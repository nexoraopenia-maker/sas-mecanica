import { expect, test, type Page } from "@playwright/test";

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

test.describe("tablero, reportes, configuración y suscripción (demo)", () => {
  test("el inicio muestra las alertas rojas de stock, las OT activas y las métricas por módulo", async ({
    page,
  }) => {
    await enterDemo(page);
    await expect(page.getByTestId("dash-stock")).toBeVisible();
    await expect(page.getByTestId("dash-critical")).toHaveText("5");
    await expect(page.getByTestId("dash-sales-today")).toContainText("S/ 0.00");
    expect(Number(await page.getByTestId("dash-active-ot").innerText())).toBeGreaterThan(0);
    await expect(page.getByTestId("dash-warranties")).toBeVisible();
    await expect(page.getByTestId("dash-ai")).toContainText("Beneficio neto");
  });

  test("lista los reportes, muestra uno y lo descarga en CSV con BOM; sin sesión no se descarga", async ({
    page,
    request,
    playwright,
  }) => {
    await enterDemo(page);
    await page.getByRole("link", { name: "Reportes", exact: true }).click();
    await expect(page.getByTestId("report-link")).toHaveCount(9);
    await page.getByRole("link", { name: "Rotación de inventario" }).click();
    await expect(
      page.getByRole("heading", { name: "Rotación de inventario", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("report-row").first()).toBeVisible();
    await expect(page.getByTestId("report-summary")).toContainText("Valor del inventario");

    const href = await page.getByTestId("report-csv").getAttribute("href");
    const csv = await page.request.get(href as string);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(csv.headers()["content-disposition"]).toContain("reporte-rotation-");
    expect(csv.headers()["cache-control"]).toBe("no-store");
    const text = await csv.text();
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("SKU;Producto;Stock");

    // Sin sesión no hay descarga (el proxy manda al login).
    const anonymous = await playwright.request.newContext({
      baseURL: page.url().split("/app")[0],
      extraHTTPHeaders: { "x-forwarded-for": "10.7.7.7" },
    });
    const denied = await anonymous.get(href as string, { maxRedirects: 0 });
    expect([307, 401]).toContain(denied.status());
    await anonymous.dispose();
    void request;
  });

  test("libros PLE: filtro por mes y año, aviso de RUC faltante y descarga protegida", async ({
    page,
    playwright,
  }) => {
    await enterDemo(page);
    await page.getByRole("link", { name: "Reportes", exact: true }).click();
    await page.getByTestId("ple-link").click();
    await expect(
      page.getByRole("heading", { name: /Libros electrónicos/, level: 1 }),
    ).toBeVisible();
    await page.getByLabel("Año").selectOption("2025");
    await page.getByLabel("Mes").selectOption("3");
    await page.getByTestId("ple-show").click();
    await expect(page).toHaveURL(/anio=2025&mes=3/);
    await expect(page.getByTestId("ple-sales-rows")).toContainText("0 filas");
    await expect(page.getByTestId("ple-purchases-rows")).toContainText("0 filas");
    // La cuenta demo no tiene RUC propio: se avisa y no se ofrece la descarga.
    await expect(page.getByText("Falta el RUC de la empresa")).toBeVisible();
    await expect(page.getByTestId("ple-download-ventas")).toHaveCount(0);
    // Un periodo inválido se explica en pantalla.
    await page.goto("/app/reports/ple?anio=2026&mes=13");
    await expect(page.getByText("Mes inválido")).toBeVisible();

    // La ruta de descarga exige sesión y rechaza un RUC no válido con un error legible.
    const exportUrl = "/app/reports/ple/export?libro=14.1&anio=2025&mes=3";
    const refused = await page.request.get(exportUrl);
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error).toContain("RUC");
    const anonymous = await playwright.request.newContext({
      baseURL: page.url().split("/app")[0],
      extraHTTPHeaders: { "x-forwarded-for": "10.8.8.8" },
    });
    const denied = await anonymous.get(exportUrl, { maxRedirects: 0 });
    expect([307, 401]).toContain(denied.status());
    await anonymous.dispose();
  });

  test("el reporte de ventas explica un rango de fechas inválido en vez de romperse", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app/reports/sales?from=2026-12-31&to=2026-01-01");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "La fecha inicial no puede ser posterior a la final" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ventas por periodo", level: 1 })).toBeVisible();
  });

  test("Configuración: guarda el perfil y los parámetros, y rechaza valores fuera de rango", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.getByRole("link", { name: "Configuración", exact: true }).click();
    await page.getByLabel("Nombre comercial").fill("Taller Demo QA");
    await page.getByRole("button", { name: "Guardar datos" }).click();
    await expect(page.getByText("Datos de la empresa guardados.")).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Tasa (%)").fill("90");
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /Too big|menor|no más|50|0\.5/i })
        .or(page.getByRole("alert"))
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Tasa (%)").fill("18");
    await page.getByLabel("Stock muerto: días sin consumo").fill("120");
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await expect(page.getByText("Configuración operativa guardada.")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("Suscripción: la cuenta demo muestra su estado y no ofrece pagar", async ({ page }) => {
    await enterDemo(page);
    await page.getByRole("link", { name: "Suscripción", exact: true }).click();
    await expect(page.getByTestId("subscription-card")).toBeVisible();
    await expect(page.getByText("Las cuentas demo no se cobran.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pagar ahora" })).toHaveCount(0);
  });

  test("el webhook de cobro rechaza lo no firmado y lo que no es POST", async ({ request }) => {
    const bad = await request.post("/api/webhooks/billing/simulated", {
      data: "{}",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`,
        "x-forwarded-for": "10.8.8.8",
      },
    });
    expect([401, 404]).toContain(bad.status());
    const unknown = await request.post("/api/webhooks/billing/paypal", {
      data: "{}",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.8.8.9" },
    });
    expect(unknown.status()).toBe(404);
    expect((await request.get("/api/webhooks/billing/simulated")).status()).toBe(405);
  });
});

test.describe("flujo crítico: reclamo de garantía (demo)", () => {
  test("recibe el reclamo, lo evalúa, lo aprueba con nota de crédito y lo resuelve", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.getByRole("link", { name: "Garantías", exact: true }).click();
    await page.getByPlaceholder("Placa").fill("CDE789");
    await page.getByRole("button", { name: "Buscar" }).click();
    const warranty = page.getByTestId("warranty").first();
    await expect(warranty).toContainText("Mano de obra");
    await expect(warranty).toContainText("Con cobertura");

    await warranty.getByLabel("Falla reportada").fill("Vuelve el ruido al frenar");
    await warranty.getByRole("button", { name: "Registrar reclamo" }).click();
    const claim = page.getByTestId("claim").first();
    await expect(claim).toContainText("Recibido", { timeout: 30_000 });

    await claim.getByRole("button", { name: "Iniciar evaluación" }).click();
    await expect(claim).toContainText("En evaluación", { timeout: 30_000 });

    await claim
      .getByLabel("Resultado de la evaluación")
      .fill("Pastilla mal asentada: falla de instalación");
    await claim.getByLabel("Resolución").selectOption("CREDIT_NOTE");
    await claim.getByRole("button", { name: "Registrar decisión" }).click();
    await expect(claim).toContainText("Aprobado", { timeout: 30_000 });

    await claim.getByLabel("Monto de la nota de crédito").fill("70");
    await claim.getByRole("button", { name: "Resolver" }).click();
    await expect(claim).toContainText("Resuelto", { timeout: 30_000 });
  });
});
