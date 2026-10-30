import { createFileRoute } from "@tanstack/react-router";

import { FactoryOverviewPage } from "../components/factory/FactoryOverviewPage";

export const Route = createFileRoute("/_chat/factory/")({
  component: FactoryOverviewPage,
});
