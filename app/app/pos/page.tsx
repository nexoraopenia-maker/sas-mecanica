import Link from "next/link";
import { PosTerminal } from "@/components/pos/pos-terminal";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { getCurrentSession } from "@/server/services/cash";

export default async function PosPage() {
  const user = await requireTenantUser();
  requirePermission(user, "pos:crear");
  const session = await getCurrentSession(user);
  const t = es.pos;

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        {session ? (
          <p className="text-sm text-muted-foreground">
            {es.cash.current} · {es.cash.expectedCash}: S/ {session.summary.expectedCash}
          </p>
        ) : null}
      </div>
      {session ? (
        <PosTerminal />
      ) : (
        <Card className="space-y-3">
          <p>{t.needCash}</p>
          <Link
            className="inline-flex h-12 items-center rounded-lg bg-primary px-5 text-primary-foreground"
            href="/app/cash"
          >
            {t.openCash}
          </Link>
        </Card>
      )}
    </>
  );
}
