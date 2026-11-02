import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile(".env");
} catch {
  // Sin .env: las variables vienen del entorno (CI, Vercel).
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DIRECT_URL ?? "postgresql://postgres:postgres@localhost:5432/sas",
  },
});
