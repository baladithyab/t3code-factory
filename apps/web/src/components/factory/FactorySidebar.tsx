import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { Link, useLocation } from "@tanstack/react-router";
import {
  BotIcon,
  CalendarClockIcon,
  FolderGit2Icon,
  GlobeIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  RssIcon,
  SquarePenIcon,
} from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironments } from "../../state/environments";
import { useFactoryFeedsSupported } from "../../state/factory";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { resolveSettingsScope, type SettingsScopeSearch } from "../settings/settingsScope";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import {
  factoryScopeSearchForMember,
  singleFactoryMember,
  validateFactorySearch,
} from "./factoryScope";

const FACTORY_SECTIONS = [
  { to: "/factory", label: "Overview", icon: LayoutDashboardIcon },
  { to: "/factory/issues", label: "Issues", icon: ListTodoIcon },
  { to: "/factory/sources", label: "Sources", icon: RssIcon },
  { to: "/factory/workflows", label: "Workflows", icon: CalendarClockIcon },
  { to: "/factory/orchestrator", label: "Orchestrator", icon: BotIcon },
] as const;

export function FactorySidebar() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const rawSearch = useLocation({ select: (location) => location.search });
  const search = validateFactorySearch(rawSearch);
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const scope = resolveSettingsScope(search, groups, environments);
  const member = singleFactoryMember(scope);
  const newThread = useNewThreadHandler();
  const feedsSupported = useFactoryFeedsSupported();
  const { isMobile, setOpenMobile } = useSidebar();
  const section =
    FACTORY_SECTIONS.find(
      (candidate) =>
        candidate.to === pathname || (candidate.to === "/factory" && pathname === "/factory/"),
    ) ?? FACTORY_SECTIONS[0];
  // An older server omits the capability; its Sources page would be a dead end.
  const visibleSections = feedsSupported
    ? FACTORY_SECTIONS
    : FACTORY_SECTIONS.filter(({ to }) => to !== "/factory/sources");
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const sectionSearch = {
    project: search.project,
    machine: search.machine,
    checkout: search.checkout,
    state: search.state,
    view: search.view,
  };
  const scopedSearch = (next: SettingsScopeSearch) => ({
    ...next,
    state: search.state,
    view: search.view,
  });
  const visibleGroups =
    scope.kind === "unavailable"
      ? []
      : groups.filter((group) =>
          group.memberProjects.some(
            (candidate) =>
              (search.machine === undefined || candidate.environmentId === search.machine) &&
              (search.project === undefined || group.projectKey === search.project),
          ),
        );

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        fixedHeader={
          <SidebarGroup>
            <SidebarMenu aria-label="Factory sections">
              {visibleSections.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    isActive={section.to === to}
                    aria-current={section.to === to ? "page" : undefined}
                    render={<Link to={to} search={sectionSearch} />}
                    onClick={closeMobileSidebar}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => {
                    closeMobileSidebar();
                    if (member) {
                      void newThread(scopeProjectRef(member.environmentId, member.id));
                    } else {
                      openCommandPalette({
                        open: groups.length > 0 ? "new-thread-in" : "add-project",
                      });
                    }
                  }}
                >
                  <SquarePenIcon />
                  <span>New thread</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <h2 className="px-2 py-1.5 text-xs font-medium text-sidebar-muted-foreground">
            Project context
          </h2>
          <p className="px-2 pb-2 text-xs text-sidebar-muted-foreground">{scope.label}</p>
          {scope.kind === "unavailable" ? (
            <p role="status" className="px-2 pb-2 text-xs text-destructive">
              {scope.message}
            </p>
          ) : null}
          <SidebarMenu aria-label="Factory project scope">
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={scope.kind === "all"}
                render={<Link to={section.to} search={scopedSearch({})} />}
                onClick={closeMobileSidebar}
              >
                <GlobeIcon />
                <span>All projects and environments</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {visibleGroups.map((group) => (
              <SidebarMenuItem key={group.projectKey}>
                <SidebarMenuButton
                  isActive={scope.kind === "project" && scope.group.projectKey === group.projectKey}
                  render={
                    <Link
                      to={section.to}
                      search={scopedSearch({ project: group.projectKey, machine: search.machine })}
                    />
                  }
                  onClick={closeMobileSidebar}
                >
                  <FolderGit2Icon />
                  <span>{group.displayName}</span>
                </SidebarMenuButton>
                <div className="pl-3">
                  <SidebarMenu aria-label={`${group.displayName} checkouts`}>
                    {group.memberProjects
                      .filter(
                        (candidate) =>
                          search.machine === undefined ||
                          candidate.environmentId === search.machine,
                      )
                      .map((candidate) => (
                        <SidebarMenuItem key={candidate.physicalProjectKey}>
                          <SidebarMenuButton
                            size="lg"
                            isActive={member?.physicalProjectKey === candidate.physicalProjectKey}
                            aria-label={`${group.displayName}, ${candidate.environmentLabel ?? candidate.environmentId}, ${candidate.workspaceRoot}`}
                            title={candidate.workspaceRoot}
                            render={
                              <Link
                                to={section.to}
                                search={scopedSearch(factoryScopeSearchForMember(candidate, group))}
                              />
                            }
                            onClick={closeMobileSidebar}
                          >
                            <span className="min-w-0">
                              <span className="block truncate">
                                {candidate.environmentLabel ?? candidate.environmentId}
                              </span>
                              <span className="block truncate text-xs text-sidebar-muted-foreground">
                                {candidate.workspaceRoot}
                              </span>
                            </span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                  </SidebarMenu>
                </div>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {scope.kind !== "unavailable" && visibleGroups.length === 0 ? (
            <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
              No projects in this scope. Add a project from Sessions to get started.
            </p>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
