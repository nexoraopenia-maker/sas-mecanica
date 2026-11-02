import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, softDeleteData } from "@/lib/db";
import { CrossTenantError, HardDeleteForbiddenError } from "@/lib/errors";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  adminClient,
  appRawClient,
  asTenantRaw,
  seedTenant,
  type SeededTenant,
} from "../helpers/db.ts";

/**
 * Regla 9: el tenant A no puede leer, escribir ni borrar datos del tenant B,
 * ni por Prisma (capa 1) ni por SQL directo (capa 2: RLS + rol sin BYPASSRLS).
 */
describe("aislamiento entre tenants", () => {
  let admin: PrismaClient;
  let raw: PrismaClient;
  let a: SeededTenant;
  let b: SeededTenant;

  beforeAll(async () => {
    admin = adminClient();
    raw = appRawClient();
    a = await seedTenant(admin, "A");
    b = await seedTenant(admin, "B");
  });

  afterAll(async () => {
    await admin.$disconnect();
    await raw.$disconnect();
  });

  describe("capa 1: Prisma extendido (withTenant)", () => {
    it("lista solo filas propias", async () => {
      const products = await withTenant(a.tenantId, (tx) => tx.product.findMany());
      expect(products.length).toBeGreaterThan(0);
      expect(products.every((p) => p.tenantId === a.tenantId)).toBe(true);
      expect(products.map((p) => p.id)).not.toContain(b.productId);
    });

    it("no encuentra por id una fila de otro tenant (findUnique / findFirst / count)", async () => {
      await withTenant(a.tenantId, async (tx) => {
        expect(await tx.product.findUnique({ where: { id: b.productId } })).toBeNull();
        expect(await tx.product.findFirst({ where: { id: b.productId } })).toBeNull();
        expect(await tx.product.findFirst({ where: { tenantId: b.tenantId } })).toBeNull();
        expect(
          await tx.product.findFirst({
            where: { OR: [{ id: b.productId }, { tenantId: b.tenantId }] },
          }),
        ).toBeNull();
        expect(await tx.customer.count({ where: { id: b.customerId } })).toBe(0);
        await expect(
          tx.product.findUniqueOrThrow({ where: { id: b.productId } }),
        ).rejects.toThrow();
      });
    });

    it("rechaza un filtro único con el tenantId ajeno", async () => {
      await expect(
        withTenant(a.tenantId, (tx) =>
          tx.product.findUnique({ where: { id: b.productId, tenantId: b.tenantId } }),
        ),
      ).rejects.toBeInstanceOf(CrossTenantError);
    });

    it("no puede modificar filas de otro tenant", async () => {
      await withTenant(a.tenantId, async (tx) => {
        await expect(
          tx.product.update({ where: { id: b.productId }, data: { name: "HACK" } }),
        ).rejects.toThrow();
        const many = await tx.product.updateMany({
          where: { id: b.productId },
          data: { name: "HACK" },
        });
        expect(many.count).toBe(0);
      });
      const untouched = await admin.product.findUniqueOrThrow({ where: { id: b.productId } });
      expect(untouched.name).not.toBe("HACK");
    });

    it("no puede borrar filas de otro tenant", async () => {
      await withTenant(a.tenantId, async (tx) => {
        const result = await tx.partEquivalence.deleteMany({ where: { id: b.equivalenceId } });
        expect(result.count).toBe(0);
        await expect(
          tx.partEquivalence.delete({ where: { id: b.equivalenceId } }),
        ).rejects.toThrow();
      });
      expect(await admin.partEquivalence.count({ where: { id: b.equivalenceId } })).toBe(1);
    });

    it("prohíbe DELETE físico en entidades con borrado lógico", async () => {
      await withTenant(a.tenantId, async (tx) => {
        await expect(tx.product.delete({ where: { id: a.productId } })).rejects.toBeInstanceOf(
          HardDeleteForbiddenError,
        );
        await expect(tx.customer.deleteMany({ where: {} })).rejects.toBeInstanceOf(
          HardDeleteForbiddenError,
        );
      });
      expect(await admin.product.count({ where: { id: a.productId } })).toBe(1);
    });

    it("no permite crear filas para otro tenant", async () => {
      await withTenant(a.tenantId, async (tx) => {
        await expect(
          tx.customer.create({ data: { tenantId: b.tenantId, name: "Intruso" } }),
        ).rejects.toBeInstanceOf(CrossTenantError);
        await expect(
          tx.customer.createMany({
            data: [{ name: "ok" }, { tenantId: b.tenantId, name: "Intruso" }],
          }),
        ).rejects.toBeInstanceOf(CrossTenantError);
      });
      expect(await admin.customer.count({ where: { name: "Intruso" } })).toBe(0);
    });

    it("inyecta el tenant en create y en creaciones anidadas", async () => {
      const customer = await withTenant(a.tenantId, (tx) =>
        tx.customer.create({ data: { name: "Cliente nuevo A", docNumber: `N-${Date.now()}` } }),
      );
      expect(customer.tenantId).toBe(a.tenantId);

      const product = await withTenant(a.tenantId, (tx) =>
        tx.product.create({
          data: {
            sku: `NEST-${Date.now()}`,
            name: "Batería 12V 60Ah",
            kind: "BATTERY",
            batteryDetail: { create: { capacityAh: 60, ccaA: 550, polarity: "LEFT_POSITIVE" } },
          },
          include: { batteryDetail: true },
        }),
      );
      expect(product.tenantId).toBe(a.tenantId);
      expect(product.batteryDetail?.tenantId).toBe(a.tenantId);
    });

    it("no permite mover un registro a otro tenant", async () => {
      await expect(
        withTenant(a.tenantId, (tx) =>
          tx.product.update({ where: { id: a.productId }, data: { tenantId: b.tenantId } }),
        ),
      ).rejects.toBeInstanceOf(CrossTenantError);
    });

    it("upsert no puede tocar filas de otro tenant", async () => {
      await expect(
        withTenant(a.tenantId, (tx) =>
          tx.product.upsert({
            where: { id: b.productId },
            update: { name: "HACK" },
            create: { id: b.productId, sku: "X", name: "HACK", kind: "PART" },
          }),
        ),
      ).rejects.toThrow();
      const untouched = await admin.product.findUniqueOrThrow({ where: { id: b.productId } });
      expect(untouched.name).not.toBe("HACK");
      expect(untouched.tenantId).toBe(b.tenantId);
    });

    it("FK compuestas: no se puede referenciar una fila de otro tenant", async () => {
      await withTenant(a.tenantId, async (tx) => {
        await expect(
          tx.vehicle.create({ data: { customerId: b.customerId, plate: `X-${Date.now()}` } }),
        ).rejects.toThrow(/foreign key|Foreign key/i);
      });
      // Control: el mismo insert con un cliente propio sí funciona.
      const own = await withTenant(a.tenantId, (tx) =>
        tx.vehicle.create({ data: { customerId: a.customerId, plate: `OK-${Date.now()}` } }),
      );
      expect(own.tenantId).toBe(a.tenantId);
    });

    it("withTenant anidado con otro tenant es un error; con el mismo reutiliza la transacción", async () => {
      await expect(
        withTenant(a.tenantId, () => withTenant(b.tenantId, async (tx) => tx.product.findMany())),
      ).rejects.toBeInstanceOf(CrossTenantError);
      const count = await withTenant(a.tenantId, () =>
        withTenant(a.tenantId, (tx) => tx.product.count()),
      );
      expect(count).toBeGreaterThan(0);
    });

    it("rechaza un tenantId que no es UUID", async () => {
      await expect(withTenant("no-es-uuid", async () => 1)).rejects.toThrow(/inválido/);
    });

    it("el modelo Tenant solo expone la propia empresa y no permite escribir fuera de ella", async () => {
      await withTenant(a.tenantId, async (tx) => {
        const tenants = await tx.tenant.findMany();
        expect(tenants.map((t) => t.id)).toEqual([a.tenantId]);
        await expect(
          tx.tenant.update({ where: { id: b.tenantId }, data: { phone: "1" } }),
        ).rejects.toBeInstanceOf(CrossTenantError);
        await expect(
          tx.tenant.create({ data: { legalName: "x", planId: "y" } }),
        ).rejects.toBeInstanceOf(CrossTenantError);
        await expect(
          tx.plan.create({ data: { code: "z", name: "z", priceMonthly: "1" } }),
        ).rejects.toBeInstanceOf(CrossTenantError);
      });
    });
  });

  describe("borrado lógico", () => {
    it("excluye borrados por defecto y los muestra con includeDeleted", async () => {
      const sku = `SOFT-${Date.now()}`;
      const created = await withTenant(a.tenantId, (tx) =>
        tx.product.create({ data: { sku, name: "Temporal", kind: "PART" } }),
      );
      await withTenant(a.tenantId, (tx) =>
        tx.product.update({ where: { id: created.id }, data: softDeleteData() }),
      );

      await withTenant(a.tenantId, async (tx) => {
        expect(await tx.product.findUnique({ where: { id: created.id } })).toBeNull();
        expect(await tx.product.findMany({ where: { sku } })).toHaveLength(0);
        await expect(
          tx.product.update({ where: { id: created.id }, data: { name: "zombie" } }),
        ).rejects.toThrow();
      });
      const visible = await withTenant(
        a.tenantId,
        (tx) => tx.product.findUnique({ where: { id: created.id } }),
        {
          includeDeleted: true,
        },
      );
      expect(visible?.deletedAt).not.toBeNull();
    });

    it("el índice único es parcial: el SKU puede reutilizarse tras borrar, pero no duplicarse activo", async () => {
      const sku = `REUSE-${Date.now()}`;
      const first = await withTenant(a.tenantId, (tx) =>
        tx.product.create({ data: { sku, name: "Uno", kind: "PART" } }),
      );
      await expect(
        withTenant(a.tenantId, (tx) =>
          tx.product.create({ data: { sku, name: "Duplicado", kind: "PART" } }),
        ),
      ).rejects.toThrow();
      await withTenant(a.tenantId, (tx) =>
        tx.product.update({ where: { id: first.id }, data: softDeleteData() }),
      );
      const second = await withTenant(a.tenantId, (tx) =>
        tx.product.create({ data: { sku, name: "Dos", kind: "PART" } }),
      );
      expect(second.id).not.toBe(first.id);
    });

    it("el mismo SKU puede existir en tenants distintos", async () => {
      const sku = `SHARED-${Date.now()}`;
      await withTenant(a.tenantId, (tx) =>
        tx.product.create({ data: { sku, name: "A", kind: "PART" } }),
      );
      const other = await withTenant(b.tenantId, (tx) =>
        tx.product.create({ data: { sku, name: "B", kind: "PART" } }),
      );
      expect(other.tenantId).toBe(b.tenantId);
    });
  });

  describe("capa 2: SQL directo con el rol de la app (RLS)", () => {
    it("sin contexto de tenant no ve nada", async () => {
      const rows = await raw.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM products`;
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it("con contexto A ve solo A, incluso pidiendo explícitamente filas de B", async () => {
      await asTenantRaw(raw, a.tenantId, async (tx) => {
        const own = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM products WHERE id = ${a.productId}::uuid`;
        expect(own).toHaveLength(1);
        const foreign = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM products WHERE id = ${b.productId}::uuid`;
        expect(foreign).toHaveLength(0);
        const byTenant = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM products WHERE "tenantId" = ${b.tenantId}::uuid`;
        expect(byTenant).toHaveLength(0);
        const tenants = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenants`;
        expect(tenants.map((t) => t.id)).toEqual([a.tenantId]);
      });
    });

    it("UPDATE y DELETE sobre filas de B afectan 0 filas", async () => {
      await asTenantRaw(raw, a.tenantId, async (tx) => {
        const updated =
          await tx.$executeRaw`UPDATE products SET name = 'HACK' WHERE id = ${b.productId}::uuid`;
        expect(updated).toBe(0);
        const deleted =
          await tx.$executeRaw`DELETE FROM part_equivalences WHERE id = ${b.equivalenceId}::uuid`;
        expect(deleted).toBe(0);
        const wide = await tx.$executeRaw`UPDATE customers SET name = 'HACK'`;
        expect(wide).toBeGreaterThan(0); // solo los propios
      });
      expect(await admin.customer.count({ where: { tenantId: b.tenantId, name: "HACK" } })).toBe(0);
      expect(
        await admin.customer.count({ where: { tenantId: a.tenantId, name: "HACK" } }),
      ).toBeGreaterThan(0);
    });

    it("INSERT con el tenantId de otro tenant viola la política RLS", async () => {
      await expect(
        asTenantRaw(
          raw,
          a.tenantId,
          (tx) =>
            tx.$executeRaw`INSERT INTO customers (id, "tenantId", name, "updatedAt") VALUES (gen_random_uuid(), ${b.tenantId}::uuid, 'Intruso', now())`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("UPDATE que intenta mover una fila a otro tenant viola la política RLS", async () => {
      await expect(
        asTenantRaw(
          raw,
          a.tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE customers SET "tenantId" = ${b.tenantId}::uuid WHERE id = ${a.customerId}::uuid`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("INSERT sin tenantId toma el del contexto (DEFAULT) y sin contexto falla", async () => {
      const inserted = await asTenantRaw(
        raw,
        a.tenantId,
        (tx) =>
          tx.$queryRaw<
            { tenantId: string }[]
          >`INSERT INTO suppliers (id, name, "updatedAt") VALUES (gen_random_uuid(), 'Default', now()) RETURNING "tenantId"`,
      );
      expect(inserted[0]?.tenantId).toBe(a.tenantId);
      await expect(
        raw.$executeRaw`INSERT INTO suppliers (id, name, "updatedAt") VALUES (gen_random_uuid(), 'Sin contexto', now())`,
      ).rejects.toThrow();
    });

    it("el contexto no se filtra entre transacciones aunque se reutilice la conexión", async () => {
      await asTenantRaw(raw, a.tenantId, (tx) => tx.$queryRaw`SELECT 1`);
      for (let i = 0; i < 25; i += 1) {
        const rows = await raw.$queryRaw<{ setting: string | null; n: bigint }[]>`
          SELECT nullif(current_setting('app.tenant_id', true), '') AS setting,
                 (SELECT count(*) FROM products) AS n`;
        expect(rows[0]?.setting).toBeNull();
        expect(Number(rows[0]?.n)).toBe(0);
      }
    });

    it("el rol de la app no puede alterar estado, plan ni datos fiscales de su tenant", async () => {
      await expect(
        asTenantRaw(
          raw,
          a.tenantId,
          (tx) => tx.$executeRaw`UPDATE tenants SET status = 'ACTIVE', "planId" = "planId"`,
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asTenantRaw(
          raw,
          a.tenantId,
          (tx) =>
            tx.$executeRaw`INSERT INTO tenants (id, "legalName", "planId", "updatedAt") VALUES (gen_random_uuid(), 'x', (SELECT id FROM plans LIMIT 1), now())`,
        ),
      ).rejects.toThrow(/permission denied/i);
      // Campos de contacto sí son editables.
      const ok = await asTenantRaw(
        raw,
        a.tenantId,
        (tx) => tx.$executeRaw`UPDATE tenants SET phone = '999' WHERE id = ${a.tenantId}::uuid`,
      );
      expect(ok).toBe(1);
    });
  });
});
