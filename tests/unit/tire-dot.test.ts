import { describe, expect, it } from "vitest";
import {
  formatTireSize,
  isTireTooOld,
  parseDot,
  parseTireSize,
  tireAgeYears,
} from "@/lib/inventory/tire";

describe("medidas de llanta", () => {
  it.each([
    ["205/55 R16", 205, 55, 16],
    ["205/55R16", 205, 55, 16],
    ["205/55r16", 205, 55, 16],
    ["205-55-16", 205, 55, 16],
    ["205 55 16", 205, 55, 16],
    ["2055516", 205, 55, 16],
    ["265/65 R17", 265, 65, 17],
    ["175/70 R13", 175, 70, 13],
    ["225/45 R16.5", 225, 45, 16.5],
  ])("interpreta %s", (text, width, aspectRatio, rimDiameter) => {
    expect(parseTireSize(text)).toEqual({ width, aspectRatio, rimDiameter });
  });

  it.each([
    "",
    "abc",
    "20/55 R16",
    "205/5 R16",
    "205/55 R5",
    "999/55 R16",
    "205/55 R99",
    "205//55",
  ])("rechaza %j", (text) => {
    expect(parseTireSize(text)).toBeNull();
  });

  it("formatea de forma canónica", () => {
    expect(formatTireSize({ width: 205, aspectRatio: 55, rimDiameter: 16 })).toBe("205/55 R16");
  });
});

describe("código DOT", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("2423 = semana 24 de 2023 (lunes 12 de junio)", () => {
    const parsed = parseDot("2423", now);
    expect(parsed).toMatchObject({ week: 24, year: 2023 });
    expect(parsed?.manufacturedAt.toISOString()).toBe("2023-06-12T00:00:00.000Z");
  });

  it("semana 1 contiene el 4 de enero (ISO)", () => {
    expect(parseDot("0120", now)?.manufacturedAt.toISOString()).toBe("2019-12-30T00:00:00.000Z");
    expect(parseDot("0125", now)?.manufacturedAt.toISOString()).toBe("2024-12-30T00:00:00.000Z");
  });

  it.each(["0023", "5423", "2", "24234", "ab23", "", "24 23"])("rechaza %j", (dot) => {
    expect(parseDot(dot, now)).toBeNull();
  });

  it("rechaza fechas futuras", () => {
    expect(parseDot("5226", now)).toBeNull();
    expect(parseDot("4226", now)).not.toBeNull(); // semana 42 de 2026 = esta semana
  });

  it("calcula la antigüedad y la alerta de llantas viejas", () => {
    const old = parseDot("1218", now)?.manufacturedAt ?? now;
    expect(tireAgeYears(old, now)).toBeGreaterThan(8);
    expect(isTireTooOld(old, 5, now)).toBe(true);
    expect(isTireTooOld(parseDot("2425", now)?.manufacturedAt ?? now, 5, now)).toBe(false);
    expect(isTireTooOld(null, 5, now)).toBe(false);
  });
});
