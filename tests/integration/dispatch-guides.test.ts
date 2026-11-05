import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/auth/can";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import type { CreateDispatchGuideInput } from "@/lib/validation/dispatch";
import {
  setDispatchProviderForTests,
  type DispatchPayload,
} from "@/server/integrations/dispatch-provider";
import {
  createDispatchGuide,
  draftFromSale,
  draftFromTransfer,
  getDispatchGuide,
  listDispatchGuides,
  listGuideSources,
  voidDispatchGuide,
} from "@/server/services/dispatch-guides";
import { openCashSession } from "@/server/services/cash";
import { registerStockIn } from "@/server/services/inventory";
import { createSale } from "@/server/services/sales";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import { updateTenantModules } from "@/server/services/tenants";
import { requestTransfer } from "@/server/services/transfers";
import { bootstrapTenant, meta, superAdminUser } from "../helpers/auth.ts";
import { adminClient } from "../helpers/db.ts";
import { inventoryWorld, key, make, plain, type InventoryWorld } from "../helpers/inventory.ts";

function ruc(prefix10: string): string {
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix10[i]), 0);
  return `${prefix10}${(11 - (sum % 11)) % 10}`;
}
const CLIENT_RUC = ruc("2098765432");
const CARRIER_RUC = ruc("2011223344");

const guide = (over: Record<string, unknown> = {}): CreateDispatchGuideInput =>
  ({
    transferDate: new Date().toISOString().slice(0, 10),
    reason: "SALE",
    transportMode: "PRIVATE",
    driverDocNumber: "45871236",
    driverName: "Juan Pérez",
    driverLicense: "Q12345678",
    vehiclePlate: "ABC-123",
    grossWeightKg: "48.5",
    packages: 3,
    originAddress: "Av. Industrial 123, Ate",
    originUbigeo: "150103",
    destinationAddress: "Jr. Comercio 456, Miraflores",
    destinationUbigeo: "150122",
    recipientDocType: "RUC",
    recipientDocNumber: CLIENT_RUC,
    recipientName: "Cliente Destino SAC",
    items: [{ description: "Filtro de aceite", sku: "FIL-1", unit: "UND", quantity: "10" }],
    ...over,
  }) as CreateDispatchGuideInput;

describe("guías de remisión electrónicas (GRE remitente)", () => {
  let admin: PrismaClient;
  let sa: AuthUser;
  let w: InventoryWorld;
  let other: InventoryWorld;

  const refresh = async (userId: string, tenantId: string): Promise<AuthUser> => {
    const row = await admin.user.findUniqueOrThrow({ where: { id: userId } });
    const user = await resolveSession({
      sub: userId,
      tid: tenantId,
      sv: row.sessionVersion,
      mfa: true,
    });
    if (!user) throw new Error("sin sesión");
    return user;
  };

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    sa = await superAdminUser(admin);
    w = await inventoryWorld(admin, "pro");
    other = await inventoryWorld(admin, "pro");
    // RUC válido de la empresa (para los traslados entre establecimientos).
    await admin.tenant.update({ where: { id: w.tenantId }, data: { taxId: ruc("2055667788") } });
    // Proveedor simulado: las guías quedan aceptadas al emitirse.
    for (const tenantId of [w.tenantId, other.tenantId])
      await admin.tenantSettings.update({
        where: { tenantId },
        data: { invoiceProvider: "SIMULATED" },
      });
  }, 300_000);
  afterAll(async () => {
    await admin.$disconnect();
  });
  afterEach(() => setDispatchProviderForTests(null));

  it("emite una guía de transporte privado con serie y correlativo", async () => {
    const first = await createDispatchGuide(w.admin, guide(), meta());
    const second = await createDispatchGuide(w.admin, guide(), meta());
    expect(first).toMatchObject({ number: "T001-00000001", status: "ACCEPTED" });
    expect(second.number).toBe("T001-00000002");

    const detail = await getDispatchGuide(w.admin, first.id);
    expect(detail).toMatchObject({
      reason: "SALE",
      transportMode: "PRIVATE",
      driverDocNumber: "45871236",
      driverName: "Juan Pérez",
      driverLicense: "Q12345678",
      vehiclePlate: "ABC123",
      originUbigeo: "150103",
      destinationUbigeo: "150122",
      packages: 3,
      recipientDocNumber: CLIENT_RUC,
      carrierDocNumber: null,
    });
    expect(detail.grossWeightKg.toString()).toBe("48.5");
    expect(detail.hash).toBeTruthy();
    expect(detail.providerRef).toBe("SIM-GRE-T001-1");
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.quantity.toString()).toBe("10");
    expect(detail.createdById).toBe(w.admin.userId);
  });

  it("emite una guía de transporte público con RUC del transportista", async () => {
    const issued = await createDispatchGuide(
      w.admin,
      guide({
        transportMode: "PUBLIC",
        carrierDocNumber: CARRIER_RUC,
        carrierName: "Transportes Rápidos SAC",
        driverDocNumber: undefined,
        driverName: undefined,
        driverLicense: undefined,
        vehiclePlate: undefined,
      }),
      meta(),
    );
    const detail = await getDispatchGuide(w.admin, issued.id);
    expect(detail).toMatchObject({
      transportMode: "PUBLIC",
      carrierDocType: "RUC",
      carrierDocNumber: CARRIER_RUC,
      carrierName: "Transportes Rápidos SAC",
      driverDocNumber: null,
      vehiclePlate: null,
    });
  });

  it("envía al proveedor los códigos de los catálogos 18 y 20 de SUNAT", async () => {
    let seen: DispatchPayload | null = null;
    setDispatchProviderForTests(() => ({
      name: "FAKE",
      async submit(payload) {
        seen = payload;
        return {
          outcome: "ACCEPTED",
          providerRef: "X-1",
          hash: "h",
          xmlUrl: null,
          pdfUrl: null,
          cdrUrl: null,
          code: "0",
          message: null,
        };
      },
    }));
    await createDispatchGuide(w.admin, guide({ reason: "PURCHASE" }), meta());
    const payload = seen as unknown as DispatchPayload;
    expect(payload).toMatchObject({
      reasonCode: "02",
      transportModeCode: "02",
      grossWeightKg: "48.500",
      vehiclePlate: "ABC123",
      series: "T001",
    });
    expect(payload.issuerRuc).toBeTruthy();
    expect(payload.driver).toMatchObject({ dni: "45871236", license: "Q12345678" });
    expect(payload.items[0]).toMatchObject({ unit: "UND", quantity: "10.0000" });
  });

  it("una guía rechazada por el proveedor queda registrada con su motivo", async () => {
    setDispatchProviderForTests(() => ({
      name: "FAKE",
      async submit() {
        return {
          outcome: "REJECTED",
          providerRef: null,
          hash: null,
          xmlUrl: null,
          pdfUrl: null,
          cdrUrl: null,
          code: "2420",
          message: "Transportista no habilitado",
        };
      },
    }));
    const issued = await createDispatchGuide(w.admin, guide(), meta());
    expect(issued.status).toBe("REJECTED");
    const detail = await getDispatchGuide(w.admin, issued.id);
    expect(detail.errorMessage).toBe("Transportista no habilitado");
  });

  it("con un OSE real (sin adaptador de GRE) la guía queda pendiente de envío", async () => {
    await admin.tenantSettings.update({
      where: { tenantId: other.tenantId },
      data: { invoiceProvider: "HTTP" },
    });
    const issued = await createDispatchGuide(other.admin, guide(), meta());
    expect(issued.status).toBe("PENDING");
    await admin.tenantSettings.update({
      where: { tenantId: other.tenantId },
      data: { invoiceProvider: "SIMULATED" },
    });
  });

  it("valida con Zod antes de tocar la base y no consume correlativos", async () => {
    const before = await admin.dispatchGuide.count({ where: { tenantId: w.tenantId } });
    await expect(
      createDispatchGuide(w.admin, guide({ grossWeightKg: "0" }), meta()),
    ).rejects.toBeTruthy();
    await expect(
      createDispatchGuide(w.admin, guide({ vehiclePlate: undefined }), meta()),
    ).rejects.toBeTruthy();
    await expect(createDispatchGuide(w.admin, guide({ items: [] }), meta())).rejects.toBeTruthy();
    expect(await admin.dispatchGuide.count({ where: { tenantId: w.tenantId } })).toBe(before);
  });

  it("el traslado entre establecimientos solo puede ir a la propia empresa", async () => {
    await expect(
      createDispatchGuide(
        w.admin,
        guide({ reason: "TRANSFER_BETWEEN_ESTABLISHMENTS", recipientDocNumber: CLIENT_RUC }),
        meta(),
      ),
    ).rejects.toMatchObject({ code: "GRE_TRANSFER_RECIPIENT" });
  });

  it("valida que la venta, la transferencia y los productos existan en la empresa", async () => {
    const foreign = await make(other.admin, plain());
    await expect(
      createDispatchGuide(
        w.admin,
        guide({ items: [{ productId: foreign.id, description: "Ajeno", quantity: "1" }] }),
        meta(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createDispatchGuide(w.admin, guide({ saleId: randomUUID() }), meta()),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      createDispatchGuide(w.admin, guide({ transferId: randomUUID() }), meta()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("completa el SKU desde el catálogo cuando se elige un producto", async () => {
    const product = await make(w.admin, plain({ sku: "CAT-SKU-9" }));
    const issued = await createDispatchGuide(
      w.admin,
      guide({ items: [{ productId: product.id, description: product.name, quantity: "2" }] }),
      meta(),
    );
    const detail = await getDispatchGuide(w.admin, issued.id);
    expect(detail.items[0]).toMatchObject({ productId: product.id, sku: "CAT-SKU-9" });
  });

  it("lista las guías de la empresa (más recientes primero) y no filtra las de otra", async () => {
    const mine = await listDispatchGuides(w.admin);
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect(mine[0]?.number).toBe(
      `T001-${String(Math.max(...mine.map((g) => Number(g.number.slice(-8))))).padStart(8, "0")}`,
    );
    const theirs = await listDispatchGuides(other.admin);
    expect(theirs.every((row) => !mine.some((m) => m.id === row.id))).toBe(true);
    await expect(getDispatchGuide(other.admin, mine[0]?.id ?? "")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("cada empresa lleva su propio correlativo", async () => {
    const issued = await createDispatchGuide(other.admin, guide(), meta());
    expect(Number(issued.number.slice(-8))).toBeLessThan(
      (await listDispatchGuides(w.admin)).length + 1,
    );
    expect(issued.number.startsWith("T001-")).toBe(true);
  });

  it("anula una guía una sola vez y deja motivo y auditoría", async () => {
    const issued = await createDispatchGuide(w.admin, guide(), meta());
    await expect(
      voidDispatchGuide(w.admin, { guideId: issued.id, reason: "x" }, meta()),
    ).rejects.toBeTruthy();
    await voidDispatchGuide(
      w.admin,
      { guideId: issued.id, reason: "Datos del conductor errados" },
      meta(),
    );
    const detail = await getDispatchGuide(w.admin, issued.id);
    expect(detail).toMatchObject({ status: "VOIDED", voidReason: "Datos del conductor errados" });
    expect(detail.voidedAt).toBeInstanceOf(Date);
    await expect(
      voidDispatchGuide(w.admin, { guideId: issued.id, reason: "Otra vez" }, meta()),
    ).rejects.toMatchObject({ code: "GRE_ALREADY_VOIDED" });
    expect(
      await admin.auditLog.count({
        where: { tenantId: w.tenantId, action: "dispatch_guide.voided", entityId: issued.id },
      }),
    ).toBe(1);
    expect(
      await admin.auditLog.count({
        where: { tenantId: w.tenantId, action: "dispatch_guide.created", entityId: issued.id },
      }),
    ).toBe(1);
    // No se puede anular la guía de otra empresa.
    await expect(
      voidDispatchGuide(other.admin, { guideId: issued.id, reason: "Intento ajeno" }, meta()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("exige permisos de facturación para ver, emitir y anular", async () => {
    const issued = await createDispatchGuide(w.admin, guide(), meta());
    // El mecánico no tiene el módulo de facturación.
    await expect(listDispatchGuides(w.mechanic)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(createDispatchGuide(w.mechanic, guide(), meta())).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    // El cajero ve y emite, pero no anula (billing:editar).
    expect((await listDispatchGuides(w.cashier)).length).toBeGreaterThan(0);
    await expect(
      voidDispatchGuide(w.cashier, { guideId: issued.id, reason: "Sin permiso" }, meta()),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("si el módulo de Facturación SUNAT se apaga, las guías desaparecen", async () => {
    const t = await bootstrapTenant(admin, "pro", sa);
    await updateTenantModules(
      sa,
      {
        tenantId: t.tenantId,
        businessType: "MIXED",
        groups: ["core", "reports"],
        reason: "Prueba de módulos",
      },
      meta(),
    );
    const user = await refresh(t.adminId, t.tenantId);
    await expect(listDispatchGuides(user)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(createDispatchGuide(user, guide(), meta())).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("una cuenta sin RUC cargado no puede emitir guías", async () => {
    const t = await bootstrapTenant(admin, "pro", sa);
    await admin.tenant.update({ where: { id: t.tenantId }, data: { taxId: null } });
    await expect(createDispatchGuide(t.admin, guide(), meta())).rejects.toMatchObject({
      code: "ISSUER_RUC",
    });
  });

  describe("borradores desde una venta o una transferencia", () => {
    it("precarga una venta con sus bienes y el cliente como destinatario", async () => {
      const product = await make(w.admin, plain({ name: "Escobillas Bosch", sku: "ESC-9" }));
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: product.id,
          quantity: 10,
          unitCost: "8",
          idempotencyKey: key(),
        },
        meta(),
      );
      await openCashSession(w.admin, { openingAmount: "100" }, meta());
      const customer = await admin.customer.create({
        data: {
          tenantId: w.tenantId,
          docType: "RUC",
          docNumber: CLIENT_RUC,
          name: "Cliente Mayorista SAC",
          address: "Av. Los Olivos 999, Los Olivos",
        },
      });
      const sale = await createSale(
        w.admin,
        {
          customerId: customer.id,
          items: [{ productId: product.id, quantity: 3 }],
          payments: [{ method: "CASH", amount: "75" }],
          idempotencyKey: key(),
        } as Parameters<typeof createSale>[1],
        meta(),
      );
      const sources = await listGuideSources(w.admin);
      expect(sources.sales.some((row) => row.id === sale.id)).toBe(true);
      const draft = await draftFromSale(w.admin, sale.id);
      expect(draft).toMatchObject({
        reason: "SALE",
        saleId: sale.id,
        recipientDocType: "RUC",
        recipientDocNumber: CLIENT_RUC,
        recipientName: "Cliente Mayorista SAC",
        destinationAddress: "Av. Los Olivos 999, Los Olivos",
      });
      expect(draft.items).toEqual([
        expect.objectContaining({ productId: product.id, sku: "ESC-9", quantity: "3" }),
      ]);
      // La guía puede quedar vinculada a la venta.
      const issued = await createDispatchGuide(
        w.admin,
        guide({ saleId: sale.id, reason: "SALE", items: draft.items }),
        meta(),
      );
      expect(
        (await admin.dispatchGuide.findUniqueOrThrow({ where: { id: issued.id } })).saleId,
      ).toBe(sale.id);
      await expect(draftFromSale(other.admin, sale.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("precarga una transferencia: la propia empresa es la destinataria", async () => {
      const product = await make(w.admin, plain());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: product.id,
          quantity: 20,
          unitCost: "5",
          idempotencyKey: key(),
        },
        meta(),
      );
      const transfer = await requestTransfer(
        w.manager,
        {
          fromWarehouseId: w.warehouseId,
          toWarehouseId: w.warehouse2Id,
          items: [{ productId: product.id, quantity: 7 }],
        },
        meta(),
      );
      const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
      const draft = await draftFromTransfer(w.admin, transfer.id);
      expect(draft).toMatchObject({
        reason: "TRANSFER_BETWEEN_ESTABLISHMENTS",
        transferId: transfer.id,
        recipientDocType: "RUC",
        recipientDocNumber: tenant.taxId,
        recipientName: tenant.legalName,
      });
      expect(draft.items[0]).toMatchObject({ productId: product.id, quantity: "7" });
      await expect(draftFromTransfer(other.admin, transfer.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      // Emitir la guía con el RUC de la empresa: se acepta y queda vinculada a la transferencia.
      const issued = await createDispatchGuide(
        w.admin,
        guide({
          reason: "TRANSFER_BETWEEN_ESTABLISHMENTS",
          transferId: transfer.id,
          recipientDocType: "RUC",
          recipientDocNumber: tenant.taxId,
          recipientName: tenant.legalName,
          items: draft.items,
        }),
        meta(),
      );
      expect(
        (await admin.dispatchGuide.findUniqueOrThrow({ where: { id: issued.id } })).transferId,
      ).toBe(transfer.id);
    });
  });
});
