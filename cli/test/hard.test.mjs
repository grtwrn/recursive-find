import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { crawl, formatText, resolveOptions, robotsAllows, parseRobots, retryAfterMs } from "../scripts/crawl.mjs";
import { startHardFixture } from "./fixture-hard.mjs";

const RFIND = fileURLToPath(new URL("../scripts/rfind.mjs", import.meta.url));
let site;
before(async () => { site = await startHardFixture(); });
after(() => site.close());

const run = (path, query, opts = {}) => crawl({ url: site.url + path, query, ...opts });
const paths = (list) => list.map((h) => decodeURIComponent(new URL(h.url).pathname)).sort();

// --- encodings ---

test("decodes ISO-8859-1 declared in the Content-Type header", async () => {
  const r = await run("/latin1-header", "café crème", { depth: 0 });
  assert.equal(r.summary.totalHits, 1);
  assert.equal(r.hits[0].title, "Café");
  assert.match(r.hits[0].snippets[0], /naïve/);
});

test("decodes windows-1252 declared in <meta charset>", async () => {
  const r = await run("/cp1252-meta", "“café”", { depth: 0 });
  assert.equal(r.summary.totalHits, 1);
});

test("decodes Shift_JIS declared in <meta http-equiv>", async () => {
  const r = await run("/sjis-http-equiv", "東京タワー", { depth: 0 });
  assert.equal(r.summary.totalHits, 1);
  assert.match(r.hits[0].snippets[0], /\[\[東京タワー\]\]/);
});

test("undeclared encoding: UTF-8 if valid, else windows-1252", async () => {
  assert.equal((await run("/utf8-undeclared", "東京", { depth: 0 })).summary.totalHits, 1);
  assert.equal((await run("/undeclared-latin1", "déjà vu", { depth: 0 })).summary.totalHits, 1);
});

test("the Content-Type charset wins over <meta>", async () => {
  assert.equal((await run("/header-beats-meta", "déjà vu", { depth: 0 })).summary.totalHits, 1);
});

// --- hangs ---

test("a catastrophic regex is stopped by the per-page timeout; the crawl goes on", async () => {
  const t0 = Date.now();
  const r = await run("/redos-links", "(a+)+$|apple", { mode: "regex", timeout: 1, maxSeconds: 30 });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /regex search took over 1s/);
  assert.equal(r.summary.timedOut, false);
});

test("a catastrophic regex can't outlast max_seconds either", async () => {
  const t0 = Date.now();
  const r = await run("/redos", "(a+)+$", { mode: "regex", timeout: 60, maxSeconds: 1, depth: 0 });
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  assert.equal(r.summary.timedOut, true);
});

test("CLI: a catastrophic regex exits with a report, not a hang", async () => {
  const t0 = Date.now();
  const res = await new Promise((resolve) => execFile(process.execPath,
    [RFIND, site.url + "/redos", "(a+)+$", "--mode", "regex", "--timeout", "1", "--depth", "0"],
    { encoding: "utf8", timeout: 20000 }, (e, stdout) => resolve({ code: e ? e.code : 0, stdout })));
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /start page failed: regex search took over 1s/);
});

test("a body that never arrives is cut off by the per-page timeout", async () => {
  const t0 = Date.now();
  const r = await run("/stall", "apple", { timeout: 1, depth: 0 });
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(r.errors[0].error, "timeout");
});

test("a hostile robots.txt pattern doesn't backtrack", async () => {
  const rules = parseRobots("User-agent: *\nDisallow: /*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b$\n");
  const t0 = Date.now();
  assert.equal(robotsAllows(rules, "https://s.test/" + "a".repeat(5000) + "c"), true);
  assert.equal(robotsAllows(rules, "https://s.test/" + "a".repeat(5000) + "b"), false);
  assert.ok(Date.now() - t0 < 500);
});

// --- rate limits ---

test("429 with a short Retry-After is retried once", async () => {
  const r = await run("/429-once", "apple", { depth: 0 });
  assert.equal(r.summary.totalHits, 1);
  assert.equal(site.hits.get("/429-once"), 2);
});

test("429 with a long Retry-After isn't retried, and says so", async () => {
  const t0 = Date.now();
  const r = await run("/429-long", "apple", { depth: 0 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.errors[0].error, "HTTP 429, Retry-After 3600s (not retried)");
});

test("503 without Retry-After is retried once after a second", async () => {
  const before = site.hits.get("/503-always") ?? 0;
  const r = await run("/503-always", "apple", { depth: 0 });
  assert.equal(site.hits.get("/503-always") - before, 2);
  assert.equal(r.errors[0].error, "HTTP 503 (also after a retry)");
});

test("retryAfterMs: seconds, HTTP dates, garbage", () => {
  assert.equal(retryAfterMs("5"), 5000);
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("Thu, 01 Jan 2026 00:00:00 GMT")), 10000);
  assert.equal(retryAfterMs("soon"), null);
  assert.equal(retryAfterMs(null), null);
});

// --- odd pages and links ---

test("invalid HTML doesn't crash", async () => {
  const r = await run("/invalid", "apple", { depth: 0 });
  assert.equal(r.errors.length, 0);
  assert.ok(r.summary.totalHits >= 1);
});

test("a page with 50,000 links stays bounded by max_pages", async () => {
  const t0 = Date.now();
  const r = await run("/many-links", "apple", { maxPages: 5 });
  assert.equal(r.summary.capped, true);
  assert.equal(r.summary.pagesScanned, 5);
  assert.ok(Date.now() - t0 < 5000);
});

test("odd links: credentials, unicode paths, long queries, other schemes", async () => {
  const r = await run("/odd-links", "apple", { maxPages: 50 });
  // Unicode and percent-encoded paths are the same page; credentials, ftp,
  // mailto, javascript, broken and >8 KB URLs aren't followed.
  assert.deepEqual(paths(r.hits), ["/café/carte", "/café/menu"]);
  // /blocked; the long path is checked against the hostile wildcard rule quickly.
  assert.equal(r.summary.robotsBlocked, 1);
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.ok(r.errors.every((e) => e.error === "HTTP 404"), JSON.stringify(r.errors));
});

test("start URLs with credentials or other schemes are rejected clearly", () => {
  assert.throws(() => resolveOptions({ url: "http://u:secret@a.test/", query: "x" }), /username or password/);
});

test("within accepts unicode, missing leading slash and full URLs", async () => {
  assert.equal(resolveOptions({ url: "a.test", query: "x", within: "/café/" }).within, "/caf%C3%A9/");
  assert.equal(resolveOptions({ url: "a.test", query: "x", within: "docs/" }).within, "/docs/");
  assert.equal(resolveOptions({ url: "a.test", query: "x", within: "https://a.test/docs/x" }).within, "/docs/x");
  const r = await run("/odd-links", "apple", { within: "/café/" });
  assert.deepEqual(paths(r.hits), ["/café/carte", "/café/menu"]);
});

test("network errors say why", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const r = await crawl({ url: `http://127.0.0.1:${port}/`, query: "x", depth: 0, robots: false });
  assert.match(r.errors[0].error, /^fetch failed: ECONNREFUSED/);
  const dns = await crawl({ url: "http://nonexistent.invalid/", query: "x", depth: 0, robots: false });
  assert.match(dns.errors[0].error, /^fetch failed: (ENOTFOUND|EAI_AGAIN)/);
});

test("formatText still renders encoded results", async () => {
  const opts = resolveOptions({ url: site.url + "/latin1-header", query: "crème", depth: 0 });
  assert.match(formatText(await crawl(opts), opts), /1× .*\/latin1-header {2}— Café/);
});
