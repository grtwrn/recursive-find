// Dedicated Web Worker: one OS thread that fetches a page (or takes provided
// text), strips it to text, runs KMP, and extracts links. The side panel spins
// up a pool of these so many pages are fetched + searched genuinely in parallel.

import { kmpSearch } from "./kmp.js";

const FETCH_TIMEOUT_MS = 10000;
const SNIPPET_RADIUS = 40;
const MAX_SNIPPETS = 3;

// --- text utilities (same logic that used to live in the service worker) ---

const NAMED_ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => NAMED_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
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

function extractLinks(html, baseUrl) {
  const links = new Set();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) continue;
    try {
      const url = new URL(raw, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") {
        url.hash = "";
        links.add(url.href);
      }
    } catch {
      /* skip malformed URLs */
    }
  }
  return [...links];
}

function makePreview(text, max = 200) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

// --- matching ---

const WORD_RE = /\w/;
function isWordChar(c) {
  return c !== undefined && WORD_RE.test(c);
}

function findMatches(text, cfg) {
  const { query, mode, caseSensitive } = cfg;
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
    indices = indices.filter(
      (i) => !isWordChar(text[i - 1]) && !isWordChar(text[i + query.length])
    );
  }
  return indices.map((i) => ({ index: i, length: query.length }));
}

function searchText(text, cfg) {
  const matches = findMatches(text, cfg);
  const snippets = [];
  for (let k = 0; k < matches.length && k < MAX_SNIPPETS; k++) {
    const { index, length } = matches[k];
    const start = Math.max(0, index - SNIPPET_RADIUS);
    const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
    const before = (start > 0 ? "…" : "") + text.slice(start, index);
    const match = text.slice(index, index + length);
    const after = text.slice(index + length, end) + (end < text.length ? "…" : "");
    snippets.push({ before, match, after });
  }
  return { matchCount: matches.length, snippets };
}

// --- fetching ---

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      throw new Error(`skipped ${type.split(";")[0]}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// --- job runner ---
// job: { url?, text?, title?, depth, collectLinks, query, mode, caseSensitive }
// A job with `text` searches that text directly (the active tab, already read).
// A job with `url` fetches + parses + searches, and optionally returns links.

async function runJob(job) {
  const cfg = { query: job.query, mode: job.mode, caseSensitive: job.caseSensitive };

  if (job.text != null) {
    const found = searchText(job.text, cfg);
    return {
      result: { url: job.url, title: job.title, depth: job.depth, preview: makePreview(job.text), ...found },
      links: [],
    };
  }

  const html = await fetchHtml(job.url);
  const text = htmlToText(html);
  const found = searchText(text, cfg);
  return {
    result: { url: job.url, title: job.url, depth: job.depth, preview: makePreview(text), ...found },
    links: job.collectLinks ? extractLinks(html, job.url) : [],
  };
}

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    const { result, links } = await runJob(job);
    self.postMessage({ id, ok: true, result, links });
  } catch (err) {
    self.postMessage({
      id,
      ok: true,
      result: {
        url: job.url,
        title: job.url,
        depth: job.depth,
        error: err && err.message ? err.message : String(err),
        matchCount: 0,
      },
      links: [],
    });
  }
};
