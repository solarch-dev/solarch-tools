import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { LOGO_LINES, paintLogo, renderBanner, renderVersionScreen, colorsEnabled } from "../src/brand.js";

describe("brand", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env, NO_COLOR: "1" };
  });

  afterEach(() => {
    process.env = env;
  });

  it("logo has expected height", () => {
    expect(LOGO_LINES.length).toBeGreaterThanOrEqual(14);
  });

  it("paintLogo preserves structure without color", () => {
    const out = paintLogo();
    expect(out).toMatch(/ff/i);
    expect(out.split("\n").length).toBe(LOGO_LINES.length);
  });

  it("renderBanner includes version", () => {
    expect(renderBanner({ version: "0.6.0" })).toContain("SOLARCH");
    expect(renderBanner({ version: "0.6.0" })).toContain("v0.6.0");
  });

  it("renderVersionScreen includes connect hint", () => {
    expect(renderVersionScreen("0.6.0")).toContain("solarch connect");
  });

  it("colorsEnabled respects NO_COLOR", () => {
    process.env.NO_COLOR = "1";
    expect(colorsEnabled()).toBe(false);
  });
});
