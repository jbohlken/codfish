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
import type { WrappedCanvas } from "mediabunny";

/**
 * Phase-3 routing: mediabunny is the DEFAULT engine and the engine attempt
 * itself is the routing probe — creation opens the file and checks
 * decodability anyway, so instead of a bare failure it returns a typed
 * rescue verdict and the caller falls back to the <video> element:
 * - 'undecodable': no track WebCodecs (+ our extensions) can decode — the
 *   platform media stack may still manage it.
 * - 'hdr': decodable, but the 2D canvas is SDR; the element tone-maps HDR
 *   properly, so it gives the better picture.
 * - 'error': the file couldn't be read/parsed at all.
 */
export interface EngineRescue {
  rescue: "undecodable" | "hdr" | "error";
}

export function isRescue(result: MediabunnyPlayer | EngineRescue): result is EngineRescue {
  return "rescue" in result;
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
  /** Master volume as linear gain 0..1 (callers apply their own taper).
   *  Affects playback and scrub grains alike — everything routes through the
   *  engine's master gain node. */
  setVolume(value: number): void;
  /** Play one short, click-free grain of audio at a zero-based position —
   *  the frame-step blip primitive. `durationSec` defaults to ~60 ms and is
   *  clamped to [30, 120] ms; pass 1/fps to blip exactly the stepped frame.
   *  Paused-state only; a newer grain supersedes an in-flight one, so
   *  rapid-fire calls are safe. No-op while playing or for clips without
   *  decodable audio. */
  playGrain(seconds: number, durationSec?: number): void;
  dispose(): void;
}

export async function createMediabunnyPlayer(opts: {
  path: string;
  canvas: HTMLCanvasElement;
  /** Called once when playback reaches the end (engine has already paused). */
  onEnded?: () => void;
}): Promise<MediabunnyPlayer | EngineRescue> {
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
      return { rescue: "undecodable" };
    }
    if (videoTrack && (await videoTrack.hasHighDynamicRange())) {
      input.dispose();
      return { rescue: "hdr" };
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

    // ── Scrub grains ───────────────────────────────────────────────────────
    // A grain is a ~60 ms window of decoded audio played through its own gain
    // node with fast attack/release ramps (no clicks). One grain at a time:
    // a new one fades the old out; requests arriving while a fetch is in
    // flight coalesce to the latest (trailing edge), so pointer-move-rate
    // calls produce the classic NLE zipper, not a backlog.
    const GRAIN_SEC = 0.06;
    const GRAIN_FADE = 0.008;
    let grainSeq = 0;
    let grainBusy = false;
    let grainPending: { t: number; dur: number } | null = null;
    let grainGain: GainNode | null = null;
    let grainNodes: AudioBufferSourceNode[] = [];
    let grainNativeStart = -1;
    let grainStartedAt = -1;
    let grainLen = GRAIN_SEC;

    const stopGrain = () => {
      const g = grainGain;
      if (!g) return;
      grainGain = null;
      const nodes = grainNodes;
      grainNodes = [];
      const now = audioContext.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + GRAIN_FADE);
      for (const node of nodes) {
        try {
          node.stop(now + GRAIN_FADE + 0.002);
        } catch {
          // already stopped
        }
      }
      setTimeout(() => g.disconnect(), 60);
    };

    const playGrainAt = async (publicT: number, durationSec = GRAIN_SEC) => {
      if (!audioSink || disposed || playing) return;
      const grainSec = Math.max(0.03, Math.min(durationSec, 0.12));
      if (grainBusy) {
        grainPending = { t: publicT, dur: grainSec };
        return;
      }
      grainBusy = true;
      try {
        const seq = ++grainSeq;
        const nativeStart = startTs + Math.max(0, Math.min(publicT, Math.max(0, duration - 0.01)));
        // Re-trigger at (nearly) the same spot while the current grain still
        // sounds — e.g. stepping against the clamped end — would stutter;
        // skip it. Threshold is relative to the grain so consecutive frame
        // steps (one grain-length apart) are never mistaken for wiggle.
        if (
          Math.abs(nativeStart - grainNativeStart) < grainSec * 0.25
          && audioContext.currentTime - grainStartedAt < grainLen
        ) {
          return;
        }
        if (audioContext.state === "suspended") {
          // Scrubbing follows a pointerdown, so resume() has its gesture.
          await Promise.race([
            audioContext.resume(),
            new Promise<void>((r) => setTimeout(r, 250)),
          ]);
        }
        if (disposed || playing || audioContext.state !== "running" || seq !== grainSeq) return;
        const grainEnd = Math.min(nativeStart + grainSec, nativeEnd);
        const collected: { buffer: AudioBuffer; timestamp: number }[] = [];
        for await (const wb of audioSink.buffers(nativeStart, grainEnd)) {
          collected.push(wb);
          if (disposed || seq !== grainSeq) return;
        }
        if (disposed || playing || seq !== grainSeq || collected.length === 0) return;
        stopGrain();
        const g = audioContext.createGain();
        g.connect(gain);
        const now = audioContext.currentTime;
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(1, now + GRAIN_FADE);
        g.gain.setValueAtTime(1, now + grainSec - GRAIN_FADE);
        g.gain.linearRampToValueAtTime(0, now + grainSec);
        const nodes: AudioBufferSourceNode[] = [];
        for (const { buffer, timestamp } of collected) {
          const rel = timestamp - nativeStart;
          const remaining = grainEnd - Math.max(timestamp, nativeStart);
          if (remaining <= 0) continue;
          const node = audioContext.createBufferSource();
          node.buffer = buffer;
          node.connect(g);
          node.start(now + Math.max(rel, 0), rel < 0 ? -rel : 0, remaining);
          nodes.push(node);
        }
        grainGain = g;
        grainNodes = nodes;
        grainNativeStart = nativeStart;
        grainStartedAt = now;
        grainLen = grainSec;
      } finally {
        grainBusy = false;
        if (grainPending !== null && !disposed && !playing) {
          const next = grainPending;
          grainPending = null;
          void playGrainAt(next.t, next.dur);
        }
      }
    };

    // Bumped by EVERY pause() call — including when already internally paused.
    // seek()'s auto-resume checks it, so a pause landing while a seek's
    // iterator restart is in flight cancels the pending resume. Without the
    // unconditional bump, the scrub-during-play race resurrected playback:
    // a stale rAF tick seeks (engine internally pauses, capturing
    // wasPlaying=true), the real pause then no-ops on the early return, and
    // the seek's .then resumes audio under a paused UI.
    let resumeGen = 0;

    const pause = () => {
      resumeGen++;
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
        if (audioContext.state === "suspended") {
          // resume() can stay pending forever under a strict autoplay policy
          // (no user gesture). Bounded wait; if the context still isn't
          // running we decline to play — the caller checks isPlaying() and
          // resets the UI state, mirroring the element's play() rejection.
          await Promise.race([
            audioContext.resume(),
            new Promise<void>((r) => setTimeout(r, 1000)),
          ]);
        }
        if (disposed || audioContext.state !== "running") return;
        stopGrain(); // a lingering scrub grain must not bleed into playback
        if (nativeClock() >= nativeEnd) {
          nativeAtStart = startTs;
          await startFrameIterator();
          if (disposed) return;
        }
        ctxAtStart = audioContext.currentTime;
        playing = true;
        if (audioSink) {
          // Deliberately NO asyncId bump here: every path into play() already
          // went through pause()/seek()/dispose(), which bump it. Bumping
          // again would cancel a seek's still-in-flight frame-iterator
          // restart (seek() is fire-and-forget), freezing video while audio
          // plays — the seek-then-immediately-play race.
          audioIterator = audioSink.buffers(nativeClock());
          void runAudioIterator();
        }
      },
      pause,
      seek(seconds) {
        if (disposed) return;
        const wasPlaying = playing;
        if (wasPlaying) pause();
        // Captured AFTER the internal pause's bump: only an EXTERNAL pause
        // (or a later seek's pause) arriving during the iterator restart can
        // advance it past this value and veto the resume.
        const gen = resumeGen;
        nativeAtStart = startTs + Math.max(0, Math.min(seconds, duration));
        void startFrameIterator().then(() => {
          if (!disposed && wasPlaying && gen === resumeGen && nativeAtStart < nativeEnd) {
            void this.play();
          }
        });
      },
      setVolume(value) {
        gain.gain.value = Math.max(0, Math.min(1, value));
      },
      playGrain(seconds, durationSec) {
        void playGrainAt(seconds, durationSec);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        asyncId++;
        grainSeq++;
        cancelAnimationFrame(raf);
        clearInterval(hiddenTick);
        stopGrain();
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
    return { rescue: "error" };
  }
}
