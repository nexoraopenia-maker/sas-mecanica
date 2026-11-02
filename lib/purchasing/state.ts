import type { PurchaseOrderStatus } from "@/lib/db/enums";

/**
 * Seguimiento de una orden de compra: Solicitado → Cotizado → En camino → Recibido
 * (más Borrador, Pendiente de aprobación y Cancelado). Los saltos hacia atrás no existen.
 */
const TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "REQUESTED", "CANCELLED"],
  PENDING_APPROVAL: ["REQUESTED", "CANCELLED"],
  REQUESTED: ["QUOTED", "IN_TRANSIT", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  QUOTED: ["IN_TRANSIT", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  IN_TRANSIT: ["PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  PARTIALLY_RECEIVED: ["PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"],
  RECEIVED: [],
  CANCELLED: [],
};

export function canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Estados en los que la mercadería aún puede llegar (cuentan como "en pedido"). */
export const OPEN_STATUSES: PurchaseOrderStatus[] = [
  "REQUESTED",
  "QUOTED",
  "IN_TRANSIT",
  "PARTIALLY_RECEIVED",
];

/** Estados que un mensaje del proveedor (no confiable) puede provocar. Nunca RECEIVED. */
export const SUPPLIER_DRIVEN: PurchaseOrderStatus[] = ["QUOTED", "IN_TRANSIT"];

export const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  DRAFT: "Borrador",
  PENDING_APPROVAL: "Pendiente de aprobación",
  REQUESTED: "Solicitado",
  QUOTED: "Cotizado",
  IN_TRANSIT: "En camino",
  PARTIALLY_RECEIVED: "Recibido parcial",
  RECEIVED: "Recibido",
  CANCELLED: "Cancelado",
};
