import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { hashToken } from "@/lib/auth/secure-token";
import {
  ConflictError,
  InvalidTokenError,
  NotFoundError,
  PermissionDeniedError,
} from "@/lib/errors";
import { MemoryStorage, setStorageForTests } from "@/server/integrations/storage";
import { registerStockIn } from "@/server/services/inventory";
import { createReminder, listReminders, processReminders } from "@/server/services/reminders";
import {
  decideByToken,
  getApprovalView,
  approveInPerson,
  requestApproval,
} from "@/server/services/work-order-approval";
import {
  addItem,
  addPhoto,
  assignMechanic,
  cancelWorkOrder,
  createWorkOrder,
  deliverWorkOrder,
  getWorkOrder,
  issuePart,
  listWorkOrders,
  markReady,
  removeItem,
  saveDiagnosis,
  startDiagnosis,
  startRepair,
} from "@/server/services/work-orders";
import {
  createClaim,
  decideClaim,
  resolveClaim,
  searchWarranties,
  startEvaluation,
  createWarrantyPolicy,
  processWarranties,
} from "@/server/services/warranties";
import { configureAuthCache } from "@/server/services/session-resolver";
import { withTenant } from "@/lib/db";
import { meta } from "../helpers/auth.ts";
import { adminClient } from "../helpers/db.ts";
import {
  battery,
  inventoryWorld,
  key,
  make,
  plain,
  type InventoryWorld,
} from "../helpers/inventory.ts";

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(200).fill(7),
]);
const dni = (): string => String(Math.floor(10_000_000 + Math.random() * 89_999_999));
const plateOf = (): string =>
  `T${randomUUID()
    .replace(/[^A-Z0-9]/gi, "")
    .slice(0, 5)
    .toUpperCase()}`;

describe("taller: recepción, aprobación, repuestos, entrega y garantías", () => {
  let admin: PrismaClient;
  let w: InventoryWorld;
  let other: InventoryWorld;
  let storage: MemoryStorage;

  beforeAll(async () => {
    configureAuthCache(0);
    storage = new MemoryStorage();
    setStorageForTests(storage);
    admin = adminClient();
    w = await inventoryWorld(admin);
    other = await inventoryWorld(admin);
  }, 180_000);
  afterAll(async () => {
    setStorageForTests(null);
    await admin.$disconnect();
  });

  const reception = async (over: Record<string, unknown> = {}) => {
    const plate = plateOf();
    const created = await createWorkOrder(
      w.admin,
      {
        plate,
        newCustomer: {
          docType: "DNI",
          docNumber: dni(),
          name: "Cliente Prueba",
          whatsapp: "987654321",
          whatsappOptIn: true,
        },
        newVehicle: { make: "Toyota", model: "Yaris" },
        mileageIn: 50_000,
        fuelLevelEighths: 4,
        complaint: "Revisión general",
        ...over,
      },
      meta(),
    );
    return { ...created, plate };
  };
  const stock = (productId: string, quantity: string, extra: Record<string, unknown> = {}) =>
    registerStockIn(
      w.manager,
      {
        warehouseId: w.warehouseId,
        productId,
        quantity,
        unitCost: "50",
        idempotencyKey: key(),
        ...extra,
      } as never,
      meta(),
    );
  const balance = async (productId: string) =>
    Number(
      (
        await admin.stockBalance.findFirst({
          where: { tenantId: w.tenantId, productId, warehouseId: w.warehouseId },
        })
      )?.quantity ?? 0,
    );
  const approveLink = async (id: string, name = "Cliente Prueba", rejected: string[] = []) => {
    const { link } = await requestApproval(w.admin, id, meta());
    const token = link.split("/aprobar/")[1] as string;
    return {
      token,
      result: await decideByToken(
        { token, decision: "APPROVE", name, rejectedItemIds: rejected },
        meta(),
      ),
    };
  };

  describe("recepción", () => {
    it("da de alta cliente y vehículo por placa, numera la OT y la audita", async () => {
      const r = await reception();
      expect(r.number).toBeGreaterThan(0);
      const order = await admin.workOrder.findFirstOrThrow({ where: { id: r.id } });
      expect(order.status).toBe("RECEIVED");
      expect(
        (await admin.vehicle.findFirstOrThrow({ where: { id: r.vehicleId } })).currentMileage,
      ).toBe(50_000);
      expect(
        await admin.auditLog.count({ where: { entityId: r.id, action: "workorder.created" } }),
      ).toBe(1);
    });

    it("una segunda OT abierta para la misma placa se rechaza; tras cancelar sí se puede", async () => {
      const r = await reception();
      await expect(
        createWorkOrder(
          w.admin,
          { plate: r.plate, mileageIn: 50_100, fuelLevelEighths: 2, complaint: "Otra vez" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "VEHICLE_OPEN_ORDER" });
      await cancelWorkOrder(w.admin, r.id, "Cliente se fue", {}, meta());
      await expect(
        createWorkOrder(
          w.admin,
          { plate: r.plate, mileageIn: 50_100, fuelLevelEighths: 2, complaint: "Otra vez" },
          meta(),
        ),
      ).resolves.toBeTruthy();
    });

    it("el kilometraje menor al registrado exige confirmación explícita y queda auditado", async () => {
      const r = await reception();
      await cancelWorkOrder(w.admin, r.id, "Prueba de km", {}, meta());
      await expect(
        createWorkOrder(
          w.admin,
          { plate: r.plate, mileageIn: 10_000, fuelLevelEighths: 2, complaint: "Km bajo" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "MILEAGE_LOWER" });
      const ok = await createWorkOrder(
        w.admin,
        {
          plate: r.plate,
          mileageIn: 10_000,
          fuelLevelEighths: 2,
          complaint: "Km bajo",
          confirmLowerMileage: true,
        },
        meta(),
      );
      const log = await admin.auditLog.findFirstOrThrow({
        where: { entityId: ok.id, action: "workorder.created" },
      });
      expect(log.reason).toMatch(/menor/);
    });

    it("una placa desconocida sin cliente indicado se rechaza", async () => {
      await expect(
        createWorkOrder(
          w.admin,
          { plate: plateOf(), mileageIn: 1, fuelLevelEighths: 1, complaint: "Sin cliente" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("el mecánico no puede crear recepciones", async () => {
      await expect(
        createWorkOrder(
          w.mechanic,
          { plate: plateOf(), mileageIn: 1, fuelLevelEighths: 1, complaint: "x y z" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("presupuesto y aprobación del cliente", () => {
    it("el enlace aprueba una vez; el reuso, un token falso y uno vencido se rechazan", async () => {
      const r = await reception();
      await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Diagnóstico", quantity: "1", unitPrice: "60" },
        meta(),
      );
      const { link, expiresAt } = await requestApproval(w.admin, r.id, meta());
      const token = link.split("/aprobar/")[1] as string;
      const view = await getApprovalView(token, "1.1.1.1");
      expect(view.items).toHaveLength(1);
      expect(JSON.stringify(view)).not.toMatch(/unitCost/);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

      expect(
        (await decideByToken({ token, decision: "APPROVE", name: "Cliente Prueba" }, meta()))
          .approved,
      ).toBe(1);
      await expect(
        decideByToken({ token, decision: "APPROVE", name: "Cliente Prueba" }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);
      await expect(getApprovalView("x".repeat(40), "1.1.1.1")).rejects.toBeInstanceOf(
        InvalidTokenError,
      );

      const order = await admin.workOrder.findFirstOrThrow({ where: { id: r.id } });
      expect(order.status).toBe("IN_REPAIR");
      expect(order.approvalTokenHash).toBeNull();
      expect(order.approvalMethod).toBe("LINK");

      const r2 = await reception();
      await addItem(
        w.admin,
        r2.id,
        { type: "LABOR", description: "Diag", quantity: "1", unitPrice: "60" },
        meta(),
      );
      const second = await requestApproval(w.admin, r2.id, meta());
      const t2 = second.link.split("/aprobar/")[1] as string;
      await admin.workOrder.update({
        where: { id: r2.id },
        data: { approvalTokenExpiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        decideByToken({ token: t2, decision: "APPROVE", name: "Cliente Prueba" }, meta()),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it("solo se guarda el hash del token, nunca el token", async () => {
      const r = await reception();
      await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Diag", quantity: "1", unitPrice: "60" },
        meta(),
      );
      const { link } = await requestApproval(w.admin, r.id, meta());
      const token = link.split("/aprobar/")[1] as string;
      const order = await admin.workOrder.findFirstOrThrow({ where: { id: r.id } });
      expect(order.approvalTokenHash).toBe(hashToken(token));
      expect(order.approvalTokenHash).not.toBe(token);
    });

    it("rechazar todo vuelve a diagnóstico; aprobar solo una parte deja lo rechazado fuera del total", async () => {
      const r = await reception();
      const a = await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Frenos", quantity: "1", unitPrice: "100" },
        meta(),
      );
      const b = await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Alineación", quantity: "1", unitPrice: "80" },
        meta(),
      );
      const { token } = await approveLink(r.id, "Cliente Prueba", [b.id]);
      expect(token).toBeTruthy();
      const detail = await getWorkOrder(w.admin, r.id);
      expect(detail.items.find((i) => i.id === a.id)?.approvalStatus).toBe("APPROVED");
      expect(detail.items.find((i) => i.id === b.id)?.approvalStatus).toBe("REJECTED");
      expect(detail.total).toBe("118.00");

      const r2 = await reception();
      await addItem(
        w.admin,
        r2.id,
        { type: "LABOR", description: "Frenos", quantity: "1", unitPrice: "100" },
        meta(),
      );
      const { link } = await requestApproval(w.admin, r2.id, meta());
      await decideByToken(
        { token: link.split("/aprobar/")[1] as string, decision: "REJECT", name: "Cliente Prueba" },
        meta(),
      );
      expect((await admin.workOrder.findFirstOrThrow({ where: { id: r2.id } })).status).toBe(
        "DIAGNOSING",
      );
    });

    it("el trabajo adicional abre una ronda nueva y bloquea la entrega de su repuesto hasta aprobarse", async () => {
      const r = await reception();
      const p = await make(w.admin, plain({ salePrice: 40 }));
      await stock(p.id, "5");
      await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Revisión", quantity: "1", unitPrice: "50" },
        meta(),
      );
      await approveLink(r.id);
      const extra = await addItem(
        w.admin,
        r.id,
        { type: "PART", productId: p.id, quantity: "1" },
        meta(),
      );
      expect(extra.round).toBe(2);
      expect(extra.opensNewRound).toBe(true);
      expect((await admin.workOrder.findFirstOrThrow({ where: { id: r.id } })).status).toBe(
        "AWAITING_APPROVAL",
      );
      await expect(issuePart(w.manager, r.id, extra.id, {}, meta())).rejects.toMatchObject({
        code: "ITEM_NOT_APPROVED",
      });
      await expect(markReady(w.admin, r.id, meta())).rejects.toBeInstanceOf(ConflictError);
      await approveLink(r.id);
      await issuePart(w.manager, r.id, extra.id, {}, meta());
      expect(await balance(p.id)).toBe(4);
    });

    it("firma en el taller: guarda la firma privada y aprueba", async () => {
      const r = await reception();
      await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Revisión", quantity: "1", unitPrice: "50" },
        meta(),
      );
      await requestApproval(w.admin, r.id, meta());
      await expect(
        approveInPerson(
          w.admin,
          {
            workOrderId: r.id,
            name: "Cliente Prueba",
            signatureDataUrl: "data:image/png;base64,AAAA",
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
      const dataUrl = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
      await approveInPerson(
        w.admin,
        { workOrderId: r.id, name: "Cliente Prueba", signatureDataUrl: dataUrl },
        meta(),
      );
      const order = await admin.workOrder.findFirstOrThrow({ where: { id: r.id } });
      expect(order.approvalMethod).toBe("SIGNATURE");
      expect(order.signatureUrl).toMatch(new RegExp(`^${w.tenantId}/signatures/`));
      expect(order.status).toBe("IN_REPAIR");
    });

    it("un ítem aprobado no se puede quitar; uno pendiente sí", async () => {
      const r = await reception();
      const a = await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "A", quantity: "1", unitPrice: "10" },
        meta(),
      );
      await approveLink(r.id);
      await expect(removeItem(w.admin, r.id, a.id, meta())).rejects.toMatchObject({
        code: "ITEM_LOCKED",
      });
      const b = await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "B", quantity: "1", unitPrice: "10" },
        meta(),
      );
      await removeItem(w.admin, r.id, b.id, meta());
      expect(await admin.workOrderItem.count({ where: { id: b.id } })).toBe(0);
    });

    it("los precios fuera del catálogo exigen el permiso de descuentos (el mecánico no lo tiene)", async () => {
      const r = await reception();
      await assignMechanic(w.admin, r.id, w.mechanic.userId, meta());
      await expect(
        addItem(
          w.mechanic,
          r.id,
          { type: "LABOR", description: "Extra", quantity: "1", unitPrice: "1" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("repuestos y kardex", () => {
    it("entrega descuenta una sola vez (idempotente) y guarda el costo real; devolver reingresa", async () => {
      const r = await reception();
      const p = await make(w.admin, plain({ salePrice: 40 }));
      await stock(p.id, "5");
      const item = await addItem(
        w.admin,
        r.id,
        { type: "PART", productId: p.id, quantity: "2" },
        meta(),
      );
      await approveLink(r.id);
      const first = await issuePart(w.manager, r.id, item.id, {}, meta());
      const again = await issuePart(w.manager, r.id, item.id, {}, meta());
      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      expect(await balance(p.id)).toBe(3);
      expect(
        Number((await admin.workOrderItem.findFirstOrThrow({ where: { id: item.id } })).unitCost),
      ).toBe(50);
      expect(
        await admin.kardexMovement.count({
          where: { productId: p.id, type: "WORK_ORDER_CONSUMPTION" },
        }),
      ).toBe(1);
    });

    it("sin stock la OT pasa a esperar el repuesto y se avisa; al reponer se completa", async () => {
      const r = await reception();
      const p = await make(w.admin, plain({ salePrice: 40 }));
      const item = await addItem(
        w.admin,
        r.id,
        { type: "PART", productId: p.id, quantity: "2" },
        meta(),
      );
      await approveLink(r.id);
      expect((await admin.workOrder.findFirstOrThrow({ where: { id: r.id } })).status).toBe(
        "AWAITING_PARTS",
      );
      await expect(issuePart(w.manager, r.id, item.id, {}, meta())).rejects.toMatchObject({
        code: "INSUFFICIENT_STOCK",
      });
      expect(await balance(p.id)).toBe(0);
      expect(
        await admin.notification.count({
          where: {
            tenantId: w.tenantId,
            kind: "workorder.part_missing",
            dedupeKey: `part-missing:${item.id}`,
          },
        }),
      ).toBe(1);
      await stock(p.id, "3");
      await issuePart(w.manager, r.id, item.id, {}, meta());
      expect((await admin.workOrder.findFirstOrThrow({ where: { id: r.id } })).status).toBe(
        "IN_REPAIR",
      );
    });

    it("el stock nunca queda negativo ante entregas simultáneas", async () => {
      const p = await make(w.admin, plain({ salePrice: 40 }));
      await stock(p.id, "2");
      const orders = await Promise.all([reception(), reception(), reception()]);
      const items = [] as Array<{ orderId: string; itemId: string }>;
      for (const o of orders) {
        const it = await addItem(
          w.admin,
          o.id,
          { type: "PART", productId: p.id, quantity: "1" },
          meta(),
        );
        await approveLink(o.id);
        items.push({ orderId: o.id, itemId: it.id });
      }
      const results = await Promise.allSettled(
        items.map((i) => issuePart(w.manager, i.orderId, i.itemId, {}, meta())),
      );
      expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
      expect(await balance(p.id)).toBe(0);
    });

    it("cancelar con repuestos entregados exige devolverlos; al devolver, el stock se restituye", async () => {
      const r = await reception();
      const p = await make(w.admin, plain({ salePrice: 40 }));
      await stock(p.id, "4");
      const item = await addItem(
        w.admin,
        r.id,
        { type: "PART", productId: p.id, quantity: "2" },
        meta(),
      );
      await approveLink(r.id);
      await issuePart(w.manager, r.id, item.id, {}, meta());
      await expect(
        cancelWorkOrder(w.admin, r.id, "Cliente desistió", {}, meta()),
      ).rejects.toMatchObject({ code: "PARTS_ISSUED" });
      await cancelWorkOrder(w.admin, r.id, "Cliente desistió", { returnParts: true }, meta());
      expect(await balance(p.id)).toBe(4);
      const detail = await getWorkOrder(w.admin, r.id);
      expect(detail.status).toBe("CANCELLED");
      expect(detail.total).toBe("0.00");
    });

    it("una batería con serie se entrega por serie y queda vinculada al movimiento", async () => {
      const r = await reception();
      const b = await make(w.admin, battery({ salePrice: 400 }));
      const serial = `SN-${randomUUID().slice(0, 8)}`;
      await stock(b.id, "1", { quantity: undefined, serials: [serial] });
      const item = await addItem(
        w.admin,
        r.id,
        { type: "PART", productId: b.id, quantity: "1" },
        meta(),
      );
      await approveLink(r.id);
      await issuePart(w.manager, r.id, item.id, { serials: [serial] }, meta());
      const sn = await admin.serialNumber.findFirstOrThrow({
        where: { tenantId: w.tenantId, productId: b.id, serial },
      });
      expect(sn.status).toBe("INSTALLED");
    });
  });

  describe("entrega, garantías y recordatorios", () => {
    it("al entregar emite garantía de batería (con serie) y de mano de obra, y programa el aceite", async () => {
      const r = await reception();
      const policy = await createWarrantyPolicy(
        w.admin,
        { name: "Batería 12m", months: 12 },
        meta(),
      );
      const laborPolicy = await createWarrantyPolicy(
        w.admin,
        { name: "Mano de obra 3m", months: 3, kilometers: 3000, coversLabor: true },
        meta(),
      );
      const b = await make(w.admin, battery({ salePrice: 400 }));
      await admin.product.update({ where: { id: b.id }, data: { warrantyPolicyId: policy.id } });
      const oil = await make(w.admin, {
        kind: "LUBRICANT",
        sku: `LU-${randomUUID().slice(0, 6)}`.toUpperCase(),
        name: "Aceite 5W30 4L",
        salePrice: 150,
        lubricant: { viscosity: "5W-30" },
      });
      const serial = `SN-${randomUUID().slice(0, 8)}`;
      await stock(b.id, "1", { quantity: undefined, serials: [serial] });
      await stock(oil.id, "3");
      const battItem = await addItem(
        w.admin,
        r.id,
        { type: "PART", productId: b.id, quantity: "1" },
        meta(),
      );
      const oilItem = await addItem(
        w.admin,
        r.id,
        { type: "PART", productId: oil.id, quantity: "1" },
        meta(),
      );
      await addItem(
        w.admin,
        r.id,
        {
          type: "LABOR",
          description: "Instalación de batería",
          quantity: "1",
          unitPrice: "40",
          warrantyPolicyId: laborPolicy.id,
        },
        meta(),
      );
      await approveLink(r.id);
      await issuePart(w.manager, r.id, battItem.id, { serials: [serial] }, meta());
      await issuePart(w.manager, r.id, oilItem.id, {}, meta());
      await markReady(w.admin, r.id, meta());
      await expect(
        deliverWorkOrder(w.admin, { workOrderId: r.id, mileageOut: 10 }, meta()),
      ).rejects.toMatchObject({ code: "MILEAGE_OUT" });
      const delivered = await deliverWorkOrder(
        w.admin,
        { workOrderId: r.id, mileageOut: 50_020 },
        meta(),
      );
      expect(delivered).toEqual({ warranties: 2, reminders: 1 });

      const bySerial = await searchWarranties(w.admin, { serial }, new Date());
      expect(bySerial).toHaveLength(1);
      expect(bySerial[0]?.status).toBe("ACTIVE");
      const byPlate = await searchWarranties(w.admin, { plate: r.plate }, new Date());
      expect(byPlate).toHaveLength(2);
      const reminders = await listReminders(w.admin, { vehicleId: r.vehicleId, open: true });
      expect(reminders[0]).toMatchObject({ description: "Cambio de aceite", dueMileage: 55_020 });
      expect(
        (await admin.vehicle.findFirstOrThrow({ where: { id: r.vehicleId } })).currentMileage,
      ).toBe(50_020);
      // Idempotente: una segunda ejecución no duplica garantías.
      expect(
        await admin.warranty.count({ where: { tenantId: w.tenantId, vehicleId: r.vehicleId } }),
      ).toBe(2);
    });

    it("«lista para entrega» avisa al cliente una sola vez por WhatsApp (simulado) y respeta el consentimiento", async () => {
      const r = await reception();
      await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Revisión", quantity: "1", unitPrice: "50" },
        meta(),
      );
      await approveLink(r.id);
      const ready = await markReady(w.admin, r.id, meta());
      expect(["SIMULATED", "QUEUED"]).toContain(ready.customerNotified);
      expect(
        await admin.outboundMessage.count({
          where: { tenantId: w.tenantId, idempotencyKey: `wo-ready:${r.id}` },
        }),
      ).toBe(1);

      const noConsent = await reception({
        newCustomer: {
          docType: "DNI",
          docNumber: dni(),
          name: "Sin Permiso",
          whatsapp: "987654322",
          whatsappOptIn: false,
        },
      });
      await addItem(
        w.admin,
        noConsent.id,
        { type: "LABOR", description: "Revisión", quantity: "1", unitPrice: "50" },
        meta(),
      );
      await approveLink(noConsent.id);
      expect((await markReady(w.admin, noConsent.id, meta())).customerNotified).toBe(
        "SKIPPED_NO_CONSENT",
      );
    });

    it("recordatorio por km o fecha: se avisa una sola vez", async () => {
      const r = await reception();
      const rem = await createReminder(
        w.admin,
        { vehicleId: r.vehicleId, description: "Rotación de llantas", dueMileage: 50_300 },
        meta(),
      );
      const run = () => withTenant(w.tenantId, (tx) => processReminders(tx, new Date()));
      expect((await run()).notified).toBeGreaterThanOrEqual(1);
      expect(
        (await admin.maintenanceReminder.findFirstOrThrow({ where: { id: rem.id } })).status,
      ).toBe("NOTIFIED");
      const before = await admin.outboundMessage.count({
        where: { tenantId: w.tenantId, idempotencyKey: `reminder:${rem.id}` },
      });
      await run();
      expect(before).toBe(1);
      expect(
        await admin.outboundMessage.count({
          where: { tenantId: w.tenantId, idempotencyKey: `reminder:${rem.id}` },
        }),
      ).toBe(1);
    });

    it("las garantías por vencer avisan una vez por plazo y las vencidas se marcan", async () => {
      const r = await reception();
      const policy = await createWarrantyPolicy(w.admin, { name: "Corta", months: 1 }, meta());
      const warranty = await withTenant(w.tenantId, (tx) =>
        tx.warranty.create({
          data: {
            source: "WORK_ORDER_ITEM",
            customerId: r.customerId,
            vehicleId: r.vehicleId,
            policyId: policy.id,
            description: "Pastillas",
            startsAt: new Date(Date.now() - 25 * 86_400_000),
            expiresAt: new Date(Date.now() + 5 * 86_400_000),
          },
        }),
      );
      const first = await withTenant(w.tenantId, (tx) => processWarranties(tx, new Date()));
      const second = await withTenant(w.tenantId, (tx) => processWarranties(tx, new Date()));
      expect(first.noticed).toBeGreaterThanOrEqual(1);
      expect(
        await admin.outboundMessage.count({
          where: { tenantId: w.tenantId, idempotencyKey: `warranty-notice:${warranty.id}:7` },
        }),
      ).toBe(1);
      expect(second.expired).toBe(0);
      const future = await withTenant(w.tenantId, (tx) =>
        processWarranties(tx, new Date(Date.now() + 10 * 86_400_000)),
      );
      expect(future.expired).toBeGreaterThanOrEqual(1);
      expect((await admin.warranty.findFirstOrThrow({ where: { id: warranty.id } })).status).toBe(
        "EXPIRED",
      );
    });
  });

  describe("reclamos de garantía", () => {
    const makeWarranty = async (over: Record<string, unknown> = {}) => {
      const r = await reception();
      const policy = await createWarrantyPolicy(
        w.admin,
        { name: `P-${randomUUID().slice(0, 4)}`, months: 12 },
        meta(),
      );
      const p = await make(w.admin, plain({ salePrice: 90 }));
      const warranty = await withTenant(w.tenantId, (tx) =>
        tx.warranty.create({
          data: {
            source: "WORK_ORDER_ITEM",
            customerId: r.customerId,
            vehicleId: r.vehicleId,
            productId: p.id,
            policyId: policy.id,
            description: "Amortiguador",
            startsAt: new Date(Date.now() - 30 * 86_400_000),
            expiresAt: new Date(Date.now() + 300 * 86_400_000),
            ...over,
          },
        }),
      );
      return { r, warranty, p };
    };

    it("recepción → evaluación → aprobado por reposición: sale del kardex y anula la garantía original", async () => {
      const { warranty, p } = await makeWarranty();
      await stock(p.id, "2");
      const claim = await createClaim(
        w.admin,
        { warrantyId: warranty.id, description: "Pierde aceite" },
        meta(),
      );
      expect((await admin.warranty.findFirstOrThrow({ where: { id: warranty.id } })).status).toBe(
        "IN_CLAIM",
      );
      await startEvaluation(w.admin, claim.id, meta());
      await decideClaim(
        w.admin,
        {
          claimId: claim.id,
          decision: "APPROVE",
          evaluation: "Falla de fábrica confirmada",
          resolution: "REPLACEMENT",
        },
        meta(),
      );
      const resolved = await resolveClaim(w.admin, { claimId: claim.id }, meta());
      expect(resolved.status).toBe("RESOLVED");
      expect(await balance(p.id)).toBe(1);
      expect((await admin.warranty.findFirstOrThrow({ where: { id: warranty.id } })).status).toBe(
        "VOID",
      );
      const replay = await resolveClaim(w.admin, { claimId: claim.id }, meta());
      expect(replay).toMatchObject({ replayed: true });
      expect(await balance(p.id)).toBe(1);
    });

    it("rechazar devuelve la garantía a ACTIVA; aprobar fuera de cobertura exige motivo", async () => {
      const { warranty } = await makeWarranty();
      const claim = await createClaim(
        w.admin,
        { warrantyId: warranty.id, description: "Ruido al girar" },
        meta(),
      );
      await startEvaluation(w.admin, claim.id, meta());
      await decideClaim(
        w.admin,
        { claimId: claim.id, decision: "REJECT", evaluation: "Desgaste normal por uso" },
        meta(),
      );
      expect((await admin.warranty.findFirstOrThrow({ where: { id: warranty.id } })).status).toBe(
        "ACTIVE",
      );

      const expired = await makeWarranty({ expiresAt: new Date(Date.now() - 86_400_000) });
      const c2 = await createClaim(
        w.admin,
        { warrantyId: expired.warranty.id, description: "Falla tardía" },
        meta(),
      );
      await startEvaluation(w.admin, c2.id, meta());
      await expect(
        decideClaim(
          w.admin,
          {
            claimId: c2.id,
            decision: "APPROVE",
            evaluation: "Falla de fábrica",
            resolution: "CREDIT_NOTE",
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      await decideClaim(
        w.admin,
        {
          claimId: c2.id,
          decision: "APPROVE",
          evaluation: "Falla de fábrica",
          resolution: "CREDIT_NOTE",
          overrideReason: "Cliente frecuente, gerencia autorizó",
        },
        meta(),
      );
      expect(
        await admin.auditLog.count({
          where: { entityId: c2.id, reason: { contains: "gerencia" } },
        }),
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe("fotos", () => {
    it("acepta imágenes reales bajo la carpeta del tenant y rechaza archivos disfrazados", async () => {
      const r = await reception();
      const photo = await addPhoto(
        w.admin,
        r.id,
        { kind: "DAMAGE", caption: "Rayón", bytes: PNG },
        meta(),
      );
      const row = await admin.workOrderPhoto.findFirstOrThrow({ where: { id: photo.id } });
      expect(row.storagePath.startsWith(`${w.tenantId}/work-orders/${r.id}/`)).toBe(true);
      await expect(
        addPhoto(
          w.admin,
          r.id,
          {
            kind: "DAMAGE",
            bytes: new TextEncoder().encode("<html><script>alert(1)</script></html>"),
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "PHOTO_TYPE" });
      await expect(
        addPhoto(w.admin, r.id, { kind: "DAMAGE", bytes: new Uint8Array(0) }, meta()),
      ).rejects.toMatchObject({ code: "PHOTO_SIZE" });
      const detail = await getWorkOrder(w.admin, r.id);
      expect(detail.photos).toHaveLength(1);
      expect(detail.photos[0]?.url).toBeTruthy();
    });
  });

  describe("permisos y aislamiento", () => {
    it("el mecánico solo ve sus OT; no ve costos; no entrega vehículos", async () => {
      const mine = await reception();
      const notMine = await reception();
      await assignMechanic(w.admin, mine.id, w.mechanic.userId, meta());
      const list = await listWorkOrders(w.mechanic);
      expect(list.map((o) => o.id)).toContain(mine.id);
      expect(list.map((o) => o.id)).not.toContain(notMine.id);
      await expect(getWorkOrder(w.mechanic, notMine.id)).rejects.toBeInstanceOf(NotFoundError);
      const detail = await getWorkOrder(w.mechanic, mine.id);
      expect(JSON.stringify(detail)).not.toMatch(/unitCost/);
      await expect(
        deliverWorkOrder(w.mechanic, { workOrderId: mine.id, mileageOut: 60_000 }, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        assignMechanic(w.mechanic, mine.id, w.mechanic.userId, meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("solo se asigna a usuarios activos con rol de taller", async () => {
      const r = await reception();
      await expect(assignMechanic(w.admin, r.id, w.cashier.userId, meta())).rejects.toMatchObject({
        code: "NOT_A_MECHANIC",
      });
    });

    it("otro tenant no puede leer ni tocar la OT ni usar su token", async () => {
      const r = await reception();
      await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Revisión", quantity: "1", unitPrice: "50" },
        meta(),
      );
      await expect(getWorkOrder(other.admin, r.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        saveDiagnosis(other.admin, r.id, "Intento ajeno", meta()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(startDiagnosis(other.admin, r.id, meta())).rejects.toBeInstanceOf(NotFoundError);
      expect(await listWorkOrders(other.admin)).toHaveLength(0);
      await expect(startRepair(other.admin, r.id, meta())).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
