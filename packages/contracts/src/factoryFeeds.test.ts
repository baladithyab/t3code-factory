import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  FACTORY_FEED_INSTRUCTIONS_MAX_CHARS,
  FactoryFeedCandidateAdmitInput,
  FactoryFeedSourceId,
} from "./factoryFeeds.ts";

const input = {
  commandId: CommandId.make("admit"),
  projectId: ProjectId.make("project"),
  expectedRepositoryKey: "github.com/owner/factory",
  sourceId: FactoryFeedSourceId.make("source"),
  itemKey: "atom:urn:uuid:1",
  expectedRevision: "reviewed-revision",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
} satisfies FactoryFeedCandidateAdmitInput;
const decodeAdmitInput = Schema.decodeUnknownSync(FactoryFeedCandidateAdmitInput);

describe("factory feed wire contract", () => {
  it("keeps the item key exact, because atom:id and guid compare character for character", () => {
    const itemKey = "atom: spaced id ";
    expect(decodeAdmitInput({ ...input, itemKey }).itemKey).toBe(itemKey);
    expect(() => decodeAdmitInput({ ...input, itemKey: "" })).toThrow();
  });

  it("has no admit shape that skips the reviewed revision", () => {
    const { expectedRevision: _reviewed, ...unreviewed } = input;
    expect(() => decodeAdmitInput(unreviewed)).toThrow();
    for (const value of [null, "", "   "]) {
      expect(() => decodeAdmitInput({ ...input, expectedRevision: value })).toThrow();
    }
  });

  it("bounds reviewer instructions at the boundary", () => {
    const limit = "x".repeat(FACTORY_FEED_INSTRUCTIONS_MAX_CHARS);
    expect(decodeAdmitInput({ ...input, instructions: limit }).instructions).toBe(limit);
    expect(() => decodeAdmitInput({ ...input, instructions: `${limit}x` })).toThrow();
  });
});
