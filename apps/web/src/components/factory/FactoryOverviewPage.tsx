import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  type ScheduledTask,
} from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useEnvironmentShellStatus } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { factoryScopeSearchForMember } from "./factoryScope";

type Checkout = {
  readonly group: SidebarProjectSnapshot;
  readonly member: SidebarProjectGroupMember;
};

export function FactoryOverviewPage() {
  const { scope, groups } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  if (scope.kind === "unavailable") return null;
  const relevantEnvironments = environments.filter((environment) =>
    scope.environmentIds.includes(environment.environmentId),
  );
  const checkouts = groups.flatMap((group) =>
    group.memberProjects.flatMap((member) => {
      const included =
        scope.kind === "project" || scope.kind === "checkout"
          ? scope.members.some(
              (selected) => selected.physicalProjectKey === member.physicalProjectKey,
            )
          : scope.environmentIds.includes(member.environmentId);
      return included ? [{ group, member }] : [];
    }),
  );
  return (
    <section className="min-w-0 space-y-6" aria-labelledby="factory-overview-title">
      <div className="space-y-1">
        <h2 id="factory-overview-title" className="font-medium text-lg">
          Overview
        </h2>
        <p className="text-muted-foreground text-sm">
          Projects, sessions and scheduled agent prompts in this scope. Workflow status is the
          latest dispatch, not a completion signal or run history.
        </p>
      </div>
      {!isReady ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading environments…
        </p>
      ) : relevantEnvironments.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Connect an environment to see your projects and work.
        </p>
      ) : (
        relevantEnvironments.map((environment) => (
          <FactoryOverviewEnvironment
            key={environment.environmentId}
            environment={environment}
            checkouts={checkouts.filter(
              ({ member }) => member.environmentId === environment.environmentId,
            )}
          />
        ))
      )}
    </section>
  );
}

function FactoryOverviewEnvironment({
  environment,
  checkouts,
}: {
  readonly environment: EnvironmentPresentation;
  readonly checkouts: ReadonlyArray<Checkout>;
}) {
  const search = useSearch({ from: "/_chat/factory" });
  const session = useEnvironmentSessionState(environment.environmentId);
  const shellStatus = useEnvironmentShellStatus(environment.environmentId);
  const threads = useQuietThreadShells();
  const connected = environment.connection.phase === "connected";
  const canRead =
    session.data !== null &&
    !session.hasError &&
    sessionGrantsScope(session.data, AuthOrchestrationReadScope);
  const readable = connected && environment.serverConfig !== null && canRead;
  const coordinatorSupported =
    environment.serverConfig?.environment.capabilities.projectCoordinators === true;
  const workflows = useEnvironmentQuery(
    readable
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const coordinators = useEnvironmentQuery(
    readable && coordinatorSupported
      ? factoryEnvironment.coordinatorsList({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const accessMessage = !connected
    ? "Offline. Reconnect to load current work."
    : environment.serverConfig === null
      ? "Server capabilities unknown."
      : session.hasError
        ? "Connection permissions unavailable."
        : session.data === null
          ? "Loading connection permissions…"
          : !canRead
            ? "Read access denied for this connection."
            : null;
  const inventoryLive = readable && shellStatus === "live";
  const workflowMessage =
    accessMessage ??
    (workflows.error !== null
      ? `Workflows unavailable: ${workflows.error}`
      : workflows.data === null
        ? "Loading workflows…"
        : null);
  const coordinatorMessage =
    accessMessage ??
    (!coordinatorSupported
      ? "Project orchestrators unsupported by this server."
      : coordinators.error !== null
        ? `Orchestrators unavailable: ${coordinators.error}`
        : coordinators.data === null
          ? "Loading orchestrators…"
          : null);

  return (
    <section className="space-y-3" aria-label={`${environment.label} work`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{environment.label}</h3>
        {readable ? (
          <Button
            size="sm"
            variant="outline"
            disabled={workflows.isPending || coordinators.isPending}
            onClick={() => {
              workflows.refresh();
              if (coordinatorSupported) coordinators.refresh();
            }}
          >
            Refresh
          </Button>
        ) : null}
      </div>
      {accessMessage !== null ? (
        <p role="status" className="text-muted-foreground text-sm">
          {accessMessage}
        </p>
      ) : null}
      {checkouts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {inventoryLive
            ? "No project checkouts in this scope."
            : "Project inventory unavailable until this environment is connected and synchronized."}
        </p>
      ) : (
        checkouts.map(({ member, group }) => {
          const exactSearch = {
            ...search,
            ...factoryScopeSearchForMember(member, group),
            taskId: undefined,
          };
          const projectThreads = threads.filter(
            (thread) =>
              thread.environmentId === environment.environmentId &&
              thread.projectId === member.id &&
              thread.deletedAt === null,
          );
          const tasks =
            workflowMessage === null
              ? workflows.data?.tasks.filter((task) => task.projectId === member.id)
              : undefined;
          const coordinator =
            coordinatorMessage === null
              ? coordinators.data?.coordinators.find((item) => item.projectId === member.id)
              : undefined;
          return (
            <article
              key={member.physicalProjectKey}
              className="min-w-0 space-y-4 rounded-lg border p-4"
            >
              <div className="space-y-1">
                <Link
                  to="/factory"
                  search={exactSearch}
                  className="font-medium text-sm underline-offset-4 hover:underline"
                >
                  {group.displayName}
                </Link>
                <p className="text-muted-foreground text-xs">{environment.label}</p>
                <p className="break-all text-muted-foreground text-xs">{member.workspaceRoot}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <h4 className="font-medium text-xs">Sessions</h4>
                  <p className="text-muted-foreground text-sm">
                    {inventoryLive
                      ? `${projectThreads.length} ${projectThreads.length === 1 ? "thread" : "threads"} · ${projectThreads.filter((thread) => threadRuntimeIsActive(thread.runtime)).length} running`
                      : "Current thread and running counts unavailable."}
                  </p>
                </div>
                <div className="space-y-1">
                  <h4 className="font-medium text-xs">Project orchestrator</h4>
                  <p className="text-muted-foreground text-sm">
                    {coordinatorMessage ?? (coordinator ? coordinator.status : "Not created")}
                  </p>
                  {coordinatorMessage === null ? (
                    coordinator &&
                    coordinator.status !== "missing" &&
                    coordinator.status !== "launching" ? (
                      <Link
                        to="/$environmentId/$threadId"
                        params={buildThreadRouteParams(
                          scopeThreadRef(environment.environmentId, coordinator.threadId),
                        )}
                        className="text-sm underline underline-offset-4"
                      >
                        Open orchestrator
                      </Link>
                    ) : (
                      <Link
                        to="/factory/orchestrator"
                        search={exactSearch}
                        className="text-sm underline underline-offset-4"
                      >
                        {coordinator?.status === "launching"
                          ? "Review orchestrator startup"
                          : coordinator
                            ? "Review missing orchestrator"
                            : "Set up orchestrator"}
                      </Link>
                    )
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                <Link
                  to="/factory/workflows"
                  search={exactSearch}
                  className="font-medium text-sm underline-offset-4 hover:underline"
                >
                  Workflows{tasks !== undefined ? ` · ${tasks.length}` : ""}
                </Link>
                {workflowMessage !== null ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    {workflowMessage}
                  </p>
                ) : tasks?.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No scheduled workflows.</p>
                ) : (
                  <ul className="space-y-2">
                    {tasks?.map((task) => (
                      <li
                        key={task.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
                      >
                        <Link
                          to="/factory/workflows"
                          search={{ ...exactSearch, taskId: task.id }}
                          className="min-w-0 break-words underline underline-offset-4"
                        >
                          {task.title}
                        </Link>
                        <span className="text-muted-foreground text-xs">
                          {task.enabled ? "Enabled" : "Paused"} · {latestDispatchLabel(task)}
                          {task.lastRunAt !== null ? (
                            <>
                              {" "}
                              · <RelativeTime timestamp={task.lastRunAt} />
                            </>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Link
                  to="/factory/issues"
                  search={exactSearch}
                  className="inline-block text-sm underline underline-offset-4"
                >
                  Open issue inbox
                </Link>
                {environment.serverConfig?.environment.capabilities.factoryFeeds === true ? (
                  <Link
                    to="/factory/sources"
                    search={exactSearch}
                    className="inline-block text-sm underline underline-offset-4"
                  >
                    Open feed sources
                  </Link>
                ) : null}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}

function latestDispatchLabel(task: ScheduledTask): string {
  switch (task.lastRunStatus) {
    case "never":
      return "Never dispatched";
    case "running":
      return "Dispatching";
    case "succeeded":
      return "Dispatch accepted";
    case "failed":
      return "Dispatch failed";
  }
}
