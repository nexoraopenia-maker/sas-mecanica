import { getAppClient } from "./raw.ts";
import type { $Enums } from "./generated/client.ts";

export interface LoginUserRow {
  id: string;
  tenantId: string | null;
  passwordHash: string | null;
  status: $Enums.UserStatus;
  isSuperAdmin: boolean;
  sessionVersion: number;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface AuthTokenRow {
  id: string;
  tenantId: string | null;
  userId: string;
  type: $Enums.AuthTokenType;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * Búsquedas previas a tener contexto de tenant (login, enlaces de correo).
 * Pasan por funciones SECURITY DEFINER porque RLS no permite resolver el
 * tenant a partir del correo/token.
 */
export async function findUserByEmail(email: string): Promise<LoginUserRow | null> {
  const rows = await getAppClient().$queryRaw<
    LoginUserRow[]
  >`SELECT * FROM auth_find_user_by_email(${email})`;
  return rows[0] ?? null;
}

export async function findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRow | null> {
  const rows = await getAppClient().$queryRaw<
    AuthTokenRow[]
  >`SELECT * FROM auth_find_token(${tokenHash})`;
  return rows[0] ?? null;
}

export interface WorkOrderTokenRow {
  id: string;
  tenantId: string;
  approvalTokenExpiresAt: Date | null;
}

/** Resuelve el tenant de una OT a partir del enlace de aprobación que recibió el cliente. */
export async function findWorkOrderByTokenHash(
  tokenHash: string,
): Promise<WorkOrderTokenRow | null> {
  const rows = await getAppClient().$queryRaw<
    WorkOrderTokenRow[]
  >`SELECT * FROM auth_find_work_order_by_token(${tokenHash})`;
  return rows[0] ?? null;
}
