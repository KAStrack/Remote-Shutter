// Data channel protocol: JSON control messages (strings) plus binary photo
// chunks (ArrayBuffers). The channel is ordered and reliable, so chunks
// arrive in order between a photoStart header and a photoEnd trailer.

export const MSG = {
  // viewer -> camera
  CAPTURE: 'capture',
  TIMER_START: 'timerStart',
  TIMER_CANCEL: 'timerCancel',
  SWITCH_CAMERA: 'switchCamera',
  SET_ZOOM: 'setZoom',
  SET_ROTATION: 'setRotation',
  // camera -> viewer
  STATUS: 'status',
  TIMER_TICK: 'timerTick',
  SHUTTER: 'shutter',
  PHOTO_START: 'photoStart',
  PHOTO_END: 'photoEnd',
  ERROR: 'error',
  // either way
  BYE: 'bye',
};

export const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

export function send(dc, type, data = {}) {
  if (dc.readyState !== 'open') return false;
  dc.send(JSON.stringify({ type, ...data }));
  return true;
}

// Listen for messages. Strings are parsed as JSON control messages and
// passed to onMessage; ArrayBuffers go to onBinary.
export function listen(dc, onMessage, onBinary) {
  dc.addEventListener('message', (e) => {
    if (typeof e.data === 'string') {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && typeof msg.type === 'string') onMessage(msg);
    } else if (onBinary) {
      onBinary(e.data);
    }
  });
}

function chunkSizeFor(dc, pc) {
  // Respect the negotiated SCTP limit; 16 KB is safe on every browser anyway.
  const max = pc?.sctp?.maxMessageSize;
  return max ? Math.min(CHUNK_SIZE, max) : CHUNK_SIZE;
}

function waitForDrain(dc) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', onLow);
      dc.removeEventListener('close', onClose);
    };
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Connection closed during transfer')); };
    dc.addEventListener('bufferedamountlow', onLow);
    dc.addEventListener('close', onClose);
  });
}

let nextId = 1;

// Send a Blob as photoStart + chunks + photoEnd, pausing while the channel's
// buffer is full. Extra fields in `meta` are copied into photoStart.
export async function sendPhoto(dc, pc, blob, meta = {}, onProgress) {
  const chunkSize = chunkSizeFor(dc, pc);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = nextId++;
  const chunks = Math.ceil(bytes.length / chunkSize);
  dc.bufferedAmountLowThreshold = LOW_WATER;
  send(dc, MSG.PHOTO_START, { id, size: bytes.length, mime: blob.type || 'image/jpeg', chunks, ...meta });
  for (let i = 0; i < chunks; i++) {
    if (dc.readyState !== 'open') throw new Error('Connection closed during transfer');
    if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);
    // slice() copies, so each message owns its own buffer.
    dc.send(bytes.slice(i * chunkSize, (i + 1) * chunkSize).buffer);
    onProgress?.((i + 1) / chunks);
  }
  send(dc, MSG.PHOTO_END, { id });
  return id;
}

// Reassembles photos on the receiving side.
export class PhotoReceiver {
  constructor({ onStart, onProgress, onPhoto, onError }) {
    Object.assign(this, { onStart, onProgress, onPhoto, onError });
    this.current = null;
  }

  // Returns true if the message was part of a photo transfer.
  handleMessage(msg) {
    if (msg.type === MSG.PHOTO_START) {
      if (!(msg.size > 0) || !(msg.chunks > 0)) { this.onError?.(new Error('Bad photo header')); return true; }
      this.current = { meta: msg, parts: [], received: 0 };
      this.onStart?.(msg);
      return true;
    }
    if (msg.type === MSG.PHOTO_END) {
      const cur = this.current;
      this.current = null;
      if (!cur || cur.meta.id !== msg.id) { this.onError?.(new Error('Photo transfer got out of step')); return true; }
      if (cur.received !== cur.meta.size || cur.parts.length !== cur.meta.chunks) {
        this.onError?.(new Error(`Photo arrived incomplete (${cur.received} of ${cur.meta.size} bytes)`));
        return true;
      }
      this.onPhoto?.(new Blob(cur.parts, { type: cur.meta.mime }), cur.meta);
      return true;
    }
    return false;
  }

  handleBinary(buf) {
    const cur = this.current;
    if (!cur) return;
    cur.parts.push(buf);
    cur.received += buf.byteLength;
    this.onProgress?.(Math.min(1, cur.received / cur.meta.size), cur.meta);
  }

  reset() { this.current = null; }
}
