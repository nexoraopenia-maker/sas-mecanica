import { describe, expect, it } from "vitest";
import {
  AFFECTATION_CODE,
  ANONYMOUS_BOLETA_LIMIT,
  DOCUMENT_TYPE_CODE,
  IDENTITY_CODE,
  IGV_RATE,
  seriesMatchesType,
  validateIgvRate,
  validateIssuance,
  type Buyer,
} from "@/lib/billing/sunat";

/** RUC válido (módulo 11) a partir de 10 dígitos. */
function ruc(prefix10: string): string {
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix10[i]), 0);
  return `${prefix10}${(11 - (sum % 11)) % 10}`;
}

const buyer = (over: Partial<Buyer>): Buyer => ({
  docType: "RUC",
  docNumber: ruc("2010007097"),
  name: "Cliente SAC",
  ...over,
});

describe("factura (SUNAT)", () => {
  it("exige comprador con RUC", () => {
    expect(validateIssuance("FACTURA", 100, null)).toMatch(/RUC/);
    expect(
      validateIssuance("FACTURA", 100, buyer({ docType: "DNI", docNumber: "12345678" })),
    ).toMatch(/RUC/);
    expect(validateIssuance("FACTURA", 100, buyer({ docType: "OTHER", docNumber: "123" }))).toMatch(
      /RUC/,
    );
  });
  it("valida el dígito verificador y el largo del RUC", () => {
    expect(validateIssuance("FACTURA", 100, buyer({}))).toBeNull();
    expect(validateIssuance("FACTURA", 100, buyer({ docNumber: "20100070971" }))).toMatch(
      /no es válido/,
    );
    expect(validateIssuance("FACTURA", 100, buyer({ docNumber: "2010007097" }))).toMatch(
      /no es válido/,
    );
    expect(validateIssuance("FACTURA", 100, buyer({ docNumber: "ABCDEFGHIJK" }))).toMatch(
      /no es válido/,
    );
  });
  it("solo RUC que empiezan con 10 o 20", () => {
    expect(validateIssuance("FACTURA", 100, buyer({ docNumber: ruc("1012345678") }))).toBeNull();
    expect(validateIssuance("FACTURA", 100, buyer({ docNumber: ruc("2012345678") }))).toBeNull();
    for (const prefix of ["1512345678", "1612345678", "1712345678"])
      expect(validateIssuance("FACTURA", 100, buyer({ docNumber: ruc(prefix) }))).toMatch(
        /10 o 20/,
      );
  });
  it("exige razón social", () => {
    expect(validateIssuance("FACTURA", 100, buyer({ name: " " }))).toMatch(/razón social/);
    expect(validateIssuance("FACTURA", 100, buyer({ name: "A" }))).toMatch(/razón social/);
  });
});

describe("boleta (SUNAT)", () => {
  it(`puede ser anónima hasta S/ ${ANONYMOUS_BOLETA_LIMIT} y luego exige identificar al cliente`, () => {
    expect(validateIssuance("BOLETA", ANONYMOUS_BOLETA_LIMIT, null)).toBeNull();
    expect(validateIssuance("BOLETA", ANONYMOUS_BOLETA_LIMIT + 0.01, null)).toMatch(/identificar/);
    expect(validateIssuance("BOLETA", 5000, null)).toMatch(/DNI/);
  });
  it("el DNI debe tener 8 dígitos", () => {
    expect(
      validateIssuance("BOLETA", 800, buyer({ docType: "DNI", docNumber: "12345678" })),
    ).toBeNull();
    for (const bad of ["1234567", "123456789", "1234567A", ""])
      expect(
        validateIssuance("BOLETA", 100, buyer({ docType: "DNI", docNumber: bad })),
        bad,
      ).toMatch(/DNI/);
  });
  it("acepta carné de extranjería, pasaporte o RUC válidos", () => {
    expect(
      validateIssuance("BOLETA", 900, buyer({ docType: "CE", docNumber: "001234567" })),
    ).toBeNull();
    expect(
      validateIssuance("BOLETA", 900, buyer({ docType: "PASSPORT", docNumber: "AB123456" })),
    ).toBeNull();
    expect(validateIssuance("BOLETA", 900, buyer({}))).toBeNull();
    expect(validateIssuance("BOLETA", 900, buyer({ docNumber: "20100070971" }))).toMatch(/RUC/);
  });
  it("un comprador sin documento (OTHER) no sirve por encima del tope", () => {
    expect(
      validateIssuance("BOLETA", 800, buyer({ docType: "OTHER", docNumber: "XYZ123" })),
    ).toMatch(/exige DNI/);
    expect(
      validateIssuance("BOLETA", 100, buyer({ docType: "OTHER", docNumber: "XYZ123" })),
    ).toBeNull();
  });
});

describe("IGV y catálogos oficiales", () => {
  it("la tasa del comprobante es 18 %", () => {
    expect(IGV_RATE).toBe(0.18);
    expect(validateIgvRate("0.18", "100.00")).toBeNull();
    expect(validateIgvRate("0.1800", "100.00")).toBeNull();
    expect(validateIgvRate("0.10", "100.00")).toMatch(/18 %/);
    expect(validateIgvRate("0.19", "0.01")).toMatch(/10\.00|19\.00/);
  });
  it("sin operaciones gravadas la tasa no interviene", () => {
    expect(validateIgvRate("0.10", "0.00")).toBeNull();
    expect(validateIgvRate("0", "0")).toBeNull();
  });
  it("catálogo 07: gravado 10, exonerado 20, inafecto 30", () => {
    expect(AFFECTATION_CODE).toEqual({ TAXED: "10", EXEMPT: "20", UNAFFECTED: "30" });
  });
  it("catálogo 01: factura 01, boleta 03, nota de crédito 07, nota de débito 08", () => {
    expect(DOCUMENT_TYPE_CODE).toEqual({
      FACTURA: "01",
      BOLETA: "03",
      NOTA_CREDITO: "07",
      NOTA_DEBITO: "08",
    });
  });
  it("catálogo 06: DNI 1, CE 4, RUC 6, pasaporte 7, otros 0", () => {
    expect(IDENTITY_CODE).toEqual({ OTHER: "0", DNI: "1", CE: "4", RUC: "6", PASSPORT: "7" });
  });
});

describe("serie según el tipo de comprobante", () => {
  it("B### para boletas y F### para facturas", () => {
    expect(seriesMatchesType("BOLETA", "B001")).toBe(true);
    expect(seriesMatchesType("FACTURA", "F001")).toBe(true);
    expect(seriesMatchesType("BOLETA", "F001")).toBe(false);
    expect(seriesMatchesType("FACTURA", "B001")).toBe(false);
    expect(seriesMatchesType("BOLETA", "B01")).toBe(false);
    expect(seriesMatchesType("FACTURA", "FA01")).toBe(false);
  });
  it("las notas siguen la serie del comprobante que modifican", () => {
    expect(seriesMatchesType("NOTA_CREDITO", "BC01", "BOLETA")).toBe(true);
    expect(seriesMatchesType("NOTA_CREDITO", "FC01", "FACTURA")).toBe(true);
    expect(seriesMatchesType("NOTA_CREDITO", "FC01", "BOLETA")).toBe(false);
    expect(seriesMatchesType("NOTA_DEBITO", "BD01", "FACTURA")).toBe(false);
  });
});
