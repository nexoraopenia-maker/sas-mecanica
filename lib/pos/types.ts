/** Tipos del mostrador compartidos entre servidor, navegador y almacenamiento sin conexión. */

export type PosAffectation = "TAXED" | "EXEMPT" | "UNAFFECTED";
export type PosTracking = "NONE" | "LOT" | "SERIAL";

export interface PosProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  kind: string;
  brand: string | null;
  /** Precio de lista (con IGV si la empresa así lo configura). */
  salePrice: string;
  /** Stock total; null si el rol no ve inventario. */
  stock: number | null;
  trackingMode: PosTracking;
  isStocked: boolean;
  taxAffectation: PosAffectation;
  /** Código OEM y equivalentes, para buscar por referencia. */
  codes: string[];
  /** Medida de llanta canónica («205/55 R16») o null. */
  tire: string | null;
}

export interface PosTaxContext {
  /** Tasa como fracción: «0.18». */
  taxRate: string;
  pricesIncludeTax: boolean;
}

export interface PosSnapshot {
  version: 1;
  generatedAt: string;
  tax: PosTaxContext;
  products: PosProduct[];
  /** Si el catálogo se recortó por tamaño (el mostrador avisa y sigue funcionando con la búsqueda en línea). */
  truncated: boolean;
}
