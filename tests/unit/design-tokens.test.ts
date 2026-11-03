import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND_BACKGROUND } from "@/lib/brand";

const ROOT = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx|ts)$/.test(name) ? [path] : [];
  });
}

const PALETTE =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const LOOSE_COLOR = new RegExp(
  [
    `\\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|shadow|decoration|accent|caret)-(?:${PALETTE})-\\d{2,3}\\b`,
    "\\b(?:bg|text|border|ring|fill|stroke|divide|outline)-(?:white|black)\\b",
    "#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3}\\b",
    "\\b(?:rgb|rgba|hsl|hsla|oklch|lab|lch)\\(",
  ].join("|"),
);

describe("identidad visual: solo tokens, sin colores sueltos", () => {
  const files = [...sources(join(ROOT, "app")), ...sources(join(ROOT, "components"))];

  it("revisa los componentes y páginas", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((file) => [file.slice(ROOT.length + 1), file]))(
    "%s no define colores propios",
    (_name, file) => {
      const offenders = readFileSync(file as string, "utf8")
        .split("\n")
        .flatMap((line, index) => {
          const match = LOOSE_COLOR.exec(line);
          return match ? [`línea ${index + 1}: ${match[0]}`] : [];
        });
      expect(offenders).toEqual([]);
    },
  );

  it("globals.css define todos los tokens de la marca", () => {
    const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
    for (const token of [
      "background",
      "card",
      "border",
      "foreground",
      "muted",
      "primary",
      "ring",
      "success",
      "warning",
      "danger",
    ])
      expect(css).toMatch(new RegExp(`--color-${token}:`));
    expect(css).toContain(BRAND_BACKGROUND);
    expect(css).toMatch(new RegExp(`--background:\\s*${BRAND_BACKGROUND};`));
    expect(css).toContain("--glow-cyan: 0 245 255");
    expect(css).toContain("--glow-violet: 191 90 242");
  });
});
