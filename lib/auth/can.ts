import { PermissionDeniedError } from "@/lib/errors";
import type { RoleKey } from "@/lib/db/enums";
import type { PermissionKey } from "./permissions";

export interface AuthUser {
  userId: string;
  /** null solo para el SuperAdmin fuera de un tenant. */
  tenantId: string | null;
  email: string;
  name: string;
  roleKey: RoleKey | null;
  roleName: string | null;
  isSuperAdmin: boolean;
  /** Permisos efectivos, leídos de la BD (no del token). */
  permissions: ReadonlySet<PermissionKey>;
  /** Descuento máximo (% de una línea) que su rol puede aplicar en el POS. */
  maxDiscountPercent: number;
  /** Estado de cobro de la suscripción: el banner avisa en gracia o pago atrasado. null = sin suscripción visible. */
  subscription: {
    status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "GRACE" | "SUSPENDED" | "CANCELED";
    graceEndsAt: Date | null;
  } | null;
  mfaVerified: boolean;
  tenantName: string | null;
  isDemo: boolean;
  demoExpiresAt: Date | null;
  /** Rubro del negocio (decide qué bloques del inicio se muestran). */
  businessType: "AUTOPARTS" | "WORKSHOP" | "MIXED";
  /** Tiene RUC cargado (o es demo): puede emitir boletas y facturas electrónicas. */
  fiscalReady: boolean;
  /** Entró con una contraseña temporal: debe cambiarla antes de usar el sistema. */
  mustChangePassword: boolean;
  /** Presente cuando un SuperAdmin opera dentro de un tenant (soporte). */
  impersonation: { sessionId: string; reason: string } | null;
}

/** Autorización por permiso. El SuperAdmin fuera de un tenant no tiene permisos de negocio. */
export function can(user: AuthUser, permission: PermissionKey): boolean {
  return user.permissions.has(permission);
}

export function requirePermission(user: AuthUser, permission: PermissionKey): void {
  if (!can(user, permission)) throw new PermissionDeniedError(permission);
}

export function requireSuperAdmin(user: AuthUser): void {
  if (!user.isSuperAdmin || !user.mfaVerified || user.impersonation)
    throw new PermissionDeniedError("superadmin");
}

/** Id del tenant sobre el que opera el usuario; error si no hay (SuperAdmin sin impersonar). */
export function requireTenantId(user: AuthUser): string {
  if (!user.tenantId) throw new PermissionDeniedError("tenant");
  return user.tenantId;
}

/** Mecánico: en el módulo de taller solo ve las OT asignadas a él (se aplica en las consultas de la Fase 5). */
export function isOwnRecordsOnly(user: AuthUser): boolean {
  return user.roleKey === "mechanic" && !user.impersonation;
}
