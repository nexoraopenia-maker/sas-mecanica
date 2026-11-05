import { describe, expect, it } from "vitest";
import { matchScan, ScanDebouncer, scanCandidates } from "@/lib/pos/scan";
import type { PosProduct } from "@/lib/pos/types";

const p = (over: Partial<PosProduct> & Pick<PosProduct, "id" | "sku">): PosProduct => ({
  name: over.sku,
  barcode: null,
  kind: "PART",
  brand: null,
  salePrice: "10.00",
  stock: 1,
  trackingMode: "NONE",
  isStocked: true,
  taxAffectation: "TAXED",
  codes: [],
  tire: null,
  ...over,
});

describe("candidatos de un código leído", () => {
  it("el texto literal siempre va primero", () => {
    expect(scanCandidates("  7750001112223 ")[0]).toBe("7750001112223");
    expect(scanCandidates("")).toEqual([]);
    expect(scanCandidates("   ")).toEqual([]);
  });
  it("QR con enlace: usa el parámetro sku/code o el último tramo de la ruta", () => {
    expect(scanCandidates("https://tienda.pe/p?sku=FR-PAST-1&x=2")).toContain("FR-PAST-1");
    expect(scanCandidates("https://tienda.pe/producto/LU-5W30")).toContain("LU-5W30");
    expect(scanCandidates("https://tienda.pe/p?code=ABC")).toContain("ABC");
  });
  it("QR con JSON o prefijo: extrae el SKU", () => {
    expect(scanCandidates('{"sku":"BAT-12V","precio":295}')).toContain("BAT-12V");
    expect(scanCandidates('{"barcode":7750001112223}')).toContain("7750001112223");
    expect(scanCandidates("SKU:LL-2055516")).toContain("LL-2055516");
    expect(scanCandidates("codigo = ABC-9")).toContain("ABC-9");
  });
  it("JSON o enlace inválidos no rompen: queda el texto literal", () => {
    expect(scanCandidates("{no es json")).toEqual(["{no es json"]);
    expect(scanCandidates("https://")).toEqual(["https://"]);
  });
  it("EAN-13 con cero inicial equivale al UPC-A (y al revés)", () => {
    expect(scanCandidates("0036000291452")).toContain("036000291452");
    expect(scanCandidates("036000291452")).toContain("0036000291452");
  });
  it("quita caracteres de control", () => {
    expect(scanCandidates("AB\u0000C\n")[0]).toBe("ABC");
  });
});

describe("coincidencia exacta", () => {
  const catalog = [
    p({ id: "1", sku: "FR-PAST-1", barcode: "7750001112223" }),
    p({ id: "2", sku: "LU-5W30", codes: ["04152-YZZA1"] }),
    p({ id: "3", sku: "DUP-A", barcode: "111" }),
    p({ id: "4", sku: "DUP-B", barcode: "111" }),
  ];
  it("por SKU, código de barras u OEM, sin importar mayúsculas ni tildes", () => {
    expect(matchScan(catalog, ["fr-past-1"])?.id).toBe("1");
    expect(matchScan(catalog, ["7750001112223"])?.id).toBe("1");
    expect(matchScan(catalog, ["04152-yzza1"])?.id).toBe("2");
  });
  it("prueba los candidatos en orden y no adivina", () => {
    expect(matchScan(catalog, ["no-existe", "LU-5W30"])?.id).toBe("2");
    expect(matchScan(catalog, ["no-existe"])).toBeNull();
    expect(matchScan(catalog, [])).toBeNull();
  });
  it("un código repetido en dos productos no se resuelve a ciegas", () => {
    expect(matchScan(catalog, ["111"])).toBeNull();
  });
});

describe("antirrebote de la cámara", () => {
  it("mientras el código sigue a la vista no se vuelve a aceptar (ventana deslizante)", () => {
    const debounce = new ScanDebouncer(1000);
    expect(debounce.accept("A", 0)).toBe(true);
    expect(debounce.accept("A", 500)).toBe(false);
    expect(debounce.accept("A", 1400)).toBe(false); // lo vio hace 900 ms
    expect(debounce.accept("A", 2300)).toBe(false); // lo vio hace 900 ms
    expect(debounce.accept("A", 3400)).toBe(true); // dejó de verse más de 1 s
  });
  it("códigos distintos no se estorban", () => {
    const debounce = new ScanDebouncer(1000);
    expect(debounce.accept("A", 0)).toBe(true);
    expect(debounce.accept("B", 100)).toBe(true);
    expect(debounce.accept("A", 200)).toBe(false);
  });
  it("apartar el código y volver a apuntarlo suma otra unidad", () => {
    const debounce = new ScanDebouncer(1000);
    expect(debounce.accept("A", 0)).toBe(true);
    expect(debounce.accept("A", 1500)).toBe(true);
  });
  it("reset permite volver a leer el mismo código al instante", () => {
    const debounce = new ScanDebouncer(1000);
    debounce.accept("A", 0);
    debounce.reset();
    expect(debounce.accept("A", 10)).toBe(true);
  });
});
