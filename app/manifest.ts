import type { MetadataRoute } from "next";
import { BRAND_BACKGROUND } from "@/lib/brand";
import { es } from "@/lib/i18n/es";

/** Manifiesto de la PWA: instalable en celulares y tablets, abre directo el área de trabajo. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: `${es.app.name} · AIMA Automatizaciones`,
    short_name: es.app.name,
    description: es.app.tagline,
    lang: "es-PE",
    dir: "ltr",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: BRAND_BACKGROUND,
    theme_color: BRAND_BACKGROUND,
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: es.nav.newSale,
        short_name: es.nav.newSale,
        url: "/app/pos",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: es.nav.cash,
        short_name: es.nav.cash,
        url: "/app/cash",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
