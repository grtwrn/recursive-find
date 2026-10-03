// The rfind crawler, shared by the CLI (rfind.mjs) and the MCP server
// (mcp.mjs). Headless port of grtwrn/recursive-find (worker.js + kmp.js):
// fetch a page, strip it to text, search it, follow its links breadth-first
// to `depth`, and return only the pages that match. Never writes to stdout.

import { kmpSearch } from "./kmp.mjs";

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULTS = {
  depth: 1, maxPages: 100, mode: "text", caseSensitive: false, anySite: false,
  within: null, mainOnly: false, first: false, limit: 20, snippets: 3, concurrency: 4,
  timeout: 10, maxSeconds: 120, robots: true, maxBodyBytes: MAX_BODY_BYTES,
};

const SNIPPET_RADIUS = 60;
const MAX_ERRORS_SHOWN = 20;
const UA = "rfind/1.0 (+https://github.com/grtwrn/recursive-find)";
const SKIP_EXT =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|zip|gz|tgz|bz2|7z|rar|dmg|exe|pkg|deb|rpm|iso|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|csv|md|markdown|xlsx?|docx?|pptx?)$/i;

// --- options ---

// Fill in defaults, clamp numbers to their caps, and validate url/mode/query.
// Throws an Error with a user-facing message on bad input. Idempotent.
export function resolveOptions(input) {
  const opts = { ...DEFAULTS };
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) opts[k] = v;
  const num = (name) => {
    const n = Number(opts[name]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`bad value for ${name}: ${opts[name]}`);
    return Math.floor(n);
  };
  const clamp = (name, lo, hi) => Math.max(lo, Math.min(hi, num(name)));
  opts.depth = clamp("depth", 0, 3);
  opts.maxPages = clamp("maxPages", 1, 1000);
  opts.limit = clamp("limit", 1, Infinity);
  opts.snippets = num("snippets");
  opts.concurrency = clamp("concurrency", 1, 8);
  opts.timeout = clamp("timeout", 1, Infinity);
  opts.maxSeconds = clamp("maxSeconds", 1, Infinity);
  opts.maxBodyBytes = clamp("maxBodyBytes", 1, Infinity);
  opts.within = opts.within || null;

  let url = String(opts.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { opts.url = new URL(url).href; } catch { throw new Error(`bad url: ${url}`); }
  if (!["text", "word", "regex"].includes(opts.mode)) throw new Error("mode must be text, word or regex");
  if (!opts.query) throw new Error("empty query");
  opts.query = String(opts.query);
  if (opts.mode === "regex") {
    try { new RegExp(opts.query); } catch (e) { throw new Error(`invalid regex: ${e.message}`); }
  }
  return opts;
}

// --- text utilities (from worker.js) ---

const NAMED_ENTITIES = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#39;": "'", "&apos;": "'",
};

export function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => NAMED_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)));
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return " "; }
}

export function htmlToText(html) {
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

export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

export function extractLinks(html, baseUrl) {
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

export function normalizeUrl(href) {
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
export function mainContent(html) {
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

export function findMatches(text, { query, mode, caseSensitive }) {
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

export function searchText(text, cfg, maxSnippets) {
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

// `signal` aborts the fetch from outside (the crawl deadline); the error message
// is then "deadline" instead of "timeout".
export async function fetchHtml(url, timeoutMs, { signal, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
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
      if (size > maxBodyBytes) {
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
    }
    return { html: Buffer.concat(chunks).toString("utf8"), finalUrl: res.url || url, truncated };
  } catch (e) {
    if (e?.name === "AbortError" || controller.signal.aborted) {
      throw new Error(signal?.aborted ? "deadline" : "timeout");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Minimal robots.txt: Disallow/Allow rules in the "User-agent: *" (or rfind)
// groups, longest match wins. Unreachable robots.txt = allow everything.
export function parseRobots(txt) {
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

export function robotsAllows(rules, url) {
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

// Crawl and search. Returns { summary, hits, errors } with every hit and error
// (use toJSON / formatText to apply `limit`). Throws only on bad options.
export async function crawl(input) {
  const opts = resolveOptions(input);
  const cfg = { query: opts.query, mode: opts.mode, caseSensitive: opts.caseSensitive };
  const timeoutMs = opts.timeout * 1000;
  const startOrigin = new URL(opts.url).origin;
  const deadline = new AbortController();
  const fetchOpts = { signal: deadline.signal, maxBodyBytes: opts.maxBodyBytes };
  const t0 = Date.now();

  const robotsCache = new Map();
  const robotsFor = (origin) => {
    if (!robotsCache.has(origin)) {
      robotsCache.set(origin, (async () => {
        try {
          const { html } = await fetchHtml(origin + "/robots.txt", Math.min(timeoutMs, 5000), fetchOpts);
          return parseRobots(html);
        } catch {
          return [];
        }
      })());
    }
    return robotsCache.get(origin);
  };

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
  let timedOut = false;
  let stopped = false;
  let firstHit = false;
  let active = 0;
  let queued = 1; // pages queued for fetching, start page included

  await new Promise((resolve) => {
    let graceTimer;
    const finish = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      resolve();
    };
    // --max-seconds: stop queueing, abort in-flight fetches, and give them a
    // moment to unwind; resolve regardless so the crawl can never hang.
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      stopped = true;
      queue.length = 0;
      deadline.abort();
      graceTimer = setTimeout(finish, 1000);
    }, opts.maxSeconds * 1000);

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
      if (active === 0 && queue.length === 0) finish();
    };

    const visit = async ({ url, depth }) => {
      try {
        if (opts.robots) {
          const rules = await robotsFor(new URL(url).origin);
          if (!robotsAllows(rules, url)) {
            blocked++;
            return;
          }
        }
        const { html, finalUrl, truncated } = await fetchHtml(url, timeoutMs, fetchOpts);
        if (truncated) truncatedPages.push(finalUrl);
        if (stopped) return;
        scanned++;
        const text = htmlToText(opts.mainOnly ? mainContent(html) : html);
        const found = searchText(text, cfg, opts.snippets);
        if (found.matchCount > 0) {
          hits.push({ url: finalUrl, title: pageTitle(html), depth, ...found, ...(truncated && { truncated }) });
          if (opts.first) stopped = firstHit = true;
        }
        if (depth < opts.depth && !stopped) {
          for (const href of extractLinks(html, finalUrl)) {
            if (timedOut) break;
            const n = normalizeUrl(href);
            if (visited.has(n) || !allowed(href)) continue;
            visited.add(n);
            // Check robots before queueing so blocked links don't use up --max-pages.
            if (opts.robots && !robotsAllows(await robotsFor(new URL(href).origin), href)) {
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
        if (timedOut) {
          // Pages cut off by the deadline aren't errors, unless it's the start page.
          if (depth === 0) {
            scanned++;
            errors.push({ url, depth, error: `deadline: no response within ${opts.maxSeconds}s` });
          }
          return;
        }
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
  const summary = {
    query: opts.query, start: opts.url, depth: opts.depth, mode: opts.mode,
    pagesScanned: scanned, pagesWithHits: hits.length,
    totalHits: hits.reduce((s, h) => s + h.matchCount, 0),
    errors: errors.length, skippedNonHtml: skipped, robotsBlocked: blocked, capped, timedOut,
    truncatedPages, stoppedAtFirst: firstHit,
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
  };
  return { summary, hits, errors };
}

// The start page's error, if it failed (CLI exit code 1, MCP isError).
export function startError(result) {
  return result.errors.find((e) => e.depth === 0) || null;
}

export function toJSON({ summary, hits, errors }, opts) {
  return { summary, hits: hits.slice(0, opts.limit), errors: errors.slice(0, MAX_ERRORS_SHOWN) };
}

// Option names as they appear in the summary line ("hit --max-pages 100").
export const CLI_NAMES = { maxPages: "--max-pages", maxSeconds: "--max-seconds", limit: "--limit" };

// Compact text report: a summary line, then each matching page with snippets.
export function formatText(result, opts, names = CLI_NAMES) {
  const { summary, hits } = result;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const size = maxBodyBytes % (1 << 20) === 0 ? `${maxBodyBytes >> 20} MB` : `${maxBodyBytes} bytes`;
  const lines = [];
  let line = `${plural(summary.totalHits, "hit")} on ${plural(summary.pagesWithHits, "page")} · ${plural(summary.pagesScanned, "page")} scanned, depth ${summary.depth}, ${summary.seconds}s`;
  if (summary.errors) line += ` · ${plural(summary.errors, "error")}`;
  if (summary.skippedNonHtml) line += ` · ${summary.skippedNonHtml} non-HTML links skipped`;
  if (summary.robotsBlocked) line += ` · ${summary.robotsBlocked} blocked by robots.txt`;
  if (summary.capped) line += ` · hit ${names.maxPages} ${opts.maxPages}, results may be incomplete`;
  if (summary.timedOut) line += ` · hit ${names.maxSeconds} ${opts.maxSeconds}, results may be incomplete`;
  if (summary.truncatedPages.length) {
    line += ` · ${plural(summary.truncatedPages.length, "page")} over ${size} only partly searched: ${summary.truncatedPages.join(", ")}`;
  }
  if (summary.stoppedAtFirst) line += " · stopped at first hit";
  lines.push(line);
  for (const h of hits.slice(0, opts.limit)) {
    lines.push(`\n${h.matchCount}× ${h.url}${h.title ? `  — ${h.title}` : ""}`);
    for (const s of h.snippets) lines.push(`   ${s}`);
  }
  if (hits.length > opts.limit) lines.push(`\n… ${hits.length - opts.limit} more matching pages (raise ${names.limit})`);
  const failed = startError(result);
  if (failed) lines.push(`\nstart page failed: ${failed.error}`);
  return lines.join("\n");
}
