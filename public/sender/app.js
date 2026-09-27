import { normalizeSessionCode } from "../../src/receiver/config.js";
import { TandemSender, isTerminalShareState } from "../../src/sender/sender.js";

const ENDPOINT_STORAGE_KEY = "tandem.signalingEndpoint";
const CLIENT_ID_STORAGE_KEY = "tandem.clientId";
const DEVICE_NAME_STORAGE_KEY = "tandem.deviceName";
// Each discovery is a billed round trip; refresh only while the page is visible.
const DISCOVERY_INTERVAL_MS = 15000;
const STATS_INTERVAL_MS = 2000;
const STATUS_MESSAGES = {
  offering: ["Contacting the TV…"],
  "awaiting-approval": ["Waiting for someone to press Allow on the TV…"],
  connecting: ["Connecting to the TV…"],
  streaming: ["Sharing your screen."],
  declined: ["The TV declined the share.", true],
  "no-receiver": ["No TV is showing that code. Check the code on the TV.", true],
  "rate-limited": ["Too many wrong codes from this network. Try again in a few minutes.", true],
  "receiver-left": ["The TV stopped receiving.", true],
  failed: ["Could not connect to the TV. Are you on the same WiFi?", true],
  stopped: ["Stopped sharing."],
  error: ["Something went wrong.", true],
};

const tvList = document.querySelector("#tv-list");
const tvListEmpty = document.querySelector("#tv-list-empty");
const codeInput = document.querySelector("#session-code");
const shareCodeButton = document.querySelector("#share-code");
const shareAudioInput = document.querySelector("#share-audio");
const statusElement = document.querySelector("#sender-status");
const stopButton = document.querySelector("#stop-sharing");
const preview = document.querySelector("#preview");
const statsSection = document.querySelector("#stats-section");
const statsList = document.querySelector("#stats");
const deviceNameInput = document.querySelector("#device-name");
const endpointInput = document.querySelector("#signaling-endpoint");
let sender = null;
let receivers = [];
let isSharing = false;
let statsTimer = null;

function readStorage(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
}

// A stable id lets the TV remember that it already allowed this browser.
function loadClientId() {
  const stored = readStorage(CLIENT_ID_STORAGE_KEY);
  if (stored) {
    return stored;
  }
  const clientId = crypto.randomUUID();
  writeStorage(CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
}

function defaultDeviceName() {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const platform = /Windows/.test(agent)
    ? "Windows"
    : /Mac OS X/.test(agent)
      ? "Mac"
      : /CrOS/.test(agent)
        ? "Chromebook"
        : /Android/.test(agent)
          ? "Android"
          : /Linux/.test(agent)
            ? "Linux"
            : "computer";
  return `${browser} on ${platform}`;
}

// Endpoint precedence: ?signaling=, then the last one used here, then the
// tandem.config.json written by `npm run deploy:signaling`.
async function loadEndpoint() {
  const fromQuery = new URLSearchParams(location.search).get("signaling");
  if (fromQuery) {
    return fromQuery;
  }

  const stored = readStorage(ENDPOINT_STORAGE_KEY);
  if (stored) {
    return stored;
  }

  try {
    const response = await fetch("../../tandem.config.json");
    return response.ok ? (await response.json()).signalingEndpoint ?? "" : "";
  } catch {
    return "";
  }
}

function setStatus(state, detail) {
  const [message, isProblem = false] = STATUS_MESSAGES[state] ?? [state];
  statusElement.textContent = detail ?? message;
  statusElement.classList.toggle("problem", isProblem || Boolean(detail));
}

function renderReceivers() {
  tvList.replaceChildren(
    ...receivers.map(({ name, sessionId }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = isSharing;
      const label = document.createElement("span");
      label.textContent = name;
      const code = document.createElement("span");
      code.className = "code";
      code.textContent = sessionId;
      button.append(label, code);
      button.addEventListener("click", () => startSharing(sessionId));

      const item = document.createElement("li");
      item.append(button);
      return item;
    }),
  );

  tvListEmpty.hidden = receivers.length > 0;
  tvListEmpty.textContent = sender
    ? "No TVs found on this network yet. Open Tandem on the TV, or enter its code below."
    : "Looking for TVs…";
}

function describePath(connection) {
  const { localCandidate: local, remoteCandidate: remote } = connection;
  if (!local || !remote) {
    return "not selected yet";
  }

  const direct = local.type !== "relay" && remote.type !== "relay";
  return `${local.type} ${local.address ?? ""}:${local.port} → ${remote.type} ${remote.address ?? ""}:${remote.port} (${local.protocol}${direct ? ", direct" : ", relayed"})`;
}

async function renderStats() {
  const connection = await sender?.describeConnection();
  if (!connection) {
    return;
  }

  const rows = {
    Path: describePath(connection),
    Video: connection.width
      ? `${connection.width}×${connection.height} @ ${connection.framesPerSecond ?? "?"} fps`
      : "waiting for frames",
    Codec: connection.codec ?? "negotiating",
    Bitrate: connection.bitrateKbps == null ? "measuring" : `${connection.bitrateKbps} kbps`,
    Audio: connection.hasAudio
      ? connection.audioCodec ?? "negotiating"
      : "none (to include sound, share a tab or tick the picker's audio option)",
    Limited: connection.qualityLimitation ?? "none",
  };

  statsList.replaceChildren(
    ...Object.entries(rows).flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      return [term, description];
    }),
  );
}

function setSharing(sharing) {
  isSharing = sharing;
  stopButton.hidden = !sharing;
  shareCodeButton.disabled = sharing;
  codeInput.disabled = sharing;
  statsSection.hidden = !sharing;
  renderReceivers();

  if (!sharing) {
    clearInterval(statsTimer);
    preview.srcObject = null;
    delete preview.dataset.active;
  }
}

async function startSharing(sessionId) {
  if (!sender) {
    setStatus("error", "Still connecting to Tandem. Try again in a moment.");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // Voice-call processing degrades music and video soundtracks, and local
      // playback is suppressed so the sound comes from the TV, like casting.
      audio: shareAudioInput.checked
        ? {
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
            suppressLocalAudioPlayback: true,
          }
        : false,
      systemAudio: "include",
      video: { frameRate: { ideal: 30 } },
    });
  } catch (error) {
    setStatus("error", `Screen capture was not started: ${error.message}`);
    return;
  }

  preview.srcObject = stream;
  preview.dataset.active = "";
  setSharing(true);

  try {
    await sender.share(stream, sessionId);
    statsTimer = setInterval(renderStats, STATS_INTERVAL_MS);
  } catch (error) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    setSharing(false);
    setStatus("failed", error.message);
  }
}

function shareTypedCode() {
  const sessionId = normalizeSessionCode(codeInput.value);
  if (!/^[A-Z0-9]{6}$/.test(sessionId)) {
    codeInput.focus();
    setStatus("error", "Enter the 6-character code shown on the TV.");
    return;
  }
  startSharing(sessionId);
}

async function connect() {
  const signalingEndpoint = endpointInput.value.trim();
  if (!signalingEndpoint) {
    document.querySelector("#settings").open = true;
    setStatus("error", "Add the signaling endpoint in Settings.");
    return;
  }

  sender?.close();
  const nextSender = new TandemSender({
    clientId: loadClientId(),
    name: deviceNameInput.value.trim() || defaultDeviceName(),
    onReceivers(list) {
      receivers = list;
      renderReceivers();
    },
    onSignalingChange(connected) {
      if (connected) {
        nextSender.discover();
      }
    },
    onStateChange(state, detail) {
      setStatus(state, detail);
      console.info(`[tandem-sender] ${state}${detail ? `: ${detail}` : ""}`);
      if (isTerminalShareState(state)) {
        setSharing(false);
      }
    },
    signalingEndpoint,
  });

  try {
    await nextSender.connect();
    sender = nextSender;
    writeStorage(ENDPOINT_STORAGE_KEY, signalingEndpoint);
    renderReceivers();
  } catch (error) {
    nextSender.close();
    setStatus("error", error.message);
  }
}

shareCodeButton.addEventListener("click", shareTypedCode);
codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    shareTypedCode();
  }
});
stopButton.addEventListener("click", () => sender?.stopSharing("stopped"));
deviceNameInput.addEventListener("change", () => {
  writeStorage(DEVICE_NAME_STORAGE_KEY, deviceNameInput.value.trim());
  if (!isSharing) {
    connect();
  }
});
endpointInput.addEventListener("change", () => {
  if (!isSharing) {
    connect();
  }
});

deviceNameInput.value = readStorage(DEVICE_NAME_STORAGE_KEY) || defaultDeviceName();
endpointInput.value = await loadEndpoint();
await connect();
setInterval(() => {
  if (!isSharing && document.visibilityState === "visible") {
    sender?.discover();
  }
}, DISCOVERY_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (!isSharing && document.visibilityState === "visible") {
    sender?.discover();
  }
});
