import { createFileRoute } from "@tanstack/react-router";

import { FactoryOrchestratorPage } from "../components/factory/FactoryOrchestratorPage";

export const Route = createFileRoute("/_chat/factory/orchestrator")({
  component: FactoryOrchestratorPage,
});
