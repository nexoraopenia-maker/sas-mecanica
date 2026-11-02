"use server";

import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { registerPurchaseInvoice, voidPurchaseInvoice } from "@/server/services/ple";

const opt = (formData: FormData, name: string): string | undefined =>
  field(formData, name).trim() || undefined;

export async function registerPurchaseInvoiceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await registerPurchaseInvoice(
      await requireTenantUser(),
      {
        docTypeCode: field(formData, "docTypeCode") as never,
        series: field(formData, "series"),
        number: field(formData, "number"),
        issueDate: field(formData, "issueDate"),
        dueDate: opt(formData, "dueDate"),
        supplierDocType: (opt(formData, "supplierDocType") ?? "RUC") as never,
        supplierDocNumber: opt(formData, "supplierDocNumber"),
        supplierName: opt(formData, "supplierName"),
        taxedBase: field(formData, "taxedBase") || "0",
        igv: field(formData, "igv") || "0",
        exemptTotal: field(formData, "exemptTotal") || "0",
        givesTaxCredit: formData.get("givesTaxCredit") === "on",
        paidWithBankMethod: formData.get("paidWithBankMethod") === "on",
        ...(opt(formData, "relatedSeries")
          ? {
              related: {
                docTypeCode: field(formData, "relatedDocTypeCode") as never,
                series: field(formData, "relatedSeries"),
                number: field(formData, "relatedNumber"),
                issueDate: field(formData, "relatedIssueDate"),
              },
            }
          : {}),
        notes: opt(formData, "notes"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/reports/ple");
    return { message: "Comprobante de compra registrado." };
  });
}

export async function voidPurchaseInvoiceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await voidPurchaseInvoice(
      await requireTenantUser(),
      { id: field(formData, "id"), reason: field(formData, "reason") },
      await getRequestMeta(),
    );
    revalidatePath("/app/reports/ple");
    return { message: "Comprobante anulado." };
  });
}
