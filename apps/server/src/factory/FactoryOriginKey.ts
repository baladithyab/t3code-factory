import { FactoryOriginKey, type SourceControlProviderKind } from "@t3tools/contracts";

// Escape the escape marker too, so literal percent sequences cannot impersonate delimiters.
const component = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("|", "%7C").replaceAll("#", "%23").replaceAll(":", "%3A");

// The provider kind is the namespace, so `github:` keys stay byte-identical to the rows written
// before other forges existed. The canonical key already carries the host, so two forges never
// produce the same key for different issues.
export const issueOriginKey = (
  provider: SourceControlProviderKind,
  canonicalKey: string,
  number: number,
): FactoryOriginKey => FactoryOriginKey.make(`${provider}:${component(canonicalKey)}#${number}`);

export const feedItemOriginKey = (
  canonicalKey: string,
  locator: string,
  itemKey: string,
): FactoryOriginKey =>
  FactoryOriginKey.make(
    `feed:${component(canonicalKey)}|${component(locator)}|${component(itemKey)}`,
  );

export const researchRunOriginKey = (protocolId: string, role: string): FactoryOriginKey =>
  FactoryOriginKey.make(`research:${component(protocolId)}:${component(role)}`);

export const knowledgeBriefOriginKey = (briefId: string): FactoryOriginKey =>
  FactoryOriginKey.make(`knowledge:${component(briefId)}`);
