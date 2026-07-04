import { Fragment } from "preact";
import type { ComponentChildren } from "preact";
import type { StyleSpan } from "../types/project";
import { segmentLine } from "../lib/spans";

// Renders caption lines with their styling overlay. The single render path
// for styled caption text — caption rows, the video overlay, and timeline
// block labels all go through here so styling can never disagree between
// surfaces. Styles become nested <span data-style="…"> (outermost follows
// STYLE_ORDER, matching the export emitter's nesting); search-match
// decorations become <mark class="search-match"> without touching the model.

export interface StyledLinesProps {
  lines: string[];
  spans?: StyleSpan[];
  /** Ephemeral highlight ranges in joined-text offsets (lines joined with
   *  "\n") — e.g. caption-search matches. Split per line here, since a match
   *  can cross the line break. */
  decorations?: readonly { start: number; end: number }[];
  /** Element wrapping each line. */
  lineAs?: "span" | "div";
  lineClass?: string;
  /** "br" inserts <br> between lines, for prose-style text blocks. */
  separator?: "br" | null;
}

function wrapStyles(seg: { text: string; styles: readonly { style: string; value?: string }[] }): ComponentChildren {
  let node: ComponentChildren = seg.text;
  // Wrap inner-to-outer so the outermost element is first in STYLE_ORDER.
  for (let j = seg.styles.length - 1; j >= 0; j--) {
    const s = seg.styles[j];
    node = (
      <span data-style={s.style} {...(s.value !== undefined ? { "data-value": s.value } : {})}>
        {node}
      </span>
    );
  }
  return node;
}

function renderSegments(
  text: string,
  spans: StyleSpan[],
  decorations: { start: number; end: number }[],
): ComponentChildren {
  const segs = segmentLine(text, spans, decorations);
  const out: ComponentChildren[] = [];
  // One <mark> per contiguous matched run, not per segment — a match crossing
  // a style boundary must stay a single highlight box (each mark carries its
  // own border-radius, so per-segment marks would notch mid-highlight).
  let i = 0;
  while (i < segs.length) {
    if (!segs[i].match) {
      out.push(<Fragment key={i}>{wrapStyles(segs[i])}</Fragment>);
      i++;
      continue;
    }
    const run: ComponentChildren[] = [];
    const runStart = i;
    while (i < segs.length && segs[i].match) {
      run.push(<Fragment key={i}>{wrapStyles(segs[i])}</Fragment>);
      i++;
    }
    out.push(<mark key={`m${runStart}`} class="search-match">{run}</mark>);
  }
  return out;
}

export function StyledLines({
  lines,
  spans,
  decorations,
  lineAs = "span",
  lineClass,
  separator = null,
}: StyledLinesProps) {
  const Tag = lineAs as "span";
  let lineStart = 0;
  return (
    <>
      {lines.map((line, i) => {
        const start = lineStart;
        lineStart += line.length + 1; // +1 for the "\n" separator
        const lineSpans = spans?.filter((s) => s.line === i) ?? [];
        const lineDecorations = (decorations ?? [])
          .map((d) => ({
            start: Math.max(d.start, start) - start,
            end: Math.min(d.end, start + line.length) - start,
          }))
          .filter((d) => d.start < d.end);
        return (
          <Fragment key={i}>
            {i > 0 && separator === "br" && <br />}
            <Tag class={lineClass}>{renderSegments(line, lineSpans, lineDecorations)}</Tag>
          </Fragment>
        );
      })}
    </>
  );
}
