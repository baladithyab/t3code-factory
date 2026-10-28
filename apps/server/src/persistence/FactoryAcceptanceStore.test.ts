import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactoryOriginKey,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryAcceptance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryAcceptanceStore.ts";
import { type FactoryLaunchIntent } from "./FactoryIssueLaunches.ts";
import * as Sqlite from "./Sqlite.ts";

const originKey = FactoryOriginKey.make("github:github.com/owner/repo#7");
const acceptance = (id: string, overrides: Partial<FactoryAcceptance> = {}): FactoryAcceptance => ({
  id,
  originKey,
  threadId: ThreadId.make(`thread:${id}`),
  projectId: ProjectId.make("project"),
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  acceptedAt: "2026-10-27T00:00:00.000Z",
  acceptedBy: EnvironmentId.make("environment"),
  evidenceRefs: ["ci:run/1", "review:note"],
  ...overrides,
});
const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("inserts write-once per origin and reads back by thread and by origin", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryAcceptanceStore;
    const first = acceptance("first");
    assert.deepEqual(yield* store.insert(first), first);
    assert.deepEqual(Option.getOrThrow(yield* store.getByThread(first.threadId)), first);
    assert.deepEqual(Option.getOrThrow(yield* store.getByOrigin(originKey)), first);

    const refused = yield* store.insert(acceptance("second")).pipe(Effect.flip);
    assert.equal(refused.reason, "already-accepted");
    assert.isTrue(Option.isNone(yield* store.getByThread(ThreadId.make("thread:second"))));
    assert.deepEqual(Option.getOrThrow(yield* store.getByOrigin(originKey)), first);
  }).pipe(Effect.provide(layer)),
);

it.effect("supersede retires the prior row in the same transaction", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryAcceptanceStore;
    const first = acceptance("first");
    const second = acceptance("second", { headSha: "c".repeat(40) });
    yield* store.insert(first);
    assert.deepEqual(yield* store.insert(second, { supersede: true }), second);
    assert.isTrue(Option.isNone(yield* store.getByThread(first.threadId)));
    assert.deepEqual(Option.getOrThrow(yield* store.getByOrigin(originKey)), second);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT id, superseded FROM factory_acceptances ORDER BY id`;
    assert.deepEqual(rows, [
      { id: "first", superseded: 1 },
      { id: "second", superseded: 0 },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("a different origin is independent", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryAcceptanceStore;
    yield* store.insert(acceptance("first"));
    const other = acceptance("other", { originKey: FactoryOriginKey.make("github:x#8") });
    assert.deepEqual(yield* store.insert(other), other);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "an issue claim admitted before origin keys were recorded derives its key in its provider's namespace",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.FactoryAcceptanceStore;
      for (const [provider, host, path] of [
        ["github", "github.com", "owner/repo"],
        ["gitlab", "gitlab.com", "group/sub/repo"],
      ] as const) {
        const threadId = ThreadId.make(`legacy:${provider}`);
        const intent: FactoryLaunchIntent = {
          repository: {
            provider: SourceControlProviderKind.make(provider),
            host,
            repository: path,
            canonicalKey: `${host}/${path}`,
            url: `https://${host}/${path}`,
          },
          issue: {
            number: 7,
            title: "Task",
            body: null,
            state: "open",
            url: `https://${host}/${path}/issues/7`,
            labels: [],
            updatedAt: "2026-10-27T00:00:00.000Z",
            task: null,
          },
          projectId: ProjectId.make("project"),
          workspaceRoot: "/repo",
          requestCommandId: CommandId.make(`request:${provider}`),
          commandId: CommandId.make(`command:${provider}`),
          threadId,
          messageId: MessageId.make(`message:${provider}`),
          baseRef: "main",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          prompt: "Frozen snapshot",
          createdBy: "user",
          creationSource: "web",
          createdAt: "2026-10-27T00:00:00.000Z",
          previousThreadId: null,
        };
        yield* sql`INSERT INTO factory_issue_launches (thread_id, canonical_key, issue_number, request_command_id, intent_json, origin_key)
          VALUES (${threadId}, ${intent.repository.canonicalKey}, 7, ${intent.requestCommandId}, ${JSON.stringify(intent)}, NULL)`;
        const origin = Option.getOrThrow(yield* store.resolveOrigin(threadId));
        assert.equal(origin.originKey, `${provider}:${host}/${path}#7`);
        assert.deepEqual(origin.repository, intent.repository);
      }
    }).pipe(Effect.provide(layer)),
);
