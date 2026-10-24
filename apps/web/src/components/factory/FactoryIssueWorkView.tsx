import type { FactoryIssue, FactoryIssueTask, ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon, CircleDotIcon } from "lucide-react";
import { Fragment, useId, useState } from "react";

import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  boundedIssueBody,
  factoryTaskPresentation,
  resolveFactoryIssueAction,
  safeExternalUrl,
} from "./factoryIssues.logic";
import { groupFactoryIssuesByStage, type FactoryIssueViewMode } from "./factoryIssues.views";

const MAX_VISIBLE_LABELS = 5;

type FactoryIssueWorkViewProps = {
  readonly mode: FactoryIssueViewMode;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly canStart: boolean;
  readonly busy: boolean;
  readonly startingIssue: number | null;
  readonly selectedProjectId: ProjectId;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
  readonly refreshing: boolean;
  readonly onStart: (issue: FactoryIssue) => void;
  readonly onRestart: (issue: FactoryIssue) => void;
  readonly onResume: (issue: FactoryIssue) => void;
  readonly onOpen: (task: FactoryIssueTask) => void;
};

export function FactoryIssueWorkView(props: FactoryIssueWorkViewProps) {
  // The parent keys this component by repository and page, but not presentation mode.
  const [expandedIssues, setExpandedIssues] = useState<ReadonlySet<number>>(() => new Set());

  const renderIssue = (issue: FactoryIssue) => (
    <FactoryIssueEntry
      key={issue.number}
      mode={props.mode}
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
          <td className="min-w-56 max-w-72 p-3">{taskState}</td>
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
          {taskState}
        </div>
        {actions}
      </div>
      {details ? <div className="mt-3">{details}</div> : null}
    </li>
  );
}
