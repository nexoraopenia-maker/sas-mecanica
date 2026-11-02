import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/lib/errors";
import { exportPle } from "@/server/services/ple";
import { getCurrentUser } from "@/server/services/session";

export const dynamic = "force-dynamic";

/** Descarga el TXT del PLE (14.1 o 8.1) del mes pedido. Exige sesión y `reports:ver`; nunca cachea. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || !user.tenantId)
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const url = new URL(request.url);
  try {
    const file = await exportPle(user, {
      book: url.searchParams.get("libro"),
      year: url.searchParams.get("anio"),
      month: url.searchParams.get("mes"),
    });
    return new NextResponse(new Uint8Array(file.content), {
      headers: {
        "content-type": "text/plain; charset=windows-1252",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
        "x-ple-rows": String(file.rows),
      },
    });
  } catch (error) {
    if (error instanceof ZodError)
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 },
      );
    if (error instanceof DomainError) {
      const status = error.code === "PERMISSION_DENIED" ? 403 : 422;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}
