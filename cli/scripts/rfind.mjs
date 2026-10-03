#!/usr/bin/env node
// rfind — Ctrl+F, but recursive. Headless port of grtwrn/recursive-find
// (worker.js + kmp.js): fetch a page, strip it to text, search it, follow its
// links breadth-first to --depth, and print only the pages that match.

import { kmpSearch } from "./kmp.mjs";

const USAGE = `usage: rfind <url> <query> [options]

  --depth N         0 = start page only, 1 = + pages it links to (default 1, max 3)
  --max-pages N     stop fetching after N pages (default 100, max 1000)
  --mode M          text (default) | word | regex
  --case            case-sensitive
  --any-site        follow links to other sites (default: same origin only)
  --within PATH     only follow links whose path starts with PATH (e.g. /docs/)
  --first           stop at the first page that matches
  --limit N         print at most N matching pages (default 20)
  --snippets N      snippets per page (default 3)
  --concurrency N   parallel fetches (default 4, max 8)
  --timeout S       per-page timeout in seconds (default 10)
  --main            search only the page's main content (<main>, role="main" or
                    <article>), skipping nav, sidebars and footers when present
  --ignore-robots   don't honor robots.txt
  --json            JSON output`;

const SNIPPET_RADIUS = 60;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UA = "rfind/1.0 (+https://github.com/grtwrn/recursive-find)";
const SKIP_EXT =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|zip|gz|tgz|bz2|7z|rar|dmg|exe|pkg|deb|rpm|iso|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|csv|md|markdown|xlsx?|docx?|pptx?)$/i;

// --- args ---

function parseArgs(argv) {
  const opts = {
    depth: 1, maxPages: 100, mode: "text", caseSensitive: false, anySite: false,
    within: null, mainOnly: false, first: false, limit: 20, snippets: 3, concurrency: 4,
    timeout: 10, robots: true, json: false,
  };
  const pos = [];
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) die(`bad value for ${name}: ${v}`);
    return Math.floor(n);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "-h": case "--help": console.log(USAGE); process.exit(0);
      case "--depth": opts.depth = Math.min(3, num(next(), a)); break;
      case "--max-pages": opts.maxPages = Math.max(1, Math.min(1000, num(next(), a))); break;
      case "--mode": opts.mode = next(); break;
      case "--case": opts.caseSensitive = true; break;
      case "--any-site": opts.anySite = true; break;
      case "--within": opts.within = next(); break;
      case "--first": opts.first = true; break;
      case "--limit": opts.limit = Math.max(1, num(next(), a)); break;
      case "--snippets": opts.snippets = num(next(), a); break;
      case "--concurrency": opts.concurrency = Math.max(1, Math.min(8, num(next(), a))); break;
      case "--timeout": opts.timeout = Math.max(1, num(next(), a)); break;
      case "--main": opts.mainOnly = true; break;
      case "--ignore-robots": opts.robots = false; break;
      case "--json": opts.json = true; break;
      default:
        if (a.startsWith("--")) die(`unknown option ${a}`);
        pos.push(a);
    }
  }
  if (pos.length !== 2) die(USAGE);
  [opts.url, opts.query] = pos;
  if (!/^https?:\/\//i.test(opts.url)) opts.url = "https://" + opts.url;
  try { opts.url = new URL(opts.url).href; } catch { die(`bad url: ${opts.url}`); }
  if (!["text", "word", "regex"].includes(opts.mode)) die(`--mode must be text, word or regex`);
  if (!opts.query) die("empty query");
  if (opts.mode === "regex") {
    try { new RegExp(opts.query); } catch (e) { die(`invalid regex: ${e.message}`); }
  }
  return opts;
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}

// --- text utilities (from worker.js) ---

const NAMED_ENTITIES = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#39;": "'", "&apos;": "'",
};

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => NAMED_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)));
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return " "; }
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function extractLinks(html, baseUrl) {
  const base = /<base\b[^>]*?\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  if (base) {
    try { baseUrl = new URL(base[1], baseUrl).href; } catch { /* keep page url */ }
  }
  const links = new Set();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
    try {
      const url = new URL(raw, baseUrl);
      if ((url.protocol === "http:" || url.protocol === "https:") && !SKIP_EXT.test(url.pathname)) {
        url.hash = "";
        links.add(url.href);
      }
    } catch { /* skip malformed URLs */ }
  }
  return [...links];
}

function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.hash = "";
    let s = u.href;
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return href;
  }
}

// The page's main content: the first <main>, role="main" element or <article>,
// found by counting nested tags of the same name. Falls back to the whole page.
function mainContent(html) {
  const open =
    /<main\b[^>]*>/i.exec(html) ||
    /<([a-z][a-z0-9]*)\b[^>]*\brole\s*=\s*["']?main\b[^>]*>/i.exec(html) ||
    /<article\b[^>]*>/i.exec(html);
  if (!open) return html;
  const tag = (open[1] || /^<([a-z0-9]+)/i.exec(open[0])[1]).toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m;
  while ((m = re.exec(html)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index, m.index);
  }
  return html.slice(open.index);
}

// --- matching (from worker.js) ---

const WORD_RE = /\w/;
const isWordChar = (c) => c !== undefined && WORD_RE.test(c);

function findMatches(text, { query, mode, caseSensitive }) {
  if (mode === "regex") {
    const re = new RegExp(query, caseSensitive ? "g" : "gi");
    const out = [];
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      out.push({ index: m.index, length: m[0].length || 1 });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (++guard > 100000) break;
    }
    return out;
  }
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  let indices = kmpSearch(haystack, needle);
  if (mode === "word") {
    indices = indices.filter((i) => !isWordChar(text[i - 1]) && !isWordChar(text[i + query.length]));
  }
  return indices.map((i) => ({ index: i, length: query.length }));
}

function searchText(text, cfg, maxSnippets) {
  const matches = findMatches(text, cfg);
  const snippets = [];
  let lastEnd = -1;
  for (const { index, length } of matches) {
    if (snippets.length >= maxSnippets) break;
    if (index < lastEnd) continue; // skip matches inside the previous snippet
    const start = Math.max(0, index - SNIPPET_RADIUS);
    const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
    snippets.push(
      (start > 0 ? "…" : "") + text.slice(start, index) + "[[" + text.slice(index, index + length) +
        "]]" + text.slice(index + length, end) + (end < text.length ? "…" : "")
    );
    lastEnd = end;
  }
  return { matchCount: matches.length, snippets };
}

// --- fetching ---

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`skipped ${type.split(";")[0]}`), { skipped: true });
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX_BODY_BYTES) {
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
    }
    return { html: Buffer.concat(chunks).toString("utf8"), finalUrl: res.url || url, truncated };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Minimal robots.txt: Disallow/Allow rules in the "User-agent: *" (or rfind)
// groups, longest match wins. Unreachable robots.txt = allow everything.
const robotsCache = new Map();

async function robotsFor(origin, timeoutMs) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const p = (async () => {
    try {
      const { html } = await fetchHtml(origin + "/robots.txt", Math.min(timeoutMs, 5000));
      return parseRobots(html);
    } catch {
      return [];
    }
  })();
  robotsCache.set(origin, p);
  return p;
}

function parseRobots(txt) {
  const rules = [];
  let agents = [];
  let inRules = false;
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([a-z-]+)\s*:\s*(.*?)\s*(#.*)?$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === "user-agent") {
      if (inRules) { agents = []; inRules = false; }
      agents.push(val.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      if (val && agents.some((a) => a === "*" || a.includes("rfind"))) {
        rules.push({ allow: key === "allow", path: val });
      }
    }
  }
  return rules;
}

function robotsAllows(rules, url) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    const re = new RegExp(
      "^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")
    );
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}

// --- crawl ---

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = { query: opts.query, mode: opts.mode, caseSensitive: opts.caseSensitive };
  const timeoutMs = opts.timeout * 1000;
  const startOrigin = new URL(opts.url).origin;
  const t0 = Date.now();

  const allowed = (href) => {
    try {
      const u = new URL(href);
      if (!opts.anySite && u.origin !== startOrigin) return false;
      if (opts.within && !u.pathname.startsWith(opts.within)) return false;
      return true;
    } catch {
      return false;
    }
  };

  const visited = new Set([normalizeUrl(opts.url)]);
  const queue = [{ url: opts.url, depth: 0 }];
  const hits = [];
  const errors = [];
  const truncatedPages = [];
  let scanned = 0;
  let blocked = 0;
  let skipped = 0;
  let capped = false;
  let stopped = false;
  let active = 0;
  let queued = 1; // pages queued for fetching, start page included

  await new Promise((resolve) => {
    const pump = () => {
      if (stopped) queue.length = 0;
      while (active < opts.concurrency && queue.length) {
        const job = queue.shift();
        active++;
        visit(job).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && queue.length === 0) resolve();
    };

    const visit = async ({ url, depth }) => {
      try {
        if (opts.robots) {
          const rules = await robotsFor(new URL(url).origin, timeoutMs);
          if (!robotsAllows(rules, url)) {
            blocked++;
            return;
          }
        }
        const { html, finalUrl, truncated } = await fetchHtml(url, timeoutMs);
        if (truncated) truncatedPages.push(finalUrl);
        if (stopped) return;
        scanned++;
        const text = htmlToText(opts.mainOnly ? mainContent(html) : html);
        const found = searchText(text, cfg, opts.snippets);
        if (found.matchCount > 0) {
          hits.push({ url: finalUrl, title: pageTitle(html), depth, ...found, ...(truncated && { truncated }) });
          if (opts.first) stopped = true;
        }
        if (depth < opts.depth && !stopped) {
          for (const href of extractLinks(html, finalUrl)) {
            const n = normalizeUrl(href);
            if (visited.has(n) || !allowed(href)) continue;
            visited.add(n);
            // Check robots before queueing so blocked links don't use up --max-pages.
            if (opts.robots && !robotsAllows(await robotsFor(new URL(href).origin, timeoutMs), href)) {
              blocked++;
              continue;
            }
            if (queued >= opts.maxPages) {
              capped = true;
              break;
            }
            queued++;
            queue.push({ url: href, depth: depth + 1 });
          }
        }
      } catch (e) {
        if (e?.skipped && depth > 0) {
          skipped++; // a non-HTML link (PDF, markdown, image…), not a failure
          return;
        }
        scanned++;
        errors.push({ url, depth, error: e?.message || String(e) });
      }
    };

    pump();
  });

  hits.sort((a, b) => b.matchCount - a.matchCount || a.depth - b.depth);
  const totalHits = hits.reduce((s, h) => s + h.matchCount, 0);
  const startFailed = errors.find((e) => e.depth === 0);
  const summary = {
    query: opts.query, start: opts.url, depth: opts.depth, mode: opts.mode,
    pagesScanned: scanned, pagesWithHits: hits.length, totalHits,
    errors: errors.length, skippedNonHtml: skipped, robotsBlocked: blocked, capped, truncatedPages,
    stoppedAtFirst: opts.first && stopped, seconds: +((Date.now() - t0) / 1000).toFixed(1),
  };

  if (opts.json) {
    console.log(JSON.stringify({ summary, hits: hits.slice(0, opts.limit), errors: errors.slice(0, 20) }, null, 2));
  } else {
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    let line = `${plural(totalHits, "hit")} on ${plural(hits.length, "page")} · ${plural(scanned, "page")} scanned, depth ${opts.depth}, ${summary.seconds}s`;
    if (errors.length) line += ` · ${plural(errors.length, "error")}`;
    if (skipped) line += ` · ${skipped} non-HTML links skipped`;
    if (blocked) line += ` · ${blocked} blocked by robots.txt`;
    if (capped) line += ` · hit --max-pages ${opts.maxPages}, results may be incomplete`;
    if (truncatedPages.length) {
      line += ` · ${plural(truncatedPages.length, "page")} over ${MAX_BODY_BYTES >> 20} MB only partly searched: ${truncatedPages.join(", ")}`;
    }
    if (summary.stoppedAtFirst) line += " · stopped at first hit";
    console.log(line);
    for (const h of hits.slice(0, opts.limit)) {
      console.log(`\n${h.matchCount}× ${h.url}${h.title ? `  — ${h.title}` : ""}`);
      for (const s of h.snippets) console.log(`   ${s}`);
    }
    if (hits.length > opts.limit) console.log(`\n… ${hits.length - opts.limit} more matching pages (raise --limit)`);
    if (startFailed) console.log(`\nstart page failed: ${startFailed.error}`);
  }
  process.exit(startFailed ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
