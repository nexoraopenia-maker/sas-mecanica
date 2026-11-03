import { createHash } from "node:crypto";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { checkLogo } from "@/lib/branding/logo";
import { withTenant, type TenantTx } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { assertStoragePathBelongsToTenant, buildStoragePath } from "@/lib/security/storage-path";
import { EXTENSION } from "@/lib/workshop/image";
import { BUCKETS, getStorage } from "@/server/integrations/storage";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

const LOGO_URL_TTL_SECONDS = 600;

/**
 * Sube el logo del taller. Se valida el tipo real, el peso y las dimensiones; el archivo vive en el
 * bucket privado bajo el prefijo del tenant y nunca se sirve con una URL pública permanente.
 */
export async function setTenantLogo(
  actor: AuthUser,
  bytes: Uint8Array,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "settings:editar");
  const tenantId = requireTenantId(actor);
  const checked = checkLogo(bytes);
  if (!checked.ok) throw new ConflictError("LOGO_INVALID", checked.error);
  const { type, width, height } = checked.info;
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const path = buildStoragePath(
    tenantId,
    "branding",
    `logo-${Date.now()}-${hash}.${EXTENSION[type]}`,
  );
  await getStorage().put(BUCKETS.receipts, path, bytes, type);
  await withTenant(tenantId, async (tx) => {
    const before = await tx.tenant.findFirstOrThrow({ select: { logoUrl: true } });
    await tx.tenant.update({ where: { id: tenantId }, data: { logoUrl: path } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "tenant.logo_changed",
      entityType: "tenant",
      entityId: tenantId,
      before: { hasLogo: before.logoUrl !== null },
      after: { hasLogo: true, type, width, height, bytes: bytes.length },
    });
  });
}

export async function removeTenantLogo(actor: AuthUser, meta: RequestMeta = {}): Promise<void> {
  requirePermission(actor, "settings:editar");
  const tenantId = requireTenantId(actor);
  await withTenant(tenantId, async (tx) => {
    const before = await tx.tenant.findFirstOrThrow({ select: { logoUrl: true } });
    if (before.logoUrl === null) return;
    await tx.tenant.update({ where: { id: tenantId }, data: { logoUrl: null } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "tenant.logo_removed",
      entityType: "tenant",
      entityId: tenantId,
      before: { hasLogo: true },
      after: { hasLogo: false },
    });
  });
}

/** URL temporal del logo del tenant de la transacción (o null). Comprueba que la ruta sea del tenant. */
export async function logoUrlOf(tx: TenantTx, tenantId: string): Promise<string | null> {
  const tenant = await tx.tenant.findFirstOrThrow({ select: { logoUrl: true } });
  if (!tenant.logoUrl) return null;
  assertStoragePathBelongsToTenant(tenant.logoUrl, tenantId);
  return getStorage().signedUrl(BUCKETS.receipts, tenant.logoUrl, LOGO_URL_TTL_SECONDS);
}

/** Logo para pantallas y comprobantes del usuario actual. */
export async function getTenantLogoUrl(actor: AuthUser): Promise<string | null> {
  const tenantId = requireTenantId(actor);
  return withTenant(tenantId, (tx) => logoUrlOf(tx, tenantId));
}
