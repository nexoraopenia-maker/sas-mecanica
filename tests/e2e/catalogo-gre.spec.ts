import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { goNav } from "./helpers";

test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.${octet()}.${octet()}.${octet()}` });
});

/**
 * Acceso demo. E2E_SESSION_TOKEN permite entrar con una sesión ya emitida cuando el captcha no se puede
 * resolver (desarrollo local sin las llaves de prueba de Turnstile); en CI se usa el botón.
 */
async function enterDemo(page: Page) {
  if (process.env.E2E_SESSION_TOKEN) {
    await page.context().addCookies([
      {
        name: "__Host-sas_session",
        value: process.env.E2E_SESSION_TOKEN,
        domain: "localhost",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ]);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app$/);
    return;
  }
  await page.goto("/login");
  if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", {
      timeout: 30_000,
    });
  }
  await page.getByRole("button", { name: "Acceso Demo" }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 60_000 });
}

const suffix = () => randomUUID().slice(0, 6).toUpperCase();

const ubl = (sku: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns:cac="urn:cac" xmlns:cbc="urn:cbc">
  <cbc:ID>F001-00000777</cbc:ID>
  <cbc:IssueDate>2026-10-30</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID>20123456786</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>Distribuidora E2E SAC</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="NIU">8</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount>96.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>Bujía importada E2E</cbc:Description>
      <cac:SellersItemIdentification><cbc:ID>${sku}</cbc:ID></cac:SellersItemIdentification></cac:Item>
    <cac:Price><cbc:PriceAmount>12.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

test.describe("catálogo: alta manual, etiquetas, importación y guías de remisión (demo)", () => {
  test("la cabecera del catálogo ofrece Nuevo producto, Importar y Etiquetas", async ({ page }) => {
    await enterDemo(page);
    await goNav(page, "Catálogo", { exact: true });
    const actions = page.getByTestId("catalog-actions");
    await expect(actions.getByRole("button", { name: "Nuevo producto" })).toBeVisible();
    await expect(actions.getByRole("link", { name: "Importar" })).toBeVisible();
    await expect(actions.getByRole("link", { name: "Etiquetas" })).toBeVisible();
  });

  test("crea un producto con los campos del rubro y genera su etiqueta térmica", async ({
    page,
  }) => {
    await enterDemo(page);
    const sku = `E2E-${suffix()}`;
    const name = `Filtro de aire E2E ${sku}`;
    await page.goto("/app/catalog");
    await page.getByRole("button", { name: "Nuevo producto" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Nuevo producto" });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Tipo").selectOption("PART");
    await dialog.getByLabel("SKU", { exact: true }).fill(sku);
    await dialog.getByLabel("Nombre", { exact: true }).fill(name);
    await dialog.getByLabel("Marca", { exact: true }).fill("Bosch");
    await dialog.getByLabel("Código OEM").fill("OEM-9988");
    await dialog.getByLabel("Precio de venta").fill("45.90");
    await dialog.getByLabel("Precio de compra").fill("28");
    await dialog.getByLabel("Stock mínimo").fill("4");
    await dialog.getByLabel("Marca del vehículo").fill("Toyota");
    await dialog.getByLabel("Modelo", { exact: true }).fill("Yaris");
    await dialog.getByLabel("Año desde").fill("2015");
    await dialog.getByLabel("Año hasta").fill("2020");
    await dialog.getByRole("button", { name: "Crear producto" }).click();
    await expect(dialog.getByText(`Producto ${sku} creado.`)).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Cerrar" }).click();

    // La compatibilidad quedó guardada: el producto aparece al filtrar por vehículo.
    await page.goto("/app/catalog?make=Toyota&model=Yaris&year=2018&q=" + sku);
    await expect(page.getByTestId("product-card").filter({ hasText: name }).first()).toBeVisible();

    // Etiquetas: el producto no traía código de fábrica; el sistema le generó uno.
    await goNav(page, "Catálogo", { exact: true });
    await page.getByRole("link", { name: "Etiquetas" }).click();
    await page.getByLabel("Buscar producto").fill(sku);
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.getByLabel(`Seleccionar ${name}`).check();
    await page.getByLabel("Copias por producto").fill("2");
    await page.getByRole("button", { name: "Generar etiquetas" }).click();

    const sheet = page.getByTestId("label-sheet");
    await expect(sheet).toHaveAttribute("data-count", "2");
    const label = page.getByTestId("label").first();
    await expect(label).toContainText("S/ 45.90");
    await expect(label).toContainText(sku);
    await expect(label.getByRole("img", { name: /Código de barras 2\d{12}/ })).toBeVisible();
    // Layout para impresora térmica: el tamaño de página es el de la etiqueta.
    expect(await page.locator("style").allTextContents()).toEqual(
      expect.arrayContaining([expect.stringMatching(/size: 50mm 25mm/)]),
    );
    await expect(page.getByTestId("print-labels")).toBeVisible();
    const box = await label.boundingBox();
    expect(box?.width).toBeGreaterThan(box?.height ?? 0);
  });

  test("importa un comprobante XML: revisa la tabla y guarda catálogo y stock", async ({
    page,
  }) => {
    await enterDemo(page);
    const sku = `IMP-${suffix()}`;
    await page.goto("/app/catalog/import");
    await page.getByLabel("Comprobante").setInputFiles({
      name: "factura.xml",
      mimeType: "text/xml",
      buffer: Buffer.from(ubl(sku)),
    });
    await page.getByRole("button", { name: "Leer comprobante" }).click();
    await expect(page.getByTestId("import-mode")).toContainText("XML de SUNAT");
    const row = page.getByTestId("import-row").first();
    await expect(row.getByLabel(`SKU Bujía importada E2E`)).toHaveValue(sku);
    await expect(row.getByLabel(`Cantidad ${sku}`)).toHaveValue("8");
    await expect(row.getByLabel(`Costo unit. (sin IGV) ${sku}`)).toHaveValue("12");

    // Sin precio de venta no se guarda un producto nuevo.
    await page.getByRole("button", { name: "Guardar en catálogo y stock" }).click();
    await expect(page.getByText("Falta el precio de venta de un producto nuevo.")).toBeVisible();
    await row.getByLabel(`Precio de venta ${sku}`).fill("19.9");
    await page.getByRole("button", { name: "Guardar en catálogo y stock" }).click();
    await expect(page.getByTestId("import-result")).toContainText("1 productos creados", {
      timeout: 30_000,
    });

    await page.goto(`/app/catalog?q=${sku}`);
    const card = page.getByTestId("product-card").filter({ hasText: sku }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("S/ 19.90");
  });

  test("un PDF en la demo se lee en modo simulado y avisa que son datos de ejemplo", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app/catalog/import");
    await page.getByLabel("Comprobante").setInputFiles({
      name: "factura.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n"),
    });
    await page.getByRole("button", { name: "Leer comprobante" }).click();
    await expect(page.getByTestId("import-mode")).toContainText("Modo simulado");
    await expect(page.getByTestId("import-row")).toHaveCount(3);
  });

  test("un archivo no soportado se rechaza con un mensaje claro", async ({ page }) => {
    await enterDemo(page);
    await page.goto("/app/catalog/import");
    await page.getByLabel("Comprobante").setInputFiles({
      name: "virus.xml",
      mimeType: "text/xml",
      buffer: Buffer.from("MZ esto no es un comprobante"),
    });
    await page.getByRole("button", { name: "Leer comprobante" }).click();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText(
      "Formato no soportado",
    );
  });

  test("emite una guía de remisión de transporte privado y la muestra con sus datos", async ({
    page,
  }) => {
    await enterDemo(page);
    await goNav(page, "Guías de remisión", { exact: true });
    await expect(page.getByRole("heading", { name: "Guías de remisión", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: "Nueva guía" }).click();

    await page.getByLabel("Nombre o razón social").fill("Cliente Destino E2E SAC");
    await page.getByLabel("N.º de documento").fill("20987654321");
    await page.getByLabel("Dirección de partida").fill("Av. Industrial 123, Ate");
    await page.getByLabel("UBIGEO de partida").fill("150103");
    await page.getByLabel("Dirección de llegada").fill("Jr. Comercio 456, Miraflores");
    await page.getByLabel("UBIGEO de llegada").fill("150122");
    await page.getByLabel("DNI del conductor").fill("45871236");
    await page.getByLabel("Nombre del conductor").fill("Juan Pérez");
    await page.getByLabel("Placa del vehículo").fill("ABC-123");
    await page.getByLabel("Peso total bruto (kg)").fill("48.5");
    await page.getByLabel("Descripción").fill("Filtros de aceite");
    await page.getByLabel("Cantidad", { exact: true }).fill("10");

    // RUC con dígito verificador incorrecto: se rechaza con un mensaje.
    await page.getByRole("button", { name: "Emitir guía" }).click();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText(
      "RUC inválido",
    );

    await page.getByLabel("N.º de documento").fill("20123456786");
    await page.getByRole("button", { name: "Emitir guía" }).click();
    await expect(page).toHaveURL(/\/app\/guias\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const detail = page.getByTestId("gre-detail");
    await expect(detail).toContainText("Cliente Destino E2E SAC");
    await expect(detail).toContainText("ABC123");
    await expect(detail).toContainText("Filtros de aceite");
    await expect(detail).toContainText("48.500 kg");
    await expect(detail).toContainText("UBIGEO 150103");

    await page.goto("/app/guias");
    await expect(page.getByTestId("gre-list")).toContainText("Cliente Destino E2E SAC");
  });

  test("el transporte público pide RUC del transportista y oculta los datos del conductor", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app/guias/nueva");
    await expect(page.getByLabel("DNI del conductor")).toBeVisible();
    await page.getByLabel("Modalidad de transporte").selectOption("PUBLIC");
    await expect(page.getByLabel("RUC del transportista")).toBeVisible();
    await expect(page.getByLabel("Razón social del transportista")).toBeVisible();
    await expect(page.getByLabel("DNI del conductor")).toHaveCount(0);
  });
});
