import { randomUUID } from "node:crypto";
import type { AuthUser } from "@/lib/auth/can";
import { hashPassword } from "@/lib/auth/password";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { setEmailSenderForTests, type EmailMessage } from "@/server/integrations/email";
import { acceptInvite } from "@/server/services/auth";
import { resolveSession } from "@/server/services/session-resolver";
import { createTenant } from "@/server/services/tenants";

export const PASSWORD = "Taller-Segura-2026";

/** Captura los correos que enviaría la plataforma. */
export function captureEmails(): EmailMessage[] {
  const sent: EmailMessage[] = [];
  setEmailSenderForTests({
    async send(message) {
      sent.push(message);
    },
  });
  return sent;
}

export function tokenIn(message: EmailMessage | undefined): string {
  const match = /token=([\w-]+)/.exec(message?.text ?? "");
  if (!match?.[1]) throw new Error("El correo no trae token");
  return match[1];
}

export const meta = () => ({ ip: `test-${randomUUID()}` });
export const uniqueEmail = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}@prueba.pe`;

export async function createSuperAdmin(
  admin: PrismaClient,
  options: { totpSecretEncrypted?: string; totpEnabled?: boolean } = {},
) {
  const email = uniqueEmail("root");
  const user = await admin.user.create({
    data: {
      tenantId: null,
      isSuperAdmin: true,
      email,
      name: "Root",
      status: "ACTIVE",
      passwordHash: await hashPassword(PASSWORD),
      ...(options.totpSecretEncrypted ? { totpSecretEncrypted: options.totpSecretEncrypted } : {}),
      ...(options.totpEnabled ? { totpEnabledAt: new Date() } : {}),
    },
  });
  return { id: user.id, email };
}

export async function superAdminUser(admin: PrismaClient): Promise<AuthUser> {
  const root = await createSuperAdmin(admin);
  const user = await resolveSession({ sub: root.id, tid: null, sv: 1, mfa: true });
  if (!user) throw new Error("No se pudo resolver el SuperAdmin");
  return user;
}

export interface BootstrappedTenant {
  tenantId: string;
  adminId: string;
  adminEmail: string;
  admin: AuthUser;
  superAdmin: AuthUser;
}

/** Alta real de un tenant por el SuperAdmin + aceptación de la invitación del administrador. */
export async function bootstrapTenant(
  admin: PrismaClient,
  planCode: "basic" | "pro" | "enterprise",
  superAdmin?: AuthUser,
): Promise<BootstrappedTenant> {
  const sa = superAdmin ?? (await superAdminUser(admin));
  const emails = captureEmails();
  const adminEmail = uniqueEmail("dueno");
  const { tenantId } = await createTenant(
    sa,
    {
      legalName: `Taller ${randomUUID().slice(0, 6)} SAC`,
      taxId: `20${Math.floor(Math.random() * 1e9)}`,
      planCode,
      adminName: "Dueño Taller",
      adminEmail,
    },
    meta(),
  );
  await acceptInvite(
    { token: tokenIn(emails.at(-1)), name: "Dueño Taller", password: PASSWORD },
    meta(),
  );
  const row = await admin.user.findFirstOrThrow({ where: { email: adminEmail } });
  const user = await resolveSession({
    sub: row.id,
    tid: tenantId,
    sv: row.sessionVersion,
    mfa: true,
  });
  if (!user) throw new Error("No se pudo resolver el administrador del tenant");
  return { tenantId, adminId: row.id, adminEmail, admin: user, superAdmin: sa };
}

/** Invita y activa a un usuario del tenant con el rol indicado; devuelve su AuthUser. */
export async function addUser(
  inviteUser: (input: {
    email: string;
    name: string;
    roleId: string;
  }) => Promise<{ userId: string }>,
  adminDb: PrismaClient,
  tenantId: string,
  roleId: string,
  name = "Usuario",
): Promise<AuthUser> {
  const emails = captureEmails();
  const email = uniqueEmail("user");
  const { userId } = await inviteUser({ email, name, roleId });
  await acceptInvite({ token: tokenIn(emails.at(-1)), name, password: PASSWORD }, meta());
  const row = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  const user = await resolveSession({
    sub: userId,
    tid: tenantId,
    sv: row.sessionVersion,
    mfa: true,
  });
  if (!user) throw new Error("No se pudo resolver el usuario");
  return user;
}
