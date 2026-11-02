import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { setChannelDepsForTests } from "@/server/integrations/channels";
import { updateChannelSettings } from "@/server/services/ai-settings";
import { provisionDemo } from "@/server/services/demo";
import { withTenant } from "@/lib/db";
import {
  claimOutbound,
  MAX_ATTEMPTS,
  processAllOutbound,
  processOutboundQueue,
  tenantsWithPendingMessages,
} from "@/server/services/outbound";
import { configureAuthCache } from "@/server/services/session-resolver";
import { adminClient } from "../helpers/db.ts";
import { meta } from "../helpers/auth.ts";
import { key } from "../helpers/inventory.ts";
import { purchasingWorld, uninstallFakes, type PurchasingWorld } from "../helpers/purchasing.ts";

const publicResolve = async () => ["93.184.216.34"];

describe("cola de envíos: reintentos, errores permanentes y seguridad", () => {
  let admin: PrismaClient;
  let w: PurchasingWorld;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    w = await purchasingWorld(admin);
    await updateChannelSettings(
      w.admin,
      {
        whatsappProvider: "N8N",
        whatsappWebhookUrl: "https://93.184.216.34/webhook/wa",
        whatsappApiKey: "tok-whatsapp-abcdef",
        smtpHost: "93.184.216.34",
        smtpPort: 587,
        smtpSecure: false,
        smtpFromAddress: "Taller <pedidos@taller.pe>",
      },
      meta(),
    );
  }, 120_000);
  afterEach(() => uninstallFakes());
  afterAll(async () => {
    await admin.$disconnect();
  });

  const enqueue = (tenantId: string, over: Record<string, unknown> = {}) =>
    admin.outboundMessage.create({
      data: {
        tenantId,
        channel: "WHATSAPP",
        toAddress: "+51 987 000 001",
        body: "Pedido 7",
        idempotencyKey: key(),
        status: "PENDING",
        ...over,
      } as never,
    });
  const reload = (id: string) => admin.outboundMessage.findUniqueOrThrow({ where: { id } });

  function installHttp(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setChannelDepsForTests({
      resolve: publicResolve,
      fetch: async (url, init) => (calls.push({ url, init }), handler(url, init)),
    });
    return calls;
  }

  it("WhatsApp: envía por el webhook del tenant con su clave descifrada y marca SENT", async () => {
    const calls = installHttp(() => new Response('{"id":"wamid.77"}', { status: 200 }));
    const message = await enqueue(w.tenantId);
    expect(await processOutboundQueue(w.tenantId)).toEqual({ sent: 1, retried: 0, failed: 0 });
    const stored = await reload(message.id);
    expect(stored).toMatchObject({
      status: "SENT",
      providerRef: "wamid.77",
      attempts: 1,
      error: null,
    });
    expect(stored.sentAt).not.toBeNull();
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(calls[0]?.url).toBe("https://93.184.216.34/webhook/wa");
    expect(init.headers.authorization).toBe("Bearer tok-whatsapp-abcdef");
    expect(init.headers["idempotency-key"]).toBe(message.idempotencyKey);
    expect(JSON.parse(String(init.body))).toMatchObject({ to: "51987000001", text: "Pedido 7" });
    expect(await processOutboundQueue(w.tenantId)).toEqual({ sent: 0, retried: 0, failed: 0 }); // ya no está pendiente
  });

  it("correo: envía por el SMTP del tenant", async () => {
    const sent: unknown[] = [];
    setChannelDepsForTests({
      resolve: publicResolve,
      transportFactory: () => ({ sendMail: async (m) => (sent.push(m), { messageId: "<m1@x>" }) }),
    });
    const message = await enqueue(w.tenantId, {
      channel: "EMAIL",
      toAddress: "ventas@proveedor.pe",
      subject: "Pedido N.º 7",
    });
    expect(await processOutboundQueue(w.tenantId)).toMatchObject({ sent: 1 });
    expect(sent[0]).toMatchObject({
      to: "ventas@proveedor.pe",
      subject: "Pedido N.º 7",
      from: "Taller <pedidos@taller.pe>",
    });
    expect((await reload(message.id)).providerRef).toBe("<m1@x>");
  });

  it("error transitorio: reintenta con backoff exponencial y termina FAILED tras 5 intentos con alerta crítica", async () => {
    const calls = installHttp(() => new Response("upstream down", { status: 503 }));
    const message = await enqueue(w.tenantId);
    let now = new Date();
    const waits: number[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await processOutboundQueue(w.tenantId, now);
      const stored = await reload(message.id);
      expect(stored.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
        expect(stored.status).toBe("PENDING");
        expect(stored.error).toBe("El webhook de WhatsApp respondió 503");
        waits.push(Math.round((stored.scheduledAt.getTime() - now.getTime()) / 60_000));
        // Antes de que venza el backoff no se vuelve a intentar.
        expect(await processOutboundQueue(w.tenantId, new Date(now.getTime() + 30_000))).toEqual({
          sent: 0,
          retried: 0,
          failed: 0,
        });
        now = stored.scheduledAt;
      } else {
        expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
        expect(stored.status).toBe("FAILED");
      }
    }
    expect(waits).toEqual([1, 5, 15, 60]);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    const alert = await admin.notification.findFirstOrThrow({
      where: { tenantId: w.tenantId, dedupeKey: `outbound-failed:${message.id}` },
    });
    expect(alert).toMatchObject({ kind: "outbound.failed", severity: "CRITICAL" });
    expect(await processOutboundQueue(w.tenantId, new Date(now.getTime() + 999_999_999))).toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    }); // FAILED no se reintenta
  });

  it("se recupera: falla dos veces y luego se envía", async () => {
    let calls = 0;
    installHttp(() =>
      (calls += 1) < 3
        ? new Response("x", { status: 502 })
        : new Response('{"id":"ok"}', { status: 200 }),
    );
    const message = await enqueue(w.tenantId);
    let now = new Date();
    for (let i = 0; i < 3; i += 1) {
      await processOutboundQueue(w.tenantId, now);
      now = (await reload(message.id)).scheduledAt;
    }
    expect(await reload(message.id)).toMatchObject({ status: "SENT", attempts: 3, error: null });
  });

  it("error permanente (4xx) => FAILED de inmediato, sin reintentos", async () => {
    const calls = installHttp(() => new Response("forbidden", { status: 403 }));
    const message = await enqueue(w.tenantId);
    expect(await processOutboundQueue(w.tenantId)).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(calls).toHaveLength(1);
    const stored = await reload(message.id);
    expect(stored).toMatchObject({
      status: "FAILED",
      attempts: 1,
      error: "El webhook de WhatsApp respondió 403",
    });
    expect(JSON.stringify(stored)).not.toContain("tok-whatsapp");
  });

  it("canal sin configurar => FAILED claro y alerta", async () => {
    const calls = installHttp(() => new Response("{}"));
    const bare = await purchasingWorld(admin);
    const message = await enqueue(bare.tenantId);
    expect(await processOutboundQueue(bare.tenantId)).toMatchObject({ failed: 1 });
    expect((await reload(message.id)).error).toBe("El canal de WhatsApp no está configurado");
    expect(calls).toHaveLength(0);
    const mail = await enqueue(bare.tenantId, { channel: "EMAIL", toAddress: "a@b.pe" });
    await processOutboundQueue(bare.tenantId);
    expect((await reload(mail.id)).error).toBe("El SMTP no está configurado");
  });

  it("SSRF: un webhook que apunta a una red interna nunca se contacta", async () => {
    const calls = installHttp(() => new Response("{}"));
    const victim = await purchasingWorld(admin);
    await updateChannelSettings(
      victim.admin,
      { whatsappProvider: "N8N", whatsappWebhookUrl: "https://93.184.216.34/ok" },
      meta(),
    );
    await admin.tenantSettings.update({
      where: { tenantId: victim.tenantId },
      data: { whatsappWebhookUrl: "https://169.254.169.254/latest/meta-data" },
    }); // p. ej. configuración manipulada
    const message = await enqueue(victim.tenantId);
    expect(await processOutboundQueue(victim.tenantId)).toMatchObject({ failed: 1 });
    expect((await reload(message.id)).error).toContain("Destino no permitido");
    expect(calls).toHaveLength(0);
  });

  it("5 procesos simultáneos no envían dos veces el mismo mensaje", async () => {
    const calls = installHttp(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response('{"id":"once"}', { status: 200 });
    });
    const t = await purchasingWorld(admin);
    await updateChannelSettings(
      t.admin,
      { whatsappProvider: "N8N", whatsappWebhookUrl: "https://93.184.216.34/webhook/wa" },
      meta(),
    );
    const message = await enqueue(t.tenantId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => processOutboundQueue(t.tenantId)),
    );
    expect(calls).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1);
    expect((await reload(message.id)).status).toBe("SENT");
  });

  it("el reclamo es atómico: procesos con la MISMA lectura obsoleta no pueden reclamar el mensaje a la vez", async () => {
    const t = await purchasingWorld(admin);
    const message = await enqueue(t.tenantId);
    const stale = { id: message.id, attempts: message.attempts }; // todos leyeron lo mismo
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        withTenant(t.tenantId, (tx) => claimOutbound(tx, stale, new Date())),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await reload(message.id)).attempts).toBe(1);
    // Ya enviado: ningún proceso rezagado puede reclamarlo de nuevo.
    await admin.outboundMessage.update({ where: { id: message.id }, data: { status: "SENT" } });
    expect(
      await withTenant(t.tenantId, (tx) =>
        claimOutbound(tx, { id: message.id, attempts: 1 }, new Date()),
      ),
    ).toBe(false);
  });

  it("un mensaje en vuelo no se vuelve a tomar durante la ventana de visibilidad", async () => {
    const t = await purchasingWorld(admin);
    await updateChannelSettings(
      t.admin,
      { whatsappProvider: "N8N", whatsappWebhookUrl: "https://93.184.216.34/webhook/wa" },
      meta(),
    );
    const calls = installHttp(() => new Response("", { status: 500 }));
    const message = await enqueue(t.tenantId);
    await processOutboundQueue(t.tenantId, new Date());
    expect(calls).toHaveLength(1);
    expect(await processOutboundQueue(t.tenantId, new Date(Date.now() + 10_000))).toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    });
    expect(calls).toHaveLength(1);
    expect((await reload(message.id)).attempts).toBe(1);
  });

  it("cuenta demo: lo pendiente se marca SIMULATED y no se llama a ningún adaptador", async () => {
    let called = 0;
    setChannelDepsForTests({
      resolve: publicResolve,
      fetch: async () => ((called += 1), new Response("{}")),
      transportFactory: () => ({ sendMail: async () => ((called += 1), {}) }),
    });
    const demo = await provisionDemo({ ip: `demo-${randomUUID()}` });
    const wa = await enqueue(demo.tenantId);
    const mail = await enqueue(demo.tenantId, { channel: "EMAIL", toAddress: "a@b.pe" });
    expect(await processOutboundQueue(demo.tenantId)).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect((await reload(wa.id)).status).toBe("SIMULATED");
    expect((await reload(mail.id)).status).toBe("SIMULATED");
    expect(called).toBe(0);
  });

  it("procesa por tenant: no envía mensajes ajenos y un tenant con problemas no frena a los demás", async () => {
    const calls = installHttp((url) =>
      url.includes("rota")
        ? new Response("", { status: 500 })
        : new Response('{"id":"x"}', { status: 200 }),
    );
    const good = await purchasingWorld(admin);
    const broken = await purchasingWorld(admin);
    await updateChannelSettings(
      good.admin,
      { whatsappProvider: "N8N", whatsappWebhookUrl: "https://93.184.216.34/webhook/wa" },
      meta(),
    );
    await updateChannelSettings(
      broken.admin,
      { whatsappProvider: "N8N", whatsappWebhookUrl: "https://93.184.216.34/rota" },
      meta(),
    );
    const mine = await enqueue(good.tenantId);
    const theirs = await enqueue(broken.tenantId);
    expect(await tenantsWithPendingMessages()).toEqual(
      expect.arrayContaining([good.tenantId, broken.tenantId]),
    );

    const only = await processOutboundQueue(good.tenantId);
    expect(only.sent).toBe(1);
    expect((await reload(theirs.id)).status).toBe("PENDING"); // el tenant B ni se tocó
    expect(calls.filter((c) => c.url.includes("rota"))).toHaveLength(0);

    const total = await processAllOutbound();
    expect(total.retried).toBeGreaterThanOrEqual(1);
    expect((await reload(mine.id)).status).toBe("SENT");
    expect(await reload(theirs.id)).toMatchObject({ status: "PENDING", attempts: 1 });
  });
});
