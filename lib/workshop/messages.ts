/** Textos de WhatsApp al cliente (español). Sin datos sensibles más allá de lo necesario. */
export const messages = {
  approvalRequest: (p: {
    customer: string;
    company: string;
    plate: string;
    total: string;
    link: string;
  }) =>
    `Hola ${p.customer}, soy ${p.company}. Preparamos el presupuesto para tu vehículo ${p.plate} por ${p.total}. Revísalo y apruébalo aquí (vence en 7 días): ${p.link}`,
  vehicleReady: (p: { customer: string; company: string; plate: string }) =>
    `Hola ${p.customer}, tu vehículo ${p.plate} ya está listo para entrega en ${p.company}. Te esperamos.`,
  maintenanceReminder: (p: {
    customer: string;
    company: string;
    plate: string;
    description: string;
    due: string;
  }) =>
    `Hola ${p.customer}, de ${p.company}: a tu vehículo ${p.plate} le toca "${p.description}" (${p.due}). Escríbenos para agendar.`,
  warrantyNotice: (p: {
    customer: string;
    company: string;
    plate: string;
    description: string;
    days: number;
  }) =>
    `Hola ${p.customer}, de ${p.company}: la garantía de "${p.description}"${p.plate ? ` (vehículo ${p.plate})` : ""} vence en ${p.days} día(s). Si notas alguna falla, tráelo a revisar antes de esa fecha.`,
  claimReceived: (p: { customer: string; company: string; number: number }) =>
    `Hola ${p.customer}, recibimos tu reclamo de garantía N.º ${p.number} en ${p.company}. Lo evaluaremos y te avisaremos.`,
  claimResolved: (p: {
    customer: string;
    company: string;
    number: number;
    approved: boolean;
    resolution: string;
  }) =>
    p.approved
      ? `Hola ${p.customer}, tu reclamo de garantía N.º ${p.number} fue APROBADO (${p.resolution}). ${p.company} se pondrá en contacto contigo.`
      : `Hola ${p.customer}, tu reclamo de garantía N.º ${p.number} no pudo ser aprobado tras la evaluación. Puedes acercarte a ${p.company} para conocer el detalle.`,
} as const;
