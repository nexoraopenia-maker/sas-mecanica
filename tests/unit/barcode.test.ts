import { describe, expect, it } from "vitest";
import {
  barcodeModules,
  barcodePath,
  barcodeSvg,
  code128Modules,
  detectFormat,
  ean13CheckDigit,
  ean13Modules,
  internalEan13,
  isCode128Text,
  isValidEan13,
} from "@/lib/barcode";

const bits = (modules: number[]) => modules.join("");

describe("EAN-13", () => {
  it("calcula el dígito verificador (ejemplos publicados)", () => {
    expect(ean13CheckDigit("590123412345")).toBe(7);
    expect(ean13CheckDigit("400638133393")).toBe(1);
    expect(ean13CheckDigit("775000111222")).toBe(8);
  });

  it("valida códigos completos", () => {
    expect(isValidEan13("5901234123457")).toBe(true);
    expect(isValidEan13("5901234123458")).toBe(false);
    expect(isValidEan13("590123412345")).toBe(false);
    expect(isValidEan13("59012341234a7")).toBe(false);
    expect(isValidEan13("7750001112228")).toBe(true);
  });

  it("genera 95 módulos con guardas y mitad derecha estándar", () => {
    const modules = bits(ean13Modules("5901234123457"));
    expect(modules).toHaveLength(95);
    expect(modules.slice(0, 3)).toBe("101");
    expect(modules.slice(45, 50)).toBe("01010");
    expect(modules.slice(92)).toBe("101");
    // Dígitos 1 2 3 4 5 7 de la derecha: patrón R del estándar.
    const right = ["1100110", "1101100", "1000010", "1011100", "1001110", "1000100"];
    expect(modules.slice(50, 92)).toBe(right.join(""));
  });

  it("elige la paridad de la izquierda según el primer dígito (5 → LGGLLG)", () => {
    const modules = bits(ean13Modules("5901234123457"));
    // 9 (L)=0001011, 0 (G)=0100111, 1 (G)=0110011, 2 (L)=0010011, 3 (L)=0111101, 4 (G)=0011101
    const left = ["0001011", "0100111", "0110011", "0010011", "0111101", "0011101"];
    expect(modules.slice(3, 45)).toBe(left.join(""));
  });

  it("rechaza un EAN inválido", () => {
    expect(() => ean13Modules("5901234123458")).toThrow();
  });
});

describe("EAN-13 interno (prefijo 2)", () => {
  it("construye códigos válidos y distintos por correlativo", () => {
    const first = internalEan13(1);
    expect(first).toHaveLength(13);
    expect(first.startsWith("2")).toBe(true);
    expect(isValidEan13(first)).toBe(true);
    expect(first.slice(0, 12)).toBe("200000000001");
    expect(internalEan13(2)).not.toBe(first);
    expect(isValidEan13(internalEan13(987_654_321))).toBe(true);
  });

  it("rechaza correlativos fuera de rango", () => {
    expect(() => internalEan13(0)).toThrow();
    expect(() => internalEan13(1.5)).toThrow();
    expect(() => internalEan13(100_000_000_000)).toThrow();
  });

  it("los 5000 primeros no se repiten", () => {
    const seen = new Set(Array.from({ length: 5000 }, (_v, i) => internalEan13(i + 1)));
    expect(seen.size).toBe(5000);
  });
});

describe("Code 128", () => {
  it("empieza con Start B, termina con Stop y tiene el largo esperado", () => {
    const modules = bits(code128Modules("SKU-123"));
    // start(11) + 7 caracteres(77) + checksum(11) + stop(13)
    expect(modules).toHaveLength(11 + 7 * 11 + 11 + 13);
    expect(modules.startsWith("11010010000")).toBe(true);
    expect(modules.endsWith("1100011101011")).toBe(true);
  });

  it("el checksum cambia si cambia un carácter", () => {
    expect(bits(code128Modules("AB"))).not.toBe(bits(code128Modules("AC")));
  });

  it("reconoce el texto soportado", () => {
    expect(isCode128Text("FIL-ACE_01")).toBe(true);
    expect(isCode128Text("")).toBe(false);
    expect(isCode128Text("ñandú")).toBe(false);
    expect(isCode128Text("x".repeat(41))).toBe(false);
    expect(() => code128Modules("ñ")).toThrow();
  });
});

describe("selección de formato y SVG", () => {
  it("usa EAN-13 para 13 dígitos válidos y Code 128 para lo demás", () => {
    expect(detectFormat("7750001112228")).toBe("EAN13");
    expect(detectFormat("7750001112229")).toBe("CODE128");
    expect(detectFormat("SKU-1")).toBe("CODE128");
    expect(barcodeModules("7750001112228").modules).toHaveLength(95);
  });

  it("dibuja las barras como un trazado con zona de silencio", () => {
    const path = barcodePath("7750001112228", 40);
    expect(path.width).toBe(95 + 20);
    expect(path.d.startsWith("M10 0")).toBe(true);
    const svg = barcodeSvg("7750001112228", { label: 'a"<b' });
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 115 60"');
    expect(svg).not.toContain('a"<b');
  });
});
