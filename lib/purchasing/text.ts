import { createHash } from "node:crypto";

/** Quita caracteres de control y de formato (incluye bidi), colapsa espacios y recorta. */
export function sanitizeText(input: string, maxLength: number): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

/** Solo dígitos, para comparar teléfonos de WhatsApp entre formatos (+51 987 000 001). */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function samePhone(a: string, b: string): boolean {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  if (x.length < 7 || y.length < 7) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

export interface OrderLine {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Mensaje al proveedor: una introducción breve (que puede venir del modelo, ya
 * saneada) y el detalle de líneas generado SIEMPRE por el sistema. Así lo que se
 * pide es exactamente lo que el sistema calculó, diga lo que diga el texto libre.
 */
export function buildOrderMessage(params: {
  company: string;
  orderNumber?: number;
  intro?: string;
  lines: OrderLine[];
  currency: string;
  conditions?: string;
}): string {
  const intro = params.intro
    ? sanitizeText(params.intro, 500)
    : `Hola, desde ${params.company} necesitamos cotización y disponibilidad de lo siguiente:`;
  const rows = params.lines.map(
    (line) =>
      `• ${line.sku} — ${sanitizeText(line.name, 80)} — ${line.quantity} u. × ${params.currency} ${line.unitPrice.toFixed(2)}`,
  );
  const total = params.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  return [
    intro,
    params.orderNumber ? `Pedido N.º ${params.orderNumber}` : null,
    ...rows,
    `Total referencial: ${params.currency} ${total.toFixed(2)}`,
    params.conditions ? `Condiciones: ${sanitizeText(params.conditions, 300)}` : null,
    "Responde a este mensaje indicando precio, disponibilidad y fecha de entrega.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** Clave determinista por proveedor + líneas + día: el mismo pedido del mismo día no se duplica. */
export function draftIdempotencyKey(
  tenantId: string,
  supplierId: string,
  day: string,
  items: Array<{ productId: string; quantity: number }>,
): string {
  const canonical = [...items]
    .sort((a, b) => a.productId.localeCompare(b.productId))
    .map((item) => `${item.productId}:${item.quantity}`)
    .join("|");
  return `draft:${createHash("sha256").update(`${tenantId}|${supplierId}|${day}|${canonical}`).digest("hex").slice(0, 40)}`;
}

/**
 * Deja un valor listo para guardarlo en una columna JSONB: PostgreSQL no admite el carácter NUL
 * (\u0000) y un texto hostil de un modelo o proveedor no debe poder romper el registro.
 */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/\\u0000/g, "")) as T;
}
