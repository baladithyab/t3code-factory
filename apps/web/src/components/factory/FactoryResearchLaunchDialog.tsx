import {
  FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS,
  type EnvironmentId,
  type FactoryRepository,
  type FactoryResearchProtocol,
  type FactoryResearchRunLaunchInput,
  type ModelSelection,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
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
  isFactoryResearchSubmitEnabled,
  type FactoryResearchFailure,
} from "./factoryResearch.logic";
import {
  FactoryLaunchFields,
  useFactoryLaunchDraft,
  type FactoryLaunchModelSettings,
} from "./FactoryLaunchControls";
import {
  FactoryReviewFailure,
  FactoryReviewSnapshot,
  type FactoryReviewField,
} from "./FactoryReview";

/** The sealed protocol in full, so what a run is launched under is exactly what the server holds. */
function factoryProtocolReviewFields(
  protocol: FactoryResearchProtocol,
): ReadonlyArray<FactoryReviewField> {
  const { metric, budget } = protocol;
  return [
    { label: "Hypothesis", text: protocol.hypothesis, emptyNote: "The hypothesis is empty." },
    { label: "Run command", text: protocol.runCommand, emptyNote: "The run command is empty." },
    {
      label: "Evaluators (path, blob)",
      text: protocol.evaluators.map(({ path, blobOid }) => `${path}  ${blobOid}`).join("\n"),
      emptyNote: "No evaluators were sealed.",
    },
    {
      label: "Metric",
      text: `${metric.name}\nline prefix: ${metric.linePrefix}\n${
        metric.direction === "lower" ? "lower is better" : "higher is better"
      }\nminimum effect: ${metric.minimumEffect === null ? "none declared" : String(metric.minimumEffect)}`,
      emptyNote: "The metric is empty.",
    },
    {
      label: "Budget",
      text: `${budget.maxRuns} runs\n${budget.maxRunMinutes} minutes per run\nwindow closes ${budget.expiresAt}`,
      emptyNote: "The budget is empty.",
    },
    { label: "Base commit", text: protocol.baseCommit, emptyNote: "The base commit is empty." },
  ];
}

/**
 * Pins one reviewed protocol revision. The `protocol` it was opened with is the only thing it ever
 * submits; a refreshed page can never change what is confirmed here.
 */
export function FactoryResearchLaunchDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly role: FactoryResearchRunLaunchInput["role"];
  readonly protocol: FactoryResearchProtocol;
  /** The candidate commit a verification is pinned to; null for an explore run. */
  readonly targetCommit: string | null;
  readonly projectTitle: string;
  readonly repository: FactoryRepository;
  readonly settings: FactoryLaunchModelSettings;
  readonly canLaunch: boolean;
  readonly pending: boolean;
  readonly failure: FactoryResearchFailure | null;
  readonly onClose: () => void;
  readonly onSubmit: (options: {
    readonly modelSelection: ModelSelection;
    readonly instructions: string;
  }) => void;
}) {
  const { role, protocol, pending } = props;
  const draft = useFactoryLaunchDraft(props.settings);
  const instructionsId = useId();
  const [instructions, setInstructions] = useState("");
  const changed = props.failure?.kind === "changed";
  const count = countFactoryFeedText(instructions, FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS);
  const { selection } = draft;
  const enabled = isFactoryResearchSubmitEnabled({
    allowed: props.canLaunch,
    pending,
    changed,
    selection,
    instructions,
  });
  const verify = role === "verify";
  const fields: ReadonlyArray<FactoryReviewField> = [
    ...factoryProtocolReviewFields(protocol),
    ...(verify && props.targetCommit !== null
      ? [
          {
            label: "Candidate commit under test",
            text: props.targetCommit,
            emptyNote: "The candidate commit is empty.",
          },
        ]
      : []),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{verify ? "Launch verification run" : "Launch explore run"}</DialogTitle>
          <DialogDescription>
            {verify
              ? "Starts a separate thread in its own isolated worktree, pinned to the candidate commit. It must measure the same metric under the same protocol and record its own evidence."
              : "Starts a thread in its own isolated worktree at the sealed base commit. The run records its own evidence; the server reads the lines it cites."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || changed} className="min-w-0 space-y-4">
            <div className="space-y-0.5">
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                {`${props.repository.host}/${props.repository.repository}`} · task project{" "}
                {props.projectTitle}
              </p>
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                Protocol revision {protocol.revision}
              </p>
            </div>
            <FactoryReviewSnapshot
              heading="Sealed protocol"
              intro="Review the full protocol this run is launched under."
              fields={fields}
            />
            <div className="space-y-1.5">
              <Label htmlFor={instructionsId}>
                Instructions <span className="font-normal text-muted-foreground">optional</span>
              </Label>
              <Textarea
                id={instructionsId}
                value={instructions}
                aria-invalid={count.overLimit}
                aria-describedby={`${instructionsId}-help`}
                placeholder="Guidance for this run in your own words"
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="flex items-start justify-between gap-3">
                <p id={`${instructionsId}-help`} className="text-muted-foreground text-xs">
                  Your own guidance, frozen into the run and sent apart from the sealed protocol. It
                  cannot change the protocol.
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
            <FactoryLaunchFields
              environmentId={props.environmentId}
              disabled={pending || changed}
              draft={draft}
              untrustedText="Run output"
              showBaseRef={false}
            />
            {verify ? (
              <Alert variant="info">
                <AlertDescription>
                  Verification is launched here, by you, never by an agent. A verification launched
                  by the thread that produced the result is refused as not independent.
                </AlertDescription>
              </Alert>
            ) : null}
          </fieldset>
        </DialogPanel>
        {props.failure ? (
          <FactoryReviewFailure
            failure={props.failure}
            changed={changed}
            staleHint="This protocol is no longer current. Close this dialog and review the protocol again before launching."
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
              if (!enabled || selection === null) return;
              props.onSubmit({ modelSelection: selection, instructions });
            }}
          >
            {pending ? "Starting…" : verify ? "Launch verification" : "Launch explore run"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
