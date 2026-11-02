import { serve } from "inngest/next";
import { billingMaintenance } from "@/server/jobs/billing-maintenance";
import { demoCleanup } from "@/server/jobs/demo-cleanup";
import { inventoryMaintenance } from "@/server/jobs/inventory-maintenance";
import { invoiceDispatch } from "@/server/jobs/invoice-dispatch";
import { outboundDispatch } from "@/server/jobs/outbound-dispatch";
import { purchasingAgent } from "@/server/jobs/purchasing-agent";
import { subscriptionBilling } from "@/server/jobs/subscription-billing";
import { workshopMaintenance } from "@/server/jobs/workshop-maintenance";
import { inngest } from "@/server/jobs/client";

// Inngest firma sus peticiones (INNGEST_SIGNING_KEY): el endpoint rechaza lo no firmado en producción.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    billingMaintenance,
    demoCleanup,
    inventoryMaintenance,
    invoiceDispatch,
    outboundDispatch,
    purchasingAgent,
    subscriptionBilling,
    workshopMaintenance,
  ],
});
