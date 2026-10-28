import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type FactoryKnowledgeBrief,
  type FactoryKnowledgeTask,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSettingsScope } from "../settings/SettingsScopeContext";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { FactoryCheckoutChooser } from "./FactoryCheckoutChooser";
import { FactoryEmptyState } from "./FactoryEmptyState";
import { factoryTaskPresentation } from "./factoryIssues.logic";
import {
  EMPTY_KNOWLEDGE_DRAFT,
  KNOWLEDGE_LIMITS,
  factoryKnowledgeArtifactIssueMessage,
  factoryKnowledgeArtifactState,
  factoryKnowledgeFailureMessage,
  validateFactoryKnowledgeDraft,
  type FactoryKnowledgeDraft,
} from "./factoryKnowledge.logic";
import {
  FactoryLaunchFields,
  useFactoryLaunchDraft,
  useFactoryLaunchModelSettings,
} from "./FactoryLaunchControls";
import { FactoryReviewSnapshot } from "./FactoryReview";
import { singleFactoryMember } from "./factoryScope";

export function FactoryBriefsPage() {
  const { scope, groups, selectScope } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  const projects = useProjects();
  const readableIds = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const member = singleFactoryMember(scope);
  const environment = environments.find((entry) => entry.environmentId === member?.environmentId);
  const project = projects.find(
    (entry) => entry.environmentId === member?.environmentId && entry.id === member?.id,
  );
  const canRead = useEnvironmentScope(member?.environmentId ?? null, AuthOrchestrationReadScope);

  if (scope.kind === "unavailable") return null;
  if (!isReady) return <p role="status">Loading environments…</p>;

  const unavailable =
    !environment || !project
      ? { title: "Checkout unavailable", description: "Choose another checkout to manage briefs." }
      : environment.connection.phase !== "connected"
        ? {
            title: "Environment offline",
            description: `Reconnect ${environment.label} to read briefs.`,
          }
        : environment.serverConfig === null
          ? {
              title: "Server capabilities unknown",
              description: "Wait for this environment to finish connecting.",
            }
          : environment.serverConfig.environment.capabilities.factoryKnowledge !== true
            ? {
                title: "Knowledge briefs unsupported",
                description: `Update the server on ${environment.label} to use briefs.`,
              }
            : !canRead
              ? {
                  title: "Read access unavailable",
                  description: "This connection needs orchestration read access to list briefs.",
                }
              : null;

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="factory-briefs-title">
      <div className="space-y-1">
        <h2 id="factory-briefs-title" className="font-medium text-lg">
          Briefs
        </h2>
        <p className="text-muted-foreground text-sm">
          Write a knowledge brief, review its frozen revision and start a task in its own folder.
          Accept the resulting artifact after reviewing it against your criteria.
        </p>
      </div>
      {member === null ? (
        <FactoryCheckoutChooser
          scope={scope}
          groups={groups}
          environments={environments}
          intro="Choose an exact checkout to manage its briefs. Each task works in a separate folder."
          emptyDescription="Connect an environment and add a project to author briefs."
          statusFor={(owner) =>
            !owner
              ? "Environment unavailable"
              : owner.connection.phase !== "connected"
                ? "Offline. Reconnect to read briefs"
                : owner.serverConfig === null
                  ? "Server capabilities unknown"
                  : owner.serverConfig.environment.capabilities.factoryKnowledge !== true
                    ? "Knowledge briefs unsupported. Update this server"
                    : !readableIds.has(owner.environmentId)
                      ? "Read access unavailable"
                      : "Connected · briefs available"
          }
          onChoose={selectScope}
        />
      ) : unavailable !== null ? (
        <FactoryEmptyState icon={<FileTextIcon />} {...unavailable} />
      ) : environment && project ? (
        <FactoryBriefsWorkspace
          key={`${environment.environmentId}:${project.id}`}
          environmentId={environment.environmentId}
          project={project}
        />
      ) : null}
    </section>
  );
}

function KnowledgeFailure(props: { readonly message: string | null }) {
  return props.message === null ? null : (
    <Alert variant="error">
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
  );
}

function FactoryBriefsWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}) {
  const { environmentId, project } = props;
  const query = useEnvironmentQuery(
    factoryEnvironment.listKnowledgeBriefs({ environmentId, input: { projectId: project.id } }),
  );
  const canCreate = useAtomValue(
    factoryEnvironment.createKnowledgeBrief.permissionAtom(environmentId),
  );
  const canStart = useAtomValue(
    factoryEnvironment.startKnowledgeTask.permissionAtom(environmentId),
  );
  const [creating, setCreating] = useState(false);
  const [review, setReview] = useState<{ brief: FactoryKnowledgeBrief; restart: boolean } | null>(
    null,
  );
  const tasks = new Map(query.data?.tasks.map((task) => [task.briefId, task]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!canCreate || creating} onClick={() => setCreating(true)}>
          New brief
        </Button>
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          Refresh briefs
        </Button>
      </div>
      {!canCreate || !canStart ? (
        <p className="text-muted-foreground text-xs">
          Creating briefs and starting tasks need operate permission on this environment.
        </p>
      ) : null}
      {creating ? (
        <KnowledgeBriefForm
          environmentId={environmentId}
          projectId={project.id}
          canCreate={canCreate}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            query.refresh();
          }}
        />
      ) : null}
      <KnowledgeFailure
        message={
          query.error === null ? null : factoryKnowledgeFailureMessage(query.failure, query.error)
        }
      />
      {query.isPending ? <p role="status">Loading briefs…</p> : null}
      {query.error === null && query.data?.briefs.length === 0 ? (
        <p>No briefs yet. Create a brief to begin.</p>
      ) : null}
      <ul className="space-y-3" aria-label="Knowledge briefs">
        {query.data?.briefs.map((brief) => (
          <KnowledgeBriefRow
            key={brief.id}
            environmentId={environmentId}
            projectId={project.id}
            brief={brief}
            task={tasks.get(brief.id) ?? null}
            canStart={canStart && query.error === null && !query.isPending}
            onReview={(restart) => setReview({ brief, restart })}
          />
        ))}
      </ul>
      {review !== null ? (
        <KnowledgeStartDialog
          environmentId={environmentId}
          project={project}
          brief={review.brief}
          restart={review.restart}
          canStart={canStart}
          onClose={() => setReview(null)}
          onStarted={() => {
            setReview(null);
            query.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function KnowledgeBriefForm(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canCreate: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<FactoryKnowledgeDraft>(EMPTY_KNOWLEDGE_DRAFT);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const runCreate = useAtomCommand(factoryEnvironment.createKnowledgeBrief, {
    label: "factory create knowledge brief",
    reportFailure: false,
  });
  const update = (
    field: "title" | "question" | "deliverablePath" | "acceptanceCriteria",
    value: string,
  ) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };
  const updateInput = (index: number, field: "label" | "content", value: string) => {
    setDraft((previous) => ({
      ...previous,
      inputs: previous.inputs.map((input, position) =>
        position === index ? { ...input, [field]: value } : input,
      ),
    }));
  };
  const submit = async () => {
    if (!props.canCreate || inFlight.current) return;
    const invalid = validateFactoryKnowledgeDraft(draft);
    if (invalid !== null) {
      setFailure(invalid);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    const result = await runCreate({
      environmentId: props.environmentId,
      input: {
        ...draft,
        title: draft.title.trim(),
        deliverablePath: draft.deliverablePath.trim(),
        inputs: draft.inputs.map((input) => ({ ...input, label: input.label.trim() })),
        commandId: CommandId.make(randomUUID()),
        projectId: props.projectId,
      },
    }).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
    if (result._tag === "Success") props.onCreated();
    else if (!isAtomCommandInterrupted(result))
      setFailure(factoryKnowledgeFailureMessage(squashAtomCommandFailure(result)));
  };

  return (
    <form
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="font-medium">New brief</h3>
      <p className="text-muted-foreground text-sm">
        Creating saves an immutable revision. Review it before starting a task.
      </p>
      <fieldset className="min-w-0 space-y-4" disabled={pending || !props.canCreate}>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-title`}>Title</Label>
          <Input
            id={`${id}-title`}
            value={draft.title}
            maxLength={KNOWLEDGE_LIMITS.title}
            required
            onChange={(event) => update("title", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-question`}>Question</Label>
          <Textarea
            id={`${id}-question`}
            value={draft.question}
            maxLength={KNOWLEDGE_LIMITS.question}
            onChange={(event) => update("question", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-path`}>Deliverable path</Label>
          <Input
            id={`${id}-path`}
            value={draft.deliverablePath}
            required
            font="mono"
            aria-describedby={`${id}-path-help`}
            onChange={(event) => update("deliverablePath", event.target.value)}
          />
          <p id={`${id}-path-help`} className="text-muted-foreground text-xs">
            A relative file path inside the task folder, without parent traversal or a .git
            directory.
          </p>
        </div>
        <div className="space-y-3">
          <h4 className="font-medium text-sm">
            Inputs ({draft.inputs.length}/{KNOWLEDGE_LIMITS.inputs})
          </h4>
          {draft.inputs.map((input, index) => (
            <fieldset key={index} className="min-w-0 space-y-2 rounded-lg border p-3">
              <legend className="text-sm">Input {index + 1}</legend>
              <Label htmlFor={`${id}-input-${index}-label`}>Label</Label>
              <Input
                id={`${id}-input-${index}-label`}
                value={input.label}
                required
                maxLength={KNOWLEDGE_LIMITS.inputLabel}
                onChange={(event) => updateInput(index, "label", event.target.value)}
              />
              <Label htmlFor={`${id}-input-${index}-content`}>Pasted content</Label>
              <Textarea
                id={`${id}-input-${index}-content`}
                value={input.content}
                maxLength={KNOWLEDGE_LIMITS.inputContent}
                onChange={(event) => updateInput(index, "content", event.target.value)}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-label={`Remove input ${index + 1}`}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    inputs: previous.inputs.filter((_, position) => position !== index),
                  }))
                }
              >
                Remove input
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.inputs.length >= KNOWLEDGE_LIMITS.inputs}
            onClick={() =>
              setDraft((previous) => ({
                ...previous,
                inputs: [...previous.inputs, { label: "", content: "" }],
              }))
            }
          >
            Add input
          </Button>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-criteria`}>Acceptance criteria</Label>
          <Textarea
            id={`${id}-criteria`}
            value={draft.acceptanceCriteria}
            maxLength={KNOWLEDGE_LIMITS.acceptanceCriteria}
            onChange={(event) => update("acceptanceCriteria", event.target.value)}
          />
        </div>
      </fieldset>
      <KnowledgeFailure message={failure} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || !props.canCreate} aria-busy={pending}>
          {pending ? "Creating…" : "Create brief"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={props.onClose}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function KnowledgeStartDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly brief: FactoryKnowledgeBrief;
  readonly restart: boolean;
  readonly canStart: boolean;
  readonly onClose: () => void;
  readonly onStarted: () => void;
}) {
  const settings = useFactoryLaunchModelSettings(props.environmentId, props.project);
  const draft = useFactoryLaunchDraft(settings);
  const id = useId();
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const runStart = useAtomCommand(factoryEnvironment.startKnowledgeTask, {
    label: "factory start knowledge task",
    reportFailure: false,
  });
  const { brief } = props;
  const enabled =
    props.canStart &&
    !pending &&
    failure === null &&
    draft.selection !== null &&
    instructions.length <= KNOWLEDGE_LIMITS.instructions;
  const submit = async () => {
    if (!enabled || draft.selection === null || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    const result = await runStart({
      environmentId: props.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        projectId: props.project.id,
        briefId: brief.id,
        expectedRevision: brief.revision,
        modelSelection: draft.selection,
        instructions,
        ...(props.restart ? { restartDeleted: true } : {}),
      },
    }).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
    if (result._tag === "Success") props.onStarted();
    else if (!isAtomCommandInterrupted(result))
      setFailure(factoryKnowledgeFailureMessage(squashAtomCommandFailure(result)));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.restart ? "Review new attempt" : "Review brief"}</DialogTitle>
          <DialogDescription>
            {props.restart ? "The previous thread was deleted. " : ""}
            Confirm this frozen revision to start a task in a separate folder outside the checkout.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || failure !== null} className="min-w-0 space-y-4">
            <p className="text-muted-foreground text-xs">
              Project {props.project.title} · revision <code>{brief.revision.slice(0, 7)}</code>
            </p>
            <FactoryReviewSnapshot
              heading="Frozen brief"
              intro="Review the complete brief before admitting it."
              fields={[
                { label: "Title", text: brief.title, emptyNote: "No title." },
                { label: "Question", text: brief.question, emptyNote: "No question supplied." },
                {
                  label: "Deliverable path",
                  text: brief.deliverablePath,
                  emptyNote: "No path supplied.",
                },
                ...brief.inputs.flatMap((input, index) => [
                  { label: `Input ${index + 1} label`, text: input.label, emptyNote: "No label." },
                  {
                    label: `Input ${index + 1} content`,
                    text: input.content,
                    emptyNote: "Empty input.",
                  },
                ]),
                {
                  label: "Acceptance criteria",
                  text: brief.acceptanceCriteria,
                  emptyNote: "No acceptance criteria supplied.",
                },
              ]}
            />
            <FactoryLaunchFields
              environmentId={props.environmentId}
              disabled={pending || failure !== null}
              draft={draft}
              untrustedText="Brief text"
              showBaseRef={false}
            />
            <div className="space-y-1.5">
              <Label htmlFor={id}>Instructions (optional)</Label>
              <Textarea
                id={id}
                value={instructions}
                maxLength={KNOWLEDGE_LIMITS.instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </div>
          </fieldset>
          <KnowledgeFailure message={failure} />
          {failure !== null ? (
            <p className="text-muted-foreground text-xs">
              Close this dialog, refresh and review before trying again.
            </p>
          ) : null}
          {!props.canStart ? <p role="status">Starting a task needs operate permission.</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!enabled} aria-busy={pending} onClick={() => void submit()}>
            {pending ? "Starting…" : "Admit and start"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function KnowledgeBriefRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly brief: FactoryKnowledgeBrief;
  readonly task: FactoryKnowledgeTask | null;
  readonly canStart: boolean;
  readonly onReview: (restart: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { brief, task } = props;
  const status = task === null ? null : factoryTaskPresentation(task.status);
  return (
    <li className="min-w-0 space-y-3 rounded-lg border p-4">
      <h3 className="font-medium [overflow-wrap:anywhere]">{brief.title}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">
          Revision <code>{brief.revision.slice(0, 7)}</code>
        </span>
        {status !== null ? (
          <Badge variant={status.variant}>{status.label}</Badge>
        ) : (
          <Badge variant="secondary">Not started</Badge>
        )}
        {brief.supersededBy !== null ? <Badge variant="outline">Superseded</Badge> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {(task === null || task.status === "missing") && brief.supersededBy === null ? (
          <Button
            size="sm"
            disabled={!props.canStart}
            onClick={() => props.onReview(task !== null)}
          >
            {task === null ? "Start task" : "Start new attempt"}
          </Button>
        ) : null}
        {task !== null && task.status !== "missing" ? (
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(scopeThreadRef(props.environmentId, task.threadId))}
              />
            }
          >
            Open thread
          </Button>
        ) : null}
        {task !== null ? (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide artifact" : "Review artifact"}
          </Button>
        ) : null}
      </div>
      {expanded && task !== null ? (
        <KnowledgeArtifact
          environmentId={props.environmentId}
          projectId={props.projectId}
          briefId={brief.id}
        />
      ) : null}
    </li>
  );
}

function KnowledgeArtifact(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly briefId: string;
}) {
  const { environmentId, projectId, briefId } = props;
  const query = useEnvironmentQuery(
    factoryEnvironment.readKnowledgeTask({ environmentId, input: { projectId, briefId } }),
  );
  const canAccept = useAtomValue(
    factoryEnvironment.acceptKnowledgeArtifact.permissionAtom(environmentId),
  );
  const runAccept = useAtomCommand(factoryEnvironment.acceptKnowledgeArtifact, {
    label: "factory accept knowledge artifact",
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const id = useId();
  const data = query.data;
  const artifact = data?.artifact ?? null;
  const acceptance = data?.acceptance ?? null;
  const artifactIssueMessage =
    data === null
      ? null
      : factoryKnowledgeArtifactIssueMessage(data.artifactIssue, data.brief.deliverablePath);
  const state = factoryKnowledgeArtifactState(
    query.error === null && !query.isPending ? data : null,
  );
  const readFailure =
    query.error === null ? null : factoryKnowledgeFailureMessage(query.failure, query.error);
  const disabledReason = !canAccept
    ? "Accepting an artifact needs operate permission on this environment."
    : readFailure !== null
      ? readFailure
      : query.isPending || data === null
        ? "Reading the artifact…"
        : data.task?.folderPath == null
          ? "The task folder is unavailable. Restore it and refresh before accepting."
          : artifactIssueMessage !== null
            ? artifactIssueMessage
            : artifact === null
              ? "No artifact yet"
              : failure !== null
                ? "Refresh and review the artifact before accepting again."
                : null;
  const accept = async () => {
    if (inFlight.current || disabledReason !== null || artifact === null || state === "current")
      return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    const result = await runAccept({
      environmentId,
      input: {
        projectId,
        briefId,
        // Only the observed digest is submitted; the server rejects concurrent file changes.
        expectedSha256: artifact.sha256,
        ...(state === "changed" ? { supersede: true } : {}),
      },
    }).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
    if (result._tag === "Success") query.refresh();
    else if (!isAtomCommandInterrupted(result))
      setFailure(factoryKnowledgeFailureMessage(squashAtomCommandFailure(result)));
  };

  return (
    <section
      className="space-y-3"
      aria-label="Task artifact"
      aria-busy={pending || query.isPending}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium text-sm">Artifact</h4>
        <Button
          size="xs"
          variant="outline"
          disabled={pending || query.isPending}
          onClick={() => {
            setFailure(null);
            query.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {data !== null ? (
        <FactoryReviewSnapshot
          heading="Acceptance criteria for this brief"
          intro="Compare the artifact with the frozen question and criteria."
          fields={[
            { label: "Question", text: data.brief.question, emptyNote: "No question supplied." },
            {
              label: "Acceptance criteria",
              text: data.brief.acceptanceCriteria,
              emptyNote: "No acceptance criteria supplied.",
            },
          ]}
        />
      ) : null}
      {artifact !== null ? (
        <>
          <p className="text-sm [overflow-wrap:anywhere]">
            <code>{artifact.path}</code> · SHA-256 <code>{artifact.sha256.slice(0, 7)}</code> ·{" "}
            {artifact.bytes.toLocaleString()} bytes
          </p>
          {artifact.preview === null ? (
            <p className="text-muted-foreground text-xs">
              Text preview unavailable. Review the file in the task folder before accepting.
            </p>
          ) : (
            <pre
              tabIndex={0}
              aria-label="Artifact preview"
              className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border p-3 text-sm [overflow-wrap:anywhere]"
            >
              {artifact.preview}
            </pre>
          )}
          <p className="text-muted-foreground text-xs">
            The preview contains at most 256 KiB. Acceptance records the digest of the whole file;
            it does not establish that the contents are true.
          </p>
        </>
      ) : null}
      {artifactIssueMessage !== null &&
      artifactIssueMessage !== disabledReason &&
      readFailure === null &&
      !query.isPending ? (
        <p>{artifactIssueMessage}</p>
      ) : null}
      {acceptance !== null ? (
        <p className="text-muted-foreground text-xs">
          Accepted artifact <code>{acceptance.sha256.slice(0, 7)}</code> ·{" "}
          <time dateTime={acceptance.acceptedAt}>
            {new Date(acceptance.acceptedAt).toLocaleString()}
          </time>
        </p>
      ) : null}
      {state === "current" ? (
        <p className="text-sm">Acceptance matches the observed artifact.</p>
      ) : null}
      {state === "changed" ? (
        <Alert variant="warning">
          <AlertDescription>Artifact changed since acceptance</AlertDescription>
        </Alert>
      ) : null}
      {state === "unverifiable" && acceptance !== null ? (
        <Alert variant="warning">
          <AlertDescription>
            The accepted artifact cannot currently be compared with the file. Restore access and
            refresh.
          </AlertDescription>
        </Alert>
      ) : null}
      <KnowledgeFailure message={failure ?? readFailure} />
      {state !== "current" && data !== null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending || disabledReason !== null}
          aria-busy={pending}
          aria-describedby={disabledReason === null ? undefined : id}
          onClick={() => void accept()}
        >
          {pending ? "Accepting…" : acceptance !== null ? "Re-accept" : "Accept this artifact"}
        </Button>
      ) : null}
      {disabledReason !== null ? (
        <p id={id} role="status" className="text-muted-foreground text-xs">
          {disabledReason}
        </p>
      ) : null}
    </section>
  );
}
