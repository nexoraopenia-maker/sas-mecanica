import nodemailer from "nodemailer";
import {
  assertPublicHost,
  assertPublicUrl,
  defaultResolver,
  type Resolver,
} from "@/lib/security/net";
import { redactSecrets } from "./openai";

export class ChannelError extends Error {
  constructor(
    message: string,
    /** true = reintentar con backoff; false = error permanente (configuración, 4xx). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface WhatsAppConfig {
  provider: "N8N" | "EVOLUTION" | "BUSINESS";
  url: string;
  apiKey: string | null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string }>;
}

export interface ChannelDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  resolve: Resolver;
  transportFactory: (config: SmtpConfig) => MailTransport;
}

const realDeps: ChannelDeps = {
  fetch: (input, init) => fetch(input, init),
  resolve: defaultResolver,
  transportFactory: (config) =>
    nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user && config.password
        ? { auth: { user: config.user, pass: config.password } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    }),
};

let deps: ChannelDeps = realDeps;

/** Para pruebas: reemplaza red, DNS y transporte SMTP. */
export function setChannelDepsForTests(override: Partial<ChannelDeps> | null): void {
  deps = override ? { ...realDeps, ...override } : realDeps;
}

/** Solo puertos SMTP habituales: evita usar el servidor SMTP para sondear otros servicios. */
const SMTP_PORTS = new Set([25, 465, 587, 2525]);

export function isAllowedSmtpPort(port: number): boolean {
  return SMTP_PORTS.has(port);
}

function providerRef(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const direct = record.id ?? record.messageId;
  if (typeof direct === "string") return direct.slice(0, 120);
  const messages = record.messages;
  if (
    Array.isArray(messages) &&
    typeof (messages[0] as { id?: unknown } | undefined)?.id === "string"
  )
    return String((messages[0] as { id: string }).id).slice(0, 120);
  const key = record.key;
  if (typeof key === "object" && key !== null && typeof (key as { id?: unknown }).id === "string")
    return String((key as { id: string }).id).slice(0, 120);
  return null;
}

/**
 * Envía un WhatsApp por el webhook del tenant (n8n, Evolution API o WhatsApp Business).
 * Protegido contra SSRF: HTTPS, IP pública verificada y sin seguir redirecciones.
 */
export async function sendWhatsApp(
  config: WhatsAppConfig,
  message: { to: string; body: string; idempotencyKey: string },
): Promise<{ providerRef: string | null }> {
  let url: URL;
  try {
    url = await assertPublicUrl(config.url, deps.resolve);
  } catch (error) {
    throw new ChannelError(error instanceof Error ? error.message : "URL no permitida", false);
  }
  const to = message.to.replace(/[^\d]/g, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": message.idempotencyKey,
  };
  let payload: Record<string, unknown>;
  if (config.provider === "EVOLUTION") {
    if (config.apiKey) headers.apikey = config.apiKey;
    payload = { number: to, text: message.body };
  } else if (config.provider === "BUSINESS") {
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    payload = { messaging_product: "whatsapp", to, type: "text", text: { body: message.body } };
  } else {
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    payload = { to, text: message.body, idempotencyKey: message.idempotencyKey };
  }

  let response: Response;
  try {
    response = await deps.fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ChannelError(
      `No se pudo contactar al webhook de WhatsApp: ${redactSecrets(error instanceof Error ? error.message : "error de red")}`,
      true,
    );
  }
  if (!response.ok) {
    // 4xx (salvo 408/429) son errores de configuración: reintentar no ayuda.
    throw new ChannelError(
      `El webhook de WhatsApp respondió ${response.status}`,
      response.status >= 500 || response.status === 408 || response.status === 429,
    );
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { providerRef: providerRef(json) };
}

/** Envía un correo por el SMTP propio del tenant (host público y puerto SMTP estándar). */
export async function sendEmail(
  config: SmtpConfig,
  message: { to: string; subject: string; text: string },
): Promise<{ providerRef: string | null }> {
  if (!isAllowedSmtpPort(config.port))
    throw new ChannelError("Puerto SMTP no permitido (usa 25, 465, 587 o 2525)", false);
  try {
    await assertPublicHost(config.host, deps.resolve);
  } catch (error) {
    throw new ChannelError(
      error instanceof Error ? error.message : "Servidor SMTP no permitido",
      false,
    );
  }
  try {
    const result = await deps.transportFactory(config).sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { providerRef: result.messageId?.slice(0, 120) ?? null };
  } catch (error) {
    throw new ChannelError(
      `Falló el envío SMTP: ${redactSecrets(error instanceof Error ? error.message : "error")}`.slice(
        0,
        300,
      ),
      true,
    );
  }
}
