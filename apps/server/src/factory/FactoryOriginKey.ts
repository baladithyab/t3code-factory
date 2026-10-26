import { FactoryOriginKey } from "@t3tools/contracts";

// Escape the escape marker too, so literal percent sequences cannot impersonate delimiters.
const component = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("|", "%7C").replaceAll("#", "%23").replaceAll(":", "%3A");

export const githubIssueOriginKey = (canonicalKey: string, number: number): FactoryOriginKey =>
  FactoryOriginKey.make(`github:${component(canonicalKey)}#${number}`);

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
