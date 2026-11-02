import { processAllOutbound } from "@/server/services/outbound";
import { inngest } from "./client";

/** Cada 2 minutos: envía los mensajes pendientes y reintenta los fallidos con backoff. */
export const outboundDispatch = inngest.createFunction(
  { id: "outbound-dispatch", triggers: [{ cron: "*/2 * * * *" }], retries: 2 },
  async ({ step }) => step.run("process-outbound-queue", () => processAllOutbound()),
);
