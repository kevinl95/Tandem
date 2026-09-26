import { ScreenMirrorReceiver } from "../../src/receiver/receiver.js";

const videoElement = document.querySelector("#receiver-video");
const offerInput = document.querySelector("#offer-input");
const answerOutput = document.querySelector("#answer-output");
const sessionIdInput = document.querySelector("#session-id");
const stunUrlInput = document.querySelector("#stun-url");
const signalingEndpointInput = document.querySelector("#signaling-endpoint");
const signalStatus = document.querySelector("#signal-status");
const receiverStatus = document.querySelector("#receiver-status");
let currentReceiver = null;
let currentReceiverKey = "";

function setReceiverStatus(message) {
  receiverStatus.textContent = message;
}

function buildReceiver() {
  const receiverKey = JSON.stringify({
    sessionId: sessionIdInput.value,
    signalingEndpoint: signalingEndpointInput.value,
    stunServerUrl: stunUrlInput.value,
  });

  if (!currentReceiver || currentReceiverKey !== receiverKey) {
    currentReceiver?.dispose();
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
  try {
    const receiver = buildReceiver();
    const answer = await receiver.acceptOffer(JSON.parse(offerInput.value));
    answerOutput.value = JSON.stringify(answer, null, 2);
    setReceiverStatus("Offer accepted. Answer ready to send.");
  } catch (error) {
    setReceiverStatus(`Offer handling failed: ${error.message}`);
  }
});

document
  .querySelector("#connect-signaling")
  .addEventListener("click", async () => {
    try {
      const receiver = buildReceiver();
      const signalingSocket = await receiver.connectSignaling((state) => {
        signalStatus.textContent = state;
        if (state === "error") {
          setReceiverStatus("Signaling connection failed.");
        }
      });
      if (!signalingSocket) {
        signalStatus.textContent = "not connected";
        setReceiverStatus("Add both a session ID and signaling endpoint first.");
        return;
      }
      setReceiverStatus("Waiting for a remote offer through signaling.");
    } catch (error) {
      setReceiverStatus(`Signaling setup failed: ${error.message}`);
    }
  });
