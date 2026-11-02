import { describe, expect, it } from "vitest";
import {
  can,
  isOwnRecordsOnly,
  requirePermission,
  requireSuperAdmin,
  requireTenantId,
  type AuthUser,
} from "@/lib/auth/can";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  ROLE_TEMPLATES,
  isPermissionKey,
  type PermissionKey,
} from "@/lib/auth/permissions";
import { PermissionDeniedError } from "@/lib/errors";

const template = (key: string) => {
  const found = ROLE_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`rol ${key}`);
  return new Set<PermissionKey>(found.permissions);
};

function userWith(permissions: ReadonlySet<PermissionKey>, over: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: "u",
    tenantId: "t",
    email: "a@b.pe",
    name: "A",
    roleKey: null,
    roleName: null,
    isSuperAdmin: false,
    permissions,
    maxDiscountPercent: 0,
    subscription: null,
    mfaVerified: true,
    tenantName: "T",
    isDemo: false,
    demoExpiresAt: null,
    impersonation: null,
    ...over,
  };
}

describe("catálogo de permisos", () => {
  it("incluye las 10 acciones exigidas y claves únicas", () => {
    const actions = new Set(PERMISSION_CATALOG.map((p) => p.action));
    for (const action of [
      "ver",
      "crear",
      "editar",
      "eliminar",
      "aplicar_descuentos",
      "ver_costos_compra",
      "autorizar_pedidos_ia",
      "anular_venta",
      "cerrar_caja",
      "permitir_stock_negativo",
    ]) {
      expect(actions.has(action as never), action).toBe(true);
    }
    expect(ALL_PERMISSION_KEYS.size).toBe(PERMISSION_CATALOG.length);
    expect(isPermissionKey("pos:anular_venta")).toBe(true);
    expect(isPermissionKey("pos:volar")).toBe(false);
  });

  it("todo permiso de las plantillas existe en el catálogo", () => {
    for (const role of ROLE_TEMPLATES) {
      for (const key of role.permissions)
        expect(ALL_PERMISSION_KEYS.has(key), `${role.key}:${key}`).toBe(true);
    }
  });
});

describe("roles base", () => {
  it("Administrador tiene todo", () => {
    expect(template("admin").size).toBe(ALL_PERMISSION_KEYS.size);
  });

  it("Cajero/Vendedor: sin costos de compra ni configuración de IA", () => {
    const cashier = template("cashier");
    expect(cashier.has("purchasing:ver_costos_compra")).toBe(false);
    expect([...cashier].some((k) => k.startsWith("ai_agent:"))).toBe(false);
    expect([...cashier].some((k) => k.startsWith("settings:"))).toBe(false);
    expect(cashier.has("pos:crear")).toBe(true);
    expect(cashier.has("pos:anular_venta")).toBe(false);
    expect(cashier.has("cash:cerrar_caja")).toBe(true);
  });

  it("Mecánico: solo taller y consulta; sin ventas ni compras", () => {
    const mechanic = template("mechanic");
    expect(mechanic.has("workshop:ver")).toBe(true);
    expect(mechanic.has("workshop:editar")).toBe(true);
    expect(
      [...mechanic].some(
        (k) =>
          k.startsWith("pos:") ||
          k.startsWith("purchasing:") ||
          k.startsWith("cash:") ||
          k.startsWith("settings:"),
      ),
    ).toBe(false);
    expect(mechanic.has("inventory:permitir_stock_negativo")).toBe(false);
  });

  it("Jefe de Almacén ve costos y autoriza pedidos IA, pero no vende", () => {
    const manager = template("warehouse_manager");
    expect(manager.has("purchasing:ver_costos_compra")).toBe(true);
    expect(manager.has("ai_agent:autorizar_pedidos_ia")).toBe(true);
    expect(manager.has("pos:crear")).toBe(false);
  });

  it("solo el administrador puede dejar stock negativo y anular ventas", () => {
    for (const role of ROLE_TEMPLATES.filter((r) => r.key !== "admin")) {
      expect(role.permissions).not.toContain("inventory:permitir_stock_negativo");
      expect(role.permissions).not.toContain("pos:anular_venta");
    }
  });
});

describe("can / require*", () => {
  it("can y requirePermission", () => {
    const user = userWith(new Set<PermissionKey>(["pos:ver"]));
    expect(can(user, "pos:ver")).toBe(true);
    expect(can(user, "pos:crear")).toBe(false);
    expect(() => requirePermission(user, "pos:ver")).not.toThrow();
    expect(() => requirePermission(user, "pos:anular_venta")).toThrow(PermissionDeniedError);
  });

  it("requireSuperAdmin exige 2FA y no admite impersonación", () => {
    const empty = new Set<PermissionKey>();
    expect(() =>
      requireSuperAdmin(userWith(empty, { isSuperAdmin: true, mfaVerified: true, tenantId: null })),
    ).not.toThrow();
    expect(() =>
      requireSuperAdmin(
        userWith(empty, { isSuperAdmin: true, mfaVerified: false, tenantId: null }),
      ),
    ).toThrow(PermissionDeniedError);
    expect(() => requireSuperAdmin(userWith(empty, { isSuperAdmin: false }))).toThrow(
      PermissionDeniedError,
    );
    expect(() =>
      requireSuperAdmin(
        userWith(empty, {
          isSuperAdmin: true,
          impersonation: { sessionId: "s", reason: "soporte" },
        }),
      ),
    ).toThrow(PermissionDeniedError);
  });

  it("requireTenantId y mecánico de solo sus registros", () => {
    expect(requireTenantId(userWith(new Set()))).toBe("t");
    expect(() => requireTenantId(userWith(new Set(), { tenantId: null }))).toThrow(
      PermissionDeniedError,
    );
    expect(isOwnRecordsOnly(userWith(new Set(), { roleKey: "mechanic" }))).toBe(true);
    expect(isOwnRecordsOnly(userWith(new Set(), { roleKey: "cashier" }))).toBe(false);
  });
});
