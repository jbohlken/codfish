// Mediabunny-engine playback surface — mounted by VideoPanel in place of the
// <video> element for clips the element can't play (ProRes .mov, .mkv, .m4a).
// Speaks the exact same signal protocol as the element path: publishes the
// clock into playbackTime via rAF while playing (with the external-seek
// write-through drift check), follows isPlaying, and applies external seeks
// while paused. Downstream code can't tell which engine is underneath.
import { useEffect, useRef } from "preact/hooks";
import { playbackTime, isPlaying, timelineFps } from "../../store/app";
import { createMediabunnyPlayer, isRescue, type MediabunnyPlayer, type EngineRescue } from "../../lib/mediabunnyPlayer";
import { isAudioPath } from "../../lib/mediaExts";
import type { MediaItem } from "../../types/project";

export function EnginePlayer({ media, onRescue }: {
  media: MediaItem;
  /** The engine declined this file (undecodable / HDR / unreadable) — the
   *  parent swaps to the <video> element rescue path. */
  onRescue: (reason: EngineRescue["rescue"]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<MediabunnyPlayer | null>(null);
  const rafLastWrittenRef = useRef(0);

  const playing = isPlaying.value;
  const currentTime = playbackTime.value;
  const fps = timelineFps.value;

  // Engine lifecycle, one per path. Creation is async (~100 ms of container
  // parsing); a clip switch mid-create disposes the late arrival.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let stale = false;
    void createMediabunnyPlayer({
      path: media.path,
      canvas,
      onEnded: () => {
        isPlaying.value = false;
      },
    }).then((player) => {
      if (isRescue(player)) {
        if (!stale) onRescue(player.rescue);
        return;
      }
      if (stale) {
        player.dispose();
        return;
      }
      playerRef.current = player;
      // Restore the clip-view playhead, then honor play state (mirrors the
      // element path's onLoadedMetadata restore).
      const t = playbackTime.peek();
      if (t > 0) player.seek(t);
      if (isPlaying.peek()) void player.play();
    });
    return () => {
      stale = true;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, [media.path]);

  // isPlaying → engine, and while playing the engine's clock owns playbackTime
  // (same rAF ownership protocol as VideoPanel: if the signal drifted from
  // what rAF last wrote, an external seek landed — write through to the
  // engine instead of clobbering it with a stale clock read).
  useEffect(() => {
    if (!playing) {
      playerRef.current?.pause();
      return;
    }
    let alive = true;
    let raf = 0;
    const tick = () => {
      if (!alive) return;
      const player = playerRef.current;
      if (player) {
        const pt = playbackTime.value;
        if (Math.abs(pt - rafLastWrittenRef.current) > 1 / (2 * fps)) {
          player.seek(pt);
          rafLastWrittenRef.current = pt;
        } else {
          const t = player.currentTime();
          playbackTime.value = t;
          rafLastWrittenRef.current = t;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    void (async () => {
      const player = playerRef.current;
      if (player) {
        // Play pressed at the end → restart from the top, writing BOTH clocks
        // like the element path does. Resetting only the engine would leave
        // playbackTime parked at the end, and the drift check above would
        // read that as an external seek and slam the restarted engine
        // straight back to the end — spacebar would look dead.
        if (player.currentTime() >= player.duration - 1 / fps) {
          player.seek(0);
          playbackTime.value = 0;
          rafLastWrittenRef.current = 0;
        }
        await player.play();
        if (!alive) return;
        if (!player.isPlaying()) {
          // Engine declined (suspended AudioContext that never resumed) —
          // mirror the element path's play().catch: don't leave the UI
          // claiming playback that isn't happening.
          isPlaying.value = false;
          return;
        }
        rafLastWrittenRef.current = player.currentTime();
      }
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [playing, fps, media.path]);

  // External seeks while paused (timeline click, frame step, caption click).
  // No frame-midpoint nudge needed here: engine seeks are deterministic — the
  // CanvasSink returns THE frame containing the timestamp, every time.
  useEffect(() => {
    if (playing) return;
    const player = playerRef.current;
    if (!player) return;
    if (Math.abs(player.currentTime() - currentTime) > 1 / (2 * fps)) {
      player.seek(currentTime);
    }
  }, [currentTime, fps, playing]);

  return (
    <canvas
      ref={canvasRef}
      key={media.id}
      class={`video-element ${isAudioPath(media.path) ? "video-element--hidden" : ""}`}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
