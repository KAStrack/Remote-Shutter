// Peer connection setup for both roles. No STUN/TURN: same LAN or hotspot only.
import { decodePayload, encodeSdp } from './signaling-codec.js';

export const RTC_CONFIG = {
  iceServers: [],
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

// Preview stream target: light enough for low latency, sharp enough to frame.
const PREVIEW_SHORT_SIDE = 720;
const PREVIEW_MAX_BITRATE = 1_500_000;
const PREVIEW_MAX_FPS = 30;

// Order matters: the answerer picks the first codec it supports. H.264
// constrained baseline is hardware-accelerated on iPhones and most Androids;
// VP8 is the universal fallback. Every extra codec costs QR bytes.
const CODEC_ORDER = [
  (c) => c.mimeType === 'video/H264' && /packetization-mode=1/.test(c.sdpFmtpLine || '') && /profile-level-id=42e0/i.test(c.sdpFmtpLine || ''),
  (c) => c.mimeType === 'video/VP8',
];

function preferredCodecs(caps) {
  if (!caps?.codecs) return null;
  const picked = [];
  for (const test of CODEC_ORDER) {
    const c = caps.codecs.find((x) => test(x) && !picked.includes(x));
    if (c) picked.push(c);
  }
  if (!picked.length) return null;
  return [...picked, ...caps.codecs.filter((c) => c.mimeType === 'video/rtx')];
}

function setCodecPreferences(transceiver, caps) {
  const codecs = preferredCodecs(caps);
  if (!codecs || typeof transceiver.setCodecPreferences !== 'function') return;
  try {
    transceiver.setCodecPreferences(codecs);
  } catch (err) {
    // Not fatal: the codec only keeps codecs it knows how to rebuild anyway.
    console.warn('setCodecPreferences failed', err);
  }
}

export function waitForIceGathering(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    // With no STUN servers, host gathering finishes in well under a second;
    // the timeout only guards against browsers that never report complete.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export function previewEncoding(track) {
  const s = track?.getSettings?.() || {};
  const shortSide = Math.min(s.width || 0, s.height || 0);
  const scale = shortSide > PREVIEW_SHORT_SIDE ? shortSide / PREVIEW_SHORT_SIDE : 1;
  return {
    scaleResolutionDownBy: scale,
    maxBitrate: PREVIEW_MAX_BITRATE,
    maxFramerate: PREVIEW_MAX_FPS,
  };
}

// Re-apply the preview encoding (e.g. after switching camera).
export async function applyPreviewEncoding(sender, track) {
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  Object.assign(params.encodings[0], previewEncoding(track));
  params.degradationPreference = 'maintain-framerate';
  try {
    await sender.setParameters(params);
  } catch (err) {
    console.warn('setParameters failed', err);
  }
}

function createDataChannel(pc) {
  // Pre-negotiated id: no in-band DCEP handshake, both sides just open it.
  const dc = pc.createDataChannel('rs', { negotiated: true, id: 0, ordered: true });
  dc.binaryType = 'arraybuffer';
  return dc;
}

// Camera side, step 1: build an offer and return its compact payload.
export async function createCameraPeer(track) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const transceiver = pc.addTransceiver(track, {
    direction: 'sendonly',
    sendEncodings: [previewEncoding(track)],
  });
  setCodecPreferences(transceiver, RTCRtpSender.getCapabilities?.('video'));
  const dc = createDataChannel(pc);
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIceGathering(pc);
  const payload = await encodeSdp(pc.localDescription.sdp, 'offer');
  return { pc, dc, sender: transceiver.sender, payload };
}

// Camera side, step 2: apply the viewer's answer.
export async function acceptAnswer(pc, payload) {
  const { type, sdp } = await decodePayload(payload);
  if (type !== 'answer') throw new Error('That code is a pairing link, not an answer');
  await pc.setRemoteDescription({ type: 'answer', sdp });
}

// Viewer side: consume the offer, return the answer payload.
export async function createViewerPeer(offerPayload) {
  const { type, sdp } = await decodePayload(offerPayload);
  if (type !== 'offer') throw new Error('That code is not a pairing link');
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const dc = createDataChannel(pc);
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const transceiver = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
  transceiver.direction = 'recvonly';
  setCodecPreferences(transceiver, RTCRtpReceiver.getCapabilities?.('video'));
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIceGathering(pc);
  const payload = await encodeSdp(pc.localDescription.sdp, 'answer');
  return { pc, dc, track: transceiver.receiver.track, payload };
}

// Connection health, reported as plain events so each role can decide what
// to show. Calls:
//   onOpen()              data channel open: we're live
//   onTrouble(kind)       'slow' (not open after timeoutMs; only if set),
//                         'unstable' (dropped, may come back)
//   onRecovered()         came back after 'unstable'
//   onLost(kind)          'failed' | 'closed'; needs re-pairing
// Returns a function that stops watching.
export function watchConnection(pc, dc, { onOpen, onTrouble, onRecovered, onLost, timeoutMs = 0 }) {
  let opened = false;
  let lost = false;
  let unstableTimer = 0;
  const slowTimer = timeoutMs ? setTimeout(() => !opened && onTrouble?.('slow'), timeoutMs) : 0;

  const lose = (kind) => {
    if (lost) return;
    lost = true;
    stop();
    onLost?.(kind);
  };
  const handleOpen = () => {
    opened = true;
    clearTimeout(slowTimer);
    onOpen?.();
  };
  const handleClose = () => lose('closed');
  const handleState = () => {
    const s = pc.connectionState || pc.iceConnectionState;
    if (s === 'failed') {
      // Before the channel opens, ICE can fail while the other phone is still
      // scanning; it recovers once checks resume, so only report trouble.
      if (opened) lose('failed');
      else onTrouble?.('failed');
    } else if (s === 'disconnected' && opened) {
      clearTimeout(unstableTimer);
      unstableTimer = setTimeout(() => {
        if ((pc.connectionState || pc.iceConnectionState) === 'disconnected') onTrouble?.('unstable');
      }, 2500);
    } else if ((s === 'connected' || s === 'completed') && opened) {
      clearTimeout(unstableTimer);
      onRecovered?.();
    } else if (s === 'closed') {
      lose('closed');
    }
  };

  dc.addEventListener('open', handleOpen);
  dc.addEventListener('close', handleClose);
  pc.addEventListener('connectionstatechange', handleState);
  pc.addEventListener('iceconnectionstatechange', handleState);
  if (dc.readyState === 'open') handleOpen();

  function stop() {
    clearTimeout(slowTimer);
    clearTimeout(unstableTimer);
    dc.removeEventListener('open', handleOpen);
    dc.removeEventListener('close', handleClose);
    pc.removeEventListener('connectionstatechange', handleState);
    pc.removeEventListener('iceconnectionstatechange', handleState);
  }
  return stop;
}

// Pull the offer payload out of whatever a scanner read: a full pairing URL
// or a bare payload.
export function offerFromText(text) {
  const m = /#o=([A-Za-z2-7]+)/.exec(text);
  return m ? m[1] : null;
}

// The app URL without fragment or query, for building pairing links.
export function appUrl() {
  return location.origin + location.pathname;
}
