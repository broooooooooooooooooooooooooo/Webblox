(function () {
  var problems = [];
  var ua = navigator.userAgent;
  var match = /Chrom(?:e|ium)\/(\d+)/.exec(ua);
  var chrome = match ? Number(match[1]) : 0;
  var wasm = typeof WebAssembly === "object";
  if (!("serviceWorker" in navigator)) problems.push("service workers");
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer !== "function") problems.push("memoria compartida (SharedArrayBuffer)");
  if (!wasm) problems.push("WebAssembly");
  else if (typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function") problems.push("JSPI de WebAssembly");
  var webgl2 = false;
  try { webgl2 = !!document.createElement("canvas").getContext("webgl2"); } catch (e) {}
  if (!webgl2 && !navigator.gpu) problems.push("WebGL 2 o WebGPU");
  if (typeof WebTransport !== "function") problems.push("WebTransport");
  var advice;
  if (chrome && chrome < 123) advice = "Tienes Chrome " + chrome + ". El motor de Roblox necesita Chrome 137 o posterior: actualízalo en chrome://settings/help.";
  else if (chrome && chrome < 137) advice = "Tienes Chrome " + chrome + ". Actualízalo a la versión 137 o posterior en chrome://settings/help, o activa \"Experimental WebAssembly JavaScript Promise Integration (JSPI)\" en chrome://flags y reinicia el navegador.";
  else advice = "Usa una versión reciente de Chrome o Edge (137 o posterior).";
  window.__bloxCompat = {
    ok: problems.length === 0,
    problems: problems,
    message: problems.length ? "Este navegador no puede ejecutar el motor de Roblox: le falta " + problems.join(", ") + ". " + advice : ""
  };
})();
