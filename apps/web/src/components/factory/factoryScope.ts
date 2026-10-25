import { ScheduledTaskId } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  validateSettingsScopeSearch,
  type ResolvedSettingsScope,
  type SettingsScopeSearch,
} from "../settings/settingsScope";
import { parseFactoryStateFilter, type FactoryIssueStateFilter } from "./factoryIssues.logic";
import { parseFactoryIssueViewMode, type FactoryIssueViewMode } from "./factoryIssues.views";

export interface FactorySearch extends SettingsScopeSearch {
  state: FactoryIssueStateFilter;
  view: FactoryIssueViewMode;
  taskId?: ScheduledTaskId | undefined;
}

export function validateFactorySearch(raw: Record<string, unknown>): FactorySearch {
  return {
    ...validateSettingsScopeSearch(raw),
    state: parseFactoryStateFilter(raw.state),
    view: parseFactoryIssueViewMode(raw.view),
    ...(typeof raw.taskId === "string" && raw.taskId.trim().length > 0
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export function factoryScopeSearchForMember(
  member: SidebarProjectGroupMember,
  group: SidebarProjectSnapshot,
): SettingsScopeSearch {
  return {
    project: group.projectKey,
    machine: member.environmentId,
    checkout: member.physicalProjectKey,
  };
}

export function singleFactoryMember(
  scope: ResolvedSettingsScope,
): SidebarProjectGroupMember | null {
  if ((scope.kind !== "project" && scope.kind !== "checkout") || scope.members.length !== 1) {
    return null;
  }
  return scope.members[0] ?? null;
}
