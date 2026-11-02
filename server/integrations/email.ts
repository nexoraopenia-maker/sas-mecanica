import nodemailer from "nodemailer";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** SMTP de la plataforma (invitaciones y recuperación). El SMTP propio de cada tenant llega en la Fase 4. */
class SmtpSender implements EmailSender {
  private readonly transport = nodemailer.createTransport(getEnv().SMTP_URL);

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: getEnv().SMTP_FROM, ...message });
  }
}

/** Solo desarrollo/CI sin SMTP_URL: registra el asunto, nunca el cuerpo (trae enlaces con token). */
class LogSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject },
      "correo no enviado: SMTP_URL no configurada",
    );
  }
}

let override: EmailSender | null = null;
let cached: EmailSender | undefined;

export function getEmailSender(): EmailSender {
  if (override) return override;
  cached ??= getEnv().SMTP_URL ? new SmtpSender() : new LogSender();
  return cached;
}

/** Para pruebas: captura los correos en memoria. */
export function setEmailSenderForTests(sender: EmailSender | null): void {
  override = sender;
}
