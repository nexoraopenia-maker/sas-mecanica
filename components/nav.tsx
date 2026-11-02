import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { es } from "@/lib/i18n/es";

export function Header({
  title,
  subtitle,
  links,
}: {
  title: string;
  subtitle: string;
  links: Array<{ href: string; label: string }>;
}) {
  return (
    <header className="border-b border-border print:hidden">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <form action={logoutAction}>
          <Button type="submit" variant="ghost" size="sm">
            {es.auth.logout}
          </Button>
        </form>
      </div>
      <nav
        className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 pb-2"
        aria-label="Principal"
      >
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="whitespace-nowrap rounded-lg px-4 py-3 text-base font-medium hover:bg-muted"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
