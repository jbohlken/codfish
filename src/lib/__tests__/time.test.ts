import { describe, it, expect } from "vitest";
import {
  EPSILON,
  timeEq, timeLt, timeGt, timeLte, timeGte,
  snapToFrame, framesBetween,
  toSeconds,
  timeComponents,
  isDropFrameRate,
  formatSmpte,
  formatDisplayTime,
} from "../time";

// ── Epsilon comparisons ────────────────────────────────────────────────────

describe("timeEq", () => {
  it("equal values", () => {
    expect(timeEq(1.0, 1.0)).toBe(true);
  });

  it("values within epsilon", () => {
    expect(timeEq(1.0, 1.0 + EPSILON / 2)).toBe(true);
  });

  it("values outside epsilon", () => {
    expect(timeEq(1.0, 1.0 + EPSILON * 2)).toBe(false);
  });

  it("classic floating-point case: 0.1 + 0.2 vs 0.3", () => {
    expect(timeEq(0.1 + 0.2, 0.3)).toBe(true);
  });
});

describe("timeLt", () => {
  it("genuinely less", () => {
    expect(timeLt(1.0, 2.0)).toBe(true);
  });

  it("approximately equal (not less)", () => {
    expect(timeLt(1.0, 1.0 + EPSILON / 2)).toBe(false);
  });

  it("genuinely greater", () => {
    expect(timeLt(2.0, 1.0)).toBe(false);
  });
});

describe("timeGt", () => {
  it("genuinely greater", () => {
    expect(timeGt(2.0, 1.0)).toBe(true);
  });

  it("approximately equal (not greater)", () => {
    expect(timeGt(1.0, 1.0 - EPSILON / 2)).toBe(false);
  });

  it("genuinely less", () => {
    expect(timeGt(1.0, 2.0)).toBe(false);
  });
});

describe("timeLte", () => {
  it("less", () => {
    expect(timeLte(1.0, 2.0)).toBe(true);
  });

  it("approximately equal", () => {
    expect(timeLte(1.0, 1.0 + EPSILON / 2)).toBe(true);
  });

  it("genuinely greater", () => {
    expect(timeLte(2.0, 1.0)).toBe(false);
  });
});

describe("timeGte", () => {
  it("greater", () => {
    expect(timeGte(2.0, 1.0)).toBe(true);
  });

  it("approximately equal", () => {
    expect(timeGte(1.0, 1.0 - EPSILON / 2)).toBe(true);
  });

  it("genuinely less", () => {
    expect(timeGte(1.0, 2.0)).toBe(false);
  });
});

// ── Frame operations ───────────────────────────────────────────────────────

describe("snapToFrame", () => {
  it("snaps whole second at 30fps", () => {
    expect(snapToFrame(1.0, 30)).toBe(1.0);
  });

  it("snaps near-frame boundary down at 30fps", () => {
    expect(snapToFrame(1.016, 30)).toBe(1.0);
  });

  it("snaps near-frame boundary up at 30fps", () => {
    expect(snapToFrame(1.034, 30)).toBeCloseTo(1 + 1 / 30, 10);
  });

  it("snaps at 24fps", () => {
    expect(snapToFrame(0.05, 24)).toBeCloseTo(1 / 24, 3);
  });

  it("snaps at 60fps", () => {
    expect(snapToFrame(0.5, 60)).toBe(0.5);
  });

  it("round-trip stability at 29.97fps", () => {
    const t = 1.5;
    const snapped = snapToFrame(t, 29.97);
    const resnapped = snapToFrame(snapped, 29.97);
    expect(snapped).toBe(resnapped);
  });

  it("round-trip stability at 29.97fps — many values", () => {
    for (let i = 0; i < 100; i++) {
      const t = i * 0.1337; // arbitrary non-aligned times
      const snapped = snapToFrame(t, 29.97);
      const resnapped = snapToFrame(snapped, 29.97);
      expect(resnapped).toBe(snapped);
    }
  });

  it("consecutive frames at 29.97fps differ by exactly 1 frame", () => {
    for (let frame = 0; frame < 100; frame++) {
      const t1 = snapToFrame(frame / 29.97, 29.97);
      const t2 = snapToFrame((frame + 1) / 29.97, 29.97);
      expect(framesBetween(t1, t2, 29.97)).toBe(1);
    }
  });
});

describe("framesBetween", () => {
  it("30 frames in 1 second at 30fps", () => {
    expect(framesBetween(0, 1.0, 30)).toBe(30);
  });

  it("15 frames in 0.5 seconds at 30fps", () => {
    expect(framesBetween(0, 0.5, 30)).toBe(15);
  });

  it("0 for zero gap", () => {
    expect(framesBetween(1.0, 1.0, 30)).toBe(0);
  });

  it("consistent with snapToFrame at 29.97fps", () => {
    const a = snapToFrame(1.0, 29.97);
    const b = snapToFrame(2.0, 29.97);
    const frames = framesBetween(a, b, 29.97);
    expect(frames).toBe(30); // ~1 second at 29.97fps = 30 frames
  });
});

// ── Unit conversion ────────────────────────────────────────────────────────

describe("toSeconds", () => {
  it("seconds pass through", () => {
    expect(toSeconds({ value: 1.5, strict: false, unit: "s" }, 30)).toBe(1.5);
  });

  it("frames converted at 30fps", () => {
    expect(toSeconds({ value: 30, strict: false, unit: "fr" }, 30)).toBeCloseTo(1.0, 10);
  });

  it("frames converted at 29.97fps", () => {
    expect(toSeconds({ value: 30, strict: false, unit: "fr" }, 29.97)).toBeCloseTo(30 / 29.97, 10);
  });

  it("frames converted at 24fps", () => {
    expect(toSeconds({ value: 24, strict: false, unit: "fr" }, 24)).toBeCloseTo(1.0, 10);
  });
});

// ── Time components ────────────────────────────────────────────────────────

describe("timeComponents", () => {
  it("zero", () => {
    const { h, m, s, frac } = timeComponents(0);
    expect(h).toBe(0);
    expect(m).toBe(0);
    expect(s).toBe(0);
    expect(frac).toBe(0);
  });

  it("basic values", () => {
    const { h, m, s, frac } = timeComponents(3661.5);
    expect(h).toBe(1);
    expect(m).toBe(1);
    expect(s).toBe(1);
    expect(frac).toBeCloseTo(0.5, 10);
  });

  it("fractional precision: 0.1", () => {
    const { frac } = timeComponents(0.1);
    expect(Math.floor(frac * 1000)).toBe(100);
  });

  it("fractional precision: 0.999", () => {
    const { frac } = timeComponents(0.999);
    expect(Math.floor(frac * 1000)).toBe(999);
  });

  it("fractional precision: frame boundary at 29.97fps", () => {
    // 1 frame = 1/29.97 ≈ 0.033366...
    const t = snapToFrame(1.0, 29.97); // should be very close to 1.0
    const { s, frac } = timeComponents(t);
    // The snapped value of 1.0 at 29.97fps: Math.round(1.0 * 29.97) = 30, 30 / 29.97 ≈ 1.001001...
    // So s should be 1 and frac should be ~0.001
    expect(s).toBe(1);
    expect(frac).toBeCloseTo(30 / 29.97 - 1, 8);
  });

  it("no negative fractional part", () => {
    for (let i = 0; i < 50; i++) {
      const t = i * 0.333;
      const { frac } = timeComponents(t);
      expect(frac).toBeGreaterThanOrEqual(0);
      expect(frac).toBeLessThan(1);
    }
  });
});

// ── SMPTE ──────────────────────────────────────────────────────────────────

describe("isDropFrameRate", () => {
  it("29.97 is drop-frame", () => {
    expect(isDropFrameRate(29.97)).toBe(true);
  });

  it("59.94 is drop-frame", () => {
    expect(isDropFrameRate(59.94)).toBe(true);
  });

  it("24 is not drop-frame", () => {
    expect(isDropFrameRate(24)).toBe(false);
  });

  it("25 is not drop-frame", () => {
    expect(isDropFrameRate(25)).toBe(false);
  });

  it("30 is not drop-frame", () => {
    expect(isDropFrameRate(30)).toBe(false);
  });

  it("60 is not drop-frame", () => {
    expect(isDropFrameRate(60)).toBe(false);
  });
});

describe("formatSmpte", () => {
  // NDF tests
  it("NDF at 29.97fps", () => {
    expect(formatSmpte(1.2, 29.97, false)).toBe("00:00:01:05");
  });

  it("NDF at 24fps", () => {
    expect(formatSmpte(1.2, 24, false)).toBe("00:00:01:04");
  });

  it("NDF at 25fps — zero", () => {
    expect(formatSmpte(0, 25, false)).toBe("00:00:00:00");
  });

  it("NDF rolls over seconds", () => {
    expect(formatSmpte(61.5, 24, false)).toBe("00:01:01:12");
  });

  it("NDF rolls over hours", () => {
    expect(formatSmpte(3661.0, 24, false)).toBe("01:01:01:00");
  });

  // DF tests — 29.97fps
  it("DF at 29.97fps — zero", () => {
    expect(formatSmpte(0, 29.97, true)).toBe("00:00:00;00");
  });

  it("DF at 29.97fps — basic", () => {
    expect(formatSmpte(1.2, 29.97, true)).toBe("00:00:01;05");
  });

  it("DF skips frames 0-1 at minute boundary", () => {
    const t = 1800 / 29.97;
    expect(formatSmpte(t, 29.97, true)).toBe("00:01:00;02");
  });

  it("DF does NOT skip at 10-minute boundaries", () => {
    const t = 17982 / 29.97;
    expect(formatSmpte(t, 29.97, true)).toBe("00:10:00;00");
  });

  it("DF falls back to NDF for 24fps", () => {
    const ndf = formatSmpte(1.2, 24, false);
    const dfFallback = formatSmpte(1.2, 24, true);
    expect(dfFallback).toBe(ndf);
    expect(dfFallback).not.toContain(";");
  });

  it("DF falls back to NDF for 25fps", () => {
    expect(formatSmpte(1.2, 25, true)).toBe(formatSmpte(1.2, 25, false));
  });

  it("DF at 59.94fps", () => {
    const result = formatSmpte(1.2, 59.94, true);
    expect(result).toContain(";");
    expect(result).toBe("00:00:01;11");
  });
});

// ── Display formatting ─────────────────────────────────────────────────────

describe("formatDisplayTime", () => {
  describe("time mode", () => {
    it("zero", () => {
      expect(formatDisplayTime(0, "time", 30)).toBe("00:00:00.000");
    });

    it("basic value", () => {
      expect(formatDisplayTime(3661.5, "time", 30)).toBe("01:01:01.500");
    });

    it("millisecond precision", () => {
      expect(formatDisplayTime(1.234, "time", 30)).toBe("00:00:01.234");
    });

    it("compact omits hours when zero", () => {
      expect(formatDisplayTime(61.5, "time", 30, true)).toBe("1:01.500");
    });

    it("compact keeps hours when non-zero", () => {
      expect(formatDisplayTime(3661.5, "time", 30, true)).toBe("01:01:01.500");
    });

    it("precision guard: 0.1 displays as 100ms", () => {
      const result = formatDisplayTime(0.1, "time", 30);
      expect(result).toBe("00:00:00.100");
    });
  });

  describe("smpte mode", () => {
    it("delegates to formatSmpte NDF", () => {
      expect(formatDisplayTime(1.2, "smpte", 29.97)).toBe("00:00:01:05");
    });
  });

  describe("smpte-df mode", () => {
    it("delegates to formatSmpte DF", () => {
      expect(formatDisplayTime(0, "smpte-df", 29.97)).toBe("00:00:00;00");
    });

    it("falls back to NDF for non-DF fps", () => {
      expect(formatDisplayTime(1.2, "smpte-df", 24)).toBe(formatDisplayTime(1.2, "smpte", 24));
    });
  });

  describe("frames mode", () => {
    it("shows frame count", () => {
      expect(formatDisplayTime(1.0, "frames", 30)).toBe("30f");
    });

    it("truncates partial frame", () => {
      expect(formatDisplayTime(0.5, "frames", 24)).toBe("12f");
    });

    it("zero", () => {
      expect(formatDisplayTime(0, "frames", 30)).toBe("0f");
    });
  });
});
