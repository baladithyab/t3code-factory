import { Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";

import { isElectron } from "../../env";
import { SettingsScopeProvider, useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsScopeSentence } from "../settings/SettingsScopeSentence";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export function FactoryPage() {
  const search = useSearch({ from: "/_chat/factory" });
  const navigate = useNavigate({ from: "/factory" });
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={search}
      onChange={(next) => {
        void navigate({
          to: pathname,
          search: (previous) => ({
            ...previous,
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
            taskId: undefined,
          }),
          replace: true,
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <WorkspacePageHeader electron={isElectron}>
            <FactoryIcon aria-hidden className="size-4 text-muted-foreground" />
            <h1 className="truncate font-medium text-sm">Factory</h1>
          </WorkspacePageHeader>
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="wide">
              <SettingsScopeSentence leadIn="Showing work for" />
              <FactoryScopedContent />
            </WorkspacePageContainer>
          </ScrollArea>
        </div>
      </SidebarInset>
    </SettingsScopeProvider>
  );
}

function FactoryScopedContent() {
  const { scope, selectScope } = useSettingsScope();
  if (scope.kind === "unavailable") {
    return (
      <Alert variant="error">
        <AlertTitle>Scope unavailable</AlertTitle>
        <AlertDescription>
          <p>{scope.message}</p>
          <Button size="sm" variant="outline" onClick={() => selectScope({})}>
            Show all projects
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <Outlet />;
}
