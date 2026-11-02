import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "@/lib/auth/totp";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  AccountLockedError,
  InvalidCredentialsError,
  InvalidTokenError,
  MfaError,
  RateLimitError,
  TenantInactiveError,
} from "@/lib/errors";
import { decryptSecret } from "@/lib/security/crypto";
import {
  acceptInvite,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  describeInvite,
  login,
  requestPasswordReset,
  resetPassword,
  verifyMfaLogin,
} from "@/server/services/auth";
import { configureAuthCache } from "@/server/services/session-resolver";
import { suspendTenant } from "@/server/services/tenants";
import { inviteUser } from "@/server/services/users";
import { adminClient } from "../helpers/db.ts";
import {
  PASSWORD,
  bootstrapTenant,
  captureEmails,
  createSuperAdmin,
  meta,
  tokenIn,
  uniqueEmail,
  type BootstrappedTenant,
} from "../helpers/auth.ts";

describe("autenticación", () => {
  let admin: PrismaClient;
  let t: BootstrappedTenant;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    t = await bootstrapTenant(admin, "pro");
  });
  afterAll(async () => {
    await admin.$disconnect();
  });
  beforeEach(() => {
    captureEmails();
  });

  describe("login", () => {
    it("acepta credenciales válidas, sin distinguir mayúsculas del correo", async () => {
      const outcome = await login(
        { email: t.adminEmail.toUpperCase(), password: PASSWORD },
        meta(),
      );
      expect(outcome).toMatchObject({
        userId: t.adminId,
        tenantId: t.tenantId,
        isSuperAdmin: false,
        mfa: "none",
      });
    });

    it("da el MISMO error para contraseña incorrecta y usuario inexistente", async () => {
      const wrong = await login(
        { email: t.adminEmail, password: "Incorrecta-123456" },
        meta(),
      ).catch((e: unknown) => e);
      const unknown = await login(
        { email: uniqueEmail("nadie"), password: PASSWORD },
        meta(),
      ).catch((e: unknown) => e);
      expect(wrong).toBeInstanceOf(InvalidCredentialsError);
      expect(unknown).toBeInstanceOf(InvalidCredentialsError);
      expect((wrong as Error).message).toBe((unknown as Error).message);
    });

    it("bloquea la cuenta tras 5 fallos, incluso con la contraseña correcta, y registra auditoría", async () => {
      const owner = await bootstrapTenant(admin, "basic", t.superAdmin);
      for (let i = 0; i < 5; i += 1) {
        await expect(
          login({ email: owner.adminEmail, password: "Incorrecta-123456" }, meta()),
        ).rejects.toBeInstanceOf(InvalidCredentialsError);
      }
      await expect(
        login({ email: owner.adminEmail, password: PASSWORD }, meta()),
      ).rejects.toBeInstanceOf(AccountLockedError);
      expect(
        await admin.auditLog.count({ where: { tenantId: owner.tenantId, action: "auth.locked" } }),
      ).toBe(1);
      expect(
        await admin.auditLog.count({
          where: { tenantId: owner.tenantId, action: "auth.login_failed" },
        }),
      ).toBe(4);

      await admin.user.update({
        where: { id: owner.adminId },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      expect((await login({ email: owner.adminEmail, password: PASSWORD }, meta())).userId).toBe(
        owner.adminId,
      );
      expect(
        (await admin.user.findUniqueOrThrow({ where: { id: owner.adminId } })).failedLoginCount,
      ).toBe(0);
    });

    it("aplica rate limit por correo", async () => {
      const email = uniqueEmail("flood");
      const results: unknown[] = [];
      for (let i = 0; i < 10; i += 1)
        results.push(
          await login({ email, password: "Incorrecta-123456" }, meta()).catch((e: unknown) => e),
        );
      expect(results.slice(0, 8).every((r) => r instanceof InvalidCredentialsError)).toBe(true);
      expect(results[8]).toBeInstanceOf(RateLimitError);
    });

    it("aplica rate limit por IP", async () => {
      const ip = `flood-${randomUUID()}`;
      const outcomes: unknown[] = [];
      for (let i = 0; i < 32; i += 1)
        outcomes.push(
          await login({ email: uniqueEmail("x"), password: "Incorrecta-123456" }, { ip }).catch(
            (e: unknown) => e,
          ),
        );
      expect(outcomes[29]).toBeInstanceOf(InvalidCredentialsError);
      expect(outcomes[30]).toBeInstanceOf(RateLimitError);
    });

    it("un usuario invitado (sin contraseña) no puede entrar", async () => {
      const emails = captureEmails();
      const email = uniqueEmail("pendiente");
      const role = await admin.role.findFirstOrThrow({
        where: { tenantId: t.tenantId, key: "cashier" },
      });
      await inviteUser(t.admin, { email, name: "Pendiente", roleId: role.id });
      expect(emails).toHaveLength(1);
      await expect(login({ email, password: PASSWORD }, meta())).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    it("rechaza el acceso a una empresa suspendida y vuelve a permitirlo al reactivar", async () => {
      const victim = await bootstrapTenant(admin, "basic", t.superAdmin);
      await suspendTenant(
        t.superAdmin,
        { tenantId: victim.tenantId, reason: "Falta de pago" },
        meta(),
      );
      await expect(
        login({ email: victim.adminEmail, password: PASSWORD }, meta()),
      ).rejects.toBeInstanceOf(TenantInactiveError);
    });

    it("valida el formato de la entrada con Zod", async () => {
      await expect(login({ email: "no-es-correo", password: "x" }, meta())).rejects.toThrow();
      await expect(login({ email: t.adminEmail, password: "" }, meta())).rejects.toThrow();
    });
  });

  describe("2FA obligatorio del SuperAdmin", () => {
    it("exige registro la primera vez y verificación después", async () => {
      const root = await createSuperAdmin(admin);
      const first = await login({ email: root.email, password: PASSWORD }, meta());
      expect(first).toMatchObject({ isSuperAdmin: true, tenantId: null, mfa: "enroll" });

      const { secret, uri } = await beginMfaEnrollment(root.id);
      expect(uri).toContain(secret);
      // El secreto se guarda CIFRADO y atado al usuario.
      const stored =
        (await admin.user.findUniqueOrThrow({ where: { id: root.id } })).totpSecretEncrypted ?? "";
      expect(stored).not.toContain(secret);
      expect(decryptSecret(stored, process.env.ENCRYPTION_KEY ?? "", `user:${root.id}:totp`)).toBe(
        secret,
      );

      await expect(confirmMfaEnrollment(root.id, "000000")).rejects.toBeInstanceOf(MfaError);
      await confirmMfaEnrollment(root.id, totpCode(secret), meta());
      expect(
        await admin.auditLog.count({ where: { actorUserId: root.id, action: "auth.mfa_enabled" } }),
      ).toBe(1);

      const second = await login({ email: root.email, password: PASSWORD }, meta());
      expect(second.mfa).toBe("verify");
      await expect(verifyMfaLogin(root.id, "123456")).rejects.toBeInstanceOf(MfaError);
      await expect(verifyMfaLogin(root.id, "abc")).rejects.toThrow();
      await expect(verifyMfaLogin(root.id, totpCode(secret))).resolves.toBeUndefined();
      await expect(beginMfaEnrollment(root.id)).rejects.toThrow(/ya está activado/);
    });

    it("con el 2FA apagado (solo desarrollo) el SuperAdmin entra con correo y contraseña, haya o no 2FA registrado", async () => {
      const root = await createSuperAdmin(admin);
      const off = { requireSuperAdmin2fa: false };
      const direct = await login({ email: root.email, password: PASSWORD }, meta(), off);
      expect(direct).toMatchObject({ isSuperAdmin: true, tenantId: null, mfa: "none" });
      // La contraseña sigue siendo obligatoria y el bloqueo por intentos fallidos sigue vigente.
      await expect(
        login({ email: root.email, password: "incorrecta-1234" }, meta(), off),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      // Una cuenta que ya tenía 2FA activo tampoco lo pide mientras el entorno lo tenga apagado...
      const { secret } = await beginMfaEnrollment(root.id);
      await confirmMfaEnrollment(root.id, totpCode(secret), meta());
      expect((await login({ email: root.email, password: PASSWORD }, meta(), off)).mfa).toBe(
        "none",
      );
      // ...y al volver a exigirlo (valor por defecto) lo pide de nuevo.
      expect((await login({ email: root.email, password: PASSWORD }, meta())).mfa).toBe("verify");
    });

    it("limita los intentos de código", async () => {
      const root = await createSuperAdmin(admin);
      const { secret } = await beginMfaEnrollment(root.id);
      await confirmMfaEnrollment(root.id, totpCode(secret), meta());
      const outcomes: unknown[] = [];
      for (let i = 0; i < 10; i += 1)
        outcomes.push(await verifyMfaLogin(root.id, "000000").catch((e: unknown) => e));
      // El alta del 2FA ya consumió 1 de los 8 intentos de la ventana.
      expect(outcomes[6]).toBeInstanceOf(MfaError);
      expect(outcomes[7]).toBeInstanceOf(RateLimitError);
    });

    it("un usuario de tenant no puede registrar 2FA de SuperAdmin", async () => {
      await expect(beginMfaEnrollment(t.adminId)).rejects.toBeInstanceOf(InvalidCredentialsError);
    });
  });

  describe("recuperación de contraseña", () => {
    it("flujo completo: correo, nuevo password, sesiones revocadas y token de un solo uso", async () => {
      const owner = await bootstrapTenant(admin, "basic", t.superAdmin);
      const emails = captureEmails();
      await requestPasswordReset({ email: owner.adminEmail }, meta());
      expect(emails).toHaveLength(1);
      expect(emails[0]?.to).toBe(owner.adminEmail);
      const token = tokenIn(emails[0]);

      const before = (await admin.user.findUniqueOrThrow({ where: { id: owner.adminId } }))
        .sessionVersion;
      await expect(resetPassword({ token, password: "debil" }, meta())).rejects.toThrow();
      await resetPassword({ token, password: "Nueva-Clave-2027" }, meta());

      const after = (await admin.user.findUniqueOrThrow({ where: { id: owner.adminId } }))
        .sessionVersion;
      expect(after).toBe(before + 1);
      await expect(
        login({ email: owner.adminEmail, password: PASSWORD }, meta()),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(
        login({ email: owner.adminEmail, password: "Nueva-Clave-2027" }, meta()),
      ).resolves.toMatchObject({ userId: owner.adminId });
      await expect(
        resetPassword({ token, password: "Otra-Clave-2028x" }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);
      expect(
        await admin.auditLog.count({
          where: { tenantId: owner.tenantId, action: "auth.password_reset" },
        }),
      ).toBe(1);
    });

    it("no revela si el correo existe", async () => {
      const emails = captureEmails();
      await expect(
        requestPasswordReset({ email: uniqueEmail("fantasma") }, meta()),
      ).resolves.toBeUndefined();
      expect(emails).toHaveLength(0);
    });

    it("un token nuevo invalida el anterior y los vencidos no sirven", async () => {
      const owner = await bootstrapTenant(admin, "basic", t.superAdmin);
      const emails = captureEmails();
      await requestPasswordReset({ email: owner.adminEmail }, meta());
      await requestPasswordReset({ email: owner.adminEmail }, meta());
      await expect(
        resetPassword({ token: tokenIn(emails[0]), password: "Nueva-Clave-2027" }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);

      await admin.authToken.updateMany({
        where: { userId: owner.adminId, usedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        resetPassword({ token: tokenIn(emails[1]), password: "Nueva-Clave-2027" }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it("el token jamás se guarda en claro", async () => {
      const owner = await bootstrapTenant(admin, "basic", t.superAdmin);
      const emails = captureEmails();
      await requestPasswordReset({ email: owner.adminEmail }, meta());
      const token = tokenIn(emails[0]);
      expect(await admin.authToken.count({ where: { tokenHash: token } })).toBe(0);
    });
  });

  describe("invitaciones", () => {
    it("muestra a quién pertenece, activa la cuenta y no se reutiliza", async () => {
      const emails = captureEmails();
      const email = uniqueEmail("nuevo");
      const role = await admin.role.findFirstOrThrow({
        where: { tenantId: t.tenantId, key: "mechanic" },
      });
      const { userId } = await inviteUser(
        t.admin,
        { email, name: "Nuevo Mecánico", roleId: role.id },
        meta(),
      );
      const token = tokenIn(emails[0]);

      expect(await describeInvite(token)).toMatchObject({ email, name: "Nuevo Mecánico" });
      await acceptInvite({ token, name: "Mecánico Juan", password: PASSWORD }, meta());
      expect(await admin.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({
        status: "ACTIVE",
        name: "Mecánico Juan",
      });
      await expect(
        acceptInvite({ token, name: "Otro", password: PASSWORD }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);
      expect(await describeInvite(token)).toBeNull();
      await expect(login({ email, password: PASSWORD }, meta())).resolves.toMatchObject({ userId });
    });

    it("rechaza tokens inventados o de otro tipo", async () => {
      await expect(
        acceptInvite({ token: "x".repeat(43), name: "Hacker", password: PASSWORD }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);
      const owner = await bootstrapTenant(admin, "basic", t.superAdmin);
      const emails = captureEmails();
      await requestPasswordReset({ email: owner.adminEmail }, meta());
      await expect(
        acceptInvite({ token: tokenIn(emails[0]), name: "Hacker", password: PASSWORD }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });
  });
});
