#!/usr/bin/env node
// recursive-find-mcp — stdio MCP server exposing rfind as one tool,
// `recursive_find`. Only the MCP protocol may go to stdout; logs go to stderr.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { crawl, formatText, resolveOptions, startError, toJSON } from "./crawl.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const DESCRIPTION = `Ctrl+F for a whole website. Fetches a start page and every page it links to (breadth-first, same site by default), searches their text, and returns only the pages that match, with short snippets (matches shown as [[match]]). Use it for "which pages on this site / in these docs / among these listings mention X?": one call replaces fetching and reading dozens of pages.

How to use it well:
- Start from the most specific page you know (a docs index, a category page), not a site's home page; big home pages link to hundreds of pages and burn the page budget before reaching the right section.
- Set \`within\` to a path prefix (e.g. "/docs/") whenever the content lives under one path. Keep depth 1; use depth 2 only with \`within\` or on a small site.
- mode "word" for short words ("cat" won't match "category"), "regex" for patterns; \`first\` when one hit answers the question.
- main_only when the question is which pages *discuss* X: it searches only the main content (<main>, role="main", <article>), so nav menus, sidebars and "next page" links that merely name X don't count.
- Read the summary line: "hit max_pages" or "hit max_seconds" means results are incomplete; narrow (within, a deeper start URL) before raising max_pages. It also flags pages too large to search fully. Skipped non-HTML links are normal, not failures.
- Cite the page URLs; fetch a page yourself if you need more than the snippet.

Not for: reading one known page, JavaScript-rendered sites or pages behind a login (it sees server HTML only, no cookies), or general web search. Honors robots.txt; 4 parallel fetches, 10 s per page.`;

const inputSchema = {
  url: z.string().describe("Start page. https:// is assumed if no scheme is given."),
  query: z.string().min(1).describe("Text to find (or a JavaScript regex when mode is \"regex\")."),
  depth: z.number().int().min(0).optional()
    .describe("0 = start page only, 1 = + pages it links to (default 1, max 3)."),
  within: z.string().optional()
    .describe("Only follow links whose path starts with this prefix, e.g. \"/docs/\"."),
  max_pages: z.number().int().min(1).optional().describe("Stop fetching after N pages (default 100, max 1000)."),
  max_seconds: z.number().int().min(1).optional().describe("Stop the whole crawl after N seconds (default 120)."),
  mode: z.enum(["text", "word", "regex"]).optional()
    .describe("text = substring (default), word = whole word, regex = JavaScript RegExp."),
  case_sensitive: z.boolean().optional().describe("Match case (default false)."),
  main_only: z.boolean().optional()
    .describe("Search only the main content, ignoring nav, sidebars and footers (default false)."),
  any_site: z.boolean().optional().describe("Follow links to other sites (default false: same origin only)."),
  first: z.boolean().optional().describe("Stop at the first page that matches (default false)."),
  limit: z.number().int().min(1).optional().describe("Return at most N matching pages (default 20)."),
  snippets: z.number().int().min(0).optional().describe("Snippets per page (default 3)."),
};

const MCP_NAMES = { maxPages: "max_pages", maxSeconds: "max_seconds", limit: "limit" };

async function recursiveFind(args) {
  try {
    const opts = resolveOptions({
      url: args.url, query: args.query, depth: args.depth, within: args.within,
      maxPages: args.max_pages, maxSeconds: args.max_seconds, mode: args.mode,
      caseSensitive: args.case_sensitive, mainOnly: args.main_only, anySite: args.any_site,
      first: args.first, limit: args.limit, snippets: args.snippets,
    });
    const result = await crawl(opts);
    return {
      content: [{ type: "text", text: formatText(result, opts, MCP_NAMES) }],
      structuredContent: toJSON(result, opts),
      ...(startError(result) && { isError: true }),
    };
  } catch (e) {
    return { content: [{ type: "text", text: `recursive_find: ${e?.message || String(e)}` }], isError: true };
  }
}

const server = new McpServer({ name: "recursive-find", version });
server.registerTool(
  "recursive_find",
  {
    title: "Recursive find (Ctrl+F for a website)",
    description: DESCRIPTION,
    inputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  recursiveFind
);

process.on("unhandledRejection", (e) => console.error("recursive-find-mcp:", e?.stack || e));
await server.connect(new StdioServerTransport());
console.error(`recursive-find-mcp ${version} ready on stdio`);
