import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "on-first-retry" },
  projects: [
    { name: "tablet", testIgnore: /scanner\.spec\.ts/, use: { ...devices["Galaxy Tab S4"] } },
    { name: "mobile", testIgnore: /scanner\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    {
      // Cámara falsa de Chromium con un EAN-13 (tests/fixtures/ean13.mjpeg) para probar el escáner del POS.
      name: "camera",
      testMatch: /scanner\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        permissions: ["camera"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-video-capture=${process.cwd()}/tests/fixtures/ean13.mjpeg`,
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- -p ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
