import { FACTORY_DELIVERY_BODY_MAX_CHARS } from "@t3tools/contracts";

export const artifactDeliveryMarker = (acceptanceId: string, artifactSha256: string) =>
  `<!-- t3-factory-delivery acceptance=${acceptanceId} sha256=${artifactSha256} -->`;

/** Null when the rendered comment would exceed what one comment holds; never truncated. */
export const renderArtifactComment = (input: {
  readonly briefTitle: string;
  readonly deliverablePath: string;
  readonly text: string;
  readonly artifactSha256: string;
  readonly acceptanceId: string;
}): string | null => {
  // A title may contain newlines, but must not create additional heading or footer lines.
  const title = input.briefTitle.replace(/[\r\n]+/g, " ");
  const body = `# ${title}\n\n${input.text}\n\n---\n_Delivered by T3 Factory from brief “${title}” · ${input.deliverablePath} · sha256 ${input.artifactSha256} · acceptance ${input.acceptanceId}_\n${artifactDeliveryMarker(input.acceptanceId, input.artifactSha256)}`;
  return body.length > FACTORY_DELIVERY_BODY_MAX_CHARS ? null : body;
};
