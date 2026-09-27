import test from "node:test";
import assert from "node:assert/strict";
import { TandemSender, isTerminalShareState, preferCodec } from "../src/sender/sender.js";
import {
  FakePeerConnection,
  FakeWebSocket,
  flushAsync,
  installFakes,
} from "./fake-webrtc.js";

function fakeTrack(kind) {
  return {
    kind,
    listeners: {},
    stopped: false,
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    },
    stop() {
      this.stopped = true;
    },
  };
}

function fakeStream({ audio = false } = {}) {
  const video = fakeTrack("video");
  const tracks = audio ? [video, fakeTrack("audio")] : [video];
  return {
    tracks,
    video,
    stream: {
      getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
      getTracks: () => tracks,
      getVideoTracks: () => [video],
    },
  };
}

async function connectSender(t) {
  installFakes(t);
  const states = [];
  const receiverLists = [];
  const signaling = [];
  const sender = new TandemSender({
    clientId: "client-laptop-1",
    name: "Kevin's laptop",
    onReceivers: (receivers) => receiverLists.push(receivers),
    onSignalingChange: (connected) => signaling.push(connected),
    onStateChange: (state, detail) => states.push(detail ? `${state}: ${detail}` : state),
    signalingEndpoint: "wss://signal.example/prod",
  });
  t.after(() => sender.close());

  const connected = sender.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connected;

  return { receiverLists, sender, signaling, socket, states };
}

async function startShare(t, options) {
  const context = await connectSender(t);
  const media = fakeStream(options);
  await context.sender.share(media.stream, " k7p-2qx ");
  return { ...context, ...media, peerConnection: FakePeerConnection.instances[0] };
}

test("sender connects with its identity and no session", async (t) => {
  const { signaling, socket } = await connectSender(t);

  const url = new URL(socket.url);
  assert.equal(url.searchParams.get("role"), "sender");
  assert.equal(url.searchParams.get("clientId"), "client-laptop-1");
  assert.equal(url.searchParams.get("name"), "Kevin's laptop");
  assert.equal(url.searchParams.has("sessionId"), false);
  assert.deepEqual(signaling, [true]);
});

test("sender discovers TVs on its network", async (t) => {
  const { receiverLists, sender, socket } = await connectSender(t);

  sender.discover();
  socket.receive({ receivers: [{ name: "Living Room", sessionId: "K7P2QX" }], type: "receivers" });
  await flushAsync();

  assert.deepEqual(socket.sent, [{ type: "discover" }]);
  assert.deepEqual(receiverLists, [[{ name: "Living Room", sessionId: "K7P2QX" }]]);
});

test("sender offers send-only media to the chosen TV", async (t) => {
  const { peerConnection, socket, states, video } = await startShare(t);

  assert.deepEqual(socket.sent, [{ sdp: "offer-sdp", sessionId: "K7P2QX", type: "offer" }]);
  assert.equal(peerConnection.transceivers[0].init.direction, "sendonly");
  assert.equal(video.contentHint, "detail");
  assert.deepEqual(states, ["offering"]);
});

test("sender shares audio as music alongside the screen", async (t) => {
  const { peerConnection, tracks } = await startShare(t, { audio: true });

  assert.deepEqual(peerConnection.transceivers.map(({ track }) => track.kind), ["video", "audio"]);
  assert.equal(tracks[1].contentHint, "music");
});

test("sender waits for approval, then holds ICE that overtakes the answer", async (t) => {
  const { peerConnection, socket, states } = await startShare(t);
  const candidate = { candidate: "candidate:1 1 udp 1 a1b2.local 5000 typ host" };

  socket.receive({ sessionId: "K7P2QX", type: "pending" });
  socket.receive({ candidate, sessionId: "K7P2QX", type: "ice" });
  await flushAsync();
  assert.equal(states.at(-1), "awaiting-approval");
  assert.deepEqual(peerConnection.addedIceCandidates, []);

  socket.receive({ sdp: "answer-sdp", sessionId: "K7P2QX", type: "answer" });
  await flushAsync();
  assert.deepEqual(peerConnection.remoteDescription, { sdp: "answer-sdp", type: "answer" });
  assert.deepEqual(peerConnection.addedIceCandidates, [candidate]);
  assert.equal(states.at(-1), "connecting");

  socket.receive({ candidate: null, sessionId: "K7P2QX", type: "ice" });
  await flushAsync();
  assert.deepEqual(peerConnection.addedIceCandidates, [candidate, null]);

  peerConnection.setConnectionState("connected");
  assert.equal(states.at(-1), "streaming");
});

test("sender holds its own ICE until the TV acknowledges the offer", async (t) => {
  const { peerConnection, socket } = await startShare(t);
  const hostCandidate = { candidate: "candidate:1 1 udp 1 192.168.2.119 5000 typ host" };

  peerConnection.emit("icecandidate", { candidate: { toJSON: () => hostCandidate } });
  peerConnection.emit("icecandidate", { candidate: null });
  assert.deepEqual(socket.sent, [{ sdp: "offer-sdp", sessionId: "K7P2QX", type: "offer" }]);

  socket.receive({ sessionId: "K7P2QX", type: "pending" });
  await flushAsync();
  assert.deepEqual(socket.sent.slice(1), [
    { candidate: hostCandidate, type: "ice" },
    { candidate: null, type: "ice" },
  ]);

  peerConnection.emit("icecandidate", { candidate: { toJSON: () => hostCandidate } });
  assert.deepEqual(socket.sent.at(-1), { candidate: hostCandidate, type: "ice" });
});

test("a trusted TV's answer also releases held ICE", async (t) => {
  const { peerConnection, socket } = await startShare(t);

  peerConnection.emit("icecandidate", { candidate: null });
  socket.receive({ sdp: "answer-sdp", sessionId: "K7P2QX", type: "answer" });
  await flushAsync();

  assert.deepEqual(socket.sent.slice(1), [{ candidate: null, type: "ice" }]);
});

test("sender gives up when the TV answered but the connection never completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { peerConnection, socket, states } = await startShare(t);

  socket.receive({ sdp: "answer-sdp", sessionId: "K7P2QX", type: "answer" });
  await flushAsync();
  t.mock.timers.tick(20000);

  assert.equal(states.at(-1), "failed: The TV answered but the connection never completed.");
  assert.equal(peerConnection.closed, true);
});

test("sender ignores messages about a TV it no longer shares to", async (t) => {
  const { peerConnection, socket, states } = await startShare(t);

  socket.receive({ sdp: "stale", sessionId: "OLD111", type: "answer" });
  socket.receive({ from: "receiver", sessionId: "OLD111", type: "peer-left" });
  await flushAsync();

  assert.equal(peerConnection.remoteDescription, null);
  assert.deepEqual(states, ["offering"]);
});

for (const [message, expectedState] of [
  [{ type: "decline" }, "declined"],
  [{ reason: "busy", type: "decline" }, "declined: The TV is busy with another request. Try again in a moment."],
  [{ reason: "no-peer", type: "error" }, "no-receiver"],
  [{ reason: "rate-limited", type: "error" }, "rate-limited"],
  [{ from: "receiver", type: "peer-left" }, "receiver-left"],
]) {
  test(`sender ends the share on ${JSON.stringify(message)}`, async (t) => {
    const { peerConnection, sender, socket, states, video } = await startShare(t);

    socket.receive({ ...message, sessionId: "K7P2QX" });
    await flushAsync();

    assert.equal(states.at(-1), expectedState);
    assert.equal(isTerminalShareState(expectedState.split(":")[0]), true);
    assert.equal(peerConnection.closed, true);
    assert.equal(video.stopped, true);
    assert.equal(sender.isSharing, false);
    assert.equal(socket.readyState, FakeWebSocket.OPEN, "signaling stays up for the next share");
  });
}

test("sender stops when the user ends the capture from the browser", async (t) => {
  const { states, video } = await startShare(t);

  video.listeners.ended();

  assert.equal(states.at(-1), "stopped");
});

test("sender needs a TV and a live connection to share", async (t) => {
  const { sender } = await connectSender(t);
  await assert.rejects(sender.share(fakeStream().stream, ""), /Pick a TV/);

  const offline = new TandemSender({ clientId: "client-x-123", signalingEndpoint: "wss://x" });
  await assert.rejects(offline.share(fakeStream().stream, "K7P2QX"), /Not connected/);
});

test("sender reconnects signaling after it drops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { signaling, socket } = await connectSender(t);

  socket.close();
  assert.deepEqual(signaling, [true, false]);

  t.mock.timers.tick(3000);
  assert.equal(FakeWebSocket.instances.length, 2);
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
