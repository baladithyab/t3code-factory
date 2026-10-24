import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
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
  PlugZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
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
import { useFactoryIssueEnvironmentIds, factoryEnvironment } from "../../state/factory";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
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
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
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
  type FactoryIssuesSearch,
} from "./factoryIssues.logic";
import { FactoryIssueWorkView } from "./FactoryIssueWorkView";
import { parseFactoryIssueViewMode, type FactoryIssueViewMode } from "./factoryIssues.views";

function isConnected(environment: EnvironmentPresentation): boolean {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

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
  const navigate = useNavigate({ from: "/factory" });
  const { isReady, environments } = useEnvironments();
  const supportedIds = useFactoryIssueEnvironmentIds();
  const allProjects = useProjects();

  const supported = environments.filter((environment) =>
    supportedIds.includes(environment.environmentId),
  );
  const selectedEnvironment =
    supported.find((environment) => environment.environmentId === search.environmentId) ??
    supported.find(isConnected) ??
    supported[0] ??
    null;
  const projects =
    selectedEnvironment === null
      ? []
      : allProjects
          .filter((project) => project.environmentId === selectedEnvironment.environmentId)
          .toSorted((left, right) => left.title.localeCompare(right.title));
  const selectedProject =
    projects.find((project) => project.id === search.projectId) ?? projects[0] ?? null;
  const state = search.state;
  const view = parseFactoryIssueViewMode(search.view);

  const setScope = (next: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId;
    readonly state: FactoryIssueStateFilter;
  }) => {
    const target: FactoryIssuesSearch = {
      state: next.state,
      view,
      environmentId: next.environmentId,
      ...(next.projectId !== undefined ? { projectId: next.projectId } : {}),
    };
    void navigate({ search: target, replace: true });
  };

  const setView = (next: FactoryIssueViewMode) => {
    void navigate({ search: (previous) => ({ ...previous, view: next }), replace: true });
  };

  const unknownCapabilities = environments.filter(
    (environment) => environment.serverConfig === null,
  );
  const awaitingCapabilities =
    supported.length === 0 &&
    unknownCapabilities.some((environment) => environment.connection.phase === "connecting");

  let content: ReactNode;
  if (!isReady || awaitingCapabilities) {
    content = (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  } else if (environments.length === 0) {
    content = (
      <FactoryEmptyState
        icon={<PlugZapIcon />}
        title="Connect an environment"
        description="Factory issues are read and started by a T3 Code server. Connect an environment to get started."
      />
    );
  } else if (selectedEnvironment === null) {
    const lacking = environments.filter((environment) => environment.serverConfig !== null);
    content =
      unknownCapabilities.length > 0 ? (
        <FactoryEmptyState
          icon={<PlugZapIcon />}
          title="Environment not connected"
          description={`Connect ${unknownCapabilities
            .map((environment) => environment.label)
            .join(", ")} to check whether it supports the GitHub issue inbox.`}
        />
      ) : (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Factory issues unavailable"
          description={`Update the T3 Code server on ${lacking
            .map((environment) => environment.label)
            .join(", ")} to enable the GitHub issue inbox.`}
        />
      );
  } else if (!isConnected(selectedEnvironment)) {
    content = (
      <>
        <ScopeControls
          supported={supported}
          selectedEnvironment={selectedEnvironment}
          projects={projects}
          selectedProject={selectedProject}
          state={state}
          onChange={setScope}
        />
        <FactoryEmptyState
          icon={<PlugZapIcon />}
          title="Environment not connected"
          description={`${selectedEnvironment.label} must be connected to list and start issues.`}
        />
      </>
    );
  } else if (selectedProject === null) {
    content = (
      <>
        <ScopeControls
          supported={supported}
          selectedEnvironment={selectedEnvironment}
          projects={projects}
          selectedProject={null}
          state={state}
          onChange={setScope}
        />
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="No projects in this environment"
          description="Add a project that is a clone of the repository whose issues you want to work."
        />
      </>
    );
  } else {
    const scopeKey = factoryScopeKey(selectedEnvironment.environmentId, selectedProject.id, state);
    content = (
      <>
        <ScopeControls
          supported={supported}
          selectedEnvironment={selectedEnvironment}
          projects={projects}
          selectedProject={selectedProject}
          state={state}
          onChange={setScope}
        />
        <FactoryInbox
          key={scopeKey}
          environmentId={selectedEnvironment.environmentId}
          project={selectedProject}
          projectTitleById={new Map(projects.map((project) => [project.id, project.title]))}
          state={state}
          mode={view}
          onModeChange={setView}
        />
      </>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <FactoryIcon aria-hidden className="size-4 text-muted-foreground" />
          <h1 className="truncate font-medium text-sm">Factory issues</h1>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">{content}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ScopeControls(props: {
  readonly supported: ReadonlyArray<EnvironmentPresentation>;
  readonly selectedEnvironment: EnvironmentPresentation;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly selectedProject: { readonly id: ProjectId; readonly title: string } | null;
  readonly state: FactoryIssueStateFilter;
  readonly onChange: (next: {
    readonly environmentId: EnvironmentId;
    readonly projectId?: ProjectId;
    readonly state: FactoryIssueStateFilter;
  }) => void;
}) {
  const { selectedEnvironment, selectedProject, state, onChange } = props;
  return (
    <div className="flex flex-wrap items-end gap-3">
      {props.supported.length > 1 ? (
        <div className="min-w-44 space-y-1.5">
          <Label htmlFor="factory-environment">Environment</Label>
          <Select
            value={selectedEnvironment.environmentId}
            onValueChange={(environmentId) => {
              const next = props.supported.find(
                (environment) => environment.environmentId === environmentId,
              );
              if (next) onChange({ environmentId: next.environmentId, state });
            }}
          >
            <SelectTrigger size="sm" id="factory-environment">
              <SelectValue>{selectedEnvironment.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {props.supported.map((environment) => (
                <SelectItem
                  key={environment.environmentId}
                  value={environment.environmentId}
                  label={environment.label}
                >
                  <span className="block truncate">{environment.label}</span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {props.projects.length > 0 ? (
        <div className="min-w-44 space-y-1.5">
          <Label htmlFor="factory-project">Project</Label>
          <Select
            value={selectedProject?.id ?? ""}
            onValueChange={(projectId) => {
              const next = props.projects.find((project) => project.id === projectId);
              if (next) {
                onChange({
                  environmentId: selectedEnvironment.environmentId,
                  projectId: next.id,
                  state,
                });
              }
            }}
          >
            <SelectTrigger size="sm" id="factory-project">
              <SelectValue placeholder="Select a project">{selectedProject?.title}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id} label={project.title}>
                  <span className="block truncate">{project.title}</span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      <ToggleGroup
        aria-label="Issue state"
        value={[state]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === undefined) return;
          onChange({
            environmentId: selectedEnvironment.environmentId,
            ...(selectedProject ? { projectId: selectedProject.id } : {}),
            state: parseFactoryStateFilter(next),
          });
        }}
      >
        {FACTORY_STATE_FILTERS.map((filter) => (
          <Toggle key={filter.value} value={filter.value}>
            {filter.label}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
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
    startInFlight.current = true;
    setStartingIssue(issue.number);
    setStartFailure(null);
    try {
      const input: FactoryIssueStartInput = {
        commandId: CommandId.make(randomUUID()),
        projectId: project.id,
        issueNumber: issue.number,
        expectedRepositoryKey: options.expectedRepositoryKey,
        modelSelection: options.modelSelection,
        runtimeMode: options.runtimeMode,
        interactionMode: options.interactionMode,
        ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
        ...(options.restartDeleted ? { restartDeleted: true } : {}),
      };
      const result = await runStart({ environmentId, input });
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
    } finally {
      startInFlight.current = false;
      if (mounted.current) setStartingIssue(null);
    }
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
          onSubmit={(options) =>
            void startIssue(dialog.issue, {
              ...options,
              expectedRepositoryKey: dialog.repository.canonicalKey,
              runtimeMode: "approval-required",
              interactionMode: "default",
            })
          }
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
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const pickedIsAvailable =
    picked !== null &&
    props.instanceEntries.some((entry) => entry.instanceId === picked.instanceId && entry.enabled);
  const candidate = pickedIsAvailable ? picked : props.defaultSelection;
  const selection = candidate === null ? null : props.normalizeModelSelection(candidate);
  const activeInstanceId: ProviderInstanceId | null =
    selection?.instanceId ?? props.instanceEntries[0]?.instanceId ?? null;

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
          <fieldset disabled={pending} className="min-w-0 space-y-4">
            <div className="space-y-1">
              <p className="font-medium text-sm">{issue.title}</p>
              <p className="text-muted-foreground text-xs">
                {`${props.repository.host}/${props.repository.repository}`} · task project{" "}
                {props.projectTitle}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <div>
                {activeInstanceId !== null ? (
                  <ProviderModelPicker
                    environmentId={props.environmentId}
                    disabled={pending}
                    activeInstanceId={activeInstanceId}
                    model={selection?.model ?? ""}
                    lockedProvider={null}
                    instanceEntries={props.instanceEntries}
                    modelOptionsByInstance={props.modelOptionsByInstance}
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
            {props.failure ? (
              <Alert variant="error">
                <AlertTitle>{props.failure.title}</AlertTitle>
                <AlertDescription>{props.failure.message}</AlertDescription>
              </Alert>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!props.canStart || pending || selection === null}
            aria-busy={pending}
            onClick={() => {
              if (selection === null) return;
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
