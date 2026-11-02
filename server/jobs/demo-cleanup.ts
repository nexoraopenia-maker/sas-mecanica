import { purgeExpiredDemos } from "@/server/services/demo";
import { inngest } from "./client";

/** Cada hora elimina los sandbox vencidos. Idempotente y reintentable: purgar dos veces es inocuo. */
export const demoCleanup = inngest.createFunction(
  { id: "demo-cleanup", triggers: [{ cron: "0 * * * *" }], retries: 3 },
  async ({ step }) => step.run("purge-expired-demos", () => purgeExpiredDemos()),
);
