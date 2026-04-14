import { useRef, useEffect } from "preact/hooks";
import { MusicNoteIcon as MusicNote } from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { selectedMedia, playbackTime, isPlaying, mediaDuration, activeProfile } from "../../store/app";
import { editingIndex, editText } from "./CaptionPanel";

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg"]);
function isAudioOnly(path: string): boolean {
  const ext = path.replace(/\\/g, "/").split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.has(ext);
}

export function VideoPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const rafLastWrittenRef = useRef<number>(0);

  // Read signals — subscribes this component to re-render when they change
  const media = selectedMedia.value;
  const playing = isPlaying.value;
  const currentTime = playbackTime.value;

  const activeCaption = media?.captions.find(
    (c) => currentTime >= c.start && currentTime < c.end,
  ) ?? null;

  const isEditingActive = activeCaption !== null && editingIndex.value === activeCaption.index;
  const overlayLines = isEditingActive
    ? editText.value.split("\n").filter((l) => l.trim())
    : activeCaption?.lines ?? null;

  // Reset playback state when media changes
  useEffect(() => {
    playbackTime.value = 0;
    isPlaying.value = false;
    mediaDuration.value = 0;
  }, [media?.id]);

  // Sync isPlaying → video element, and drive playbackTime via rAF while playing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (playing) {
      video.play().catch(() => { isPlaying.value = false; });
      rafLastWrittenRef.current = video.currentTime;

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
      rafRef.current = requestAnimationFrame(tick);

      return () => cancelAnimationFrame(rafRef.current);
    } else {
      video.pause();
      cancelAnimationFrame(rafRef.current);
    }
  }, [playing]);

  // Sync external seeks (timeline click, caption click) → video element.
  // Use a half-frame threshold so any frame-aligned seek registers, while
  // still absorbing sub-frame float drift from the rAF playback loop.
  const fps = media?.fps ?? activeProfile.value.timing.defaultFps;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (Math.abs(video.currentTime - currentTime) > 1 / (2 * fps)) {
      video.currentTime = currentTime;
    }
  }, [currentTime, fps]);

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
              class={`video-element ${isAudioOnly(media.path) ? "video-element--hidden" : ""}`}
              controls={false}
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
              onLoadedMetadata={(e) => { mediaDuration.value = e.currentTarget.duration; }}
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
