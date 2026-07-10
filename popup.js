// Side panel UI: owns a pool of Web Workers (real threads) that fetch + parse +
// KMP-search pages in parallel, drives the BFS crawl, and renders results live.

const $ = (id) => document.getElementById(id);
const queryEl = $("query");
const depthEl = $("depth");
const maxPagesEl = $("maxPages");
const caseEl = $("caseSensitive");
const modeEl = $("mode");
const sameOriginEl = $("sameOrigin");
const stopFirstEl = $("stopFirst");
const goEl = $("go");
const stopEl = $("stop");
const statusEl = $("status");
const progressEl = $("progress");
const resultsEl = $("results");

// Thread pool sized to the machine, capped so we don't hammer servers.
const POOL_SIZE = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const DEFAULT_MAX_PAGES = 500; // default cap on pages fetched (user-editable)

let running = false;
let pool = null;
let activeAbort = null; // set to the current run's stop() while a search is live
let sortedRows = []; // {rank, node} for pages WITH matches, sorted by count desc
let othersEl = null; // collapsible <details> holding no-match pages
let othersBody = null;
let othersCount = 0;

// Persist the last-used settings.
chrome.storage.local.get(
  ["query", "depth", "maxPages", "caseSensitive", "mode", "sameOrigin", "stopFirst"],
  (s) => {
    if (s.query) queryEl.value = s.query;
    if (s.depth != null) depthEl.value = s.depth;
    if (s.maxPages != null) maxPagesEl.value = s.maxPages;
    caseEl.checked = !!s.caseSensitive;
    if (s.mode) modeEl.value = s.mode;
    sameOriginEl.checked = !!s.sameOrigin;
    stopFirstEl.checked = !!s.stopFirst;
    updatePlaceholder();
  }
);

function updatePlaceholder() {
  queryEl.placeholder =
    modeEl.value === "regex" ? "Regex pattern…  e.g. \\bfoo(bar)?\\b" : "Search text…";
}
modeEl.addEventListener("change", updatePlaceholder);

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderResult(r) {
  const div = document.createElement("div");
  const hasError = !!r.error;
  const count = r.matchCount || 0;
  div.className = "result" + (hasError ? " err" : count === 0 ? " nohit" : "");

  const match = (r.snippets && r.snippets[0] && r.snippets[0].match) || "";
  const href = linkWithHighlight(r); // shareable #:~:text= URL for copy/middle-click
  div.dataset.href = href;
  div.dataset.match = match; // used by our own injected highlighter
  if (!hasError) div.title = "Open and highlight the match";

  const head = document.createElement("div");
  head.className = "r-head";

  const title = document.createElement("div");
  title.className = "r-title";
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = (r.depth === 0 ? "📄 " : "") + (r.title || r.url || "Current page");
  title.appendChild(a);
  head.appendChild(title);

  const countEl = document.createElement("div");
  countEl.className = "r-count" + (count === 0 ? " zero" : "");
  countEl.textContent = hasError ? "—" : count === 1 ? "1 hit" : `${count} hits`;
  head.appendChild(countEl);
  div.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "r-meta";
  meta.textContent = `depth ${r.depth}` + (r.depth === 0 ? "" : " · " + shortUrl(r.url));
  div.appendChild(meta);

  if (hasError) {
    const err = document.createElement("div");
    err.className = "r-err";
    err.textContent = "⚠ " + r.error;
    div.appendChild(err);
  } else {
    if (r.preview) {
      const prev = document.createElement("div");
      prev.className = "preview";
      prev.textContent = r.preview || "(no text)";
      div.appendChild(prev);
    }
    if (r.snippets && r.snippets.length) {
      for (const s of r.snippets) {
        const snip = document.createElement("div");
        snip.className = "snip";
        snip.innerHTML =
          escapeHtml(s.before) + "<mark>" + escapeHtml(s.match) + "</mark>" + escapeHtml(s.after);
        div.appendChild(snip);
      }
    }
  }
  return div;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname : "");
  } catch {
    return url;
  }
}

// Percent-encode text for a Scroll-to-Text-Fragment directive. `-` is a
// delimiter in the fragment grammar, so it must be encoded beyond the usual set.
function encodeTextFragment(text) {
  return encodeURIComponent(text.trim()).replace(/-/g, "%2D");
}

// Build a URL that, when opened, scrolls to and highlights the first match.
// Falls back to the plain URL when there's no match to point at.
function linkWithHighlight(r) {
  let base = r.url || "";
  const hash = base.indexOf("#");
  if (hash >= 0) base = base.slice(0, hash);
  const match = r.snippets && r.snippets[0] && r.snippets[0].match;
  if (!base) return r.url || "#";
  return match ? base + "#:~:text=" + encodeTextFragment(match) : base;
}

// Lazily create the collapsed "no match" group at the bottom of the list.
function ensureOthers() {
  if (othersEl) return;
  othersEl = document.createElement("details");
  othersEl.className = "others";
  const sum = document.createElement("summary");
  sum.className = "others-sum";
  othersEl.appendChild(sum);
  othersBody = document.createElement("div");
  othersBody.className = "others-body";
  othersEl.appendChild(othersBody);
  resultsEl.appendChild(othersEl);
}

function updateOthersSummary() {
  othersEl.querySelector(".others-sum").textContent =
    `${othersCount} page${othersCount === 1 ? "" : "s"} with no match`;
}

// Pages with matches (and the current page) show at the top, sorted by hit
// count. Pages with no match go into the collapsed dropdown.
function addResult(r) {
  const node = renderResult(r);
  const isHit = (r.matchCount || 0) > 0 || r.depth === 0;

  if (!isHit) {
    ensureOthers();
    othersBody.appendChild(node);
    othersCount++;
    updateOthersSummary();
    return;
  }

  const rank = r.depth === 0 ? Infinity : r.matchCount || 0;
  let insertBefore = null;
  let idx = sortedRows.length;
  for (let i = 0; i < sortedRows.length; i++) {
    if (rank > sortedRows[i].rank) {
      insertBefore = sortedRows[i].node;
      idx = i;
      break;
    }
  }
  sortedRows.splice(idx, 0, { rank, node });
  // Keep the "no match" group pinned to the very bottom.
  resultsEl.insertBefore(node, insertBefore || othersEl);
}

function setRunning(on) {
  running = on;
  goEl.disabled = on;
  goEl.textContent = on ? "Searching…" : "Find";
  stopEl.hidden = !on;
  stopEl.disabled = !on;
}

// Stop the in-progress search. In-flight fetches finish (they can't be killed
// mid-request without hanging the awaits), but nothing new is dispatched.
stopEl.addEventListener("click", () => {
  if (activeAbort) activeAbort();
});

// ---------------------------------------------------------------------------
// Worker pool — a fixed set of threads; jobs queue and run as threads free up.
// ---------------------------------------------------------------------------

class WorkerPool {
  constructor(size) {
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map(); // id -> resolve
    this.seq = 0;
    for (let i = 0; i < size; i++) {
      const w = new Worker("worker.js", { type: "module" });
      w.onmessage = (e) => this._onDone(w, e.data);
      this.workers.push(w);
      this.idle.push(w);
    }
  }
  run(job) {
    return new Promise((resolve) => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.queue.push({ id, job });
      this._pump();
    });
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const { id, job } = this.queue.shift();
      w.postMessage({ id, job });
    }
  }
  _onDone(w, data) {
    const resolve = this.pending.get(data.id);
    this.pending.delete(data.id);
    this.idle.push(w);
    this._pump();
    if (resolve) resolve(data);
  }
  // Resolve every queued-but-not-yet-started job with an abort sentinel so
  // awaiting callers unblock. In-flight jobs finish naturally.
  cancelPending() {
    for (const { id } of this.queue) {
      const resolve = this.pending.get(id);
      this.pending.delete(id);
      if (resolve) resolve({ aborted: true });
    }
    this.queue = [];
  }
  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Active-tab reader
// ---------------------------------------------------------------------------

function extractFromPage() {
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (a.href) links.push(a.href);
  }
  return {
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : "",
    links,
  };
}

async function readActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  if (!/^https?:/.test(tab.url || "")) {
    throw new Error("Recursive Find only works on http(s) pages.");
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractFromPage,
  });
  return result;
}

function normalizeUrl(href) {
  try {
    const url = new URL(href);
    url.hash = "";
    let s = url.href;
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function start() {
  if (running) return;
  const mode = modeEl.value;
  // Regex patterns can be meaningfully whitespace; don't trim those.
  const query = mode === "regex" ? queryEl.value : queryEl.value.trim();
  if (!query) {
    statusEl.textContent = "Enter something to search for.";
    return;
  }
  if (mode === "regex") {
    try {
      new RegExp(query, caseEl.checked ? "g" : "gi");
    } catch (e) {
      statusEl.textContent = "⚠ Invalid regex: " + e.message;
      return;
    }
  }
  const depth = Math.max(0, Math.min(5, parseInt(depthEl.value, 10) || 1));
  const maxPages = Math.max(1, Math.min(100000, parseInt(maxPagesEl.value, 10) || DEFAULT_MAX_PAGES));
  const caseSensitive = caseEl.checked;
  const sameOrigin = sameOriginEl.checked;
  const stopAtFirst = stopFirstEl.checked;
  const cfg = { query, mode, caseSensitive };

  chrome.storage.local.set({ query, depth, maxPages, caseSensitive, mode, sameOrigin, stopFirst: stopAtFirst });

  resultsEl.innerHTML = "";
  sortedRows = [];
  othersEl = null;
  othersBody = null;
  othersCount = 0;
  progressEl.style.width = "0%";
  statusEl.textContent = "Reading current page…";
  setRunning(true);

  let hitPages = 0;
  let totalHits = 0;
  let scanned = 0;
  let discovered = 1; // the current page
  let aborted = false; // set when the crawl is stopped early
  let abortReason = null; // "first" (stop-at-first-hit) or "manual" (Stop button)
  let capped = false; // set when we skip links because maxPages was reached

  const requestStop = (reason) => {
    if (aborted) return;
    aborted = true;
    abortReason = reason;
    if (pool) pool.cancelPending(); // unblock queued jobs; in-flight ones finish
    if (reason === "manual") statusEl.textContent = "Stopping…";
  };
  activeAbort = () => requestStop("manual");

  const handle = (data) => {
    if (aborted || data.aborted) return;
    const r = data.result;
    addResult(r);
    scanned++;
    if ((r.matchCount || 0) > 0) {
      hitPages++;
      totalHits += r.matchCount;
      if (stopAtFirst) requestStop("first");
    }
    const pct = discovered ? Math.round((scanned / discovered) * 100) : 0;
    progressEl.style.width = Math.min(100, pct) + "%";
    statusEl.textContent = `Scanning ${scanned}/${discovered} pages · ${POOL_SIZE} threads…`;
  };

  try {
    const page = await readActiveTab();
    pool = new WorkerPool(POOL_SIZE);

    const visited = new Set([normalizeUrl(page.url)]);
    let pageCount = 1; // current page counts as one

    let originHost = null;
    try {
      originHost = new URL(page.url).origin;
    } catch {
      /* no filtering */
    }
    const allowed = (href) => {
      if (!sameOrigin || !originHost) return true;
      try {
        return new URL(href).origin === originHost;
      } catch {
        return false;
      }
    };

    // Recursively crawl a URL and (up to depth) its links — the pool bounds
    // how many run at once, so recursion stays saturated across levels.
    const crawl = async (job) => {
      if (aborted) return;
      const data = await pool.run(job);
      if (aborted || data.aborted) return;
      handle(data);
      if (!aborted && job.depth < depth && data.links && data.links.length) {
        const children = [];
        for (const href of data.links) {
          const n = normalizeUrl(href);
          if (visited.has(n) || !allowed(href)) continue;
          if (pageCount >= maxPages) {
            capped = true;
            continue;
          }
          visited.add(n);
          pageCount++;
          discovered++;
          children.push(
            crawl({ url: href, depth: job.depth + 1, collectLinks: job.depth + 1 < depth, ...cfg })
          );
        }
        if (children.length) await Promise.all(children);
      }
    };

    // Depth 0: search the live page text (no fetch). Its links seed level 1.
    const root = await pool.run({
      text: page.text,
      title: page.title || page.url,
      url: page.url,
      depth: 0,
      collectLinks: false,
      ...cfg,
    });
    handle(root);

    if (!aborted && depth >= 1) {
      const level1 = [];
      for (const href of page.links) {
        const n = normalizeUrl(href);
        if (visited.has(n) || !allowed(href)) continue;
        if (pageCount >= maxPages) {
          capped = true;
          continue;
        }
        visited.add(n);
        pageCount++;
        discovered++;
        level1.push(crawl({ url: href, depth: 1, collectLinks: 1 < depth, ...cfg }));
      }
      await Promise.all(level1);
    }

    progressEl.style.width = "100%";
    if (aborted && abortReason === "manual") {
      statusEl.textContent = `Stopped — ${totalHits} hit${totalHits === 1 ? "" : "s"} across ${hitPages} page${hitPages === 1 ? "" : "s"} (${scanned} scanned).`;
    } else if (aborted) {
      statusEl.textContent = `Stopped at first hit — found in ${scanned} page${scanned === 1 ? "" : "s"} scanned.`;
    } else {
      let msg = `Done — ${totalHits} hit${totalHits === 1 ? "" : "s"} across ${hitPages} page${hitPages === 1 ? "" : "s"} (${pageCount} scanned).`;
      if (capped) msg += ` ⚠ Reached the ${maxPages}-page limit — results may be incomplete.`;
      statusEl.textContent = msg;
    }
    if (!resultsEl.children.length) {
      resultsEl.innerHTML = '<div class="empty">No matches found.</div>';
    }
  } catch (e) {
    statusEl.textContent = "⚠ " + (e && e.message ? e.message : String(e));
  } finally {
    activeAbort = null;
    if (pool) {
      pool.terminate();
      pool = null;
    }
    setRunning(false);
  }
}

// Runs IN the opened page: find the first occurrence of `needle`, highlight it
// persistently (Custom Highlight API, falling back to a text selection), and
// scroll it into view. Native #:~:text= fragments are unreliable, so we do it
// ourselves — we have host + scripting permission for the target tab.
function highlightInPage(needle) {
  try {
    const target = (needle || "").trim();
    if (!target) return;
    const lc = target.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentNode && n.parentNode.nodeName;
        if (p === "SCRIPT" || p === "STYLE" || p === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.toLowerCase().includes(lc)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const node = walker.nextNode();
    if (!node) return;
    const idx = node.nodeValue.toLowerCase().indexOf(lc);
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + target.length);

    if (window.CSS && CSS.highlights && window.Highlight) {
      const style = document.createElement("style");
      style.textContent =
        "::highlight(recursive-find){background:#ffd166;color:#000;border-radius:2px;}";
      document.head.appendChild(style);
      CSS.highlights.set("recursive-find", new Highlight(range));
    } else {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const anchor = node.parentElement;
    if (anchor && anchor.scrollIntoView) {
      anchor.scrollIntoView({ block: "center", inline: "nearest" });
    }
  } catch (_) {
    /* best-effort */
  }
}

// Open a URL in a new tab and, once it finishes loading, inject the highlighter.
function openWithHighlight(url, match) {
  chrome.tabs.create({ url }, (tab) => {
    if (!match || !tab || tab.id == null) return;
    const tabId = tab.id;
    const onUpdated = (updatedId, info) => {
      if (updatedId !== tabId || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.scripting
        .executeScript({ target: { tabId }, func: highlightInPage, args: [match] })
        .catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// Click a result card to open it and spotlight the match. Ignore the group
// toggle and clicks made while selecting text; intercept everything else
// (including the inner link) so the highlighter always runs.
resultsEl.addEventListener("click", (e) => {
  if (e.target.closest("summary")) return;
  if (window.getSelection && String(window.getSelection())) return;
  const card = e.target.closest(".result");
  if (!card || !card.dataset.href) return;
  e.preventDefault();
  openWithHighlight(card.dataset.href, card.dataset.match || "");
});

goEl.addEventListener("click", start);
queryEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") start();
});
depthEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") start();
});
