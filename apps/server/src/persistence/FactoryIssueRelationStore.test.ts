import { assert, it } from "@effect/vitest";
import { CommandId, FactoryReadinessOverrideId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryIssueRelationStore.ts";
import * as Sqlite from "./Sqlite.ts";

const subject = { canonicalKey: "github.com/owner/repo", issueNumber: 12 };
const at = "2026-10-25T00:00:00.000Z";
const later = "2026-10-25T00:01:00.000Z";
const target = {
  targetHost: "github.com",
  targetId: 70,
  targetRepository: "owner/other",
  targetNumber: 7,
};
const observation = {
  subject,
  observedAt: at,
  listedCount: 1,
  summaryTotal: 1,
  present: [target],
  tombstones: [],
};
const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "complete observations retain identity and first sighting across tombstones and reappearance",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.FactoryIssueRelationStore;
      yield* store.recordComplete(observation);
      yield* store.recordComplete({
        ...observation,
        observedAt: later,
        listedCount: 0,
        summaryTotal: 0,
        present: [],
        tombstones: [{ ...target, status: "deleted" }],
      });
      const rebuilt = yield* Store.FactoryIssueRelationStore.pipe(Effect.provide(Store.layer));
      assert.deepInclude((yield* rebuilt.listEdges(subject))[0], {
        status: "deleted",
        firstObservedAt: at,
        lastObservedAt: at,
        tombstonedAt: later,
      });
      yield* rebuilt.recordComplete({
        ...observation,
        observedAt: later,
        present: [{ ...target, targetRepository: "owner/renamed", targetNumber: 8 }],
      });
      const edges = yield* store.listEdges(subject);
      assert.equal(edges.length, 1);
      assert.deepInclude(edges[0], {
        status: "present",
        targetNumber: 8,
        firstObservedAt: at,
        lastObservedAt: later,
        tombstonedAt: null,
      });
    }).pipe(Effect.provide(layer)),
);
it.effect("failed attempts never refresh or replace a complete baseline or its edges", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    yield* store.recordComplete(observation);
    const edges = yield* store.listEdges(subject);
    yield* store.recordFailure({ subject, observedAt: later, failure: "partial-listing" });
    assert.deepEqual(yield* store.listEdges(subject), edges);
    assert.deepInclude(Option.getOrThrow(yield* store.getObservation(subject)), {
      observedAt: at,
      complete: 1,
      listedCount: 1,
      summaryTotal: 1,
      lastAttemptAt: later,
      failure: "partial-listing",
    });
  }).pipe(Effect.provide(layer)),
);
it.effect("failure before a complete listing records no comparison baseline", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    assert.isTrue(Option.isNone(yield* store.getObservation(subject)));
    yield* store.recordFailure({ subject, observedAt: at, failure: "authentication" });
    assert.deepInclude(Option.getOrThrow(yield* store.getObservation(subject)), {
      complete: 0,
      observedAt: null,
      lastAttemptAt: at,
      failure: "authentication",
    });
    assert.deepEqual(yield* store.listEdges(subject), []);
    yield* store.recordComplete(observation);
    assert.deepInclude(Option.getOrThrow(yield* store.getObservation(subject)), {
      complete: 1,
      observedAt: at,
      failure: null,
    });
  }).pipe(Effect.provide(layer)),
);
it.effect("an observation failure rolls back both present updates and tombstones", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    yield* store.recordComplete(observation);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER fail_relations BEFORE UPDATE ON factory_issue_relation_observations BEGIN SELECT RAISE(ABORT, 'test'); END`;
    const failure = yield* store
      .recordComplete({
        ...observation,
        observedAt: later,
        present: [{ ...target, targetId: 80 }],
        tombstones: [{ ...target, status: "deleted" }],
      })
      .pipe(Effect.flip);
    assert.equal(failure.reason, "persistence-failure");
    const edges = yield* store.listEdges(subject);
    assert.equal(edges.length, 1);
    assert.deepInclude(edges[0], { status: "present", targetId: 70, lastObservedAt: at });
    assert.equal(Option.getOrThrow(yield* store.getObservation(subject)).observedAt, at);
  }).pipe(Effect.provide(layer)),
);

const overrideRow: Store.StoredOverride = {
  ...subject,
  id: FactoryReadinessOverrideId.make("override-one"),
  kind: "waive",
  targetHost: target.targetHost,
  targetId: target.targetId,
  boundFingerprint: "observed-resolution",
  reason: "Deleted upstream; reviewed the retained evidence.",
  requestCommandId: CommandId.make("override-command"),
  createdAt: at,
  revokedAt: null,
};
it.effect("override commands replay one durable row, and superseding retains the revoked row", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    assert.deepEqual(yield* store.listOverrides(subject), []);
    assert.deepEqual(yield* store.setOverride(overrideRow), overrideRow);
    assert.deepEqual(
      yield* store.setOverride({
        ...overrideRow,
        id: FactoryReadinessOverrideId.make("replayed-id"),
      }),
      overrideRow,
    );
    const second = {
      ...overrideRow,
      id: FactoryReadinessOverrideId.make("override-two"),
      requestCommandId: CommandId.make("second-command"),
      createdAt: later,
    };
    yield* store.setOverride(second);
    const rebuilt = yield* Store.FactoryIssueRelationStore.pipe(Effect.provide(Store.layer));
    assert.deepEqual(yield* rebuilt.listOverrides(subject), [
      { ...overrideRow, revokedAt: later },
      second,
    ]);
    assert.deepEqual(
      Option.getOrThrow(yield* rebuilt.findOverrideCommand(overrideRow.requestCommandId)),
      {
        ...overrideRow,
        revokedAt: later,
      },
    );
    yield* rebuilt.setOverride(overrideRow);
    assert.deepEqual(yield* rebuilt.listOverrides(subject), [
      { ...overrideRow, revokedAt: later },
      second,
    ]);
  }).pipe(Effect.provide(layer)),
);
it.effect("revocation is subject-scoped, idempotent, and never deletes the override", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    yield* store.setOverride(overrideRow);
    const input = { ...subject, overrideId: overrideRow.id, revokedAt: later };
    assert.equal(
      (yield* store.revokeOverride({ ...input, issueNumber: 13 }).pipe(Effect.flip)).reason,
      "invalid-response",
    );
    yield* store.revokeOverride(input);
    yield* store.revokeOverride({ ...input, revokedAt: "2026-10-25T00:02:00.000Z" });
    assert.deepEqual(yield* store.listOverrides(subject), [{ ...overrideRow, revokedAt: later }]);
    assert.deepEqual(yield* store.listOverrides({ ...subject, issueNumber: 13 }), []);
    assert.equal(
      (yield* store.setOverride({ ...overrideRow, issueNumber: 13 }).pipe(Effect.flip)).reason,
      "invalid-response",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("superseding rolls back the old revocation when the replacement insert fails", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    yield* store.setOverride(overrideRow);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER fail_override BEFORE INSERT ON factory_issue_readiness_overrides BEGIN SELECT RAISE(ABORT, 'test'); END`;
    const error = yield* store
      .setOverride({
        ...overrideRow,
        id: FactoryReadinessOverrideId.make("replacement"),
        requestCommandId: CommandId.make("replacement-command"),
        createdAt: later,
      })
      .pipe(Effect.flip);
    assert.equal(error.reason, "persistence-failure");
    assert.deepEqual(yield* store.listOverrides(subject), [overrideRow]);
  }).pipe(Effect.provide(layer)),
);
it.effect("the database rejects two unrevoked overrides for one edge without foreign keys", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.setOverride(overrideRow);
    const result = yield* sql`INSERT INTO factory_issue_readiness_overrides
      SELECT 'duplicate', canonical_key, issue_number, target_host, target_id, kind,
      bound_fingerprint, reason, 'duplicate-command', created_at, NULL
      FROM factory_issue_readiness_overrides`.pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepEqual(yield* sql`PRAGMA foreign_key_list(factory_issue_readiness_overrides)`, []);
    assert.deepEqual(yield* store.listOverrides(subject), [overrideRow]);
  }).pipe(Effect.provide(layer)),
);
