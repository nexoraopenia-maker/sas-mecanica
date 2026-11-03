import { posApi } from "@/server/http/pos-api";
import { posSnapshot } from "@/server/services/pos-lookup";

export const dynamic = "force-dynamic";

/** Copia del catálogo y la tasa de IGV para vender sin conexión. */
export async function GET() {
  return posApi((user) => posSnapshot(user));
}
