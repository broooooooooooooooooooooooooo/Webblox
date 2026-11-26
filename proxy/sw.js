// Scramjet service worker.
// Loads the controller, which intercepts and routes proxied requests.
// This file MUST be served from your site root so its scope covers the whole app.
if (typeof self.trustedTypes !== "undefined" && !self.trustedTypes.defaultPolicy) {
  try {
    self.trustedTypes.createPolicy("default", {
      createHTML: (value) => value,
      createScript: (value) => value,
      createScriptURL: (value) => {
        const url = new URL(value, self.location.href);
        if (url.origin === self.location.origin || url.protocol === "blob:") return value;
        throw new TypeError(`Blocked untrusted script URL: ${value}`);
      },
    });
  } catch {}
}

importScripts("/controller/controller.sw.js");

addEventListener("fetch", (e) => {
  if ($scramjetController.shouldRoute(e)) {
    e.respondWith($scramjetController.route(e));
  }
});
