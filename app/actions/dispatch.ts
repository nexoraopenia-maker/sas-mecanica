"use server";

import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { createDispatchGuide, voidDispatchGuide } from "@/server/services/dispatch-guides";

const KEYS = [
  "transferDate",
  "reason",
  "reasonNote",
  "transportMode",
  "carrierDocNumber",
  "carrierName",
  "driverDocNumber",
  "driverName",
  "driverLicense",
  "vehiclePlate",
  "grossWeightKg",
  "packages",
  "originAddress",
  "originUbigeo",
  "destinationAddress",
  "destinationUbigeo",
  "recipientDocType",
  "recipientDocNumber",
  "recipientName",
  "saleId",
  "transferId",
  "relatedDocument",
  "series",
] as const;

export async function createDispatchGuideAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requireTenantUser();
    let items: unknown;
    try {
      items = JSON.parse(field(formData, "items") || "[]");
    } catch {
      return { error: "El detalle de bienes no es válido" };
    }
    const input: Record<string, unknown> = { items };
    for (const key of KEYS) {
      const value = field(formData, key);
      if (value !== "") input[key] = value;
    }
    const guide = await createDispatchGuide(
      actor,
      input as Parameters<typeof createDispatchGuide>[1],
      await getRequestMeta(),
    );
    revalidatePath("/app/guias");
    return { redirectTo: `/app/guias/${guide.id}` };
  });
}

export async function voidDispatchGuideAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requireTenantUser();
    await voidDispatchGuide(
      actor,
      { guideId: field(formData, "guideId"), reason: field(formData, "reason") },
      await getRequestMeta(),
    );
    revalidatePath("/app/guias");
    revalidatePath(`/app/guias/${field(formData, "guideId")}`);
    return { message: "Guía anulada." };
  });
}
