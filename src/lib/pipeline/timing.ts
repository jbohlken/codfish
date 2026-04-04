import type { CaptionBlock } from "../../types/project";
import type { TimingConfig } from "../../types/profile";

export function snapToFrame(timeSeconds: number, fps: number): number {
  const frame = Math.round(timeSeconds * fps);
  return frame / fps;
}

export function framesBetween(start: number, end: number, fps: number): number {
  return Math.round((end - start) * fps);
}

function getWordGap(current: CaptionBlock, next: CaptionBlock): number {
  if (current.words?.length && next.words?.length) {
    return next.words[0].start - current.words[current.words.length - 1].end;
  }
  return next.start - current.end;
}

/**
 * Adjust caption timing to meet gap and duration constraints.
 *
 * Firm rules:
 * - Gaps must be 0 (seamless) or >= minGapSeconds (prevents flicker).
 *
 * Soft adjustments:
 * - extend_to_fill: extend captions into dead time before the next one.
 * - min_duration: safety net for very short captions.
 *
 * All timestamps are snapped to frame boundaries.
 * Mutates the blocks array in place (same as Python original) and returns it.
 */
export function enforceTiming(
  blocks: CaptionBlock[],
  config: TimingConfig,
  sourceFps?: number,
): CaptionBlock[] {
  if (blocks.length === 0) return blocks;

  const fps = sourceFps ?? config.defaultFps;
  const minDuration = config.minDuration.value;
  const maxDuration = config.maxDuration.value;
  const maxDurationStrict = config.maxDuration.strict;

  // Forward pass: snap, extend-to-fill, min duration
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    block.start = snapToFrame(block.start, fps);
    block.end = snapToFrame(block.end, fps);

    if (config.extendToFill && i + 1 < blocks.length) {
      const next = blocks[i + 1];
      const wordGap = getWordGap(block, next);
      let available: number;

      if (wordGap < config.gapCloseThreshold) {
        // Continuous speech — extend all the way (will be seamless)
        available = next.start - block.end;
      } else {
        // Pause — leave room for minimum gap
        available = next.start - block.end - config.minGapSeconds.value;
      }

      if (available > 0) {
        const extension = Math.min(available, config.extendToFillMax);
        block.end = snapToFrame(block.end + extension, fps);
      }
    }

    // minDuration is always enforced (it's a display safety net)
    if (block.end - block.start < minDuration) {
      block.end = snapToFrame(block.start + minDuration, fps);
    }

    // maxDuration: clamp end if strict
    if (maxDurationStrict && block.end - block.start > maxDuration) {
      block.end = snapToFrame(block.start + maxDuration, fps);
    }
  }

  // Gap enforcement pass: eliminate the flicker zone
  // NEVER delay next caption — only extend current caption's end
  for (let i = 0; i < blocks.length - 1; i++) {
    const current = blocks[i];
    const next = blocks[i + 1];
    const gapSeconds = next.start - current.end;

    if (gapSeconds < 0) {
      // Overlap — pull current end back
      current.end = next.start;
    } else if (gapSeconds > 0 && gapSeconds < config.minGapSeconds.value) {
      // Flicker zone — close to seamless
      current.end = next.start;
    }
  }

  // Backward pass: fix cascading overlaps
  for (let i = blocks.length - 1; i > 0; i--) {
    const current = blocks[i];
    const prev = blocks[i - 1];
    if (prev.end > current.start) {
      prev.end = current.start;
    }
  }

  // Final snap pass
  for (const block of blocks) {
    block.start = snapToFrame(block.start, fps);
    block.end = snapToFrame(block.end, fps);
    if (block.end <= block.start) {
      block.end = snapToFrame(block.start + 1 / fps, fps);
    }
  }

  return blocks;
}
