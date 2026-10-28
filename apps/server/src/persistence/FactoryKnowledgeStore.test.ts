import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryKnowledgeAcceptance,
  type FactoryKnowledgeBrief,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryKnowledgeStore.ts";
import * as Sqlite from "./Sqlite.ts";

const at = "2026-10-27T00:00:00.000Z";
const projectId = ProjectId.make("project");
const environmentId = EnvironmentId.make("environment");
const brief = (
  id: string,
  overrides: Partial<FactoryKnowledgeBrief> = {},
): FactoryKnowledgeBrief => ({
  id,
  projectId,
  title: "Survey",
  question: "What changed?",
  deliverablePath: "DELIVERABLE.md",
  inputs: [{ label: "notes", content: "pasted" }],
  acceptanceCriteria: "cites sources",
  revision: `revision:${id}`,
  createdAt: at,
  createdBy: environmentId,
  supersededBy: null,
  ...overrides,
});
const intent = (
  briefId: string,
  thread: string,
  overrides: Partial<Store.FactoryKnowledgeLaunchIntent> = {},
): Store.FactoryKnowledgeLaunchIntent => ({
  briefId,
  briefRevision: `revision:${briefId}`,
  title: "Survey",
  projectId,
  workspaceRoot: "/project",
  requestCommandId: CommandId.make(`request:${thread}`),
  commandId: CommandId.make(`command:${thread}`),
  threadId: ThreadId.make(thread),
  messageId: MessageId.make(`message:${thread}`),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: "Frozen brief",
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  previousThreadId: null,
  ...overrides,
});
const acceptance = (
  id: string,
  overrides: Partial<FactoryKnowledgeAcceptance> = {},
): FactoryKnowledgeAcceptance => ({
  id,
  briefId: "brief:one",
  threadId: ThreadId.make("thread:one"),
  projectId,
  artifactPath: "DELIVERABLE.md",
  sha256: "a".repeat(64),
  bytes: 12,
  acceptedAt: at,
  acceptedBy: environmentId,
  ...overrides,
});
const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("creates briefs, replays by command and supersedes an older brief once", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryKnowledgeStore;
    const first = brief("brief:one");
    const options = (command: string, supersedes: string | null = null) => ({
      requestCommandId: CommandId.make(command),
      supersedes,
    });
    assert.deepEqual(yield* store.createBrief(first, options("create:one")), first);
    // The replay keeps the first brief even though the caller minted a fresh id.
    assert.deepEqual(yield* store.createBrief(brief("brief:replay"), options("create:one")), first);
    assert.isTrue(Option.isNone(yield* store.getBrief("brief:replay")));

    const second = brief("brief:two", { question: "Edited" });
    assert.deepEqual(yield* store.createBrief(second, options("create:two", "brief:one")), second);
    assert.equal(Option.getOrThrow(yield* store.getBrief("brief:one")).supersededBy, "brief:two");
    assert.deepEqual(
      (yield* store.listBriefs(projectId)).map((entry) => [entry.id, entry.supersededBy]),
      [
        ["brief:one", "brief:two"],
        ["brief:two", null],
      ],
    );

    const again = yield* store
      .createBrief(brief("brief:three"), options("create:three", "brief:one"))
      .pipe(Effect.flip);
    assert.equal(again.reason, "unknown-brief");
    const foreign = yield* store
      .createBrief(
        brief("brief:four", { projectId: ProjectId.make("other") }),
        options("create:four", "brief:two"),
      )
      .pipe(Effect.flip);
    assert.equal(foreign.reason, "unknown-brief");
    assert.isTrue(Option.isNone(yield* store.getBrief("brief:four")));
  }).pipe(Effect.provide(layer)),
);

it.effect("reserves one live launch per brief and restarts only once per command", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryKnowledgeStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.createBrief(brief("brief:one"), {
      requestCommandId: CommandId.make("create:one"),
      supersedes: null,
    });
    const first = yield* store.reserve(intent("brief:one", "thread:a"));
    assert.equal(first.accepted, 0);
    // A racing writer reads the winner back instead of creating a second live launch.
    const raced = yield* store.reserve(intent("brief:one", "thread:b"));
    assert.equal(raced.intent.threadId, "thread:a");
    yield* store.accept(ThreadId.make("thread:a"));
    assert.equal(Option.getOrThrow(yield* store.getLaunch("brief:one")).accepted, 1);
    assert.deepEqual(
      (yield* store.listLaunches(projectId)).map((binding) => binding.intent.threadId),
      ["thread:a"],
    );

    const restart = intent("brief:one", "thread:c", {
      previousThreadId: ThreadId.make("thread:a"),
    });
    assert.equal((yield* store.reserve(restart)).intent.threadId, "thread:c");
    // The same restart command replayed does not authorize a further attempt.
    const replay = intent("brief:one", "thread:d", {
      previousThreadId: ThreadId.make("thread:c"),
      requestCommandId: restart.requestCommandId,
    });
    assert.equal((yield* store.reserve(replay)).intent.threadId, "thread:c");
    const rows =
      yield* sql`SELECT thread_id, superseded FROM factory_knowledge_launches ORDER BY thread_id`;
    assert.deepEqual(rows, [
      { thread_id: "thread:a", superseded: 1 },
      { thread_id: "thread:c", superseded: 0 },
    ]);
    const orphan = yield* store
      .reserve(intent("brief:other", "thread:e", { previousThreadId: ThreadId.make("thread:x") }))
      .pipe(Effect.flip);
    assert.equal(orphan.reason, "persistence-failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("accepts write-once per brief and supersede retires the prior row atomically", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryKnowledgeStore;
    const sql = yield* SqlClient.SqlClient;
    const first = acceptance("first");
    assert.deepEqual(yield* store.insertAcceptance(first), first);
    assert.deepEqual(Option.getOrThrow(yield* store.getAcceptance("brief:one")), first);

    const refused = yield* store.insertAcceptance(acceptance("second")).pipe(Effect.flip);
    assert.equal(refused.reason, "already-accepted");
    assert.deepEqual(Option.getOrThrow(yield* store.getAcceptance("brief:one")), first);

    const second = acceptance("second", { sha256: "b".repeat(64), bytes: 20 });
    assert.deepEqual(yield* store.insertAcceptance(second, { supersede: true }), second);
    const rows = yield* sql`SELECT id, superseded FROM factory_knowledge_acceptances ORDER BY id`;
    assert.deepEqual(rows, [
      { id: "first", superseded: 1 },
      { id: "second", superseded: 0 },
    ]);

    // Another brief is independent.
    const other = acceptance("other", { briefId: "brief:two" });
    assert.deepEqual(yield* store.insertAcceptance(other), other);
  }).pipe(Effect.provide(layer)),
);
