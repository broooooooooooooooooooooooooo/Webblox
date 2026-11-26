// /blox/: Roblox's browser client. The host page (webblox/) and its relay
// worker, the epoxy Wisp client they share with the browser page, and the
// engine pulled by scripts/fetch-webblox.mjs (vendor/webblox/engine/).
//
// Every response is cross-origin isolated: the engine runs on pthreads over a
// shared WebAssembly.Memory, which needs SharedArrayBuffer.
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { MIME_TYPES, serveStatic } from "./static";

export const BLOX_PREFIX = "/blox/";

const HOST_FILES: Record<string, true> = { "index.html": true, "host.js": true, "host.css": true, "sw.js": true, "compat.js": true, "direct-wisp.js": true, "themes.js": true };
// Engine content paths as the metadata list writes them; anything else is
// not something the engine asks for.
const ENGINE_PATH = /^[A-Za-z0-9_@ .()+-]+(?:\/[A-Za-z0-9_@ .()+-]+)*$/;

export type BloxPaths = {
  /** webblox/: index.html, host.js, host.css, sw.js. */
  host: string;
  /** vendor/webblox/engine/. */
  engine: string;
  /** The epoxy Wisp client bundle (@mercuryworkshop/epoxy-transport's dist/index.mjs). */
  epoxy: string;
};

function isolated(headers: Record<string, string>): Headers {
  return new Headers({
    ...headers,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: isolated({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }) });
}

function inside(root: string, relative: string): string | null {
  const path = resolve(root, relative);
  return path.startsWith(`${root}${sep}`) ? path : null;
}

export function createBloxHandler(paths: BloxPaths, fetchImpl: typeof fetch = fetch) {
  const host = resolve(paths.host);
  const engine = resolve(paths.engine);
  const epoxy = resolve(paths.epoxy);

  // Revalidated on every load: the engine keeps the same paths across
  // versions, so a cached WebClient.js must never outlive the WebClient.wasm
  // it was built with.
  async function serveFile(req: Request, path: string): Promise<Response | null> {
    const response = await serveStatic(req, path);
    if (!response) return null;
    return new Response(response.body, { status: response.status, headers: isolated(Object.fromEntries(response.headers)) });
  }

  // The metadata list is the engine's own prefetch list, not a promise that
  // it never asks for anything else, so a file missing from disk comes from
  // the CDN folder the engine was pulled from.
  async function fromCdn(req: Request, relative: string): Promise<Response> {
    let source: unknown;
    try {
      source = JSON.parse(await readFile(resolve(engine, "version.json"), "utf8")).source;
    } catch {
      return notFound();
    }
    if (typeof source !== "string" || !source.startsWith("https://setup.rbxcdn.com/webclient/")) return notFound();
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${source}/${encodeURI(relative)}`, { method: req.method, signal: req.signal });
    } catch {
      return notFound();
    }
    if (!upstream.ok) return notFound();
    const ext = extname(relative).toLowerCase();
    return new Response(req.method === "HEAD" ? null : upstream.body, {
      headers: isolated({
        "content-type": MIME_TYPES[ext] || upstream.headers.get("content-type") || "application/octet-stream",
        "cache-control": "no-cache",
      }),
    });
  }

  // version.json's upload id, reread only when the file changes.
  let upload: { mtime: number; value: string | null } | null = null;
  async function currentUpload(): Promise<string | null> {
    const file = Bun.file(resolve(engine, "version.json"));
    if (!(await file.exists())) return null;
    if (upload?.mtime !== file.lastModified) {
      let value: string | null = null;
      try {
        const id: unknown = JSON.parse(await file.text()).clientVersionUpload;
        value = typeof id === "string" ? id : null;
      } catch {}
      upload = { mtime: file.lastModified, value };
    }
    return upload.value;
  }

  return async function handleBlox(req: Request, pathname: string): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: isolated({ allow: "GET, HEAD" }) });
    }
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(BLOX_PREFIX.length));
    } catch {
      return notFound();
    }
    if (relative === "") relative = "index.html";
    if (relative === "epoxy.mjs") return (await serveFile(req, epoxy)) ?? notFound();
    if (Object.hasOwn(HOST_FILES, relative)) return (await serveFile(req, resolve(host, relative))) ?? notFound();
    if (!relative.startsWith("engine/")) return notFound();
    let enginePath = relative.slice("engine/".length);
    // engine/v/<upload>/…: the engine of that version, cached for good. Any
    // other version is refused, so a page left open across a deploy can
    // never mix files from two engines.
    const versioned = /^v\/([^/]+)\/(.+)$/.exec(enginePath);
    if (versioned) {
      if (versioned[1] !== (await currentUpload())) return notFound();
      enginePath = versioned[2]!;
    }
    if (!ENGINE_PATH.test(enginePath) || enginePath.split("/").some((part) => part === "." || part === "..")) return notFound();
    const path = inside(engine, normalize(enginePath));
    if (!path) return notFound();
    const response = (await serveFile(req, path)) ?? (await fromCdn(req, enginePath));
    if (!versioned || !response.ok) return response;
    response.headers.set("cache-control", "public, max-age=31536000, immutable");
    // The decoded size, which sw.js checks its cached copy against.
    const size = Bun.file(path).size;
    if ((await Bun.file(path).exists()) && Number.isFinite(size)) response.headers.set("x-blox-size", String(size));
    return response;
  };
}
