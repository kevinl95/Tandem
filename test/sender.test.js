import test from "node:test";
import assert from "node:assert/strict";
import { ScreenShareSender, preferCodec } from "../src/sender/sender.js";
import {
  FakePeerConnection,
  FakeWebSocket,
  flushAsync,
  installFakes,
} from "./fake-webrtc.js";

function fakeStream() {
  const track = {
    kind: "video",
    listeners: {},
    stopped: false,
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    },
    stop() {
      this.stopped = true;
    },
  };
  return {
    track,
    stream: {
      getAudioTracks: () => [],
      getTracks: () => [track],
      getVideoTracks: () => [track],
    },
  };
}

async function startSender(t) {
  installFakes(t);
  const states = [];
  const sender = new ScreenShareSender({
    onStateChange: (state) => states.push(state),
    sessionId: " k7p-2qx ",
    signalingEndpoint: "wss://signal.example/prod",
  });
  t.after(() => sender.stop());
  const { stream, track } = fakeStream();

  const started = sender.start(stream);
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await started;

  return { peerConnection: FakePeerConnection.instances[0], sender, socket, states, track };
}

test("sender joins the normalized session and sends a send-only offer", async (t) => {
  const { peerConnection, socket, states, track } = await startSender(t);

  const url = new URL(socket.url);
  assert.equal(url.searchParams.get("sessionId"), "K7P2QX");
  assert.equal(url.searchParams.get("role"), "sender");
  assert.equal(peerConnection.transceivers[0].init.direction, "sendonly");
  assert.equal(track.contentHint, "detail");
  assert.deepEqual(socket.sent, [{ sdp: "offer-sdp", type: "offer" }]);
  assert.deepEqual(states, ["signaling-connecting", "offering"]);
});

test("sender holds ICE candidates that overtake the answer", async (t) => {
  const { peerConnection, socket, states } = await startSender(t);
  const candidate = { candidate: "candidate:1 1 udp 1 a1b2.local 5000 typ host" };

  socket.receive({ type: "ice", candidate });
  await flushAsync();
  assert.deepEqual(peerConnection.addedIceCandidates, []);

  socket.receive({ type: "answer", sdp: "answer-sdp" });
  await flushAsync();
  assert.deepEqual(peerConnection.remoteDescription, { sdp: "answer-sdp", type: "answer" });
  assert.deepEqual(peerConnection.addedIceCandidates, [candidate]);
  assert.equal(states.at(-1), "connecting");

  socket.receive({ type: "ice", candidate: null });
  await flushAsync();
  assert.deepEqual(peerConnection.addedIceCandidates, [candidate, null]);
});

test("sender reports streaming once the peer connection connects", async (t) => {
  const { peerConnection, states } = await startSender(t);

  peerConnection.setConnectionState("connected");

  assert.equal(states.at(-1), "streaming");
});

test("sender stops when no TV is using the code", async (t) => {
  const { peerConnection, socket, states, track } = await startSender(t);

  socket.receive({ type: "error", reason: "no-peer" });
  await flushAsync();

  assert.equal(states.at(-1), "no-receiver");
  assert.equal(peerConnection.closed, true);
  assert.equal(track.stopped, true);
});

test("sender stops when the TV leaves or the user ends the capture", async (t) => {
  const first = await startSender(t);
  first.socket.receive({ type: "peer-left", from: "receiver" });
  await flushAsync();
  assert.equal(first.states.at(-1), "receiver-left");

  const second = await startSender(t);
  second.track.listeners.ended();
  assert.equal(second.states.at(-1), "stopped");
});

test("sender requires an endpoint and code", async () => {
  const sender = new ScreenShareSender({ signalingEndpoint: "wss://x", sessionId: "" });
  await assert.rejects(sender.start(fakeStream().stream), /TV code/);
});

test("sender shares tab audio as music alongside the screen", async (t) => {
  installFakes(t);
  const { stream: screen, track: videoTrack } = fakeStream();
  const audioTrack = {
    kind: "audio",
    addEventListener() {
      throw new Error("audio track end should not stop sharing");
    },
    stop() {},
  };
  const stream = {
    getAudioTracks: () => [audioTrack],
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => screen.getVideoTracks(),
  };
  const sender = new ScreenShareSender({
    sessionId: "K7P2QX",
    signalingEndpoint: "wss://signal.example/prod",
  });
  t.after(() => sender.stop());

  const started = sender.start(stream);
  FakeWebSocket.instances[0].open();
  await started;

  const transceivers = FakePeerConnection.instances[0].transceivers;
  assert.deepEqual(transceivers.map(({ track }) => track.kind), ["video", "audio"]);
  assert.equal(audioTrack.contentHint, "music");
  assert.equal(transceivers[1].init.direction, "sendonly");
});

test("preferCodec moves the requested codec to the front", (t) => {
  const original = globalThis.RTCRtpReceiver;
  t.after(() => {
    globalThis.RTCRtpReceiver = original;
  });
  globalThis.RTCRtpReceiver = {
    getCapabilities: () => ({
      codecs: [{ mimeType: "video/VP8" }, { mimeType: "video/H264" }, { mimeType: "video/rtx" }],
    }),
  };
  let preferences;
  const transceiver = { setCodecPreferences: (codecs) => (preferences = codecs) };

  assert.equal(preferCodec(transceiver, "video/H264"), true);
  assert.deepEqual(
    preferences.map((codec) => codec.mimeType),
    ["video/H264", "video/VP8", "video/rtx"],
  );
});
