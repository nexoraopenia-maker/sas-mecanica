"use server";

import { redirect } from "next/navigation";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { verifyCaptcha } from "@/server/integrations/turnstile";
import {
  acceptInvite,
  confirmMfaEnrollment,
  getMfaStage,
  login,
  requestPasswordReset,
  resetPassword,
  verifyMfaLogin,
} from "@/server/services/auth";
import { provisionDemo, restoreDemo } from "@/server/services/demo";
import { endSession, readSessionClaims, startSession } from "@/server/services/session";

/** Solo rutas internas: evita redirecciones abiertas (`//evil.com`, `https://...`). */
function safeNext(value: string): string | null {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : null;
}

export async function loginAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const outcome = await login(
      { email: field(formData, "email"), password: field(formData, "password") },
      await getRequestMeta(),
    );
    if (outcome.mfa !== "none") {
      // Sesión "pendiente": solo sirve para completar el 2FA (10 min).
      await startSession({
        sub: outcome.userId,
        tid: null,
        sv: outcome.sessionVersion,
        mfa: false,
      });
      return { redirectTo: "/login/mfa" };
    }
    await startSession({
      sub: outcome.userId,
      tid: outcome.tenantId,
      sv: outcome.sessionVersion,
      mfa: true,
    });
    // Sin 2FA el SuperAdmin entra directo a su panel (no tiene empresa a la que ir).
    return {
      redirectTo: safeNext(field(formData, "next")) ?? (outcome.isSuperAdmin ? "/admin" : "/app"),
    };
  });
}

export async function mfaAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const claims = await readSessionClaims();
    if (!claims || claims.tid !== null || claims.mfa) return { redirectTo: "/login" };
    const code = field(formData, "code");
    if ((await getMfaStage(claims.sub)) === "enroll")
      await confirmMfaEnrollment(claims.sub, code, await getRequestMeta());
    else await verifyMfaLogin(claims.sub, code);
    await startSession({ ...claims, mfa: true });
    return { redirectTo: "/admin" };
  });
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}

export async function forgotPasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await requestPasswordReset({ email: field(formData, "email") }, await getRequestMeta());
    return {
      message:
        "Si el correo está registrado, te enviamos un enlace para crear una nueva contraseña.",
    };
  });
}

export async function resetPasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    if (field(formData, "password") !== field(formData, "confirm"))
      return { error: "Las contraseñas no coinciden" };
    await resetPassword(
      { token: field(formData, "token"), password: field(formData, "password") },
      await getRequestMeta(),
    );
    return { redirectTo: "/login?reset=1" };
  });
}

export async function acceptInviteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    if (field(formData, "password") !== field(formData, "confirm"))
      return { error: "Las contraseñas no coinciden" };
    await acceptInvite(
      {
        token: field(formData, "token"),
        name: field(formData, "name"),
        password: field(formData, "password"),
      },
      await getRequestMeta(),
    );
    return { redirectTo: "/login?welcome=1" };
  });
}

/** "Acceso Demo": captcha + rate limit + sandbox nuevo por sesión. */
export async function startDemoAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const meta = await getRequestMeta();
    if (!(await verifyCaptcha(field(formData, "cf-turnstile-response"), meta.ip))) {
      return { error: "No pudimos verificar el captcha. Inténtalo de nuevo." };
    }
    const demo = await provisionDemo(meta);
    await startSession({ sub: demo.userId, tid: demo.tenantId, sv: 1, mfa: true });
    return { redirectTo: "/app" };
  });
}

export async function restoreDemoAction(_previous: ActionState): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireUser();
    const demo = await restoreDemo(user, await getRequestMeta());
    await startSession({ sub: demo.userId, tid: demo.tenantId, sv: 1, mfa: true });
    return { redirectTo: "/app" };
  });
}
