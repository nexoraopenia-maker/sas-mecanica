"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionErrorMessage } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { labelParamsSchema } from "@/lib/catalog/labels";
import { prepareLabelProducts } from "@/server/services/catalog";
import {
  confirmCatalogImport,
  extractInvoiceFile,
  type ImportPreview,
  type ImportResult,
} from "@/server/services/catalog-import";

/** Asigna código a los productos que no lo tienen y abre la hoja de etiquetas lista para imprimir. */
export async function prepareLabelsAction(formData: FormData): Promise<void> {
  const actor = await requireTenantUser();
  const params = labelParamsSchema.parse({
    ids: formData.getAll("ids"),
    copies: formData.get("copies") ?? undefined,
    format: formData.get("format") ?? undefined,
  });
  if (params.ids.length === 0) redirect("/app/catalog/labels?error=empty");
  const products = await prepareLabelProducts(actor, params.ids, await getRequestMeta());
  revalidatePath("/app/catalog");
  const query = new URLSearchParams({
    ids: products.map((product) => product.id).join(","),
    copies: String(params.copies),
    format: params.format,
  });
  redirect(`/app/catalog/labels?${query.toString()}`);
}

export interface ImportPreviewState {
  error?: string;
  preview?: ImportPreview;
}

export interface ImportResultState {
  error?: string;
  result?: ImportResult;
}

/** Paso 1 del importador: lee el comprobante y devuelve la tabla de revisión (no guarda nada). */
export async function extractInvoiceAction(
  _previous: ImportPreviewState,
  formData: FormData,
): Promise<ImportPreviewState> {
  try {
    const actor = await requireTenantUser();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0)
      return { error: "Elige un archivo PDF, XML o una foto del comprobante" };
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      preview: await extractInvoiceFile(actor, { name: file.name, bytes }, await getRequestMeta()),
    };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}

/** Paso 2: guarda la tabla revisada (productos nuevos + entrada de stock por kardex). */
export async function confirmImportAction(
  _previous: ImportResultState,
  formData: FormData,
): Promise<ImportResultState> {
  try {
    const actor = await requireTenantUser();
    let payload: unknown;
    try {
      payload = JSON.parse(String(formData.get("payload") ?? ""));
    } catch {
      return { error: "Los datos de la importación no son válidos" };
    }
    const result = await confirmCatalogImport(
      actor,
      payload as Parameters<typeof confirmCatalogImport>[1],
      await getRequestMeta(),
    );
    revalidatePath("/app/catalog");
    revalidatePath("/app/inventory");
    return { result };
  } catch (error) {
    return { error: actionErrorMessage(error) };
  }
}
