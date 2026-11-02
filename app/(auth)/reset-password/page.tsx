import { resetPasswordAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) return <Alert tone="error">{es.auth.tokenMissing}</Alert>;
  return (
    <Card>
      <CardTitle>{es.auth.resetTitle}</CardTitle>
      <ActionForm action={resetPasswordAction} submitLabel={es.auth.resetSubmit}>
        <input type="hidden" name="token" value={token} />
        <div>
          <Label htmlFor="password">{es.auth.newPassword}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <p className="mt-1 text-xs text-muted-foreground">{es.auth.passwordHint}</p>
        </div>
        <div>
          <Label htmlFor="confirm">{es.auth.confirmPassword}</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
        </div>
      </ActionForm>
    </Card>
  );
}
