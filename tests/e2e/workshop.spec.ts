import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { goNav } from "./helpers";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

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

test.describe("taller (demo)", () => {
  test("recepción → presupuesto → aprobación del cliente por enlace → entrega con historial", async ({
    page,
    browser,
  }) => {
    const plate = `E${randomUUID()
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 5)
      .toUpperCase()}`;
    await enterDemo(page);

    // 1) Recepción digital con cliente nuevo.
    await goNav(page, "Taller");
    await expect(page.getByRole("heading", { name: "Taller", level: 1 })).toBeVisible();
    await expect(page.getByTestId("work-order").first()).toBeVisible();
    await page.getByLabel("Placa", { exact: true }).fill(plate);
    await page.getByLabel("Kilometraje de ingreso").fill("40000");
    await page.getByLabel("Motivo del ingreso").fill("Ruido al frenar");
    await page
      .getByLabel("Documento", { exact: true })
      .fill(String(Math.floor(10_000_000 + Math.random() * 89_999_999)));
    await page.getByLabel("Nombre del cliente").fill("Cliente E2E");
    await page.getByLabel("WhatsApp", { exact: true }).fill("987654321");
    await page.getByLabel("Rayones o abolladuras").check();
    // Evidencia del estado inicial: dos fotos adjuntas en la propia recepción.
    await page.getByLabel("Fotos de ingreso (estado inicial de las piezas)").setInputFiles([
      { name: "embrague.png", mimeType: "image/png", buffer: PNG_1X1 },
      { name: "motor.png", mimeType: "image/png", buffer: PNG_1X1 },
    ]);
    await page.getByRole("button", { name: "Abrir orden de trabajo" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(plate, { timeout: 30_000 });
    await expect(page.getByRole("img", { name: /Ingreso \d/ })).toHaveCount(2);
    await expect(page.getByTestId("wo-status")).toHaveText("Recibida");

    // 2) Foto de ingreso (validada por contenido) y mano de obra.
    await page
      .getByLabel("Foto", { exact: true })
      .setInputFiles({ name: "daño.png", mimeType: "image/png", buffer: PNG_1X1 });
    await page.getByRole("button", { name: "Subir foto" }).click();
    await expect(page.getByText("Foto guardada.")).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Descripción", { exact: true }).fill("Cambio de pastillas delanteras");
    await page.getByLabel("Precio unitario").fill("120");
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await expect(page.getByTestId("wo-item")).toContainText("Cambio de pastillas delanteras", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("wo-total")).toHaveText("S/ 141.60");

    // 3) Presupuesto al cliente: el enlace queda visible (en demo el WhatsApp es simulado).
    await page.getByRole("button", { name: "Enviar presupuesto al cliente" }).click();
    const notice = page.getByRole("status").filter({ hasText: "/aprobar/" });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const link = /(https?:\/\/\S+\/aprobar\/\S+)/.exec(await notice.innerText())?.[1];
    expect(link).toBeTruthy();

    // 4) El cliente (otra sesión, sin login) aprueba desde el enlace; el enlace es de un solo uso.
    const customer = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-for": "10.9.9.9" },
    });
    const approval = await customer.newPage();
    await approval.goto(link as string);
    await expect(approval.getByText("Cambio de pastillas delanteras")).toBeVisible();
    await expect(approval.getByTestId("approval-total")).toContainText("141.60");
    await approval.getByLabel("Tu nombre completo").fill("Cliente E2E");
    await approval.getByRole("button", { name: "Aprobar lo seleccionado" }).click();
    await expect(approval.getByText(/Aprobaste 1 trabajo/)).toBeVisible({ timeout: 30_000 });
    await approval.goto(link as string);
    await expect(approval.getByText(/no es válido o ya venció/)).toBeVisible();
    await customer.close();

    // 5) El taller ve la aprobación, termina y entrega.
    await page.reload();
    await expect(page.getByTestId("wo-status")).toHaveText("En reparación");
    await page.getByRole("button", { name: "Marcar lista para entrega" }).click();
    await expect(page.getByTestId("wo-status")).toHaveText("Lista para entrega", {
      timeout: 30_000,
    });
    await page.getByLabel("Kilometraje de salida").fill("40010");
    await page.getByRole("button", { name: "Entregar vehículo" }).last().click();
    await expect(page.getByText(/Vehículo entregado/)).toBeVisible({ timeout: 30_000 });

    // 6) El historial técnico del vehículo muestra el servicio.
    await page.reload();
    await expect(page.getByTestId("wo-status")).toHaveText("Entregada");
    await page.getByRole("link", { name: plate }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(plate);
    await expect(page.getByText("Cambio de pastillas delanteras").first()).toBeVisible();
  });

  test("consulta rápida de garantías y clientes en la demo", async ({ page }) => {
    await enterDemo(page);
    await goNav(page, "Garantías");
    await expect(page.getByRole("heading", { name: "Garantías", level: 1 })).toBeVisible();
    await page.getByPlaceholder("Placa").fill("CDE789");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByTestId("warranty").first()).toContainText("Mano de obra");

    await goNav(page, "Clientes");
    await page.getByPlaceholder(/Buscar por nombre/).fill("Mendoza");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByTestId("customer").first()).toContainText("Carlos Mendoza");
    await page.getByTestId("customer").first().click();
    await page.getByRole("link", { name: "Ver historial técnico" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("ABC123");
  });
});
