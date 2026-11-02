import Link from "next/link";
import { forgotPasswordAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { es } from "@/lib/i18n/es";

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardTitle>{es.auth.forgotTitle}</CardTitle>
      <ActionForm action={forgotPasswordAction} submitLabel={es.auth.forgotSubmit}>
        <div>
          <Label htmlFor="email">{es.auth.email}</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </div>
      </ActionForm>
      <p className="mt-4 text-sm">
        <Link href="/login" className="text-primary underline">
          {es.auth.submitLogin}
        </Link>
      </p>
    </Card>
  );
}
