import {
  CommandId,
  FactoryIssueError,
  FactoryRepository,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type FactoryIssueTask,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as Git from "../vcs/GitVcsDriver.ts";

export const FactoryLaunchCore = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  requestCommandId: CommandId,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  baseRef: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  prompt: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  previousThreadId: Schema.NullOr(ThreadId),
});
type Core = typeof FactoryLaunchCore.Type;
type Binding<I extends Core> = { readonly intent: I; readonly accepted: 0 | 1 };
type LaunchReason =
  | "persistence-failure"
  | "deleted-task"
  | "launch-authority"
  | "provider-unavailable"
  | "launch-failure";

function repositoryTarget(identity: RepositoryIdentity, remote: string): FactoryRepository | null {
  const canonicalKey = normalizeGitRemoteUrl(remote);
  const detected = detectSourceControlProviderFromGitRemoteUrl(remote)?.kind;
  const provider =
    detected === "unknown" && canonicalKey === identity.canonicalKey ? identity.provider : detected;
  if (provider !== "github") return null;
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/.exec(
    canonicalKey,
  );
  if (match === null) return null;
  const [, host, owner, name] = match;
  if (!host || !owner || !name || owner === "." || owner === ".." || name === "." || name === "..")
    return null;
  const repository = `${owner}/${name}`;
  return {
    provider: "github",
    host,
    repository,
    canonicalKey,
    url: `https://${host}/${repository}`,
  };
}

export const makeRepositoryResolver = Effect.gen(function* () {
  const projects = yield* Projects.ProjectService;
  const identities = yield* Identities.RepositoryIdentityResolver;
  const git = yield* Git.GitVcsDriver;
  return Effect.fn("FactoryIssueService.resolve")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError((cause) => new FactoryIssueError({ reason: "persistence-failure", cause })),
      );
    if (Option.isNone(project)) return yield* new FactoryIssueError({ reason: "missing-project" });
    const identity = yield* identities.resolve(project.value.workspaceRoot, { refresh: true });
    if (identity === null) return yield* new FactoryIssueError({ reason: "missing-repository" });
    // `remote get-url` distinguishes a missing origin and applies Git's insteadOf rewrites.
    const origin = yield* git
      .execute({
        operation: "FactoryIssueService.resolveOrigin",
        cwd: project.value.workspaceRoot,
        args: ["remote", "get-url", "--", "origin"],
        allowNonZeroExit: true,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.mapError((cause) => new FactoryIssueError({ reason: "missing-repository", cause })),
      );
    if (
      origin.exitCode !== 0 ||
      origin.stdoutTruncated ||
      origin.stderrTruncated ||
      origin.stdout.trim().length === 0
    )
      return yield* new FactoryIssueError({ reason: "missing-repository" });
    const repository = repositoryTarget(identity, origin.stdout.trim());
    if (repository === null)
      return yield* new FactoryIssueError({ reason: "unsupported-provider" });
    return { project: project.value, repository };
  });
});

export const make = Effect.fn("FactoryTaskLaunch.make")(function* <I extends Core, E>(options: {
  readonly span: string;
  readonly error: (reason: LaunchReason, cause?: unknown) => E;
  readonly accept: (threadId: ThreadId) => Effect.Effect<void, E>;
  readonly title: (intent: I) => string;
  readonly precondition: (intent: I) => Effect.Effect<void, E>;
}) {
  const projects = yield* Projects.ProjectService;
  const threads = yield* Threads.ThreadManagementService;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const inspect = Effect.fn(`${options.span}.inspect`)(function* (binding: Binding<I>) {
    const { intent } = binding;
    const shell = yield* threads
      .getThreadShell(intent.threadId)
      .pipe(Effect.mapError((cause) => options.error("persistence-failure", cause)));
    let status: FactoryIssueTask["status"];
    if (shell === null) {
      // Receipt and tombstone distinguish an interrupted reservation from a deletion even
      // when the process died before recording the launch response in this table.
      const receipt = yield* receipts
        .getByCommandId(intent.commandId)
        .pipe(Effect.mapError((cause) => options.error("persistence-failure", cause)));
      status =
        binding.accepted === 1 || (Option.isSome(receipt) && receipt.value.status === "accepted")
          ? "missing"
          : "launching";
      if (status === "launching") {
        const owner = yield* projects
          .getById(intent.projectId)
          .pipe(Effect.mapError((cause) => options.error("persistence-failure", cause)));
        if (Option.isNone(owner)) status = "missing";
      }
    } else if (shell.deletedAt !== null) status = "missing";
    else if (shell.archivedAt !== null) status = "archived";
    else if (shell.status === "preparing") status = "preparing";
    else if (shell.status === "failed") status = "failed";
    else if (["running", "starting", "waiting", "queued"].includes(shell.status))
      status = "running";
    else status = binding.accepted === 0 && shell.latestRunId === null ? "launching" : "idle";
    return {
      shell,
      task: {
        projectId: intent.projectId,
        threadId: intent.threadId,
        baseRef: intent.baseRef,
        createdAt: intent.createdAt,
        status,
        modelSelection: intent.modelSelection,
        runtimeMode: intent.runtimeMode,
        interactionMode: intent.interactionMode,
      } satisfies FactoryIssueTask,
    };
  });
  const resume = Effect.fn(`${options.span}.launch`)(function* (binding: Binding<I>) {
    const { intent } = binding;
    let inspected = yield* inspect(binding);
    if (inspected.task.status === "missing")
      return yield* Effect.fail(options.error("deleted-task"));
    if (binding.accepted === 0 && inspected.task.status !== "archived") {
      const limit = yield* DispatchModeLimit;
      if (limit !== undefined && exceededDispatchModeLimit(limit, intent) !== undefined)
        return yield* Effect.fail(options.error("launch-authority"));
      yield* options.precondition(intent);
      yield* launcher
        .launch({
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId: intent.projectId,
          title: options.title(intent),
          modelSelection: intent.modelSelection,
          runtimeMode: intent.runtimeMode,
          interactionMode: intent.interactionMode,
          workspaceStrategy: {
            type: "worktree",
            baseRef: intent.baseRef,
            startFromOrigin: false,
          },
          initialMessage: { messageId: intent.messageId, text: intent.prompt, attachments: [] },
          createdBy: intent.createdBy,
          creationSource: intent.creationSource,
        })
        .pipe(
          Effect.mapError((cause) =>
            options.error(
              cause._tag === "ThreadManagementProviderInstanceDisabledError"
                ? "provider-unavailable"
                : "launch-failure",
              cause,
            ),
          ),
        );
      yield* options.accept(intent.threadId);
      inspected = yield* inspect({ ...binding, accepted: 1 });
    }
    return inspected.task;
  });
  return { inspect, resume };
});
