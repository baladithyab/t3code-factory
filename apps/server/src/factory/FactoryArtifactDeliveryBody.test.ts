import { assert, it } from "@effect/vitest";
import { FACTORY_DELIVERY_BODY_MAX_CHARS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  artifactDeliveryMarker,
  renderArtifactComment,
  carriesDeliveryMarker,
} from "./FactoryArtifactDeliveryBody.ts";

const input = {
  briefTitle: "Protocol survey",
  deliverablePath: "out/DELIVERABLE.md",
  text: "## Findings\n\n**Markdown** stays intact.\n",
  artifactSha256: "a".repeat(64),
  acceptanceId: "knowledge-acceptance:one",
  attempt: "attempt-one",
};

it.effect(
  "renders the accepted markdown verbatim with the marker between the text and the provenance footer",
  () =>
    Effect.sync(() => {
      const marker = `<!-- t3-factory-delivery attempt=${input.attempt} -->`;
      const expected = `# Protocol survey\n\n${input.text}\n\n${marker}\n\n---\n_Delivered by T3 Factory from brief “Protocol survey” · out/DELIVERABLE.md · sha256 ${input.artifactSha256} · acceptance ${input.acceptanceId}_`;
      assert.equal(renderArtifactComment(input), expected);
      assert.equal(renderArtifactComment(input), renderArtifactComment(input));
      assert.equal(artifactDeliveryMarker(input.attempt), marker);
      assert.notEqual(
        renderArtifactComment({ ...input, attempt: "attempt-two" }),
        renderArtifactComment(input),
      );
      assert.equal(
        renderArtifactComment({ ...input, briefTitle: "One\r\nTwo" })!.split("\n")[0],
        "# One Two",
      );
    }),
);

it.effect("an artifact ending in an open HTML comment cannot hide the footer", () =>
  Effect.sync(() => {
    const body = renderArtifactComment({ ...input, text: "last line <!--" })!;
    const lines = body.split("\n");
    const markerLine = lines.indexOf(artifactDeliveryMarker(input.attempt));
    const footerRule = lines.indexOf("---");
    assert.isAbove(markerLine, 0);
    assert.include(lines[markerLine]!, "-->");
    assert.isAbove(footerRule, markerLine);
    assert.isTrue(lines.at(-1)!.startsWith("_Delivered by T3 Factory"));
  }),
);

it.effect("carriesDeliveryMarker matches the marker line and tolerates edits around it", () =>
  Effect.sync(() => {
    const body = renderArtifactComment(input)!;
    const marker = artifactDeliveryMarker(input.attempt);
    assert.isTrue(carriesDeliveryMarker(body, body));
    assert.isTrue(carriesDeliveryMarker(body.replaceAll("\n", "\r\n"), body));
    assert.isTrue(carriesDeliveryMarker(`${body}\n\nEdited by a maintainer.`, body));
    assert.isTrue(carriesDeliveryMarker(body.replace("Findings", "Findingz"), body));
    assert.isTrue(carriesDeliveryMarker(`  ${marker}  `, body));
    assert.isFalse(carriesDeliveryMarker(`quoting: ${marker}`, body));
    assert.isFalse(carriesDeliveryMarker(body.replace(marker, "<!-- removed -->"), body));
    assert.isFalse(
      carriesDeliveryMarker(body, renderArtifactComment({ ...input, attempt: "other" })!),
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
