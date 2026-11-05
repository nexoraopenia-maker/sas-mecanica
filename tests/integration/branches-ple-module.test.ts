import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type AuthUser } from "@/lib/auth/can";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  createBranch,
  createWarehouse,
  getBranchContext,
  getBranchesOverview,
  setActiveBranch,
  setBranchActive,
  setWarehouseActive,
  updateBranch,
  updateWarehouse,
} from "@/server/services/branches";
import { openCashSession } from "@/server/services/cash";
import { registerStockIn } from "@/server/services/inventory";
import {
  exportPle,
  exportPleZip,
  previewPle,
  registerPurchaseInvoice,
} from "@/server/services/ple";
import { createRoleFromTemplate } from "@/server/services/roles";
import { createSale } from "@/server/services/sales";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import { updateTenantModules } from "@/server/services/tenants";
import { changeUserBranch, inviteUser } from "@/server/services/users";
import { addUser, bootstrapTenant, meta, superAdminUser } from "../helpers/auth.ts";
import { adminClient } from "../helpers/db.ts";
import { inventoryWorld, key, make, plain, type InventoryWorld } from "../helpers/inventory.ts";

// Todas las casillas que ofrece el plan Standard (no incluye IA).
const ALL_GROUPS = [
  "core",
  "billing",
  "workshop",
  "warranties",
  "purchasing",
  "whatsapp",
  "accounting",
  "branches",
  "reports",
];

function ruc(prefix10: string): string {
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix10[i]), 0);
  return `${prefix10}${(11 - (sum % 11)) % 10}`;
}
const newRuc = () => ruc(`20${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);

describe("sucursales y libros PLE bajo módulos", () => {
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
  const setModules = (tenantId: string, groups: string[]) =>
    updateTenantModules(
      sa,
      { tenantId, businessType: "MIXED", groups, reason: "Prueba de módulos" },
      meta(),
    );

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    sa = await superAdminUser(admin);
    w = await inventoryWorld(admin, "pro");
    other = await inventoryWorld(admin, "pro");
  }, 240_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  describe("sucursales y almacenes", () => {
    let south: { id: string; warehouseId: string };

    it("crea una sucursal con su almacén principal y respeta el límite del plan", async () => {
      south = await createBranch(
        w.admin,
        { code: "sur", name: "Tienda Sur", address: "Av. Sur 123" },
        meta(),
      );
      const warehouse = await admin.warehouse.findUniqueOrThrow({
        where: { id: south.warehouseId },
      });
      expect(warehouse).toMatchObject({ branchId: south.id, isDefault: true, code: "ALM-SUR" });
      await createBranch(w.admin, { code: "NORTE", name: "Tienda Norte" }, meta());
      await expect(
        createBranch(w.admin, { code: "ESTE", name: "Tienda Este" }, meta()),
      ).rejects.toMatchObject({ code: "PLAN_LIMIT" });
      await expect(
        createBranch(w.admin, { code: "SUR", name: "Otra" }, meta()),
      ).rejects.toBeTruthy();
      const overview = await getBranchesOverview(w.admin);
      expect(overview.usage.branches).toEqual({ used: 3, max: 3 });
      expect(overview.branches.map((b) => b.code)).toEqual(
        expect.arrayContaining(["SUR", "NORTE"]),
      );
      expect(overview.branches[0]?.isMain).toBe(true);
    });

    it("exige el módulo Multi-sucursal y permisos", async () => {
      const t = await bootstrapTenant(admin, "pro", sa);
      await setModules(t.tenantId, ["core", "billing", "reports"]);
      await expect(
        createBranch(await refresh(t.adminId, t.tenantId), { code: "X1", name: "Sede X" }, meta()),
      ).rejects.toMatchObject({ code: "MODULE_DISABLED" });
      await expect(getBranchesOverview(await refresh(t.adminId, t.tenantId))).rejects.toMatchObject(
        { code: "PERMISSION_DENIED" },
      );
      await expect(
        createBranch(w.cashier, { code: "X2", name: "Sede X" }, meta()),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(
        updateBranch(w.cashier, { id: south.id, name: "Hack" }, meta()),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }, 120_000);

    it("edita datos y deja constancia", async () => {
      await updateBranch(
        w.admin,
        { id: south.id, name: "Tienda Sur Renovada", address: "Av. Nueva 9", phone: "999888777" },
        meta(),
      );
      const row = await admin.branch.findUniqueOrThrow({ where: { id: south.id } });
      expect(row).toMatchObject({
        name: "Tienda Sur Renovada",
        address: "Av. Nueva 9",
        phone: "999888777",
      });
      const entry = await admin.auditLog.findFirstOrThrow({
        where: { tenantId: w.tenantId, action: "branch.updated", entityId: south.id },
      });
      expect(entry.after).toMatchObject({ name: "Tienda Sur Renovada" });
    });

    it("la sucursal principal y la última activa no se desactivan; tampoco con cajas abiertas o gente asignada", async () => {
      const main = await admin.branch.findFirstOrThrow({
        where: { tenantId: w.tenantId, isMain: true },
      });
      await expect(
        setBranchActive(w.admin, { id: main.id, active: false }, meta()),
      ).rejects.toMatchObject({ code: "BRANCH_MAIN" });
      const norte = await admin.branch.findFirstOrThrow({
        where: { tenantId: w.tenantId, code: "NORTE" },
      });
      await changeUserBranch(w.admin, { userId: w.cashier.userId, branchId: norte.id }, meta());
      await expect(
        setBranchActive(w.admin, { id: norte.id, active: false }, meta()),
      ).rejects.toMatchObject({ code: "BRANCH_HAS_USERS" });
      await changeUserBranch(w.admin, { userId: w.cashier.userId, branchId: null }, meta());
      await setBranchActive(w.admin, { id: norte.id, active: false }, meta());
      expect((await admin.branch.findUniqueOrThrow({ where: { id: norte.id } })).isActive).toBe(
        false,
      );
      // Una sucursal inactiva ya no admite usuarios ni almacenes nuevos.
      await expect(
        changeUserBranch(w.admin, { userId: w.cashier.userId, branchId: norte.id }, meta()),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      await expect(
        createWarehouse(
          w.admin,
          { branchId: norte.id, code: "ALM-N2", name: "No debe crearse" },
          meta(),
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      await setBranchActive(w.admin, { id: norte.id, active: true }, meta());
    }, 120_000);

    it("los almacenes: se crean y renombran; el principal y los que tienen stock no se desactivan", async () => {
      const created = await createWarehouse(
        w.admin,
        { branchId: south.id, code: "ALM-S2", name: "Almacén Sur 2" },
        meta(),
      );
      await expect(
        createWarehouse(w.admin, { branchId: south.id, code: "ALM-S2", name: "Repetido" }, meta()),
      ).rejects.toMatchObject({ code: "WAREHOUSE_CODE_TAKEN" });
      await updateWarehouse(w.admin, { id: created.id, name: "Almacén Sur Secundario" }, meta());
      expect((await admin.warehouse.findUniqueOrThrow({ where: { id: created.id } })).name).toBe(
        "Almacén Sur Secundario",
      );
      await expect(
        setWarehouseActive(w.admin, { id: south.warehouseId, active: false }, meta()),
      ).rejects.toMatchObject({ code: "WAREHOUSE_DEFAULT" });

      const product = await make(w.manager, plain({ name: "Producto en almacén", salePrice: 10 }));
      await registerStockIn(
        w.manager,
        {
          warehouseId: created.id,
          productId: product.id,
          quantity: "3",
          unitCost: "5",
          idempotencyKey: key(),
        } as never,
        meta(),
      );
      await expect(
        setWarehouseActive(w.admin, { id: created.id, active: false }, meta()),
      ).rejects.toMatchObject({ code: "WAREHOUSE_HAS_STOCK" });
      const empty = await createWarehouse(
        w.admin,
        { branchId: south.id, code: "ALM-S3", name: "Vacío" },
        meta(),
      );
      await setWarehouseActive(w.admin, { id: empty.id, active: false }, meta());
      expect((await admin.warehouse.findUniqueOrThrow({ where: { id: empty.id } })).isActive).toBe(
        false,
      );
      await setWarehouseActive(w.admin, { id: empty.id, active: true }, meta());
    }, 120_000);

    it("elegir la sucursal de trabajo: cambia la sucursal del usuario y no con la caja abierta", async () => {
      const ctx = await getBranchContext(w.admin);
      expect(ctx.canSwitch).toBe(true);
      expect(ctx.branches.length).toBeGreaterThanOrEqual(2);
      await setActiveBranch(w.admin, south.id, meta());
      expect((await getBranchContext(w.admin)).active?.id).toBe(south.id);
      expect(
        (await admin.user.findUniqueOrThrow({ where: { id: w.admin.userId } })).defaultBranchId,
      ).toBe(south.id);
      // Con la caja abierta en esa sucursal hay que cerrarla antes de cambiar.
      await openCashSession(w.admin, { openingAmount: 0 }, meta());
      const main = await admin.branch.findFirstOrThrow({
        where: { tenantId: w.tenantId, isMain: true },
      });
      await expect(setActiveBranch(w.admin, main.id, meta())).rejects.toMatchObject({
        code: "BRANCH_SWITCH_OPEN_CASH",
      });
      await expect(
        setBranchActive(w.admin, { id: south.id, active: false }, meta()),
      ).rejects.toMatchObject({ code: "BRANCH_OPEN_CASH" });
      const entry = await admin.auditLog.findFirstOrThrow({
        where: { tenantId: w.tenantId, action: "user.active_branch_changed" },
      });
      expect(entry.after).toMatchObject({ branchId: south.id });
    }, 120_000);

    it("las ventas usan el almacén de la sucursal de trabajo", async () => {
      const product = await make(w.manager, plain({ name: "Venta en la sucursal", salePrice: 59 }));
      await registerStockIn(
        w.manager,
        {
          warehouseId: south.warehouseId,
          productId: product.id,
          quantity: "4",
          unitCost: "20",
          idempotencyKey: key(),
        } as never,
        meta(),
      );
      const sale = await createSale(
        w.admin,
        {
          idempotencyKey: key(),
          documentType: "NOTA_VENTA",
          items: [{ productId: product.id, quantity: "1" }],
          payments: [{ method: "CASH", amount: "59" }],
        } as never,
        meta(),
      );
      expect(sale.id).toBeTruthy();
      const balance = await admin.stockBalance.findFirstOrThrow({
        where: { productId: product.id, warehouseId: south.warehouseId },
      });
      expect(Number(balance.quantity)).toBe(3);
    }, 120_000);

    it("aislamiento: otro negocio no ve ni toca estas sucursales", async () => {
      await expect(
        updateBranch(other.admin, { id: south.id, name: "Robada" }, meta()),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      await expect(setActiveBranch(other.admin, south.id, meta())).rejects.toMatchObject({
        name: "NotFoundError",
      });
      await expect(
        setBranchActive(other.admin, { id: south.id, active: false }, meta()),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      const theirs = await getBranchesOverview(other.admin);
      expect(theirs.branches.map((b) => b.id)).not.toContain(south.id);
      expect(await getBranchContext(w.cashier).then((c) => c.canSwitch)).toBe(false);
    });
  });

  describe("libros PLE bajo el módulo Contabilidad", () => {
    let t: Awaited<ReturnType<typeof bootstrapTenant>>;
    const period = { year: 2026, month: 3 };

    beforeAll(async () => {
      t = await bootstrapTenant(admin, "pro", sa);
      await admin.tenant.update({ where: { id: t.tenantId }, data: { taxId: newRuc() } });
    }, 120_000);

    it("sin el módulo (apagado por el SuperAdmin) no se ve ni se descarga nada", async () => {
      await setModules(t.tenantId, ["core", "billing", "reports"]);
      const user = await refresh(t.adminId, t.tenantId);
      expect(can(user, "accounting:ver")).toBe(false);
      await expect(previewPle(user, period)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(exportPle(user, { book: "14.1", ...period })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(exportPleZip(user, period)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await setModules(t.tenantId, ALL_GROUPS);
    }, 120_000);

    it("en un plan Básico tampoco existe", async () => {
      const basic = await bootstrapTenant(admin, "basic", sa);
      await expect(
        previewPle(await refresh(basic.adminId, basic.tenantId), period),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }, 120_000);

    it("el ZIP trae los dos libros, queda registrado quién los descargó y no guarda su contenido", async () => {
      const user = await refresh(t.adminId, t.tenantId);
      await registerPurchaseInvoice(
        user,
        {
          docTypeCode: "01",
          series: "F777",
          number: "1001",
          issueDate: "2026-03-10",
          supplierDocNumber: ruc("2010007097"),
          supplierName: "Repuestos SA",
          taxedBase: "100.00",
          igv: "18.00",
        },
        meta(),
      );
      const zip = await exportPleZip(user, period, meta());
      expect(zip.fileName).toMatch(/^PLE-\d{11}-202603\.zip$/);
      expect(zip.rows.purchases).toBe(1);
      const end = zip.content.length - 22;
      expect(zip.content.readUInt16LE(end + 10)).toBe(2);
      const text = zip.content.toString("latin1");
      expect(text).toContain("140100");
      expect(text).toContain("080100");
      const exports = await admin.auditLog.findMany({
        where: { tenantId: t.tenantId, action: "ple.exported" },
      });
      expect(exports.length).toBeGreaterThanOrEqual(2);
      expect(exports.every((e) => e.actorUserId === user.userId)).toBe(true);
      expect(JSON.stringify(exports)).not.toContain("Repuestos SA");
    }, 120_000);

    it("la vista previa muestra muestras y avisa filas inválidas; con ellas no se genera el archivo", async () => {
      const user = await refresh(t.adminId, t.tenantId);
      const clean = await previewPle(user, period);
      expect(clean.purchases.invalidRows).toBe(0);
      expect(clean.purchases.sample[0]).toMatchObject({
        document: "01 F777-1001",
        total: "118.00",
      });
      await admin.purchaseInvoice.create({
        data: {
          tenantId: t.tenantId,
          docTypeCode: "01",
          series: "F888",
          number: "9",
          issueDate: new Date("2026-03-12T17:00:00Z"),
          period: 202603,
          supplierDocType: "RUC",
          supplierDocNumber: null,
          supplierName: null,
          taxedBase: 10,
          igv: 1.8,
          exemptTotal: 0,
          total: 11.8,
        },
      });
      const dirty = await previewPle(user, period);
      expect(dirty.purchases.invalidRows).toBe(1);
      expect(dirty.purchases.firstError).toMatch(/Campo/);
      await expect(exportPle(user, { book: "8.1", ...period })).rejects.toMatchObject({
        code: "PLE_INVALID",
      });
      await expect(exportPleZip(user, period)).rejects.toMatchObject({ code: "PLE_INVALID" });
      await admin.purchaseInvoice
        .deleteMany({ where: { tenantId: t.tenantId, series: "F888" } })
        .catch(() => undefined);
    }, 120_000);

    it("la plantilla «Contador» descarga y registra compras, pero no vende ni toca inventario", async () => {
      const adminUser = await refresh(t.adminId, t.tenantId);
      const role = await createRoleFromTemplate(adminUser, "contador", meta());
      const accountant = await addUser(
        (input: { email: string; name: string; roleId: string }) =>
          inviteUser(adminUser, input, meta()),
        admin,
        t.tenantId,
        role.id,
        "Contador Externo",
      );
      expect(can(accountant, "accounting:ver")).toBe(true);
      await expect(
        exportPle(accountant, { book: "14.1", year: 2026, month: 4 }, meta()),
      ).resolves.toMatchObject({ rows: 0 });
      await expect(
        registerPurchaseInvoice(
          accountant,
          {
            docTypeCode: "01",
            series: "F900",
            number: String(Math.floor(Math.random() * 1e6)),
            issueDate: "2026-04-05",
            supplierDocNumber: ruc("2010007097"),
            supplierName: "Proveedor",
            taxedBase: "50.00",
            igv: "9.00",
          },
          meta(),
        ),
      ).resolves.toBeTruthy();
      const product = await make(adminUser, plain({ name: "Para el contador", salePrice: 10 }));
      await expect(
        createSale(
          accountant,
          {
            idempotencyKey: key(),
            documentType: "NOTA_VENTA",
            items: [{ productId: product.id, quantity: "1" }],
            payments: [{ method: "CASH", amount: "10" }],
          } as never,
          meta(),
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(createRoleFromTemplate(adminUser, "contador", meta())).rejects.toMatchObject({
        code: "ROLE_NAME_TAKEN",
      });
      void randomUUID();
    }, 180_000);
  });
});
