import { getEnv } from "@/lib/env";
import type { BillingConfig } from "./subscription";

/** Parámetros del ciclo de cobro, tomados del entorno (validados por `lib/env.ts`). */
export function getBillingConfig(): BillingConfig {
  const env = getEnv();
  return {
    graceDays: env.BILLING_GRACE_DAYS,
    retryDays: env.BILLING_RETRY_DAYS.split(",").map(Number),
    renewalLeadDays: 3,
  };
}
