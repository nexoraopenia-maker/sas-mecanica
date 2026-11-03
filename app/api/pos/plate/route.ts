import { posApi } from "@/server/http/pos-api";
import { lookupPlate } from "@/server/services/pos-lookup";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const plate = new URL(request.url).searchParams.get("plate") ?? "";
  return posApi((user) => lookupPlate(user, plate));
}
