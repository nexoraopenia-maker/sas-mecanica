import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { hashPassword } from "@/lib/auth/password";
import { totpCode } from "@/lib/auth/totp";
import { createClient } from "@/lib/db/raw.ts";
import { openMenu } from "./helpers";

const PASSWORD = "Taller-Segura-2026";

const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
});

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

/** SuperAdmin nuevo (alta directa en BD) con el 2FA ya registrado, como exige la plataforma. */
async function superAdminSession(page: Page) {
  const email = `root-${randomUUID().slice(0, 8)}@saas.pe`;
  const db = createClient(process.env.ADMIN_DATABASE_URL ?? "");
  await db.user.create({
    data: {
      tenantId: null,
      isSuperAdmin: true,
      email,
      name: "Root",
      status: "ACTIVE",
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  await db.$disconnect();
  await login(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/login\/mfa$/);
  const secret = (await page.locator("p.font-mono").innerText()).trim();
  await page.getByLabel("Código de 6 dígitos").fill(totpCode(secret));
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function newTenantPage(browser: Browser) {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return { context, page: await context.newPage() };
}

test.describe("módulos por cliente, alta rápida y rubro (SuperAdmin → cliente)", () => {
  test("el SuperAdmin crea la cuenta sin RUC, el cliente entra con la clave temporal y los módulos se reflejan en su menú", async ({
    page,
    browser,
  }) => {
    await superAdminSession(page);

    // 1) Alta rápida: plan Standard, rubro «Tienda de autopartes»; sin RUC ni SUNAT.
    await page.goto("/admin/tenants");
    const quick = page.getByTestId("quick-tenant");
    const legalName = `Autopartes E2E ${randomUUID().slice(0, 6)}`;
    const adminEmail = `dueno-${randomUUID().slice(0, 8)}@e2e.pe`;
    await quick.getByLabel("Nombre o razón social").fill(legalName);
    await quick.getByLabel("Nombre del administrador").fill("Dueña E2E");
    await quick.getByLabel("Correo del administrador").fill(adminEmail);
    await quick.getByLabel("Plan", { exact: true }).selectOption({ label: "Standard" });
    await quick.getByLabel("Rubro del negocio").selectOption("AUTOPARTS");
    // El rubro marca las casillas habituales: sin Taller ni Garantías, con Contabilidad.
    await expect(quick.getByTestId("module-workshop").locator("input")).not.toBeChecked();
    await expect(quick.getByTestId("module-warranties").locator("input")).not.toBeChecked();
    await expect(quick.getByTestId("module-accounting").locator("input")).toBeChecked();
    // La IA no está en el plan Standard: la casilla aparece bloqueada.
    await expect(quick.getByTestId("module-ai").locator("input")).toBeDisabled();
    await quick.getByRole("button", { name: "Crear cuenta ahora" }).click();
    const notice = page.getByRole("status").filter({ hasText: "contraseña temporal" });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const text = await notice.innerText();
    const tempPassword = /contraseña temporal (\S+)/.exec(text)?.[1] ?? "";
    const tenantUrl = /(\/admin\/tenants\/[0-9a-f-]{36})/.exec(text)?.[1] ?? "";
    expect(tempPassword.length).toBeGreaterThanOrEqual(10);
    expect(tenantUrl).not.toBe("");

    // 2) El cliente entra con la temporal: debe crear su propia contraseña antes de usar nada.
    const client = await newTenantPage(browser);
    await login(client.page, adminEmail, tempPassword);
    await expect(client.page).toHaveURL(/\/cambiar-clave$/);
    await client.page.goto("/app");
    await expect(client.page).toHaveURL(/\/cambiar-clave$/); // sin cambiarla no hay acceso
    await client.page.getByLabel("Contraseña temporal").fill(tempPassword);
    await client.page.getByLabel("Nueva contraseña").fill("MiClaveNueva2026");
    await client.page.getByLabel("Repite la contraseña").fill("MiClaveNueva2026");
    await client.page.getByRole("button", { name: "Guardar y entrar" }).click();
    await expect(client.page).toHaveURL(/\/app$/, { timeout: 30_000 });

    // 3) Sin RUC: aviso para completar los datos fiscales; rubro comercial: sin Taller ni Garantías.
    await expect(client.page.getByTestId("fiscal-banner")).toContainText("aún no tiene RUC");
    await expect(client.page.getByTestId("dash-stock")).toBeVisible();
    await expect(client.page.getByTestId("dash-workshop")).toHaveCount(0);
    await expect(client.page.getByTestId("dash-warranties")).toHaveCount(0);
    await openMenu(client.page);
    const menu = client.page.locator("#menu-lateral");
    await expect(menu.getByRole("link", { name: "Libros PLE" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Taller", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Garantías" })).toHaveCount(0);

    // 4) El SuperAdmin pasa el negocio a «Mixto» y activa el Taller con las casillas.
    await page.goto(tenantUrl);
    const card = page.getByTestId("modules-card");
    await expect(card.getByTestId("module-workshop").locator("input")).not.toBeChecked();
    await card.getByLabel("Rubro del negocio").selectOption("MIXED");
    await expect(card.getByTestId("module-workshop").locator("input")).toBeChecked();
    await card.getByLabel("Motivo").fill("Cliente también atiende servicios");
    await card.getByRole("button", { name: "Guardar módulos" }).click();
    await expect(page.getByText("Rubro y módulos guardados.")).toBeVisible({ timeout: 30_000 });

    await client.page.goto("/app");
    await expect(client.page.getByTestId("dash-workshop")).toBeVisible();
    await openMenu(client.page);
    await expect(
      client.page.locator("#menu-lateral").getByRole("link", { name: "Taller", exact: true }),
    ).toBeVisible();

    // 5) El SuperAdmin apaga Contabilidad: el cliente ya no ve los Libros PLE ni puede abrir la pantalla.
    await page.goto(tenantUrl);
    await card.getByTestId("module-accounting").locator("input").uncheck();
    await card.getByLabel("Motivo").fill("Contrató solo el plan básico de reportes");
    await card.getByRole("button", { name: "Guardar módulos" }).click();
    await expect(page.getByText("Rubro y módulos guardados.")).toBeVisible({ timeout: 30_000 });
    await client.page.goto("/app");
    await openMenu(client.page);
    await expect(
      client.page.locator("#menu-lateral").getByRole("link", { name: "Libros PLE" }),
    ).toHaveCount(0);
    await client.page.goto("/app/reports/ple");
    await expect(client.page.getByTestId("ple")).toHaveCount(0);

    // 6) Datos fiscales diferidos: con el RUC cargado desaparece el aviso.
    await page.goto(tenantUrl);
    await expect(page.getByTestId("fiscal-pending")).toBeVisible();
    const fiscal = page.getByTestId("fiscal-card");
    const ruc = (() => {
      const prefix = `20${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
      const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
      const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix[i]), 0);
      return `${prefix}${(11 - (sum % 11)) % 10}`;
    })();
    await fiscal.getByLabel("RUC oficial").fill("20100070971");
    await fiscal.getByLabel("Motivo").fill("RUC con dígito mal");
    await fiscal.getByRole("button", { name: "Guardar datos fiscales" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /RUC/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    await fiscal.getByLabel("RUC oficial").fill(ruc);
    await fiscal.getByLabel("Correo corporativo").fill("contabilidad@e2e.pe");
    await fiscal.getByRole("button", { name: "Guardar datos fiscales" }).click();
    await expect(page.getByText("Datos fiscales guardados.")).toBeVisible({ timeout: 30_000 });
    await client.page.goto("/app");
    await expect(client.page.getByTestId("fiscal-banner")).toHaveCount(0);
    await client.context.close();
  });
});

test.describe("inicio adaptable (demo)", () => {
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

  test("el stock se resume en contadores limpios con botón de detalle y filtros por estado", async ({
    page,
  }) => {
    await enterDemo(page);
    const card = page.getByTestId("dash-stock");
    await expect(card).toContainText("Stock crítico");
    await expect(card).toContainText("Por reorden");
    await expect(page.getByTestId("dash-critical")).toHaveText(/^\d+$/);
    await expect(page.getByTestId("dash-reorder")).toHaveText(/^\d+$/);
    // Sin listas largas de productos en el widget.
    await expect(card.locator("ul")).toHaveCount(0);
    await expect(card).not.toContainText("mín.");

    await page.getByTestId("dash-critical-link").click();
    await expect(page).toHaveURL(/\/app\/inventory\?estado=CRITICAL/);
    await expect(page.getByTestId("stock-filter-CRITICAL")).toHaveAttribute("aria-current", "true");
    await page.goto("/app");
    await page.getByTestId("dash-stock-detail").click();
    await expect(page).toHaveURL(/\/app\/inventory$/);
  });

  test("una cuenta mixta (demo) ve Taller y Garantías en el inicio", async ({ page }) => {
    await enterDemo(page);
    await expect(page.getByTestId("dash-workshop")).toBeVisible();
    await expect(page.getByTestId("dash-warranties")).toBeVisible();
  });
});
