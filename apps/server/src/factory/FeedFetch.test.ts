import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { FactoryFeedSourceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Feed from "./FeedFetch.ts";

const source = { id: FactoryFeedSourceId.make("feed"), locator: "https://news.example.org/feed" };
const validators = { etag: null, lastModified: null };
const atom = (entries: string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title>${entries}</feed>`;
const fixture = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  Feed.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
  );

it.effect.each([
  ["http://example.org/feed", "invalid-url"],
  ["https://u:p@example.org/feed", "invalid-url"],
  ["https://localhost/feed", "unsafe-host"],
  ["https://127.1/feed", "unsafe-host"],
  ["https://10.0.0.1/feed", "unsafe-host"],
  ["https://169.254.169.254/feed", "unsafe-host"],
  ["https://[::ffff:127.0.0.1]/feed", "unsafe-host"],
  ["https://[fe80::1]/feed", "unsafe-host"],
] as const)("refuses %s before HTTP", ([locator, reason]) =>
  Effect.gen(function* () {
    const fetcher = yield* Feed.FeedFetch;
    assert.equal(
      (yield* fetcher.fetch({ ...source, locator }, validators).pipe(Effect.flip)).reason,
      reason,
    );
  }).pipe(
    Effect.provide(
      fixture(() => {
        throw new Error("Unexpected HTTP");
      }),
    ),
  ),
);

it.effect(
  "follows three validated redirects without rewriting the locator or forwarding credentials",
  () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const fetcher = yield* Feed.FeedFetch;
      assert.equal(
        (yield* fetcher.fetch(source, { etag: '"v1"', lastModified: "yesterday" })).kind,
        "observed",
      );
      assert.equal(requests.length, 4);
      assert.equal(source.locator, "https://news.example.org/feed");
    }).pipe(
      Effect.provide(
        fixture((request) => {
          requests.push(request.url);
          assert.isUndefined(request.headers.authorization);
          assert.isUndefined(request.headers.cookie);
          assert.equal(request.headers["if-none-match"], '"v1"');
          assert.equal(request.headers["if-modified-since"], "yesterday");
          return requests.length < 4
            ? new Response(null, { status: 302, headers: { location: `/hop${requests.length}` } })
            : new Response(atom(""));
        }),
      ),
    );
  },
);
it.effect("refuses a fourth redirect", () =>
  Effect.gen(function* () {
    const fetcher = yield* Feed.FeedFetch;
    assert.equal(
      (yield* fetcher.fetch(source, validators).pipe(Effect.flip)).reason,
      "feed-unavailable",
    );
  }).pipe(
    Effect.provide(
      fixture(() => new Response(null, { status: 302, headers: { location: "/again" } })),
    ),
  ),
);
it.effect("revalidates redirect hosts", () =>
  Effect.gen(function* () {
    const fetcher = yield* Feed.FeedFetch;
    assert.equal(
      (yield* fetcher.fetch(source, validators).pipe(Effect.flip)).reason,
      "unsafe-host",
    );
  }).pipe(
    Effect.provide(
      fixture(
        () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/feed" } }),
      ),
    ),
  ),
);

it.effect.each(["<!DOCTYPE feed>", "<!ENTITY x 'secret'>"])(
  "rejects XML declarations %s",
  (declaration) =>
    Effect.gen(function* () {
      const fetcher = yield* Feed.FeedFetch;
      assert.equal(
        (yield* fetcher.fetch(source, validators).pipe(Effect.flip)).reason,
        "invalid-feed",
      );
    }).pipe(Effect.provide(fixture(() => new Response(`${declaration}${atom("")}`)))),
);
it.effect.each([true, false])("bounds body bytes with content-length=%s", (header) =>
  Effect.gen(function* () {
    const fetcher = yield* Feed.FeedFetch;
    assert.equal(
      (yield* fetcher.fetch(source, validators).pipe(Effect.flip)).reason,
      "feed-too-large",
    );
  }).pipe(
    Effect.provide(
      fixture(
        () =>
          new Response("x".repeat(2 * 1024 * 1024 + 1), {
            headers: header ? { "content-length": String(2 * 1024 * 1024 + 1) } : {},
          }),
      ),
    ),
  ),
);
it.effect("handles 304 without parsing a body", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* (yield* Feed.FeedFetch).fetch(source, validators), {
      kind: "notModified",
    });
  }).pipe(Effect.provide(fixture(() => new Response(null, { status: 304 })))),
);
it.effect.each([429, 503])("honours Retry-After for %s", (status) =>
  Effect.gen(function* () {
    const error = yield* (yield* Feed.FeedFetch).fetch(source, validators).pipe(Effect.flip);
    assert.equal(error.nextAllowedAt, "1970-01-01T00:02:00.000Z");
  }).pipe(
    Effect.provide(
      fixture(() => new Response(null, { status, headers: { "retry-after": "120" } })),
    ),
  ),
);
it.effect("extracts RSS verbatim content and key precedence", () =>
  Effect.gen(function* () {
    const result = yield* (yield* Feed.FeedFetch).fetch(source, validators);
    assert.equal(result.kind, "observed");
    if (result.kind !== "observed") return;
    assert.deepEqual(
      result.items.map((item) => item.itemKey),
      ["atom: exact id ", "guid:non-url", "link:https://news.example.org/a", "unreviewable:3"],
    );
    assert.equal(result.items[0]?.content, "<b>encoded & exact</b>");
    assert.equal(result.items[1]?.content, "description");
    assert.equal(result.items[3]?.disposition, "unreviewable");
  }).pipe(
    Effect.provide(
      fixture(
        () =>
          new Response(`<rss version="2.0" xmlns:a="http://www.w3.org/2005/Atom" xmlns:c="http://purl.org/rss/1.0/modules/content/"><channel><title>RSS</title>
<item><a:id> exact id </a:id><guid>ignored</guid><c:encoded><![CDATA[<b>encoded & exact</b>]]></c:encoded><description>ignored</description></item>
<item><guid isPermaLink="false">non-url</guid><description>description</description></item><item><link>/a</link></item><item><title>No key</title></item></channel></rss>`),
      ),
    ),
  ),
);
it.effect("extracts Atom inline XHTML, summary, tombstones and normalized forge references", () =>
  Effect.gen(function* () {
    const result = yield* (yield* Feed.FeedFetch).fetch(source, validators);
    if (result.kind !== "observed") return assert.fail("expected observed");
    assert.equal(
      result.items[0]?.content,
      '<div xmlns="http://www.w3.org/1999/xhtml"><b>raw</b></div>',
    );
    assert.deepEqual(result.items[0]?.forgeReference, {
      host: "github.com",
      repository: "owner/repo",
      issueNumber: 7,
    });
    assert.equal(result.items[1]?.content, "fallback & text");
    assert.equal(result.items[2]?.disposition, "retracted");
    assert.equal(result.items[2]?.itemKey, "atom:deleted");
  }).pipe(
    Effect.provide(
      fixture(
        () =>
          new Response(
            atom(
              `<entry><id>one</id><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><b>raw</b></div></content><link href="https://GITHUB.com/Owner/Repo/issues/7/?a=1#x"/></entry><entry><id>two</id><content src="https://private.local/secret"/><summary>fallback &amp; text</summary></entry><at:deleted-entry xmlns:at="http://purl.org/atompub/tombstones/1.0" ref="deleted"/>`,
            ),
          ),
      ),
    ),
  ),
);
it.effect("retains bounded previews but never admissible truncated content", () =>
  Effect.gen(function* () {
    const result = yield* (yield* Feed.FeedFetch).fetch(source, validators);
    if (result.kind !== "observed") return assert.fail("expected observed");
    assert.equal(result.items[0]?.title?.length, 1024);
    assert.equal(result.items[0]?.content, null);
    assert.equal(result.items[0]?.disposition, "unreviewable");
  }).pipe(
    Effect.provide(
      fixture(
        () =>
          new Response(
            atom(
              `<entry><id>big</id><title>${"t".repeat(1025)}</title><content>${"b".repeat(65537)}</content></entry>`,
            ),
          ),
      ),
    ),
  ),
);
it.effect("rejects documents with more than 200 items", () =>
  Effect.gen(function* () {
    assert.equal(
      (yield* (yield* Feed.FeedFetch).fetch(source, validators).pipe(Effect.flip)).reason,
      "invalid-feed",
    );
  }).pipe(
    Effect.provide(
      fixture(
        () =>
          new Response(
            atom(Array.from({ length: 201 }, (_, i) => `<entry><id>${i}</id></entry>`).join("")),
          ),
      ),
    ),
  ),
);

it.effect("revision digest preserves null, empty text, markup and exact item identity", () =>
  Effect.gen(function* () {
    const result = yield* (yield* Feed.FeedFetch).fetch(source, validators);
    if (result.kind !== "observed") return assert.fail("expected observed");
    const item = result.items[0];
    assert.isDefined(item);
    assert.equal(
      item?.revision,
      "05b9d79a93779cb47b96f93355d69732f23cdf0e7f67ebe45298fc3148f4b278",
    );
  }).pipe(
    Effect.provide(
      fixture(
        () =>
          new Response(
            atom("<entry><id> X </id><title/><content><![CDATA[<b>text</b>]]></content></entry>"),
          ),
      ),
    ),
  ),
);

it.effect("times out the whole fetch after 15 seconds", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const client = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const fetcher = yield* Feed.FeedFetch.pipe(
      Effect.provide(
        Feed.layer.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
    const fiber = yield* fetcher.fetch(source, validators).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("15 seconds");
    assert.equal((yield* Fiber.join(fiber)).reason, "feed-unavailable");
  }),
);

it("normalizes encoded forge issue paths without their query, fragment or trailing slash", () => {
  assert.deepEqual(Feed.forgeReference("https://GitHub.com/%6fwner/Repo/%69ssues/7/?view=1#body"), {
    host: "github.com",
    repository: "owner/repo",
    issueNumber: 7,
  });
});
