import {
  CommandId,
  FactoryDeliveryError,
  type FactoryAcceptanceError,
  type FactoryDeliveryGrantInput,
  type FactoryDeliveryIntent,
  type FactoryDeliveryKind,
  type FactoryDeliveryPayload,
  type FactoryDeliveryPrepareInput,
  type FactoryDeliveryPrepareResult,
  type FactoryDeliveryReadInput,
  type FactoryDeliveryReadResult,
  type FactoryDeliveryReconcileInput,
  type FactoryRepository,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the digest must be one pure, synchronous function so the transactional grant recheck and prepare compute byte-identical values without a service boundary between them.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as GitManager from "../git/GitManager.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as AcceptanceStore from "../persistence/FactoryAcceptanceStore.ts";
import * as Store from "../persistence/FactoryDeliveryStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Acceptance from "./FactoryAcceptanceService.ts";

const FAILURE_MAX_CHARS = 1000;

// A rejection the forge answered definitively, so nothing was created. Everything else (network,
// timeout, 5xx, an undecodable answer) may still have created the pull request and is `unknown`.
const DEFINITE_REJECTION_TAGS = new Set([
  "GitHubApiAuthenticationError",
  "GitHubApiRateLimitError",
  "GitHubApiNotFoundError",
  "GitHubCliMissingError",
  "GitHubNotSignedInError",
  "GitHubHostDisabledError",
  "GitHubCredentialUnavailableError",
  "SourceControlRateLimitPausedError",
]);

const isDefiniteRejection = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const { _tag, status, cause } = current as {
      readonly _tag?: unknown;
      readonly status?: unknown;
      readonly cause?: unknown;
    };
    if (typeof _tag === "string" && DEFINITE_REJECTION_TAGS.has(_tag)) return true;
    if (_tag === "GitHubApiResponseError" && typeof status === "number")
      return status >= 400 && status < 500 && status !== 408;
    current = cause;
  }
  return false;
};

const describe = (prefix: string, error: { readonly message: string }) =>
  `${prefix}: ${error.message}`.slice(0, FAILURE_MAX_CHARS);

/** The digest a grant echoes back; computed only here so a client cannot choose what it signs. */
export const deliveryPayloadDigest = (input: {
  readonly kind: FactoryDeliveryKind;
  readonly repository: FactoryRepository;
  readonly baseRef: string;
  readonly headSha: string;
  readonly payload: FactoryDeliveryPayload;
}) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        input.kind,
        input.repository.canonicalKey,
        input.baseRef,
        input.headSha,
        input.payload.title,
        input.payload.body,
        input.payload.draft,
      ]),
      "utf8",
    )
    .digest("hex");

export class FactoryDeliveryService extends Context.Service<
  FactoryDeliveryService,
  {
    /** Read-only proposal of the exact payload a person can grant; agents may call it. */
    readonly prepare: (
      input: FactoryDeliveryPrepareInput,
    ) => Effect.Effect<FactoryDeliveryPrepareResult, FactoryDeliveryError>;
    /**
     * A person's act, never an agent's: the only caller is the guarded RPC, and no MCP tool
     * exposes it. Single-use over the exact head and payload digest the grantor saw.
     */
    readonly grant: (
      input: FactoryDeliveryGrantInput,
    ) => Effect.Effect<FactoryDeliveryIntent, FactoryDeliveryError>;
    readonly read: (
      input: FactoryDeliveryReadInput,
    ) => Effect.Effect<FactoryDeliveryReadResult, FactoryDeliveryError>;
    /** Settles an `unknown` or `failed` intent by reading remote state. Never sends. */
    readonly reconcile: (
      input: FactoryDeliveryReconcileInput,
    ) => Effect.Effect<FactoryDeliveryIntent, FactoryDeliveryError>;
    /**
     * Called only by the effect worker. A retry that finds the intent already `sending` means a
     * previous attempt may have reached the forge, so it settles `unknown` and never re-sends.
     */
    readonly execute: (intentId: string) => Effect.Effect<void, FactoryDeliveryError>;
  }
>()("t3/factory/FactoryDeliveryService") {}

const fromAcceptance = (error: FactoryAcceptanceError) =>
  new FactoryDeliveryError({
    reason:
      error.reason === "unknown-thread" || error.reason === "worktree-unavailable"
        ? error.reason
        : error.reason === "not-a-factory-task"
          ? "not-a-factory-task"
          : "persistence-failure",
    cause: error,
  });
const persistenceFailure = (cause: unknown) =>
  new FactoryDeliveryError({ reason: "persistence-failure", cause });

const makeService = Effect.gen(function* () {
  const store = yield* Store.FactoryDeliveryStore;
  const acceptanceStore = yield* AcceptanceStore.FactoryAcceptanceStore;
  const acceptance = yield* Acceptance.FactoryAcceptanceService;
  const environment = yield* ServerEnvironmentIdentity;
  const threads = yield* Threads.ThreadManagementService;
  const git = yield* Git.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = NodeOS.tmpdir();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // What the grantor is shown and what a grant re-derives: the claim, the live acceptance, and
  // whether the worktree still sits on the accepted commit.
  const observe = Effect.fn("FactoryDeliveryService.observe")(function* (input: {
    readonly projectId: FactoryDeliveryReadInput["projectId"];
    readonly threadId: FactoryDeliveryReadInput["threadId"];
  }) {
    const origin = yield* acceptanceStore
      .resolveOrigin(input.threadId)
      .pipe(Effect.mapError(fromAcceptance));
    const read = yield* acceptance
      .read({ projectId: input.projectId, threadId: input.threadId })
      .pipe(Effect.mapError(fromAcceptance));
    if (Option.isNone(origin))
      return yield* new FactoryDeliveryError({ reason: "not-a-factory-task" });
    if (read.acceptance === null || read.acceptance.originKey !== origin.value.originKey)
      return yield* new FactoryDeliveryError({ reason: "not-accepted" });
    return {
      origin: origin.value,
      acceptance: read.acceptance,
      current: read.current,
      liveHeadSha: read.liveHeadSha,
    };
  });

  const prepare = Effect.fn("FactoryDeliveryService.prepare")(function* (
    input: FactoryDeliveryPrepareInput,
  ) {
    const seen = yield* observe(input);
    if (!seen.current) return yield* new FactoryDeliveryError({ reason: "acceptance-stale" });
    const existing = yield* store.getLive(seen.origin.originKey, input.kind);
    return {
      acceptance: seen.acceptance,
      current: true,
      repository: seen.origin.repository,
      baseRef: seen.acceptance.baseRef,
      headSha: seen.acceptance.headSha,
      payload: input.payload,
      payloadDigest: deliveryPayloadDigest({
        kind: input.kind,
        repository: seen.origin.repository,
        baseRef: seen.acceptance.baseRef,
        headSha: seen.acceptance.headSha,
        payload: input.payload,
      }),
      existing: Option.getOrNull(existing),
    };
  });

  const grant = Effect.fn("FactoryDeliveryService.grant")(function* (
    input: FactoryDeliveryGrantInput,
  ) {
    // A repeated grant is answered from the stored intent even after the head has moved on.
    const replay = yield* store.getByCommand(input.commandId);
    if (Option.isSome(replay)) {
      if (
        replay.value.threadId !== input.threadId ||
        replay.value.projectId !== input.projectId ||
        replay.value.kind !== input.kind
      )
        return yield* new FactoryDeliveryError({ reason: "intent-not-found" });
      if (replay.value.payloadDigest !== input.expectedPayloadDigest)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      return replay.value;
    }
    // Re-run under the grant transaction, so a head that moves between the check and the insert
    // is still refused.
    const validate = Effect.gen(function* () {
      const seen = yield* observe(input);
      const headSha = seen.acceptance.headSha;
      if (!seen.current || seen.liveHeadSha !== headSha || headSha !== input.expectedHeadSha)
        return yield* new FactoryDeliveryError({ reason: "head-moved" });
      const payloadDigest = deliveryPayloadDigest({
        kind: input.kind,
        repository: seen.origin.repository,
        baseRef: seen.acceptance.baseRef,
        headSha,
        payload: input.payload,
      });
      if (payloadDigest !== input.expectedPayloadDigest)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      return { ...seen, payloadDigest };
    });
    const validated = yield* validate;
    const at = yield* nowIso;
    const intent: FactoryDeliveryIntent = {
      id: `delivery:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
      originKey: validated.origin.originKey,
      threadId: input.threadId,
      projectId: input.projectId,
      kind: input.kind,
      acceptanceId: validated.acceptance.id,
      repository: validated.origin.repository,
      baseRef: validated.acceptance.baseRef,
      baseSha: validated.acceptance.baseSha,
      headSha: validated.acceptance.headSha,
      payload: input.payload,
      payloadDigest: validated.payloadDigest,
      grantedBy: yield* environment.getEnvironmentId,
      grantedAt: at,
      requestCommandId: input.commandId,
      status: "pending",
      remote: null,
      failure: null,
      updatedAt: at,
    };
    const granted = yield* store.grant(intent, {
      recheck: Effect.asVoid(validate),
      enqueue: outbox
        .enqueue([
          {
            id: `${intent.id}:execute`,
            commandId: CommandId.make(input.commandId),
            threadId: input.threadId,
            request: { type: "factory.delivery.execute", intentId: intent.id },
          },
        ])
        .pipe(Effect.mapError(persistenceFailure)),
    });
    // The effect row is committed with the intent; wake the worker only once that commit is out.
    if (granted.created) yield* outbox.notifyAvailable(1);
    return granted.intent;
  });

  const read = Effect.fn("FactoryDeliveryService.read")(function* (
    input: FactoryDeliveryReadInput,
  ) {
    // The acceptance read refuses a thread outside the project, which is the same gate here.
    yield* acceptance
      .read({ projectId: input.projectId, threadId: input.threadId })
      .pipe(Effect.mapError(fromAcceptance));
    const intents = yield* store.listByThread(input.threadId);
    return { intents: intents.filter((intent) => intent.projectId === input.projectId) };
  });

  const settle = Effect.fn("FactoryDeliveryService.settle")(function* (
    intent: FactoryDeliveryIntent,
    status: "failed" | "unknown",
    failure: string,
  ) {
    yield* store.settle(intent.id, {
      status,
      failure: failure.slice(0, FAILURE_MAX_CHARS),
      updatedAt: yield* nowIso,
    });
  });

  // The forge call already succeeded, so a link that cannot be made is logged and dropped. The
  // command id is derived from the intent, so a retried link replays instead of duplicating.
  const linkPullRequest = Effect.fn("FactoryDeliveryService.linkPullRequest")(
    function* (intent: FactoryDeliveryIntent, remote: { readonly url: string }) {
      const key = parseChangeRequestUrl(remote.url);
      if (key === null) return;
      yield* threads
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`${intent.id}:link-pull-request`),
          threadId: intent.threadId,
          ...key,
          url: remote.url,
          source: "created",
        })
        .pipe(Effect.asVoid);
    },
    (effect, intent) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning("failed to link delivered pull request to thread", {
                threadId: intent.threadId,
              }),
        ),
      ),
  );

  const confirm = Effect.fn("FactoryDeliveryService.confirm")(function* (
    intent: FactoryDeliveryIntent,
    remote: { readonly number: number; readonly url: string },
  ) {
    const settled = yield* store.settle(intent.id, {
      status: "confirmed",
      remote,
      failure: null,
      updatedAt: yield* nowIso,
    });
    yield* linkPullRequest(intent, remote);
    return Option.getOrElse(settled, () => intent);
  });

  const worktreeOf = (shell: {
    readonly deletedAt: unknown;
    readonly worktreePath: string | null;
  }) => (shell.deletedAt === null ? shell.worktreePath : null);

  // Business outcomes settle the intent and return normally; only infrastructure errors escape.
  const send = Effect.fn("FactoryDeliveryService.send")(function* (intent: FactoryDeliveryIntent) {
    const fail = (failure: string) => settle(intent, "failed", failure);
    const shell = yield* threads
      .getThreadShell(intent.threadId)
      .pipe(Effect.mapError(persistenceFailure));
    const worktree = shell === null ? null : worktreeOf(shell);
    if (worktree === null) return yield* fail("worktree-unavailable");
    const observed = yield* Effect.result(
      acceptance.read({ projectId: intent.projectId, threadId: intent.threadId }),
    );
    if (observed._tag === "Failure") return yield* fail("worktree-unavailable");
    if (observed.success.liveHeadSha !== intent.headSha) return yield* fail("head-moved");

    // Publishing sets the upstream, which the open-pull-request lookup needs to resolve the head.
    const pushed = yield* Effect.result(git.pushCurrentBranch(worktree, null));
    if (pushed._tag === "Failure") return yield* fail(describe("push failed", pushed.failure));
    yield* gitManager.invalidateStatus(worktree);

    // Reconcile first: a pull request for this head may already exist, and creating again would
    // fail or duplicate it.
    const before = yield* Effect.result(gitManager.findOpenPullRequestForHead(worktree));
    if (before._tag === "Failure")
      return yield* fail(describe("could not read pull requests", before.failure));
    if (Option.isSome(before.success.open)) {
      yield* confirm(intent, before.success.open.value);
      return;
    }

    const provider = yield* Effect.result(providers.resolve({ cwd: worktree }));
    if (provider._tag === "Failure")
      return yield* fail(describe("no source control provider", provider.failure));
    const bodyFile = path.join(
      tempDir,
      `t3code-delivery-body-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.md`,
    );
    const written = yield* Effect.result(fileSystem.writeFileString(bodyFile, intent.payload.body));
    if (written._tag === "Failure")
      return yield* fail(describe("could not write the pull request body", written.failure));
    // From here the request may reach the forge: only a definite rejection proves it did not.
    const created = yield* Effect.result(
      provider.success
        .createChangeRequest({
          cwd: worktree,
          baseRefName: intent.baseRef,
          headSelector: before.success.headSelector,
          title: intent.payload.title,
          bodyFile,
          draft: intent.payload.draft,
        })
        .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.ignore))),
    );
    if (created._tag === "Failure") {
      yield* gitManager.invalidateStatus(worktree);
      return isDefiniteRejection(created.failure)
        ? yield* fail(describe("pull request rejected", created.failure))
        : yield* settle(intent, "unknown", describe("response lost", created.failure));
    }
    yield* gitManager.invalidateStatus(worktree);
    const after = yield* Effect.result(gitManager.findOpenPullRequestForHead(worktree));
    if (after._tag === "Success" && Option.isSome(after.success.open)) {
      yield* confirm(intent, after.success.open.value);
      return;
    }
    yield* settle(intent, "unknown", "created, but the pull request could not be read back");
  });

  const execute = Effect.fn("FactoryDeliveryService.execute")(function* (intentId: string) {
    const found = yield* store.get(intentId);
    if (Option.isNone(found)) return;
    const intent = found.value;
    if (intent.status === "sending") {
      yield* settle(intent, "unknown", "response lost");
      return;
    }
    if (intent.status !== "pending") return;
    if (!(yield* store.markSending(intent.id, yield* nowIso))) return;
    yield* send(intent);
  });

  const reconcile = Effect.fn("FactoryDeliveryService.reconcile")(function* (
    input: FactoryDeliveryReconcileInput,
  ) {
    const found = yield* store.getInProject(input.projectId, input.intentId);
    if (Option.isNone(found))
      return yield* new FactoryDeliveryError({ reason: "intent-not-found" });
    const intent = found.value;
    if (intent.status !== "unknown" && intent.status !== "failed")
      return yield* new FactoryDeliveryError({ reason: "not-reconcilable" });
    const shell = yield* threads
      .getThreadShell(intent.threadId)
      .pipe(Effect.mapError(persistenceFailure));
    const worktree = shell === null ? null : worktreeOf(shell);
    if (worktree === null)
      return yield* new FactoryDeliveryError({ reason: "worktree-unavailable" });
    const looked = yield* Effect.result(gitManager.findOpenPullRequestForHead(worktree));
    if (looked._tag === "Success" && Option.isSome(looked.success.open))
      return yield* confirm(intent, looked.success.open.value);
    // A lookup that itself failed proves nothing, so the status stays. A lookup that succeeded
    // and found no open pull request is the human's answer: the send did not land, and the
    // origin is released for a new grant. Without this an `unknown` intent would block the
    // origin forever.
    const reason =
      looked._tag === "Failure"
        ? describe("could not read pull requests", looked.failure)
        : "no open pull request found for this head";
    const refreshed = yield* store.settle(intent.id, {
      status: looked._tag === "Failure" ? intent.status : "failed",
      failure: reason.slice(0, FAILURE_MAX_CHARS),
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(refreshed, () => intent);
  });

  const recoverInterrupted = Effect.gen(function* () {
    const recovered = yield* store.recoverInterrupted(yield* nowIso);
    if (recovered > 0)
      yield* Effect.logWarning("settled interrupted pull request deliveries as unknown", {
        recovered,
      });
  });

  return {
    service: FactoryDeliveryService.of({ prepare, grant, read, reconcile, execute }),
    recoverInterrupted,
  };
});

export const layer = Layer.effect(
  FactoryDeliveryService,
  makeService.pipe(Effect.map(({ service }) => service)),
);

/**
 * The instance the effect executor runs on. Recovery runs before the service exists, so no
 * worker built on it can claim a delivery before an interrupted `sending` row is settled.
 */
export const layerWithStartupRecovery = Layer.effect(
  FactoryDeliveryService,
  Effect.gen(function* () {
    const { service, recoverInterrupted } = yield* makeService;
    yield* recoverInterrupted;
    return service;
  }),
);
