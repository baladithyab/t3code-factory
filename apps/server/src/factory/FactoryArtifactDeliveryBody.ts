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
  // Keep user-controlled metadata on one line so only the appended marker can end the body.
  const title = input.briefTitle.replace(/[\r\n]+/g, " ");
  const path = input.deliverablePath.replace(/[\r\n]+/g, " ");
  const body = `# ${title}\n\n${input.text}\n\n${artifactDeliveryMarker(input.attempt)}\n\n---\n_Delivered by T3 Factory from brief “${title}” · ${path} · sha256 ${input.artifactSha256} · acceptance ${input.acceptanceId}_`;
  return body.length > FACTORY_DELIVERY_BODY_MAX_CHARS ? null : body;
};

/**
 * Match this attempt's marker without requiring the original body: a maintainer's edit must not
 * turn a posted delivery into a lost one that a new grant would post twice.
 */
export const carriesDeliveryMarker = (commentBody: string, deliveryBody: string) => {
  // Artifact text may quote older public markers; the server appends this attempt's marker last.
  const marker = deliveryBody
    .split(/\r?\n/)
    .findLast((line) => /^<!-- t3-factory-delivery attempt=\S+ -->$/.test(line.trimEnd()));
  return marker !== undefined && commentBody.split(/\r?\n/).some((line) => line.trim() === marker);
};
