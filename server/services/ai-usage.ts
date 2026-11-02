import type { TenantTx } from "@/lib/db";
import { resolveAiPolicy } from "./messaging";

export interface AiUsage {
  tokens: number;
  costUsd: number;
  /** Tope mensual de tokens efectivo (null = sin tope). En demo nunca supera el máximo de la demo. */
  tokenCap: number | null;
  costCapUsd: number | null;
  tokensRemaining: number | null;
  exhausted: boolean;
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Consumo del mes en curso (UTC) contra los topes del tenant. Las corridas
 * simuladas (demo) no consumen tokens reales y no cuentan.
 */
export async function getAiUsage(tx: TenantTx, now: Date = new Date()): Promise<AiUsage> {
  const [policy, settings, totals] = await Promise.all([
    resolveAiPolicy(tx),
    tx.tenantSettings.findFirst({ select: { aiMonthlyCostCapUsd: true } }),
    tx.aiRun.aggregate({
      where: { startedAt: { gte: monthStartUtc(now) }, simulated: false },
      _sum: { promptTokens: true, completionTokens: true, costUsd: true },
    }),
  ]);
  const tokens = (totals._sum.promptTokens ?? 0) + (totals._sum.completionTokens ?? 0);
  const costUsd = Number(totals._sum.costUsd ?? 0);
  const costCapUsd = settings?.aiMonthlyCostCapUsd ? Number(settings.aiMonthlyCostCapUsd) : null;
  const tokenCap = policy.monthlyTokenCap;
  const exhausted =
    (tokenCap !== null && tokens >= tokenCap) || (costCapUsd !== null && costUsd >= costCapUsd);
  return {
    tokens,
    costUsd,
    tokenCap,
    costCapUsd,
    tokensRemaining: tokenCap === null ? null : Math.max(0, tokenCap - tokens),
    exhausted,
  };
}
