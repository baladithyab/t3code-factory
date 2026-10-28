import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FactoryKnowledgeBriefListResult,
  type FactoryKnowledgeTaskReadResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  list: null as FactoryKnowledgeBriefListResult | null,
  read: null as FactoryKnowledgeTaskReadResult | null,
  environment: null as unknown,
  project: null as unknown,
  scope: null as unknown,
  accept: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock(import("../../state/factory"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const permissionAtom = () => allowed;
  return {
    factoryEnvironment: {
      listKnowledgeBriefs: () => "briefs",
      readKnowledgeTask: () => "task",
      createKnowledgeBrief: { key: "create", permissionAtom },
      startKnowledgeTask: { key: "start", permissionAtom },
      acceptKnowledgeArtifact: { key: "accept", permissionAtom },
    },
  } as never;
});

vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: ((key: string) => ({
    data: key === "briefs" ? state.list : state.read,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: state.refresh,
  })) as never,
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.accept) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useProjects: (() => [state.project]) as never,
}));

vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({ isReady: true, environments: [state.environment] })) as never,
}));

vi.mock(import("../../state/session"), () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set<EnvironmentId>(),
}));

vi.mock(import("../settings/SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({ scope: state.scope, groups: [], selectScope: () => {} })) as never,
}));

vi.mock(import("./FactoryLaunchControls"), () => ({
  FactoryLaunchFields: () => <></>,
  useFactoryLaunchModelSettings: (() => null) as never,
  useFactoryLaunchDraft: (() => null) as never,
}));

import { render } from "../../../test/render";
import { FactoryBriefsPage } from "./FactoryBriefsPage";

function setup() {
  state.accept.mockReset();
  state.refresh.mockReset();
  const environmentId = EnvironmentId.make("environment:knowledge");
  const projectId = ProjectId.make("project:knowledge");
  const observedAt = "2026-10-27T12:00:00.000Z";
  const brief = {
    id: "brief:one",
    projectId,
    title: "Compare storage options",
    question: "Which option meets the requirements?",
    deliverablePath: "DELIVERABLE.md",
    inputs: [],
    acceptanceCriteria: "Include supporting sources.",
    revision: "c".repeat(64),
    createdAt: observedAt,
    createdBy: environmentId,
    supersededBy: null,
  };
  const task = {
    briefId: brief.id,
    threadId: ThreadId.make("thread:knowledge"),
    status: "idle" as const,
    folderPath: "/managed/knowledge",
    createdAt: observedAt,
    creationSource: "web" as const,
  };
  const artifact = {
    path: "DELIVERABLE.md",
    sha256: "b".repeat(64),
    bytes: 21,
    preview: "Updated recommendation",
    observedAt,
  };
  state.list = { briefs: [brief], tasks: [task], fetchedAt: observedAt };
  state.read = {
    brief,
    task,
    artifact,
    artifactIssue: null,
    acceptance: {
      id: "acceptance:one",
      briefId: brief.id,
      threadId: task.threadId,
      projectId,
      artifactPath: artifact.path,
      sha256: "a".repeat(64),
      bytes: 10,
      acceptedAt: observedAt,
      acceptedBy: environmentId,
    },
    current: false,
  };
  state.environment = {
    environmentId,
    label: "Laptop",
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { factoryKnowledge: true } } },
  };
  state.project = { id: projectId, environmentId, title: "Knowledge", workspaceRoot: "/work/repo" };
  state.scope = { kind: "checkout", members: [{ id: projectId, environmentId }] };
  state.accept.mockResolvedValue(AsyncResult.success(undefined));
  return { environmentId, projectId, brief, artifact };
}

it("shows a changed artifact and re-accepts only the digest the human reviewed", async () => {
  const { environmentId, projectId, brief, artifact } = setup();
  await using screen = await render(<FactoryBriefsPage />, { router: "/factory/briefs" });
  await screen.getByRole("button", { name: "Review artifact" }).click();
  await expect.element(screen.getByText("Artifact changed since acceptance")).toBeVisible();
  await expect.element(screen.getByText("aaaaaaa", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("bbbbbbb", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(artifact.preview, { exact: true })).toBeVisible();
  const reaccept = screen.getByRole("button", { name: "Re-accept", exact: true });
  await expect.element(reaccept).toBeEnabled();
  await reaccept.click();
  await vi.waitFor(() => {
    expect(state.accept).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, briefId: brief.id, expectedSha256: artifact.sha256, supersede: true },
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
