import { createFileRoute } from "@tanstack/react-router";

import { FactoryPage } from "../components/factory/FactoryPage";
import { validateFactorySearch } from "../components/factory/factoryScope";

export const Route = createFileRoute("/_chat/factory")({
  validateSearch: validateFactorySearch,
  component: FactoryPage,
});
