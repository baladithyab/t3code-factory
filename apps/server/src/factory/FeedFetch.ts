import { parseXml, XmlElement } from "@rgrove/parse-xml";
import {
  FACTORY_FEED_CONTENT_MAX_CHARS,
  FACTORY_FEED_TITLE_MAX_CHARS,
  FactoryFeedError,
  type FactoryFeedForgeReference,
  type FactoryFeedSourceId,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { Observation } from "../persistence/FactoryFeedStore.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const ATOM = "http://www.w3.org/2005/Atom";
const TOMBSTONE = "http://purl.org/atompub/tombstones/1.0";
const CONTENT = "http://purl.org/rss/1.0/modules/content/";
export class FeedFetchError extends Schema.TaggedError<FeedFetchError>()("FeedFetchError", {
  reason: Schema.Literals([
    "invalid-url",
    "unsafe-host",
    "feed-unavailable",
    "feed-too-large",
    "invalid-feed",
  ]),
  nextAllowedAt: Schema.optional(Schema.String),
  suspend: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}
const isFetchError = Schema.is(FeedFetchError);
const isFeedError = Schema.is(FactoryFeedError);
type Result =
  | { readonly kind: "notModified" }
  | {
      readonly kind: "observed";
      readonly title: string | null;
      readonly items: readonly Observation[];
      readonly etag: string | null;
      readonly lastModified: string | null;
    };
export class FeedFetch extends Context.Service<
  FeedFetch,
  {
    readonly fetch: (
      source: { readonly id: FactoryFeedSourceId; readonly locator: string },
      validators: { readonly etag: string | null; readonly lastModified: string | null },
    ) => Effect.Effect<Result, FeedFetchError>;
  }
>()("t3/factory/FeedFetch") {}

export const validateLocator = Effect.fn("FeedFetch.validateLocator")((locator: string) =>
  Effect.try({
    try: () => {
      const url = new URL(locator);
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
        throw new FactoryFeedError({ reason: "invalid-url" });
      // Host-string checks do not close DNS rebinding between validation and connect.
      if (isLocalLoopbackHost(url.hostname) || isPrivateNetworkHost(url.hostname))
        throw new FactoryFeedError({ reason: "unsafe-host" });
      return url;
    },
    catch: (cause) =>
      isFeedError(cause) ? cause : new FactoryFeedError({ reason: "invalid-url", cause }),
  }),
);

function namespace(element: XmlElement): string {
  const colon = element.name.indexOf(":");
  const key = colon < 0 ? "xmlns" : `xmlns:${element.name.slice(0, colon)}`;
  let current: XmlElement | null = element;
  while (current !== null) {
    if (current.attributes[key] !== undefined) return current.attributes[key];
    current = current.parent instanceof XmlElement ? current.parent : null;
  }
  return "";
}
const named = (element: XmlElement, name: string, ns: string) =>
  element.name.split(":").at(-1) === name && namespace(element) === ns;
const children = (element: XmlElement, name: string, ns: string) =>
  element.children.filter(
    (child): child is XmlElement => child instanceof XmlElement && named(child, name, ns),
  );
const child = (element: XmlElement, name: string, ns: string) => children(element, name, ns)[0];
function text(element: XmlElement | undefined, xml: string): string | null {
  if (element === undefined) return null;
  // Keep inline XHTML and other markup visible; .text alone would silently strip it.
  return element.children
    .map((node) =>
      node instanceof XmlElement || node.type === "comment" || node.type === "pi"
        ? xml.slice(node.start, node.end)
        : "text" in node
          ? node.text
          : "",
    )
    .join("");
}
function absolute(value: string | null, element: XmlElement, locator: string): string | null {
  if (value === null || value.trim() === "") return null;
  const ancestors: XmlElement[] = [];
  let current: XmlElement | null = element;
  while (current !== null) {
    ancestors.push(current);
    current = current.parent instanceof XmlElement ? current.parent : null;
  }
  try {
    let base = locator;
    for (let ancestor = ancestors.pop(); ancestor !== undefined; ancestor = ancestors.pop()) {
      const xmlBase = ancestor.attributes["xml:base"];
      if (xmlBase !== undefined) base = new URL(xmlBase, base).href;
    }
    return new URL(value, base).href;
  } catch {
    return null;
  }
}
export function forgeReference(value: string | null): FactoryFeedForgeReference | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "")
      return null;
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/.exec(
      decodeURIComponent(url.pathname),
    );
    if (match === null) return null;
    const [, owner, repo, number] = match;
    if (!owner || !repo || !number || !Number.isSafeInteger(Number(number))) return null;
    return {
      host: url.hostname.toLowerCase(),
      repository: `${owner}/${repo}`.toLowerCase(),
      issueNumber: Number(number),
    };
  } catch {
    return null;
  }
}
function published(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DateTime.formatIso(DateTime.makeUnsafe(timestamp)) : null;
}
function parse(xml: string, locator: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new FeedFetchError({ reason: "invalid-feed" });
  const root = parseXml(xml, { includeOffsets: true, preserveComments: true }).root;
  if (root === null) throw new FeedFetchError({ reason: "invalid-feed" });
  const atom = named(root, "feed", ATOM);
  const channel = atom
    ? root
    : named(root, "rss", "") && root.attributes.version === "2.0"
      ? child(root, "channel", "")
      : undefined;
  if (channel === undefined) throw new FeedFetchError({ reason: "invalid-feed" });
  const entries = channel.children.filter(
    (node): node is XmlElement =>
      node instanceof XmlElement &&
      (named(node, atom ? "entry" : "item", atom ? ATOM : "") ||
        named(node, "deleted-entry", TOMBSTONE)),
  );
  if (entries.length > 200) throw new FeedFetchError({ reason: "invalid-feed" });
  const items = entries.map((entry, index) => {
    if (named(entry, "deleted-entry", TOMBSTONE)) {
      const ref = entry.attributes.ref;
      if (!ref) throw new FeedFetchError({ reason: "invalid-feed" });
      return {
        itemKey: `atom:${ref}`,
        title: null,
        content: null,
        link: null,
        publishedAt: null,
        forgeReference: forgeReference(ref),
        disposition: "retracted" as const,
      };
    }
    const ns = atom ? ATOM : "";
    const id = child(entry, "id", ATOM)?.text ?? null;
    const guid = child(entry, "guid", "")?.text ?? null;
    const linkElement = atom
      ? children(entry, "link", ATOM).find(
          (link) => (link.attributes.rel ?? "alternate") === "alternate",
        )
      : child(entry, "link", "");
    const link = absolute(
      atom ? (linkElement?.attributes.href ?? null) : (linkElement?.text ?? null),
      linkElement ?? entry,
      locator,
    );
    const itemKey =
      id !== null && id !== ""
        ? `atom:${id}`
        : guid !== null && guid !== ""
          ? `guid:${guid}`
          : link !== null
            ? `link:${link}`
            : null;
    const title = text(child(entry, "title", ns), xml);
    const inline = child(entry, "content", ATOM);
    const content = atom
      ? text(
          inline !== undefined && inline.attributes.src === undefined
            ? inline
            : child(entry, "summary", ATOM),
          xml,
        )
      : text(child(entry, "encoded", CONTENT) ?? child(entry, "description", ""), xml);
    return {
      itemKey: itemKey ?? `unreviewable:${index}`,
      title,
      content,
      link,
      publishedAt: published(child(entry, atom ? "published" : "pubDate", ns)?.text ?? null),
      forgeReference: forgeReference(link) ?? forgeReference(id) ?? forgeReference(guid),
      disposition:
        itemKey === null ||
        (title?.length ?? 0) > FACTORY_FEED_TITLE_MAX_CHARS ||
        (content?.length ?? 0) > FACTORY_FEED_CONTENT_MAX_CHARS
          ? ("unreviewable" as const)
          : ("open" as const),
    };
  });
  if (new Set(items.map((item) => item.itemKey)).size !== items.length)
    throw new FeedFetchError({ reason: "invalid-feed" });
  return {
    title:
      text(child(channel, "title", atom ? ATOM : ""), xml)?.slice(
        0,
        FACTORY_FEED_TITLE_MAX_CHARS,
      ) ?? null,
    items,
  };
}

const make = Effect.gen(function* () {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const crypto = yield* Crypto.Crypto;
  const fetch = Effect.fn("FeedFetch.fetch")(
    function* (
      source: { readonly id: FactoryFeedSourceId; readonly locator: string },
      validators: { readonly etag: string | null; readonly lastModified: string | null },
    ) {
      let target = source.locator;
      for (let hop = 0; ; hop += 1) {
        yield* validateLocator(target).pipe(
          Effect.mapError(
            (error) =>
              new FeedFetchError({
                reason: error.reason === "unsafe-host" ? "unsafe-host" : "invalid-url",
                cause: error,
              }),
          ),
        );
        const response = yield* client
          .execute(
            HttpClientRequest.get(target).pipe(
              HttpClientRequest.setHeaders({
                accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
                ...(validators.etag === null ? {} : { "if-none-match": validators.etag }),
                ...(validators.lastModified === null
                  ? {}
                  : { "if-modified-since": validators.lastModified }),
              }),
            ),
          )
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {
              redirect: "manual",
              credentials: "omit",
            }),
            Effect.mapError((cause) => new FeedFetchError({ reason: "feed-unavailable", cause })),
          );
        if (response.status === 304) return { kind: "notModified" as const };
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (hop >= 3 || response.headers.location === undefined)
            return yield* new FeedFetchError({ reason: "feed-unavailable" });
          target = yield* Effect.try({
            try: () => new URL(response.headers.location!, target).href,
            catch: (cause) => new FeedFetchError({ reason: "invalid-url", cause }),
          });
          continue;
        }
        if (response.status !== 200) {
          const now = yield* Clock.currentTimeMillis;
          const retry = response.headers["retry-after"];
          const retryAt =
            retry === undefined
              ? NaN
              : /^\d+$/.test(retry.trim())
                ? now + Number(retry) * 1000
                : Date.parse(retry);
          return yield* new FeedFetchError({
            reason: "feed-unavailable",
            suspend: response.status === 404 || response.status === 410,
            ...([429, 503].includes(response.status) &&
            Number.isFinite(retryAt) &&
            retryAt <= 8.64e15
              ? {
                  nextAllowedAt: DateTime.formatIso(
                    DateTime.makeUnsafe(Math.max(now + 60_000, retryAt)),
                  ),
                }
              : {}),
          });
        }
        if (Number(response.headers["content-length"]) > MAX_BYTES)
          return yield* new FeedFetchError({ reason: "feed-too-large" });
        let bytes = 0;
        let body = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        yield* Stream.runForEach(response.stream, (chunk) =>
          Effect.gen(function* () {
            bytes += chunk.byteLength;
            if (bytes > MAX_BYTES) return yield* new FeedFetchError({ reason: "feed-too-large" });
            body += yield* Effect.try({
              try: () => decoder.decode(chunk, { stream: true }),
              catch: (cause) => new FeedFetchError({ reason: "invalid-feed", cause }),
            });
          }),
        ).pipe(
          Effect.mapError((cause) =>
            isFetchError(cause) ? cause : new FeedFetchError({ reason: "feed-unavailable", cause }),
          ),
        );
        const document = yield* Effect.try({
          try: () => parse(body + decoder.decode(), target),
          catch: (cause) =>
            isFetchError(cause) ? cause : new FeedFetchError({ reason: "invalid-feed", cause }),
        });
        const items = yield* Effect.forEach(document.items, (item) =>
          crypto
            .digest(
              "SHA-256",
              new TextEncoder().encode(
                JSON.stringify([
                  "t3.factory.feed-item-content/1",
                  source.id,
                  item.itemKey,
                  item.title,
                  item.content,
                  item.link,
                ]),
              ),
            )
            .pipe(
              Effect.orDie,
              Effect.map((digest): Observation => ({
                ...item,
                revision: Hex.encode(digest),
                title:
                  item.disposition === "unreviewable"
                    ? (item.title?.slice(0, FACTORY_FEED_TITLE_MAX_CHARS) ?? null)
                    : item.title,
                content: item.disposition === "unreviewable" ? null : item.content,
              })),
            ),
        );
        return {
          kind: "observed" as const,
          ...document,
          items,
          etag: response.headers.etag ?? null,
          lastModified: response.headers["last-modified"] ?? null,
        };
      }
    },
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      isFetchError(cause) ? cause : new FeedFetchError({ reason: "feed-unavailable", cause }),
    ),
  );
  return FeedFetch.of({ fetch });
});
export const layer = Layer.effect(FeedFetch, make);
