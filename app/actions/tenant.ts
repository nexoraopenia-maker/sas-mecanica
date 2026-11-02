"use server";

import { revalidatePath } from "next/cache";
import { runAction, field, type ActionState } from "@/lib/action";
import { requireTenantUser } from "@/lib/auth/guards";
import { getRequestMeta } from "@/lib/http";
import { createRole, deleteRole, setRolePermissions } from "@/server/services/roles";
import { changeUserRole, inviteUser, resendInvite, setUserStatus } from "@/server/services/users";

export async function inviteUserAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const user = await requireTenantUser();
    await inviteUser(
      user,
      {
        email: field(formData, "email"),
        name: field(formData, "name"),
        roleId: field(formData, "roleId"),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/users");
    return { message: "Invitación enviada por correo." };
  });
}

export async function resendInviteAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await resendInvite(
      await requireTenantUser(),
      field(formData, "userId"),
      await getRequestMeta(),
    );
    return { message: "Invitación reenviada." };
  });
}

export async function userStatusAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const status = field(formData, "status") === "DISABLED" ? "DISABLED" : "ACTIVE";
    await setUserStatus(
      await requireTenantUser(),
      field(formData, "userId"),
      status,
      await getRequestMeta(),
    );
    revalidatePath("/app/users");
    return { message: status === "DISABLED" ? "Usuario deshabilitado." : "Usuario habilitado." };
  });
}

export async function changeRoleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await changeUserRole(
      await requireTenantUser(),
      field(formData, "userId"),
      field(formData, "roleId"),
      await getRequestMeta(),
    );
    revalidatePath("/app/users");
    return { message: "Rol actualizado." };
  });
}

export async function createRoleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await createRole(
      await requireTenantUser(),
      {
        name: field(formData, "name"),
        description: field(formData, "description") || undefined,
        permissions: formData.getAll("permissions").map(String),
      },
      await getRequestMeta(),
    );
    revalidatePath("/app/roles");
    return { message: "Rol creado." };
  });
}

export async function rolePermissionsAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await setRolePermissions(
      await requireTenantUser(),
      field(formData, "roleId"),
      formData.getAll("permissions").map(String),
      await getRequestMeta(),
    );
    revalidatePath("/app/roles");
    return { message: "Permisos guardados." };
  });
}

export async function deleteRoleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    await deleteRole(await requireTenantUser(), field(formData, "roleId"), await getRequestMeta());
    revalidatePath("/app/roles");
    return { message: "Rol eliminado." };
  });
}
