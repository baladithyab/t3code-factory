import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FactoryIssuesPage } from "../components/factory/FactoryIssuesPage";
import {
  parseFactoryStateFilter,
  type FactoryIssuesSearch,
} from "../components/factory/factoryIssues.logic";
import { parseFactoryIssueViewMode } from "../components/factory/factoryIssues.views";

export const Route = createFileRoute("/_chat/factory")({
  validateSearch: (raw: Record<string, unknown>): FactoryIssuesSearch => ({
    state: parseFactoryStateFilter(raw.state),
    view: parseFactoryIssueViewMode(raw.view),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: ProjectId.make(raw.projectId) }
      : {}),
  }),
  component: FactoryIssuesPage,
});
