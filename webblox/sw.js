// Service worker for /blox/. Roblox's web client talks to *.roblox.com and
// *.rbxcdn.com with ordinary fetch/XHR, from the page and from its pthread
// workers. Those hosts may be unreachable from here, so every cross-origin
// request is handed to a page in this scope, which sends it over Wisp
// (host.js) with the Roblox session attached, and the reply comes back here.
// Same-origin requests are left alone: the server already sends the
// cross-origin isolation headers the engine's SharedArrayBuffer needs.

// URL pública de Cloudflare R2 (u otro CDN) donde está alojado el contenido de
// vendor/webblox/engine/ (sin barra final, ej. "https://pub-xxxx.r2.dev").
// Si se deja vacío, el motor se descarga desde el mismo origen (/blox/engine/).
const ENGINE_CDN = "";

const SCOPE = new URL(self.registration.scope);
const ENGINE_PREFIX = `${SCOPE.pathname}engine/`;
const ENGINE_CDN_BASE = ENGINE_CDN.replace(/\/+$/, "");

function engineUrl(relative) {
  const clean = relative.replace(/^\/+/, "");
  return ENGINE_CDN_BASE ? `${ENGINE_CDN_BASE}/${clean}` : new URL(`engine/${clean}`, SCOPE).href;
}

const PINNED_FLAGS = engineUrl("PinnedFlags.json");
// WasmPlayer.js loads the engine's flags from here. The engine on disk is one
// pinned version, so it gets the flags fetched alongside it, not whatever
// Roblox's live flags are for a newer engine.
const FLAGS_URL = /^https:\/\/clientsettingscdn\.roblox\.com\/v2\/settings\/application\/WebClientApp(?:\/bucket\/[^?#]*)?(?:[?#]|$)/;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const RELAY_TIMEOUT_MS = 120_000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!/^https?:/.test(request.url)) return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (ENGINE_CDN_BASE && url.pathname.startsWith(ENGINE_PREFIX) && (request.method === "GET" || request.method === "HEAD")) {
      const version = request.method === "GET" ? ENGINE_VERSIONED.exec(url.pathname) : null;
      if (version) event.respondWith(cachedEngineFile(request, version[1], version[2]));
      else event.respondWith(fetchFromEngineCdn(request, url.pathname.slice(ENGINE_PREFIX.length)));
      return;
    }
    const version = request.method === "GET" ? ENGINE_VERSIONED.exec(url.pathname) : null;
    if (version) event.respondWith(cachedEngineFile(request, version[1], version[2]));
    return;
  }
  event.respondWith(crossOrigin(request, event.clientId));
});

// ---- Engine cache ---------------------------------------------------------------
// engine/v/<upload>/… never changes, so it is kept in Cache Storage, one cache
// per engine version. Every copy is checked against the size the server sent
// (x-blox-size) when stored and when used; a short or missing copy is dropped
// and fetched again, and caches of other versions are deleted.

const ENGINE_VERSIONED = new RegExp(`^${SCOPE.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}engine/v/(version-[0-9a-f]{16})/(.+)$`);
const CACHE_PREFIX = "blox-engine-";
const pruned = new Set();

function isolatedCdnResponse(response, relative) {
  const headers = new Headers(response.headers);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-embedder-policy", "require-corp");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (!headers.get("content-type") || headers.get("content-type") === "application/octet-stream") {
    if (relative.endsWith(".wasm")) headers.set("content-type", "application/wasm");
    else if (relative.endsWith(".js") || relative.endsWith(".mjs")) headers.set("content-type", "text/javascript; charset=utf-8");
    else if (relative.endsWith(".json")) headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function fetchFromEngineCdn(request, relative) {
  const upstream = await fetch(engineUrl(relative), { method: request.method, mode: "cors", cache: "no-store" });
  return isolatedCdnResponse(upstream, relative);
}

async function intact(response) {
  if (!response?.ok) return false;
  const expected = Number(response.headers.get("x-blox-size"));
  if (!Number.isFinite(expected) || expected <= 0) return true;
  try {
    return (await response.clone().blob()).size === expected;
  } catch {
    return false;
  }
}

async function pruneOtherVersions(keep) {
  if (pruned.has(keep)) return;
  pruned.add(keep);
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && name !== keep) await caches.delete(name);
  }
}

let outdatedAnnounced = false;
async function announceIfOutdated(upload) {
  if (outdatedAnnounced) return;
  try {
    const live = await fetch(engineUrl("version.json"), { cache: "no-store" });
    if (!live.ok || (await live.json()).clientVersionUpload === upload) return;
  } catch {
    return;
  }
  outdatedAnnounced = true;
  for (const page of await self.clients.matchAll({ type: "window" })) page.postMessage({ type: "blox-engine-outdated" });
}

async function reassembleChunkedFile(baseUrl) {
  const manifestRes = await fetch(`${baseUrl}.parts.json`, { credentials: "same-origin", cache: "no-cache" });
  if (!manifestRes.ok) return manifestRes;
  const manifest = await manifestRes.json();
  const partBase = new URL("./", baseUrl);
  const blobs = await Promise.all(
    manifest.parts.map(async (part) => {
      const res = await fetch(new URL(part, partBase).href, { credentials: "same-origin", cache: "no-cache" });
      if (!res.ok) throw new Error(`Failed to fetch chunk ${part}: HTTP ${res.status}`);
      return res.blob();
    }),
  );
  const combined = new Blob(blobs, { type: manifest.contentType || "application/wasm" });
  const headers = new Headers({
    "content-type": manifest.contentType || "application/wasm",
    "content-length": String(combined.size),
    "cache-control": "public, max-age=31536000, immutable",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    "x-blox-size": String(manifest.size || combined.size),
  });
  return new Response(combined, { status: 200, headers });
}

async function cachedEngineFile(request, upload, relative) {
  const name = `${CACHE_PREFIX}${upload}`;
  let cache = null;
  try {
    cache = await caches.open(name);
    void pruneOtherVersions(name);
    const hit = await cache.match(request.url);
    if (hit && (await intact(hit))) return hit;
    if (hit) {
      console.warn("[blox] cached engine file damaged, fetching it again:", request.url);
      await cache.delete(request.url);
    }
  } catch (error) {
    console.warn("[blox] engine cache unavailable:", error);
  }
  let response = ENGINE_CDN_BASE
    ? isolatedCdnResponse(await fetch(engineUrl(relative), { mode: "cors", cache: "no-cache" }), relative)
    : await fetch(request.url, { credentials: "same-origin", cache: "no-cache" });
  if (!ENGINE_CDN_BASE && response.status === 404 && response.headers.get("x-blox-chunked") === "1") {
    response = await reassembleChunkedFile(request.url);
  }
  // The server refuses a version it no longer runs: tell the page, whose
  // engine would otherwise fail on the next file it asks for.
  if (response.status === 404) void announceIfOutdated(upload);
  if (cache && (await intact(response))) {
    // Stored in the background: the engine gets its bytes now.
    cache.put(request.url, response.clone()).catch((error) => console.warn("[blox] could not cache", request.url, error));
  }
  return response;
}

// Telemetry and crash reports the engine and roblox.com send. Answered here
// so they cost neither the relay nor the Wisp server, which refuses Sentry
// anyway (every report was a failed request).
const TELEMETRY = /^(?:client-telemetry|ecsv2|tracing|ephemeralcounters\.api)\.roblox\.com$|(?:^|\.)ingest(?:\.[a-z]+)?\.sentry\.io$/i;

async function crossOrigin(request, clientId) {
  if (TELEMETRY.test(new URL(request.url).hostname)) return reply(204, "No Content", [], null);
  if (request.method === "GET" && FLAGS_URL.test(request.url)) {
    const pinned = await fetch(PINNED_FLAGS, { cache: "no-cache" }).catch(() => null);
    if (pinned?.ok) return reply(200, "", [["content-type", "application/json"]], withLocalFlags(await pinned.text()));
  }
  const cacheable = request.method === "GET" && !request.headers.has("range") && GAME_ASSET_HOST.test(new URL(request.url).hostname);
  if (cacheable) {
    const hit = await cachedGameAsset(request.url);
    if (hit) return hit;
  }
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const result = await relay(clientId, {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
    });
    const response = reply(result.status, result.statusText, result.headers, result.body);
    if (cacheable && result.status === 200 && immutableAsset(request.url, response.headers)) {
      void storeGameAsset(request.url, response.clone(), clientId);
    }
    return response;
  } catch (error) {
    return reply(502, "Bad Gateway", [["content-type", "application/json"]], JSON.stringify({ error: String(error?.message || error) }));
  }
}

// Performance FFlags toggled from the launcher (saved via blox-perf-flags message).
let perfFlags = { perfMode: true, ultraFps: false };

// Lets the page pick the renderer with ?renderer=webgl|webgpu (WasmPlayer.js
// only reads it with this flag on); host.js uses it to keep old Chrome off WebGPU.
function withLocalFlags(text) {
  try {
    const flags = JSON.parse(text);
    const s = flags?.applicationSettings;
    if (s) {
      s.FFlagWebClientRenderQueryParams = "True";
      if (perfFlags.perfMode) {
        s.DFFlagDisableDPIScale = "True";
        s.DFIntTaskSchedulerTargetFps = "240";
        s.FFlagDebugDisableTelemetryV2Event = "True";
        s.FFlagDebugDisableTelemetryV2Stat = "True";
        s.FFlagDebugDisableTelemetryV2Counter = "True";
      }
      if (perfFlags.ultraFps) {
        s.FIntRenderShadowIntensity = "0";
        s.FFlagDisablePostFx = "True";
        s.DFFlagTextureQualityOverrideEnabled = "True";
        s.DFIntTextureQualityOverride = "0";
        s.FIntFRMMinGrassDistance = "0";
        s.FIntFRMMaxGrassDistance = "0";
        s.DFIntDebugFRMQualityLevelOverride = "1";
      }
    }
    return JSON.stringify(flags);
  } catch {
    return text;
  }
}

function reply(status, statusText, headers, body) {
  const out = new Headers(headers);
  // The page is cross-origin isolated (COEP require-corp): without this, any
  // no-cors load (an <img>) of a relayed response would be blocked.
  out.set("cross-origin-resource-policy", "cross-origin");
  // The engine fetches with credentials and reads headers such as
  // x-csrf-token, so answer as Roblox would to its own site.
  out.set("access-control-allow-origin", self.location.origin);
  out.set("access-control-allow-credentials", "true");
  const names = [...new Set([...out.keys()])].join(", ");
  if (names) out.set("access-control-expose-headers", names);
  return new Response(NULL_BODY.has(status) ? null : body, { status, statusText, headers: out });
}

// A page of ours in this scope. Requests from the engine's workers carry the
// worker's client id, so fall back to any window.
async function relayPage(clientId) {
  const own = clientId ? await self.clients.get(clientId) : null;
  if (own?.type === "window") return own;
  const pages = await self.clients.matchAll({ type: "window" });
  const page = pages.find((client) => client.frameType === "top-level") ?? pages[0];
  if (!page) throw new Error("no page to relay through");
  return page;
}

async function relay(clientId, message) {
  const page = await relayPage(clientId);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("relay timed out"));
    }, RELAY_TIMEOUT_MS);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data.ok) resolve(data);
      else reject(new Error(data.error));
    };
    const transfer = message.body ? [channel.port2, message.body] : [channel.port2];
    page.postMessage({ type: "blox-fetch", ...message }, transfer);
  });
}

// ---- Game asset cache -----------------------------------------------------------
// What games download from Roblox's CDN (meshes, textures, sounds) is kept
// in Cache Storage when Roblox itself marks it as unchanging, so a game you
// come back to loads from disk instead of over the network. Each asset
// remembers which places used it; past the budget, the least recently used
// assets go first, and those of your three most visited places go last.

const GAME_ASSET_HOST = /(^|\.)rbxcdn\.com$/i;
const ASSET_CACHE = "blox-game-assets";
const ASSET_BUDGET = 768 * 1024 * 1024;
const PROTECTED_PLACES = 3;
const DAY = 86400;

function immutableAsset(url, headers) {
  const control = (headers.get("cache-control") || "").toLowerCase();
  if (/no-store|private|no-cache/.test(control)) return false;
  const maxAge = Number(/max-age=(\d+)/.exec(control)?.[1] ?? 0);
  // Content-addressed paths (a 32-hex hash) never change either.
  return maxAge >= DAY || /\/[0-9a-f]{32}(?:\/|$)/i.test(new URL(url).pathname);
}

// A small IndexedDB: assets { url, size, lastUsed, places[] }, visits { placeId, count, last }.
let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("blox-cache", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("assets", { keyPath: "url" });
      open.result.createObjectStore("visits", { keyPath: "placeId" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function idb(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name, mode = "readonly") {
  return (await db()).transaction(name, mode).objectStore(name);
}

// Last-use times are written in batches: a game asks for thousands of assets.
const touched = new Map();
let flushTimer = 0;
function touch(url) {
  touched.set(url, Date.now());
  flushTimer ||= setTimeout(async () => {
    flushTimer = 0;
    const batch = [...touched];
    touched.clear();
    try {
      const assets = await store("assets", "readwrite");
      for (const [key, time] of batch) {
        const entry = await idb(assets.get(key));
        if (entry) assets.put({ ...entry, lastUsed: time });
      }
    } catch {}
  }, 5000);
}

let assetCachePromise = null;
function getAssetCache() {
  return (assetCachePromise ??= caches.open(ASSET_CACHE));
}

async function cachedGameAsset(url) {
  try {
    const cache = await getAssetCache();
    const hit = await cache.match(url);
    if (hit?.ok) {
      touch(url);
      return hit;
    }
  } catch {}
  return null;
}

async function placeOf(clientId) {
  try {
    const page = await relayPage(clientId);
    const id = new URL(page.url).searchParams.get("placeId");
    return id && /^[1-9]\d{0,18}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

let pendingBytes = 0;
async function storeGameAsset(url, response, clientId) {
  try {
    const size = (await response.clone().blob()).size;
    if (!size || size > ASSET_BUDGET / 8) return;
    const place = await placeOf(clientId);
    await (await getAssetCache()).put(url, response);
    const assets = await store("assets", "readwrite");
    const previous = await idb(assets.get(url));
    const places = [...new Set([...(previous?.places ?? []), ...(place ? [place] : [])])].slice(-8);
    assets.put({ url, size, lastUsed: Date.now(), places });
    pendingBytes += size;
    if (pendingBytes > 32 * 1024 * 1024) {
      pendingBytes = 0;
      void trimGameAssets();
    }
  } catch (error) {
    console.warn("[blox] could not cache", url, error);
  }
}

async function topPlaces() {
  const visits = await idb((await store("visits")).getAll());
  return new Set(visits.sort((a, b) => b.count - a.count || b.last - a.last).slice(0, PROTECTED_PLACES).map((v) => v.placeId));
}

let trimming = null;
function trimGameAssets() {
  trimming ??= (async () => {
    try {
      const all = await idb((await store("assets")).getAll());
      let total = all.reduce((sum, a) => sum + a.size, 0);
      if (total <= ASSET_BUDGET) return;
      const favourite = await topPlaces();
      const kept = (a) => a.places.some((p) => favourite.has(p));
      // Everything else first, oldest first; favourites' assets only if still over.
      const order = all.sort((a, b) => Number(kept(a)) - Number(kept(b)) || a.lastUsed - b.lastUsed);
      const evict = [];
      for (const asset of order) {
        if (total <= ASSET_BUDGET * 0.9) break;
        evict.push(asset.url);
        total -= asset.size;
      }
      // One transaction with no other awaits inside it, or it closes early.
      const assets = await store("assets", "readwrite");
      for (const url of evict) assets.delete(url);
      const cache = await caches.open(ASSET_CACHE);
      await Promise.all(evict.map((url) => cache.delete(url)));
    } catch (error) {
      console.warn("[blox] could not trim the game cache", error);
    } finally {
      trimming = null;
    }
  })();
  return trimming;
}

async function recordVisit(placeId) {
  if (!/^[1-9]\d{0,18}$/.test(String(placeId))) return;
  const visits = await store("visits", "readwrite");
  const entry = await idb(visits.get(String(placeId)));
  visits.put({ placeId: String(placeId), count: (entry?.count ?? 0) + 1, last: Date.now() });
}

async function cacheStats() {
  const all = await idb((await store("assets")).getAll());
  const visits = await idb((await store("visits")).getAll());
  return {
    bytes: all.reduce((sum, a) => sum + a.size, 0),
    assets: all.length,
    budget: ASSET_BUDGET,
    top: visits.sort((a, b) => b.count - a.count || b.last - a.last).slice(0, PROTECTED_PLACES),
  };
}

async function clearGameAssets() {
  await caches.delete(ASSET_CACHE);
  (await store("assets", "readwrite")).clear();
}

self.addEventListener("message", (event) => {
  const message = event.data;
  const answer = (value) => event.ports[0]?.postMessage(value);
  if (message?.type === "blox-perf-flags") {
    perfFlags = { perfMode: Boolean(message.perfMode), ultraFps: Boolean(message.ultraFps) };
    answer(true);
  }
  else if (message?.type === "blox-visit") event.waitUntil(recordVisit(message.placeId).catch(() => {}));
  else if (message?.type === "blox-cache-stats") event.waitUntil(cacheStats().then(answer, () => answer(null)));
  else if (message?.type === "blox-cache-trim") event.waitUntil(trimGameAssets().then(() => answer(true)));
  else if (message?.type === "blox-cache-clear") event.waitUntil(clearGameAssets().then(() => answer(true), () => answer(false)));
});
