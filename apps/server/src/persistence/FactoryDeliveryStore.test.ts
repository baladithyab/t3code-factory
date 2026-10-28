import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  FactoryDeliveryError,
  FactoryOriginKey,
  ProjectId,
  ThreadId,
  type FactoryDeliveryIntent,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryDeliveryStore.ts";
import * as Sqlite from "./Sqlite.ts";

const at = "2026-10-27T00:00:00.000Z";
const originKey = FactoryOriginKey.make("github:github.com/owner/repo#7");
const intent = (
  id: string,
  overrides: Partial<FactoryDeliveryIntent> = {},
): FactoryDeliveryIntent => ({
  id,
  originKey,
  threadId: ThreadId.make(`thread:${id}`),
  projectId: ProjectId.make("project"),
  kind: "publish-pr",
  acceptanceId: "acceptance:1",
  repository: {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  },
  baseRef: "main",
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  payload: { title: "Title", body: "Body", draft: false },
  payloadDigest: "d".repeat(64),
  grantedBy: EnvironmentId.make("environment"),
  grantedAt: at,
  requestCommandId: `command:${id}`,
  status: "pending",
  remote: null,
  failure: null,
  updatedAt: at,
  ...overrides,
});
const noop = Effect.void;
const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "the migration creates the table and the partial unique index refuses a second live intent",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryDeliveryStore;
      const sql = yield* SqlClient.SqlClient;
      const tables =
        yield* sql`SELECT name FROM sqlite_schema WHERE name = 'factory_delivery_intents'`;
      assert.lengthOf(tables, 1);

      const first = intent("first");
      assert.deepEqual((yield* store.grant(first, { recheck: noop, enqueue: noop })).intent, first);
      // The index, not the service's read, is the last arbiter between two racing grants.
      const raw = yield* sql`INSERT INTO factory_delivery_intents
      (id, origin_key, thread_id, project_id, kind, acceptance_id, repository_json, base_ref, base_sha,
       head_sha, payload_json, payload_digest, granted_by, granted_at, request_command_id, status, updated_at)
      VALUES ('raw', ${originKey}, 't', 'p', 'publish-pr', 'a', '{}', 'main', 'b', 'h', '{}', 'd', 'e', ${at},
       'raw-command', 'unknown', ${at})`.pipe(Effect.flip);
      assert.isDefined(raw);

      const refused = yield* store
        .grant(intent("second"), { recheck: noop, enqueue: noop })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "already-delivering");
    }).pipe(Effect.provide(layer)),
);

it.effect("a failed delivery frees the origin for a new grant", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryDeliveryStore;
    yield* store.grant(intent("first"), { recheck: noop, enqueue: noop });
    yield* store.settle("first", { status: "failed", failure: "rejected", updatedAt: at });
    const second = intent("second");
    assert.deepEqual((yield* store.grant(second, { recheck: noop, enqueue: noop })).intent, second);
    assert.deepEqual(
      (yield* store.listByThread(second.threadId)).map(({ id }) => id),
      ["second"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("replays by request command id, and refuses the id for another target or payload", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryDeliveryStore;
    let enqueued = 0;
    const steps = {
      recheck: noop,
      enqueue: Effect.sync(() => {
        enqueued += 1;
      }),
    };
    const first = intent("first");
    const granted = yield* store.grant(first, steps);
    assert.isTrue(granted.created);
    const replay = yield* store.grant({ ...first, id: "retry" }, steps);
    assert.isFalse(replay.created);
    assert.deepEqual(replay.intent, first);
    assert.equal(enqueued, 1);

    const otherPayload = yield* store
      .grant({ ...first, id: "retry", payloadDigest: "e".repeat(64) }, steps)
      .pipe(Effect.flip);
    assert.equal(otherPayload.reason, "payload-changed");
    const otherThread = yield* store
      .grant({ ...first, id: "retry", threadId: ThreadId.make("elsewhere") }, steps)
      .pipe(Effect.flip);
    assert.equal(otherThread.reason, "intent-not-found");
  }).pipe(Effect.provide(layer)),
);

it.effect("a refused recheck or enqueue leaves no intent behind", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryDeliveryStore;
    const first = intent("first");
    const recheck = yield* store
      .grant(first, {
        recheck: Effect.fail(new FactoryDeliveryError({ reason: "head-moved" })),
        enqueue: noop,
      })
      .pipe(Effect.flip);
    assert.equal(recheck.reason, "head-moved");
    const enqueue = yield* store
      .grant(first, {
        recheck: noop,
        enqueue: Effect.fail(new FactoryDeliveryError({ reason: "persistence-failure" })),
      })
      .pipe(Effect.flip);
    assert.equal(enqueue.reason, "persistence-failure");
    assert.isTrue(Option.isNone(yield* store.get("first")));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "sending is claimed once, confirmed is terminal, and recovery turns sending into unknown",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryDeliveryStore;
      yield* store.grant(intent("first"), { recheck: noop, enqueue: noop });
      assert.isTrue(yield* store.markSending("first", at));
      assert.isFalse(yield* store.markSending("first", at));

      assert.equal(yield* store.recoverInterrupted(at), 1);
      const recovered = Option.getOrThrow(yield* store.get("first"));
      assert.equal(recovered.status, "unknown");
      assert.equal(recovered.failure, "server restarted during send");

      const remote = { number: 12, url: "https://github.com/owner/repo/pull/12" };
      yield* store.settle("first", { status: "confirmed", remote, failure: null, updatedAt: at });
      yield* store.settle("first", { status: "failed", failure: "late", updatedAt: at });
      const confirmed = Option.getOrThrow(yield* store.get("first"));
      assert.equal(confirmed.status, "confirmed");
      assert.deepEqual(confirmed.remote, remote);
    }).pipe(Effect.provide(layer)),
);

it.effect("a publish row stored before merge-pr existed still decodes as a publish payload", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryDeliveryStore;
    const sql = yield* SqlClient.SqlClient;
    const publish = intent("stored");
    yield* sql`INSERT INTO factory_delivery_intents
      (id, origin_key, thread_id, project_id, kind, acceptance_id, repository_json, base_ref, base_sha,
       head_sha, payload_json, payload_digest, granted_by, granted_at, request_command_id, status, updated_at)
      VALUES ('stored', ${originKey}, ${publish.threadId}, 'project', 'publish-pr', 'acceptance:1',
       ${JSON.stringify(publish.repository)}, 'main', ${publish.baseSha}, ${publish.headSha},
       '{"title":"Title","body":"Body","draft":false}', ${publish.payloadDigest}, 'environment', ${at},
       'command:stored', 'pending', ${at})`;
    assert.deepEqual(Option.getOrThrow(yield* store.get("stored")), publish);
  }).pipe(Effect.provide(layer)),
);

it.effect("a merge intent keeps the remote set at grant through a failed settlement", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryDeliveryStore;
    const remote = { number: 12, url: "https://github.com/owner/repo/pull/12" };
    const merge = intent("merge", {
      kind: "merge-pr",
      payload: { mergeMethod: "squash" },
      remote,
    });
    assert.deepEqual((yield* store.grant(merge, { recheck: noop, enqueue: noop })).intent, merge);
    assert.deepEqual(Option.getOrThrow(yield* store.get("merge")).payload, {
      mergeMethod: "squash",
    });
    yield* store.settle("merge", { status: "failed", failure: "rejected", updatedAt: at });
    const failed = Option.getOrThrow(yield* store.get("merge"));
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.remote, remote);
    // The live index is per kind, so a merge never blocks or is blocked by a publish.
    const publish = intent("publish");
    assert.deepEqual(
      (yield* store.grant(publish, { recheck: noop, enqueue: noop })).intent,
      publish,
    );
  }).pipe(Effect.provide(layer)),
);
