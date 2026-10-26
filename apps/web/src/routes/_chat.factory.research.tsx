import { createFileRoute } from "@tanstack/react-router";

import { FactoryResearchPage } from "../components/factory/FactoryResearchPage";

export const Route = createFileRoute("/_chat/factory/research")({
  component: FactoryResearchPage,
});
