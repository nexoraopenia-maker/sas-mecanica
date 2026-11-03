import { documentError, isValidRuc } from "@/lib/workshop/documents";
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

/** Tasa vigente del IGV en el Perú (16 % de IGV + 2 % de IPM). Los comprobantes electrónicos la exigen. */
export const IGV_RATE = 0.18;

/** Prefijos de RUC que pueden recibir una factura: 10 (persona natural con negocio) y 20 (persona jurídica). */
const FACTURABLE_RUC_PREFIX = /^(10|20)/;

/**
 * Reglas de emisión que SUNAT rechazaría. Se validan ANTES de crear el comprobante para que el
 * cajero lo corrija en el mostrador, no que lo descubra un rechazo horas después.
 *
 * - Factura: comprador con RUC (11 dígitos, dígito verificador y prefijo 10 o 20) y razón social.
 *   Que el RUC esté activo y habido solo lo puede confirmar SUNAT (el OSE rechaza el comprobante si no).
 * - Boleta: hasta S/ 700 puede ser anónima; por encima exige identificar al comprador con un documento
 *   válido (DNI, carné de extranjería, pasaporte o RUC). Si se identifica, el documento debe ser válido.
 */
export function validateIssuance(
  type: "BOLETA" | "FACTURA",
  total: number,
  buyer: Buyer | null,
): string | null {
  if (type === "FACTURA") {
    if (!buyer || buyer.docType !== "RUC") return "La factura exige un cliente con RUC";
    if (!isValidRuc(buyer.docNumber)) return "El RUC del cliente no es válido";
    if (!FACTURABLE_RUC_PREFIX.test(buyer.docNumber))
      return "El RUC debe empezar con 10 o 20 para emitir una factura";
    if (buyer.name.trim().length < 2) return "La factura exige la razón social del cliente";
    return null;
  }
  if (!buyer) {
    return total > ANONYMOUS_BOLETA_LIMIT
      ? `Una boleta mayor a S/ ${ANONYMOUS_BOLETA_LIMIT} exige identificar al cliente (DNI, carné de extranjería o pasaporte)`
      : null;
  }
  if (total > ANONYMOUS_BOLETA_LIMIT && buyer.docType === "OTHER")
    return `Una boleta mayor a S/ ${ANONYMOUS_BOLETA_LIMIT} exige DNI, carné de extranjería, pasaporte o RUC del cliente`;
  const problem = documentError(buyer.docType, buyer.docNumber);
  if (problem) return problem;
  if (buyer.docType === "RUC" && !isValidRuc(buyer.docNumber)) return "RUC inválido";
  return null;
}

/**
 * El IGV de un comprobante electrónico es 18 %. Si la empresa lo configuró distinto, no se emite: el OSE
 * lo rechazaría. Con cero operaciones gravadas (todo exonerado/inafecto) la tasa no interviene.
 */
export function validateIgvRate(
  taxRate: string | number,
  taxedBase: string | number,
): string | null {
  if (Number(taxedBase) <= 0) return null;
  return Math.abs(Number(taxRate) - IGV_RATE) < 1e-9
    ? null
    : `La tasa de IGV configurada (${(Number(taxRate) * 100).toFixed(2)} %) no es la vigente (18 %). Corrígela en Configuración antes de emitir comprobantes`;
}

/** Serie y tipo deben coincidir: B### para boletas, F### para facturas; las notas siguen la serie del comprobante que modifican. */
export function seriesMatchesType(
  type: FiscalType,
  series: string,
  relatedType?: FiscalType | null,
): boolean {
  const first = series.charAt(0);
  if (type === "BOLETA") return /^B\d{3}$/.test(series);
  if (type === "FACTURA") return /^F\d{3}$/.test(series);
  if (!relatedType) return first === "B" || first === "F";
  return first === (relatedType === "FACTURA" ? "F" : "B");
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
