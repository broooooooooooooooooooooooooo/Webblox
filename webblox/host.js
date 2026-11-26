// Host page for Roblox's own browser client (binary type WebClientApp, pulled
// into vendor/webblox/engine by scripts/fetch-webblox.mjs).
//
// 1. Answers sw.js: every cross-origin request the engine makes arrives here
//    and goes out over Wisp through epoxy, which runs TLS in this page, so the
//    Wisp server never sees the session. Cookies live in a jar in localStorage.
// 2. Takes the Roblox session (.ROBLOSECURITY) from a Scramjet 2 browser on
//    this origin, if you signed in to roblox.com there, or asks for it.
// 3. Boots WasmPlayer.js the way Roblox's WasmLoader.js does, pointed at the
//    engine on this server.
//
// ?placeId=<id> joins that experience (&gameInstanceId=<job id> one server of
// it); without a place the page is a launcher. With a Scramjet 2 proxy,
// roblox.com's Play button opens this page (integrations/scramjet/plugin.ts).

import { DIRECT_WISP_URL, hasDirectSockets, installDirectWisp } from "./direct-wisp.js";
import { THEMES, startThemeBackground, stopThemeBackground } from "./themes.js";

const ROOT = new URL("./", import.meta.url);
const ENGINE_ROOT = new URL("engine", ROOT).href;

// engine/v/<upload>: the server caches that path for good and sw.js keeps a
// checked copy, so a returning player loads the engine without the network.
// Falls back to the unversioned path when version.json is unreadable.
async function engineBase() {
  if (location.protocol === "isolated-app:") return ENGINE_ROOT;
  try {
    const response = await fetch(`${ENGINE_ROOT}/version.json`, { cache: "no-store" });
    const upload = response.ok ? (await response.json()).clientVersionUpload : null;
    if (typeof upload === "string" && /^version-[0-9a-f]{16}$/.test(upload)) return `${ENGINE_ROOT}/v/${upload}`;
  } catch {}
  return ENGINE_ROOT;
}
const WISP_KEY = "blox.wisp";
const JAR_KEY = "blox.cookies";
// ?placeId=…&gameInstanceId=…: join that server of the place (roblox.com's
// Join on a server or a friend). The id is a job id, a UUID in practice.
const JOIN_SERVER = (() => {
  const params = new URLSearchParams(location.search);
  const placeId = params.get("placeId");
  const serverId = params.get("gameInstanceId");
  return placeId && serverId && /^[A-Za-z0-9-]{1,64}$/.test(serverId) ? { placeId, serverId } : null;
})();
const SESSION = ".ROBLOSECURITY";
const SESSION_CHECK = "https://users.roblox.com/v1/users/authenticated";
const ROBLOX_HOST = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i;
// Dropped from what the engine sent: the browser's own values describe this
// page, not www.roblox.com, and epoxy sets length and host itself.
const DROP_REQUEST = new Set(["cookie", "content-length", "host", "origin", "referer", "connection"]);
// Dropped from what Roblox sent: epoxy already decoded the body, the cookies
// went into the jar, and the CORS and isolation headers are set by sw.js.
const DROP_RESPONSE = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie",
  "access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-headers",
  "access-control-allow-methods", "access-control-expose-headers", "cross-origin-opener-policy",
  "cross-origin-embedder-policy", "cross-origin-resource-policy", "strict-transport-security",
]);

const status = document.getElementById("status");
const say = (text) => {
  status.textContent = text;
};

// ---- Wisp transport ---------------------------------------------------------

// Opened with ?wisp=<server> (the opener may be on another origin, so
// localStorage cannot carry it), the page remembers that server for the joins
// that follow. In an IWA with Direct Sockets, use the built-in TCPSocket Wisp
// bridge; otherwise fall back to /wisp/ on this host.

function wispUrl() {
  const url = new URL(location.href);
  const given = url.searchParams.get("wisp");
  if (given !== null) {
    if (/^wss?:\/\//i.test(given)) localStorage.setItem(WISP_KEY, given);
    url.searchParams.delete("wisp");
    history.replaceState(history.state, "", url);
  }
  if (hasDirectSockets() && (!given || given === DIRECT_WISP_URL)) return DIRECT_WISP_URL;
  const stored = localStorage.getItem(WISP_KEY);
  if (stored && /^wss?:\/\//i.test(stored)) return stored;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
}

const WISP = wispUrl();
// Epoxy waits forever on a Wisp server that never answers; give up instead.
const REQUEST_TIMEOUT_MS = 30_000;

const transport = (async () => {
  if (WISP === DIRECT_WISP_URL) installDirectWisp();
  const { default: EpoxyTransport } = await import(new URL("epoxy.mjs", ROOT).href);
  const epoxy = new EpoxyTransport({ wisp: WISP, ...(WISP === DIRECT_WISP_URL ? { wisp_v2: false } : {}) });
  await epoxy.init();
  return epoxy;
})();

// ---- Cookie jar ---------------------------------------------------------------
// { name, value, domain, hostOnly, path, expires (ms, 0 = session) }

// Every relayed request reads the jar, thousands per game: keep it in memory
// and reparse localStorage only when another tab of ours changed it.
let jarCache = null;
addEventListener("storage", (event) => {
  if (event.key === JAR_KEY || event.key === null) jarCache = null;
});

function readJar() {
  if (jarCache === null) {
    try {
      const jar = JSON.parse(localStorage.getItem(JAR_KEY) || "[]");
      jarCache = Array.isArray(jar) ? jar : [];
    } catch {
      jarCache = [];
    }
  }
  const now = Date.now();
  return jarCache.filter((c) => !c.expires || c.expires > now);
}

function writeJar(jar) {
  jarCache = jar;
  try {
    localStorage.setItem(JAR_KEY, JSON.stringify(jar));
  } catch (error) {
    console.warn("[blox] could not save cookies:", error);
  }
}

function domainMatches(host, cookie) {
  return host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`));
}

function pathMatches(path, cookiePath) {
  return path === cookiePath || path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function cookieHeader(url) {
  return readJar()
    .filter((c) => domainMatches(url.hostname, c) && pathMatches(url.pathname, c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function putCookie(jar, cookie) {
  const kept = jar.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
  if (!cookie.expires || cookie.expires > Date.now()) kept.push(cookie);
  return kept;
}

function parseSetCookie(url, line) {
  const [pair, ...attributes] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    hostOnly: true,
    path: "/",
    expires: 0,
  };
  let maxAge = null;
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? "" : attribute.slice(at + 1).trim();
    if (key === "domain" && value) {
      const domain = value.replace(/^\./, "").toLowerCase();
      // A host may only set cookies for itself or a parent domain.
      if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return null;
      cookie.domain = domain;
      cookie.hostOnly = false;
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "expires") {
      const time = Date.parse(value);
      if (Number.isFinite(time)) cookie.expires = time;
    } else if (key === "max-age" && /^-?\d+$/.test(value)) {
      maxAge = Number(value);
    }
  }
  // Max-Age wins over Expires; zero or less deletes the cookie.
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? 1 : Date.now() + maxAge * 1000;
  return cookie;
}

function storeSession(value) {
  let jar = readJar().filter((c) => c.name !== SESSION);
  jar = putCookie(jar, { name: SESSION, value, domain: "roblox.com", hostOnly: false, path: "/", expires: 0 });
  writeJar(jar);
}

function forgetSession() {
  writeJar(readJar().filter((c) => c.name !== SESSION));
}

const savedSession = () => readJar().find((c) => c.name === SESSION)?.value ?? null;

// ---- Requests -----------------------------------------------------------------

// Roblox's game servers are reached over WebTransport at *.qdmux.roblox.com.
// gamejoin only returns that name (gameFqdn) to the web client; with a native
// client's user agent it returns the UDMUX relay and a net stack token
// instead, from which the name is derived. Both rules are taken from a working
// deployment of this client, not from Roblox documentation.
function nativeUserAgent(value) {
  return value.replace(/Roblox\/Web\s+\w+\s+Desktop/, "Roblox/WinInet").replace(/\s*Browser\/\S+/, "");
}

function qdmuxFqdn(joinScript) {
  const udmux = joinScript.UdmuxEndpoints?.[0];
  const netStackToken = String(joinScript.NetStackTokenValue || "");
  if (!udmux || !netStackToken || !joinScript.MachineAddress || !joinScript.NetStackPort) return null;
  let token = netStackToken.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(token)) {
    try {
      token = [...atob(netStackToken)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }
  if (token.length !== 32) return null;
  const relay = String(udmux.Address).split(".").map(Number);
  const machine = String(joinScript.MachineAddress).split(".").map(Number);
  const octets = (list) => list.length === 4 && list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!octets(relay) || !octets(machine)) return null;
  relay[3] += 1;
  if (relay[3] > 255) return null;
  const hex = (list) => list.map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${token}-${hex(machine)}-${Number(joinScript.NetStackPort).toString(16)}.${hex(relay)}.qdmux.roblox.com`;
}

function withGameFqdn(body) {
  try {
    const json = JSON.parse(new TextDecoder().decode(body));
    if (!json?.joinScript || json.joinScript.gameFqdn) return body;
    const fqdn = qdmuxFqdn(json.joinScript);
    if (!fqdn) return body;
    json.joinScript.gameFqdn = fqdn;
    return new TextEncoder().encode(JSON.stringify(json)).buffer;
  } catch {
    return body;
  }
}

// roblox.com's Join on a server or a friend names one server (game instance).
// The engine always asks gamejoin for any server of the place; for that
// place's first join (not a teleport), ask for the named one instead.
function joinNamedServer(target, body) {
  if (!JOIN_SERVER || target.pathname !== "/v1/join-game" || !body) return body;
  try {
    const request = JSON.parse(new TextDecoder().decode(body));
    if (String(request.placeId) !== JOIN_SERVER.placeId || request.isTeleport) return body;
    target.pathname = "/v1/join-game-instance";
    return new TextEncoder().encode(JSON.stringify({ ...request, gameId: JOIN_SERVER.serverId })).buffer;
  } catch {
    return body;
  }
}

// gamejoin is first asked as the web client the engine is, so Roblox answers
// with the game server address it hands that client (joinScript.gameFqdn).
// Only when that answer has no address is it asked again as the desktop
// client, whose UDMUX answer the address is derived from (qdmuxFqdn), and
// this page keeps doing so after that.
let desktopGameJoin = false;

function joinAnswerOf(data) {
  try {
    return JSON.parse(new TextDecoder().decode(data)) ?? null;
  } catch {
    return null;
  }
}

function joinScriptOf(data) {
  return joinAnswerOf(data)?.joinScript ?? null;
}

// gamejoin's status 12: "Not authorized to join this experience", what it
// answers a web client the account or experience is not enabled for.
const JOIN_NOT_AUTHORIZED = 12;

async function upstream(message, asDesktop = desktopGameJoin) {
  let { url, method, headers, body } = message;
  const original = body ? body.slice(0) : body;
  const target = new URL(url);
  const out = new Map();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (!DROP_REQUEST.has(key) && !key.startsWith("sec-")) out.set(key, value);
  }
  const roblox = ROBLOX_HOST.test(target.hostname);
  const gameJoin = roblox && target.hostname === "gamejoin.roblox.com" && method === "POST";
  out.set("origin", roblox ? "https://www.roblox.com" : target.origin);
  out.set("referer", roblox ? "https://www.roblox.com/" : `${target.origin}/`);
  if (gameJoin) {
    if (asDesktop) out.set("rbx-user-agent", "Roblox/Darwin");
    body = joinNamedServer(target, body);
  } else if (roblox && out.has("rbx-user-agent")) {
    out.set("rbx-user-agent", nativeUserAgent(out.get("rbx-user-agent")));
  }
  const cookies = cookieHeader(target);
  if (cookies) out.set("cookie", cookies);

  const epoxy = await transport;
  let timer;
  const response = await Promise.race([
    // Epoxy's own errors are Rust debug dumps; keep them in the console only.
    epoxy.request(target, method, body && body.byteLength ? body : null, [...out], undefined).catch((error) => {
      console.error("[blox] epoxy:", target.href, error);
      throw new Error(`No se pudo conectar con ${target.hostname} a través del servidor Wisp ${WISP}.`);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${target.hostname} no respondió a través del servidor Wisp ${WISP} en ${REQUEST_TIMEOUT_MS / 1000} s`)),
        REQUEST_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  let data = await new Response(response.body).arrayBuffer();

  let jar = null;
  let jarChanged = false;
  const kept = [];
  for (const [name, value] of response.headers) {
    const key = name.toLowerCase();
    if (key === "set-cookie") {
      const cookie = parseSetCookie(target, value);
      if (cookie) {
        const baseJar = jar ?? readJar();
        const prev = baseJar.find((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
        if (!prev || prev.value !== cookie.value || prev.expires !== cookie.expires) jarChanged = true;
        jar = putCookie(baseJar, cookie);
      }
    } else if (key === "location") {
      kept.push([key, new URL(value, target).href]);
    } else if (!DROP_RESPONSE.has(key)) {
      kept.push([key, value]);
    }
  }
  if (jar && jarChanged) writeJar(jar);
  if (gameJoin && response.status === 200) {
    const answer = joinAnswerOf(data);
    const joinScript = answer?.joinScript ?? null;
    if (!asDesktop && !joinScript && answer?.status === JOIN_NOT_AUTHORIZED) {
      console.info("[blox] Roblox refused the web client for this join; asking as the desktop client");
      desktopGameJoin = true;
      return upstream({ ...message, body: original }, true);
    }
    if (joinScript?.gameFqdn) {
      console.info(`[blox] game server from Roblox (${asDesktop ? "desktop" : "web"} join): ${joinScript.gameFqdn}`);
    } else if (joinScript && !asDesktop) {
      console.info("[blox] Roblox gave the web client no game server address; asking as the desktop client");
      desktopGameJoin = true;
      return upstream({ ...message, body: original }, true);
    } else if (joinScript) {
      data = withGameFqdn(data);
      console.info(`[blox] game server derived from the UDMUX relay: ${joinScriptOf(data)?.gameFqdn ?? "(none)"}`);
    }
  }
  return { status: response.status, statusText: response.statusText, headers: kept, body: data };
}

navigator.serviceWorker.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.type !== "blox-fetch") return;
  const [port] = event.ports;
  try {
    const result = await upstream(message);
    port.postMessage({ ok: true, ...result }, [result.body]);
  } catch (error) {
    console.error("[blox] relay failed:", message.method, message.url, error);
    port.postMessage({ ok: false, error: String(error?.message || error) });
  }
});
navigator.serviceWorker.startMessages();

// ---- Session ------------------------------------------------------------------

async function currentUser() {
  const result = await upstream({ url: SESSION_CHECK, method: "GET", headers: [], body: null });
  if (result.status !== 200) return null;
  try {
    return JSON.parse(new TextDecoder().decode(result.body));
  } catch {
    return {};
  }
}

async function sessionAccepted() {
  return (await currentUser()) !== null;
}

async function robloxPostWithCsrf(url, payload) {
  const encoded = payload === undefined ? null : new TextEncoder().encode(JSON.stringify(payload)).buffer;
  const baseHeaders = [
    ["accept", "application/json"],
    ["content-type", "application/json"],
  ];
  let result = await upstream({ url, method: "POST", headers: baseHeaders, body: encoded ? encoded.slice(0) : null });
  const csrf = result.headers.find(([k]) => k.toLowerCase() === "x-csrf-token")?.[1];
  if (result.status === 403 && csrf) {
    result = await upstream({
      url,
      method: "POST",
      headers: [...baseHeaders, ["x-csrf-token", csrf]],
      body: encoded ? encoded.slice(0) : null,
    });
  }
  let json = null;
  try {
    json = JSON.parse(new TextDecoder().decode(result.body));
  } catch {}
  return { status: result.status, json };
}

// A Scramjet 2 browser on this origin (its controller) keeps its cookie jar in
// IndexedDB, so signing in to roblox.com there leaves .ROBLOSECURITY where
// this page can read it. Never creates the database when it is missing.
function proxySession() {
  return new Promise((resolve) => {
    const open = indexedDB.open("__scramjet_controller");
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      const finish = (value) => {
        db.close();
        resolve(value);
      };
      try {
        const get = db.transaction("state", "readonly").objectStore("state").get("cookies");
        get.onsuccess = () => finish(sessionFromDump(get.result?.cookies));
        get.onerror = () => finish(null);
      } catch {
        finish(null);
      }
    };
  });
}

// The controller stores CookieJar.dump(): JSON of { [key]: { name, value, domain, … } }.
function sessionFromDump(dump) {
  if (typeof dump !== "string") return null;
  let cookies;
  try {
    cookies = JSON.parse(dump);
  } catch {
    return null;
  }
  for (const cookie of Object.values(cookies ?? {})) {
    if (cookie?.name !== SESSION || typeof cookie.value !== "string" || !cookie.value) continue;
    if (/^\.?(?:[^.]+\.)*roblox\.com$/i.test(String(cookie.domain))) return cookie.value;
  }
  return null;
}

// Puts a candidate session in the jar and keeps it only if Roblox accepts it.
async function trySession(value) {
  storeSession(value);
  if (await sessionAccepted()) return true;
  forgetSession();
  return false;
}

// Joining needs a signed-in account (gamejoin answers 524 "Not authorized"
// otherwise), so this runs before the engine starts and only then.
function askForSession(expired, { allowCancel = false } = {}) {
  return new Promise((resolve) => {
    let pollTimer = 0;
    let closed = false;
    const stopPolling = () => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = 0;
    };

    const shade = document.createElement("div");
    shade.className = "session";
    shade.innerHTML = `
      <form novalidate aria-labelledby="session-title">
        <h1 id="session-title"></h1>
        <p>Usa <b>Inicio rápido</b> (aprueba el código en roblox.com/crossdevicelogin/ConfirmCode desde tu móvil o navegador) o pega tu cookie <code>.ROBLOSECURITY</code>.</p>
        <div class="quick-code" hidden></div>
        <p class="quick-status" hidden></p>
        <div class="actions">
          <button type="button" class="quick-btn">Generar código rápido</button>
          <button type="button" class="secondary proxy-btn">Leer del proxy</button>
        </div>
        <div class="session-divider">o pega la cookie</div>
        <input type="password" autocomplete="off" spellcheck="false" placeholder="_|WARNING:-DO-NOT-SHARE-THIS.--|..." aria-label="Cookie .ROBLOSECURITY" />
        <p class="error" id="session-error" role="alert"></p>
        <div class="actions">
          <button type="button" class="secondary cancel-btn"></button>
          <button type="submit">Entrar con cookie</button>
        </div>
      </form>`;

    const form = shade.querySelector("form");
    const error = form.querySelector(".error");
    const quickCode = form.querySelector(".quick-code");
    const quickStatus = form.querySelector(".quick-status");
    const quickBtn = form.querySelector(".quick-btn");
    const proxyBtn = form.querySelector(".proxy-btn");
    const cancelBtn = form.querySelector(".cancel-btn");
    const cookieInput = form.querySelector("input");
    const submitBtn = form.querySelector('button[type="submit"]');

    form.querySelector("h1").textContent = expired ? "La sesión de Roblox caducó" : "Inicia sesión en Roblox";
    cancelBtn.textContent = allowCancel ? "Cerrar" : "Volver";

    const fail = (text) => {
      error.textContent = text;
    };
    const finish = (ok = true) => {
      closed = true;
      stopPolling();
      shade.remove();
      resolve(ok);
    };

    cancelBtn.addEventListener("click", () => {
      if (allowCancel) finish(false);
      else location.assign(ROOT.href);
    });

    quickBtn.addEventListener("click", async () => {
      stopPolling();
      error.textContent = "";
      quickBtn.disabled = true;
      quickStatus.hidden = false;
      quickStatus.textContent = "Generando código…";
      try {
        const created = await robloxPostWithCsrf("https://apis.roblox.com/auth-token-service/v1/login/create");
        if (created.status !== 200 || !created.json?.code || !created.json?.privateKey) {
          throw new Error(`Roblox respondió HTTP ${created.status}`);
        }
        const { code, privateKey } = created.json;
        quickCode.hidden = false;
        quickCode.textContent = code;
        quickStatus.textContent = "Introduce este código en roblox.com/crossdevicelogin/ConfirmCode y apruébalo…";

        const poll = async () => {
          if (closed) return;
          try {
            const st = await robloxPostWithCsrf("https://apis.roblox.com/auth-token-service/v1/login/status", { code, privateKey });
            if (closed) return;
            const statusValue = st.json?.status;
            if (statusValue === "Validated") {
              quickStatus.textContent = "Código aprobado. Iniciando sesión…";
              const login = await robloxPostWithCsrf("https://auth.roblox.com/v2/login", {
                ctype: "AuthToken",
                cvalue: code,
                password: privateKey,
              });
              if (login.status === 200 && (await sessionAccepted())) {
                finish(true);
                return;
              }
              throw new Error(`Error al canjear el código (HTTP ${login.status})`);
            }
            if (statusValue === "Cancelled" || st.status === 400) {
              quickStatus.textContent = "Código cancelado o caducado. Genera uno nuevo.";
              quickBtn.disabled = false;
              return;
            }
            if (statusValue === "UserLinked") {
              quickStatus.textContent = "Código introducido. Confírmalo en tu otro dispositivo…";
            }
          } catch (err) {
            if (closed) return;
            fail(err.message || String(err));
            quickBtn.disabled = false;
            return;
          }
          pollTimer = setTimeout(poll, 3000);
        };
        pollTimer = setTimeout(poll, 3000);
      } catch (err) {
        quickStatus.hidden = true;
        quickBtn.disabled = false;
        fail(`No se pudo iniciar Quick Login: ${err.message || err}`);
      }
    });

    proxyBtn.addEventListener("click", async () => {
      error.textContent = "";
      const value = await proxySession();
      if (!value) return fail("No se encontró una sesión en el proxy Scramjet.");
      proxyBtn.disabled = true;
      try {
        if (await trySession(value)) {
          finish(true);
          return;
        }
        fail("La sesión del proxy caducó.");
      } catch (err) {
        forgetSession();
        fail(`No se pudo conectar con Roblox: ${err.message || err}`);
      }
      proxyBtn.disabled = false;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      const raw = cookieInput.value.trim().replace(/^\.ROBLOSECURITY=/i, "");
      if (!raw) return fail("Pega tu cookie .ROBLOSECURITY o usa Quick Login.");
      submitBtn.disabled = true;
      try {
        if (await trySession(raw)) {
          finish(true);
          return;
        }
        fail("Roblox rechazó esa cookie.");
      } catch (err) {
        forgetSession();
        fail(`No se pudo conectar con Roblox: ${err.message || err}`);
      }
      submitBtn.disabled = false;
    });

    document.body.append(shade);
    quickBtn.focus();
  });
}

// Signing in via Quick Login, pasted cookie, or Scramjet browser storage.
async function ensureSession() {
  const saved = savedSession();
  const proxied = await proxySession();
  for (const value of new Set([proxied, saved].filter(Boolean))) {
    if (await trySession(value)) return;
  }
  return askForSession(saved !== null);
}

// ---- Launcher -----------------------------------------------------------------

const GAME_LINK = /roblox\.com\/(?:[a-z]{2}\/)?games\/([1-9]\d{0,18})/i;

function placeFromInput(text) {
  const value = text.trim();
  if (/^[1-9]\d{0,18}$/.test(value)) return value;
  return GAME_LINK.exec(value)?.[1] ?? null;
}

async function robloxJson(url) {
  const result = await upstream({ url, method: "GET", headers: [["accept", "application/json"]], body: null });
  // Roblox limits requests per IP, and the IP it sees is the Wisp server's.
  if (result.status === 429) throw new Error(`Roblox está limitando las peticiones del servidor Wisp (${WISP}). Prueba de nuevo en un minuto o abre esta página con ?wisp=<otro servidor>.`);
  if (result.status !== 200) throw new Error(`Roblox respondió HTTP ${result.status}`);
  return JSON.parse(new TextDecoder().decode(result.body));
}

async function searchGames(query) {
  const search = await robloxJson(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${crypto.randomUUID()}&pageType=all`,
  );
  const games = (search.searchResults ?? [])
    .filter((group) => group.contentGroupType === "Game")
    .flatMap((group) => group.contents ?? [])
    .filter((game) => game.rootPlaceId && game.universeId)
    .slice(0, 30);
  if (!games.length) return [];
  const icons = await robloxJson(
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${games.map((game) => game.universeId).join(",")}&size=150x150&format=Webp&isCircular=false`,
  ).catch(() => ({ data: [] }));
  const iconOf = new Map((icons.data ?? []).map((icon) => [icon.targetId, icon.imageUrl]));
  return games.map((game) => ({
    placeId: String(game.rootPlaceId),
    name: game.name,
    creator: game.creatorName,
    players: game.playerCount,
    icon: iconOf.get(game.universeId),
  }));
}

// The launcher's renderer switch: "webgl", "webgpu", or null for automatic
// (WebGPU, or WebGL on Chrome before 156 on x86).
const RENDERER_KEY = "blox.renderer";
// The launcher's quality switch: WasmPlayer.js draws at devicePixelRatio ×
// ?renderScale=, so 0.75 draws 56% of the pixels and 0.5 a quarter, which
// eases the GPU and its memory under WebGL and WebGPU alike.
const SCALE_KEY = "blox.renderScale";
const SCALES = ["1", "0.75", "0.5"];
const THEME_KEY = "blox.theme";
const SHOW_FPS_KEY = "blox.showFps";
const PERF_MODE_KEY = "blox.perfMode";
const RECENT_KEY = "blox.recentPlaces";

function readRecentPlaces() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? { placeId: item, last: 0 } : item))
      .filter((item) => item && /^[1-9]\d{0,18}$/.test(String(item.placeId)));
  } catch {
    return [];
  }
}

function saveRecentPlace(placeId) {
  if (!/^[1-9]\d{0,18}$/.test(String(placeId))) return;
  const id = String(placeId);
  const next = [{ placeId: id, last: Date.now() }, ...readRecentPlaces().filter((p) => p.placeId !== id)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

function clearRecentPlaces() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {}
}

async function fetchRecentGames() {
  let recent = readRecentPlaces();
  if (!recent.length) {
    const stats = await askWorker({ type: "blox-cache-stats" }).catch(() => null);
    if (stats?.top?.length) {
      recent = stats.top.map((v) => ({ placeId: String(v.placeId), last: v.last || 0 }));
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      } catch {}
    }
  }
  const ids = recent.map((r) => r.placeId).slice(0, 12);
  if (!ids.length) return [];

  const details = await robloxJson(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${ids.join(",")}`);
  const detailMap = new Map((Array.isArray(details) ? details : []).map((d) => [String(d.placeId), d]));
  const universeIds = [...new Set([...detailMap.values()].map((d) => d.universeId).filter(Boolean))];
  if (!universeIds.length) return [];

  const [iconsRes, gamesRes] = await Promise.all([
    robloxJson(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(",")}&size=150x150&format=Webp&isCircular=false`,
    ).catch(() => ({ data: [] })),
    robloxJson(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(",")}`).catch(() => ({ data: [] })),
  ]);
  const iconOf = new Map((iconsRes?.data ?? []).map((i) => [i.targetId, i.imageUrl]));
  const playersOf = new Map((gamesRes?.data ?? []).map((g) => [g.id, g.playing]));

  return ids
    .map((id) => detailMap.get(id))
    .filter(Boolean)
    .map((d) => ({
      placeId: String(d.placeId),
      name: d.name,
      creator: d.builder,
      players: playersOf.get(d.universeId),
      icon: iconOf.get(d.universeId),
    }));
}

function savedScale() {
  try {
    const value = localStorage.getItem(SCALE_KEY);
    return SCALES.includes(value) ? value : "1";
  } catch {
    return "1";
  }
}

function saveScale(value) {
  try {
    localStorage.setItem(SCALE_KEY, value);
  } catch {}
}

function savedRenderer() {
  try {
    const value = localStorage.getItem(RENDERER_KEY);
    return value === "webgl" || value === "webgpu" ? value : null;
  } catch {
    return null;
  }
}

function saveRenderer(value) {
  try {
    if (value) localStorage.setItem(RENDERER_KEY, value);
    else localStorage.removeItem(RENDERER_KEY);
  } catch {}
}

function savedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : "space";
  } catch {
    return "space";
  }
}

function saveTheme(value) {
  try {
    localStorage.setItem(THEME_KEY, THEMES.includes(value) ? value : "space");
  } catch {}
}

function savedBool(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function saveBool(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {}
}

const savedShowFps = () => savedBool(SHOW_FPS_KEY, false);
const savedPerfMode = () => savedBool(PERF_MODE_KEY, true);

function play(placeId, serverId = null) {
  saveRecentPlace(placeId);
  const url = new URL(location.href);
  url.search = `?placeId=${placeId}`;
  if (serverId && /^[A-Za-z0-9-]{1,64}$/.test(serverId)) {
    url.searchParams.set("gameInstanceId", serverId);
  }
  const renderer = savedRenderer();
  if (renderer) url.searchParams.set("renderer", renderer);
  const scale = savedScale();
  if (scale !== "1") url.searchParams.set("renderScale", scale);
  location.assign(url);
}

function gameItem(game) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const icon = document.createElement("img");
  icon.alt = "";
  icon.loading = "lazy";
  if (game.icon) icon.src = game.icon;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = game.name;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [game.creator, Number.isFinite(game.players) ? `${game.players.toLocaleString("es")} jugando` : ""].filter(Boolean).join(" · ");
  button.append(icon, name, meta);
  button.addEventListener("click", () => play(game.placeId));
  item.append(button);
  return item;
}

async function fetchFriends(userId) {
  const friendsRes = await robloxJson(`https://friends.roblox.com/v1/users/${userId}/friends`);
  const list = Array.isArray(friendsRes?.data) ? friendsRes.data : [];
  if (!list.length) return [];

  const presenceMap = new Map();
  const avatarMap = new Map();
  for (let i = 0; i < list.length; i += 50) {
    const chunkIds = list.slice(i, i + 50).map((f) => f.id);
    const [presRes, thumbRes] = await Promise.all([
      robloxPostWithCsrf("https://presence.roblox.com/v1/presence/users", { userIds: chunkIds }).catch(() => ({ json: null })),
      robloxJson(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunkIds.join(",")}&size=150x150&format=Png&isCircular=true`,
      ).catch(() => ({ data: [] })),
    ]);
    for (const p of presRes?.json?.userPresences ?? []) presenceMap.set(p.userId, p);
    for (const t of thumbRes?.data ?? []) if (t.imageUrl) avatarMap.set(t.targetId, t.imageUrl);
  }

  const stateOrder = { 2: 0, 1: 1, 3: 2, 0: 3 };
  return list
    .map((f) => {
      const p = presenceMap.get(f.id);
      const type = p?.userPresenceType ?? 0;
      const rawPlace = p?.placeId ?? p?.rootPlaceId ?? null;
      const placeId = rawPlace && /^[1-9]\d{0,18}$/.test(String(rawPlace)) ? String(rawPlace) : null;
      const gameId = typeof p?.gameId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(p.gameId) ? p.gameId : null;
      return {
        id: f.id,
        name: f.name,
        displayName: f.displayName || f.name,
        avatar: avatarMap.get(f.id) || "",
        type,
        location: p?.lastLocation || "",
        placeId,
        gameId,
      };
    })
    .sort((a, b) => (stateOrder[a.type] ?? 9) - (stateOrder[b.type] ?? 9) || a.displayName.localeCompare(b.displayName));
}

function friendItem(friend) {
  const item = document.createElement("li");
  item.className = "friend-card";

  const avatarWrap = document.createElement("div");
  avatarWrap.className = "friend-avatar-wrap";
  const img = document.createElement("img");
  img.className = "friend-avatar";
  img.alt = "";
  img.loading = "lazy";
  if (friend.avatar) img.src = friend.avatar;
  const dot = document.createElement("span");
  dot.className = "friend-dot";
  const state = friend.type === 2 ? "ingame" : friend.type === 1 ? "online" : friend.type === 3 ? "studio" : "offline";
  dot.dataset.state = state;
  avatarWrap.append(img, dot);

  const info = document.createElement("div");
  info.className = "friend-info";
  const name = document.createElement("div");
  name.className = "friend-name";
  name.textContent = friend.displayName !== friend.name ? `${friend.displayName} (@${friend.name})` : `@${friend.name}`;
  const presence = document.createElement("div");
  presence.className = "friend-presence";
  presence.dataset.state = state;
  if (friend.type === 2) {
    presence.textContent = friend.location ? `Jugando: ${friend.location}` : friend.placeId ? "En un juego" : "En juego (unión privada)";
  } else if (friend.type === 1) {
    presence.textContent = "En línea";
  } else if (friend.type === 3) {
    presence.textContent = "En Roblox Studio";
  } else {
    presence.textContent = "Desconectado";
  }
  info.append(name, presence);
  item.append(avatarWrap, info);

  if (friend.type === 2 && friend.placeId) {
    const joinBtn = document.createElement("button");
    joinBtn.type = "button";
    joinBtn.className = "friend-join";
    joinBtn.textContent = "Unirse";
    joinBtn.addEventListener("click", () => play(friend.placeId, friend.gameId));
    item.append(joinBtn);
  }
  return item;
}

function showLauncher() {
  document.getElementById("loading-overlay").hidden = true;
  document.body.classList.add("launcher-open");
  const themeCanvas = document.getElementById("theme-bg");
  startThemeBackground(themeCanvas, savedTheme());

  const launcher = document.createElement("main");
  launcher.className = "launcher";
  launcher.innerHTML = `
    <header class="glass-card topbar">
      <div class="brand-row">
        <span class="brand-badge">W</span>
        <span class="brand-title">Webblox</span>
      </div>
      <div class="account-controls">
        <span class="account-label">Comprobando sesión…</span>
        <button type="button" class="account-btn" hidden></button>
      </div>
    </header>
    <section class="glass-card search-card">
      <form role="search">
        <input type="search" placeholder="Busca juegos o pega un enlace / Place ID de Roblox" aria-label="Busca juegos o pega un enlace de juego" autocomplete="off" spellcheck="false">
        <button type="submit">Buscar</button>
      </form>
      <p class="launcher-status" role="status"></p>
      <ul class="launcher-games"></ul>
    </section>
    <section class="glass-card recent-card" hidden>
      <div class="section-head">
        <h2>Juegos recientes</h2>
        <button type="button" class="ghost-btn recent-clear">Limpiar</button>
      </div>
      <p class="friends-status recent-status"></p>
      <ul class="launcher-games recent-games"></ul>
    </section>
    <section class="glass-card friends-card" hidden>
      <div class="section-head">
        <h2>Amigos</h2>
        <button type="button" class="ghost-btn friends-refresh">Actualizar</button>
      </div>
      <p class="friends-status">Cargando amigos…</p>
      <ul class="friends-list"></ul>
    </section>
    <section class="glass-card settings-grid">
      <fieldset class="renderer-switch">
        <legend>Tema</legend>
        <label><input type="radio" name="theme" value="space"> Space</label>
        <label><input type="radio" name="theme" value="aurora"> Aurora</label>
        <label><input type="radio" name="theme" value="dark"> Oscuro</label>
      </fieldset>
      <fieldset class="renderer-switch">
        <legend>Gráficos</legend>
        <label><input type="radio" name="renderer" value=""> Automático</label>
        <label><input type="radio" name="renderer" value="webgpu"> WebGPU</label>
        <label><input type="radio" name="renderer" value="webgl"> WebGL</label>
      </fieldset>
      <p class="renderer-hint"></p>
      <fieldset class="renderer-switch quality-switch">
        <legend>Calidad</legend>
        <label><input type="radio" name="scale" value="1"> Alta</label>
        <label><input type="radio" name="scale" value="0.75"> Media</label>
        <label><input type="radio" name="scale" value="0.5"> Rendimiento</label>
      </fieldset>
      <p class="renderer-hint quality-hint"></p>
      <div class="toggle-row">
        <label class="toggle-pill"><input type="checkbox" id="toggleFps"> Mostrar FPS en una esquina</label>
        <label class="toggle-pill"><input type="checkbox" id="togglePerf"> Optimizar GPU y HiDPI (más FPS)</label>
      </div>
    </section>
    <section class="glass-card downloader" aria-labelledby="downloader-title">
      <h2 id="downloader-title">Motor de Roblox</h2>
      <p class="downloader-text">Comprobando…</p>
      <progress class="downloader-bar" max="1" value="0" hidden></progress>
      <button type="button" class="downloader-button" hidden>Descargar</button>
      <p class="cache-line" hidden><span class="cache-text"></span> <button type="button" class="cache-clear">Vaciar</button></p>
    </section>`;

  const accountLabel = launcher.querySelector(".account-label");
  const accountBtn = launcher.querySelector(".account-btn");
  const recentCard = launcher.querySelector(".recent-card");
  const recentStatus = launcher.querySelector(".recent-status");
  const recentList = launcher.querySelector(".recent-games");
  const recentClear = launcher.querySelector(".recent-clear");
  const friendsCard = launcher.querySelector(".friends-card");
  const friendsStatus = launcher.querySelector(".friends-status");
  const friendsList = launcher.querySelector(".friends-list");
  const friendsRefresh = launcher.querySelector(".friends-refresh");
  let activeUserId = null;

  const loadRecent = async () => {
    const localIds = readRecentPlaces();
    if (!localIds.length && !activeUserId) {
      recentCard.hidden = true;
      return;
    }
    recentCard.hidden = false;
    recentStatus.textContent = "Cargando recientes…";
    try {
      const games = await fetchRecentGames();
      if (!games.length) {
        recentCard.hidden = true;
        return;
      }
      recentStatus.textContent = "";
      recentList.replaceChildren(...games.map(gameItem));
    } catch {
      recentCard.hidden = true;
    }
  };

  recentClear.addEventListener("click", () => {
    clearRecentPlaces();
    recentList.replaceChildren();
    recentCard.hidden = true;
  });

  const loadFriends = async () => {
    if (!activeUserId) return;
    friendsCard.hidden = false;
    friendsRefresh.disabled = true;
    friendsStatus.textContent = "Actualizando amigos…";
    try {
      const friends = await fetchFriends(activeUserId);
      const inGame = friends.filter((f) => f.type === 2).length;
      const online = friends.filter((f) => f.type === 1 || f.type === 3).length;
      friendsStatus.textContent = friends.length
        ? `${friends.length} amigos · ${inGame} jugando · ${online} en línea`
        : "No tienes amigos añadidos en esta cuenta.";
      friendsList.replaceChildren(...friends.map(friendItem));
    } catch (error) {
      friendsStatus.textContent = `No se pudieron cargar los amigos: ${error.message || error}`;
    } finally {
      friendsRefresh.disabled = false;
    }
  };
  friendsRefresh.addEventListener("click", () => void loadFriends());

  const refreshAccount = async () => {
    accountBtn.hidden = true;
    if (!savedSession()) {
      const proxied = await proxySession().catch(() => null);
      if (proxied) storeSession(proxied);
    }
    const user = savedSession() ? await currentUser().catch(() => null) : null;
    accountBtn.hidden = false;
    if (user?.name) {
      activeUserId = user.id ?? null;
      accountLabel.textContent = `${user.displayName ? `${user.displayName} (@${user.name})` : `@${user.name}`}${WISP === DIRECT_WISP_URL ? " · Direct Sockets" : ""}`;
      accountBtn.textContent = "Cerrar sesión";
      accountBtn.classList.remove("primary");
      accountBtn.onclick = () => {
        forgetSession();
        activeUserId = null;
        friendsCard.hidden = true;
        friendsList.replaceChildren();
        void refreshAccount();
      };
      if (activeUserId) void loadFriends();
    } else {
      activeUserId = null;
      friendsCard.hidden = true;
      friendsList.replaceChildren();
      accountLabel.textContent = `Sin sesión${WISP === DIRECT_WISP_URL ? " · Direct Sockets" : ""}`;
      accountBtn.textContent = "Iniciar sesión";
      accountBtn.classList.add("primary");
      accountBtn.onclick = async () => {
        await askForSession(false, { allowCancel: true });
        void refreshAccount();
      };
    }
    void loadRecent();
  };
  void refreshAccount();

  const currentTheme = savedTheme();
  for (const radio of launcher.querySelectorAll('input[name="theme"]')) {
    radio.checked = radio.value === currentTheme;
    radio.addEventListener("change", () => {
      saveTheme(radio.value);
      startThemeBackground(themeCanvas, radio.value);
    });
  }

  const form = launcher.querySelector("form");
  const hint = launcher.querySelector(".renderer-hint");
  const hints = {
    "": "Automático usa WebGPU, salvo en Chrome anterior a 156 en x86, donde usa WebGL para evitar cierres.",
    webgpu: "WebGPU suele ir más fluido, pero en Chrome anterior a 156 en x86 el juego puede cerrarse a los pocos minutos.",
    webgl: "WebGL es más compatible y estable; puede ir algo más lento.",
  };
  const current = savedRenderer() ?? "";
  for (const radio of launcher.querySelectorAll('input[name="renderer"]')) {
    radio.checked = radio.value === current;
    radio.addEventListener("change", () => {
      saveRenderer(radio.value || null);
      hint.textContent = hints[radio.value];
    });
  }
  hint.textContent = hints[current];
  const qualityHint = launcher.querySelector(".quality-hint");
  const qualityHints = {
    "1": "Resolución completa.",
    "0.75": "Dibuja ~56 % de los píxeles: más FPS y menos consumo de memoria gráfica.",
    "0.5": "Dibuja 25 % de los píxeles: máximo rendimiento.",
  };
  const scale = savedScale();
  for (const radio of launcher.querySelectorAll('input[name="scale"]')) {
    radio.checked = radio.value === scale;
    radio.addEventListener("change", () => {
      saveScale(radio.value);
      qualityHint.textContent = qualityHints[radio.value];
    });
  }
  qualityHint.textContent = qualityHints[scale];

  const fpsToggle = launcher.querySelector("#toggleFps");
  fpsToggle.checked = savedShowFps();
  fpsToggle.addEventListener("change", () => saveBool(SHOW_FPS_KEY, fpsToggle.checked));

  const perfToggle = launcher.querySelector("#togglePerf");
  perfToggle.checked = savedPerfMode();
  perfToggle.addEventListener("change", () => saveBool(PERF_MODE_KEY, perfToggle.checked));

  void showCacheLine(launcher);
  if (!COMPAT.ok) {
    const note = document.createElement("p");
    note.className = "compat-note";
    note.setAttribute("role", "alert");
    note.textContent = COMPAT.message;
    launcher.prepend(note);
  }
  // label:has(input:checked) needs Chrome 105; mark the chosen option by class too.
  const markChecked = () => {
    for (const input of launcher.querySelectorAll(".renderer-switch input")) input.parentElement.classList.toggle("is-checked", input.checked);
  };
  launcher.addEventListener("change", markChecked);
  markChecked();
  void setUpDownloader(launcher);
  const input = launcher.querySelector(".search-card input");
  const status = launcher.querySelector(".launcher-status");
  const list = launcher.querySelector(".launcher-games");
  let search = 0;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const place = placeFromInput(input.value);
    if (place) return play(place);
    const query = input.value.trim();
    if (!query) return;
    const current = ++search;
    status.textContent = "Buscando…";
    list.replaceChildren();
    try {
      const games = await searchGames(query);
      if (current !== search) return;
      status.textContent = games.length ? "" : "No se encontraron juegos.";
      list.replaceChildren(...games.map(gameItem));
    } catch (error) {
      if (current === search) status.textContent = `La búsqueda falló: ${error.message || error}`;
    }
  });
  document.body.append(launcher);
  input.focus();
}

// ---- Browser check ------------------------------------------------------------

// Roblox documents that Chrome before 156 on x86 can crash the web client after
// about five minutes of play; only a browser update fixes it.
const CHROME_FIXED = 156;

async function chromeCrashRisk() {
  const data = navigator.userAgentData;
  if (!data?.getHighEntropyValues) return null;
  try {
    const { architecture, fullVersionList } = await data.getHighEntropyValues(["architecture", "fullVersionList"]);
    if (architecture !== "x86") return null;
    const chrome = (fullVersionList ?? []).find((b) => b.brand === "Google Chrome" || b.brand === "Chromium");
    const major = Number.parseInt(chrome?.version ?? "", 10);
    return Number.isFinite(major) && major < CHROME_FIXED ? major : null;
  } catch {
    return null;
  }
}

// On those Chrome versions the crash comes from WebGPU losing its device (the
// engine logs "[WebGPU] Device LOST" and cannot recover), so draw with WebGL
// instead, unless the URL already names a renderer.
async function avoidWebGpuOnOldChrome() {
  const url = new URL(location.href);
  if (url.searchParams.has("renderer") || savedRenderer() || (await chromeCrashRisk()) === null) return;
  url.searchParams.set("renderer", "webgl");
  history.replaceState(history.state, "", url);
  console.info("[blox] Chrome before 156 on x86: using WebGL instead of WebGPU");
}

async function warnOldChrome() {
  const major = await chromeCrashRisk();
  if (major === null) return;
  const note = document.createElement("aside");
  note.className = "browser-warning";
  note.setAttribute("role", "alert");
  const text = document.createElement("p");
  text.textContent = `Tienes Chrome ${major}. Para evitar que Roblox se cierre a los pocos minutos, se usa WebGL en lugar de WebGPU (puede ir algo más lento). Actualiza a Chrome ${CHROME_FIXED} o posterior en chrome://settings/help para usar WebGPU.`;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Entendido";
  close.addEventListener("click", () => note.remove());
  note.append(text, close);
  document.body.append(note);
}

// ---- Join errors ------------------------------------------------------------

// The engine reaches game servers itself, over WebTransport to
// *.qdmux.roblox.com, not through the Wisp server. A network that blocks
// those (school or work Wi-Fi often does) fails the join with "Failed to
// launch the game", which says nothing about why; add the likely cause.
function explainJoinErrors() {
  const message = document.getElementById("loading-error-message");
  if (!message) return;
  const note = document.createElement("p");
  note.className = "loading-error-hint";
  note.textContent =
    "Si estás en una red con restricciones (colegio, trabajo o una wifi pública), probablemente bloquea la conexión con los servidores de juego de Roblox. Prueba desde otra red, por ejemplo la de casa o los datos del móvil.";
  const update = () => {
    // "Failed to connect to the Game." (error 279) is what a blocked
    // WebTransport/QUIC handshake to the game server ends in.
    const code = document.getElementById("loading-error-code")?.textContent ?? "";
    const failed =
      /failed to (?:launch|connect)|launch the game|could not connect|unable to connect/i.test(message.textContent ?? "") ||
      /\b279\b/.test(code);
    if (failed && !note.isConnected) message.after(note);
    else if (!failed && note.isConnected) note.remove();
  };
  const observer = new MutationObserver(update);
  observer.observe(message, { childList: true, characterData: true, subtree: true });
  const codeElement = document.getElementById("loading-error-code");
  if (codeElement) observer.observe(codeElement, { childList: true, characterData: true, subtree: true });
}

// ---- Engine memory -------------------------------------------------------------

// WasmPlayer.js reserves the engine's shared memory in one block of
// FIntWasmMemoryPages (32767 pages, 2 GB) and gives up when the browser
// cannot find that much ("WebAssembly.Memory(): could not allocate memory":
// little free RAM, many tabs, or a 32-bit browser). WebClient.wasm only needs
// 4096 pages (256 MB), so ask again for less before failing.
const ENGINE_MIN_PAGES = 4096;
const MEMORY_FALLBACK_PAGES = [24576, 16384, 12288];

function allowSmallerEngineMemory() {
  const Native = WebAssembly.Memory;
  if (Native.__bloxFallback) return;
  function Memory(descriptor) {
    try {
      return new Native(descriptor);
    } catch (error) {
      const fixed = descriptor?.shared && descriptor.initial === descriptor.maximum;
      if (!(error instanceof RangeError) || !fixed) throw error;
      for (const pages of MEMORY_FALLBACK_PAGES) {
        if (pages >= descriptor.initial || pages < ENGINE_MIN_PAGES) continue;
        try {
          const memory = new Native({ ...descriptor, initial: pages, maximum: pages });
          console.warn(`[blox] ${descriptor.initial} pages of engine memory unavailable; running with ${pages} (${pages / 16} MB)`);
          return memory;
        } catch {}
      }
      say("No hay memoria libre suficiente para Roblox (necesita al menos 768 MB). Cierra otras pestañas o programas y recarga la página.");
      throw error;
    }
  }
  Memory.prototype = Native.prototype;
  Memory.__bloxFallback = true;
  WebAssembly.Memory = Memory;
}

allowSmallerEngineMemory();

// ---- Recovery -------------------------------------------------------------------

// Where the engine has no way back, offer one instead of a frozen page or a
// blocking alert(): the GPU dropped the WebGL context or the WebGPU device,
// or the server now runs a newer engine than the one this page loaded.
function showRecovery(message, actions) {
  if (document.querySelector(".recovery")) return;
  const panel = document.createElement("aside");
  panel.className = "recovery";
  panel.setAttribute("role", "alertdialog");
  const text = document.createElement("p");
  text.textContent = message;
  const buttons = document.createElement("div");
  buttons.className = "recovery-actions";
  for (const [label, run] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", run);
    buttons.append(button);
  }
  panel.append(text, buttons);
  document.body.append(panel);
  buttons.querySelector("button")?.focus();
}

function rejoin(renderer) {
  const url = new URL(location.href);
  if (renderer) url.searchParams.set("renderer", renderer);
  location.replace(url);
}

function watchGraphicsLoss() {
  // WasmPlayer.js answers a lost WebGL context with a blocking alert().
  const nativeAlert = window.alert.bind(window);
  window.alert = (message) => {
    if (/WebGL context lost/i.test(String(message))) {
      showRecovery("Se ha perdido la conexión con la tarjeta gráfica (WebGL). Vuelve a entrar para seguir jugando.", [
        ["Volver a entrar", () => rejoin()],
      ]);
      return;
    }
    nativeAlert(message);
  };
  // A lost WebGPU device only logs "[WebGPU] Device LOST"; the game freezes.
  const Adapter = globalThis.GPUAdapter;
  if (!Adapter?.prototype?.requestDevice) return;
  const requestDevice = Adapter.prototype.requestDevice;
  Adapter.prototype.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    device.lost?.then((info) => {
      if (info?.reason === "destroyed") return;
      console.error("[blox] WebGPU device lost:", info?.reason, info?.message);
      showRecovery("Se ha perdido la conexión con la tarjeta gráfica (WebGPU). Puedes volver a entrar, o hacerlo con WebGL, que es más estable.", [
        ["Volver a entrar con WebGL", () => rejoin("webgl")],
        ["Volver a entrar", () => rejoin()],
      ]);
    });
    return device;
  };
}

function watchEngineUpdates() {
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type !== "blox-engine-outdated") return;
    showRecovery("Webblox se ha actualizado mientras jugabas. Vuelve a entrar para cargar la versión nueva.", [["Volver a entrar", () => rejoin()]]);
  });
}

// Lets the browser keep the engine cache (about 230 MB) instead of clearing
// it when space runs low; it may still say no, which changes nothing.
function keepEngineCache() {
  navigator.storage?.persist?.().catch(() => {});
}

watchGraphicsLoss();
watchEngineUpdates();

// ---- Game cache -----------------------------------------------------------------
// sw.js keeps what games download from Roblox's CDN, and needs to know which
// places you visit most so their assets are the last to be cleared.

function askWorker(message) {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 5000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      resolve(data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

function recordVisit(placeId) {
  saveRecentPlace(placeId);
  navigator.serviceWorker?.controller?.postMessage({ type: "blox-visit", placeId });
}

async function placeNames(ids) {
  if (!ids.length) return new Map();
  try {
    const details = await robloxJson(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${ids.join(",")}`);
    return new Map((Array.isArray(details) ? details : []).map((d) => [String(d.placeId), d.name]));
  } catch {
    return new Map();
  }
}

async function showCacheLine(launcher) {
  const line = launcher.querySelector(".cache-line");
  const text = launcher.querySelector(".cache-text");
  const clear = launcher.querySelector(".cache-clear");
  const stats = await askWorker({ type: "blox-cache-stats" });
  if (!stats) return;
  const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  text.textContent = `Juegos guardados: ${megabytes(stats.bytes)} de ${megabytes(stats.budget)}.`;
  line.hidden = false;
  const ids = stats.top.map((v) => v.placeId);
  const names = await placeNames(ids);
  if (ids.length) {
    text.textContent += ` Se conservan antes los de tus juegos más visitados: ${ids.map((id) => names.get(id) ?? id).join(", ")}.`;
  }
  clear.addEventListener("click", async () => {
    clear.disabled = true;
    await askWorker({ type: "blox-cache-clear" });
    text.textContent = "Juegos guardados: 0 MB. Se volverán a guardar mientras juegas.";
  });
}

// ---- Engine downloader ------------------------------------------------------
// Fetches every engine file (the core and all of WebClient.fsindex.txt) ahead
// of time through sw.js, which keeps them, so the first game starts without
// waiting on downloads. Files already kept are answered from the cache.

const ENGINE_CORE = ["WasmPlayer.js", "WebClient.js", "WebClient.wasm", "WebClient.fsindex.txt", "audio-processor-fast.js"];
const DOWNLOAD_CONCURRENCY = 6;

function parseFsIndex(bytes) {
  const header = new TextEncoder().encode("rbxfsindex 1\n");
  if (!header.every((byte, i) => bytes[i] === byte)) throw new Error("WebClient.fsindex.txt: unsupported header");
  const decoder = new TextDecoder();
  const entries = [];
  let previous = new Uint8Array(0);
  let at = header.length;
  const until = (byte) => {
    const end = bytes.indexOf(byte, at);
    if (end < 0) throw new Error("WebClient.fsindex.txt: truncated line");
    const field = bytes.subarray(at, end);
    at = end + 1;
    return field;
  };
  while (at < bytes.length) {
    const shared = Number(decoder.decode(until(9)));
    const suffix = until(9);
    const size = Number(decoder.decode(until(10)));
    const path = new Uint8Array(shared + suffix.length);
    path.set(previous.subarray(0, shared));
    path.set(suffix, shared);
    entries.push({ path: decoder.decode(path), size });
    previous = path;
  }
  return entries;
}

async function engineFiles() {
  const base = await engineBase();
  if (base === ENGINE_ROOT) throw new Error("No se pudo saber qué versión del motor tiene el servidor.");
  const index = await fetch(`${base}/WebClient.fsindex.txt`);
  if (!index.ok) throw new Error(`El servidor respondió HTTP ${index.status} al pedir la lista de archivos.`);
  const content = parseFsIndex(new Uint8Array(await index.arrayBuffer()));
  const upload = base.slice(base.lastIndexOf("/") + 1);
  const files = [
    ...ENGINE_CORE.map((name) => ({ url: `${base}/${name}`, size: 0 })),
    ...content.map((entry) => ({ url: `${base}${encodeURI(entry.path)}`, size: entry.size })),
  ];
  return { upload, files, bytes: content.reduce((sum, entry) => sum + entry.size, 0) };
}

async function keptEngineFiles(upload) {
  try {
    if (!(await caches.has(`blox-engine-${upload}`))) return new Set();
    const cache = await caches.open(`blox-engine-${upload}`);
    return new Set((await cache.keys()).map((request) => request.url));
  } catch {
    return new Set();
  }
}

async function downloadEngine(files, onProgress, signal) {
  let next = 0;
  let done = 0;
  const failed = [];
  const worker = async () => {
    while (next < files.length && !signal.aborted) {
      const file = files[next++];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await fetch(file.url, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await response.arrayBuffer();
          break;
        } catch (error) {
          if (signal.aborted) return;
          if (attempt === 3) failed.push(file.url);
          else await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
      onProgress(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
  return failed;
}

async function setUpDownloader(launcher) {
  const text = launcher.querySelector(".downloader-text");
  const bar = launcher.querySelector(".downloader-bar");
  const button = launcher.querySelector(".downloader-button");
  if (location.protocol === "isolated-app:") {
    text.textContent = "Incluido en el paquete local (.swbn). Los juegos arrancan directo desde el disco.";
    return;
  }
  if (!navigator.serviceWorker?.controller || !("caches" in window)) {
    text.textContent = "Recarga la página para poder descargar el motor por adelantado.";
    return;
  }
  let plan;
  try {
    plan = await engineFiles();
  } catch (error) {
    text.textContent = `No se pudo preparar la descarga: ${error.message || error}`;
    return;
  }
  const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  const kept = await keptEngineFiles(plan.upload);
  const missing = plan.files.filter((file) => !kept.has(new URL(file.url, location.href).href));
  if (!missing.length) {
    text.textContent = `Descargado (${plan.upload}). Los juegos arrancan sin esperar a descargar el motor.`;
    return;
  }
  text.textContent = `Descárgalo ahora (${missing.length} de ${plan.files.length} archivos, unos ${megabytes(plan.bytes + 105e6)}) para que el primer juego arranque sin esperar.`;
  button.hidden = false;
  let controller = null;
  button.addEventListener("click", async () => {
    if (controller) {
      controller.abort();
      return;
    }
    controller = new AbortController();
    button.textContent = "Cancelar";
    bar.hidden = false;
    bar.value = 0;
    const failed = await downloadEngine(missing, (done, total) => {
      bar.value = done / total;
      text.textContent = `Descargando… ${done} de ${total} archivos (${Math.round((done / total) * 100)} %)`;
    }, controller.signal);
    const cancelled = controller.signal.aborted;
    controller = null;
    bar.hidden = true;
    if (cancelled) {
      text.textContent = "Descarga cancelada. Lo ya descargado se conserva; pulsa Descargar para seguir.";
      button.textContent = "Descargar";
    } else if (failed.length) {
      text.textContent = `Faltan ${failed.length} archivos que no se pudieron descargar. Pulsa Descargar para reintentarlos.`;
      button.textContent = "Descargar";
      missing.splice(0, missing.length, ...missing.filter((file) => failed.includes(file.url)));
    } else {
      text.textContent = `Descargado (${plan.upload}). Los juegos arrancan sin esperar a descargar el motor.`;
      button.hidden = true;
    }
  });
}

// ---- Boot ---------------------------------------------------------------------

async function controlled() {
  if (!("serviceWorker" in navigator)) throw new Error("Este navegador no admite service workers.");
  await navigator.serviceWorker.register(new URL("sw.js", ROOT), { scope: ROOT.pathname });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  // First visit: the worker claims this page once it activates.
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  if (!navigator.serviceWorker.controller) throw new Error("El service worker no tomó el control de esta página. Recarga para intentarlo de nuevo.");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.body.append(script);
  });
}

// What the inline check in index.html found (an older copy of the page has none).
const COMPAT = window.__bloxCompat ?? { ok: true, problems: [], message: "" };

function showUnsupported() {
  const overlay = document.getElementById("loading-overlay");
  overlay.classList.add("unsupported");
  say(COMPAT.message);
}

function keepScreenAwake() {
  if (!navigator.wakeLock?.request) return;
  let lock = null;
  const acquire = () => {
    if (document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then((s) => { lock = s; }).catch(() => {});
  };
  acquire();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!lock || lock.released)) acquire();
  });
}

function applyPerformanceOptimizations() {
  keepScreenAwake();
  if (!savedPerfMode()) return;

  if (window.devicePixelRatio > 1) {
    try {
      Object.defineProperty(window, "devicePixelRatio", { get: () => 1, configurable: true });
    } catch {}
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  if (!origGetContext.__bloxPerf) {
    const wrapped = function (type, attrs) {
      if (type === "webgl2" || type === "webgl") {
        // alpha: false + desynchronized enables Direct Scanout / zero-copy swapchain;
        // antialias: false avoids costly MSAA resolve on integrated GPUs.
        const merged = {
          alpha: false,
          antialias: false,
          preserveDrawingBuffer: false,
          powerPreference: "high-performance",
          desynchronized: true,
          ...(attrs || {}),
        };
        if (attrs?.alpha === undefined) merged.alpha = false;
        if (attrs?.antialias === undefined) merged.antialias = false;
        return origGetContext.call(this, type, merged);
      }
      return origGetContext.call(this, type, attrs);
    };
    wrapped.__bloxPerf = true;
    HTMLCanvasElement.prototype.getContext = wrapped;
  }

  if (navigator.gpu?.requestAdapter && !navigator.gpu.requestAdapter.__bloxPerf) {
    const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    const wrappedAdapter = (options) =>
      origRequestAdapter({ powerPreference: "high-performance", ...(options || {}) });
    wrappedAdapter.__bloxPerf = true;
    try {
      navigator.gpu.requestAdapter = wrappedAdapter;
    } catch {}
  }

  // Promote WebGPU canvas to hardware Direct Scanout overlay by avoiding alpha compositing.
  const gpuCtxProto = globalThis.GPUCanvasContext?.prototype;
  if (gpuCtxProto?.configure && !gpuCtxProto.configure.__bloxPerf) {
    const origConfigure = gpuCtxProto.configure;
    const wrappedConfigure = function (config) {
      return origConfigure.call(this, { ...config, alphaMode: "opaque" });
    };
    wrappedConfigure.__bloxPerf = true;
    try {
      gpuCtxProto.configure = wrappedConfigure;
    } catch {}
  }
}

function startFpsHud() {
  const hud = document.getElementById("fps-hud");
  if (!hud || !savedShowFps()) return;
  hud.hidden = false;
  hud.textContent = "Cargando…";

  let gpuFrames = 0;
  let offscreenFrames = 0;
  let glDrew = false;
  let sawEngineRender = false;

  // 1. WebGPU swapchain frames (1 getCurrentTexture() per presented frame)
  const gpuProto = globalThis.GPUCanvasContext?.prototype;
  if (gpuProto?.getCurrentTexture && !gpuProto.getCurrentTexture.__bloxFps) {
    const origGetTex = gpuProto.getCurrentTexture;
    const wrappedGetTex = function (...args) {
      sawEngineRender = true;
      gpuFrames++;
      return origGetTex.apply(this, args);
    };
    wrappedGetTex.__bloxFps = true;
    try {
      gpuProto.getCurrentTexture = wrappedGetTex;
    } catch {}
  }

  // 2. WebGL / WebGL2 frames (mark frame dirty on real draw/clear calls)
  for (const Ctx of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    const proto = Ctx?.prototype;
    if (!proto) continue;
    for (const method of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "clear"]) {
      const orig = proto[method];
      if (typeof orig !== "function" || orig.__bloxFps) continue;
      const wrapped = function (...args) {
        sawEngineRender = true;
        glDrew = true;
        return orig.apply(this, args);
      };
      wrapped.__bloxFps = true;
      try {
        proto[method] = wrapped;
      } catch {}
    }
  }

  // 3. OffscreenCanvas worker frames (if engine renders inside a Worker)
  let fpsChannel = null;
  if (typeof BroadcastChannel === "function") {
    try {
      fpsChannel = new BroadcastChannel("blox-fps");
      fpsChannel.onmessage = (event) => {
        if (event.data?.n > 0) {
          sawEngineRender = true;
          offscreenFrames += event.data.n;
        }
      };
    } catch {}
  }

  let lastReport = performance.now();
  const tick = (now) => {
    if (glDrew) {
      gpuFrames++;
      glDrew = false;
    }
    const elapsed = now - lastReport;
    if (elapsed >= 500) {
      const total = gpuFrames + offscreenFrames;
      if (!sawEngineRender) {
        hud.textContent = "Cargando…";
        delete hud.dataset.tier;
      } else {
        const fps = Math.round((total * 1000) / elapsed);
        const ms = total > 0 ? (elapsed / total).toFixed(1) : "—";
        hud.textContent = `${fps} FPS · ${ms} ms`;
        hud.dataset.tier = fps >= 50 ? "high" : fps >= 30 ? "mid" : "low";
      }
      gpuFrames = 0;
      offscreenFrames = 0;
      lastReport = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function boot() {
  const placeId = new URLSearchParams(location.search).get("placeId");
  const joining = Boolean(placeId && /^[1-9]\d{0,18}$/.test(placeId));
  // The launcher (search) only needs the service worker; the engine needs everything.
  if (!COMPAT.ok && (joining || !("serviceWorker" in navigator))) return showUnsupported();
  explainJoinErrors();
  void warnOldChrome();
  say("Conectando…");
  await controlled();
  await transport;
  // The engine only joins experiences: without a place it logs "no startup
  // place id" and exits, so pick one here first.
  if (!joining) return showLauncher();
  stopThemeBackground(document.getElementById("theme-bg"));
  applyPerformanceOptimizations();
  startFpsHud();
  say("Comprobando tu sesión de Roblox…");
  await ensureSession();
  keepEngineCache();
  recordVisit(placeId);
  say("Iniciando…");
  // What Roblox's WasmLoader.js leaves behind for WasmPlayer.js. channel null
  // keeps the engine on the production flags and channel.
  await avoidWebGpuOnOldChrome();
  const base = await engineBase();
  window.__wasmLoaderContext = { engineBase: base, channel: null, server: "prod" };
  await loadScript(`${base}/WasmPlayer.js`);
}

boot().catch((error) => {
  console.error("[blox]", error);
  say(error.message || String(error));
});
