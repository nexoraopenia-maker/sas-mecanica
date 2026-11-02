import { redirect } from "next/navigation";
import { mfaAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";
import { beginMfaEnrollment, getMfaStage } from "@/server/services/auth";
import { readSessionClaims } from "@/server/services/session";

export default async function MfaPage() {
  const claims = await readSessionClaims();
  if (!claims || claims.tid !== null || claims.mfa) redirect("/login");
  const stage = await getMfaStage(claims.sub);
  const enrollment = stage === "enroll" ? await beginMfaEnrollment(claims.sub) : null;

  return (
    <Card>
      <CardTitle>{es.auth.mfaTitle}</CardTitle>
      <p className="mb-4 text-sm text-muted-foreground">
        {enrollment ? es.auth.mfaEnroll : es.auth.mfaVerify}
      </p>
      {enrollment ? (
        <div className="mb-4 space-y-2 rounded-lg bg-muted p-3 text-sm">
          <p className="font-medium">{es.auth.mfaSecret}</p>
          <p className="break-all font-mono text-base">{enrollment.secret}</p>
          <p className="break-all text-xs text-muted-foreground">{enrollment.uri}</p>
        </div>
      ) : null}
      <ActionForm action={mfaAction} submitLabel={es.auth.mfaSubmit}>
        <div>
          <Label htmlFor="code">{es.auth.mfaCode}</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
          />
        </div>
      </ActionForm>
    </Card>
  );
}
