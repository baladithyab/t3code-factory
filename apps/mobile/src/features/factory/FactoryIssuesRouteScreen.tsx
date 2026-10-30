import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryIssue,
  type ProjectId,
} from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { useMemo, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "../settings/components/SettingsSection";
import { updateFactoryInboxSelection, useFactoryInboxSelection } from "./factory-inbox-state";
import { FactoryIssueRow } from "./FactoryIssueRow";
import { FactoryIssueReviewModal } from "./FactoryIssueReviewModal";
import {
  describeFactoryFailure,
  FACTORY_ISSUE_FILTERS,
  FACTORY_SUPERVISION_NOTICE,
  factoryRepositoryLabel,
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

export function FactoryIssuesRouteScreen({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<FactoryRoutes>>();
  const isFocused = useIsFocused();
  const selection = useFactoryInboxSelection();
  const allProjects = useProjects();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canStart = useAtomValue(factoryEnvironment.start.permissionAtom(environmentId));
  const listActive = canRead;
  const list = useFactoryIssueList({
    environmentId: listActive ? environmentId : null,
    projectId: listActive ? projectId : null,
    filter: selection.filter,
  });
  const launch = useFactoryLaunchModel({ ...selection, environmentId, projectId });

  const settings = useMemo(
    () =>
      environmentId !== null && projectId !== null
        ? {
            environmentId,
            projectId,
            repository: list.repository,
            displayName: list.capabilities?.displayName ?? null,
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
      list.capabilities?.displayName,
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

  const project =
    allProjects.find((entry) => entry.environmentId === environmentId && entry.id === projectId) ??
    null;
  const failure = list.error ? describeFactoryFailure(list.error, "Couldn't load issues") : null;
  const repositoryUrl = list.repository ? safeFactoryIssueUrl(list.repository.url) : null;

  const { capabilities } = list;
  const renderIssues = (issues: ReadonlyArray<FactoryIssue>) =>
    // Capabilities arrive with every page, so rows never render without them.
    capabilities === null ? null : (
      <SettingsSection>
        {issues.map((issue, index) => (
          <FactoryIssueRow
            key={issue.number}
            environmentId={environmentId}
            issue={issue}
            capabilities={capabilities}
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
  if (!canRead) {
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

  return (
    <View className="flex-1">
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
          <View className="gap-1 px-4 py-3">
            <Text className="text-lg text-foreground">
              {project?.title ?? "Project unavailable"}
            </Text>
            <Text className="text-sm text-foreground-muted" selectable>
              {project?.workspaceRoot}
            </Text>
          </View>
          <View className="min-h-14 justify-center gap-0.5 border-t border-border-subtle px-4 py-3">
            <Text className="text-sm text-foreground-muted">Issues from</Text>
            <Text className="text-base text-foreground" selectable>
              {list.repository && list.capabilities
                ? `${list.capabilities.displayName} · ${factoryRepositoryLabel(list.repository)}`
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
    </View>
  );
}
