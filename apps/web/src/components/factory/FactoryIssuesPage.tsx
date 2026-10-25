import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { factoryIssueReviewText } from "@t3tools/client-runtime/state/factory";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type FactoryIssue,
  type FactoryIssueStartInput,
  type FactoryRepository,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CircleDotIcon,
  ExternalLinkIcon,
  FactoryIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ModelEsque } from "../chat/providerIconUtils";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { randomUUID } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { RelativeTime } from "../RelativeTime";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  FACTORY_STATE_FILTERS,
  currentFactoryPage,
  describeFactoryFailure,
  factoryScopeKey,
  normalizeFactoryBaseRef,
  parseFactoryStateFilter,
  popFactoryPage,
  pushFactoryPage,
  safeExternalUrl,
  type FactoryFailure,
  type FactoryIssueStateFilter,
} from "./factoryIssues.logic";
import { FactoryIssueWorkView } from "./FactoryIssueWorkView";
import { parseFactoryIssueViewMode, type FactoryIssueViewMode } from "./factoryIssues.views";

import { useSettingsScope } from "../settings/SettingsScopeContext";
import { factoryScopeSearchForMember, singleFactoryMember } from "./factoryScope";

function FactoryEmptyState(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <Empty className="min-h-64">
      <EmptyMedia variant="icon">{props.icon}</EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action}
    </Empty>
  );
}

export function FactoryIssuesPage() {
  const search = useSearch({ from: "/_chat/factory" });
  const navigate = useNavigate({ from: "/factory/issues" });
  const { scope, groups, selectScope } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  const allProjects = useProjects();
  const readableIds = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const member = singleFactoryMember(scope);
  const environment = environments.find(
    (candidate) => candidate.environmentId === member?.environmentId,
  );
  const canRead = useEnvironmentScope(member?.environmentId ?? null, AuthOrchestrationReadScope);
  const project = allProjects.find(
    (candidate) => candidate.environmentId === member?.environmentId && candidate.id === member?.id,
  );
  const state = search.state;
  const view = parseFactoryIssueViewMode(search.view);
  const visibleGroups = groups.flatMap((group) => {
    const members = group.memberProjects.filter((candidate) =>
      scope.kind === "project" || scope.kind === "checkout"
        ? scope.members.some(
            (selected) => selected.physicalProjectKey === candidate.physicalProjectKey,
          )
        : scope.environmentIds.includes(candidate.environmentId),
    );
    return members.length > 0 ? [{ group, members }] : [];
  });

  if (scope.kind === "unavailable") return null;
  if (!isReady) {
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="factory-issues-title">
      <div className="space-y-1">
        <h2 id="factory-issues-title" className="font-medium text-lg">
          Issues
        </h2>
        <p className="text-muted-foreground text-sm">
          Review GitHub issues in one checkout before starting isolated, supervised work.
        </p>
      </div>
      {member === null ? (
        <>
          <p className="text-muted-foreground text-sm">
            Choose a checkout to open its issue inbox. Checkouts of the same repository may share
            issues; they are not combined into a global queue.
          </p>
          {visibleGroups.length === 0 ? (
            <FactoryEmptyState
              icon={<FactoryIcon />}
              title="No checkouts in this scope"
              description="Connect an environment and add a repository checkout to use the issue inbox."
            />
          ) : (
            visibleGroups.map(({ group, members }) => (
              <section key={group.projectKey} className="space-y-2">
                <h3 className="font-medium text-sm">{group.displayName}</h3>
                <ul className="divide-y rounded-lg border">
                  {members.map((candidate) => {
                    const owner = environments.find(
                      (item) => item.environmentId === candidate.environmentId,
                    );
                    const status = !owner
                      ? "Environment unavailable"
                      : owner.connection.phase !== "connected"
                        ? "Offline. Reconnect to read issues"
                        : owner.serverConfig === null
                          ? "Server capabilities unknown"
                          : owner.serverConfig.environment.capabilities.factoryIssues !== true
                            ? "Issue inbox unsupported. Update this server"
                            : !readableIds.has(owner.environmentId)
                              ? "Read access unavailable"
                              : "Connected · issue inbox available";
                    return (
                      <li
                        key={candidate.physicalProjectKey}
                        className="flex flex-wrap items-center justify-between gap-3 p-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <p className="font-medium text-sm">
                            {owner?.label ?? candidate.environmentLabel ?? candidate.environmentId}
                          </p>
                          <p className="break-all text-muted-foreground text-xs">
                            {candidate.workspaceRoot}
                          </p>
                          <p className="text-muted-foreground text-xs">{status}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => selectScope(factoryScopeSearchForMember(candidate, group))}
                        >
                          Choose checkout
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </>
      ) : !environment || !project ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Checkout unavailable"
          description="This checkout is no longer available. Choose another scope."
        />
      ) : environment.connection.phase !== "connected" ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Environment offline"
          description={`Reconnect ${environment.label} to read this checkout's issues.`}
        />
      ) : environment.serverConfig === null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Server capabilities unknown"
          description="Wait for this environment to finish connecting before opening its inbox."
        />
      ) : environment.serverConfig.environment.capabilities.factoryIssues !== true ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Issue inbox unsupported"
          description={`Update the server on ${environment.label} to use the GitHub issue inbox.`}
        />
      ) : !canRead ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Read access unavailable"
          description="This connection needs orchestration read access to list issues."
        />
      ) : (
        <>
          <ToggleGroup
            aria-label="Issue state"
            value={[state]}
            onValueChange={(values) => {
              const next = values[0];
              if (next !== undefined) {
                void navigate({
                  search: (previous) => ({ ...previous, state: parseFactoryStateFilter(next) }),
                  replace: true,
                });
              }
            }}
          >
            {FACTORY_STATE_FILTERS.map((filter) => (
              <Toggle key={filter.value} value={filter.value}>
                {filter.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <FactoryInbox
            key={factoryScopeKey(environment.environmentId, project.id, state)}
            environmentId={environment.environmentId}
            project={project}
            projectTitleById={
              new Map(
                allProjects
                  .filter((candidate) => candidate.environmentId === environment.environmentId)
                  .map((candidate) => [candidate.id, candidate.title]),
              )
            }
            state={state}
            mode={view}
            onModeChange={(next) => {
              void navigate({ search: (previous) => ({ ...previous, view: next }), replace: true });
            }}
          />
        </>
      )}
    </section>
  );
}

type InboxProject = EnvironmentProject;

interface PendingStart {
  readonly issue: FactoryIssue;
  readonly restart: boolean;
  readonly repository: FactoryRepository;
}

function FactoryInbox(props: {
  readonly environmentId: EnvironmentId;
  readonly project: InboxProject;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
  readonly state: FactoryIssueStateFilter;
  readonly mode: FactoryIssueViewMode;
  readonly onModeChange: (mode: FactoryIssueViewMode) => void;
}) {
  const { environmentId, project, state, mode } = props;
  const navigate = useNavigate();
  const [pages, setPages] = useState<ReadonlyArray<number>>([1]);
  const page = currentFactoryPage(pages);
  const query = useEnvironmentQuery(
    factoryEnvironment.list({ environmentId, input: { projectId: project.id, state, page } }),
  );
  const canStart = useAtomValue(factoryEnvironment.start.permissionAtom(environmentId));
  const runStart = useAtomCommand(factoryEnvironment.start, {
    label: "factory issue start",
    reportFailure: false,
  });

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, project.id),
  );
  const normalizeSelection = (selection: ModelSelection) =>
    resolveEffectiveDefaultModelSelection(settings, providers, selection);
  const configuredDefault = scheduledTaskDefaultModel(settings, project, instanceEntries);
  const defaultSelection =
    configuredDefault === null ? null : normalizeSelection(configuredDefault);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    defaultSelection?.instanceId ?? null,
    defaultSelection?.model ?? null,
  );

  const [dialog, setDialog] = useState<PendingStart | null>(null);
  const [startingIssue, setStartingIssue] = useState<number | null>(null);
  const [startFailure, setStartFailure] = useState<FactoryFailure | null>(null);
  const startInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const startIssue = async (
    issue: FactoryIssue,
    options: {
      readonly modelSelection: ModelSelection;
      readonly expectedRepositoryKey: string;
      readonly runtimeMode: FactoryIssueStartInput["runtimeMode"];
      readonly interactionMode: FactoryIssueStartInput["interactionMode"];
      readonly baseRef?: string;
      readonly restartDeleted: boolean;
    },
  ) => {
    // The server owns deduplication; this only stops the same client double-submitting.
    if (startInFlight.current) return;
    const input: FactoryIssueStartInput = {
      commandId: CommandId.make(randomUUID()),
      projectId: project.id,
      issueNumber: issue.number,
      expectedRepositoryKey: options.expectedRepositoryKey,
      expectedIssueRevision: issue.revision,
      modelSelection: options.modelSelection,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
      ...(options.restartDeleted ? { restartDeleted: true } : {}),
    };
    startInFlight.current = true;
    setStartingIssue(issue.number);
    setStartFailure(null);
    const result = await runStart({ environmentId, input }).finally(() => {
      startInFlight.current = false;
      if (mounted.current) setStartingIssue(null);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      query.refresh();
      setDialog(null);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setStartFailure(describeFactoryFailure(squashAtomCommandFailure(result)));
    // The failure may mean the row is stale (closed, deleted, already launched elsewhere).
    query.refresh();
  };

  const openTask = (task: NonNullable<FactoryIssue["task"]>) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, task.threadId)),
    });
  };

  const resume = (issue: FactoryIssue, repository: FactoryRepository) => {
    const task = issue.task;
    if (task === null || task.status !== "launching") return;
    void startIssue(issue, {
      modelSelection: task.modelSelection,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
      expectedRepositoryKey: repository.canonicalKey,
      restartDeleted: false,
    });
  };

  const failure = query.error === null ? null : describeFactoryFailure(query.failure, query.error);
  const data = failure === null ? query.data : null;
  const refreshing = query.isPending;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RepositoryTarget repository={data?.repository ?? null} projectTitle={project.title} />
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Issue view"
            value={[mode]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "list" || next === "table" || next === "board") {
                props.onModeChange(next);
              }
            }}
          >
            <Toggle value="list">List</Toggle>
            <Toggle value="table">Table</Toggle>
            <Toggle value="board">Board</Toggle>
          </ToggleGroup>
          {data ? (
            <span className="text-muted-foreground text-xs">
              Updated <RelativeTime timestamp={data.fetchedAt} />
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={query.refresh}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <RefreshIcon size="sm" refreshing={refreshing} />
            Refresh
          </Button>
        </div>
      </div>

      {!canStart ? (
        <Alert variant="warning">
          <AlertDescription>
            This connection cannot start tasks. Starting needs orchestration and source control
            write access; existing tasks can still be opened.
          </AlertDescription>
        </Alert>
      ) : null}

      {startFailure !== null && dialog === null ? (
        <Alert variant="error">
          <AlertTitle>{startFailure.title}</AlertTitle>
          <AlertDescription>{startFailure.message}</AlertDescription>
        </Alert>
      ) : null}

      {failure !== null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={failure.title}
          description={failure.message}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={query.refresh}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
              Retry
            </Button>
          }
        />
      ) : data === null ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          {mode !== "list" ? (
            <p className="text-muted-foreground text-xs">
              Source filter: {state === "open" ? "Open" : state === "closed" ? "Closed" : "All"}.
              Page {page} only, not all project work.
              {state === "open"
                ? " Tasks linked to closed issues appear under Closed or All."
                : null}
            </p>
          ) : null}
          {data.issues.length === 0 ? (
            <FactoryEmptyState
              icon={<CircleDotIcon />}
              title={`No ${state === "all" ? "" : `${state} `}issues on this page`}
              description={
                data.nextPage === null
                  ? "Nothing to show for this filter."
                  : "GitHub returned no issues on this page, but more pages exist."
              }
            />
          ) : (
            <FactoryIssueWorkView
              key={`${data.repository.canonicalKey}:${page}`}
              mode={mode}
              issues={data.issues}
              canStart={canStart}
              busy={startingIssue !== null}
              startingIssue={startingIssue}
              selectedProjectId={project.id}
              projectTitleById={props.projectTitleById}
              refreshing={refreshing}
              onStart={(issue) => {
                setStartFailure(null);
                setDialog({ issue, repository: data.repository, restart: false });
              }}
              onRestart={(issue) => {
                setStartFailure(null);
                setDialog({ issue, repository: data.repository, restart: true });
              }}
              onResume={(issue) => resume(issue, data.repository)}
              onOpen={openTask}
            />
          )}
          <div className="flex items-center justify-between gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || refreshing}
              onClick={() => setPages(popFactoryPage(pages))}
            >
              <ChevronLeftIcon />
              Previous
            </Button>
            <span className="text-muted-foreground text-xs">Page {page}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={data.nextPage === null || refreshing}
              onClick={() => {
                if (data.nextPage !== null) setPages(pushFactoryPage(pages, data.nextPage));
              }}
            >
              Next
              <ChevronRightIcon />
            </Button>
          </div>
        </>
      )}

      {dialog !== null ? (
        <FactoryStartDialog
          key={`${dialog.issue.number}:${dialog.restart}`}
          environmentId={environmentId}
          issue={dialog.issue}
          restart={dialog.restart}
          projectTitle={project.title}
          repository={dialog.repository}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          defaultSelection={defaultSelection}
          normalizeModelSelection={normalizeSelection}
          canStart={canStart}
          pending={startingIssue === dialog.issue.number}
          failure={startFailure}
          onClose={() => {
            setDialog(null);
            setStartFailure(null);
          }}
          onSubmit={(options) => {
            if (startFailure?.kind === "changed") return;
            void startIssue(dialog.issue, {
              ...options,
              expectedRepositoryKey: dialog.repository.canonicalKey,
              runtimeMode: "approval-required",
              interactionMode: "default",
            });
          }}
        />
      ) : null}
    </div>
  );
}

function RepositoryTarget(props: {
  readonly repository: FactoryRepository | null;
  readonly projectTitle: string;
}) {
  const href = props.repository ? safeExternalUrl(props.repository.url) : null;
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-muted-foreground text-xs">Issues from</p>
      {props.repository ? (
        <p className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate underline-offset-4 hover:underline"
            >
              {props.repository.host}/{props.repository.repository}
            </a>
          ) : (
            <span className="min-w-0 truncate">
              {props.repository.host}/{props.repository.repository}
            </span>
          )}
          <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          Resolving {props.projectTitle}'s repository…
        </p>
      )}
    </div>
  );
}

function FactoryStartDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly issue: FactoryIssue;
  readonly restart: boolean;
  readonly projectTitle: string;
  readonly repository: FactoryRepository;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly defaultSelection: ModelSelection | null;
  readonly normalizeModelSelection: (selection: ModelSelection) => ModelSelection;
  readonly canStart: boolean;
  readonly pending: boolean;
  readonly failure: FactoryFailure | null;
  readonly onClose: () => void;
  readonly onSubmit: (options: {
    readonly modelSelection: ModelSelection;
    readonly baseRef?: string;
    readonly restartDeleted: boolean;
  }) => void;
}) {
  const { issue, restart, pending } = props;
  // Keep defaults and model normalization pinned while the user reviews this issue.
  const [modelSettings] = useState(() => ({
    defaultSelection: props.defaultSelection,
    instanceEntries: props.instanceEntries,
    modelOptionsByInstance: props.modelOptionsByInstance,
    normalizeModelSelection: props.normalizeModelSelection,
  }));
  const reviewId = useId();
  const review = {
    title: factoryIssueReviewText(issue.title),
    body: issue.body === null ? null : factoryIssueReviewText(issue.body),
  };
  const changed = props.failure?.kind === "changed";
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const pickedIsAvailable =
    picked !== null &&
    modelSettings.instanceEntries.some(
      (entry) => entry.instanceId === picked.instanceId && entry.enabled,
    );
  const candidate = pickedIsAvailable ? picked : modelSettings.defaultSelection;
  const selection = candidate === null ? null : modelSettings.normalizeModelSelection(candidate);
  const activeInstanceId: ProviderInstanceId | null =
    selection?.instanceId ?? modelSettings.instanceEntries[0]?.instanceId ?? null;

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
            {restart ? "Start a new attempt" : "Start task"} · #{issue.number}
          </DialogTitle>
          <DialogDescription>
            {restart
              ? "The previous task's thread was deleted. Confirming creates a new isolated worktree and a new attempt for this issue."
              : "Creates a task in its own isolated git worktree and sends the issue to the selected agent."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || changed} className="min-w-0 space-y-4">
            <p className="text-muted-foreground text-xs">
              {`${props.repository.host}/${props.repository.repository}`} · task project{" "}
              {props.projectTitle}
            </p>
            <div className="space-y-2">
              <h3 id={`${reviewId}-title`} className="font-medium text-sm">
                Full issue snapshot
              </h3>
              <p id={`${reviewId}-description`} className="text-muted-foreground text-xs">
                Review the full title and description before confirming. Backslashes are escaped;
                control and formatting characters are shown as <code>{"\\uXXXX"}</code>. Tabs and
                newlines remain literal. No source text is omitted.
              </p>
              <div
                role="region"
                aria-labelledby={`${reviewId}-title`}
                aria-describedby={`${reviewId}-description`}
                tabIndex={0}
                className="max-h-80 min-w-0 space-y-3 overflow-auto rounded-lg border border-border/60 p-3 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <div className="space-y-1">
                  <h4 className="font-medium text-xs">Title</h4>
                  {review.title.length === 0 ? (
                    <p className="text-muted-foreground text-sm">The source title is empty.</p>
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]">
                      {review.title}
                    </pre>
                  )}
                </div>
                <div className="space-y-1">
                  <h4 className="font-medium text-xs">Description</h4>
                  {review.body === null ? (
                    <p className="text-muted-foreground text-sm">
                      This issue has no description. The source body is null.
                    </p>
                  ) : review.body.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      The source description is an empty string.
                    </p>
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]">
                      {review.body}
                    </pre>
                  )}
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <div>
                {activeInstanceId !== null ? (
                  <ProviderModelPicker
                    environmentId={props.environmentId}
                    disabled={pending || changed}
                    activeInstanceId={activeInstanceId}
                    model={selection?.model ?? ""}
                    lockedProvider={null}
                    instanceEntries={modelSettings.instanceEntries}
                    modelOptionsByInstance={modelSettings.modelOptionsByInstance}
                    isComposerOwned={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onInstanceModelChange={(instanceId, model) => setPicked({ instanceId, model })}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">No provider is configured.</p>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="factory-base-ref">
                Base ref <span className="font-normal text-muted-foreground">optional</span>
              </Label>
              <Input
                id="factory-base-ref"
                value={baseRef}
                placeholder="Current HEAD of the project checkout"
                onChange={(event) => setBaseRef(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                A local branch, tag or commit. It is resolved to a fixed commit when the task
                starts; your checkout is not fetched or changed.
              </p>
            </div>
            <Alert variant="info">
              <AlertDescription>
                The task starts with approval required. Issue text is treated as untrusted task
                data, and nothing here authorizes publishing, merging or releasing. You can change
                the thread's controls afterwards.
              </AlertDescription>
            </Alert>
          </fieldset>
        </DialogPanel>
        {props.failure ? (
          <div className="shrink-0 px-6 pt-3">
            <Alert variant="error">
              <AlertTitle>{props.failure.title}</AlertTitle>
              <AlertDescription>
                <p>{props.failure.message}</p>
                {changed ? (
                  <p>
                    This snapshot is no longer current. Close this dialog and reopen the issue to
                    review the refreshed content before starting new work.
                  </p>
                ) : null}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!props.canStart || pending || changed || selection === null}
            aria-busy={pending}
            onClick={() => {
              if (!props.canStart || pending || changed || selection === null) return;
              const normalized = normalizeFactoryBaseRef(baseRef);
              props.onSubmit({
                modelSelection: selection,
                restartDeleted: restart,
                ...(normalized !== undefined ? { baseRef: normalized } : {}),
              });
            }}
          >
            {pending ? "Starting…" : restart ? "Start new attempt" : "Start task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
