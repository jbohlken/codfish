/**
 * Mediabunny playback engine — plays what the <video> element can't (ProRes
 * .mov, .mkv, .m4a), decoding through WebCodecs and presenting the same
 * time/play/pause/seek surface the element path exposes, so downstream code
 * (signals, timeline, captions) never knows which engine is underneath.
 *
 * Architecture (from mediabunny's media-player example, adapted):
 * - The AudioContext clock is the master clock, even for silent video — it's
 *   monotonic, high-resolution, and the audio schedule is phase-locked to it.
 * - Video: a CanvasSink with a two-canvas pool; a rAF loop draws the queued
 *   frame when the clock passes its timestamp, then pulls the next from an
 *   async iterator. A 500 ms interval keeps frames advancing in hidden tabs.
 * - Audio: an AudioBufferSink iterator schedules AudioBufferSourceNodes at
 *   sample-accurate times, staying ~1 s ahead of the clock.
 * - Seeks restart the iterators at the target; an asyncId counter cancels
 *   stale async work (the example's pattern).
 *
 * Time domains: track timestamps are container-native (MPEG-TS starts ~1.4 s);
 * the app's timeline is zero-based. Internally everything runs NATIVE and the
 * public API converts at the boundary (public = native − startTs).
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { loadMediabunny } from "./mediabunnyRuntime";
import type { MediaProbe } from "./mediaProbe";
import type { WrappedCanvas } from "mediabunny";

/** Video codecs no browser <video> element decodes — always engine material
 *  when WebCodecs (plus our registered extensions) can. */
const ELEMENT_UNSUPPORTED_VIDEO = new Set(["prores"]);
/** Containers WebView2 rejects outright (MEDIA_ERR_SRC_NOT_SUPPORTED). */
const ELEMENT_UNSUPPORTED_EXT = new Set(["mkv", "m4a"]);

/** Phase-2 routing: the <video> element stays the default engine; mediabunny
 *  takes a clip only when the element demonstrably can't play it. Containers
 *  the element rejects route unconditionally (the element shows nothing at
 *  all); element-playable containers with an element-undecodable video codec
 *  (ProRes .mov) route only when WebCodecs can actually decode — otherwise
 *  the element's audio-with-black-frame is still the better experience. */
export function needsEngine(path: string, probe: MediaProbe | null): boolean {
  const ext = path.replace(/\\/g, "/").split(".").pop()?.toLowerCase() ?? "";
  if (ELEMENT_UNSUPPORTED_EXT.has(ext)) return true;
  if (
    probe?.hasVideo
    && probe.videoCodec !== null
    && ELEMENT_UNSUPPORTED_VIDEO.has(probe.videoCodec)
    && probe.canDecodeVideo
  ) {
    return true;
  }
  return false;
}

export interface MediabunnyPlayer {
  /** Zero-based content length in seconds. */
  readonly duration: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  /** Current zero-based playback position. */
  currentTime(): number;
  isPlaying(): boolean;
  play(): Promise<void>;
  pause(): void;
  /** Seek to a zero-based position (clamped). Restarts iterators; safe to
   *  call rapidly — stale async work is cancelled by the id counter. */
  seek(seconds: number): void;
  dispose(): void;
}

export async function createMediabunnyPlayer(opts: {
  path: string;
  canvas: HTMLCanvasElement;
  /** Called once when playback reaches the end (engine has already paused). */
  onEnded?: () => void;
}): Promise<MediabunnyPlayer | null> {
  const { canvas, onEnded } = opts;
  try {
    const { Input, ALL_FORMATS, UrlSource, CanvasSink, AudioBufferSink } = await loadMediabunny();
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(convertFileSrc(opts.path)),
    });

    let videoTrack = await input.getPrimaryVideoTrack();
    let audioTrack = await input.getPrimaryAudioTrack();
    if (videoTrack && !(await videoTrack.canDecode())) videoTrack = null;
    if (audioTrack && !(await audioTrack.canDecode())) audioTrack = null;
    if (!videoTrack && !audioTrack) {
      input.dispose();
      return null;
    }

    const startTs = Math.max(await input.getFirstTimestamp(), 0);
    const nativeEnd = await input.computeDuration(undefined, { skipLiveWait: true });
    const duration = Math.max(0, nativeEnd - startTs);

    // Matching the track's sample rate avoids a resample pass and, for
    // low-rate files, acoustic artifacts.
    const audioContext = new AudioContext({
      sampleRate: audioTrack ? await audioTrack.getSampleRate() : undefined,
    });
    const gain = audioContext.createGain();
    gain.connect(audioContext.destination);

    const ctx2d = canvas.getContext("2d");
    const videoSink = videoTrack
      ? new CanvasSink(videoTrack, { poolSize: 2, fit: "contain" })
      : null;
    const audioSink = audioTrack ? new AudioBufferSink(audioTrack) : null;
    if (videoTrack) {
      canvas.width = await videoTrack.getDisplayWidth();
      canvas.height = await videoTrack.getDisplayHeight();
    }

    // ── Engine state (all times NATIVE) ────────────────────────────────────
    let disposed = false;
    let playing = false;
    /** Native media time where playback (re)started or is parked. */
    let nativeAtStart = startTs;
    /** audioContext.currentTime the moment playback started. */
    let ctxAtStart = 0;
    /** Cancels stale async iterations (seek/play/dispose bump it). */
    let asyncId = 0;

    let frameIterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
    let nextFrame: WrappedCanvas | null = null;
    let audioIterator: AsyncGenerator<{ buffer: AudioBuffer; timestamp: number }, void, unknown> | null = null;
    const queuedNodes = new Set<AudioBufferSourceNode>();

    const nativeClock = () =>
      playing ? audioContext.currentTime - ctxAtStart + nativeAtStart : nativeAtStart;

    const drawFrame = (frame: WrappedCanvas) => {
      if (!ctx2d) return;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.drawImage(frame.canvas, 0, 0);
    };

    /** (Re)start the frame iterator at the current clock and paint the frame
     *  there — the example's startVideoIterator. */
    const startFrameIterator = async () => {
      if (!videoSink) return;
      const id = ++asyncId;
      await frameIterator?.return();
      if (disposed || id !== asyncId) return;
      frameIterator = videoSink.canvases(Math.min(nativeClock(), Math.max(startTs, nativeEnd - 1e-4)));
      const first = (await frameIterator.next()).value ?? null;
      if (disposed || id !== asyncId) return;
      const second = (await frameIterator.next()).value ?? null;
      if (disposed || id !== asyncId) return;
      nextFrame = second;
      if (first) drawFrame(first);
    };

    /** Advance until a future frame is queued — the example's updateNextFrame. */
    const pullNextFrame = async () => {
      const id = asyncId;
      while (frameIterator) {
        const frame = (await frameIterator.next()).value ?? null;
        if (!frame || disposed || id !== asyncId) return;
        if (frame.timestamp <= nativeClock()) {
          drawFrame(frame);
        } else {
          nextFrame = frame;
          return;
        }
      }
    };

    /** Schedule decoded audio against the context clock, ~1 s ahead. */
    const runAudioIterator = async () => {
      if (!audioSink || !audioIterator) return;
      const id = asyncId;
      for await (const { buffer, timestamp } of audioIterator) {
        if (disposed || id !== asyncId) return;
        const node = audioContext.createBufferSource();
        node.buffer = buffer;
        node.connect(gain);
        let at = ctxAtStart + timestamp - nativeAtStart;
        at = Math.round(at * audioContext.sampleRate) / audioContext.sampleRate;
        if (at >= audioContext.currentTime) {
          node.start(at);
        } else {
          node.start(audioContext.currentTime, audioContext.currentTime - at);
        }
        queuedNodes.add(node);
        node.onended = () => queuedNodes.delete(node);
        if (timestamp - nativeClock() >= 1) {
          await new Promise<void>((resolve) => {
            const poll = setInterval(() => {
              if (disposed || id !== asyncId || timestamp - nativeClock() < 1) {
                clearInterval(poll);
                resolve();
              }
            }, 100);
          });
          if (disposed || id !== asyncId) return;
        }
      }
    };

    const stopAudio = () => {
      void audioIterator?.return();
      audioIterator = null;
      for (const node of queuedNodes) node.stop();
      queuedNodes.clear();
    };

    const pause = () => {
      if (!playing) return;
      nativeAtStart = nativeClock();
      playing = false;
      asyncId++;
      stopAudio();
    };

    // Render loop: draw the queued frame when the clock passes it; detect the
    // end of media. rAF for smoothness, plus a coarse interval so playback
    // state still settles when the window is hidden.
    const render = () => {
      if (disposed) return;
      if (playing && nativeClock() >= nativeEnd) {
        pause();
        nativeAtStart = nativeEnd;
        onEnded?.();
      }
      if (nextFrame && nextFrame.timestamp <= nativeClock()) {
        drawFrame(nextFrame);
        nextFrame = null;
        void pullNextFrame();
      }
    };
    let raf = 0;
    const rafLoop = () => {
      render();
      if (!disposed) raf = requestAnimationFrame(rafLoop);
    };
    raf = requestAnimationFrame(rafLoop);
    const hiddenTick = setInterval(render, 500);

    await startFrameIterator();

    const player: MediabunnyPlayer = {
      duration,
      hasVideo: videoTrack !== null,
      hasAudio: audioTrack !== null,
      currentTime: () => Math.max(0, Math.min(nativeClock() - startTs, duration)),
      isPlaying: () => playing,
      async play() {
        if (disposed || playing) return;
        if (audioContext.state === "suspended") await audioContext.resume();
        if (disposed) return;
        if (nativeClock() >= nativeEnd) {
          nativeAtStart = startTs;
          await startFrameIterator();
          if (disposed) return;
        }
        ctxAtStart = audioContext.currentTime;
        playing = true;
        if (audioSink) {
          asyncId++;
          audioIterator = audioSink.buffers(nativeClock());
          void runAudioIterator();
        }
      },
      pause,
      seek(seconds) {
        if (disposed) return;
        const wasPlaying = playing;
        if (wasPlaying) pause();
        nativeAtStart = startTs + Math.max(0, Math.min(seconds, duration));
        void startFrameIterator().then(() => {
          if (!disposed && wasPlaying && nativeAtStart < nativeEnd) void this.play();
        });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        asyncId++;
        cancelAnimationFrame(raf);
        clearInterval(hiddenTick);
        stopAudio();
        void frameIterator?.return();
        frameIterator = null;
        nextFrame = null;
        void audioContext.close();
        input.dispose();
      },
    };
    return player;
  } catch {
    return null;
  }
}
