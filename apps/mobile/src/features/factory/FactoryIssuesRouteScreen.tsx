import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MenuAction } from "@react-native-menu/menu";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryIssue,
  type ProjectId,
} from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { environmentServerConfigsAtom } from "../../state/server";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import {
  selectFactoryInboxProject,
  updateFactoryInboxSelection,
  useFactoryInboxSelection,
} from "./factory-inbox-state";
import { FactoryIssueRow } from "./FactoryIssueRow";
import { FactoryIssueReviewModal } from "./FactoryIssueReviewModal";
import {
  describeFactoryFailure,
  FACTORY_ISSUE_FILTERS,
  FACTORY_SUPERVISION_NOTICE,
  factoryRepositoryLabel,
  resolveFactoryInboxTarget,
  safeFactoryIssueUrl,
  type FactoryIssueFilter,
} from "./factoryIssues";
import { useFactoryIssueActions } from "./useFactoryIssueActions";
import { useFactoryIssueList } from "./useFactoryIssueList";
import { useFactoryLaunchModel } from "./useFactoryLaunch";

type FactoryRoutes = {
  SettingsFactoryModel: undefined;
  SettingsFactoryBranch: undefined;
};

const NO_PERMISSION_ATOM = Atom.make(false).pipe(Atom.keepAlive);

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
  const content = (
    <>
      <Text className="text-lg text-foreground">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
    </>
  );
  const className = props.borderTop
    ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
    : "min-h-14 flex-row items-center gap-3 px-4 py-3";
  if (props.actions.length < 2) return <View className={className}>{content}</View>;
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={`${className} active:opacity-70`}
      >
        {content}
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.value}`}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text className="text-lg text-foreground">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

function StateMessage(props: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}) {
  return (
    <View className="py-6">
      <EmptyState variant="plain" title={props.title} detail={props.detail} action={props.action} />
    </View>
  );
}

export function FactoryIssuesRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<FactoryRoutes>>();
  const isFocused = useIsFocused();
  const { availableTargets, selectedProjectKey, projectGroups } = useSettingsEnvironmentFilter();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selection = useFactoryInboxSelection();
  const allProjects = useProjects();

  const environments = useMemo(
    () =>
      availableTargets.map((target) => ({
        environmentId: target.environmentId,
        label: target.label,
        supported:
          configs.get(target.environmentId)?.environment.capabilities.factoryIssues === true,
      })),
    [availableTargets, configs],
  );
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const hints = useMemo(
    () =>
      selectedGroup?.members.map((member) => ({
        environmentId: member.project.environmentId,
        projectId: member.project.id,
      })) ?? [],
    [selectedGroup],
  );
  const everyProject = useMemo(
    () =>
      allProjects
        .filter(
          (project) =>
            !project.isScratch &&
            environments.some((entry) => entry.environmentId === project.environmentId),
        )
        .map((project) => ({ environmentId: project.environmentId, projectId: project.id })),
    [allProjects, environments],
  );
  const resolved = resolveFactoryInboxTarget<EnvironmentId, ProjectId>({
    environments,
    projects: everyProject,
    preferred: { environmentId: selection.environmentId, projectId: selection.projectId },
    hints,
  });
  const environmentId = resolved.environmentId;
  const projectId = resolved.projectId;

  // The pickers read the stored selection, so keep it equal to what this screen resolved.
  useEffect(() => {
    if (environmentId === selection.environmentId && projectId === selection.projectId) return;
    if (environmentId !== null && projectId !== null) {
      selectFactoryInboxProject(environmentId, projectId);
    } else {
      updateFactoryInboxSelection({ environmentId, projectId });
    }
  }, [environmentId, projectId, selection.environmentId, selection.projectId]);

  const environment = environments.find((entry) => entry.environmentId === environmentId) ?? null;
  const supported = environment?.supported === true;
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canStart = useAtomValue(
    environmentId === null
      ? NO_PERMISSION_ATOM
      : factoryEnvironment.start.permissionAtom(environmentId),
  );
  const listActive = supported && canRead;
  const list = useFactoryIssueList({
    environmentId: listActive ? environmentId : null,
    projectId: listActive ? projectId : null,
    filter: selection.filter,
  });
  const launch = useFactoryLaunchModel({ ...selection, environmentId, projectId });
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) => !project.isScratch && project.environmentId === environmentId,
      ),
    [allProjects, environmentId],
  );

  const settings = useMemo(
    () =>
      environmentId !== null && projectId !== null
        ? {
            environmentId,
            projectId,
            repository: list.repository,
            modelSelection: launch.modelSelection,
            modelLabel: launch.label ?? "Default model",
            baseRef: selection.baseRef,
            runtimeMode: selection.runtimeMode,
          }
        : null,
    [
      environmentId,
      projectId,
      list.repository,
      launch.modelSelection,
      launch.label,
      selection.baseRef,
      selection.runtimeMode,
    ],
  );
  const { refresh } = list;
  const actions = useFactoryIssueActions({
    settings,
    scopeKey:
      isFocused && list.requestKey !== null ? JSON.stringify([list.requestKey, canStart]) : null,
    onSettled: () => void refresh(),
  });

  const project = projects.find((entry) => entry.id === projectId) ?? null;
  const failure = list.error ? describeFactoryFailure(list.error, "Couldn't load issues") : null;
  const repositoryUrl = list.repository ? safeFactoryIssueUrl(list.repository.url) : null;

  const renderIssues = (issues: ReadonlyArray<FactoryIssue>) => (
    <SettingsSection>
      {issues.map((issue, index) => (
        <FactoryIssueRow
          key={issue.number}
          issue={issue}
          borderTop={index > 0}
          busy={actions.busyIssue === issue.number}
          locked={actions.busyIssue !== null}
          canStart={
            canStart && (issue.task?.status === "launching" || launch.modelSelection !== null)
          }
          canOpen
          onPerform={actions.perform}
        />
      ))}
    </SettingsSection>
  );

  let body: ReactNode;
  if (environments.length === 0) {
    body = (
      <StateMessage
        title="Connect an environment"
        detail="Connect to a T3 Code server in Settings to see its repository's issues."
      />
    );
  } else if (!supported) {
    body = (
      <StateMessage
        title="Not supported by this server"
        detail="This environment doesn't offer the factory issue inbox. Update its T3 Code server to use it."
      />
    );
  } else if (projectId === null) {
    body = (
      <StateMessage
        title="No project"
        detail="Add a project with a GitHub repository to this environment to see its issues."
      />
    );
  } else if (!canRead) {
    body = (
      <StateMessage
        title="Not permitted"
        detail="This connection can't read orchestration data in this environment."
      />
    );
  } else if (list.loading) {
    body = (
      <View className="items-center py-12">
        <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading issues" />
      </View>
    );
  } else if (failure) {
    body = (
      <StateMessage
        title={failure.title}
        detail={failure.detail}
        action={<Button tone="primary" label="Try again" onPress={() => void list.refresh()} />}
      />
    );
  } else {
    body = (
      <>
        {list.issues.length === 0 ? (
          <StateMessage
            title={selection.filter === "all" ? "No issues" : `No ${selection.filter} issues`}
            detail={
              list.hasMore
                ? "This page had no issues. Load the next page to keep looking."
                : "This repository has nothing here yet."
            }
          />
        ) : (
          renderIssues(list.issues)
        )}
        {list.loadingMore ? (
          <View className="items-center py-4">
            <AppActivityIndicator
              colorClassName="accent-icon"
              accessibilityLabel="Loading more issues"
            />
          </View>
        ) : list.loadMoreError ? (
          <View className="items-center gap-2 px-4">
            <Text className="text-center text-sm text-foreground-muted">
              {describeFactoryFailure(list.loadMoreError, "Couldn't load more").detail}
            </Text>
            <Button label="Try again" onPress={() => void list.loadMore()} />
          </View>
        ) : list.hasMore ? (
          <View className="items-center">
            <Button
              label="Load more"
              accessibilityLabel="Load more issues"
              onPress={() => void list.loadMore()}
            />
          </View>
        ) : null}
      </>
    );
  }

  const environmentActions: MenuAction[] = environments.map((entry) => ({
    id: entry.environmentId,
    title: entry.supported ? entry.label : `${entry.label} (unsupported)`,
    state: entry.environmentId === environmentId ? "on" : undefined,
  }));
  const projectActions: MenuAction[] = projects.map((entry) => ({
    id: entry.id,
    title: entry.title,
    state: entry.id === projectId ? "on" : undefined,
  }));

  return (
    <SettingsScreen title="Factory issues">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          listActive ? (
            <RefreshControl refreshing={list.refreshing} onRefresh={() => void list.refresh()} />
          ) : undefined
        }
      >
        <SettingsSection title="Source">
          <SelectRow
            label="Environment"
            value={environment?.label ?? "None"}
            actions={environmentActions}
            onSelect={(id) => {
              const next = environments.find((entry) => entry.environmentId === id);
              if (next) {
                updateFactoryInboxSelection({
                  environmentId: next.environmentId,
                  projectId: null,
                  modelSelection: null,
                  baseRef: null,
                });
              }
            }}
          />
          <SelectRow
            borderTop
            label="Project"
            value={project?.title ?? (projects.length ? "Choose project" : "No projects")}
            actions={projectActions}
            onSelect={(id) => {
              const next = projects.find((entry) => entry.id === id);
              if (next && environmentId !== null) selectFactoryInboxProject(environmentId, next.id);
            }}
          />
          <View className="min-h-14 justify-center gap-0.5 border-t border-border-subtle px-4 py-3">
            <Text className="text-sm text-foreground-muted">Issues from</Text>
            <Text className="text-base text-foreground" selectable>
              {list.repository
                ? `GitHub · ${factoryRepositoryLabel(list.repository)}`
                : list.loading
                  ? "Resolving repository…"
                  : "Repository not resolved"}
            </Text>
            {repositoryUrl ? (
              <Text className="text-xs text-foreground-muted" selectable numberOfLines={1}>
                {repositoryUrl}
              </Text>
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection title="New tasks">
          <PickerRow
            label="Model"
            value={launch.label ?? (launch.modelOptions.length ? "Choose model" : "No models")}
            disabled={projectId === null}
            onPress={() => navigation.navigate("SettingsFactoryModel")}
          />
          <PickerRow
            borderTop
            label="Base branch"
            value={selection.baseRef ?? "Current HEAD"}
            disabled={projectId === null}
            onPress={() => navigation.navigate("SettingsFactoryBranch")}
          />
          {selection.baseRef !== null ? (
            <View className="items-start border-t border-border-subtle px-4 py-2">
              <Button
                label="Use current HEAD"
                tone="text"
                onPress={() => updateFactoryInboxSelection({ baseRef: null })}
              />
            </View>
          ) : null}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">{FACTORY_SUPERVISION_NOTICE}</Text>

        <SegmentedControl<FactoryIssueFilter>
          options={FACTORY_ISSUE_FILTERS}
          selected={selection.filter}
          onSelect={(filter) => updateFactoryInboxSelection({ filter })}
        />
        <View className="flex-row items-center justify-between gap-3 px-1">
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            {list.fetchedAt ? `Updated ${new Date(list.fetchedAt).toLocaleTimeString()}` : " "}
          </Text>
          <Button
            tone="text"
            label="Refresh"
            icon="arrow.clockwise"
            disabled={!listActive || list.loading || list.refreshing}
            onPress={() => void list.refresh()}
          />
        </View>

        {body}
      </ScrollView>
      {actions.review ? (
        <FactoryIssueReviewModal
          review={actions.review}
          pending={actions.busyIssue !== null}
          onClose={actions.closeReview}
          onConfirm={actions.confirmReview}
        />
      ) : null}
    </SettingsScreen>
  );
}
