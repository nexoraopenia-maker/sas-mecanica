"use server";

import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requirePlatformUser, requireTenantUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { updateCompanyProfile, updateOperations } from "@/server/services/company-settings";
import {
  extendGrace,
  recordManualPayment,
  setCancelAtPeriodEnd,
  startCheckout,
} from "@/server/services/subscription-billing";

const checked = (formData: FormData, name: string): boolean => formData.get(name) === "on";

export async function updateProfileAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await updateCompanyProfile(
      await requireTenantUser(),
      {
        legalName: field(formData, "legalName"),
        tradeName: field(formData, "tradeName"),
        // Un campo bloqueado no se envía: ausente = no tocar (no es «borrar el RUC»).
        taxId: formData.has("taxId") ? field(formData, "taxId") : undefined,
        address: field(formData, "address"),
        phone: field(formData, "phone"),
        contactName: field(formData, "contactName"),
        contactEmail: field(formData, "contactEmail"),
        billingEmail: field(formData, "billingEmail"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/settings");
    return { message: "Datos de la empresa guardados." };
  });
}

export async function updateOperationsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await updateOperations(
      await requireTenantUser(),
      {
        taxName: field(formData, "taxName"),
        taxRate: Number(field(formData, "taxPercent")) / 100,
        pricesIncludeTax: checked(formData, "pricesIncludeTax"),
        ticketWidthMm: field(formData, "ticketWidthMm"),
        tireMaxAgeYears: field(formData, "tireMaxAgeYears"),
        allowNegativeStock: checked(formData, "allowNegativeStock"),
        rotationWindowDays: field(formData, "rotationWindowDays"),
        deadStockDays: field(formData, "deadStockDays"),
        aiMinutesSavedPerLine: field(formData, "aiMinutesSavedPerLine"),
        staffHourlyCost: field(formData, "staffHourlyCost"),
        usdExchangeRate: field(formData, "usdExchangeRate"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/settings");
    return { message: "Configuración operativa guardada." };
  });
}

/** Crea el cobro del periodo y lleva al cliente a pagar en la pasarela. */
export async function startCheckoutAction(_previous: ActionState): Promise<ActionState> {
  return runAction(async () => {
    const { url } = await startCheckout(await requireTenantUser());
    return { redirectTo: url };
  });
}

export async function cancelSubscriptionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const cancel = field(formData, "cancel") === "1";
    await setCancelAtPeriodEnd(await requireTenantUser(), cancel, await getRequestMeta());
    revalidatePath("/app/subscription");
    return {
      message: cancel
        ? "La suscripción terminará al final del periodo pagado."
        : "Cancelación retirada: tu suscripción continúa.",
    };
  });
}

export async function manualPaymentAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const result = await recordManualPayment(
      await requirePlatformUser(),
      {
        tenantId: field(formData, "tenantId"),
        amount: field(formData, "amount"),
        reference: field(formData, "reference"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/admin/billing");
    return {
      message:
        result.outcome === "APPLIED"
          ? "Pago registrado y suscripción activada."
          : `Pago registrado (${result.outcome}).`,
    };
  });
}

export async function extendGraceAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await extendGrace(
      await requirePlatformUser(),
      {
        tenantId: field(formData, "tenantId"),
        days: field(formData, "days"),
        reason: field(formData, "reason"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/admin/billing");
    return { message: "Gracia extendida." };
  });
}
