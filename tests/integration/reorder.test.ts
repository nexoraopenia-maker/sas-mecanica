import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, type MovementType } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { PermissionDeniedError } from "@/lib/errors";
import { applyMovement, registerStockIn } from "@/server/services/inventory";
import {
  maintainAllTenants,
  maintainTenantInventory,
} from "@/server/services/inventory-maintenance";
import { reconcileStock } from "@/server/services/reconcile";
import {
  recomputeForTenant,
  recomputeReorderPolicies,
  setReorderPolicy,
} from "@/server/services/reorder";
import { configureAuthCache } from "@/server/services/session-resolver";
import {
  listStock,
  listStockAlerts,
  markAlertsRead,
  stockSummary,
} from "@/server/services/stock-queries";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import {
  inventoryWorld,
  key,
  make,
  plain,
  tire,
  type InventoryWorld,
} from "../helpers/inventory.ts";

const DAY = 86_400_000;

describe("motor de stock mínimo y punto de reorden (rotación 30/90 días)", () => {
  let admin: PrismaClient;
  let w: InventoryWorld;
  let other: InventoryWorld;
  const NOW = new Date();

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await inventoryWorld(admin);
    other = await inventoryWorld(admin);
  }, 120_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  /**
   * Crea historial real en el kardex: un inventario inicial hace 100 días y una venta
   * diaria (índice k = hace k días, k = 0..89). `daily[k]` unidades; el saldo final es `endStock`.
   */
  async function history(
    productId: string,
    daily: number[],
    endStock: number,
    extra: Array<{ type: MovementType; daysAgo: number; qty: number }> = [],
  ) {
    const sold = daily.reduce((sum, qty) => sum + qty, 0);
    const outflow = extra
      .filter((e) =>
        ["ADJUSTMENT_OUT", "TRANSFER_OUT", "SALE", "WORK_ORDER_CONSUMPTION"].includes(e.type),
      )
      .reduce((sum, e) => sum + e.qty, 0);
    const inflow = extra
      .filter((e) => ["RETURN_CUSTOMER", "ADJUSTMENT_IN"].includes(e.type))
      .reduce((sum, e) => sum + e.qty, 0);
    await withTenant(
      w.tenantId,
      async (tx) => {
        const base = { warehouseId: w.warehouseId, productId, createdById: w.manager.userId };
        await tx.kardexMovement.create({
          data: {
            ...base,
            type: "INITIAL",
            quantityDelta: String(endStock + sold + outflow - inflow),
            unitCost: "10",
            reason: "Inicial",
            idempotencyKey: key(),
            occurredAt: new Date(NOW.getTime() - 100 * DAY),
          },
        });
        for (const [k, qty] of daily.entries()) {
          if (qty > 0)
            await tx.kardexMovement.create({
              data: {
                ...base,
                type: "SALE",
                quantityDelta: String(-qty),
                idempotencyKey: key(),
                occurredAt: new Date(NOW.getTime() - k * DAY - 3_600_000),
              },
            });
        }
        for (const e of extra) {
          const sign = ["RETURN_CUSTOMER", "ADJUSTMENT_IN"].includes(e.type) ? 1 : -1;
          await tx.kardexMovement.create({
            data: {
              ...base,
              type: e.type,
              quantityDelta: String(sign * e.qty),
              reason: "prueba",
              idempotencyKey: key(),
              occurredAt: new Date(NOW.getTime() - e.daysAgo * DAY - 3_600_000),
            },
          });
        }
      },
      { timeoutMs: 120_000 },
    );
  }

  const recompute = () =>
    withTenant(w.tenantId, (tx) => recomputeReorderPolicies(tx, NOW), { timeoutMs: 120_000 });
  const policyOf = async (productId: string) =>
    admin.reorderPolicy.findFirstOrThrow({ where: { tenantId: w.tenantId, productId } });
  const rowOf = async (productId: string) =>
    (await listStock(w.manager, {})).find((row) => row.productId === productId);
  const constant = (perDay: number) => Array.from({ length: 90 }, () => perDay);

  async function supplierLink(
    productId: string,
    leadTimeDays: number | null,
    options: { preferred?: boolean; supplierDefault?: number | null } = {},
  ) {
    const supplier = await admin.supplier.create({
      data: {
        tenantId: w.tenantId,
        name: `Prov ${randomUUID().slice(0, 6)}`,
        defaultLeadTimeDays: options.supplierDefault ?? null,
      },
    });
    await admin.supplierProduct.create({
      data: {
        tenantId: w.tenantId,
        supplierId: supplier.id,
        productId,
        leadTimeDays,
        isPreferred: options.preferred ?? false,
        lastPrice: "10",
      },
    });
  }

  describe("cálculo con historial", () => {
    it("venta constante 2/día, plazo 5 días => mínimo 6 y reorden 10", async () => {
      const p = await make(w.manager, plain());
      await supplierLink(p.id, 5);
      await history(p.id, constant(2), 8);
      await recompute();
      const policy = await policyOf(p.id);
      expect(Number(policy.avgDailySales30)).toBe(2);
      expect(Number(policy.avgDailySales90)).toBe(2);
      expect([Number(policy.computedMinStock), Number(policy.computedReorderPoint)]).toEqual([
        6, 10,
      ]);
      expect(policy.computedAt?.getTime()).toBe(NOW.getTime());
      const row = await rowOf(p.id);
      expect(row).toMatchObject({
        quantity: 8,
        minStock: 6,
        reorderPoint: 10,
        status: "REORDER",
        mode: "AUTO",
      });
      expect(row?.daysOfCover).toBeCloseTo(4, 5); // 8 / 2 por día
    });

    it("el semáforo cambia con el stock: crítico ≤ mínimo, reorden ≤ punto, óptimo por encima", async () => {
      const make3 = async (end: number) => {
        const p = await make(w.manager, plain());
        await supplierLink(p.id, 5);
        await history(p.id, constant(2), end);
        return p.id;
      };
      const [critical, reorder, optimal] = [await make3(5), await make3(8), await make3(11)];
      await recompute();
      expect((await rowOf(critical))?.status).toBe("CRITICAL");
      expect((await rowOf(reorder))?.status).toBe("REORDER");
      expect((await rowOf(optimal))?.status).toBe("OPTIMAL");
      const summary = await stockSummary(w.manager);
      expect(summary.critical).toBeGreaterThanOrEqual(1);
      expect(summary.reorder + summary.critical + summary.optimal).toBe(summary.total);
      // La lista viene ordenada por urgencia.
      const order = (await listStock(w.manager, {})).map((r) => r.status);
      expect(order.indexOf("OPTIMAL")).toBeGreaterThan(order.lastIndexOf("CRITICAL"));
      expect(
        (await listStock(w.manager, { status: "CRITICAL" })).every((r) => r.status === "CRITICAL"),
      ).toBe(true);
    });

    it("la variabilidad de la demanda agrega stock de seguridad (días alternados 0 y 4)", async () => {
      const p = await make(w.manager, plain());
      await supplierLink(p.id, null, { supplierDefault: 4 }); // plazo del proveedor
      await history(
        p.id,
        Array.from({ length: 90 }, (_, k) => (k % 2 === 0 ? 4 : 0)),
        50,
      );
      await recompute();
      const policy = await policyOf(p.id);
      expect([Number(policy.computedMinStock), Number(policy.computedReorderPoint)]).toEqual([
        13, 15,
      ]);
    });

    it("la estacionalidad (×1.5) sube el mínimo y el reorden", async () => {
      const p = await make(w.manager, plain());
      await supplierLink(p.id, null, { supplierDefault: 4 });
      await history(
        p.id,
        Array.from({ length: 90 }, (_, k) => (k % 2 === 0 ? 4 : 0)),
        50,
      );
      await setReorderPolicy(
        w.manager,
        { warehouseId: w.warehouseId, productId: p.id, mode: "AUTO", seasonalityFactor: 1.5 },
        meta(),
      );
      await recompute();
      const policy = await policyOf(p.id);
      expect([Number(policy.computedMinStock), Number(policy.computedReorderPoint)]).toEqual([
        19, 22,
      ]);
      expect(Number(policy.seasonalityFactor)).toBe(1.5);
    });

    it("pesa la rotación reciente: venta que se aceleró en el último mes", async () => {
      const p = await make(w.manager, plain());
      await supplierLink(p.id, 10);
      // 30 días recientes a 6/día; los 60 anteriores a 1/día => d30 = 6, d90 = (180 + 60)/90 = 2.667
      await history(
        p.id,
        Array.from({ length: 90 }, (_, k) => (k < 30 ? 6 : 1)),
        100,
      );
      await recompute();
      const policy = await policyOf(p.id);
      expect(Number(policy.avgDailySales30)).toBe(6);
      expect(Number(policy.avgDailySales90)).toBeCloseTo(240 / 90, 3);
      expect(Number(policy.computedReorderPoint)).toBeGreaterThan(40); // 10 días × (0.6·6 + 0.4·2.67) ≈ 46.7 + seguridad
    });

    it("las devoluciones restan; los ajustes y transferencias no cuentan; lo anterior a 90 días se ignora", async () => {
      const p = await make(w.manager, plain());
      await supplierLink(p.id, 5);
      const daily = Array.from({ length: 90 }, (_, k) => (k === 1 ? 10 : 0));
      await history(p.id, daily, 100, [
        { type: "RETURN_CUSTOMER", daysAgo: 1, qty: 4 },
        { type: "ADJUSTMENT_OUT", daysAgo: 2, qty: 50 },
        { type: "TRANSFER_OUT", daysAgo: 3, qty: 30 },
        { type: "SALE", daysAgo: 120, qty: 40 }, // fuera de la ventana
      ]);
      await recompute();
      const policy = await policyOf(p.id);
      expect(Number(policy.avgDailySales30)).toBeCloseTo(6 / 30, 4); // 10 − 4
      expect(Number(policy.avgDailySales90)).toBeCloseTo(6 / 90, 4);
    });

    it("el plazo sale del proveedor preferido (aunque otro sea más rápido)", async () => {
      const preferredSlow = await make(w.manager, plain());
      await supplierLink(preferredSlow.id, 10, { preferred: true });
      await supplierLink(preferredSlow.id, 2);
      const noPreference = await make(w.manager, plain());
      await supplierLink(noPreference.id, 10);
      await supplierLink(noPreference.id, 2);
      await history(preferredSlow.id, constant(2), 100);
      await history(noPreference.id, constant(2), 100);
      await recompute();
      expect(Number((await policyOf(preferredSlow.id)).computedReorderPoint)).toBe(20); // 2 · 10
      expect(Number((await policyOf(noPreference.id)).computedReorderPoint)).toBe(4); // 2 · 2 (el más rápido)
    });

    it("sin historial: umbrales 0; solo es crítico al agotarse", async () => {
      const p = await make(w.manager, plain());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          quantity: "3",
          unitCost: "1",
          idempotencyKey: key(),
        },
        meta(),
      );
      await recompute();
      expect([
        Number((await policyOf(p.id)).computedMinStock),
        Number((await policyOf(p.id)).computedReorderPoint),
      ]).toEqual([0, 0]);
      expect((await rowOf(p.id))?.status).toBe("OPTIMAL");
      await withTenant(w.tenantId, (tx) =>
        applyMovement(tx, {
          warehouseId: w.warehouseId,
          productId: p.id,
          type: "SALE",
          quantity: "3",
          idempotencyKey: key(),
        }),
      );
      expect((await rowOf(p.id))?.status).toBe("CRITICAL");
    });

    it("es idempotente: recalcular dos veces da lo mismo y no duplica políticas", async () => {
      const p = await make(w.manager, plain());
      await history(p.id, constant(1), 20);
      await recompute();
      const first = await policyOf(p.id);
      await recompute();
      const second = await policyOf(p.id);
      expect(second.id).toBe(first.id);
      expect(second.computedReorderPoint?.toString()).toBe(first.computedReorderPoint?.toString());
      expect(
        await admin.reorderPolicy.count({ where: { tenantId: w.tenantId, productId: p.id } }),
      ).toBe(1);
    });
  });

  describe("modo manual", () => {
    it("el usuario fija los umbrales y el recálculo no los pisa; volver a AUTO usa lo calculado", async () => {
      const p = await make(w.manager, plain());
      await supplierLink(p.id, 5);
      await history(p.id, constant(2), 25);
      await setReorderPolicy(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          mode: "MANUAL",
          manualMinStock: 20,
          manualReorderPoint: 30,
        },
        meta(),
      );
      await recompute();
      const policy = await policyOf(p.id);
      expect([Number(policy.manualMinStock), Number(policy.manualReorderPoint)]).toEqual([20, 30]);
      expect([Number(policy.computedMinStock), Number(policy.computedReorderPoint)]).toEqual([
        6, 10,
      ]); // sigue calculando como referencia
      expect(await rowOf(p.id)).toMatchObject({
        mode: "MANUAL",
        minStock: 20,
        reorderPoint: 30,
        status: "REORDER",
      });

      await setReorderPolicy(
        w.manager,
        { warehouseId: w.warehouseId, productId: p.id, mode: "AUTO" },
        meta(),
      );
      expect(await rowOf(p.id)).toMatchObject({
        mode: "AUTO",
        minStock: 6,
        reorderPoint: 10,
        status: "OPTIMAL",
      });
      const logs = await admin.auditLog.findMany({
        where: { entityId: p.id, action: "reorder.policy_changed" },
        orderBy: { occurredAt: "asc" },
      });
      expect(logs).toHaveLength(2);
      expect(logs[1]).toMatchObject({
        before: { mode: "MANUAL", min: "20", rop: "30" },
        after: { mode: "AUTO" },
      });
    });

    it("valida: manual necesita valores, reorden ≥ mínimo y permisos", async () => {
      const p = await make(w.manager, plain());
      await expect(
        setReorderPolicy(
          w.manager,
          { warehouseId: w.warehouseId, productId: p.id, mode: "MANUAL" },
          meta(),
        ),
      ).rejects.toThrow(/modo manual/);
      await expect(
        setReorderPolicy(
          w.manager,
          {
            warehouseId: w.warehouseId,
            productId: p.id,
            mode: "MANUAL",
            manualMinStock: 9,
            manualReorderPoint: 3,
          },
          meta(),
        ),
      ).rejects.toThrow(/punto de reorden/);
      await expect(
        setReorderPolicy(
          w.cashier,
          { warehouseId: w.warehouseId, productId: p.id, mode: "AUTO" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(recomputeForTenant(w.cashier, meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    it("recomputeForTenant deja auditoría con el resumen", async () => {
      const summary = await recomputeForTenant(w.manager, meta());
      expect(summary.evaluated).toBeGreaterThan(0);
      expect(
        await admin.auditLog.count({
          where: { tenantId: w.tenantId, action: "reorder.recomputed" },
        }),
      ).toBeGreaterThan(0);
    });
  });

  describe("alertas inmediatas y panel", () => {
    it("al cruzar el umbral se notifica en el acto (una por estado y día) y se puede marcar como leída", async () => {
      const p = await make(w.manager, plain());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          quantity: "10",
          unitCost: "5",
          idempotencyKey: key(),
        },
        meta(),
      );
      await setReorderPolicy(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          mode: "MANUAL",
          manualMinStock: 4,
          manualReorderPoint: 8,
        },
        meta(),
      );
      const sell = (q: string) =>
        withTenant(w.tenantId, (tx) =>
          applyMovement(tx, {
            warehouseId: w.warehouseId,
            productId: p.id,
            type: "SALE",
            quantity: q,
            idempotencyKey: key(),
          }),
        );
      const alertsFor = async () =>
        (
          await admin.notification.findMany({
            where: {
              tenantId: w.tenantId,
              kind: { startsWith: "stock." },
              data: { path: ["productId"], equals: p.id },
            },
          })
        )
          .map((n) => n.kind)
          .sort();

      await sell("1"); // 9: óptimo
      expect(await alertsFor()).toEqual([]);
      await sell("2"); // 7: reorden
      expect(await alertsFor()).toEqual(["stock.reorder"]);
      await sell("1"); // 6: sigue en reorden, no repite
      expect(await alertsFor()).toEqual(["stock.reorder"]);
      await sell("3"); // 3: crítico
      expect(await alertsFor()).toEqual(["stock.critical", "stock.reorder"]);
      await sell("1"); // 2: crítico otra vez el mismo día, sin duplicar
      expect(await alertsFor()).toEqual(["stock.critical", "stock.reorder"]);

      const panel = await listStockAlerts(w.cashier); // el panel lo ve cualquiera con inventory:ver
      const mine = panel.filter(
        (n) => (n.data as { productId?: string } | null)?.productId === p.id,
      );
      expect(mine).toHaveLength(2);
      expect(mine.find((n) => n.kind === "stock.critical")).toMatchObject({ severity: "CRITICAL" });
      expect(
        await markAlertsRead(
          w.manager,
          mine.map((n) => n.id),
        ),
      ).toBe(2);
      expect(
        (await listStockAlerts(w.manager)).some(
          (n) => (n.data as { productId?: string } | null)?.productId === p.id,
        ),
      ).toBe(false);
    });
  });

  describe("mantenimiento diario y conciliación", () => {
    it("recalcula, concilia y avisa de llantas antiguas sin duplicar notificaciones", async () => {
      const t = await make(w.manager, tire());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: t.id,
          quantity: "4",
          unitCost: "200",
          lot: { code: "DOT-1218", dotCode: "1218" },
          idempotencyKey: key(),
        },
        meta(),
      );
      const first = await maintainTenantInventory(w.tenantId, NOW);
      expect(first.discrepancies).toEqual([]);
      expect(first.oldTireLots).toBeGreaterThanOrEqual(1);
      const count = () =>
        admin.notification.count({ where: { tenantId: w.tenantId, kind: "stock.old_tire" } });
      const before = await count();
      expect(before).toBeGreaterThanOrEqual(1);
      await maintainTenantInventory(w.tenantId, NOW);
      expect(await count()).toBe(before);
      const alert = await admin.notification.findFirstOrThrow({
        where: { tenantId: w.tenantId, kind: "stock.old_tire" },
      });
      expect(alert.body).toContain("DOT 1218");
    });

    it("detecta un saldo manipulado fuera del kardex y lo notifica como crítico", async () => {
      const p = await make(w.manager, plain());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: p.id,
          quantity: "10",
          unitCost: "5",
          idempotencyKey: key(),
        },
        meta(),
      );
      // Simula una manipulación directa (solo posible desactivando el trigger de guarda como dueño de la BD).
      await admin.$executeRawUnsafe(
        `ALTER TABLE stock_balances DISABLE TRIGGER stock_balances_guard`,
      );
      try {
        await admin.$executeRaw`UPDATE stock_balances SET quantity = quantity + 5 WHERE "productId" = ${p.id}::uuid`;
      } finally {
        await admin.$executeRawUnsafe(
          `ALTER TABLE stock_balances ENABLE TRIGGER stock_balances_guard`,
        );
      }
      const found = await withTenant(w.tenantId, (tx) => reconcileStock(tx));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        scope: "balance",
        productId: p.id,
        balance: "15",
        ledger: "10",
      });

      const result = await maintainTenantInventory(w.tenantId, NOW);
      expect(result.discrepancies).toHaveLength(1);
      const alert = await admin.notification.findFirstOrThrow({
        where: { tenantId: w.tenantId, kind: "stock.reconciliation" },
      });
      expect(alert.severity).toBe("CRITICAL");
      // Se repara para no contaminar otras pruebas.
      await admin.$executeRawUnsafe(
        `ALTER TABLE stock_balances DISABLE TRIGGER stock_balances_guard`,
      );
      try {
        await admin.$executeRaw`UPDATE stock_balances SET quantity = quantity - 5 WHERE "productId" = ${p.id}::uuid`;
      } finally {
        await admin.$executeRawUnsafe(
          `ALTER TABLE stock_balances ENABLE TRIGGER stock_balances_guard`,
        );
      }
      expect(await withTenant(w.tenantId, (tx) => reconcileStock(tx))).toEqual([]);
    });

    it("el mantenimiento de un tenant no toca a otro", async () => {
      const before = await admin.reorderPolicy.count({ where: { tenantId: other.tenantId } });
      await maintainTenantInventory(w.tenantId, NOW);
      expect(await admin.reorderPolicy.count({ where: { tenantId: other.tenantId } })).toBe(before);
    });

    it("el job recorre todos los tenants operativos y salta los suspendidos", async () => {
      const suspended = await inventoryWorld(admin);
      await admin.tenant.update({
        where: { id: suspended.tenantId },
        data: { status: "SUSPENDED" },
      });
      const p = await make(other.manager, plain());
      await registerStockIn(
        other.manager,
        {
          warehouseId: other.warehouseId,
          productId: p.id,
          quantity: "3",
          unitCost: "1",
          idempotencyKey: key(),
        },
        meta(),
      );
      const result = await maintainAllTenants(NOW);
      expect(result.failed).toBe(0);
      expect(result.ok).toBeGreaterThanOrEqual(2);
      expect(
        await admin.reorderPolicy.count({ where: { tenantId: other.tenantId, productId: p.id } }),
      ).toBe(1);
      expect(await admin.reorderPolicy.count({ where: { tenantId: suspended.tenantId } })).toBe(0);
    });
  });

  describe("aislamiento", () => {
    it("las existencias, umbrales y alertas de un tenant no aparecen en otro", async () => {
      const mine = await make(w.manager, plain());
      await registerStockIn(
        w.manager,
        {
          warehouseId: w.warehouseId,
          productId: mine.id,
          quantity: "2",
          unitCost: "1",
          idempotencyKey: key(),
        },
        meta(),
      );
      await withTenant(w.tenantId, (tx) => recomputeReorderPolicies(tx, NOW));
      expect((await listStock(other.manager, {})).some((r) => r.productId === mine.id)).toBe(false);
      expect(
        (await listStockAlerts(other.manager)).some(
          (n) => (n.data as { productId?: string } | null)?.productId === mine.id,
        ),
      ).toBe(false);
      await expect(
        setReorderPolicy(
          other.manager,
          { warehouseId: other.warehouseId, productId: mine.id, mode: "AUTO" },
          meta(),
        ),
      ).rejects.toThrow();
    });
  });
});
