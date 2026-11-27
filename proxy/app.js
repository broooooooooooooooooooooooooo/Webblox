import { bloxUrl, createBloxLaunchPlugin } from "/launch-plugin.mjs";
import { DIRECT_WISP_URL, hasDirectSockets, installDirectWisp } from "/direct-wisp.js";

const { Controller, ManagedPlugin } = window.$scramjetController;
const { defaultConfig } = window.$scramjet;
const EpoxyTransport = window.EpoxyTransport.default;
const iframe = document.getElementById("browserFrame");
const input = document.getElementById("urlInput");
const status = document.getElementById("status");
const PUBLIC_WISP = "wss://wisp.mercurywork.shop/";
const direct = hasDirectSockets();
const isIwa = location.protocol === "isolated-app:";
const paramWisp = new URLSearchParams(location.search).get("wisp");
const wisp = new URL(
  paramWisp && /^wss?:\/\//i.test(paramWisp)
    ? paramWisp
    : isIwa
      ? PUBLIC_WISP
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`,
);
if (wisp.href === DIRECT_WISP_URL && direct) installDirectWisp();
let frame;
const parked = document.getElementById("parked");

function park() {
  setTimeout(() => {
    frame?.go("data:text/html,");
    iframe.hidden = true;
    parked.hidden = false;
    setStatus("Juego abierto");
  }, 1500);
}

function unpark() {
  parked.hidden = true;
  iframe.hidden = false;
  frame?.go("https://www.roblox.com/home");
  setStatus("Proxy listo");
}
document.getElementById("unpark").addEventListener("click", unpark);

function openGameWindow(url) {
  const width = Math.round(screen.availWidth * 0.9);
  const height = Math.round(screen.availHeight * 0.9);
  const left = Math.round((screen.availWidth - width) / 2);
  const top = Math.round((screen.availHeight - height) / 2);
  const popup = window.open(url, "_blank", `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (popup) park();
  return popup;
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? "error" : "ok";
}

function robloxUrl(value) {
  const raw = value.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!/(^|\.)roblox\.com$/i.test(url.hostname) && !/(^|\.)(rbxcdn\.com|robloxlabs\.com)$/i.test(url.hostname)) {
    throw new Error("Por seguridad, este proxy solo abre páginas de Roblox.");
  }
  if (url.protocol !== "https:") throw new Error("Usa una dirección HTTPS de Roblox.");
  return url.href;
}

document.getElementById("homeButton").addEventListener("click", () => (parked.hidden ? frame?.go("https://www.roblox.com/home") : unpark()));
document.getElementById("reloadButton").addEventListener("click", () => (parked.hidden ? frame?.go(input.value) : unpark()));
document.getElementById("addressForm").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const url = robloxUrl(input.value);
    input.value = url;
    parked.hidden = true;
    iframe.hidden = false;
    frame?.go(url);
  } catch (error) {
    setStatus(error.message, true);
  }
});

async function start() {
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    const serviceworker = navigator.serviceWorker.controller ?? registration.active;
    if (!serviceworker) throw new Error("No se pudo iniciar el service worker.");

    const useDirect = wisp.href === DIRECT_WISP_URL && direct;
    const transport = new EpoxyTransport({ wisp: wisp.href, ...(useDirect ? { wisp_v2: false } : {}) });
    await transport.init();

    const controller = new Controller({ serviceworker, transport, scramjetConfig: defaultConfig });
    await controller.wait();

    const launchPlugin = createBloxLaunchPlugin(ManagedPlugin, {
      url: (launch) => bloxUrl("/blox/", launch, direct ? DIRECT_WISP_URL : wisp.href),
      open: openGameWindow,
      notify: setStatus,
    });
    frame = controller.createFrame(iframe, { plugins: [launchPlugin] });
    frame.go("https://www.roblox.com/login");
    setStatus("Proxy listo");
  } catch (error) {
    console.error(error);
    setStatus(`No se pudo iniciar Roblox: ${error.message || error}`, true);
  }
}

if ("serviceWorker" in navigator) void start();
else setStatus("Este navegador no admite el proxy necesario para iniciar sesión.", true);
