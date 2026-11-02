import { Prisma } from "@/lib/db";

const LIMA_OFFSET_MS = 5 * 3_600_000;

/** Fecha DD/MM/AAAA en horario de Lima (el día que SUNAT considera para el comprobante). */
export function pleDate(date: Date): string {
  const lima = new Date(date.getTime() - LIMA_OFFSET_MS);
  const dd = String(lima.getUTCDate()).padStart(2, "0");
  const mm = String(lima.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${lima.getUTCFullYear()}`;
}

/** Año y mes (Lima) de una fecha, para decidir en qué periodo cae. */
export function limaYearMonth(date: Date): { year: number; month: number } {
  const lima = new Date(date.getTime() - LIMA_OFFSET_MS);
  return { year: lima.getUTCFullYear(), month: lima.getUTCMonth() + 1 };
}

/** Campo 1: periodo `AAAAMM00`. */
export function plePeriod(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}${String(month).padStart(2, "0")}00`;
}

/** Importe: hasta 12 enteros y 2 decimales, punto decimal, sin separador de miles; negativo con «-». */
export function pleMoney(value: string | number | Prisma.Decimal): string {
  const amount = new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return amount.isZero() ? "0.00" : amount.toFixed(2);
}

export const PLE_ZERO = "0.00";
/** Tipo de cambio `#.###` (soles = 1.000). */
export const PLE_FX_PEN = "1.000";

/** Texto seguro para un campo: sin palotes ni saltos de línea (romperían el archivo), sin espacios sobrantes, recortado. */
export function pleText(value: string | null | undefined, max: number): string {
  if (!value) return "";
  return value
    .normalize("NFC")
    .replace(/[|\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * El PLE lee el archivo en ANSI (Windows-1252). Los caracteres que no existen en ese juego se reemplazan por su letra
 * base (sin tilde) o por «?» para no corromper el resto de la línea.
 */
export function encodeAnsi(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 63;
    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }
    const base = ch.normalize("NFD").charCodeAt(0);
    bytes.push(base <= 0x7f ? base : 63);
  }
  return Buffer.from(bytes);
}

export type PleBook = "14.1" | "8.1";

/** Código de libro del nombre del archivo (14.1 Registro de Ventas e Ingresos, 8.1 Registro de Compras). */
export const BOOK_CODE: Record<PleBook, string> = { "14.1": "140100", "8.1": "080100" };

/** Indicador de libro generado por el PLE (el nombre lo exige; ver README sobre su verificación). */
export const GENERATED_BY_PLE = "1";

/**
 * `LE` + RUC(11) + AAAA + MM + `00` + libro(6) + oportunidad `00` + operaciones + contenido + moneda + generación + `.TXT`
 * Operaciones 1 = empresa operativa; contenido 1 = con información; moneda 1 = soles.
 */
export function pleFileName(params: {
  ruc: string;
  year: number;
  month: number;
  book: PleBook;
  hasData: boolean;
}): string {
  return `LE${params.ruc}${String(params.year).padStart(4, "0")}${String(params.month).padStart(2, "0")}00${BOOK_CODE[params.book]}00${"1"}${params.hasData ? "1" : "0"}${"1"}${GENERATED_BY_PLE}.TXT`;
}

/** Une los campos con palotes; la línea termina con palote y salto CRLF, como el PLE espera. */
export function pleLine(fields: string[]): string {
  return `${fields.join("|")}|`;
}

export function pleFile(rows: string[][]): string {
  return rows.map((row) => `${pleLine(row)}\r\n`).join("");
}
