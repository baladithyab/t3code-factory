import {
  FactoryAcceptanceError,
  type FactoryAcceptCommitInput,
  type FactoryAcceptanceReadInput,
  type FactoryAcceptanceReadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "../persistence/FactoryAcceptanceStore.ts";
import * as Git from "../vcs/GitVcsDriver.ts";

export class FactoryAcceptanceService extends Context.Service<
  FactoryAcceptanceService,
  {
    /**
     * A person's act, never an agent's: the only caller is the guarded RPC, and no MCP tool
     * exposes it. The server observes the worktree head itself; the input only asserts what the
     * reviewer saw.
     */
    readonly acceptCommit: (
      input: FactoryAcceptCommitInput,
    ) => Effect.Effect<FactoryAcceptanceReadResult, FactoryAcceptanceError>;
    readonly read: (
      input: FactoryAcceptanceReadInput,
    ) => Effect.Effect<FactoryAcceptanceReadResult, FactoryAcceptanceError>;
  }
>()("t3/factory/FactoryAcceptanceService") {}

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryAcceptanceStore;
  const environment = yield* ServerEnvironmentIdentity;
  const threads = yield* Threads.ThreadManagementService;
  const git = yield* Git.GitVcsDriver;
  const crypto = yield* Crypto.Crypto;
  const revParse = Effect.fn("FactoryAcceptanceService.revParse")(function* (
    cwd: string,
    revision: string,
  ) {
    const result = yield* git.execute({
      operation: "FactoryAcceptanceService.revParse",
      cwd,
      args: ["rev-parse", "--verify", `${revision}^{commit}`],
      allowNonZeroExit: true,
      maxOutputBytes: 4096,
    });
    return result.exitCode === 0 && !result.stdoutTruncated && result.stdout.trim() !== ""
      ? Option.some(result.stdout.trim())
      : Option.none<string>();
  });
  const requireShell = Effect.fn("FactoryAcceptanceService.requireShell")(function* (
    input: FactoryAcceptanceReadInput,
  ) {
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new FactoryAcceptanceError({ reason: "persistence-failure", cause }),
        ),
      );
    if (shell === null || shell.projectId !== input.projectId)
      return yield* new FactoryAcceptanceError({ reason: "unknown-thread" });
    return shell;
  });
  const worktreeOf = (shell: {
    readonly deletedAt: unknown;
    readonly worktreePath: string | null;
  }) => (shell.deletedAt === null ? shell.worktreePath : null);

  const acceptCommit = Effect.fn("FactoryAcceptanceService.acceptCommit")(function* (
    input: FactoryAcceptCommitInput,
  ) {
    const shell = yield* requireShell(input);
    const worktree = worktreeOf(shell);
    if (worktree === null)
      return yield* new FactoryAcceptanceError({ reason: "worktree-unavailable" });
    const origin = yield* store.resolveOrigin(input.threadId);
    if (Option.isNone(origin))
      return yield* new FactoryAcceptanceError({ reason: "not-a-factory-task" });
    const existing = yield* store.getByOrigin(origin.value.originKey);
    // A live acceptance held by an earlier attempt of the same origin is retired by this one.
    // The same thread is refused unless the caller asked to supersede after the head moved.
    if (
      Option.isSome(existing) &&
      existing.value.threadId === input.threadId &&
      input.supersede !== true
    )
      return yield* new FactoryAcceptanceError({ reason: "already-accepted" });
    const unavailable = (cause?: unknown) =>
      new FactoryAcceptanceError({
        reason: "worktree-unavailable",
        ...(cause === undefined ? {} : { cause }),
      });
    const head = yield* revParse(worktree, "HEAD").pipe(Effect.mapError(unavailable));
    if (Option.isNone(head)) return yield* unavailable();
    // Compare-and-swap: the client's view must be the head the server sees right now.
    if (head.value !== input.expectedHeadSha)
      return yield* new FactoryAcceptanceError({ reason: "head-moved" });
    const baseSha = yield* revParse(worktree, origin.value.baseRef).pipe(
      Effect.mapError(unavailable),
    );
    if (Option.isNone(baseSha)) return yield* unavailable();
    const acceptance = yield* store.insert(
      {
        id: `acceptance:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
        originKey: origin.value.originKey,
        threadId: input.threadId,
        projectId: input.projectId,
        headSha: head.value,
        baseRef: origin.value.baseRef,
        baseSha: baseSha.value,
        acceptedAt: DateTime.formatIso(yield* DateTime.now),
        acceptedBy: yield* environment.getEnvironmentId,
        evidenceRefs: input.evidenceRefs,
      },
      { supersede: Option.isSome(existing) },
    );
    return { acceptance, liveHeadSha: head.value, current: true };
  });

  const read = Effect.fn("FactoryAcceptanceService.read")(function* (
    input: FactoryAcceptanceReadInput,
  ) {
    const shell = yield* requireShell(input);
    const acceptance = Option.getOrNull(yield* store.getByThread(input.threadId));
    if (acceptance !== null && acceptance.projectId !== input.projectId)
      return yield* new FactoryAcceptanceError({ reason: "unknown-thread" });
    const worktree = worktreeOf(shell);
    const liveHeadSha =
      worktree === null
        ? null
        : Option.getOrNull(
            yield* revParse(worktree, "HEAD").pipe(
              Effect.orElseSucceed(() => Option.none<string>()),
            ),
          );
    return {
      acceptance,
      liveHeadSha,
      current: acceptance !== null && liveHeadSha === acceptance.headSha,
    };
  });
  return FactoryAcceptanceService.of({ acceptCommit, read });
});
export const layer = Layer.effect(FactoryAcceptanceService, make);
