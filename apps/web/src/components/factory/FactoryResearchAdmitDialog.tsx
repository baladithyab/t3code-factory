import {
  FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS,
  type EnvironmentId,
  type FactoryRepository,
  type FactoryResearchFinding,
  type FactoryResearchProtocol,
  type ModelSelection,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
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
  factoryFindingPresentation,
  factoryFindingReviewJson,
  isFactoryResearchSubmitEnabled,
  shortFactoryCommit,
  type FactoryResearchFailure,
} from "./factoryResearch.logic";
import {
  FactoryLaunchFields,
  useFactoryLaunchDraft,
  type FactoryLaunchModelSettings,
} from "./FactoryLaunchControls";
import { FactoryReviewFailure, FactoryReviewSnapshot } from "./FactoryReview";

/**
 * Pins one reviewed finding revision. The `protocol` and `finding` it was opened with are the only
 * things it ever submits, so admitting is approval of exactly the evidence read here.
 */
export function FactoryResearchAdmitDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly protocol: FactoryResearchProtocol;
  readonly finding: FactoryResearchFinding;
  readonly projectTitle: string;
  readonly repository: FactoryRepository;
  readonly settings: FactoryLaunchModelSettings;
  readonly canAdmit: boolean;
  /** The previous implementation thread was deleted; confirming starts a new attempt. */
  readonly restart: boolean;
  readonly pending: boolean;
  readonly failure: FactoryResearchFailure | null;
  readonly onClose: () => void;
  readonly onSubmit: (options: {
    readonly modelSelection: ModelSelection;
    readonly instructions: string;
  }) => void;
}) {
  const { protocol, finding, pending } = props;
  const draft = useFactoryLaunchDraft(props.settings);
  const instructionsId = useId();
  const [instructions, setInstructions] = useState("");
  const changed = props.failure?.kind === "changed";
  const count = countFactoryFeedText(instructions, FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS);
  const { selection } = draft;
  const enabled = isFactoryResearchSubmitEnabled({
    allowed: props.canAdmit,
    pending,
    changed,
    selection,
    instructions,
  });
  const presentation = factoryFindingPresentation(finding, protocol.metric);

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
            {props.restart ? "Start a new attempt" : "Admit implementation"}
          </DialogTitle>
          <DialogDescription>
            {props.restart
              ? "The previous implementation's thread was deleted. Confirming creates a new isolated worktree and a new attempt on the selected commit. This approval is the record: it names this finding revision and your instructions."
              : "Creates an implementation task in its own isolated worktree on the selected commit and sends the reviewed finding to the selected agent. This approval is the record: it names this finding revision and your instructions."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || changed} className="min-w-0 space-y-4">
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                {`${props.repository.host}/${props.repository.repository}`} · task project{" "}
                {props.projectTitle}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={presentation.variant}>{presentation.statusLabel}</Badge>
                <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                  Finding revision {shortFactoryCommit(finding.revision)} · commit{" "}
                  {finding.selectedCommit === null
                    ? "not selected"
                    : shortFactoryCommit(finding.selectedCommit)}
                </span>
              </div>
            </div>
            <FactoryReviewSnapshot
              heading="Full protocol and finding"
              intro="Review the complete evidence this admission approves."
              fields={[
                {
                  label: "Protocol and finding (JSON)",
                  text: factoryFindingReviewJson(protocol, finding),
                  emptyNote: "The finding is empty.",
                },
              ]}
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
                placeholder="Requirements for the implementation in your own words"
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="flex items-start justify-between gap-3">
                <p id={`${instructionsId}-help`} className="text-muted-foreground text-xs">
                  Your own requirements, frozen into the task and sent apart from the finding, which
                  stays untrusted.
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
              untrustedText="The finding"
              showBaseRef={false}
            />
            <Alert variant="info">
              <AlertDescription>
                A supported finding is evidence, not a decision. Nothing starts until you admit it,
                and admitting does not publish, merge or release anything.
              </AlertDescription>
            </Alert>
          </fieldset>
        </DialogPanel>
        {props.failure ? (
          <FactoryReviewFailure
            failure={props.failure}
            changed={changed}
            staleHint="This finding is no longer current. Close this dialog and review the current finding before admitting work."
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
            {pending ? "Starting…" : props.restart ? "Start new attempt" : "Admit and start"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
