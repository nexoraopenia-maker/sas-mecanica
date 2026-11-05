import { expect, test, type Page } from "@playwright/test";
import { goNav } from "./helpers";

/**
 * Corre solo en el proyecto «camera» de playwright.config.ts: Chromium con una cámara falsa que muestra un
 * EAN-13 (tests/fixtures/ean13.mjpeg = 7750001112228). Regenerar: node scripts/generate-scan-fixture.mjs
 */
const BARCODE = "7750001112228";

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

test.describe("escáner con la cámara en el POS", () => {
  test("lee el código de barras con la cámara y agrega el producto al carrito", async ({
    page,
  }) => {
    await enterDemo(page);
    // Producto con el código de barras que muestra la cámara falsa.
    await page.goto("/app/catalog");
    await page.getByRole("button", { name: "Nuevo producto" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Nuevo producto" });
    await dialog
      .getByLabel("SKU", { exact: true })
      .fill(`ESC-${Date.now().toString(36).toUpperCase()}`);
    await dialog.getByLabel("Nombre", { exact: true }).fill("Llanta del escáner e2e");
    await dialog.getByLabel("Precio de venta").fill("59");
    await dialog.getByLabel("Código de barras", { exact: true }).fill(BARCODE);
    // El tipo por defecto es Llanta: lleva medida (la misma que usan las demás pruebas de alta).
    await dialog.getByLabel("Medida de llanta").fill("195/65R15");
    await dialog.getByRole("button", { name: "Crear producto" }).click();
    await expect(dialog.getByText(/Producto .* creado\./)).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Cerrar" }).click();

    // Caja abierta y mostrador.
    await goNav(page, "Vender", { exact: true });
    await expect(page.getByRole("heading", { name: "Punto de venta", level: 1 })).toBeVisible();
    if (await page.getByText("Abre tu caja para empezar a vender.").isVisible()) {
      await goNav(page, "Caja", { exact: true });
      await page.getByLabel("Efectivo inicial").fill("100");
      await page.getByRole("button", { name: "Abrir caja" }).click();
      await expect(page).toHaveURL(/\/app\/pos$/, { timeout: 30_000 });
    }

    await page.getByTestId("scan-camera").click();
    await expect(page.getByTestId("scanner-dialog")).toBeVisible();
    await expect(page.getByTestId("scanner-video")).toBeVisible();
    // La cámara falsa muestra el EAN-13: el producto entra al carrito sin teclear nada.
    const line = page.getByTestId("cart-line").filter({ hasText: "Llanta del escáner e2e" });
    await expect(line).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("scanner-status")).toContainText("Agregado");
    await expect(page.getByTestId("pos-total")).toContainText("S/");
    // Mientras el código sigue a la vista no se suma otra unidad.
    await page.waitForTimeout(2500);
    await expect(line.getByLabel("Cant.")).toHaveValue("1");

    // «Seguir escaneando» desmarcado cierra al leer; Escape también cierra.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("scanner-dialog")).toBeHidden();
    await expect(page.getByTestId("scanner-error")).toHaveCount(0);
  });
});
