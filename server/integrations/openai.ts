import { z } from "zod";

/** Contenido multimodal (imágenes y PDF) para extraer datos de comprobantes. */
export type AiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiRequest {
  model: string;
  messages: AiMessage[];
  /** Adjuntos (imagen/PDF) que viajan junto al último mensaje del usuario. */
  attachments?: AiContentPart[];
  /** Function calling: el modelo SOLO puede invocar estas herramientas. */
  tools?: AiToolDef[];
  forceTool?: string;
  /** Structured Outputs sin herramientas (extracción de datos). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  temperature?: number;
}

export interface AiResponse {
  content: string | null;
  toolCalls: Array<{ name: string; argumentsJson: string }>;
  usage: { promptTokens: number; completionTokens: number };
}

export interface AiClient {
  complete(request: AiRequest): Promise<AiResponse>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

/** Oculta cualquier clave de API que el proveedor repita en sus mensajes de error. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
}

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                type: z.string().optional(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

const errorSchema = z.object({ error: z.object({ message: z.string().optional() }).optional() });

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Cliente de Chat Completions con function calling y Structured Outputs, sobre `fetch` (sin SDK). */
export class OpenAiClient implements AiClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly retryDelayMs = 1_000,
  ) {}

  async complete(request: AiRequest): Promise<AiResponse> {
    const body = {
      model: request.model,
      messages: withAttachments(request.messages, request.attachments),
      max_completion_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: true,
              },
            })),
            tool_choice: request.forceTool
              ? { type: "function", function: { name: request.forceTool } }
              : "auto",
            parallel_tool_calls: false,
          }
        : {}),
      ...(request.jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.jsonSchema.name,
                schema: request.jsonSchema.schema,
                strict: true,
              },
            },
          }
        : {}),
    };

    let lastError: AiProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        lastError = new AiProviderError(
          `No se pudo contactar a OpenAI: ${redactSecrets(error instanceof Error ? error.message : "error de red")}`,
          null,
        );
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        const parsed = errorSchema.safeParse(safeJson(text));
        const detail = redactSecrets(
          parsed.success ? (parsed.data.error?.message ?? "") : "",
        ).slice(0, 200);
        lastError = new AiProviderError(
          `OpenAI respondió ${response.status}${detail ? `: ${detail}` : ""}`,
          response.status,
        );
        if (response.status === 429 || response.status >= 500) continue; // reintento único
        throw lastError;
      }
      const parsed = completionSchema.safeParse(safeJson(text));
      if (!parsed.success)
        throw new AiProviderError("Respuesta de OpenAI con formato inesperado", response.status);
      const message = parsed.data.choices[0]?.message;
      return {
        content: message?.content ?? null,
        toolCalls: (message?.tool_calls ?? []).map((call) => ({
          name: call.function.name,
          argumentsJson: call.function.arguments,
        })),
        usage: {
          promptTokens: parsed.data.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.data.usage?.completion_tokens ?? 0,
        },
      };
    }
    throw lastError ?? new AiProviderError("OpenAI no respondió", null);
  }
}

function withAttachments(messages: AiMessage[], attachments?: AiContentPart[]): unknown[] {
  if (!attachments || attachments.length === 0) return messages;
  let last = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") last = index;
  });
  return messages.map((message, index) =>
    index === last
      ? { role: message.role, content: [{ type: "text", text: message.content }, ...attachments] }
      : message,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type AiClientFactory = (apiKey: string) => AiClient;
let override: AiClientFactory | null = null;

export function getAiClient(apiKey: string): AiClient {
  return override ? override(apiKey) : new OpenAiClient(apiKey);
}

/** Para pruebas: inyecta un cliente falso (nunca se llama a OpenAI en los tests). */
export function setAiClientFactoryForTests(factory: AiClientFactory | null): void {
  override = factory;
}
