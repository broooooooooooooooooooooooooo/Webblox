// Standalone webblox: /blox/ (host page + engine, cross-origin isolated) and a
// Wisp server at /wisp/ that only reaches Roblox. Run with Bun after
// `bun run fetch:webblox`; to embed in your own server instead, mount
// createBloxHandler (server/blox.ts) the same way.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { BLOX_PREFIX, createBloxHandler } from "./server/blox";
import { serveStatic } from "./server/static";

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
  return headers;
}

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "127.0.0.1";

const ROOT_FILES: Record<string, string> = {
  "/": "proxy/index.html",
  "/index.html": "proxy/index.html",
  "/compat.js": "proxy/compat.js",
  "/app.js": "proxy/app.js",
  "/direct-wisp.js": "webblox/direct-wisp.js",
  "/sw.js": "proxy/sw.js",
  "/scramjet/scramjet.js": "proxy/scramjet/scramjet.js",
  "/scramjet/scramjet.wasm": "proxy/scramjet/scramjet.wasm",
  "/controller/controller.api.js": "proxy/controller/controller.api.js",
  "/controller/controller.inject.js": "proxy/controller/controller.inject.js",
  "/controller/controller.sw.js": "proxy/controller/controller.sw.js",
  "/epoxy/index.js": "node_modules/@mercuryworkshop/epoxy-transport/dist/index.js",
  "/launch-plugin.mjs": "proxy/launch-plugin.mjs",
  "/licenses/AGPL-3.0-Scramjet.txt": "licenses/AGPL-3.0-Scramjet.txt",
};


// The page's epoxy client opens TLS to Roblox through this; nothing else is
// reachable, so the server is not an open proxy.
wisp.options.hostname_whitelist = [
  /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com|arkoselabs\.com|funcaptcha\.com|px-cloud\.net)$/i,
];
wisp.options.port_whitelist = [443];
logging.set_level(logging.WARN);

const handleBlox = createBloxHandler({
  host: resolve(import.meta.dir, "webblox"),
  engine: resolve(import.meta.dir, "vendor", "webblox", "engine"),
  epoxy: Bun.resolveSync("@mercuryworkshop/epoxy-transport", import.meta.dir),
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<Response> {
  let response: Response;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const rootFile = ROOT_FILES[url.pathname];
  if (url.pathname === "/healthz") {
    response = new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } else if (url.pathname === BLOX_PREFIX.slice(0, -1)) {
    response = new Response(null, { status: 308, headers: { location: `${BLOX_PREFIX}${url.search}` } });
  } else if (url.pathname.startsWith(BLOX_PREFIX)) {
    const headers = requestHeaders(req);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    response = await handleBlox(new Request(url, { method: req.method, headers, signal: abort.signal }), url.pathname);
  } else if (rootFile !== undefined && (req.method === "GET" || req.method === "HEAD")) {
    const file = await serveStatic(new Request(url, { method: req.method, headers: requestHeaders(req) }), resolve(import.meta.dir, rootFile));
    if (file) {
      file.headers.set("x-content-type-options", "nosniff");
      file.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    }
    response = file ?? new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  } else {
    response = new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return response;
}

const server = createServer(async (req, res) => {
  let response: Response;
  try {
    response = await route(req, res);
  } catch (error) {
    // One bad request must never take the server down or hang the browser.
    console.error("[webblox] request failed:", req.method, req.url, error);
    response = new Response("Internal error", { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  if (res.destroyed) return;
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as never);
  // A file that fails mid-read, or a browser that hangs up, ends this response only.
  body.on("error", (error) => {
    console.error("[webblox] response stream failed:", req.url, error);
    res.destroy();
  });
  res.on("close", () => body.destroy());
  body.pipe(res);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
  else socket.destroy();
});

process.on("unhandledRejection", (error) => console.error("[webblox] unhandled rejection:", error));
process.on("uncaughtException", (error) => console.error("[webblox] uncaught exception:", error));

server.listen(PORT, HOST, () => console.log(`[webblox] http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/blox/`));
