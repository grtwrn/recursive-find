# Recursive Find

Ctrl+F, but recursive. Searches the current page **and every page it links to**,
down to a customizable depth. Text-only parsing, matching powered by
Knuth–Morris–Pratt (KMP), crawling done in parallel across a pool of real
worker threads. Lives in the Chrome **side panel**, so it stays open while you
work (Chrome 114+).

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension and click its icon on any `http(s)` page

## Use

- Type a search term, set **Depth**, and hit **Find**.
- **Depth 0** = current page only. **Depth 1** (default) = current page + every
  page it directly links to. **Depth 2** = also their links, etc. (capped at 5).
- **Match mode**:
  - **Text** — plain substring match (KMP).
  - **Whole word** — substring match with word-boundary filtering (`cat`
    won't match `category`).
  - **Regex** — JavaScript `RegExp` pattern; invalid patterns are reported
    before the crawl starts.
- **Match case** toggles case sensitivity.
- **Same site only** restricts the crawl to the starting page's origin.
- **Stop at first hit** ends the whole crawl the moment any page matches.
- Each result shows a text **preview**; pages with **no match** are tucked into
  a collapsed "N pages with no match" dropdown at the bottom.
- Results stream in live, sorted by hit count. **Click a result** to open it in
  a new tab, scrolled to and highlighting the match (via a `#:~:text=` fragment).

## Architecture

- `popup.*` — the side panel. Reads the active tab's text + links, owns the
  Web Worker pool, and runs the BFS crawl. A `visited` set (URLs normalized by
  stripping the hash + trailing slash) guarantees each page is fetched **once**.
- `worker.js` — one dedicated worker per thread. Given a URL it fetches, strips
  HTML to text, runs KMP, and extracts links — all off the main thread. The
  pool is sized to `hardwareConcurrency - 1` (2–8), so pages are fetched and
  searched genuinely in parallel.
- `kmp.js` — O(n + m) exact substring search.
- `background.js` — only configures the side panel to open on the toolbar click.

## Regenerating icons

Icons are generated procedurally — `node gen_icons.js` rewrites `icons/*.png`.

## How it works

- `popup.*` — UI; opens a streaming `Port` to the service worker.
- `background.js` — reads the active tab's text + links, then BFS-crawls the
  link graph level by level (6 concurrent fetches, 300-page cap), strips each
  fetched page to text, and runs KMP over it.
- `kmp.js` — O(n + m) exact substring search with an LPS failure table.

## Limits / notes

- Cross-origin pages are fetched from the service worker using
  `host_permissions: <all_urls>`.
- Text extraction is a regex strip (no DOM in MV3 workers), so JS-rendered
  content on linked pages won't be seen — only server-delivered HTML text.
- Non-HTML links (PDFs, images) are skipped.
