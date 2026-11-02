import { withPlatform, withTenant, type TenantTx } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ChannelError, sendEmail, sendWhatsApp } from "@/server/integrations/channels";
import { loadTenantSecrets, type TenantSecrets } from "./ai-settings";

export const MAX_ATTEMPTS = 5;
/** Minutos de espera antes del reintento n (1.º, 2.º...): backoff exponencial acotado. */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const VISIBILITY_MINUTES = 5;

export function backoffMinutes(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] ?? 180;
}

export interface QueueResult {
  sent: number;
  retried: number;
  failed: number;
}

interface Owned {
  id: string;
  channel: "WHATSAPP" | "EMAIL";
  toAddress: string;
  subject: string | null;
  body: string;
  idempotencyKey: string;
  attempts: number;
}

/**
 * Reclama un mensaje para enviarlo: UPDATE condicional sobre el estado y el número de intentos que
 * LEYÓ el llamador. Si otro proceso ya lo reclamó (o lo envió), el conteo de filas es 0 y no se envía.
 */
export async function claimOutbound(
  tx: TenantTx,
  candidate: { id: string; attempts: number },
  now: Date,
): Promise<boolean> {
  const result = await tx.outboundMessage.updateMany({
    where: { id: candidate.id, status: "PENDING", attempts: candidate.attempts },
    data: {
      attempts: { increment: 1 },
      scheduledAt: new Date(now.getTime() + VISIBILITY_MINUTES * 60_000),
    },
  });
  return result.count === 1;
}

async function deliver(
  message: Owned,
  secrets: TenantSecrets,
): Promise<{ providerRef: string | null }> {
  if (message.channel === "WHATSAPP") {
    if (!secrets.whatsapp)
      throw new ChannelError("El canal de WhatsApp no está configurado", false);
    return sendWhatsApp(secrets.whatsapp, {
      to: message.toAddress,
      body: message.body,
      idempotencyKey: message.idempotencyKey,
    });
  }
  if (!secrets.smtp) throw new ChannelError("El SMTP no está configurado", false);
  return sendEmail(secrets.smtp, {
    to: message.toAddress,
    subject: message.subject ?? "Mensaje",
    text: message.body,
  });
}

/**
 * Procesa la cola de salida de UN tenant. Reclama cada mensaje de forma atómica (varios
 * procesos no lo envían dos veces), envía FUERA de la transacción y registra el resultado:
 * éxito → SENT; error transitorio → reintento con backoff; permanente o 5 intentos → FAILED + alerta.
 * Nunca envía en cuentas demo (esos mensajes ya nacen SIMULATED).
 */
export async function processOutboundQueue(
  tenantId: string,
  now: Date = new Date(),
  limit = 20,
): Promise<QueueResult> {
  const { owned, secrets, isDemo } = await withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findFirstOrThrow({ select: { isDemo: true } });
    const candidates = await tx.outboundMessage.findMany({
      where: { status: "PENDING", scheduledAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { scheduledAt: "asc" },
      take: limit,
    });
    const claimed: Owned[] = [];
    for (const candidate of candidates) {
      if (tenant.isDemo) {
        await tx.outboundMessage.updateMany({
          where: { id: candidate.id, status: "PENDING" },
          data: { status: "SIMULATED", sentAt: now },
        });
        continue;
      }
      if (await claimOutbound(tx, candidate, now)) {
        claimed.push({
          id: candidate.id,
          channel: candidate.channel,
          toAddress: candidate.toAddress,
          subject: candidate.subject,
          body: candidate.body,
          idempotencyKey: candidate.idempotencyKey,
          attempts: candidate.attempts + 1,
        });
      }
    }
    return {
      owned: claimed,
      secrets: claimed.length > 0 ? await loadTenantSecrets(tx, tenantId) : null,
      isDemo: tenant.isDemo,
    };
  });
  if (isDemo || owned.length === 0 || !secrets) return { sent: 0, retried: 0, failed: 0 };

  const outcomes: Array<
    | { message: Owned; ok: true; providerRef: string | null }
    | { message: Owned; ok: false; error: string; retryable: boolean }
  > = [];
  for (const message of owned) {
    try {
      const { providerRef } = await deliver(message, secrets);
      outcomes.push({ message, ok: true, providerRef });
    } catch (error) {
      const retryable = error instanceof ChannelError ? error.retryable : true;
      outcomes.push({
        message,
        ok: false,
        error: (error instanceof Error ? error.message : "Error de envío").slice(0, 300),
        retryable,
      });
    }
  }

  const result: QueueResult = { sent: 0, retried: 0, failed: 0 };
  await withTenant(tenantId, async (tx) => {
    for (const outcome of outcomes) {
      if (outcome.ok) {
        await tx.outboundMessage.update({
          where: { id: outcome.message.id },
          data: { status: "SENT", sentAt: now, providerRef: outcome.providerRef, error: null },
        });
        result.sent += 1;
      } else if (outcome.retryable && outcome.message.attempts < MAX_ATTEMPTS) {
        await tx.outboundMessage.update({
          where: { id: outcome.message.id },
          data: {
            scheduledAt: new Date(
              now.getTime() + backoffMinutes(outcome.message.attempts) * 60_000,
            ),
            error: outcome.error,
          },
        });
        result.retried += 1;
      } else {
        await tx.outboundMessage.update({
          where: { id: outcome.message.id },
          data: { status: "FAILED", error: outcome.error },
        });
        await tx.notification.createMany({
          data: [
            {
              kind: "outbound.failed",
              severity: "CRITICAL",
              title: "No se pudo enviar un mensaje",
              body: `${outcome.message.channel === "WHATSAPP" ? "WhatsApp" : "Correo"} a ${outcome.message.toAddress}: ${outcome.error}`,
              data: { messageId: outcome.message.id },
              dedupeKey: `outbound-failed:${outcome.message.id}`,
            },
          ],
          skipDuplicates: true,
        });
        result.failed += 1;
      }
    }
  });
  return result;
}

/** Tenants con mensajes pendientes de envío (para el job). */
export async function tenantsWithPendingMessages(now: Date = new Date()): Promise<string[]> {
  const rows = await withPlatform((db) =>
    db.outboundMessage.findMany({
      where: { status: "PENDING", scheduledAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS } },
      distinct: ["tenantId"],
      select: { tenantId: true },
      take: 500,
    }),
  );
  return rows.map((row) => row.tenantId);
}

export async function processAllOutbound(now: Date = new Date()): Promise<QueueResult> {
  const total: QueueResult = { sent: 0, retried: 0, failed: 0 };
  for (const tenantId of await tenantsWithPendingMessages(now)) {
    try {
      const r = await processOutboundQueue(tenantId, now);
      total.sent += r.sent;
      total.retried += r.retried;
      total.failed += r.failed;
    } catch (error) {
      logger.error({ err: error, tenantId }, "falló el procesamiento de la cola de salida");
    }
  }
  return total;
}
