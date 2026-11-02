"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction, field, type ActionState } from "@/lib/action";
import { requirePlatformUser, requireUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { endImpersonation, startImpersonation } from "@/server/services/impersonation";
import { updatePlanLimits } from "@/server/services/plans";
import { readSessionClaims, startSession } from "@/server/services/session";
import {
  changeTenantPlan,
  createTenant,
  deleteTenant,
  reactivateTenant,
  suspendTenant,
} from "@/server/services/tenants";

const optional = (formData: FormData, name: string) => field(formData, name).trim() || undefined;
const limit = (formData: FormData, name: string) =>
  field(formData, name).trim() === "" ? null : field(formData, name);

export async function createTenantAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requirePlatformUser();
    const { tenantId } = await createTenant(
      actor,
      {
        legalName: field(formData, "legalName"),
        tradeName: optional(formData, "tradeName"),
        taxId: field(formData, "taxId"),
        country: optional(formData, "country"),
        currency: optional(formData, "currency"),
        address: optional(formData, "address"),
        phone: optional(formData, "phone"),
        contactEmail: optional(formData, "contactEmail"),
        planCode: field(formData, "planCode"),
        adminName: field(formData, "adminName"),
        adminEmail: field(formData, "adminEmail"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/admin/tenants");
    return { redirectTo: `/admin/tenants/${tenantId}` };
  });
}

export async function tenantStatusAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requirePlatformUser();
    const input = { tenantId: field(formData, "tenantId"), reason: field(formData, "reason") };
    const meta = await getRequestMeta();
    const intent = field(formData, "intent");
    if (intent === "suspend") await suspendTenant(actor, input, meta);
    else if (intent === "reactivate") await reactivateTenant(actor, input, meta);
    else if (intent === "delete") await deleteTenant(actor, input, meta);
    else return { error: "Acción desconocida" };
    revalidatePath(`/admin/tenants/${input.tenantId}`);
    return { message: "Estado actualizado." };
  });
}

export async function changePlanAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requirePlatformUser();
    await changeTenantPlan(
      actor,
      {
        tenantId: field(formData, "tenantId"),
        planCode: field(formData, "planCode"),
        reason: field(formData, "reason"),
      },
      await getRequestMeta(),
    );
    revalidatePath(`/admin/tenants/${field(formData, "tenantId")}`);
    return { message: "Plan actualizado." };
  });
}

export async function updatePlanAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requirePlatformUser();
    await updatePlanLimits(
      actor,
      {
        planId: field(formData, "planId"),
        priceMonthly: field(formData, "priceMonthly"),
        maxBranches: limit(formData, "maxBranches"),
        maxUsers: limit(formData, "maxUsers"),
        maxWarehouses: limit(formData, "maxWarehouses"),
        monthlyAiTokens: limit(formData, "monthlyAiTokens"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/admin/plans");
    return { message: "Plan guardado." };
  });
}

export async function startImpersonationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const actor = await requirePlatformUser();
    const claims = await readSessionClaims();
    if (!claims) return { redirectTo: "/login" };
    const tenantId = field(formData, "tenantId");
    const { sessionId } = await startImpersonation(
      actor,
      { tenantId, reason: field(formData, "reason") },
      await getRequestMeta(),
    );
    await startSession({
      sub: actor.userId,
      tid: tenantId,
      sv: claims.sv,
      mfa: true,
      imp: sessionId,
    });
    return { redirectTo: "/app" };
  });
}

export async function endImpersonationAction(): Promise<void> {
  const user = await requireUser();
  const claims = await readSessionClaims();
  if (!claims?.imp || !user.impersonation) redirect("/app");
  const tenantId = claims.tid;
  await endImpersonation(user, claims.imp, await getRequestMeta());
  await startSession({ sub: claims.sub, tid: null, sv: claims.sv, mfa: true });
  redirect(tenantId ? `/admin/tenants/${tenantId}` : "/admin");
}
