import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AuthOrchestrationReadScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useProjects } from "../../state/entities";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useFactoryInboxSelection } from "./factory-inbox-state";
import { FactoryBriefRow } from "./FactoryBriefRow";
import { FactoryKnowledgeReviewModal } from "./FactoryKnowledgeReviewModal";
import {
  EMPTY_FACTORY_KNOWLEDGE_DRAFT,
  FACTORY_KNOWLEDGE_LIMITS,
  FACTORY_KNOWLEDGE_NOTICE,
  factoryKnowledgeDeliverablePathProblem,
  factoryKnowledgeDraftProblem,
  factoryKnowledgeTaskFor,
  sortFactoryKnowledgeBriefs,
  type FactoryKnowledgeBriefDraft,
} from "./factoryKnowledge";
import { useFactoryKnowledgeCreate, useFactoryKnowledgeStart } from "./useFactoryKnowledge";
import { useFactoryLaunchModel } from "./useFactoryLaunch";

type FactoryRoutes = {
  SettingsFactoryModel: undefined;
};

function FieldLabel(props: { readonly children: ReactNode }) {
  return <Text className="text-sm font-t3-medium text-foreground">{props.children}</Text>;
}

function NewBriefForm(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}) {
  const create = useFactoryKnowledgeCreate(props);
  const [draft, setDraft] = useState<FactoryKnowledgeBriefDraft>(EMPTY_FACTORY_KNOWLEDGE_DRAFT);
  const limits = FACTORY_KNOWLEDGE_LIMITS;
  const editable = !create.pending;
  const problem = factoryKnowledgeDraftProblem(draft);
  const pathProblem = factoryKnowledgeDeliverablePathProblem(draft.deliverablePath);
  const permissionReason = create.canCreate
    ? null
    : "This connection isn't permitted to create briefs in this environment.";
  const update = (patch: Partial<FactoryKnowledgeBriefDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateInput = (index: number, patch: { label?: string; content?: string }) =>
    setDraft((current) => ({
      ...current,
      inputs: current.inputs.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    }));

  return (
    <SettingsSection title="New brief">
      <View className="gap-4 px-4 py-4">
        <View className="gap-2">
          <FieldLabel>Title</FieldLabel>
          <AppTextInput
            accessibilityLabel="Brief title"
            placeholder="What the deliverable is"
            value={draft.title}
            maxLength={limits.title}
            editable={editable}
            onChangeText={(title) => update({ title })}
          />
        </View>
        <View className="gap-2">
          <FieldLabel>Question</FieldLabel>
          <AppTextInput
            accessibilityLabel="Brief question"
            placeholder="The question the deliverable answers"
            value={draft.question}
            multiline
            maxLength={limits.question}
            textAlignVertical="top"
            className="min-h-28"
            editable={editable}
            onChangeText={(question) => update({ question })}
          />
        </View>
        <View className="gap-2">
          <FieldLabel>Deliverable path</FieldLabel>
          <AppTextInput
            accessibilityLabel="Deliverable path"
            value={draft.deliverablePath}
            autoCapitalize="none"
            autoCorrect={false}
            editable={editable}
            onChangeText={(deliverablePath) => update({ deliverablePath })}
          />
          <Text className="text-xs text-foreground-muted">
            {pathProblem ?? "Relative to the task's private folder."}
          </Text>
        </View>
        {draft.inputs.map((entry, index) => (
          <View key={index} className="gap-2 rounded-2xl border border-border-subtle p-3">
            <FieldLabel>Input {index + 1}</FieldLabel>
            <AppTextInput
              accessibilityLabel={`Input ${index + 1} label`}
              placeholder="Label"
              value={entry.label}
              maxLength={limits.inputLabel}
              editable={editable}
              onChangeText={(label) => updateInput(index, { label })}
            />
            <AppTextInput
              accessibilityLabel={`Input ${index + 1} content`}
              placeholder="Paste the source text"
              value={entry.content}
              multiline
              maxLength={limits.inputContent}
              textAlignVertical="top"
              className="min-h-24"
              editable={editable}
              onChangeText={(content) => updateInput(index, { content })}
            />
            <Button
              tone="text"
              label="Remove input"
              accessibilityLabel={`Remove input ${index + 1}`}
              disabled={!editable}
              onPress={() =>
                setDraft((current) => ({
                  ...current,
                  inputs: current.inputs.filter((_, position) => position !== index),
                }))
              }
            />
          </View>
        ))}
        <Button
          tone="text"
          icon="plus"
          label={
            draft.inputs.length >= limits.inputs
              ? `Input limit reached (${limits.inputs})`
              : "Add input"
          }
          disabled={!editable || draft.inputs.length >= limits.inputs}
          onPress={() =>
            setDraft((current) =>
              current.inputs.length >= limits.inputs
                ? current
                : { ...current, inputs: [...current.inputs, { label: "", content: "" }] },
            )
          }
        />
        <View className="gap-2">
          <FieldLabel>Acceptance criteria</FieldLabel>
          <AppTextInput
            accessibilityLabel="Acceptance criteria"
            placeholder="What a good answer must include"
            value={draft.acceptanceCriteria}
            multiline
            maxLength={limits.criteria}
            textAlignVertical="top"
            className="min-h-20"
            editable={editable}
            onChangeText={(acceptanceCriteria) => update({ acceptanceCriteria })}
          />
        </View>
        {create.failure ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="polite" className="gap-1">
            <Text className="text-sm font-t3-semibold text-danger-foreground">
              {create.failure.title}
            </Text>
            <Text selectable className="text-sm text-foreground">
              {create.failure.detail}
            </Text>
          </View>
        ) : null}
        <Button
          fullWidth
          tone="primary"
          label="Create brief"
          accessibilityHint={permissionReason ?? problem ?? undefined}
          loading={create.pending}
          disabled={permissionReason !== null || problem !== null}
          onPress={() => {
            void create.create(draft).then((created) => {
              if (!created) return;
              setDraft(EMPTY_FACTORY_KNOWLEDGE_DRAFT);
              props.onCreated();
            });
          }}
        />
        {(permissionReason ?? problem) ? (
          <Text className="text-xs text-foreground-muted">{permissionReason ?? problem}</Text>
        ) : null}
        <Button tone="text" label="Cancel" disabled={create.pending} onPress={props.onCancel} />
      </View>
    </SettingsSection>
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

export function FactoryBriefsRouteScreen({
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
  const canStart = useAtomValue(
    factoryEnvironment.startKnowledgeTask.permissionAtom(environmentId),
  );
  const list = useEnvironmentQuery(
    canRead
      ? factoryEnvironment.listKnowledgeBriefs({ environmentId, input: { projectId } })
      : null,
  );
  const launch = useFactoryLaunchModel({ ...selection, environmentId, projectId });
  const [composing, setComposing] = useState(false);

  const settings = useMemo(
    () => ({
      environmentId,
      projectId,
      modelSelection: launch.modelSelection,
      modelLabel: launch.label ?? "Default model",
      runtimeMode: selection.runtimeMode,
    }),
    [environmentId, projectId, launch.modelSelection, launch.label, selection.runtimeMode],
  );
  const refreshList = list.refresh;
  const start = useFactoryKnowledgeStart({
    settings,
    scopeKey: isFocused && canRead ? JSON.stringify([environmentId, projectId, canStart]) : null,
    onSettled: refreshList,
  });

  const project =
    allProjects.find((entry) => entry.environmentId === environmentId && entry.id === projectId) ??
    null;
  const briefs = useMemo(
    () => (list.data === null ? [] : sortFactoryKnowledgeBriefs(list.data.briefs)),
    [list.data],
  );
  const tasks = list.data?.tasks ?? [];

  let body: ReactNode;
  if (!canRead) {
    body = (
      <StateMessage
        title="Not permitted"
        detail="This connection can't read orchestration data in this environment."
      />
    );
  } else if (list.data === null && list.error) {
    body = (
      <StateMessage
        title="Couldn't load briefs"
        detail={list.error}
        action={<Button tone="primary" label="Try again" onPress={refreshList} />}
      />
    );
  } else if (list.data === null) {
    body = <Text className="py-6 text-center text-sm text-foreground-muted">Loading briefs…</Text>;
  } else if (briefs.length === 0) {
    body = (
      <StateMessage
        title="No briefs"
        detail="Write a brief to ask a bounded question and get one reviewed deliverable."
      />
    );
  } else {
    body = (
      <SettingsSection>
        {briefs.map((brief, index) => (
          <FactoryBriefRow
            key={brief.id}
            environmentId={environmentId}
            projectId={projectId}
            brief={brief}
            task={factoryKnowledgeTaskFor(tasks, brief.id)}
            borderTop={index > 0}
            busy={start.busyBrief === brief.id}
            locked={start.busyBrief !== null}
            canStart={canStart && launch.modelSelection !== null}
            onPerform={start.perform}
          />
        ))}
      </SettingsSection>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          canRead ? (
            <RefreshControl
              refreshing={list.isPending && list.data !== null}
              onRefresh={refreshList}
            />
          ) : undefined
        }
      >
        <SettingsSection title="Project">
          <View className="gap-1 px-4 py-3">
            <Text className="text-lg text-foreground">
              {project?.title ?? "Project unavailable"}
            </Text>
            <Text className="text-sm text-foreground-muted" selectable>
              {project?.workspaceRoot}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Model, ${launch.label ?? "Choose model"}`}
            onPress={() => navigation.navigate("SettingsFactoryModel")}
            className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
          >
            <Text className="text-lg text-foreground">Model</Text>
            <Text
              className="min-w-0 flex-1 text-right text-base text-foreground-muted"
              numberOfLines={1}
            >
              {launch.label ?? (launch.modelOptions.length ? "Choose model" : "No models")}
            </Text>
            <SymbolView
              name="chevron.right"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          </Pressable>
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">{FACTORY_KNOWLEDGE_NOTICE}</Text>

        {composing ? (
          <NewBriefForm
            environmentId={environmentId}
            projectId={projectId}
            // The create command refreshes this list when it settles.
            onCreated={() => setComposing(false)}
            onCancel={() => setComposing(false)}
          />
        ) : (
          <Button
            tone="primary"
            icon="plus"
            label="New brief"
            disabled={!canRead}
            onPress={() => setComposing(true)}
          />
        )}

        <View className="flex-row items-center justify-between gap-3 px-1">
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            {list.data ? `Updated ${new Date(list.data.fetchedAt).toLocaleTimeString()}` : " "}
          </Text>
          <Button
            tone="text"
            label="Refresh"
            icon="arrow.clockwise"
            accessibilityLabel="Refresh briefs"
            disabled={!canRead || list.isPending}
            onPress={refreshList}
          />
        </View>
        {list.data !== null && list.error ? (
          <Text className="px-1 text-sm text-danger-foreground">
            Couldn't refresh briefs: {list.error}
          </Text>
        ) : null}

        {body}
      </ScrollView>
      {start.review ? (
        <FactoryKnowledgeReviewModal
          review={start.review}
          pending={start.busyBrief !== null}
          onClose={start.closeReview}
          onConfirm={start.confirmReview}
        />
      ) : null}
    </View>
  );
}
