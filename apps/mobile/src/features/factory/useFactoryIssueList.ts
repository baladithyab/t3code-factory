import { RegistryContext } from "@effect/atom-react";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { use, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { factoryEnvironment } from "../../state/factory";
import {
  applyFactoryIssuePage,
  EMPTY_FACTORY_ISSUE_PAGES,
  type FactoryIssueFilter,
  type FactoryIssuePages,
} from "./factoryIssues";

type ListPhase = "idle" | "loading" | "refreshing" | "loadingMore";

interface ListState {
  /** The request identity these pages belong to; stale state is never shown for another one. */
  readonly key: string | null;
  readonly pages: FactoryIssuePages;
  readonly phase: ListPhase;
  /** Set when the first page failed; nothing trustworthy is on screen. */
  readonly error: unknown;
  /** Set when a later page failed; the pages already loaded stay usable. */
  readonly loadMoreError: unknown;
  readonly loaded: boolean;
}

const IDLE_STATE: ListState = {
  key: null,
  pages: EMPTY_FACTORY_ISSUE_PAGES,
  phase: "idle",
  error: null,
  loadMoreError: null,
  loaded: false,
};

function emptyStateFor(key: string): ListState {
  return { ...IDLE_STATE, key };
}

/**
 * Loads one bounded server page at a time. Pagination follows the server's `nextPage`, and an
 * empty page can still have a next one, so "no rows" never means "no more". A `null` environment
 * or project (unsupported, offline, or not permitted) holds no data and makes no request.
 * Refreshing replaces the loaded pages with a fresh first page.
 */
export function useFactoryIssueList(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly filter: FactoryIssueFilter;
}) {
  const registry = use(RegistryContext);
  const { environmentId, projectId, filter } = input;
  const key =
    environmentId === null || projectId === null
      ? null
      : JSON.stringify([environmentId, projectId, filter]);
  const [state, setState] = useState<ListState>(IDLE_STATE);
  const activeRequest = useRef<{
    readonly key: string;
    readonly controller: AbortController;
  } | null>(null);
  const activeKey = useRef<string | null>(key);
  useLayoutEffect(() => {
    activeKey.current = key;
    return () => {
      activeKey.current = null;
    };
  }, [key]);

  const fetchPage = useCallback(
    async (page: number) => {
      if (environmentId === null || projectId === null || key === null || activeKey.current !== key)
        return;
      activeRequest.current?.controller.abort();
      const request = { key, controller: new AbortController() };
      activeRequest.current = request;
      const result = await executeAtomQuery(
        registry,
        factoryEnvironment.list({ environmentId, input: { projectId, state: filter, page } }),
        { refresh: true, reportFailure: false, signal: request.controller.signal },
      );
      // A newer request owns the screen now.
      if (activeKey.current !== key || activeRequest.current !== request) return;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        setState((current) =>
          page <= 1
            ? { ...emptyStateFor(key), error: failure }
            : { ...current, phase: "idle", loadMoreError: failure },
        );
        return;
      }
      setState((current) => ({
        key,
        pages: applyFactoryIssuePage(
          current.key === key ? current.pages : EMPTY_FACTORY_ISSUE_PAGES,
          page,
          result.value,
        ),
        phase: "idle",
        error: null,
        loadMoreError: null,
        loaded: true,
      }));
    },
    [environmentId, filter, key, projectId, registry],
  );

  useEffect(() => {
    if (key === null) {
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      return;
    }
    void fetchPage(1);
    return () => {
      activeRequest.current?.controller.abort();
    };
  }, [fetchPage, key]);

  const current = state.key === key && key !== null;
  const pages = current ? state.pages : EMPTY_FACTORY_ISSUE_PAGES;
  const phase: ListPhase = current ? state.phase : key === null ? "idle" : "loading";
  const nextPage = pages.nextPage;
  const loaded = current && state.loaded;

  const requestPage = useCallback(
    (page: number, phase: "refreshing" | "loadingMore") => {
      if (key === null || activeKey.current !== key) return Promise.resolve();
      setState((current) => ({
        ...(current.key === key ? current : emptyStateFor(key)),
        phase,
        ...(phase === "loadingMore" ? { loadMoreError: null } : { error: null }),
      }));
      return fetchPage(page);
    },
    [fetchPage, key],
  );

  const refresh = useCallback(() => requestPage(1, "refreshing"), [requestPage]);
  const loadMore = useCallback(() => {
    if (nextPage === null) return Promise.resolve();
    return requestPage(nextPage, "loadingMore");
  }, [requestPage, nextPage]);

  return {
    requestKey: key,
    repository: pages.repository,
    capabilities: pages.capabilities,
    issues: pages.issues,
    fetchedAt: pages.fetchedAt,
    hasMore: nextPage !== null,
    // Only a first-page request with nothing to show is a blocking load.
    loading: phase === "loading" || (phase === "refreshing" && !loaded),
    refreshing: phase === "refreshing" && loaded,
    loadingMore: phase === "loadingMore",
    error: current ? state.error : null,
    loadMoreError: current ? state.loadMoreError : null,
    loaded,
    refresh,
    loadMore,
  };
}
