import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import type {
  EnvironmentId,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { useRef, useState, type ReactNode } from "react";
import { useFocusEffect, useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AppState, Platform, Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  EnvironmentMachineSymbol,
  ENVIRONMENT_MACHINE_SYMBOLS,
} from "../../components/EnvironmentMachineSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { usePreparedConnection } from "../../state/session";
import { buildModelOptions } from "../../lib/modelOptions";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useEnvironmentServerConfig, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { factoryCoordinatorSupportedAtom, factoryEnvironment } from "../../state/factory";
import { environmentThreadShells } from "../../state/threads";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { resolveNewTaskBranchLabel } from "../threads/new-task-context-presentation";
import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { ScheduledTaskPromptField } from "./components/ScheduledTaskPromptField";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import {
  createFactoryDraft,
  createDraft,
  editDraft,
  scheduledTaskDefaultModel,
  scheduleFromDraft,
  type ScheduledTaskDraft as Draft,
} from "./scheduledTaskDraft";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";
import { useScheduledTaskEditor } from "./scheduled-task-editor";
import {
  discardScheduledTaskEditor,
  markScheduledTaskEditorSaved,
  moveScheduledTaskEditor,
  scheduledTaskEditorSessionAtom,
  scheduledTaskInScope,
} from "./scheduled-task-editor-state";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

type ScheduledTaskRoutes = {
  SettingsScheduledTaskNew: undefined;
  SettingsScheduledTaskEdit: undefined;
  SettingsScheduledTaskModel: undefined;
  SettingsScheduledTaskBranch: undefined;
};

const DAYS = [
  { index: 1, label: "Mon" },
  { index: 2, label: "Tue" },
  { index: 3, label: "Wed" },
  { index: 4, label: "Thu" },
  { index: 5, label: "Fri" },
  { index: 6, label: "Sat" },
  { index: 0, label: "Sun" },
] as const;

function describeSchedule(task: ScheduledTask): string {
  if (task.schedule.type === "webhook") return "On webhook";
  if (task.schedule.type === "interval") return formatScheduledTaskInterval(task.schedule.everyMs);
  const days = task.schedule.weekdays?.length ? repeatLabel(task.schedule.weekdays) : "Every day";
  return `${days} at ${formatTime(task.schedule.timeOfDay)}`;
}

function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function timePickerValue(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);
  const time = new Date();
  time.setHours(
    Number.isInteger(hours) ? (hours ?? 9) : 9,
    Number.isInteger(minutes) ? (minutes ?? 0) : 0,
    0,
    0,
  );
  return time;
}

function repeatLabel(weekdays: ReadonlyArray<number>): string {
  const days = new Set(weekdays);
  if (days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => day.label)
      .join(", ") || "Choose days"
  );
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly keyboardType?: "decimal-pad" | "number-pad";
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly borderTop?: boolean;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <RNTextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        textAlignVertical="center"
        keyboardType={props.keyboardType}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly valueIcon?: ReactNode;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
  const value = (
    <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
      {props.valueIcon}
      <Text
        textRole="footnote"
        className="shrink text-right text-foreground-muted"
        numberOfLines={1}
      >
        {props.value}
      </Text>
    </View>
  );
  if (props.actions.length === 0) {
    return (
      <View
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
      </View>
    );
  }
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        }
      >
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
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

function WebhookFilterRows(props: {
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  readonly disabled: boolean;
  readonly onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    props.onChange(
      props.filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)),
    );
  return (
    <>
      {props.filters.map((filter, index) => (
        <View key={filter.id}>
          <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 pt-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted">Filter {index + 1}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove filter ${index + 1}`}
              disabled={props.disabled}
              hitSlop={8}
              onPress={() => props.onChange(removeWebhookFilterDraft(props.filters, filter.id))}
              className="active:opacity-70"
            >
              <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
            </Pressable>
          </View>
          <FormField
            label="Path"
            value={filter.path}
            placeholder="body.action"
            disabled={props.disabled}
            onChange={(path) => update(index, { path })}
          />
          <SelectRow
            label="Test"
            value={WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label ?? ""}
            actions={WEBHOOK_FILTER_OPS.map((option) => ({
              id: option.op,
              title: option.label,
              state: option.op === filter.op ? ("on" as const) : undefined,
            }))}
            onSelect={(id) => {
              const known = WEBHOOK_FILTER_OPS.find((option) => option.op === id);
              if (known) update(index, { op: known.op });
            }}
          />
          {filter.op === "exists" ? null : (
            <FormField
              label={filter.op === "in" ? "Values, comma-separated" : "Value"}
              value={filter.value}
              placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
              disabled={props.disabled}
              onChange={(value) => update(index, { value })}
            />
          )}
        </View>
      ))}
      {props.filters.length < MAX_WEBHOOK_FILTERS ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => props.onChange([...props.filters, emptyWebhookFilterDraft()])}
          className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
        >
          <Text textRole="body" className="min-w-0 flex-1 text-foreground">
            Add filter
          </Text>
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      ) : null}
      {props.filters.length > 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          Runs only when every filter matches. Other requests are logged as filtered. Separate “is
          one of” values with commas; a value can't contain a comma.
        </Text>
      ) : null}
    </>
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
      <Text textRole="body" className="text-foreground">
        {props.label}
      </Text>
      <Text
        textRole="footnote"
        className="min-w-0 flex-1 text-right text-foreground-muted"
        numberOfLines={1}
      >
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

function useScheduledTasksNow() {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(() => {
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = setInterval(updateNow, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") updateNow();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  });
  return now;
}

export function FactoryScheduledTasksScreen({
  environmentId,
  projectId,
  taskId,
  onWorkflowOpened,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly taskId?: ScheduledTaskId;
  readonly onWorkflowOpened?: (taskId: ScheduledTaskId) => void;
}) {
  const now = useScheduledTasksNow();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const projects = useProjects();
  const configs = useServerConfigs();
  const { startEditor } = useScheduledTaskEditor();
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const scopedEnvironments = environments.filter(
    (environment) => environmentId === null || environment.environmentId === environmentId,
  );
  const invalidScope =
    (environmentId !== null && scopedEnvironments.length === 0) ||
    (projectId !== null &&
      (environmentId === null ||
        !projects.some(
          (project) => project.id === projectId && project.environmentId === environmentId,
        ))) ||
    (taskId !== undefined && environmentId === null);
  if (invalidScope) {
    return (
      <Text className="p-4 text-base text-danger-foreground">
        This workflow scope is unavailable. Choose its exact environment and project.
      </Text>
    );
  }
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <Text className="text-sm text-foreground-muted">
        Scheduled agent prompts; latest dispatch only, not a dependency graph or historical run
        timeline. New workflows start paused and supervised.
      </Text>
      {scopedEnvironments.length === 0 ? (
        <Text className="text-base text-foreground-muted">
          Connect an environment to manage workflows.
        </Text>
      ) : null}
      {scopedEnvironments.map((environment) => {
        const target = availableTargets.find(
          (entry) => entry.environmentId === environment.environmentId,
        );
        if (!target) {
          return (
            <SettingsSection key={environment.environmentId} title={environment.label}>
              <Text className="p-4 text-base text-foreground-muted">
                Environment disconnected. Workflow counts and dispatch state are unavailable.
              </Text>
            </SettingsSection>
          );
        }
        return (
          <EnvironmentTasks
            key={`${target.environmentId}:${projectId ?? "all"}:${taskId ?? "all"}`}
            environment={target}
            now={now}
            projectIds={projectId === null ? null : [projectId]}
            taskId={taskId}
            onCreate={() => {
              const project =
                projects.find(
                  (entry) => entry.environmentId === target.environmentId && entry.id === projectId,
                ) ?? null;
              startEditor({
                environmentId: target.environmentId,
                environmentLabel: target.label,
                factory: true,
                environmentScope: target.environmentId,
                ...(projectId === null ? {} : { projectScope: projectId }),
                draft: createFactoryDraft(
                  projectId,
                  scheduledTaskDefaultModel(configs.get(target.environmentId) ?? null, project),
                ),
              });
              navigation.navigate("SettingsScheduledTaskEdit");
            }}
            onEdit={(task) => {
              startEditor({
                environmentId: target.environmentId,
                environmentLabel: target.label,
                factory: true,
                environmentScope: target.environmentId,
                projectScope: task.projectId,
                draft: editDraft(task),
              });
              navigation.navigate("SettingsScheduledTaskEdit");
              onWorkflowOpened?.(task.id);
            }}
          />
        );
      })}
    </ScrollView>
  );
}

export function SettingsScheduledTasksRouteScreen() {
  const now = useScheduledTasksNow();
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const visibleEnvironments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const { startEditor, resetEditor } = useScheduledTaskEditor();
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const insets = useSafeAreaInsets();
  const newTask = () => {
    if (visibleEnvironments.length === 0) return;
    resetEditor();
    navigation.navigate("SettingsScheduledTaskNew");
  };

  return (
    <>
      <SettingsEnvironmentFilterHeader
        trailingItems={[
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: "New task",
            icon: { type: "sfSymbol", name: "plus" } as const,
            disabled: visibleEnvironments.length === 0,
            onPress: newTask,
          }),
        ]}
      />
      <SettingsScreen
        title="Scheduled tasks"
        trailing={
          <View className="flex-row items-center">
            <AndroidSettingsEnvironmentFilter />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New task"
              accessibilityState={{ disabled: visibleEnvironments.length === 0 }}
              disabled={visibleEnvironments.length === 0}
              onPress={newTask}
              className="size-11 items-center justify-center rounded-full disabled:opacity-50"
            >
              <SymbolView name="plus" size={22} tintColorClassName="accent-icon" />
            </Pressable>
          </View>
        }
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {visibleEnvironments.length > 0 ? (
            visibleEnvironments.map((environment) => (
              <EnvironmentTasks
                key={environment.environmentId}
                environment={environment}
                now={now}
                projectIds={
                  selectedProjectKey === null
                    ? null
                    : (selectedGroup?.members
                        .filter(
                          (member) => member.project.environmentId === environment.environmentId,
                        )
                        .map((member) => member.project.id) ?? [])
                }
                onEdit={(task) => {
                  startEditor({
                    environmentId: environment.environmentId,
                    environmentLabel: environment.label,
                    draft: editDraft(task),
                  });
                  navigation.navigate("SettingsScheduledTaskEdit");
                }}
              />
            ))
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect an environment to view and create scheduled tasks."
                : "No environments match these filters. Change the filter above."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

// The "New task" action and takeScheduledTaskNewLink clear the editor before
// this screen opens, so it starts from the default target.
export function SettingsScheduledTaskNewRouteScreen() {
  return <SettingsScheduledTaskEditorScreen title="New scheduled task" />;
}

export function SettingsScheduledTaskEditRouteScreen() {
  const { editor } = useScheduledTaskEditor();
  return (
    <SettingsScheduledTaskEditorScreen
      title={
        editor?.factory
          ? editor.draft.task
            ? "Edit workflow"
            : "New workflow"
          : "Edit scheduled task"
      }
    />
  );
}

function SettingsScheduledTaskEditorScreen({ title }: { readonly title: string }) {
  const { editor, voiceOwnerKey, readEditor, setEditor, hasChanges, draftForEnvironment, startEditor } =
    useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const configs = useServerConfigs();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  // Set once the save lands, so the removal guard lets the editor close.
  const saved = useRef(false);
  const ownerKey = editor ? `${voiceOwnerKey}:${editor.environmentId}` : null;
  const prompt = editor?.draft.prompt ?? "";
  const [selectionState, setSelectionState] = useState<{
    readonly ownerKey: string | null;
    readonly selection: ComposerEditorSelection;
  } | null>(null);
  const selection =
    selectionState?.ownerKey === ownerKey
      ? selectionState.selection
      : { start: prompt.length, end: prompt.length };
  const setSelection = (next: ComposerEditorSelection) =>
    setSelectionState({ ownerKey, selection: next });
  const setPrompt = (next: string) =>
    setEditor((current) =>
      current
        ? {
            ...current,
            draft: { ...current.draft, prompt: next },
          }
        : current,
    );
  const voiceInput = useVoiceInputController({
    ownerKey,
    label: editor?.draft.title.trim() || title,
    subscribeToDraftChanges: (onChange) =>
      appAtomRegistry.subscribe(scheduledTaskEditorSessionAtom, onChange),
    selection,
    readDraftMessage: () => {
      const current = readEditor();
      if (current?.environmentId !== editor?.environmentId) return null;
      return current?.draft.prompt ?? null;
    },
    onChangeSelection: setSelection,
    onChangeDraftMessage: (text) => {
      if (readEditor()?.environmentId === editor?.environmentId) setPrompt(text);
    },
    disabled: saving,
  });
  const preventRemove = hasChanges || saving;
  usePreventRemove(preventRemove, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert("Saving task", "Wait for the task to finish saving before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => {
          if (voiceInput.isBusy) voiceInput.cancel();
          discardScheduledTaskEditor();
          navigation.dispatch(data.action);
        },
      },
    ]);
  });
  return (
    <SettingsScreen title={title}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            // Native Back pops before removal guards; a bar action lets the guard run first.
            unstable_headerLeftItems: () => [
              withNativeGlassHeaderItem({
                type: "button",
                label: "",
                accessibilityLabel: "Back",
                icon: { type: "sfSymbol", name: "chevron.backward" },
                onPress: () => navigation.goBack(),
              }),
            ],
          }}
        />
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {editor ? (
          <TaskForm
            key={editor.environmentId}
            environmentId={editor.environmentId}
            environmentLabel={
              availableTargets.find((target) => target.environmentId === editor.environmentId)
                ?.label ?? editor.environmentLabel
            }
            availableTargets={availableTargets}
            projectScope={editor.projectScope}
            environmentLocked={editor.environmentScope !== undefined}
            draft={editor.draft}
            saving={saving}
            setSaving={setSaving}
            dictationPending={voiceInput.blocksSubmission}
            promptField={
              <ScheduledTaskPromptField
                value={prompt}
                onChange={setPrompt}
                selection={selection}
                onChangeSelection={setSelection}
                disabled={saving}
                voiceInput={voiceInput}
              />
            }
            setDraft={(draft) => {
              if (!saving) setEditor({ ...editor, draft });
            }}
            onSaved={() => {
              saved.current = true;
              markScheduledTaskEditorSaved();
              if (navigation.isFocused()) navigation.goBack();
            }}
            onChangeEnvironment={(target) => {
              if (target.environmentId === editor.environmentId) return;
              const next = moveScheduledTaskEditor(
                editor,
                { environmentId: target.environmentId, environmentLabel: target.label },
                createDraft(
                  null,
                  scheduledTaskDefaultModel(configs.get(target.environmentId) ?? null, null),
                ),
              );
              if (next) setEditor(next);
            }}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Connect an environment to create a scheduled task."
              : "No environments match the current filters. Change the filters to create a task."}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function TaskForm({
  environmentId,
  environmentLabel,
  availableTargets,
  projectScope,
  environmentLocked,
  draft,
  saving,
  setSaving,
  dictationPending,
  promptField,
  setDraft,
  onSaved,
  onChangeEnvironment,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly availableTargets: readonly SettingsTarget[];
  readonly projectScope?: ProjectId;
  readonly environmentLocked: boolean;
  readonly draft: Draft;
  readonly saving: boolean;
  readonly setSaving: (saving: boolean) => void;
  readonly dictationPending: boolean;
  readonly promptField: ReactNode;
  readonly setDraft: (draft: Draft) => void;
  readonly onSaved: () => void;
  readonly onChangeEnvironment: (target: SettingsTarget) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const config = useEnvironmentServerConfig(environmentId);
  const modelOptions = buildModelOptions(config, null, undefined, draft.projectId);
  const supportsCoordinator = useAtomValue(factoryCoordinatorSupportedAtom(environmentId));
  const coordinatorQuery = useEnvironmentQuery(
    supportsCoordinator && draft.projectId !== null
      ? factoryEnvironment.coordinatorsGet({ environmentId, input: { projectId: draft.projectId } })
      : null,
  );
  const coordinator = coordinatorQuery.error ? null : coordinatorQuery.data?.coordinator;
  const threadShells = useAtomValue(environmentThreadShells.threadShellsAtom);
  const boundThread = threadShells.find(
    (thread) => thread.environmentId === environmentId && thread.id === draft.threadId,
  );
  const coordinatorThread = coordinator
    ? threadShells.find(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.id === coordinator.threadId &&
          thread.projectId === draft.projectId &&
          thread.deletedAt === null &&
          thread.archivedAt === null,
      )
    : undefined;
  const canBindCoordinator =
    coordinator?.current === true &&
    coordinatorThread !== undefined &&
    (coordinator.status === "idle" ||
      coordinator.status === "running" ||
      coordinator.status === "preparing");
  const coordinatorUnavailableReason = !draft.projectId
    ? "Choose a project to select its orchestrator."
    : !supportsCoordinator
      ? "This environment does not support project orchestrators."
      : coordinatorQuery.error
        ? `Project orchestrator unavailable: ${coordinatorQuery.error}`
        : !coordinatorQuery.data
          ? "Loading project orchestrator…"
          : !coordinator
            ? "No project orchestrator exists. Create one in the Factory Orchestrator section."
            : !canBindCoordinator
              ? `Project orchestrator unavailable for binding (${coordinator.status}).`
              : null;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
    reportFailure: false,
  });
  const submissionPending = useRef(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const liveTask = tasks.data?.tasks.find((task) => task.id === draft.task?.id);
  const ownerChanged =
    draft.task !== null &&
    liveTask !== undefined &&
    (liveTask.threadId !== draft.task.threadId || liveTask.projectId !== draft.task.projectId);
  const taskMissing = draft.task !== null && tasks.data !== null && liveTask === undefined;
  const environmentUnavailable = !availableTargets.some(
    (target) => target.environmentId === environmentId,
  );
  const taskUnavailable = draft.task !== null && (tasks.error !== null || !tasks.isSuccess);
  const bindingUnavailable =
    draft.threadId !== null &&
    (!boundThread ||
      boundThread.projectId !== draft.projectId ||
      boundThread.deletedAt !== null ||
      boundThread.archivedAt !== null);

  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const save = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      dictationPending ||
      taskMissing ||
      environmentUnavailable ||
      taskUnavailable ||
      bindingUnavailable ||
      ownerChanged
    )
      return;
    // Preserve signatures edited on other clients by sending the task's current value.
    const liveTask = tasks.data?.tasks.find((task) => task.id === draft.task?.id);
    const schedule = scheduleFromDraft(
      draft.schedule.mode === "webhook" && liveTask?.schedule.type === "webhook"
        ? { ...draft.schedule, signature: liveTask.schedule.signature }
        : draft.schedule,
    );
    if (
      draft.schedule.mode === "webhook" &&
      parseMaxDeliveryAge(draft.schedule.maxDeliveryAgeMinutes) === undefined
    ) {
      Dialog.alert(
        "Invalid age limit",
        `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      );
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.schedule.filters);
    if (draft.schedule.mode === "webhook" && "error" in parsedFilters) {
      Dialog.alert("Invalid filter", parsedFilters.error);
      return;
    }
    if (draft.schedule.mode === "webhook" && schedule === null) {
      Dialog.alert(
        "Invalid webhook settings",
        "Each dedupe key must contain a valid request placeholder. The coalesce window must be whole seconds from 10 to 3600, or blank.",
      );
      return;
    }
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !draft.projectId ||
      !draft.modelSelection ||
      !schedule ||
      (draft.workspace === "existing_worktree" && !draft.checkoutPath.trim())
    ) {
      Dialog.alert(
        "Incomplete task",
        "Add a name, prompt, project, model, valid schedule, and checkout path if needed.",
      );
      return;
    }
    if (!projects.some((project) => project.id === draft.projectId)) {
      Dialog.alert("Project unavailable", "Choose a project in this environment.");
      return;
    }
    if (projectScope !== undefined && draft.projectId !== projectScope) {
      Dialog.alert("Project changed", "Reopen the workflow in its exact project scope.");
      return;
    }
    const input: ScheduledTaskUpsertInput = {
      ...(draft.task ? { id: draft.task.id, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      projectId: draft.projectId,
      modelSelection: draft.modelSelection,
      schedule,
      enabled: draft.enabled,
      threadId: draft.threadId,
      workspaceStrategy:
        draft.workspace === "root"
          ? { type: "root" }
          : draft.workspace === "existing_worktree"
            ? { type: "existing_worktree", worktreePath: draft.checkoutPath.trim() }
            : {
                type: "worktree",
                baseRef: draft.baseRef.trim() || "main",
                startFromOrigin: draft.startFromOrigin,
              },
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: draft.task?.creationSource ?? "mobile",
    };
    submissionPending.current = true;
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      failure("Could not save task", result);
      return;
    }
    onSaved();
  };

  return (
    <View className="gap-5">
      <View
        className="gap-5"
        pointerEvents={saving ? "none" : "auto"}
        accessibilityElementsHidden={saving}
        importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
      >
        {taskMissing ? (
          <Text className="px-1 text-base text-danger-foreground">This task no longer exists.</Text>
        ) : null}

        {environmentUnavailable ? (
          <Text className="px-1 text-base text-danger-foreground">
            This environment is disconnected. Reconnect before saving.
          </Text>
        ) : null}
        {taskUnavailable ? (
          <Text className="px-1 text-base text-danger-foreground">
            {tasks.error ?? "Loading the current workflow before saving…"}
          </Text>
        ) : null}
        {ownerChanged ? (
          <Text className="px-1 text-base text-danger-foreground">
            This workflow's project or bound thread changed elsewhere. Reopen it to review the
            current binding before saving.
          </Text>
        ) : null}
        <SettingsSection>
          <SelectRow
            label="Runs on"
            value={environmentLabel}
            valueIcon={
              <EnvironmentMachineSymbol
                kind={resolveEnvironmentMachineKind(config)}
                size={18}
                tintColorClassName="accent-foreground-muted"
              />
            }
            actions={
              draft.task ||
              draft.threadId ||
              environmentLocked ||
              projectScope ||
              saving ||
              dictationPending
                ? []
                : availableTargets.map((target) => ({
                    id: target.environmentId,
                    title: target.label,
                    image:
                      ENVIRONMENT_MACHINE_SYMBOLS[
                        resolveEnvironmentMachineKind(target.serverConfig)
                      ],
                    state: target.environmentId === environmentId ? "on" : undefined,
                  }))
            }
            onSelect={(id) => {
              const target = availableTargets.find((entry) => entry.environmentId === id);
              if (target) onChangeEnvironment(target);
            }}
          />
        </SettingsSection>
        <SettingsSection title="Task">
          <FormField
            label="Name"
            disabled={saving}
            value={draft.title}
            placeholder="Check for issues"
            onChange={(title) => setDraft({ ...draft, title })}
          />
          {promptField}
        </SettingsSection>

        <SettingsSection title="Context">
          <SelectRow
            label="Project"
            value={
              projects.find((project) => project.id === draft.projectId)?.title ??
              (projects.length ? "Choose project" : "No projects available")
            }
            actions={
              draft.threadId || projectScope
                ? []
                : projects.map((project) => ({
                    id: project.id,
                    title: project.title,
                    state: project.id === draft.projectId ? "on" : undefined,
                  }))
            }
            onSelect={(id) => {
              const project = projects.find((item) => item.id === id);
              if (!project || draft.threadId || projectScope) return;
              const keepsExplicitModel =
                draft.modelSelectionIsExplicit &&
                (draft.modelSelection === null ||
                  !config?.settings ||
                  resolveProjectProviderInstanceEnabled(
                    config.settings,
                    project.id,
                    draft.modelSelection.instanceId,
                  ));
              setDraft({
                ...draft,
                projectId: project.id,
                modelSelection: keepsExplicitModel
                  ? draft.modelSelection
                  : scheduledTaskDefaultModel(config, project),
                modelSelectionIsExplicit: keepsExplicitModel,
              });
            }}
          />
          <PickerRow
            label="Model"
            borderTop
            value={
              draft.threadId
                ? (boundThread?.modelSelection.model ?? "Bound thread provider unavailable")
                : (modelOptions.find(
                    (option) =>
                      option.selection.instanceId === draft.modelSelection?.instanceId &&
                      option.selection.model === draft.modelSelection?.model,
                  )?.label ??
                  draft.modelSelection?.model ??
                  (modelOptions.length ? "Choose model" : "No models available"))
            }
            onPress={() => navigation.navigate("SettingsScheduledTaskModel")}
            disabled={
              draft.threadId !== null || saving || dictationPending || environmentUnavailable
            }
          />
        </SettingsSection>

        <SettingsSection title="Delivery">
          <SelectRow
            label="Run in"
            value={
              draft.threadId === null
                ? "New thread each run"
                : draft.threadId === coordinator?.threadId
                  ? "Current project orchestrator"
                  : `Bound thread: ${boundThread?.title ?? draft.threadId}`
            }
            actions={[
              {
                id: "direct",
                title: "New thread each run",
                state: draft.threadId === null ? "on" : undefined,
              },
              ...(canBindCoordinator
                ? [
                    {
                      id: "coordinator",
                      title: "Current project orchestrator",
                      state: draft.threadId === coordinator?.threadId ? ("on" as const) : undefined,
                    },
                  ]
                : []),
              ...(draft.task?.threadId
                ? [
                    {
                      id: "preserved",
                      title: `Original bound thread: ${draft.task.threadId}`,
                      state: draft.threadId === draft.task.threadId ? ("on" as const) : undefined,
                    },
                  ]
                : []),
            ]}
            onSelect={(id) => {
              if (id === "direct") setDraft({ ...draft, threadId: null });
              if (id === "coordinator" && canBindCoordinator && coordinator) {
                setDraft({
                  ...draft,
                  threadId: coordinator.threadId,
                  modelSelection: draft.modelSelection ?? coordinator.modelSelection,
                });
              }
              if (id === "preserved" && draft.task?.threadId) {
                setDraft({
                  ...draft,
                  projectId: draft.task.projectId,
                  threadId: draft.task.threadId,
                });
              }
            }}
          />
          {coordinatorUnavailableReason ? (
            <Text className="px-4 pb-3 text-sm text-foreground-muted">
              {coordinatorUnavailableReason}
            </Text>
          ) : null}
          {supportsCoordinator && draft.projectId ? (
            <Button label="Refresh orchestrator" onPress={coordinatorQuery.refresh} />
          ) : null}
          <Text className="px-4 pb-3 text-sm text-foreground-muted">
            Bound delivery queues a prompt in the selected thread, using its current provider and
            model, not the stored new-thread model. Deleting that thread removes its bound
            workflows. Choose New thread each run to deliberately unbind before changing project or
            environment.
          </Text>
          {bindingUnavailable ? (
            <Text className="px-4 pb-3 text-sm text-danger-foreground">
              The bound thread is unavailable in this project. Reconnect or explicitly unbind/rebind
              before saving. The saved binding has not been cleared.
            </Text>
          ) : null}
        </SettingsSection>

        {draft.threadId === null ? (
          <>
            <SettingsSection title="Permissions">
              <SelectRow
                label="Runtime"
                value={
                  RUNTIME_MODE_CHOICES.find((choice) => choice.mode === draft.runtimeMode)?.label ??
                  draft.runtimeMode
                }
                actions={RUNTIME_MODE_CHOICES.map((choice) => ({
                  id: choice.mode,
                  title: choice.label,
                  state: draft.runtimeMode === choice.mode ? "on" : undefined,
                }))}
                onSelect={(id) => {
                  const choice = RUNTIME_MODE_CHOICES.find((choice) => choice.mode === id);
                  if (choice) setDraft({ ...draft, runtimeMode: choice.mode });
                }}
              />
              <SelectRow
                label="Interaction"
                borderTop
                value={draft.interactionMode === "plan" ? "Plan" : "Default"}
                actions={[
                  {
                    id: "default",
                    title: "Default",
                    state: draft.interactionMode === "default" ? "on" : undefined,
                  },
                  {
                    id: "plan",
                    title: "Plan",
                    state: draft.interactionMode === "plan" ? "on" : undefined,
                  },
                ]}
                onSelect={(id) => {
                  if (id === "default" || id === "plan")
                    setDraft({ ...draft, interactionMode: id });
                }}
              />
            </SettingsSection>

            <SettingsSection title="Workspace">
              <SelectRow
                label="Checkout"
                value={
                  draft.workspace === "worktree"
                    ? "New worktree"
                    : draft.workspace === "root"
                      ? "Project checkout"
                      : "Specific checkout"
                }
                actions={[
                  {
                    id: "worktree",
                    title: "New worktree",
                    state: draft.workspace === "worktree" ? "on" : undefined,
                  },
                  {
                    id: "root",
                    title: "Project checkout",
                    state: draft.workspace === "root" ? "on" : undefined,
                  },
                  {
                    id: "existing_worktree",
                    title: "Specific checkout",
                    state: draft.workspace === "existing_worktree" ? "on" : undefined,
                  },
                ]}
                onSelect={(id) => {
                  if (id === "worktree" || id === "root" || id === "existing_worktree")
                    setDraft({ ...draft, workspace: id });
                }}
              />
              {draft.workspace === "worktree" ? (
                <PickerRow
                  label="Base branch"
                  value={resolveNewTaskBranchLabel({
                    branchName: draft.baseRef,
                    startFromOrigin: draft.startFromOrigin,
                    workspaceMode: "worktree",
                  })}
                  borderTop
                  disabled={
                    !draft.projectId || saving || dictationPending || environmentUnavailable
                  }
                  onPress={() => navigation.navigate("SettingsScheduledTaskBranch")}
                />
              ) : null}
              {draft.workspace === "existing_worktree" ? (
                <FormField
                  label="Checkout path"
                  disabled={saving}
                  value={draft.checkoutPath}
                  borderTop
                  onChange={(checkoutPath) => setDraft({ ...draft, checkoutPath })}
                />
              ) : null}
            </SettingsSection>
          </>
        ) : (
          <Text className="px-2 text-sm text-foreground-muted">
            Bound delivery keeps the thread's current workspace, runtime and interaction modes.
            {boundThread
              ? ` Current modes: ${boundThread.runtimeMode} / ${boundThread.interactionMode}.`
              : ""}{" "}
            Stored new-thread settings are preserved if you later unbind.
          </Text>
        )}

        <SettingsSection title="Schedule">
          <View className="px-4 py-3">
            <SegmentedControl
              variant="card"
              options={[
                { value: "fixed_time", label: "At a time" },
                { value: "interval", label: "Interval" },
                { value: "webhook", label: "On webhook" },
              ]}
              selected={draft.schedule.mode}
              onSelect={(mode) => {
                setTimePickerOpen(false);
                setDraft({
                  ...draft,
                  prompt:
                    mode === "webhook" && !draft.prompt.trim()
                      ? DEFAULT_WEBHOOK_PROMPT
                      : draft.prompt,
                  schedule: { ...draft.schedule, mode },
                });
              }}
            />
          </View>
          {draft.schedule.mode === "fixed_time" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Time, ${formatTime(draft.schedule.timeOfDay)}`}
                onPress={() => setTimePickerOpen((open) => !open)}
                className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
              >
                <Text textRole="body" className="text-foreground">
                  Time
                </Text>
                <Text
                  textRole="footnote"
                  className="min-w-0 flex-1 text-right text-foreground-muted"
                >
                  {formatTime(draft.schedule.timeOfDay)}
                </Text>
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
              {timePickerOpen ? (
                <DateTimePicker
                  value={timePickerValue(draft.schedule.timeOfDay)}
                  mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  onDismiss={() => setTimePickerOpen(false)}
                  onValueChange={(_, selected) => {
                    const timeOfDay = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
                    setDraft({ ...draft, schedule: { ...draft.schedule, timeOfDay } });
                  }}
                />
              ) : null}
              <SelectRow
                label="Repeat"
                value={repeatLabel(draft.schedule.weekdays)}
                borderTop
                actions={[
                  {
                    id: "every_day",
                    title: "Every day",
                    state: draft.schedule.weekdays.length === 7 ? "on" : undefined,
                  },
                  {
                    id: "weekdays",
                    title: "Weekdays",
                    state: repeatLabel(draft.schedule.weekdays) === "Weekdays" ? "on" : undefined,
                  },
                  ...DAYS.map((day) => ({
                    id: String(day.index),
                    title: day.label,
                    attributes: { keepsMenuPresented: true },
                    state: draft.schedule.weekdays.includes(day.index)
                      ? ("on" as const)
                      : undefined,
                  })),
                ]}
                onSelect={(id) => {
                  const weekdays =
                    id === "every_day"
                      ? DAYS.map((day) => day.index)
                      : id === "weekdays"
                        ? [1, 2, 3, 4, 5]
                        : (() => {
                            const day = DAYS.find((item) => String(item.index) === id);
                            if (!day) return draft.schedule.weekdays;
                            return draft.schedule.weekdays.includes(day.index)
                              ? draft.schedule.weekdays.filter((index) => index !== day.index)
                              : [...draft.schedule.weekdays, day.index];
                          })();
                  setDraft({ ...draft, schedule: { ...draft.schedule, weekdays } });
                }}
              />
            </>
          ) : draft.schedule.mode === "webhook" ? (
            <>
              <WebhookScheduleDetails
                environmentId={environmentId}
                // Use the live row for rotated URLs; hide the URL once a loaded list no longer contains the task.
                task={
                  tasks.data
                    ? (tasks.data.tasks.find((task) => task.id === draft.task?.id) ?? null)
                    : draft.task
                }
                signatureConfigured={draft.schedule.signature !== null}
                disabled={!canOperate || saving || environmentUnavailable}
              />
              <FormField
                label="Skip requests older than (minutes)"
                value={draft.schedule.maxDeliveryAgeMinutes}
                placeholder="Run every request"
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(maxDeliveryAgeMinutes) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, maxDeliveryAgeMinutes } })
                }
              />
              <WebhookFilterRows
                filters={draft.schedule.filters}
                disabled={saving}
                onChange={(filters) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, filters } })
                }
              />
              <FormField
                label="Replay key template"
                value={draft.schedule.replayKey}
                placeholder="{{headers.delivery-id}}"
                disabled={saving}
                borderTop
                onChange={(replayKey) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, replayKey } })
                }
              />
              <FormField
                label="Coalesce key template"
                value={draft.schedule.coalesceKey}
                placeholder="{{body.id}}"
                disabled={saving}
                borderTop
                onChange={(coalesceKey) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, coalesceKey } })
                }
              />
              <FormField
                label="Coalesce window (seconds, 10–3600)"
                value={draft.schedule.coalesceWindowSeconds}
                placeholder="120"
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(coalesceWindowSeconds) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, coalesceWindowSeconds } })
                }
              />
              <Text className="px-4 pb-3 text-sm text-foreground-muted">
                Replay keys suppress repeats for 7 days. Coalescing runs the latest payload when the
                window from the first delivery closes. Empty keys run normally.
              </Text>
            </>
          ) : (
            <>
              <FormField
                label="Minutes between runs"
                value={draft.schedule.intervalMinutes}
                keyboardType="decimal-pad"
                disabled={saving}
                borderTop
                onChange={(intervalMinutes) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, intervalMinutes } })
                }
              />
              {Number(draft.schedule.intervalMinutes) < 1 ? (
                <Text className="px-4 pb-3 text-sm text-danger-foreground">
                  Intervals must be at least 1 minute. Update this interval before saving.
                </Text>
              ) : draft.task?.schedule.type === "interval" &&
                draft.task.schedule.everyMs < 60_000 ? (
                <Text className="px-4 pb-3 text-sm text-foreground-muted">
                  This task previously ran more than once per minute. Saving requires an interval of
                  at least 1 minute.
                </Text>
              ) : null}
            </>
          )}
          <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
            <Text textRole="body" className="min-w-0 flex-1 text-foreground">
              Enabled
            </Text>
            <ThemedSwitch
              accessibilityLabel="Task enabled"
              value={draft.enabled}
              onValueChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </View>
        </SettingsSection>
        {draft.schedule.mode === "fixed_time" ? (
          <Text className="px-2 text-sm text-foreground-muted">
            Time uses the environment's time zone, which may differ from your phone's.
          </Text>
        ) : null}
      </View>
      <Button
        tone="primary"
        fullWidth
        loading={saving}
        disabled={
          !canOperate ||
          dictationPending ||
          taskMissing ||
          environmentUnavailable ||
          taskUnavailable ||
          bindingUnavailable ||
          ownerChanged
        }
        onPress={() => void save()}
        label={saving ? "Saving…" : draft.task ? "Save changes" : "Create task"}
      />
    </View>
  );
}

function WebhookScheduleDetails({
  environmentId,
  task,
  signatureConfigured,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly signatureConfigured: boolean;
  readonly disabled: boolean;
}) {
  const [rotating, setRotating] = useState(false);
  const canOperate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const webhook = canOperate && task?.schedule.type === "webhook" ? task.webhook : undefined;
  const resolved = webhook ? webhookAddress(webhook, httpBaseUrl) : null;
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        {
          "The prompt can use {{body.a.b}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}}. The filled-in prompt is all the agent sees."
        }
      </Text>
      {task === null || resolved === null ? (
        <Text className="text-sm text-foreground-muted">
          {!canOperate
            ? "Webhook URLs require operate permission."
            : task === null
              ? "Save the task to get its webhook URL."
              : "The webhook URL is unavailable in this connection."}
        </Text>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy webhook URL"
            accessibilityHint="Copies the URL to the clipboard"
            disabled={!resolved.copyable}
            onPress={() => {
              if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
                void tryCopyTextWithHaptic(resolved.address);
              }
            }}
            className="gap-1 active:opacity-70"
          >
            <Text textRole="body" className="text-foreground">
              {resolved.copyable ? "Webhook URL" : "Webhook path"}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={2} selectable>
              {resolved.address}
            </Text>
          </Pressable>
          {resolved.note !== null ? (
            <Text className="text-sm text-foreground-muted">{resolved.note}</Text>
          ) : null}
          <Button
            label={rotating ? "Rotating…" : "Rotate URL"}
            tone="danger"
            disabled={disabled || rotating}
            onPress={() =>
              Dialog.alert("Rotate URL?", "The current URL stops working immediately.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Rotate",
                  style: "destructive",
                  onPress: () => {
                    setRotating(true);
                    void rotate({ environmentId, input: { id: task.id } }).then((result) => {
                      setRotating(false);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        Dialog.alert(
                          "Could not rotate URL",
                          String(squashAtomCommandFailure(result)),
                        );
                      }
                    });
                  },
                },
              ])
            }
            loading={rotating}
          />
        </>
      )}
      {signatureConfigured ? (
        <Text className="text-sm text-foreground-muted">
          Signature check configured on desktop/web.
        </Text>
      ) : null}
    </View>
  );
}

function EnvironmentTasks({
  environment,
  now,
  projectIds,
  taskId,
  onCreate,
  onEdit,
}: {
  readonly environment: SettingsTarget;
  readonly now: number;
  readonly projectIds: readonly ProjectId[] | null;
  readonly taskId?: ScheduledTaskId;
  readonly onCreate?: () => void;
  readonly onEdit: (task: ScheduledTask) => void;
}) {
  const environmentId = environment.environmentId;
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const visibleTasks = tasks.data?.tasks.filter((task) =>
    scheduledTaskInScope(task, projectIds, taskId),
  );
  const { selectThreadRoute } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const deepLinkOpened = useRef<ScheduledTaskId | null>(null);
  useEffect(() => {
    if (
      taskId === undefined ||
      deepLinkOpened.current === taskId ||
      tasks.error ||
      !tasks.isSuccess ||
      !navigation.isFocused()
    )
      return;
    const task = tasks.data?.tasks.find((entry) => scheduledTaskInScope(entry, projectIds, taskId));
    if (!task) return;
    onEdit(task);
    deepLinkOpened.current = taskId;
  }, [navigation, onEdit, projectIds, taskId, tasks.data, tasks.error, tasks.isSuccess]);
  const pendingAction = useRef(false);
  const [pendingTaskId, setPendingTaskId] = useState<ScheduledTaskId | null>(null);
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
    reportFailure: false,
  });
  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const act = async (task: ScheduledTask, action: "run" | "toggle" | "delete") => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      pendingAction.current ||
      tasks.error ||
      !tasks.isSuccess
    )
      return;
    pendingAction.current = true;
    setPendingTaskId(task.id);
    try {
      if (action === "run") {
        if (task.schedule.type === "webhook") return;
        const result = await runNow({ environmentId, input: { id: task.id } });
        if (result._tag === "Failure") {
          failure("Could not dispatch task", result);
        } else if (result.value.task.lastRunStatus === "failed") {
          Dialog.alert(
            "Dispatch failed",
            result.value.task.lastRunError ?? "The prompt was not dispatched.",
          );
        } else {
          const threadId = result.value.threadId;
          Dialog.alert(
            "Dispatch accepted",
            "The prompt was dispatched or queued. This is not confirmation that the agent finished.",
            threadId
              ? [
                  { text: "Close", style: "cancel" },
                  {
                    text: "Open thread",
                    onPress: () => selectThreadRoute({ environmentId, threadId }),
                  },
                ]
              : [{ text: "Close" }],
          );
        }
        return;
      }
      const result =
        action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await remove({ environmentId, input: { id: task.id } });
      failure(`Could not ${action === "toggle" ? "update" : "delete"} task`, result);
    } finally {
      pendingAction.current = false;
      setPendingTaskId(null);
    }
  };

  return (
    <SettingsSection
      title={environment.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
      }
    >
      {onCreate ? (
        <View className="gap-2 p-4">
          <Button
            label="New workflow"
            disabled={!canOperate || pendingTaskId !== null}
            onPress={onCreate}
          />
          {!canOperate ? (
            <Text className="text-sm text-foreground-muted">
              Read-only: workflow changes and dispatch require operate permission.
            </Text>
          ) : null}
        </View>
      ) : null}
      {tasks.error ? (
        <View className="gap-2 p-4">
          <Text className="text-base text-danger-foreground">{tasks.error}</Text>
          <Button label="Retry workflows" onPress={tasks.refresh} />
        </View>
      ) : !tasks.data ? (
        <Text className="p-4 text-base text-foreground-muted">Loading tasks…</Text>
      ) : visibleTasks?.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {taskId !== undefined
            ? "This workflow is unavailable in the selected scope. No other workflow has been opened."
            : projectIds === null
              ? "No scheduled tasks yet."
              : "No tasks in this project."}
        </Text>
      ) : (
        visibleTasks?.map((task, index) => (
          <View
            key={task.id}
            className={
              index === 0
                ? "flex-row items-start gap-1 px-4 py-3"
                : "flex-row items-start gap-1 border-t border-border-subtle px-4 py-3"
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${task.title}`}
              onPress={() => {
                onEdit(task);
              }}
              className="min-w-0 flex-1 gap-1 active:opacity-70"
            >
              <Text textRole="body" className="text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {describeSchedule(task)}
                {!task.enabled
                  ? " · Paused"
                  : task.nextRunAt
                    ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                    : ""}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {task.runCount} dispatch attempt{task.runCount === 1 ? "" : "s"}
                {task.lastRunAt ? ` · Latest: ${new Date(task.lastRunAt).toLocaleString()}` : ""}
                {task.lastRunStatus === "never"
                  ? " · Never dispatched"
                  : task.lastRunStatus === "failed"
                    ? " · Dispatch failed"
                    : task.lastRunStatus === "running"
                      ? " · Dispatching"
                      : " · Dispatch accepted"}
              </Text>
              {task.lastRunError ? (
                <Text className="text-sm text-danger-foreground" numberOfLines={2}>
                  Latest dispatch failed: {task.lastRunError}
                </Text>
              ) : null}
            </Pressable>
            <Menu
              actions={[
                { id: "edit", title: "Edit" },
                {
                  id: "toggle",
                  title: task.enabled ? "Pause" : "Resume",
                  attributes: { disabled: !canOperate || pendingTaskId !== null },
                },
                ...(task.schedule.type === "webhook"
                  ? []
                  : [
                      {
                        id: "run",
                        title: "Run now",
                        attributes: { disabled: !canOperate || pendingTaskId !== null },
                      },
                    ]),
                {
                  id: "delete",
                  title: "Delete",
                  attributes: {
                    destructive: true,
                    disabled: !canOperate || pendingTaskId !== null,
                  },
                },
              ]}
              onPressAction={({ nativeEvent }) => {
                const action = nativeEvent.event;
                if (action === "edit") {
                  onEdit(task);
                } else if (action === "delete") {
                  Dialog.alert("Delete task?", task.title, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => void act(task, "delete"),
                    },
                  ]);
                } else if (action === "toggle" || action === "run") {
                  void act(task, action);
                }
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Actions for ${task.title}`}
                className="h-11 w-11 items-center justify-center"
              >
                <SymbolView
                  name="ellipsis"
                  size={18}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </Pressable>
            </Menu>
          </View>
        ))
      )}
    </SettingsSection>
  );
}
