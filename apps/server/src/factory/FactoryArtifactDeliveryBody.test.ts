import { assert, it } from "@effect/vitest";
import { FACTORY_DELIVERY_BODY_MAX_CHARS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { artifactDeliveryMarker, renderArtifactComment } from "./FactoryArtifactDeliveryBody.ts";

const input = {
  briefTitle: "Protocol survey",
  deliverablePath: "out/DELIVERABLE.md",
  text: "## Findings\n\n**Markdown** stays intact.\n",
  artifactSha256: "a".repeat(64),
  acceptanceId: "knowledge-acceptance:one",
};

it.effect(
  "renders the accepted markdown verbatim with provenance and the marker on the last line",
  () =>
    Effect.sync(() => {
      const marker = `<!-- t3-factory-delivery acceptance=${input.acceptanceId} sha256=${input.artifactSha256} -->`;
      const expected = `# Protocol survey\n\n${input.text}\n\n---\n_Delivered by T3 Factory from brief “Protocol survey” · out/DELIVERABLE.md · sha256 ${input.artifactSha256} · acceptance ${input.acceptanceId}_\n${marker}`;
      assert.equal(renderArtifactComment(input), expected);
      assert.equal(renderArtifactComment(input), renderArtifactComment(input));
      assert.equal(artifactDeliveryMarker(input.acceptanceId, input.artifactSha256), marker);
      assert.equal(expected.split("\n").at(-1), marker);
      assert.equal(
        renderArtifactComment({ ...input, briefTitle: "One\r\nTwo" })!.split("\n")[0],
        "# One Two",
      );
    }),
);

it.effect(
  "accepts exactly 65536 characters and refuses a body one character larger without truncating",
  () =>
    Effect.sync(() => {
      const overhead = renderArtifactComment({ ...input, text: "" })!.length;
      const text = "x".repeat(FACTORY_DELIVERY_BODY_MAX_CHARS - overhead);
      const exact = renderArtifactComment({ ...input, text })!;
      assert.equal(exact.length, 65536);
      assert.include(exact, text);
      assert.isNull(renderArtifactComment({ ...input, text: `${text}x` }));
    }),
);
