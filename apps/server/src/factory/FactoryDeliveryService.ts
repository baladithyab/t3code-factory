import {
  CommandId,
  FactoryDeliveryError,
  FACTORY_KNOWLEDGE_ARTIFACT_PREVIEW_MAX_BYTES,
  type FactoryArtifactDeliveryGrantInput,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryRemote,
  type FactoryCommitDeliveryIntent,
  type FactoryAcceptanceError,
  type FactoryDeliveryGrantInput,
  type FactoryDeliveryIntent,
  type FactoryDeliveryKind,
  type FactoryDeliveryMergePayload,
  type FactoryDeliveryPayload,
  type FactoryDeliveryPrepareInput,
  type FactoryDeliveryPrepareResult,
  type FactoryDeliveryPublishPayload,
  type FactoryDeliveryPullRequest,
  type FactoryDeliveryReadInput,
  type FactoryDeliveryReadResult,
  type FactoryDeliveryReconcileInput,
  type FactoryOriginKey,
  type FactoryRepository,
  type PullRequestDetail,
  type PullRequestRef,
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
import * as KnowledgeStore from "../persistence/FactoryKnowledgeStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Acceptance from "./FactoryAcceptanceService.ts";
import * as Knowledge from "./FactoryKnowledgeService.ts";
import { carriesDeliveryMarker, renderArtifactComment } from "./FactoryArtifactDeliveryBody.ts";
import { issueOriginKey, knowledgeBriefOriginKey } from "./FactoryOriginKey.ts";
import { makeRepositoryResolver } from "./FactoryTaskLaunch.ts";
import { IssueTrackerProviderRegistry } from "./IssueTrackerProviderRegistry.ts";

const FAILURE_MAX_CHARS = 1000;

// A rejection the forge answered definitively, so nothing was created. Everything else (network,
// timeout, 5xx, an undecodable answer) may still have created the pull request and is `unknown`.
// The tags are GitHub's: a host whose rejections are not classified here could settle a request
// that never landed as `unknown`, which is why `publish` stays undeclared on every other host and
// prepare and grant refuse them by capability.
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

// What a merge request that never reached GitHub's merge can look like. The pull request service
// raises its own errors with no cause before sending anything (project, capability, access), the
// host answers a refused mutation with a GraphQL `errors` body (status 200 here, as a stale
// `expectedHeadOid` does) or a 4xx, and a credential or rate limit stops the call outright.
const NEVER_SENT_PROVIDER_REASONS = new Set([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
]);

const isDefiniteMergeRejection = (error: PullRequests.PullRequestError): boolean => {
  if (error._tag === "PullRequestUnavailableError") return true;
  if (error.cause === undefined) return true;
  if (isDefiniteRejection(error)) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const { _tag, status, reason, cause } = current as {
      readonly _tag?: unknown;
      readonly status?: unknown;
      readonly reason?: unknown;
      readonly cause?: unknown;
    };
    if (
      _tag === "PullRequestProviderError" &&
      typeof reason === "string" &&
      NEVER_SENT_PROVIDER_REASONS.has(reason)
    )
      return true;
    if (_tag === "GitHubApiResponseError" && status === 200) return true;
    current = cause;
  }
  return false;
};

const describe = (prefix: string, error: { readonly message: string }) =>
  `${prefix}: ${error.message}`.slice(0, FAILURE_MAX_CHARS);

const isMergePayload = (payload: FactoryDeliveryPayload): payload is FactoryDeliveryMergePayload =>
  "mergeMethod" in payload;

/** A kind and the payload shape it takes; any other pairing is a payload the grantor did not see. */
type DeliveryTarget =
  | { readonly kind: "publish-pr"; readonly payload: FactoryDeliveryPublishPayload }
  | { readonly kind: "merge-pr"; readonly payload: FactoryDeliveryMergePayload };

const targetOf = (input: {
  readonly kind: FactoryDeliveryKind;
  readonly payload: FactoryDeliveryPayload;
}): DeliveryTarget | null => {
  if (input.kind === "merge-pr")
    return isMergePayload(input.payload) ? { kind: input.kind, payload: input.payload } : null;
  return input.kind === "publish-pr" && "title" in input.payload
    ? { kind: input.kind, payload: input.payload }
    : null;
};

/** The digest a grant echoes back; computed only here so a client cannot choose what it signs. */
export const deliveryPayloadDigest = (
  input: {
    readonly repository: FactoryRepository;
    readonly baseRef: string;
    readonly headSha: string;
  } & (
    | { readonly kind: "publish-pr"; readonly payload: FactoryDeliveryPublishPayload }
    | {
        readonly kind: "merge-pr";
        readonly payload: FactoryDeliveryMergePayload;
        readonly pullRequestNumber: number;
      }
  ),
) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        input.kind === "merge-pr"
          ? [
              input.kind,
              input.repository.canonicalKey,
              input.baseRef,
              input.headSha,
              input.pullRequestNumber,
              input.payload.mergeMethod,
            ]
          : [
              input.kind,
              input.repository.canonicalKey,
              input.baseRef,
              input.headSha,
              input.payload.title,
              input.payload.body,
              input.payload.draft,
            ],
      ),
      "utf8",
    )
    .digest("hex");

const summarizeChecks = (checks: PullRequestDetail["checks"]) => {
  let passed = 0;
  let failing = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.status === "success") passed += 1;
    else if (check.status === "failure" || check.status === "cancelled") failing += 1;
    else if (check.status === "pending" || check.status === "action-required") pending += 1;
  }
  const parts = [
    passed > 0 ? `${passed} passed` : null,
    failing > 0 ? `${failing} failing` : null,
    pending > 0 ? `${pending} pending` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
};

const summarizePullRequest = (detail: PullRequestDetail): FactoryDeliveryPullRequest => ({
  number: detail.number,
  url: detail.url,
  headSha: detail.headSha ?? null,
  state: detail.state,
  mergeability: detail.mergeability,
  isDraft: detail.isDraft,
  checksSummary: summarizeChecks(detail.checks),
  mergeMethods: detail.capabilities.mergeMethods,
});

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
  const knowledgeStore = yield* KnowledgeStore.FactoryKnowledgeStore;
  const knowledge = yield* Knowledge.FactoryKnowledgeService;
  const projects = yield* Projects.ProjectService;
  const resolveRepository = yield* makeRepositoryResolver;
  const environment = yield* ServerEnvironmentIdentity;
  const threads = yield* Threads.ThreadManagementService;
  const git = yield* Git.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const trackers = yield* IssueTrackerProviderRegistry;
  const pullRequests = yield* PullRequests.PullRequestService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = NodeOS.tmpdir();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // What the grantor is shown and what a grant re-derives: the claim, the live acceptance, and
  // whether the worktree still sits on the accepted commit. Every caller reads it before the host,
  // so a host that cannot deliver with the exact-commit guarantee is refused without being asked.
  const observe = Effect.fn("FactoryDeliveryService.observe")(function* (input: {
    readonly projectId: FactoryDeliveryReadInput["projectId"];
    readonly threadId: FactoryDeliveryReadInput["threadId"];
    readonly kind: FactoryDeliveryKind;
  }) {
    const origin = yield* acceptanceStore
      .resolveOrigin(input.threadId)
      .pipe(Effect.mapError(fromAcceptance));
    const read = yield* acceptance
      .read({ projectId: input.projectId, threadId: input.threadId })
      .pipe(Effect.mapError(fromAcceptance));
    if (Option.isNone(origin))
      return yield* new FactoryDeliveryError({ reason: "not-a-factory-task" });
    // The provider frozen into the claim at admission, not whatever the checkout points at now.
    const capabilities = trackers.get(origin.value.repository.provider)?.capabilities;
    if (
      capabilities === undefined ||
      !capabilities.publish ||
      (input.kind === "merge-pr" && !capabilities.headPinnedMerge)
    )
      return yield* new FactoryDeliveryError({ reason: "capability-unsupported" });
    if (read.acceptance === null || read.acceptance.originKey !== origin.value.originKey)
      return yield* new FactoryDeliveryError({ reason: "not-accepted" });
    return {
      origin: origin.value,
      acceptance: read.acceptance,
      current: read.current,
      liveHeadSha: read.liveHeadSha,
    };
  });

  // The pull request a merge acts on is the one this origin's confirmed publish created, never one
  // the caller names.
  const publishedPullRequest = Effect.fn("FactoryDeliveryService.publishedPullRequest")(function* (
    originKey: FactoryOriginKey,
  ) {
    const published = yield* store.getLive(originKey, "publish-pr");
    if (
      Option.isNone(published) ||
      published.value.status !== "confirmed" ||
      published.value.remote === null
    )
      return yield* new FactoryDeliveryError({ reason: "not-published" });
    return published.value.remote;
  });

  const pullRequestRef = (
    projectId: PullRequestRef["projectId"],
    repository: FactoryRepository,
    number: number,
  ): PullRequestRef => ({
    projectId,
    repository: repository.repository,
    host: repository.host,
    number,
  });

  // `fresh` drops the shared one-minute read cache: a grant and a reconcile decide on the head as
  // it stands now, while prepare is advisory and may be served from it.
  const readPullRequest = Effect.fn("FactoryDeliveryService.readPullRequest")(function* (
    ref: PullRequestRef,
    options: { readonly fresh: boolean },
  ) {
    if (options.fresh) yield* pullRequests.invalidate({ reference: ref });
    return yield* pullRequests
      .detail(options.fresh ? { ...ref, allowStale: false } : ref)
      .pipe(Effect.mapError(persistenceFailure));
  });
  const observeArtifact = Effect.fn("FactoryDeliveryService.observeArtifact")(function* (
    input: FactoryDeliveryReadInput,
    attempt: string,
  ) {
    const launch = yield* knowledgeStore
      .getLaunchByThread(input.threadId)
      .pipe(Effect.mapError(persistenceFailure));
    if (Option.isNone(launch) || launch.value.intent.projectId !== input.projectId)
      return yield* new FactoryDeliveryError({ reason: "not-a-factory-task" });
    // Knowledge owns the realpath confinement and UTF-8 decoding. Delivery never reads the file
    // through a second path that could disagree with what was accepted.
    const seen = yield* knowledge
      .read({
        projectId: input.projectId,
        briefId: launch.value.intent.briefId,
      })
      .pipe(Effect.mapError(persistenceFailure));
    if (seen.acceptance === null || seen.acceptance.threadId !== input.threadId)
      return yield* new FactoryDeliveryError({ reason: "not-accepted" });
    if (seen.artifactIssue === "too-large")
      return yield* new FactoryDeliveryError({ reason: "artifact-too-large" });
    if (seen.artifact === null)
      return yield* new FactoryDeliveryError({ reason: "artifact-changed" });
    if (!seen.current) return yield* new FactoryDeliveryError({ reason: "artifact-changed" });
    if (seen.artifact.bytes > FACTORY_KNOWLEDGE_ARTIFACT_PREVIEW_MAX_BYTES)
      return yield* new FactoryDeliveryError({ reason: "artifact-too-large" });
    if (seen.artifact.preview === null)
      return yield* new FactoryDeliveryError({ reason: "artifact-not-text" });
    const rendered = {
      briefTitle: seen.brief.title,
      deliverablePath: seen.artifact.path,
      text: seen.artifact.preview,
      artifactSha256: seen.artifact.sha256,
      acceptanceId: seen.acceptance.id,
      attempt,
    };
    const body = renderArtifactComment(rendered);
    if (body === null) return yield* new FactoryDeliveryError({ reason: "artifact-too-large" });
    return {
      acceptance: seen.acceptance,
      originKey: knowledgeBriefOriginKey(seen.brief.id),
      briefId: seen.brief.id,
      artifact: seen.artifact,
      body,
    };
  });

  const artifactDestination = Effect.fn("FactoryDeliveryService.artifactDestination")(function* (
    input: FactoryDeliveryReadInput,
    issueNumber: number,
  ) {
    const resolved = yield* resolveRepository(input.projectId).pipe(
      Effect.mapError(
        (cause) =>
          new FactoryDeliveryError({
            reason:
              cause.reason === "unsupported-provider"
                ? "capability-unsupported"
                : "persistence-failure",
            cause,
          }),
      ),
    );
    const { tracker, repository, project } = resolved;
    if (
      !tracker.capabilities.issueComment ||
      tracker.commentOnIssue === undefined ||
      tracker.listIssueComments === undefined
    )
      return yield* new FactoryDeliveryError({ reason: "capability-unsupported" });
    const issue = yield* tracker
      .getIssue({
        cwd: project.workspaceRoot,
        host: repository.host,
        repository: repository.repository,
        number: issueNumber,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new FactoryDeliveryError({
              reason:
                cause.reason === "not-found" || cause.reason === "not-an-issue"
                  ? "destination-not-found"
                  : "persistence-failure",
              cause,
            }),
        ),
      );
    return {
      repository,
      destination: { number: issue.number, title: issue.title, state: issue.state, url: issue.url },
      destinationKey: `comment:${issueOriginKey(repository.provider, repository.canonicalKey, issueNumber)}`,
    };
  });

  const artifactDigest = (
    destinationKey: string,
    seen: Effect.Success<ReturnType<typeof observeArtifact>>,
  ) =>
    NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([
          "publish-artifact",
          destinationKey,
          seen.acceptance.id,
          seen.artifact.sha256,
          seen.body,
        ]),
        "utf8",
      )
      .digest("hex");

  const grantArtifact = Effect.fn("FactoryDeliveryService.grantArtifact")(function* (
    input: FactoryArtifactDeliveryGrantInput,
  ) {
    const destination = yield* artifactDestination(input, input.payload.issueNumber);
    const validate = Effect.gen(function* () {
      const seen = yield* observeArtifact(input, input.attempt);
      if (seen.artifact.sha256 !== input.expectedArtifactSha256)
        return yield* new FactoryDeliveryError({ reason: "artifact-changed" });
      const payloadDigest = artifactDigest(destination.destinationKey, seen);
      if (payloadDigest !== input.expectedPayloadDigest)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      return { ...seen, payloadDigest };
    });
    const seen = yield* validate;
    const at = yield* nowIso;
    const intent: FactoryArtifactDeliveryIntent = {
      // The primary key consumes a prepared attempt even when its delivery later fails.
      id: `delivery:artifact:${input.attempt}`,
      originKey: seen.originKey,
      threadId: input.threadId,
      projectId: input.projectId,
      kind: "publish-artifact",
      acceptanceId: seen.acceptance.id,
      briefId: seen.briefId,
      artifactPath: seen.artifact.path,
      artifactSha256: seen.artifact.sha256,
      artifactBytes: seen.artifact.bytes,
      repository: destination.repository,
      destinationKey: destination.destinationKey,
      payload: input.payload,
      body: seen.body,
      payloadDigest: seen.payloadDigest,
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
    if (granted.created) yield* outbox.notifyAvailable(1);
    return granted.intent;
  });

  const prepare = Effect.fn("FactoryDeliveryService.prepare")(function* (
    input: FactoryDeliveryPrepareInput,
  ) {
    if (input.kind === "publish-artifact") {
      if (!("issueNumber" in input.payload))
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      const attempt = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const seen = yield* observeArtifact(input, attempt);
      const destination = yield* artifactDestination(input, input.payload.issueNumber);
      return {
        attempt,
        acceptance: seen.acceptance,
        current: true,
        ...destination,
        artifactSha256: seen.artifact.sha256,
        artifactBytes: seen.artifact.bytes,
        body: seen.body,
        payload: input.payload,
        payloadDigest: artifactDigest(destination.destinationKey, seen),
        existing: Option.getOrNull(
          yield* store.getLiveArtifact(seen.originKey, destination.destinationKey),
        ),
      };
    }
    const target = targetOf(input);
    if (target === null) return yield* new FactoryDeliveryError({ reason: "payload-changed" });
    const seen = yield* observe(input);
    if (!seen.current) return yield* new FactoryDeliveryError({ reason: "acceptance-stale" });
    const existing = yield* store.getLive(seen.origin.originKey, input.kind);
    const common = {
      acceptance: seen.acceptance,
      current: true,
      repository: seen.origin.repository,
      baseRef: seen.acceptance.baseRef,
      headSha: seen.acceptance.headSha,
      existing: Option.getOrNull(existing),
    };
    if (target.kind === "publish-pr")
      return {
        ...common,
        payload: target.payload,
        payloadDigest: deliveryPayloadDigest({
          kind: target.kind,
          repository: seen.origin.repository,
          baseRef: seen.acceptance.baseRef,
          headSha: seen.acceptance.headSha,
          payload: target.payload,
        }),
        pullRequest: null,
      };
    const remote = yield* publishedPullRequest(seen.origin.originKey);
    const detail = yield* readPullRequest(
      pullRequestRef(input.projectId, seen.origin.repository, remote.number),
      { fresh: false },
    );
    return {
      ...common,
      payload: target.payload,
      payloadDigest: deliveryPayloadDigest({
        kind: target.kind,
        repository: seen.origin.repository,
        baseRef: seen.acceptance.baseRef,
        headSha: seen.acceptance.headSha,
        payload: target.payload,
        pullRequestNumber: remote.number,
      }),
      pullRequest: summarizePullRequest(detail),
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
    if (input.kind === "publish-artifact") return yield* grantArtifact(input);
    const target = targetOf(input);
    if (target === null) return yield* new FactoryDeliveryError({ reason: "payload-changed" });
    // The host is read once, before the transaction: a network call must not hold the database
    // write lock. The transactional recheck below re-derives everything local against this read,
    // and the host pins the merge itself to the accepted head when it runs.
    const pullRequest =
      target.kind === "merge-pr"
        ? yield* Effect.gen(function* () {
            const seen = yield* observe(input);
            const remote = yield* publishedPullRequest(seen.origin.originKey);
            return {
              number: remote.number,
              detail: yield* readPullRequest(
                pullRequestRef(input.projectId, seen.origin.repository, remote.number),
                { fresh: true },
              ),
            };
          })
        : null;
    // Re-run under the grant transaction, so a head that moves between the check and the insert
    // is still refused.
    const validate = Effect.gen(function* () {
      const seen = yield* observe(input);
      const headSha = seen.acceptance.headSha;
      if (!seen.current || seen.liveHeadSha !== headSha || headSha !== input.expectedHeadSha)
        return yield* new FactoryDeliveryError({ reason: "head-moved" });
      const common = {
        repository: seen.origin.repository,
        baseRef: seen.acceptance.baseRef,
        headSha,
      };
      if (target.kind === "publish-pr") {
        const payloadDigest = deliveryPayloadDigest({
          ...common,
          kind: target.kind,
          payload: target.payload,
        });
        if (payloadDigest !== input.expectedPayloadDigest)
          return yield* new FactoryDeliveryError({ reason: "payload-changed" });
        return { ...seen, payloadDigest, remote: null };
      }
      const published = yield* publishedPullRequest(seen.origin.originKey);
      if (pullRequest === null || pullRequest.number !== published.number)
        return yield* new FactoryDeliveryError({ reason: "not-published" });
      const { detail } = pullRequest;
      if (detail.state === "merged")
        return yield* new FactoryDeliveryError({ reason: "already-merged" });
      if (detail.headSha !== headSha)
        return yield* new FactoryDeliveryError({ reason: "pull-request-head-moved" });
      // Branch protection stays the host's call; only what it already reports as unmergeable is
      // refused here, so a person is not asked to grant a merge that cannot run.
      if (detail.state !== "open" || detail.isDraft || detail.mergeability === "conflicting")
        return yield* new FactoryDeliveryError({ reason: "not-mergeable" });
      const payloadDigest = deliveryPayloadDigest({
        ...common,
        kind: target.kind,
        payload: target.payload,
        pullRequestNumber: published.number,
      });
      if (payloadDigest !== input.expectedPayloadDigest)
        return yield* new FactoryDeliveryError({ reason: "payload-changed" });
      return {
        ...seen,
        payloadDigest,
        remote: { number: detail.number, url: detail.url },
      };
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
      payload: target.payload,
      payloadDigest: validated.payloadDigest,
      grantedBy: yield* environment.getEnvironmentId,
      grantedAt: at,
      requestCommandId: input.commandId,
      status: "pending",
      remote: validated.remote,
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
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(persistenceFailure));
    if (shell === null || shell.projectId !== input.projectId)
      return yield* new FactoryDeliveryError({ reason: "unknown-thread" });
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
    function* (intent: FactoryCommitDeliveryIntent, remote: { readonly url: string }) {
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
    intent: FactoryCommitDeliveryIntent,
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
  const send = Effect.fn("FactoryDeliveryService.send")(function* (
    intent: FactoryCommitDeliveryIntent,
  ) {
    const fail = (failure: string) => settle(intent, "failed", failure);
    const { payload } = intent;
    if (isMergePayload(payload)) return yield* fail("payload does not match the delivery kind");
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
    const written = yield* Effect.result(fileSystem.writeFileString(bodyFile, payload.body));
    if (written._tag === "Failure")
      return yield* fail(describe("could not write the pull request body", written.failure));
    // From here the request may reach the forge: only a definite rejection proves it did not.
    const created = yield* Effect.result(
      provider.success
        .createChangeRequest({
          cwd: worktree,
          baseRefName: intent.baseRef,
          headSelector: before.success.headSelector,
          title: payload.title,
          bodyFile,
          draft: payload.draft,
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

  // The pull request is already linked to the thread by its publish, so a merge only settles.
  const confirmMerged = Effect.fn("FactoryDeliveryService.confirmMerged")(function* (
    intent: FactoryCommitDeliveryIntent,
    remote: { readonly number: number; readonly url: string },
  ) {
    const settled = yield* store.settle(intent.id, {
      status: "confirmed",
      remote,
      failure: null,
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(settled, () => intent);
  });

  // A merge touches neither the worktree nor git: the host merges the pull request, pinned to the
  // head the grantor accepted, so a push since then is refused instead of merged.
  const sendMerge = Effect.fn("FactoryDeliveryService.sendMerge")(function* (
    intent: FactoryCommitDeliveryIntent,
  ) {
    const { remote, payload } = intent;
    if (remote === null || !isMergePayload(payload))
      return yield* settle(intent, "failed", "merge intent is missing its pull request");
    const merged = yield* Effect.result(
      pullRequests.runAction({
        ...pullRequestRef(intent.projectId, intent.repository, remote.number),
        action: "merge",
        mergeMethod: payload.mergeMethod,
        expectedHeadSha: intent.headSha,
      }),
    );
    if (merged._tag === "Failure")
      return isDefiniteMergeRejection(merged.failure)
        ? yield* settle(intent, "failed", describe("merge rejected", merged.failure))
        : yield* settle(intent, "unknown", describe("response lost", merged.failure));
    yield* confirmMerged(intent, remote);
  });

  const reconcileMerge = Effect.fn("FactoryDeliveryService.reconcileMerge")(function* (
    intent: FactoryCommitDeliveryIntent,
  ) {
    if (intent.remote === null)
      return yield* new FactoryDeliveryError({ reason: "not-reconcilable" });
    const looked = yield* Effect.result(
      readPullRequest(pullRequestRef(intent.projectId, intent.repository, intent.remote.number), {
        fresh: true,
      }),
    );
    if (looked._tag === "Success" && looked.success.state === "merged")
      return yield* confirmMerged(intent, intent.remote);
    // As for a publish: a failed read proves nothing, so the status stays; a successful read of a
    // pull request that is not merged means the send did not land, and releases the origin.
    const refreshed = yield* store.settle(intent.id, {
      status: looked._tag === "Failure" ? intent.status : "failed",
      failure: (looked._tag === "Failure"
        ? describe("could not read pull request", looked.failure)
        : "pull request is not merged"
      ).slice(0, FAILURE_MAX_CHARS),
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(refreshed, () => intent);
  });
  const confirmArtifact = Effect.fn("FactoryDeliveryService.confirmArtifact")(function* (
    intent: FactoryArtifactDeliveryIntent,
    remote: FactoryArtifactDeliveryRemote,
  ) {
    const settled = yield* store.settle(intent.id, {
      status: "confirmed",
      remote,
      failure: null,
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(settled, () => intent);
  });

  const sendArtifact = Effect.fn("FactoryDeliveryService.sendArtifact")(function* (
    intent: FactoryArtifactDeliveryIntent,
  ) {
    const tracker = trackers.get(intent.repository.provider);
    if (!tracker?.capabilities.issueComment || tracker.commentOnIssue === undefined)
      return yield* settle(intent, "failed", "capability-unsupported");
    const project = yield* projects
      .getById(intent.projectId)
      .pipe(Effect.mapError(persistenceFailure));
    if (Option.isNone(project)) return yield* settle(intent, "failed", "project-unavailable");
    // The grant froze the bytes and destination. Neither a changed file nor a changed origin
    // may redirect an already-authorized send.
    const sent = yield* Effect.result(
      tracker.commentOnIssue({
        cwd: project.value.workspaceRoot,
        host: intent.repository.host,
        repository: intent.repository.repository,
        number: intent.payload.issueNumber,
        body: intent.body,
      }),
    );
    if (sent._tag === "Failure")
      return yield* settle(
        intent,
        isDefiniteRejection(sent.failure) ? "failed" : "unknown",
        describe("comment response", sent.failure),
      );
    yield* confirmArtifact(intent, { commentId: sent.success.id, url: sent.success.url });
  });

  const reconcileArtifact = Effect.fn("FactoryDeliveryService.reconcileArtifact")(function* (
    intent: FactoryArtifactDeliveryIntent,
  ) {
    const tracker = trackers.get(intent.repository.provider);
    if (!tracker?.capabilities.issueComment || tracker.listIssueComments === undefined)
      return intent;
    const project = yield* projects
      .getById(intent.projectId)
      .pipe(Effect.mapError(persistenceFailure));
    if (Option.isNone(project)) return intent;
    let page = 1;
    let remote: FactoryArtifactDeliveryRemote | null = null;
    while (true) {
      const listed = yield* Effect.result(
        tracker.listIssueComments({
          cwd: project.value.workspaceRoot,
          host: intent.repository.host,
          repository: intent.repository.repository,
          number: intent.payload.issueNumber,
          page,
        }),
      );
      if (listed._tag === "Failure") return intent;
      const match = listed.success.comments.find((comment) =>
        carriesDeliveryMarker(comment.body, intent.body),
      );
      if (remote === null && match !== undefined) remote = { commentId: match.id, url: match.url };
      if (listed.success.nextPage === null) break;
      // A non-advancing cursor cannot prove absence; it is an incomplete listing.
      if (listed.success.nextPage <= page) return intent;
      page = listed.success.nextPage;
    }
    if (remote !== null) return yield* confirmArtifact(intent, remote);
    const settled = yield* store.settle(intent.id, {
      status: "failed",
      failure: "no matching artifact comment found",
      updatedAt: yield* nowIso,
    });
    return Option.getOrElse(settled, () => intent);
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
    yield* intent.kind === "publish-artifact"
      ? sendArtifact(intent)
      : intent.kind === "merge-pr"
        ? sendMerge(intent)
        : send(intent);
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
    if (intent.kind === "publish-artifact") return yield* reconcileArtifact(intent);
    if (intent.kind === "merge-pr") return yield* reconcileMerge(intent);
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
      yield* Effect.logWarning("settled interrupted Factory deliveries as unknown", {
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
