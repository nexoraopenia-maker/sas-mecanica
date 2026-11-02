import { PermissionAction, RoleKey, type AppModule } from "@/lib/db/enums";

/** Clave `modulo:accion` (módulo en minúsculas), p. ej. `pos:anular_venta`. */
export type PermissionKey = `${Lowercase<AppModule>}:${PermissionAction}`;

export function permissionKey(module: AppModule, action: PermissionAction): PermissionKey {
  return `${module.toLowerCase() as Lowercase<AppModule>}:${action}`;
}

const CRUD: PermissionAction[] = [
  PermissionAction.ver,
  PermissionAction.crear,
  PermissionAction.editar,
  PermissionAction.eliminar,
];

/** Acciones válidas por módulo: es la fuente de verdad de la tabla `permissions`. */
export const MODULE_ACTIONS: Record<AppModule, PermissionAction[]> = {
  USERS: CRUD,
  CUSTOMERS: CRUD,
  CATALOG: CRUD,
  INVENTORY: [...CRUD, PermissionAction.permitir_stock_negativo],
  PURCHASING: [...CRUD, PermissionAction.ver_costos_compra],
  AI_AGENT: [PermissionAction.ver, PermissionAction.editar, PermissionAction.autorizar_pedidos_ia],
  WORKSHOP: CRUD,
  WARRANTIES: CRUD,
  POS: [...CRUD, PermissionAction.aplicar_descuentos, PermissionAction.anular_venta],
  CASH: [
    PermissionAction.ver,
    PermissionAction.crear,
    PermissionAction.editar,
    PermissionAction.cerrar_caja,
  ],
  BILLING: [PermissionAction.ver, PermissionAction.crear, PermissionAction.editar],
  REPORTS: [PermissionAction.ver],
  SETTINGS: [PermissionAction.ver, PermissionAction.editar],
  AUDIT: [PermissionAction.ver],
};

export const PERMISSION_CATALOG: ReadonlyArray<{
  module: AppModule;
  action: PermissionAction;
  key: PermissionKey;
}> = (Object.keys(MODULE_ACTIONS) as AppModule[]).flatMap((module) =>
  MODULE_ACTIONS[module].map((action) => ({ module, action, key: permissionKey(module, action) })),
);

export const ALL_PERMISSION_KEYS: ReadonlySet<PermissionKey> = new Set(
  PERMISSION_CATALOG.map((entry) => entry.key),
);

export function isPermissionKey(value: string): value is PermissionKey {
  return (ALL_PERMISSION_KEYS as ReadonlySet<string>).has(value);
}

export interface RoleTemplate {
  key: RoleKey;
  name: string;
  description: string;
  permissions: PermissionKey[];
  /** Descuento máximo (% de la línea) que el rol puede aplicar en el POS. */
  maxDiscountPercent: number;
}

const keys = (module: AppModule, actions: PermissionAction[]): PermissionKey[] =>
  actions.map((action) => permissionKey(module, action));
const { ver, crear, editar } = PermissionAction;

/** Roles base creados en cada tenant. Luego el dueño puede crear roles propios. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: RoleKey.admin,
    name: "Administrador",
    description: "Acceso total a la empresa",
    permissions: PERMISSION_CATALOG.map((entry) => entry.key),
    maxDiscountPercent: 100,
  },
  {
    key: RoleKey.warehouse_manager,
    name: "Jefe de Almacén",
    description: "Catálogo, inventario, compras y reposición",
    permissions: [
      ...keys("CATALOG", CRUD),
      ...keys("INVENTORY", CRUD),
      ...keys("PURCHASING", [...CRUD, PermissionAction.ver_costos_compra]),
      ...keys("AI_AGENT", [ver, PermissionAction.autorizar_pedidos_ia]),
      ...keys("WORKSHOP", [ver]),
      ...keys("WARRANTIES", [ver]),
      ...keys("REPORTS", [ver]),
    ],
    maxDiscountPercent: 0,
  },
  {
    key: RoleKey.cashier,
    name: "Cajero/Vendedor",
    description: "Ventas, caja y atención al cliente. Sin costos de compra ni configuración de IA",
    permissions: [
      ...keys("CUSTOMERS", [ver, crear, editar]),
      ...keys("CATALOG", [ver]),
      ...keys("INVENTORY", [ver]),
      ...keys("POS", [ver, crear, PermissionAction.aplicar_descuentos]),
      ...keys("CASH", [ver, crear, PermissionAction.cerrar_caja]),
      ...keys("BILLING", [ver, crear]),
      ...keys("WORKSHOP", [ver]),
      ...keys("WARRANTIES", [ver, crear]),
    ],
    maxDiscountPercent: 10,
  },
  {
    key: RoleKey.mechanic,
    name: "Mecánico",
    description: "Solo sus órdenes de trabajo asignadas y solicitud de repuestos",
    permissions: [
      ...keys("WORKSHOP", [ver, editar]),
      ...keys("CATALOG", [ver]),
      ...keys("INVENTORY", [ver]),
      ...keys("CUSTOMERS", [ver]),
      ...keys("WARRANTIES", [ver]),
    ],
    maxDiscountPercent: 0,
  },
];
