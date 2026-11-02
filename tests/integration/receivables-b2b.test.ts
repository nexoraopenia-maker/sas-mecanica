import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { withTenant } from "@/lib/db";
import { createCustomer } from "@/server/services/customers";
import {
  collectReceivable,
  listReceivables,
  processReceivables,
} from "@/server/services/receivables";
import { convertWorkOrderToSale, createSale } from "@/server/services/sales";
import { configureAuthCache } from "@/server/services/session-resolver";
import { decideByToken, requestApproval } from "@/server/services/work-order-approval";
import {
  addItem,
  addPhoto,
  createWorkOrder,
  getWorkOrder,
  markReady,
} from "@/server/services/work-orders";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { key, make, plain } from "../helpers/inventory.ts";
import { openCash, posWorld, saleKey, stockUp, type PosWorld } from "../helpers/pos.ts";

const DAY = 86_400_000;
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(64).fill(3),
]);

/** RUC válido a partir de 10 dígitos (módulo 11, igual que SUNAT). */
function ruc(prefix10: string): string {
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix10[i]), 0);
  return `${prefix10}${(11 - (sum % 11)) % 10}`;
}

describe("cuentas por cobrar B2B, facturación a crédito de OT y evidencia", () => {
  let admin: PrismaClient;
  let w: PosWorld;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await posWorld(admin);
    await openCash(w.cashier);
    await openCash(w.admin);
  }, 240_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  const product = async (price = 118) => {
    const p = await make(w.admin, plain({ salePrice: price }));
    await stockUp(w, p.id, "50");
    return p;
  };
  const customer = async (docType: "RUC" | "DNI", name: string, optIn = true) => {
    const docNumber =
      docType === "RUC"
        ? ruc(`20${Math.floor(10_000_000 + Math.random() * 89_999_999)}`)
        : String(Math.floor(10_000_000 + Math.random() * 89_999_999));
    const created = await createCustomer(
      w.admin,
      { docType, docNumber, name, whatsapp: "987654321", whatsappOptIn: optIn },
      meta(),
    );
    await admin.customer.update({
      where: { id: created.id },
      data: { creditLimit: 5000, creditDays: 15 },
    });
    return created;
  };
  const creditSale = async (customerId: string, dueInDays: number, items = 1, paid?: string) => {
    const p = await product(100);
    const sale = await createSale(
      w.cashier,
      {
        idempotencyKey: saleKey(),
        documentType: "NOTA_VENTA",
        customerId,
        isCredit: true,
        items: [{ productId: p.id, quantity: String(items) }],
        payments: paid ? [{ method: "CASH", amount: paid }] : [],
      },
      meta(),
    );
    const receivable = await admin.receivable.findFirstOrThrow({ where: { saleId: sale.id } });
    await admin.receivable.update({
      where: { id: receivable.id },
      data: { dueDate: new Date(Date.now() + dueInDays * DAY) },
    });
    return { sale, receivableId: receivable.id };
  };

  describe("panel y semáforo", () => {
    it("ordena por vencimiento, marca verde/ámbar/rojo y resume por empresa", async () => {
      const acme = await customer("RUC", "Transportes Acme SAC");
      const norte = await customer("RUC", "Constructora Norte SAC");
      const juan = await customer("DNI", "Juan Pérez");
      const a = await creditSale(acme.id, 10);
      const b = await creditSale(norte.id, 2);
      const c = await creditSale(juan.id, -5);
      const d = await creditSale(acme.id, -1, 2);

      const result = await listReceivables(w.admin);
      const mine = result.items.filter((r) => [a, b, c, d].some((x) => x.receivableId === r.id));
      expect(mine.map((r) => r.id)).toEqual([
        c.receivableId,
        d.receivableId,
        b.receivableId,
        a.receivableId,
      ]);
      const light = (id: string) => result.items.find((r) => r.id === id)?.light;
      expect(light(a.receivableId)).toBe("GREEN");
      expect(light(b.receivableId)).toBe("AMBER");
      expect(light(c.receivableId)).toBe("RED");
      expect(light(d.receivableId)).toBe("RED");
      expect(result.items.find((r) => r.id === b.receivableId)).toMatchObject({
        isCompany: true,
        daysToDue: 2,
      });

      const acmeRow = result.byCustomer.find((x) => x.customerId === acme.id);
      expect(acmeRow).toMatchObject({ count: 2, light: "RED", balance: "300.00", isCompany: true });
      // Lo más urgente primero.
      expect(result.byCustomer[0]?.light).toBe("RED");
      expect(result.byCustomer.findIndex((x) => x.customerId === norte.id)).toBeGreaterThan(
        result.byCustomer.findIndex((x) => x.customerId === acme.id),
      );
    });

    it("filtra por empresas (RUC) y por nombre", async () => {
      const empresa = await customer("RUC", "Logística Andina SAC");
      const persona = await customer("DNI", "María Andina");
      await creditSale(empresa.id, 8);
      await creditSale(persona.id, 8);
      const companies = await listReceivables(w.admin, { onlyCompanies: true });
      expect(companies.items.every((r) => r.isCompany)).toBe(true);
      expect(companies.items.some((r) => r.customerId === empresa.id)).toBe(true);
      expect(companies.items.some((r) => r.customerId === persona.id)).toBe(false);
      const byName = await listReceivables(w.admin, { q: "andina" });
      expect(new Set(byName.items.map((r) => r.customerId))).toEqual(
        new Set([empresa.id, persona.id]),
      );
      expect(
        (await listReceivables(w.admin, { q: "andina", onlyCompanies: true })).items.map(
          (r) => r.customerId,
        ),
      ).toEqual([empresa.id]);
      expect((await listReceivables(w.admin, { q: "no-existe-xyz" })).items).toEqual([]);
    });

    it("registrar el pago total deja el saldo en 0, la cuenta cancelada y el cobro en la caja", async () => {
      const company = await customer("RUC", "Cobros Totales SAC");
      const { sale, receivableId } = await creditSale(company.id, 5);
      const before = await admin.salePayment.count({ where: { saleId: sale.id } });
      const result = await collectReceivable(
        w.cashier,
        {
          receivableId,
          idempotencyKey: key(),
          method: "TRANSFER",
          amount: "100",
          reference: "OP-8841",
        },
        meta(),
      );
      expect(result).toMatchObject({ balance: "0.00", status: "PAID", replayed: false });
      expect(await admin.salePayment.count({ where: { saleId: sale.id } })).toBe(before + 1);
      const payment = await admin.salePayment.findFirstOrThrow({
        where: { saleId: sale.id, method: "TRANSFER" },
      });
      expect(payment).toMatchObject({ reference: "OP-8841" });
      expect(payment.cashSessionId).toBeTruthy();
      expect((await listReceivables(w.admin)).items.some((r) => r.id === receivableId)).toBe(false);
    });
  });

  describe("recordatorios por WhatsApp", () => {
    const outbound = (relatedId: string, k: string) =>
      admin.outboundMessage.count({
        where: { tenantId: w.tenantId, relatedId, idempotencyKey: k },
      });

    it("avisa una sola vez cuando faltan 3 días o menos, no antes ni después de pagar", async () => {
      const company = await customer("RUC", "Aviso Previo SAC");
      const soon = await creditSale(company.id, 2);
      const far = await creditSale(company.id, 10);
      const partial = await creditSale(company.id, 3, 2, "50");
      expect(
        (await admin.receivable.findFirstOrThrow({ where: { id: partial.receivableId } })).status,
      ).toBe("PARTIAL");

      const run = () => withTenant(w.tenantId, (tx) => processReceivables(tx, new Date()));
      const first = await run();
      expect(first.dueSoon).toBeGreaterThanOrEqual(2);
      expect(await outbound(soon.receivableId, `recv-due:${soon.receivableId}`)).toBe(1);
      expect(await outbound(partial.receivableId, `recv-due:${partial.receivableId}`)).toBe(1);
      expect(await outbound(far.receivableId, `recv-due:${far.receivableId}`)).toBe(0);
      const message = await admin.outboundMessage.findFirstOrThrow({
        where: { idempotencyKey: `recv-due:${soon.receivableId}` },
      });
      expect(message.body).toContain("Aviso Previo SAC");
      expect(message.body).toMatch(/vence en 2 día\(s\)/);
      expect(message.body).toContain("S/ 100.00");

      await run();
      expect(await outbound(soon.receivableId, `recv-due:${soon.receivableId}`)).toBe(1); // idempotente

      await collectReceivable(
        w.cashier,
        { receivableId: far.receivableId, idempotencyKey: key(), method: "CASH", amount: "100" },
        meta(),
      );
      await admin.receivable.update({
        where: { id: far.receivableId },
        data: { dueDate: new Date(Date.now() + DAY) },
      });
      await run();
      expect(await outbound(far.receivableId, `recv-due:${far.receivableId}`)).toBe(0); // ya pagada: no se avisa
    });

    it("respeta el consentimiento: sin opt-in no hay WhatsApp, pero el personal sí recibe la alerta", async () => {
      const company = await customer("RUC", "Sin Consentimiento SAC", false);
      const { receivableId } = await creditSale(company.id, 1);
      await withTenant(w.tenantId, (tx) => processReceivables(tx, new Date()));
      expect(
        await admin.outboundMessage.count({
          where: { idempotencyKey: `recv-due:${receivableId}` },
        }),
      ).toBe(0);
      expect(
        await admin.notification.count({
          where: { tenantId: w.tenantId, dedupeKey: `receivable-due-soon:${receivableId}` },
        }),
      ).toBe(1);
    });

    it("las vencidas siguen recibiendo su recordatorio semanal y no el de «vence pronto»", async () => {
      const company = await customer("RUC", "Ya Vencida SAC");
      const { receivableId } = await creditSale(company.id, -4);
      await withTenant(w.tenantId, (tx) => processReceivables(tx, new Date()));
      expect(
        (await admin.receivable.findFirstOrThrow({ where: { id: receivableId } })).status,
      ).toBe("OVERDUE");
      expect(
        await admin.outboundMessage.count({
          where: { idempotencyKey: { startsWith: `recv-reminder:${receivableId}:` } },
        }),
      ).toBe(1);
      expect(
        await admin.outboundMessage.count({
          where: { idempotencyKey: `recv-due:${receivableId}` },
        }),
      ).toBe(0);
    });
  });

  describe("OT facturada a crédito", () => {
    const readyOrder = async (creditLimit: number) => {
      const part = await product(40);
      const doc = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
      const r = await createWorkOrder(
        w.admin,
        {
          plate: `C${randomUUID()
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 5)
            .toUpperCase()}`,
          newCustomer: {
            docType: "DNI",
            docNumber: doc,
            name: "Taller Cliente",
            whatsapp: "987654321",
            whatsappOptIn: true,
          },
          mileageIn: 1000,
          fuelLevelEighths: 4,
          complaint: "Embrague patina",
        },
        meta(),
      );
      await admin.customer.update({ where: { id: r.customerId }, data: { creditLimit } });
      await addItem(
        w.admin,
        r.id,
        {
          type: "LABOR",
          description: "Cambio de kit de embrague",
          quantity: "1",
          unitPrice: "300",
        },
        meta(),
      );
      const { link } = await requestApproval(w.admin, r.id, meta());
      await decideByToken(
        {
          token: link.split("/aprobar/")[1] as string,
          decision: "APPROVE",
          name: "Taller Cliente",
        },
        meta(),
      );
      await markReady(w.admin, r.id, meta());
      void part;
      return r;
    };

    it("se factura a crédito con el plazo acordado: venta, deuda con vencimiento y estado visible en la OT", async () => {
      const r = await readyOrder(5000);
      const total = (await getWorkOrder(w.admin, r.id)).total;
      const sale = await convertWorkOrderToSale(
        w.admin,
        {
          workOrderId: r.id,
          idempotencyKey: saleKey(),
          documentType: "BOLETA",
          isCredit: true,
          creditDays: 20,
          payments: [],
        },
        meta(),
      );
      expect(sale.paymentStatus).toBe("UNPAID");
      const receivable = await admin.receivable.findFirstOrThrow({ where: { saleId: sale.id } });
      expect(Number(receivable.balance)).toBe(Number(total));
      expect(Math.round((receivable.dueDate.getTime() - Date.now()) / DAY)).toBe(20);

      const view = await getWorkOrder(w.admin, r.id);
      expect(view.sale).toMatchObject({ isCredit: true, balance: total, receivableStatus: "OPEN" });
      expect(view.sale?.dueDate?.getTime()).toBe(receivable.dueDate.getTime());
      // El comprobante electrónico queda enlazado a la misma venta que originó la deuda.
      expect(await admin.fiscalDocument.count({ where: { saleId: sale.id, type: "BOLETA" } })).toBe(
        1,
      );

      const list = await listReceivables(w.admin, { customerId: r.customerId });
      expect(list.items[0]).toMatchObject({ saleId: sale.id, light: "GREEN", balance: total });

      await collectReceivable(
        w.cashier,
        { receivableId: receivable.id, idempotencyKey: key(), method: "YAPE", amount: total },
        meta(),
      );
      const paid = await getWorkOrder(w.admin, r.id);
      expect(paid.sale).toMatchObject({ balance: "0.00", receivableStatus: "PAID" });
    });

    it("sin línea de crédito autorizada para el cliente no se puede facturar a crédito", async () => {
      const r = await readyOrder(0);
      await expect(
        convertWorkOrderToSale(
          w.admin,
          {
            workOrderId: r.id,
            idempotencyKey: saleKey(),
            documentType: "NOTA_VENTA",
            isCredit: true,
            creditDays: 20,
            payments: [],
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "NO_CREDIT" });
      expect((await getWorkOrder(w.admin, r.id)).sale).toBeNull();
    });
  });

  describe("evidencia fotográfica inmutable", () => {
    it("las fotos de ingreso se pueden agregar pero no modificar ni borrar, ni siquiera con el rol dueño", async () => {
      const r = await createWorkOrder(
        w.admin,
        {
          plate: `E${randomUUID()
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 5)
            .toUpperCase()}`,
          newCustomer: {
            docType: "DNI",
            docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
            name: "Cliente Evidencia",
          },
          mileageIn: 10,
          fuelLevelEighths: 2,
          complaint: "Motor con golpe",
        },
        meta(),
      );
      const photo = await addPhoto(
        w.admin,
        r.id,
        { kind: "INTAKE", caption: "Embrague dañado", bytes: PNG },
        meta(),
      );
      await addPhoto(
        w.admin,
        r.id,
        { kind: "INTAKE", caption: "Disco de embrague", bytes: PNG },
        meta(),
      );
      expect(await admin.workOrderPhoto.count({ where: { workOrderId: r.id } })).toBe(2);
      await expect(
        admin.workOrderPhoto.update({
          where: { id: photo.id },
          data: { storagePath: "otra/ruta.png" },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        admin.workOrderPhoto.update({ where: { id: photo.id }, data: { caption: "editada" } }),
      ).rejects.toThrow(/immutable/);
      await expect(admin.workOrderPhoto.delete({ where: { id: photo.id } })).rejects.toThrow(
        /immutable/,
      );
      await expect(
        admin.workOrderPhoto.deleteMany({ where: { workOrderId: r.id } }),
      ).rejects.toThrow(/immutable/);
      expect(await admin.workOrderPhoto.count({ where: { workOrderId: r.id } })).toBe(2);
      expect(
        (await admin.workOrderPhoto.findFirstOrThrow({ where: { id: photo.id } })).caption,
      ).toBe("Embrague dañado");
    });
  });
});
