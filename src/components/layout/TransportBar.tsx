import {
  SkipBackIcon as SkipBack,
  SkipForwardIcon as SkipForward,
  CaretLineLeftIcon as StepBack,
  CaretLineRightIcon as StepForward,
  PlayIcon as Play,
  PauseIcon as Pause,
} from "@phosphor-icons/react";
import { selectedMedia, isPlaying, playbackTime, mediaDuration, stepPlayhead } from "../../store/app";

/**
 * Playback transport — a strip docked under the video preview: go to start,
 * frame-step back/forward, and play/pause. Playback only, paired with the thing
 * you're watching. Timeline-view tools (timecode/fps readout, snap, follow,
 * waveform style, zoom) live in the timeline toolbar, not here.
 */
export function TransportBar() {
  const media = selectedMedia.value;
  const playing = isPlaying.value;
  if (!media) return null;

  const goToEnd = () => {
    const m = selectedMedia.peek();
    const dur = mediaDuration.peek() || (m?.captions.length ? m.captions[m.captions.length - 1].end : 0);
    if (dur) playbackTime.value = dur;
  };

  return (
    <div class="transport-bar">
      <button class="timeline-btn" onClick={() => { playbackTime.value = 0; }} data-tooltip="Go to start">
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
    </div>
  );
}
