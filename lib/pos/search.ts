import { formatTireSize, parseTireSize } from "@/lib/inventory/tire";
import type { PosProduct } from "./types";

/** Minúsculas, sin tildes y con espacios simples: «Pastillas  de Freno» → «pastillas de freno». */
export function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Producto con sus campos ya normalizados: se calcula una vez y se reutiliza en cada tecla. */
export interface IndexedProduct {
  product: PosProduct;
  sku: string;
  barcode: string;
  nameWords: string[];
  name: string;
  brand: string;
  codes: string[];
  tire: string;
}

export function indexProduct(product: PosProduct): IndexedProduct {
  const name = normalizeText(product.name);
  return {
    product,
    sku: normalizeText(product.sku),
    barcode: product.barcode ? normalizeText(product.barcode) : "",
    name,
    nameWords: name.split(" "),
    brand: product.brand ? normalizeText(product.brand) : "",
    codes: product.codes.map(normalizeText),
    tire: product.tire ? normalizeText(product.tire) : "",
  };
}

interface PreparedQuery {
  whole: string;
  tokens: string[];
  tire: string | null;
}

function prepareQuery(query: string): PreparedQuery | null {
  const whole = normalizeText(query);
  const tokens = whole.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;
  const size = parseTireSize(query);
  return { whole, tokens, tire: size ? normalizeText(formatTireSize(size)) : null };
}

function scoreIndexed(h: IndexedProduct, q: PreparedQuery): number {
  const tireMatch = q.tire !== null && h.tire === q.tire;
  let score = 0;
  if (h.sku === q.whole || (h.barcode !== "" && h.barcode === q.whole)) score += 1000;
  else if (h.sku.startsWith(q.whole)) score += 400;
  if (h.codes.includes(q.whole)) score += 300;
  if (tireMatch) score += 200;
  for (const token of q.tokens) {
    let best = 0;
    if (h.sku.startsWith(token)) best = Math.max(best, 60);
    else if (h.sku.includes(token)) best = Math.max(best, 25);
    if (h.barcode !== "" && h.barcode.startsWith(token)) best = Math.max(best, 60);
    if (h.nameWords.some((word) => word.startsWith(token))) best = Math.max(best, 40);
    else if (h.name.includes(token)) best = Math.max(best, 15);
    if (h.brand.includes(token)) best = Math.max(best, 20);
    if (h.codes.some((code) => code.includes(token))) best = Math.max(best, 20);
    if (h.tire !== "" && h.tire.includes(token)) best = Math.max(best, 20);
    if (best === 0 && !tireMatch) return -1;
    score += best;
  }
  return score;
}

/**
 * Puntaje de una sugerencia: todas las palabras de la consulta deben aparecer (en nombre, SKU, marca,
 * código de barras, códigos OEM o medida de llanta). Las coincidencias exactas de código pesan más.
 * Devuelve -1 si no coincide.
 */
export function scoreProduct(product: PosProduct, query: string): number {
  const prepared = prepareQuery(query);
  return prepared ? scoreIndexed(indexProduct(product), prepared) : -1;
}

/** Catálogo local indexado (para vender sin conexión): cada búsqueda solo compara texto ya normalizado. */
export class LocalCatalog {
  private readonly entries: IndexedProduct[];

  constructor(products: readonly PosProduct[]) {
    this.entries = products.map(indexProduct);
  }

  get size(): number {
    return this.entries.length;
  }

  search(query: string, limit = 8): PosProduct[] {
    const prepared = prepareQuery(query);
    if (!prepared) return [];
    return this.entries
      .map((entry) => ({ entry, score: scoreIndexed(entry, prepared) }))
      .filter((hit) => hit.score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.entry.product.name.localeCompare(b.entry.product.name, "es") ||
          a.entry.product.sku.localeCompare(b.entry.product.sku),
      )
      .slice(0, limit)
      .map((hit) => hit.entry.product);
  }
}

export function searchLocal(
  products: readonly PosProduct[],
  query: string,
  limit = 8,
): PosProduct[] {
  return new LocalCatalog(products).search(query, limit);
}

/** Parte un texto en trozos resaltados según las palabras buscadas (para el desplegable). */
export function highlightParts(
  text: string,
  query: string,
): Array<{ text: string; match: boolean }> {
  const tokens = [
    ...new Set(
      normalizeText(query)
        .split(" ")
        .filter((token) => token.length > 0),
    ),
  ];
  const chars = [...text];
  const folded = chars.map((ch) => normalizeText(ch) || ch.toLowerCase());
  // Solo se resalta si cada carácter conserva su longitud al normalizarse (sin descomposiciones raras).
  const aligned = folded.every((f) => f.length === 1 || f === "");
  const flags = new Array<boolean>(chars.length).fill(false);
  if (aligned && tokens.length > 0) {
    const flat = folded.map((f) => f || " ").join("");
    for (const token of tokens) {
      let from = 0;
      for (;;) {
        const at = flat.indexOf(token, from);
        if (at < 0) break;
        for (let i = at; i < at + token.length; i += 1) flags[i] = true;
        from = at + token.length;
      }
    }
  }
  const parts: Array<{ text: string; match: boolean }> = [];
  chars.forEach((ch, i) => {
    const match = flags[i] ?? false;
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += ch;
    else parts.push({ text: ch, match });
  });
  return parts;
}
