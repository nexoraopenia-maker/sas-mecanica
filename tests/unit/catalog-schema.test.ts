import { describe, expect, it } from "vitest";
import { createProductSchema, dotSchema, productSearchSchema } from "@/lib/validation/catalog";
import {
  adjustmentSchema,
  reorderPolicySchema,
  stockInSchema,
  transferRequestSchema,
} from "@/lib/validation/inventory";

const common = { sku: "ll-205-55", name: "Llanta Michelin", salePrice: 389 };
const uuid = "0198a1c2-0000-7000-8000-000000000001";

describe("validación del catálogo (Zod)", () => {
  it("llanta: acepta la medida como texto, normaliza el SKU y formatea precios", () => {
    const parsed = createProductSchema.parse({
      ...common,
      kind: "TIRE",
      tire: { size: "205/55R16", speedRating: "v", loadIndex: 91 },
    });
    expect(parsed.sku).toBe("LL-205-55");
    expect(parsed.salePrice).toBe("389.0000");
    if (parsed.kind !== "TIRE") throw new Error("tipo");
    expect(parsed.tire).toMatchObject({
      width: 205,
      aspectRatio: 55,
      rimDiameter: 16,
      speedRating: "V",
      runFlat: false,
    });
  });

  it("llanta: acepta ancho/perfil/aro por separado y rechaza medidas incompletas o inválidas", () => {
    expect(
      createProductSchema.safeParse({
        ...common,
        kind: "TIRE",
        tire: { width: 205, aspectRatio: 55, rimDiameter: 16 },
      }).success,
    ).toBe(true);
    expect(
      createProductSchema.safeParse({ ...common, kind: "TIRE", tire: { width: 205 } }).success,
    ).toBe(false);
    expect(
      createProductSchema.safeParse({ ...common, kind: "TIRE", tire: { size: "medida rara" } })
        .success,
    ).toBe(false);
    expect(
      createProductSchema.safeParse({
        ...common,
        kind: "TIRE",
        tire: { size: "205/55 R16", speedRating: "9z" },
      }).success,
    ).toBe(false);
  });

  it("batería: exige Ah, CCA y polaridad", () => {
    expect(
      createProductSchema.safeParse({
        ...common,
        kind: "BATTERY",
        battery: { capacityAh: 60, ccaA: 550, polarity: "LEFT_POSITIVE" },
      }).success,
    ).toBe(true);
    expect(
      createProductSchema.safeParse({
        ...common,
        kind: "BATTERY",
        battery: { capacityAh: 60, ccaA: 550 },
      }).success,
    ).toBe(false);
    expect(
      createProductSchema.safeParse({
        ...common,
        kind: "BATTERY",
        battery: { capacityAh: 0, ccaA: 550, polarity: "LEFT_POSITIVE" },
      }).success,
    ).toBe(false);
    expect(createProductSchema.safeParse({ ...common, kind: "BATTERY" }).success).toBe(false);
  });

  it("lubricante: valida la viscosidad", () => {
    for (const ok of ["5W-30", "10w40", "ATF", "20W-50"]) {
      expect(
        createProductSchema.safeParse({
          ...common,
          kind: "LUBRICANT",
          lubricant: { viscosity: ok },
        }).success,
        ok,
      ).toBe(true);
    }
    expect(
      createProductSchema.safeParse({
        ...common,
        kind: "LUBRICANT",
        lubricant: { viscosity: "espeso" },
      }).success,
    ).toBe(false);
  });

  it("repuesto: OEM, equivalencias y compatibilidad con rango de años coherente", () => {
    const ok = createProductSchema.safeParse({
      ...common,
      kind: "PART",
      part: { oemCode: "04465-52130", isOem: true },
      equivalences: [{ code: "GDB3469", brand: "TRW" }],
      compatibilities: [{ make: "Toyota", model: "Yaris", yearFrom: 2014, yearTo: 2020 }],
    });
    expect(ok.success).toBe(true);
    const bad = createProductSchema.safeParse({
      ...common,
      kind: "PART",
      part: {},
      compatibilities: [{ make: "Toyota", model: "Yaris", yearFrom: 2021, yearTo: 2014 }],
    });
    expect(bad.success).toBe(false);
  });

  it("rechaza SKU raro, precios negativos y tipos desconocidos", () => {
    expect(
      createProductSchema.safeParse({ ...common, sku: "a b", kind: "ACCESSORY" }).success,
    ).toBe(false);
    expect(
      createProductSchema.safeParse({ ...common, salePrice: -1, kind: "ACCESSORY" }).success,
    ).toBe(false);
    expect(createProductSchema.safeParse({ ...common, kind: "NAVE" }).success).toBe(false);
  });

  it("DOT y búsqueda", () => {
    expect(dotSchema.safeParse("2423").success).toBe(true);
    expect(dotSchema.safeParse("9923").success).toBe(false);
    expect(productSearchSchema.parse({}).limit).toBe(50);
    expect(productSearchSchema.safeParse({ limit: 5000 }).success).toBe(false);
  });
});

describe("validación de inventario (Zod)", () => {
  const target = { warehouseId: uuid, productId: uuid, idempotencyKey: "clave-0001" };

  it("entrada: cantidad decimal como texto, costo obligatorio", () => {
    expect(stockInSchema.parse({ ...target, quantity: "10.5", unitCost: 25 })).toMatchObject({
      quantity: "10.5",
      unitCost: "25",
      type: "PURCHASE",
    });
    expect(stockInSchema.safeParse({ ...target, quantity: "10" }).success).toBe(false);
    for (const bad of ["0", "-3", "1.23456", "abc", ""])
      expect(
        stockInSchema.safeParse({ ...target, quantity: bad, unitCost: "1" }).success,
        bad,
      ).toBe(false);
    expect(
      stockInSchema.safeParse({ ...target, idempotencyKey: "x", quantity: "1", unitCost: "1" })
        .success,
    ).toBe(false);
  });

  it("ajuste: exige motivo explícito", () => {
    expect(
      adjustmentSchema.safeParse({ ...target, direction: "OUT", quantity: "1", reason: "ok" })
        .success,
    ).toBe(false);
    expect(
      adjustmentSchema.safeParse({
        ...target,
        direction: "OUT",
        quantity: "1",
        reason: "Rotura en almacén",
      }).success,
    ).toBe(true);
    expect(
      adjustmentSchema.parse({
        ...target,
        direction: "IN",
        quantity: "1",
        reason: "Sobrante de conteo",
      }).allowNegative,
    ).toBe(false);
  });

  it("política de reorden: manual necesita valores y reorden ≥ mínimo", () => {
    expect(
      reorderPolicySchema.safeParse({ warehouseId: uuid, productId: uuid, mode: "AUTO" }).success,
    ).toBe(true);
    expect(
      reorderPolicySchema.safeParse({ warehouseId: uuid, productId: uuid, mode: "MANUAL" }).success,
    ).toBe(false);
    expect(
      reorderPolicySchema.safeParse({
        warehouseId: uuid,
        productId: uuid,
        mode: "MANUAL",
        manualMinStock: 10,
        manualReorderPoint: 5,
      }).success,
    ).toBe(false);
    expect(
      reorderPolicySchema.safeParse({
        warehouseId: uuid,
        productId: uuid,
        mode: "MANUAL",
        manualMinStock: 5,
        manualReorderPoint: 10,
        seasonalityFactor: 9,
      }).success,
    ).toBe(false);
  });

  it("transferencia: origen y destino distintos y al menos un ítem", () => {
    const item = { productId: uuid, quantity: "2" };
    expect(
      transferRequestSchema.safeParse({ fromWarehouseId: uuid, toWarehouseId: uuid, items: [item] })
        .success,
    ).toBe(false);
    expect(
      transferRequestSchema.safeParse({
        fromWarehouseId: uuid,
        toWarehouseId: "0198a1c2-0000-7000-8000-000000000002",
        items: [],
      }).success,
    ).toBe(false);
    expect(
      transferRequestSchema.safeParse({
        fromWarehouseId: uuid,
        toWarehouseId: "0198a1c2-0000-7000-8000-000000000002",
        items: [item],
      }).success,
    ).toBe(true);
  });
});
