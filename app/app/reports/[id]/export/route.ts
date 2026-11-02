import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/lib/errors";
import { defaultPeriod } from "@/lib/reports/period";
import { reportToCsv } from "@/lib/reports/table";
import { availableReports, runReport } from "@/server/services/reports";
import { getCurrentUser } from "@/server/services/session";

export const dynamic = "force-dynamic";

/** Descarga un reporte como CSV (Excel). Exige sesión y el mismo permiso que la pantalla; nunca cachea. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !user.tenantId)
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;
  if (!availableReports(user).some((r) => r.id === id))
    return NextResponse.json({ error: "No disponible" }, { status: 403 });
  const url = new URL(request.url);
  const fallback = defaultPeriod();
  try {
    const groupBy = url.searchParams.get("agrupar") === "month" ? "month" : "day";
    const report = await runReport(
      user,
      id,
      {
        from: url.searchParams.get("from") ?? fallback.from,
        to: url.searchParams.get("to") ?? fallback.to,
      },
      new Date(),
      groupBy,
    );
    return new NextResponse(reportToCsv(report), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="reporte-${report.id}-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ZodError)
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 },
      );
    if (error instanceof DomainError)
      return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
}
