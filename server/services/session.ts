import { cache } from "react";
import { cookies } from "next/headers";
import type { AuthUser } from "@/lib/auth/can";
import {
  signSession,
  verifySession,
  MFA_PENDING_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  type SessionClaims,
} from "@/lib/auth/token";
import { getEnv } from "@/lib/env";
import { resolveSession } from "./session-resolver";

export const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-sas_session" : "sas_session";

/** Usuario autenticado de la petición actual (o null). Una sola resolución por petición. */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value);
  return claims ? resolveSession(claims) : null;
});

export async function startSession(claims: SessionClaims): Promise<void> {
  const ttl = claims.mfa ? SESSION_TTL_SECONDS : MFA_PENDING_TTL_SECONDS;
  const store = await cookies();
  store.set(SESSION_COOKIE, await signSession(claims, ttl), {
    httpOnly: true,
    secure: getEnv().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ttl,
  });
}

export async function endSession(): Promise<void> {
  // Con el prefijo __Host- el navegador ignora un Set-Cookie de borrado sin `Secure`:
  // se emite con los mismos atributos y maxAge 0.
  (await cookies()).set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: getEnv().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function readSessionClaims(): Promise<SessionClaims | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}
