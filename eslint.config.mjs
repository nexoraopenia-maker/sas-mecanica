import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "lib/db/generated/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-expect-error": true, "ts-nocheck": true },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
      // Regla 6: el cliente Prisma crudo solo vive en /lib/db.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message:
                "Usa withTenant() de '@/lib/db'. El cliente Prisma crudo solo se importa dentro de lib/db.",
            },
          ],
          patterns: [
            {
              group: ["**/db/generated/client*", "**/db/generated", "**/db/raw", "**/db/admin"],
              message:
                "Importa desde '@/lib/db' (withTenant / withAdmin). Prohibido usar el cliente crudo fuera de lib/db.",
            },
          ],
        },
      ],
    },
  },
  // Dentro de lib/db, scripts, pruebas y prisma se permite el cliente crudo.
  {
    files: [
      "lib/db/**",
      "prisma/**",
      "scripts/**",
      "tests/**",
      "prisma.config.ts",
      "vitest.config.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },
  { files: ["scripts/**", "tests/**"], rules: { "no-console": "off" } },
]);
