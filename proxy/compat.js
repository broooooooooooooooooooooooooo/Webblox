(function () {
  if (typeof window.trustedTypes !== "undefined" && !window.trustedTypes.defaultPolicy) {
    try {
      window.trustedTypes.createPolicy("default", {
        createHTML: function (value) { return value; },
        createScript: function (value) { return value; },
        createScriptURL: function (value) {
          var url = new URL(value, location.href);
          if (url.origin === location.origin || url.protocol === "blob:") return value;
          throw new TypeError("Blocked untrusted script URL: " + value);
        }
      });
    } catch (e) {}
  }

  var match = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
  var chrome = match ? Number(match[1]) : 0;
  var wasm = typeof WebAssembly === "object";
  var jspi = wasm && typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";
  var message = "";
  if (!("serviceWorker" in navigator) || !wasm) message = "Este navegador es demasiado antiguo para Webblox. Usa Chrome o Edge 137 o posterior.";
  else if (!jspi) message = (chrome ? "Tienes Chrome " + chrome + ". " : "") + "Puedes iniciar sesión, pero para jugar necesitas Chrome 137 o posterior (actualízalo en chrome://settings/help)" + (chrome >= 123 && chrome < 137 ? ", o activar \"Experimental WebAssembly JavaScript Promise Integration (JSPI)\" en chrome://flags" : "") + ".";
  if (!message) return;
  var note = document.getElementById("compat");
  note.textContent = message;
  note.hidden = false;
})();
