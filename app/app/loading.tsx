/** Esqueleto instantáneo al navegar dentro del área privada: la pantalla responde al toque sin esperar al servidor. */
export default function Loading() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-live="polite"
      aria-label="Cargando"
      data-testid="route-loading"
    >
      <div className="h-8 w-48 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-40 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        <div className="h-40 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      </div>
      <div className="h-56 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
    </div>
  );
}
