import { toCsv } from "./csv";

export interface ReportColumn {
  key: string;
  label: string;
  /** Cómo se alinea y formatea en pantalla. */
  kind?: "text" | "number" | "money" | "percent";
}

export type ReportCell = string | number | null;

/** Forma común de todo reporte: una tabla con resumen. La misma estructura alimenta la pantalla, el CSV y la impresión. */
export interface Report {
  id: ReportId;
  title: string;
  summary: Array<{ label: string; value: string }>;
  columns: ReportColumn[];
  rows: Array<Record<string, ReportCell>>;
  /** Aclaraciones de método (qué incluye, qué no) que se imprimen con el reporte. */
  notes: string[];
}

export const REPORT_IDS = [
  "sales",
  "margin",
  "top",
  "rotation",
  "dead",
  "mechanics",
  "ai",
  "suppliers",
  "receivables",
] as const;
export type ReportId = (typeof REPORT_IDS)[number];

export function reportToCsv(report: Report): string {
  return toCsv(
    report.columns.map((c) => c.label),
    report.rows.map((row) => report.columns.map((c) => row[c.key] ?? "")),
  );
}
