import { IDENTITY_CODE, type Buyer } from "@/lib/billing/sunat";
import {
  limaYearMonth,
  pleDate,
  plePeriod,
  pleMoney,
  pleText,
  PLE_FX_PEN,
  PLE_ZERO,
} from "./format";
import { COMPRAS_8_1 } from "./spec";

/** Comprobante de compra registrado, tal como lo necesita el Registro de Compras. */
export interface PurchaseBookDoc {
  docTypeCode: string;
  series: string;
  number: string;
  issueDate: Date;
  dueDate: Date | null;
  supplier: Buyer | null;
  taxedBase: string;
  igv: string;
  exemptTotal: string;
  total: string;
  givesTaxCredit: boolean;
  paidWithBankMethod: boolean;
  related: { docTypeCode: string; series: string; number: string; issueDate: Date } | null;
}

/** Meses completos entre el mes de emisión y el periodo en que se anota (0 = mismo mes). */
export function monthsBetween(issue: Date, year: number, month: number): number {
  const { year: iy, month: im } = limaYearMonth(issue);
  return year * 12 + month - (iy * 12 + im);
}

/**
 * Estado del campo 42 y si el crédito fiscal sigue vigente. Mismo mes: 1 con derecho a crédito, 0 sin él. Mes posterior:
 * 6 si se anota dentro de los 12 meses siguientes a la emisión (crédito vigente); pasado ese plazo el crédito se
 * pierde (las cifras pasan a «no dan derecho») y se marca 7.
 */
export function purchaseState(
  issue: Date,
  year: number,
  month: number,
  givesTaxCredit: boolean,
): { state: "0" | "1" | "6" | "7"; credit: boolean } {
  if (!givesTaxCredit) return { state: "0", credit: false };
  const gap = monthsBetween(issue, year, month);
  if (gap <= 0) return { state: "1", credit: true };
  return gap <= 12 ? { state: "6", credit: true } : { state: "7", credit: false };
}

/**
 * Filas del Formato 8.1 (42 campos). Las notas de crédito del proveedor restan (importes negativos). Si el crédito
 * fiscal no procede, base e IGV van a las columnas «no dan derecho a crédito» (18 y 19). El total (campo 24) es la
 * suma de los campos 14 al 23, como exige la estructura.
 */
export function buildPurchaseRows(
  docs: PurchaseBookDoc[],
  year: number,
  month: number,
): string[][] {
  const period = plePeriod(year, month);
  const sorted = [...docs].sort(
    (a, b) =>
      a.issueDate.getTime() - b.issueDate.getTime() ||
      a.docTypeCode.localeCompare(b.docTypeCode) ||
      a.series.localeCompare(b.series) ||
      a.number.localeCompare(b.number),
  );
  return sorted.map((doc, index) => {
    const n = index + 1;
    const row: string[] = Array.from({ length: COMPRAS_8_1.length }, () => "");
    const set = (field: number, value: string) => {
      row[field - 1] = value;
    };
    const sign = doc.docTypeCode === "07" ? -1 : 1;
    const amount = (value: string) => pleMoney(sign * Number(value));
    const { state, credit } = purchaseState(doc.issueDate, year, month, doc.givesTaxCredit);

    set(1, period);
    set(2, String(n));
    set(3, `M${n}`);
    set(4, pleDate(doc.issueDate));
    if (doc.dueDate) set(5, pleDate(doc.dueDate));
    set(6, doc.docTypeCode);
    set(7, pleText(doc.series, 20));
    set(9, pleText(doc.number, 20));
    if (doc.supplier && doc.supplier.docType !== "OTHER") {
      set(11, IDENTITY_CODE[doc.supplier.docType]);
      set(12, pleText(doc.supplier.docNumber, 15));
      set(13, pleText(doc.supplier.name, 100));
    }
    for (let field = 14; field <= 23; field += 1) set(field, PLE_ZERO);
    set(credit ? 14 : 18, amount(doc.taxedBase));
    set(credit ? 15 : 19, amount(doc.igv));
    set(20, amount(doc.exemptTotal));
    set(24, amount(doc.total));
    set(25, "PEN");
    set(26, PLE_FX_PEN);
    if (doc.related) {
      set(27, pleDate(doc.related.issueDate));
      set(28, doc.related.docTypeCode);
      set(29, pleText(doc.related.series, 20));
      set(31, pleText(doc.related.number, 20));
    }
    if (doc.paidWithBankMethod) set(41, "1");
    set(42, state);
    return row;
  });
}
