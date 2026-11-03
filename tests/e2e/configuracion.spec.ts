import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { goConfig } from "./helpers";

test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.${octet()}.${octet()}.${octet()}` });
});

async function enterDemo(page: Page) {
  await page.goto("/login");
  if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", {
      timeout: 30_000,
    });
  }
  await page.getByRole("button", { name: "Acceso Demo" }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
}

/** PNG mínimo con cabecera válida de 200 × 80 px (el servidor valida tipo, peso y dimensiones). */
function pngBuffer(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

test.describe("Configuración (demo)", () => {
  test("las pantallas antiguas redirigen a su pestaña y Configuración es la única entrada", async ({
    page,
  }) => {
    await enterDemo(page);
    for (const [from, tab] of [
      ["/app/users", "usuarios"],
      ["/app/roles", "roles"],
      ["/app/settings", "taller"],
      ["/app/subscription", "plan"],
      ["/app/ai", "ia"],
    ] as const) {
      await page.goto(from);
      await expect(page).toHaveURL(new RegExp(`/app/configuracion\\?tab=${tab}`));
      await expect(page.getByTestId(`settings-tab-${tab}`)).toHaveAttribute("aria-current", "page");
    }
    // El grupo provisional «Administración» ya no existe.
    await expect(page.getByText("Administración", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("settings-tab-facturacion")).toBeVisible();
  });

  test("usuarios: uso del plan, sucursal oculta con una sola sucursal y el propio usuario sin desactivar", async ({
    page,
  }) => {
    await enterDemo(page);
    await goConfig(page, "usuarios");
    await expect(page.getByTestId("users-usage")).toContainText("Usuarios activos");
    // El selector de sucursal del formulario de invitación no existe (los de cada fila sí).
    await expect(page.locator("#branchId")).toHaveCount(0);
    const own = page.getByTestId("user-row").filter({ hasText: "(tú)" });
    await expect(own).toHaveCount(1);
    await expect(own.getByRole("button", { name: "Deshabilitar" })).toHaveCount(0);
  });

  test("roles: crea «Asesor de servicio» con un clic y aparece en la matriz", async ({ page }) => {
    await enterDemo(page);
    await goConfig(page, "roles");
    await page.getByRole("button", { name: "Crear con un clic" }).click();
    // Al crearse, la plantilla desaparece de la lista y el rol aparece en la matriz.
    await expect(page.getByTestId("role-templates")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("role-matrix")).toContainText("Asesor de servicio");
  });

  test("facturación: rechaza series con formato inválido y las repetidas", async ({ page }) => {
    await enterDemo(page);
    await goConfig(page, "facturacion");
    const boleta = page.getByLabel("Serie de boletas");
    await boleta.fill("B1");
    // El navegador ya valida el patrón; se quita para comprobar que el servidor responde igual.
    await boleta.evaluate((el: HTMLInputElement) => {
      el.removeAttribute("pattern");
      el.removeAttribute("maxlength");
    });
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await expect(page.getByText(/formato B###/)).toBeVisible({ timeout: 30_000 });
  });

  test("logo: rechaza lo que no es imagen y acepta un PNG válido", async ({ page }) => {
    await enterDemo(page);
    await goConfig(page, "taller");
    await page.getByLabel(/Imagen \(PNG/).setInputFiles({
      name: "logo.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
    });
    await page.getByRole("button", { name: "Subir logo" }).click();
    await expect(page.getByText(/PNG, JPG o WebP \(no se admite SVG\)/)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByLabel(/Imagen \(PNG/).setInputFiles({
      name: `logo-${randomUUID().slice(0, 6)}.png`,
      mimeType: "image/png",
      buffer: pngBuffer(200, 80),
    });
    await page.getByRole("button", { name: "Subir logo" }).click();
    await expect(page.getByText("Logo actualizado.")).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(page.getByTestId("logo-preview")).toBeVisible();
    await page.getByRole("button", { name: "Quitar logo" }).click();
    await expect(page.getByTestId("logo-empty")).toBeVisible({ timeout: 30_000 });
  });

  test("IA y canales: interruptores y clave de OpenAI sin exponerla", async ({ page }) => {
    await enterDemo(page);
    await goConfig(page, "ia");
    await expect(page.getByTestId("automation-switches")).toBeVisible();
    await page.getByLabel("Avisos a clientes por WhatsApp").uncheck();
    await page.getByRole("button", { name: "Guardar interruptores" }).click();
    await expect(page.getByText("Interruptores guardados.")).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(page.getByLabel("Avisos a clientes por WhatsApp")).not.toBeChecked();
    await page.getByLabel("Avisos a clientes por WhatsApp").check();
    await page.getByRole("button", { name: "Guardar interruptores" }).click();
    await expect(page.getByText("Interruptores guardados.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("api-key-state")).toBeVisible();
  });

  test("plan: límites con su uso y botón para activar el plan", async ({ page }) => {
    await enterDemo(page);
    await goConfig(page, "plan");
    await expect(page.getByTestId("limit-users")).toContainText("/");
    await expect(page.getByTestId("limit-branches")).toBeVisible();
    await expect(page.getByTestId("demo-activate")).toBeVisible();
  });
});
