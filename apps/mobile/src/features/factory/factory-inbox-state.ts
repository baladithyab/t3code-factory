import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { FACTORY_DEFAULT_RUNTIME_MODE, type FactoryIssueFilter } from "./factoryIssues";

export type FactorySection = "overview" | "issues" | "briefs" | "workflows" | "orchestrator";

/**
 * Factory-owned scope and section, independent from Settings filters. Model and branch picker
 * routes edit the same selection so returning to Factory retains the reviewed checkout.
 */
export interface FactoryInboxSelection {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly filter: FactoryIssueFilter;
  readonly section: FactorySection;
  readonly taskId: ScheduledTaskId | null;
  /** Null until the user picks one; the project's default applies until then. */
  readonly modelSelection: ModelSelection | null;
  /** Null starts from the project's current local HEAD. */
  readonly baseRef: string | null;
  readonly runtimeMode: RuntimeMode;
}

const INITIAL_SELECTION: FactoryInboxSelection = {
  environmentId: null,
  projectId: null,
  filter: "open",
  section: "overview",
  taskId: null,
  modelSelection: null,
  baseRef: null,
  runtimeMode: FACTORY_DEFAULT_RUNTIME_MODE,
};

export const factoryInboxSelectionAtom = Atom.make<FactoryInboxSelection>(INITIAL_SELECTION).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-factory-inbox-selection"),
);

export function useFactoryInboxSelection(): FactoryInboxSelection {
  return useAtomValue(factoryInboxSelectionAtom);
}

export function updateFactoryInboxSelection(patch: Partial<FactoryInboxSelection>): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({ ...current, ...patch }));
}

export function openFactoryIssues(environmentId: EnvironmentId, projectId: ProjectId): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) => ({
    ...current,
    environmentId,
    projectId,
    section: "issues" as const,
    taskId: null,
    ...(current.environmentId === environmentId && current.projectId === projectId
      ? {}
      : { modelSelection: null, baseRef: null }),
  }));
}

/**
 * A completion belongs to its captured selection, not just its task id: a later request may
 * open the same workflow again. Loading and failed opens must retain the pending target.
 */
export function consumeFactoryWorkflowTarget(
  requested: FactoryInboxSelection,
  openedTaskId: ScheduledTaskId,
): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) =>
    current === requested && current.section === "workflows" && current.taskId === openedTaskId
      ? { ...current, taskId: null }
      : current,
  );
}

/** Null ids are the Factory's all/environment scope, independent from Settings filters. */
export function selectFactoryScope(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): void {
  appAtomRegistry.update(factoryInboxSelectionAtom, (current) =>
    current.environmentId === environmentId && current.projectId === projectId
      ? current
      : {
          ...current,
          environmentId,
          projectId,
          taskId: null,
          modelSelection: null,
          baseRef: null,
        },
  );
}
