import type { NextConfig } from "next";

// La CSP (con nonce por petición) la emite proxy.ts.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pino", "@prisma/client", "@prisma/adapter-pg"],
  // Hasta 4 fotos de 5 MB al recibir un vehículo: el límite por defecto (1 MB) las rechazaría.
  experimental: { serverActions: { bodySizeLimit: "21mb" } },
  // Configuración unificada: las pantallas sueltas anteriores redirigen a su pestaña (se conserva la query).
  async redirects() {
    const tab = (id: string) => `/app/configuracion?tab=${id}`;
    return [
      { source: "/app/users", destination: tab("usuarios"), permanent: false },
      { source: "/app/roles", destination: tab("roles"), permanent: false },
      { source: "/app/settings", destination: tab("taller"), permanent: false },
      { source: "/app/subscription", destination: tab("plan"), permanent: false },
      { source: "/app/ai", destination: tab("ia"), permanent: false },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
