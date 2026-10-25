import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type ProjectCoordinator,
  type ProjectCoordinatorEnsureInput,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { FactoryOrchestratorDialog } from "./FactoryOrchestratorDialog";
import {
  coordinatorFailure,
  coordinatorPresentation,
  type CoordinatorFailure,
} from "./factoryCoordinatorPresentation";
import {
  factoryScopeSearchForMember,
  singleFactoryMember,
  validateFactorySearch,
} from "./factoryScope";

type CoordinatorTarget = {
  readonly member: SidebarProjectGroupMember;
  readonly group: SidebarProjectSnapshot;
};

export function FactoryOrchestratorPage() {
  const { scope, groups, search } = useSettingsScope();
  const { environments, isReady } = useEnvironments();
  const member = singleFactoryMember(scope);
  const scopeKey = JSON.stringify([search.project, search.machine, search.checkout]);
  const targets = groups.flatMap((group) =>
    group.memberProjects
      .filter((candidate) =>
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members.some(
              (selected) =>
                selected.physicalProjectKey === candidate.physicalProjectKey &&
                selected.environmentId === candidate.environmentId,
            )
          : scope.environmentIds.includes(candidate.environmentId),
      )
      .map((candidate) => ({ member: candidate, group })),
  );
  const selectedEnvironments = environments.filter((environment) =>
    scope.environmentIds.includes(environment.environmentId),
  );

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="factory-orchestrator-title">
      <div className="space-y-1">
        <h1 id="factory-orchestrator-title" className="text-lg font-semibold">
          Project orchestrator
        </h1>
        <p className="text-sm text-muted-foreground">
          One ordinary agent thread per project checkout. Opening this page or an existing thread
          sends nothing. Create and start explicitly sends a one-time orientation request.
        </p>
        <p className="text-xs text-muted-foreground">
          Use the thread's existing delegation and workflow tools for later operator requests. No
          workers or schedules are started by visiting Factory.
        </p>
      </div>
      {scope.kind === "unavailable" ? (
        <Alert variant="error">
          <AlertTitle>Unavailable selection</AlertTitle>
          <AlertDescription>{scope.message}</AlertDescription>
        </Alert>
      ) : !isReady ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading environments…
        </p>
      ) : selectedEnvironments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Connect an environment to view its project orchestrators.
        </p>
      ) : (
        <>
          {member === null ? (
            <p className="text-sm text-muted-foreground">
              Choose an exact checkout to create or resume its orchestrator. Existing threads can be
              opened below.
            </p>
          ) : null}
          {selectedEnvironments.map((environment) => (
            <CoordinatorEnvironment
              key={`${scopeKey}:${environment.environmentId}:${member?.workspaceRoot ?? "broad"}`}
              environment={environment}
              targets={targets.filter(
                (target) => target.member.environmentId === environment.environmentId,
              )}
              exactMember={member}
            />
          ))}
        </>
      )}
    </section>
  );
}

function CoordinatorEnvironment(props: {
  readonly environment: EnvironmentPresentation;
  readonly targets: ReadonlyArray<CoordinatorTarget>;
  readonly exactMember: SidebarProjectGroupMember | null;
}) {
  const { environment, targets, exactMember } = props;
  const environmentId = environment.environmentId;
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const supported = environment.serverConfig?.environment.capabilities.projectCoordinators === true;
  const session = useEnvironmentSessionState(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const queryEnabled = connected && supported && canRead;
  const getQuery = useEnvironmentQuery(
    queryEnabled && exactMember !== null
      ? factoryEnvironment.coordinatorsGet({ environmentId, input: { projectId: exactMember.id } })
      : null,
  );
  const listQuery = useEnvironmentQuery(
    queryEnabled && exactMember === null
      ? factoryEnvironment.coordinatorsList({ environmentId, input: {} })
      : null,
  );
  const query = exactMember === null ? listQuery : getQuery;
  const failure = query.error === null ? null : coordinatorFailure(query.failure);
  const unavailable = !connected
    ? "Environment offline. Reconnect to read or start an orchestrator."
    : !supported
      ? "Project orchestrators are unsupported on this server. Update the server to use this feature."
      : session.data === null && !session.hasError
        ? "Checking orchestration read permission…"
        : !canRead
          ? "Orchestration read permission required. This connection cannot read project orchestrators."
          : null;
  const loaded = queryEnabled && failure === null && query.data !== null;

  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border p-4"
      aria-label={`${environment.label} orchestrators`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 font-medium text-sm [overflow-wrap:anywhere]">
          {environment.label}
        </h2>
        {queryEnabled ? (
          <Button
            size="sm"
            variant="outline"
            disabled={query.isPending}
            aria-busy={query.isPending}
            onClick={query.refresh}
          >
            <RefreshIcon size="sm" refreshing={query.isPending} />
            Refresh
          </Button>
        ) : null}
      </div>
      {unavailable !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailable}
        </p>
      ) : failure !== null ? (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : !loaded ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading orchestrators…
        </p>
      ) : null}
      {targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No project checkouts in this scope on this environment.
        </p>
      ) : (
        targets.map(({ member, group }) => {
          const coordinator =
            exactMember === null
              ? (listQuery.data?.coordinators.find(
                  (candidate) => candidate.projectId === member.id,
                ) ?? null)
              : (getQuery.data?.coordinator ?? null);
          return (
            <div
              key={member.physicalProjectKey}
              className="min-w-0 space-y-3 rounded-lg border p-3"
            >
              <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
                <h3 className="font-medium text-sm">{group.displayName}</h3>
                <p className="text-xs text-muted-foreground">
                  {member.title} · {environment.label}
                </p>
                <p className="font-mono text-xs text-muted-foreground">{member.workspaceRoot}</p>
                {loaded ? (
                  coordinator === null ? (
                    <p className="text-sm">
                      Not created. No orientation has been requested for this checkout.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-medium">
                        {coordinatorPresentation(coordinator.status).label}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {coordinatorPresentation(coordinator.status).detail}
                      </p>
                    </>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Orchestrator state unavailable until this environment can be read.
                  </p>
                )}
              </div>
              {exactMember === null ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <Link
                        to="/factory/orchestrator"
                        search={(previous) => ({
                          ...validateFactorySearch(previous),
                          ...factoryScopeSearchForMember(member, group),
                          taskId: undefined,
                        })}
                      />
                    }
                  >
                    Choose checkout
                  </Button>
                  {loaded &&
                  coordinator !== null &&
                  coordinator.status !== "missing" &&
                  coordinator.status !== "launching" ? (
                    <OpenCoordinator
                      environmentId={environmentId}
                      threadId={coordinator.threadId}
                    />
                  ) : null}
                </div>
              ) : loaded ? (
                <ExactCoordinator
                  key={`${environmentId}:${member.id}:${member.workspaceRoot}`}
                  target={member}
                  environmentLabel={environment.label}
                  coordinator={coordinator}
                  refreshing={query.isPending}
                />
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}

function OpenCoordinator(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(scopeThreadRef(props.environmentId, props.threadId))}
        />
      }
    >
      Open thread
    </Button>
  );
}

function ExactCoordinator(props: {
  readonly target: SidebarProjectGroupMember;
  readonly environmentLabel: string;
  readonly coordinator: ProjectCoordinator | null;
  readonly refreshing: boolean;
}) {
  const { target, coordinator } = props;
  const navigate = useNavigate();
  const router = useRouter();
  const canStart = useAtomValue(
    factoryEnvironment.coordinatorsEnsure.permissionAtom(target.environmentId),
  );
  const ensure = useAtomCommand(factoryEnvironment.coordinatorsEnsure, {
    label: "project orchestrator start",
    reportFailure: false,
  });
  const [dialog, setDialog] = useState<{ readonly coordinator: ProjectCoordinator | null } | null>(
    null,
  );
  const [request, setRequest] = useState<ProjectCoordinatorEnsureInput | null>(null);
  const requestRef = useRef<ProjectCoordinatorEnsureInput | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CoordinatorFailure | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async (
    modes: Pick<
      ProjectCoordinatorEnsureInput,
      "modelSelection" | "runtimeMode" | "interactionMode"
    >,
  ) => {
    if (inFlight.current || !canStart || dialog === null || failure?.requiresReview) return;
    const input: ProjectCoordinatorEnsureInput = requestRef.current ?? {
      commandId: CommandId.make(randomUUID()),
      projectId: target.id,
      expectedThreadId: dialog.coordinator?.threadId ?? null,
      ...modes,
      ...(dialog.coordinator?.status === "missing" ? { replaceRetired: true } : {}),
      creationSource: "web",
    };
    requestRef.current = input;
    inFlight.current = true;
    setRequest(input);
    setPending(true);
    setFailure(null);
    const requestingHref = router.state.location.href;
    const result = await ensure({ environmentId: target.environmentId, input });
    inFlight.current = false;
    if (!mounted.current) return;
    setPending(false);
    if (router.state.location.href !== requestingHref) {
      setDialog(null);
      return;
    }
    if (result._tag === "Success") {
      const binding = result.value.coordinator;
      if (!binding.current || binding.projectId !== target.id || binding.status === "missing") {
        setFailure({
          title: "Review the current orchestrator",
          message:
            "This request refers to a superseded or unavailable binding. Close the dialog and review the refreshed checkout before starting again.",
          requiresReview: true,
        });
        return;
      }
      setDialog(null);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(target.environmentId, binding.threadId)),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(coordinatorFailure(squashAtomCommandFailure(result)));
    }
  };

  const review = () => {
    if (props.refreshing || inFlight.current || !canStart) return;
    requestRef.current = null;
    setRequest(null);
    setFailure(null);
    setDialog({ coordinator });
  };
  return (
    <div className="space-y-3">
      {!canStart ? (
        <p className="text-xs text-muted-foreground">
          Read-only connection. Orchestration operate permission is required to create or resume an
          orchestrator; existing threads remain readable.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {coordinator !== null &&
        coordinator.status !== "missing" &&
        coordinator.status !== "launching" ? (
          <OpenCoordinator environmentId={target.environmentId} threadId={coordinator.threadId} />
        ) : null}
        {coordinator === null ||
        coordinator.status === "missing" ||
        coordinator.status === "launching" ? (
          <Button size="sm" disabled={!canStart || props.refreshing || pending} onClick={review}>
            {coordinator === null
              ? "Create and start"
              : coordinator.status === "missing"
                ? "Replace unavailable orchestrator…"
                : "Resume start…"}
          </Button>
        ) : null}
      </div>
      {dialog !== null ? (
        <FactoryOrchestratorDialog
          target={target}
          environmentLabel={props.environmentLabel}
          coordinator={dialog.coordinator}
          request={request}
          canStart={canStart}
          pending={pending}
          failure={failure}
          onClose={() => {
            if (!inFlight.current) {
              setDialog(null);
              setFailure(null);
              requestRef.current = null;
              setRequest(null);
            }
          }}
          onSubmit={(modes) => {
            void submit(modes);
          }}
        />
      ) : null}
    </div>
  );
}
