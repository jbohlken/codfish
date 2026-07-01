import { useRef, useEffect } from "preact/hooks";
import { MusicNoteIcon as MusicNote } from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { selectedMedia, playbackTime, isPlaying, mediaDuration, activeProfile } from "../../store/app";
import { editingIndex, editText } from "./CaptionPanel";
import { AUDIO_EXTS } from "../../lib/project";
import { findCaptionAt } from "../../lib/pipeline";
import { getClipView } from "../../lib/clipView";
import { frameMidpoint } from "../../lib/playhead";

function isAudioOnly(path: string): boolean {
  const ext = path.replace(/\\/g, "/").split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.includes(ext);
}

export function VideoPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const rafLastWrittenRef = useRef<number>(0);
  // True only while the rAF tick loop is actively syncing currentTime ↔
  // playbackTime. False when paused AND while play() is still pending —
  // the seek effect uses this to know when it owns video.currentTime.
  const rafActiveRef = useRef<boolean>(false);

  // Read signals — subscribes this component to re-render when they change
  const media = selectedMedia.value;
  const playing = isPlaying.value;
  const currentTime = playbackTime.value;

  const activeCaption = media ? findCaptionAt(media.captions, currentTime) : null;

  const isEditingActive = activeCaption !== null && editingIndex.value === activeCaption.index;
  const overlayLines = isEditingActive
    ? editText.value.split("\n").filter((l) => l.trim())
    : activeCaption?.lines ?? null;

  // On a clip switch, restore that clip's remembered playhead (0 if none) and
  // stop playback. This owns playbackTime across media changes; the caption
  // selection is restored separately by openClip.
  useEffect(() => {
    playbackTime.value = getClipView(media?.id)?.playbackTime ?? 0;
    isPlaying.value = false;
    mediaDuration.value = 0;
  }, [media?.id]);

  // Adopt the element's duration, but only a real (finite, positive) value.
  // The first `loadedmetadata` for a file still streaming in (e.g. a freshly
  // Dropbox-synced clip over the asset protocol, or an MP4 whose moov atom
  // isn't faststart) can report Infinity/NaN or a provisional length, then
  // emit `durationchange` with the true duration — so we listen to both and
  // ignore bogus values rather than locking in the first reading.
  const adoptDuration = (el: HTMLVideoElement) => {
    const d = el.duration;
    if (Number.isFinite(d) && d > 0) mediaDuration.value = d;
  };

  // Sync isPlaying → video element, and drive playbackTime via rAF while playing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (playing) {
      let cancelled = false;

      const tick = () => {
        // If playbackTime has drifted from what rAF last wrote, an external
        // seek landed — write through to the video instead of clobbering the
        // user's seek with a stale video.currentTime read.
        const pt = playbackTime.value;
        if (Math.abs(pt - rafLastWrittenRef.current) > 1 / (2 * fps)) {
          video.currentTime = pt;
          rafLastWrittenRef.current = pt;
        } else {
          const vt = video.currentTime;
          playbackTime.value = vt;
          rafLastWrittenRef.current = vt;
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      // Play pressed at the end → restart from the top (standard player behavior);
      // otherwise play() sits at the end and does nothing.
      if (video.duration > 0 && video.currentTime >= video.duration - 1 / fps) {
        video.currentTime = 0;
        playbackTime.value = 0;
      }

      // Wait for play() to resolve before starting rAF. On Mac the decoder
      // can take 50–300ms to actually start producing frames; ticking during
      // that window spins re-renders against stale video.currentTime reads
      // while the main thread is busy with decode setup.
      video.play().then(() => {
        if (cancelled) return;
        rafLastWrittenRef.current = video.currentTime;
        rafActiveRef.current = true;
        rafRef.current = requestAnimationFrame(tick);
      }).catch(() => {
        if (cancelled) return;
        isPlaying.value = false;
      });

      return () => {
        cancelled = true;
        rafActiveRef.current = false;
        cancelAnimationFrame(rafRef.current);
      };
    } else {
      rafActiveRef.current = false;
      video.pause();
      cancelAnimationFrame(rafRef.current);
    }
  }, [playing]);

  // Sync external seeks (timeline click, caption click) → video element
  // whenever the rAF loop isn't actively syncing. Covers paused state and
  // the play-pending window between video.play() being called and its
  // promise resolving — without this, a timeline click during the decoder
  // warmup would only land on the next rAF tick (or be lost if the user
  // pauses again first). During active playback rAF owns sync; running
  // this effect there would micro-seek every tick.
  const fps = media?.fps ?? activeProfile.value.timing.defaultFps;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (rafActiveRef.current) return;
    // Seek to the middle of the frame containing currentTime (see frameMidpoint):
    // a frame-boundary seek is ambiguous and makes stepping land a frame early/late
    // at random. The playhead stays on the boundary; only the video seek is nudged.
    const target = frameMidpoint(currentTime, fps);
    if (Math.abs(video.currentTime - target) > 1 / (2 * fps)) {
      video.currentTime = target;
    }
  }, [currentTime, fps, playing]);

  return (
    <div class="panel video-panel">
      {!media ? (
        <div class="empty-state">
          <span class="empty-state-title">No media selected</span>
          <span class="empty-state-body">Select a media item from the project panel.</span>
        </div>
      ) : (
        <div class="video-container">
          <div class="video-wrapper">
            <video
              ref={videoRef}
              key={media.id}
              src={convertFileSrc(media.path)}
              preload="auto"
              class={`video-element ${isAudioOnly(media.path) ? "video-element--hidden" : ""}`}
              controls={false}
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
              onLoadedMetadata={(e) => {
                adoptDuration(e.currentTarget);
                // Seek to the restored playhead once the video can actually seek
                // (setting currentTime before metadata loads doesn't stick).
                const t = playbackTime.peek();
                if (t > 0) e.currentTarget.currentTime = Math.min(t, e.currentTarget.duration || t);
              }}
              onDurationChange={(e) => adoptDuration(e.currentTarget)}
              onPlay={() => { isPlaying.value = true; }}
              onPause={() => { isPlaying.value = false; }}
              onEnded={() => { isPlaying.value = false; }}
            />
            {isAudioOnly(media.path) && (
              <div class="audio-placeholder">
                <span class="audio-placeholder-icon"><MusicNote size={32} /></span>
                <span class="audio-placeholder-name">{media.name}</span>
              </div>
            )}
            {overlayLines && overlayLines.length > 0 && (
              <div class="caption-overlay">
                {overlayLines.map((line, i) => (
                  <span key={i} class="caption-overlay-line">{line}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
