import { expect, test, type Page } from "@playwright/test";
import { goNav } from "./helpers";

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

async function openCash(page: Page, amount = "100") {
  await goNav(page, "Caja", { exact: true });
  await page.getByLabel("Efectivo inicial").fill(amount);
  await page.getByRole("button", { name: "Abrir caja" }).click();
  await expect(page).toHaveURL(/\/app\/pos$/, { timeout: 30_000 });
}

test.describe("punto de venta, caja y facturación (demo)", () => {
  test("abre caja, vende con boleta aceptada, imprime el ticket, cuadra y cierra", async ({
    page,
  }) => {
    await enterDemo(page);
    await goNav(page, "Vender", { exact: true });
    await expect(page.getByText("Abre tu caja para empezar a vender.")).toBeVisible();
    await openCash(page, "100");

    // El lector de código escribe el SKU y envía Enter: entra directo al carrito.
    await page.getByLabel("Buscar producto o escanear código").fill("FR-PAST-ACCENT-BOSCH");
    await page.getByLabel("Buscar producto o escanear código").press("Enter");
    await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("pos-total")).toContainText("S/", { timeout: 30_000 });
    const total = (await page.getByTestId("pos-total").innerText()).replace("S/", "").trim();

    await page.getByRole("button", { name: "Total exacto" }).click();
    await expect(page.getByTestId("pos-remaining")).toContainText("0.00");
    await page.getByRole("button", { name: /^Cobrar S\// }).click();

    await expect(page).toHaveURL(/\/app\/sales\/[0-9a-f-]+\?nueva=1/, { timeout: 30_000 });
    await expect(page.getByText("Venta registrada.")).toBeVisible();
    await expect(page.getByTestId("sale-document")).toContainText("Boleta B001-00000001");
    await expect(page.getByTestId("sale-document")).toContainText("Aceptado");

    // Ticket de 80 mm con los datos fiscales.
    const href = await page.getByRole("link", { name: /Ticket 80 mm/ }).getAttribute("href");
    await page.goto(href as string);
    await expect(page.getByTestId("print-sheet")).toContainText("Boleta electrónica B001-00000001");
    await expect(page.getByTestId("print-sheet")).toContainText("SON:");

    // La caja suma la venta y el cierre cuadra sin diferencia.
    await goNav(page, "Caja", { exact: true });
    const expected = Number(total) + 100;
    await expect(page.getByTestId("cash-expected")).toContainText(expected.toFixed(2));
    await page.getByLabel("Efectivo · Contado").fill(expected.toFixed(2));
    await page.getByRole("button", { name: "Cerrar caja" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Diferencia S\/ 0\.00/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("No tienes una caja abierta.")).toBeVisible();
  });

  test("convierte la cotización de la demo en venta y la anula con motivo", async ({ page }) => {
    await enterDemo(page);
    await openCash(page, "50");
    await goNav(page, "Cotizaciones", { exact: true });
    await page.getByTestId("quote").first().click();
    await expect(page.getByTestId("quote-status")).toHaveText("Enviada");
    await page.getByRole("button", { name: "Convertir en venta" }).click();
    await expect(page).toHaveURL(/\/app\/sales\/[0-9a-f-]+\?nueva=1/, { timeout: 30_000 });
    await expect(page.getByTestId("sale-item")).toHaveCount(2);

    await page.getByLabel("Motivo de la anulación").fill("El cliente cambió de opinión");
    await page.getByRole("button", { name: "Anular venta", exact: true }).click();
    await expect(page.getByText("Venta anulada.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sale-status")).toHaveText("Anulada");
    await expect(page.getByTestId("sale-document").last()).toContainText("Nota de crédito");

    await goNav(page, "Cotizaciones", { exact: true });
    await expect(page.getByTestId("quote").first()).toContainText("Convertida");
  });

  test("vende a crédito a un cliente con línea autorizada y cobra la deuda en dos partes", async ({
    page,
  }) => {
    await enterDemo(page);
    await openCash(page, "0");
    await page.getByLabel("Buscar producto o escanear código").fill("FR-PAST-ACCENT-BOSCH");
    await page.getByLabel("Buscar producto o escanear código").press("Enter");
    await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("pos-total")).toContainText("S/", { timeout: 30_000 });

    await page.getByLabel("Buscar cliente").fill("Mendoza");
    await page.getByRole("button", { name: "Buscar" }).last().click();
    await page.getByRole("button", { name: /Carlos Mendoza/ }).click();
    await expect(page.getByTestId("pos-customer")).toContainText("Carlos Mendoza");
    await page.getByLabel("Venta a crédito").check();
    await page.getByRole("button", { name: /^Cobrar S\// }).click();
    await expect(page).toHaveURL(/\/app\/sales\/[0-9a-f-]+\?nueva=1/, { timeout: 30_000 });
    await expect(page.getByTestId("sale-status")).toHaveText("Sin pagar");

    await goNav(page, "Por cobrar", { exact: true });
    const debt = page.getByTestId("receivable").first();
    await expect(debt).toContainText("Carlos Mendoza");
    // Plazo de 15 días: la deuda está a tiempo (verde) y la empresa figura en el resumen.
    await expect(debt.getByTestId("receivable-light")).toHaveAttribute("data-light", "GREEN");
    await expect(page.getByTestId("receivable-company").first()).toContainText("Carlos Mendoza");
    await debt.getByLabel("Monto a cobrar").fill("50");
    await debt.getByRole("button", { name: "Registrar pago" }).click();
    await expect(page.getByText(/Pago registrado\. Saldo de la cuenta: S\/ /)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("receivable").first()).toContainText("Parcial");
  });
});
