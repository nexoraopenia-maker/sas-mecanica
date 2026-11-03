import { describe, expect, it } from "vitest";
import {
  checkLogo,
  imageDimensions,
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  LOGO_MIN_SIDE,
} from "@/lib/branding/logo";
import { jpeg, png, SVG, webpExtended, webpLossy } from "../helpers/images.ts";

describe("dimensiones leídas de la cabecera", () => {
  it("PNG, JPEG y WebP (lossy y extendido)", () => {
    expect(imageDimensions(png(300, 120), "image/png")).toEqual({ width: 300, height: 120 });
    expect(imageDimensions(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpLossy(200, 100), "image/webp")).toEqual({ width: 200, height: 100 });
    expect(imageDimensions(webpExtended(1024, 512), "image/webp")).toEqual({
      width: 1024,
      height: 512,
    });
  });
  it("una cabecera dañada devuelve null", () => {
    expect(imageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBeNull();
  });
});

describe("validación del logo", () => {
  it("acepta PNG, JPG y WebP dentro de los límites", () => {
    for (const bytes of [png(400, 150), jpeg(400, 150), webpLossy(400, 150)]) {
      const result = checkLogo(bytes);
      expect(result.ok).toBe(true);
    }
  });
  it("acepta justo los límites de lado", () => {
    expect(checkLogo(png(LOGO_MIN_SIDE, LOGO_MIN_SIDE)).ok).toBe(true);
    expect(checkLogo(png(LOGO_MAX_SIDE, LOGO_MAX_SIDE)).ok).toBe(true);
  });
  it("rechaza SVG y archivos que no son imagen, aunque se disfracen", () => {
    for (const bytes of [SVG, new TextEncoder().encode("<html><body>hola</body></html>")]) {
      const result = checkLogo(bytes);
      expect(result).toMatchObject({ ok: false });
    }
    expect(checkLogo(SVG)).toMatchObject({ error: expect.stringContaining("SVG") });
  });
  it("rechaza un archivo vacío", () => {
    expect(checkLogo(new Uint8Array())).toMatchObject({ ok: false });
  });
  it("rechaza más de 1 MB", () => {
    expect(checkLogo(png(400, 150, LOGO_MAX_BYTES))).toMatchObject({
      ok: false,
      error: expect.stringContaining("1 MB"),
    });
    expect(checkLogo(png(400, 150, LOGO_MAX_BYTES - 40)).ok).toBe(true);
  });
  it("rechaza dimensiones fuera de rango y proporciones extremas", () => {
    expect(checkLogo(png(63, 200))).toMatchObject({
      ok: false,
      error: expect.stringContaining("pequeño"),
    });
    expect(checkLogo(png(2049, 500))).toMatchObject({
      ok: false,
      error: expect.stringContaining("grande"),
    });
    expect(checkLogo(png(2000, 100))).toMatchObject({
      ok: false,
      error: expect.stringContaining("alargadas"),
    });
  });
  it("rechaza una cabecera con dimensiones imposibles", () => {
    expect(checkLogo(png(0, 0))).toMatchObject({ ok: false });
  });
});
