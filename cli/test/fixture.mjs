// A tiny local website for integration tests, served on 127.0.0.1. A second
// server on another port is a different origin, for same-origin tests.

import http from "node:http";

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const a = (href) => `<a href="${href}">${href}</a>`;

export async function startFixture() {
  const other = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("External", "apple on another origin"));
  });
  const otherUrl = `http://127.0.0.1:${other.address().port}`;
  const routes = {
    "/robots.txt": () => ["text/plain", "User-agent: *\nDisallow: /private/\n"],
    "/": () => ["text/html", page("Home", `apple on the home page
      ${a("/docs/")} ${a("/docs/a")} ${a("/blog/post")} ${a("/private/secret")}
      ${a("/api/data")} ${a("/report.pdf")} ${a("/missing")} ${a(`${otherUrl}/ext`)}
      ${a("mailto:x@example.com")} ${a("#top")}`)],
    "/docs/": () => ["text/html", page("Docs", `docs index, apple ${a("/docs/a")} ${a("/docs/b")} ${a("/blog/post")}`)],
    "/docs/a": () => ["text/html", page("Doc A", `apple banana pineapple ${a("/docs/deep")}`)],
    "/docs/b": () => ["text/html", page("Doc B", "cherry only")],
    "/docs/deep": () => ["text/html", page("Deep", "apple in the deep page")],
    "/blog/post": () => ["text/html", page("Blog", "an apple blog post")],
    "/private/secret": () => ["text/html", page("Secret", "apple secret")],
    "/api/data": () => ["application/json", '{"apple": true}'],
    "/main": () => ["text/html", page("Main", `<nav>apple menu</nav><main>banana <div><main>nested</main></div> kiwi</main><footer>apple footer</footer>`)],
    "/words": () => ["text/html", page("Words", "cat category concat cat. Errors E1234 and E99, not E.")],
    "/big": () => ["text/html", page("Big", "apple " + "x".repeat(500_000) + " banana")],
    "/slow-links": () => ["text/html", page("Slow links", `apple ${a("/slow1")} ${a("/slow2")}`)],
  };
  const server = await listen((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/slow") && path !== "/slow-links") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page("Slow", "apple, slowly"));
      }, 5000).unref();
      return;
    }
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(page("Not found", "apple 404"));
      return;
    }
    const [type, body] = route();
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(body);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    otherUrl,
    close: () => Promise.all([server, other].map((s) => {
      s.closeAllConnections?.();
      return new Promise((r) => s.close(r));
    })),
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}
