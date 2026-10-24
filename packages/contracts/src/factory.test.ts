import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { FactoryIssueListInput, FactoryIssueStartInput } from "./factory.ts";

const input = {
  commandId: CommandId.make("start"),
  projectId: ProjectId.make("project"),
  issueNumber: 1,
  expectedRepositoryKey: "github.com/owner/factory",
  expectedIssueRevision: "reviewed-revision",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
} satisfies FactoryIssueStartInput;
const decodeStartInput = Schema.decodeUnknownSync(FactoryIssueStartInput);
const decodeListInput = Schema.decodeUnknownSync(FactoryIssueListInput);

describe("factory wire contract", () => {
  it("rejects invalid issue numbers and pages at the boundary", () => {
    for (const value of [0, 1.5]) {
      expect(() => decodeStartInput({ ...input, issueNumber: value })).toThrow();
      expect(() => decodeListInput({ projectId: input.projectId, page: value })).toThrow();
    }
  });

  it("has no start shape that skips the reviewed issue revision", () => {
    const { expectedIssueRevision: _reviewed, ...unreviewed } = input;
    expect(() => decodeStartInput(unreviewed)).toThrow();
    for (const value of [null, "", "   "]) {
      expect(() => decodeStartInput({ ...input, expectedIssueRevision: value })).toThrow();
    }
  });
});
