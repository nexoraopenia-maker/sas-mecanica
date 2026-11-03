export type StockLight = "GREEN" | "AMBER" | "RED";

export interface StockIndicator {
  light: StockLight;
  /** Relleno de la barra (0–1) o null si no hay punto de reposición (no se dibuja barra). */
  bar: number | null;
  /** Posición (0–1) de la marca del punto de reposición en la barra, o null sin barra. */
  mark: number | null;
}

/**
 * Semáforo del catálogo con el punto de reposición ya existente (suma de las políticas por almacén):
 * rojo si el stock es 0; ámbar en el punto de reposición o por debajo; verde por encima.
 * Sin punto de reposición: verde (si hay stock) y sin barra. La barra llena al 100 % cuando el stock
 * duplica el punto de reposición, que queda marcado a la mitad.
 */
export function stockIndicator(quantity: number, reorderPoint: number): StockIndicator {
  const hasPoint = reorderPoint > 0;
  const bar = hasPoint ? Math.min(Math.max(quantity, 0) / (reorderPoint * 2), 1) : null;
  const mark = hasPoint ? 0.5 : null;
  if (quantity <= 0) return { light: "RED", bar, mark };
  if (!hasPoint) return { light: "GREEN", bar: null, mark: null };
  return { light: quantity <= reorderPoint ? "AMBER" : "GREEN", bar, mark };
}

export const STOCK_LIGHT_LABEL: Record<StockLight, string> = {
  GREEN: "Stock normal",
  AMBER: "En punto de reposición",
  RED: "Sin stock",
};
