import { headers } from "next/headers";
import type { RequestMeta } from "@/server/services/audit";

/** IP (primer valor de x-forwarded-for en Vercel), user-agent e id de petición del proxy. */
export async function getRequestMeta(): Promise<RequestMeta> {
  const store = await headers();
  return {
    ip: store.get("x-forwarded-for")?.split(",")[0]?.trim() || store.get("x-real-ip") || undefined,
    userAgent: store.get("user-agent")?.slice(0, 300) || undefined,
    requestId: store.get("x-request-id") || undefined,
  };
}
