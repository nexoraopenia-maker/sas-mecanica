import { Banners } from "@/components/banners";
import { AppShell, type NavGroup, type NavItem } from "@/components/shell/app-shell";
import { can, type AuthUser } from "@/lib/auth/can";
import type { PermissionKey } from "@/lib/auth/permissions";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";

type Entry = NavItem & { needs: PermissionKey[] };

const GROUPS: Array<{ label: string; items: Entry[] }> = [
  {
    label: es.nav.groupOperation,
    items: [
      { href: "/app", label: es.nav.dashboard, icon: "dashboard", needs: [] },
      { href: "/app/pos", label: es.nav.pos, icon: "pos", needs: ["pos:crear"] },
      { href: "/app/sales", label: es.pos.sales, icon: "sales", needs: ["pos:ver"] },
      { href: "/app/cash", label: es.nav.cash, icon: "cash", needs: ["cash:ver"] },
      { href: "/app/quotes", label: es.nav.quotes, icon: "quotes", needs: ["pos:ver"] },
      {
        href: "/app/receivables",
        label: es.nav.receivables,
        icon: "receivables",
        needs: ["pos:ver"],
      },
    ],
  },
  {
    label: es.nav.groupWorkshop,
    items: [
      { href: "/app/workshop", label: es.nav.workshop, icon: "workshop", needs: ["workshop:ver"] },
      {
        href: "/app/customers",
        label: es.nav.customers,
        icon: "customers",
        needs: ["customers:ver"],
      },
      {
        href: "/app/warranties",
        label: es.nav.warranties,
        icon: "warranties",
        needs: ["warranties:ver"],
      },
    ],
  },
  {
    label: es.nav.groupInventory,
    items: [
      { href: "/app/catalog", label: es.nav.catalog, icon: "catalog", needs: ["catalog:ver"] },
      {
        href: "/app/inventory",
        label: es.nav.inventory,
        icon: "inventory",
        needs: ["inventory:ver"],
      },
      {
        href: "/app/purchasing",
        label: es.nav.purchasing,
        icon: "purchasing",
        needs: ["purchasing:ver"],
      },
    ],
  },
  {
    label: es.nav.groupFiscal,
    items: [
      { href: "/app/billing", label: es.nav.billing, icon: "billing", needs: ["billing:ver"] },
      { href: "/app/reports", label: es.nav.reports, icon: "reports", needs: ["reports:ver"] },
    ],
  },
  {
    // Provisional: la Fase 3 los reúne en la pantalla de Configuración.
    label: es.nav.groupAdmin,
    items: [
      {
        href: "/app/subscription",
        label: es.nav.subscription,
        icon: "subscription",
        needs: ["settings:ver"],
      },
      { href: "/app/ai", label: es.nav.ai, icon: "ai", needs: ["ai_agent:ver"] },
      { href: "/app/users", label: es.nav.users, icon: "users", needs: ["users:ver"] },
      { href: "/app/roles", label: es.nav.roles, icon: "roles", needs: ["users:ver"] },
    ],
  },
];

function visibleGroups(user: AuthUser): NavGroup[] {
  return GROUPS.map((group) => ({
    label: group.label,
    items: group.items
      .filter((item) => item.needs.every((permission) => can(user, permission)))
      .map(({ href, label, icon }) => ({ href, label, icon })),
  })).filter((group) => group.items.length > 0);
}

export default async function TenantLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requireTenantUser();
  const settings: NavItem | null =
    can(user, "settings:ver") || can(user, "ai_agent:ver")
      ? { href: "/app/settings", label: es.nav.settings, icon: "settings" }
      : null;
  return (
    <AppShell
      groups={visibleGroups(user)}
      settings={settings}
      canSell={can(user, "pos:crear")}
      user={{
        name: user.name,
        roleName: user.roleName ?? "",
        tenantName: user.tenantName ?? es.app.name,
      }}
      banners={<Banners user={user} />}
    >
      {children}
    </AppShell>
  );
}
