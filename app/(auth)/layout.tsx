import { Logo } from "@/components/brand/logo";
import { es } from "@/lib/i18n/es";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-8">
      <header className="text-center">
        <h1 className="sr-only">{es.app.name}</h1>
        <Logo priority className="mx-auto max-w-sm" />
        <p className="mt-2 text-sm tracking-wide text-muted-foreground">{es.app.slogan}</p>
      </header>
      {children}
    </main>
  );
}
