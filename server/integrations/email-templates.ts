import { getEnv } from "@/lib/env";
import type { EmailMessage } from "./email";

function link(path: string, token: string): string {
  return `${getEnv().APP_URL.replace(/\/$/, "")}${path}?token=${encodeURIComponent(token)}`;
}

export function inviteEmail(input: {
  to: string;
  name: string;
  company: string;
  token: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: `Te invitaron a ${input.company} en Mecania`,
    text: `Hola ${input.name},\n\nTe invitaron a unirte a ${input.company}. Crea tu contraseña aquí (el enlace vence en 7 días):\n\n${link("/invite", input.token)}\n\nSi no esperabas este correo, ignóralo.`,
  };
}

export function passwordResetEmail(input: {
  to: string;
  name: string;
  token: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Recupera tu contraseña de Mecania",
    text: `Hola ${input.name},\n\nUsa este enlace para crear una nueva contraseña (vence en 1 hora y solo funciona una vez):\n\n${link("/reset-password", input.token)}\n\nSi no lo pediste, ignora este mensaje: tu contraseña no cambió.`,
  };
}
