# recursive-find-mcp

**Ctrl+F for whole websites, for agents.** Search a page and every page it
links to, and get back only the pages that match, with short snippets. One
call answers "which pages on this site / in these docs mention X?" without the
agent fetching and reading every page itself.

Ships three ways: an **MCP server** (one tool, `recursive_find`), a **CLI**
(`rfind`), and an **[Agent Skill](https://agentskills.io)** (`SKILL.md`).
Headless version of the [Recursive Find](https://github.com/grtwrn/recursive-find)
Chrome extension. Node 18+.

```
$ rfind https://docs.python.org/3/library/ "free-threaded" --within /3/library/ --main --depth 2 --max-pages 1000 --snippets 1
18 hits on 9 pages · 323 pages scanned, depth 2, 1s

8× https://docs.python.org/3/library/asyncio-threading.html  — asyncio and free-threaded Python — Python 3.14.8 documentation
   asyncio and [[free-threaded]] Python ¶ asyncio uses an event loop as a scheduler to enabl…
…
```

## MCP server

**Claude Code**

```sh
claude mcp add recursive-find -- npx -y recursive-find-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`
or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "recursive-find": { "command": "npx", "args": ["-y", "recursive-find-mcp"] }
  }
}
```

The tool takes `url` and `query`, plus optional `depth` (default 1, max 3),
`within` (path prefix, e.g. `/docs/`), `max_pages` (default 100, max 1000),
`max_seconds` (default 120), `mode` (`text` | `word` | `regex`),
`case_sensitive`, `main_only` (ignore nav, sidebars and footers), `any_site`,
`first`, `limit` and `snippets`. It returns the compact text report above, plus
the same data as JSON in `structuredContent`.

## CLI

```sh
npx -y -p recursive-find-mcp rfind https://docs.python.org/3/library/ "free-threaded" --within /3/library/ --depth 2
```

Or `npm install -g recursive-find-mcp` and run `rfind`. `rfind --help` lists the
flags. Exit codes: 0 = crawl ran (even with 0 hits), 1 = start page failed,
2 = bad arguments. `--json` for JSON output.

## Agent skill

Copy this package's folder (`SKILL.md` + `scripts/`) into your agent's skills
folder as `recursive-find/`, and symlink `scripts/rfind.mjs` onto your PATH as
`rfind`. The CLI itself has no dependencies.

## Behavior

Same site only by default, breadth-first, 4 parallel fetches, 10 s per page, a
120 s limit for the whole crawl, honors `robots.txt`, skips non-HTML links.
Server HTML only: no JavaScript rendering, no cookies or logins. Pages over
32 MB are searched partially and flagged in the summary, as are crawls that
hit `max_pages` or `max_seconds`.
