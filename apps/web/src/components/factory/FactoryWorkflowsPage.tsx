import { useSearch } from "@tanstack/react-router";

import { ScheduledTasksManager } from "../settings/ScheduledTasksSettings";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { singleFactoryMember } from "./factoryScope";

export function FactoryWorkflowsPage() {
  const search = useSearch({ from: "/_chat/factory" });
  const { scope } = useSettingsScope();
  const member = singleFactoryMember(scope);
  const environmentId =
    member?.environmentId ??
    (scope.kind === "environment" || scope.kind === "checkout" || scope.kind === "project"
      ? (scope.environmentId ?? undefined)
      : undefined);

  return (
    <ScheduledTasksManager
      key={`${search.project ?? ""}:${search.machine ?? ""}:${search.checkout ?? ""}:${search.taskId ?? ""}`}
      factory
      environmentId={environmentId}
      taskId={search.taskId}
    />
  );
}
