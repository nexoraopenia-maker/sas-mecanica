import { createHash } from "node:crypto";
import { z } from "zod";
import type { InvoicePayload } from "@/lib/billing/payload";
import { isValidRuc } from "@/lib/workshop/documents";
import { assertPublicUrl, defaultResolver, type Resolver } from "@/lib/security/net";

/** Resultado de enviar o dar de baja un comprobante ante el OSE/PSE. */
export interface ProviderOutcome {
  outcome: "ACCEPTED" | "REJECTED";
  providerRef: string | null;
  hash: string | null;
  xmlUrl: string | null;
  pdfUrl: string | null;
  cdrUrl: string | null;
  /** Código y mensaje del proveedor/SUNAT cuando rechaza. */
  code: string | null;
  message: string | null;
}

/** Error transitorio (red, 5xx, 429) → se reintenta; no transitorio → queda para revisión humana. */
export class InvoiceProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "InvoiceProviderError";
  }
}

/**
 * Contrato que cualquier OSE/PSE debe cumplir. La app solo habla con esta interfaz: cambiar de
 * proveedor es escribir otro adaptador, sin tocar ventas ni comprobantes.
 */
export interface InvoiceProvider {
  readonly name: string;
  /** Envía el comprobante. Debe ser idempotente por serie-correlativo del emisor. */
  submit(payload: InvoicePayload): Promise<ProviderOutcome>;
}

const accepted = (partial: Partial<ProviderOutcome> = {}): ProviderOutcome => ({
  outcome: "ACCEPTED",
  providerRef: null,
  hash: null,
  xmlUrl: null,
  pdfUrl: null,
  cdrUrl: null,
  code: "0",
  message: null,
  ...partial,
});
const rejected = (code: string, message: string): ProviderOutcome => ({
  outcome: "REJECTED",
  providerRef: null,
  hash: null,
  xmlUrl: null,
  pdfUrl: null,
  cdrUrl: null,
  code,
  message,
});

/**
 * Proveedor simulado (demo y sandbox local). Aplica las validaciones básicas que haría SUNAT para
 * que los rechazos se vean en pruebas: RUC inválido, importes que no cuadran y series mal formadas.
 * No firma ni envía nada: el hash es un resumen del contenido, no una firma.
 */
export class SimulatedInvoiceProvider implements InvoiceProvider {
  readonly name = "SIMULATED";

  async submit(payload: InvoicePayload): Promise<ProviderOutcome> {
    if (!/^[A-Z0-9]{4}$/.test(payload.series)) return rejected("2111", "Serie inválida");
    if (
      payload.documentTypeCode === "01" &&
      !(payload.customer.identityCode === "6" && isValidRuc(payload.customer.docNumber))
    ) {
      return rejected("2800", "El RUC del receptor no es válido");
    }
    const sum = payload.items.reduce((acc, item) => acc + Number(item.total), 0);
    if (Math.abs(sum - Number(payload.totals.total)) > 0.005) {
      return rejected("3030", "El total no coincide con la suma de los ítems");
    }
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("base64").slice(0, 28);
    return accepted({
      providerRef: `SIM-${payload.series}-${payload.correlative}`,
      hash,
      message: "Aceptado (simulado)",
    });
  }
}

const responseSchema = z.object({
  status: z.enum(["ACCEPTED", "REJECTED"]),
  id: z.string().max(200).nullish(),
  hash: z.string().max(200).nullish(),
  xml_url: z.url().nullish(),
  pdf_url: z.url().nullish(),
  cdr_url: z.url().nullish(),
  code: z.union([z.string(), z.number()]).nullish(),
  message: z.string().max(1000).nullish(),
});

export interface HttpProviderDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  resolve: Resolver;
}

const realDeps: HttpProviderDeps = {
  fetch: (input, init) => fetch(input, init),
  resolve: defaultResolver,
};

/**
 * Adaptador REST genérico (JSON) para un OSE/PSE:
 *   POST {baseUrl}/documents           cuerpo = InvoicePayload      → { status, id, hash, xml_url, pdf_url, cdr_url, code, message }
 * Para un proveedor con otra API se escribe otro adaptador que implemente `InvoiceProvider`.
 * Protegido contra SSRF (HTTPS, IP pública, sin redirecciones). 4xx con cuerpo válido = rechazo;
 * 5xx/429/red = reintentable; 401/403/404 = configuración que debe corregir el dueño.
 */
export class HttpInvoiceProvider implements InvoiceProvider {
  readonly name = "HTTP";
  constructor(
    private readonly config: { baseUrl: string; token: string | null },
    private readonly deps: HttpProviderDeps = realDeps,
  ) {}

  private async call(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<ProviderOutcome> {
    let url: URL;
    try {
      url = await assertPublicUrl(
        `${this.config.baseUrl.replace(/\/$/, "")}${path}`,
        this.deps.resolve,
      );
    } catch (error) {
      throw new InvoiceProviderError(
        error instanceof Error ? error.message : "URL no permitida",
        false,
      );
    }
    let response: Response;
    try {
      response = await this.deps.fetch(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new InvoiceProviderError(
        `No se pudo contactar al proveedor: ${error instanceof Error ? error.name : "error de red"}`,
        true,
      );
    }
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new InvoiceProviderError(`El proveedor respondió ${response.status}`, true);
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new InvoiceProviderError(
        `El proveedor respondió ${response.status}: revisa la URL y el token`,
        false,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new InvoiceProviderError(
        "Respuesta del proveedor ilegible",
        response.ok ? true : false,
      );
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success)
      throw new InvoiceProviderError("Respuesta del proveedor con formato inesperado", false);
    const r = parsed.data;
    return r.status === "ACCEPTED"
      ? accepted({
          providerRef: r.id ?? null,
          hash: r.hash ?? null,
          xmlUrl: r.xml_url ?? null,
          pdfUrl: r.pdf_url ?? null,
          cdrUrl: r.cdr_url ?? null,
          code: r.code === undefined || r.code === null ? "0" : String(r.code),
          message: r.message ?? null,
        })
      : rejected(
          r.code === undefined || r.code === null ? "RECHAZADO" : String(r.code),
          r.message ?? "Rechazado por el proveedor",
        );
  }

  submit(payload: InvoicePayload): Promise<ProviderOutcome> {
    return this.call("/documents", payload, `${payload.series}-${payload.correlative}`);
  }
}

let override:
  | ((config: {
      kind: "SIMULATED" | "HTTP";
      baseUrl?: string;
      token?: string | null;
    }) => InvoiceProvider)
  | null = null;

/** Para pruebas: reemplaza la construcción del proveedor (sin red real). */
export function setInvoiceProviderForTests(factory: typeof override): void {
  override = factory;
}

export function buildInvoiceProvider(config: {
  kind: "SIMULATED" | "HTTP";
  baseUrl?: string;
  token?: string | null;
}): InvoiceProvider {
  if (override) return override(config);
  if (config.kind === "HTTP") {
    if (!config.baseUrl)
      throw new InvoiceProviderError("Falta la URL del proveedor de facturación", false);
    return new HttpInvoiceProvider({ baseUrl: config.baseUrl, token: config.token ?? null });
  }
  return new SimulatedInvoiceProvider();
}
