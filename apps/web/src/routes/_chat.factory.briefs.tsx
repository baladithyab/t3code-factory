import { createFileRoute } from "@tanstack/react-router";

import { FactoryBriefsPage } from "../components/factory/FactoryBriefsPage";

export const Route = createFileRoute("/_chat/factory/briefs")({
  component: FactoryBriefsPage,
});
