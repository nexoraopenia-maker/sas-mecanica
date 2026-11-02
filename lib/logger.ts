import pino, { type DestinationStream, type Logger } from "pino";

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
type Level = (typeof LEVELS)[number];

function resolveLevel(): Level {
  const candidate = process.env.LOG_LEVEL;
  return LEVELS.find((level) => level === candidate) ?? "info";
}

// Nunca se escriben secretos en los logs (regla 24).
const REDACT_PATHS = [
  "password",
  "passwordHash",
  "token",
  "apiKey",
  "secret",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.apiKey",
  "*.secret",
  "*.openaiApiKey",
  "*.openaiApiKeyEncrypted",
  "*.whatsappApiKeyEncrypted",
  "*.smtpPasswordEncrypted",
  "req.headers.authorization",
  "req.headers.cookie",
];

export function buildLogger(
  destination?: DestinationStream,
  level: Level = resolveLevel(),
): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export const logger: Logger = buildLogger();

export interface LogBindings {
  tenantId?: string | null;
  requestId?: string;
  userId?: string;
}

/** Logger hijo: `tenantId` y `requestId` salen en cada línea. */
export function loggerFor(bindings: LogBindings): Logger {
  return logger.child(bindings);
}
