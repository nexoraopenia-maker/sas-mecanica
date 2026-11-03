// Decimal «browser»: la misma clase de Prisma (decimal.js) sin arrastrar el adaptador de la base de datos.
import { Prisma } from "@/lib/db/generated/browser.ts";

export const Decimal = Prisma.Decimal;
export type Decimal = InstanceType<typeof Prisma.Decimal>;
