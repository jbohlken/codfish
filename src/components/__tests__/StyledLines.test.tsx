import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/preact";
import { StyledLines } from "../StyledLines";
import type { StyleSpan } from "../../types/project";

afterEach(cleanup);

const em = (line: number, start: number, end: number): StyleSpan =>
  ({ line, start, end, style: "emphasis" });
const st = (line: number, start: number, end: number): StyleSpan =>
  ({ line, start, end, style: "strong" });

const html = (ui: Parameters<typeof render>[0]) => render(ui).container.innerHTML;

describe("StyledLines", () => {
  it("renders plain lines with the requested wrapper and class", () => {
    expect(html(<StyledLines lines={["Hello", "world"]} lineAs="span" lineClass="cap" />))
      .toBe('<span class="cap">Hello</span><span class="cap">world</span>');
  });

  it("inserts <br> separators between lines when requested", () => {
    expect(html(<StyledLines lines={["Hello", "world"]} separator="br" />))
      .toBe("<span>Hello</span><br><span>world</span>");
  });

  it("wraps styled ranges in data-style spans", () => {
    expect(html(<StyledLines lines={["Hello world"]} spans={[em(0, 0, 5)]} />))
      .toBe('<span><span data-style="emphasis">Hello</span> world</span>');
  });

  it("nests overlapping styles with STYLE_ORDER outermost-first", () => {
    expect(html(<StyledLines lines={["abcdef"]} spans={[st(0, 0, 4), em(0, 2, 6)]} />))
      .toBe(
        '<span><span data-style="strong">ab</span>' +
        '<span data-style="emphasis"><span data-style="strong">cd</span></span>' +
        '<span data-style="emphasis">ef</span></span>'
      );
  });

  it("only applies spans to their own line", () => {
    expect(html(<StyledLines lines={["Hello", "world"]} spans={[em(1, 0, 5)]} />))
      .toBe('<span>Hello</span><span><span data-style="emphasis">world</span></span>');
  });

  it("renders decorations as search-match marks", () => {
    expect(html(<StyledLines lines={["Hello world"]} decorations={[{ start: 6, end: 11 }]} />))
      .toBe('<span>Hello <mark class="search-match">world</mark></span>');
  });

  it("splits a decoration that crosses the line break", () => {
    // joined text "ab\ncd": decoration [1,4) covers "b\nc"
    expect(html(<StyledLines lines={["ab", "cd"]} decorations={[{ start: 1, end: 4 }]} />))
      .toBe(
        '<span>a<mark class="search-match">b</mark></span>' +
        '<span><mark class="search-match">c</mark>d</span>'
      );
  });

  it("composes decorations over styled text with the mark outermost", () => {
    expect(html(
      <StyledLines lines={["Hello"]} spans={[em(0, 0, 5)]} decorations={[{ start: 0, end: 5 }]} />
    )).toBe('<span><mark class="search-match"><span data-style="emphasis">Hello</span></mark></span>');
  });

  it("keeps a match crossing a style boundary inside one mark", () => {
    // strong covers [0,4), match covers [2,6) — the highlight must be a single
    // box even though the styling changes mid-match.
    expect(html(
      <StyledLines lines={["abcdef"]} spans={[st(0, 0, 4)]} decorations={[{ start: 2, end: 6 }]} />
    )).toBe(
      '<span><span data-style="strong">ab</span>' +
      '<mark class="search-match"><span data-style="strong">cd</span>ef</mark></span>'
    );
  });

  it("survives out-of-range and garbage span offsets", () => {
    expect(html(<StyledLines lines={["abc"]} spans={[em(0, 1, 99)]} />))
      .toBe('<span>a<span data-style="emphasis">bc</span></span>');
    expect(html(<StyledLines lines={["abc"]} spans={[em(7, 0, 2)]} />))
      .toBe("<span>abc</span>");
  });

  it("renders empty lines as empty wrappers", () => {
    expect(html(<StyledLines lines={[""]} />)).toBe("<span></span>");
  });

  it("renders span values as data-value (future <c.class>-style keys)", () => {
    const valued: StyleSpan = { line: 0, start: 0, end: 3, style: "emphasis", value: "x" };
    expect(html(<StyledLines lines={["abc"]} spans={[valued]} />))
      .toBe('<span><span data-style="emphasis" data-value="x">abc</span></span>');
  });
});
