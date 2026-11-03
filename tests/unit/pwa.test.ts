import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { BRAND_BACKGROUND } from "@/lib/brand";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("manifiesto de la PWA", () => {
  const m = manifest();
  it("es instalable: nombre, modo independiente, inicio dentro del alcance", () => {
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/app");
    expect(m.scope).toBe("/");
    expect(m.start_url?.startsWith(m.scope ?? "/")).toBe(true);
  });
  it("usa los colores de la marca", () => {
    expect(m.background_color).toBe(BRAND_BACKGROUND);
    expect(m.theme_color).toBe(BRAND_BACKGROUND);
  });
  it("trae íconos 192 y 512 y uno «maskable», y los archivos existen", () => {
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      const file = join(ROOT, "public", icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(1000);
    }
    expect(existsSync(join(ROOT, "public/icons/apple-touch-icon.png"))).toBe(true);
  });
  it("los atajos apuntan a pantallas reales", () => {
    expect((m.shortcuts ?? []).map((s) => s.url)).toEqual(["/app/pos", "/app/cash"]);
  });
});

describe("service worker", () => {
  const sw = read("public/sw.js");
  it("nunca toca /api ni peticiones que no sean GET ni otros orígenes", () => {
    expect(sw).toContain('if (request.method !== "GET") return;');
    expect(sw).toContain('if (url.pathname.startsWith("/api/")) return;');
    expect(sw).toContain("url.origin !== self.location.origin");
  });
  it("solo guarda páginas del mostrador y no respuestas redirigidas (login)", () => {
    expect(sw).toMatch(/OFFLINE_PAGES = \["\/app\/pos"\]/);
    expect(sw).toContain("!response.redirected");
  });
  it("borra las páginas guardadas al cerrar sesión y tiene página sin conexión", () => {
    expect(sw).toContain("CLEAR_PRIVATE_CACHES");
    expect(sw).toContain('const OFFLINE_URL = "/offline.html"');
    const page = read("public/offline.html");
    expect(page).toContain('lang="es"');
    expect(page).toContain('href="/app/pos"');
    expect(page).not.toMatch(/<script/i); // la CSP del sitio bloquea scripts en línea
  });
});

describe("política de seguridad para la PWA", () => {
  it("permite el worker y el manifiesto del propio origen", () => {
    const proxy = read("proxy.ts");
    expect(proxy).toContain("\"worker-src 'self'\"");
    expect(proxy).toContain("\"manifest-src 'self'\"");
  });
  it("el service worker no se cachea", () => {
    const config = read("next.config.ts");
    expect(config).toContain('source: "/sw.js"');
    expect(config).toContain("no-cache, no-store, must-revalidate");
  });
});
