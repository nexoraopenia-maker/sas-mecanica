import { randomUUID } from "node:crypto";
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

test.describe("catálogo e inventario (demo)", () => {
  test("el semáforo muestra exactamente 5 productos críticos y varios en punto de reorden", async ({
    page,
  }) => {
    await enterDemo(page);
    await goNav(page, "Inventario");
    await expect(page.getByRole("heading", { name: "Inventario", level: 1 })).toBeVisible();
    await expect(page.getByTestId("count-CRITICAL")).toHaveText("5");
    // Reorden: ATF, filtro de combustible y las baterías con 5 unidades (reorden = 5).
    await expect(async () => {
      expect(Number(await page.getByTestId("count-REORDER").innerText())).toBeGreaterThanOrEqual(3);
    }).toPass();
    await expect(page.getByText("Llanta 205/55 R16 Michelin Primacy 4").first()).toBeVisible();
    // Alertas inmediatas y llantas con DOT antiguo (1218 = semana 12 de 2018).
    await expect(page.getByText(/DOT 1218/)).toBeVisible();
  });

  test("busca llantas por medida en cualquier formato y repuestos por código equivalente", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app/catalog?tireSize=205%2F55R16");
    await expect(page.getByText("Llanta 205/55 R16 Michelin Primacy 4")).toBeVisible();
    await expect(page.getByText("Llanta 225/45 R17 Pirelli P Zero 225/45 R17")).toHaveCount(0);

    await page.goto("/app/catalog?code=gdb3469");
    await expect(page.getByText("Pastillas de freno delanteras Toyota Yaris (OEM)")).toBeVisible();

    await page.goto("/app/catalog?make=Toyota&model=Yaris&year=2018");
    await expect(page.getByText("Pastillas de freno delanteras Toyota Yaris (OEM)")).toBeVisible();
    await expect(page.getByText("Pastillas de freno delanteras Bosch Hyundai Accent")).toHaveCount(
      0,
    );

    await page.goto("/app/catalog?tireSize=xx");
    await expect(
      page.getByRole("alert").filter({ hasText: "205/55 R16, 205/55R16 o 2055516" }),
    ).toBeVisible();
  });

  test("catálogo: chips, semáforo de stock, costo y margen, paginación y estados vacíos", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app/catalog");
    await expect(page.getByTestId("product-card")).toHaveCount(12);
    await expect(page.getByTestId("stock-light").first()).toBeVisible();
    // El administrador demo ve costo y margen.
    await expect(page.getByTestId("product-cost").first()).toContainText("Margen");

    // Paginación en el servidor: la página 2 trae otros productos y la URL la conserva.
    const first = await page.getByTestId("product-card").first().innerText();
    await page.getByRole("link", { name: "Siguiente" }).click();
    await expect(page).toHaveURL(/page=2/);
    expect(await page.getByTestId("product-card").first().innerText()).not.toBe(first);

    // Chips de categoría: solo llantas, y el chip activo queda marcado.
    await page.getByTestId("chip-llantas").click();
    await expect(page).toHaveURL(/chip=llantas/);
    await expect(page.getByTestId("chip-llantas")).toHaveAttribute("aria-current", "true");
    const cards = page.getByTestId("product-card");
    await expect(cards.first()).toBeVisible();
    for (const text of await cards.allInnerTexts()) expect(text).toContain("Llanta");

    // Sin resultados: mensaje útil y salida para limpiar los filtros.
    await page.goto("/app/catalog?q=zzzz-no-existe");
    const empty = page.getByTestId("catalog-empty");
    await expect(empty).toContainText("No hay productos con ese criterio.");
    await empty.getByRole("link", { name: "Limpiar filtros" }).click();
    await expect(page.getByTestId("product-card").first()).toBeVisible();
  });

  test("crea una llanta, registra su entrada con DOT y un ajuste con motivo", async ({ page }) => {
    await enterDemo(page);
    const sku = `E2E-${randomUUID().slice(0, 6)}`.toUpperCase();

    await page.goto("/app/catalog");
    // React limpia el formulario tras cada envío: se vuelve a llenar para el reintento.
    const fillTire = async () => {
      await page.getByLabel("SKU", { exact: true }).fill(sku);
      await page.getByLabel("Nombre", { exact: true }).fill("Llanta E2E 195/65 R15");
      await page.getByLabel("Precio de venta").fill("320");
      await page.getByLabel("Medida de llanta").last().fill("195/65R15");
      await page.getByRole("button", { name: "Crear producto" }).click();
    };
    await fillTire();
    await expect(page.getByText(`Producto ${sku} creado.`)).toBeVisible();

    // Un SKU repetido se rechaza con un mensaje claro.
    await fillTire();
    await expect(page.getByText(`Ya existe un producto con el SKU ${sku}`)).toBeVisible();

    await page.goto("/app/inventory");
    const entry = page.locator("form", {
      has: page.getByRole("button", { name: "Registrar entrada" }),
    });
    await entry
      .getByLabel("Producto")
      .selectOption({ label: new RegExp(sku) as never })
      .catch(async () => {
        const value = await entry
          .getByLabel("Producto")
          .locator("option", { hasText: sku })
          .getAttribute("value");
        await entry.getByLabel("Producto").selectOption(value ?? "");
      });
    await entry.getByLabel("Cantidad").fill("8");
    await entry.getByLabel("Costo unitario").fill("210");
    await entry.getByLabel("Lote").fill("L-E2E");
    await entry.getByLabel(/DOT/).fill("9999");
    await entry.getByRole("button", { name: "Registrar entrada" }).click();
    await expect(page.getByText(/DOT inválido/)).toBeVisible();
    await entry.getByLabel(/DOT/).fill("2425");
    await entry.getByRole("button", { name: "Registrar entrada" }).click();
    await expect(page.getByText("Entrada registrada.")).toBeVisible();
    await expect(page.getByText(sku).first()).toBeVisible();

    const adjust = page.locator("form", {
      has: page.getByRole("button", { name: "Registrar ajuste" }),
    });
    const value = await adjust
      .getByLabel("Producto")
      .locator("option", { hasText: sku })
      .getAttribute("value");
    await adjust.getByLabel("Producto").selectOption(value ?? "");
    await adjust.getByLabel("Cantidad").fill("2");
    await adjust.getByLabel("Motivo").fill("Rotura en almacén");
    await adjust.getByRole("button", { name: "Registrar ajuste" }).click();
    await expect(page.getByText("Ajuste registrado.")).toBeVisible();
  });
});
