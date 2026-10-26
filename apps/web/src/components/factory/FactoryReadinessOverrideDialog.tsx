import { FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { countFactoryFeedText } from "./factoryFeeds.logic";
import {
  FACTORY_OVERRIDE_ACTIONS,
  isFactoryOverrideSubmitEnabled,
  type FactoryFailure,
  type FactoryReadinessEdgeRow,
  type FactoryReadinessOverrideAction,
} from "./factoryIssues.logic";
import { FactoryReviewFailure } from "./FactoryReview";

/**
 * Records one decision about one blocker. `row` is the edge exactly as the reviewer saw it, and its
 * fingerprint is the only evidence ever submitted: a refreshed table can never change what is
 * confirmed here, and a blocker that changed since is refused by the server.
 */
export function FactoryReadinessOverrideDialog(props: {
  readonly row: FactoryReadinessEdgeRow;
  readonly action: FactoryReadinessOverrideAction;
  readonly canOperate: boolean;
  readonly pending: boolean;
  readonly failure: FactoryFailure | null;
  readonly onClose: () => void;
  readonly onSubmit: (reason: string) => void;
}) {
  const { row, pending } = props;
  const copy = FACTORY_OVERRIDE_ACTIONS[props.action];
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const changed = props.failure?.kind === "changed";
  const count = countFactoryFeedText(reason, FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS);
  const enabled = isFactoryOverrideSubmitEnabled({
    canOperate: props.canOperate,
    pending,
    changed,
    reason,
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || changed} className="min-w-0 space-y-4">
            <div className="space-y-0.5">
              <p className="font-medium text-sm [overflow-wrap:anywhere]">
                {row.locator} · {row.title}
              </p>
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                {row.stateLabel} · {row.resolutionLabel} · {row.statusLabel}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={reasonId}>Reason</Label>
              <Textarea
                id={reasonId}
                value={reason}
                aria-invalid={count.overLimit}
                aria-describedby={`${reasonId}-help`}
                placeholder="Why this decision is right, in your own words"
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="flex items-start justify-between gap-3">
                <p id={`${reasonId}-help`} className="text-muted-foreground text-xs">
                  Required. Shown beside the blocker and kept after it is revoked.
                </p>
                <span
                  className={
                    count.overLimit
                      ? "shrink-0 text-destructive text-xs"
                      : "shrink-0 text-muted-foreground text-xs"
                  }
                >
                  {count.label}
                </span>
              </div>
            </div>
          </fieldset>
        </DialogPanel>
        {props.failure ? (
          <FactoryReviewFailure
            failure={props.failure}
            changed={changed}
            staleHint="This blocker changed after you reviewed it. Close this dialog, refresh, and review the blocker again before recording a decision."
          />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!enabled}
            aria-busy={pending}
            onClick={() => {
              if (!enabled) return;
              props.onSubmit(reason);
            }}
          >
            {pending ? copy.pendingLabel : copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
