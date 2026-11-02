/**
 * Crea (o restablece la contraseña de) una cuenta SuperAdmin. Las credenciales
 * se leen del ENTORNO, nunca se piden ni se guardan en el repositorio. El 2FA se
 * registra en el primer inicio de sesión (es obligatorio).
 *
 *   SUPERADMIN_EMAIL=owner@tu-saas.com SUPERADMIN_PASSWORD='...' npm run superadmin:create
 */
import { z } from "zod";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { createClient } from "@/lib/db/raw.ts";
import { emailSchema } from "@/lib/validation/auth";

try {
  process.loadEnvFile(".env");
} catch {
  // Sin .env: se usa el entorno del proceso.
}

const env = z
  .object({
    DIRECT_URL: z.url(),
    SUPERADMIN_EMAIL: emailSchema,
    SUPERADMIN_PASSWORD: passwordSchema,
    SUPERADMIN_NAME: z.string().min(2).default("SuperAdmin"),
  })
  .parse(process.env);

const client = createClient(env.DIRECT_URL);
try {
  const passwordHash = await hashPassword(env.SUPERADMIN_PASSWORD);
  const existing = await client.user.findFirst({
    where: { email: env.SUPERADMIN_EMAIL, deletedAt: null },
  });
  if (existing && !existing.isSuperAdmin)
    throw new Error("Ese correo pertenece a un usuario de tenant");
  const user = existing
    ? await client.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          status: "ACTIVE",
          sessionVersion: { increment: 1 },
          failedLoginCount: 0,
          lockedUntil: null,
        },
      })
    : await client.user.create({
        data: {
          tenantId: null,
          isSuperAdmin: true,
          email: env.SUPERADMIN_EMAIL,
          name: env.SUPERADMIN_NAME,
          passwordHash,
          status: "ACTIVE",
        },
      });
  await client.auditLog.create({
    data: {
      actorType: "SYSTEM",
      action: existing ? "superadmin.password_reset" : "superadmin.created",
      entityType: "user",
      entityId: user.id,
    },
  });
  console.log(`SuperAdmin ${existing ? "actualizado" : "creado"}: ${user.email}`);
} finally {
  await client.$disconnect();
}
