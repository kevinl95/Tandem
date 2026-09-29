import {
  buildPeerConfiguration,
  normalizeSessionCode,
} from "../receiver/config.js";

// API Gateway closes WebSockets that are idle for 10 minutes. Each ping is a
// billed message, so send them as rarely as that allows.
const KEEPALIVE_INTERVAL_MS = 9 * 60 * 1000;
const RECONNECT_DELAY_MS = 3000;
// A share that hasn't connected this long after the TV answered has failed.
const CONNECT_TIMEOUT_MS = 20000;
const PREFERRED_VIDEO_CODEC = "video/H264";
const TERMINAL_SHARE_STATES = new Set([
  "declined",
  "failed",
  "no-receiver",
  "rate-limited",
  "receiver-left",
  "stopped",
]);

export function isTerminalShareState(state) {
  return TERMINAL_SHARE_STATES.has(state);
}

// One sender per page: it stays connected to signaling to discover TVs on the
// same network, and shares to one TV at a time.
//
// Share states reported through onStateChange:
//   offering → awaiting-approval (TV is asking its viewer) → connecting → streaming
//   and the terminal states in TERMINAL_SHARE_STATES.
// onSignalingChange(true|false) reports whether signaling is connected.
export class TandemSender {
  constructor({
    signalingEndpoint = "",
    clientId = "",
    name = "",
    stunServerUrl = "",
    onStateChange = () => {},
    onReceivers = () => {},
    onSignalingChange = () => {},
  } = {}) {
    this.signalingEndpoint = signalingEndpoint.trim();
    this.clientId = clientId;
    this.name = name.trim();
    this.peerConfiguration = buildPeerConfiguration({ stunServerUrl });
    this.onStateChange = onStateChange;
    this.onReceivers = onReceivers;
    this.onSignalingChange = onSignalingChange;
    this.signalingSocket = null;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.isClosed = false;
    this.resetShare();
  }

  resetShare() {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.peerConnection = null;
    this.stream = null;
    this.sessionId = null;
    this.pendingRemoteCandidates = [];
    this.pendingLocalCandidates = [];
    this.isOfferAcknowledged = false;
    this.lastOutboundSample = null;
  }

  get isSharing() {
    return this.peerConnection !== null;
  }

  connect() {
    if (!this.signalingEndpoint || !this.clientId) {
      return Promise.reject(new Error("A signaling endpoint and client id are required."));
    }

    const signalingUrl = new URL(this.signalingEndpoint);
    signalingUrl.searchParams.set("role", "sender");
    signalingUrl.searchParams.set("clientId", this.clientId);
    if (this.name) {
      signalingUrl.searchParams.set("name", this.name);
    }

    const socket = new WebSocket(String(signalingUrl));
    this.signalingSocket = socket;
    socket.addEventListener("message", (event) => this.handleSignal(event.data));
    socket.addEventListener("close", () => {
      clearInterval(this.keepaliveTimer);
      if (this.signalingSocket !== socket || this.isClosed) {
        return;
      }

      this.onSignalingChange(false);
      // A share in progress keeps flowing peer to peer, but only a connected
      // sender can be told that the TV left, so end shares that aren't live.
      if (this.isSharing && this.peerConnection.connectionState !== "connected") {
        this.stopSharing("failed", "Lost the connection to Tandem signaling.");
      }
      this.reconnectTimer = setTimeout(
        () => this.connect().catch(() => {}),
        RECONNECT_DELAY_MS,
      );
    });

    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = setInterval(
          () => this.sendSignal({ type: "ping" }),
          KEEPALIVE_INTERVAL_MS,
        );
        this.onSignalingChange(true);
        resolve();
      });
      socket.addEventListener("error", () =>
        reject(new Error("Could not reach Tandem signaling.")),
      );
    });
  }

  discover() {
    this.sendSignal({ type: "discover" });
  }

  async share(stream, sessionId) {
    const code = normalizeSessionCode(sessionId);
    if (!code) {
      throw new Error("Pick a TV or enter its code.");
    }
    if (this.signalingSocket?.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to Tandem signaling yet.");
    }
    if (this.isSharing) {
      this.stopSharing("stopped");
    }

    this.stream = stream;
    this.sessionId = code;
    // The browser's "Stop sharing" button ends the video track.
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        if (this.stream === stream) {
          this.stopSharing("stopped");
        }
      });
    }

    const peerConnection = new RTCPeerConnection(this.peerConfiguration);
    this.peerConnection = peerConnection;
    peerConnection.addEventListener("icecandidate", (event) => {
      const message = {
        candidate: event.candidate ? event.candidate.toJSON() : null,
        type: "ice",
      };
      // The relay handles each message in a separate Lambda invocation, so
      // candidates sent right behind the offer can arrive before the server
      // has bound this sender to the TV's session, and get dropped. Hold them
      // until the TV acknowledges the offer.
      if (this.isOfferAcknowledged) {
        this.sendSignal(message);
      } else {
        this.pendingLocalCandidates.push(message);
      }
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (this.peerConnection !== peerConnection) {
        return;
      }
      if (peerConnection.connectionState === "connected") {
        clearTimeout(this.connectTimer);
        this.onStateChange("streaming");
      } else if (peerConnection.connectionState === "failed") {
        this.stopSharing("failed");
      }
    });

    for (const track of stream.getTracks()) {
      // Favor sharp text over frame rate for the screen, and fidelity over
      // speech processing for the sound.
      track.contentHint = track.kind === "video" ? "detail" : "music";
      const transceiver = peerConnection.addTransceiver(track, {
        direction: "sendonly",
        streams: [stream],
      });
      if (track.kind === "video") {
        preferCodec(transceiver, PREFERRED_VIDEO_CODEC);
      }
    }

    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    this.onStateChange("offering");
    this.sendSignal({
      sdp: peerConnection.localDescription.sdp,
      sessionId: code,
      type: "offer",
    });
  }

  async handleSignal(data) {
    try {
      const message = JSON.parse(data);

      if (message.type === "receivers") {
        this.onReceivers(Array.isArray(message.receivers) ? message.receivers : []);
        return;
      }

      // Everything else concerns the current share; drop leftovers from a
      // previous TV.
      if (!this.isSharing || (message.sessionId && message.sessionId !== this.sessionId)) {
        return;
      }

      if (message.type === "pending" || message.type === "answer") {
        this.acknowledgeOffer();
      }

      if (message.type === "answer" && message.sdp) {
        await this.peerConnection.setRemoteDescription({ sdp: message.sdp, type: "answer" });
        this.onStateChange("connecting");
        const peerConnection = this.peerConnection;
        this.connectTimer = setTimeout(() => {
          if (this.peerConnection === peerConnection && peerConnection.connectionState !== "connected") {
            this.stopSharing("failed", "The TV answered but the connection never completed.");
          }
        }, CONNECT_TIMEOUT_MS);
        const pending = this.pendingRemoteCandidates;
        this.pendingRemoteCandidates = [];
        for (const candidate of pending) {
          await this.peerConnection.addIceCandidate(candidate);
        }
      } else if (message.type === "ice") {
        const candidate = Object.hasOwn(message, "candidate") ? message.candidate : null;
        // Relayed messages can overtake the answer, so hold candidates until then.
        if (this.peerConnection.remoteDescription) {
          await this.peerConnection.addIceCandidate(candidate);
        } else {
          this.pendingRemoteCandidates.push(candidate);
        }
      } else if (message.type === "pending") {
        this.onStateChange("awaiting-approval");
      } else if (message.type === "decline" && message.reason === "ended") {
        this.stopSharing("receiver-left");
      } else if (message.type === "decline") {
        this.stopSharing("declined", message.reason === "busy"
          ? "The TV is busy with another request. Try again in a moment."
          : undefined);
      } else if (message.type === "error" && message.reason === "no-peer") {
        this.stopSharing("no-receiver");
      } else if (message.type === "error" && message.reason === "rate-limited") {
        this.stopSharing("rate-limited");
      } else if (message.type === "peer-left") {
        this.stopSharing("receiver-left");
      }
    } catch (error) {
      this.onStateChange("error", error.message);
    }
  }

  acknowledgeOffer() {
    if (this.isOfferAcknowledged) {
      return;
    }
    this.isOfferAcknowledged = true;
    for (const message of this.pendingLocalCandidates.splice(0)) {
      this.sendSignal(message);
    }
  }

  sendSignal(message) {
    if (this.signalingSocket?.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(message));
    }
  }

  // Summarizes the selected ICE path and outgoing media, for showing whether
  // media flows directly over the LAN.
  async describeConnection() {
    if (!this.peerConnection) {
      return null;
    }

    const stats = await this.peerConnection.getStats();
    const entries = [...stats.values()];
    const transport = entries.find((entry) => entry.type === "transport");
    const pair =
      stats.get(transport?.selectedCandidatePairId) ??
      entries.find(
        (entry) =>
          entry.type === "candidate-pair" && entry.nominated && entry.state === "succeeded",
      );
    const local = pair && stats.get(pair.localCandidateId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    const video = entries.find((entry) => entry.type === "outbound-rtp" && entry.kind === "video");
    const audio = entries.find((entry) => entry.type === "outbound-rtp" && entry.kind === "audio");

    let bitrateKbps = null;
    if (video && this.lastOutboundSample) {
      const seconds = (video.timestamp - this.lastOutboundSample.timestamp) / 1000;
      if (seconds > 0) {
        bitrateKbps = Math.round(
          ((video.bytesSent - this.lastOutboundSample.bytesSent) * 8) / seconds / 1000,
        );
      }
    }
    if (video) {
      this.lastOutboundSample = { bytesSent: video.bytesSent, timestamp: video.timestamp };
    }

    return {
      audioCodec: audio ? stats.get(audio.codecId)?.mimeType ?? null : null,
      bitrateKbps,
      codec: video ? stats.get(video.codecId)?.mimeType ?? null : null,
      framesPerSecond: video?.framesPerSecond ?? null,
      hasAudio: this.stream.getAudioTracks().length > 0,
      height: video?.frameHeight ?? null,
      localCandidate: local ? describeCandidate(local) : null,
      qualityLimitation: video?.qualityLimitationReason ?? null,
      remoteCandidate: remote ? describeCandidate(remote) : null,
      width: video?.frameWidth ?? null,
    };
  }

  stopSharing(finalState = "stopped", detail) {
    if (!this.isSharing) {
      return;
    }

    this.peerConnection.close();
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.resetShare();
    this.onStateChange(finalState, detail);
  }

  close() {
    this.stopSharing("stopped");
    this.isClosed = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.reconnectTimer);
    this.signalingSocket?.close();
  }
}

function describeCandidate(candidate) {
  return {
    address: candidate.address ?? candidate.ip ?? null,
    port: candidate.port ?? null,
    protocol: candidate.protocol ?? null,
    type: candidate.candidateType ?? null,
  };
}

export function preferCodec(transceiver, mimeType) {
  const capabilities = globalThis.RTCRtpReceiver?.getCapabilities?.("video");
  if (!capabilities || typeof transceiver.setCodecPreferences !== "function") {
    return false;
  }

  const wanted = mimeType.toLowerCase();
  const preferred = capabilities.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === wanted,
  );
  if (preferred.length === 0) {
    return false;
  }

  try {
    transceiver.setCodecPreferences([
      ...preferred,
      ...capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() !== wanted),
    ]);
    return true;
  } catch {
    return false;
  }
}
