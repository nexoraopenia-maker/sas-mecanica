import { es } from "@/lib/i18n/es";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">{es.app.name}</h1>
        <p className="text-sm text-muted-foreground">{es.app.tagline}</p>
      </header>
      {children}
    </main>
  );
}
