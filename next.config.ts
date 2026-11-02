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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
