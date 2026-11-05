"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { approveDraft, rejectDraft } from "@/server/services/ai-drafts";
import {
  sendTestMessage,
  updateAiSettings,
  updateChannelSettings,
} from "@/server/services/ai-settings";
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  markInTransit,
  receivePurchaseOrder,
  sendPurchaseOrder,
} from "@/server/services/purchasing";
import { updateAutomationSwitches } from "@/server/services/ai-settings";
import { runAgentNow } from "@/server/services/purchasing-agent";
import { createSupplier } from "@/server/services/suppliers";
import { getAppUrl } from "@/lib/app-url";
import { withTenant } from "@/lib/db";

const opt = (formData: FormData, name: string): string | undefined =>
  field(formData, name).trim() || undefined;
const optNumber = (formData: FormData, name: string): string | null | undefined => {
  if (!formData.has(name)) return undefined;
  const value = field(formData, name).trim();
  return value === "" ? null : value;
};

export async function runAgentAction(_previous: ActionState): Promise<ActionState> {
  return runAction(async () => {
    const result = await runAgentNow(await requireTenantUser(), await getRequestMeta());
    revalidatePath("/app/configuracion");
    if (result.status === "BLOCKED_BUDGET")
      return { error: "Presupuesto de IA agotado: el agente no se ejecutó." };
    if (result.status === "FAILED")
      return { error: `La corrida falló: ${result.message ?? "error desconocido"}` };
    return {
      message:
        result.draftIds.length > 0
          ? `${result.draftIds.length} pedido(s) propuesto(s) en la bandeja.`
          : (result.message ?? "No hay productos que reponer."),
    };
  });
}

export async function approveDraftAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const approved = await approveDraft(
      await requireTenantUser(),
      { draftId: field(formData, "draftId"), confirmViolations: formData.get("confirm") === "on" },
      await getRequestMeta(),
    );
    revalidatePath("/app/purchasing");
    // El borrador sale de la bandeja: el aviso debe vivir en la página, no en su formulario.
    return {
      redirectTo: `/app/configuracion?tab=ia&aprobada=${approved.number}&sim=${approved.delivery === "SIMULATED" ? 1 : 0}`,
    };
  });
}

export async function rejectDraftAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await rejectDraft(
      await requireTenantUser(),
      field(formData, "draftId"),
      field(formData, "reason"),
      await getRequestMeta(),
    );
    return { redirectTo: "/app/configuracion?tab=ia&rechazada=1" };
  });
}

export async function updateAiSettingsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await updateAiSettings(
      await requireTenantUser(),
      {
        apiKey: opt(formData, "apiKey"),
        clearApiKey: formData.get("clearApiKey") === "on",
        model: opt(formData, "model"),
        tone: field(formData, "tone"),
        mode: field(formData, "mode") === "AUTOMATIC" ? "AUTOMATIC" : "DRAFT_APPROVAL",
        monthlyTokenCap: optNumber(formData, "monthlyTokenCap"),
        monthlyCostCapUsd: optNumber(formData, "monthlyCostCapUsd"),
        maxOrderAmount: optNumber(formData, "maxOrderAmount"),
        maxQtyPerSku: optNumber(formData, "maxQtyPerSku"),
        maxOrdersPerDay: opt(formData, "maxOrdersPerDay"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/configuracion");
    return { message: "Configuración de IA guardada." };
  });
}

export async function updateChannelsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireTenantUser();
    const provider = field(formData, "whatsappProvider");
    const { inboundSecret } = await updateChannelSettings(
      user,
      {
        whatsappProvider:
          provider === "N8N" || provider === "EVOLUTION" || provider === "BUSINESS"
            ? provider
            : null,
        whatsappWebhookUrl: field(formData, "whatsappWebhookUrl"),
        whatsappApiKey: opt(formData, "whatsappApiKey"),
        rotateInboundSecret: formData.get("rotateInboundSecret") === "on",
        smtpHost: field(formData, "smtpHost"),
        smtpPort: optNumber(formData, "smtpPort"),
        smtpSecure: formData.get("smtpSecure") === "on",
        smtpUser: field(formData, "smtpUser"),
        smtpPassword: opt(formData, "smtpPassword"),
        smtpFromAddress: field(formData, "smtpFromAddress"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/configuracion");
    if (inboundSecret) {
      const tenantId = user.tenantId ?? "";
      return {
        message: `Canales guardados. Secreto para webhooks entrantes (cópialo ahora, no se vuelve a mostrar): ${inboundSecret} — URL: ${getAppUrl()}/api/webhooks/supplier/${tenantId}`,
      };
    }
    return { message: "Canales guardados." };
  });
}

export async function testMessageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const result = await sendTestMessage(
      await requireTenantUser(),
      {
        channel: field(formData, "channel") === "EMAIL" ? "EMAIL" : "WHATSAPP",
        to: field(formData, "to"),
      },
      await getRequestMeta(),
    );
    return result.status === "FAILED" ? { error: result.detail } : { message: result.detail };
  });
}

export async function createSupplierAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await createSupplier(
      await requireTenantUser(),
      {
        name: field(formData, "name"),
        taxId: opt(formData, "taxId"),
        whatsapp: opt(formData, "whatsapp"),
        email: opt(formData, "email"),
        defaultLeadTimeDays: opt(formData, "defaultLeadTimeDays"),
        aiWhitelisted: formData.get("aiWhitelisted") === "on" ? true : undefined,
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/purchasing");
    return { message: "Proveedor creado." };
  });
}

export async function createOrderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireTenantUser();
    const warehouse = await withTenant(user.tenantId ?? "", (tx) =>
      tx.warehouse.findFirst({
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { code: "asc" }],
      }),
    );
    const order = await createPurchaseOrder(
      user,
      {
        supplierId: field(formData, "supplierId"),
        warehouseId: warehouse?.id ?? "",
        idempotencyKey: field(formData, "idempotencyKey") || randomUUID(),
        items: [
          {
            productId: field(formData, "productId"),
            quantity: field(formData, "quantity"),
            unitCost: field(formData, "unitCost"),
          },
        ],
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/purchasing");
    return { message: `Orden #${order.number} creada en borrador.` };
  });
}

export async function orderStepAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireTenantUser();
    const meta = await getRequestMeta();
    const orderId = field(formData, "orderId");
    const step = field(formData, "step");
    let message = "Listo.";
    if (step === "send") {
      const result = await sendPurchaseOrder(user, orderId, meta);
      message =
        result.delivery === "SIMULATED"
          ? "Solicitado (envío simulado en demo)."
          : "Solicitado: el mensaje quedó en cola de envío.";
    } else if (step === "transit") {
      await markInTransit(user, orderId, meta);
      message = "Marcada en camino.";
    } else if (step === "cancel") {
      await cancelPurchaseOrder(user, orderId, field(formData, "reason"), meta);
      message = "Orden cancelada.";
    } else if (step === "receive") {
      const items = await withTenant(user.tenantId ?? "", (tx) =>
        tx.purchaseOrderItem.findMany({ where: { orderId } }),
      );
      const result = await receivePurchaseOrder(
        user,
        {
          orderId,
          idempotencyKey: field(formData, "idempotencyKey") || randomUUID(),
          lines: items
            .filter((item) => item.qtyOrdered.gt(item.qtyReceived))
            .map((item) => ({ orderItemId: item.id })),
        },
        meta,
      );
      message =
        result.status === "RECEIVED" ? "Orden recibida completa." : "Recepción parcial registrada.";
    } else {
      return { error: "Acción desconocida" };
    }
    revalidatePath("/app/purchasing");
    return { message };
  });
}

export async function automationSwitchesAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await updateAutomationSwitches(
      await requireTenantUser(),
      {
        ...(formData.has("aiPresent")
          ? {
              aiAgentEnabled: formData.get("aiAgentEnabled") === "on",
              humanApproval: formData.get("humanApproval") === "on",
            }
          : {}),
        // El interruptor solo existe en pantalla si el cliente tiene WhatsApp; sin él no se toca ese ajuste.
        ...(formData.has("whatsappPresent")
          ? { whatsappNoticesEnabled: formData.get("whatsappNoticesEnabled") === "on" }
          : {}),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/configuracion");
    return { message: "Interruptores guardados." };
  });
}
