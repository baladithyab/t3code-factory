import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { factoryIssueReviewText } from "@t3tools/client-runtime/state/factory";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationReadScope,
  CommandId,
  FACTORY_FEED_DISMISSAL_NOTE_MAX_CHARS,
  type EnvironmentId,
  type FactoryFeedCandidate,
  type FactoryFeedSource,
  type FactoryIssueTask,
  type FactoryRepository,
  type ModelSelection,
} from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronDownIcon, FactoryIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { FactoryCheckoutChooser } from "./FactoryCheckoutChooser";
import { FactoryEmptyState } from "./FactoryEmptyState";
import { FactoryFeedAdmitDialog } from "./FactoryFeedAdmitDialog";
import {
  buildFactoryFeedAdmitInput,
  checkFactoryFeedUrl,
  countFactoryFeedText,
  describeFactoryFeedFailure,
  describeFactoryFeedSource,
  factoryFeedCandidateBadges,
  factoryFeedRefreshAvailability,
  normalizeFactoryFeedText,
  resolveFactoryFeedCandidateAction,
  resolveFactoryFeedDismissal,
  visibleFactoryFeedCandidates,
  type FactoryFeedFailure,
} from "./factoryFeeds.logic";
import { factoryTaskPresentation, safeExternalUrl } from "./factoryIssues.logic";
import { useFactoryLaunchModelSettings } from "./FactoryLaunchControls";
import { FactoryReviewFailure, FactoryReviewSnapshot } from "./FactoryReview";
import { singleFactoryMember, type FactorySearch } from "./factoryScope";

export function FactorySourcesPage() {
  const search = useSearch({ from: "/_chat/factory" });
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
    <section className="min-w-0 space-y-5" aria-labelledby="factory-sources-title">
      <div className="space-y-1">
        <h2 id="factory-sources-title" className="font-medium text-lg">
          Sources
        </h2>
        <p className="text-muted-foreground text-sm">
          Bind public RSS or Atom feeds to one checkout and review what they publish. Nothing starts
          on its own: an item becomes a task only when you review and admit it.
        </p>
      </div>
      {member === null ? (
        <FactoryCheckoutChooser
          scope={scope}
          groups={groups}
          environments={environments}
          intro="Choose a checkout to manage its feed sources. Feeds belong to one checkout; they are not combined into a global queue."
          emptyDescription="Connect an environment and add a repository checkout to bind feed sources."
          statusFor={(owner) =>
            !owner
              ? "Environment unavailable"
              : owner.connection.phase !== "connected"
                ? "Offline. Reconnect to read feed sources"
                : owner.serverConfig === null
                  ? "Server capabilities unknown"
                  : owner.serverConfig.environment.capabilities.factoryFeeds !== true
                    ? "Feed sources unsupported. Update this server"
                    : !readableIds.has(owner.environmentId)
                      ? "Read access unavailable"
                      : "Connected · feed sources available"
          }
          onChoose={selectScope}
        />
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
          description={`Reconnect ${environment.label} to read this checkout's feed sources.`}
        />
      ) : environment.serverConfig === null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Server capabilities unknown"
          description="Wait for this environment to finish connecting before opening its sources."
        />
      ) : environment.serverConfig.environment.capabilities.factoryFeeds !== true ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Feed sources unsupported"
          description={`Update the server on ${environment.label} to bind feed sources.`}
        />
      ) : !canRead ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Read access unavailable"
          description="This connection needs orchestration read access to list feed sources."
        />
      ) : (
        <FactorySourcesWorkspace
          key={`${environment.environmentId}:${project.id}`}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          project={project}
          issuesSearch={search}
        />
      )}
    </section>
  );
}

interface PendingAdmit {
  readonly candidate: FactoryFeedCandidate;
  readonly source: FactoryFeedSource;
  readonly repository: FactoryRepository;
  readonly restart: boolean;
}

type AdmitMode = "admit" | "restart" | "resume";

function candidateKey(candidate: Pick<FactoryFeedCandidate, "sourceId" | "itemKey">): string {
  return JSON.stringify([candidate.sourceId, candidate.itemKey]);
}

function FactorySourcesWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly project: EnvironmentProject;
  readonly issuesSearch: FactorySearch;
}) {
  const { environmentId, project } = props;
  const navigate = useNavigate();
  const sources = useEnvironmentQuery(
    factoryEnvironment.listFeedSources({ environmentId, input: { projectId: project.id } }),
  );
  // One list for the whole project: the server's `open` filter would hide retracted and
  // unreviewable items, which must stay visible and labelled.
  const candidates = useEnvironmentQuery(
    factoryEnvironment.listFeedCandidates({
      environmentId,
      input: { projectId: project.id, disposition: "all" },
    }),
  );
  const canBind = useAtomValue(factoryEnvironment.bindFeedSource.permissionAtom(environmentId));
  const canUnbind = useAtomValue(factoryEnvironment.unbindFeedSource.permissionAtom(environmentId));
  const canRefresh = useAtomValue(
    factoryEnvironment.refreshFeedSource.permissionAtom(environmentId),
  );
  const canDismiss = useAtomValue(
    factoryEnvironment.setFeedCandidateDismissed.permissionAtom(environmentId),
  );
  const canAdmit = useAtomValue(
    factoryEnvironment.admitFeedCandidate.permissionAtom(environmentId),
  );
  const runAdmit = useAtomCommand(factoryEnvironment.admitFeedCandidate, {
    label: "factory feed admit",
    reportFailure: false,
  });
  const launchSettings = useFactoryLaunchModelSettings(environmentId, project);

  const [showDismissed, setShowDismissed] = useState(false);
  const [bindUrl, setBindUrl] = useState("");
  const [bindFocus, setBindFocus] = useState(0);
  const [dialog, setDialog] = useState<PendingAdmit | null>(null);
  const [admitting, setAdmitting] = useState<string | null>(null);
  const [admitFailure, setAdmitFailure] = useState<FactoryFeedFailure | null>(null);
  const admitInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = () => {
    sources.refresh();
    candidates.refresh();
  };

  const failure =
    sources.error !== null
      ? describeFactoryFeedFailure(sources.failure, sources.error)
      : candidates.error !== null
        ? describeFactoryFeedFailure(candidates.failure, candidates.error)
        : null;
  const sourceList = failure === null ? sources.data : null;
  const candidateList = failure === null ? candidates.data : null;
  const refreshing = sources.isPending || candidates.isPending;
  const repository = candidateList?.repository ?? null;

  const admit = async (
    candidate: FactoryFeedCandidate,
    target: FactoryRepository,
    options: {
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: FactoryIssueTask["runtimeMode"];
      readonly interactionMode: FactoryIssueTask["interactionMode"];
      readonly instructions: string;
      readonly baseRef?: string;
      readonly restartDeleted: boolean;
    },
  ) => {
    // The server owns deduplication; this only stops the same client double-submitting.
    if (admitInFlight.current) return;
    const input = buildFactoryFeedAdmitInput({
      commandId: CommandId.make(randomUUID()),
      projectId: project.id,
      repository: target,
      candidate,
      modelSelection: options.modelSelection,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      instructions: options.instructions,
      baseRef: options.baseRef,
      restartDeleted: options.restartDeleted,
    });
    admitInFlight.current = true;
    setAdmitting(candidateKey(candidate));
    setAdmitFailure(null);
    const result = await runAdmit({ environmentId, input }).finally(() => {
      admitInFlight.current = false;
      if (mounted.current) setAdmitting(null);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      reload();
      setDialog(null);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setAdmitFailure(describeFactoryFeedFailure(squashAtomCommandFailure(result)));
    // The failure may mean the row is stale (edited, dismissed, retracted, launched elsewhere).
    reload();
  };

  const startAdmit = (
    source: FactoryFeedSource,
    candidate: FactoryFeedCandidate,
    mode: AdmitMode,
  ) => {
    if (repository === null) return;
    setAdmitFailure(null);
    if (mode === "resume") {
      const task = candidate.task;
      if (task === null || task.status !== "launching") return;
      // The server resumes the reserved launch from its frozen intent and ignores new choices.
      void admit(candidate, repository, {
        modelSelection: task.modelSelection,
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
        instructions: "",
        restartDeleted: false,
      });
      return;
    }
    setDialog({ candidate, source, repository, restart: mode === "restart" });
  };

  const openTask = (task: FactoryIssueTask) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, task.threadId)),
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label="Item visibility"
          value={[showDismissed ? "all" : "open"]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "open" || next === "all") setShowDismissed(next === "all");
          }}
        >
          <Toggle value="open">Open</Toggle>
          <Toggle value="all">Include dismissed</Toggle>
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-2">
          {candidateList ? (
            <span className="text-muted-foreground text-xs">
              Updated <RelativeTime timestamp={candidateList.fetchedAt} />
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={reload}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <RefreshIcon size="sm" refreshing={refreshing} />
            Refresh
          </Button>
        </div>
      </div>

      {!canBind ? (
        <Alert variant="warning">
          <AlertDescription>
            This connection cannot bind or unbind feeds. Binding makes {props.environmentLabel}{" "}
            fetch the address, so it needs settings write access; items can still be reviewed.
          </AlertDescription>
        </Alert>
      ) : null}
      {!canAdmit ? (
        <Alert variant="warning">
          <AlertDescription>
            This connection cannot admit items. Admitting needs orchestration and source control
            write access; existing tasks can still be opened.
          </AlertDescription>
        </Alert>
      ) : null}
      {candidateList !== null && repository === null ? (
        <Alert variant="info">
          <AlertDescription>
            This project has no usable GitHub repository remote. Items can be reviewed, but
            admitting one needs a GitHub origin.
          </AlertDescription>
        </Alert>
      ) : null}
      {admitFailure !== null && dialog === null ? (
        <Alert variant="error">
          <AlertTitle>{admitFailure.title}</AlertTitle>
          <AlertDescription>{admitFailure.message}</AlertDescription>
        </Alert>
      ) : null}

      <FeedBindForm
        environmentId={environmentId}
        environmentLabel={props.environmentLabel}
        projectId={project.id}
        canBind={canBind}
        url={bindUrl}
        focusSignal={bindFocus}
        onUrlChange={setBindUrl}
        onChanged={reload}
      />

      {failure !== null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={failure.title}
          description={failure.message}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={reload}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
              Retry
            </Button>
          }
        />
      ) : sourceList === null || candidateList === null ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : sourceList.sources.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No feeds are bound to this project. Bind one above; its items appear here after the first
          check.
        </p>
      ) : (
        <ul className="space-y-4" aria-label="Bound feeds">
          {sourceList.sources.map((source) => (
            <FeedSourceCard
              key={source.id}
              environmentId={environmentId}
              projectId={project.id}
              source={source}
              candidates={visibleFactoryFeedCandidates(
                candidateList.candidates,
                source.id,
                showDismissed,
              )}
              dismissedHidden={
                showDismissed
                  ? 0
                  : candidateList.candidates.filter(
                      (candidate) =>
                        candidate.sourceId === source.id && candidate.disposition === "dismissed",
                    ).length
              }
              repository={repository}
              canBind={canBind}
              canUnbind={canUnbind}
              canRefresh={canRefresh}
              canDismiss={canDismiss}
              canAdmit={canAdmit}
              admittingKey={admitting}
              issuesSearch={props.issuesSearch}
              onChanged={reload}
              onRebind={(locator) => {
                setBindUrl(locator);
                setBindFocus(bindFocus + 1);
              }}
              onAdmit={(candidate, mode) => startAdmit(source, candidate, mode)}
              onOpenTask={openTask}
            />
          ))}
        </ul>
      )}

      {dialog !== null ? (
        <FactoryFeedAdmitDialog
          key={`${candidateKey(dialog.candidate)}:${dialog.candidate.revision}:${dialog.restart}`}
          environmentId={environmentId}
          candidate={dialog.candidate}
          source={dialog.source}
          restart={dialog.restart}
          projectTitle={project.title}
          repository={dialog.repository}
          settings={launchSettings}
          canAdmit={canAdmit}
          pending={admitting === candidateKey(dialog.candidate)}
          failure={admitFailure}
          onClose={() => {
            setDialog(null);
            setAdmitFailure(null);
          }}
          onSubmit={(options) => {
            if (admitFailure?.kind === "changed") return;
            void admit(dialog.candidate, dialog.repository, {
              ...options,
              runtimeMode: "approval-required",
              interactionMode: "default",
            });
          }}
        />
      ) : null}
    </div>
  );
}

function FeedBindForm(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId: EnvironmentProject["id"];
  readonly canBind: boolean;
  readonly url: string;
  /** Increments when the page wants the address field focused, e.g. to bind a source again. */
  readonly focusSignal: number;
  readonly onUrlChange: (url: string) => void;
  readonly onChanged: () => void;
}) {
  const { environmentId, projectId } = props;
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.focusSignal > 0) inputRef.current?.focus();
  }, [props.focusSignal]);
  const runBind = useAtomCommand(factoryEnvironment.bindFeedSource, {
    label: "factory feed bind",
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FactoryFeedFailure | null>(null);
  const [bound, setBound] = useState<{
    readonly locator: string;
    readonly observed: number;
  } | null>(null);

  const submit = async () => {
    if (!props.canBind || pending) return;
    const check = checkFactoryFeedUrl(props.url);
    if (!check.ok) {
      setBound(null);
      setFailure({
        kind: "other",
        title: "Feed address rejected",
        message: check.message,
        reason: null,
      });
      return;
    }
    setPending(true);
    setFailure(null);
    setBound(null);
    const result = await runBind({
      environmentId,
      input: { commandId: CommandId.make(randomUUID()), projectId, url: check.url },
    });
    setPending(false);
    // Binding is saved before the first fetch, so even a failed first check changes the list.
    props.onChanged();
    if (result._tag === "Success") {
      props.onUrlChange("");
      setBound({ locator: result.value.source.locator, observed: result.value.observed });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setFailure(describeFactoryFeedFailure(squashAtomCommandFailure(result)));
  };

  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Label htmlFor={inputId}>Feed address</Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-64 flex-1">
          <Input
            id={inputId}
            ref={inputRef}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={props.url}
            placeholder="https://example.com/feed.xml"
            disabled={!props.canBind || pending}
            aria-describedby={`${inputId}-help`}
            onChange={(event) => props.onUrlChange(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={!props.canBind || pending || props.url.trim().length === 0}
          aria-busy={pending}
        >
          {pending ? "Binding…" : "Bind feed"}
        </Button>
      </div>
      <p id={`${inputId}-help`} className="text-muted-foreground text-xs">
        {props.environmentLabel} will fetch this address itself, now and whenever you press Check
        now. Only public https:// RSS 2.0 or Atom 1.0 feeds are supported. The address is shown
        below exactly as the server stored it.
      </p>
      {failure !== null ? (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
      {bound !== null ? (
        <Alert variant="success">
          <AlertDescription>
            <span role="status" className="[overflow-wrap:anywhere]">
              Bound {factoryIssueReviewText(bound.locator)}. {bound.observed}{" "}
              {bound.observed === 1 ? "item" : "items"} observed.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}

function FeedSourceCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: EnvironmentProject["id"];
  readonly source: FactoryFeedSource;
  readonly candidates: ReadonlyArray<FactoryFeedCandidate>;
  readonly dismissedHidden: number;
  readonly repository: FactoryRepository | null;
  readonly canBind: boolean;
  readonly canUnbind: boolean;
  readonly canRefresh: boolean;
  readonly canDismiss: boolean;
  readonly canAdmit: boolean;
  readonly admittingKey: string | null;
  readonly issuesSearch: FactorySearch;
  readonly onChanged: () => void;
  readonly onRebind: (locator: string) => void;
  readonly onAdmit: (candidate: FactoryFeedCandidate, mode: AdmitMode) => void;
  readonly onOpenTask: (task: FactoryIssueTask) => void;
}) {
  const { environmentId, projectId, source } = props;
  const runRefresh = useAtomCommand(factoryEnvironment.refreshFeedSource, {
    label: "factory feed refresh",
    reportFailure: false,
  });
  const runUnbind = useAtomCommand(factoryEnvironment.unbindFeedSource, {
    label: "factory feed unbind",
    reportFailure: false,
  });
  const [busy, setBusy] = useState<"refresh" | "unbind" | null>(null);
  const [failure, setFailure] = useState<FactoryFeedFailure | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const description = describeFactoryFeedSource(source);
  const title = source.title === null || source.title.length === 0 ? source.locator : source.title;

  const check = async () => {
    if (busy !== null) return;
    setBusy("refresh");
    setFailure(null);
    setNote(null);
    const result = await runRefresh({ environmentId, input: { projectId, sourceId: source.id } });
    setBusy(null);
    // A failed check still records the error and the next allowed time.
    props.onChanged();
    if (result._tag === "Success") {
      setNote(
        result.value.notModified
          ? "Not modified since the last check."
          : `Checked. ${result.value.observed} ${result.value.observed === 1 ? "item" : "items"} observed.`,
      );
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setFailure(describeFactoryFeedFailure(squashAtomCommandFailure(result)));
  };

  const unbind = async () => {
    if (busy !== null) return;
    setBusy("unbind");
    setFailure(null);
    setNote(null);
    const result = await runUnbind({
      environmentId,
      input: { commandId: CommandId.make(randomUUID()), projectId, sourceId: source.id },
    });
    setBusy(null);
    props.onChanged();
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) return;
    setFailure(describeFactoryFeedFailure(squashAtomCommandFailure(result)));
  };

  return (
    <li className="min-w-0 space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-sm [overflow-wrap:anywhere]">
              {factoryIssueReviewText(title)}
            </h3>
            <Badge variant={description.badge.variant}>{description.badge.label}</Badge>
          </div>
          <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {factoryIssueReviewText(source.locator)}
          </p>
          <p className="text-muted-foreground text-xs">
            {source.lastCheckedAt === null ? (
              "Not checked yet."
            ) : (
              <>
                Checked <RelativeTime timestamp={source.lastCheckedAt} />
              </>
            )}
          </p>
          {description.detail !== null ? (
            <p className="text-muted-foreground text-xs">{description.detail}</p>
          ) : null}
          {source.lastError !== null ? (
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">
              Last error: {source.lastError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <CheckNowButton
            source={source}
            disabled={!props.canRefresh || busy !== null}
            pending={busy === "refresh"}
            onCheck={() => void check()}
          />
          {source.status === "active" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!props.canUnbind || busy !== null}
              aria-busy={busy === "unbind"}
              onClick={() => void unbind()}
            >
              {busy === "unbind" ? "Unbinding…" : "Unbind"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!props.canBind}
              onClick={() => props.onRebind(source.locator)}
            >
              Bind again
            </Button>
          )}
        </div>
      </div>
      {failure !== null ? (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
      {note !== null ? (
        <p role="status" className="text-muted-foreground text-xs">
          {note}
        </p>
      ) : null}
      {props.candidates.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {source.lastCheckedAt === null
            ? "No items yet. Check the feed to observe its items."
            : "No items to show."}
          {props.dismissedHidden > 0
            ? ` ${props.dismissedHidden} dismissed ${props.dismissedHidden === 1 ? "item is" : "items are"} hidden.`
            : null}
        </p>
      ) : (
        <>
          <ul className="space-y-2" aria-label={`Items from ${factoryIssueReviewText(title)}`}>
            {props.candidates.map((candidate) => (
              <FeedCandidateRow
                key={candidate.itemKey}
                environmentId={environmentId}
                projectId={projectId}
                source={source}
                candidate={candidate}
                repository={props.repository}
                canAdmit={props.canAdmit}
                canDismiss={props.canDismiss}
                admittingKey={props.admittingKey}
                issuesSearch={props.issuesSearch}
                onChanged={props.onChanged}
                onAdmit={props.onAdmit}
                onOpenTask={props.onOpenTask}
              />
            ))}
          </ul>
          {props.dismissedHidden > 0 ? (
            <p className="text-muted-foreground text-xs">
              {props.dismissedHidden} dismissed{" "}
              {props.dismissedHidden === 1 ? "item is" : "items are"} hidden.
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}

function CheckNowButton(props: {
  readonly source: FactoryFeedSource;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onCheck: () => void;
}) {
  // Only this button re-renders each second, and only to open when the server's floor passes.
  const nowMs = useNowSecond();
  const availability = factoryFeedRefreshAvailability(props.source, nowMs);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={props.disabled || availability.kind !== "ready"}
      aria-busy={props.pending}
      onClick={props.onCheck}
    >
      <RefreshIcon size="sm" refreshing={props.pending} />
      {props.pending
        ? "Checking…"
        : availability.kind === "waiting"
          ? `Check again in ${availability.label}`
          : "Check now"}
    </Button>
  );
}

function FeedCandidateRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: EnvironmentProject["id"];
  readonly source: FactoryFeedSource;
  readonly candidate: FactoryFeedCandidate;
  readonly repository: FactoryRepository | null;
  readonly canAdmit: boolean;
  readonly canDismiss: boolean;
  readonly admittingKey: string | null;
  readonly issuesSearch: FactorySearch;
  readonly onChanged: () => void;
  readonly onAdmit: (candidate: FactoryFeedCandidate, mode: AdmitMode) => void;
  readonly onOpenTask: (task: FactoryIssueTask) => void;
}) {
  const { environmentId, projectId, source, candidate } = props;
  const detailsId = useId();
  const runDismiss = useAtomCommand(factoryEnvironment.setFeedCandidateDismissed, {
    label: "factory feed dismissal",
    reportFailure: false,
  });
  const [expanded, setExpanded] = useState(false);
  // The dismissal dialog keeps the revision it was opened on, whatever the list refreshes to.
  const [dismissing, setDismissing] = useState<FactoryFeedCandidate | null>(null);
  const [pending, setPending] = useState<"dismiss" | "restore" | null>(null);
  const [failure, setFailure] = useState<FactoryFeedFailure | null>(null);

  const action = resolveFactoryFeedCandidateAction(candidate, {
    source,
    repository: props.repository,
  });
  const dismissal = resolveFactoryFeedDismissal(candidate);
  const badges = factoryFeedCandidateBadges(candidate);
  const presentation = candidate.task ? factoryTaskPresentation(candidate.task.status) : null;
  const href = candidate.link === null ? null : safeExternalUrl(candidate.link);
  const admitBusy = props.admittingKey !== null;
  const admitting = props.admittingKey === candidateKey(candidate);
  const title =
    candidate.title === null || candidate.title.length === 0
      ? null
      : factoryIssueReviewText(candidate.title);

  const setDismissed = async (target: FactoryFeedCandidate, dismissed: boolean, note?: string) => {
    if (pending !== null) return;
    setPending(dismissed ? "dismiss" : "restore");
    setFailure(null);
    const result = await runDismiss({
      environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        projectId,
        sourceId: target.sourceId,
        itemKey: target.itemKey,
        // A dismissal covers exactly the revision the reviewer saw.
        expectedRevision: target.revision,
        dismissed,
        ...(note !== undefined ? { note } : {}),
      },
    });
    setPending(null);
    props.onChanged();
    if (result._tag === "Success") {
      setDismissing(null);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setFailure(describeFactoryFeedFailure(squashAtomCommandFailure(result)));
  };

  return (
    <li className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-48 space-y-1.5">
          {title === null ? (
            <p className="text-muted-foreground text-sm">Untitled item</p>
          ) : (
            <p className="font-medium text-sm [overflow-wrap:anywhere]">{title}</p>
          )}
          {href !== null && candidate.link !== null ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-muted-foreground text-xs underline-offset-4 [overflow-wrap:anywhere] hover:underline"
            >
              {factoryIssueReviewText(candidate.link)}
            </a>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {badges.map((badge) => (
              <Badge key={badge.label} variant={badge.variant}>
                {badge.label}
              </Badge>
            ))}
            {candidate.publishedAt !== null ? (
              <span className="text-muted-foreground text-xs">
                published <RelativeTime timestamp={candidate.publishedAt} />
              </span>
            ) : null}
          </div>
          {candidate.disposition === "dismissed" && candidate.dismissalNote !== null ? (
            <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              Dismissal note: {factoryIssueReviewText(candidate.dismissalNote)}
            </p>
          ) : null}
          {presentation ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={presentation.variant}>{presentation.label}</Badge>
              <span className="text-muted-foreground text-xs">{presentation.detail}</span>
            </div>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={expanded ? detailsId : undefined}
              aria-label={`${expanded ? "Hide" : "Show"} full item`}
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDownIcon className={expanded ? "rotate-180" : undefined} />
              Details
            </Button>
            {action.kind === "admit" ? (
              <Button
                size="sm"
                disabled={!props.canAdmit || admitBusy}
                onClick={() => props.onAdmit(candidate, "admit")}
              >
                Review and admit
              </Button>
            ) : action.kind === "resume" ? (
              <Button
                size="sm"
                disabled={!props.canAdmit || admitBusy}
                aria-busy={admitting}
                onClick={() => props.onAdmit(candidate, "resume")}
              >
                {admitting ? "Resuming…" : "Resume launch"}
              </Button>
            ) : action.kind === "restart" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!props.canAdmit || admitBusy}
                onClick={() => props.onAdmit(candidate, "restart")}
              >
                New attempt…
              </Button>
            ) : action.kind === "open" ? (
              <Button size="sm" variant="outline" onClick={() => props.onOpenTask(action.task)}>
                Open thread
              </Button>
            ) : null}
            {dismissal === "dismiss" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!props.canDismiss || pending !== null}
                onClick={() => setDismissing(candidate)}
              >
                Dismiss…
              </Button>
            ) : dismissal === "restore" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!props.canDismiss || pending !== null}
                aria-busy={pending === "restore"}
                onClick={() => void setDismissed(candidate, false)}
              >
                {pending === "restore" ? "Restoring…" : "Restore"}
              </Button>
            ) : null}
          </div>
          {action.kind === "unavailable" ? (
            <p className="max-w-64 text-muted-foreground text-xs">{action.reason}</p>
          ) : null}
        </div>
      </div>
      {action.kind === "project-issue" ? (
        <p className="text-muted-foreground text-xs">
          Points at a project issue
          {candidate.forgeReference !== null ? ` (#${candidate.forgeReference.issueNumber})` : ""},
          start it from{" "}
          <Link
            to="/factory/issues"
            search={props.issuesSearch}
            className="underline underline-offset-4"
          >
            Issues
          </Link>
          .
        </p>
      ) : candidate.forgeReference !== null ? (
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
          References {candidate.forgeReference.host}/{candidate.forgeReference.repository}#
          {candidate.forgeReference.issueNumber}.
        </p>
      ) : null}
      {!candidate.inWindow ? (
        <p className="text-muted-foreground text-xs">
          The feed no longer lists this item. Absence never removes it; only the publisher can
          retract it.
        </p>
      ) : null}
      {failure !== null && dismissing === null ? (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
      {expanded ? (
        <div id={detailsId} className="min-w-0 border-border/60 border-t pt-3">
          <FactoryReviewSnapshot
            heading="Full item"
            intro="This is everything the feed published for this item."
            fields={[
              {
                label: "Title",
                text: candidate.title,
                emptyNote: "The feed title is an empty string.",
                missingNote: "The feed published no title. The source title is null.",
              },
              {
                label: "Content",
                text: candidate.content,
                emptyNote: "The feed content is an empty string.",
                missingNote: "The feed published no content. The source content is null.",
              },
              {
                label: "Link",
                text: candidate.link,
                emptyNote: "The feed link is an empty string.",
                missingNote: "The feed published no link. The source link is null.",
              },
              {
                label: "Item key",
                text: candidate.itemKey,
                emptyNote: "The item key is an empty string.",
              },
            ]}
          />
        </div>
      ) : null}
      {dismissing !== null ? (
        <FeedDismissDialog
          candidate={dismissing}
          pending={pending === "dismiss"}
          failure={failure}
          onClose={() => {
            setDismissing(null);
            setFailure(null);
          }}
          onConfirm={(note) => void setDismissed(dismissing, true, normalizeFactoryFeedText(note))}
        />
      ) : null}
    </li>
  );
}

function FeedDismissDialog(props: {
  readonly candidate: FactoryFeedCandidate;
  readonly pending: boolean;
  readonly failure: FactoryFeedFailure | null;
  readonly onClose: () => void;
  readonly onConfirm: (note: string) => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const changed = props.failure?.kind === "changed";
  const count = countFactoryFeedText(note, FACTORY_FEED_DISMISSAL_NOTE_MAX_CHARS);
  const enabled = !props.pending && !changed && !count.overLimit;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss item</DialogTitle>
          <DialogDescription>
            Hides this item from the default list. The dismissal covers the revision you reviewed:
            if the publisher edits the item, it returns for review.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={props.pending || changed} className="min-w-0 space-y-3">
            <p className="font-medium text-sm [overflow-wrap:anywhere]">
              {props.candidate.title === null || props.candidate.title.length === 0
                ? "Untitled item"
                : factoryIssueReviewText(props.candidate.title)}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor={noteId}>
                Note <span className="font-normal text-muted-foreground">optional</span>
              </Label>
              <Textarea
                id={noteId}
                value={note}
                aria-invalid={count.overLimit}
                placeholder="Why this item is not being admitted, for example a duplicate of work already tracked"
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="flex justify-end">
                <span
                  className={
                    count.overLimit ? "text-destructive text-xs" : "text-muted-foreground text-xs"
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
            staleHint="This item was edited after you reviewed it, so it is open for review again. Close this dialog and review the current item."
          />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={props.pending} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!enabled}
            aria-busy={props.pending}
            onClick={() => {
              if (enabled) props.onConfirm(note);
            }}
          >
            {props.pending ? "Dismissing…" : "Dismiss"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
