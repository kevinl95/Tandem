import { generateSessionCode } from "../../src/receiver/config.js";
import { ScreenMirrorReceiver } from "../../src/receiver/receiver.js";

const SESSION_CODE_STORAGE_KEY = "tandem.sessionCode";
const TRUSTED_SENDERS_STORAGE_KEY = "tandem.trustedSenders";
const APPROVAL_TIMEOUT_MS = 30000;
// Vega remote keys arrive as these keyCodes in the WebView.
const KEY_BACK = 27;
const KEY_LEFT = 37;
const KEY_RIGHT = 39;
const STATUS_MESSAGES = {
  "signaling-connecting": "Connecting to Tandem…",
  waiting: "Waiting for a screen share.",
  connecting: "Connecting to the sender…",
  streaming: "Streaming.",
  "signaling-closed": "Connection lost. Reconnecting…",
  error: "Something went wrong with the last screen share.",
};

const videoElement = document.querySelector("#receiver-video");
const receiverNameElement = document.querySelector("#receiver-name");
const sessionCodeElement = document.querySelector("#session-code");
const statusElement = document.querySelector("#receiver-status");
const approvalDialog = document.querySelector("#approval");
const approvalTitle = document.querySelector("#approval-title");
const approvalDetail = document.querySelector("#approval-detail");
const allowButton = document.querySelector("#approval-allow");
const declineButton = document.querySelector("#approval-decline");

// The Vega build injects window.TANDEM_CONFIG; in a desktop browser pass
// ?signaling=wss://... instead.
function readConfig() {
  const params = new URLSearchParams(location.search);
  const injected = globalThis.TANDEM_CONFIG ?? {};

  return {
    receiverName: params.get("name") ?? injected.receiverName ?? "",
    signalingEndpoint: params.get("signaling") ?? injected.signalingEndpoint ?? "",
    stunServerUrl: params.get("stun") ?? injected.stunServerUrl ?? "",
  };
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; the TV then asks again next time.
  }
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

function isTrustedSender(clientId) {
  return readJson(TRUSTED_SENDERS_STORAGE_KEY, []).some((sender) => sender.clientId === clientId);
}

function trustSender(clientId, name) {
  const trusted = readJson(TRUSTED_SENDERS_STORAGE_KEY, []).filter(
    (sender) => sender.clientId !== clientId,
  );
  writeJson(TRUSTED_SENDERS_STORAGE_KEY, [...trusted, { clientId, name }]);
}

function setStatus(message, isProblem = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("problem", isProblem);
}

// Shows the Allow/Decline prompt and resolves with the viewer's choice.
// Enter activates the focused button, left/right move between them, and Back
// declines. The prompt declines by itself if nobody answers.
function requestApproval({ clientId, sameNetwork, senderName, signal }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    let timeout;

    function finish(approved) {
      clearTimeout(timeout);
      document.removeEventListener("keydown", onKeyDown, true);
      allowButton.removeEventListener("click", onAllow);
      declineButton.removeEventListener("click", onDecline);
      signal.removeEventListener("abort", onDecline);
      approvalDialog.hidden = true;
      previousFocus?.focus?.();
      if (approved) {
        trustSender(clientId, senderName);
      }
      resolve(approved);
    }

    function onAllow() {
      finish(true);
    }

    function onDecline() {
      finish(false);
    }

    function onKeyDown(event) {
      if (event.keyCode === KEY_BACK || event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.keyCode === KEY_LEFT || event.keyCode === KEY_RIGHT) {
        event.preventDefault();
        (document.activeElement === allowButton ? declineButton : allowButton).focus();
      }
    }

    approvalTitle.textContent = `${senderName} wants to share its screen`;
    approvalDetail.textContent = sameNetwork
      ? "Allow it? This device will be remembered."
      : "Warning: this device is not on your network. Only allow it if you know who it is.";
    approvalDetail.classList.toggle("warning", !sameNetwork);
    approvalDialog.hidden = false;
    // Default to the safe choice for devices from elsewhere.
    (sameNetwork ? allowButton : declineButton).focus();

    document.addEventListener("keydown", onKeyDown, true);
    allowButton.addEventListener("click", onAllow);
    declineButton.addEventListener("click", onDecline);
    signal.addEventListener("abort", onDecline);
    timeout = setTimeout(onDecline, APPROVAL_TIMEOUT_MS);
  });
}

function start() {
  const config = readConfig();
  const sessionCode = loadSessionCode();
  const receiverName = config.receiverName || `Fire TV ${sessionCode}`;
  receiverNameElement.textContent = receiverName;
  sessionCodeElement.textContent = sessionCode;

  if (!config.signalingEndpoint) {
    setStatus("No signaling endpoint configured. Run npm run deploy:signaling, then rebuild.", true);
    return;
  }

  const receiver = new ScreenMirrorReceiver(videoElement, {
    ...config,
    isTrustedSender,
    receiverName,
    requestApproval,
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
