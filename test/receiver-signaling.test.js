import test from "node:test";
import assert from "node:assert/strict";
import { ScreenMirrorReceiver } from "../src/receiver/receiver.js";
import {
  FakePeerConnection,
  FakeWebSocket,
  flushAsync,
  installFakes,
} from "./fake-webrtc.js";

const hostCandidate = {
  candidate: "candidate:1 1 udp 2113937151 a1b2.local 5000 typ host",
};

function startReceiver(t) {
  installFakes(t);
  const states = [];
  const video = { srcObject: null };
  const receiver = new ScreenMirrorReceiver(video, {
    onStateChange: (state, detail) => states.push(detail ? `${state}: ${detail}` : state),
    sessionId: "K7P2QX",
    signalingEndpoint: "wss://signal.example/prod",
  });
  t.after(() => receiver.dispose());

  receiver.connectSignaling();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  return { receiver, socket, states, video };
}

test("receiver joins its session and answers relayed offers", async (t) => {
  const { socket, states } = startReceiver(t);

  const url = new URL(socket.url);
  assert.equal(url.searchParams.get("sessionId"), "K7P2QX");
  assert.equal(url.searchParams.get("role"), "receiver");

  socket.receive({ type: "offer", sdp: "offer-sdp", from: "sender" });
  await flushAsync();

  assert.deepEqual(socket.sent, [{ sdp: "answer-sdp", type: "answer" }]);
  assert.deepEqual(states, ["signaling-connecting", "waiting", "connecting"]);
});

test("receiver applies ICE that arrives before its offer", async (t) => {
  const { socket } = startReceiver(t);

  socket.receive({ type: "ice", candidate: hostCandidate });
  socket.receive({ type: "offer", sdp: "offer-sdp" });
  await flushAsync();

  assert.deepEqual(FakePeerConnection.instances[0].addedIceCandidates, [hostCandidate]);
});

test("receiver forwards its own ICE candidates to the sender", async (t) => {
  const { socket } = startReceiver(t);

  socket.receive({ type: "offer", sdp: "offer-sdp" });
  await flushAsync();
  FakePeerConnection.instances[0].emit("icecandidate", {
    candidate: { toJSON: () => hostCandidate },
  });
  FakePeerConnection.instances[0].emit("icecandidate", { candidate: null });

  assert.deepEqual(socket.sent.slice(1), [
    { candidate: hostCandidate, type: "ice" },
    { candidate: null, type: "ice" },
  ]);
});

test("receiver resets when the sender leaves and accepts a new sender", async (t) => {
  const { socket, states, video } = startReceiver(t);

  socket.receive({ type: "offer", sdp: "offer-sdp" });
  await flushAsync();
  const first = FakePeerConnection.instances[0];
  first.setConnectionState("connected");
  video.srcObject = "stream";

  socket.receive({ type: "peer-left", from: "sender" });
  await flushAsync();
  assert.equal(first.closed, true);
  assert.equal(video.srcObject, null);
  assert.equal(states.at(-1), "waiting");

  socket.receive({ type: "offer", sdp: "offer-sdp-2" });
  await flushAsync();
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(FakePeerConnection.instances[1].remoteDescription.sdp, "offer-sdp-2");
});

test("receiver returns to waiting when the peer connection fails", async (t) => {
  const { socket, states } = startReceiver(t);

  socket.receive({ type: "offer", sdp: "offer-sdp" });
  await flushAsync();
  FakePeerConnection.instances[0].setConnectionState("failed");

  assert.equal(FakePeerConnection.instances[0].closed, true);
  assert.equal(states.at(-1), "waiting: The connection to the sender failed.");
});

test("receiver reconnects signaling after the socket drops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { socket, states } = startReceiver(t);

  socket.close();
  assert.equal(states.at(-1), "signaling-closed");

  t.mock.timers.tick(3000);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(FakeWebSocket.instances[1].url, socket.url);
});

test("receiver sends keepalive pings while idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { socket } = startReceiver(t);

  t.mock.timers.tick(5 * 60 * 1000);

  assert.deepEqual(socket.sent, [{ type: "ping" }]);
});
