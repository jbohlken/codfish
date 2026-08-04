import {
  SkipBackIcon as SkipBack,
  SkipForwardIcon as SkipForward,
  CaretLineLeftIcon as StepBack,
  CaretLineRightIcon as StepForward,
  PlayIcon as Play,
  PauseIcon as Pause,
  SpeakerHighIcon as SpeakerHigh,
  SpeakerLowIcon as SpeakerLow,
  SpeakerSlashIcon as SpeakerSlash,
} from "@phosphor-icons/react";
import { selectedMedia, isPlaying, playbackTime, timelineDuration, stepPlayhead, volume, muted, setVolume, toggleMuted } from "../../store/app";

/**
 * Playback transport — a strip docked under the video preview: go to start,
 * frame-step back/forward, and play/pause. Playback only, paired with the thing
 * you're watching. Timeline-view tools (timecode/fps readout, snap, follow,
 * waveform style, zoom) live in the timeline toolbar, not here.
 */
export function TransportBar() {
  const media = selectedMedia.value;
  const playing = isPlaying.value;
  const vol = volume.value;
  const isMuted = muted.value;
  if (!media) return null;

  // Any user seek stops playback (#43) — play is always an explicit action.
  const goToStart = () => {
    isPlaying.value = false;
    playbackTime.value = 0;
  };

  const goToEnd = () => {
    const dur = timelineDuration.peek();
    if (!dur) return;
    isPlaying.value = false;
    playbackTime.value = dur;
  };

  return (
    <div class="transport-bar">
      <button class="timeline-btn" onClick={goToStart} data-tooltip="Go to start">
        <SkipBack size={14} weight="fill" />
      </button>
      <button class="timeline-btn" onClick={() => stepPlayhead(-1)} data-tooltip="Previous frame (←)">
        <StepBack size={16} />
      </button>
      <button
        class="timeline-btn timeline-btn--play"
        onClick={() => { isPlaying.value = !isPlaying.peek(); }}
        data-tooltip={playing ? "Pause (Space)" : "Play (Space)"}
      >
        {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
      </button>
      <button class="timeline-btn" onClick={() => stepPlayhead(1)} data-tooltip="Next frame (→)">
        <StepForward size={16} />
      </button>
      <button class="timeline-btn" onClick={goToEnd} data-tooltip="Go to end">
        <SkipForward size={14} weight="fill" />
      </button>

      {/* Volume cluster — absolutely right-aligned so the transport buttons
          stay centered. One preference for both players (engine gain node and
          the <video> rescue path), persisted app-wide, never in the .cod. */}
      <div class="transport-volume">
        <button
          class="timeline-btn"
          onClick={toggleMuted}
          data-tooltip={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted || vol === 0 ? <SpeakerSlash size={16} /> : vol < 0.5 ? <SpeakerLow size={16} /> : <SpeakerHigh size={16} />}
        </button>
        <input
          class={`transport-volume-slider${isMuted ? " transport-volume-slider--muted" : ""}`}
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={vol}
          style={{ background: `linear-gradient(to right, var(--color-accent) ${vol * 100}%, var(--color-border) ${vol * 100}%)` }}
          onInput={(e) => setVolume(Number((e.currentTarget as HTMLInputElement).value))}
          data-tooltip="Volume"
        />
      </div>
    </div>
  );
}
