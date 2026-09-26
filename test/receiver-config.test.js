import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPeerConfiguration,
  createReceiverRuntimeConfig,
  enableStereoOpus,
  generateSessionCode,
  isHostIceCandidate,
  normalizeSessionCode,
  prioritizeIceCandidates,
} from "../src/receiver/config.js";

test("receiver config prefers a direct host-ICE-first flow without STUN by default", () => {
  const config = createReceiverRuntimeConfig();

  assert.equal(config.preferHostIceCandidates, true);
  assert.deepEqual(config.peerConfiguration.iceServers, []);
});

test("receiver config includes optional STUN when provided", () => {
  const config = buildPeerConfiguration({
    stunServerUrl: "stun:aws.example.internal:3478",
  });

  assert.deepEqual(config.iceServers, [
    { urls: "stun:aws.example.internal:3478" },
  ]);
});

test("receiver config trims optional STUN input before using it", () => {
  const config = createReceiverRuntimeConfig({
    stunServerUrl: "  stun:aws.example.internal:3478  ",
  });

  assert.deepEqual(config.peerConfiguration.iceServers, [
    { urls: "stun:aws.example.internal:3478" },
  ]);
});

test("host candidates are prioritized ahead of broader-compatibility candidates", () => {
  const relayCandidate = {
    candidate:
      "candidate:2 1 udp 33562367 198.51.100.10 3478 typ srflx raddr 10.0.0.1 rport 5000",
  };
  const hostCandidate = {
    candidate: "candidate:1 1 udp 2113937151 10.0.0.5 5000 typ host",
  };

  assert.equal(isHostIceCandidate(hostCandidate.candidate), true);
  assert.deepEqual(prioritizeIceCandidates([relayCandidate, hostCandidate]), [
    hostCandidate,
    relayCandidate,
  ]);
});

test("session codes are six unambiguous characters the signaling server accepts", () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = generateSessionCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  }
});

test("typed session codes are normalized before joining", () => {
  assert.equal(normalizeSessionCode(" k7p-2qx "), "K7P2QX");
});

test("receiver answers request stereo, music-bitrate Opus", () => {
  const sdp = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "a=rtpmap:63 red/48000/2",
    "a=fmtp:63 111/111",
    "",
  ].join("\r\n");

  const updated = enableStereoOpus(sdp);

  assert.match(
    updated,
    /\r\na=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=128000;sprop-stereo=1;stereo=1\r\n/,
  );
  assert.match(updated, /\r\na=fmtp:63 111\/111\r\n/);
});

test("stereo Opus rewrite leaves video-only SDP untouched", () => {
  const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
  assert.equal(enableStereoOpus(sdp), sdp);
});
