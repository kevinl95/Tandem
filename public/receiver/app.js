import { generateSessionCode } from "../../src/receiver/config.js";
import { createDeviceStore } from "../../src/receiver/devices.js";
import { ScreenMirrorReceiver } from "../../src/receiver/receiver.js";

const SESSION_CODE_STORAGE_KEY = "tandem.sessionCode";
const RECEIVER_SECRET_STORAGE_KEY = "tandem.receiverSecret";
const APPROVAL_TIMEOUT_MS = 30000;
// Disconnect after this long with nobody sharing: an open connection is billed
// by the minute, and TVs are often left on.
const IDLE_PAUSE_MS = 15 * 60 * 1000;
const STATS_LOG_INTERVAL_MS = 10 * 1000;
// Vega remote keys arrive as these keyCodes in the WebView.
const KEY_ENTER = 13;
const KEY_BACK = 27;
const KEY_LEFT = 37;
const KEY_UP = 38;
const KEY_RIGHT = 39;
const KEY_DOWN = 40;
const STATUS_MESSAGES = {
  "signaling-connecting": "Connecting to Tandem…",
  waiting: "Waiting for a screen share.",
  connecting: "Connecting to the sender…",
  streaming: "Streaming.",
  "signaling-closed": "Connection lost. Reconnecting…",
  error: "Something went wrong with the last screen share.",
  paused: "Paused while idle. Press OK on the remote to share again.",
};

const videoElement = document.querySelector("#receiver-video");
const receiverNameElement = document.querySelector("#receiver-name");
const sessionCodeElement = document.querySelector("#session-code");
const instructionsElement = document.querySelector("#instructions");
const statusElement = document.querySelector("#receiver-status");
const tvActions = document.querySelector("#tv-actions");
const manageDevicesButton = document.querySelector("#manage-devices");
const approvalDialog = document.querySelector("#approval");
const approvalTitle = document.querySelector("#approval-title");
const approvalDetail = document.querySelector("#approval-detail");
const allowButton = document.querySelector("#approval-allow");
const declineButton = document.querySelector("#approval-decline");
const blockButton = document.querySelector("#approval-block");
const devicesDialog = document.querySelector("#devices");
const devicesList = document.querySelector("#devices-list");
const devicesEmpty = document.querySelector("#devices-empty");
const forgetAllButton = document.querySelector("#devices-forget-all");
const closeDevicesButton = document.querySelector("#devices-close");

const devices = createDeviceStore(globalThis.localStorage);
// Set while a dialog is open; Back runs it.
let onBack = null;

// Asks the Vega app shell (App.tsx) to exit; a no-op in a desktop browser.
function requestExit() {
  globalThis.ReactNativeWebView?.postMessage(JSON.stringify({ type: "exit-app" }));
}

// The Vega build injects window.TANDEM_CONFIG; in a desktop browser pass
// ?signaling=wss://... instead.
function readConfig() {
  const params = new URLSearchParams(location.search);
  const injected = globalThis.TANDEM_CONFIG ?? {};

  return {
    receiverName: params.get("name") ?? injected.receiverName ?? "",
    siteUrl: params.get("site") ?? injected.siteUrl ?? "",
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

// The secret proves to the server that this TV owns its code. It must stay
// with the code, so both are regenerated together if storage is unavailable.
function loadReceiverSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const fresh = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  try {
    const stored = localStorage.getItem(RECEIVER_SECRET_STORAGE_KEY);
    if (stored) {
      return stored;
    }
    localStorage.setItem(RECEIVER_SECRET_STORAGE_KEY, fresh);
  } catch {
    // Fall through to an unsaved secret.
  }
  return fresh;
}

// "https://tandemscreen.com" → "tandemscreen.com"; empty if not a URL.
function siteHostname(siteUrl) {
  try {
    return siteUrl ? new URL(siteUrl).hostname : "";
  } catch {
    return "";
  }
}

function setStatus(message, isProblem = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("problem", isProblem);
}

// D-pad focus moves between the controls of whatever is on top: an open
// dialog, or else the TV options row.
function focusableControls() {
  const container = !approvalDialog.hidden
    ? approvalDialog
    : !devicesDialog.hidden
      ? devicesDialog
      : document.body.classList.contains("streaming")
        ? null
        : tvActions;
  return container ? [...container.querySelectorAll("button:not([hidden]), a[href]")] : [];
}

function moveFocus(step) {
  const controls = focusableControls();
  if (controls.length === 0) {
    return;
  }
  const index = controls.indexOf(document.activeElement);
  const next = index === -1 ? 0 : (index + step + controls.length) % controls.length;
  controls[next].focus();
}

// Shows the Allow/Decline/Block prompt and resolves with whether to accept.
// It declines by itself if nobody answers, or if the sender gives up.
function requestApproval({ clientId, sameNetwork, senderName, signal }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    let timeout;

    function finish(choice) {
      clearTimeout(timeout);
      allowButton.removeEventListener("click", onAllow);
      declineButton.removeEventListener("click", onDecline);
      blockButton.removeEventListener("click", onBlock);
      signal.removeEventListener("abort", onAbort);
      approvalDialog.hidden = true;
      onBack = null;
      previousFocus?.focus?.();

      if (choice === "allow") {
        devices.allow(clientId, senderName);
      } else if (choice === "block") {
        devices.block(clientId, senderName);
      } else if (choice === "decline") {
        devices.noteDeclined(clientId);
      }
      resolve(choice === "allow");
    }

    const onAllow = () => finish("allow");
    const onDecline = () => finish("decline");
    const onBlock = () => finish("block");
    // The sender left or the TV paused; nobody decided anything.
    const onAbort = () => finish("abort");

    devicesDialog.hidden = true;
    approvalTitle.textContent = `${senderName} wants to share its screen`;
    approvalDetail.textContent = sameNetwork
      ? "Allow it? This device will be remembered."
      : "Warning: this device is not on your network. Only allow it if you know who it is.";
    approvalDetail.classList.toggle("warning", !sameNetwork);
    approvalDialog.hidden = false;
    // Default to the safe choice for devices from elsewhere.
    (sameNetwork ? allowButton : declineButton).focus();
    onBack = onDecline;

    allowButton.addEventListener("click", onAllow);
    declineButton.addEventListener("click", onDecline);
    blockButton.addEventListener("click", onBlock);
    signal.addEventListener("abort", onAbort);
    timeout = setTimeout(onDecline, APPROVAL_TIMEOUT_MS);
  });
}

function renderDevices() {
  const { allowed, blocked } = devices.list();
  const rows = [
    ...allowed.map((device) => ({ ...device, action: "Forget", isBlocked: false })),
    ...blocked.map((device) => ({ ...device, action: "Unblock", isBlocked: true })),
  ];

  devicesList.replaceChildren(
    ...rows.map(({ action, clientId, isBlocked, name }) => {
      const label = document.createElement("span");
      label.textContent = isBlocked ? `${name} (blocked)` : name;
      label.classList.toggle("blocked", isBlocked);

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action;
      button.setAttribute("aria-label", `${action} ${name}`);
      button.addEventListener("click", () => {
        devices.forget(clientId);
        renderDevices();
        moveFocus(0);
      });

      const item = document.createElement("li");
      item.append(label, button);
      return item;
    }),
  );
  devicesEmpty.hidden = rows.length > 0;
  forgetAllButton.hidden = rows.length === 0;
}

function openDevices() {
  renderDevices();
  devicesDialog.hidden = false;
  onBack = closeDevices;
  focusableControls()[0]?.focus();
}

function closeDevices() {
  devicesDialog.hidden = true;
  onBack = null;
  manageDevicesButton.focus();
}

manageDevicesButton.addEventListener("click", openDevices);
closeDevicesButton.addEventListener("click", closeDevices);
forgetAllButton.addEventListener("click", () => {
  devices.forgetAll();
  renderDevices();
  closeDevicesButton.focus();
});

function start() {
  const config = readConfig();
  const sessionCode = loadSessionCode();
  const receiverName = config.receiverName || `Fire TV ${sessionCode}`;
  receiverNameElement.textContent = receiverName;
  sessionCodeElement.textContent = sessionCode;
  const siteHost = siteHostname(config.siteUrl);
  if (siteHost) {
    instructionsElement.textContent = `On a computer on this WiFi, go to ${siteHost} and pick this TV, or enter`;
  }

  if (!config.signalingEndpoint) {
    setStatus("No signaling endpoint configured. Run npm run deploy:signaling, then rebuild.", true);
    return;
  }

  let idleTimer = null;
  let statsTimer = null;
  // While streaming, log what arrives (through the Vega shell into the device
  // log) so sender-side encoder problems can be diagnosed from the TV.
  async function logInboundStats() {
    const inbound = await receiver.describeInbound().catch(() => null);
    if (inbound) {
      globalThis.ReactNativeWebView?.postMessage(JSON.stringify({ type: "stats", ...inbound }));
      console.info("[tandem-receiver] stats", inbound);
    }
  }
  const receiver = new ScreenMirrorReceiver(videoElement, {
    ...config,
    isBlockedSender: (clientId) => devices.isBlocked(clientId),
    isTrustedSender: (clientId) => devices.isTrusted(clientId),
    receiverName,
    receiverSecret: loadReceiverSecret(),
    requestApproval,
    sessionId: sessionCode,
    onStateChange(state, detail) {
      clearInterval(statsTimer);
      if (state === "streaming") {
        statsTimer = setInterval(logInboundStats, STATS_LOG_INTERVAL_MS);
      }
      // Only an idle, connected TV counts down to pausing.
      clearTimeout(idleTimer);
      if (state === "waiting") {
        idleTimer = setTimeout(() => receiver.pauseSignaling(), IDLE_PAUSE_MS);
      }
      document.body.classList.toggle("paused", state === "paused");
      document.body.classList.toggle("streaming", state === "streaming");
      setStatus(
        detail ?? STATUS_MESSAGES[state] ?? state,
        state === "error" || state === "signaling-closed" || Boolean(detail),
      );
      console.info(`[tandem-receiver] ${state}${detail ? `: ${detail}` : ""}`);
    },
  });

  // Back steps out one level: close a dialog, then end a share, then exit.
  function handleBack() {
    if (onBack) {
      onBack();
    } else if (!receiver.endShare()) {
      requestExit();
    }
  }

  // Leaving the screen (Home, another app) ends any share, so no audio plays
  // over the launcher, and disconnects, since connections are billed by the
  // minute. Both can be called more than once.
  function onBackground() {
    receiver.endShare();
    if (!receiver.isPaused) {
      receiver.pauseSignaling();
    }
  }

  function onForeground() {
    if (receiver.isPaused) {
      receiver.connectSignaling();
    }
  }

  // The Vega shell calls these from its app-state listener; visibilitychange
  // covers the same transitions if the WebView reports them.
  globalThis.tandemHost = { handleBack, onBackground, onForeground };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      onBackground();
    } else {
      onForeground();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (receiver.isPaused && event.keyCode === KEY_ENTER) {
      event.preventDefault();
      receiver.connectSignaling();
    } else if ((event.keyCode === KEY_BACK || event.key === "Escape") && !globalThis.ReactNativeWebView) {
      // In the Vega app the shell delivers Back through tandemHost.handleBack;
      // this path is for desktop browsers during development.
      event.preventDefault();
      handleBack();
    } else if (event.keyCode === KEY_LEFT || event.keyCode === KEY_UP) {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.keyCode === KEY_RIGHT || event.keyCode === KEY_DOWN) {
      event.preventDefault();
      moveFocus(1);
    }
  });

  receiver.connectSignaling();
}

start();
