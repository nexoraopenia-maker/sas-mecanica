import { consumeRateLimit, Prisma, withTenant } from "@/lib/db";
import { canTransition, SUPPLIER_DRIVEN } from "@/lib/purchasing/state";
import { samePhone, sanitizeText } from "@/lib/purchasing/text";
import { verifyWebhook } from "@/lib/security/webhook-signature";
import { webhookPayloadSchema, type WebhookPayload } from "@/lib/validation/purchasing";
import { uuidSchema } from "@/lib/validation/common";
import { getAiUsage } from "./ai-usage";
import { loadTenantSecrets } from "./ai-settings";
import { resolveAiPolicy } from "./messaging";
import { parseSupplierReply, type ParsedReply } from "./supplier-reply-parser";

export const MAX_WEBHOOK_BYTES = 256 * 1024;

export interface WebhookResult {
  status: 200 | 400 | 401 | 413 | 429;
  body: { ok: boolean; duplicate?: boolean; error?: string };
}

const unauthorized: WebhookResult = { status: 401, body: { ok: false, error: "unauthorized" } };

interface Prelude {
  secret: string | null;
  duplicate: boolean;
  aiKey: string | null;
  model: string;
  skus: string[];
}

function parseEta(value: string | null | undefined, now: Date): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const maxFuture = now.getTime() + 365 * 86_400_000;
  return date.getTime() > now.getTime() - 86_400_000 && date.getTime() <= maxFuture ? date : null;
}

/**
 * Webhook entrante de proveedores (WhatsApp vía n8n / Evolution / Business).
 *
 * Seguridad:
 *  - firma HMAC-SHA256 sobre `timestamp.cuerpo` con el secreto del tenant (cifrado en BD),
 *    ventana de 5 min y comparación en tiempo constante; sin firma válida no se procesa nada;
 *  - rate limit por IP, tope de tamaño, esquema Zod y deduplicación por `externalId`;
 *  - el contenido es DATO NO CONFIABLE: se guarda como tal y solo puede avanzar la orden a
 *    Cotizado o En camino. Jamás aprueba pedidos, envía mensajes, cambia precios ni configuración.
 */
export async function handleSupplierWebhook(params: {
  tenantId: string;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  ip: string | undefined;
  nowMs?: number;
}): Promise<WebhookResult> {
  const now = new Date(params.nowMs ?? Date.now());
  if (!uuidSchema.safeParse(params.tenantId).success) return unauthorized;
  if (Buffer.byteLength(params.rawBody, "utf8") > MAX_WEBHOOK_BYTES)
    return { status: 413, body: { ok: false, error: "payload_too_large" } };

  const ip = params.ip ?? "unknown";
  const flood = await consumeRateLimit("webhook:ip", `${params.tenantId}:${ip}`, 120, 60);
  if (!flood.allowed) return { status: 429, body: { ok: false, error: "rate_limited" } };

  // Lectura previa: secreto, duplicado y datos para la extracción opcional con IA.
  let payload: WebhookPayload | null = null;
  const prelude = await withTenant(params.tenantId, async (tx): Promise<Prelude> => {
    const tenant = await tx.tenant.findFirst({ select: { status: true, isDemo: true } });
    if (!tenant || tenant.status !== "ACTIVE")
      return { secret: null, duplicate: false, aiKey: null, model: "", skus: [] };
    const secrets = await loadTenantSecrets(tx, params.tenantId);
    const settings = await tx.tenantSettings.findFirst({ select: { aiModel: true } });
    return {
      secret: secrets.inboundSecret,
      duplicate: false,
      aiKey: tenant.isDemo ? null : secrets.openaiKey,
      model: settings?.aiModel ?? "",
      skus: [],
    };
  }).catch(() => null);
  if (!prelude?.secret) return unauthorized;

  const check = verifyWebhook({
    secret: prelude.secret,
    timestamp: params.timestamp,
    signature: params.signature,
    rawBody: params.rawBody,
    nowMs: now.getTime(),
  });
  if (check !== "ok") {
    const bad = await consumeRateLimit("webhook:bad", `${params.tenantId}:${ip}`, 20, 600);
    return bad.allowed ? unauthorized : { status: 429, body: { ok: false, error: "rate_limited" } };
  }

  let json: unknown;
  try {
    json = JSON.parse(params.rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }
  const parsed = webhookPayloadSchema.safeParse(json);
  if (!parsed.success) return { status: 400, body: { ok: false, error: "invalid_payload" } };
  payload = parsed.data;

  // Duplicado (reintento del emisor): se confirma sin repetir efectos ni gastar IA.
  const known = await withTenant(params.tenantId, async (tx) => {
    const duplicate = Boolean(
      await tx.webhookEvent.findFirst({
        where: { source: "supplier", externalId: payload.externalId },
      }),
    );
    if (duplicate) return { duplicate, skus: [] as string[], allowAi: false };
    let skus: string[] = [];
    if (payload.orderNumber) {
      const order = await tx.purchaseOrder.findFirst({
        where: { number: payload.orderNumber },
        include: { items: { include: { product: { select: { sku: true } } } } },
      });
      skus = order?.items.map((item) => item.product.sku) ?? [];
    }
    const policy = await resolveAiPolicy(tx);
    const usage = await getAiUsage(tx, now);
    return { duplicate, skus, allowAi: policy.enabled && !policy.simulated && !usage.exhausted };
  });
  if (known.duplicate) return { status: 200, body: { ok: true, duplicate: true } };

  // Extracción con IA solo si el emisor no envió campos estructurados (sin herramientas, salida validada).
  let aiParsed: ParsedReply | null = null;
  if (
    !payload.event &&
    known.allowAi &&
    prelude.aiKey &&
    known.skus.length > 0 &&
    payload.text.trim()
  ) {
    aiParsed = await parseSupplierReply({
      apiKey: prelude.aiKey,
      model: prelude.model,
      text: payload.text,
      knownSkus: known.skus,
    });
  }

  try {
    await withTenant(params.tenantId, async (tx) => {
      const event = await tx.webhookEvent.create({
        data: {
          tenantId: params.tenantId,
          source: "supplier",
          externalId: payload.externalId,
          signatureValid: true,
          payload: {
            from: payload.from,
            orderNumber: payload.orderNumber ?? null,
            event: payload.event ?? null,
            length: payload.text.length,
          },
        },
      });
      const suppliers = await tx.supplier.findMany({
        where: { isActive: true, whatsapp: { not: null } },
        select: { id: true, name: true, whatsapp: true },
      });
      const supplier = suppliers.find(
        (candidate) => candidate.whatsapp && samePhone(candidate.whatsapp, payload.from),
      );
      if (!supplier) {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: { processedAt: now, error: "unknown_supplier" },
        });
        return;
      }
      // Solo órdenes DE ESTE proveedor: un proveedor no puede tocar pedidos ajenos.
      const order = payload.orderNumber
        ? await tx.purchaseOrder.findFirst({
            where: { number: payload.orderNumber, supplierId: supplier.id },
            include: { items: { include: { product: { select: { sku: true, id: true } } } } },
          })
        : null;
      const orderSkus = new Set(order?.items.map((item) => item.product.sku) ?? []);

      const intent =
        payload.event ??
        (aiParsed && aiParsed.reply.intent !== "other" ? aiParsed.reply.intent : null);
      const quoteItems = (
        payload.quote?.items ??
        aiParsed?.reply.items.flatMap((i) =>
          i.unitPrice === null ? [] : [{ sku: i.sku, unitPrice: i.unitPrice }],
        ) ??
        []
      ).filter((item) => orderSkus.has(item.sku));
      const eta = parseEta(payload.etaDate ?? aiParsed?.reply.etaDate, now);

      const message = await tx.supplierMessage.create({
        data: {
          supplierId: supplier.id,
          orderId: order?.id ?? null,
          direction: "INBOUND",
          channel: "WHATSAPP",
          body: sanitizeText(payload.text, 5_000),
          untrusted: true,
          externalId: payload.externalId,
          parsed: {
            source: payload.event ? "structured" : aiParsed ? "ai" : "none",
            intent,
            quote: quoteItems,
            etaDate: eta?.toISOString() ?? null,
            summary: aiParsed?.reply.summary ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      // ÚNICO efecto permitido: avanzar el seguimiento a Cotizado o En camino (nunca Recibido).
      let applied: string | null = null;
      const target = intent === "quote" ? "QUOTED" : intent === "shipped" ? "IN_TRANSIT" : null;
      if (
        order &&
        target &&
        SUPPLIER_DRIVEN.includes(target) &&
        canTransition(order.status, target)
      ) {
        const moved = await tx.purchaseOrder.updateMany({
          where: { id: order.id, status: order.status },
          data: {
            status: target,
            ...(target === "QUOTED" ? { quotedAt: now } : {}),
            ...(target === "IN_TRANSIT" && eta ? { expectedAt: eta } : {}),
          },
        });
        if (moved.count === 1) applied = target;
      }

      if (aiParsed) {
        await tx.aiRun.create({
          data: {
            kind: "SUPPLIER_REPLY_PARSE",
            status: "SUCCEEDED",
            model: aiParsed.model,
            prompt: {
              messages: aiParsed.messages.map((m) => ({ role: m.role, content: m.content })),
            },
            response: aiParsed.reply as unknown as Prisma.InputJsonValue,
            promptTokens: aiParsed.usage.promptTokens,
            completionTokens: aiParsed.usage.completionTokens,
            costUsd: aiParsed.costUsd.toString(),
            idempotencyKey: `parse:${payload.externalId}`,
            finishedAt: now,
          },
        });
      }
      await tx.notification.createMany({
        data: [
          {
            kind: "supplier.reply",
            severity: "INFO",
            title: `Respuesta de ${supplier.name}`,
            body: applied
              ? `La orden #${order?.number} pasó a ${applied === "QUOTED" ? "Cotizado" : "En camino"}.`
              : "Revisa el mensaje recibido.",
            data: { messageId: message.id, orderId: order?.id ?? null },
            dedupeKey: `supplier-msg:${message.id}`,
          },
        ],
        skipDuplicates: true,
      });
      await tx.webhookEvent.update({ where: { id: event.id }, data: { processedAt: now } });
    });
  } catch (error) {
    // Dos entregas simultáneas del mismo evento: la segunda pierde la carrera de unicidad.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      return { status: 200, body: { ok: true, duplicate: true } };
    throw error;
  }
  return { status: 200, body: { ok: true } };
}

export const _testing = { parseEta };
