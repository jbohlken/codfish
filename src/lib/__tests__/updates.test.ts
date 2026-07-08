import { describe, it, expect, beforeEach } from "vitest";
import {
  compareVersions,
  isOsSupported,
  updateChannel,
  setUpdateChannel,
} from "../updates";

describe("compareVersions", () => {
  it("orders by numeric segments", () => {
    expect(compareVersions("13.4.1", "13.4.0")).toBe(1);
    expect(compareVersions("13.4", "13.5")).toBe(-1);
    expect(compareVersions("14.0", "13.9")).toBe(1);
  });

  it("treats missing trailing segments as zero", () => {
    expect(compareVersions("13.4", "13.4.0")).toBe(0);
    expect(compareVersions("13.4.0", "13.4")).toBe(0);
    expect(compareVersions("13", "13.0.0")).toBe(0);
  });

  it("does not compare lexically (10 > 9)", () => {
    expect(compareVersions("10.0", "9.0")).toBe(1);
    expect(compareVersions("13.10", "13.9")).toBe(1);
  });

  it("treats non-numeric segments as zero", () => {
    expect(compareVersions("Unknown", "0.0.0")).toBe(0);
    expect(compareVersions("13.x", "13.0")).toBe(0);
  });
});

describe("isOsSupported", () => {
  it("passes when the OS meets or exceeds the floor", () => {
    expect(isOsSupported("13.4.0", "13.4")).toBe(true);
    expect(isOsSupported("13.5", "13.4")).toBe(true);
    expect(isOsSupported("14.0", "13.4")).toBe(true);
  });

  it("fails when the OS is below the floor", () => {
    expect(isOsSupported("13.3", "13.4")).toBe(false);
    expect(isOsSupported("12.7.6", "13.4")).toBe(false);
    expect(isOsSupported("10.15.7", "13.4")).toBe(false);
  });

  it("imposes no gate when there is no floor", () => {
    expect(isOsSupported("10.15.7", null)).toBe(true);
    expect(isOsSupported("10.15.7", undefined)).toBe(true);
    expect(isOsSupported("Unknown", "")).toBe(true);
  });

  it("fails safe when the OS version is unknowable but a floor exists", () => {
    // Never offer an update we can't prove the OS can run.
    expect(isOsSupported("Unknown", "13.4")).toBe(false);
    expect(isOsSupported("", "13.4")).toBe(false);
  });
});

describe("updateChannel preference", () => {
  beforeEach(() => localStorage.clear());

  it("persists and reflects the chosen channel", () => {
    setUpdateChannel("beta");
    expect(updateChannel.value).toBe("beta");
    expect(localStorage.getItem("codfish:updateChannel")).toBe("beta");
    setUpdateChannel("stable");
    expect(updateChannel.value).toBe("stable");
    expect(localStorage.getItem("codfish:updateChannel")).toBe("stable");
  });
});
