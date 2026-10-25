import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryFeedSourceId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryFeedStore.ts";
import * as IssueLaunches from "./FactoryIssueLaunches.ts";
import * as Sqlite from "./Sqlite.ts";

const projectId = ProjectId.make("project");
const sourceId = FactoryFeedSourceId.make("source");
const key = { sourceId, itemKey: "atom:item" };
const at = "2026-10-24T00:00:00.000Z";
const item: Store.Observation = {
  itemKey: key.itemKey,
  title: "Task",
  content: "body",
  link: null,
  publishedAt: null,
  revision: "d1",
  disposition: "open",
  forgeReference: null,
};
const observation = {
  sourceId,
  at,
  nextAllowedAt: at,
  title: "News",
  etag: '"v1"',
  lastModified: null,
  items: [item],
};
const seed = Effect.gen(function* () {
  const store = yield* Store.FactoryFeedStore;
  yield* store.bind({
    id: sourceId,
    projectId,
    locator: "https://news.example.org/feed",
    commandId: CommandId.make("bind"),
    at,
  });
  yield* store.observe(observation);
  return store;
});
const intent = (
  id: string,
  previousThreadId: ThreadId | null = null,
): Store.FactoryFeedLaunchIntent => ({
  repository: {
    provider: "github",
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  },
  ...key,
  revision: "d1",
  title: "News: Task",
  snapshot: {
    feed: "https://news.example.org/feed",
    title: item.title,
    content: item.content,
    link: null,
    publishedAt: null,
  },
  projectId,
  workspaceRoot: "/repo",
  requestCommandId: CommandId.make(`request:${id}`),
  commandId: CommandId.make(`launch:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  messageId: MessageId.make(`message:${id}`),
  baseRef: "a".repeat(40),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: `Frozen ${id}`,
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  previousThreadId,
});
const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("SQL reservation chooses one immutable intent across independent store instances", () =>
  Effect.gen(function* () {
    const first = yield* seed;
    const second = yield* Store.FactoryFeedStore.pipe(Effect.provide(Store.layer));
    const [a, b] = yield* Effect.all([first.reserve(intent("a")), second.reserve(intent("b"))], {
      concurrency: "unbounded",
    });
    assert.deepEqual(a, b);
    assert.deepEqual(Option.getOrThrow(yield* second.get(key)), a);
    assert.equal(
      (yield* (yield* SqlClient.SqlClient)`SELECT * FROM factory_feed_launches`).length,
      1,
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("restarts compare-and-swap the previous attempt and preserve provenance", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    const original = yield* store.reserve(intent("original"));
    yield* store.accept(original.intent.threadId);
    const [a, b] = yield* Effect.all(
      [
        store.reserve(intent("a", original.intent.threadId)),
        store.reserve(intent("b", original.intent.threadId)),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(a, b);
    assert.equal(a.accepted, 0);
    assert.equal(a.intent.previousThreadId, original.intent.threadId);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT thread_id, accepted, superseded FROM factory_feed_launches`;
    assert.equal(rows.length, 2);
    assert.deepInclude(rows, { thread_id: original.intent.threadId, accepted: 1, superseded: 1 });
    const replay = yield* store.reserve({
      ...intent("replayed", a.intent.threadId),
      requestCommandId: original.intent.requestCommandId,
    });
    assert.equal(replay.intent.threadId, a.intent.threadId);
    assert.equal((yield* sql`SELECT * FROM factory_feed_launches`).length, 2);
  }).pipe(Effect.provide(layer)),
);
it.effect("a command-id conflict retains the current binding", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    const original = yield* store.reserve(intent("original"));
    yield* store.observe({ ...observation, items: [item, { ...item, itemKey: "atom:other" }] });
    const other = { ...intent("other"), itemKey: "atom:other" };
    yield* store.reserve(other);
    const result = yield* store.reserve({
      ...intent("replacement", original.intent.threadId),
      requestCommandId: other.requestCommandId,
    });
    assert.equal(result.intent.threadId, original.intent.threadId);
    assert.equal(
      Option.getOrThrow(yield* store.get(key)).intent.threadId,
      original.intent.threadId,
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("observation preserves absence and reopens only revision-bound dismissals on edit", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    yield* store.setDismissed({
      ...key,
      projectId,
      commandId: CommandId.make("dismiss"),
      expectedRevision: "d1",
      dismissed: true,
      note: "duplicate",
    });
    yield* store.observe({ ...observation, items: [] });
    assert.deepInclude(Option.getOrThrow(yield* store.getItem(key)), {
      inWindow: false,
      disposition: "dismissed",
      ordinal: 1,
    });
    yield* store.observe(observation);
    assert.deepInclude(Option.getOrThrow(yield* store.getItem(key)), {
      inWindow: true,
      disposition: "dismissed",
      ordinal: 1,
    });
    yield* store.observe({
      ...observation,
      etag: '"v2"',
      items: [{ ...item, revision: "d2", content: "edited" }],
    });
    assert.deepInclude(Option.getOrThrow(yield* store.getItem(key)), {
      disposition: "open",
      ordinal: 2,
      dismissalNote: null,
      content: "edited",
    });
    assert.equal(Option.getOrThrow(yield* store.getSource(sourceId)).etag, '"v2"');
    assert.equal(
      (yield* (yield* SqlClient.SqlClient)`SELECT * FROM factory_feed_item_revisions`).length,
      2,
    );
    assert.equal(
      (yield* store
        .setDismissed({
          ...key,
          projectId,
          commandId: CommandId.make("stale-dismiss"),
          expectedRevision: "d1",
          dismissed: true,
        })
        .pipe(Effect.flip)).reason,
      "candidate-changed",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("reservation atomically rechecks changed content and source suspension", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    yield* store.observe({ ...observation, items: [{ ...item, revision: "d2" }] });
    assert.equal(
      (yield* store.reserve(intent("stale")).pipe(Effect.flip)).reason,
      "candidate-changed",
    );
    yield* store.unbind(sourceId);
    assert.equal(
      (yield* store.reserve({ ...intent("suspended"), revision: "d2" }).pipe(Effect.flip)).reason,
      "source-suspended",
    );
    assert.equal(
      (yield* (yield* SqlClient.SqlClient)`SELECT * FROM factory_feed_launches`).length,
      0,
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("observation rolls back validators and every item when a revision insert fails", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER fail_feed_revision BEFORE INSERT ON factory_feed_item_revisions BEGIN SELECT RAISE(ABORT, 'test'); END`;
    assert.equal(
      (yield* store
        .observe({ ...observation, etag: '"bad"', items: [{ ...item, revision: "d2" }] })
        .pipe(Effect.flip)).reason,
      "persistence-failure",
    );
    assert.equal(Option.getOrThrow(yield* store.getSource(sourceId)).etag, '"v1"');
    assert.deepInclude(Option.getOrThrow(yield* store.getItem(key)), {
      revision: "d1",
      ordinal: 1,
      inWindow: true,
    });
  }).pipe(Effect.provide(layer)),
);
it.effect("retraction preserves the reviewed snapshot and can be explicitly restored", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    yield* store.observe({
      ...observation,
      items: [
        { ...item, content: null, title: null, disposition: "retracted", revision: "tombstone" },
      ],
    });
    assert.deepInclude(Option.getOrThrow(yield* store.getItem(key)), {
      disposition: "retracted",
      content: "body",
      revision: "d1",
    });
    assert.equal(
      (yield* store.reserve(intent("retracted")).pipe(Effect.flip)).reason,
      "candidate-retracted",
    );
    yield* store.setDismissed({
      ...key,
      projectId,
      commandId: CommandId.make("restore"),
      expectedRevision: "d1",
      dismissed: false,
    });
    assert.equal(Option.getOrThrow(yield* store.getItem(key)).disposition, "open");
  }).pipe(Effect.provide(layer)),
);
it.effect("rebind reuses identity and refresh claims are durable across service instances", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    yield* store.unbind(sourceId);
    const rebound = yield* store.bind({
      id: FactoryFeedSourceId.make("unused"),
      projectId,
      locator: "https://news.example.org/feed",
      commandId: CommandId.make("rebind"),
      at,
    });
    assert.equal(rebound.id, sourceId);
    assert.equal(rebound.status, "active");
    yield* store.claimFetch({ sourceId, at, nextAllowedAt: "2026-10-24T00:01:00.000Z" });
    const other = yield* Store.FactoryFeedStore.pipe(Effect.provide(Store.layer));
    assert.equal(
      (yield* other.claimFetch({ sourceId, at, nextAllowedAt: at }).pipe(Effect.flip)).reason,
      "refresh-throttled",
    );
  }).pipe(Effect.provide(layer)),
);
it("old-format issue intent JSON round-trips byte-identically through the extracted core", () => {
  const feed = intent("legacy");
  const old = {
    repository: feed.repository,
    issue: {
      number: 7,
      title: "Task",
      body: null,
      state: "open",
      url: "https://github.com/owner/repo/issues/7",
      labels: [],
      updatedAt: at,
      task: null,
    },
    projectId: feed.projectId,
    workspaceRoot: feed.workspaceRoot,
    requestCommandId: feed.requestCommandId,
    commandId: feed.commandId,
    threadId: feed.threadId,
    messageId: feed.messageId,
    baseRef: feed.baseRef,
    modelSelection: feed.modelSelection,
    runtimeMode: feed.runtimeMode,
    interactionMode: feed.interactionMode,
    prompt: feed.prompt,
    createdBy: feed.createdBy,
    creationSource: feed.creationSource,
    createdAt: feed.createdAt,
    previousThreadId: null,
  };
  const json = JSON.stringify(old);
  const schema = Schema.fromJsonString(IssueLaunches.FactoryLaunchIntent);
  assert.equal(Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(json)), json);
});

it.effect("retraction and restore never turn an unreviewable preview into admissible content", () =>
  Effect.gen(function* () {
    const store = yield* seed;
    yield* store.observe({
      ...observation,
      items: [{ ...item, content: null, disposition: "unreviewable", revision: "oversized" }],
    });
    yield* store.observe({
      ...observation,
      items: [{ ...item, content: null, disposition: "retracted", revision: "tombstone" }],
    });
    const restore = {
      ...key,
      projectId,
      commandId: CommandId.make("restore"),
      expectedRevision: "oversized",
      dismissed: false,
    };
    assert.equal(
      (yield* store.setDismissed(restore).pipe(Effect.flip)).reason,
      "candidate-unreviewable",
    );
    yield* store.observe({ ...observation, items: [{ ...item, revision: "reviewable" }] });
    yield* store.observe({
      ...observation,
      items: [{ ...item, content: null, disposition: "retracted", revision: "tombstone" }],
    });
    yield* store.observe({
      ...observation,
      items: [{ ...item, content: null, disposition: "unreviewable", revision: "oversized-again" }],
    });
    assert.equal(
      (yield* store
        .setDismissed({ ...restore, expectedRevision: "oversized-again" })
        .pipe(Effect.flip)).reason,
      "candidate-unreviewable",
    );
  }).pipe(Effect.provide(layer)),
);
