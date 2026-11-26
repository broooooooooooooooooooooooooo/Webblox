// Packages Webblox (proxy/, webblox/, epoxy-transport, licenses/, and the full
// vendor/webblox/engine/ directory) into a standalone, 100% autonomous
// Signed Web Bundle (.swbn) Isolated Web App using Chrome Direct Sockets.
//
// Run:
//   bun run fetch:webblox
//   bun run build:proxy
//   bun run build:swbn
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { BundleBuilder } from "wbn";
import { NodeCryptoSigningStrategy, SignedWebBundle, WebBundleId } from "wbn-sign";

const SWBN_DIR = import.meta.dirname;
const ROOT = resolve(SWBN_DIR, "..");
const DIST = resolve(SWBN_DIR, "dist");
const KEY_PATH = resolve(SWBN_DIR, "iwa-key.pem");
const OUT_FILE = resolve(DIST, "webblox.swbn");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

function mimeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

function makePngIcon(size = 192) {
  const rowBytes = 1 + size * 4;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = x - size / 2;
      const dy = y - size / 2;
      const insideSquare = Math.abs(dx) < size * 0.34 && Math.abs(dy) < size * 0.34;
      const insideHole = Math.abs(dx) < size * 0.11 && Math.abs(dy) < size * 0.11;
      if (insideSquare && !insideHole) {
        raw[px] = 0x3d;
        raw[px + 1] = 0x7b;
        raw[px + 2] = 0xff;
        raw[px + 3] = 0xff;
      } else {
        raw[px] = 0x17;
        raw[px + 1] = 0x1b;
        raw[px + 2] = 0x26;
        raw[px + 3] = 0xff;
      }
    }
  }

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function loadOrCreatePrivateKey() {
  const fromEnv = process.env.IWA_SIGNING_KEY?.trim();
  if (fromEnv) {
    return createPrivateKey(fromEnv);
  }
  if (process.env.CI) {
    throw new Error("Missing IWA_SIGNING_KEY environment secret in CI. Every release must be signed with the same .pem key.");
  }
  try {
    const pem = await readFile(KEY_PATH, "utf8");
    return createPrivateKey(pem);
  } catch {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    await writeFile(KEY_PATH, pem, { mode: 0o600 });
    console.log(`[swbn] Generated new Ed25519 signing key at ${KEY_PATH}`);
    return privateKey;
  }
}

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
}

const ENGINE_WORKER_SHIM = Buffer.from(
  'try{if(typeof self!=="undefined"&&self.trustedTypes&&!self.trustedTypes.defaultPolicy){self.trustedTypes.createPolicy("default",{createHTML:function(s){return s},createScript:function(s){return s},createScriptURL:function(s){return s}})}}catch(e){};',
  "utf8",
);
const SHIM_ENGINE_SCRIPTS = new Set(["WasmPlayer.js", "WebClient.js", "audio-processor-fast.js"]);

async function addDirectory(builder, origin, urlPrefix, dir, { skipCompressed = true } = {}) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await addDirectory(builder, origin, `${urlPrefix}${entry.name}/`, fullPath, { skipCompressed });
      continue;
    }
    if (!entry.isFile()) continue;
    if (skipCompressed && (entry.name.endsWith(".br") || entry.name.endsWith(".gz"))) continue;

    let bytes = await readFile(fullPath);
    if (urlPrefix === "/blox/engine/" && SHIM_ENGINE_SCRIPTS.has(entry.name)) {
      bytes = Buffer.concat([ENGINE_WORKER_SHIM, bytes]);
    }
    const headers = responseHeaders(mimeFor(fullPath));
    if (entry.name === "index.html") {
      builder.addExchange(`${origin}${urlPrefix}`, 200, headers, bytes);
      builder.addExchange(`${origin}${urlPrefix}index.html`, 301, { Location: "./" }, "");
    } else {
      builder.addExchange(`${origin}${urlPrefix}${entry.name}`, 200, headers, bytes);
    }
  }
}

async function main() {
  const privateKey = await loadOrCreatePrivateKey();
  const publicKey = createPublicKey(privateKey);
  const bundleId = new WebBundleId(publicKey);
  const origin = bundleId.serializeWithIsolatedWebAppOrigin().replace(/\/+$/, "");

  const builder = new BundleBuilder("b2");

  await addDirectory(builder, origin, "/", resolve(ROOT, "proxy"));
  await addDirectory(builder, origin, "/blox/", resolve(ROOT, "webblox"));

  builder.addExchange(
    `${origin}/direct-wisp.js`,
    200,
    responseHeaders("text/javascript; charset=utf-8"),
    await readFile(resolve(ROOT, "webblox/direct-wisp.js")),
  );
  builder.addExchange(
    `${origin}/licenses/AGPL-3.0-Scramjet.txt`,
    200,
    responseHeaders("text/plain; charset=utf-8"),
    await readFile(resolve(ROOT, "licenses/AGPL-3.0-Scramjet.txt")),
  );
  builder.addExchange(
    `${origin}/epoxy/index.js`,
    200,
    responseHeaders("text/javascript; charset=utf-8"),
    await readFile(resolve(ROOT, "node_modules/@mercuryworkshop/epoxy-transport/dist/index.js")),
  );
  builder.addExchange(
    `${origin}/blox/epoxy.mjs`,
    200,
    responseHeaders("text/javascript; charset=utf-8"),
    await readFile(resolve(ROOT, "node_modules/@mercuryworkshop/epoxy-transport/dist/index.mjs")),
  );

  const engineDir = resolve(ROOT, "vendor/webblox/engine");
  let hasEngine = false;
  try {
    await stat(engineDir);
    hasEngine = true;
    await addDirectory(builder, origin, "/blox/engine/", engineDir, { skipCompressed: true });
  } catch {
    console.warn("[swbn] vendor/webblox/engine not found; bundle will not include the Roblox engine.");
  }

  builder.addExchange(`${origin}/blox/icon.png`, 200, responseHeaders("image/png"), makePngIcon(192));

  const manifest = {
    name: "Webblox",
    short_name: "Webblox",
    version: process.env.SWBN_VERSION || "1.0.0",
    id: "/",
    start_url: "/blox/",
    scope: "/",
    display: "standalone",
    background_color: "#18191c",
    theme_color: "#335fff",
    icons: [{ src: "/blox/icon.png", sizes: "192x192", type: "image/png" }],
    permissions_policy: {
      "cross-origin-isolated": ["self"],
      "direct-sockets": ["self"],
      "screen-wake-lock": ["self"],
      fullscreen: ["self"],
      gamepad: ["self"],
      "clipboard-read": ["self"],
      "clipboard-write": ["self"],
    },
  };
  builder.addExchange(
    `${origin}/.well-known/manifest.webmanifest`,
    200,
    responseHeaders("application/manifest+json; charset=utf-8"),
    JSON.stringify(manifest, null, 2),
  );

  const unsignedBundle = builder.createBundle();
  const signedBundle = await SignedWebBundle.fromWebBundle(unsignedBundle, [
    new NodeCryptoSigningStrategy(privateKey),
  ]);
  const bytes = signedBundle.getSignedWebBundleBytes();

  await mkdir(DIST, { recursive: true });
  await writeFile(OUT_FILE, bytes);

  console.log(`[swbn] Created ${OUT_FILE} (${(bytes.byteLength / 1048576).toFixed(2)} MiB)`);
  console.log(`[swbn] Isolated Web App Origin: ${origin}/blox/`);
  if (!hasEngine) {
    console.warn("[swbn] Run `bun run fetch:webblox` before `bun run build:swbn` to include the engine.");
  }
}

await main();
