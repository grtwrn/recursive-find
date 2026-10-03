// Misbehaving and unusual pages for robustness tests: other character
// encodings, rate limits, a body that never arrives, catastrophic regex input,
// hostile robots.txt, huge link counts and odd URLs. Served on 127.0.0.1.

import http from "node:http";

const page = (title, body, head = "") =>
  `<!doctype html><html><head>${head}<title>${title}</title></head><body>${body}</body></html>`;
const latin1 = (s) => Buffer.from(s, "latin1");

export async function startHardFixture() {
  const hits = new Map(); // path -> request count
  const routes = {
    "/robots.txt": () => [200, "text/plain", "User-agent: *\nDisallow: /*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b\nDisallow: /blocked\n"],
    // Encodings. "café" etc. as single bytes; 0x93/0x94 are windows-1252 quotes.
    "/latin1-header": () => [200, "text/html; charset=ISO-8859-1", latin1(page("Caf\xe9", "un caf\xe9 cr\xe8me, na\xefve"))],
    "/cp1252-meta": () => [200, "text/html", Buffer.concat([
      latin1(page("Quotes", "", '<meta charset="windows-1252">').replace("</body>", "")),
      Buffer.from([0x93, 0x63, 0x61, 0x66, 0xe9, 0x94]), latin1("</body></html>")])],
    "/sjis-http-equiv": () => [200, "text/html", Buffer.concat([
      latin1(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>T</title></head><body>`),
      Buffer.from([0x93, 0x8c, 0x8b, 0x9e, 0x83, 0x5e, 0x83, 0x8f, 0x81, 0x5b]), latin1("</body></html>")])],
    "/undeclared-latin1": () => [200, "text/html", latin1(page("No charset", "d\xe9j\xe0 vu"))],
    "/utf8-undeclared": () => [200, "text/html", Buffer.from(page("UTF-8", "déjà vu, 東京"))],
    "/header-beats-meta": () => [200, "text/html; charset=utf-8",
      Buffer.from(page("Header", "déjà vu", '<meta charset="windows-1252">'))],
    // Catastrophic backtracking input for /(a+)+$/.
    "/redos": () => [200, "text/html", page("ReDoS", "a".repeat(40) + "!")],
    "/redos-links": () => [200, "text/html", page("ReDoS links", `${"a".repeat(40)}! <a href="/fine">fine</a>`)],
    "/fine": () => [200, "text/html", page("Fine", "nothing to see, apple")],
    // Odd links.
    "/odd-links": () => [200, "text/html", page("Odd", [
      `<a href="http://user:secret@127.0.0.1:PORT/creds">creds</a>`,
      `<a href="/caf%C3%A9/menu">encoded</a>`, `<a href="/café/carte">unicode</a>`,
      `<a href="/long?q=${"x".repeat(10000)}">long</a>`, `<a href="/ok?q=${"y".repeat(2000)}">ok</a>`,
      `<a href="ftp://127.0.0.1/file">ftp</a>`, `<a href="mailto:a@b.c">mail</a>`,
      `<a href="javascript:alert(1)">js</a>`, `<a href="//[::1">broken</a>`,
      `<a href="http://xn--bcher-kva.example/">idn</a>`, `<a href="/blocked">robots</a>`,
      `<a href="/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac">long path</a>`,
    ].join(" "))],
    "/café/menu": () => [200, "text/html", page("Menu", "apple tart")],
    "/café/carte": () => [200, "text/html", page("Carte", "apple pie")],
    "/many-links": () => [200, "text/html",
      page("Many", "apple " + Array.from({ length: 50000 }, (_, i) => `<a href="/n/${i}">${i}</a>`).join(""))],
    "/invalid": () => [200, "text/html",
      `<<<>>> <p <b apple <!-- x <script>apple(</scr ipt> &#xZZ; &#99999999999; &bogus; \0\x01 apple </html></html><`],
    // Rate limits: /429-once succeeds on the second request.
    "/429-once": (n) => n === 1 ? [429, "text/html", "slow down", { "retry-after": "1" }] : [200, "text/html", page("Retried", "apple after a retry")],
    "/429-long": () => [429, "text/html", "slow down", { "retry-after": "3600" }],
    "/503-always": () => [503, "text/html", "unavailable"],
    "/redirect-to-a": () => [301, "text/html", "", { location: "/a" }],
    "/redirect-off-site": () => [302, "text/html", "", { location: "http://localhost:PORT/fine" }],
    "/a": () => [200, "text/html", page("A", "apple A")],
    "/links-redirects": () => [200, "text/html",
      page("Redirects", `apple <a href="/a">a</a> <a href="/redirect-to-a">r</a> <a href="/redirect-off-site">off</a>`)],
  };
  let port;
  const server = await listen((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    if (path === "/stall") { // headers, then a body that never comes
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><body>apple ");
      return;
    }
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("not found");
    }
    const [status, type, body, headers = {}] = route(n);
    for (const k of Object.keys(headers)) headers[k] = headers[k].replace("PORT", port);
    res.writeHead(status, { "content-type": type, ...headers });
    res.end(typeof body === "string" ? body.replace(/PORT/g, port) : body);
  });
  port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}
