import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  FactoryDeliveryError,
  FactoryOriginKey,
  ProjectId,
  ThreadId,
  type FactoryCommitDeliveryIntent,
  type FactoryArtifactDeliveryIntent,
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
  overrides: Partial<FactoryCommitDeliveryIntent> = {},
): FactoryCommitDeliveryIntent => ({
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

const artifactIntent = (id: string, issueNumber = 7): FactoryArtifactDeliveryIntent => ({
  id,
  originKey: FactoryOriginKey.make("knowledge:brief:one"),
  threadId: ThreadId.make("artifact-thread"),
  projectId: ProjectId.make("project"),
  kind: "publish-artifact",
  acceptanceId: "knowledge-acceptance:one",
  briefId: "brief:one",
  artifactPath: "DELIVERABLE.md",
  artifactSha256: "a".repeat(64),
  artifactBytes: 4,
  repository: intent("repository").repository,
  destinationKey: `comment:github:github.com/owner/repo#${issueNumber}`,
  payload: { issueNumber },
  body: "Body",
  payloadDigest: "d".repeat(64),
  grantedBy: EnvironmentId.make("environment"),
  grantedAt: at,
  requestCommandId: `command:${id}`,
  status: "pending",
  remote: null,
  failure: null,
  updatedAt: at,
});

it.effect("artifact rows share reads and command replay but are live per destination", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryDeliveryStore;
    const sql = yield* SqlClient.SqlClient;
    const first = artifactIntent("artifact");
    const commit = intent("commit", { threadId: first.threadId });
    yield* store.grant(commit, { recheck: noop, enqueue: noop });
    const before = yield* sql`SELECT * FROM factory_delivery_intents`;
    let enqueued = 0;
    const steps = {
      recheck: noop,
      enqueue: Effect.sync(() => {
        enqueued += 1;
      }),
    };
    assert.deepEqual((yield* store.grant(first, steps)).intent, first);
    assert.deepEqual(yield* store.grant({ ...first, id: "replay" }, steps), {
      intent: first,
      created: false,
    });
    assert.equal(enqueued, 1);
    assert.equal(
      (yield* store.grant(artifactIntent("duplicate"), steps).pipe(Effect.flip)).reason,
      "already-delivering",
    );
    const other = { ...artifactIntent("other", 8), grantedAt: "2026-10-28T00:00:00.000Z" };
    yield* store.grant(other, steps);
    assert.deepEqual(Option.getOrThrow(yield* store.get(first.id)), first);
    assert.deepEqual(Option.getOrThrow(yield* store.getByCommand(first.requestCommandId)), first);
    assert.deepEqual(
      Option.getOrThrow(yield* store.getInProject(first.projectId, first.id)),
      first,
    );
    assert.isTrue(Option.isNone(yield* store.getInProject(ProjectId.make("foreign"), first.id)));
    assert.deepEqual(
      Option.getOrThrow(yield* store.getLiveArtifact(first.originKey, first.destinationKey)),
      first,
    );
    assert.deepEqual(
      (yield* store.listByThread(first.threadId)).map(({ id }) => id),
      ["other", "commit", "artifact"],
    );
    assert.deepEqual(yield* sql`SELECT * FROM factory_delivery_intents`, before);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "artifact sending is claimed once, recovered unknown and confirmed with a comment remote",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryDeliveryStore;
      const first = artifactIntent("artifact");
      yield* store.grant(first, { recheck: noop, enqueue: noop });
      assert.isTrue(yield* store.markSending(first.id, at));
      assert.isFalse(yield* store.markSending(first.id, at));
      assert.equal(yield* store.recoverInterrupted(at), 1);
      assert.equal(Option.getOrThrow(yield* store.get(first.id)).status, "unknown");
      const remote = {
        commentId: 12,
        url: "https://github.com/owner/repo/issues/7#issuecomment-12",
      };
      yield* store.settle(first.id, { status: "confirmed", remote, failure: null, updatedAt: at });
      yield* store.settle(first.id, { status: "failed", failure: "late", updatedAt: at });
      assert.deepEqual(Option.getOrThrow(yield* store.get(first.id)), {
        ...first,
        status: "confirmed",
        remote,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "artifact grants roll back both recheck and enqueue failures and release failed destinations",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryDeliveryStore;
      const first = artifactIntent("artifact");
      const refused = Effect.fail(new FactoryDeliveryError({ reason: "artifact-changed" }));
      for (const steps of [
        { recheck: refused, enqueue: noop },
        { recheck: noop, enqueue: refused },
      ]) {
        assert.equal(
          (yield* store.grant(first, steps).pipe(Effect.flip)).reason,
          "artifact-changed",
        );
        assert.isTrue(Option.isNone(yield* store.get(first.id)));
      }
      yield* store.grant(first, { recheck: noop, enqueue: noop });
      yield* store.settle(first.id, { status: "failed", failure: "rejected", updatedAt: at });
      assert.isTrue(
        (yield* store.grant(artifactIntent("second"), {
          recheck: noop,
          enqueue: noop,
        })).created,
      );
    }).pipe(Effect.provide(layer)),
);
