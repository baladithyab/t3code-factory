import { FACTORY_DELIVERY_BODY_MAX_CHARS } from "@t3tools/contracts";

export const artifactDeliveryMarker = (attempt: string) =>
  `<!-- t3-factory-delivery attempt=${attempt} -->`;

/**
 * Null when the rendered comment would exceed what one comment holds; never truncated. The marker
 * sits between the text and the footer: an artifact whose last line opens an HTML comment would
 * otherwise swallow the footer up to the first `-->`, and the marker line is that `-->`.
 */
export const renderArtifactComment = (input: {
  readonly briefTitle: string;
  readonly deliverablePath: string;
  readonly text: string;
  readonly artifactSha256: string;
  readonly acceptanceId: string;
  readonly attempt: string;
}): string | null => {
  // A title may contain newlines, but must not create additional heading or footer lines.
  const title = input.briefTitle.replace(/[\r\n]+/g, " ");
  const body = `# ${title}\n\n${input.text}\n\n${artifactDeliveryMarker(input.attempt)}\n\n---\n_Delivered by T3 Factory from brief “${title}” · ${input.deliverablePath} · sha256 ${input.artifactSha256} · acceptance ${input.acceptanceId}_`;
  return body.length > FACTORY_DELIVERY_BODY_MAX_CHARS ? null : body;
};

/**
 * A comment is this delivery's when one of its lines is exactly the marker. The attempt token
 * makes the marker unguessable until the comment exists, so a copied token proves a comment with
 * these bytes was posted; matching only the line lets a person edit the rest of the comment
 * without turning the delivery into a lost one that a re-grant would post twice.
 */
export const carriesDeliveryMarker = (commentBody: string, deliveryBody: string) => {
  const marker = deliveryBody
    .split(/\r?\n/)
    .find((line) => /^<!-- t3-factory-delivery attempt=\S+ -->$/.test(line.trimEnd()));
  return marker !== undefined && commentBody.split(/\r?\n/).some((line) => line.trim() === marker);
};
