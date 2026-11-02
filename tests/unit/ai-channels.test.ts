import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiProviderError,
  OpenAiClient,
  redactSecrets,
  type AiRequest,
} from "@/server/integrations/openai";
import {
  ChannelError,
  sendEmail,
  sendWhatsApp,
  setChannelDepsForTests,
  isAllowedSmtpPort,
} from "@/server/integrations/channels";

const publicResolve = async () => ["93.184.216.34"];
const req: AiRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hola" }],
  tools: [{ name: "propose_orders", description: "d", parameters: { type: "object" } }],
  forceTool: "propose_orders",
  maxTokens: 500,
  temperature: 0.2,
};
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const completion = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { type: "function", function: { name: "propose_orders", arguments: '{"orders":[]}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
};

afterEach(() => setChannelDepsForTests(null));

describe("cliente de OpenAI", () => {
  it("arma la petición con function calling estricto y devuelve herramientas y tokens", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new OpenAiClient(
      "sk-test-1234567890abcdef",
      async (url, init) => (calls.push({ url, init }), ok(completion)),
    );
    const result = await client.complete(req);
    expect(result).toEqual({
      content: null,
      toolCalls: [{ name: "propose_orders", argumentsJson: '{"orders":[]}' }],
      usage: { promptTokens: 120, completionTokens: 30 },
    });
    const call = calls[0];
    expect(call?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((call?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-test-1234567890abcdef",
    );
    const body = JSON.parse(String(call?.init.body));
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      max_completion_tokens: 500,
      parallel_tool_calls: false,
      tool_choice: { type: "function", function: { name: "propose_orders" } },
    });
    expect(body.tools[0].function.strict).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-test"); // la clave va en la cabecera, no en el cuerpo
  });

  it("Structured Outputs usa response_format json_schema estricto y sin herramientas", async () => {
    let sent: Record<string, unknown> = {};
    const client = new OpenAiClient(
      "sk-test-1234567890abcdef",
      async (_url, init) => (
        (sent = JSON.parse(String(init.body))),
        ok({
          choices: [{ message: { content: '{"intent":"other"}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        })
      ),
    );
    const result = await client.complete({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "x" }],
      jsonSchema: { name: "r", schema: { type: "object" } },
      maxTokens: 100,
    });
    expect(result.content).toBe('{"intent":"other"}');
    expect(sent).toHaveProperty("response_format.json_schema.strict", true);
    expect(sent).not.toHaveProperty("tools");
  });

  it("reintenta UNA vez ante 429/5xx y devuelve el resultado", async () => {
    let attempts = 0;
    const client = new OpenAiClient(
      "sk-test-1234567890abcdef",
      async () =>
        (attempts += 1) === 1 ? ok({ error: { message: "overloaded" } }, 503) : ok(completion),
      undefined,
      0,
    );
    await expect(client.complete(req)).resolves.toMatchObject({ usage: { promptTokens: 120 } });
    expect(attempts).toBe(2);
  });

  it("no reintenta errores 4xx y NO filtra la clave en el mensaje de error", async () => {
    let attempts = 0;
    const client = new OpenAiClient(
      "sk-secretisima-1234567890",
      async () => (
        (attempts += 1),
        ok({ error: { message: "Incorrect API key provided: sk-secretisima-1234567890." } }, 401)
      ),
      undefined,
      0,
    );
    const error = await client.complete(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(attempts).toBe(1);
    expect(String((error as Error).message)).not.toContain("secretisima");
    expect((error as AiProviderError).status).toBe(401);
  });

  it("falla con claridad ante red caída o formato inesperado, sin exponer la clave", async () => {
    const down = new OpenAiClient(
      "sk-secretisima-1234567890",
      async () => {
        throw new Error("connect ECONNREFUSED sk-secretisima-1234567890");
      },
      undefined,
      0,
    );
    const error = (await down.complete(req).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("No se pudo contactar");
    expect(error.message).not.toContain("secretisima");
    const weird = new OpenAiClient("sk-test-1234567890abcdef", async () => ok({ nada: true }));
    await expect(weird.complete(req)).rejects.toThrow(/formato inesperado/);
  });

  it("redactSecrets oculta claves y tokens Bearer", () => {
    expect(redactSecrets("clave sk-abc123DEF456_ghi y Bearer eyJhbGciOi.x.y")).toBe(
      "clave sk-*** y Bearer ***",
    );
  });
});

describe("WhatsApp (n8n / Evolution / Business)", () => {
  function install() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setChannelDepsForTests({
      resolve: publicResolve,
      fetch: async (url, init) => (calls.push({ url, init }), ok({ id: "wamid.1" })),
    });
    return calls;
  }
  const message = { to: "+51 987-000-001", body: "Pedido 7", idempotencyKey: "k-1" };

  it("n8n: JSON simple con Bearer", async () => {
    const calls = install();
    const result = await sendWhatsApp(
      { provider: "N8N", url: "https://n8n.ejemplo.com/webhook/wa", apiKey: "tok-123456" },
      message,
    );
    expect(result.providerRef).toBe("wamid.1");
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.authorization).toBe("Bearer tok-123456");
    expect(init.headers["idempotency-key"]).toBe("k-1");
    expect(JSON.parse(String(init.body))).toEqual({
      to: "51987000001",
      text: "Pedido 7",
      idempotencyKey: "k-1",
    });
    expect(init.redirect).toBe("error"); // sin seguir redirecciones (SSRF)
  });

  it("Evolution API: cabecera apikey y campo number", async () => {
    const calls = install();
    await sendWhatsApp(
      {
        provider: "EVOLUTION",
        url: "https://evo.ejemplo.com/message/sendText/inst",
        apiKey: "evo-key-123",
      },
      message,
    );
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.apikey).toBe("evo-key-123");
    expect(JSON.parse(String(init.body))).toEqual({ number: "51987000001", text: "Pedido 7" });
  });

  it("WhatsApp Business: formato de la Cloud API", async () => {
    const calls = install();
    await sendWhatsApp(
      {
        provider: "BUSINESS",
        url: "https://graph.facebook.com/v20.0/123/messages",
        apiKey: "EAAG-token",
      },
      message,
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: "whatsapp",
      to: "51987000001",
      type: "text",
      text: { body: "Pedido 7" },
    });
  });

  it("bloquea destinos internos antes de hacer la petición", async () => {
    const fetchSpy = vi.fn();
    setChannelDepsForTests({ resolve: async () => ["10.0.0.7"], fetch: fetchSpy });
    const error = await sendWhatsApp(
      { provider: "N8N", url: "https://interno.ejemplo.com/hook", apiKey: null },
      message,
    ).catch((e: unknown) => e as ChannelError);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).retryable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      sendWhatsApp({ provider: "N8N", url: "http://n8n.ejemplo.com/hook", apiKey: null }, message),
    ).rejects.toThrow(/HTTPS/);
  });

  it("clasifica errores: 5xx/429/red = reintentar; 4xx = permanente", async () => {
    const cfg = { provider: "N8N" as const, url: "https://n8n.ejemplo.com/hook", apiKey: null };
    for (const [status, retryable] of [
      [500, true],
      [503, true],
      [429, true],
      [408, true],
      [400, false],
      [401, false],
      [404, false],
    ] as const) {
      setChannelDepsForTests({
        resolve: publicResolve,
        fetch: async () => new Response("x", { status }),
      });
      const error = (await sendWhatsApp(cfg, message).catch((e: unknown) => e)) as ChannelError;
      expect(error.retryable, String(status)).toBe(retryable);
    }
    setChannelDepsForTests({
      resolve: publicResolve,
      fetch: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    expect(
      ((await sendWhatsApp(cfg, message).catch((e: unknown) => e)) as ChannelError).retryable,
    ).toBe(true);
  });
});

describe("SMTP del tenant", () => {
  const config = {
    host: "smtp.ejemplo.com",
    port: 587,
    secure: false,
    user: "u",
    password: "p",
    from: "Taller <no-reply@taller.pe>",
  };

  it("envía por el transporte configurado", async () => {
    const sent: unknown[] = [];
    setChannelDepsForTests({
      resolve: publicResolve,
      transportFactory: () => ({ sendMail: async (m) => (sent.push(m), { messageId: "<abc@x>" }) }),
    });
    const result = await sendEmail(config, { to: "prov@x.pe", subject: "Pedido", text: "Hola" });
    expect(result.providerRef).toBe("<abc@x>");
    expect(sent[0]).toMatchObject({ from: config.from, to: "prov@x.pe", subject: "Pedido" });
  });

  it("rechaza puertos no SMTP y servidores internos", async () => {
    setChannelDepsForTests({
      resolve: publicResolve,
      transportFactory: () => ({ sendMail: async () => ({}) }),
    });
    expect(isAllowedSmtpPort(587)).toBe(true);
    expect(isAllowedSmtpPort(6379)).toBe(false);
    await expect(
      sendEmail({ ...config, port: 6379 }, { to: "a@b.pe", subject: "s", text: "t" }),
    ).rejects.toThrow(/Puerto SMTP/);
    setChannelDepsForTests({
      resolve: async () => ["127.0.0.1"],
      transportFactory: () => ({ sendMail: async () => ({}) }),
    });
    const error = (await sendEmail(config, { to: "a@b.pe", subject: "s", text: "t" }).catch(
      (e: unknown) => e,
    )) as ChannelError;
    expect(error.retryable).toBe(false);
  });

  it("un fallo del servidor SMTP es reintentable y no filtra credenciales", async () => {
    setChannelDepsForTests({
      resolve: publicResolve,
      transportFactory: () => ({
        sendMail: async () => {
          throw new Error("535 auth failed Bearer abc.def.ghi");
        },
      }),
    });
    const error = (await sendEmail(config, { to: "a@b.pe", subject: "s", text: "t" }).catch(
      (e: unknown) => e,
    )) as ChannelError;
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("abc.def.ghi");
  });
});
