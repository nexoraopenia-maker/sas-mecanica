import { claimStepAction, createClaimAction, createPolicyAction } from "@/app/actions/workshop";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDate, formatKm } from "@/lib/workshop/format";
import { listClaims, listWarrantyPolicies, searchWarranties } from "@/server/services/warranties";

export default async function WarrantiesPage({
  searchParams,
}: {
  searchParams: Promise<{ placa?: string; serie?: string; cliente?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "warranties:ver");
  const t = es.warranties;
  const filter = await searchParams;
  const searched = Boolean(filter.placa || filter.serie || filter.cliente);
  const [results, claims, policies] = await Promise.all([
    searchWarranties(user, {
      plate: filter.placa,
      serial: filter.serie,
      customer: filter.cliente,
      limit: searched ? 50 : 20,
    }),
    listClaims(user),
    listWarrantyPolicies(user),
  ]);
  const canClaim = can(user, "warranties:crear");
  const canDecide = can(user, "warranties:editar");

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>

      <form className="grid gap-2 sm:grid-cols-4" role="search" aria-label={t.search}>
        <Input
          name="placa"
          defaultValue={filter.placa ?? ""}
          placeholder={t.plate}
          aria-label={t.plate}
        />
        <Input
          name="serie"
          defaultValue={filter.serie ?? ""}
          placeholder={t.serialLabel}
          aria-label={t.serialLabel}
        />
        <Input
          name="cliente"
          defaultValue={filter.cliente ?? ""}
          placeholder={t.customer}
          aria-label={t.customer}
        />
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>

      <h2 className="text-xl font-semibold">{t.results}</h2>
      {results.length === 0 ? <p className="text-muted-foreground">{t.none}</p> : null}
      <ul className="space-y-3">
        {results.map((warranty) => (
          <li key={warranty.id}>
            <Card className="space-y-2" data-testid="warranty">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">{warranty.description}</p>
                <span className="rounded-full bg-muted px-3 py-1 text-sm">
                  {t.status[warranty.status]}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {warranty.customer ?? "—"} · {warranty.plate ?? "sin placa"}
                {warranty.serial ? ` · ${es.vehicles.serial} ${warranty.serial}` : ""}
                {warranty.dotCode ? ` · ${es.vehicles.dot} ${warranty.dotCode}` : ""}
              </p>
              <p className="text-sm">
                {t.expires}: {formatDate(warranty.expiresAt)}
                {warranty.expiresAtMileage ? ` / ${formatKm(warranty.expiresAtMileage)}` : ""}
                {warranty.daysLeft !== null ? ` (${warranty.daysLeft} ${t.daysLeft})` : ""} ·{" "}
                {warranty.covered ? t.covered : `${t.notCovered}: ${warranty.reasons.join(", ")}`}
              </p>
              {canClaim && (warranty.status === "ACTIVE" || warranty.status === "EXPIRED") ? (
                <ActionForm
                  action={createClaimAction}
                  submitLabel={t.submitClaim}
                  size="sm"
                  className="grid gap-2 sm:grid-cols-3"
                >
                  <input type="hidden" name="warrantyId" value={warranty.id} />
                  <div className="sm:col-span-2">
                    <Label htmlFor={`d-${warranty.id}`}>{t.claimDescription}</Label>
                    <Input
                      id={`d-${warranty.id}`}
                      name="description"
                      required
                      minLength={5}
                      maxLength={1000}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`m-${warranty.id}`}>{t.claimMileage}</Label>
                    <Input
                      id={`m-${warranty.id}`}
                      name="mileage"
                      type="number"
                      inputMode="numeric"
                      min={0}
                    />
                  </div>
                </ActionForm>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>

      <h2 className="text-xl font-semibold">{t.claims}</h2>
      <ul className="space-y-3">
        {claims.map((claim) => (
          <li key={claim.id}>
            <Card className="space-y-2" data-testid="claim">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  N.º {claim.number} · {claim.warranty.description} ·{" "}
                  {claim.warranty.vehicle?.plate ?? ""}
                </p>
                <span className="rounded-full bg-muted px-3 py-1 text-sm">
                  {t.claimStatus[claim.status]}
                </span>
              </div>
              <p className="text-sm">{claim.description}</p>
              {claim.evaluation ? (
                <p className="text-sm text-muted-foreground">{claim.evaluation}</p>
              ) : null}
              {canDecide && claim.status === "RECEIVED" ? (
                <ActionForm
                  action={claimStepAction}
                  submitLabel={t.evaluate}
                  size="sm"
                  variant="outline"
                  className="inline"
                >
                  <input type="hidden" name="claimId" value={claim.id} />
                  <input type="hidden" name="step" value="evaluate" />
                </ActionForm>
              ) : null}
              {canDecide && claim.status === "EVALUATING" ? (
                <ActionForm
                  action={claimStepAction}
                  submitLabel="Registrar decisión"
                  size="sm"
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <input type="hidden" name="claimId" value={claim.id} />
                  <input type="hidden" name="step" value="decide" />
                  <div className="sm:col-span-2">
                    <Label htmlFor={`e-${claim.id}`}>{t.evaluation}</Label>
                    <Input
                      id={`e-${claim.id}`}
                      name="evaluation"
                      required
                      minLength={5}
                      maxLength={1000}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`x-${claim.id}`}>Decisión</Label>
                    <Select id={`x-${claim.id}`} name="decision" defaultValue="APPROVE">
                      <option value="APPROVE">{t.approveClaim}</option>
                      <option value="REJECT">{t.rejectClaim}</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`r-${claim.id}`}>Resolución</Label>
                    <Select id={`r-${claim.id}`} name="resolution" defaultValue="REPLACEMENT">
                      <option value="REPLACEMENT">{t.replacement}</option>
                      <option value="CREDIT_NOTE">{t.creditNote}</option>
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor={`o-${claim.id}`}>{t.overrideReason}</Label>
                    <Input id={`o-${claim.id}`} name="overrideReason" maxLength={300} />
                  </div>
                </ActionForm>
              ) : null}
              {canDecide && claim.status === "APPROVED" ? (
                <ActionForm
                  action={claimStepAction}
                  submitLabel={t.resolve}
                  size="sm"
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="claimId" value={claim.id} />
                  <input type="hidden" name="step" value="resolve" />
                  {claim.resolution === "CREDIT_NOTE" ? (
                    <Input
                      name="creditAmount"
                      inputMode="decimal"
                      placeholder={t.creditAmount}
                      required
                      className="max-w-56"
                      aria-label={t.creditAmount}
                    />
                  ) : null}
                </ActionForm>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>

      <h2 className="text-xl font-semibold">{t.policies}</h2>
      <ul className="space-y-1 text-sm">
        {policies.map((policy) => (
          <li key={policy.id}>
            {policy.name} · {policy.months ? `${policy.months} meses` : ""}{" "}
            {policy.kilometers ? `${policy.kilometers.toLocaleString("es-PE")} km` : ""}
            {policy.coversLabor ? ` · ${t.coversLabor}` : ""}
          </li>
        ))}
      </ul>
      {canClaim ? (
        <Card>
          <CardTitle>{t.newPolicy}</CardTitle>
          <ActionForm
            action={createPolicyAction}
            submitLabel={t.submitPolicy}
            className="grid gap-3 sm:grid-cols-3"
          >
            <div className="sm:col-span-3">
              <Label htmlFor="name">{t.policyName}</Label>
              <Input id="name" name="name" required minLength={2} maxLength={120} />
            </div>
            <div>
              <Label htmlFor="months">{t.months}</Label>
              <Input
                id="months"
                name="months"
                type="number"
                inputMode="numeric"
                min={1}
                max={120}
              />
            </div>
            <div>
              <Label htmlFor="kilometers">{t.kilometers}</Label>
              <Input
                id="kilometers"
                name="kilometers"
                type="number"
                inputMode="numeric"
                min={100}
              />
            </div>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input type="checkbox" name="coversLabor" className="size-5" />
              {t.coversLabor}
            </label>
            <div className="sm:col-span-3">
              <Label htmlFor="terms">{t.terms}</Label>
              <Input id="terms" name="terms" maxLength={1000} />
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
