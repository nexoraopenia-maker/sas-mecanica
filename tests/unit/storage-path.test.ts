import { describe, expect, it } from "vitest";
import { assertStoragePathBelongsToTenant, buildStoragePath } from "@/lib/security/storage-path";

const tenant = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

describe("rutas de Storage por tenant", () => {
  it("prefija con el tenantId", () => {
    expect(buildStoragePath(tenant, "work-orders", "ot-1", "frente.jpg")).toBe(
      `${tenant}/work-orders/ot-1/frente.jpg`,
    );
  });

  it("rechaza path traversal y caracteres peligrosos", () => {
    for (const bad of ["..", ".", "a/b", "/abs", "", " espacio", "a\\b", "%2e%2e"]) {
      expect(() => buildStoragePath(tenant, "ok", bad), bad).toThrow();
    }
    expect(() => buildStoragePath("no-uuid", "a")).toThrow();
    expect(() => buildStoragePath(tenant)).toThrow();
  });

  it("verifica que una ruta pertenezca al tenant", () => {
    expect(() => assertStoragePathBelongsToTenant(`${tenant}/a/b.jpg`, tenant)).not.toThrow();
    expect(() => assertStoragePathBelongsToTenant(`${other}/a/b.jpg`, tenant)).toThrow();
    expect(() => assertStoragePathBelongsToTenant(`${tenant}/../${other}/b.jpg`, tenant)).toThrow();
    expect(() => assertStoragePathBelongsToTenant(tenant, tenant)).toThrow();
  });
});
