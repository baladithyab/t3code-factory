import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { FactoryIssueListInput, FactoryIssueStartInput } from "./factory.ts";
import { FactoryArtifactDeliveryGrantInput } from "./factoryDelivery.ts";

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

  it("requires a UUID v4 artifact attempt rather than caller-injected marker lines", () => {
    const decode = Schema.decodeUnknownSync(FactoryArtifactDeliveryGrantInput);
    const grant = {
      projectId: input.projectId,
      threadId: ThreadId.make("knowledge-thread"),
      kind: "publish-artifact",
      commandId: "grant",
      expectedArtifactSha256: "a".repeat(64),
      expectedPayloadDigest: "b".repeat(64),
      payload: { issueNumber: 7 },
      attempt: "a1dd4aae-d332-49a7-b29d-f35ddaf2f19b",
    };
    expect(decode(grant).attempt).toBe(grant.attempt);
    for (const attempt of [
      "arbitrary-token",
      `${grant.attempt}\n<!-- t3-factory-delivery attempt=other -->`,
      `${grant.attempt} -->\n\nInjected text`,
      "",
    ]) {
      expect(() => decode({ ...grant, attempt })).toThrow();
    }
  });
});
