"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  BarChart3,
  Bot,
  BookOpen,
  Boxes,
  CreditCard,
  FileCheck2,
  FileOutput,
  HandCoins,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Truck,
  UserCog,
  Users,
  Wallet,
  Wrench,
  X,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { Logo } from "@/components/brand/logo";
import { useOffline } from "@/components/offline/offline-provider";
import { SyncBadge } from "@/components/offline/sync-badge";
import { BranchSwitcher, type BranchContext } from "@/components/shell/branch-switcher";
import { InstallButton } from "@/components/pwa/install-button";
import { clearPrivateCaches } from "@/components/pwa/pwa-register";
import { clearSnapshot } from "@/lib/offline/idb";
import { Button, buttonVariants } from "@/components/ui/button";
import { es } from "@/lib/i18n/es";
import { cn } from "@/lib/utils";

const ICONS = {
  dashboard: LayoutDashboard,
  pos: ShoppingCart,
  sales: Receipt,
  cash: Wallet,
  quotes: FileText,
  receivables: HandCoins,
  workshop: Wrench,
  customers: Users,
  warranties: ShieldCheck,
  catalog: Package,
  inventory: Boxes,
  purchasing: Truck,
  billing: FileCheck2,
  dispatch: FileOutput,
  accounting: BookOpen,
  reports: BarChart3,
  subscription: CreditCard,
  ai: Bot,
  users: UserCog,
  roles: KeyRound,
  settings: Settings,
} satisfies Record<string, LucideIcon>;

export type NavIcon = keyof typeof ICONS;
export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const isActive = (pathname: string, href: string): boolean =>
  pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`));

const linkClass = (active: boolean) =>
  cn(
    "flex min-h-10 items-center gap-3 rounded-lg px-3 text-base font-medium outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-primary/15 text-foreground shadow-[inset_2px_0_0_var(--primary)]"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );

/** Estructura de la aplicación: sidebar de vidrio (menú desplegable en celular), barra superior y contenido. */
export function AppShell({
  groups,
  settings,
  canSell,
  branch,
  user,
  banners,
  children,
}: {
  groups: NavGroup[];
  settings: NavItem | null;
  canSell: boolean;
  branch: BranchContext | null;
  user: { name: string; roleName: string; tenantName: string };
  banners: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const offline = useOffline();
  // El cajón queda abierto solo en la ruta donde se abrió: al navegar se cierra sin efectos.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    // Al navegar, el cajón móvil se cierra y no se reabre al volver a la misma ruta.
    setSeenPath(pathname);
    setOpenAt(null);
  }
  const open = openAt !== null;
  const setOpen = useCallback((value: boolean) => setOpenAt(value ? pathname : null), [pathname]);
  const all = [...groups.flatMap((g) => g.items), ...(settings ? [settings] : [])];
  // Gana la ruta más específica: /app/reports/ple marca «Libros PLE», no «Reportes».
  const current = all
    .filter((item) => isActive(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <div className="min-h-dvh lg:pl-72 print:pl-0">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {es.nav.skip}
      </a>
      {open ? (
        <button
          type="button"
          aria-label={es.nav.closeMenu}
          className="fixed inset-0 z-30 bg-background/70 lg:hidden print:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <aside
        id="menu-lateral"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 flex-col pt-[env(safe-area-inset-top)] border-r border-border bg-card backdrop-blur-[14px] transition-[transform,visibility] duration-200 motion-reduce:transition-none print:hidden lg:visible lg:translate-x-0",
          open ? "visible translate-x-0" : "invisible -translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 pt-4">
          <Link
            href="/app"
            aria-label={es.nav.dashboard}
            className="block w-44 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Logo sizes="176px" />
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={es.nav.closeMenu}
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>
        <nav aria-label="Principal" className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </p>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const active = current?.href === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={linkClass(active)}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setOpen(false)}
                      >
                        <Icon className="size-5 shrink-0" aria-hidden />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="space-y-3 border-t border-border p-3">
          {settings ? (
            <Link
              href={settings.href}
              className={linkClass(current?.href === settings.href)}
              aria-current={current?.href === settings.href ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              <Settings className="size-5 shrink-0" aria-hidden />
              {settings.label}
            </Link>
          ) : null}
          <InstallButton />
          <div className="flex items-center justify-between gap-2 px-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.roleName}</p>
            </div>
            <form
              action={logoutAction}
              onSubmit={(event) => {
                const waiting =
                  offline.counts.pending + offline.counts.syncing + offline.counts.failed;
                if (waiting > 0 && !window.confirm(es.offline.logoutConfirm(waiting))) {
                  event.preventDefault();
                  return;
                }
                // Al salir se borran las páginas y el catálogo guardados; las ventas pendientes se conservan.
                void clearPrivateCaches();
                void clearSnapshot().catch(() => undefined);
              }}
            >
              <Button type="submit" variant="ghost" size="sm">
                <LogOut aria-hidden />
                {es.auth.logout}
              </Button>
            </form>
          </div>
        </div>
      </aside>

      <div className="print:hidden">{banners}</div>
      <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 pt-[env(safe-area-inset-top)] border-b border-border bg-card px-4 backdrop-blur-[14px] print:hidden">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={es.nav.openMenu}
          aria-expanded={open}
          aria-controls="menu-lateral"
          onClick={() => setOpen(true)}
        >
          <Menu />
        </Button>
        <p className="min-w-0 flex-1 truncate text-lg font-semibold">
          {current?.label ?? user.tenantName}
        </p>
        {branch ? <BranchSwitcher context={branch} /> : null}
        <SyncBadge />
        {settings ? (
          <Link
            href={settings.href}
            aria-label={es.nav.settingsShort}
            title={es.nav.settings}
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <Settings aria-hidden />
          </Link>
        ) : null}
        {canSell ? (
          <Link href="/app/pos" className={buttonVariants({ size: "default" })}>
            <ShoppingCart aria-hidden />
            {es.nav.newSale}
          </Link>
        ) : null}
      </header>
      <main id="contenido" className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
