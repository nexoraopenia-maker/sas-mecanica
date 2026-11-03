"use server";

import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { ConflictError } from "@/lib/errors";
import { getRequestMeta } from "@/lib/http";
import { MAX_PHOTO_BYTES, sniffImage } from "@/lib/workshop/image";
import { RECEPTION_CHECKLIST } from "@/lib/workshop/reception-checklist";
import { createCustomer } from "@/server/services/customers";
import { createReminder, completeReminder } from "@/server/services/reminders";
import { createVehicle } from "@/server/services/vehicles";
import {
  createClaim,
  createWarrantyPolicy,
  decideClaim,
  resolveClaim,
  startEvaluation,
} from "@/server/services/warranties";
import {
  approveInPerson,
  decideByToken,
  requestApproval,
} from "@/server/services/work-order-approval";
import {
  addItem,
  addPhoto,
  assignMechanic,
  cancelWorkOrder,
  createWorkOrder,
  deliverWorkOrder,
  issuePart,
  markReady,
  removeItem,
  reopen,
  returnPart,
  saveDiagnosis,
  startDiagnosis,
  startRepair,
} from "@/server/services/work-orders";

const opt = (formData: FormData, name: string): string | undefined =>
  field(formData, name).trim() || undefined;
const checked = (formData: FormData, name: string): boolean => formData.get(name) === "on";

/** Máximo de fotos al recibir el vehículo (se pueden agregar más después desde la orden). */
const MAX_INTAKE_PHOTOS = 4;

async function readIntakePhotos(formData: FormData): Promise<Uint8Array[]> {
  const files = formData
    .getAll("photos")
    .filter((value): value is File => value instanceof File && value.size > 0);
  if (files.length > MAX_INTAKE_PHOTOS)
    throw new ConflictError(
      "PHOTO_LIMIT",
      `Máximo ${MAX_INTAKE_PHOTOS} fotos al recibir; agrega el resto desde la orden`,
    );
  const result: Uint8Array[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_PHOTO_BYTES)
      throw new ConflictError("PHOTO_SIZE", "Cada foto debe pesar como máximo 5 MB");
    if (!sniffImage(bytes))
      throw new ConflictError("PHOTO_TYPE", "Solo se aceptan fotos JPG, PNG o WebP");
    result.push(bytes);
  }
  return result;
}

export async function receptionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireTenantUser();
    // Las fotos de ingreso se validan por contenido ANTES de abrir la orden: si una no sirve, no queda una OT a medias.
    const photos = await readIntakePhotos(formData);
    const customerDoc = opt(formData, "docNumber");
    const created = await createWorkOrder(
      user,
      {
        plate: field(formData, "plate"),
        ...(customerDoc
          ? {
              newCustomer: {
                docType: (field(formData, "docType") || "DNI") as "DNI",
                docNumber: customerDoc,
                name: field(formData, "customerName"),
                whatsapp: opt(formData, "whatsapp"),
                whatsappOptIn: checked(formData, "optIn"),
              },
            }
          : {}),
        newVehicle: {
          make: opt(formData, "make"),
          model: opt(formData, "model"),
          year: opt(formData, "year") as never,
        },
        mileageIn: field(formData, "mileageIn"),
        confirmLowerMileage: checked(formData, "confirmLowerMileage"),
        fuelLevelEighths: field(formData, "fuel"),
        complaint: field(formData, "complaint"),
        promisedAt: opt(formData, "promisedAt") as never,
        checklist: RECEPTION_CHECKLIST.map((entry) => ({
          category: entry.category,
          label: entry.label,
          checked: checked(formData, entry.id),
        })),
      },
      await getRequestMeta(),
    );
    for (const [index, bytes] of photos.entries()) {
      await addPhoto(
        user,
        created.id,
        { kind: "INTAKE", caption: `Ingreso ${index + 1}`, bytes },
        await getRequestMeta(),
      );
    }
    revalidatePath("/app/workshop");
    return { redirectTo: `/app/workshop/${created.id}` };
  });
}

export async function addItemAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "workOrderId");
    const result = await addItem(
      await requireTenantUser(),
      id,
      {
        type: field(formData, "type") === "PART" ? "PART" : "LABOR",
        productId: opt(formData, "productId"),
        description: opt(formData, "description"),
        quantity: field(formData, "quantity") || "1",
        unitPrice: opt(formData, "unitPrice"),
        discount: opt(formData, "discount"),
        warrantyPolicyId: opt(formData, "warrantyPolicyId"),
      },
      await getRequestMeta(),
    );
    revalidatePath(`/app/workshop/${id}`);
    return {
      message: result.opensNewRound
        ? "Agregado en una ronda nueva: el cliente debe aprobarla."
        : "Ítem agregado.",
    };
  });
}

export async function removeItemAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "workOrderId");
    await removeItem(
      await requireTenantUser(),
      id,
      field(formData, "itemId"),
      await getRequestMeta(),
    );
    revalidatePath(`/app/workshop/${id}`);
    return { message: "Ítem quitado." };
  });
}

export async function issuePartAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "workOrderId");
    const serial = opt(formData, "serial");
    await issuePart(
      await requireTenantUser(),
      id,
      field(formData, "itemId"),
      { ...(serial ? { serials: [serial] } : {}) },
      await getRequestMeta(),
    );
    revalidatePath(`/app/workshop/${id}`);
    return { message: "Repuesto entregado desde el almacén." };
  });
}

export async function returnPartAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "workOrderId");
    await returnPart(
      await requireTenantUser(),
      id,
      field(formData, "itemId"),
      field(formData, "reason"),
      await getRequestMeta(),
    );
    revalidatePath(`/app/workshop/${id}`);
    return { message: "Repuesto devuelto al almacén." };
  });
}

/** Pasos de la OT que solo necesitan el id (y, a veces, un texto o el kilometraje). */
export async function workOrderStepAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireTenantUser();
    const meta = await getRequestMeta();
    const id = field(formData, "workOrderId");
    const step = field(formData, "step");
    let message = "Listo.";
    switch (step) {
      case "assign":
        await assignMechanic(user, id, field(formData, "mechanicId"), meta);
        message = "Mecánico asignado.";
        break;
      case "diagnose":
        await startDiagnosis(user, id, meta);
        message = "Diagnóstico iniciado.";
        break;
      case "saveDiagnosis":
        await saveDiagnosis(user, id, field(formData, "diagnosis"), meta);
        message = "Diagnóstico guardado.";
        break;
      case "requestApproval": {
        const result = await requestApproval(user, id, meta);
        message = `Presupuesto enviado (${result.notified === "SIMULATED" ? "simulado" : result.notified === "QUEUED" ? "por WhatsApp" : "sin WhatsApp: el cliente no tiene consentimiento o número"}). Enlace de aprobación (vence en 7 días): ${result.link}`;
        break;
      }
      case "startRepair":
        await startRepair(user, id, meta);
        message = "Reparación iniciada.";
        break;
      case "ready": {
        const result = await markReady(user, id, meta);
        revalidatePath("/app/workshop");
        // El formulario desaparece al cambiar de estado: el aviso viaja por la URL (solo códigos fijos).
        return {
          redirectTo: `/app/workshop/${id}?aviso=${
            result.customerNotified === "SKIPPED_NO_CONSENT" ||
            result.customerNotified === "SKIPPED_NO_CONTACT" ||
            result.customerNotified === "SKIPPED_DISABLED"
              ? "lista_sin_aviso"
              : "lista"
          }`,
        };
      }
      case "reopen":
        await reopen(user, id, field(formData, "reason"), meta);
        message = "Orden reabierta.";
        break;
      case "cancel":
        await cancelWorkOrder(
          user,
          id,
          field(formData, "reason"),
          { returnParts: checked(formData, "returnParts") },
          meta,
        );
        message = "Orden cancelada.";
        break;
      case "deliver": {
        const result = await deliverWorkOrder(
          user,
          {
            workOrderId: id,
            mileageOut: field(formData, "mileageOut"),
            notes: opt(formData, "notes"),
          },
          meta,
        );
        revalidatePath("/app/workshop");
        return {
          redirectTo: `/app/workshop/${id}?aviso=entregada&g=${result.warranties}&r=${result.reminders}`,
        };
      }
      default:
        return { error: "Acción no reconocida." };
    }
    revalidatePath(`/app/workshop/${id}`);
    revalidatePath("/app/workshop");
    return { message };
  });
}

export async function approveInPersonAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "workOrderId");
    const result = await approveInPerson(
      await requireTenantUser(),
      {
        workOrderId: id,
        name: field(formData, "name"),
        signatureDataUrl: field(formData, "signature"),
        rejectedItemIds: formData
          .getAll("rejected")
          .filter((v): v is string => typeof v === "string"),
      },
      await getRequestMeta(),
    );
    revalidatePath(`/app/workshop/${id}`);
    return { message: `Aprobado con firma (${result.approved} ítem(s)).` };
  });
}

export async function photoAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const id = field(formData, "workOrderId");
    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) return { error: "Elige una foto." };
    const kind = field(formData, "kind");
    await addPhoto(
      await requireTenantUser(),
      id,
      {
        kind: kind === "INTAKE" || kind === "PROGRESS" || kind === "DELIVERY" ? kind : "DAMAGE",
        caption: opt(formData, "caption"),
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
      await getRequestMeta(),
    );
    revalidatePath(`/app/workshop/${id}`);
    return { message: "Foto guardada." };
  });
}

/** Decisión del cliente desde el enlace público (sin sesión). */
export async function decideByTokenAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const decision = field(formData, "decision") === "REJECT" ? "REJECT" : "APPROVE";
    const result = await decideByToken(
      {
        token: field(formData, "token"),
        decision,
        name: field(formData, "name"),
        rejectedItemIds: formData
          .getAll("rejected")
          .filter((v): v is string => typeof v === "string"),
      },
      await getRequestMeta(),
    );
    return {
      message:
        decision === "APPROVE"
          ? `¡Gracias! Aprobaste ${result.approved} trabajo(s). El taller ya puede continuar.`
          : "Registramos tu rechazo. El taller se comunicará contigo.",
    };
  });
}

export async function createCustomerAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const created = await createCustomer(
      await requireTenantUser(),
      {
        docType: (field(formData, "docType") || "DNI") as "DNI",
        docNumber: field(formData, "docNumber"),
        name: field(formData, "name"),
        email: opt(formData, "email"),
        phone: opt(formData, "phone"),
        whatsapp: opt(formData, "whatsapp"),
        whatsappOptIn: checked(formData, "optIn"),
        address: opt(formData, "address"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/customers");
    return { redirectTo: `/app/customers/${created.id}` };
  });
}

export async function createVehicleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const customerId = field(formData, "customerId");
    await createVehicle(
      await requireTenantUser(),
      {
        customerId,
        plate: field(formData, "plate"),
        make: opt(formData, "make"),
        model: opt(formData, "model"),
        year: opt(formData, "year") as never,
        currentMileage: opt(formData, "currentMileage") as never,
      },
      await getRequestMeta(),
    );
    revalidatePath(`/app/customers/${customerId}`);
    return { message: "Vehículo registrado." };
  });
}

export async function createReminderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const vehicleId = field(formData, "vehicleId");
    await createReminder(
      await requireTenantUser(),
      {
        vehicleId,
        description: field(formData, "description"),
        dueDate: opt(formData, "dueDate") as never,
        dueMileage: opt(formData, "dueMileage") as never,
      },
      await getRequestMeta(),
    );
    revalidatePath(`/app/vehicles/${vehicleId}`);
    return { message: "Recordatorio creado." };
  });
}

export async function closeReminderAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await completeReminder(
      await requireTenantUser(),
      field(formData, "reminderId"),
      field(formData, "status") === "CANCELLED" ? "CANCELLED" : "DONE",
      await getRequestMeta(),
    );
    revalidatePath(`/app/vehicles/${field(formData, "vehicleId")}`);
    return { message: "Recordatorio cerrado." };
  });
}

export async function createPolicyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await createWarrantyPolicy(
      await requireTenantUser(),
      {
        name: field(formData, "name"),
        months: (opt(formData, "months") as never) ?? null,
        kilometers: (opt(formData, "kilometers") as never) ?? null,
        coversLabor: checked(formData, "coversLabor"),
        terms: opt(formData, "terms"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/warranties");
    return { message: "Política creada." };
  });
}

export async function createClaimAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const result = await createClaim(
      await requireTenantUser(),
      {
        warrantyId: field(formData, "warrantyId"),
        description: field(formData, "description"),
        mileage: opt(formData, "mileage") as never,
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/warranties");
    return { message: `Reclamo N.º ${result.number} registrado.` };
  });
}

export async function claimStepAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireTenantUser();
    const meta = await getRequestMeta();
    const claimId = field(formData, "claimId");
    const step = field(formData, "step");
    let message = "Listo.";
    if (step === "evaluate") {
      await startEvaluation(user, claimId, meta);
      message = "Evaluación iniciada.";
    } else if (step === "decide") {
      const decision = field(formData, "decision") === "REJECT" ? "REJECT" : "APPROVE";
      await decideClaim(
        user,
        {
          claimId,
          decision,
          evaluation: field(formData, "evaluation"),
          resolution:
            decision === "APPROVE"
              ? field(formData, "resolution") === "CREDIT_NOTE"
                ? "CREDIT_NOTE"
                : "REPLACEMENT"
              : undefined,
          overrideReason: opt(formData, "overrideReason"),
        },
        meta,
      );
      message = decision === "APPROVE" ? "Reclamo aprobado." : "Reclamo rechazado.";
    } else if (step === "resolve") {
      const result = await resolveClaim(
        user,
        { claimId, creditAmount: opt(formData, "creditAmount") as never },
        meta,
      );
      message = result.status === "RESOLVED" ? "Reclamo resuelto." : "Listo.";
    } else {
      return { error: "Acción no reconocida." };
    }
    revalidatePath("/app/warranties");
    return { message };
  });
}
