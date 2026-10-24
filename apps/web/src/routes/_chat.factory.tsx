import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FactoryIssuesPage } from "../components/factory/FactoryIssuesPage";
import {
  parseFactoryStateFilter,
  type FactoryIssuesSearch,
} from "../components/factory/factoryIssues.logic";

export const Route = createFileRoute("/_chat/factory")({
  validateSearch: (raw: Record<string, unknown>): FactoryIssuesSearch => ({
    state: parseFactoryStateFilter(raw.state),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: ProjectId.make(raw.projectId) }
      : {}),
  }),
  component: FactoryIssuesPage,
});
