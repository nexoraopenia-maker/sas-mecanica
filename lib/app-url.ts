import { getEnv } from "@/lib/env";

/** URL pública de la app, sin barra final. */
export function getAppUrl(): string {
  return getEnv().APP_URL.replace(/\/$/, "");
}
