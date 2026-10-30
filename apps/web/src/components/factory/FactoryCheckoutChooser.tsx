import { FactoryIcon } from "lucide-react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ResolvedSettingsScope, SettingsScopeSearch } from "../settings/settingsScope";
import { Button } from "../ui/button";
import { FactoryEmptyState } from "./FactoryEmptyState";
import { factoryScopeSearchForMember } from "./factoryScope";

export type FactoryAvailableScope = Exclude<ResolvedSettingsScope, { kind: "unavailable" }>;

/** Factory work belongs to one checkout; a broad scope only chooses one, never merges them. */
export function FactoryCheckoutChooser(props: {
  readonly scope: FactoryAvailableScope;
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly intro: string;
  readonly emptyDescription: string;
  readonly statusFor: (owner: EnvironmentPresentation | undefined) => string;
  readonly onChoose: (search: SettingsScopeSearch) => void;
}) {
  const { scope, environments } = props;
  const visibleGroups = props.groups.flatMap((group) => {
    const members = group.memberProjects.filter((candidate) =>
      scope.kind === "project" || scope.kind === "checkout"
        ? scope.members.some(
            (selected) => selected.physicalProjectKey === candidate.physicalProjectKey,
          )
        : scope.environmentIds.includes(candidate.environmentId),
    );
    return members.length > 0 ? [{ group, members }] : [];
  });

  return (
    <>
      <p className="text-muted-foreground text-sm">{props.intro}</p>
      {visibleGroups.length === 0 ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title="No checkouts in this scope"
          description={props.emptyDescription}
        />
      ) : (
        visibleGroups.map(({ group, members }) => (
          <section key={group.projectKey} className="space-y-2">
            <h3 className="font-medium text-sm">{group.displayName}</h3>
            <ul className="divide-y rounded-lg border">
              {members.map((candidate) => {
                const owner = environments.find(
                  (item) => item.environmentId === candidate.environmentId,
                );
                return (
                  <li
                    key={candidate.physicalProjectKey}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium text-sm">
                        {owner?.label ?? candidate.environmentLabel ?? candidate.environmentId}
                      </p>
                      <p className="break-all text-muted-foreground text-xs">
                        {candidate.workspaceRoot}
                      </p>
                      <p className="text-muted-foreground text-xs">{props.statusFor(owner)}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => props.onChoose(factoryScopeSearchForMember(candidate, group))}
                    >
                      Choose checkout
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
