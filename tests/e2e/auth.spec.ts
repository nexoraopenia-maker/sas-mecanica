import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "@/lib/auth/password";
import { totpCode } from "@/lib/auth/totp";
import { createClient } from "@/lib/db/raw.ts";

const PASSWORD = "Taller-Segura-2026";

/** Cada prueba usa su propia IP de origen: los límites de demo/login son por IP. */
test.beforeEach(async ({ context }) => {
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  await context.setExtraHTTPHeaders({ "x-forwarded-for": ip });
});

/** Alertas del formulario (excluye el anunciador de rutas de Next, que también es role=alert). */
const alert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

/** Con Turnstile configurado hay que esperar a que el widget entregue el token antes de enviar. */
async function startDemo(page: Page) {
  await page.goto("/login");
  if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", {
      timeout: 30_000,
    });
  }
  await page.getByRole("button", { name: "Acceso Demo" }).click();
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

test.describe("acceso", () => {
  test("las rutas privadas redirigen al login", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp$/);
    await page.goto("/admin/tenants");
    await expect(page).toHaveURL(/\/login/);
  });

  test("credenciales incorrectas muestran un error genérico", async ({ page }) => {
    await login(page, `nadie-${randomUUID()}@prueba.pe`, "Incorrecta-123456");
    await expect(alert(page)).toContainText("Correo o contraseña incorrectos");
    await expect(page).toHaveURL(/\/login/);
  });

  test("recuperar contraseña no revela si el correo existe", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Correo electrónico").fill(`nadie-${randomUUID()}@prueba.pe`);
    await page.getByRole("button", { name: "Enviar enlace" }).click();
    await expect(page.getByRole("status")).toContainText("Si el correo está registrado");
  });

  test("un enlace de invitación inválido se rechaza", async ({ page }) => {
    await page.goto(`/invite?token=${"x".repeat(43)}`);
    await expect(alert(page)).toContainText("no es válido o ya expiró");
  });

  test("la redirección posterior al login solo acepta rutas internas", async ({ page }) => {
    await page.goto("/login?next=https://evil.example");
    await expect(page.locator('input[name="next"]')).toHaveValue("https://evil.example");
    await login(page, `nadie-${randomUUID()}@prueba.pe`, "Incorrecta-123456");
    await expect(page).not.toHaveURL(/evil\.example/);
  });
});

test.describe("cuenta demo", () => {
  test("Acceso Demo crea un taller de ejemplo, muestra el banner y permite restaurar", async ({
    page,
  }) => {
    await startDemo(page);
    await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
    await expect(page.getByTestId("demo-banner")).toContainText(
      "envíos a clientes y proveedores son simulados",
    );
    await expect(page.getByRole("heading", { name: /Hola, Dueño Demo/ })).toBeVisible();
    expect(Number(await page.getByTestId("permission-count").innerText())).toBeGreaterThan(40);

    await page.getByRole("link", { name: "Usuarios" }).click();
    await expect(page.getByText("Mecánico Demo", { exact: true })).toBeVisible();
    await expect(page.getByText("Dueño Demo", { exact: true })).toBeVisible();

    const firstUrl = page.url();
    await page.getByRole("button", { name: "Restaurar demo" }).click();
    await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
    await expect(page.getByTestId("demo-banner")).toBeVisible();
    expect(firstUrl).toContain("/app/users");
  });

  test("la sesión demo no entra al panel SuperAdmin", async ({ page }) => {
    await startDemo(page);
    await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/app$/);
  });

  test("cerrar sesión elimina el acceso", async ({ page }) => {
    await startDemo(page);
    await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
    await page.getByRole("button", { name: "Salir" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("SuperAdmin", () => {
  test("2FA obligatorio, alta de empresa e impersonación con banner", async ({ page }) => {
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

    // 1) Primer ingreso: obligatorio registrar el 2FA.
    await login(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/login\/mfa$/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\/mfa$/); // sin 2FA no hay acceso al panel
    const secret = (await page.locator("p.font-mono").innerText()).trim();
    await page.getByLabel("Código de 6 dígitos").fill("000000");
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect(alert(page)).toContainText("Código de verificación incorrecto");
    await page.getByLabel("Código de 6 dígitos").fill(totpCode(secret));
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Resumen de la plataforma" })).toBeVisible();

    // 2) Alta de empresa.
    await page.getByRole("link", { name: "Empresas" }).click();
    const legalName = `Taller E2E ${randomUUID().slice(0, 6)} SAC`;
    await page.getByLabel("Razón social").fill(legalName);
    await page.getByLabel("RUC / NIT").fill(`20${Math.floor(Math.random() * 1e9)}`);
    await page.getByLabel("Nombre del administrador").fill("Admin E2E");
    await page
      .getByLabel("Correo del administrador")
      .fill(`admin-${randomUUID().slice(0, 8)}@e2e.pe`);
    await page.getByRole("button", { name: "Crear empresa e invitar administrador" }).click();
    await expect(page.getByRole("heading", { level: 1, name: legalName })).toBeVisible();

    // 3) Impersonación: motivo obligatorio, banner permanente y regreso al panel.
    const supportReason = page
      .locator("form", { has: page.getByRole("button", { name: "Entrar como soporte" }) })
      .getByLabel("Motivo");
    await supportReason.fill("corto");
    await page.getByRole("button", { name: "Entrar como soporte" }).click();
    await expect(alert(page).filter({ hasText: "mínimo 10" })).toBeVisible();
    await supportReason.fill("Ticket E2E: revisar configuración de caja");
    await page.getByRole("button", { name: "Entrar como soporte" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByTestId("support-banner")).toContainText("Ticket E2E");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/app$/); // en soporte no se usa la plataforma
    await page.getByRole("button", { name: "Terminar soporte" }).click();
    await expect(page).toHaveURL(/\/admin\/tenants\/.+/);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/admin$/); // sesión de plataforma, sin tenant
  });

  test("un usuario sin 2FA no ve el panel aunque conozca la URL", async ({ page }) => {
    await page.goto("/admin/plans");
    await expect(page).toHaveURL(/\/login/);
  });
});
