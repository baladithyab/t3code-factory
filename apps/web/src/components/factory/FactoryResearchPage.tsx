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
  type EnvironmentId,
  type FactoryRepository,
  type FactoryResearchFinding,
  type FactoryResearchImplementationAdmitInput,
  type FactoryResearchProtocol,
  type FactoryResearchProtocolId,
  type FactoryResearchProtocolReadResult,
  type FactoryResearchRunRole,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronDownIcon, FactoryIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { FactoryCheckoutChooser } from "./FactoryCheckoutChooser";
import { FactoryEmptyState } from "./FactoryEmptyState";
import { useFactoryLaunchModelSettings } from "./FactoryLaunchControls";
import { FactoryResearchAdmitDialog } from "./FactoryResearchAdmitDialog";
import { FactoryResearchLaunchDialog } from "./FactoryResearchLaunchDialog";
import { FactoryResearchSealDialog } from "./FactoryResearchSealDialog";
import {
  buildFactoryResearchAdmitInput,
  buildFactoryResearchLaunchInput,
  buildFactoryResearchSealInput,
  describeFactoryResearchFailure,
  factoryFindingPresentation,
  factoryProtocolPresentation,
  factoryRunPresentations,
  researchActionsFor,
  shortFactoryCommit,
  type FactoryArtifactRow,
  type FactoryResearchAdmitAction,
  type FactoryResearchAdmitMode,
  type FactoryResearchFailure,
  type FactoryResearchSealFields,
  type FactoryRunPresentation,
} from "./factoryResearch.logic";
import { singleFactoryMember } from "./factoryScope";

export function FactoryResearchPage() {
  const { scope, groups, selectScope } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  const allProjects = useProjects();
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
    <section className="min-w-0 space-y-5" aria-labelledby="factory-research-title">
      <div className="space-y-1">
        <h2 id="factory-research-title" className="font-medium text-lg">
          Research
        </h2>
        <p className="text-muted-foreground text-sm">
          Seal a protocol, then run explore and verification threads against it. Runs record their
          own evidence and the server reads what they cite. The finding is derived evidence: nothing
          becomes implementation work until you admit it.
        </p>
      </div>
      {member === null ? (
        <FactoryCheckoutChooser
          scope={scope}
          groups={groups}
          environments={environments}
          intro="Choose a checkout to manage its research protocols. Protocols belong to one checkout; they are not combined into a global queue."
          emptyDescription="Connect an environment and add a repository checkout to seal research protocols."
          statusFor={(owner) =>
            !owner
              ? "Environment unavailable"
              : owner.connection.phase !== "connected"
                ? "Offline. Reconnect to read research protocols"
                : owner.serverConfig === null
                  ? "Server capabilities unknown"
                  : owner.serverConfig.environment.capabilities.factoryResearch !== true
                    ? "Research runs unsupported. Update this server"
                    : "Connected · research runs available"
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
          description={`Reconnect ${environment.label} to read this checkout's research protocols.`}
        />
      ) : environment.serverConfig === null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Server capabilities unknown"
          description="Wait for this environment to finish connecting before opening its research protocols."
        />
      ) : environment.serverConfig.environment.capabilities.factoryResearch !== true ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Research runs unsupported"
          description={`Update the server on ${environment.label} to seal research protocols.`}
        />
      ) : !canRead ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="Read access unavailable"
          description="This connection needs orchestration read access to list research protocols."
        />
      ) : (
        <FactoryResearchWorkspace
          key={`${environment.environmentId}:${project.id}`}
          environmentId={environment.environmentId}
          project={project}
        />
      )}
    </section>
  );
}

/** One reload for the page: every read is explicit, so nothing polls while a run is going. */
function RefreshButton(props: { readonly pending: boolean; readonly onRefresh: () => void }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={props.onRefresh}
      disabled={props.pending}
      aria-busy={props.pending}
    >
      <RefreshIcon size="sm" refreshing={props.pending} />
      Refresh
    </Button>
  );
}

function FailureAlert(props: { readonly failure: FactoryResearchFailure }) {
  return (
    <Alert variant="error">
      <AlertTitle>{props.failure.title}</AlertTitle>
      <AlertDescription>{props.failure.message}</AlertDescription>
    </Alert>
  );
}

function FactoryResearchWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}) {
  const { environmentId, project } = props;
  const list = useEnvironmentQuery(
    factoryEnvironment.listResearchProtocols({ environmentId, input: { projectId: project.id } }),
  );
  const canSeal = useAtomValue(
    factoryEnvironment.sealResearchProtocol.permissionAtom(environmentId),
  );
  const runSeal = useAtomCommand(factoryEnvironment.sealResearchProtocol, {
    label: "factory research seal",
    reportFailure: false,
  });
  const now = Date.parse(`${useNowMinute()}Z`);

  const [selectedId, setSelectedId] = useState<FactoryResearchProtocolId | null>(null);
  const [sealRepository, setSealRepository] = useState<FactoryRepository | null>(null);
  const [sealing, setSealing] = useState(false);
  const [sealFailure, setSealFailure] = useState<FactoryResearchFailure | null>(null);
  const [sealed, setSealed] = useState<FactoryResearchProtocol | null>(null);
  // One id per open dialog: a retry after a lost response replays the persisted seal instead of
  // sealing a second protocol, and the client coalesces concurrent submits of the same attempt.
  const [sealCommandId, setSealCommandId] = useState(() => CommandId.make(randomUUID()));
  const sealInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const failure =
    list.error === null ? null : describeFactoryResearchFailure(list.failure, list.error);
  const data = failure === null ? list.data : null;

  const seal = async (fields: FactoryResearchSealFields) => {
    if (sealRepository === null || sealInFlight.current) return;
    const input = buildFactoryResearchSealInput({
      commandId: sealCommandId,
      projectId: project.id,
      repository: sealRepository,
      fields,
    });
    sealInFlight.current = true;
    setSealing(true);
    setSealFailure(null);
    const result = await runSeal({ environmentId, input }).finally(() => {
      sealInFlight.current = false;
      if (mounted.current) setSealing(false);
    });
    if (!mounted.current) return;
    // The list is read again when the command settles, whether or not it succeeded.
    if (result._tag === "Success") {
      setSealed(result.value.protocol);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setSealFailure(describeFactoryResearchFailure(squashAtomCommandFailure(result)));
  };

  const closeSeal = () => {
    setSealRepository(null);
    setSealed(null);
    setSealFailure(null);
  };

  if (selectedId !== null) {
    return (
      <FactoryResearchProtocolDetail
        key={selectedId}
        environmentId={environmentId}
        project={project}
        protocolId={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const protocols = data === null ? null : data.protocols.toSorted(compareSealedNewestFirst);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
          {data === null
            ? project.title
            : `${data.repository.host}/${data.repository.repository} · ${project.title}`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {data !== null ? (
            <span className="text-muted-foreground text-xs">
              Updated <RelativeTime timestamp={data.fetchedAt} />
            </span>
          ) : null}
          <RefreshButton pending={list.isPending} onRefresh={list.refresh} />
          <Button
            size="sm"
            disabled={!canSeal || data === null}
            onClick={() => {
              if (data === null) return;
              setSealFailure(null);
              setSealed(null);
              // A new dialog is a new sealing attempt; retries inside it replay the same one.
              setSealCommandId(CommandId.make(randomUUID()));
              // The checkout the reviewer saw when opening, even if a later read of the list fails.
              setSealRepository(data.repository);
            }}
          >
            Seal protocol
          </Button>
        </div>
      </div>
      {!canSeal ? (
        <Alert variant="warning">
          <AlertDescription>
            This connection cannot seal protocols. Sealing needs orchestration operate access;
            existing protocols can still be read.
          </AlertDescription>
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
              onClick={list.refresh}
              disabled={list.isPending}
              aria-busy={list.isPending}
            >
              <RefreshIcon size="sm" refreshing={list.isPending} />
              Retry
            </Button>
          }
        />
      ) : protocols === null ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : protocols.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No protocols are sealed for this project. Seal one to fix a hypothesis, a metric and a
          budget before any run starts.
        </p>
      ) : (
        <ul className="space-y-3" aria-label="Research protocols">
          {protocols.map((protocol) => {
            const presentation = factoryProtocolPresentation(protocol, now);
            return (
              <li key={protocol.id} className="min-w-0 space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 basis-64 space-y-1">
                    <p className="font-medium text-sm [overflow-wrap:anywhere]">
                      {factoryIssueReviewText(protocol.hypothesis)}
                    </p>
                    <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                      {presentation.metricLabel}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={presentation.budget.expired ? "outline" : "info"}>
                        {presentation.budget.label}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        {presentation.budget.runsLabel} · {presentation.budget.runMinutesLabel}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        sealed <RelativeTime timestamp={protocol.sealedAt} />
                      </span>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setSelectedId(protocol.id)}>
                    Open protocol
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {sealRepository !== null ? (
        <FactoryResearchSealDialog
          repository={sealRepository}
          projectTitle={project.title}
          canSeal={canSeal}
          pending={sealing}
          failure={sealFailure}
          sealed={sealed}
          onClose={closeSeal}
          onSubmit={(fields) => void seal(fields)}
          onOpenProtocol={(protocol) => {
            closeSeal();
            setSelectedId(protocol.id);
          }}
        />
      ) : null}
    </div>
  );
}

function compareSealedNewestFirst(left: FactoryResearchProtocol, right: FactoryResearchProtocol) {
  return Date.parse(right.sealedAt) - Date.parse(left.sealedAt) || right.id.localeCompare(left.id);
}

/** What each admit mode's button says; only `admit` and `restart` open a review dialog. */
const ADMIT_LABELS: Record<FactoryResearchAdmitMode, string> = {
  admit: "Admit implementation",
  resume: "Resume implementation launch",
  restart: "Start new attempt…",
  open: "Open implementation thread",
};

/**
 * `commandId` is chosen when a dialog opens and reused by every submit from it, so a retry after
 * an interrupted launch resumes the same reserved task instead of reserving another.
 */
type PendingDialog =
  | {
      readonly kind: "launch";
      readonly commandId: CommandId;
      readonly role: Extract<FactoryResearchRunRole, "explore" | "verify">;
      readonly protocol: FactoryResearchProtocol;
      readonly targetCommit: string | null;
      readonly repository: FactoryRepository;
    }
  | {
      readonly kind: "admit";
      readonly commandId: CommandId;
      readonly protocol: FactoryResearchProtocol;
      readonly finding: FactoryResearchFinding;
      readonly repository: FactoryRepository;
      readonly restart: boolean;
    };

function FactoryResearchProtocolDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly protocolId: FactoryResearchProtocolId;
  readonly onBack: () => void;
}) {
  const { environmentId, project, protocolId } = props;
  const navigate = useNavigate();
  const read = useEnvironmentQuery(
    factoryEnvironment.readResearchProtocol({
      environmentId,
      input: { projectId: project.id, protocolId },
    }),
  );
  const canLaunch = useAtomValue(
    factoryEnvironment.launchResearchRun.permissionAtom(environmentId),
  );
  const canAdmit = useAtomValue(
    factoryEnvironment.admitResearchImplementation.permissionAtom(environmentId),
  );
  const runLaunch = useAtomCommand(factoryEnvironment.launchResearchRun, {
    label: "factory research launch",
    reportFailure: false,
  });
  const runAdmit = useAtomCommand(factoryEnvironment.admitResearchImplementation, {
    label: "factory research admit",
    reportFailure: false,
  });
  const launchSettings = useFactoryLaunchModelSettings(environmentId, project);
  // Minute precision is enough: it only decides whether the sealed window is still open.
  const now = Date.parse(`${useNowMinute()}Z`);

  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<FactoryResearchFailure | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const readFailure =
    read.error === null ? null : describeFactoryResearchFailure(read.failure, read.error);
  const data: FactoryResearchProtocolReadResult | null = readFailure === null ? read.data : null;

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  // Both commands read the protocol again when they settle, so a success or failure here never
  // leaves the page showing the revision it was opened on.
  const launch = async (
    pending: Extract<PendingDialog, { kind: "launch" }>,
    options: { readonly modelSelection: ModelSelection; readonly instructions: string },
  ) => {
    // The server owns deduplication; this only stops the same client double-submitting.
    if (inFlight.current) return;
    const input = buildFactoryResearchLaunchInput({
      commandId: pending.commandId,
      projectId: project.id,
      repository: pending.repository,
      protocol: pending.protocol,
      role: pending.role,
      targetCommit: pending.targetCommit,
      modelSelection: options.modelSelection,
      instructions: options.instructions,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    inFlight.current = true;
    setSubmitting(true);
    setFailure(null);
    const result = await runLaunch({ environmentId, input }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      setDialog(null);
      openThread(result.value.threadId);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setFailure(describeFactoryResearchFailure(squashAtomCommandFailure(result)));
  };

  const admit = async (
    pending: Extract<PendingDialog, { kind: "admit" }>,
    options: {
      readonly modelSelection: ModelSelection;
      readonly instructions: string;
      readonly runtimeMode: FactoryResearchImplementationAdmitInput["runtimeMode"];
      readonly interactionMode: FactoryResearchImplementationAdmitInput["interactionMode"];
    },
  ) => {
    if (inFlight.current) return;
    const input = buildFactoryResearchAdmitInput({
      commandId: pending.commandId,
      projectId: project.id,
      repository: pending.repository,
      protocolId: pending.protocol.id,
      finding: pending.finding,
      modelSelection: options.modelSelection,
      instructions: options.instructions,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      restartDeleted: pending.restart,
    });
    inFlight.current = true;
    setSubmitting(true);
    setFailure(null);
    const result = await runAdmit({ environmentId, input }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      setDialog(null);
      openThread(result.value.threadId);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setFailure(describeFactoryResearchFailure(squashAtomCommandFailure(result)));
  };

  const startAdmit = (
    snapshot: FactoryResearchProtocolReadResult,
    action: FactoryResearchAdmitAction,
  ) => {
    const { task } = action;
    setFailure(null);
    if (action.mode === "open") {
      if (task !== null) openThread(task.threadId);
      return;
    }
    const pending = {
      kind: "admit",
      commandId: CommandId.make(randomUUID()),
      protocol: snapshot.protocol,
      finding: snapshot.finding,
      repository: snapshot.repository,
      restart: action.mode === "restart",
    } as const;
    if (action.mode === "resume" && task !== null) {
      // The server resumes the reserved launch from its frozen intent and ignores new choices.
      void admit(pending, {
        modelSelection: task.modelSelection,
        instructions: "",
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
      });
      return;
    }
    setDialog(pending);
  };

  const actions =
    data === null
      ? null
      : researchActionsFor(data.protocol, data.finding, data.runs, { canLaunch, canAdmit }, now);

  const closeDialog = () => {
    setDialog(null);
    setFailure(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button size="sm" variant="ghost" onClick={props.onBack}>
          <ArrowLeftIcon />
          All protocols
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {data !== null ? (
            <span className="text-muted-foreground text-xs">
              Updated <RelativeTime timestamp={data.fetchedAt} />
            </span>
          ) : null}
          <RefreshButton pending={read.isPending} onRefresh={read.refresh} />
        </div>
      </div>
      {failure !== null && dialog === null ? <FailureAlert failure={failure} /> : null}
      {readFailure !== null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={readFailure.title}
          description={readFailure.message}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={read.refresh}
              disabled={read.isPending}
              aria-busy={read.isPending}
            >
              <RefreshIcon size="sm" refreshing={read.isPending} />
              Retry
            </Button>
          }
        />
      ) : data === null || actions === null ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          <ProtocolSummary protocol={data.protocol} now={now} />
          <section className="space-y-2" aria-labelledby="factory-research-actions-title">
            <h3 id="factory-research-actions-title" className="font-medium text-sm">
              Runs and promotion
            </h3>
            <div className="flex flex-wrap items-start gap-4">
              <ActionButton
                label="Launch explore"
                variant="default"
                action={actions.launchExplore}
                busy={submitting}
                onClick={() =>
                  setDialog({
                    kind: "launch",
                    commandId: CommandId.make(randomUUID()),
                    role: "explore",
                    protocol: data.protocol,
                    targetCommit: null,
                    repository: data.repository,
                  })
                }
              />
              <ActionButton
                label="Launch verify"
                variant="outline"
                action={actions.launchVerify}
                busy={submitting}
                detail={
                  actions.launchVerify.targetCommit === null
                    ? null
                    : `On commit ${shortFactoryCommit(actions.launchVerify.targetCommit)}`
                }
                onClick={() =>
                  setDialog({
                    kind: "launch",
                    commandId: CommandId.make(randomUUID()),
                    role: "verify",
                    protocol: data.protocol,
                    targetCommit: actions.launchVerify.targetCommit,
                    repository: data.repository,
                  })
                }
              />
              <ActionButton
                label={ADMIT_LABELS[actions.admitImplementation.mode]}
                variant="outline"
                action={actions.admitImplementation}
                busy={submitting}
                onClick={() => startAdmit(data, actions.admitImplementation)}
              />
            </div>
          </section>
          <FindingBlock protocol={data.protocol} finding={data.finding} onOpenThread={openThread} />
          <RunsTable protocol={data.protocol} data={data} onOpenThread={openThread} />
        </>
      )}
      {dialog?.kind === "launch" ? (
        <FactoryResearchLaunchDialog
          key={`${dialog.role}:${dialog.protocol.revision}:${dialog.targetCommit ?? ""}`}
          environmentId={environmentId}
          role={dialog.role}
          protocol={dialog.protocol}
          targetCommit={dialog.targetCommit}
          projectTitle={project.title}
          repository={dialog.repository}
          settings={launchSettings}
          canLaunch={canLaunch}
          pending={submitting}
          failure={failure}
          onClose={closeDialog}
          onSubmit={(options) => {
            if (failure?.kind === "changed") return;
            void launch(dialog, options);
          }}
        />
      ) : null}
      {dialog?.kind === "admit" ? (
        <FactoryResearchAdmitDialog
          key={`${dialog.protocol.id}:${dialog.finding.revision}:${dialog.restart}`}
          environmentId={environmentId}
          protocol={dialog.protocol}
          finding={dialog.finding}
          projectTitle={project.title}
          repository={dialog.repository}
          settings={launchSettings}
          canAdmit={canAdmit}
          restart={dialog.restart}
          pending={submitting}
          failure={failure}
          onClose={closeDialog}
          onSubmit={(options) => {
            if (failure?.kind === "changed") return;
            void admit(dialog, {
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

function ActionButton(props: {
  readonly label: string;
  readonly variant: "default" | "outline";
  readonly action: { readonly enabled: boolean; readonly reason: string | null };
  /** True while another request from this page is in flight. */
  readonly busy: boolean;
  readonly detail?: string | null;
  readonly onClick: () => void;
}) {
  return (
    <div className="max-w-64 space-y-1">
      <Button
        size="sm"
        variant={props.variant}
        disabled={!props.action.enabled || props.busy}
        onClick={props.onClick}
      >
        {props.label}
      </Button>
      {props.detail !== undefined && props.detail !== null ? (
        <p className="text-muted-foreground text-xs">{props.detail}</p>
      ) : null}
      {props.action.reason !== null ? (
        <p className="text-muted-foreground text-xs">{props.action.reason}</p>
      ) : null}
    </div>
  );
}

function Detail(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="font-medium text-xs">{props.label}</dt>
      <dd
        className={
          props.mono === true
            ? "font-mono text-xs [overflow-wrap:anywhere]"
            : "text-sm [overflow-wrap:anywhere]"
        }
      >
        {props.children}
      </dd>
    </div>
  );
}

/** The sealed protocol, read-only: nothing here can be edited, only replaced by a new protocol. */
function ProtocolSummary(props: {
  readonly protocol: FactoryResearchProtocol;
  readonly now: number;
}) {
  const { protocol } = props;
  const presentation = factoryProtocolPresentation(protocol, props.now);
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border p-3"
      aria-labelledby="factory-research-protocol-title"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="factory-research-protocol-title" className="font-medium text-sm">
          Sealed protocol
        </h3>
        <Badge variant={presentation.budget.expired ? "outline" : "info"}>
          {presentation.budget.label}
        </Badge>
        <span className="text-muted-foreground text-xs">
          sealed <RelativeTime timestamp={protocol.sealedAt} />
        </span>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-0.5 sm:col-span-2">
          <dt className="font-medium text-xs">Hypothesis</dt>
          <dd className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
            {factoryIssueReviewText(protocol.hypothesis)}
          </dd>
        </div>
        <Detail label="Run command" mono>
          {factoryIssueReviewText(protocol.runCommand)}
        </Detail>
        <Detail label="Base commit" mono>
          {protocol.baseCommit}
        </Detail>
        <Detail label="Metric">{presentation.metricLabel}</Detail>
        <Detail label="Decision rule">{presentation.ruleLabel}</Detail>
        <Detail label="Budget">
          {presentation.budget.runsLabel} · {presentation.budget.runMinutesLabel} · closes{" "}
          {protocol.budget.expiresAt}
        </Detail>
        <Detail label="Revision" mono>
          {protocol.revision}
        </Detail>
        <div className="min-w-0 space-y-1 sm:col-span-2">
          <dt className="font-medium text-xs">Evaluators</dt>
          <dd>
            <ul className="space-y-1" aria-label="Sealed evaluators">
              {presentation.evaluators.map((evaluator) => (
                <li key={evaluator.path} className="font-mono text-xs [overflow-wrap:anywhere]">
                  {factoryIssueReviewText(evaluator.path)}{" "}
                  <span className="text-muted-foreground">blob {evaluator.blobOid}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function FindingBlock(props: {
  readonly protocol: FactoryResearchProtocol;
  readonly finding: FactoryResearchFinding;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const presentation = factoryFindingPresentation(props.finding, props.protocol.metric);
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border p-3"
      aria-labelledby="factory-research-finding-title"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="factory-research-finding-title" className="font-medium text-sm">
          Finding
        </h3>
        <Badge variant={presentation.variant}>{presentation.statusLabel}</Badge>
        <span className="text-muted-foreground text-xs">derived on every read</span>
      </div>
      {presentation.reasons.length > 0 ? (
        <ul
          className="list-disc space-y-1 pl-5 text-sm"
          aria-label="Why the finding is not supported"
        >
          {presentation.reasons.map(({ reason, text }) => (
            <li key={reason}>{text}</li>
          ))}
        </ul>
      ) : null}
      <ul className="grid gap-3 sm:grid-cols-3" aria-label="Measured values">
        {presentation.values.map((row) => (
          <li key={row.key} className="min-w-0 space-y-0.5 rounded-lg border border-border/60 p-2">
            <p className="font-medium text-xs">{row.label}</p>
            <p className="font-mono text-sm">{row.value}</p>
            {row.effect !== null ? (
              <p className="text-muted-foreground text-xs">{row.effect}</p>
            ) : null}
            {row.threadId !== null ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (row.threadId !== null) props.onOpenThread(row.threadId);
                }}
              >
                Open thread
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Detail label="Selected commit" mono>
          {presentation.selectedCommit ?? "None selected"}
        </Detail>
        <Detail label="Minimum effect">
          {presentation.minimumEffect} · {presentation.direction}
        </Detail>
        <Detail label="Finding revision" mono>
          {props.finding.revision}
        </Detail>
      </dl>
      <p className="text-muted-foreground text-xs">{presentation.varianceNote}</p>
    </section>
  );
}

function RunsTable(props: {
  readonly protocol: FactoryResearchProtocol;
  readonly data: FactoryResearchProtocolReadResult;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const rows = factoryRunPresentations(props.data.runs, props.protocol);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <section className="min-w-0 space-y-2" aria-labelledby="factory-research-runs-title">
      <h3 id="factory-research-runs-title" className="font-medium text-sm">
        Runs
      </h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No runs yet. Launch an explore run to measure the baseline and try a change.
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table aria-label="Research runs">
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Thread</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Commit</TableHead>
                <TableHead>Metric</TableHead>
                <TableHead>Usage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <RunRows
                  key={row.key}
                  row={row}
                  open={expanded.has(row.key)}
                  onToggle={() => toggle(row.key)}
                  onOpenThread={props.onOpenThread}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function RunRows(props: {
  readonly row: FactoryRunPresentation;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const observation = row.observation;
  const detailsId = `factory-research-run-${row.key}`;
  return (
    <Fragment>
      <TableRow>
        <TableCell className="align-top">
          {row.roleLabel}
          {row.staleRevision ? (
            <span className="block text-muted-foreground text-xs">older protocol revision</span>
          ) : null}
        </TableCell>
        <TableCell className="align-top">
          <Button size="sm" variant="ghost" onClick={() => props.onOpenThread(row.threadId)}>
            Open thread
          </Button>
        </TableCell>
        <TableCell className="align-top">
          <Badge variant={row.task.variant}>{row.task.label}</Badge>
        </TableCell>
        <TableCell className="align-top">
          {observation === null ? (
            <span className="text-muted-foreground">
              {row.recordsEvidence ? "Awaiting evidence" : "Not applicable"}
            </span>
          ) : (
            <div className="space-y-1">
              <Badge variant={observation.variant}>{observation.dispositionLabel}</Badge>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={props.open}
                aria-controls={props.open ? detailsId : undefined}
                onClick={props.onToggle}
              >
                <ChevronDownIcon className={props.open ? "rotate-180" : undefined} />
                Details
              </Button>
            </div>
          )}
        </TableCell>
        <TableCell className="align-top">
          <span className="font-mono">
            {row.commit === null ? "Not recorded" : shortFactoryCommit(row.commit)}
          </span>
        </TableCell>
        <TableCell className="align-top">
          <span className="font-mono">{observation?.metric ?? "Not recorded"}</span>
        </TableCell>
        <TableCell className="align-top">{observation?.usage ?? "Not recorded"}</TableCell>
      </TableRow>
      {props.open && observation !== null ? (
        <TableRow id={detailsId}>
          <TableCell colSpan={7} className="whitespace-normal">
            <RunEvidence
              commit={row.commit}
              reasons={observation.reasons}
              missing={observation.missing}
              artifacts={observation.artifacts}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

function RunEvidence(props: {
  readonly commit: string | null;
  readonly reasons: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<FactoryArtifactRow>;
}) {
  return (
    <div className="min-w-0 space-y-3">
      {props.commit !== null ? (
        <p className="font-mono text-xs [overflow-wrap:anywhere]">Commit {props.commit}</p>
      ) : null}
      {props.reasons.length > 0 ? (
        <ul
          className="list-disc space-y-1 pl-5 text-sm"
          aria-label="Why this evidence was not accepted"
        >
          {props.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {props.missing.length > 0 ? (
        <div className="space-y-1">
          <h4 className="font-medium text-xs">The run reported these as missing</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {props.missing.map((item) => (
              <li key={item} className="[overflow-wrap:anywhere]">
                {factoryIssueReviewText(item)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {props.artifacts.length === 0 ? (
        <p className="text-muted-foreground text-xs">The run cited no files.</p>
      ) : (
        <ul className="space-y-2" aria-label="Cited artifacts">
          {props.artifacts.map((artifact) => (
            <li
              key={artifact.key}
              className="min-w-0 space-y-1 rounded-lg border border-border/60 p-2"
            >
              <p className="font-mono text-xs [overflow-wrap:anywhere]">
                {factoryIssueReviewText(artifact.path)}:{artifact.line}
              </p>
              <p className="font-mono text-muted-foreground text-xs [overflow-wrap:anywhere]">
                sha256 {artifact.sha256}
              </p>
              <p className="text-muted-foreground text-xs">
                {artifact.bytes} bytes · {artifact.retentionLabel}
              </p>
              {artifact.lineText === null ? (
                <p className="text-muted-foreground text-xs">The cited line does not exist.</p>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
                  {factoryIssueReviewText(artifact.lineText)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
