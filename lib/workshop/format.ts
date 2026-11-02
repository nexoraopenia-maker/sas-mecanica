const TZ = "America/Lima";

export function formatDate(value: Date | string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString("es-PE", { timeZone: TZ }) : "—";
}

export function formatDateTime(value: Date | string | null | undefined): string {
  return value
    ? new Date(value).toLocaleString("es-PE", {
        timeZone: TZ,
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
}

export function formatMoney(value: string | number): string {
  return `S/ ${Number(value).toFixed(2)}`;
}

export function formatKm(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toLocaleString("es-PE")} km`;
}
