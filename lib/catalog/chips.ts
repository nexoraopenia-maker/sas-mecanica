import type { ProductKind } from "@/lib/db/enums";

/** Chips de categoría del catálogo. `kind` filtra por tipo de producto; `category` por nombre de categoría (o su padre). */
export const CATALOG_CHIPS = [
  { id: "todos", label: "Todos" },
  { id: "lubricante", label: "Lubricante", kind: "LUBRICANT" },
  { id: "filtro", label: "Filtro", category: "filtro" },
  { id: "frenos", label: "Frenos", category: "freno" },
  { id: "llantas", label: "Llantas", kind: "TIRE" },
  { id: "baterias", label: "Baterías", kind: "BATTERY" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  kind?: ProductKind;
  category?: string;
}>;

export type CatalogChipId = (typeof CATALOG_CHIPS)[number]["id"];
export const CATALOG_CHIP_IDS = CATALOG_CHIPS.map((chip) => chip.id) as [
  CatalogChipId,
  ...CatalogChipId[],
];
