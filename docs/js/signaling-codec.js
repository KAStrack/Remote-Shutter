// Compact signaling codec.
//
// A full SDP offer is 4-7 KB, far too big for a QR code. Both peers are
// browsers that only ever negotiate one sendonly/recvonly video m-line plus
// one data channel, so we extract the handful of values that actually vary
// (ICE credentials, DTLS fingerprint, setup role, codec payload types,
// header-extension ids, SSRCs, host candidates), pack them into a small
// binary structure, and rebuild a valid SDP from a template on the other side.
//
// Wire format (before base32):
//   [flag byte: 0 = raw, 1 = deflate-raw] [body]
// Body:
//   u8  version (1)
//   u8  bits: 0 = type (0 offer, 1 answer), 1-2 = setup (0 actpass, 1 active,
//       2 passive), 3-4 = fingerprint algorithm
//   str ufrag, str pwd   (header byte: 2-bit charset + 6-bit length, then
//                         6 bits/char for base64 chars, 4 for hex, else 8)
//   the fingerprint digest bytes
//   u8  sctp max-message-size as a power of two (0 = not present)
//   u8  codec count, then per codec: u8 kind (+0x80 if it has rtx), u8 pt,
//       (+ u8 rtx pt)
//   u8  bitmask of header extensions present, then their ids, 4 bits each
//   u8  ssrc count, then u32 each      (primary, rtx)
//   u8  candidate count, then per candidate: u8 kind, address bytes, u16 port
//
// The text form is RFC 4648 base32 (no padding), which fits the QR
// alphanumeric mode: 5.5 bits per character instead of 8 for base64 bytes.

export const VERSION = 1;

const FP_ALGS = ['sha-256', 'sha-1', 'sha-384', 'sha-512'];
const FP_LENGTHS = { 'sha-1': 20, 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 };
const SETUPS = ['actpass', 'active', 'passive'];

// Codec kinds we know how to rebuild. The camera restricts its offer to these
// with setCodecPreferences, so anything else is safely dropped.
export const CODEC = {
  VP8: 1,
  VP9: 2,        // profile-id=0
  H264_CB: 3,    // 42e01f, packetization-mode=1 (constrained baseline)
  H264_B: 4,     // 42001f, packetization-mode=1 (baseline)
};
const RTX_FLAG = 0x80;

const EXT_URIS = {
  1: 'urn:ietf:params:rtp-hdrext:sdes:mid',
  2: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  3: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  4: 'urn:3gpp:video-orientation',
  5: 'urn:ietf:params:rtp-hdrext:toffset',
};
const EXT_KINDS = Object.fromEntries(Object.entries(EXT_URIS).map(([k, v]) => [v, Number(k)]));

const CAND = { MDNS: 1, IPV4: 4, IPV6: 6 };
const MAX_CANDIDATES = 4;

// ---------------------------------------------------------------- parsing

function splitSections(sdp) {
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  const session = [];
  const media = [];
  for (const line of lines) {
    if (line.startsWith('m=')) media.push({ mline: line, lines: [] });
    else if (media.length) media[media.length - 1].lines.push(line);
    else session.push(line);
  }
  return { session, media };
}

function attr(lines, name) {
  const prefix = `a=${name}:`;
  const line = lines.find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function attrs(lines, name) {
  const prefix = `a=${name}:`;
  return lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
}

function parseFmtp(params) {
  const out = {};
  for (const part of (params || '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k.trim().toLowerCase()] = (v || '').trim();
  }
  return out;
}

function codecKind(name, fmtp) {
  name = name.toUpperCase();
  if (name === 'VP8') return CODEC.VP8;
  if (name === 'VP9') return (fmtp['profile-id'] ?? '0') === '0' ? CODEC.VP9 : 0;
  if (name === 'H264') {
    if (fmtp['packetization-mode'] !== '1') return 0;
    const plid = (fmtp['profile-level-id'] || '').toLowerCase();
    // Profile is the first 4 hex digits; level is ignored (we rebuild with 3.1).
    if (plid.startsWith('42e0')) return CODEC.H264_CB;
    if (plid.startsWith('4200')) return CODEC.H264_B;
  }
  return 0;
}

function parseCodecs(lines, mline) {
  const pts = mline.split(' ').slice(3).map(Number);
  const rtpmaps = {};
  for (const v of attrs(lines, 'rtpmap')) {
    const [pt, rest] = v.split(' ');
    rtpmaps[Number(pt)] = rest.split('/')[0];
  }
  const fmtps = {};
  for (const v of attrs(lines, 'fmtp')) {
    const i = v.indexOf(' ');
    fmtps[Number(v.slice(0, i))] = parseFmtp(v.slice(i + 1));
  }
  const rtxFor = {};
  for (const pt of pts) {
    if (rtpmaps[pt]?.toLowerCase() === 'rtx' && fmtps[pt]?.apt) rtxFor[Number(fmtps[pt].apt)] = pt;
  }
  const codecs = [];
  for (const pt of pts) {
    const name = rtpmaps[pt];
    const kind = name && codecKind(name, fmtps[pt] || {});
    if (!kind) continue;
    const codec = { kind, pt };
    if (rtxFor[pt] !== undefined) codec.rtx = rtxFor[pt];
    codecs.push(codec);
  }
  return codecs;
}

function parseExtensions(lines) {
  const exts = [];
  for (const v of attrs(lines, 'extmap')) {
    const [idPart, uri] = v.split(/\s+/);
    if (idPart.includes('/')) continue; // direction-qualified (Firefox recvonly-only extras)
    const kind = EXT_KINDS[uri];
    const id = Number(idPart);
    // Ids above 14 need the two-byte header form; none of ours ever do.
    if (kind && id >= 1 && id <= 14) exts.push({ kind, id });
  }
  return exts.sort((a, b) => a.kind - b.kind);
}

function parseSsrcs(lines) {
  const fid = attr(lines, 'ssrc-group');
  if (fid && fid.startsWith('FID ')) {
    return fid.split(' ').slice(1, 3).map((n) => Number(n) >>> 0);
  }
  const first = attr(lines, 'ssrc');
  return first ? [Number(first.split(' ')[0]) >>> 0] : [];
}

// Parse an ICE candidate attribute value (with or without "candidate:" prefix).
export function parseCandidate(value) {
  const parts = value.replace(/^a=/, '').replace(/^candidate:/, '').trim().split(/\s+/);
  if (parts.length < 8) return null;
  const typIdx = parts.indexOf('typ');
  return {
    component: Number(parts[1]),
    protocol: parts[2].toLowerCase(),
    address: parts[4],
    port: Number(parts[5]),
    type: typIdx >= 0 ? parts[typIdx + 1] : '',
  };
}

function isIPv4(a) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(a);
}

function isMdns(a) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i.test(a);
}

// Decide which candidates are worth a QR byte. Prefers IPv4 host candidates;
// falls back to IPv6, then to mDNS names, only when nothing better exists.
export function filterCandidates(cands) {
  const seen = new Set();
  const usable = [];
  for (const c of cands) {
    if (!c || c.component !== 1 || c.protocol !== 'udp' || c.type !== 'host') continue;
    if (!(c.port > 0 && c.port < 65536)) continue;
    const a = c.address.toLowerCase();
    let kind;
    if (isIPv4(a)) {
      if (a.startsWith('127.') || a.startsWith('169.254.') || a === '0.0.0.0') continue;
      kind = CAND.IPV4;
    } else if (isMdns(a)) {
      kind = CAND.MDNS;
    } else if (a.includes(':')) {
      if (a === '::1' || a.startsWith('fe80') || a.startsWith('::ffff:')) continue;
      kind = CAND.IPV6;
    } else {
      continue;
    }
    const key = `${a}|${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push({ kind, address: a, port: c.port });
  }
  for (const kind of [CAND.IPV4, CAND.IPV6, CAND.MDNS]) {
    const pick = usable.filter((c) => c.kind === kind);
    if (pick.length) return pick.slice(0, MAX_CANDIDATES);
  }
  return [];
}

// Extract the compact description from a full browser SDP.
export function compactFromSdp(sdp, type) {
  const { session, media } = splitSections(sdp);
  const video = media.find((m) => m.mline.startsWith('m=video'));
  const app = media.find((m) => m.mline.startsWith('m=application'));
  if (!video || !app) throw new Error('SDP must contain one video and one application m-line');
  if (media.indexOf(video) !== 0) throw new Error('Video m-line must come first');
  for (const m of media) {
    const mid = attr(m.lines, 'mid');
    if (mid !== String(media.indexOf(m))) throw new Error(`Unexpected mid "${mid}"`);
  }

  const pick = (name) => attr(video.lines, name) ?? attr(session, name);
  const ufrag = pick('ice-ufrag');
  const pwd = pick('ice-pwd');
  const fingerprint = pick('fingerprint');
  const setup = pick('setup');
  if (!ufrag || !pwd || !fingerprint || !setup) throw new Error('SDP is missing ICE or DTLS parameters');

  const [fpAlg, fpHex] = fingerprint.split(' ');
  const fp = Uint8Array.from(fpHex.split(':').map((h) => parseInt(h, 16)));

  // With max-bundle, candidates live in the first m-line; gather from all to be safe.
  const raw = media.flatMap((m) => attrs(m.lines, 'candidate').map(parseCandidate));

  const mms = attr(app.lines, 'max-message-size');

  return {
    type,
    setup: setup.toLowerCase(),
    ufrag,
    pwd,
    fpAlg: fpAlg.toLowerCase(),
    fp,
    // Rounded down to a power of two: telling the peer a smaller limit is safe.
    maxMessageSize: mms ? 2 ** Math.min(30, Math.floor(Math.log2(Number(mms)))) : 0,
    codecs: parseCodecs(video.lines, video.mline),
    exts: parseExtensions(video.lines),
    ssrcs: type === 'offer' ? parseSsrcs(video.lines) : [],
    candidates: filterCandidates(raw),
  };
}

// ---------------------------------------------------------------- rebuild

const CODEC_LINES = {
  [CODEC.VP8]: (pt) => [`a=rtpmap:${pt} VP8/90000`],
  [CODEC.VP9]: (pt) => [`a=rtpmap:${pt} VP9/90000`, `a=fmtp:${pt} profile-id=0`],
  [CODEC.H264_CB]: (pt) => [
    `a=rtpmap:${pt} H264/90000`,
    `a=fmtp:${pt} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`,
  ],
  [CODEC.H264_B]: (pt) => [
    `a=rtpmap:${pt} H264/90000`,
    `a=fmtp:${pt} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`,
  ],
};

const RTCP_FB = ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'];

function candidateLines(cands) {
  return cands.map((c, i) => {
    // RFC 8445 priority for host candidates: type pref 126, falling local pref.
    const priority = (126 << 24) + ((65535 - i) << 8) + 255;
    return `a=candidate:${i + 1} 1 udp ${priority >>> 0} ${c.address} ${c.port} typ host generation 0`;
  });
}

// Rebuild a full SDP that browsers accept for setRemoteDescription.
export function sdpFromCompact(d) {
  const isOffer = d.type === 'offer';
  const fpHex = Array.from(d.fp, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const transport = [
    `a=ice-ufrag:${d.ufrag}`,
    `a=ice-pwd:${d.pwd}`,
    `a=fingerprint:${d.fpAlg} ${fpHex}`,
    `a=setup:${d.setup}`,
  ];
  const pts = d.codecs.flatMap((c) => (c.rtx === undefined ? [c.pt] : [c.pt, c.rtx]));
  const out = [
    'v=0',
    `o=- ${sessionId(d)} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=msid-semantic: WMS',
    `m=video 9 UDP/TLS/RTP/SAVPF ${pts.join(' ')}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    ...candidateLines(d.candidates),
    ...(d.candidates.length ? ['a=end-of-candidates'] : []),
    ...transport,
    'a=mid:0',
    ...d.exts.map((e) => `a=extmap:${e.id} ${EXT_URIS[e.kind]}`),
    isOffer ? 'a=sendonly' : 'a=recvonly',
    ...(isOffer ? ['a=msid:- rs-video'] : []),
    'a=rtcp-mux',
    'a=rtcp-rsize',
  ];
  for (const c of d.codecs) {
    const [rtpmap, ...fmtp] = CODEC_LINES[c.kind](c.pt);
    out.push(rtpmap, ...RTCP_FB.map((fb) => `a=rtcp-fb:${c.pt} ${fb}`), ...fmtp);
    if (c.rtx !== undefined) out.push(`a=rtpmap:${c.rtx} rtx/90000`, `a=fmtp:${c.rtx} apt=${c.pt}`);
  }
  if (isOffer && d.ssrcs.length) {
    if (d.ssrcs.length > 1) out.push(`a=ssrc-group:FID ${d.ssrcs.join(' ')}`);
    for (const s of d.ssrcs) out.push(`a=ssrc:${s} cname:rs`, `a=ssrc:${s} msid:- rs-video`);
  }
  out.push(
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...transport,
    'a=mid:1',
    'a=sctp-port:5000',
  );
  if (d.maxMessageSize) out.push(`a=max-message-size:${d.maxMessageSize}`);
  return out.join('\r\n') + '\r\n';
}

// Deterministic, so rebuilding the same payload twice gives identical SDP.
function sessionId(d) {
  let h = 0;
  for (const b of d.fp) h = (h * 31 + b) >>> 0;
  return String(h || 1);
}

// ---------------------------------------------------------------- binary pack

const STR_RAW = 0;
const STR_B64 = 1;
const STR_HEX = 2;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX = '0123456789abcdef';

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.u8(v >> 8); this.u8(v); }
  u32(v) { this.u16(v >>> 16); this.u16(v & 0xffff); }
  raw(arr) { for (const b of arr) this.u8(b); }
  // ICE credentials: Chrome/Safari use base64 characters, Firefox lowercase
  // hex. Pack them at 6 or 4 bits per character when they fit.
  str(s) {
    if (s.length > 63 || /[^\x21-\x7e]/.test(s)) throw new Error('Unsupported ICE credential');
    let mode = STR_RAW;
    if (/^[0-9a-f]+$/.test(s)) mode = STR_HEX;
    else if (/^[A-Za-z0-9+/]+$/.test(s)) mode = STR_B64;
    this.u8((mode << 6) | s.length);
    if (mode === STR_RAW) {
      for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
      return;
    }
    const [alphabet, bits] = mode === STR_HEX ? [HEX, 4] : [B64, 6];
    let acc = 0;
    let n = 0;
    for (const ch of s) {
      acc = (acc << bits) | alphabet.indexOf(ch);
      n += bits;
      while (n >= 8) { n -= 8; this.u8(acc >> n); }
    }
    if (n) this.u8(acc << (8 - n));
  }
  done() { return Uint8Array.from(this.bytes); }
}

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  u8() {
    if (this.i >= this.b.length) throw new Error('Payload is truncated');
    return this.b[this.i++];
  }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u16() << 16) | this.u16()) >>> 0; }
  raw(n) {
    if (this.i + n > this.b.length) throw new Error('Payload is truncated');
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
  str() {
    const head = this.u8();
    const mode = head >> 6;
    const len = head & 63;
    if (mode === STR_RAW) return String.fromCharCode(...this.raw(len));
    if (mode !== STR_HEX && mode !== STR_B64) throw new Error('Payload is corrupt');
    const [alphabet, bits] = mode === STR_HEX ? [HEX, 4] : [B64, 6];
    const bytes = this.raw(Math.ceil((len * bits) / 8));
    let out = '';
    let acc = 0;
    let n = 0;
    let i = 0;
    while (out.length < len) {
      if (n < bits) { acc = ((acc << 8) | bytes[i++]) & 0xffff; n += 8; }
      n -= bits;
      out += alphabet[(acc >> n) & ((1 << bits) - 1)];
    }
    return out;
  }
}

function ipv4Bytes(a) { return a.split('.').map(Number); }

function ipv6Bytes(a) {
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 0xff]; });
}

function ipv6String(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // Compress the longest run of zero groups.
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  if (best[1] < 2) return groups.join(':');
  return `${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`;
}

function uuidBytes(name) {
  const hex = name.slice(0, 36).replace(/-/g, '');
  return Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function uuidString(bytes) {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
}

export function pack(d) {
  const w = new Writer();
  w.u8(VERSION);
  const setup = SETUPS.indexOf(d.setup);
  const alg = FP_ALGS.indexOf(d.fpAlg);
  if (setup < 0) throw new Error(`Unsupported setup role ${d.setup}`);
  if (alg < 0) throw new Error(`Unsupported fingerprint algorithm ${d.fpAlg}`);
  w.u8((d.type === 'answer' ? 1 : 0) | (setup << 1) | (alg << 3));
  w.str(d.ufrag);
  w.str(d.pwd);
  w.raw(d.fp);
  w.u8(d.maxMessageSize ? Math.log2(d.maxMessageSize) : 0);
  w.u8(d.codecs.length);
  for (const c of d.codecs) {
    w.u8(c.kind | (c.rtx === undefined ? 0 : RTX_FLAG));
    w.u8(c.pt);
    if (c.rtx !== undefined) w.u8(c.rtx);
  }
  let mask = 0;
  for (const e of d.exts) mask |= 1 << (e.kind - 1);
  w.u8(mask);
  for (let i = 0; i < d.exts.length; i += 2) w.u8((d.exts[i].id << 4) | (d.exts[i + 1]?.id ?? 0));
  w.u8(d.ssrcs.length);
  for (const s of d.ssrcs) w.u32(s);
  w.u8(d.candidates.length);
  for (const c of d.candidates) {
    w.u8(c.kind);
    if (c.kind === CAND.IPV4) w.raw(ipv4Bytes(c.address));
    else if (c.kind === CAND.IPV6) w.raw(ipv6Bytes(c.address));
    else w.raw(uuidBytes(c.address));
    w.u16(c.port);
  }
  return w.done();
}

export function unpack(bytes) {
  const r = new Reader(bytes);
  const version = r.u8();
  if (version !== VERSION) throw new Error(`Unsupported payload version ${version}`);
  const bits = r.u8();
  const d = {
    type: bits & 1 ? 'answer' : 'offer',
    setup: SETUPS[(bits >> 1) & 3],
    ufrag: r.str(),
    pwd: r.str(),
  };
  d.fpAlg = FP_ALGS[(bits >> 3) & 3];
  if (!d.setup) throw new Error('Payload is corrupt');
  d.fp = r.raw(FP_LENGTHS[d.fpAlg]);
  const mms = r.u8();
  d.maxMessageSize = mms ? 2 ** mms : 0;
  d.codecs = [];
  for (let n = r.u8(); n > 0; n--) {
    const head = r.u8();
    const c = { kind: head & ~RTX_FLAG, pt: r.u8() };
    if (!CODEC_LINES[c.kind]) throw new Error('Payload has an unknown codec');
    if (head & RTX_FLAG) c.rtx = r.u8();
    d.codecs.push(c);
  }
  const mask = r.u8();
  const kinds = Object.keys(EXT_URIS).map(Number).filter((k) => mask & (1 << (k - 1)));
  if (mask >> Object.keys(EXT_URIS).length) throw new Error('Payload has an unknown extension');
  d.exts = [];
  for (let i = 0; i < kinds.length; i += 2) {
    const b = r.u8();
    d.exts.push({ kind: kinds[i], id: b >> 4 });
    if (i + 1 < kinds.length) d.exts.push({ kind: kinds[i + 1], id: b & 15 });
  }
  d.ssrcs = [];
  for (let n = r.u8(); n > 0; n--) d.ssrcs.push(r.u32());
  d.candidates = [];
  for (let n = r.u8(); n > 0; n--) {
    const kind = r.u8();
    let address;
    if (kind === CAND.IPV4) address = Array.from(r.raw(4)).join('.');
    else if (kind === CAND.IPV6) address = ipv6String(r.raw(16));
    else if (kind === CAND.MDNS) address = uuidString(r.raw(16));
    else throw new Error('Payload has an unknown candidate type');
    d.candidates.push({ kind, address, port: r.u16() });
  }
  if (r.i !== bytes.length) throw new Error('Payload has trailing bytes');
  return d;
}

// ---------------------------------------------------------------- text encoding

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(bytes) {
  let out = '';
  let acc = 0;
  let n = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    n += 8;
    while (n >= 5) { n -= 5; out += BASE32[(acc >> n) & 31]; }
  }
  if (n) out += BASE32[(acc << (5 - n)) & 31];
  return out;
}

export function fromBase32(text) {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  const out = [];
  let acc = 0;
  let n = 0;
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error('Not a Remote Shutter pairing code');
    acc = ((acc << 5) | v) & 0xfff;
    n += 5;
    if (n >= 8) { n -= 8; out.push((acc >> n) & 0xff); }
  }
  return Uint8Array.from(out);
}

async function pipeThrough(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canCompress = () => typeof CompressionStream === 'function';
const canDecompress = () => typeof DecompressionStream === 'function';

// Full pipeline: SDP -> compact -> binary -> (deflate if smaller) -> base32.
export async function encodeSdp(sdp, type) {
  return encodeCompact(compactFromSdp(sdp, type));
}

export async function encodeCompact(compact) {
  const body = pack(compact);
  let flag = 0;
  let data = body;
  if (canCompress()) {
    try {
      const deflated = await pipeThrough(body, new CompressionStream('deflate-raw'));
      if (deflated.length < body.length) { flag = 1; data = deflated; }
    } catch { /* fall back to raw */ }
  }
  const out = new Uint8Array(data.length + 1);
  out[0] = flag;
  out.set(data, 1);
  return toBase32(out);
}

// Returns { type, sdp, compact }. Throws a friendly-ish Error on bad input.
export async function decodePayload(text) {
  const bytes = fromBase32(text.trim());
  if (!bytes.length) throw new Error('Payload is empty');
  let body = bytes.subarray(1);
  if (bytes[0] === 1) {
    if (!canDecompress()) throw new Error('This browser cannot decompress the pairing code');
    body = await pipeThrough(body, new DecompressionStream('deflate-raw'));
  } else if (bytes[0] !== 0) {
    throw new Error('Not a Remote Shutter pairing code');
  }
  const compact = unpack(body);
  return { type: compact.type, sdp: sdpFromCompact(compact), compact };
}
