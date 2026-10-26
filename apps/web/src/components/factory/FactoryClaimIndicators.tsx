import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import type { FactoryClaimRowPresentation } from "./factoryClaims.logic";

/** The conflict badges and provenance line for one issue or feed item. Renders nothing otherwise. */
export function FactoryClaimIndicators(props: {
  readonly presentation: FactoryClaimRowPresentation;
}) {
  const { conflict, duplicates, provenance } = props.presentation;
  if (conflict === null && duplicates === null && provenance === null) return null;
  return (
    <div className="min-w-0 space-y-1">
      {[conflict, duplicates].map((entry) =>
        entry === null ? null : (
          <div key={entry.badge} className="flex flex-wrap items-center gap-2">
            <Badge variant="warning">{entry.badge}</Badge>
            <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {entry.detail}
            </span>
          </div>
        ),
      )}
      {provenance !== null ? (
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{provenance}</p>
      ) : null}
    </div>
  );
}

/** Environments that may hold claims but did not answer; never worded as "no claims". */
export function FactoryClaimsUnavailableNote(props: { readonly note: string | null }) {
  if (props.note === null) return null;
  return (
    <Alert variant="info">
      <AlertDescription>{props.note}</AlertDescription>
    </Alert>
  );
}

/** Shown in the Start and Admit dialogs. A warning only: it never disables the action. */
export function FactoryClaimWarning(props: { readonly message: string | null }) {
  if (props.message === null) return null;
  return (
    <Alert variant="warning">
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
  );
}
