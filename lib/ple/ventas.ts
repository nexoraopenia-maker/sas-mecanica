import { totalsOfLines, type DocumentLine } from "@/lib/billing/payload";
import {
  DOCUMENT_TYPE_CODE,
  IDENTITY_CODE,
  type Buyer,
  type FiscalType,
} from "@/lib/billing/sunat";
import { pleDate, plePeriod, pleMoney, pleText, PLE_FX_PEN, PLE_ZERO } from "./format";
import { VENTAS_14_1 } from "./spec";

/** Comprobante emitido, tal como lo necesita el Registro de Ventas e Ingresos. */
export interface SaleBookDoc {
  type: FiscalType;
  /** ACCEPTED = aceptado por SUNAT/OSE; VOIDED = número inutilizado antes de aceptarse. */
  state: "ACCEPTED" | "VOIDED";
  series: string;
  correlative: number;
  issueDate: Date;
  buyer: Buyer | null;
  lines: DocumentLine[];
  related: { type: FiscalType; series: string; correlative: number; issueDate: Date } | null;
  /** Cancelado íntegramente con un medio de pago (tarjeta, transferencia, Yape/Plin) y no en efectivo. */
  paidWithBankMethod: boolean;
}

/** Cliente sin documento (boleta < S/ 700): «Doc.trib.no.dom.sin.ruc» con ceros, como usa el PLE para clientes varios. */
export const ANONYMOUS_BUYER = {
  docType: "0",
  docNumber: "00000000",
  name: "CLIENTES VARIOS",
} as const;

const TYPE_ORDER: Record<FiscalType, number> = {
  FACTURA: 0,
  BOLETA: 1,
  NOTA_CREDITO: 2,
  NOTA_DEBITO: 3,
};

export function documentNumber(correlative: number): string {
  return String(correlative).padStart(8, "0");
}

export function sortSaleDocs(docs: SaleBookDoc[]): SaleBookDoc[] {
  return [...docs].sort(
    (a, b) =>
      a.issueDate.getTime() - b.issueDate.getTime() ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      a.series.localeCompare(b.series) ||
      a.correlative - b.correlative,
  );
}

/**
 * Filas del Formato 14.1 (35 campos). Sin Libro Diario, el CUO es el correlativo del mes (campo 2) y el campo 3 lo
 * lleva con prefijo «M» (asiento de movimiento). Las notas de crédito restan (importes negativos); un comprobante
 * inutilizado va con estado «2» e importes en cero; todo lo demás es estado «1» (operación del periodo).
 */
export function buildSalesRows(docs: SaleBookDoc[], year: number, month: number): string[][] {
  const period = plePeriod(year, month);
  return sortSaleDocs(docs).map((doc, index) => {
    const n = index + 1;
    const row: string[] = Array.from({ length: VENTAS_14_1.length }, () => "");
    const set = (field: number, value: string) => {
      row[field - 1] = value;
    };
    set(1, period);
    set(2, String(n));
    set(3, `M${n}`);
    set(6, DOCUMENT_TYPE_CODE[doc.type]);
    set(7, pleText(doc.series, 20));
    set(8, documentNumber(doc.correlative));

    if (doc.state === "VOIDED") {
      for (let field = 13; field <= 25; field += 1) set(field, PLE_ZERO);
      set(35, "2");
      return row;
    }

    const totals = totalsOfLines(doc.lines);
    const sign = doc.type === "NOTA_CREDITO" ? -1 : 1;
    const amount = (value: string) => pleMoney(sign * Number(value));
    const buyer = doc.buyer
      ? {
          type: IDENTITY_CODE[doc.buyer.docType],
          number: doc.buyer.docNumber,
          name: doc.buyer.name,
        }
      : {
          type: ANONYMOUS_BUYER.docType,
          number: ANONYMOUS_BUYER.docNumber,
          name: ANONYMOUS_BUYER.name,
        };

    set(4, pleDate(doc.issueDate));
    set(10, buyer.type);
    set(11, pleText(buyer.number, 15));
    set(12, pleText(buyer.name, 100));
    set(13, PLE_ZERO);
    set(14, amount(totals.taxed));
    set(15, PLE_ZERO);
    set(16, amount(totals.tax));
    set(17, PLE_ZERO);
    set(18, amount(totals.exempt));
    set(19, amount(totals.unaffected));
    for (const field of [20, 21, 22, 23, 24]) set(field, PLE_ZERO);
    set(25, amount(totals.total));
    set(26, "PEN");
    set(27, PLE_FX_PEN);
    if (doc.related) {
      set(28, pleDate(doc.related.issueDate));
      set(29, DOCUMENT_TYPE_CODE[doc.related.type]);
      set(30, pleText(doc.related.series, 20));
      set(31, documentNumber(doc.related.correlative));
    }
    if (doc.paidWithBankMethod && doc.type !== "NOTA_CREDITO") set(34, "1");
    set(35, "1");
    return row;
  });
}
