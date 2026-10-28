import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  FactoryOriginKey,
  ProjectId,
  ThreadId,
  type FactoryAcceptance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryAcceptanceStore.ts";
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
