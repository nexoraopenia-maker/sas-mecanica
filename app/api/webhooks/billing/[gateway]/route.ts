import { NextResponse } from "next/server";
import { MAX_BILLING_WEBHOOK_BYTES, handleBillingWebhook } from "@/server/services/billing-webhook";

export const dynamic = "force-dynamic";

/**
 * Webhooks de la pasarela de cobro de la suscripción del SaaS (`/api/webhooks/billing/{stripe|mercadopago}`).
 * Se lee el cuerpo CRUDO: la firma se calcula sobre esos bytes exactos.
 */
export async function POST(request: Request, { params }: { params: Promise<{ gateway: string }> }) {
  const { gateway } = await params;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BILLING_WEBHOOK_BYTES)
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  const result = await handleBillingWebhook({
    gateway,
    rawBody: await request.text(),
    headers: {
      "stripe-signature": request.headers.get("stripe-signature"),
      "x-signature": request.headers.get("x-signature"),
      "x-request-id": request.headers.get("x-request-id"),
    },
    query: new URL(request.url).searchParams,
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}
