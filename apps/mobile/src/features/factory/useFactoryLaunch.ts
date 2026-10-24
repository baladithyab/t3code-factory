import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";

import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";
import type { FactoryInboxSelection } from "./factory-inbox-state";

/** Projects a task can start in. A scratch folder has no repository, so it has no issues. */
export function useFactoryProjects(environmentId: EnvironmentId | null) {
  const projects = useProjects();
  return useMemo(
    () =>
      environmentId === null
        ? []
        : projects.filter(
            (project) => project.environmentId === environmentId && !project.isScratch,
          ),
    [environmentId, projects],
  );
}

export function findFactoryProject(
  projects: ReadonlyArray<EnvironmentProject>,
  projectId: ProjectId | null,
): EnvironmentProject | null {
  return projects.find((project) => project.id === projectId) ?? null;
}

/**
 * The model a launch will use: the user's explicit pick, otherwise the project's default through
 * the same resolution new tasks and scheduled tasks use.
 */
export function useFactoryLaunchModel(selection: FactoryInboxSelection) {
  const config = useEnvironmentServerConfig(selection.environmentId);
  const projects = useFactoryProjects(selection.environmentId);
  const project = findFactoryProject(projects, selection.projectId);
  const explicit = selection.modelSelection;
  const modelSelection: ModelSelection | null = useMemo(
    () => explicit ?? scheduledTaskDefaultModel(config, project),
    [config, explicit, project],
  );
  const projectId = selection.projectId;
  const modelOptions = useMemo(
    () => buildModelOptions(config, modelSelection, undefined, projectId),
    [config, modelSelection, projectId],
  );
  const option: ModelOption | null =
    modelOptions.find(
      (candidate) =>
        candidate.selection.instanceId === modelSelection?.instanceId &&
        candidate.selection.model === modelSelection.model,
    ) ?? null;
  return {
    config,
    project,
    modelSelection,
    modelOptions,
    option,
    label: option?.label ?? modelSelection?.model ?? null,
  };
}
