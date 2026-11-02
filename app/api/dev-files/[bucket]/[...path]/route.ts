import { NextResponse } from "next/server";
import {
  isLocalStorageDriver,
  readLocalFile,
  verifyLocalSignature,
} from "@/server/integrations/storage";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Sirve archivos del almacenamiento LOCAL (desarrollo/CI) con URL firmada y vencimiento.
 * Con Supabase como driver esta ruta no existe (404): el navegador usa las URLs firmadas de Supabase.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ bucket: string; path: string[] }> },
) {
  if (!isLocalStorageDriver()) return new NextResponse(null, { status: 404 });
  const { bucket, path } = await params;
  const url = new URL(request.url);
  const relative = path.join("/");
  if (
    !verifyLocalSignature(
      bucket,
      relative,
      Number(url.searchParams.get("e")),
      url.searchParams.get("s") ?? "",
    )
  ) {
    return new NextResponse(null, { status: 403 });
  }
  const bytes = await readLocalFile(bucket, relative);
  if (!bytes) return new NextResponse(null, { status: 404 });
  const contentType = TYPES[relative.split(".").pop() ?? ""] ?? "application/octet-stream";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    },
  });
}
