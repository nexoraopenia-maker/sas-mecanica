import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@/lib/auth/can";
import { withTenant } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { PermissionDeniedError, RateLimitError } from "@/lib/errors";
import {
  DEMO_TTL_HOURS,
  provisionDemo,
  purgeExpiredDemos,
  restoreDemo,
} from "@/server/services/demo";
import { DEMO_CRITICAL_SKUS } from "@/server/services/demo-seed";
import { enqueueOutbound, resolveAiPolicy } from "@/server/services/messaging";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import { adminClient, appRawClient, asTenantRaw } from "../helpers/db.ts";
import { bootstrapTenant, meta } from "../helpers/auth.ts";

describe("cuenta demo instantánea", () => {
  let admin: PrismaClient;
  let raw: PrismaClient;
  let demo: Awaited<ReturnType<typeof provisionDemo>>;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    raw = appRawClient();
    demo = await provisionDemo(meta());
  }, 120_000);
  afterAll(async () => {
    await admin.$disconnect();
    await raw.$disconnect();
  });

  describe("aprovisionamiento", () => {
    it("crea un sandbox aislado que expira en 24 h con el plan demo", async () => {
      const tenant = await admin.tenant.findUniqueOrThrow({
        where: { id: demo.tenantId },
        include: { plan: true, settings: true },
      });
      expect(tenant).toMatchObject({ isDemo: true, status: "ACTIVE" });
      expect(tenant.plan.code).toBe("demo");
      const hours = ((tenant.demoExpiresAt?.getTime() ?? 0) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(DEMO_TTL_HOURS - 0.1);
      expect(hours).toBeLessThanOrEqual(DEMO_TTL_HOURS);
      expect(tenant.demoSessionKey).toBeTruthy();
      expect(tenant.settings?.aiMonthlyTokenCap).toBe(20_000);
    });

    it("el usuario demo entra como administrador sin contraseña y se resuelve como cuenta demo", async () => {
      const row = await admin.user.findUniqueOrThrow({ where: { id: demo.userId } });
      expect(row.passwordHash).toBeNull(); // solo se entra por el botón "Acceso Demo"
      const user = await resolveSession({
        sub: demo.userId,
        tid: demo.tenantId,
        sv: row.sessionVersion,
        mfa: true,
      });
      expect(user).toMatchObject({ isDemo: true, roleKey: "admin" });
      expect(user && can(user, "ai_agent:autorizar_pedidos_ia")).toBe(true);
    });

    it("cada sesión obtiene un tenant distinto", async () => {
      const other = await provisionDemo(meta());
      expect(other.tenantId).not.toBe(demo.tenantId);
      expect(await admin.product.count({ where: { tenantId: other.tenantId } })).toBe(
        await admin.product.count({ where: { tenantId: demo.tenantId } }),
      );
      // Mismos SKU en ambos sandbox: no se mezclan.
      const visible = await withTenant(demo.tenantId, (tx) =>
        tx.product.findMany({ select: { tenantId: true } }),
      );
      expect(new Set(visible.map((p) => p.tenantId))).toEqual(new Set([demo.tenantId]));
    });

    it("aplica rate limit por IP", async () => {
      const ip = `demo-${randomUUID()}`;
      for (let i = 0; i < 3; i += 1) await provisionDemo({ ip });
      await expect(provisionDemo({ ip })).rejects.toBeInstanceOf(RateLimitError);
    });
  });

  describe("seed realista", () => {
    it("30+ productos de llantas, baterías, lubricantes y frenos con los datos del brief", async () => {
      const products = await withTenant(demo.tenantId, (tx) =>
        tx.product.findMany({
          include: {
            tireDetail: true,
            batteryDetail: true,
            lubricantDetail: true,
            partDetail: true,
            compatibilities: true,
          },
        }),
      );
      expect(products.length).toBeGreaterThanOrEqual(30);
      const kinds = new Set(products.map((p) => p.kind));
      for (const kind of ["TIRE", "BATTERY", "LUBRICANT", "PART", "SERVICE"])
        expect(kinds.has(kind as never), kind).toBe(true);

      const tires = products.filter(
        (p) =>
          p.tireDetail?.width === 205 &&
          p.tireDetail.aspectRatio === 55 &&
          Number(p.tireDetail.rimDiameter) === 16,
      );
      expect(tires.length).toBeGreaterThanOrEqual(3);
      const battery = products.find(
        (p) =>
          p.batteryDetail?.capacityAh === 60 &&
          p.batteryDetail.ccaA === 550 &&
          p.batteryDetail.voltage === 12,
      );
      expect(battery?.trackingMode).toBe("SERIAL");
      expect(products.some((p) => p.lubricantDetail?.viscosity === "5W-30")).toBe(true);
      expect(products.some((p) => p.name.toLowerCase().includes("pastillas") && p.partDetail)).toBe(
        true,
      );
      expect(products.filter((p) => p.compatibilities.length > 0).length).toBeGreaterThan(3);
      expect(products.every((p) => Number(p.salePrice) > 0)).toBe(true);
    });

    it("exactamente 5 productos en stock crítico y el resto sano", async () => {
      const rows = await withTenant(demo.tenantId, async (tx) => {
        const policies = await tx.reorderPolicy.findMany({
          include: { product: { select: { sku: true } } },
        });
        const balances = await tx.stockBalance.findMany();
        return policies.map((policy) => {
          const qty = Number(balances.find((b) => b.productId === policy.productId)?.quantity ?? 0);
          const min = Number(policy.manualMinStock);
          const reorder = Number(policy.manualReorderPoint);
          return {
            sku: policy.product.sku,
            status: qty <= min ? "CRITICO" : qty <= reorder ? "REORDEN" : "OPTIMO",
          };
        });
      });
      const critical = rows
        .filter((r) => r.status === "CRITICO")
        .map((r) => r.sku)
        .sort();
      expect(critical).toEqual([...DEMO_CRITICAL_SKUS].sort());
      expect(rows.filter((r) => r.status === "REORDEN").length).toBeGreaterThanOrEqual(3);
      expect(rows.filter((r) => r.status === "OPTIMO").length).toBeGreaterThan(15);
    });

    it("el stock sale del kardex (saldo = suma de movimientos) y las baterías llevan serie única", async () => {
      const mismatches = await admin.$queryRaw<
        { productId: string; saldo: string; suma: string }[]
      >`
        SELECT b."productId", b.quantity::text AS saldo, COALESCE(k.suma, 0)::text AS suma
        FROM stock_balances b
        LEFT JOIN (SELECT "productId", "warehouseId", SUM("quantityDelta") AS suma FROM kardex_movements WHERE "tenantId" = ${demo.tenantId}::uuid GROUP BY 1, 2) k
          ON k."productId" = b."productId" AND k."warehouseId" = b."warehouseId"
        WHERE b."tenantId" = ${demo.tenantId}::uuid AND b.quantity <> COALESCE(k.suma, 0)`;
      expect(mismatches).toEqual([]);

      const serials = await withTenant(demo.tenantId, (tx) =>
        tx.serialNumber.findMany({ include: { product: true } }),
      );
      expect(serials.length).toBeGreaterThanOrEqual(15);
      expect(new Set(serials.map((s) => `${s.productId}:${s.serial}`)).size).toBe(serials.length);
      expect(serials.some((s) => s.status === "INSTALLED")).toBe(true);
    });

    it("incluye una llanta con DOT antiguo (>5 años) para la alerta", async () => {
      const lots = await withTenant(demo.tenantId, (tx) =>
        tx.stockLot.findMany({ where: { dotCode: { not: null } } }),
      );
      const old = lots.filter(
        (lot) =>
          lot.manufacturedAt && Date.now() - lot.manufacturedAt.getTime() > 5 * 365 * 86_400_000,
      );
      expect(old.map((l) => l.dotCode)).toContain("1218");
      expect(lots.length).toBeGreaterThan(8);
    });

    it("4 órdenes de trabajo en estados distintos, con cuenta mixta", async () => {
      const orders = await withTenant(demo.tenantId, (tx) =>
        tx.workOrder.findMany({
          include: {
            items: true,
            checklist: true,
            statusHistory: true,
            vehicle: true,
            customer: true,
          },
        }),
      );
      expect(orders.map((o) => o.status).sort()).toEqual([
        "AWAITING_PARTS",
        "DIAGNOSING",
        "IN_REPAIR",
        "READY",
      ]);
      expect(
        orders.every(
          (o) => o.checklist.length > 0 && o.statusHistory.length === 2 && o.vehicle && o.customer,
        ),
      ).toBe(true);
      const mixed = orders.filter(
        (o) => o.items.some((i) => i.type === "LABOR") && o.items.some((i) => i.type === "PART"),
      );
      expect(mixed.length).toBeGreaterThanOrEqual(3);
      const waiting = orders.find((o) => o.status === "AWAITING_PARTS");
      expect(waiting?.items.some((i) => i.partStatus === "REQUESTED")).toBe(true);
      // Los repuestos ya instalados descontaron del almacén vía kardex.
      const consumed = orders.flatMap((o) => o.items).filter((i) => i.consumptionMovementId);
      expect(consumed.length).toBeGreaterThanOrEqual(3);
      expect(new Set(orders.map((o) => o.number)).size).toBe(4);
    });

    it("3 proveedores con catálogo, precios, tiempos de entrega y lista blanca", async () => {
      const suppliers = await withTenant(demo.tenantId, (tx) =>
        tx.supplier.findMany({ include: { products: true } }),
      );
      expect(suppliers).toHaveLength(3);
      for (const supplier of suppliers) {
        expect(supplier.products.length).toBeGreaterThanOrEqual(10);
        expect(
          supplier.products.every((p) => p.leadTimeDays !== null && Number(p.lastPrice) > 0),
        ).toBe(true);
      }
      expect(suppliers.filter((s) => s.aiWhitelisted)).toHaveLength(2);
      expect(new Set(suppliers.map((s) => s.defaultLeadTimeDays)).size).toBe(3);
    });
  });

  describe("envíos simulados y tope de IA", () => {
    it("en demo los mensajes quedan SIMULATED; en un tenant real quedan PENDING; es idempotente", async () => {
      const key = randomUUID();
      const simulated = await withTenant(demo.tenantId, (tx) =>
        enqueueOutbound(tx, {
          channel: "WHATSAPP",
          toAddress: "+51987000001",
          body: "Pedido de prueba",
          idempotencyKey: key,
        }),
      );
      expect(simulated.status).toBe("SIMULATED");
      expect(simulated.sentAt).not.toBeNull();
      const again = await withTenant(demo.tenantId, (tx) =>
        enqueueOutbound(tx, {
          channel: "WHATSAPP",
          toAddress: "+51987000001",
          body: "Pedido de prueba",
          idempotencyKey: key,
        }),
      );
      expect(again.id).toBe(simulated.id);

      const real = await bootstrapTenant(admin, "pro");
      const queued = await withTenant(real.tenantId, (tx) =>
        enqueueOutbound(tx, {
          channel: "EMAIL",
          toAddress: "proveedor@x.pe",
          body: "Pedido real",
          idempotencyKey: randomUUID(),
        }),
      );
      expect(queued.status).toBe("PENDING");
    });

    it("la política de IA de la demo es simulada y con tope estricto de tokens", async () => {
      const policy = await withTenant(demo.tenantId, (tx) => resolveAiPolicy(tx));
      expect(policy).toEqual({ enabled: true, simulated: true, monthlyTokenCap: 20_000 });
      // Aunque el dueño de la demo intente subir el tope, nunca supera el máximo.
      await admin.tenantSettings.update({
        where: { tenantId: demo.tenantId },
        data: { aiMonthlyTokenCap: 5_000_000 },
      });
      expect((await withTenant(demo.tenantId, (tx) => resolveAiPolicy(tx))).monthlyTokenCap).toBe(
        20_000,
      );
      await admin.tenantSettings.update({
        where: { tenantId: demo.tenantId },
        data: { aiMonthlyTokenCap: 20_000 },
      });

      const enterprise = await bootstrapTenant(admin, "enterprise");
      expect(await withTenant(enterprise.tenantId, (tx) => resolveAiPolicy(tx))).toEqual({
        enabled: true,
        simulated: false,
        monthlyTokenCap: 2_000_000,
      });
      const basic = await bootstrapTenant(admin, "basic");
      expect((await withTenant(basic.tenantId, (tx) => resolveAiPolicy(tx))).enabled).toBe(false);
    });
  });

  describe("restaurar y expirar", () => {
    it("restaurar crea un sandbox nuevo y deja inutilizable el anterior", async () => {
      const first = await provisionDemo(meta());
      const user = await resolveSession({
        sub: first.userId,
        tid: first.tenantId,
        sv: 1,
        mfa: true,
      });
      if (!user) throw new Error("demo esperada");
      const restored = await restoreDemo(user, meta());
      expect(restored.tenantId).not.toBe(first.tenantId);
      expect(
        await resolveSession({ sub: first.userId, tid: first.tenantId, sv: 1, mfa: true }),
      ).toBeNull();
      expect(
        await resolveSession({ sub: restored.userId, tid: restored.tenantId, sv: 1, mfa: true }),
      ).not.toBeNull();
    });

    it("solo una sesión demo puede restaurar", async () => {
      const real = await bootstrapTenant(admin, "pro");
      await expect(restoreDemo(real.admin, meta())).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("una demo vencida no autentica", async () => {
      const short = await provisionDemo(meta());
      await admin.tenant.update({
        where: { id: short.tenantId },
        data: { demoExpiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        await resolveSession({ sub: short.userId, tid: short.tenantId, sv: 1, mfa: true }),
      ).toBeNull();
    });
  });

  describe("limpieza de demos vencidas (job)", () => {
    it("elimina TODOS los datos del sandbox vencido (kardex y auditoría incluidos) sin tocar a los demás", async () => {
      const doomed = await provisionDemo(meta());
      const survivor = await provisionDemo(meta());
      const real = await bootstrapTenant(admin, "pro");
      await admin.tenant.update({
        where: { id: doomed.tenantId },
        data: { demoExpiresAt: new Date(Date.now() - 1000) },
      });

      const result = await purgeExpiredDemos();
      expect(result.purged).toBeGreaterThanOrEqual(1);

      expect(await admin.tenant.count({ where: { id: doomed.tenantId } })).toBe(0);
      const tables = await admin.$queryRaw<{ table_name: string }[]>`
        SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'`;
      for (const { table_name } of tables) {
        const [row] = await admin.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM public."${table_name}" WHERE "tenantId" = $1::uuid`,
          doomed.tenantId,
        );
        expect(Number(row?.n), table_name).toBe(0);
      }
      expect(
        await admin.kardexMovement.count({ where: { tenantId: survivor.tenantId } }),
      ).toBeGreaterThan(30);
      expect(
        await admin.tenant.count({ where: { id: { in: [survivor.tenantId, real.tenantId] } } }),
      ).toBe(2);
      expect(
        await admin.auditLog.count({
          where: { tenantId: null, action: "demo.purged", entityId: doomed.tenantId },
        }),
      ).toBe(1);
      // Idempotente: una segunda pasada no falla ni borra de más.
      await expect(purgeExpiredDemos()).resolves.toBeDefined();
    });

    it("purge_tenant se niega a borrar tenants reales o con retención vigente, y la app no puede invocarla", async () => {
      const real = await bootstrapTenant(admin, "basic");
      await expect(admin.$queryRaw`SELECT purge_tenant(${real.tenantId}::uuid)`).rejects.toThrow(
        /purge_denied/,
      );
      await admin.tenant.update({
        where: { id: real.tenantId },
        data: { status: "CANCELLED", purgeAfter: new Date(Date.now() + 86_400_000) },
      });
      await expect(admin.$queryRaw`SELECT purge_tenant(${real.tenantId}::uuid)`).rejects.toThrow(
        /purge_denied/,
      );
      await expect(
        asTenantRaw(
          raw,
          demo.tenantId,
          (tx) => tx.$queryRaw`SELECT purge_tenant(${demo.tenantId}::uuid)`,
        ),
      ).rejects.toThrow(/permission denied/i);
      // Cumplida la retención sí se puede purgar.
      await admin.tenant.update({
        where: { id: real.tenantId },
        data: { purgeAfter: new Date(Date.now() - 1000) },
      });
      await expect(
        admin.$queryRaw`SELECT purge_tenant(${real.tenantId}::uuid)`,
      ).resolves.toBeDefined();
      expect(await admin.tenant.count({ where: { id: real.tenantId } })).toBe(0);
    });

    it("la app no puede borrar kardex ni auditoría ni siquiera con el flag de purga", async () => {
      await expect(
        withTenant(
          demo.tenantId,
          (tx) =>
            tx.$executeRaw`SELECT set_config('app.allow_purge', 'on', true); DELETE FROM kardex_movements`,
        ),
      ).rejects.toThrow();
    });
  });
});
