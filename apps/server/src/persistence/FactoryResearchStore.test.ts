import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryResearchError,
  FactoryResearchProtocolId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryResearchProtocol,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./FactoryResearchStore.ts";
import * as Sqlite from "./Sqlite.ts";

const at = "2026-10-25T00:00:00.000Z";
const protocol: FactoryResearchProtocol = {
  id: FactoryResearchProtocolId.make("protocol"),
  projectId: ProjectId.make("project"),
  repository: {
    provider: "github",
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  },
  baseCommit: "B",
  hypothesis: "Lower loss",
  runCommand: "python train.py",
  evaluators: [{ path: "prepare.py", blobOid: "p0" }],
  metric: { name: "loss", linePrefix: "loss:", direction: "lower", minimumEffect: 0.01 },
  budget: { maxRuns: 1, maxRunMinutes: 5, expiresAt: "2099-01-01T00:00:00.000Z" },
  revision: "revision",
  sealedAt: at,
};
const intent = (
  id: string,
  role: Store.FactoryResearchLaunchIntent["role"] = "explore",
  previousThreadId: ThreadId | null = null,
): Store.FactoryResearchLaunchIntent => ({
  projectId: protocol.projectId,
  workspaceRoot: "/repo",
  requestCommandId: CommandId.make(`request:${id}`),
  commandId: CommandId.make(`launch:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  messageId: MessageId.make(`message:${id}`),
  baseRef: protocol.baseCommit,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  prompt: "sealed prompt",
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  previousThreadId,
  protocolId: protocol.id,
  protocolRevision: protocol.revision,
  role,
  protocol,
  instructions: null,
  launchedByThreadId: null,
  finding: null,
});
const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const seed = Effect.gen(function* () {
  const store = yield* Store.FactoryResearchStore;
  yield* store.seal(protocol, CommandId.make("seal"));
  return store;
});

it.effect(
  "sealing replays the immutable protocol and survives missing projects without foreign keys",
  () =>
    Effect.gen(function* () {
      const store = yield* seed;
      assert.deepEqual(
        yield* store.seal({ ...protocol, hypothesis: "different" }, CommandId.make("seal")),
        protocol,
      );
      assert.deepEqual(yield* store.listProtocols(protocol.projectId), [protocol]);
      assert.deepEqual(Option.getOrThrow(yield* store.getProtocol(protocol.id)), protocol);
      const sql = yield* SqlClient.SqlClient;
      for (const table of [
        "factory_research_protocols",
        "factory_research_launches",
        "factory_research_evidence",
        "factory_research_artifacts",
      ]) {
        assert.equal((yield* sql.unsafe(`PRAGMA foreign_key_list(${table})`)).length, 0);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "budget counting is transactional across store instances; command replay does not spend twice",
  () =>
    Effect.gen(function* () {
      const first = yield* seed;
      const second = yield* Store.FactoryResearchStore.pipe(Effect.provide(Store.layer));
      const results = yield* Effect.all(
        [
          first.reserve(intent("a"), Effect.void).pipe(Effect.result),
          second.reserve(intent("b"), Effect.void).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const runs = yield* first.listRuns(protocol.id);
      assert.equal(runs.length, 1);
      const winner = runs[0]!;
      assert.deepEqual(
        yield* second.reserve(winner.intent, Effect.die("Replay must not recheck")),
        winner,
      );
      assert.equal(
        (yield* first.reserve(intent("c"), Effect.void).pipe(Effect.flip)).reason,
        "budget-exhausted",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "implementation reservation rechecks approval inside the transaction and restarts with CAS",
  () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const rejected = yield* store
        .reserve(
          intent("stale", "implementation"),
          Effect.fail(new FactoryResearchError({ reason: "finding-changed" })),
        )
        .pipe(Effect.flip);
      assert.equal(rejected.reason, "finding-changed");
      assert.isTrue(Option.isNone(yield* store.getImplementation(protocol.id)));
      const first = yield* store.reserve(intent("first", "implementation"), Effect.void);
      yield* store.accept(first.intent.threadId);
      const [a, b] = yield* Effect.all(
        [
          store.reserve(intent("a", "implementation", first.intent.threadId), Effect.void),
          store.reserve(intent("b", "implementation", first.intent.threadId), Effect.void),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(a, b);
      assert.equal(a.intent.previousThreadId, first.intent.threadId);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM factory_research_launches`).length, 2);
      assert.equal((yield* store.listRuns(protocol.id)).length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "evidence and retained artifact bytes commit atomically once without stored disposition",
  () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const run = yield* store.reserve(intent("run"), Effect.void);
      const artifact = {
        path: "run.log",
        line: 2,
        sha256: "digest",
        bytes: 3,
        retention: "inline" as const,
        lineText: "loss: 1",
      };
      const evidence: Store.StoredEvidence = {
        threadId: run.intent.threadId,
        role: "explore",
        commit: "C",
        recordedAt: at,
        ancestorOfBase: true,
        evaluators: [{ path: "prepare.py", blobOid: "p0", matchesSealed: true }],
        artifacts: [artifact],
        metricValue: 1,
        missing: [],
        runCount: 1,
        elapsedMinutes: 1,
      };
      yield* store.recordEvidence(
        evidence,
        [{ ...artifact, content: new Uint8Array([1, 2, 3]) }],
        Effect.void,
      );
      assert.equal(
        (yield* store
          .recordEvidence(
            { ...evidence, metricValue: 0 },
            [],
            Effect.die("A rejected writer must not move the ref"),
          )
          .pipe(Effect.flip)).reason,
        "evidence-already-recorded",
      );
      assert.deepEqual(Option.getOrThrow(yield* store.getEvidence(run.intent.threadId)), evidence);
      assert.deepEqual(yield* store.listEvidence(protocol.id), [evidence]);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly bytes: number;
        readonly content: Uint8Array;
      }>`SELECT bytes, content FROM factory_research_artifacts`;
      assert.equal(rows[0]?.bytes, 3);
      assert.deepEqual(Array.from(rows[0]?.content ?? []), [1, 2, 3]);
    }).pipe(Effect.provide(layer)),
);
