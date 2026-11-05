import { redirect } from "next/navigation";
import { changeTemporaryPasswordAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { requireUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";

/** Primer ingreso con la contraseña temporal que entregó el SuperAdmin: hay que crear una propia. */
export default async function ChangePasswordPage() {
  const user = await requireUser();
  if (!user.tenantId || !user.mustChangePassword) redirect(user.isSuperAdmin ? "/admin" : "/app");
  const t = es.auth;
  return (
    <Card>
      <CardTitle>{t.changeTempTitle}</CardTitle>
      <Alert tone="info" className="mb-4">
        {t.changeTempHelp}
      </Alert>
      <ActionForm action={changeTemporaryPasswordAction} submitLabel={t.changeTempSubmit}>
        <div>
          <Label htmlFor="current">{t.changeTempCurrent}</Label>
          <Input
            id="current"
            name="current"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <div>
          <Label htmlFor="password">{t.newPassword}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
          />
          <p className="mt-1 text-xs text-muted-foreground">{t.passwordRules}</p>
        </div>
        <div>
          <Label htmlFor="confirm">{t.confirmPassword}</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </div>
      </ActionForm>
    </Card>
  );
}
