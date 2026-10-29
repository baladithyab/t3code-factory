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
 * Hosts normalize line endings and strip trailing whitespace when they store a comment, so the
 * body read back is compared on those terms, never by substring.
 */
export const sameCommentBody = (left: string, right: string) =>
  normalizeCommentBody(left) === normalizeCommentBody(right);

const normalizeCommentBody = (body: string) =>
  body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
