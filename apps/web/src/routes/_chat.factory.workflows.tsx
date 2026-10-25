import { createFileRoute } from "@tanstack/react-router";

import { FactoryWorkflowsPage } from "../components/factory/FactoryWorkflowsPage";

export const Route = createFileRoute("/_chat/factory/workflows")({
  component: FactoryWorkflowsPage,
});
