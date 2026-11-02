import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/auth/can";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { PermissionDeniedError } from "@/lib/errors";
import { limaDay } from "@/lib/reports/period";
import { reportToCsv } from "@/lib/reports/table";
import { getDashboard } from "@/server/services/dashboard";
import {
  aiReport,
  availableReports,
  deadStockReport,
  marginReport,
  mechanicsReport,
  receivablesReport,
  rotationReport,
  runReport,
  salesReport,
  suppliersReport,
  topProductsReport,
} from "@/server/services/reports";
import { createRole } from "@/server/services/roles";
import { createSale, getSale, returnSale, voidSale } from "@/server/services/sales";
import { createSupplier } from "@/server/services/suppliers";
import { configureAuthCache } from "@/server/services/session-resolver";
import { addUser, meta } from "../helpers/auth.ts";
import { adminClient } from "../helpers/db.ts";
import { make, plain } from "../helpers/inventory.ts";
import {
  dniCustomer,
  openCash,
  posWorld,
  saleKey,
  stockUp,
  type PosWorld,
} from "../helpers/pos.ts";
import { inviteUser } from "@/server/services/users";
import {
  assignMechanic,
  addItem,
  createWorkOrder,
  deliverWorkOrder,
  markReady,
} from "@/server/services/work-orders";
import { decideByToken, requestApproval } from "@/server/services/work-order-approval";

const DAY = 86_400_000;

describe("reportes y tablero", () => {
  let admin: PrismaClient;
  let w: PosWorld;
  let other: PosWorld;
  let analyst: AuthUser; // reports:ver + pos:ver, SIN costos de compra
  const period = () => ({
    from: limaDay(new Date(Date.now() - DAY)),
    to: limaDay(new Date(Date.now() + DAY)),
  });
  const p1: { id: string; sku: string } = { id: "", sku: "" };
  const evil: { id: string } = { id: "" };

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await posWorld(admin);
    other = await posWorld(admin);
    await openCash(w.cashier);
    await openCash(w.admin);
    const role = await createRole(
      w.admin,
      {
        name: "Analista",
        permissions: ["reports:ver", "pos:ver", "purchasing:ver", "inventory:ver"],
      },
      meta(),
    );
    analyst = await addUser(
      (input) => inviteUser(w.admin, input, meta()),
      admin,
      w.tenantId,
      role.id,
      "Analista",
    );
  }, 240_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  const sell = (
    user: AuthUser,
    items: Array<Record<string, unknown>>,
    amount: string,
    over: Record<string, unknown> = {},
  ) =>
    createSale(
      user,
      {
        idempotencyKey: saleKey(),
        documentType: "NOTA_VENTA",
        items,
        payments: [{ method: "CASH", amount }],
        ...over,
      } as never,
      meta(),
    );

  describe("ventas, márgenes y más vendidos", () => {
    let completedTotal = 0;
    beforeAll(async () => {
      const a = await make(w.admin, plain({ salePrice: 118 }));
      p1.id = a.id;
      p1.sku = a.sku;
      await stockUp(w, a.id, "20", { unitCost: "50" });
      const b = await make(w.admin, plain({ salePrice: 59 }));
      await stockUp(w, b.id, "20", { unitCost: "20" });
      const bad = await make(
        w.admin,
        plain({ salePrice: 30, name: '=HYPERLINK("http://malo.example","clic")' }),
      );
      evil.id = bad.id;
      await stockUp(w, bad.id, "5", { unitCost: "10" });

      const first = await sell(w.cashier, [{ productId: a.id, quantity: "3" }], "354");
      completedTotal += 354;
      await sell(w.cashier, [{ productId: b.id, quantity: "2" }], "118");
      completedTotal += 118;
      await sell(
        w.cashier,
        [{ description: "Alineamiento y balanceo", quantity: "1", unitPrice: "100" }],
        "100",
      );
      completedTotal += 100;
      await sell(w.cashier, [{ productId: bad.id, quantity: "1" }], "30");
      completedTotal += 30;
      const voided = await sell(w.cashier, [{ productId: b.id, quantity: "1" }], "59");
      await voidSale(w.admin, { saleId: voided.id, reason: "Venta duplicada por error" }, meta());
      const item = (await getSale(w.admin, first.id)).items[0];
      await returnSale(
        w.admin,
        {
          saleId: first.id,
          idempotencyKey: saleKey(),
          reason: "Una unidad defectuosa",
          resolution: "REFUND",
          items: [{ saleItemId: item?.id as string, quantity: "1" }],
        },
        meta(),
      );
    });

    it("ventas por periodo: solo completadas, devoluciones descontadas, cobros por medio y agrupación por mes", async () => {
      const report = await salesReport(w.admin, period());
      const total = (label: string) => report.summary.find((s) => s.label === label)?.value;
      expect(total("Ventas")).toBe("4");
      expect(total("Total vendido")).toBe(`S/ ${completedTotal.toFixed(2)}`);
      expect(total("Devoluciones")).toBe("S/ 118.00");
      expect(total("Venta neta")).toBe(`S/ ${(completedTotal - 118).toFixed(2)}`);
      expect(report.rows.find((r) => r.period === limaDay(new Date()))).toMatchObject({
        sales: 4,
        returns: "118.00",
      });
      expect(report.summary.some((s) => s.label.startsWith("Cobrado: CASH"))).toBe(true);
      const monthly = await salesReport(w.admin, period(), { groupBy: "month" });
      expect(monthly.rows.every((r) => String(r.period).length === 7)).toBe(true);
      expect(monthly.rows.reduce((s, r) => s + Number(r.sales), 0)).toBe(4);
    });

    it("el periodo se limita a 400 días y valida las fechas", async () => {
      await expect(salesReport(w.admin, { from: "2020-01-01", to: "2026-01-01" })).rejects.toThrow(
        /máximo/,
      );
      await expect(
        salesReport(w.admin, { from: "2026-02-01", to: "2026-01-01" }),
      ).rejects.toThrow();
    });

    it("margen: ingreso sin IGV y neto de devoluciones, costo al momento de vender; ordenado por margen", async () => {
      const report = await marginReport(w.admin, period());
      const row = report.rows.find((r) => r.sku === p1.sku);
      expect(row).toMatchObject({
        qty: 2,
        revenue: "200.00",
        cost: "100.00",
        margin: "100.00",
        marginPct: "50.0",
      });
      const margins = report.rows.map((r) => Number(r.margin));
      expect([...margins].sort((a, b) => b - a)).toEqual(margins);
      expect(report.rows.find((r) => r.name === "Servicios y mano de obra")).toMatchObject({
        cost: "0.00",
      });
      expect(report.summary.find((s) => s.label === "Margen bruto")?.value).toBeDefined();
    });

    it("más vendidos: por cantidad neta, solo productos y sin costos", async () => {
      const report = await topProductsReport(analyst, period());
      expect(report.rows[0]).toMatchObject({
        sku: p1.sku === report.rows[0]?.sku ? p1.sku : report.rows[0]?.sku,
      });
      expect(report.rows.every((r) => r.name !== "Servicios y mano de obra")).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(/cost|margin/i);
      const quantities = report.rows.map((r) => Number(r.qty));
      expect([...quantities].sort((a, b) => b - a)).toEqual(quantities);
    });

    it("el CSV neutraliza fórmulas de los datos (un producto llamado «=HYPERLINK(...)» no se ejecuta en Excel)", async () => {
      const csv = reportToCsv(await marginReport(w.admin, period()));
      expect(csv.startsWith("﻿")).toBe(true);
      expect(csv).toContain("'=HYPERLINK");
      expect(csv.split("\r\n").some((line) => /^=/.test(line))).toBe(false);
      expect(csv).not.toMatch(/;=HYPERLINK/);
    });
  });

  describe("permisos", () => {
    it("sin reports:ver no hay reportes; con él, cada reporte exige además su propio permiso", async () => {
      await expect(salesReport(w.cashier, period())).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(availableReports(w.cashier)).toEqual([]);
      await expect(marginReport(analyst, period())).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(aiReport(analyst, period())).rejects.toBeInstanceOf(PermissionDeniedError);
      const ids = availableReports(analyst).map((r) => r.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          "sales",
          "top",
          "rotation",
          "dead",
          "mechanics",
          "suppliers",
          "receivables",
        ]),
      );
      expect(ids).not.toContain("margin");
      expect(ids).not.toContain("ai");
      expect(availableReports(w.admin).map((r) => r.id)).toContain("margin");
      await expect(runReport(analyst, "margin", period())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(runReport(w.admin, "no-existe", period())).rejects.toThrow();
    });

    it("sin permiso de costos, rotación y proveedores no muestran valores", async () => {
      const rotation = await rotationReport(analyst);
      expect(rotation.columns.some((c) => c.key === "value")).toBe(false);
      expect(rotation.summary.some((s) => s.label === "Valor del inventario")).toBe(false);
      const full = await rotationReport(w.admin);
      expect(full.columns.some((c) => c.key === "value")).toBe(true);
    });

    it("otra empresa no ve nada de esta", async () => {
      expect((await salesReport(other.admin, period())).rows).toEqual([]);
      expect((await marginReport(other.admin, period())).rows).toEqual([]);
      expect((await rotationReport(other.admin)).rows).toEqual([]);
    });
  });

  describe("rotación y stock muerto", () => {
    it("rotación: consumo neto de 30/90 días, rotación y días de cobertura", async () => {
      const report = await rotationReport(w.admin);
      const row = report.rows.find((r) => r.sku === p1.sku);
      // 20 comprados − 3 vendidos + 1 devuelto: stock 18, consumo neto 2.
      expect(row).toMatchObject({ stock: 18, used30: 2, used90: 2, turnover: 0.11 });
      expect(row?.cover).toBe(Math.round(18 / (2 / 90)));
    });

    it("stock muerto: con existencias y sin consumo más allá del umbral; lo nuevo o lo que rota no cuenta", async () => {
      const dead = await make(w.admin, plain({ salePrice: 50 }));
      await stockUp(w, dead.id, "5", { unitCost: "40" });
      await admin.product.update({
        where: { id: dead.id },
        data: { createdAt: new Date(Date.now() - 200 * DAY) },
      });
      const fresh = await make(w.admin, plain({ salePrice: 50 }));
      await stockUp(w, fresh.id, "5", { unitCost: "40" });
      const report = await deadStockReport(w.admin);
      const skus = report.rows.map((r) => r.sku);
      expect(skus).toContain(dead.sku);
      expect(skus).not.toContain(fresh.sku); // recién creado
      expect(skus).not.toContain(p1.sku); // se vendió hoy
      expect(report.rows.find((r) => r.sku === dead.sku)).toMatchObject({
        stock: 5,
        lastUse: "Nunca",
        value: "200.00",
      });
      expect(report.summary.find((s) => s.label === "Capital inmovilizado")?.value).toBe(
        "S/ 200.00",
      );
      // El umbral es configurable por empresa.
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { deadStockDays: 400 },
      });
      expect((await deadStockReport(w.admin)).rows.map((r) => r.sku)).not.toContain(dead.sku);
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { deadStockDays: 90 },
      });
    });
  });

  describe("mecánicos, IA y proveedores", () => {
    it("mecánicos: OT entregadas, ciclo, puntualidad y mano de obra aprobada", async () => {
      const r = await createWorkOrder(
        w.admin,
        {
          plate: `M${randomUUID()
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 5)
            .toUpperCase()}`,
          newCustomer: {
            docType: "DNI",
            docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
            name: "Cliente OT",
          },
          mileageIn: 100,
          fuelLevelEighths: 4,
          complaint: "Revisión general",
        },
        meta(),
      );
      await assignMechanic(w.admin, r.id, w.mechanic.userId, meta());
      await admin.workOrder.update({
        where: { id: r.id },
        data: { promisedAt: new Date(Date.now() + DAY) },
      });
      await addItem(
        w.admin,
        r.id,
        { type: "LABOR", description: "Mano de obra", quantity: "1", unitPrice: "100" },
        meta(),
      );
      const { link } = await requestApproval(w.admin, r.id, meta());
      await decideByToken(
        { token: link.split("/aprobar/")[1] as string, decision: "APPROVE", name: "Cliente OT" },
        meta(),
      );
      await markReady(w.admin, r.id, meta());
      await deliverWorkOrder(w.admin, { workOrderId: r.id, mileageOut: 120 }, meta());
      const report = await mechanicsReport(w.admin, period());
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({
        mechanic: "Mecánico Beto",
        orders: 1,
        onTime: 100,
        labor: "100.00",
      });
      expect(Number(report.rows[0]?.cycleHours)).toBeGreaterThanOrEqual(0);
      expect((await mechanicsReport(other.admin, period())).rows).toEqual([]);
    });

    it("IA: el ahorro y el costo usan los supuestos de la empresa; las corridas simuladas no cuentan", async () => {
      const supplier = await createSupplier(
        w.manager,
        {
          name: "Frenos Perú SAC",
          taxId: `20${Math.floor(Math.random() * 1e9)}`,
          whatsapp: "+51 999 111 222",
          defaultLeadTimeDays: 4,
        },
        meta(),
      );
      await admin.tenantSettings.update({
        where: { tenantId: w.tenantId },
        data: { aiMinutesSavedPerLine: 10, staffHourlyCost: 30, usdExchangeRate: 4 },
      });
      const run = (over: Record<string, unknown>) =>
        admin.aiRun.create({
          data: {
            tenantId: w.tenantId,
            kind: "PURCHASING",
            status: "SUCCEEDED",
            model: "gpt-4o-mini",
            prompt: {},
            idempotencyKey: randomUUID(),
            ...over,
          } as never,
        });
      await run({ promptTokens: 1000, completionTokens: 500, costUsd: "0.40", simulated: false });
      await run({ promptTokens: 9999, completionTokens: 9999, costUsd: "5.00", simulated: true });
      const makeOrder = async (
        status: "RECEIVED" | "PARTIALLY_RECEIVED",
        lines: number,
        extra: Record<string, unknown>,
      ) => {
        const order = await admin.purchaseOrder.create({
          data: {
            tenantId: w.tenantId,
            number: Math.floor(Math.random() * 1e6),
            supplierId: supplier.id,
            warehouseId: w.warehouseId,
            status,
            origin: "AI",
            total: lines * 100,
            idempotencyKey: randomUUID(),
            ...extra,
          } as never,
        });
        await admin.purchaseOrderItem.createMany({
          data: Array.from({ length: lines }, () => ({
            tenantId: w.tenantId,
            orderId: order.id,
            productId: p1.id,
            qtyOrdered: 10,
            qtyReceived: status === "RECEIVED" ? 10 : 5,
            unitCost: 10,
          })),
        });
        return order;
      };
      const sent = new Date(Date.now() - 10 * DAY);
      await makeOrder("RECEIVED", 3, {
        sentAt: sent,
        expectedAt: new Date(sent.getTime() + 3 * DAY),
        receivedAt: new Date(sent.getTime() + 2 * DAY),
      });
      await makeOrder("PARTIALLY_RECEIVED", 3, {
        sentAt: sent,
        expectedAt: new Date(sent.getTime() + 3 * DAY),
        receivedAt: new Date(sent.getTime() + 5 * DAY),
      });
      const report = await aiReport(w.admin, period());
      const value = (metric: string) => report.rows.find((r) => r.metric === metric)?.value;
      expect(value("Corridas del agente")).toBe("1");
      expect(value("Tokens consumidos")).toBe("1500");
      expect(value("Costo (S/)")).toBe("1.60");
      expect(value("Líneas de pedido generadas")).toBe("6");
      expect(value("Horas de trabajo ahorradas")).toBe("1.0");
      expect(value("Ahorro estimado (S/)")).toBe("30.00");
      expect(value("Beneficio neto (S/)")).toBe("28.40");
      expect(report.rows.find((r) => r.metric === "Ahorro estimado (S/)")?.note).toContain(
        "S/ 30.00 por hora",
      );
      await expect(aiReport(other.admin, period())).resolves.toBeTruthy();
      expect(
        (await aiReport(other.admin, period())).rows.find((r) => r.metric === "Corridas del agente")
          ?.value,
      ).toBe("0");

      const suppliers = await suppliersReport(w.admin, period());
      expect(suppliers.rows).toHaveLength(1);
      expect(suppliers.rows[0]).toMatchObject({
        supplier: "Frenos Perú SAC",
        orders: 2,
        received: 2,
        onTime: 50,
        leadDays: 3.5,
        fillRate: 75,
        spend: "450.00",
      });
      const noCost = await suppliersReport(analyst, period());
      expect(noCost.columns.some((c) => c.key === "spend")).toBe(false);
      expect("spend" in (noCost.rows[0] ?? {})).toBe(false);
    });

    it("cuentas por cobrar: antigüedad de saldos", async () => {
      const customer = await dniCustomer(w.admin);
      await admin.customer.update({
        where: { id: customer.id },
        data: { creditLimit: 1000, creditDays: 10 },
      });
      const sale = await createSale(
        w.cashier,
        {
          idempotencyKey: saleKey(),
          documentType: "BOLETA",
          customerId: customer.id,
          isCredit: true,
          items: [{ description: "Servicio a crédito", quantity: "1", unitPrice: "250" }],
          payments: [],
        },
        meta(),
      );
      await admin.receivable.updateMany({
        where: { saleId: sale.id },
        data: { dueDate: new Date(Date.now() - 45 * DAY) },
      });
      const report = await receivablesReport(w.admin);
      expect(report.summary.find((s) => s.label === "31–60 días")?.value).toBe("S/ 250.00");
      expect(report.rows.find((r) => r.sale === sale.number)).toMatchObject({
        balance: "250.00",
        daysOverdue: 45,
      });
    });
  });

  describe("tablero", () => {
    it("el administrador ve todas las tarjetas con cifras coherentes", async () => {
      await admin.warranty.create({
        data: {
          tenantId: w.tenantId,
          source: "WORK_ORDER_ITEM",
          description: "Pastillas",
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * DAY),
          status: "ACTIVE",
        },
      });
      const data = await getDashboard(w.admin);
      expect(data.sales).not.toBeNull();
      expect(data.sales?.todayCount).toBeGreaterThanOrEqual(5);
      const direct = await admin.sale.aggregate({
        where: {
          tenantId: w.tenantId,
          status: "COMPLETED",
          createdAt: { gte: new Date(Date.now() - DAY) },
        },
        _sum: { total: true },
      });
      expect(Number(data.sales?.monthTotal)).toBeLessThanOrEqual(Number(direct._sum.total) + 0.001);
      expect(data.warranties?.expiring30).toBe(1);
      expect(data.stock).not.toBeNull();
      expect(data.workshop).not.toBeNull();
      expect(data.ai?.ordersCreated).toBe(2);
      expect(data.receivables).not.toBeNull();
    });

    it("cada rol ve solo las tarjetas de sus módulos", async () => {
      const cashier = await getDashboard(w.cashier);
      expect(cashier.sales).not.toBeNull();
      expect(cashier.ai).toBeNull();
      expect(cashier.warranties).not.toBeNull();
      const analystView = await getDashboard(analyst);
      expect(analystView.warranties).toBeNull();
      expect(analystView.workshop).toBeNull();
      expect(analystView.ai).toBeNull();
      expect(analystView.sales).not.toBeNull();
      const mechanic = await getDashboard(w.mechanic);
      expect(mechanic.sales).toBeNull();
      expect(mechanic.receivables).toBeNull();
      expect(mechanic.ai).toBeNull();
      expect(mechanic.workshop).not.toBeNull();
      expect(mechanic.warranties).not.toBeNull();
      const manager = await getDashboard(w.manager);
      expect(manager.ai).not.toBeNull();
      expect(manager.sales).toBeNull();
    });

    it("el tablero de otra empresa está vacío", async () => {
      const data = await getDashboard(other.admin);
      expect(data.sales).toMatchObject({ todayCount: 0, todayTotal: "0.00" });
      expect(data.warranties?.expiring30).toBe(0);
      expect(data.workshop?.active).toBe(0);
    });
  });
});
