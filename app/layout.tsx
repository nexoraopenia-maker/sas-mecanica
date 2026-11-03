import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { BRAND_BACKGROUND } from "@/lib/brand";
import { PwaRegister } from "@/components/pwa/pwa-register";
import { es } from "@/lib/i18n/es";
import "./globals.css";

export const metadata: Metadata = {
  title: es.app.name,
  description: es.app.tagline,
  applicationName: es.app.name,
  appleWebApp: { capable: true, title: es.app.name, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pantallas con muesca: el contenido usa los márgenes seguros (ver globals.css).
  viewportFit: "cover",
  themeColor: BRAND_BACKGROUND,
  colorScheme: "dark",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // CSP con nonce por petición: Next solo lo inyecta en páginas renderizadas por petición.
  // Sin esto, las páginas estáticas quedan sin hidratar (el navegador bloquea sus scripts).
  await connection();
  return (
    <html lang="es">
      <body className="min-h-dvh antialiased">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
