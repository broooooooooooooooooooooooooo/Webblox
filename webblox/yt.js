// Embedded YouTube stealth page for #expectedFrame.
// Persists last watched video, saved videos, and history in localStorage.

const YT_STORE_KEY = "blox.yt.v1";

const DEFAULT_VIDEOS = [
  { id: "jfKfPfyJRdk", title: "lofi hip hop radio 📚 beats to relax/study to", channel: "Lofi Girl" },
  { id: "4xDzrJKXOOY", title: "synthwave radio 🌌 chill synth / retro beats", channel: "Lofi Girl Synthwave" },
  { id: "DWcJFNfaw9c", title: "lofi hip hop radio 💤 beats to sleep/chill to", channel: "Lofi Girl" },
  { id: "5yx6BWlEVcY", title: "Chillhop Radio - jazzy & lofi hip hop beats", channel: "Chillhop Music" },
];

const form = document.getElementById("ytForm");
const input = document.getElementById("ytInput");
const player = document.getElementById("ytPlayer");
const titleEl = document.getElementById("ytTitle");
const hintEl = document.getElementById("ytHint");
const listEl = document.getElementById("ytList");
const saveBtn = document.getElementById("ytSaveBtn");
const backBtn = document.getElementById("ytBackBtn");
const clearBtn = document.getElementById("ytClearBtn");

function readState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(YT_STORE_KEY) || "null");
    if (parsed && typeof parsed === "object" && typeof parsed.currentId === "string") {
      return {
        currentId: parsed.currentId,
        videos: Array.isArray(parsed.videos) && parsed.videos.length ? parsed.videos : [...DEFAULT_VIDEOS],
        lastQuery: typeof parsed.lastQuery === "string" ? parsed.lastQuery : "",
      };
    }
  } catch {}
  return { currentId: DEFAULT_VIDEOS[0].id, videos: [...DEFAULT_VIDEOS], lastQuery: "" };
}

let state = readState();

function persist() {
  try {
    localStorage.setItem(YT_STORE_KEY, JSON.stringify(state));
  } catch {}
}

function extractVideoId(raw) {
  const value = raw.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
      const v = url.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const parts = url.pathname.split("/").filter(Boolean);
      if ((parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") && /^[A-Za-z0-9_-]{11}$/.test(parts[1] || "")) {
        return parts[1];
      }
    }
  } catch {}
  return null;
}

function embedUrl(videoId, autoplay = false) {
  const params = new URLSearchParams({
    rel: "0",
    modestbranding: "1",
    enablejsapi: "1",
    ...(autoplay ? { autoplay: "1" } : {}),
  });
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

function loadVideo(id, { title = "", channel = "Guardado en Webblox", autoplay = true } = {}) {
  state.currentId = id;
  const existing = state.videos.find((v) => v.id === id);
  if (!existing) {
    state.videos = [{ id, title: title || `Video ${id}`, channel }, ...state.videos].slice(0, 25);
  }
  const active = state.videos.find((v) => v.id === id) || { id, title: title || `Video ${id}`, channel };
  titleEl.textContent = active.title;
  const nextSrc = embedUrl(id, autoplay);
  if (player.src !== nextSrc) player.src = nextSrc;
  persist();
  renderList();
}

function renderList() {
  listEl.replaceChildren();
  for (const video of state.videos) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "yt-item";
    if (video.id === state.currentId) btn.classList.add("is-active");

    const img = document.createElement("img");
    img.className = "yt-thumb";
    img.alt = "";
    img.loading = "lazy";
    img.src = `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;

    const info = document.createElement("div");
    info.className = "yt-item-info";
    const t = document.createElement("span");
    t.className = "yt-item-title";
    t.textContent = video.title;
    const sub = document.createElement("span");
    sub.className = "yt-item-sub";
    sub.textContent = video.channel || video.id;
    info.append(t, sub);

    btn.append(img, info);
    btn.addEventListener("click", () => loadVideo(video.id, { autoplay: true }));
    li.append(btn);
    listEl.append(li);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  state.lastQuery = query;
  persist();
  const id = extractVideoId(query);
  if (id) {
    hintEl.textContent = "Video cargado y guardado en tu historial local.";
    loadVideo(id, { title: `YouTube (${id})`, channel: "Enlace guardado", autoplay: true });
    return;
  }
  const searchSrc = `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(query)}`;
  player.src = searchSrc;
  titleEl.textContent = `Búsqueda: ${query}`;
  hintEl.textContent = "Mostrando resultados para tu búsqueda (también puedes pegar cualquier URL o ID de YouTube).";
});

saveBtn.addEventListener("click", () => {
  const id = extractVideoId(input.value) || state.currentId;
  if (!id) return;
  const label = input.value.trim() && !extractVideoId(input.value) ? input.value.trim() : titleEl.textContent;
  const idx = state.videos.findIndex((v) => v.id === id);
  const entry = { id, title: label || `Video ${id}`, channel: "Favorito guardado" };
  if (idx >= 0) state.videos[idx] = entry;
  else state.videos.unshift(entry);
  state.currentId = id;
  persist();
  renderList();
  hintEl.textContent = "Video guardado permanentemente en tus datos locales.";
});

clearBtn.addEventListener("click", () => {
  state = { currentId: DEFAULT_VIDEOS[0].id, videos: [...DEFAULT_VIDEOS], lastQuery: "" };
  input.value = "";
  persist();
  loadVideo(state.currentId, { autoplay: false });
  hintEl.textContent = "Lista restablecida a los videos predeterminados.";
});

const toggleBack = () => {
  try {
    window.parent?.postMessage({ type: "blox-toggle-expected" }, location.origin);
  } catch {}
};

backBtn.addEventListener("click", toggleBack);

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.altKey && (event.key.toLowerCase() === "y" || event.code === "KeyY")) {
    event.preventDefault();
    event.stopPropagation();
    toggleBack();
  }
}, { capture: true });

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  if (event.data?.type === "blox-yt-pause") {
    try {
      player.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "pauseVideo", args: [] }), "*");
    } catch {}
  } else if (event.data?.type === "blox-yt-save") {
    persist();
  }
});

if (state.lastQuery) input.value = state.lastQuery;
loadVideo(state.currentId, { autoplay: false });
