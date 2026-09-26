import { ScreenMirrorReceiver } from "../../src/receiver/receiver.js";

const videoElement = document.querySelector("#receiver-video");
const offerInput = document.querySelector("#offer-input");
const answerOutput = document.querySelector("#answer-output");
const sessionIdInput = document.querySelector("#session-id");
const stunUrlInput = document.querySelector("#stun-url");
const signalingEndpointInput = document.querySelector("#signaling-endpoint");
const signalStatus = document.querySelector("#signal-status");
let currentReceiver = null;
let currentReceiverKey = "";

function buildReceiver() {
  const receiverKey = JSON.stringify({
    sessionId: sessionIdInput.value,
    signalingEndpoint: signalingEndpointInput.value,
    stunServerUrl: stunUrlInput.value,
  });

  if (!currentReceiver || currentReceiverKey !== receiverKey) {
    currentReceiverKey = receiverKey;
    currentReceiver = new ScreenMirrorReceiver(videoElement, {
      sessionId: sessionIdInput.value,
      signalingEndpoint: signalingEndpointInput.value,
      stunServerUrl: stunUrlInput.value,
    });
  }

  return currentReceiver;
}

document.querySelector("#accept-offer").addEventListener("click", async () => {
  const receiver = buildReceiver();
  const answer = await receiver.acceptOffer(JSON.parse(offerInput.value));
  answerOutput.value = JSON.stringify(answer, null, 2);
});

document
  .querySelector("#connect-signaling")
  .addEventListener("click", async () => {
    const receiver = buildReceiver();
    await receiver.connectSignaling((state) => {
      signalStatus.textContent = state;
    });
  });
