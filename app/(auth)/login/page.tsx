import Link from "next/link";
import { headers } from "next/headers";
import { loginAction, startDemoAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Turnstile } from "@/components/forms/turnstile";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string; welcome?: string }>;
}) {
  const params = await searchParams;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      {params.reset ? <Alert tone="success">{es.auth.resetDone}</Alert> : null}
      {params.welcome ? <Alert tone="success">{es.auth.welcome}</Alert> : null}
      <Card>
        <CardTitle>{es.auth.loginTitle}</CardTitle>
        <ActionForm action={loginAction} submitLabel={es.auth.submitLogin}>
          <input type="hidden" name="next" value={params.next ?? ""} />
          <div>
            <Label htmlFor="email">{es.auth.email}</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required />
          </div>
          <div>
            <Label htmlFor="password">{es.auth.password}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
        </ActionForm>
        <p className="mt-4 text-sm">
          <Link href="/forgot-password" className="text-primary underline">
            {es.auth.forgot}
          </Link>
        </p>
      </Card>
      <Card>
        <CardTitle>{es.auth.demoTitle}</CardTitle>
        <p className="mb-4 text-sm text-muted-foreground">{es.auth.demoText}</p>
        <ActionForm
          action={startDemoAction}
          submitLabel={es.auth.demoSubmit}
          pendingLabel="Preparando tu taller de prueba…"
          variant="outline"
        >
          <Turnstile siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} nonce={nonce} />
        </ActionForm>
      </Card>
    </>
  );
}
