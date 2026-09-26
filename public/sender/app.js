import { normalizeSessionCode } from "../../src/receiver/config.js";
import { ScreenShareSender } from "../../src/sender/sender.js";

const ENDPOINT_STORAGE_KEY = "tandem.signalingEndpoint";
const CODE_STORAGE_KEY = "tandem.lastSessionCode";
const STATS_INTERVAL_MS = 2000;
const STATUS_MESSAGES = {
  "signaling-connecting": ["Connecting to Tandem…"],
  offering: ["Looking for the TV…"],
  connecting: ["Connecting to the TV…"],
  streaming: ["Sharing your screen."],
  "no-receiver": ["No TV is showing that code. Check the code on the TV.", true],
  "receiver-left": ["The TV stopped receiving.", true],
  failed: ["Could not connect to the TV. Are you on the same WiFi?", true],
  stopped: ["Stopped sharing."],
  error: ["Something went wrong.", true],
};

const codeInput = document.querySelector("#session-code");
const endpointInput = document.querySelector("#signaling-endpoint");
const shareAudioInput = document.querySelector("#share-audio");
const startButton = document.querySelector("#start-sharing");
const stopButton = document.querySelector("#stop-sharing");
const statusElement = document.querySelector("#sender-status");
const preview = document.querySelector("#preview");
const statsList = document.querySelector("#stats");
let activeSender = null;
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

function describePath(connection) {
  const { localCandidate: local, remoteCandidate: remote } = connection;
  if (!local || !remote) {
    return "not selected yet";
  }

  const direct = local.type !== "relay" && remote.type !== "relay";
  return `${local.type} ${local.address}:${local.port} → ${remote.type} ${remote.address}:${remote.port} (${local.protocol}${direct ? ", direct" : ", relayed"})`;
}

async function renderStats() {
  const connection = await activeSender?.describeConnection();
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

function setSharing(isSharing) {
  startButton.disabled = isSharing;
  stopButton.disabled = !isSharing;
  codeInput.disabled = isSharing;
}

async function startSharing() {
  const sessionId = normalizeSessionCode(codeInput.value);
  const signalingEndpoint = endpointInput.value.trim();

  if (!/^[A-Z0-9]{6}$/.test(sessionId)) {
    codeInput.focus();
    setStatus("error", "Enter the 6-character code shown on the TV.");
    return;
  }

  if (!signalingEndpoint) {
    document.querySelector("#settings").open = true;
    setStatus("error", "Add the signaling endpoint in Settings first.");
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

  writeStorage(ENDPOINT_STORAGE_KEY, signalingEndpoint);
  writeStorage(CODE_STORAGE_KEY, codeInput.value.trim());
  preview.srcObject = stream;
  setSharing(true);

  const sender = new ScreenShareSender({
    onStateChange(state, detail) {
      setStatus(state, detail);
      console.info(`[tandem-sender] ${state}${detail ? `: ${detail}` : ""}`);
      if (["no-receiver", "receiver-left", "failed", "stopped"].includes(state)) {
        clearInterval(statsTimer);
        preview.srcObject = null;
        setSharing(false);
        if (activeSender === sender) {
          activeSender = null;
        }
      }
    },
    sessionId,
    signalingEndpoint,
  });
  activeSender = sender;

  try {
    await sender.start(stream);
    statsTimer = setInterval(renderStats, STATS_INTERVAL_MS);
  } catch (error) {
    sender.stop("failed", error.message);
  }
}

startButton.addEventListener("click", startSharing);
stopButton.addEventListener("click", () => activeSender?.stop());
codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    startSharing();
  }
});

codeInput.value = readStorage(CODE_STORAGE_KEY);
endpointInput.value = await loadEndpoint();
