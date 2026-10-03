import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLPS, kmpSearch } from "../scripts/kmp.mjs";
import {
  decodeEntities, extractLinks, findMatches, htmlToText, mainContent, normalizeUrl, pageTitle,
  parseRobots, resolveOptions, robotsAllows, searchText,
} from "../scripts/crawl.mjs";

test("kmp: LPS table", () => {
  assert.deepEqual(computeLPS("aabaaab"), [0, 1, 0, 1, 2, 2, 3]);
  assert.deepEqual(computeLPS("abcd"), [0, 0, 0, 0]);
});

test("kmp: finds every, including overlapping, match", () => {
  assert.deepEqual(kmpSearch("aaaa", "aa"), [0, 1, 2]);
  assert.deepEqual(kmpSearch("abcabcab", "abcab"), [0, 3]);
  assert.deepEqual(kmpSearch("hello", ""), []);
  assert.deepEqual(kmpSearch("hi", "hello"), []);
  assert.deepEqual(kmpSearch("no match here", "xyz"), []);
});

test("decodeEntities: named, decimal, hex, invalid code points", () => {
  assert.equal(decodeEntities("a&nbsp;b &amp; &lt;i&gt; &quot;q&quot; &#39;s&apos;"), `a b & <i> "q" 's'`);
  assert.equal(decodeEntities("&#233;&#x1F600;&#X41;"), "é😀A");
  assert.equal(decodeEntities("&#99999999;"), " ");
  assert.equal(decodeEntities("&amp;lt;"), "&lt;"); // decoded once, not twice
});

test("htmlToText: drops script/style/noscript/comments and tags, collapses whitespace", () => {
  const html = `<head><style>.apple{}</style><script>var apple = 1;</script></head>
    <body><!-- apple --><noscript>apple</noscript><p>Hello&nbsp;<b>world</b></p>\n\n<p>bye</p></body>`;
  assert.equal(htmlToText(html), "Hello world bye");
});

test("pageTitle", () => {
  assert.equal(pageTitle("<title>\n  A &amp; B\n</title>"), "A & B");
  assert.equal(pageTitle("<p>no title</p>"), "");
});

test("extractLinks: resolves, dedupes, strips hashes, skips non-pages", () => {
  const html = `
    <a href="/a">a</a> <a href='b'>b</a> <a href=c?x=1&amp;y=2>c</a>
    <a class="x" href="/a#section">dup</a> <a href="#top">top</a>
    <a href="mailto:x@y.z">m</a> <a href="javascript:void(0)">j</a> <a href="tel:1">t</a>
    <a href="/file.pdf">pdf</a> <a href="/img.PNG">png</a> <a href="/notes.md">md</a>
    <a href="ftp://example.com/x">ftp</a> <a href="https://other.example/page">other</a>
    <a href="http://[bad">bad</a> <link href="/style">`;
  assert.deepEqual(extractLinks(html, "https://site.test/dir/page"), [
    "https://site.test/a",
    "https://site.test/dir/b",
    "https://site.test/dir/c?x=1&y=2",
    "https://other.example/page",
  ]);
});

test("extractLinks: honors <base href>", () => {
  const html = `<base href="https://cdn.test/root/"><a href="x">x</a>`;
  assert.deepEqual(extractLinks(html, "https://site.test/page"), ["https://cdn.test/root/x"]);
});

test("normalizeUrl: drops hash and trailing slash except at root", () => {
  assert.equal(normalizeUrl("https://a.test/docs/#x"), "https://a.test/docs");
  assert.equal(normalizeUrl("https://a.test/"), "https://a.test/");
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("mainContent: <main>, nested tags, role=main, <article>, fallback", () => {
  assert.equal(
    mainContent("<nav>n</nav><main id=m>a<main>b</main>c</main><footer>f</footer>"),
    "<main id=m>a<main>b</main>c"
  );
  assert.equal(
    mainContent(`<div>menu</div><div role="main">x<div>y</div>z</div><div>foot</div>`),
    `<div role="main">x<div>y</div>z`
  );
  assert.equal(mainContent("<aside>s</aside><article>post</article>"), "<article>post");
  assert.equal(mainContent("<p>no landmarks</p>"), "<p>no landmarks</p>");
  assert.equal(mainContent("<main>unclosed"), "<main>unclosed");
});

test("findMatches: text, case, word, regex", () => {
  const text = "Cat category cat. concat CAT";
  assert.equal(findMatches(text, { query: "cat", mode: "text", caseSensitive: false }).length, 5);
  assert.equal(findMatches(text, { query: "cat", mode: "text", caseSensitive: true }).length, 3);
  assert.deepEqual(
    findMatches(text, { query: "cat", mode: "word", caseSensitive: false }).map((m) => m.index),
    [0, 13, 25]
  );
  assert.deepEqual(findMatches("E12 and E3", { query: "E\\d+", mode: "regex", caseSensitive: true }), [
    { index: 0, length: 3 },
    { index: 8, length: 2 },
  ]);
  // Zero-length regex matches don't loop forever.
  assert.equal(findMatches("abc", { query: "x*", mode: "regex", caseSensitive: false }).length, 4);
});

test("searchText: snippets mark matches and skip overlaps", () => {
  const text = "a".repeat(100) + " apple apple " + "b".repeat(100);
  const r = searchText(text, { query: "apple", mode: "text", caseSensitive: false }, 3);
  assert.equal(r.matchCount, 2);
  assert.equal(r.snippets.length, 1); // second match falls inside the first snippet
  assert.match(r.snippets[0], /^….*\[\[apple\]\] apple.*…$/);
  assert.equal(searchText(text, { query: "apple", mode: "text" }, 0).snippets.length, 0);
});

test("parseRobots: only * and rfind groups, comments, blank values", () => {
  const rules = parseRobots(`# comment
User-agent: Googlebot
Disallow: /google-only/

User-agent: *
User-agent: rfind
Disallow: /private/   # trailing comment
Allow: /private/public
Disallow:

User-agent: other
Disallow: /`);
  assert.deepEqual(rules, [
    { allow: false, path: "/private/" },
    { allow: true, path: "/private/public" },
  ]);
});

test("robotsAllows: longest match wins, wildcards, $ anchors, query strings", () => {
  const rules = parseRobots(`User-agent: *
Disallow: /private/
Allow: /private/public
Disallow: /*.php$
Disallow: /search?`);
  const ok = (p) => robotsAllows(rules, "https://s.test" + p);
  assert.equal(ok("/"), true);
  assert.equal(ok("/private/x"), false);
  assert.equal(ok("/private/public/page"), true);
  assert.equal(ok("/a/b.php"), false);
  assert.equal(ok("/a/b.php5"), true);
  assert.equal(ok("/search?q=1"), false);
  assert.equal(ok("/search"), true);
  assert.equal(robotsAllows([], "https://s.test/anything"), true);
});

test("resolveOptions: defaults, caps and validation", () => {
  const o = resolveOptions({ url: "example.com/docs", query: "x" });
  assert.equal(o.url, "https://example.com/docs");
  assert.equal(o.depth, 1);
  assert.equal(o.maxPages, 100);
  assert.equal(o.maxSeconds, 120);
  assert.equal(o.limit, 20);
  assert.equal(o.robots, true);
  const capped = resolveOptions({ url: "http://a.test", query: "x", depth: 9, maxPages: 5000, concurrency: 99, limit: 0 });
  assert.deepEqual([capped.depth, capped.maxPages, capped.concurrency, capped.limit], [3, 1000, 8, 1]);
  assert.throws(() => resolveOptions({ url: "http://a.test", query: "" }), /empty query/);
  assert.throws(() => resolveOptions({ url: "http://a.test", query: "(", mode: "regex" }), /invalid regex/);
  assert.throws(() => resolveOptions({ url: "http://a.test", query: "x", mode: "fuzzy" }), /mode must be/);
  assert.throws(() => resolveOptions({ url: "http://exa mple.com", query: "x" }), /bad url/);
  assert.throws(() => resolveOptions({ url: "http://a.test", query: "x", depth: -1 }), /bad value for depth/);
});
