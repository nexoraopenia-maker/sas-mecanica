import { z } from "zod";
import { passwordSchema } from "@/lib/auth/password";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email("Correo inválido"));

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Ingresa tu contraseña").max(128),
});

export const mfaCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "El código tiene 6 dígitos"),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2, "Ingresa tu nombre").max(120),
  password: passwordSchema,
});

export const inviteUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(120),
  roleId: z.uuid(),
  /** Sucursal base del usuario. Con una sola sucursal activa se asigna sola. */
  branchId: z.uuid().optional(),
});
