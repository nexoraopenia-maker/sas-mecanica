import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { handleSupplierWebhook, MAX_WEBHOOK_BYTES } from "@/server/services/supplier-webhook";

export const dynamic = "force-dynamic";

/**
 * Respuestas de proveedores (n8n / Evolution / WhatsApp Business → este endpoint).
 * Cabeceras: `x-timestamp` (epoch) y `x-signature: sha256=HMAC(secreto, "<timestamp>.<cuerpo>")`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const { tenantId } = await params;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BYTES)
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });

  try {
    const result = await handleSupplierWebhook({
      tenantId,
      rawBody: await request.text(),
      signature: request.headers.get("x-signature"),
      timestamp: request.headers.get("x-timestamp"),
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
    });
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    logger.error({ err: error, tenantId }, "error procesando el webhook de proveedor");
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
