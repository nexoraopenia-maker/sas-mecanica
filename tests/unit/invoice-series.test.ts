import { describe, expect, it } from "vitest";
import { invoiceSettingsSchema } from "@/lib/validation/sales";

const valid = {
  provider: "NONE",
  boletaSeries: "B001",
  facturaSeries: "F001",
  creditNoteBoletaSeries: "BC01",
  creditNoteFacturaSeries: "FC01",
  debitNoteBoletaSeries: "BD01",
  debitNoteFacturaSeries: "FD01",
  saleNoteSeries: "NV01",
  defaultCreditDays: 30,
  cashTolerance: 1,
} as const;

const issues = (over: Record<string, unknown>) => {
  const result = invoiceSettingsSchema.safeParse({ ...valid, ...over });
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("series de boleta y factura", () => {
  it("acepta el formato B### y F### (en minúsculas se normaliza)", () => {
    expect(
      invoiceSettingsSchema.parse({ ...valid, boletaSeries: "b012", facturaSeries: "f999" }),
    ).toMatchObject({
      boletaSeries: "B012",
      facturaSeries: "F999",
    });
  });
  it.each(["B1", "B0001", "BA01", "F001", "X001", "B-01", " ", ""])(
    "rechaza la serie de boleta %j",
    (value) => {
      expect(issues({ boletaSeries: value }).join()).toMatch(/boletaSeries/);
    },
  );
  it.each(["F1", "F0001", "FA01", "B001", "X001", "F-01", ""])(
    "rechaza la serie de factura %j",
    (value) => {
      expect(issues({ facturaSeries: value }).join()).toMatch(/facturaSeries/);
    },
  );
  it("impide series repetidas entre comprobantes", () => {
    expect(
      issues({ creditNoteBoletaSeries: "BC01", creditNoteFacturaSeries: "BC01" }).join(),
    ).toMatch(/ya se usa en otro comprobante/);
    expect(issues({ saleNoteSeries: "BC01" }).join()).toMatch(/ya se usa/);
  });
  it("el ancho del ticket es 58 u 80 mm y es opcional", () => {
    expect(invoiceSettingsSchema.parse({ ...valid, ticketWidthMm: "58" }).ticketWidthMm).toBe(58);
    expect(invoiceSettingsSchema.parse(valid).ticketWidthMm).toBeUndefined();
    expect(issues({ ticketWidthMm: 70 }).join()).toMatch(/58 o 80/);
  });
  it("la confirmación de cambio de serie es falsa por omisión", () => {
    expect(invoiceSettingsSchema.parse(valid).confirmSeriesChange).toBe(false);
  });
});
