import { describe, expect, it } from "vitest";
import { CATALOG_CHIPS } from "@/lib/catalog/chips";
import { marginPercent, netSalePrice } from "@/lib/catalog/margin";
import { stockIndicator } from "@/lib/catalog/stock-light";
import { catalogListSchema } from "@/lib/validation/catalog";

describe("semáforo de stock del catálogo", () => {
  it("rojo con stock 0, ámbar en el punto de reposición o por debajo, verde por encima", () => {
    expect(stockIndicator(0, 10).light).toBe("RED");
    expect(stockIndicator(-3, 10).light).toBe("RED");
    expect(stockIndicator(1, 10).light).toBe("AMBER");
    expect(stockIndicator(10, 10).light).toBe("AMBER");
    expect(stockIndicator(10.01, 10).light).toBe("GREEN");
    expect(stockIndicator(50, 10).light).toBe("GREEN");
  });
  it("sin punto de reposición: verde y sin barra (rojo si no hay stock)", () => {
    expect(stockIndicator(7, 0)).toEqual({ light: "GREEN", bar: null, mark: null });
    expect(stockIndicator(0, 0)).toEqual({ light: "RED", bar: null, mark: null });
  });
  it("la barra llena al duplicar el punto de reposición y lo marca a la mitad", () => {
    expect(stockIndicator(5, 10)).toEqual({ light: "AMBER", bar: 0.25, mark: 0.5 });
    expect(stockIndicator(10, 10).bar).toBe(0.5);
    expect(stockIndicator(20, 10).bar).toBe(1);
    expect(stockIndicator(999, 10).bar).toBe(1);
    expect(stockIndicator(0, 10)).toEqual({ light: "RED", bar: 0, mark: 0.5 });
  });
});

describe("margen del catálogo", () => {
  const ctx = { taxRate: "0.18", pricesIncludeTax: true };
  it("mide sobre el precio sin IGV", () => {
    const net = netSalePrice("118", "TAXED", ctx);
    expect(net.toFixed(2)).toBe("100.00");
    expect(marginPercent(net, "60")).toBe("40.0");
    expect(marginPercent(net, "100")).toBe("0.0");
    expect(marginPercent(net, "125")).toBe("-25.0");
  });
  it("exonerado o precios sin IGV incluido no se dividen", () => {
    expect(netSalePrice("118", "EXEMPT", ctx).toFixed(2)).toBe("118.00");
    expect(netSalePrice("100", "TAXED", { ...ctx, pricesIncludeTax: false }).toFixed(2)).toBe(
      "100.00",
    );
  });
  it("sin costo, costo 0 o precio 0 no hay margen", () => {
    const net = netSalePrice("118", "TAXED", ctx);
    expect(marginPercent(net, null)).toBeNull();
    expect(marginPercent(net, undefined)).toBeNull();
    expect(marginPercent(net, "0")).toBeNull();
    expect(marginPercent(netSalePrice("0", "TAXED", ctx), "10")).toBeNull();
  });
  it("redondea a un decimal", () => {
    expect(marginPercent(netSalePrice("118", "TAXED", ctx), "33.333")).toBe("66.7");
  });
});

describe("chips y validación del listado", () => {
  it("los chips acordados, en orden", () => {
    expect(CATALOG_CHIPS.map((chip) => chip.label)).toEqual([
      "Todos",
      "Lubricante",
      "Filtro",
      "Frenos",
      "Llantas",
      "Baterías",
    ]);
  });
  it("normaliza página y tamaño; rechaza valores inválidos", () => {
    expect(catalogListSchema.parse({})).toMatchObject({ page: 1, pageSize: 12, chip: "todos" });
    expect(catalogListSchema.parse({ page: "3", year: "2018" })).toMatchObject({
      page: 3,
      year: 2018,
    });
    for (const bad of [
      { page: 0 },
      { page: "x" },
      { pageSize: 1000 },
      { chip: "otros" },
      { year: 1800 },
    ])
      expect(catalogListSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(catalogListSchema.safeParse({ tireSize: "xx" }).success).toBe(false);
    expect(catalogListSchema.safeParse({ tireSize: "205/55R16" }).success).toBe(true);
  });
});
