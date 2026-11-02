import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, withTenant, type TenantTx } from "@/lib/db";
import { billingMessages } from "@/lib/billing/messages";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { daysToDue, DUE_SOON_DAYS, trafficLight, type Light } from "@/lib/pos/receivable-light";
import { formatDate } from "@/lib/workshop/format";
import { collectSchema, type CollectInput } from "@/lib/validation/sales";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { lockOpenSession } from "./cash";
import { companyName, notifyCustomer } from "./customer-notify";

const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);
const OPEN_STATES = ["OPEN", "PARTIAL", "OVERDUE"] as const;

/** Tramo de antigüedad de una deuda según los días vencidos (0 = aún no vence). */
export function agingBucket(
  daysOverdue: number,
): "CURRENT" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS" {
  if (daysOverdue <= 0) return "CURRENT";
  if (daysOverdue <= 30) return "D1_30";
  if (daysOverdue <= 60) return "D31_60";
  if (daysOverdue <= 90) return "D61_90";
  return "D90_PLUS";
}

export async function listReceivables(
  actor: AuthUser,
  filter: {
    customerId?: string;
    includePaid?: boolean;
    /** Solo clientes con RUC (empresas, B2B). */ onlyCompanies?: boolean;
    /** Nombre del cliente (contiene). */ q?: string;
  } = {},
  now: Date = new Date(),
) {
  requirePermission(actor, "pos:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.receivable.findMany({
      where: {
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.onlyCompanies || filter.q?.trim()
          ? {
              customer: {
                ...(filter.onlyCompanies ? { docType: "RUC" as const } : {}),
                ...(filter.q?.trim()
                  ? { name: { contains: filter.q.trim(), mode: "insensitive" as const } }
                  : {}),
              },
            }
          : {}),
        ...(filter.includePaid ? {} : { status: { in: [...OPEN_STATES] } }),
      },
      include: {
        customer: { select: { name: true, phone: true, docType: true, docNumber: true } },
        sale: { select: { number: true } },
      },
      orderBy: [{ dueDate: "asc" }],
      take: 300,
    });
    const items = rows.map((r) => {
      const daysOverdue = Math.floor((now.getTime() - r.dueDate.getTime()) / 86_400_000);
      return {
        id: r.id,
        saleId: r.saleId,
        saleNumber: r.sale.number,
        customerId: r.customerId,
        customer: r.customer.name,
        customerDoc: r.customer.docNumber,
        isCompany: r.customer.docType === "RUC",
        light: trafficLight(r.dueDate, now),
        daysToDue: daysToDue(r.dueDate, now),
        total: r.total.toFixed(2),
        balance: r.balance.toFixed(2),
        dueDate: r.dueDate,
        status: r.status,
        daysOverdue: Math.max(0, daysOverdue),
        bucket: agingBucket(daysOverdue),
      };
    });
    const aging = { CURRENT: D(0), D1_30: D(0), D31_60: D(0), D61_90: D(0), D90_PLUS: D(0) };
    for (const item of items)
      if (OPEN_STATES.includes(item.status as (typeof OPEN_STATES)[number]))
        aging[item.bucket] = aging[item.bucket].plus(item.balance);
    // Resumen por cliente (empresa): cuánto debe y con qué urgencia (el peor semáforo de sus deudas).
    const rank: Record<Light, number> = { GREEN: 0, AMBER: 1, RED: 2 };
    const byCustomer = new Map<
      string,
      {
        customerId: string;
        customer: string;
        isCompany: boolean;
        count: number;
        balance: Prisma.Decimal;
        light: Light;
      }
    >();
    for (const item of items) {
      const entry = byCustomer.get(item.customerId) ?? {
        customerId: item.customerId,
        customer: item.customer,
        isCompany: item.isCompany,
        count: 0,
        balance: D(0),
        light: "GREEN" as Light,
      };
      entry.count += 1;
      entry.balance = entry.balance.plus(item.balance);
      if (rank[item.light] > rank[entry.light]) entry.light = item.light;
      byCustomer.set(item.customerId, entry);
    }
    return {
      byCustomer: [...byCustomer.values()]
        .sort((a, b) => rank[b.light] - rank[a.light] || b.balance.comparedTo(a.balance))
        .map((c) => ({ ...c, balance: c.balance.toFixed(2) })),
      items,
      aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, v.toFixed(2)])) as Record<
        keyof typeof aging,
        string
      >,
      totalOutstanding: Object.values(aging)
        .reduce((sum, v) => sum.plus(v), D(0))
        .toFixed(2),
    };
  });
}

/**
 * Cobro (total o parcial) de una cuenta por cobrar. Entra a la caja abierta de quien cobra, es
 * idempotente por clave y bloquea la cuenta mientras se registra: dos cobros simultáneos no
 * pueden dejar el saldo negativo.
 */
export async function collectReceivable(
  actor: AuthUser,
  input: CollectInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "cash:crear");
  const data = collectSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const replay = await tx.salePayment.findFirst({
      where: { idempotencyKey: data.idempotencyKey },
    });
    if (replay) {
      const current = await tx.receivable.findFirstOrThrow({ where: { saleId: replay.saleId } });
      return { balance: current.balance.toFixed(2), status: current.status, replayed: true };
    }
    await tx.$queryRaw`SELECT id FROM receivables WHERE id = ${data.receivableId}::uuid FOR UPDATE`;
    const receivable = await tx.receivable.findFirst({ where: { id: data.receivableId } });
    if (!receivable) throw new NotFoundError("Cuenta por cobrar");
    if (!OPEN_STATES.includes(receivable.status as (typeof OPEN_STATES)[number]))
      throw new ConflictError("RECEIVABLE_CLOSED", "La cuenta ya está cancelada");
    const amount = D(data.amount);
    if (amount.gt(receivable.balance))
      throw new ConflictError(
        "PAYMENT_EXCEEDS",
        `El monto supera el saldo (S/ ${receivable.balance.toFixed(2)})`,
      );

    const session = await lockOpenSession(tx, actor);
    await tx.salePayment.create({
      data: {
        saleId: receivable.saleId,
        cashSessionId: session.id,
        method: data.method,
        amount: amount.toFixed(2),
        reference: data.reference ?? null,
        idempotencyKey: data.idempotencyKey,
        receivedById: actor.userId,
      },
    });
    const balance = receivable.balance.minus(amount);
    const status = balance.isZero()
      ? "PAID"
      : receivable.dueDate < new Date()
        ? "OVERDUE"
        : "PARTIAL";
    await tx.receivable.update({
      where: { id: receivable.id },
      data: { balance: balance.toFixed(2), status },
    });
    await tx.sale.update({
      where: { id: receivable.saleId },
      data: {
        paidTotal: { increment: amount.toFixed(2) },
        paymentStatus: balance.isZero() ? "PAID" : "PARTIAL",
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "receivable.collected",
      entityType: "receivable",
      entityId: receivable.id,
      before: { balance: receivable.balance.toFixed(2) },
      after: { amount: amount.toFixed(2), balance: balance.toFixed(2), method: data.method },
    });
    return { balance: balance.toFixed(2), status, replayed: false };
  });
}

export interface ReceivableJobSummary {
  overdue: number;
  reminded: number;
  /** Deudas por vencer cuyo aviso quedó en cola (reintentar la pasada no duplica mensajes: la clave es por deuda). */
  dueSoon: number;
}

/**
 * Cobranza diaria de un tenant:
 *  1. marca como vencidas las deudas pasadas de fecha y alerta al personal;
 *  2. recuerda al cliente una vez por semana mientras siga vencida;
 *  3. avisa UNA vez, a los `DUE_SOON_DAYS` días del vencimiento, a quien aún no vence.
 * Los mensajes entran a la cola de WhatsApp (respeta el consentimiento y es idempotente por clave).
 */
export async function processReceivables(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<ReceivableJobSummary> {
  const moved = await tx.receivable.updateMany({
    where: { status: { in: ["OPEN", "PARTIAL"] }, dueDate: { lt: now }, balance: { gt: 0 } },
    data: { status: "OVERDUE" },
  });
  const include = {
    customer: { select: { id: true, name: true } },
    sale: { select: { number: true } },
  } as const;
  const overdue = await tx.receivable.findMany({
    where: { status: "OVERDUE", balance: { gt: 0 } },
    include,
  });
  const soon = await tx.receivable.findMany({
    where: {
      status: { in: ["OPEN", "PARTIAL"] },
      balance: { gt: 0 },
      dueDate: { gte: now, lte: new Date(now.getTime() + DUE_SOON_DAYS * 86_400_000) },
    },
    include,
  });
  const company = overdue.length + soon.length > 0 ? await companyName(tx) : "";
  const week = `${now.getUTCFullYear()}-${Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`;
  let reminded = 0;
  let dueSoon = 0;
  for (const r of overdue) {
    await tx.notification.createMany({
      data: [
        {
          kind: "receivable.overdue",
          severity: "WARNING",
          title: `Deuda vencida: ${r.customer.name}`,
          body: `Venta N.º ${r.sale.number} · saldo S/ ${r.balance.toFixed(2)}`,
          data: { receivableId: r.id },
          dedupeKey: `receivable-overdue:${r.id}`,
        },
      ],
      skipDuplicates: true,
    });
    const result = await notifyCustomer(tx, {
      customerId: r.customer.id,
      key: `recv-reminder:${r.id}:${week}`,
      relatedType: "receivable",
      relatedId: r.id,
      body: billingMessages.paymentReminder({
        customer: r.customer.name,
        company,
        number: r.sale.number,
        balance: `S/ ${r.balance.toFixed(2)}`,
        due: formatDate(r.dueDate),
      }),
    });
    if (result === "QUEUED" || result === "SIMULATED") reminded += 1;
  }
  for (const r of soon) {
    await tx.notification.createMany({
      data: [
        {
          kind: "receivable.due_soon",
          severity: "INFO",
          title: `Vence pronto: ${r.customer.name}`,
          body: `Venta N.º ${r.sale.number} · saldo S/ ${r.balance.toFixed(2)} · vence ${formatDate(r.dueDate)}`,
          data: { receivableId: r.id },
          dedupeKey: `receivable-due-soon:${r.id}`,
        },
      ],
      skipDuplicates: true,
    });
    // La clave es por deuda (no por semana): el aviso previo se manda una sola vez.
    const result = await notifyCustomer(tx, {
      customerId: r.customer.id,
      key: `recv-due:${r.id}`,
      relatedType: "receivable",
      relatedId: r.id,
      body: billingMessages.paymentDueSoon({
        customer: r.customer.name,
        company,
        number: r.sale.number,
        balance: `S/ ${r.balance.toFixed(2)}`,
        due: formatDate(r.dueDate),
        days: Math.max(0, Math.round((r.dueDate.getTime() - now.getTime()) / 86_400_000)),
      }),
    });
    if (result === "QUEUED" || result === "SIMULATED") dueSoon += 1;
  }
  return { overdue: moved.count, reminded, dueSoon };
}
