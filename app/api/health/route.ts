import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const database = await checkDatabase();
  return NextResponse.json(
    { status: database ? "ok" : "degraded", database },
    { status: database ? 200 : 503 },
  );
}
