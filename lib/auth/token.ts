import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { getEnv } from "@/lib/env";

/**
 * Contenido mínimo de la cookie de sesión. Los PERMISOS no viajan aquí: se
 * leen de la BD en cada petición (con caché corto) para que un cambio de rol
 * o una revocación surta efecto de inmediato.
 */
const claimsSchema = z.object({
  sub: z.uuid(),
  tid: z.uuid().nullable(),
  sv: z.number().int(),
  /** SuperAdmin: false hasta completar el 2FA. */
  mfa: z.boolean(),
  /** Id de ImpersonationSession cuando un SuperAdmin opera dentro de un tenant. */
  imp: z.uuid().optional(),
});

export type SessionClaims = z.infer<typeof claimsSchema>;

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const MFA_PENDING_TTL_SECONDS = 10 * 60;

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().SESSION_SECRET);
}

export async function signSession(
  claims: SessionClaims,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey());
}

/** Devuelve null ante firma inválida, expiración o forma inesperada (nunca lanza). */
export async function verifySession(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    const parsed = claimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
