import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFixture } from "./fixture.mjs";

const MCP = fileURLToPath(new URL("../scripts/mcp.mjs", import.meta.url));
let site;
let client;

before(async () => {
  site = await startFixture();
  client = new Client({ name: "rfind-test", version: "0.0.0" });
  // A non-protocol line on the server's stdout would break this connection.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], stderr: "pipe" }));
});
after(async () => {
  await client.close();
  await site.close();
});

test("initialize reports the server", () => {
  assert.equal(client.getServerVersion().name, "recursive-find");
});

test("tools/list exposes recursive_find", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["recursive_find"]);
  const [tool] = tools;
  assert.match(tool.description, /within/);
  assert.match(tool.description, /JavaScript-rendered/);
  assert.deepEqual(tool.inputSchema.required.sort(), ["query", "url"]);
  for (const k of ["depth", "within", "max_pages", "mode", "case_sensitive", "main_only", "any_site", "first", "limit", "snippets"]) {
    assert.ok(tool.inputSchema.properties[k], `input ${k}`);
  }
  assert.equal(tool.annotations.readOnlyHint, true);
});

test("tools/call: text content + structured JSON", async () => {
  const res = await client.callTool({
    name: "recursive_find",
    arguments: { url: site.url + "/docs/", query: "apple", within: "/docs/", depth: 2, snippets: 1 },
  });
  assert.ok(!res.isError);
  const text = res.content[0].text;
  assert.match(text, /^4 hits on 3 pages · 4 pages scanned, depth 2, /);
  assert.ok(text.includes(`2× ${site.url}/docs/a  — Doc A`));
  assert.equal(res.structuredContent.summary.pagesWithHits, 3);
  assert.equal(res.structuredContent.hits[0].url, site.url + "/docs/a");
});

test("tools/call: caps use MCP option names in the summary", async () => {
  const res = await client.callTool({ name: "recursive_find", arguments: { url: site.url, query: "apple", max_pages: 2, limit: 1 } });
  assert.match(res.content[0].text, /hit max_pages 2, results may be incomplete/);
  assert.match(res.content[0].text, /more matching pages \(raise limit\)/);
});

test("tools/call: bad input is an error result, not a crash", async () => {
  const badRegex = await client.callTool({ name: "recursive_find", arguments: { url: site.url, query: "(", mode: "regex" } });
  assert.equal(badRegex.isError, true);
  assert.match(badRegex.content[0].text, /invalid regex/);

  const badUrl = await client.callTool({ name: "recursive_find", arguments: { url: "http://exa mple.com", query: "x" } });
  assert.equal(badUrl.isError, true);
  assert.match(badUrl.content[0].text, /bad url/);

  const badType = await client.callTool({ name: "recursive_find", arguments: { url: site.url, query: "x", depth: "deep" } });
  assert.equal(badType.isError, true);

  const failed = await client.callTool({ name: "recursive_find", arguments: { url: site.url + "/missing", query: "x" } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /start page failed: HTTP 404/);

  // Still serving after all that.
  const ok = await client.callTool({ name: "recursive_find", arguments: { url: site.url, query: "apple", depth: 0 } });
  assert.ok(!ok.isError);
});
