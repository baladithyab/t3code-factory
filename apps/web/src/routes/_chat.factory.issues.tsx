import { createFileRoute } from "@tanstack/react-router";

import { FactoryIssuesPage } from "../components/factory/FactoryIssuesPage";

export const Route = createFileRoute("/_chat/factory/issues")({
  component: FactoryIssuesPage,
});
