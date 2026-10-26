import { factoryIssueReviewText } from "@t3tools/client-runtime/state/factory";
import {
  FACTORY_RESEARCH_EVALUATOR_MAX_PATHS,
  FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS,
  FACTORY_RESEARCH_RUN_COMMAND_MAX_CHARS,
  type FactoryRepository,
  type FactoryResearchProtocol,
} from "@t3tools/contracts";
import { useId, useState, type ReactNode } from "react";

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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { countFactoryFeedText } from "./factoryFeeds.logic";
import {
  EMPTY_FACTORY_RESEARCH_SEAL_DRAFT,
  checkFactoryResearchSealDraft,
  shortFactoryCommit,
  type FactoryResearchFailure,
  type FactoryResearchSealDraft,
  type FactoryResearchSealErrors,
  type FactoryResearchSealField,
  type FactoryResearchSealFields,
} from "./factoryResearch.logic";
import { FactoryReviewFailure } from "./FactoryReview";

function Field(props: {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          {props.hint !== undefined ? (
            <p id={`${props.id}-hint`} className="text-muted-foreground text-xs">
              {props.hint}
            </p>
          ) : null}
          {props.error !== undefined ? (
            <p id={`${props.id}-error`} role="alert" className="text-destructive text-xs">
              {props.error}
            </p>
          ) : null}
        </div>
        {props.trailing}
      </div>
    </div>
  );
}

function Counter(props: { readonly value: string; readonly max: number }) {
  const count = countFactoryFeedText(props.value.trim(), props.max);
  return (
    <span
      className={
        count.overLimit
          ? "shrink-0 text-destructive text-xs"
          : "shrink-0 text-muted-foreground text-xs"
      }
    >
      {count.label}
    </span>
  );
}

/**
 * Collects a protocol and shows what the server sealed. Sealing is irreversible, so the form says
 * so and, afterwards, shows the evaluator blob ids the server computed rather than anything typed.
 */
export function FactoryResearchSealDialog(props: {
  readonly repository: FactoryRepository;
  readonly projectTitle: string;
  readonly canSeal: boolean;
  readonly pending: boolean;
  readonly failure: FactoryResearchFailure | null;
  /** Set once the server has sealed the protocol; replaces the form with the sealed record. */
  readonly sealed: FactoryResearchProtocol | null;
  readonly onClose: () => void;
  readonly onSubmit: (fields: FactoryResearchSealFields) => void;
  readonly onOpenProtocol: (protocol: FactoryResearchProtocol) => void;
}) {
  const { pending, sealed } = props;
  const baseId = useId();
  const [draft, setDraft] = useState<FactoryResearchSealDraft>(EMPTY_FACTORY_RESEARCH_SEAL_DRAFT);
  const [errors, setErrors] = useState<FactoryResearchSealErrors>({});

  const idFor = (field: FactoryResearchSealField) => `${baseId}-${field}`;
  const update = <Key extends FactoryResearchSealField>(
    field: Key,
    value: FactoryResearchSealDraft[Key],
  ) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => {
      if (previous[field] === undefined) return previous;
      const { [field]: _cleared, ...rest } = previous;
      return rest;
    });
  };
  const describedBy = (field: FactoryResearchSealField, hint: boolean) =>
    [
      hint ? `${idFor(field)}-hint` : null,
      errors[field] !== undefined ? `${idFor(field)}-error` : null,
    ]
      .filter((id) => id !== null)
      .join(" ") || undefined;

  const submit = () => {
    if (!props.canSeal || pending) return;
    // The clock is read once per attempt; the server re-checks the window when it seals.
    const check = checkFactoryResearchSealDraft(draft, Date.now());
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    props.onSubmit(check.fields);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {sealed === null ? "Seal research protocol" : "Protocol sealed"}
          </DialogTitle>
          <DialogDescription>
            {sealed === null
              ? "A protocol fixes the hypothesis, the command a run executes, the files that must not change, the metric and the budget. It cannot be edited afterwards; a change is a new protocol."
              : "The server resolved the base commit and hashed each evaluator itself. These are the values every run is checked against."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {sealed !== null ? (
            <SealedProtocolSummary protocol={sealed} />
          ) : (
            <form
              id={`${baseId}-form`}
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <fieldset disabled={pending} className="min-w-0 space-y-4">
                <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                  {`${props.repository.host}/${props.repository.repository}`} · project{" "}
                  {props.projectTitle}
                </p>
                <Field
                  id={idFor("hypothesis")}
                  label="Hypothesis"
                  hint="One falsifiable sentence."
                  error={errors.hypothesis}
                  trailing={
                    <Counter value={draft.hypothesis} max={FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS} />
                  }
                >
                  <Textarea
                    id={idFor("hypothesis")}
                    value={draft.hypothesis}
                    aria-invalid={errors.hypothesis !== undefined}
                    aria-describedby={describedBy("hypothesis", true)}
                    placeholder="Halving the batch size lowers validation loss by at least 0.01"
                    onChange={(event) => update("hypothesis", event.target.value)}
                  />
                </Field>
                <Field
                  id={idFor("runCommand")}
                  label="Run command"
                  hint="What a run executes. T3 Code does not run it; the agent does, in its own worktree."
                  error={errors.runCommand}
                  trailing={
                    <Counter
                      value={draft.runCommand}
                      max={FACTORY_RESEARCH_RUN_COMMAND_MAX_CHARS}
                    />
                  }
                >
                  <Input
                    id={idFor("runCommand")}
                    font="mono"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.runCommand}
                    aria-invalid={errors.runCommand !== undefined}
                    aria-describedby={describedBy("runCommand", true)}
                    placeholder="uv run train.py"
                    onChange={(event) => update("runCommand", event.target.value)}
                  />
                </Field>
                <Field
                  id={idFor("evaluatorPaths")}
                  label="Evaluator paths"
                  hint={`One repository path per line, up to ${FACTORY_RESEARCH_EVALUATOR_MAX_PATHS}. The server hashes each at the base commit; a run that changes one is not acceptable evidence.`}
                  error={errors.evaluatorPaths}
                >
                  <Textarea
                    id={idFor("evaluatorPaths")}
                    spellCheck={false}
                    value={draft.evaluatorPaths}
                    aria-invalid={errors.evaluatorPaths !== undefined}
                    aria-describedby={describedBy("evaluatorPaths", true)}
                    placeholder={"prepare.py\nscripts/score.py"}
                    onChange={(event) => update("evaluatorPaths", event.target.value)}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={idFor("metricName")} label="Metric name" error={errors.metricName}>
                    <Input
                      id={idFor("metricName")}
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.metricName}
                      aria-invalid={errors.metricName !== undefined}
                      aria-describedby={describedBy("metricName", false)}
                      placeholder="val_bpb"
                      onChange={(event) => update("metricName", event.target.value)}
                    />
                  </Field>
                  <Field
                    id={idFor("linePrefix")}
                    label="Line prefix"
                    hint="The server reads the number after this text on the line the run cites."
                    error={errors.linePrefix}
                  >
                    <Input
                      id={idFor("linePrefix")}
                      font="mono"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.linePrefix}
                      aria-invalid={errors.linePrefix !== undefined}
                      aria-describedby={describedBy("linePrefix", true)}
                      placeholder="val_bpb:"
                      onChange={(event) => update("linePrefix", event.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label id={`${idFor("direction")}-label`}>Direction</Label>
                    <ToggleGroup
                      aria-labelledby={`${idFor("direction")}-label`}
                      value={[draft.direction]}
                      onValueChange={(values) => {
                        const next = values[0];
                        if (next === "lower" || next === "higher") update("direction", next);
                      }}
                    >
                      <Toggle value="lower">Lower is better</Toggle>
                      <Toggle value="higher">Higher is better</Toggle>
                    </ToggleGroup>
                  </div>
                  <Field
                    id={idFor("minimumEffect")}
                    label={
                      <>
                        Minimum effect{" "}
                        <span className="font-normal text-muted-foreground">optional</span>
                      </>
                    }
                    hint="How far a result must beat the baseline. Left empty, no result can be judged and the finding stays unknown."
                    error={errors.minimumEffect}
                  >
                    <Input
                      id={idFor("minimumEffect")}
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft.minimumEffect}
                      aria-invalid={errors.minimumEffect !== undefined}
                      aria-describedby={describedBy("minimumEffect", true)}
                      placeholder="0.01"
                      onChange={(event) => update("minimumEffect", event.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={idFor("maxRuns")} label="Maximum runs" error={errors.maxRuns}>
                    <Input
                      id={idFor("maxRuns")}
                      inputMode="numeric"
                      autoComplete="off"
                      value={draft.maxRuns}
                      aria-invalid={errors.maxRuns !== undefined}
                      aria-describedby={describedBy("maxRuns", false)}
                      onChange={(event) => update("maxRuns", event.target.value)}
                    />
                  </Field>
                  <Field
                    id={idFor("maxRunMinutes")}
                    label="Maximum minutes per run"
                    error={errors.maxRunMinutes}
                  >
                    <Input
                      id={idFor("maxRunMinutes")}
                      inputMode="numeric"
                      autoComplete="off"
                      value={draft.maxRunMinutes}
                      aria-invalid={errors.maxRunMinutes !== undefined}
                      aria-describedby={describedBy("maxRunMinutes", false)}
                      onChange={(event) => update("maxRunMinutes", event.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  id={idFor("expiresAt")}
                  label="Budget window closes"
                  hint="Your local time. New runs are refused after this; a running thread is only stopped by you."
                  error={errors.expiresAt}
                >
                  <Input
                    id={idFor("expiresAt")}
                    type="datetime-local"
                    value={draft.expiresAt}
                    aria-invalid={errors.expiresAt !== undefined}
                    aria-describedby={describedBy("expiresAt", true)}
                    onChange={(event) => update("expiresAt", event.target.value)}
                  />
                </Field>
                <Field
                  id={idFor("baseRef")}
                  label={
                    <>
                      Base ref <span className="font-normal text-muted-foreground">optional</span>
                    </>
                  }
                  hint="A local branch, tag or commit, fixed to one commit when sealed. Empty uses the current HEAD of the checkout; nothing is fetched or changed."
                >
                  <Input
                    id={idFor("baseRef")}
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.baseRef}
                    aria-describedby={describedBy("baseRef", true)}
                    placeholder="Current HEAD of the project checkout"
                    onChange={(event) => update("baseRef", event.target.value)}
                  />
                </Field>
              </fieldset>
            </form>
          )}
        </DialogPanel>
        {props.failure !== null && sealed === null ? (
          <FactoryReviewFailure failure={props.failure} changed={false} staleHint="" />
        ) : null}
        <DialogFooter>
          {sealed !== null ? (
            <>
              <DialogClose render={<Button variant="outline" size="sm" />}>Close</DialogClose>
              <Button size="sm" onClick={() => props.onOpenProtocol(sealed)}>
                Open protocol
              </Button>
            </>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
                Cancel
              </DialogClose>
              <Button
                size="sm"
                type="submit"
                form={`${baseId}-form`}
                disabled={!props.canSeal || pending}
                aria-busy={pending}
              >
                {pending ? "Sealing…" : "Seal protocol"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Everything shown comes from the server's record, never from what was typed. */
function SealedProtocolSummary(props: { readonly protocol: FactoryResearchProtocol }) {
  const { protocol } = props;
  return (
    <div className="min-w-0 space-y-4">
      <dl className="space-y-3 text-sm">
        <div className="space-y-0.5">
          <dt className="font-medium text-xs">Base commit</dt>
          <dd className="font-mono text-xs [overflow-wrap:anywhere]">{protocol.baseCommit}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="font-medium text-xs">Revision</dt>
          <dd className="font-mono text-xs [overflow-wrap:anywhere]">{protocol.revision}</dd>
        </div>
      </dl>
      <div className="space-y-1.5">
        <h3 className="font-medium text-xs">Evaluators the server hashed</h3>
        <ul className="space-y-1.5" aria-label="Sealed evaluators">
          {protocol.evaluators.map((evaluator) => (
            <li key={evaluator.path} className="rounded-lg border border-border/60 p-2">
              <p className="font-mono text-xs [overflow-wrap:anywhere]">
                {factoryIssueReviewText(evaluator.path)}
              </p>
              <p className="font-mono text-muted-foreground text-xs [overflow-wrap:anywhere]">
                blob {evaluator.blobOid}
              </p>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground text-xs">
        Base commit {shortFactoryCommit(protocol.baseCommit)}. Open the protocol to launch a run.
      </p>
    </div>
  );
}
