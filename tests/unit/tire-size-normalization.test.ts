import { describe, expect, it } from "vitest";
import { formatTireSize, parseTireSize } from "@/lib/inventory/tire";

const CANONICAL = { width: 205, aspectRatio: 55, rimDiameter: 16 };

describe("normalización de la medida de llanta", () => {
  it.each([
    "205/55 R16",
    "205/55R16",
    "205/55 r16",
    "205 55 16",
    "205 55 r16",
    "205-55-16",
    "205-55 R16",
    "205/55/16",
    "205 / 55 R 16",
    "2055516",
    "  205/55R16  ",
    "205/55-R16",
  ])("%j equivale a 205/55 R16", (input) => {
    expect(parseTireSize(input)).toEqual(CANONICAL);
  });

  it("todas las variantes dan el mismo texto canónico", () => {
    const forms = ["205/55R16", "205 55 16", "205/55 r16", "2055516"];
    expect(new Set(forms.map((f) => formatTireSize(parseTireSize(f) ?? CANONICAL))).size).toBe(1);
    expect(formatTireSize(CANONICAL)).toBe("205/55 R16");
  });

  it("acepta aros con media pulgada (15,5 y 15.5)", () => {
    expect(parseTireSize("265/70R15,5")?.rimDiameter).toBe(15.5);
    expect(parseTireSize("265 70 15.5")?.rimDiameter).toBe(15.5);
  });

  it.each([
    "",
    "xx",
    "205/55",
    "20/55R16",
    "205/5R16",
    "999/55R16",
    "205/55R99",
    "205/55R16X",
    "205//55R16",
  ])("rechaza %j", (input) => {
    expect(parseTireSize(input)).toBeNull();
  });
});
