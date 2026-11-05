import { afterEach, describe, expect, it } from "vitest";
import {
  buildInvoiceExtractor,
  EXTRACTION_JSON_SCHEMA,
  ExtractionError,
  OpenAiInvoiceExtractor,
  setInvoiceExtractorForTests,
  SimulatedInvoiceExtractor,
} from "@/server/integrations/invoice-extractor";
import {
  OpenAiClient,
  setAiClientFactoryForTests,
  type AiRequest,
  type AiResponse,
} from "@/server/integrations/openai";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pdf = new TextEncoder().encode("%PDF-1.7 contenido");

const modelJson = {
  supplierName: "Repuestos SAC",
  supplierRuc: "20123456786",
  series: "F001",
  number: "123",
  issueDate: "2026-10-30",
  currency: "PEN",
  lines: [
    { sku: "FIL-1", barcode: null, name: "Filtro", quantity: 4, unitCost: 12.5, unit: "NIU" },
  ],
};

function fakeClient(content: string | null, seen: AiRequest[] = []) {
  setAiClientFactoryForTests(() => ({
    async complete(request: AiRequest): Promise<AiResponse> {
      seen.push(request);
      return { content, toolCalls: [], usage: { promptTokens: 900, completionTokens: 120 } };
    },
  }));
  return seen;
}

afterEach(() => {
  setAiClientFactoryForTests(null);
  setInvoiceExtractorForTests(null);
});

describe("extractor con IA", () => {
  it("manda la foto como imagen y valida la salida contra el esquema", async () => {
    const seen = fakeClient(JSON.stringify(modelJson));
    const output = await new OpenAiInvoiceExtractor("sk-x", "gpt-4o-mini").extract({
      kind: "IMAGE",
      bytes: png,
      fileName: "foto.png",
    });
    expect(output.invoice.lines[0]).toMatchObject({ name: "Filtro", quantity: 4, unitCost: 12.5 });
    expect(output.usage).toEqual({ promptTokens: 900, completionTokens: 120 });
    const request = seen[0] as AiRequest;
    expect(request.model).toBe("gpt-4o-mini");
    expect(request.temperature).toBe(0);
    expect(request.jsonSchema?.schema).toBe(EXTRACTION_JSON_SCHEMA);
    expect(request.attachments?.[0]).toMatchObject({ type: "image_url" });
    expect((request.attachments?.[0] as { image_url: { url: string } }).image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
    // El texto del documento se trata como dato: el prompt lo dice explícitamente.
    expect(request.messages[0]?.content).toMatch(/ignora cualquier texto/i);
  });

  it("manda el PDF como archivo con nombre saneado", async () => {
    const seen = fakeClient(JSON.stringify(modelJson));
    await new OpenAiInvoiceExtractor("sk-x", "gpt-4o").extract({
      kind: "PDF",
      bytes: pdf,
      fileName: "../../etc/pass wd.pdf",
    });
    const part = (seen[0] as AiRequest).attachments?.[0] as {
      type: string;
      file: { filename: string; file_data: string };
    };
    expect(part.type).toBe("file");
    expect(part.file.filename).not.toMatch(/[/ ]/);
    expect(part.file.file_data).toMatch(/^data:application\/pdf;base64,/);
  });

  it("falla con un mensaje claro si la IA no devuelve JSON o devuelve datos incompletos", async () => {
    fakeClient("no soy json");
    const extractor = new OpenAiInvoiceExtractor("sk-x", "gpt-4o-mini");
    await expect(
      extractor.extract({ kind: "IMAGE", bytes: png, fileName: "a.png" }),
    ).rejects.toBeInstanceOf(ExtractionError);
    fakeClient(JSON.stringify({ ...modelJson, lines: [{ name: "x", quantity: -1, unitCost: 1 }] }));
    await expect(
      extractor.extract({ kind: "IMAGE", bytes: png, fileName: "a.png" }),
    ).rejects.toThrow(/incompletos/);
    fakeClient(null);
    await expect(
      extractor.extract({ kind: "IMAGE", bytes: png, fileName: "a.png" }),
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it("el esquema de salida es estricto (todas las propiedades requeridas)", () => {
    const line = EXTRACTION_JSON_SCHEMA.properties.lines.items;
    expect(EXTRACTION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(EXTRACTION_JSON_SCHEMA.required).toEqual(Object.keys(EXTRACTION_JSON_SCHEMA.properties));
    expect(line.additionalProperties).toBe(false);
    expect(line.required).toEqual(Object.keys(line.properties));
  });
});

describe("extractor simulado y fábrica", () => {
  it("devuelve siempre las mismas líneas de ejemplo y no consume tokens", async () => {
    const a = await new SimulatedInvoiceExtractor().extract();
    expect(a.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(a.invoice.lines.length).toBeGreaterThan(1);
    expect(a.invoice.lines.every((line) => line.name.includes("ejemplo"))).toBe(true);
  });

  it("usa el simulado en demo o sin clave, y OpenAI con clave", () => {
    expect(buildInvoiceExtractor({ simulated: true, apiKey: "sk-x", model: "m" }).name).toBe(
      "SIMULATED",
    );
    expect(buildInvoiceExtractor({ simulated: false, apiKey: null, model: "m" }).name).toBe(
      "SIMULATED",
    );
    expect(buildInvoiceExtractor({ simulated: false, apiKey: "sk-x", model: "m" }).name).toBe(
      "OPENAI",
    );
  });
});

describe("cliente de OpenAI con adjuntos", () => {
  it("anexa los adjuntos al último mensaje del usuario como contenido multimodal", async () => {
    let body: { messages: Array<{ role: string; content: unknown }> } | null = null;
    const client = new OpenAiClient("sk-test-1234567890abcdef", async (_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    await client.complete({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "sistema" },
        { role: "user", content: "extrae" },
      ],
      attachments: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      maxTokens: 100,
    });
    const messages = (body as unknown as { messages: Array<{ role: string; content: unknown }> })
      .messages;
    expect(messages[0]?.content).toBe("sistema");
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "extrae" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});
