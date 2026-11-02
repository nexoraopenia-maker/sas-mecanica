import type { AuthUser } from "@/lib/auth/can";
import { ROLE_TEMPLATES, permissionKey, type PermissionKey } from "@/lib/auth/permissions";
import type { SessionClaims } from "@/lib/auth/token";
import { withPlatform, withTenant, type AppModule } from "@/lib/db";
import { effectiveModules } from "./limits";

let cacheTtlMs = 15_000;
const authCache = new Map<string, { expires: number; user: AuthUser | null }>();

/** Para pruebas: con 0 no hay caché. */
export function configureAuthCache(ttlMs: number): void {
  cacheTtlMs = ttlMs;
  authCache.clear();
}

export function invalidateAuthCache(): void {
  authCache.clear();
}

function filterByModules(keys: PermissionKey[], modules: AppModule[]): ReadonlySet<PermissionKey> {
  const allowed = new Set(modules.map((module) => module.toLowerCase()));
  return new Set(keys.filter((key) => allowed.has(key.split(":")[0] ?? "")));
}

async function loadTenantUser(claims: SessionClaims & { tid: string }): Promise<AuthUser | null> {
  return withTenant(claims.tid, async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: claims.sub },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    if (!user || user.status !== "ACTIVE" || user.sessionVersion !== claims.sv) return null;

    const tenant = await tx.tenant.findFirst({ include: { plan: true, settings: true } });
    const subscription = await tx.subscription.findFirst({
      orderBy: { createdAt: "desc" },
      select: { status: true, graceEndsAt: true },
    });
    if (!tenant || tenant.status !== "ACTIVE") return null;
    if (tenant.isDemo && tenant.demoExpiresAt && tenant.demoExpiresAt <= new Date()) return null;

    const role = user.role && !user.role.deletedAt ? user.role : null;
    const keys = role
      ? role.permissions.map((rp) => permissionKey(rp.permission.module, rp.permission.action))
      : [];
    return {
      userId: user.id,
      tenantId: tenant.id,
      email: user.email,
      name: user.name,
      roleKey: role?.key ?? null,
      roleName: role?.name ?? null,
      isSuperAdmin: false,
      maxDiscountPercent: role ? Number(role.maxDiscountPercent) : 0,
      subscription,
      permissions: filterByModules(
        keys,
        effectiveModules(tenant.plan, tenant.settings?.enabledModules ?? []),
      ),
      mfaVerified: true,
      tenantName: tenant.tradeName ?? tenant.legalName,
      isDemo: tenant.isDemo,
      demoExpiresAt: tenant.demoExpiresAt,
      impersonation: null,
    };
  });
}

async function loadSuperAdmin(claims: SessionClaims): Promise<AuthUser | null> {
  return withPlatform(async (db) => {
    const user = await db.user.findFirst({
      where: { id: claims.sub, isSuperAdmin: true, deletedAt: null, status: "ACTIVE" },
    });
    if (!user || user.sessionVersion !== claims.sv) return null;
    // Sin 2FA completado no hay acceso a nada de la plataforma (ni a impersonar).
    const base: AuthUser = {
      userId: user.id,
      tenantId: null,
      email: user.email,
      name: user.name,
      roleKey: null,
      roleName: "SuperAdmin",
      isSuperAdmin: true,
      permissions: new Set<PermissionKey>(),
      maxDiscountPercent: 0,
      subscription: null,
      mfaVerified: claims.mfa,
      tenantName: null,
      isDemo: false,
      demoExpiresAt: null,
      impersonation: null,
    };
    if (!claims.imp) return base;
    if (!claims.mfa || !claims.tid) return null;

    const session = await db.impersonationSession.findFirst({
      where: { id: claims.imp, superAdminUserId: user.id, tenantId: claims.tid, endedAt: null },
    });
    const tenant = await db.tenant.findFirst({
      where: { id: claims.tid, deletedAt: null },
      include: { plan: true, settings: true },
    });
    if (!session || !tenant) return null;

    const admin = ROLE_TEMPLATES.find((template) => template.key === "admin");
    return {
      ...base,
      tenantId: tenant.id,
      roleKey: "admin",
      roleName: "Administrador (soporte)",
      maxDiscountPercent: 100,
      permissions: filterByModules(
        admin?.permissions ?? [],
        effectiveModules(tenant.plan, tenant.settings?.enabledModules ?? []),
      ),
      tenantName: tenant.tradeName ?? tenant.legalName,
      isDemo: tenant.isDemo,
      demoExpiresAt: tenant.demoExpiresAt,
      impersonation: { sessionId: session.id, reason: session.reason },
    };
  });
}

/**
 * Construye el AuthUser a partir de las claims LEYENDO la BD: estado del
 * usuario, sessionVersion, estado del tenant, rol y permisos vigentes.
 */
export async function resolveSession(claims: SessionClaims): Promise<AuthUser | null> {
  const key = `${claims.sub}|${claims.tid}|${claims.sv}|${claims.mfa}|${claims.imp ?? ""}`;
  const hit = authCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.user;

  const user =
    claims.imp || claims.tid === null
      ? await loadSuperAdmin(claims)
      : await loadTenantUser({ ...claims, tid: claims.tid });
  // Un SuperAdmin sin tenant no pasa por el camino de usuario de tenant.
  if (cacheTtlMs > 0) authCache.set(key, { expires: Date.now() + cacheTtlMs, user });
  return user;
}
