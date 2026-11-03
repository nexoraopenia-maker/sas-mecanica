import { expect, type Locator, type Page } from "@playwright/test";

/** En tablet vertical y celular el menú lateral es un cajón: se abre solo si hace falta. */
export async function openMenu(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Abrir menú" });
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(page.locator("#menu-lateral")).toBeVisible();
  }
}

/** Entra a una sección desde el menú lateral (abriéndolo en pantallas chicas). */
export async function goNav(
  page: Page,
  name: string,
  options: { exact?: boolean } = {},
): Promise<void> {
  await openMenu(page);
  const link: Locator = page
    .locator("#menu-lateral")
    .getByRole("link", { name, exact: options.exact ?? false })
    .first();
  await link.click();
}
