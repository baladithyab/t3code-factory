import {
  EnvironmentId,
  FactoryDeliveryError,
  FactoryOriginKey,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryPrepareResult,
  type FactoryKnowledgeBriefListResult,
  type FactoryKnowledgeTaskReadResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  list: null as FactoryKnowledgeBriefListResult | null,
  read: null as FactoryKnowledgeTaskReadResult | null,
  deliveries: null as unknown,
  prepared: null as unknown,
  prepareFailure: null as unknown,
  environment: null as unknown,
  project: null as unknown,
  scope: null as unknown,
  accept: vi.fn(),
  grant: vi.fn(),
  reconcile: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock(import("../../state/factory"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const permissionAtom = () => allowed;
  // A real atom: the panel refreshes it through the registry before it observes the query.
  const prepareAtom = Object.assign(Atom.make(null), { key: "prepare" });
  return {
    factoryEnvironment: {
      listKnowledgeBriefs: () => "briefs",
      readKnowledgeTask: () => "task",
      readDeliveries: () => "deliveries",
      prepareDelivery: () => prepareAtom,
      createKnowledgeBrief: { key: "create", permissionAtom },
      startKnowledgeTask: { key: "start", permissionAtom },
      acceptKnowledgeArtifact: { key: "accept", permissionAtom },
      grantDelivery: { key: "grant", permissionAtom },
      reconcileDelivery: { key: "reconcile", permissionAtom },
    },
  } as never;
});

vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: ((query: string | { key: string } | null) => {
    const key = typeof query === "string" ? query : (query?.key ?? null);
    return {
      data:
        key === null
          ? null
          : key === "briefs"
            ? state.list
            : key === "deliveries"
              ? state.deliveries
              : key === "prepare"
                ? state.prepared
                : state.read,
      dataUpdatedAt: 0,
      error: key === "prepare" && state.prepareFailure !== null ? "Prepare failed" : null,
      failure: key === "prepare" ? state.prepareFailure : null,
      isPending: false,
      isSuccess: true,
      refresh: state.refresh,
    };
  }) as never,
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { key: string }) => (value: unknown) =>
    command.key === "grant"
      ? state.grant(value)
      : command.key === "reconcile"
        ? state.reconcile(value)
        : state.accept(value)) as never,
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

function setup({
  deliverySupported = false,
  acceptanceState = "changed",
}: {
  readonly deliverySupported?: boolean;
  readonly acceptanceState?: "changed" | "current";
} = {}) {
  state.accept.mockReset();
  state.grant.mockReset();
  state.reconcile.mockReset();
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
  const acceptance = {
    id: "acceptance:one",
    briefId: brief.id,
    threadId: task.threadId,
    projectId,
    artifactPath: artifact.path,
    sha256: acceptanceState === "current" ? artifact.sha256 : "a".repeat(64),
    bytes: 10,
    acceptedAt: observedAt,
    acceptedBy: environmentId,
  };
  const repository = {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  };
  const destinationKey = "comment:github:github.com/owner/repo#53";
  const prepared = {
    acceptance,
    current: true,
    repository,
    destination: {
      number: 53,
      title: "Share the storage comparison",
      state: "open",
      url: "https://github.com/owner/repo/issues/53",
    },
    destinationKey,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    // Markdown that would render as a heading and bold text if the review were not plain text.
    body: "# Recommendation\n\n**Use SQLite.**\n\n---\n_Delivered by T3 Factory_",
    payload: { issueNumber: 53 },
    payloadDigest: "e".repeat(64),
    attempt: "a1dd4aae-d332-49a7-b29d-f35ddaf2f19b",
    existing: null,
  } satisfies FactoryArtifactDeliveryPrepareResult;
  const intent = (overrides: Partial<FactoryArtifactDeliveryIntent>) =>
    ({
      id: "delivery:one",
      originKey: FactoryOriginKey.make("knowledge:brief:one"),
      threadId: task.threadId,
      projectId,
      kind: "publish-artifact",
      acceptanceId: acceptance.id,
      briefId: brief.id,
      artifactPath: artifact.path,
      artifactSha256: artifact.sha256,
      artifactBytes: artifact.bytes,
      repository,
      destinationKey,
      payload: { issueNumber: 53 },
      body: prepared.body,
      payloadDigest: prepared.payloadDigest,
      grantedBy: environmentId,
      grantedAt: observedAt,
      requestCommandId: "command:one",
      status: "pending",
      remote: null,
      failure: null,
      updatedAt: observedAt,
      ...overrides,
    }) satisfies FactoryArtifactDeliveryIntent;
  state.list = { briefs: [brief], tasks: [task], fetchedAt: observedAt };
  state.read = {
    brief,
    task,
    artifact,
    artifactIssue: null,
    acceptance,
    current: acceptanceState === "current",
  };
  state.deliveries = { intents: [] };
  state.prepared = null;
  state.prepareFailure = null;
  state.environment = {
    environmentId,
    label: "Laptop",
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        capabilities: {
          factoryKnowledge: true,
          ...(deliverySupported && { factoryDelivery: true }),
        },
      },
    },
  };
  state.project = { id: projectId, environmentId, title: "Knowledge", workspaceRoot: "/work/repo" };
  state.scope = { kind: "checkout", members: [{ id: projectId, environmentId }] };
  state.accept.mockResolvedValue(AsyncResult.success(undefined));
  return { environmentId, projectId, brief, task, artifact, prepared, intent };
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

it("prepares a comment, shows the exact server body as plain text, and grants the digests it saw", async () => {
  const { environmentId, projectId, task, prepared } = setup({
    deliverySupported: true,
    acceptanceState: "current",
  });
  state.prepared = prepared;
  state.grant.mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(<FactoryBriefsPage />, { router: "/factory/briefs" });
  await screen.getByRole("button", { name: "Review artifact" }).click();
  await expect
    .element(screen.getByRole("heading", { name: "Publish as issue comment" }))
    .toBeVisible();
  const prepare = screen.getByRole("button", { name: "Prepare", exact: true });
  await expect.element(prepare).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Grant publish" })).toBeDisabled();
  await userEvent.fill(screen.getByRole("textbox", { name: "Issue number" }), "#53");
  await expect.element(prepare).toBeEnabled();
  await prepare.click();
  await expect
    .element(screen.getByRole("link", { name: "#53 Share the storage comparison" }))
    .toHaveAttribute("href", prepared.destination.url);
  await expect.element(screen.getByText("open", { exact: true })).toBeVisible();
  // Plain text: the markdown markers survive verbatim and nothing becomes a heading.
  expect(screen.getByLabelText("Comment body").element().textContent).toBe(prepared.body);
  await expect
    .element(screen.getByRole("heading", { name: "Recommendation" }))
    .not.toBeInTheDocument();
  const grant = screen.getByRole("button", { name: "Grant publish" });
  await expect.element(grant).toBeEnabled();
  await grant.click();
  await vi.waitFor(() => {
    expect(state.grant).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        threadId: task.threadId,
        kind: "publish-artifact",
        commandId: expect.any(String),
        expectedArtifactSha256: prepared.artifactSha256,
        expectedPayloadDigest: prepared.payloadDigest,
        attempt: prepared.attempt,
        payload: { issueNumber: 53 },
      },
    });
  });
});

it("refuses a second grant for an issue that already has a live comment", async () => {
  const { prepared, intent } = setup({ deliverySupported: true, acceptanceState: "current" });
  const live = intent({ status: "sending" });
  state.deliveries = { intents: [live] };
  state.prepared = { ...prepared, existing: live };
  await using screen = await render(<FactoryBriefsPage />, { router: "/factory/briefs" });
  await screen.getByRole("button", { name: "Review artifact" }).click();
  await userEvent.fill(screen.getByRole("textbox", { name: "Issue number" }), "53");
  await screen.getByRole("button", { name: "Prepare", exact: true }).click();
  await expect.element(screen.getByLabelText("Comment body")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Grant publish" })).toBeDisabled();
  await expect
    .element(screen.getByText("A comment is already being posted to this issue."))
    .toBeVisible();
  expect(state.grant).not.toHaveBeenCalled();
});

it("tells the person quietly when the project's tracker cannot receive comments", async () => {
  setup({ deliverySupported: true, acceptanceState: "current" });
  state.prepareFailure = new FactoryDeliveryError({ reason: "capability-unsupported" });
  await using screen = await render(<FactoryBriefsPage />, { router: "/factory/briefs" });
  await screen.getByRole("button", { name: "Review artifact" }).click();
  await userEvent.fill(screen.getByRole("textbox", { name: "Issue number" }), "53");
  await screen.getByRole("button", { name: "Prepare", exact: true }).click();
  const notice = screen.getByText(
    "This project's issue tracker cannot receive comments from the Factory yet.",
  );
  await expect.element(notice).toBeVisible();
  await expect.element(notice).toHaveAttribute("role", "status");
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Grant publish" })).toBeDisabled();
});

it("lists a thread's comments with their link and reconciles one whose outcome is unknown", async () => {
  const { environmentId, projectId, intent } = setup({
    deliverySupported: true,
    acceptanceState: "current",
  });
  const posted = intent({
    id: "delivery:posted",
    status: "confirmed",
    remote: { commentId: 7, url: "https://github.com/owner/repo/issues/53#issuecomment-7" },
  });
  const lost = intent({ id: "delivery:lost", status: "unknown", failure: "response lost" });
  state.deliveries = { intents: [lost, posted] };
  state.reconcile.mockResolvedValue(AsyncResult.success(posted));
  await using screen = await render(<FactoryBriefsPage />, { router: "/factory/briefs" });
  await screen.getByRole("button", { name: "Review artifact" }).click();
  await expect.element(screen.getByText("Comment posted")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "View comment" }))
    .toHaveAttribute("href", "https://github.com/owner/repo/issues/53#issuecomment-7");
  await expect
    .element(screen.getByText("The server lost the response. Reconcile to check github.com."))
    .toBeVisible();
  const reconcile = screen.getByRole("button", { name: "Reconcile", exact: true });
  await reconcile.click();
  await vi.waitFor(() => {
    expect(state.reconcile).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, intentId: "delivery:lost" },
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
  expect(state.grant).not.toHaveBeenCalled();
});

it("keeps earlier comments reachable but offers no new one once the artifact changed", async () => {
  const { intent } = setup({ deliverySupported: true, acceptanceState: "changed" });
  state.deliveries = { intents: [intent({ status: "failed", failure: "Host rejected it" })] };
  await using screen = await render(<FactoryBriefsPage />, { router: "/factory/briefs" });
  await screen.getByRole("button", { name: "Review artifact" }).click();
  await expect
    .element(screen.getByText("Accept the current artifact before publishing it as a comment."))
    .toBeVisible();
  await expect.element(screen.getByText("Host rejected it")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Reconcile", exact: true }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole("textbox", { name: "Issue number" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Grant publish" }))
    .not.toBeInTheDocument();
});

it("offers no comment publishing against a server that does not advertise delivery", async () => {
  setup({ acceptanceState: "current" });
  await using screen = await render(<FactoryBriefsPage />, { router: "/factory/briefs" });
  await screen.getByRole("button", { name: "Review artifact" }).click();
  await expect.element(screen.getByText("Acceptance matches the observed artifact.")).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Publish as issue comment" }))
    .not.toBeInTheDocument();
});
