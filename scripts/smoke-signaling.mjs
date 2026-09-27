// End-to-end check of a deployed signaling stack with fake clients: discovery,
// an approved share (offer, pending, answer, ICE), targeted replies, departures
// and the wrong-code error.
// Usage: node scripts/smoke-signaling.mjs [wss://endpoint] (defaults to tandem.config.json)
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

function connect(endpoint, label, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const socket = new WebSocket(url);
  const inbox = [];
  socket.addEventListener("message", (event) => inbox.push(JSON.parse(event.data)));

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
          throw new Error(`${label} did not receive "${type}" within ${TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(client));
    socket.addEventListener("error", () => reject(new Error(`${label} could not connect`)));
  });
}

function check(condition, message) {
  if (!condition) {
    throw new Error(`not ok - ${message}`);
  }
  console.log(`ok - ${message}`);
}

const endpoint = await loadEndpoint();
const sessionId = generateSessionCode();
const tvName = `Smoke TV ${sessionId}`;
console.log(`Endpoint ${endpoint}, session ${sessionId}`);

const tv = await connect(endpoint, "tv", { name: tvName, role: "receiver", sessionId });
const laptop = await connect(endpoint, "laptop", {
  clientId: randomUUID(),
  name: "Smoke laptop",
  role: "sender",
});
const bystander = await connect(endpoint, "bystander", {
  clientId: randomUUID(),
  name: "Smoke bystander",
  role: "sender",
});

laptop.send({ type: "discover" });
const { receivers } = await laptop.next("receivers");
check(
  receivers.some((receiver) => receiver.sessionId === sessionId && receiver.name === tvName),
  "sender discovers the TV on its network",
);

laptop.send({ type: "offer", sdp: "v=0 offer", sessionId: sessionId.toLowerCase() });
const offer = await tv.next("offer");
check(
  offer.sdp === "v=0 offer" && offer.senderName === "Smoke laptop" && offer.sameNetwork === true,
  "TV gets the offer with the sender's verified name and network",
);

tv.send({ type: "pending", to: offer.senderId });
await laptop.next("pending");
check(true, "sender hears that the TV is asking for approval");

tv.send({ type: "answer", sdp: "v=0 answer", to: offer.senderId });
const answer = await laptop.next("answer");
check(answer.sdp === "v=0 answer" && answer.sessionId === sessionId, "sender gets the answer");

laptop.send({ type: "ice", candidate: null });
const ice = await tv.next("ice");
check(ice.senderId === offer.senderId, "TV gets the sender's ICE tagged with its id");

tv.send({ type: "ice", candidate: null, to: offer.senderId });
await laptop.next("ice");
await new Promise((resolve) => setTimeout(resolve, 1500));
check(tv.inbox.length === 0 && bystander.inbox.length === 0, "nothing is echoed or leaked to other senders");

bystander.send({ type: "offer", sdp: "v=0", sessionId: generateSessionCode() });
const noPeer = await bystander.next("error");
check(noPeer.reason === "no-peer", "an offer to an unused code reports no-peer");

laptop.close();
const left = await tv.next("peer-left");
check(left.senderId === offer.senderId, "TV is told which sender left");

tv.close();
bystander.close();
console.log("Signaling smoke test passed.");
