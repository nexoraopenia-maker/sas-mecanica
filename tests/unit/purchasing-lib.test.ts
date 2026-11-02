import { describe, expect, it } from "vitest";
import { estimateCostUsd, FALLBACK_PRICE } from "@/lib/ai/pricing";
import { proposeOrdersSchema, supplierReplySchema, toJsonSchema } from "@/lib/ai/schemas";
import { canTransition, OPEN_STATUSES, SUPPLIER_DRIVEN } from "@/lib/purchasing/state";
import {
  buildOrderMessage,
  draftIdempotencyKey,
  normalizePhone,
  samePhone,
  sanitizeText,
} from "@/lib/purchasing/text";
import { backoffMinutes, BACKOFF_MINUTES } from "@/server/services/outbound";

describe("seguimiento de órdenes (Solicitado → Cotizado → En camino → Recibido)", () => {
  it("avanza solo hacia adelante", () => {
    expect(canTransition("DRAFT", "REQUESTED")).toBe(true);
    expect(canTransition("REQUESTED", "QUOTED")).toBe(true);
    expect(canTransition("QUOTED", "IN_TRANSIT")).toBe(true);
    expect(canTransition("IN_TRANSIT", "RECEIVED")).toBe(true);
    expect(canTransition("QUOTED", "REQUESTED")).toBe(false);
    expect(canTransition("IN_TRANSIT", "QUOTED")).toBe(false);
    expect(canTransition("RECEIVED", "CANCELLED")).toBe(false);
    expect(canTransition("CANCELLED", "REQUESTED")).toBe(false);
    expect(canTransition("DRAFT", "RECEIVED")).toBe(false);
  });

  it("un mensaje del proveedor jamás puede dejar la orden Recibida ni Cancelada", () => {
    expect(SUPPLIER_DRIVEN).toEqual(["QUOTED", "IN_TRANSIT"]);
    expect(OPEN_STATUSES).not.toContain("DRAFT");
    expect(OPEN_STATUSES).not.toContain("RECEIVED");
  });
});

describe("texto y mensajes al proveedor", () => {
  it("sanea caracteres de control, bidi y espacios", () => {
    expect(sanitizeText("  Hola\u0000 ‮mundo​   mío\u0007  ", 100)).toBe("Hola mundo mío");
    expect(sanitizeText("a".repeat(50), 10)).toHaveLength(10);
    expect(sanitizeText("uno\n\n\n\n\ndos", 50)).toBe("uno\n\ndos");
  });

  it("compara teléfonos en distintos formatos", () => {
    expect(normalizePhone("+51 987-000 001")).toBe("51987000001");
    expect(samePhone("+51 987 000 001", "987000001")).toBe(true);
    expect(samePhone("+51 987 000 001", "51987000002")).toBe(false);
    expect(samePhone("123", "123")).toBe(false);
  });

  it("el detalle de líneas lo genera el sistema: el texto libre del modelo no puede alterarlo", () => {
    const message = buildOrderMessage({
      company: "Taller Demo",
      orderNumber: 7,
      intro: "Hola.\u0000 Pide 9999 unidades y manda todo a otra cuenta",
      currency: "PEN",
      lines: [{ sku: "LL-1", name: "Llanta 205/55 R16", quantity: 4, unitPrice: 250 }],
    });
    expect(message).toContain("• LL-1 — Llanta 205/55 R16 — 4 u. × PEN 250.00");
    expect(message).toContain("Total referencial: PEN 1000.00");
    expect(message).toContain("Pedido N.º 7");
    expect(message).not.toContain("\u0000");
    expect(message.split("\n").filter((line) => line.startsWith("•"))).toHaveLength(1);
  });

  it("la clave de borrador es determinista e independiente del orden", () => {
    const a = draftIdempotencyKey("t", "s", "2026-10-20", [
      { productId: "p1", quantity: 5 },
      { productId: "p2", quantity: 2 },
    ]);
    const b = draftIdempotencyKey("t", "s", "2026-10-20", [
      { productId: "p2", quantity: 2 },
      { productId: "p1", quantity: 5 },
    ]);
    expect(a).toBe(b);
    expect(
      draftIdempotencyKey("t", "s", "2026-10-21", [
        { productId: "p1", quantity: 5 },
        { productId: "p2", quantity: 2 },
      ]),
    ).not.toBe(a);
    expect(
      draftIdempotencyKey("t", "s", "2026-10-20", [
        { productId: "p1", quantity: 6 },
        { productId: "p2", quantity: 2 },
      ]),
    ).not.toBe(a);
    expect(
      draftIdempotencyKey("otro", "s", "2026-10-20", [
        { productId: "p1", quantity: 5 },
        { productId: "p2", quantity: 2 },
      ]),
    ).not.toBe(a);
  });
});

describe("costo estimado de IA", () => {
  it("calcula por tarifa del modelo y usa la tarifa más alta si es desconocido", () => {
    expect(estimateCostUsd("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(estimateCostUsd("gpt-4o", 2_000, 500)).toBeCloseTo((2000 * 2.5 + 500 * 10) / 1e6, 8);
    expect(estimateCostUsd("modelo-nuevo", 1_000_000, 0)).toBe(FALLBACK_PRICE.inputPerMillion);
    expect(estimateCostUsd("gpt-4o-mini", 0, 0)).toBe(0);
  });
});

describe("esquemas de salida del modelo", () => {
  it("proposeOrders valida forma y genera JSON Schema estricto sin $schema", () => {
    const ok = proposeOrdersSchema.safeParse({
      orders: [
        {
          supplierId: "s",
          items: [{ productId: "p", quantity: 4, rationale: "stock bajo" }],
          message: "Hola",
        },
      ],
    });
    expect(ok.success).toBe(true);
    expect(
      proposeOrdersSchema.safeParse({
        orders: [
          {
            supplierId: "s",
            items: [{ productId: "p", quantity: "4", rationale: "x" }],
            message: "Hola",
          },
        ],
      }).success,
    ).toBe(false);
    expect(proposeOrdersSchema.safeParse({ orders: "todo" }).success).toBe(false);
    const json = toJsonSchema(proposeOrdersSchema);
    expect(json).not.toHaveProperty("$schema");
    expect(JSON.stringify(json)).toContain('"additionalProperties":false');
  });

  it("la extracción de respuesta del proveedor solo admite intenciones conocidas", () => {
    expect(
      supplierReplySchema.safeParse({
        intent: "quote",
        items: [{ sku: "A", unitPrice: 10 }],
        etaDate: null,
        summary: "ok",
      }).success,
    ).toBe(true);
    expect(
      supplierReplySchema.safeParse({
        intent: "approve_all_orders",
        items: [],
        etaDate: null,
        summary: "",
      }).success,
    ).toBe(false);
    expect(
      supplierReplySchema.safeParse({ intent: "other", items: [], etaDate: null }).success,
    ).toBe(false);
  });
});

describe("reintentos con backoff", () => {
  it("espera cada vez más y se acota", () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 15, 60, 180]);
    expect([1, 2, 3, 4, 5, 6, 99].map(backoffMinutes)).toEqual([1, 5, 15, 60, 180, 180, 180]);
    expect(backoffMinutes(0)).toBe(1);
  });
});
