import { generateSessionCode } from "../../src/receiver/config.js";
import { ScreenMirrorReceiver } from "../../src/receiver/receiver.js";

const SESSION_CODE_STORAGE_KEY = "tandem.sessionCode";
const STATUS_MESSAGES = {
  "signaling-connecting": "Connecting to Tandem…",
  waiting: "Waiting for a screen share.",
  connecting: "Connecting to the sender…",
  streaming: "Streaming.",
  "signaling-closed": "Connection lost. Reconnecting…",
  error: "Something went wrong with the last screen share.",
};

const videoElement = document.querySelector("#receiver-video");
const sessionCodeElement = document.querySelector("#session-code");
const statusElement = document.querySelector("#receiver-status");

// The Vega build injects window.TANDEM_CONFIG; in a desktop browser pass
// ?signaling=wss://... instead.
function readConfig() {
  const params = new URLSearchParams(location.search);
  const injected = globalThis.TANDEM_CONFIG ?? {};

  return {
    signalingEndpoint: params.get("signaling") ?? injected.signalingEndpoint ?? "",
    stunServerUrl: params.get("stun") ?? injected.stunServerUrl ?? "",
  };
}

// Keep the same code across launches so a sender can reconnect without
// looking at the TV again. Storage can be unavailable; fall back to a fresh code.
function loadSessionCode() {
  try {
    const stored = localStorage.getItem(SESSION_CODE_STORAGE_KEY);
    if (stored) {
      return stored;
    }

    const code = generateSessionCode();
    localStorage.setItem(SESSION_CODE_STORAGE_KEY, code);
    return code;
  } catch {
    return generateSessionCode();
  }
}

function setStatus(message, isProblem = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("problem", isProblem);
}

function start() {
  const config = readConfig();
  const sessionCode = loadSessionCode();
  sessionCodeElement.textContent = sessionCode;

  if (!config.signalingEndpoint) {
    setStatus("No signaling endpoint configured. Run npm run deploy:signaling, then rebuild.", true);
    return;
  }

  const receiver = new ScreenMirrorReceiver(videoElement, {
    ...config,
    sessionId: sessionCode,
    onStateChange(state, detail) {
      document.body.classList.toggle("streaming", state === "streaming");
      setStatus(
        detail ?? STATUS_MESSAGES[state] ?? state,
        state === "error" || state === "signaling-closed" || Boolean(detail),
      );
      console.info(`[tandem-receiver] ${state}${detail ? `: ${detail}` : ""}`);
    },
  });

  receiver.connectSignaling();
}

start();
