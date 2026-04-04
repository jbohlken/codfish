import type { CaptionBlock } from "../../types/project";
import type { CaptionProfile, TimedRule } from "../../types/profile";
import { framesBetween } from "./timing";
import type { ValidationReport, ValidationWarning } from "./types";

function toSeconds(rule: TimedRule, fps: number): number {
  return rule.unit === "fr" ? rule.value / fps : rule.value;
}

function fmtTimedValue(rule: TimedRule): string {
  return rule.unit === "fr" ? `${rule.value}fr` : `${rule.value}s`;
}

/** Validate caption blocks against the profile spec.
 *
 * Always-firm rules:
 * - overlap
 *
 * ProfileRule parameters: strict = firm enforcement, !strict = fuzzy warning only
 * - maxCharsPerLine, maxCps, minDuration, maxDuration, minGapSeconds
 *
 * Always-fuzzy:
 * - line_balance
 */
export function validate(
  blocks: CaptionBlock[],
  profile: CaptionProfile,
  sourceFps?: number,
): ValidationReport {
  const fps = sourceFps ?? profile.timing.defaultFps;
  const warnings: ValidationWarning[] = [];
  const { formatting, timing } = profile;
  const minDurationSec = toSeconds(timing.minDuration, fps);
  const maxDurationSec = toSeconds(timing.maxDuration, fps);
  const minGapSec = toSeconds(timing.minGapSeconds, fps);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const duration = block.end - block.start;
    const blockIndex = i + 1;

    // ALWAYS FIRM: max lines
    if (block.lines.length > formatting.maxLines.value) {
      warnings.push({
        blockIndex,
        rule: "max_lines",
        label: "Too many lines",
        detail: `${block.lines.length} lines — max ${formatting.maxLines.value}`,
        message: `Caption #${blockIndex} has ${block.lines.length} lines (${formatting.maxLines.strict ? "limit" : "target"}: ${formatting.maxLines.value})`,
        actualValue: block.lines.length,
        targetValue: formatting.maxLines.value,
        strict: formatting.maxLines.strict,
      });
    }

    // maxCharsPerLine — firm if strict, fuzzy otherwise
    for (let li = 0; li < block.lines.length; li++) {
      const line = block.lines[li];
      if (line.length > formatting.maxCharsPerLine.value) {
        const lineLabel = block.lines.length > 1 ? `Line ${li + 1} too long` : "Line too long";
        warnings.push({
          blockIndex,
          rule: "chars_per_line",
          label: lineLabel,
          detail: `${line.length} chars — max ${formatting.maxCharsPerLine.value}`,
          message: `Caption #${blockIndex}${block.lines.length > 1 ? ` line ${li + 1}` : ""}: ${line.length} chars (${formatting.maxCharsPerLine.strict ? "limit" : "target"}: ${formatting.maxCharsPerLine.value})`,
          actualValue: line.length,
          targetValue: formatting.maxCharsPerLine.value,
          strict: formatting.maxCharsPerLine.strict,
        });
      }
    }

    // minDuration
    if (minDurationSec > 0 && duration < minDurationSec) {
      warnings.push({
        blockIndex,
        rule: "min_duration",
        label: "Too short",
        detail: `${duration.toFixed(2)}s — min ${fmtTimedValue(timing.minDuration)}`,
        message: `Caption #${blockIndex} too short: ${duration.toFixed(2)}s (${timing.minDuration.strict ? "limit" : "target"}: ${fmtTimedValue(timing.minDuration)})`,
        actualValue: duration,
        targetValue: minDurationSec,
        strict: timing.minDuration.strict,
      });
    }

    // maxDuration
    if (duration > maxDurationSec) {
      warnings.push({
        blockIndex,
        rule: "max_duration",
        label: "Too long",
        detail: `${duration.toFixed(2)}s — max ${fmtTimedValue(timing.maxDuration)}`,
        message: `Caption #${blockIndex} too long: ${duration.toFixed(2)}s (${timing.maxDuration.strict ? "limit" : "target"}: ${fmtTimedValue(timing.maxDuration)})`,
        actualValue: duration,
        targetValue: maxDurationSec,
        strict: timing.maxDuration.strict,
      });
    }

    // maxCps (reading speed)
    const totalChars = block.lines.reduce((sum, l) => sum + l.length, 0);
    if (duration > 0) {
      const cps = totalChars / duration;
      if (cps > timing.maxCps.value) {
        warnings.push({
          blockIndex,
          rule: "reading_speed",
          label: "Reading speed",
          detail: `${cps.toFixed(1)} CPS — max ${timing.maxCps.value}`,
          message: `Caption #${blockIndex}: ${cps.toFixed(1)} CPS (${totalChars} chars in ${duration.toFixed(2)}s, ${timing.maxCps.strict ? "limit" : "target"}: ≤${timing.maxCps.value})`,
          actualValue: cps,
          targetValue: timing.maxCps.value,
          strict: timing.maxCps.strict,
        });
      }
    }

    // Overlap / gap flicker
    if (i + 1 < blocks.length) {
      const next = blocks[i + 1];
      const gapSeconds = next.start - block.end;

      if (gapSeconds < 0) {
        warnings.push({
          blockIndex,
          rule: "overlap",
          label: "Overlaps next",
          detail: `by ${(-gapSeconds).toFixed(3)}s`,
          message: `Caption #${blockIndex} overlaps #${blockIndex + 1} by ${(-gapSeconds).toFixed(3)}s`,
          actualValue: gapSeconds,
          targetValue: 0,
          strict: true,
        });
      } else if (timing.minGapEnabled && gapSeconds > 0 && gapSeconds < minGapSec) {
        const gapFrames = framesBetween(block.end, next.start, fps);
        warnings.push({
          blockIndex,
          rule: "gap_flicker",
          label: "Gap too small",
          detail: `${gapFrames}f / ${gapSeconds.toFixed(3)}s — min ${fmtTimedValue(timing.minGapSeconds)}`,
          message: `Caption #${blockIndex}→#${blockIndex + 1}: ${gapFrames} frame gap (${gapSeconds.toFixed(3)}s, ${timing.minGapSeconds.strict ? "must" : "should"} be 0 or ≥${fmtTimedValue(timing.minGapSeconds)})`,
          actualValue: gapSeconds,
          targetValue: minGapSec,
          strict: timing.minGapSeconds.strict,
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
          label: "Unbalanced lines",
          detail: `${len1} vs ${len2} chars`,
          message: `Caption #${blockIndex}: unbalanced lines (${len1} vs ${len2} chars)`,
          actualValue: imbalance,
          targetValue: 0,
          strict: false,
        });
      }
    }
  }

  const rulePriority: Record<string, number> = {
    overlap: 0, gap_flicker: 1, max_lines: 2, chars_per_line: 3,
    min_duration: 4, max_duration: 4, reading_speed: 5, line_balance: 6,
  };
  warnings.sort((a, b) => {
    const strictDiff = (b.strict ? 1 : 0) - (a.strict ? 1 : 0);
    if (strictDiff !== 0) return strictDiff;
    return (rulePriority[a.rule] ?? 99) - (rulePriority[b.rule] ?? 99);
  });

  return { totalBlocks: blocks.length, warnings };
}
