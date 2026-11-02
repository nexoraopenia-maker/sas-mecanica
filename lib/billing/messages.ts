/** Textos de WhatsApp al cliente por comprobantes y cobranza (español). */
export const billingMessages = {
  documentReady: (p: {
    customer: string;
    company: string;
    number: string;
    total: string;
    link: string | null;
  }) =>
    `Hola ${p.customer}, de ${p.company}: tu comprobante ${p.number} por ${p.total} ya está emitido.${p.link ? ` Descárgalo aquí: ${p.link}` : " Si necesitas una copia, escríbenos."}`,
  paymentDueSoon: (p: {
    customer: string;
    company: string;
    number: number;
    balance: string;
    due: string;
    days: number;
  }) =>
    `Hola ${p.customer}, de ${p.company}: tu venta N.º ${p.number} por ${p.balance} vence ${p.days <= 0 ? "hoy" : `en ${p.days} día(s)`} (${p.due}). Te agradecemos programar tu pago.`,
  paymentReminder: (p: {
    customer: string;
    company: string;
    number: number;
    balance: string;
    due: string;
  }) =>
    `Hola ${p.customer}, de ${p.company}: tu venta N.º ${p.number} tiene un saldo pendiente de ${p.balance} con vencimiento el ${p.due}. Gracias por regularizarlo.`,
};
