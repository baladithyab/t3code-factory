import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  consumeFactoryWorkflowTarget,
  factoryInboxSelectionAtom,
  openFactoryIssues,
  selectFactoryScope,
  updateFactoryInboxSelection,
  type FactoryInboxSelection,
} from "./factory-inbox-state";

const environmentId = EnvironmentId.make("selected-environment");
const projectId = ProjectId.make("selected-project");
const taskId = ScheduledTaskId.make("previous-workflow");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
  options: [{ id: "effort", value: "high" }],
};

function setup(patch: Partial<FactoryInboxSelection> = {}): void {
  const previous = appAtomRegistry.get(factoryInboxSelectionAtom);
  onTestFinished(() => appAtomRegistry.set(factoryInboxSelectionAtom, previous));
  appAtomRegistry.set(factoryInboxSelectionAtom, {
    environmentId: null,
    projectId: null,
    filter: "open",
    section: "overview",
    taskId: null,
    modelSelection: null,
    baseRef: null,
    runtimeMode: "approval-required",
    ...patch,
  });
}

describe("openFactoryIssues", () => {
  it("opens the selected project's issues from the initial overview", () => {
    setup();

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "open",
      section: "issues",
      taskId: null,
      modelSelection: null,
      baseRef: null,
      runtimeMode: "approval-required",
    });
  });

  it("opens another project's issues from orchestrator without reusing its model or base", () => {
    setup({
      environmentId,
      projectId: ProjectId.make("previous-project"),
      section: "orchestrator",
      filter: "closed",
      modelSelection,
      baseRef: "release/previous-project",
      runtimeMode: "full-access",
    });

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "closed",
      section: "issues",
      taskId: null,
      modelSelection: null,
      baseRef: null,
      runtimeMode: "full-access",
    });
  });

  it("opens the same project's issues and clears the workflow target while retaining its model and base", () => {
    setup({
      environmentId,
      projectId,
      section: "workflows",
      taskId,
      filter: "all",
      modelSelection,
      baseRef: "release/selected-project",
      runtimeMode: "full-access",
    });

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "all",
      section: "issues",
      taskId: null,
      modelSelection,
      baseRef: "release/selected-project",
      runtimeMode: "full-access",
    });
  });

  it("opens issues on another environment and clears workflow, model and base even when project IDs match", () => {
    setup({
      environmentId: EnvironmentId.make("previous-environment"),
      projectId,
      section: "workflows",
      taskId,
      filter: "closed",
      modelSelection,
      baseRef: "release/previous-environment",
    });

    openFactoryIssues(environmentId, projectId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
      environmentId,
      projectId,
      filter: "closed",
      section: "issues",
      taskId: null,
      modelSelection: null,
      baseRef: null,
      runtimeMode: "approval-required",
    });
  });
});

describe("consumeFactoryWorkflowTarget", () => {
  it("clears only the opened target and keeps the workflow section and reviewed checkout", () => {
    setup({
      environmentId,
      projectId,
      section: "workflows",
      taskId,
      filter: "closed",
      modelSelection,
      baseRef: "release/selected-project",
      runtimeMode: "full-access",
    });
    const requested = appAtomRegistry.get(factoryInboxSelectionAtom);

    consumeFactoryWorkflowTarget(requested, taskId);

    const consumed = appAtomRegistry.get(factoryInboxSelectionAtom);
    expect(consumed).toEqual({ ...requested, taskId: null });
    consumeFactoryWorkflowTarget(requested, taskId);
    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(consumed);
  });

  it("retains the intent when a different workflow opens", () => {
    setup({ environmentId, projectId, section: "workflows", taskId });
    const requested = appAtomRegistry.get(factoryInboxSelectionAtom);

    consumeFactoryWorkflowTarget(requested, ScheduledTaskId.make("another-workflow"));

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(requested);
  });

  it.each([taskId, ScheduledTaskId.make("newer-workflow")])(
    "does not let a stale callback consume a subsequent request for %s",
    (nextTaskId) => {
      setup({ environmentId, projectId, section: "workflows", taskId });
      const previousRequest = appAtomRegistry.get(factoryInboxSelectionAtom);
      updateFactoryInboxSelection({ section: "workflows", taskId: nextTaskId });
      const nextRequest = appAtomRegistry.get(factoryInboxSelectionAtom);

      consumeFactoryWorkflowTarget(previousRequest, taskId);
      expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(nextRequest);

      consumeFactoryWorkflowTarget(nextRequest, nextTaskId);
      expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toEqual({
        ...nextRequest,
        taskId: null,
      });
    },
  );

  it("does not restore a target or old checkout after the scope changes", () => {
    setup({ environmentId, projectId, section: "workflows", taskId });
    const requested = appAtomRegistry.get(factoryInboxSelectionAtom);
    selectFactoryScope(null, null);
    const allProjects = appAtomRegistry.get(factoryInboxSelectionAtom);

    consumeFactoryWorkflowTarget(requested, taskId);

    expect(appAtomRegistry.get(factoryInboxSelectionAtom)).toBe(allProjects);
    expect(allProjects).toMatchObject({
      environmentId: null,
      projectId: null,
      section: "workflows",
      taskId: null,
    });
  });
});
