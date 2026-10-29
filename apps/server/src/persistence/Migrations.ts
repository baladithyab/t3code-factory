import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_OrchestrationV2.ts";
import Migration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Migration0059 from "./Migrations/059_McpAppModelContext.ts";
import Migration0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Migration0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import Migration0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Migration0063 from "./Migrations/063_DropUnusedV1Projections.ts";
import Migration0064 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import Migration0065 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import Migration0066 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import Migration0067 from "./Migrations/067_WebhookDedupe.ts";
import Migration0068 from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration0069 from "./Migrations/069_ThreadMessageSearch.ts";
import Migration0070 from "./Migrations/070_PeerLinks.ts";
import Migration0071 from "./Migrations/071_PeerLinkFence.ts";
import Migration0072 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Migration0073 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Migration0193 from "./Migrations/193_FactoryIssueLaunches.ts";
import Migration0194 from "./Migrations/194_ProjectCoordinators.ts";
import Migration0195 from "./Migrations/195_FactoryFeeds.ts";
import Migration0196 from "./Migrations/196_FactoryIssueRelations.ts";
import Migration0197 from "./Migrations/197_FactoryReadinessOverrides.ts";
import Migration0198 from "./Migrations/198_FactoryResearch.ts";
import Migration0199 from "./Migrations/199_FactoryClaims.ts";
import Migration0200 from "./Migrations/200_FactoryAcceptances.ts";
import Migration0201 from "./Migrations/201_FactoryDeliveryIntents.ts";
import Migration0202 from "./Migrations/202_FactoryKnowledge.ts";
import Migration0203 from "./Migrations/203_FactoryArtifactDeliveries.ts";

const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "PullRequestFilesViewed", Migration0053],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [55, "OrchestrationV2", Migration0055],
  [56, "RemoveRedundantProjectionIndexes", Migration0056],
  [57, "ScheduledTaskWebhooks", Migration0057],
  [58, "WebhookRelayDeliveries", Migration0058],
  [59, "McpAppModelContext", Migration0059],
  [60, "ThreadSnapshotWindowIndexes", Migration0060],
  [61, "PullRequestReviewGuides", Migration0061],
  [62, "ThreadFailureLookupIndex", Migration0062],
  [63, "DropUnusedV1Projections", Migration0063],
  [64, "CanonicalizeThreadPullRequestLinks", Migration0064],
  [65, "CodexUsageNativeTurnIndex", Migration0065],
  [66, "RepairClientSettlementTimestamps", Migration0066],
  [67, "WebhookDedupe", Migration0067],
  [68, "ShellStopRequestIndex", Migration0068],
  [69, "ThreadMessageSearch", Migration0069],
  [70, "PeerLinks", Migration0070],
  [71, "PeerLinkFence", Migration0071],
  [72, "WaitingLinkRequestIndex", Migration0072],
  [73, "ActiveTurnItemIndexes", Migration0073],
  [193, "FactoryIssueLaunches", Migration0193],
  [194, "ProjectCoordinators", Migration0194],
  [195, "FactoryFeeds", Migration0195],
  [196, "FactoryIssueRelations", Migration0196],
  [197, "FactoryReadinessOverrides", Migration0197],
  [198, "FactoryResearch", Migration0198],
  [199, "FactoryClaims", Migration0199],
  [200, "FactoryAcceptances", Migration0200],
  [201, "FactoryDeliveryIntents", Migration0201],
  [202, "FactoryKnowledge", Migration0202],
  [203, "FactoryArtifactDeliveries", Migration0203],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const FIRST_V2_MIGRATION_ID = 55;

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

// The pre-sync Factory build used 69-75; translate only that exact history, atomically
// installing upstream's missing 69-73 before the migrator's highest-id guard runs.
const reconcileFactoryMigrations = Effect.fn("reconcileFactoryMigrations")(function* (
  throughId?: number,
) {
  if (throughId !== undefined && throughId < 193) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`;
      if (tables.length === 0) return [];
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations
    `;
      const legacy = migrationEntries.filter(([id]) => id >= 193 && id <= 199);
      if (
        !recorded.some((row) =>
          legacy.some(([id, name]) => row.migration_id === id - 124 && row.name === name),
        )
      )
        return [];
      const translated = new Map<number, string>();
      for (const row of recorded) {
        const entry = legacy.find(
          ([id, name]) => row.migration_id === id - 124 && row.name === name,
        );
        const id = entry?.[0] ?? row.migration_id;
        if (
          translated.has(id) ||
          !migrationEntries.some(([expectedId, name]) => expectedId === id && name === row.name)
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "Unrecognized or mixed legacy Factory migration history; refusing to rewrite it.",
          });
        }
        translated.set(id, row.name);
      }
      const latest = Math.max(...translated.keys());
      for (const [id, name] of migrationEntries) {
        if (id < FIRST_V2_MIGRATION_ID || id > latest || (id >= 69 && id <= 73)) continue;
        if (translated.get(id) !== name) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Incomplete legacy Factory migration history: missing ${id}_${name}.`,
          });
        }
      }
      for (const [id, name] of legacy) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${id} WHERE migration_id = ${id - 124} AND name = ${name}`;
      }
      const executed: Array<readonly [number, string]> = [];
      for (const [id, name, migration] of migrationEntries) {
        if (id < 69 || id > 73 || translated.has(id)) continue;
        yield* Effect.catch(migration, (cause: unknown) =>
          Effect.fail(
            new Migrator.MigrationError({
              kind: "Failed",
              message: `Failed to install ${id}_${name} while upgrading legacy Factory history.`,
              cause,
            }),
          ),
        );
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        executed.push([id, name]);
      }
      return executed;
    }),
  );
});

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  const previewMigrations = includesV2 ? yield* reconcileV2PreviewMigration() : [];
  const factoryMigrations = includesV2
    ? yield* reconcileFactoryMigrations(toMigrationInclusive)
    : [];
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const executedMigrations = [
    ...previewMigrations,
    ...factoryMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
