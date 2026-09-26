// End-to-end check of a deployed signaling stack: a fake receiver and sender
// exchange an offer, answer and ICE candidate, and nothing is echoed back.
// Usage: node scripts/smoke-signaling.mjs [wss://endpoint] (defaults to tandem.config.json)
import { readFile } from "node:fs/promises";
import { generateSessionCode } from "../src/receiver/config.js";

const TIMEOUT_MS = 10000;

async function loadEndpoint() {
  if (process.argv[2]) {
    return process.argv[2];
  }
  const config = JSON.parse(
    await readFile(new URL("../tandem.config.json", import.meta.url), "utf8"),
  );
  return config.signalingEndpoint;
}

function connect(endpoint, sessionId, role) {
  const url = new URL(endpoint);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("role", role);

  const socket = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    inbox.push(message);
    waiters.splice(0).forEach((waiter) => waiter());
  });

  const client = {
    inbox,
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    async next(type) {
      const deadline = Date.now() + TIMEOUT_MS;
      for (;;) {
        const index = inbox.findIndex((message) => message.type === type);
        if (index !== -1) {
          return inbox.splice(index, 1)[0];
        }
        if (Date.now() > deadline) {
          throw new Error(`${role} did not receive "${type}" within ${TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 250);
        });
      }
    },
  };

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(client));
    socket.addEventListener("error", () => reject(new Error(`${role} could not connect`)));
  });
}

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  console.log(`ok - ${message}`);
}

const endpoint = await loadEndpoint();
const sessionId = generateSessionCode();
console.log(`Endpoint ${endpoint}, session ${sessionId}`);

const lonelySender = await connect(endpoint, generateSessionCode(), "sender");
lonelySender.send({ type: "offer", sdp: "v=0" });
const noPeer = await lonelySender.next("error");
check(noPeer.reason === "no-peer", "offer to an unused code reports no-peer");
lonelySender.close();

const receiver = await connect(endpoint, sessionId, "receiver");
const sender = await connect(endpoint, sessionId, "sender");

sender.send({ type: "offer", sdp: "v=0 offer", sessionId: "SPOOFED" });
const offer = await receiver.next("offer");
check(offer.sdp === "v=0 offer" && offer.sessionId === sessionId, "receiver gets the offer with the server's session id");

receiver.send({ type: "answer", sdp: "v=0 answer" });
const answer = await sender.next("answer");
check(answer.sdp === "v=0 answer" && answer.from === "receiver", "sender gets the answer");

receiver.send({ type: "ice", candidate: null });
await sender.next("ice");
check(true, "sender gets the receiver's ICE candidate");

receiver.send({ type: "offer", sdp: "v=0" });
receiver.send({ type: "ping" });
await new Promise((resolve) => setTimeout(resolve, 1500));
check(receiver.inbox.length === 0, "receiver's own messages are not echoed back to it");
check(!sender.inbox.some((message) => message.type === "offer"), "a receiver cannot send offers");

sender.close();
const left = await receiver.next("peer-left");
check(left.from === "sender", "receiver is told when the sender leaves");
receiver.close();

console.log("Signaling smoke test passed.");
