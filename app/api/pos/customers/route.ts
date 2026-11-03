import { posApi } from "@/server/http/pos-api";
import { lookupCustomers } from "@/server/services/pos-lookup";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return posApi((user) => lookupCustomers(user, q));
}
