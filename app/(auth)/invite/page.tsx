import { acceptInviteAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";
import { describeInvite } from "@/server/services/auth";

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) return <Alert tone="error">{es.auth.tokenMissing}</Alert>;
  const invite = await describeInvite(token);
  if (!invite) return <Alert tone="error">{es.auth.inviteInvalid}</Alert>;
  return (
    <Card>
      <CardTitle>{es.auth.inviteTitle}</CardTitle>
      <p className="mb-4 text-sm text-muted-foreground">
        {invite.company} · {invite.email}
      </p>
      <ActionForm action={acceptInviteAction} submitLabel={es.auth.inviteSubmit}>
        <input type="hidden" name="token" value={token} />
        <div>
          <Label htmlFor="name">{es.auth.yourName}</Label>
          <Input id="name" name="name" defaultValue={invite.name} autoComplete="name" required />
        </div>
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
