import {
  StackActions,
  useNavigation,
  type NavigationAction,
  type NavigationState,
} from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type FactoryIssue,
  type FactoryRepository,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { factoryEnvironment } from "../../state/factory";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import {
  describeFactoryFailure,
  FACTORY_SUPERVISION_NOTICE,
  factoryIssueStartKey,
  factoryRepositoryLabel,
  safeFactoryIssueText,
  type FactoryIssueAction,
} from "./factoryIssues";

interface NavigationNode {
  readonly dispatch: (action: NavigationAction) => void;
  readonly getParent: () => NavigationNode | undefined;
  readonly getState: () => NavigationState | undefined;
}

/**
 * Opens an existing thread with the normal chat, Git, and pull request controls. Settings is a
 * sheet over the workspace, so it is replaced rather than left underneath the thread.
 */
export function useOpenFactoryThread() {
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  return useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) => {
      const params = { environmentId: String(environmentId), threadId: String(threadId) };
      if (Platform.OS === "android") {
        selectAndroidWorkspace({ name: "Thread", params });
        return;
      }
      let root: NavigationNode = navigation;
      while (!root.getState()?.routeNames.includes("Thread")) {
        const parent = root.getParent();
        if (!parent) break;
        root = parent;
      }
      root.dispatch(StackActions.replace("Thread", params));
    },
    [navigation, selectAndroidWorkspace],
  );
}

export interface FactoryStartSettings {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repository: FactoryRepository | null;
  readonly modelSelection: ModelSelection | null;
  readonly modelLabel: string;
  readonly baseRef: string | null;
  readonly runtimeMode: RuntimeMode;
}

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/**
 * Starts, resumes, restarts, or opens the task for one issue. A start asks first so the user sees
 * the repository, model, base, and supervision they are authorizing. Each logical attempt keeps
 * one command id across retries, so a dropped response replays the same reservation instead of
 * racing a second launch.
 */
export function useFactoryIssueActions(input: {
  readonly settings: FactoryStartSettings | null;
  readonly onSettled: () => void;
  readonly scopeKey: string | null;
}) {
  const { settings, onSettled, scopeKey } = input;
  const run = useAtomCommand(factoryEnvironment.start, { reportFailure: false });
  const openThread = useOpenFactoryThread();
  const lifetime = useRef<{ readonly key: string; active: boolean; pending: boolean } | null>(null);
  const commandIds = useRef(new Map<string, string>());
  const [busy, setBusy] = useState<{
    readonly key: string | null;
    readonly issue: number | null;
  }>({ key: scopeKey, issue: null });
  if (busy.key !== scopeKey) setBusy({ key: scopeKey, issue: null });
  useLayoutEffect(() => {
    if (scopeKey === null) {
      lifetime.current = null;
      return;
    }
    const current = { key: scopeKey, active: true, pending: false };
    lifetime.current = current;
    return () => {
      current.active = false;
    };
  }, [scopeKey]);

  const launch = useCallback(
    async (issue: FactoryIssue, restartDeleted: boolean) => {
      const current = lifetime.current;
      if (
        current === null ||
        !current.active ||
        current.key !== scopeKey ||
        current.pending ||
        settings === null ||
        settings.repository === null
      )
        return;
      const reserved = issue.task?.status === "launching" ? issue.task : null;
      const modelSelection = reserved?.modelSelection ?? settings.modelSelection;
      if (modelSelection === null) return;
      const { environmentId, projectId, repository, baseRef } = settings;
      const runtimeMode = reserved?.runtimeMode ?? settings.runtimeMode;
      const interactionMode = reserved?.interactionMode ?? "default";
      const key = factoryIssueStartKey({
        environmentId,
        projectId,
        expectedRepositoryKey: repository.canonicalKey,
        issueNumber: issue.number,
        restartDeleted,
        previousThreadId: restartDeleted ? (issue.task?.threadId ?? null) : null,
      });
      let commandId = commandIds.current.get(key);
      if (commandId === undefined) {
        commandId = uuidv4();
        commandIds.current.set(key, commandId);
      }
      current.pending = true;
      setBusy({ key: scopeKey, issue: issue.number });
      const result = await run({
        environmentId,
        input: {
          commandId: CommandId.make(commandId),
          projectId,
          issueNumber: issue.number,
          expectedRepositoryKey: repository.canonicalKey,
          modelSelection,
          runtimeMode,
          interactionMode,
          ...(baseRef === null ? {} : { baseRef }),
          ...(restartDeleted ? { restartDeleted: true } : {}),
          creationSource: "mobile",
        },
      });
      current.pending = false;
      if (!current.active) return;
      setBusy({ key: scopeKey, issue: null });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = describeFactoryFailure(
            squashAtomCommandFailure(result),
            "Couldn't start the task",
          );
          Dialog.alert(failure.title, failure.detail);
        }
        // The server may have recorded an outcome (or the issue changed) before the failure.
        onSettled();
        return;
      }
      commandIds.current.delete(key);
      onSettled();
      openThread(environmentId, result.value.threadId);
    },
    [onSettled, openThread, run, scopeKey, settings],
  );

  const perform = useCallback(
    (issue: FactoryIssue, action: FactoryIssueAction) => {
      const current = lifetime.current;
      if (
        action.kind === "unavailable" ||
        current === null ||
        !current.active ||
        current.key !== scopeKey ||
        current.pending
      )
        return;
      if (action.kind === "open") {
        if (settings === null) return;
        openThread(settings.environmentId, action.task.threadId);
        return;
      }
      if (settings === null || (action.kind !== "resume" && settings.modelSelection === null)) {
        Dialog.alert("Choose a model", "Pick a model and provider before starting a task.");
        return;
      }
      if (settings.repository === null) {
        Dialog.alert("Repository unavailable", "Refresh the inbox before starting a task.");
        return;
      }
      if (action.kind === "resume") {
        void launch(issue, false);
        return;
      }
      const restart = action.kind === "restart";
      const repository = factoryRepositoryLabel(settings.repository);
      Dialog.confirm({
        title: restart ? "Start a new attempt?" : "Start this task?",
        message: [
          `#${issue.number} ${safeFactoryIssueText(issue.title, 140)}`,
          repository,
          restart
            ? "The earlier thread was deleted. A new attempt creates a new isolated worktree."
            : "This creates an isolated worktree for the issue.",
          `Model: ${settings.modelLabel}`,
          `Base: ${settings.baseRef ?? "Current HEAD"}`,
          `Runtime: ${RUNTIME_MODE_LABELS[settings.runtimeMode]}`,
          FACTORY_SUPERVISION_NOTICE,
        ].join("\n\n"),
        confirmText: restart ? "Start new attempt" : "Start task",
        onConfirm: () => {
          void launch(issue, restart);
        },
      });
    },
    [launch, openThread, scopeKey, settings],
  );

  return { busyIssue: busy.key === scopeKey ? busy.issue : null, perform };
}
