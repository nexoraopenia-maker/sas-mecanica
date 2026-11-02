import { z } from "zod";
import { getEnv } from "@/lib/env";

const responseSchema = z.object({ success: z.boolean() });

/**
 * Verifica el captcha (Cloudflare Turnstile). Sin clave configurada solo se
 * acepta fuera de producción (el entorno exige la clave en producción).
 */
export async function verifyCaptcha(
  token: string | null | undefined,
  ip?: string,
): Promise<boolean> {
  const secret = getEnv().TURNSTILE_SECRET_KEY;
  if (!secret) return getEnv().NODE_ENV !== "production";
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5_000),
    });
    const parsed = responseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.success;
  } catch {
    return false;
  }
}
