import type { CaptionBlock } from "../../types/project";
import type { CaptionProfile } from "../../types/profile";
import { framesBetween } from "./timing";
import type { ValidationReport, ValidationWarning } from "./types";

/** Validate caption blocks against the profile spec.
 *
 * Always-firm rules (pipeline bugs if violated):
 * - max_lines: each block has <= maxLines lines
 * - gap_flicker: gaps are 0 or >= minGapSeconds
 *
 * ProfileRule parameters: strict = firm enforcement, !strict = fuzzy warning only
 * - maxCharsPerLine, maxCps, minDuration, maxDuration
 */
export function validate(
  blocks: CaptionBlock[],
  profile: CaptionProfile,
  sourceFps?: number,
): ValidationReport {
  const fps = sourceFps ?? profile.timing.defaultFps;
  const warnings: ValidationWarning[] = [];
  const { formatting, timing } = profile;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const duration = block.end - block.start;
    const blockIndex = i + 1;

    // ALWAYS FIRM: max lines
    if (block.lines.length > formatting.maxLines) {
      warnings.push({
        blockIndex,
        rule: "max_lines",
        message: `Caption #${blockIndex} has ${block.lines.length} lines (limit: ${formatting.maxLines})`,
        actualValue: block.lines.length,
        targetValue: formatting.maxLines,
      });
    }

    // maxCharsPerLine — firm if strict, fuzzy otherwise
    for (const line of block.lines) {
      if (line.length > formatting.maxCharsPerLine.value) {
        warnings.push({
          blockIndex,
          rule: "chars_per_line",
          message: `Caption #${blockIndex}: ${line.length} chars on one line (${formatting.maxCharsPerLine.strict ? "limit" : "target"}: ${formatting.maxCharsPerLine.value})`,
          actualValue: line.length,
          targetValue: formatting.maxCharsPerLine.value,
          strict: formatting.maxCharsPerLine.strict,
        });
      }
    }

    // minDuration — fuzzy warning (timing stage always enforces it)
    if (timing.minDuration.value > 0 && duration < timing.minDuration.value) {
      warnings.push({
        blockIndex,
        rule: "min_duration",
        message: `Caption #${blockIndex}: ${duration.toFixed(2)}s (${timing.minDuration.strict ? "limit" : "target"}: ~${timing.minDuration.value}s)`,
        actualValue: duration,
        targetValue: timing.minDuration.value,
        strict: timing.minDuration.strict,
      });
    }

    // maxDuration
    if (duration > timing.maxDuration.value) {
      warnings.push({
        blockIndex,
        rule: "max_duration",
        message: `Caption #${blockIndex}: ${duration.toFixed(2)}s (${timing.maxDuration.strict ? "limit" : "target"}: ~${timing.maxDuration.value}s)`,
        actualValue: duration,
        targetValue: timing.maxDuration.value,
        strict: timing.maxDuration.strict,
      });
    }

    // maxCps (reading speed)
    const totalChars = block.lines.reduce((sum, l) => sum + l.length, 0);
    if (duration > 0) {
      const cps = totalChars / duration;
      if (cps > formatting.maxCps.value) {
        warnings.push({
          blockIndex,
          rule: "reading_speed",
          message: `Caption #${blockIndex}: ${cps.toFixed(1)} CPS (${totalChars} chars in ${duration.toFixed(2)}s, ${formatting.maxCps.strict ? "limit" : "target"}: ≤${formatting.maxCps.value})`,
          actualValue: cps,
          targetValue: formatting.maxCps.value,
          strict: formatting.maxCps.strict,
        });
      }
    }

    // ALWAYS FIRM: gap flicker zone
    if (i + 1 < blocks.length) {
      const next = blocks[i + 1];
      const gapSeconds = next.start - block.end;
      if (gapSeconds > 0 && gapSeconds < timing.minGapSeconds) {
        const gapFrames = framesBetween(block.end, next.start, fps);
        warnings.push({
          blockIndex,
          rule: "gap_flicker",
          message: `Caption #${blockIndex}→#${blockIndex + 1}: ${gapFrames} frame gap (${gapSeconds.toFixed(3)}s, must be 0 or ≥${timing.minGapSeconds}s)`,
          actualValue: gapSeconds,
          targetValue: timing.minGapSeconds,
          strict: true,
        });
      }
    }

    // line_balance — always fuzzy
    if (block.lines.length === 2) {
      const len1 = block.lines[0].length;
      const len2 = block.lines[1].length;
      const imbalance = Math.abs(len1 - len2);
      if (imbalance > Math.max(len1, len2) * 0.6) {
        warnings.push({
          blockIndex,
          rule: "line_balance",
          message: `Caption #${blockIndex}: unbalanced lines (${len1} vs ${len2} chars)`,
          actualValue: imbalance,
          targetValue: 0,
          strict: false,
        });
      }
    }
  }

  return { totalBlocks: blocks.length, warnings };
}
