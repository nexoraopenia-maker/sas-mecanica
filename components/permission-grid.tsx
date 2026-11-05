import { MODULE_ACTIONS, permissionKey, type PermissionKey } from "@/lib/auth/permissions";
import type { AppModule } from "@/lib/db/enums";

const MODULE_LABELS: Record<AppModule, string> = {
  USERS: "Usuarios y roles",
  CUSTOMERS: "Clientes",
  CATALOG: "Catálogo",
  INVENTORY: "Inventario",
  PURCHASING: "Compras",
  AI_AGENT: "Agente IA",
  WORKSHOP: "Taller",
  WARRANTIES: "Garantías",
  POS: "Ventas (POS)",
  CASH: "Caja",
  BILLING: "Facturación",
  REPORTS: "Reportes",
  SETTINGS: "Configuración",
  AUDIT: "Auditoría",
  WHATSAPP: "WhatsApp",
  ACCOUNTING: "Contabilidad (PLE)",
  BRANCHES: "Sucursales",
};

const ACTION_LABELS: Record<string, string> = {
  ver: "Ver",
  crear: "Crear",
  editar: "Editar",
  eliminar: "Eliminar",
  aplicar_descuentos: "Aplicar descuentos",
  ver_costos_compra: "Ver costos de compra",
  autorizar_pedidos_ia: "Autorizar pedidos IA",
  anular_venta: "Anular venta",
  cerrar_caja: "Cerrar caja",
  permitir_stock_negativo: "Permitir stock negativo",
};

export function PermissionGrid({
  selected = [],
  disabled = false,
}: {
  selected?: readonly PermissionKey[];
  disabled?: boolean;
}) {
  const chosen = new Set(selected);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(Object.keys(MODULE_ACTIONS) as AppModule[]).map((module) => (
        <fieldset key={module} className="rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{MODULE_LABELS[module]}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {MODULE_ACTIONS[module].map((action) => {
              const key = permissionKey(module, action);
              return (
                <label key={key} className="flex min-h-10 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="permissions"
                    value={key}
                    defaultChecked={chosen.has(key)}
                    disabled={disabled}
                    className="size-5"
                  />
                  {ACTION_LABELS[action] ?? action}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
