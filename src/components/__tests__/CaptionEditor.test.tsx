import { describe, it, expect } from "vitest";
import { renderInitialHtml, serializeEditor } from "../CaptionEditor";
import type { StyleSpan } from "../../types/project";

// The contenteditable DOM is untrusted scratch space: these tests pin the two
// projection functions — model → HTML (mount) and DOM → model (every read) —
// including the markup shapes different engines produce under execCommand.

const em = (line: number, start: number, end: number): StyleSpan =>
  ({ line, start, end, style: "emphasis" });
const st = (line: number, start: number, end: number): StyleSpan =>
  ({ line, start, end, style: "strong" });
const un = (line: number, start: number, end: number): StyleSpan =>
  ({ line, start, end, style: "underline" });

function editorWith(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("renderInitialHtml", () => {
  it("joins lines with <br> and escapes HTML-significant characters", () => {
    expect(renderInitialHtml(["a < b", "c & d"], [])).toBe("a &lt; b<br>c &amp; d");
  });

  it("renders spans as semantic tags", () => {
    expect(renderInitialHtml(["Hello world"], [em(0, 0, 5)])).toBe("<i>Hello</i> world");
    expect(renderInitialHtml(["Hello"], [st(0, 0, 5)])).toBe("<b>Hello</b>");
    expect(renderInitialHtml(["Hello"], [un(0, 0, 5)])).toBe("<u>Hello</u>");
  });

  it("nests overlapping styles with STYLE_ORDER outermost", () => {
    expect(renderInitialHtml(["abcdef"], [st(0, 0, 4), em(0, 2, 6)]))
      .toBe("<b>ab</b><i><b>cd</b></i><i>ef</i>");
  });

  it("renders a lone <br> for an empty editor", () => {
    expect(renderInitialHtml([], [])).toBe("<br>");
    expect(renderInitialHtml([""], [])).toBe("<br>");
  });
});

describe("serializeEditor", () => {
  it("reads plain text and <br> line breaks", () => {
    expect(serializeEditor(editorWith("Hello<br>world")))
      .toEqual({ lines: ["Hello", "world"], spans: [] });
  });

  it("treats engine-inserted <div> wrappers as line breaks", () => {
    // Chromium represents added lines as sibling divs after bare first-line text.
    expect(serializeEditor(editorWith("first<div>second</div><div>third</div>")))
      .toEqual({ lines: ["first", "second", "third"], spans: [] });
  });

  it("reads semantic tags into spans (including em/strong aliases)", () => {
    expect(serializeEditor(editorWith("<i>Hello</i> <b>world</b>")).spans)
      .toEqual([em(0, 0, 5), st(0, 6, 11)]);
    expect(serializeEditor(editorWith("<em>a</em><strong>b</strong>")).spans)
      .toEqual([em(0, 0, 1), st(0, 1, 2)]);
  });

  it("reads data-style attributes", () => {
    expect(serializeEditor(editorWith('<span data-style="underline">abc</span>')).spans)
      .toEqual([un(0, 0, 3)]);
  });

  it("reads inline styles (the WebKit/styleWithCSS markup shape)", () => {
    const { spans } = serializeEditor(editorWith(
      '<span style="font-weight: 700">a</span>' +
      '<span style="font-style: italic">b</span>' +
      '<span style="text-decoration: underline">c</span>'
    ));
    expect(spans).toEqual([st(0, 0, 1), em(0, 1, 2), un(0, 2, 3)]);
  });

  it("honors inline-style negations inside styled ancestors", () => {
    // execCommand un-bolds a middle run by wrapping it in font-weight:normal.
    expect(serializeEditor(editorWith('<b>ab<span style="font-weight: normal">cd</span>ef</b>')).spans)
      .toEqual([st(0, 0, 2), st(0, 4, 6)]);
  });

  it("normalizes NBSP to plain space", () => {
    expect(serializeEditor(editorWith("a&nbsp;b")).lines).toEqual(["a b"]);
  });

  it("merges fragmented same-style siblings into one span", () => {
    expect(serializeEditor(editorWith("<b>ab</b><b>cd</b>")).spans).toEqual([st(0, 0, 4)]);
  });

  it("splits a styled run across a <br> into per-line spans", () => {
    expect(serializeEditor(editorWith("<i>ab<br>cd</i>")))
      .toEqual({ lines: ["ab", "cd"], spans: [em(0, 0, 2), em(1, 0, 2)] });
  });

  it("drops a single trailing empty line", () => {
    expect(serializeEditor(editorWith("Hello<br>")).lines).toEqual(["Hello"]);
  });

  it("keeps interior empty lines", () => {
    expect(serializeEditor(editorWith("a<br><br>b")).lines).toEqual(["a", "", "b"]);
  });

  it("reads literal newlines in text nodes as line breaks (pre-wrap Chromium shape)", () => {
    // With white-space: pre-wrap, Chromium inserts "\n" text instead of <br>.
    expect(serializeEditor(editorWith("hello\nworld")).lines).toEqual(["hello", "world"]);
    // A styled run crossing the newline splits into per-line spans.
    expect(serializeEditor(editorWith("<i>ab\ncd</i>")))
      .toEqual({ lines: ["ab", "cd"], spans: [em(0, 0, 2), em(1, 0, 2)] });
    // Multi-line paste (insertText with \n) produces one line per segment.
    expect(serializeEditor(editorWith("a\n\nb")).lines).toEqual(["a", "", "b"]);
  });

  it("reads Chromium's <div><br></div> empty-line shape as ONE blank line", () => {
    expect(serializeEditor(editorWith("a<div><br></div><div>b</div>")).lines)
      .toEqual(["a", "", "b"]);
    // An empty editor represented as a lone empty-line div stays one line.
    expect(serializeEditor(editorWith("<div><br></div>")).lines).toEqual([""]);
  });

  it("serializes an empty editor to a single empty line", () => {
    expect(serializeEditor(editorWith(""))).toEqual({ lines: [""], spans: [] });
    expect(serializeEditor(editorWith("<br>")).lines).toEqual([""]);
  });

  it("keeps text from unknown wrappers, unstyled", () => {
    expect(serializeEditor(editorWith('<span class="whatever">abc</span>')))
      .toEqual({ lines: ["abc"], spans: [] });
  });
});

describe("model → HTML → model round-trip", () => {
  const roundTrip = (lines: string[], spans: StyleSpan[]) =>
    serializeEditor(editorWith(renderInitialHtml(lines, spans)));

  it("is lossless for plain text", () => {
    expect(roundTrip(["Hello world", "second line"], []))
      .toEqual({ lines: ["Hello world", "second line"], spans: [] });
  });

  it("is lossless for styled multi-line captions", () => {
    const lines = ["Hello world", "and goodbye"];
    const spans = [em(0, 0, 5), st(0, 6, 11), un(1, 4, 11)];
    expect(roundTrip(lines, spans)).toEqual({ lines, spans });
  });

  it("is lossless for overlapping styles", () => {
    const lines = ["abcdef"];
    const spans = [em(0, 2, 6), st(0, 0, 4)];
    expect(roundTrip(lines, spans)).toEqual({ lines, spans: [st(0, 0, 4), em(0, 2, 6)] });
  });

  it("is lossless for text containing markup characters", () => {
    const lines = ["a <b> & c"];
    expect(roundTrip(lines, [em(0, 0, 9)])).toEqual({ lines, spans: [em(0, 0, 9)] });
  });
});
