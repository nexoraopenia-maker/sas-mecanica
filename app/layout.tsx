import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { es } from "@/lib/i18n/es";
import "./globals.css";

export const metadata: Metadata = {
  title: es.app.name,
  description: es.app.tagline,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // CSP con nonce por petición: Next solo lo inyecta en páginas renderizadas por petición.
  // Sin esto, las páginas estáticas quedan sin hidratar (el navegador bloquea sus scripts).
  await connection();
  return (
    <html lang="es">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
