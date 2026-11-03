import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** Cuerpo de cada `export async function` de un archivo de acciones. */
function actionsOf(file: string): Array<{ name: string; body: string }> {
  const source = readFileSync(join(ROOT, "app", "actions", file), "utf8");
  const parts = source.split(/^export async function /m).slice(1);
  return parts.map((part) => ({ name: part.slice(0, part.indexOf("(")), body: part }));
}

/**
 * Las acciones de configuración nunca confían en que un botón esté oculto: cada una resuelve la
 * sesión (y con ella el tenant) en el servidor y delega en un servicio, que valida el permiso.
 */
const CHECKED: Array<{ file: string; only?: string[] }> = [
  { file: "tenant.ts" },
  { file: "company.ts" },
  { file: "purchasing.ts" },
  { file: "sales.ts", only: ["updateInvoiceSettingsAction", "roleDiscountAction"] },
];

describe("acciones de configuración: sesión y tenant resueltos en el servidor", () => {
  for (const { file, only } of CHECKED) {
    for (const action of actionsOf(file).filter((a) => !only || only.includes(a.name))) {
      it(`${file} › ${action.name}`, () => {
        expect(action.body).toMatch(/require(Tenant|Platform)User\(\)|requireUser\(\)/);
        expect(action.body).toMatch(/\bawait [a-zA-Z]+\(/);
        // Las del negocio nunca toman el tenantId del formulario (las de plataforma, de SuperAdmin, sí).
        if (/requireTenantUser\(\)/.test(action.body))
          expect(action.body).not.toMatch(
            /formData\.get\("tenantId"\)|field\(formData, "tenantId"\)/,
          );
      });
    }
  }
  it("revisa un número razonable de acciones", () => {
    const total = CHECKED.reduce(
      (sum, { file, only }) =>
        sum + actionsOf(file).filter((a) => !only || only.includes(a.name)).length,
      0,
    );
    expect(total).toBeGreaterThan(20);
  });
});
