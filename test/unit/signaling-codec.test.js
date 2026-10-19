import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEC, compactFromSdp, sdpFromCompact, pack, unpack, encodeSdp, encodeCompact,
  decodePayload, filterCandidates, parseCandidate, toBase32, fromBase32,
} from '../../docs/js/signaling-codec.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ENGINES = ['chromium', 'firefox', 'webkit'];
const load = (name) => fs.readFileSync(path.join(fixtures, `${name}.sdp`), 'utf8');

for (const engine of ENGINES) {
  for (const type of ['offer', 'answer']) {
    test(`${engine} ${type}: compact -> pack -> unpack round-trips`, () => {
      const compact = compactFromSdp(load(`${engine}-${type}`), type);
      assert.deepEqual(unpack(pack(compact)), { ...compact, fp: Uint8Array.from(compact.fp) });
    });

    test(`${engine} ${type}: rebuilt SDP re-parses to the same compact form`, () => {
      const compact = compactFromSdp(load(`${engine}-${type}`), type);
      const rebuilt = sdpFromCompact(compact);
      assert.deepEqual(compactFromSdp(rebuilt, type), compact);
    });

    test(`${engine} ${type}: keeps the essentials`, () => {
      const c = compactFromSdp(load(`${engine}-${type}`), type);
      assert.ok(c.ufrag.length >= 4 && c.pwd.length >= 22);
      assert.equal(c.fpAlg, 'sha-256');
      assert.equal(c.fp.length, 32);
      assert.equal(c.setup, type === 'offer' ? 'actpass' : 'active');
      assert.ok(c.codecs.length >= 1, 'has a codec');
      assert.ok(c.codecs.every((x) => x.rtx !== undefined), 'every codec has rtx');
      assert.ok(c.candidates.length >= 1, 'has a candidate');
      if (type === 'offer') assert.equal(c.ssrcs.length, 2);
    });
  }

  test(`${engine}: full text pipeline round-trips`, async () => {
    const sdp = load(`${engine}-offer`);
    const text = await encodeSdp(sdp, 'offer');
    assert.match(text, /^[A-Z2-7]+$/);
    const decoded = await decodePayload(text);
    assert.equal(decoded.type, 'offer');
    assert.deepEqual(decoded.compact, { ...compactFromSdp(sdp, 'offer'), fp: decoded.compact.fp });
  });
}

test('rebuilt offer has the structure browsers expect', () => {
  const sdp = sdpFromCompact(compactFromSdp(load('chromium-offer'), 'offer'));
  assert.match(sdp, /^v=0\r\n/);
  assert.match(sdp, /a=group:BUNDLE 0 1\r\n/);
  assert.match(sdp, /m=video 9 UDP\/TLS\/RTP\/SAVPF( \d+)+\r\n/);
  assert.match(sdp, /a=sendonly\r\n/);
  assert.match(sdp, /m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel\r\n/);
  assert.match(sdp, /a=sctp-port:5000\r\n/);
  assert.match(sdp, /a=ssrc-group:FID \d+ \d+\r\n/);
  assert.ok(sdp.endsWith('\r\n'));
  // Every PT on the m-line has an rtpmap.
  const pts = sdp.match(/m=video [^\r]+/)[0].split(' ').slice(3);
  for (const pt of pts) assert.match(sdp, new RegExp(`a=rtpmap:${pt} `));
});

test('candidate filter: IPv4 host UDP only, deduplicated, no link-local', () => {
  const lines = [
    'candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host',
    'candidate:2 1 udp 2122260223 192.168.1.20 50000 typ host', // duplicate
    'candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active',
    'candidate:4 1 udp 2122260223 169.254.3.4 50001 typ host',
    'candidate:5 1 udp 2122260223 127.0.0.1 50002 typ host',
    'candidate:6 2 udp 2122260222 192.168.1.20 50003 typ host', // rtcp component
    'candidate:7 1 udp 1686052607 81.2.3.4 50004 typ srflx raddr 0.0.0.0 rport 0',
    'candidate:8 1 udp 2122262783 2a02:c7f:1234::5 50005 typ host',
    'candidate:9 1 udp 2122262783 172.20.10.2 50006 typ host',
  ].map(parseCandidate);
  assert.deepEqual(filterCandidates(lines).map((c) => `${c.address}:${c.port}`),
    ['192.168.1.20:50000', '172.20.10.2:50006']);
});

test('candidate filter: falls back to IPv6, then mDNS', () => {
  const v6 = [
    'candidate:1 1 udp 1 fe80::1 50000 typ host',
    'candidate:2 1 udp 1 2a02:c7f:1234::5 50001 typ host',
    'candidate:3 1 udp 1 0d1f2e3c-1111-4222-8333-944445555666.local 50002 typ host',
  ].map(parseCandidate);
  assert.deepEqual(filterCandidates(v6).map((c) => c.address), ['2a02:c7f:1234::5']);
  assert.deepEqual(filterCandidates(v6.slice(2)).map((c) => c.address),
    ['0d1f2e3c-1111-4222-8333-944445555666.local']);
  assert.deepEqual(filterCandidates([]), []);
});

test('candidate filter: caps the count', () => {
  const many = Array.from({ length: 9 }, (_, i) => parseCandidate(`candidate:${i} 1 udp 1 10.0.0.${i + 1} 5000 typ host`));
  assert.equal(filterCandidates(many).length, 4);
});

test('IPv6 and mDNS addresses survive packing', () => {
  const base = compactFromSdp(load('chromium-answer'), 'answer');
  for (const address of ['2a02:c7f:1234::5', 'fd00:0:0:1::', '::', '2001:db8:1:2:3:4:5:6']) {
    const d = { ...base, candidates: [{ kind: 6, address, port: 1234 }] };
    assert.equal(unpack(pack(d)).candidates[0].address, address);
  }
  const mdns = { ...base, candidates: [{ kind: 1, address: '0d1f2e3c-1111-4222-8333-944445555666.local', port: 9 }] };
  assert.equal(unpack(pack(mdns)).candidates[0].address, mdns.candidates[0].address);
});

test('base32 fits the QR alphanumeric set and round-trips every length', () => {
  for (let len = 0; len < 40; len++) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 97 + len) & 255);
    const text = toBase32(bytes);
    assert.match(text, /^[A-Z2-7]*$/);
    assert.equal(text.length, Math.ceil((len * 8) / 5));
    assert.deepEqual(fromBase32(text), bytes);
    assert.deepEqual(fromBase32(text.toLowerCase()), bytes);
  }
  assert.throws(() => fromBase32('ABC!'), /Not a Remote Shutter/);
});

test('ICE credentials pack at 6 or 4 bits per character', () => {
  const base = compactFromSdp(load('chromium-answer'), 'answer');
  const size = (ufrag, pwd) => pack({ ...base, ufrag, pwd }).length;
  const ref = size('wxyz', 'x'.repeat(24)); // 6-bit: 3 + 18 bytes
  for (const [ufrag, pwd] of [
    ['0ivF', 'qnsnlvqqVMl3Q3ef0O0DO5Z7'], // Chrome / Safari style
    ['9e2d30a4', '252719636dcebbb661e5fbcfaad233dd'], // Firefox hex
    ['a-b_c', 'p@ss:word#with~odd*chars!'], // anything printable (raw)
    ['+/+/', '////////////////////////'],
  ]) {
    const back = unpack(pack({ ...base, ufrag, pwd }));
    assert.equal(back.ufrag, ufrag);
    assert.equal(back.pwd, pwd);
  }
  assert.ok(size('9e2d30a4', '252719636dcebbb661e5fbcfaad233dd') < ref);
});

test('rejects garbage and truncated payloads', async () => {
  await assert.rejects(decodePayload(''), /empty/);
  await assert.rejects(decodePayload(toBase32(Uint8Array.of(7, 1, 2))), /Not a Remote Shutter/);
  await assert.rejects(decodePayload('hello world!'), /Not a Remote Shutter/);
  const good = await encodeSdp(load('chromium-offer'), 'offer');
  const bytes = fromBase32(good);
  await assert.rejects(decodePayload(toBase32(bytes.subarray(0, bytes.length - 3))), /truncated|corrupt|unknown/i);
  const bad = Uint8Array.from(bytes); bad[1] = 9; // version byte (raw payload)
  if (bytes[0] === 0) await assert.rejects(decodePayload(toBase32(bad)), /version/);
});

test('falls back to an uncompressed payload when CompressionStream is missing', async () => {
  const saved = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const text = await encodeSdp(load('webkit-offer'), 'offer');
    assert.equal(fromBase32(text)[0], 0);
    assert.equal((await decodePayload(text)).type, 'offer');
  } finally {
    globalThis.CompressionStream = saved;
  }
});

test('answers carry the codec list in the answerer\'s order', async () => {
  const offer = compactFromSdp(load('chromium-offer'), 'offer');
  const answer = compactFromSdp(load('chromium-answer'), 'answer');
  assert.equal(answer.codecs[0].kind, CODEC.H264_CB);
  const offeredPts = new Set(offer.codecs.map((c) => c.pt));
  for (const c of answer.codecs) assert.ok(offeredPts.has(c.pt));
  const text = await encodeCompact(answer);
  assert.deepEqual((await decodePayload(text)).compact.codecs, answer.codecs);
});
