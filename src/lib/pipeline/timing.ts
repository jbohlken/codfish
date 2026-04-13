import type { CaptionBlock } from "../../types/project";
import type { TimingConfig } from "../../types/profile";
import { toSeconds, snapToFrame, timeLt, timeGt, timeLte } from "../time";

export { snapToFrame, framesBetween } from "../time";

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
  const minDuration = toSeconds(config.minDuration, fps);
  const maxDuration = toSeconds(config.maxDuration, fps);
  const minGapSeconds = toSeconds(config.minGapSeconds, fps);

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
        // Pause — leave room for minimum gap if enforced
        available = next.start - block.end - (config.minGapEnabled ? minGapSeconds : 0);
      }

      if (available > 0) {
        const extension = Math.min(available, config.extendToFillMax);
        block.end = snapToFrame(block.end + extension, fps);
      }
    }

    // minDuration is always enforced (it's a display safety net)
    if (timeLt(block.end - block.start, minDuration)) {
      block.end = snapToFrame(block.start + minDuration, fps);
    }

    // maxDuration: always enforced
    if (timeGt(block.end - block.start, maxDuration)) {
      block.end = snapToFrame(block.start + maxDuration, fps);
    }
  }

  // CPS enforcement pass: extend end times to meet reading speed target if strict
  if (config.maxCps.strict) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const totalChars = block.lines.reduce((sum, l) => sum + l.length, 0);
      const requiredDuration = totalChars / config.maxCps.value;
      const currentDuration = block.end - block.start;

      if (currentDuration < requiredDuration) {
        const next = i + 1 < blocks.length ? blocks[i + 1] : null;
        const gapBuffer = config.minGapEnabled ? minGapSeconds : 0;
        const ceiling = next
          ? Math.min(block.start + maxDuration, next.start - gapBuffer)
          : block.start + maxDuration;
        const newEnd = snapToFrame(Math.min(block.start + requiredDuration, ceiling), fps);
        if (newEnd > block.end) {
          block.end = newEnd;
        }
      }
    }
  }

  // Gap enforcement pass: eliminate the flicker zone
  // NEVER delay next caption — only extend current caption's end
  for (let i = 0; i < blocks.length - 1; i++) {
    const current = blocks[i];
    const next = blocks[i + 1];
    const gapSeconds = next.start - current.end;

    if (timeLt(gapSeconds, 0)) {
      // Overlap — pull current end back
      current.end = next.start;
    } else if (config.minGapEnabled && timeGt(gapSeconds, 0) && timeLt(gapSeconds, minGapSeconds)) {
      // Flicker zone — close to seamless
      current.end = next.start;
    }
  }

  // Backward pass: fix cascading overlaps
  for (let i = blocks.length - 1; i > 0; i--) {
    const current = blocks[i];
    const prev = blocks[i - 1];
    if (timeGt(prev.end, current.start)) {
      prev.end = current.start;
    }
  }

  // Final snap pass
  for (const block of blocks) {
    block.start = snapToFrame(block.start, fps);
    block.end = snapToFrame(block.end, fps);
    if (timeLte(block.end, block.start)) {
      block.end = snapToFrame(block.start + 1 / fps, fps);
    }
  }

  return blocks;
}
