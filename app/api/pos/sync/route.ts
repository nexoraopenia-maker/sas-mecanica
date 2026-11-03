import { getRequestMeta } from "@/lib/http";
import { posApi } from "@/server/http/pos-api";
import { syncOfflineSale } from "@/server/services/pos-offline";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 200_000;

/** Registra una venta guardada sin conexión. Idempotente por la clave de la venta. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host)
    return Response.json({ error: "Origen no permitido", code: "FORBIDDEN" }, { status: 403 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES)
    return Response.json(
      { error: "Solicitud demasiado grande", code: "TOO_LARGE" },
      { status: 413 },
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "JSON inválido", code: "INVALID" }, { status: 400 });
  }
  const meta = await getRequestMeta();
  return posApi((user) => syncOfflineSale(user, body, meta));
}
