import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  FactoryAcceptanceError,
  type EnvironmentId,
  type FactoryIssue,
  type FactoryIssueTask,
  type FactoryReadinessOverrideId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, CircleDotIcon } from "lucide-react";
import { Fragment, useContext, useEffect, useId, useRef, useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { randomUUID } from "../../lib/utils";
import { factoryEnvironment, useFactoryReadinessSupported } from "../../state/factory";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { FactoryClaimIndicators } from "./FactoryClaimIndicators";
import { FactoryDeliveryPanel } from "./FactoryDeliveryPanel";
import { factoryClaimRowPresentation, originKeyForIssue } from "./factoryClaims.logic";
import {
  FACTORY_OVERRIDE_ACTIONS,
  boundedIssueBody,
  buildFactoryReadinessOverrideInput,
  describeFactoryFailure,
  factoryReadinessPresentation,
  factoryTaskPresentation,
  resolveFactoryIssueAction,
  safeExternalUrl,
  type FactoryFailure,
  type FactoryReadinessEdgeRow,
  type FactoryReadinessOverrideAction,
  type FactoryReadinessTone,
} from "./factoryIssues.logic";
import { groupFactoryIssuesByStage, type FactoryIssueViewMode } from "./factoryIssues.views";
import { FactoryIssueFrontier } from "./FactoryIssueFrontier";
import { FactoryReadinessOverrideDialog } from "./FactoryReadinessOverrideDialog";
import type { FactoryClaimsView } from "./useFactoryClaims";

const MAX_VISIBLE_LABELS = 5;

type FactoryIssueWorkViewProps = {
  readonly environmentId: EnvironmentId;
  readonly mode: FactoryIssueViewMode;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly canStart: boolean;
  readonly busy: boolean;
  readonly startingIssue: number | null;
  readonly selectedProjectId: ProjectId;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
  readonly refreshing: boolean;
  /** Null when the environment does not advertise claims, which shows no claim UI at all. */
  readonly claims: FactoryClaimsView | null;
  readonly repositoryKey: string;
  readonly onStart: (issue: FactoryIssue) => void;
  readonly onRestart: (issue: FactoryIssue) => void;
  readonly onResume: (issue: FactoryIssue) => void;
  readonly onOpen: (task: FactoryIssueTask) => void;
};

export function FactoryIssueWorkView(props: FactoryIssueWorkViewProps) {
  // The parent keys this component by repository and page, but not presentation mode.
  const [expandedIssues, setExpandedIssues] = useState<ReadonlySet<number>>(() => new Set());
  const readinessSupported = useFactoryReadinessSupported(props.environmentId);
  const acceptanceSupported = useAtomValue(
    environmentPresentations.presentationAtom(props.environmentId),
    (presentation) =>
      presentation?.serverConfig?.environment.capabilities.factoryAcceptance === true,
  );
  const deliverySupported = useAtomValue(
    environmentPresentations.presentationAtom(props.environmentId),
    (presentation) => presentation?.serverConfig?.environment.capabilities.factoryDelivery === true,
  );

  const renderIssue = (issue: FactoryIssue) => (
    <FactoryIssueEntry
      key={issue.number}
      mode={props.mode}
      environmentId={props.environmentId}
      claims={props.claims}
      repositoryKey={props.repositoryKey}
      readinessSupported={readinessSupported}
      acceptanceSupported={acceptanceSupported}
      deliverySupported={deliverySupported}
      issue={issue}
      canStart={props.canStart}
      busy={props.busy}
      startingIssue={props.startingIssue}
      selectedProjectId={props.selectedProjectId}
      projectTitleById={props.projectTitleById}
      onStart={props.onStart}
      onRestart={props.onRestart}
      onResume={props.onResume}
      onOpen={props.onOpen}
      expanded={expandedIssues.has(issue.number)}
      onToggleDetails={() => {
        setExpandedIssues((current) => {
          const next = new Set(current);
          if (next.has(issue.number)) next.delete(issue.number);
          else next.add(issue.number);
          return next;
        });
      }}
    />
  );

  return (
    <div
      className="min-w-0 max-w-full data-[refreshing=true]:opacity-70"
      data-refreshing={props.refreshing}
      aria-busy={props.refreshing}
    >
      {props.mode === "table" ? (
        <div
          className="max-w-full overflow-x-auto rounded-lg border border-border/60 focus-visible:outline-2 focus-visible:outline-ring"
          role="region"
          aria-label="Issues table, this page only"
          tabIndex={0}
        >
          <table className="w-full min-w-5xl text-left text-sm">
            <caption className="sr-only">Issues on this page</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="p-3 font-medium">
                  Issue
                </th>
                <th scope="col" className="p-3 font-medium">
                  Source state
                </th>
                <th scope="col" className="p-3 font-medium">
                  Task state
                </th>
                <th scope="col" className="p-3 font-medium">
                  Labels
                </th>
                <th scope="col" className="p-3 font-medium">
                  Updated
                </th>
                <th scope="col" className="p-3 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>{props.issues.map(renderIssue)}</tbody>
          </table>
        </div>
      ) : props.mode === "board" ? (
        <div
          className="flex max-w-full items-start gap-3 overflow-x-auto pb-2 focus-visible:outline-2 focus-visible:outline-ring"
          role="region"
          aria-label="Task stages, this page only"
          tabIndex={0}
        >
          {groupFactoryIssuesByStage(props.issues).map((group) => {
            if (group.issues.length === 0) return null;
            const label =
              group.stage === "none" ? "No task" : factoryTaskPresentation(group.stage).label;
            return (
              <section key={group.stage} className="w-80 shrink-0 space-y-2" aria-label={label}>
                <h3 className="flex items-center justify-between gap-2 px-1 text-sm font-medium">
                  <span>{label}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {group.issues.length} on this page
                  </span>
                </h3>
                <ul className="flex flex-col gap-2">{group.issues.map(renderIssue)}</ul>
              </section>
            );
          })}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">{props.issues.map(renderIssue)}</ul>
      )}
    </div>
  );
}

function FactoryIssueEntry(
  props: Omit<FactoryIssueWorkViewProps, "issues" | "refreshing"> & {
    readonly issue: FactoryIssue;
    readonly expanded: boolean;
    readonly readinessSupported: boolean;
    readonly acceptanceSupported: boolean;
    readonly deliverySupported: boolean;
    readonly onToggleDetails: () => void;
  },
) {
  const { issue, expanded } = props;
  const detailsId = useId();
  const action = resolveFactoryIssueAction(issue);
  const presentation = issue.task ? factoryTaskPresentation(issue.task.status) : null;
  const ownerTitle =
    issue.task && issue.task.projectId !== props.selectedProjectId
      ? (props.projectTitleById.get(issue.task.projectId) ?? "another project")
      : null;
  const href = safeExternalUrl(issue.url);
  const body = expanded ? boundedIssueBody(issue.body) : null;
  const startDisabled = !props.canStart || props.busy;
  const starting = props.startingIssue === issue.number;

  const identity = (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="font-medium text-sm [overflow-wrap:anywhere]">{issue.title}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-muted-foreground text-xs underline-offset-4 hover:underline"
        >
          #{issue.number}
        </a>
      ) : (
        <span className="shrink-0 text-muted-foreground text-xs">#{issue.number}</span>
      )}
    </div>
  );
  const sourceState = (
    <Badge variant={issue.state === "open" ? "outline" : "secondary"}>
      <CircleDotIcon />
      {issue.state === "open" ? "Open" : "Closed"}
    </Badge>
  );
  const updated = (
    <span className="text-muted-foreground text-xs">
      <RelativeTime timestamp={issue.updatedAt} />
    </span>
  );
  const labels =
    issue.labels.length > 0 ? (
      <div className="flex flex-wrap gap-1">
        {issue.labels.slice(0, MAX_VISIBLE_LABELS).map((label) => (
          <Badge key={label} variant="outline" size="sm">
            <span className="max-w-40 truncate">{label}</span>
          </Badge>
        ))}
        {issue.labels.length > MAX_VISIBLE_LABELS ? (
          <Badge variant="outline" size="sm">
            +{issue.labels.length - MAX_VISIBLE_LABELS}
          </Badge>
        ) : null}
      </div>
    ) : null;
  const taskState = presentation ? (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={presentation.variant}>{presentation.label}</Badge>
      <span className="text-muted-foreground text-xs">{presentation.detail}</span>
      {ownerTitle ? (
        <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
          Task lives in project {ownerTitle}.
        </span>
      ) : null}
    </div>
  ) : (
    <Badge variant="outline">No task</Badge>
  );
  const claimPresentation =
    props.claims === null
      ? null
      : factoryClaimRowPresentation({
          claimsByEnvironment: props.claims.claimsByEnvironment,
          conflicts: props.claims.conflicts,
          environmentId: props.environmentId,
          originKey: originKeyForIssue(props.repositoryKey, issue.number),
          task: issue.task,
          labelOf: props.claims.labelOf,
        });
  const taskStatus = (
    <>
      {taskState}
      {claimPresentation !== null ? (
        <FactoryClaimIndicators presentation={claimPresentation} />
      ) : null}
      {issue.task?.threadId && props.acceptanceSupported ? (
        <FactoryAcceptedCommit
          key={`${props.environmentId}:${issue.task.projectId}:${issue.task.threadId}`}
          environmentId={props.environmentId}
          projectId={issue.task.projectId}
          threadId={issue.task.threadId}
          deliverySupported={props.deliverySupported}
          issueTitle={issue.title}
          issueUrl={issue.url}
        />
      ) : null}
    </>
  );
  const actions = (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-label={`${expanded ? "Hide" : "Show"} issue #${issue.number} body`}
          onClick={props.onToggleDetails}
        >
          <ChevronDownIcon className={expanded ? "rotate-180" : undefined} />
          Details
        </Button>
        {action.kind === "start" ? (
          <Button size="sm" disabled={startDisabled} onClick={() => props.onStart(issue)}>
            Start task
          </Button>
        ) : action.kind === "resume" ? (
          <Button
            size="sm"
            disabled={startDisabled}
            aria-busy={starting}
            onClick={() => props.onResume(issue)}
          >
            {starting ? "Resuming…" : "Resume launch"}
          </Button>
        ) : action.kind === "restart" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={startDisabled}
            onClick={() => props.onRestart(issue)}
          >
            New attempt…
          </Button>
        ) : action.kind === "open" ? (
          <Button size="sm" variant="outline" onClick={() => props.onOpen(action.task)}>
            Open thread
          </Button>
        ) : null}
      </div>
      {action.kind === "unavailable" ? (
        <p className="text-muted-foreground text-xs">{action.reason}</p>
      ) : null}
    </div>
  );
  const details = body ? (
    <div id={detailsId} className="min-w-0 border-border/60 border-t pt-3">
      {body.text.length === 0 ? (
        <p className="text-muted-foreground text-sm">This issue has no description.</p>
      ) : (
        <>
          {/* Remote issue content stays bounded plain text, never markup, links or media. */}
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">
            {body.text}
          </pre>
          {body.truncated ? (
            <p className="mt-2 text-muted-foreground text-xs">
              Showing the first part of the description. Open the issue on GitHub to read the rest.
            </p>
          ) : null}
        </>
      )}
      {issue.state === "open" && props.readinessSupported ? (
        <>
          <FactoryIssueBlockers
            environmentId={props.environmentId}
            projectId={props.selectedProjectId}
            issueNumber={issue.number}
          />
          <FactoryIssueFrontier
            environmentId={props.environmentId}
            projectId={props.selectedProjectId}
            issueNumber={issue.number}
          />
        </>
      ) : null}
    </div>
  ) : null;

  if (props.mode === "table") {
    return (
      <Fragment>
        <tr className="border-b border-border/60 align-top">
          <th scope="row" className="min-w-56 max-w-72 p-3 text-left font-normal">
            {identity}
          </th>
          <td className="p-3">{sourceState}</td>
          <td className="min-w-56 max-w-72 p-3">
            <div className="space-y-1.5">{taskStatus}</div>
          </td>
          <td className="min-w-40 max-w-56 p-3">{labels}</td>
          <td className="whitespace-nowrap p-3">{updated}</td>
          <td className="min-w-56 p-3">{actions}</td>
        </tr>
        {details ? (
          <tr className="border-b border-border/60">
            <td colSpan={6} className="p-3">
              {details}
            </td>
          </tr>
        ) : null}
      </Fragment>
    );
  }

  return (
    <li className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
      <div className={props.mode === "board" ? "space-y-3" : "flex flex-wrap items-start gap-3"}>
        <div className="min-w-0 flex-1 basis-48 space-y-1.5">
          {identity}
          <div className="flex flex-wrap items-center gap-2">
            {sourceState}
            <span className="text-muted-foreground text-xs">updated {updated}</span>
          </div>
          {labels}
          {taskStatus}
        </div>
        {actions}
      </div>
      {details ? <div className="mt-3">{details}</div> : null}
    </li>
  );
}

const isFactoryAcceptanceError = Schema.is(FactoryAcceptanceError);

function acceptanceFailureMessage(error: unknown, fallbackMessage?: string): string {
  if (isFactoryAcceptanceError(error)) {
    switch (error.reason) {
      case "head-moved":
        return "The head moved while you were reviewing. Refresh and review again.";
      case "already-accepted":
        return "This task already has an accepted commit. Refresh and use Re-accept at current head if it has changed.";
      case "worktree-unavailable":
        return "The worktree or live head is unavailable. Restore the worktree and refresh to accept a commit.";
      case "unknown-thread":
        return "This thread is no longer available.";
      case "not-a-factory-task":
        return "This thread is not a claimed Factory task.";
    }
  }
  return describeFactoryFailure(error, fallbackMessage).message;
}

function FactoryAcceptedCommit(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly deliverySupported: boolean;
  readonly issueTitle: string;
  readonly issueUrl: string;
}) {
  const { environmentId, projectId, threadId } = props;
  const registry = useContext(RegistryContext);
  const headingId = useId();
  const disabledReasonId = useId();
  const query = useEnvironmentQuery(
    factoryEnvironment.readAcceptance({ environmentId, input: { projectId, threadId } }),
  );
  const canAccept = useAtomValue(factoryEnvironment.acceptCommit.permissionAtom(environmentId));
  const runAccept = useAtomCommand(factoryEnvironment.acceptCommit, {
    label: "factory accept commit",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const data = query.data;
  const acceptance = data?.acceptance ?? null;
  const liveHeadSha = data?.liveHeadSha ?? null;
  const moved = acceptance !== null && data?.current === false;
  const readFailure =
    query.error === null ? null : acceptanceFailureMessage(query.failure, query.error);
  const disabledReason = !canAccept
    ? "Accepting a commit needs operate permission on this environment."
    : readFailure !== null
      ? readFailure
      : query.isPending || data === null
        ? "Reading the current head…"
        : liveHeadSha === null
          ? "The worktree or live head is unavailable. Restore the worktree and refresh to accept a commit."
          : failure !== null
            ? "Refresh and review the current head before accepting again."
            : null;

  const accept = async () => {
    if (inFlight.current || disabledReason !== null || liveHeadSha === null) return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    const result = await runAccept({
      environmentId,
      input: {
        projectId,
        threadId,
        // Only the observed head is eligible; the server rejects a concurrent head change.
        expectedHeadSha: liveHeadSha,
        evidenceRefs: [],
        ...(moved ? { supersede: true } : {}),
      },
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      query.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(acceptanceFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <div role="group" aria-labelledby={headingId} aria-busy={saving || query.isPending}>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={headingId} className="font-medium text-sm">
            Accepted commit
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={saving || query.isPending}
            aria-label="Refresh accepted commit"
            onClick={() => {
              setFailure(null);
              query.refresh();
            }}
          >
            Refresh
          </Button>
        </div>
        {acceptance !== null ? (
          <p className="text-muted-foreground text-xs">
            <code>{acceptance.headSha.slice(0, 7)}</code>
            {" · "}
            <time dateTime={acceptance.acceptedAt}>
              {new Date(acceptance.acceptedAt).toLocaleString()}
            </time>
            {" · "}
            {acceptance.evidenceRefs.length} evidence references
          </p>
        ) : data !== null ? (
          <p className="text-muted-foreground text-xs">No commit accepted yet.</p>
        ) : null}
        {moved ? (
          <Alert variant="warning">
            <AlertDescription>Head moved since acceptance</AlertDescription>
          </Alert>
        ) : null}
        {(acceptance === null || moved) && liveHeadSha !== null ? (
          <p className="text-muted-foreground text-xs">
            Current head <code>{liveHeadSha.slice(0, 7)}</code>
          </p>
        ) : null}
        {failure !== null ? (
          <Alert variant="error">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        ) : null}
        {acceptance === null || moved ? (
          <Button
            size="sm"
            variant="outline"
            disabled={saving || disabledReason !== null}
            aria-busy={saving}
            aria-describedby={disabledReason !== null ? disabledReasonId : undefined}
            onClick={() => void accept()}
          >
            {saving ? "Accepting…" : moved ? "Re-accept at current head" : "Accept this commit"}
          </Button>
        ) : null}
        {disabledReason !== null ? (
          <p id={disabledReasonId} className="text-muted-foreground text-xs" role="status">
            {disabledReason}
          </p>
        ) : null}
      </div>
      {props.deliverySupported && acceptance !== null && data?.current === true ? (
        <FactoryDeliveryPanel
          key={acceptance.id}
          environmentId={environmentId}
          projectId={projectId}
          threadId={threadId}
          issueTitle={props.issueTitle}
          issueUrl={props.issueUrl}
          acceptanceCurrent={data.current && readFailure === null && !query.isPending}
          onGranted={() => {
            registry.refresh(
              factoryEnvironment.readDeliveries({ environmentId, input: { projectId, threadId } }),
            );
          }}
        />
      ) : null}
    </div>
  );
}

const READINESS_ALERT_VARIANT = {
  success: "success",
  warning: "warning",
  info: "info",
  neutral: "default",
} as const satisfies Record<FactoryReadinessTone, "success" | "warning" | "info" | "default">;

/** The edge exactly as the reviewer saw it; a refreshed table never changes what is confirmed. */
type PendingOverride = {
  readonly row: FactoryReadinessEdgeRow;
  readonly action: FactoryReadinessOverrideAction;
};

/**
 * Observed blocker evidence for one open issue. It mounts only while Details is expanded, so the
 * read happens once per expand: collapsing unmounts the query and expanding observes again.
 * Nothing here reaches Start; the verdict is information and never a gate. Disputes and waivers
 * are the reviewer's recorded decisions about single edges: they change this verdict only.
 */
function FactoryIssueBlockers(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issueNumber: number;
}) {
  const { environmentId, projectId, issueNumber } = props;
  const headingId = useId();
  const nowMs = useNowSecond();
  const query = useEnvironmentQuery(
    factoryEnvironment.readIssueReadiness({
      environmentId,
      input: { projectId, issueNumber },
    }),
  );
  const canOverride = useAtomValue(
    factoryEnvironment.setIssueReadinessOverride.permissionAtom(environmentId),
  );
  const canRevoke = useAtomValue(
    factoryEnvironment.revokeIssueReadinessOverride.permissionAtom(environmentId),
  );
  const runSet = useAtomCommand(factoryEnvironment.setIssueReadinessOverride, {
    label: "factory readiness override",
    reportFailure: false,
  });
  const runRevoke = useAtomCommand(factoryEnvironment.revokeIssueReadinessOverride, {
    label: "factory readiness override revoke",
    reportFailure: false,
  });
  const [dialog, setDialog] = useState<PendingOverride | null>(null);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<FactoryReadinessOverrideId | null>(null);
  const [dialogFailure, setDialogFailure] = useState<FactoryFailure | null>(null);
  const [revokeFailure, setRevokeFailure] = useState<FactoryFailure | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const failure = query.error === null ? null : describeFactoryFailure(query.failure, query.error);
  const presentation =
    failure === null && query.data !== null
      ? factoryReadinessPresentation(query.data.readiness, nowMs)
      : null;
  const refreshing = query.isPending;
  const busy = saving || revokingId !== null || refreshing;
  const hasControls =
    presentation?.edgeRows.some((row) => row.overrideAction !== null || row.overrideId !== null) ??
    false;
  const hasNewDecision = presentation?.edgeRows.some((row) => row.overrideAction !== null) ?? false;

  const submitOverride = async (pending: PendingOverride, reason: string) => {
    // The server owns deduplication; this only stops the same client double-submitting.
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setDialogFailure(null);
    const result = await runSet({
      environmentId,
      input: buildFactoryReadinessOverrideInput({
        commandId: CommandId.make(randomUUID()),
        projectId,
        issueNumber,
        row: pending.row,
        action: pending.action,
        reason,
      }),
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      setDialog(null);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    // The command observes the issue again, so the table behind the dialog already shows the
    // current edge while the dialog keeps the one that was reviewed.
    setDialogFailure(describeFactoryFailure(squashAtomCommandFailure(result)));
  };

  const revoke = async (overrideId: FactoryReadinessOverrideId) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRevokingId(overrideId);
    setRevokeFailure(null);
    const result = await runRevoke({
      environmentId,
      input: { commandId: CommandId.make(randomUUID()), projectId, issueNumber, overrideId },
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setRevokingId(null);
    });
    if (!mounted.current) return;
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setRevokeFailure(describeFactoryFailure(squashAtomCommandFailure(result)));
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-busy={refreshing}
      className="mt-4 space-y-2 border-border/60 border-t pt-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={headingId} className="font-medium text-sm">
          Blockers
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRevokeFailure(null);
            query.refresh();
          }}
          disabled={refreshing}
          aria-label={`Refresh blockers for issue #${issueNumber}`}
        >
          <RefreshIcon size="sm" refreshing={refreshing} />
          Refresh
        </Button>
      </div>
      {failure !== null ? (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : presentation === null ? (
        <p className="text-muted-foreground text-sm" role="status">
          Observing blockers…
        </p>
      ) : (
        <>
          {/* A group, not the default alert role: the relative time changes every minute and must not be re-announced. */}
          <Alert variant={READINESS_ALERT_VARIANT[presentation.tone]} role="group">
            <AlertDescription>{presentation.label}</AlertDescription>
          </Alert>
          {revokeFailure !== null ? (
            <Alert variant="error">
              <AlertTitle>{revokeFailure.title}</AlertTitle>
              <AlertDescription>{revokeFailure.message}</AlertDescription>
            </Alert>
          ) : null}
          {presentation.edgeRows.length > 0 ? (
            <Table>
              <caption className="sr-only">Blockers of issue #{issueNumber}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Blocker</TableHead>
                  <TableHead scope="col">Title</TableHead>
                  <TableHead scope="col">State</TableHead>
                  <TableHead scope="col">Resolution</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Override</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {presentation.edgeRows.map((row) => {
                  const action = row.overrideAction;
                  const overrideId = row.overrideId;
                  return (
                    <TableRow key={row.key}>
                      <TableCell>
                        {row.url !== null ? (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline-offset-4 hover:underline"
                          >
                            {row.locator}
                          </a>
                        ) : (
                          row.locator
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="min-w-40 max-w-96 whitespace-normal [overflow-wrap:anywhere]">
                          {row.title}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.stateLabel}
                        {row.closedAt !== null ? (
                          <>
                            {" · "}
                            <time dateTime={row.closedAt}>
                              <RelativeTime timestamp={row.closedAt} />
                            </time>
                          </>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="max-w-96 whitespace-normal [overflow-wrap:anywhere]">
                          <div>{row.resolutionLabel}</div>
                          {row.overrideLabel !== null ? (
                            <div className="text-muted-foreground">{row.overrideLabel}</div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>{row.statusLabel}</TableCell>
                      <TableCell>
                        {action !== null ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={
                              !canOverride || presentation.overridesLockedReason !== null || busy
                            }
                            aria-label={`${FACTORY_OVERRIDE_ACTIONS[action].buttonLabel} blocker ${row.locator}`}
                            onClick={() => {
                              setRevokeFailure(null);
                              setDialogFailure(null);
                              setDialog({ row, action });
                            }}
                          >
                            {FACTORY_OVERRIDE_ACTIONS[action].buttonLabel}
                          </Button>
                        ) : overrideId !== null ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!canRevoke || busy}
                            aria-busy={revokingId === overrideId}
                            aria-label={`Revoke override on blocker ${row.locator}`}
                            onClick={() => void revoke(overrideId)}
                          >
                            {revokingId === overrideId ? "Revoking…" : "Revoke"}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : null}
          {hasNewDecision && presentation.overridesLockedReason !== null ? (
            <p className="text-muted-foreground text-xs" role="status">
              {presentation.overridesLockedReason}
            </p>
          ) : null}
          {hasControls && (!canOverride || !canRevoke) ? (
            <p className="text-muted-foreground text-xs">
              Recording or revoking overrides needs operate permission on this environment.
            </p>
          ) : null}
          {presentation.inactiveOverrides.length > 0 ? (
            <div className="space-y-1">
              <p className="font-medium text-xs">Past overrides</p>
              <ul className="space-y-1 text-muted-foreground text-xs">
                {presentation.inactiveOverrides.map((override) => (
                  <li key={override.key} className="flex flex-wrap items-baseline gap-x-2">
                    <Badge variant="outline" size="sm">
                      {override.statusLabel}
                    </Badge>
                    <span className="[overflow-wrap:anywhere]">
                      {override.kindLabel} on {override.locator}: {override.reason}
                    </span>
                    <span>
                      {override.revokedAt !== null ? "revoked " : "recorded "}
                      <RelativeTime timestamp={override.revokedAt ?? override.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Observed from GitHub blocked-by links. Evidence only: it never allows or prevents
            starting work. A dispute or waiver records your decision here and changes nothing on
            GitHub. Refresh observes again.
          </p>
        </>
      )}
      {dialog !== null ? (
        <FactoryReadinessOverrideDialog
          row={dialog.row}
          action={dialog.action}
          canOperate={canOverride}
          pending={saving}
          failure={dialogFailure}
          onClose={() => {
            setDialog(null);
            setDialogFailure(null);
          }}
          onSubmit={(reason) => void submitOverride(dialog, reason)}
        />
      ) : null}
    </div>
  );
}
