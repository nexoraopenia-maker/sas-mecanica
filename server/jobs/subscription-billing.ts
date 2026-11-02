import { runBillingCycle } from "@/server/services/subscription-billing";
import { inngest } from "./client";

/** Cada hora: genera cobros de renovación, cobra o recuerda, entra en gracia y suspende al vencer la gracia. */
export const subscriptionBilling = inngest.createFunction(
  { id: "subscription-billing", triggers: [{ cron: "0 * * * *" }], retries: 2 },
  async ({ step }) => step.run("billing-cycle", () => runBillingCycle()),
);
