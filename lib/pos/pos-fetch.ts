import type { PosProduct } from "./types";

export class PosFetchError extends Error {
  constructor(
    message: string,
    /** true = no hubo respuesta del servidor (sin red, tiempo agotado): se puede usar el catálogo local. */
    readonly network: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "PosFetchError";
  }
}

/** GET JSON de las rutas del mostrador. Cancelable; distingue falla de red de error del servidor. */
export async function posGet<T>(
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== ""));
  let response: Response;
  try {
    response = await fetch(`${path}?${query}`, { credentials: "same-origin", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PosFetchError("Sin conexión con el servidor", true);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new PosFetchError(
      body?.error ?? "No se pudo completar la consulta",
      false,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export const fetchSuggestions = (query: string, signal?: AbortSignal) =>
  posGet<{ products: PosProduct[] }>("/api/pos/products", { q: query }, signal).then(
    (r) => r.products,
  );

/**
 * Une dos listas de productos: se conserva el orden de la primera (las coincidencias locales, instantáneas)
 * y se agregan al final las que solo trajo el servidor; si un producto está en ambas, vale el del servidor
 * (stock y precio más recientes).
 */
export function mergeProducts(
  local: readonly PosProduct[],
  remote: readonly PosProduct[],
  limit = 8,
): PosProduct[] {
  const remoteById = new Map(remote.map((p) => [p.id, p]));
  const merged = local.map((p) => remoteById.get(p.id) ?? p);
  const seen = new Set(merged.map((p) => p.id));
  for (const product of remote) if (!seen.has(product.id)) merged.push(product);
  return merged.slice(0, limit);
}
