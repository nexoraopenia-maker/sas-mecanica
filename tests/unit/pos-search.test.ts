import { describe, expect, it } from "vitest";
import { mergeProducts } from "@/lib/pos/pos-fetch";
import {
  highlightParts,
  LocalCatalog,
  normalizeText,
  scoreProduct,
  searchLocal,
} from "@/lib/pos/search";
import type { PosProduct } from "@/lib/pos/types";

const product = (
  over: Partial<PosProduct> & Pick<PosProduct, "id" | "sku" | "name">,
): PosProduct => ({
  barcode: null,
  kind: "PART",
  brand: null,
  salePrice: "100.00",
  stock: 5,
  trackingMode: "NONE",
  isStocked: true,
  taxAffectation: "TAXED",
  codes: [],
  tire: null,
  ...over,
});

const CATALOG: PosProduct[] = [
  product({
    id: "1",
    sku: "FR-PAST-YARIS",
    name: "Pastillas de freno delanteras Toyota Yaris",
    brand: "Brembo",
    codes: ["04465-0D150", "GDB3469"],
  }),
  product({
    id: "2",
    sku: "FR-PAST-ACCENT",
    name: "Pastillas de freno Hyundai Accent",
    brand: "Bosch",
  }),
  product({
    id: "3",
    sku: "LU-5W30",
    name: "Aceite 5W-30 sintético Mobil 1 4L",
    brand: "Mobil",
    barcode: "7750001112223",
  }),
  product({
    id: "4",
    sku: "LL-2055516",
    name: "Llanta Michelin Primacy 4",
    brand: "Michelin",
    kind: "TIRE",
    tire: "205/55 R16",
  }),
  product({
    id: "5",
    sku: "LL-2254517",
    name: "Llanta Pirelli P Zero",
    brand: "Pirelli",
    kind: "TIRE",
    tire: "225/45 R17",
  }),
  product({ id: "6", sku: "ACC-ESCOB", name: "Escobilla limpiaparabrisas", brand: null }),
];

describe("normalización", () => {
  it("minúsculas, sin tildes ni espacios sobrantes", () => {
    expect(normalizeText("  Pastillás   de  FRENO ")).toBe("pastillas de freno");
    expect(normalizeText("Ñandú")).toBe("nandu");
  });
});

describe("búsqueda predictiva local", () => {
  const catalog = new LocalCatalog(CATALOG);
  const ids = (q: string) => catalog.search(q).map((p) => p.id);

  it("encuentra por nombre, parcial y sin tildes", () => {
    expect(ids("pastil")).toEqual(expect.arrayContaining(["1", "2"]));
    expect(ids("pastillas freno")).toEqual(expect.arrayContaining(["1", "2"]));
    expect(ids("sintetico")).toEqual(["3"]);
  });
  it("todas las palabras deben coincidir", () => {
    expect(ids("pastillas yaris")).toEqual(["1"]);
    expect(ids("pastillas zzz")).toEqual([]);
  });
  it("encuentra por SKU, marca, código de barras y OEM/equivalente", () => {
    expect(ids("lu-5w30")).toEqual(["3"]);
    expect(ids("brembo")).toEqual(["1"]);
    expect(ids("7750001112223")).toEqual(["3"]);
    expect(ids("gdb3469")).toEqual(["1"]);
    expect(ids("04465")).toEqual(["1"]);
  });
  it("la coincidencia exacta de SKU o código de barras va primero", () => {
    const first = catalog.search("fr-past-accent")[0];
    expect(first?.id).toBe("2");
    expect(catalog.search("7750001112223")[0]?.id).toBe("3");
  });
  it("la medida de llanta equivale en cualquier formato", () => {
    for (const size of ["205/55R16", "205 55 16", "205/55 r16", "2055516", "205-55-16"])
      expect(ids(size), size).toEqual(["4"]);
    expect(ids("225/45R17")).toEqual(["5"]);
  });
  it("sin texto o sin coincidencias no devuelve nada", () => {
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("xyz-no-existe")).toEqual([]);
  });
  it("respeta el límite y es estable (mismo resultado en el mismo orden)", () => {
    expect(catalog.search("a", 2)).toHaveLength(2);
    expect(catalog.search("pastillas")).toEqual(catalog.search("pastillas"));
  });
  it("searchLocal equivale al catálogo indexado", () => {
    expect(searchLocal(CATALOG, "pastillas").map((p) => p.id)).toEqual(ids("pastillas"));
    expect(scoreProduct(CATALOG[0] as PosProduct, "zzz")).toBe(-1);
  });
  it("busca rápido en un catálogo grande (5 000 productos)", () => {
    const big = Array.from({ length: 5000 }, (_, i) =>
      product({
        id: String(i),
        sku: `SKU-${i}`,
        name: `Repuesto genérico número ${i}`,
        brand: i % 2 ? "Bosch" : "Denso",
      }),
    );
    const index = new LocalCatalog(big);
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) index.search("repuesto 49");
    expect((performance.now() - start) / 20).toBeLessThan(50);
  });
});

describe("resaltado y mezcla de resultados", () => {
  it("resalta las palabras buscadas ignorando tildes y mayúsculas", () => {
    expect(highlightParts("Pastillas de Freno", "freno pasti")).toEqual([
      { text: "Pasti", match: true },
      { text: "llas de ", match: false },
      { text: "Freno", match: true },
    ]);
    expect(highlightParts("Café", "cafe")).toEqual([{ text: "Café", match: true }]);
    expect(highlightParts("abc", "")).toEqual([{ text: "abc", match: false }]);
  });
  it("conserva el orden local, agrega lo nuevo del servidor y prefiere los datos del servidor", () => {
    const local = [CATALOG[0] as PosProduct, CATALOG[1] as PosProduct];
    const remote = [{ ...(CATALOG[1] as PosProduct), stock: 99 }, CATALOG[2] as PosProduct];
    const merged = mergeProducts(local, remote, 8);
    expect(merged.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(merged[1]?.stock).toBe(99);
    expect(mergeProducts(local, remote, 2)).toHaveLength(2);
  });
});
