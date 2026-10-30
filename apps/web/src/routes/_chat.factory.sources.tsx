import { createFileRoute } from "@tanstack/react-router";

import { FactorySourcesPage } from "../components/factory/FactorySourcesPage";

export const Route = createFileRoute("/_chat/factory/sources")({
  component: FactorySourcesPage,
});
