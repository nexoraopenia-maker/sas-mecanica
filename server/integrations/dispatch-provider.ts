import { createHash } from "node:crypto";
import { DISPATCH_SERIES_PATTERN, isValidUbigeo } from "@/lib/dispatch/sunat";
import type { ProviderOutcome } from "./invoicing";

/** Datos de la GRE tal como se envían al OSE/PSE (códigos de los catálogos 18 y 20 de SUNAT). */
export interface DispatchPayload {
  issuerRuc: string;
  series: string;
  correlative: number;
  issueDate: string;
  transferDate: string;
  reasonCode: string;
  reasonNote: string | null;
  transportModeCode: string;
  grossWeightKg: string;
  packages: number | null;
  origin: { address: string; ubigeo: string };
  destination: { address: string; ubigeo: string };
  recipient: { docType: string; docNumber: string; name: string };
  carrier: { ruc: string; name: string } | null;
  driver: { dni: string; name: string; license: string | null } | null;
  vehiclePlate: string | null;
  items: Array<{ description: string; sku: string | null; unit: string; quantity: string }>;
}

/** Contrato del OSE/PSE para la GRE: cambiar de proveedor es escribir otro adaptador. */
export interface DispatchGuideProvider {
  readonly name: string;
  submit(payload: DispatchPayload): Promise<ProviderOutcome>;
}

const reject = (code: string, message: string): ProviderOutcome => ({
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
 * Proveedor simulado (demo y sandbox local): aplica las validaciones básicas de SUNAT para que los rechazos
 * se vean en pruebas. No firma ni envía nada: el hash es un resumen del contenido, no una firma.
 */
export class SimulatedDispatchProvider implements DispatchGuideProvider {
  readonly name = "SIMULATED";

  async submit(payload: DispatchPayload): Promise<ProviderOutcome> {
    if (!DISPATCH_SERIES_PATTERN.test(payload.series))
      return reject("1001", "Serie de la guía inválida");
    if (!isValidUbigeo(payload.origin.ubigeo) || !isValidUbigeo(payload.destination.ubigeo))
      return reject("2402", "UBIGEO de partida o llegada inválido");
    if (!(Number(payload.grossWeightKg) > 0))
      return reject("2406", "El peso bruto debe ser mayor que 0");
    if (payload.items.length === 0) return reject("2407", "La guía no tiene bienes");
    if (payload.transportModeCode === "01" && !payload.carrier)
      return reject("2420", "Falta el transportista (RUC) del transporte público");
    if (payload.transportModeCode === "02" && (!payload.vehiclePlate || !payload.driver))
      return reject("2421", "Falta el vehículo o el conductor del transporte privado");
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("base64").slice(0, 28);
    return {
      outcome: "ACCEPTED",
      providerRef: `SIM-GRE-${payload.series}-${payload.correlative}`,
      hash,
      xmlUrl: null,
      pdfUrl: null,
      cdrUrl: null,
      code: "0",
      message: "Aceptada (simulado)",
    };
  }
}

let override: (() => DispatchGuideProvider) | null = null;

export function buildDispatchProvider(): DispatchGuideProvider {
  return override ? override() : new SimulatedDispatchProvider();
}

/** Para pruebas: inyecta un proveedor falso. */
export function setDispatchProviderForTests(factory: (() => DispatchGuideProvider) | null): void {
  override = factory;
}
