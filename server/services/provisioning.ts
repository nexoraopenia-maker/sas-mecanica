import { ROLE_TEMPLATES, permissionKey } from "@/lib/auth/permissions";
import type { AppModule, Prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

type Db = Prisma.TransactionClient;

export interface ProvisionInput {
  planCode: string;
  legalName: string;
  tradeName?: string | undefined;
  taxIdType?: string | undefined;
  taxId?: string | null | undefined;
  country?: string | undefined;
  currency?: string | undefined;
  timezone?: string | undefined;
  address?: string | undefined;
  phone?: string | undefined;
  contactName?: string | undefined;
  contactEmail?: string | undefined;
  isDemo?: boolean;
  demoExpiresAt?: Date;
  demoSessionKey?: string;
  /** Solo SuperAdmin puede usar planes ocultos (demo). */
  allowHiddenPlan?: boolean;
  aiMonthlyTokenCap?: number;
  businessType?: "AUTOPARTS" | "WORKSHOP" | "MIXED";
  /** Módulos del plan que arrancan apagados para este cliente. */
  disabledModules?: AppModule[];
}

export interface ProvisionedTenant {
  tenantId: string;
  planId: string;
  branchId: string;
  warehouseId: string;
  roleIds: Record<"admin" | "warehouse_manager" | "cashier" | "mechanic", string>;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Crea la base de un tenant dentro de la transacción del llamador: empresa,
 * configuración, suscripción, los 4 roles base con sus permisos, la sucursal
 * principal y el almacén por defecto. Usa el cliente privilegiado.
 */
export async function provisionTenantBase(
  db: Db,
  input: ProvisionInput,
): Promise<ProvisionedTenant> {
  const plan = await db.plan.findFirst({ where: { code: input.planCode, deletedAt: null } });
  if (!plan || (!plan.isActive && !input.allowHiddenPlan)) throw new NotFoundError("Plan");

  const tenant = await db.tenant.create({
    data: {
      legalName: input.legalName,
      tradeName: input.tradeName ?? null,
      taxIdType: input.taxIdType ?? "RUC",
      taxId: input.taxId ?? null,
      country: input.country ?? "PE",
      currency: input.currency ?? plan.currency,
      timezone: input.timezone ?? "America/Lima",
      address: input.address ?? null,
      phone: input.phone ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      planId: plan.id,
      isDemo: input.isDemo ?? false,
      businessType: input.businessType ?? "MIXED",
      demoExpiresAt: input.demoExpiresAt ?? null,
      demoSessionKey: input.demoSessionKey ?? null,
    },
  });
  const tenantId = tenant.id;

  await db.tenantSettings.create({
    data: {
      tenantId,
      aiMonthlyTokenCap: input.aiMonthlyTokenCap ?? null,
      disabledModules: input.disabledModules ?? [],
    },
  });
  const now = new Date();
  await db.subscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: input.isDemo ? "TRIALING" : "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + (input.isDemo ? 1 : 30) * DAY),
    },
  });

  const permissions = await db.permission.findMany();
  const idByKey = new Map(permissions.map((p) => [permissionKey(p.module, p.action), p.id]));
  const roleIds: Partial<ProvisionedTenant["roleIds"]> = {};
  for (const template of ROLE_TEMPLATES) {
    const role = await db.role.create({
      data: {
        tenantId,
        key: template.key,
        name: template.name,
        description: template.description,
        isSystem: true,
        maxDiscountPercent: template.maxDiscountPercent,
      },
    });
    roleIds[template.key] = role.id;
    const links = template.permissions.flatMap((key) => {
      const permissionId = idByKey.get(key);
      return permissionId ? [{ tenantId, roleId: role.id, permissionId }] : [];
    });
    await db.rolePermission.createMany({ data: links });
  }

  const branch = await db.branch.create({
    data: { tenantId, code: "PRINCIPAL", name: "Sucursal principal", isMain: true },
  });
  const warehouse = await db.warehouse.create({
    data: {
      tenantId,
      branchId: branch.id,
      code: "ALM-1",
      name: "Almacén principal",
      isDefault: true,
    },
  });

  return {
    tenantId,
    planId: plan.id,
    branchId: branch.id,
    warehouseId: warehouse.id,
    roleIds: roleIds as ProvisionedTenant["roleIds"],
  };
}
