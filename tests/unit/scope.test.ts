import { describe, expect, it } from "vitest";
import { CrossTenantError, HardDeleteForbiddenError } from "@/lib/errors";
import { allModelMetas, getModelMeta } from "@/lib/db/models.ts";
import { scopeOperation, softDeleteData } from "@/lib/db/scope.ts";

const input = { tenantId: "11111111-1111-4111-8111-111111111111", includeDeleted: false };
const other = "22222222-2222-4222-8222-222222222222";

describe("metadatos de modelos (derivados del schema)", () => {
  it("clasifica catálogos, tenant y modelos de negocio", () => {
    expect(getModelMeta("Plan").scopeField).toBeNull();
    expect(getModelMeta("Permission").scopeField).toBeNull();
    expect(getModelMeta("Tenant").scopeField).toBe("id");
    expect(getModelMeta("Product")).toEqual({ scopeField: "tenantId", softDelete: true });
    expect(getModelMeta("KardexMovement")).toEqual({ scopeField: "tenantId", softDelete: false });
  });

  it("todo modelo, salvo catálogos globales y Tenant, está acotado por tenantId", () => {
    const unscoped = [...allModelMetas()]
      .filter(([, meta]) => meta.scopeField !== "tenantId")
      .map(([name]) => name);
    expect(unscoped.sort()).toEqual(["Permission", "Plan", "RateLimitBucket", "Tenant"]);
  });
});

describe("scopeOperation", () => {
  it("find*: conserva el filtro del llamador y añade tenant + borrado lógico con AND", () => {
    const args = scopeOperation(
      "Product",
      "findMany",
      { where: { OR: [{ sku: "A" }, { sku: "B" }] } },
      input,
    );
    expect(args).toEqual({
      where: {
        AND: [
          { OR: [{ sku: "A" }, { sku: "B" }] },
          { tenantId: input.tenantId },
          { deletedAt: null },
        ],
      },
    });
  });

  it("find* sin args también se acota", () => {
    expect(scopeOperation("Customer", "count", undefined, input)).toEqual({
      where: { AND: [{ tenantId: input.tenantId }, { deletedAt: null }] },
    });
  });

  it("no filtra deletedAt en modelos sin borrado lógico ni con includeDeleted", () => {
    expect(scopeOperation("KardexMovement", "findMany", {}, input)).toEqual({
      where: { AND: [{ tenantId: input.tenantId }] },
    });
    expect(scopeOperation("Product", "findMany", {}, { ...input, includeDeleted: true })).toEqual({
      where: { AND: [{ tenantId: input.tenantId }] },
    });
  });

  it("findUnique: añade tenantId y deletedAt a la clave única; rechaza tenantId ajeno", () => {
    expect(scopeOperation("Product", "findUnique", { where: { id: "x" } }, input)).toEqual({
      where: { id: "x", tenantId: input.tenantId, deletedAt: null },
    });
    expect(() =>
      scopeOperation("Product", "findUnique", { where: { id: "x", tenantId: other } }, input),
    ).toThrow(CrossTenantError);
  });

  it("create / createMany: fijan tenantId y rechazan el de otro tenant o la relación tenant", () => {
    expect(scopeOperation("Product", "create", { data: { sku: "A" } }, input)).toEqual({
      data: { sku: "A", tenantId: input.tenantId },
    });
    expect(
      scopeOperation("Product", "createMany", { data: [{ sku: "A" }, { sku: "B" }] }, input),
    ).toEqual({
      data: [
        { sku: "A", tenantId: input.tenantId },
        { sku: "B", tenantId: input.tenantId },
      ],
    });
    expect(() => scopeOperation("Product", "create", { data: { tenantId: other } }, input)).toThrow(
      CrossTenantError,
    );
    expect(() =>
      scopeOperation("Product", "create", { data: { tenant: { connect: { id: other } } } }, input),
    ).toThrow(CrossTenantError);
    expect(() =>
      scopeOperation("Product", "createMany", { data: [{ tenantId: other }] }, input),
    ).toThrow(CrossTenantError);
  });

  it("update / updateMany: acotan el where y prohíben mover el registro", () => {
    expect(
      scopeOperation("Product", "update", { where: { id: "x" }, data: { name: "n" } }, input),
    ).toEqual({
      where: { id: "x", tenantId: input.tenantId, deletedAt: null },
      data: { name: "n" },
    });
    expect(() =>
      scopeOperation("Product", "update", { where: { id: "x" }, data: { tenantId: other } }, input),
    ).toThrow(CrossTenantError);
    expect(() =>
      scopeOperation(
        "Product",
        "updateMany",
        { where: {}, data: { tenantId: { set: other } } },
        input,
      ),
    ).toThrow(CrossTenantError);
    expect(
      scopeOperation(
        "Product",
        "updateMany",
        { where: { sku: "A" }, data: { tenantId: input.tenantId } },
        input,
      ),
    ).toBeTruthy();
  });

  it("upsert acota where, create y update", () => {
    const args = scopeOperation(
      "Product",
      "upsert",
      { where: { id: "x" }, create: { sku: "A" }, update: { name: "n" } },
      input,
    );
    expect(args).toEqual({
      where: { id: "x", tenantId: input.tenantId, deletedAt: null },
      create: { sku: "A", tenantId: input.tenantId },
      update: { name: "n" },
    });
  });

  it("delete: prohibido en soft delete; permitido (acotado) en el resto", () => {
    expect(() => scopeOperation("Product", "delete", { where: { id: "x" } }, input)).toThrow(
      HardDeleteForbiddenError,
    );
    expect(() => scopeOperation("Product", "deleteMany", {}, input)).toThrow(
      HardDeleteForbiddenError,
    );
    expect(
      scopeOperation("PartEquivalence", "deleteMany", { where: { code: "A" } }, input),
    ).toEqual({
      where: { AND: [{ code: "A" }, { tenantId: input.tenantId }] },
    });
    expect(scopeOperation("PartEquivalence", "delete", { where: { id: "x" } }, input)).toEqual({
      where: { id: "x", tenantId: input.tenantId },
    });
  });

  it("Tenant: lectura y update solo de la propia empresa", () => {
    expect(scopeOperation("Tenant", "findMany", {}, input)).toEqual({
      where: { AND: [{ id: input.tenantId }, { deletedAt: null }] },
    });
    expect(() =>
      scopeOperation("Tenant", "update", { where: { id: other }, data: {} }, input),
    ).toThrow(CrossTenantError);
    expect(() => scopeOperation("Tenant", "create", { data: {} }, input)).toThrow(CrossTenantError);
    expect(() =>
      scopeOperation("Tenant", "delete", { where: { id: input.tenantId } }, input),
    ).toThrow(CrossTenantError);
  });

  it("catálogos globales: solo lectura", () => {
    expect(scopeOperation("Plan", "findMany", {}, input)).toEqual({});
    expect(() => scopeOperation("Plan", "update", { where: { id: "x" }, data: {} }, input)).toThrow(
      CrossTenantError,
    );
    expect(() => scopeOperation("Permission", "create", { data: {} }, input)).toThrow(
      CrossTenantError,
    );
  });

  it("falla cerrado ante operaciones desconocidas", () => {
    expect(() => scopeOperation("Product", "findRaw", {}, input)).toThrow(CrossTenantError);
  });

  it("softDeleteData devuelve una fecha", () => {
    expect(softDeleteData().deletedAt).toBeInstanceOf(Date);
  });
});
