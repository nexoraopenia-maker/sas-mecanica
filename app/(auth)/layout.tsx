import Image from "next/image";
import { es } from "@/lib/i18n/es";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="auth-theme min-h-dvh">
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-8">
        <header className="text-center">
          <h1 className="sr-only">{es.app.name}</h1>
          {/* El JPG trae fondo negro: `screen` lo funde con el fondo de la pantalla. */}
          <div className="relative mx-auto aspect-[3.2/1] w-full max-w-sm overflow-hidden mix-blend-screen">
            <Image
              src="/aima-logo.jpg"
              alt={es.app.logoAlt}
              fill
              priority
              sizes="(max-width: 448px) 100vw, 384px"
              className="object-cover"
            />
          </div>
          <p className="mt-2 text-sm tracking-wide text-muted-foreground">{es.app.slogan}</p>
        </header>
        {children}
      </main>
    </div>
  );
}
