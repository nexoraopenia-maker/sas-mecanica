import { isValidRuc } from "@/lib/workshop/documents";
import type { Affectation } from "@/lib/pos/totals";

export type FiscalType = "BOLETA" | "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO";
export type DocType = "DNI" | "RUC" | "CE" | "PASSPORT" | "OTHER";

/** Catálogo 01 SUNAT: tipo de comprobante. */
export const DOCUMENT_TYPE_CODE: Record<FiscalType, string> = {
  FACTURA: "01",
  BOLETA: "03",
  NOTA_CREDITO: "07",
  NOTA_DEBITO: "08",
};

/** Catálogo 06 SUNAT: tipo de documento de identidad. */
export const IDENTITY_CODE: Record<DocType, string> = {
  OTHER: "0",
  DNI: "1",
  CE: "4",
  RUC: "6",
  PASSPORT: "7",
};

/** Catálogo 07 SUNAT: afectación del IGV. */
export const AFFECTATION_CODE: Record<Affectation, string> = {
  TAXED: "10",
  EXEMPT: "20",
  UNAFFECTED: "30",
};

/** Catálogo 09 (notas de crédito) y 10 (notas de débito). */
export const CREDIT_NOTE_REASONS = {
  "01": "Anulación de la operación",
  "06": "Devolución total",
  "07": "Devolución por ítem",
  "09": "Disminución en el valor",
} as const;
export const DEBIT_NOTE_REASONS = {
  "01": "Intereses por mora",
  "02": "Aumento en el valor",
  "03": "Penalidades",
} as const;
export type CreditNoteReason = keyof typeof CREDIT_NOTE_REASONS;
export type DebitNoteReason = keyof typeof DEBIT_NOTE_REASONS;

/** RUC ficticio de las cuentas demo (sin RUC propio): sus comprobantes son simulados y nunca salen a un OSE real. */
export const DEMO_RUC = "00000000000";

/** Una boleta por montos mayores a este valor debe identificar al comprador. */
export const ANONYMOUS_BOLETA_LIMIT = 700;

/** `type` (no `interface`): se guarda tal cual en una columna JSON. */
export type Buyer = {
  docType: DocType;
  docNumber: string;
  name: string;
  address?: string | null;
};

/**
 * Reglas de emisión que SUNAT rechazaría. Se validan ANTES de crear el comprobante para que el
 * cajero lo corrija en el mostrador, no que lo descubra un rechazo horas después.
 */
export function validateIssuance(
  type: "BOLETA" | "FACTURA",
  total: number,
  buyer: Buyer | null,
): string | null {
  if (type === "FACTURA") {
    if (!buyer || buyer.docType !== "RUC") return "La factura exige un cliente con RUC";
    if (!isValidRuc(buyer.docNumber)) return "El RUC del cliente no es válido";
    if (buyer.name.trim().length < 2) return "La factura exige la razón social del cliente";
    return null;
  }
  if (!buyer) {
    return total > ANONYMOUS_BOLETA_LIMIT
      ? `Una boleta mayor a S/ ${ANONYMOUS_BOLETA_LIMIT} exige identificar al cliente`
      : null;
  }
  if (buyer.docType === "DNI" && !/^\d{8}$/.test(buyer.docNumber)) return "DNI inválido";
  if (buyer.docType === "RUC" && !isValidRuc(buyer.docNumber)) return "RUC inválido";
  return null;
}

/** Cadena del QR del comprobante (formato SUNAT: RUC|tipo|serie|correlativo|IGV|total|fecha|tipoDoc|doc|). */
export function qrString(p: {
  issuerRuc: string;
  type: FiscalType;
  series: string;
  correlative: number;
  tax: string;
  total: string;
  issueDate: Date;
  buyer: Buyer | null;
}): string {
  const date = new Date(p.issueDate.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
  return [
    p.issuerRuc,
    DOCUMENT_TYPE_CODE[p.type],
    p.series,
    String(p.correlative),
    p.tax,
    p.total,
    date,
    p.buyer ? IDENTITY_CODE[p.buyer.docType] : "0",
    p.buyer ? p.buyer.docNumber : "-",
    "",
  ].join("|");
}

export function formatDocumentNumber(series: string, correlative: number): string {
  return `${series}-${String(correlative).padStart(8, "0")}`;
}

const UNITS = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
const TEENS = [
  "DIEZ",
  "ONCE",
  "DOCE",
  "TRECE",
  "CATORCE",
  "QUINCE",
  "DIECISEIS",
  "DIECISIETE",
  "DIECIOCHO",
  "DIECINUEVE",
];
const TWENTIES = [
  "VEINTE",
  "VEINTIUN",
  "VEINTIDOS",
  "VEINTITRES",
  "VEINTICUATRO",
  "VEINTICINCO",
  "VEINTISEIS",
  "VEINTISIETE",
  "VEINTIOCHO",
  "VEINTINUEVE",
];
const TENS = [
  "",
  "",
  "",
  "TREINTA",
  "CUARENTA",
  "CINCUENTA",
  "SESENTA",
  "SETENTA",
  "OCHENTA",
  "NOVENTA",
];
const HUNDREDS = [
  "",
  "CIENTO",
  "DOSCIENTOS",
  "TRESCIENTOS",
  "CUATROCIENTOS",
  "QUINIENTOS",
  "SEISCIENTOS",
  "SETECIENTOS",
  "OCHOCIENTOS",
  "NOVECIENTOS",
];

function below1000(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(HUNDREDS[h] ?? "");
  if (rest >= 10 && rest < 20) parts.push(TEENS[rest - 10] ?? "");
  else if (rest >= 20 && rest < 30) parts.push(TWENTIES[rest - 20] ?? "");
  else if (rest >= 30) {
    const t = Math.floor(rest / 10);
    const u = rest % 10;
    parts.push(u ? `${TENS[t]} Y ${UNITS[u]}` : (TENS[t] ?? ""));
  } else if (rest > 0) parts.push(UNITS[rest] ?? "");
  return parts.join(" ");
}

function integerToWords(n: number): string {
  if (n === 0) return "CERO";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions) parts.push(millions === 1 ? "UN MILLON" : `${integerToWords(millions)} MILLONES`);
  if (thousands) parts.push(thousands === 1 ? "MIL" : `${below1000(thousands)} MIL`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}

/** Leyenda 1000 de SUNAT: «SON: CIENTO DIECIOCHO CON 00/100 SOLES». */
export function amountInWords(amount: string, currency = "PEN"): string {
  const [intPart = "0", decPart = "00"] = Number(amount).toFixed(2).split(".");
  const name = currency === "PEN" ? "SOLES" : currency === "USD" ? "DÓLARES AMERICANOS" : currency;
  return `SON: ${integerToWords(Number(intPart))} CON ${decPart}/100 ${name}`;
}
