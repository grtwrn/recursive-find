import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { crawl, formatText, resolveOptions, startError } from "../scripts/crawl.mjs";
import { startFixture } from "./fixture.mjs";

const RFIND = fileURLToPath(new URL("../scripts/rfind.mjs", import.meta.url));
let site;
before(async () => { site = await startFixture(); });
after(() => site.close());

const run = (path, query, opts = {}) => crawl({ url: site.url + path, query, ...opts });
const paths = (list) => list.map((h) => new URL(h.url).pathname).sort();

function cli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RFIND, ...args], { encoding: "utf8" }, (e, stdout, stderr) =>
      resolve({ code: e ? e.code : 0, stdout, stderr }));
  });
}

test("depth 0 searches only the start page", async () => {
  const r = await run("/", "apple", { depth: 0 });
  assert.equal(r.summary.pagesScanned, 1);
  assert.deepEqual(paths(r.hits), ["/"]);
});

test("depth 1: same origin, robots, non-HTML skips, errors", async () => {
  const r = await run("/", "apple");
  const s = r.summary;
  // /, /docs/, /docs/a, /blog/post, /missing (404). Not /private/ (robots), /api/data
  // (JSON, skipped), /report.pdf (by extension), the other origin, or /docs/deep (depth 2).
  assert.equal(s.pagesScanned, 5);
  assert.deepEqual(paths(r.hits), ["/", "/blog/post", "/docs/", "/docs/a"]);
  assert.equal(s.robotsBlocked, 1);
  assert.equal(s.skippedNonHtml, 1);
  assert.equal(s.errors, 1);
  assert.equal(r.errors[0].error, "HTTP 404");
  assert.equal(s.capped, false);
  assert.equal(s.timedOut, false);
  assert.equal(startError(r), null);
  assert.equal(r.hits[0].matchCount, 2); // /docs/a: apple + pineapple, sorted first
});

test("any_site follows links to other origins", async () => {
  const r = await run("/", "apple", { anySite: true });
  assert.ok(r.hits.some((h) => h.url === `${site.otherUrl}/ext`));
});

test("ignoring robots.txt reaches disallowed pages", async () => {
  const r = await run("/", "apple", { robots: false });
  assert.equal(r.summary.robotsBlocked, 0);
  assert.ok(paths(r.hits).includes("/private/secret"));
});

test("within limits the crawl to a path prefix; depth 2 goes one level further", async () => {
  const r = await run("/docs/", "apple", { within: "/docs/", depth: 2 });
  assert.deepEqual(paths(r.hits), ["/docs/", "/docs/a", "/docs/deep"]);
  assert.equal(r.summary.pagesScanned, 4); // + /docs/b, no /blog/post
});

test("max_pages caps the crawl and flags it", async () => {
  const r = await run("/", "apple", { maxPages: 2 });
  assert.equal(r.summary.pagesScanned, 2);
  assert.equal(r.summary.capped, true);
  const opts = resolveOptions({ url: site.url, query: "apple", maxPages: 2 });
  assert.match(formatText(r, opts), /hit --max-pages 2, results may be incomplete/);
});

test("first stops at the first matching page", async () => {
  const r = await run("/", "apple", { first: true, depth: 0 });
  assert.equal(r.summary.stoppedAtFirst, true);
  assert.equal(r.hits.length, 1);
});

test("main_only ignores nav and footer", async () => {
  assert.equal((await run("/main", "apple", { depth: 0 })).summary.totalHits, 2);
  assert.equal((await run("/main", "apple", { depth: 0, mainOnly: true })).summary.totalHits, 0);
  const r = await run("/main", "kiwi", { depth: 0, mainOnly: true }); // after a nested <main>
  assert.equal(r.summary.totalHits, 1);
});

test("word and regex modes", async () => {
  assert.equal((await run("/words", "cat", { depth: 0 })).summary.totalHits, 4);
  assert.equal((await run("/words", "cat", { depth: 0, mode: "word" })).summary.totalHits, 2);
  const r = await run("/words", "E\\d+", { depth: 0, mode: "regex", caseSensitive: true });
  assert.equal(r.summary.totalHits, 2);
  assert.match(r.hits[0].snippets[0], /\[\[E1234\]\]/);
});

test("pages over the byte cap are partly searched and flagged", async () => {
  const opts = resolveOptions({ url: site.url + "/big", query: "apple", depth: 0, maxBodyBytes: 1000 });
  const r = await crawl(opts);
  assert.deepEqual(r.summary.truncatedPages, [site.url + "/big"]);
  assert.equal(r.hits[0].truncated, true);
  assert.match(formatText(r, opts), /1 page over 1000 bytes only partly searched/);
  const tail = await run("/big", "banana", { depth: 0, maxBodyBytes: 1000 });
  assert.equal(tail.summary.totalHits, 0); // beyond the cap (the cap is checked per received chunk)
  assert.equal((await run("/big", "banana", { depth: 0 })).summary.totalHits, 1);
});

test("max_seconds stops a slow crawl and reports it", async () => {
  const t0 = Date.now();
  const r = await run("/slow-links", "apple", { maxSeconds: 1 });
  assert.ok(Date.now() - t0 < 3000, "returned soon after the deadline");
  assert.equal(r.summary.timedOut, true);
  assert.equal(r.summary.errors, 0); // pages cut off by the deadline aren't errors
  assert.deepEqual(paths(r.hits), ["/slow-links"]);
  const opts = resolveOptions({ url: site.url, query: "apple", maxSeconds: 1 });
  assert.match(formatText(r, opts), /hit --max-seconds 1, results may be incomplete/);
});

test("max_seconds on a slow start page is a start-page failure", async () => {
  const r = await run("/slow1", "apple", { maxSeconds: 1 });
  assert.equal(r.summary.timedOut, true);
  assert.match(startError(r).error, /deadline/);
});

test("CLI: text output, JSON output and exit codes", async () => {
  const ok = await cli(site.url + "/docs/", "apple", "--within", "/docs/", "--snippets", "1");
  assert.equal(ok.code, 0);
  assert.equal(ok.stderr, "");
  const lines = ok.stdout.split("\n");
  assert.match(lines[0], /^3 hits on 2 pages · 3 pages scanned, depth 1, [\d.]+s$/);
  assert.equal(lines[1], "");
  assert.equal(lines[2], `2× ${site.url}/docs/a  — Doc A`);
  assert.equal(lines[3], "   Doc A [[apple]] banana pineapple /docs/deep");

  const json = JSON.parse((await cli(site.url + "/", "apple", "--json", "--limit", "1")).stdout);
  assert.equal(json.hits.length, 1);
  assert.equal(json.summary.pagesWithHits, 4);

  const missing = await cli(site.url + "/missing", "apple");
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /start page failed: HTTP 404/);

  assert.equal((await cli(site.url, "(", "--mode", "regex")).code, 2);
  assert.equal((await cli(site.url, "x", "--mode", "fuzzy")).stderr.trim(), "--mode must be text, word or regex");
  assert.equal((await cli(site.url)).code, 2);
  assert.equal((await cli(site.url, "x", "--bogus")).code, 2);
  assert.match((await cli("--help")).stdout, /--max-seconds S/);
});
