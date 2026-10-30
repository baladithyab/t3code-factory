import { EnvironmentId, ProjectId, ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { resolveSettingsScope } from "../settings/settingsScope";
import {
  factoryScopeSearchForMember,
  singleFactoryMember,
  validateFactorySearch,
} from "./factoryScope";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(
  id: string,
  environmentId: EnvironmentId,
  workspaceRoot: string,
): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "Factory",
    workspaceRoot,
    physicalProjectKey: `${environmentId}:${workspaceRoot}`,
    environmentLabel: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
}

function group(
  projectKey: string,
  first: SidebarProjectGroupMember,
  ...others: SidebarProjectGroupMember[]
): SidebarProjectSnapshot {
  const members = [first, ...others];
  return {
    ...first,
    projectKey,
    displayName: "Factory",
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
  };
}

const main = member("main", laptopId, "/repos/factory");
const checkout = member("checkout", laptopId, "/repos/factory-next");
const remote = member("main", serverId, "/repos/factory");
const project = group("logical-factory", main, checkout, remote);
const groups = [project];

const resolve = (search: Record<string, unknown>) =>
  resolveSettingsScope(validateFactorySearch(search), groups, environments);

describe("factory scope narrowing", () => {
  it("does not pick a checkout from broad or ambiguous project scopes", () => {
    for (const search of [
      {},
      { machine: laptopId },
      { project: project.projectKey },
      { project: project.projectKey, machine: laptopId },
    ]) {
      expect(singleFactoryMember(resolve(search))).toBeNull();
    }
  });

  it("accepts a project/environment narrowing only when it has one physical member", () => {
    expect(singleFactoryMember(resolve({ project: project.projectKey, machine: serverId }))).toBe(
      remote,
    );
  });

  it("addresses each checkout exactly despite shared project IDs, paths, or environments", () => {
    for (const target of [main, checkout, remote]) {
      const search = factoryScopeSearchForMember(target, project);
      const scope = resolve({ ...search });
      expect(scope.kind).toBe("checkout");
      expect(singleFactoryMember(scope)).toBe(target);
      expect(scope.environmentIds).toEqual([target.environmentId]);
    }
  });

  it("retains a stale exact deep link instead of choosing its surviving sibling", () => {
    const search = validateFactorySearch({
      ...factoryScopeSearchForMember(checkout, project),
      taskId: "workflow-next",
      state: "closed",
      view: "board",
    });
    const surviving = [group(project.projectKey, main, remote)];
    const scope = resolveSettingsScope(search, surviving, environments);
    expect(search).toMatchObject({
      checkout: checkout.physicalProjectKey,
      taskId: ScheduledTaskId.make("workflow-next"),
      state: "closed",
      view: "board",
    });
    expect(scope).toMatchObject({ kind: "unavailable", reason: "checkout-missing" });
    expect(singleFactoryMember(scope)).toBeNull();
  });

  it.each([
    { project: "deleted-project", machine: laptopId, checkout: main.physicalProjectKey },
    { project: project.projectKey, machine: "removed-machine", checkout: main.physicalProjectKey },
    { project: project.projectKey, machine: serverId, checkout: checkout.physicalProjectKey },
    { checkout: checkout.physicalProjectKey },
  ])("never drops conflicting or stale narrowing: %j", (search) => {
    const scope = resolve(search);
    expect(scope.kind).toBe("unavailable");
    expect(singleFactoryMember(scope)).toBeNull();
  });

  it("does not rehome an exact selection after its logical project group changes", () => {
    const search = factoryScopeSearchForMember(checkout, project);
    const scope = resolveSettingsScope(
      search,
      [group("regrouped-factory", checkout)],
      environments,
    );
    expect(scope).toMatchObject({ kind: "unavailable", reason: "project-missing" });
    expect(singleFactoryMember(scope)).toBeNull();
  });

  it("does not admit a cached exact checkout whose environment has disappeared", () => {
    const scope = resolveSettingsScope(
      factoryScopeSearchForMember(remote, project),
      groups,
      environments.filter((environment) => environment.environmentId !== serverId),
    );
    expect(scope).toMatchObject({ kind: "unavailable", reason: "environment-missing" });
    expect(singleFactoryMember(scope)).toBeNull();
  });
});
