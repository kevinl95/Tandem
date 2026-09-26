import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPeerConfiguration,
  createReceiverRuntimeConfig,
  isHostIceCandidate,
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
