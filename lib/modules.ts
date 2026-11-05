import type { AppModule } from "@/lib/db/enums";

/**
 * Módulos comerciales. El SuperAdmin los activa por cliente (casillas) dentro de lo que incluye su plan;
 * lo que está apagado desaparece de menús, botones y rutas porque los PERMISOS del módulo se retiran
 * (`session-resolver`) y toda pantalla y servicio los exige.
 */

/** Siempre activos: sin ellos el cliente no podría administrar su cuenta. */
export const LOCKED_MODULES: readonly AppModule[] = ["USERS", "SETTINGS", "AUDIT"];

export interface ModuleGroup {
  id: string;
  label: string;
  description: string;
  modules: readonly AppModule[];
}

/** Casillas que ve el SuperAdmin (cada una agrupa los módulos técnicos que la componen). */
export const MODULE_GROUPS: readonly ModuleGroup[] = [
  {
    id: "core",
    label: "Núcleo POS",
    description: "Ventas, caja, clientes, catálogo e inventario",
    modules: ["POS", "CASH", "CUSTOMERS", "CATALOG", "INVENTORY"],
  },
  {
    id: "billing",
    label: "Facturación SUNAT",
    description: "Boletas, facturas y notas electrónicas",
    modules: ["BILLING"],
  },
  {
    id: "workshop",
    label: "Taller y servicios",
    description: "Órdenes de trabajo, vehículos y cotizaciones de servicio",
    modules: ["WORKSHOP"],
  },
  {
    id: "warranties",
    label: "Garantías",
    description: "Pólizas y reclamos de garantía",
    modules: ["WARRANTIES"],
  },
  {
    id: "purchasing",
    label: "Compras y proveedores",
    description: "Órdenes de compra, recepciones y devoluciones",
    modules: ["PURCHASING"],
  },
  {
    id: "ai",
    label: "IA de inventario y compras",
    description: "Agente que propone pedidos según rotación y stock",
    modules: ["AI_AGENT"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    description: "Avisos a clientes y mensajería con proveedores",
    modules: ["WHATSAPP"],
  },
  {
    id: "accounting",
    label: "Contabilidad (libros PLE)",
    description: "Registro de ventas 14.1 y de compras 8.1 en TXT para SUNAT",
    modules: ["ACCOUNTING"],
  },
  {
    id: "branches",
    label: "Multi-sucursal",
    description: "Varias sedes y almacenes",
    modules: ["BRANCHES"],
  },
  {
    id: "reports",
    label: "Reportes",
    description: "Reportes de ventas, inventario y rentabilidad",
    modules: ["REPORTS"],
  },
] as const;

export const MODULE_GROUP_IDS = MODULE_GROUPS.map((g) => g.id);

export type BusinessType = "AUTOPARTS" | "WORKSHOP" | "MIXED";

export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  AUTOPARTS: "Tienda de autopartes (comercial)",
  WORKSHOP: "Taller mecánico (servicios)",
  MIXED: "Mixto (tienda y taller)",
};

/** Casillas que se marcan por defecto según el rubro (el SuperAdmin puede ajustarlas una a una). */
export const BUSINESS_PRESETS: Record<BusinessType, readonly string[]> = {
  AUTOPARTS: [
    "core",
    "billing",
    "purchasing",
    "ai",
    "whatsapp",
    "accounting",
    "branches",
    "reports",
  ],
  WORKSHOP: MODULE_GROUP_IDS,
  MIXED: MODULE_GROUP_IDS,
};

/**
 * Módulos que de verdad usa el cliente: los de su plan, sin los que el SuperAdmin apagó (y respetando la lista
 * blanca heredada, si existe). Los módulos fijos nunca se apagan.
 */
export function effectiveModuleList(
  included: readonly AppModule[],
  disabled: readonly AppModule[] = [],
  legacyEnabled: readonly AppModule[] = [],
): AppModule[] {
  return included.filter(
    (module) =>
      LOCKED_MODULES.includes(module) ||
      ((legacyEnabled.length === 0 || legacyEnabled.includes(module)) &&
        !disabled.includes(module)),
  );
}

export interface GroupState {
  group: ModuleGroup;
  /** El plan lo incluye (si no, la casilla aparece bloqueada). */
  included: boolean;
  /** Está activo para este cliente. */
  active: boolean;
}

export function groupStates(
  included: readonly AppModule[],
  disabled: readonly AppModule[] = [],
  legacyEnabled: readonly AppModule[] = [],
): GroupState[] {
  const effective = effectiveModuleList(included, disabled, legacyEnabled);
  return MODULE_GROUPS.map((group) => ({
    group,
    included: group.modules.some((m) => included.includes(m)),
    active:
      group.modules.every((m) => !included.includes(m) || effective.includes(m)) &&
      group.modules.some((m) => effective.includes(m)),
  }));
}

/** Módulos a apagar (de los que incluye el plan) dado el conjunto de casillas marcadas. */
export function disabledFromGroups(
  included: readonly AppModule[],
  selectedGroupIds: readonly string[],
): AppModule[] {
  const keep = new Set<AppModule>(LOCKED_MODULES);
  for (const group of MODULE_GROUPS)
    if (selectedGroupIds.includes(group.id)) for (const m of group.modules) keep.add(m);
  return included.filter((m) => !keep.has(m));
}

export const MODULE_LABEL: Record<AppModule, string> = {
  USERS: "Usuarios",
  CUSTOMERS: "Clientes",
  CATALOG: "Catálogo",
  INVENTORY: "Inventario",
  PURCHASING: "Compras",
  AI_AGENT: "IA de inventario y compras",
  WORKSHOP: "Taller",
  WARRANTIES: "Garantías",
  POS: "Punto de venta",
  CASH: "Caja",
  BILLING: "Facturación SUNAT",
  REPORTS: "Reportes",
  SETTINGS: "Configuración",
  AUDIT: "Auditoría",
  WHATSAPP: "WhatsApp",
  ACCOUNTING: "Contabilidad (PLE)",
  BRANCHES: "Multi-sucursal",
};
