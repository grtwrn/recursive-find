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

## Command line + AI agent skill (`cli/`)

The same crawler, headless, for scripts and AI agents. One call answers "which
pages on this site mention X?" and returns only the matching pages with short
snippets, so an agent doesn't have to fetch and read every page itself.

```sh
node cli/scripts/rfind.mjs https://docs.openclaw.ai/tools/skills "extraDirs" --within /tools/
```

```
8 hits on 2 pages · 100 pages scanned, depth 1, 4.3s · hit --max-pages 100, results may be incomplete

4× https://docs.openclaw.ai/tools/skills  — Skills - OpenClaw
   …7 — lowest Extra directories skills.load.[[extraDirs]] + plugin skills…
```

- Node 18+, no dependencies. `--help` lists the flags: `--depth`, `--within`,
  `--max-pages`, `--max-seconds`, `--mode text|word|regex`, `--case`, `--main`
  (main content only, ignoring nav and sidebars), `--first`, `--json`, etc.
- Agent-safe defaults: same site only, depth 1, 100-page cap, 120 s crawl
  limit, 4 parallel fetches, honors `robots.txt`, skips non-HTML links. Pages
  over 32 MB are searched partially and flagged in the summary.
- **MCP server:** `cli/` is also the npm package `recursive-find-mcp`, a stdio
  MCP server with one tool, `recursive_find`
  (`claude mcp add recursive-find -- npx -y recursive-find-mcp`). Setup for
  Claude Desktop, Claude Code and Cursor: [cli/README.md](cli/README.md).
- `cli/` is also an [Agent Skill](https://agentskills.io) (`cli/SKILL.md`):
  copy it into your agent's skills folder as `recursive-find/` and symlink
  `scripts/rfind.mjs` onto your PATH as `rfind`.
- Tests: `cd cli && npm install && npm test` (offline, local fixture site).

### Benchmark: agents with and without `rfind`

Three "which pages on this docs site mention X?" questions, each answered by
two fresh Claude Opus 5.5 agents (OpenClaw subagents with shell access): one
told to use `rfind`, one told not to. Measured 2026-10-03 against the live sites.

| Question | Time with / without | Turns | Input tokens | Output tokens |
|---|---|---|---|---|
| docs.python.org `/3/library/`: "free-threaded" (323 pages) | **30 s** / 82 s | 5 / 9 | 275k / 514k | 2.5k / 7.7k |
| nodejs.org `/api/`: "AbortSignal.any" (71 pages) | **32 s** / 46 s | 5 / 6 | 273k / 340k | 1.9k / 2.6k |
| docs.openclaw.ai `/tools/`: "allowSymlinkTargets" (117 pages) | **30 s** / 43 s | 5 / 8 | 272k / 440k | 1.3k / 3.3k |
| **Total** | **92 s / 171 s (−46%)** | 15 / 23 | 820k / 1,294k (−37%) | 5.7k / 13.6k (−58%) |

All six agents reached the right answer. Without `rfind`, the agents didn't
fetch pages one by one. They wrote their own crawlers (Python `urllib`, `curl`
loops, sitemap and `objects.inv` parsing), so this compares against a strong
baseline. The savings come from skipping that
scaffolding and needing fewer turns. Input tokens are mostly the agent's system
prompt being re-read each turn (prompt-cached), so fewer turns means fewer
tokens. The `rfind` rows are from the current version. An earlier run exposed
two bugs that cost the agent extra checking: a silent 3 MB page cap and
non-HTML links being reported as errors. Both are fixed. Small sample: one run
per arm per question.

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
