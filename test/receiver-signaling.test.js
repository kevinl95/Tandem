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

function offerFrom(senderId, overrides = {}) {
  return {
    clientId: `client-${senderId}`,
    sameNetwork: true,
    sdp: `offer-from-${senderId}`,
    senderId,
    senderName: `${senderId} device`,
    type: "offer",
    ...overrides,
  };
}

// requestApproval calls are captured so tests can answer them.
function startReceiver(t, { trusted = [] } = {}) {
  installFakes(t);
  const states = [];
  const approvals = [];
  const video = { srcObject: null };
  const receiver = new ScreenMirrorReceiver(video, {
    isTrustedSender: (clientId) => trusted.includes(clientId),
    onStateChange: (state, detail) => states.push(detail ? `${state}: ${detail}` : state),
    receiverName: "Living Room",
    receiverSecret: "tv-secret-0123456789abcdefghijklmnop",
    requestApproval: (request) =>
      new Promise((resolve) => approvals.push({ ...request, resolve })),
    sessionId: "K7P2QX",
    signalingEndpoint: "wss://signal.example/prod",
  });
  t.after(() => receiver.dispose());

  receiver.connectSignaling();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  return { approvals, receiver, socket, states, video };
}

test("receiver joins its session under its display name", (t) => {
  const { socket, states } = startReceiver(t);

  const url = new URL(socket.url);
  assert.equal(url.searchParams.get("sessionId"), "K7P2QX");
  assert.equal(url.searchParams.get("role"), "receiver");
  assert.equal(url.searchParams.get("name"), "Living Room");
  assert.equal(url.searchParams.get("receiverSecret"), "tv-secret-0123456789abcdefghijklmnop");
  assert.deepEqual(states, ["signaling-connecting", "waiting"]);
});

test("receiver answers trusted senders without asking", async (t) => {
  const { approvals, socket, states } = startReceiver(t, { trusted: ["client-laptop"] });

  socket.receive(offerFrom("laptop"));
  await flushAsync();

  assert.equal(approvals.length, 0);
  assert.deepEqual(socket.sent, [{ sdp: "answer-sdp", to: "laptop", type: "answer" }]);
  assert.equal(FakePeerConnection.instances[0].remoteDescription.sdp, "offer-from-laptop");
  assert.equal(states.at(-1), "connecting");
});

test("receiver asks before accepting an unknown sender and answers once allowed", async (t) => {
  const { approvals, socket } = startReceiver(t);

  socket.receive(offerFrom("laptop", { sameNetwork: false }));
  await flushAsync();

  assert.deepEqual(socket.sent, [{ to: "laptop", type: "pending" }]);
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(approvals[0].senderName, "laptop device");
  assert.equal(approvals[0].clientId, "client-laptop");
  assert.equal(approvals[0].sameNetwork, false);

  approvals[0].resolve(true);
  await flushAsync();

  assert.deepEqual(socket.sent.at(-1), { sdp: "answer-sdp", to: "laptop", type: "answer" });
});

test("receiver declines when the viewer says no, and never creates a connection", async (t) => {
  const { approvals, socket } = startReceiver(t);

  socket.receive(offerFrom("laptop"));
  socket.receive({ candidate: hostCandidate, senderId: "laptop", type: "ice" });
  await flushAsync();
  approvals[0].resolve(false);
  await flushAsync();

  assert.deepEqual(socket.sent.at(-1), { to: "laptop", type: "decline" });
  assert.equal(FakePeerConnection.instances.length, 0);
});

test("receiver turns away a second unknown sender while a prompt is open", async (t) => {
  const { approvals, socket } = startReceiver(t);

  socket.receive(offerFrom("laptop"));
  socket.receive(offerFrom("stranger"));
  await flushAsync();

  assert.equal(approvals.length, 1);
  assert.deepEqual(socket.sent.at(-1), { reason: "busy", to: "stranger", type: "decline" });
});

test("receiver closes the prompt when the asking sender leaves", async (t) => {
  const { approvals, socket } = startReceiver(t);

  socket.receive(offerFrom("laptop"));
  await flushAsync();
  socket.receive({ from: "sender", senderId: "laptop", type: "peer-left" });
  await flushAsync();

  assert.equal(approvals[0].signal.aborted, true);
  approvals[0].resolve(true);
  await flushAsync();
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.deepEqual(socket.sent, [{ to: "laptop", type: "pending" }]);
});

test("receiver applies a sender's ICE that arrived before or during approval", async (t) => {
  const { approvals, socket } = startReceiver(t);
  const otherCandidate = { candidate: "candidate:9 1 udp 1 other.local 6000 typ host" };

  socket.receive({ candidate: hostCandidate, senderId: "laptop", type: "ice" });
  socket.receive({ candidate: otherCandidate, senderId: "stranger", type: "ice" });
  socket.receive(offerFrom("laptop"));
  await flushAsync();
  socket.receive({ candidate: null, senderId: "laptop", type: "ice" });
  await flushAsync();
  approvals[0].resolve(true);
  await flushAsync();

  assert.deepEqual(FakePeerConnection.instances[0].addedIceCandidates, [hostCandidate, null]);
});

test("receiver sends its own ICE only to the accepted sender", async (t) => {
  const { socket } = startReceiver(t, { trusted: ["client-laptop"] });

  socket.receive(offerFrom("laptop"));
  await flushAsync();
  FakePeerConnection.instances[0].emit("icecandidate", {
    candidate: { toJSON: () => hostCandidate },
  });
  FakePeerConnection.instances[0].emit("icecandidate", { candidate: null });

  assert.deepEqual(socket.sent.slice(1), [
    { candidate: hostCandidate, to: "laptop", type: "ice" },
    { candidate: null, to: "laptop", type: "ice" },
  ]);
});

test("receiver resets when the active sender leaves but not when another does", async (t) => {
  const { socket, states, video } = startReceiver(t, {
    trusted: ["client-laptop", "client-desktop"],
  });

  socket.receive(offerFrom("laptop"));
  await flushAsync();
  const first = FakePeerConnection.instances[0];
  first.setConnectionState("connected");
  video.srcObject = "stream";

  socket.receive({ from: "sender", senderId: "someone-else", type: "peer-left" });
  await flushAsync();
  assert.equal(first.closed, false);
  assert.equal(states.at(-1), "streaming");

  socket.receive({ from: "sender", senderId: "laptop", type: "peer-left" });
  await flushAsync();
  assert.equal(first.closed, true);
  assert.equal(video.srcObject, null);
  assert.equal(states.at(-1), "waiting");

  socket.receive(offerFrom("desktop"));
  await flushAsync();
  assert.equal(FakePeerConnection.instances[1].remoteDescription.sdp, "offer-from-desktop");
});

test("receiver returns to waiting when the peer connection fails", async (t) => {
  const { socket, states } = startReceiver(t, { trusted: ["client-laptop"] });

  socket.receive(offerFrom("laptop"));
  await flushAsync();
  FakePeerConnection.instances[0].setConnectionState("failed");

  assert.equal(FakePeerConnection.instances[0].closed, true);
  assert.equal(states.at(-1), "waiting: The connection to the sender failed.");
});

test("receiver gives up on a sender that never connects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { socket, states } = startReceiver(t, { trusted: ["client-laptop"] });

  socket.receive(offerFrom("laptop"));
  await flushAsync();
  t.mock.timers.tick(30000);

  assert.equal(FakePeerConnection.instances[0].closed, true);
  assert.equal(states.at(-1), "waiting: The connection to the sender timed out.");
});

test("receiver reconnects signaling after drops, backing off while it can't connect", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { socket, states } = startReceiver(t);

  socket.close();
  assert.equal(states.at(-1), "signaling-closed");
  t.mock.timers.tick(3000);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(FakeWebSocket.instances[1].url, socket.url);

  // Failed attempts wait 6s, then 12s...
  FakeWebSocket.instances[1].close();
  t.mock.timers.tick(5999);
  assert.equal(FakeWebSocket.instances.length, 2);
  t.mock.timers.tick(1);
  assert.equal(FakeWebSocket.instances.length, 3);

  // ...and a successful connection resets the delay.
  FakeWebSocket.instances[2].open();
  FakeWebSocket.instances[2].close();
  t.mock.timers.tick(3000);
  assert.equal(FakeWebSocket.instances.length, 4);
});

test("receiver sends keepalive pings just under API Gateway's idle timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { socket } = startReceiver(t);

  t.mock.timers.tick(9 * 60 * 1000 - 1);
  assert.deepEqual(socket.sent, []);
  t.mock.timers.tick(1);

  assert.deepEqual(socket.sent, [{ type: "ping" }]);
});

test("a paused receiver stays disconnected until asked to reconnect", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { receiver, socket, states } = startReceiver(t);

  receiver.pauseSignaling();
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(states.at(-1), "paused");

  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(socket.sent, []);

  receiver.connectSignaling();
  assert.equal(FakeWebSocket.instances.length, 2);
});
