import test from "node:test";
import assert from "node:assert/strict";
import { ScreenMirrorReceiver } from "../src/receiver/receiver.js";

test("receiver flushes buffered ICE candidates in host-first order after accepting an offer", async (t) => {
  const originalPeerConnection = globalThis.RTCPeerConnection;

  class FakePeerConnection {
    constructor() {
      this.addedIceCandidates = [];
      this.listeners = {};
      this.remoteDescription = null;
    }

    addEventListener(name, listener) {
      this.listeners[name] = listener;
    }

    async addIceCandidate(candidate) {
      this.addedIceCandidates.push(candidate);
    }

    async createAnswer() {
      return { sdp: "answer-sdp", type: "answer" };
    }

    close() {}

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }
  }

  globalThis.RTCPeerConnection = FakePeerConnection;
  t.after(() => {
    globalThis.RTCPeerConnection = originalPeerConnection;
  });

  const receiver = new ScreenMirrorReceiver({ srcObject: null });
  const relayCandidate = {
    candidate:
      "candidate:2 1 udp 33562367 198.51.100.10 3478 typ srflx raddr 10.0.0.1 rport 5000",
  };
  const hostCandidate = {
    candidate: "candidate:1 1 udp 2113937151 10.0.0.5 5000 typ host",
  };

  await receiver.addIceCandidate(relayCandidate);
  await receiver.addIceCandidate(hostCandidate);
  await receiver.addIceCandidate(null);
  await receiver.acceptOffer({ sdp: "offer-sdp" });

  assert.deepEqual(receiver.peerConnection.addedIceCandidates, [
    hostCandidate,
    relayCandidate,
    null,
  ]);
});

test("receiver keeps buffering candidates that arrive while queued candidates are flushing", async (t) => {
  const originalPeerConnection = globalThis.RTCPeerConnection;
  let receiverUnderTest;
  let injectedCandidate = false;

  class FakePeerConnection {
    constructor() {
      this.addedIceCandidates = [];
      this.listeners = {};
      this.remoteDescription = null;
    }

    addEventListener(name, listener) {
      this.listeners[name] = listener;
    }

    async addIceCandidate(candidate) {
      this.addedIceCandidates.push(candidate);

      if (!injectedCandidate) {
        injectedCandidate = true;
        await receiverUnderTest.addIceCandidate({
          candidate: "candidate:3 1 udp 2113937151 10.0.0.6 5001 typ host",
        });
      }
    }

    async createAnswer() {
      return { sdp: "answer-sdp", type: "answer" };
    }

    close() {}

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }
  }

  globalThis.RTCPeerConnection = FakePeerConnection;
  t.after(() => {
    globalThis.RTCPeerConnection = originalPeerConnection;
  });

  receiverUnderTest = new ScreenMirrorReceiver({ srcObject: null });

  await receiverUnderTest.addIceCandidate({
    candidate:
      "candidate:2 1 udp 33562367 198.51.100.10 3478 typ srflx raddr 10.0.0.1 rport 5000",
  });
  await receiverUnderTest.addIceCandidate(null);
  await receiverUnderTest.acceptOffer({ sdp: "offer-sdp" });

  assert.deepEqual(receiverUnderTest.peerConnection.addedIceCandidates, [
    {
      candidate:
        "candidate:2 1 udp 33562367 198.51.100.10 3478 typ srflx raddr 10.0.0.1 rport 5000",
    },
    {
      candidate: "candidate:3 1 udp 2113937151 10.0.0.6 5001 typ host",
    },
    null,
  ]);
});
