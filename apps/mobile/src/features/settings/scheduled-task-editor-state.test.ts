import {
  EnvironmentId,
  ProjectId,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  createDraft,
  createFactoryDraft,
  editDraft,
  hasScheduledTaskDraftChanges,
  scheduleFromDraft,
} from "./scheduledTaskDraft";
import {
  discardScheduledTaskEditor,
  markScheduledTaskEditorSaved,
  readScheduledTaskEditor,
  moveScheduledTaskEditor,
  scheduledTaskInScope,
  scheduledTaskEditorSessionAtom,
  startScheduledTaskEditor,
  takeScheduledTaskNewLink,
  updateScheduledTaskEditor,
} from "./scheduled-task-editor-state";

const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const decodeScheduledTask = Schema.decodeUnknownSync(ScheduledTask);

afterEach(() => appAtomRegistry.set(scheduledTaskEditorSessionAtom, null));

describe("scheduled task voice draft", () => {
  const editor = {
    environmentId: EnvironmentId.make("environment"),
    environmentLabel: "Environment",
    draft: createDraft(null, null),
  };

  it("keeps the prompt outside the screen and retains its original change baseline", () => {
    startScheduledTaskEditor(editor);
    const original = appAtomRegistry.get(scheduledTaskEditorSessionAtom)!;
    const ownerKey = `scheduled-task:${original.id}`;
    updateScheduledTaskEditor(
      (current) =>
        current && {
          ...current,
          draft: { ...current.draft, prompt: "spoken prompt" },
        },
      null,
    );

    expect(readScheduledTaskEditor(ownerKey, null)?.draft.prompt).toBe("spoken prompt");
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.initial).toBe(editor);
  });

  it("rejects an old voice target when another task opens in the same environment", () => {
    startScheduledTaskEditor(editor);
    const original = appAtomRegistry.get(scheduledTaskEditorSessionAtom)!;
    startScheduledTaskEditor({ ...editor, draft: { ...editor.draft, prompt: "other task" } });

    expect(readScheduledTaskEditor(`scheduled-task:${original.id}`, editor)).toBeNull();
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current?.draft.prompt).toBe(
      "other task",
    );
  });

  it("does not restore the default prompt after the editor is discarded", () => {
    startScheduledTaskEditor(null);
    const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom)!;
    expect(readScheduledTaskEditor(`scheduled-task:${session.id}`, editor)).toBeNull();
    updateScheduledTaskEditor((current) => current, editor);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBeNull();
  });
});

describe("new scheduled task link", () => {
  const editing = {
    environmentId: EnvironmentId.make("environment"),
    environmentLabel: "Environment",
    draft: createDraft(null, null),
  };
  const newTaskLink = {
    routes: [
      { name: "Home" },
      {
        name: "SettingsSheet",
        state: {
          routes: [{ name: "SettingsScheduledTasks" }, { name: "SettingsScheduledTaskNew" }],
        },
      },
    ],
  };

  it("drops the last edited task so the new-task screen starts from the default", () => {
    startScheduledTaskEditor(editing);
    expect(takeScheduledTaskNewLink(newTaskLink)).toBe(newTaskLink);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)).toBeNull();
  });

  it("keeps unsaved changes until the editor's removal guard discards them", () => {
    startScheduledTaskEditor(editing);
    const edited = { ...editing, draft: { ...editing.draft, prompt: "unsaved" } };
    updateScheduledTaskEditor(edited, null);

    takeScheduledTaskNewLink(newTaskLink);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBe(edited);

    discardScheduledTaskEditor();
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)).toBeNull();
  });

  it("starts the new-task screen fresh after the edited task was saved", () => {
    startScheduledTaskEditor(editing);
    updateScheduledTaskEditor({ ...editing, draft: { ...editing.draft, prompt: "saved" } }, null);
    markScheduledTaskEditorSaved();

    takeScheduledTaskNewLink(newTaskLink);
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)).toBeNull();
  });

  it("closes a discarded editor as empty when no new-task link is waiting", () => {
    startScheduledTaskEditor(editing);
    discardScheduledTaskEditor();
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBeNull();
  });

  it("keeps the editor for links to other screens", () => {
    startScheduledTaskEditor(editing);
    takeScheduledTaskNewLink({ routes: [{ name: "SettingsSheet" }] });
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toBe(editing);
  });
});

describe("workflow owner boundaries", () => {
  const environmentId = EnvironmentId.make("owner-environment");
  const otherEnvironmentId = EnvironmentId.make("other-environment");
  const projectId = ProjectId.make("owner-project");
  const otherProjectId = ProjectId.make("other-project");
  const threadId = ThreadId.make("bound-thread");
  const taskId = ScheduledTaskId.make("requested-workflow");
  const target = { environmentId: otherEnvironmentId, environmentLabel: "Other environment" };

  it("creates paused Factory workflows with a schema-valid approval-required runtime", () => {
    const draft = createFactoryDraft(projectId, null);
    expect(draft.enabled).toBe(false);
    expect(draft.threadId).toBeNull();
    expect(decodeRuntimeMode(draft.runtimeMode)).toBe("approval-required");
    expect(createDraft(projectId, null).enabled).toBe(true);
    expect(createDraft(projectId, null).runtimeMode).toBe("full-access");
  });

  it("does not move a binding or an explicitly scoped Factory draft to another environment", () => {
    const draft = createFactoryDraft(projectId, null);
    const editor = { environmentId, environmentLabel: "Owner", draft };
    expect(
      moveScheduledTaskEditor(
        { ...editor, draft: { ...draft, threadId } },
        target,
        createDraft(otherProjectId, null),
      ),
    ).toBeNull();
    expect(
      moveScheduledTaskEditor(
        { ...editor, environmentScope: environmentId },
        target,
        createDraft(otherProjectId, null),
      ),
    ).toBeNull();
    expect(
      moveScheduledTaskEditor(
        { ...editor, projectScope: projectId },
        target,
        createDraft(otherProjectId, null),
      ),
    ).toBeNull();
  });

  it("preserves signing, filtering, workspace and permission choices during an allowed owner move", () => {
    const initial = createFactoryDraft(projectId, null);
    const draft = {
      ...initial,
      title: "Signed workflow",
      prompt: "Review {{body.title}}",
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
      workspace: "existing_worktree" as const,
      checkoutPath: "/review",
      schedule: {
        ...initial.schedule,
        mode: "webhook" as const,
        signature: { header: "x-signature", encoding: "hex" as const, prefix: "sha256=" },
        filters: [{ id: "event", path: "body.action", op: "equals" as const, value: "opened" }],
        replayKey: "{{headers.delivery-id}}",
      },
    };
    const next = moveScheduledTaskEditor(
      { environmentId, environmentLabel: "Owner", draft },
      target,
      createDraft(null, null),
    );
    expect(next?.environmentId).toBe(otherEnvironmentId);
    expect(next?.draft).toEqual({
      ...draft,
      projectId: null,
      modelSelectionIsExplicit: false,
    });
    expect(next && scheduleFromDraft(next.draft.schedule)).toMatchObject({
      type: "webhook",
      signature: draft.schedule.signature,
      filters: [{ path: "body.action", op: "equals", value: "opened" }],
      dedupe: { replayKey: "{{headers.delivery-id}}" },
    });
  });

  it("treats deliberate unbinding and interaction changes as unsaved edits", () => {
    const initial = { ...createDraft(projectId, null), threadId };
    expect(hasScheduledTaskDraftChanges(initial, { ...initial, threadId: null })).toBe(true);
    expect(hasScheduledTaskDraftChanges(initial, { ...initial, interactionMode: "plan" })).toBe(
      true,
    );
    startScheduledTaskEditor({ environmentId, environmentLabel: "Owner", draft: initial });
    updateScheduledTaskEditor(
      (editor) => editor && { ...editor, draft: { ...editor.draft, threadId: null } },
      null,
    );
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.initial?.draft.threadId).toBe(
      threadId,
    );
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current?.draft.threadId).toBeNull();
  });

  it("never substitutes another workflow or project for an unavailable deep link", () => {
    const ownerTask = { id: taskId, projectId };
    const otherTask = { id: ScheduledTaskId.make("different-workflow"), projectId };
    expect(scheduledTaskInScope(ownerTask, [projectId], taskId)).toBe(true);
    expect(scheduledTaskInScope(ownerTask, [otherProjectId], taskId)).toBe(false);
    expect(scheduledTaskInScope(otherTask, [projectId], taskId)).toBe(false);
    expect(scheduledTaskInScope(ownerTask, [], taskId)).toBe(false);
    expect([otherTask].filter((task) => scheduledTaskInScope(task, null, taskId))).toEqual([]);
  });
});

describe("existing workflow editing", () => {
  it("opens an existing signed, bound task without applying Factory creation defaults", () => {
    const task = decodeScheduledTask({
      id: "signed-bound-task",
      projectId: "existing-project",
      threadId: "existing-other-thread",
      title: "Review event",
      prompt: "Review {{body.title}}",
      enabled: true,
      schedule: {
        type: "webhook",
        signature: { header: "x-signature", encoding: "hex", prefix: "sha256=" },
        filters: [{ path: "body.action", op: "equals", value: "opened" }],
        dedupe: { replayKey: "{{headers.delivery-id}}" },
        maxDeliveryAgeMinutes: 15,
      },
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/existing/checkout" },
      modelSelection: { instanceId: "codex", model: "stored-model" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: "2026-10-24T00:00:00.000Z",
      updatedAt: "2026-10-24T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    });
    const draft = editDraft(task);
    expect(draft).toMatchObject({
      task,
      threadId: task.threadId,
      projectId: task.projectId,
      enabled: task.enabled,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
      checkoutPath: "/existing/checkout",
    });
    expect(scheduleFromDraft(draft.schedule)).toMatchObject({
      type: "webhook",
      signature: task.schedule.type === "webhook" ? task.schedule.signature : null,
      dedupe: { replayKey: "{{headers.delivery-id}}" },
      maxDeliveryAgeMinutes: 15,
    });
    expect(
      moveScheduledTaskEditor(
        {
          environmentId: EnvironmentId.make("owner"),
          environmentLabel: "Owner",
          factory: true,
          draft,
        },
        { environmentId: EnvironmentId.make("different"), environmentLabel: "Different" },
        createFactoryDraft(null, null),
      ),
    ).toBeNull();
  });
});
