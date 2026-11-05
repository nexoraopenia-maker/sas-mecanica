import { redirect } from "next/navigation";
import type { AuthUser } from "@/lib/auth/can";
import { getCurrentUser } from "@/server/services/session";

/** Guardas de página/acción: la autorización real, contra la BD (el proxy solo es la primera barrera). */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireTenantUser(): Promise<AuthUser> {
  const user = await requireUser();
  if (!user.tenantId) redirect(user.isSuperAdmin ? "/admin" : "/login");
  // Con contraseña temporal no se usa nada del sistema (páginas ni acciones) hasta cambiarla.
  if (user.mustChangePassword) redirect("/cambiar-clave");
  return user;
}

export async function requirePlatformUser(): Promise<AuthUser> {
  const user = await requireUser();
  if (!user.isSuperAdmin) redirect("/app");
  if (!user.mfaVerified) redirect("/login/mfa");
  if (user.impersonation) redirect("/app");
  return user;
}
