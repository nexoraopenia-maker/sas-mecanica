import type { TenantTx } from "@/lib/db";
import { normalizeWhatsapp } from "@/lib/workshop/documents";
import { enqueueOutbound } from "./messaging";

export type NotifyResult =
  "QUEUED" | "SIMULATED" | "SKIPPED_NO_CONSENT" | "SKIPPED_NO_CONTACT" | "SKIPPED_DISABLED";

/**
 * Avisa al cliente por WhatsApp si dio su consentimiento y tiene número. Pasa por la cola
 * de salida (idempotente por `key`): en demo queda SIMULATED y nunca sale un mensaje real.
 */
export async function notifyCustomer(
  tx: TenantTx,
  params: { customerId: string; key: string; body: string; relatedType: string; relatedId: string },
): Promise<NotifyResult> {
  // Interruptor del dueño (Configuración → IA y canales): sin avisos no se encola nada.
  const settings = await tx.tenantSettings.findFirst({ select: { whatsappNoticesEnabled: true } });
  if (settings && !settings.whatsappNoticesEnabled) return "SKIPPED_DISABLED";
  const customer = await tx.customer.findFirst({
    where: { id: params.customerId },
    select: { whatsapp: true, phone: true, whatsappOptIn: true },
  });
  if (!customer?.whatsappOptIn) return "SKIPPED_NO_CONSENT";
  const to = customer.whatsapp ?? (customer.phone ? normalizeWhatsapp(customer.phone) : null);
  if (!to) return "SKIPPED_NO_CONTACT";
  const message = await enqueueOutbound(tx, {
    channel: "WHATSAPP",
    toAddress: to,
    body: params.body,
    idempotencyKey: params.key,
    relatedType: params.relatedType,
    relatedId: params.relatedId,
  });
  return message.status === "SIMULATED" ? "SIMULATED" : "QUEUED";
}

export async function companyName(tx: TenantTx): Promise<string> {
  const tenant = await tx.tenant.findFirstOrThrow({ select: { legalName: true, tradeName: true } });
  return tenant.tradeName ?? tenant.legalName;
}
