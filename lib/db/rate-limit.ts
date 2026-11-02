import { createHash } from "node:crypto";
import { getAppClient } from "./raw.ts";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Ventana fija en BD (válida en serverless, a diferencia de un Map en memoria).
 * La clave se guarda hasheada: no quedan IPs ni correos en claro. El UPSERT
 * atómico hace seguro el conteo ante peticiones simultáneas.
 */
export async function consumeRateLimit(
  scope: string,
  id: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key = createHash("sha256").update(`${scope}:${id.toLowerCase()}`).digest("hex");
  const rows = await getAppClient().$queryRaw<{ count: number; elapsed: number }[]>`
    INSERT INTO rate_limit_buckets (key, "windowStart", count)
    VALUES (${key}, now(), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limit_buckets."windowStart" <= now() - make_interval(secs => ${windowSeconds}::double precision)
                   THEN 1 ELSE rate_limit_buckets.count + 1 END,
      "windowStart" = CASE WHEN rate_limit_buckets."windowStart" <= now() - make_interval(secs => ${windowSeconds}::double precision)
                           THEN now() ELSE rate_limit_buckets."windowStart" END
    RETURNING count, EXTRACT(EPOCH FROM (now() - "windowStart"))::double precision AS elapsed`;
  const row = rows[0];
  if (!row) throw new Error("No se pudo evaluar el rate limit");
  const count = Number(row.count);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - Number(row.elapsed))),
  };
}

/** Limpia contadores vencidos (lo ejecuta el job de mantenimiento). */
export async function pruneRateLimits(olderThanSeconds = 86_400): Promise<number> {
  return getAppClient().$executeRaw`
    DELETE FROM rate_limit_buckets WHERE "windowStart" < now() - make_interval(secs => ${olderThanSeconds}::double precision)`;
}
