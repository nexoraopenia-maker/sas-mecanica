import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, withAdmin, withTenant } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { isValidRuc } from "@/lib/workshop/documents";
import {
  companyProfileSchema,
  operationsSchema,
  type CompanyProfileInput,
  type OperationsInput,
} from "@/lib/validation/company";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

export async function getCompanySettings(actor: AuthUser) {
  requirePermission(actor, "settings:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const [tenant, s, fiscal, sales] = await Promise.all([
      tx.tenant.findFirstOrThrow(),
      tx.tenantSettings.findFirstOrThrow(),
      tx.fiscalDocument.count(),
      tx.sale.count(),
    ]);
    return {
      profile: {
        legalName: tenant.legalName,
        tradeName: tenant.tradeName,
        taxId: tenant.taxId,
        address: tenant.address,
        phone: tenant.phone,
        contactName: tenant.contactName,
        contactEmail: tenant.contactEmail,
        billingEmail: tenant.billingEmail,
      },
      operations: {
        taxName: s.taxName,
        taxRate: s.taxRate.toString(),
        pricesIncludeTax: s.pricesIncludeTax,
        ticketWidthMm: s.ticketWidthMm,
        tireMaxAgeYears: s.tireMaxAgeYears,
        allowNegativeStock: s.allowNegativeStock,
        rotationWindowDays: s.rotationWindowDays,
        deadStockDays: s.deadStockDays,
        aiMinutesSavedPerLine: s.aiMinutesSavedPerLine,
        staffHourlyCost: s.staffHourlyCost.toString(),
        usdExchangeRate: s.usdExchangeRate.toString(),
      },
      locks: { taxId: fiscal > 0, pricesIncludeTax: sales > 0 },
    };
  });
}

export async function updateCompanyProfile(
  actor: AuthUser,
  input: CompanyProfileInput,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "settings:editar");
  const data = companyProfileSchema.parse(input);
  const tenantId = requireTenantId(actor);
  // La empresa solo LEE su ficha de plataforma (`tenants`); la escritura la hace el sistema, auditada a nombre de quien la pidió.
  const { before, fiscalDocs } = await withTenant(tenantId, async (tx) => ({
    before: await tx.tenant.findFirstOrThrow(),
    fiscalDocs: await tx.fiscalDocument.count(),
  }));
  if (data.taxId !== undefined && data.taxId !== before.taxId) {
    if (data.taxId !== null && !isValidRuc(data.taxId))
      throw new ConflictError("TAXID_INVALID", "RUC inválido (11 dígitos con dígito verificador)");
    if (fiscalDocs > 0)
      throw new ConflictError(
        "TAXID_LOCKED",
        "El RUC no se puede cambiar: ya hay comprobantes electrónicos emitidos con el actual",
      );
  }
  const patch = {
    legalName: data.legalName,
    ...(data.tradeName !== undefined ? { tradeName: data.tradeName } : {}),
    ...(data.taxId !== undefined ? { taxId: data.taxId } : {}),
    ...(data.address !== undefined ? { address: data.address } : {}),
    ...(data.phone !== undefined ? { phone: data.phone } : {}),
    ...(data.contactName !== undefined ? { contactName: data.contactName } : {}),
    ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail } : {}),
    ...(data.billingEmail !== undefined ? { billingEmail: data.billingEmail } : {}),
  };
  try {
    await withAdmin(
      { userId: null, reason: `Datos de la empresa editados por ${actor.email}`, tenantId },
      (db) =>
        db.$transaction(async (tx) => {
          await tx.tenant.update({ where: { id: tenantId }, data: patch });
          await tx.auditLog.create({
            data: {
              tenantId,
              actorType: "USER",
              actorUserId: actor.userId,
              action: "company.profile_changed",
              entityType: "tenant",
              entityId: tenantId,
              before: {
                legalName: before.legalName,
                tradeName: before.tradeName,
                taxId: before.taxId,
                address: before.address,
              },
              after: patch,
              ip: meta.ip ?? null,
              requestId: meta.requestId ?? null,
            },
          });
        }),
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictError("TAXID_TAKEN", "Ya existe otra empresa registrada con ese RUC");
    }
    throw error;
  }
}

/**
 * Parámetros operativos. «Precios incluyen IGV» no se puede invertir una vez que hay ventas: todos los
 * precios del catálogo cambiarían de significado de un día para otro.
 */
export async function updateOperations(
  actor: AuthUser,
  input: OperationsInput,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "settings:editar");
  const data = operationsSchema.parse(input);
  await withTenant(requireTenantId(actor), async (tx) => {
    const before = await tx.tenantSettings.findFirstOrThrow();
    if (
      data.pricesIncludeTax !== before.pricesIncludeTax &&
      ((await tx.sale.count()) > 0 || (await tx.quote.count()) > 0)
    ) {
      throw new ConflictError(
        "PRICES_LOCKED",
        "No se puede cambiar si los precios incluyen IGV: ya hay ventas o cotizaciones registradas",
      );
    }
    await tx.tenantSettings.update({ where: { id: before.id }, data });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "company.operations_changed",
      entityType: "tenant_settings",
      entityId: before.id,
      before: {
        taxRate: before.taxRate.toString(),
        pricesIncludeTax: before.pricesIncludeTax,
        ticketWidthMm: before.ticketWidthMm,
        allowNegativeStock: before.allowNegativeStock,
        deadStockDays: before.deadStockDays,
      },
      after: data,
    });
  });
}
