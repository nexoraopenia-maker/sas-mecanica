import { describe, expect, it } from "vitest";
import {
  amountInWords,
  formatDocumentNumber,
  qrString,
  validateIssuance,
} from "@/lib/billing/sunat";
import { reconcile, summarizeSession } from "@/lib/pos/cash";
import { allocate, computeLine, computeSale, exceedsDiscountLimit } from "@/lib/pos/totals";

const incl = { taxRate: "0.18", pricesIncludeTax: true };
const excl = { taxRate: "0.18", pricesIncludeTax: false };

describe("totales de venta", () => {
  it("precio con IGV incluido: 118 → base 100 + IGV 18", () => {
    const line = computeLine(
      { quantity: 1, unitPrice: "118", discount: 0, affectation: "TAXED" },
      incl,
    );
    expect(line).toMatchObject({ base: "100.00", tax: "18.00", lineTotal: "118.00" });
  });

  it("precio sin IGV: 100 → total 118", () => {
    const line = computeLine(
      { quantity: 1, unitPrice: "100", discount: 0, affectation: "TAXED" },
      excl,
    );
    expect(line).toMatchObject({ base: "100.00", tax: "18.00", lineTotal: "118.00" });
  });

  it("base + IGV = total siempre, también con redondeos incómodos", () => {
    for (const [q, p, d] of [
      [3, "33.33", "0"],
      [7, "12.57", "1.10"],
      [1, "0.99", "0"],
      [13, "249.90", "15.55"],
    ] as const) {
      const line = computeLine(
        { quantity: q, unitPrice: p, discount: d, affectation: "TAXED" },
        incl,
      );
      expect((Number(line.base) + Number(line.tax)).toFixed(2)).toBe(line.lineTotal);
    }
  });

  it("separa gravado, exonerado e inafecto y el total cuadra con la suma de líneas", () => {
    const { totals, lines } = computeSale(
      [
        { quantity: 2, unitPrice: "59", discount: 0, affectation: "TAXED" },
        { quantity: 1, unitPrice: "40", discount: 0, affectation: "EXEMPT" },
        { quantity: 1, unitPrice: "10", discount: 0, affectation: "UNAFFECTED" },
      ],
      incl,
    );
    expect(totals).toMatchObject({
      taxed: "100.00",
      exempt: "40.00",
      unaffected: "10.00",
      tax: "18.00",
      total: "168.00",
      subtotal: "150.00",
    });
    expect(lines.reduce((s, l) => s + Number(l.lineTotal), 0).toFixed(2)).toBe(totals.total);
  });

  it("rechaza descuentos negativos o mayores que la línea", () => {
    expect(() =>
      computeLine({ quantity: 1, unitPrice: "10", discount: "11", affectation: "TAXED" }, incl),
    ).toThrow();
    expect(() =>
      computeLine({ quantity: 1, unitPrice: "10", discount: "-1", affectation: "TAXED" }, incl),
    ).toThrow();
  });

  it("el tope de descuento se compara contra el porcentaje de la línea", () => {
    const line = computeLine(
      { quantity: 2, unitPrice: "100", discount: "20", affectation: "TAXED" },
      incl,
    );
    expect(line.discountPercent).toBe("10.00");
    expect(exceedsDiscountLimit(line, 10)).toBe(false);
    expect(exceedsDiscountLimit(line, 9.99)).toBe(true);
  });

  it("allocate reparte sin perder ni inventar céntimos", () => {
    const parts = allocate("100.00", [1, 1, 1]);
    expect(parts).toEqual(["33.33", "33.33", "33.34"]);
    expect(
      allocate("10.01", [3, 7])
        .reduce((s, x) => s + Number(x), 0)
        .toFixed(2),
    ).toBe("10.01");
  });
});

describe("reglas y catálogos SUNAT", () => {
  const dni = { docType: "DNI" as const, docNumber: "45678123", name: "Carlos" };
  const ruc = { docType: "RUC" as const, docNumber: "20100070970", name: "Empresa SAC" };

  it("la factura exige RUC válido", () => {
    expect(validateIssuance("FACTURA", 100, null)).toMatch(/RUC/);
    expect(validateIssuance("FACTURA", 100, dni)).toMatch(/RUC/);
    expect(validateIssuance("FACTURA", 100, { ...ruc, docNumber: "20100070971" })).toMatch(
      /no es válido/,
    );
    expect(validateIssuance("FACTURA", 100, ruc)).toBeNull();
  });

  it("la boleta anónima solo hasta S/ 700", () => {
    expect(validateIssuance("BOLETA", 700, null)).toBeNull();
    expect(validateIssuance("BOLETA", 700.01, null)).toMatch(/identificar/);
    expect(validateIssuance("BOLETA", 5000, dni)).toBeNull();
    expect(validateIssuance("BOLETA", 50, { ...dni, docNumber: "123" })).toMatch(/DNI/);
  });

  it("leyenda en letras", () => {
    expect(amountInWords("118.00")).toBe("SON: CIENTO DIECIOCHO CON 00/100 SOLES");
    expect(amountInWords("0.50")).toBe("SON: CERO CON 50/100 SOLES");
    expect(amountInWords("1021.30")).toBe("SON: MIL VEINTIUN CON 30/100 SOLES");
    expect(amountInWords("100.00")).toBe("SON: CIEN CON 00/100 SOLES");
    expect(amountInWords("2500.99")).toBe("SON: DOS MIL QUINIENTOS CON 99/100 SOLES");
    expect(amountInWords("1000000.00")).toBe("SON: UN MILLON CON 00/100 SOLES");
    expect(amountInWords("35.00")).toBe("SON: TREINTA Y CINCO CON 00/100 SOLES");
  });

  it("número y QR del comprobante", () => {
    expect(formatDocumentNumber("B001", 25)).toBe("B001-00000025");
    const qr = qrString({
      issuerRuc: "20100070970",
      type: "BOLETA",
      series: "B001",
      correlative: 25,
      tax: "18.00",
      total: "118.00",
      issueDate: new Date("2026-10-21T15:00:00Z"),
      buyer: dni,
    });
    expect(qr).toBe("20100070970|03|B001|25|18.00|118.00|2026-10-21|1|45678123|");
  });
});

describe("arqueo de caja", () => {
  const summary = summarizeSession(
    "100.00",
    [
      { method: "CASH", amount: "50.00" },
      { method: "CASH", amount: "-20.00" },
      { method: "YAPE", amount: "80.00" },
      { method: "CARD", amount: "30.00" },
    ],
    [
      { type: "INCOME", amount: "10.00" },
      { type: "EXPENSE", amount: "15.00" },
    ],
  );

  it("el efectivo esperado suma apertura, cobros netos e ingresos y resta egresos", () => {
    expect(summary.expectedCash).toBe("125.00");
    expect(summary.byMethod).toMatchObject({
      CASH: "30.00",
      YAPE: "80.00",
      CARD: "30.00",
      TRANSFER: "0.00",
    });
  });

  it("la diferencia es contado − esperado y los medios sin conteo no inventan diferencia", () => {
    const result = reconcile(summary, { CASH: "120.00", YAPE: "80.00" });
    expect(result.cashDifference).toBe("-5.00");
    expect(result.lines.CARD.difference).toBe("0.00");
    expect(result.totalDifference).toBe("-5.00");
    expect(reconcile(summary, { CASH: "130.50" }).cashDifference).toBe("5.50");
  });
});
