import { describe, expect, it } from "vitest";
import { canAutoSend, evaluateGuardrails, type GuardrailInput } from "@/lib/ai/guardrails";

const base: GuardrailInput = {
  supplierWhitelisted: true,
  total: 500,
  items: [{ sku: "A", quantity: 10 }],
  ordersPlacedToday: 0,
  limits: { maxOrderAmount: 1000, maxQtyPerSku: 50, maxOrdersPerDay: 3 },
  mode: "AUTOMATIC",
};

describe("guardrails del agente de compras", () => {
  it("un pedido dentro de todos los topes no tiene violaciones y puede enviarse solo", () => {
    const violations = evaluateGuardrails(base);
    expect(violations).toEqual([]);
    expect(canAutoSend("AUTOMATIC", violations)).toBe(true);
  });

  it("proveedor fuera de la lista blanca", () => {
    expect(evaluateGuardrails({ ...base, supplierWhitelisted: false })).toEqual([
      "SUPPLIER_NOT_WHITELISTED",
    ]);
  });

  it("monto máximo por pedido (el tope exacto sí se permite)", () => {
    expect(evaluateGuardrails({ ...base, total: 1000 })).toEqual([]);
    expect(evaluateGuardrails({ ...base, total: 1000.01 })).toEqual(["MAX_ORDER_AMOUNT"]);
  });

  it("cantidad máxima por SKU: basta una línea que exceda", () => {
    expect(
      evaluateGuardrails({
        ...base,
        items: [
          { sku: "A", quantity: 50 },
          { sku: "B", quantity: 51 },
        ],
      }),
    ).toEqual(["MAX_QTY_PER_SKU"]);
    expect(evaluateGuardrails({ ...base, items: [{ sku: "A", quantity: 50 }] })).toEqual([]);
  });

  it("máximo de pedidos por día", () => {
    expect(evaluateGuardrails({ ...base, ordersPlacedToday: 2 })).toEqual([]);
    expect(evaluateGuardrails({ ...base, ordersPlacedToday: 3 })).toEqual(["MAX_ORDERS_PER_DAY"]);
    expect(evaluateGuardrails({ ...base, limits: { ...base.limits, maxOrdersPerDay: 0 } })).toEqual(
      ["MAX_ORDERS_PER_DAY"],
    );
  });

  it("acumula todas las violaciones a la vez", () => {
    const violations = evaluateGuardrails({
      ...base,
      supplierWhitelisted: false,
      total: 5000,
      items: [{ sku: "A", quantity: 500 }],
      ordersPlacedToday: 9,
    });
    expect(violations.sort()).toEqual([
      "MAX_ORDERS_PER_DAY",
      "MAX_ORDER_AMOUNT",
      "MAX_QTY_PER_SKU",
      "SUPPLIER_NOT_WHITELISTED",
    ]);
    expect(canAutoSend("AUTOMATIC", violations)).toBe(false);
  });

  it("fallo seguro: el modo automático SIN topes configurados nunca envía solo", () => {
    for (const limits of [
      { maxOrderAmount: null, maxQtyPerSku: 50, maxOrdersPerDay: 3 },
      { maxOrderAmount: 1000, maxQtyPerSku: null, maxOrdersPerDay: 3 },
      { maxOrderAmount: null, maxQtyPerSku: null, maxOrdersPerDay: 3 },
    ]) {
      const violations = evaluateGuardrails({ ...base, limits });
      expect(violations).toContain("NO_LIMITS_CONFIGURED");
      expect(canAutoSend("AUTOMATIC", violations)).toBe(false);
    }
  });

  it("en modo borrador nunca se envía solo, aunque no haya violaciones", () => {
    expect(
      evaluateGuardrails({
        ...base,
        mode: "DRAFT_APPROVAL",
        limits: { maxOrderAmount: null, maxQtyPerSku: null, maxOrdersPerDay: 5 },
      }),
    ).toEqual([]);
    expect(canAutoSend("DRAFT_APPROVAL", [])).toBe(false);
  });
});
