import { Header } from "@/components/nav";
import { requirePlatformUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requirePlatformUser();
  return (
    <>
      <Header
        title={`${es.app.name} · SuperAdmin`}
        subtitle={user.email}
        links={[
          { href: "/admin", label: es.nav.platform },
          { href: "/admin/tenants", label: es.nav.tenants },
          { href: "/admin/plans", label: es.nav.plans },
          { href: "/admin/billing", label: es.nav.adminBilling },
        ]}
      />
      <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">{children}</main>
    </>
  );
}
