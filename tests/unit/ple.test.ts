import { describe, expect, it } from "vitest";
import type { DocumentLine } from "@/lib/billing/payload";
import { buildPurchaseRows, purchaseState, type PurchaseBookDoc } from "@/lib/ple/compras";
import {
  encodeAnsi,
  pleDate,
  pleFile,
  pleFileName,
  pleLine,
  pleMoney,
  plePeriod,
  pleText,
} from "@/lib/ple/format";
import { COMPRAS_8_1, VENTAS_14_1, validateRow } from "@/lib/ple/spec";
import { buildSalesRows, type SaleBookDoc } from "@/lib/ple/ventas";
import { purchaseInvoiceSchema, pleMonthSchema } from "@/lib/validation/ple";

// 15/03/2026 12:00 en Lima.
const MARCH = new Date("2026-03-15T17:00:00.000Z");

const line = (
  base: string,
  tax: string,
  affectation: DocumentLine["affectation"] = "TAXED",
): DocumentLine => ({
  code: "A1",
  description: "Filtro",
  unitCode: "NIU",
  quantity: "1",
  unitValue: base,
  unitPrice: (Number(base) + Number(tax)).toFixed(2),
  discount: "0.00",
  base,
  tax,
  total: (Number(base) + Number(tax)).toFixed(2),
  affectation,
});

const sale = (over: Partial<SaleBookDoc> = {}): SaleBookDoc => ({
  type: "FACTURA",
  state: "ACCEPTED",
  series: "F001",
  correlative: 7,
  issueDate: MARCH,
  buyer: { docType: "RUC", docNumber: "20100070970", name: "Transportes Ñandú SAC" },
  lines: [line("100.00", "18.00")],
  related: null,
  paidWithBankMethod: false,
  ...over,
});

const purchase = (over: Partial<PurchaseBookDoc> = {}): PurchaseBookDoc => ({
  docTypeCode: "01",
  series: "F123",
  number: "456",
  issueDate: MARCH,
  dueDate: null,
  supplier: { docType: "RUC", docNumber: "20100070970", name: "Repuestos SA" },
  taxedBase: "100.00",
  igv: "18.00",
  exemptTotal: "0.00",
  total: "118.00",
  givesTaxCredit: true,
  paidWithBankMethod: false,
  related: null,
  ...over,
});

describe("formato básico PLE", () => {
  it("fecha en horario de Lima, no UTC", () => {
    expect(pleDate(new Date("2026-03-01T03:00:00.000Z"))).toBe("28/02/2026");
    expect(pleDate(MARCH)).toBe("15/03/2026");
  });
  it("periodo AAAAMM00", () => {
    expect(plePeriod(2026, 3)).toBe("20260300");
    expect(plePeriod(2026, 12)).toBe("20261200");
  });
  it("importes con 2 decimales, sin separador de miles y negativos con signo", () => {
    expect(pleMoney("1234567.005")).toBe("1234567.01");
    expect(pleMoney(-18)).toBe("-18.00");
    expect(pleMoney("0")).toBe("0.00");
    expect(pleMoney("-0.001")).toBe("0.00");
  });
  it("el texto no puede llevar palotes ni saltos y se recorta", () => {
    expect(pleText("A|B\nC\r\nD", 100)).toBe("A B C D");
    expect(pleText("x".repeat(200), 100)).toHaveLength(100);
    expect(pleText(null, 10)).toBe("");
  });
  it("línea con palotes, palote final y salto CRLF", () => {
    expect(pleLine(["a", "", "b"])).toBe("a||b|");
    expect(pleFile([["a"], ["b"]])).toBe("a|\r\nb|\r\n");
  });
  it("ANSI: conserva tildes/ñ (Windows-1252) y degrada lo que no existe", () => {
    expect([...encodeAnsi("Ñandú")]).toEqual([0xd1, 0x61, 0x6e, 0x64, 0xfa]);
    expect([...encodeAnsi("ń")]).toEqual([0x6e]);
    expect([...encodeAnsi("漢")]).toEqual([63]);
  });
  it("nombre de archivo: LE + RUC + AAAA + MM + 00 + libro + 00 + O I M G + .TXT", () => {
    const name = pleFileName({
      ruc: "20100070970",
      year: 2026,
      month: 3,
      book: "14.1",
      hasData: true,
    });
    expect(name).toBe("LE20100070970202603001401000011" + "11.TXT");
    expect(name).toMatch(/^LE\d{11}\d{4}\d{2}00(140100|080100)00[12][01]1[01]\.TXT$/);
    expect(
      pleFileName({ ruc: "20100070970", year: 2026, month: 3, book: "8.1", hasData: false }),
    ).toBe("LE20100070970202603000801000010" + "11.TXT");
  });
});

describe("estructura oficial", () => {
  it("14.1 tiene 35 campos y 8.1 tiene 42", () => {
    expect(VENTAS_14_1).toHaveLength(35);
    expect(COMPRAS_8_1).toHaveLength(42);
    expect(VENTAS_14_1.map((f) => f.n)).toEqual(Array.from({ length: 35 }, (_, i) => i + 1));
    expect(COMPRAS_8_1.map((f) => f.n)).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
  });
});

describe("Registro de Ventas 14.1", () => {
  it("una factura genera una fila válida de 35 campos con cada campo en su formato", () => {
    const [row] = buildSalesRows([sale()], 2026, 3);
    expect(row).toHaveLength(35);
    expect(validateRow("14.1", row!)).toEqual([]);
    expect(row![0]).toBe("20260300");
    expect(row![1]).toBe("1");
    expect(row![2]).toBe("M1");
    expect(row![3]).toBe("15/03/2026");
    expect(row![5]).toBe("01");
    expect(row![6]).toBe("F001");
    expect(row![7]).toBe("00000007");
    expect(row![9]).toBe("6");
    expect(row![10]).toBe("20100070970");
    expect(row![13]).toBe("100.00");
    expect(row![15]).toBe("18.00");
    expect(row![24]).toBe("118.00");
    expect(row![25]).toBe("PEN");
    expect(row![26]).toBe("1.000");
    expect(row![34]).toBe("1");
  });
  it("boleta sin comprador usa documento 0 con ceros", () => {
    const [row] = buildSalesRows([sale({ type: "BOLETA", series: "B001", buyer: null })], 2026, 3);
    expect(validateRow("14.1", row!)).toEqual([]);
    expect(row![5]).toBe("03");
    expect(row![9]).toBe("0");
    expect(row![10]).toBe("00000000");
  });
  it("nota de crédito resta (importes negativos) y referencia el comprobante original", () => {
    const [row] = buildSalesRows(
      [
        sale({
          type: "NOTA_CREDITO",
          series: "FC01",
          related: { type: "FACTURA", series: "F001", correlative: 7, issueDate: MARCH },
        }),
      ],
      2026,
      3,
    );
    expect(validateRow("14.1", row!)).toEqual([]);
    expect(row![5]).toBe("07");
    expect(row![13]).toBe("-100.00");
    expect(row![15]).toBe("-18.00");
    expect(row![24]).toBe("-118.00");
    expect(row![27]).toBe("15/03/2026");
    expect(row![28]).toBe("01");
    expect(row![29]).toBe("F001");
    expect(row![30]).toBe("00000007");
  });
  it("comprobante inutilizado: estado 2, sin fecha ni cliente e importes en cero", () => {
    const [row] = buildSalesRows([sale({ state: "VOIDED" })], 2026, 3);
    expect(validateRow("14.1", row!)).toEqual([]);
    expect(row![34]).toBe("2");
    expect(row![3]).toBe("");
    expect(row![24]).toBe("0.00");
  });
  it("exonerado e inafecto van a sus columnas", () => {
    const [row] = buildSalesRows(
      [sale({ lines: [line("50.00", "0.00", "EXEMPT"), line("20.00", "0.00", "UNAFFECTED")] })],
      2026,
      3,
    );
    expect(validateRow("14.1", row!)).toEqual([]);
    expect(row![13]).toBe("0.00");
    expect(row![17]).toBe("50.00");
    expect(row![18]).toBe("20.00");
    expect(row![24]).toBe("70.00");
  });
  it("numera por fecha, luego tipo, serie y correlativo; el CUO es único", () => {
    const rows = buildSalesRows(
      [
        sale({ correlative: 9, issueDate: new Date("2026-03-20T17:00:00Z") }),
        sale({ type: "BOLETA", series: "B001", correlative: 2 }),
        sale({ correlative: 8 }),
      ],
      2026,
      3,
    );
    expect(rows.map((r) => [r[1], r[2], r[6], r[7]])).toEqual([
      ["1", "M1", "F001", "00000008"],
      ["2", "M2", "B001", "00000002"],
      ["3", "M3", "F001", "00000009"],
    ]);
    expect(new Set(rows.map((r) => r[1])).size).toBe(3);
    for (const row of rows) expect(validateRow("14.1", row)).toEqual([]);
  });
  it("los campos de texto se sanean: un nombre con palotes no rompe la línea", () => {
    const [row] = buildSalesRows(
      [sale({ buyer: { docType: "RUC", docNumber: "20100070970", name: "A|B\nC" } })],
      2026,
      3,
    );
    expect(row![11]).toBe("A B C");
    expect(pleLine(row!).split("|")).toHaveLength(36);
  });
  it("medio de pago bancarizado marca el campo 34 solo cuando corresponde", () => {
    const [bank] = buildSalesRows([sale({ paidWithBankMethod: true })], 2026, 3);
    const [cash] = buildSalesRows([sale({ paidWithBankMethod: false })], 2026, 3);
    expect(bank![33]).toBe("1");
    expect(cash![33]).toBe("");
  });
});

describe("validador de filas (detecta formatos y longitudes inválidos)", () => {
  const valid = () => buildSalesRows([sale()], 2026, 3)[0]!;
  const mutate = (field: number, value: string) => {
    const row = valid();
    row[field - 1] = value;
    return validateRow("14.1", row);
  };
  it("rechaza filas con número de campos incorrecto", () => {
    expect(validateRow("14.1", valid().slice(1))[0]).toMatch(/35/);
    expect(validateRow("8.1", valid())[0]).toMatch(/42/);
  });
  it.each([
    [1, "202603"],
    [1, "20261300"],
    [2, ""],
    [2, "A".repeat(41)],
    [3, "X1"],
    [3, "M"],
    [3, "M12345678901"],
    [4, "2026-03-15"],
    [4, "32/01/2026"],
    [6, "1"],
    [6, "99"],
    [7, "F".repeat(21)],
    [8, "A".repeat(21)],
    [10, "9"],
    [14, "1,000.00"],
    [14, "10.555"],
    [14, "1234567890123.00"],
    [26, "PE"],
    [27, "1.0000"],
    [35, "5"],
  ])("campo %i = %j es inválido", (field, value) => {
    expect(mutate(field, value).length).toBeGreaterThan(0);
  });
  it("todo importe generado lleva exactamente 2 decimales", () => {
    const rows = [
      ...buildSalesRows([sale(), sale({ type: "NOTA_CREDITO", correlative: 1 })], 2026, 3),
    ];
    for (const row of rows)
      for (const field of [14, 16, 18, 19, 25])
        expect(row[field - 1]).toMatch(/^-?\d{1,12}\.\d{2}$/);
  });
  it("rechaza palotes y saltos de línea en cualquier campo", () => {
    expect(mutate(12, "A|B").join()).toMatch(/palotes/);
    expect(mutate(12, "A\nB").join()).toMatch(/palotes/);
  });
  it("estado 2 permite fecha vacía; estado 1 la exige", () => {
    expect(mutate(4, "").join()).toMatch(/Campo 4/);
  });
  it("las notas exigen el comprobante que modifican", () => {
    const [row] = buildSalesRows([sale({ type: "NOTA_CREDITO" })], 2026, 3);
    expect(validateRow("14.1", row!).join()).toMatch(/Campo 2[89]|Campo 3[01]/);
  });
});

describe("Registro de Compras 8.1", () => {
  it("una factura de compra genera una fila válida de 42 campos", () => {
    const [row] = buildPurchaseRows([purchase()], 2026, 3);
    expect(row).toHaveLength(42);
    expect(validateRow("8.1", row!)).toEqual([]);
    expect(row![0]).toBe("20260300");
    expect(row![3]).toBe("15/03/2026");
    expect(row![5]).toBe("01");
    expect(row![6]).toBe("F123");
    expect(row![8]).toBe("456");
    expect(row![10]).toBe("6");
    expect(row![11]).toBe("20100070970");
    expect(row![13]).toBe("100.00");
    expect(row![14]).toBe("18.00");
    expect(row![23]).toBe("118.00");
    expect(row![24]).toBe("PEN");
    expect(row![25]).toBe("1.000");
    expect(row![41]).toBe("1");
  });
  it("el total (campo 24) es la suma de los campos 14 al 23", () => {
    const [row] = buildPurchaseRows([purchase({ exemptTotal: "10.00", total: "128.00" })], 2026, 3);
    const sum = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23].reduce(
      (a, n) => a + Number(row![n - 1] || 0),
      0,
    );
    expect(sum.toFixed(2)).toBe(row![23]);
    expect(validateRow("8.1", row!)).toEqual([]);
  });
  it("sin derecho a crédito: base e IGV pasan a las columnas 18 y 19 y el estado es 0", () => {
    const [row] = buildPurchaseRows([purchase({ givesTaxCredit: false })], 2026, 3);
    expect(row![13]).toBe("0.00");
    expect(row![17]).toBe("100.00");
    expect(row![18]).toBe("18.00");
    expect(row![41]).toBe("0");
    expect(validateRow("8.1", row!)).toEqual([]);
  });
  it("nota de crédito del proveedor resta y referencia el comprobante original", () => {
    const [row] = buildPurchaseRows(
      [
        purchase({
          docTypeCode: "07",
          related: { docTypeCode: "01", series: "F123", number: "400", issueDate: MARCH },
        }),
      ],
      2026,
      3,
    );
    expect(row![13]).toBe("-100.00");
    expect(row![23]).toBe("-118.00");
    expect(row![26]).toBe("15/03/2026");
    expect(row![27]).toBe("01");
    expect(validateRow("8.1", row!)).toEqual([]);
  });
  it("estado según el momento de anotación", () => {
    expect(purchaseState(MARCH, 2026, 3, true)).toEqual({ state: "1", credit: true });
    expect(purchaseState(MARCH, 2026, 5, true)).toEqual({ state: "6", credit: true });
    expect(purchaseState(MARCH, 2027, 3, true)).toEqual({ state: "6", credit: true });
    expect(purchaseState(MARCH, 2027, 4, true)).toEqual({ state: "7", credit: false });
    expect(purchaseState(MARCH, 2026, 3, false)).toEqual({ state: "0", credit: false });
  });
  it("rechaza total que no suma y signo de IGV distinto al de la base", () => {
    const row = buildPurchaseRows([purchase()], 2026, 3)[0]!;
    row[23] = "999.00";
    expect(validateRow("8.1", row).join()).toMatch(/suma/);
    const bad = buildPurchaseRows([purchase()], 2026, 3)[0]!;
    bad[14] = "-18.00";
    bad[23] = "82.00";
    expect(validateRow("8.1", bad).join()).toMatch(/signo/);
  });
  it("numera y ordena por fecha de emisión", () => {
    const rows = buildPurchaseRows(
      [
        purchase({ number: "2", issueDate: new Date("2026-03-20T17:00:00Z") }),
        purchase({ number: "1" }),
      ],
      2026,
      3,
    );
    expect(rows.map((r) => [r[1], r[8]])).toEqual([
      ["1", "1"],
      ["2", "2"],
    ]);
  });
});

describe("validación Zod", () => {
  it("año y mes", () => {
    expect(pleMonthSchema.parse({ year: "2026", month: "3" })).toEqual({ year: 2026, month: 3 });
    expect(pleMonthSchema.safeParse({ year: 2026, month: 13 }).success).toBe(false);
    expect(pleMonthSchema.safeParse({ year: 1999, month: 1 }).success).toBe(false);
    expect(pleMonthSchema.safeParse({ year: "x", month: 1 }).success).toBe(false);
  });
  const base = {
    docTypeCode: "01",
    series: "f123",
    number: "456",
    issueDate: "2026-03-15",
    supplierDocNumber: "20100070970",
    supplierName: "Repuestos SA",
    taxedBase: "100.00",
    igv: "18.00",
  } as const;
  it("acepta una factura de compra válida y normaliza la serie", () => {
    const parsed = purchaseInvoiceSchema.parse(base);
    expect(parsed.series).toBe("F123");
    expect(parsed.exemptTotal).toBe("0");
  });
  it.each([
    ["IGV que no corresponde a la base", { igv: "5.00" }],
    ["RUC inválido", { supplierDocNumber: "20100070971" }],
    ["factura con proveedor sin RUC", { supplierDocType: "DNI", supplierDocNumber: "12345678" }],
    ["importe con 3 decimales", { taxedBase: "100.123" }],
    ["serie con palote", { series: "F|1" }],
    ["total en cero", { taxedBase: "0", igv: "0" }],
    ["periodo anterior a la emisión", { period: "2026-02" }],
    ["vencimiento anterior a la emisión", { dueDate: "2026-03-01" }],
    ["nota sin comprobante que modifica", { docTypeCode: "07" }],
  ])("rechaza %s", (_name, over) => {
    expect(purchaseInvoiceSchema.safeParse({ ...base, ...over }).success).toBe(false);
  });
});
