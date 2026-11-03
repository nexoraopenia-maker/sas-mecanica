import { describe, expect, it } from "vitest";
import { priceDraft, validateDraftDocument, type DraftLine } from "@/lib/pos/draft";
import { computeSale } from "@/lib/pos/totals";

const TAX = { taxRate: "0.18", pricesIncludeTax: true };
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  name: "Filtro",
  unitPrice: "118.00",
  quantity: "1",
  discount: "",
  affectation: "TAXED",
  ...over,
});

describe("totales del carrito en el navegador", () => {
  it("con IGV incluido: 118 → base 100, IGV 18", () => {
    const result = priceDraft([line()], TAX);
    expect(result).toMatchObject({
      ok: true,
      totals: { subtotal: "100.00", tax: "18.00", total: "118.00", taxed: "100.00" },
    });
  });
  it("con precios sin IGV: 100 → IGV 18, total 118", () => {
    const result = priceDraft([line({ unitPrice: "100" })], {
      taxRate: "0.18",
      pricesIncludeTax: false,
    });
    expect(result).toMatchObject({
      ok: true,
      totals: { subtotal: "100.00", tax: "18.00", total: "118.00" },
    });
  });
  it("exonerado e inafecto no llevan IGV", () => {
    const result = priceDraft(
      [
        line({ unitPrice: "50", affectation: "EXEMPT" }),
        line({ unitPrice: "30", affectation: "UNAFFECTED" }),
      ],
      TAX,
    );
    expect(result).toMatchObject({
      ok: true,
      totals: { exempt: "50.00", unaffected: "30.00", taxed: "0.00", tax: "0.00", total: "80.00" },
    });
  });
  it("mezcla de afectaciones, cantidades y descuento", () => {
    const result = priceDraft(
      [line({ quantity: "3", discount: "18" }), line({ unitPrice: "40", affectation: "EXEMPT" })],
      TAX,
    );
    expect(result.ok && result.totals.total).toBe("376.00");
    expect(result.ok && result.totals.taxed).toBe("284.75");
    expect(result.ok && result.totals.tax).toBe("51.25");
  });
  it("es idéntico al cálculo del servidor (misma función)", () => {
    const lines = [
      line({ unitPrice: "59.90", quantity: "2" }),
      line({ unitPrice: "12.35", affectation: "EXEMPT" }),
    ];
    const server = computeSale(
      lines.map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: "0",
        affectation: l.affectation,
      })),
      TAX,
    );
    const client = priceDraft(lines, TAX);
    expect(client.ok && client.totals).toEqual(server.totals);
  });
  it("base + IGV = total y el IGV es el 18 % de la base (±1 céntimo por línea) en muchos precios", () => {
    for (let cents = 1; cents <= 20_000; cents += 137) {
      const price = (cents / 100).toFixed(2);
      const result = priceDraft([line({ unitPrice: price, quantity: "3" })], TAX);
      if (!result.ok) throw new Error(result.error);
      const { subtotal, tax, total } = result.totals;
      expect(Number(subtotal) + Number(tax)).toBeCloseTo(Number(total), 2);
      expect(Math.abs(Number(tax) - Number(subtotal) * 0.18)).toBeLessThanOrEqual(0.01);
    }
  });
  it("rechaza cantidades, precios y descuentos inválidos con un mensaje claro", () => {
    expect(priceDraft([line({ quantity: "0" })], TAX)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Cantidad"),
    });
    expect(priceDraft([line({ quantity: "abc" })], TAX)).toMatchObject({ ok: false });
    expect(priceDraft([line({ unitPrice: "-5" })], TAX)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Precio"),
    });
    expect(priceDraft([line({ discount: "x" })], TAX)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Descuento"),
    });
    expect(priceDraft([line({ discount: "500" })], TAX)).toMatchObject({
      ok: false,
      error: expect.stringContaining("supera"),
    });
  });
  it("aplica el tope de descuento del rol", () => {
    expect(priceDraft([line({ discount: "20" })], TAX, 10)).toMatchObject({
      ok: false,
      error: expect.stringContaining("tope de 10 %"),
    });
    expect(priceDraft([line({ discount: "5" })], TAX, 10).ok).toBe(true);
  });
});

describe("reglas del comprobante en el mostrador", () => {
  const ruc = { docType: "RUC" as const, docNumber: "20100070970", name: "Transportes SAC" };
  const dni = { docType: "DNI" as const, docNumber: "12345678", name: "Juan Pérez" };
  const base = { total: 100, offline: false, isCredit: false };

  it("la factura exige RUC y la boleta anónima tiene tope", () => {
    expect(validateDraftDocument({ ...base, documentType: "FACTURA", buyer: null })).toMatch(/RUC/);
    expect(validateDraftDocument({ ...base, documentType: "FACTURA", buyer: dni })).toMatch(/RUC/);
    expect(validateDraftDocument({ ...base, documentType: "FACTURA", buyer: ruc })).toBeNull();
    expect(validateDraftDocument({ ...base, documentType: "BOLETA", buyer: null })).toBeNull();
    expect(
      validateDraftDocument({ ...base, total: 701, documentType: "BOLETA", buyer: null }),
    ).toMatch(/700/);
    expect(
      validateDraftDocument({ ...base, total: 701, documentType: "BOLETA", buyer: dni }),
    ).toBeNull();
  });
  it("la nota de venta no exige documento", () => {
    expect(
      validateDraftDocument({ ...base, total: 5000, documentType: "NOTA_VENTA", buyer: null }),
    ).toBeNull();
  });
  it("sin conexión no se emiten facturas ni ventas a crédito", () => {
    expect(
      validateDraftDocument({ ...base, offline: true, documentType: "FACTURA", buyer: ruc }),
    ).toMatch(/solo con conexión/);
    expect(
      validateDraftDocument({
        ...base,
        offline: true,
        isCredit: true,
        documentType: "BOLETA",
        buyer: dni,
      }),
    ).toMatch(/crédito/);
    expect(
      validateDraftDocument({ ...base, offline: true, documentType: "BOLETA", buyer: null }),
    ).toBeNull();
    expect(
      validateDraftDocument({ ...base, offline: true, documentType: "NOTA_VENTA", buyer: null }),
    ).toBeNull();
  });
});
