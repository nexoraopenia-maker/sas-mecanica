import { normalizeText } from "./search";
import type { PosProduct } from "./types";

/**
 * Lo que se lee con la cámara (código de barras o QR) puede ser un SKU, un código de barras, un enlace con el SKU
 * o un JSON. Devuelve las formas razonables de buscarlo, de la más literal a la más derivada.
 */
export function scanCandidates(raw: string): string[] {
  const text = raw.trim().replace(/[\u0000-\u001f]/g, "");
  if (!text) return [];
  const out: string[] = [text];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
    if (typeof value === "number") out.push(String(value));
  };
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      for (const key of ["sku", "code", "codigo", "barcode", "id"]) add(url.searchParams.get(key));
      const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
      add(last);
    } catch {
      // URL inválida: se queda con el texto literal.
    }
  } else if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      for (const key of ["sku", "code", "codigo", "barcode"]) add(data[key]);
    } catch {
      // JSON inválido: texto literal.
    }
  } else if (/^(sku|code|codigo|barcode)\s*[:=]/i.test(text)) {
    add(text.replace(/^[^:=]+[:=]\s*/, ""));
  }
  // UPC-A leído como EAN-13 con un 0 delante (y viceversa): se prueba la forma equivalente.
  if (/^0\d{12}$/.test(text)) out.push(text.slice(1));
  if (/^\d{12}$/.test(text)) out.push(`0${text}`);
  return [...new Set(out)];
}

/** Producto cuyo SKU, código de barras u OEM coincide EXACTAMENTE con alguno de los candidatos (sin tildes ni mayúsculas). */
export function matchScan(
  products: readonly PosProduct[],
  candidates: readonly string[],
): PosProduct | null {
  for (const candidate of candidates) {
    const wanted = normalizeText(candidate);
    const hits = products.filter(
      (p) =>
        normalizeText(p.sku) === wanted ||
        (p.barcode !== null && normalizeText(p.barcode) === wanted) ||
        p.codes.some((code) => normalizeText(code) === wanted),
    );
    if (hits.length === 1 && hits[0]) return hits[0];
  }
  return null;
}

/**
 * Evita agregar dos veces el mismo código mientras sigue a la vista de la cámara: la ventana es DESLIZANTE
 * (se renueva cada vez que se vuelve a ver el código), así que para sumar otra unidad hay que apartarlo del
 * encuadre un instante y volver a apuntarlo.
 */
export class ScanDebouncer {
  private lastSeen = new Map<string, number>();
  constructor(private readonly windowMs = 1200) {}
  /** true si el código es nuevo (o dejó de verse al menos `windowMs`) y debe procesarse. */
  accept(code: string, now: number = Date.now()): boolean {
    const previous = this.lastSeen.get(code);
    this.lastSeen.set(code, now);
    return previous === undefined || now - previous >= this.windowMs;
  }
  reset(): void {
    this.lastSeen.clear();
  }
}
