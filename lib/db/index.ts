/**
 * API pública de la capa de datos. Los servicios importan SOLO desde aquí.
 * El cliente Prisma crudo no se exporta (regla 6).
 */
export { withTenant, type TenantTx, type TenantOptions } from "./tenant.ts";
export { withAdmin, type AdminActor, type AdminClient } from "./admin.ts";
export { checkDatabase } from "./health.ts";
export { withPlatform } from "./platform.ts";
export { consumeRateLimit, pruneRateLimits, type RateLimitResult } from "./rate-limit.ts";
export {
  findUserByEmail,
  findAuthTokenByHash,
  findWorkOrderByTokenHash,
  type WorkOrderTokenRow,
  type LoginUserRow,
  type AuthTokenRow,
} from "./auth-lookup.ts";
export { nextSequence } from "./sequence.ts";
export { softDeleteData } from "./scope.ts";
export { Prisma } from "./generated/client.ts";
export * from "./generated/enums.ts";
