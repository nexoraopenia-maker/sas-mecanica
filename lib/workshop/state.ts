import type { WorkOrderStatus } from "@/lib/db/enums";

/**
 * Orden de trabajo: Recibida → En diagnóstico → Esperando aprobación → En reparación /
 * Esperando repuesto → Lista para entrega → Entregada. Cancelar es posible antes de entregar.
 */
const TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  RECEIVED: ["DIAGNOSING", "AWAITING_APPROVAL", "CANCELLED"],
  DIAGNOSING: ["AWAITING_APPROVAL", "CANCELLED"],
  AWAITING_APPROVAL: ["DIAGNOSING", "IN_REPAIR", "AWAITING_PARTS", "READY", "CANCELLED"],
  AWAITING_PARTS: ["IN_REPAIR", "AWAITING_APPROVAL", "CANCELLED"],
  IN_REPAIR: ["AWAITING_PARTS", "AWAITING_APPROVAL", "READY", "CANCELLED"],
  READY: ["AWAITING_APPROVAL", "IN_REPAIR", "DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const OPEN_WORK_ORDER_STATUSES: WorkOrderStatus[] = [
  "RECEIVED",
  "DIAGNOSING",
  "AWAITING_APPROVAL",
  "AWAITING_PARTS",
  "IN_REPAIR",
  "READY",
];

/** Estados en los que aún se pueden agregar o quitar ítems. */
export const EDITABLE_STATUSES: WorkOrderStatus[] = [
  "RECEIVED",
  "DIAGNOSING",
  "AWAITING_APPROVAL",
  "AWAITING_PARTS",
  "IN_REPAIR",
];

export const WORK_ORDER_LABEL: Record<WorkOrderStatus, string> = {
  RECEIVED: "Recibida",
  DIAGNOSING: "En diagnóstico",
  AWAITING_APPROVAL: "Esperando aprobación",
  AWAITING_PARTS: "Esperando repuesto",
  IN_REPAIR: "En reparación",
  READY: "Lista para entrega",
  DELIVERED: "Entregada",
  CANCELLED: "Cancelada",
};
