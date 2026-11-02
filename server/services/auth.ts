import { generateToken, hashToken } from "@/lib/auth/secure-token";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/auth/totp";
import {
  consumeRateLimit,
  findAuthTokenByHash,
  findUserByEmail,
  withAdmin,
  withPlatform,
  withTenant,
  type LoginUserRow,
} from "@/lib/db";
import { getEnv } from "@/lib/env";
import {
  ConflictError,
  AccountLockedError,
  InvalidCredentialsError,
  InvalidTokenError,
  MfaError,
  RateLimitError,
  TenantInactiveError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import {
  acceptInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaCodeSchema,
  resetPasswordSchema,
} from "@/lib/validation/auth";
import { getEmailSender } from "@/server/integrations/email";
import { passwordResetEmail } from "@/server/integrations/email-templates";
import { recordAudit, type RequestMeta } from "./audit";
import { invalidateAuthCache } from "./session-resolver";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MS = 60 * 60 * 1000;

export type MfaStage = "none" | "enroll" | "verify";

export interface LoginOutcome {
  userId: string;
  tenantId: string | null;
  sessionVersion: number;
  isSuperAdmin: boolean;
  /** SuperAdmin: el 2FA es obligatorio; hasta completarlo la sesión es de etapa "pendiente". */
  mfa: MfaStage;
}

async function enforceRateLimit(
  scope: string,
  id: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await consumeRateLimit(scope, id, limit, windowSeconds);
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
}

/** Aplica un cambio al usuario con el cliente que corresponde (tenant con RLS, o SuperAdmin con cliente auditado). */
async function updateLoginState(
  row: LoginUserRow,
  data: { failedLoginCount?: number; lockedUntil?: Date | null; lastLoginAt?: Date },
  audit: { action: string; meta: RequestMeta },
) {
  if (row.tenantId) {
    await withTenant(row.tenantId, async (tx) => {
      await tx.user.update({ where: { id: row.id }, data });
      await recordAudit(
        tx,
        { actorType: "USER", actorUserId: row.id, ...audit.meta },
        { action: audit.action, entityType: "user", entityId: row.id },
      );
    });
    return;
  }
  await withAdmin(
    { userId: null, reason: `Autenticación de SuperAdmin: ${audit.action}`, ip: audit.meta.ip },
    async (db) => {
      await db.user.update({ where: { id: row.id }, data });
      await db.auditLog.create({
        data: {
          actorType: "SUPERADMIN",
          actorUserId: row.id,
          action: audit.action,
          entityType: "user",
          entityId: row.id,
          ip: audit.meta.ip ?? null,
          userAgent: audit.meta.userAgent ?? null,
        },
      });
    },
  );
}

async function assertTenantActive(tenantId: string): Promise<void> {
  const tenant = await withTenant(tenantId, (tx) =>
    tx.tenant.findFirst({ select: { status: true, isDemo: true, demoExpiresAt: true } }),
  );
  if (!tenant) throw new TenantInactiveError("CANCELLED");
  if (tenant.status === "SUSPENDED") throw new TenantInactiveError("SUSPENDED");
  if (tenant.status !== "ACTIVE") throw new TenantInactiveError("CANCELLED");
  if (tenant.isDemo && tenant.demoExpiresAt && tenant.demoExpiresAt <= new Date())
    throw new TenantInactiveError("EXPIRED");
}

/**
 * Valida credenciales. Mensajes y tiempos iguales para "no existe" y
 * "contraseña incorrecta"; bloqueo temporal tras 5 fallos; rate limit por IP y por correo.
 */
export async function login(
  input: { email: string; password: string },
  meta: RequestMeta,
  options: { requireSuperAdmin2fa?: boolean } = {},
): Promise<LoginOutcome> {
  const { email, password } = loginSchema.parse(input);
  await enforceRateLimit("login:ip", meta.ip ?? "unknown", 30, 600);
  await enforceRateLimit("login:email", email, 8, 900);

  const row = await findUserByEmail(email);
  if (!row || !row.passwordHash || row.status === "DISABLED" || row.status === "INVITED") {
    await verifyAgainstDummy(password);
    throw new InvalidCredentialsError();
  }
  if (row.lockedUntil && row.lockedUntil > new Date()) {
    await verifyAgainstDummy(password);
    throw new AccountLockedError(row.lockedUntil);
  }

  if (!(await verifyPassword(password, row.passwordHash))) {
    const failures = row.failedLoginCount + 1;
    const lock = failures >= MAX_FAILED_LOGINS;
    await updateLoginState(
      row,
      {
        failedLoginCount: lock ? 0 : failures,
        lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
      { action: lock ? "auth.locked" : "auth.login_failed", meta },
    );
    throw new InvalidCredentialsError();
  }

  if (row.tenantId) await assertTenantActive(row.tenantId);
  await updateLoginState(
    row,
    { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    { action: "auth.login", meta },
  );

  let mfa: MfaStage = "none";
  // El 2FA del SuperAdmin es obligatorio salvo que el entorno lo apague (solo desarrollo; ver lib/env.ts).
  const requireMfa = options.requireSuperAdmin2fa ?? getEnv().SUPERADMIN_REQUIRE_2FA === "true";
  if (row.isSuperAdmin && requireMfa) {
    const status = await withPlatform((db) =>
      db.user.findUniqueOrThrow({ where: { id: row.id }, select: { totpEnabledAt: true } }),
    );
    mfa = status.totpEnabledAt ? "verify" : "enroll";
  }
  return {
    userId: row.id,
    tenantId: row.tenantId,
    sessionVersion: row.sessionVersion,
    isSuperAdmin: row.isSuperAdmin,
    mfa,
  };
}

// ---------------------------------------------------------------------------
// 2FA (obligatorio para SuperAdmin)
// ---------------------------------------------------------------------------

const totpContext = (userId: string) => `user:${userId}:totp`;

/** Estado del 2FA de un SuperAdmin: debe registrarlo o verificarlo. */
export async function getMfaStage(userId: string): Promise<"enroll" | "verify"> {
  const user = await withPlatform((db) =>
    db.user.findFirst({
      where: { id: userId, isSuperAdmin: true, deletedAt: null },
      select: { totpEnabledAt: true },
    }),
  );
  if (!user) throw new InvalidCredentialsError();
  return user.totpEnabledAt ? "verify" : "enroll";
}

/**
 * Devuelve el secreto TOTP pendiente de confirmar (lo crea la primera vez).
 * Es idempotente: recargar la página no cambia el secreto ya escaneado.
 */
export async function beginMfaEnrollment(userId: string): Promise<{ secret: string; uri: string }> {
  const user = await withPlatform((db) =>
    db.user.findFirst({ where: { id: userId, isSuperAdmin: true, deletedAt: null } }),
  );
  if (!user) throw new InvalidCredentialsError();
  if (user.totpEnabledAt) throw new ConflictError("MFA_ALREADY_ENABLED", "El 2FA ya está activado");

  if (user.totpSecretEncrypted) {
    const existing = decryptSecret(
      user.totpSecretEncrypted,
      getEnv().ENCRYPTION_KEY,
      totpContext(userId),
    );
    return { secret: existing, uri: otpauthUri("Mecania", user.email, existing) };
  }
  const secret = generateTotpSecret();
  const encrypted = encryptSecret(secret, getEnv().ENCRYPTION_KEY, totpContext(userId));
  await withAdmin({ userId, reason: "Registro de 2FA del SuperAdmin" }, (db) =>
    db.user.update({ where: { id: userId }, data: { totpSecretEncrypted: encrypted } }),
  );
  return { secret, uri: otpauthUri("Mecania", user.email, secret) };
}

async function checkTotp(userId: string, code: string): Promise<{ ok: boolean; enabled: boolean }> {
  const user = await withPlatform((db) =>
    db.user.findFirst({ where: { id: userId, isSuperAdmin: true, deletedAt: null } }),
  );
  if (!user?.totpSecretEncrypted) return { ok: false, enabled: false };
  const secret = decryptSecret(
    user.totpSecretEncrypted,
    getEnv().ENCRYPTION_KEY,
    totpContext(userId),
  );
  return { ok: verifyTotp(secret, code), enabled: Boolean(user.totpEnabledAt) };
}

/** Confirma el alta del 2FA con un código válido. */
export async function confirmMfaEnrollment(
  userId: string,
  rawCode: string,
  meta: RequestMeta = {},
): Promise<void> {
  const { code } = mfaCodeSchema.parse({ code: rawCode });
  await enforceRateLimit("mfa", userId, 8, 300);
  const check = await checkTotp(userId, code);
  if (!check.ok || check.enabled) throw new MfaError();
  await withAdmin(
    { userId, reason: "Activación de 2FA del SuperAdmin", ip: meta.ip },
    async (db) => {
      await db.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } });
      await db.auditLog.create({
        data: {
          actorType: "SUPERADMIN",
          actorUserId: userId,
          action: "auth.mfa_enabled",
          entityType: "user",
          entityId: userId,
          ip: meta.ip ?? null,
        },
      });
    },
  );
}

/** Verifica el código del segundo factor durante el login. */
export async function verifyMfaLogin(userId: string, rawCode: string): Promise<void> {
  const { code } = mfaCodeSchema.parse({ code: rawCode });
  await enforceRateLimit("mfa", userId, 8, 300);
  const check = await checkTotp(userId, code);
  if (!check.ok || !check.enabled) throw new MfaError();
}

// ---------------------------------------------------------------------------
// Recuperación de contraseña e invitaciones
// ---------------------------------------------------------------------------

/** Siempre responde igual (no revela si el correo existe). */
export async function requestPasswordReset(
  input: { email: string },
  meta: RequestMeta,
): Promise<void> {
  const { email } = forgotPasswordSchema.parse(input);
  await enforceRateLimit("reset:ip", meta.ip ?? "unknown", 10, 3600);
  const limited = await consumeRateLimit("reset:email", email, 3, 3600);
  if (!limited.allowed) return;

  const row = await findUserByEmail(email);
  if (!row || !row.tenantId || row.status !== "ACTIVE") return;

  const { token, hash } = generateToken();
  const user = await withTenant(row.tenantId, async (tx) => {
    const found = await tx.user.findFirst({
      where: { id: row.id },
      select: { email: true, name: true },
    });
    if (!found) return null;
    await tx.authToken.updateMany({
      where: { userId: row.id, type: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.authToken.create({
      data: {
        userId: row.id,
        type: "PASSWORD_RESET",
        tokenHash: hash,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    await recordAudit(
      tx,
      { actorType: "USER", actorUserId: row.id, ...meta },
      { action: "auth.password_reset_requested", entityType: "user", entityId: row.id },
    );
    return found;
  });
  if (!user) return;
  try {
    await getEmailSender().send(passwordResetEmail({ to: user.email, name: user.name, token }));
  } catch (error) {
    logger.error(
      { err: error, tenantId: row.tenantId },
      "no se pudo enviar el correo de recuperación",
    );
  }
}

async function loadUsableToken(rawToken: string, type: "INVITE" | "PASSWORD_RESET") {
  const row = await findAuthTokenByHash(hashToken(rawToken));
  if (!row || row.type !== type || row.usedAt || row.expiresAt <= new Date() || !row.tenantId)
    throw new InvalidTokenError();
  return { ...row, tenantId: row.tenantId };
}

/** Cambia la contraseña con el enlace del correo. Revoca todas las sesiones (sessionVersion + 1). */
export async function resetPassword(
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<void> {
  const { token, password } = resetPasswordSchema.parse(input);
  const row = await loadUsableToken(token, "PASSWORD_RESET");
  const passwordHash = await hashPassword(password);
  await withTenant(row.tenantId, async (tx) => {
    const consumed = await tx.authToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw new InvalidTokenError();
    await tx.user.update({
      where: { id: row.userId },
      data: {
        passwordHash,
        sessionVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await recordAudit(
      tx,
      { actorType: "USER", actorUserId: row.userId, ...meta },
      { action: "auth.password_reset", entityType: "user", entityId: row.userId },
    );
  });
  invalidateAuthCache();
}

/** Acepta una invitación: fija nombre y contraseña y activa la cuenta. */
export async function acceptInvite(
  input: { token: string; name: string; password: string },
  meta: RequestMeta,
): Promise<void> {
  const { token, name, password } = acceptInviteSchema.parse(input);
  const row = await loadUsableToken(token, "INVITE");
  const passwordHash = await hashPassword(password);
  await withTenant(row.tenantId, async (tx) => {
    const consumed = await tx.authToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw new InvalidTokenError();
    await tx.user.update({
      where: { id: row.userId },
      data: { name, passwordHash, status: "ACTIVE" },
    });
    await recordAudit(
      tx,
      { actorType: "USER", actorUserId: row.userId, ...meta },
      { action: "user.invite_accepted", entityType: "user", entityId: row.userId },
    );
  });
  invalidateAuthCache();
}

/** Para mostrar a quién pertenece una invitación antes de pedir la contraseña. */
export async function describeInvite(
  rawToken: string,
): Promise<{ email: string; name: string; company: string } | null> {
  try {
    const row = await loadUsableToken(rawToken, "INVITE");
    return await withTenant(row.tenantId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: row.userId },
        select: { email: true, name: true },
      });
      const tenant = await tx.tenant.findFirst({ select: { legalName: true, tradeName: true } });
      return user && tenant
        ? { email: user.email, name: user.name, company: tenant.tradeName ?? tenant.legalName }
        : null;
    });
  } catch {
    return null;
  }
}
