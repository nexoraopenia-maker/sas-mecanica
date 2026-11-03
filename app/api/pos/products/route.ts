import { posApi } from "@/server/http/pos-api";
import { searchPosProducts, suggestProducts } from "@/server/services/pos-lookup";

export const dynamic = "force-dynamic";

/**
 * Productos del mostrador. Solo `q` = sugerencias en tiempo real (máx. 8); con medida de llanta o
 * vehículo = búsqueda con filtros (máx. 30).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const tireSize = params.get("tire") ?? "";
  const make = params.get("make") ?? "";
  const model = params.get("model") ?? "";
  return posApi(async (user) => ({
    products:
      tireSize || make
        ? await searchPosProducts(user, { q, tireSize, make, model })
        : await suggestProducts(user, q, 8),
  }));
}
