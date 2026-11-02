import { expect, test } from "@playwright/test";

test("la portada redirige al login, en español y con el nombre de la app", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle(/Mecania/);
  await expect(page.getByRole("heading", { level: 1, name: "Mecania" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
});

test("/api/health informa la conexión con la base de datos", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", database: true });
});

test("envía las cabeceras de seguridad, con CSP por nonce", async ({ request }) => {
  const response = await request.get("/login");
  const headers = response.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  expect(headers["x-request-id"]).toBeTruthy();
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("ninguna página pública viola la CSP y todas se hidratan", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy"))
      violations.push(message.text().slice(0, 160));
  });
  page.on("pageerror", (error) => violations.push(error.message));
  for (const path of [
    "/login",
    "/forgot-password",
    `/reset-password?token=${"x".repeat(43)}`,
    `/invite?token=${"x".repeat(43)}`,
  ]) {
    await page.goto(path);
    await page.waitForLoadState("load");
    await page.waitForTimeout(750); // da tiempo a que Next hidrate y dispare cualquier violación
  }
  expect(violations).toEqual([]);

  // Hidratación real: el formulario se envía por JavaScript (sin recargar la página).
  await page.goto("/forgot-password");
  await page.evaluate(() => {
    (window as unknown as { __marker: boolean }).__marker = true;
  });
  await page.getByLabel("Correo electrónico").fill("nadie@prueba.pe");
  await page.getByRole("button", { name: "Enviar enlace" }).click();
  await expect(page.getByRole("status")).toContainText("Si el correo está registrado");
  expect(await page.evaluate(() => (window as unknown as { __marker?: boolean }).__marker)).toBe(
    true,
  );
});
