// In-browser Wisp (v1 & v2) server bridge backed by Chrome Isolated Web App
// Direct Sockets API (`TCPSocket`). When `TCPSocket` is available, EpoxyTransport
// talks directly to Roblox from the user's own browser with zero external servers.

export const DIRECT_WISP_URL = "wss://direct.wisp.invalid/wisp/";
const DIRECT_PATCHED = Symbol("blox.directWisp");

const HOSTNAME_WHITELIST = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com|arkoselabs\.com|funcaptcha\.com|px-cloud\.net)$/i;
const PORT_WHITELIST = new Set([443]);

const PACKET = {
  CONNECT: 0x01,
  DATA: 0x02,
  CONTINUE: 0x03,
  CLOSE: 0x04,
  INFO: 0x05,
};

const STREAM_TYPE = {
  TCP: 0x01,
  UDP: 0x02,
};

const CLOSE_REASON = {
  UNKNOWN: 0x01,
  VOLUNTARY: 0x02,
  NETWORK_ERROR: 0x03,
  CONN_REFUSED: 0x44,
  HOST_BLOCKED: 0x48,
};

const SEND_BUFFER_SIZE = 512;
const CONTINUE_STEP = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function hasDirectSockets() {
  return typeof globalThis.TCPSocket === "function";
}

function u32Packet(type, streamId, value) {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  buf[0] = type;
  view.setUint32(1, streamId, true);
  view.setUint32(5, value, true);
  return buf;
}

function closePacket(streamId, reason) {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  buf[0] = PACKET.CLOSE;
  view.setUint32(1, streamId, true);
  buf[5] = reason;
  return buf;
}

function dataPacket(streamId, payload) {
  const buf = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(buf.buffer);
  buf[0] = PACKET.DATA;
  view.setUint32(1, streamId, true);
  buf.set(payload, 5);
  return buf;
}

function infoPacket(major, minor) {
  const buf = new Uint8Array(7);
  const view = new DataView(buf.buffer);
  buf[0] = PACKET.INFO;
  view.setUint32(1, 0, true);
  buf[5] = major;
  buf[6] = minor;
  return buf;
}

class DirectWispWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  constructor(url, protocols) {
    super();
    this.url = String(url);
    const list = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    this.protocol = list.includes("wisp-v2") ? "wisp-v2" : "";
    this.extensions = "";
    this.binaryType = "blob";
    this.bufferedAmount = 0;
    this.readyState = DirectWispWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._streams = new Map();
    this._handshakeDone = false;

    queueMicrotask(() => {
      if (this.readyState !== DirectWispWebSocket.CONNECTING) return;
      this.readyState = DirectWispWebSocket.OPEN;
      const openEvent = new Event("open");
      this.onopen?.(openEvent);
      this.dispatchEvent(openEvent);

      if (this.protocol !== "wisp-v2") {
        this._handshakeDone = true;
        this._emitPacket(u32Packet(PACKET.CONTINUE, 0, SEND_BUFFER_SIZE));
      }
    });
  }

  _emitPacket(bytes) {
    if (this.readyState !== DirectWispWebSocket.OPEN) return;
    const data =
      this.binaryType === "arraybuffer"
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : new Blob([bytes]);
    const event = new MessageEvent("message", { data });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  send(raw) {
    if (this.readyState !== DirectWispWebSocket.OPEN) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    let bytes;
    if (raw instanceof Uint8Array) bytes = raw;
    else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    else return;

    if (bytes.byteLength < 5) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = bytes[0];
    const streamId = view.getUint32(1, true);
    const payload = bytes.subarray(5);

    if (streamId === 0) {
      if (type === PACKET.INFO && !this._handshakeDone) {
        this._handshakeDone = true;
        this._emitPacket(infoPacket(2, 0));
        this._emitPacket(u32Packet(PACKET.CONTINUE, 0, SEND_BUFFER_SIZE));
      }
      return;
    }

    if (type === PACKET.CONNECT) {
      this._openStream(streamId, payload);
    } else if (type === PACKET.DATA) {
      const stream = this._streams.get(streamId);
      if (stream) stream.enqueue(payload.slice());
    } else if (type === PACKET.CLOSE) {
      this._closeStream(streamId, null, false);
    }
  }

  _openStream(streamId, payload) {
    if (this._streams.has(streamId) || payload.byteLength < 3) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const streamType = payload[0];
    const port = view.getUint16(1, true);
    const hostname = decoder.decode(payload.subarray(3)).trim();

    if (streamType !== STREAM_TYPE.TCP || !HOSTNAME_WHITELIST.test(hostname) || !PORT_WHITELIST.has(port)) {
      this._emitPacket(closePacket(streamId, CLOSE_REASON.HOST_BLOCKED));
      return;
    }

    let tcp;
    try {
      tcp = new globalThis.TCPSocket(hostname, port);
    } catch {
      this._emitPacket(closePacket(streamId, CLOSE_REASON.NETWORK_ERROR));
      return;
    }

    const state = {
      tcp,
      writer: null,
      reader: null,
      closed: false,
      draining: false,
      queue: [],
      packetsWritten: 0,
      enqueue: (chunk) => {
        if (state.closed) return;
        state.queue.push(chunk);
        if (state.writer && !state.draining) void state.drain();
      },
      drain: async () => {
        if (state.draining || state.closed || !state.writer) return;
        state.draining = true;
        try {
          while (!state.closed && state.queue.length > 0) {
            const batch = state.queue.splice(0, state.queue.length);
            for (let i = 0; i < batch.length; i++) {
              await state.writer.write(batch[i]);
              state.packetsWritten++;
              if (state.packetsWritten % CONTINUE_STEP === 0) {
                this._emitPacket(u32Packet(PACKET.CONTINUE, streamId, SEND_BUFFER_SIZE));
              }
            }
          }
        } catch {
          this._closeStream(streamId, CLOSE_REASON.NETWORK_ERROR, true);
        } finally {
          state.draining = false;
        }
      },
    };
    this._streams.set(streamId, state);

    tcp.opened
      .then(({ readable, writable }) => {
        if (state.closed) {
          tcp.close().catch(() => {});
          return;
        }
        state.writer = writable.getWriter();
        state.reader = readable.getReader();
        if (state.queue.length > 0) void state.drain();
        void this._pumpReads(streamId, state);
      })
      .catch(() => {
        this._closeStream(streamId, CLOSE_REASON.CONN_REFUSED, true);
      });
  }

  async _pumpReads(streamId, state) {
    try {
      while (!state.closed) {
        const { value, done } = await state.reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          this._emitPacket(dataPacket(streamId, value));
        }
      }
      this._closeStream(streamId, CLOSE_REASON.VOLUNTARY, true);
    } catch {
      this._closeStream(streamId, CLOSE_REASON.NETWORK_ERROR, true);
    }
  }

  _closeStream(streamId, reason, notifyClient) {
    const stream = this._streams.get(streamId);
    if (!stream) return;
    this._streams.delete(streamId);
    stream.closed = true;
    try { stream.reader?.cancel().catch(() => {}); } catch {}
    try { stream.writer?.close().catch(() => {}); } catch {}
    try { stream.tcp?.close().catch(() => {}); } catch {}
    if (notifyClient && reason !== null) {
      this._emitPacket(closePacket(streamId, reason));
    }
  }

  close(code = 1000, reason = "") {
    if (this.readyState === DirectWispWebSocket.CLOSED) return;
    this.readyState = DirectWispWebSocket.CLOSED;
    for (const streamId of [...this._streams.keys()]) {
      this._closeStream(streamId, null, false);
    }
    const event = new CloseEvent("close", { code, reason, wasClean: true });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }
}

export function installDirectWisp() {
  if (!hasDirectSockets()) return false;
  const NativeWebSocket = globalThis.WebSocket;
  if (NativeWebSocket?.[DIRECT_PATCHED]) return true;

  function PatchedWebSocket(url, protocols) {
    if (typeof url === "string" && url.startsWith("wss://direct.wisp.invalid/")) {
      return new DirectWispWebSocket(url, protocols);
    }
    return protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  PatchedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = NativeWebSocket.OPEN;
  PatchedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  PatchedWebSocket[DIRECT_PATCHED] = true;

  globalThis.WebSocket = PatchedWebSocket;
  return true;
}
