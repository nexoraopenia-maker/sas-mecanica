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

/** Abre la caja de la demo desde la pantalla de Caja y vuelve al mostrador. */
async function openPos(page: Page) {
  await goNav(page, "Vender", { exact: true });
  await expect(page.getByRole("heading", { name: "Punto de venta", level: 1 })).toBeVisible();
  const needsCash = await page.getByText("Abre tu caja para empezar a vender.").isVisible();
  if (needsCash) {
    await goNav(page, "Caja", { exact: true });
    await page.getByLabel("Efectivo inicial").fill("100");
    await page.getByRole("button", { name: "Abrir caja" }).click();
    await expect(page).toHaveURL(/\/app\/pos$/, { timeout: 30_000 });
  }
  await expect(page.getByRole("heading", { name: "Punto de venta", level: 1 })).toBeVisible();
}

const search = (page: Page) => page.getByLabel("Buscar producto o escanear código");

/** Espera a que el catálogo esté guardado en IndexedDB (lo que permite vender sin conexión). */
async function waitForSnapshot(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open("mecania-pos");
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("snapshot")) return resolve(false);
          const get = db.transaction("snapshot").objectStore("snapshot").get("catalog");
          get.onsuccess = () => {
            db.close();
            resolve(Boolean(get.result));
          };
          get.onerror = () => resolve(false);
        };
      }),
    undefined,
    { timeout: 60_000 },
  );
}

/** Espera a que el service worker haya guardado la pantalla del mostrador para abrirla sin conexión. */
async function waitForCachedPos(page: Page) {
  await page.waitForFunction(
    async () => Boolean(await (await caches.open("mecania-pages-v1")).match("/app/pos")),
    undefined,
    { timeout: 60_000 },
  );
}

test.describe("punto de venta: sugerencias, SUNAT, PWA y modo sin conexión (demo)", () => {
  test("al escribir se despliegan sugerencias y un clic agrega el producto al carrito", async ({
    page,
  }) => {
    await enterDemo(page);
    await openPos(page);
    await search(page).pressSequentially("pasti", { delay: 40 });
    const options = page.getByTestId("pos-suggestion");
    await expect(options.first()).toBeVisible({ timeout: 15_000 });
    expect(await options.count()).toBeGreaterThan(0);
    await expect(page.getByRole("listbox")).toBeVisible();
    await options.first().click();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    // Los totales aparecen al instante (se calculan en el navegador).
    await expect(page.getByTestId("pos-total")).toContainText("S/");
    await expect(page.getByTestId("pos-suggestions")).toHaveCount(0);

    // Teclado: flecha abajo + Enter agrega la sugerencia marcada; Escape cierra.
    await search(page).pressSequentially("acei", { delay: 40 });
    await expect(options.first()).toBeVisible({ timeout: 15_000 });
    await search(page).press("ArrowDown");
    await search(page).press("Enter");
    await expect(page.getByTestId("cart-line")).toHaveCount(2);
    await search(page).pressSequentially("pasti", { delay: 40 });
    await expect(options.first()).toBeVisible({ timeout: 15_000 });
    await search(page).press("Escape");
    await expect(page.getByTestId("pos-suggestions")).toHaveCount(0);
  });

  test("SUNAT en el mostrador: la factura exige RUC y la boleta mayor a S/ 700 exige cliente", async ({
    page,
  }) => {
    await enterDemo(page);
    await openPos(page);
    await search(page).pressSequentially("michelin", { delay: 40 });
    await page.getByTestId("pos-suggestion").first().click();
    await page.getByLabel("Cant.").fill("4");
    await expect(page.getByTestId("pos-document-rule")).toContainText("700");
    await expect(page.getByRole("button", { name: /^Cobrar S\// })).toBeDisabled();
    await page.getByLabel("Comprobante").selectOption("FACTURA");
    await expect(page.getByTestId("pos-document-rule")).toContainText("RUC");
    await page.getByLabel("Comprobante").selectOption("NOTA_VENTA");
    await expect(page.getByTestId("pos-document-rule")).toHaveCount(0);
  });

  test("PWA: manifiesto instalable y service worker activo", async ({ page }) => {
    await enterDemo(page);
    const response = await page.request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      display: "standalone",
      start_url: "/app",
      theme_color: "#050508",
    });
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons)
      expect((await page.request.get(icon.src)).status(), icon.src).toBe(200);
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);

    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.state;
    });
    expect(state).toBe("activated");
    const sw = await page.request.get("/sw.js");
    expect(sw.headers()["cache-control"]).toContain("no-cache");
  });

  test("sin conexión: vende con boleta, queda en la cola y se sincroniza sola al volver internet", async ({
    page,
    context,
  }) => {
    await enterDemo(page);
    await openPos(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await waitForSnapshot(page);
    await waitForCachedPos(page);

    await context.setOffline(true);
    await expect(page.getByTestId("pos-offline-banner")).toBeVisible();
    // Recargar sin conexión: el service worker entrega la última copia del mostrador.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Punto de venta", level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("pos-offline-banner")).toBeVisible();

    await search(page).pressSequentially("pasti", { delay: 40 });
    await expect(page.getByTestId("pos-suggestion").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("pos-suggestion").first().click();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    // La factura no se ofrece sin conexión.
    await expect(page.getByRole("option", { name: /Factura/ })).toBeDisabled();

    await page.getByRole("button", { name: "Total exacto" }).click();
    await page.getByRole("button", { name: /^Guardar sin conexión S\// }).click();
    await expect(page.getByTestId("pos-saved-offline")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("sync-badge")).toBeVisible();
    const entry = page.getByTestId("offline-entry").first();
    await expect(entry).toHaveAttribute("data-status", "PENDING");

    // Vuelve internet: se envía sola y la venta queda registrada con su comprobante.
    await context.setOffline(false);
    await expect(entry).toHaveAttribute("data-status", "SYNCED", { timeout: 60_000 });
    await expect(entry).toContainText(/B\d{3}-\d{8}/);
    await expect(page.getByTestId("sync-badge")).toHaveCount(0);
    await goNav(page, "Ventas", { exact: true });
    await expect(page.getByText(/B\d{3}-\d{8}/).first()).toBeVisible({ timeout: 30_000 });
  });
});
