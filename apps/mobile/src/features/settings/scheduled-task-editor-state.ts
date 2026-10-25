import type { EnvironmentId, ProjectId, ScheduledTask, ScheduledTaskId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import type { ScheduledTaskDraft } from "./scheduledTaskDraft";

export type ScheduledTaskEditor = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly draft: ScheduledTaskDraft;
  readonly factory?: boolean;
  readonly environmentScope?: EnvironmentId;
  readonly projectScope?: ProjectId;
};

type ScheduledTaskEditorSession = {
  readonly id: number;
  readonly initial: ScheduledTaskEditor | null;
  readonly current: ScheduledTaskEditor | null;
};

export const scheduledTaskEditorSessionAtom = Atom.make<ScheduledTaskEditorSession | null>(
  null,
).pipe(Atom.keepAlive);
let nextEditorId = 0;

export function startScheduledTaskEditor(next: ScheduledTaskEditor | null): void {
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, {
    id: ++nextEditorId,
    initial: next,
    current: next,
  });
}

export function updateScheduledTaskEditor(
  update:
    | ScheduledTaskEditor
    | null
    | ((current: ScheduledTaskEditor | null) => ScheduledTaskEditor | null),
  defaultEditor: ScheduledTaskEditor | null,
): void {
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  const previous = session ? session.current : defaultEditor;
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, {
    id: session?.id ?? 0,
    initial: session ? session.initial : previous,
    current: typeof update === "function" ? update(previous) : update,
  });
}

export function readScheduledTaskEditor(
  voiceOwnerKey: string,
  defaultEditor: ScheduledTaskEditor | null,
): ScheduledTaskEditor | null {
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  if (`scheduled-task:${session?.id ?? 0}` !== voiceOwnerKey) return null;
  return session ? session.current : defaultEditor;
}

/** A bound workflow must be explicitly unbound before moving its owner. */
export function moveScheduledTaskEditor(
  editor: ScheduledTaskEditor,
  target: Pick<ScheduledTaskEditor, "environmentId" | "environmentLabel">,
  destination: ScheduledTaskDraft,
): ScheduledTaskEditor | null {
  if (editor.environmentId === target.environmentId) return editor;
  if (editor.draft.task || editor.draft.threadId || editor.projectScope || editor.environmentScope)
    return null;
  return {
    ...editor,
    ...target,
    draft: {
      ...editor.draft,
      projectId: destination.projectId,
      modelSelection: destination.modelSelection,
      modelSelectionIsExplicit: false,
    },
  };
}

export function scheduledTaskInScope(
  task: Pick<ScheduledTask, "id" | "projectId">,
  projectIds: readonly ProjectId[] | null,
  taskId?: ScheduledTaskId,
): boolean {
  return (
    (projectIds === null || projectIds.includes(task.projectId)) &&
    (taskId === undefined || task.id === taskId)
  );
}
