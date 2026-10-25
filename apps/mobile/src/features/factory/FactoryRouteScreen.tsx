import type { MenuAction } from "@react-native-menu/menu";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { FactoryScheduledTasksScreen } from "../settings/SettingsScheduledTasksRouteScreen";
import { FactoryIssuesRouteScreen } from "./FactoryIssuesRouteScreen";
import { FactoryOrchestratorPanel } from "./FactoryOrchestratorPanel";
import {
  consumeFactoryWorkflowTarget,
  selectFactoryScope,
  updateFactoryInboxSelection,
  useFactoryInboxSelection,
  type FactorySection,
} from "./factory-inbox-state";

const SECTIONS: ReadonlyArray<{ readonly value: FactorySection; readonly label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "issues", label: "Issues" },
  { value: "workflows", label: "Workflows" },
  { value: "orchestrator", label: "Orchestrator" },
];

function ScopePicker({
  label,
  value,
  actions,
  onSelect,
}: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Menu actions={actions} onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value}`}
        className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      >
        <Text className="text-base text-foreground">{label}</Text>
        <Text className="min-w-0 flex-1 text-right text-sm text-foreground-muted" numberOfLines={1}>
          {value} ▾
        </Text>
      </Pressable>
    </Menu>
  );
}

function EnvironmentOverview({
  environment,
  projectId,
  section,
  onChoose,
  onWorkflow,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectId: ProjectId | null;
  readonly section: FactorySection;
  readonly onChoose: (environmentId: EnvironmentId, projectId: ProjectId) => void;
  readonly onWorkflow: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    taskId: ScheduledTaskId,
  ) => void;
}) {
  const environmentId = environment.environmentId;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const connected = environment.connection.phase === "connected";
  const config = environment.serverConfig;
  const readable = connected && config !== null && canRead;
  const coordinatorSupported = config?.environment.capabilities.projectCoordinators === true;
  const issuesSupported = config?.environment.capabilities.factoryIssues === true;
  const tasks = useEnvironmentQuery(
    readable && section === "overview"
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const coordinators = useEnvironmentQuery(
    readable && coordinatorSupported && section !== "issues"
      ? factoryEnvironment.coordinatorsList({ environmentId, input: {} })
      : null,
  );
  const projects = useProjects().filter(
    (project) =>
      !project.isScratch &&
      project.environmentId === environmentId &&
      (projectId === null || project.id === projectId),
  );
  const threads = useThreadShells();
  const unavailable = !connected
    ? "Offline. Reconnect to read current Factory data."
    : config === null
      ? "Server metadata is loading."
      : !canRead
        ? "This connection cannot read orchestration data."
        : null;
  return (
    <SettingsSection title={environment.label}>
      {unavailable ? (
        <Text className="p-4 text-sm text-danger-foreground">{unavailable}</Text>
      ) : null}
      {projects.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          {unavailable
            ? "Project metadata is unavailable."
            : "No project checkouts in this environment."}
        </Text>
      ) : (
        projects.map((project) => {
          const projectThreads = threads.filter(
            (thread) => thread.environmentId === environmentId && thread.projectId === project.id,
          );
          const running = projectThreads.filter(
            (thread) => thread.runtime?.status === "running",
          ).length;
          const workflows = tasks.error
            ? undefined
            : tasks.data?.tasks.filter((task) => task.projectId === project.id);
          const coordinator = coordinators.data?.coordinators.find(
            (entry) => entry.projectId === project.id,
          );
          const featureUnavailable =
            section === "issues" && !issuesSupported
              ? "Issue inbox unsupported by this server."
              : section === "orchestrator" && !coordinatorSupported
                ? "Orchestrators unsupported by this server."
                : null;
          return (
            <View key={project.id} className="gap-2 border-t border-border-subtle p-4">
              <Text className="text-lg font-t3-medium text-foreground">{project.title}</Text>
              <Text className="text-sm text-foreground-muted" selectable>
                {project.workspaceRoot}
              </Text>
              {readable && section === "overview" ? (
                <>
                  <Text className="text-sm text-foreground-muted">
                    {projectThreads.length} sessions · {running} running
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {tasks.error
                      ? "Workflows unavailable: could not load definitions."
                      : workflows === undefined
                        ? "Loading workflows…"
                        : `${workflows.length} workflows · ${workflows.filter((task) => task.enabled).length} enabled`}
                  </Text>
                  {workflows?.map((task) => (
                    <Button
                      key={task.id}
                      tone="text"
                      label={`${task.title} · ${task.lastRunStatus ?? "Not dispatched"}${task.lastRunAt ? ` · ${new Date(task.lastRunAt).toLocaleString()}` : ""}`}
                      onPress={() => onWorkflow(environmentId, project.id, task.id)}
                    />
                  ))}
                </>
              ) : null}
              {readable && section !== "issues" ? (
                <Text className="text-sm text-foreground-muted">
                  {!coordinatorSupported
                    ? "Orchestrators unsupported by this server."
                    : coordinators.error
                      ? "Orchestrator unavailable: could not load binding."
                      : coordinators.data === null
                        ? "Loading orchestrator…"
                        : coordinator
                          ? `Orchestrator: ${coordinator.status}`
                          : "No orchestrator created"}
                </Text>
              ) : null}
              {featureUnavailable ? (
                <Text className="text-sm text-danger-foreground">{featureUnavailable}</Text>
              ) : null}
              <Button
                label={
                  section === "issues"
                    ? "Choose this checkout for issues"
                    : section === "orchestrator"
                      ? "Choose orchestrator checkout"
                      : "Show this checkout"
                }
                disabled={unavailable !== null || featureUnavailable !== null}
                onPress={() => onChoose(environmentId, project.id)}
              />
            </View>
          );
        })
      )}
      {readable && section !== "issues" ? (
        <View className="items-start p-3">
          <Button
            tone="text"
            label="Refresh overview"
            onPress={() => {
              if (section === "overview") tasks.refresh();
              if (coordinatorSupported) coordinators.refresh();
            }}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}

export function FactoryRouteScreen() {
  const insets = useSafeAreaInsets();
  const selection = useFactoryInboxSelection();
  const { environments, isReady } = useEnvironments();
  const projects = useProjects().filter((project) => !project.isScratch);
  const selectedEnvironment =
    selection.environmentId === null
      ? null
      : (environments.find(
          (environment) => environment.environmentId === selection.environmentId,
        ) ?? null);
  const selectedProject =
    selection.projectId === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === selection.environmentId && project.id === selection.projectId,
        ) ?? null);
  const invalid =
    selection.projectId !== null && (selection.environmentId === null || selectedProject === null)
      ? "This checkout was removed or is unavailable. Select a known checkout or reset to all projects."
      : selection.environmentId !== null && selectedEnvironment === null
        ? "This environment was removed or is unavailable. Select another environment or reset the scope."
        : null;
  const scopedEnvironments =
    selection.environmentId === null
      ? environments
      : selectedEnvironment
        ? [selectedEnvironment]
        : [];
  const connected = selectedEnvironment?.connection.phase === "connected";
  const canRead = useEnvironmentScope(selection.environmentId, AuthOrchestrationReadScope);
  const exact = invalid === null && selectedEnvironment !== null && selectedProject !== null;
  const exactReadable = exact && connected && canRead && selectedEnvironment.serverConfig !== null;
  const issuesSupported =
    selectedEnvironment?.serverConfig?.environment.capabilities.factoryIssues === true;
  const coordinatorSupported =
    selectedEnvironment?.serverConfig?.environment.capabilities.projectCoordinators === true;
  const environmentActions: MenuAction[] = [
    {
      id: "all",
      title: "All environments",
      state: selection.environmentId === null ? "on" : undefined,
    },
    ...environments.map<MenuAction>((environment) => ({
      id: environment.environmentId,
      title: `${environment.label}${environment.connection.phase === "connected" ? "" : " (offline)"}`,
      state: environment.environmentId === selection.environmentId ? "on" : undefined,
    })),
  ];
  const scopeProjects = projects.filter(
    (project) =>
      selection.environmentId === null || project.environmentId === selection.environmentId,
  );
  const projectActions: MenuAction[] = [
    {
      id: "all",
      title: "All project checkouts",
      state: selection.projectId === null ? "on" : undefined,
    },
    ...scopeProjects.map<MenuAction>((project) => ({
      id: JSON.stringify([project.environmentId, project.id]),
      title: `${project.title} · ${environments.find((entry) => entry.environmentId === project.environmentId)?.label ?? "Unavailable environment"} · ${project.workspaceRoot}`,
      state:
        project.id === selection.projectId && project.environmentId === selection.environmentId
          ? "on"
          : undefined,
    })),
  ];
  const workflow = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    taskId: ScheduledTaskId,
  ) => {
    selectFactoryScope(environmentId, projectId);
    updateFactoryInboxSelection({ section: "workflows", taskId });
  };
  const sectionKey = JSON.stringify([
    selection.environmentId,
    selection.projectId,
    selection.section,
  ]);

  return (
    <SettingsScreen title="Factory">
      <View className="gap-3 px-5 pt-3 pb-2">
        <Text className="text-sm text-foreground-muted">Showing work for</Text>
        <SettingsSection>
          <ScopePicker
            label="Environment"
            value={
              selection.environmentId === null
                ? "All environments"
                : (selectedEnvironment?.label ?? "Unavailable environment")
            }
            actions={environmentActions}
            onSelect={(id) => {
              if (id === "all") selectFactoryScope(null, null);
              else {
                const environment = environments.find((entry) => entry.environmentId === id);
                if (environment) selectFactoryScope(environment.environmentId, null);
              }
            }}
          />
          <ScopePicker
            label="Checkout"
            value={
              selection.projectId === null
                ? "All project checkouts"
                : (selectedProject?.workspaceRoot ?? "Unavailable checkout")
            }
            actions={projectActions}
            onSelect={(id) => {
              if (id === "all") selectFactoryScope(selection.environmentId, null);
              else {
                const project = scopeProjects.find(
                  (entry) => JSON.stringify([entry.environmentId, entry.id]) === id,
                );
                if (project) selectFactoryScope(project.environmentId, project.id);
              }
            }}
          />
        </SettingsSection>
        <SegmentedControl<FactorySection>
          options={SECTIONS}
          selected={selection.section}
          onSelect={(section) => updateFactoryInboxSelection({ section, taskId: null })}
        />
      </View>
      {!isReady ? (
        <Text className="p-5 text-foreground-muted">Loading environments…</Text>
      ) : invalid ? (
        <View className="gap-3 p-5">
          <EmptyState variant="plain" title="Scope unavailable" detail={invalid} />
          <Button label="Show all projects" onPress={() => selectFactoryScope(null, null)} />
        </View>
      ) : selection.section === "workflows" ? (
        <FactoryScheduledTasksScreen
          key={sectionKey}
          environmentId={selection.environmentId}
          projectId={selection.projectId}
          {...(selection.taskId === null ? {} : { taskId: selection.taskId })}
          onWorkflowOpened={(taskId) => consumeFactoryWorkflowTarget(selection, taskId)}
        />
      ) : selection.section === "issues" &&
        exactReadable &&
        issuesSupported &&
        selectedProject !== null ? (
        <FactoryIssuesRouteScreen
          key={sectionKey}
          environmentId={selectedProject.environmentId}
          projectId={selectedProject.id}
        />
      ) : (
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-4 px-5 pt-3"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {environments.length === 0 ? (
            <EmptyState
              variant="plain"
              title="Connect an environment"
              detail="Connect to a server to see its projects, sessions and workflows."
            />
          ) : null}
          {selection.section === "issues" ? (
            <Text className="text-sm text-foreground-muted">
              Choose one connected, supported checkout to review its GitHub source and start issue
              work. This is not an aggregate issue queue.
            </Text>
          ) : null}
          {selection.section === "orchestrator" &&
          exactReadable &&
          coordinatorSupported &&
          selectedProject !== null ? (
            <FactoryOrchestratorPanel
              key={sectionKey}
              environmentId={selectedProject.environmentId}
              projectId={selectedProject.id}
            />
          ) : (
            scopedEnvironments.map((environment) => (
              <EnvironmentOverview
                key={environment.environmentId}
                environment={environment}
                projectId={selection.projectId}
                section={selection.section}
                onChoose={selectFactoryScope}
                onWorkflow={workflow}
              />
            ))
          )}
        </ScrollView>
      )}
    </SettingsScreen>
  );
}
