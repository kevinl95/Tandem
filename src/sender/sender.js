import {
  buildPeerConfiguration,
  normalizeSessionCode,
} from "../receiver/config.js";

// API Gateway closes WebSockets that are idle for 10 minutes.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
const PREFERRED_VIDEO_CODEC = "video/H264";

// Sender states reported through onStateChange:
//   signaling-connecting → offering → connecting → streaming
//   and the terminal states no-receiver, receiver-left, failed, stopped.
export class ScreenShareSender {
  constructor({
    signalingEndpoint = "",
    sessionId = "",
    stunServerUrl = "",
    onStateChange = () => {},
  } = {}) {
    this.signalingEndpoint = signalingEndpoint.trim();
    this.sessionId = normalizeSessionCode(sessionId);
    this.peerConfiguration = buildPeerConfiguration({ stunServerUrl });
    this.onStateChange = onStateChange;
    this.peerConnection = null;
    this.signalingSocket = null;
    this.stream = null;
    this.pendingRemoteCandidates = [];
    this.keepaliveTimer = null;
    this.isStopped = false;
    this.lastOutboundSample = null;
  }

  async start(stream) {
    if (!this.signalingEndpoint || !this.sessionId) {
      throw new Error("A signaling endpoint and TV code are required.");
    }

    this.stream = stream;
    // The browser's "Stop sharing" button ends the video track.
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => this.stop());
    }

    await this.openSignaling();

    const peerConnection = new RTCPeerConnection(this.peerConfiguration);
    this.peerConnection = peerConnection;
    peerConnection.addEventListener("icecandidate", (event) => {
      this.sendSignal({
        candidate: event.candidate ? event.candidate.toJSON() : null,
        type: "ice",
      });
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (peerConnection.connectionState === "connected") {
        this.onStateChange("streaming");
      } else if (peerConnection.connectionState === "failed") {
        this.stop("failed");
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
    this.sendSignal({ sdp: peerConnection.localDescription.sdp, type: "offer" });
  }

  openSignaling() {
    const signalingUrl = new URL(this.signalingEndpoint);
    signalingUrl.searchParams.set("sessionId", this.sessionId);
    signalingUrl.searchParams.set("role", "sender");

    const socket = new WebSocket(String(signalingUrl));
    this.signalingSocket = socket;
    this.onStateChange("signaling-connecting");

    socket.addEventListener("message", (event) => this.handleSignal(event.data));
    socket.addEventListener("close", () => {
      clearInterval(this.keepaliveTimer);
      if (!this.isStopped && this.peerConnection?.connectionState !== "connected") {
        this.stop("failed", "Lost the connection to Tandem signaling.");
      }
    });

    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        this.keepaliveTimer = setInterval(
          () => this.sendSignal({ type: "ping" }),
          KEEPALIVE_INTERVAL_MS,
        );
        resolve();
      });
      socket.addEventListener("error", () =>
        reject(new Error("Could not reach Tandem signaling.")),
      );
    });
  }

  async handleSignal(data) {
    try {
      const message = JSON.parse(data);

      if (message.type === "answer" && message.sdp) {
        await this.peerConnection.setRemoteDescription({
          sdp: message.sdp,
          type: "answer",
        });
        this.onStateChange("connecting");
        const pending = this.pendingRemoteCandidates;
        this.pendingRemoteCandidates = [];
        for (const candidate of pending) {
          await this.peerConnection.addIceCandidate(candidate);
        }
      } else if (message.type === "ice") {
        const candidate = Object.hasOwn(message, "candidate") ? message.candidate : null;
        // Relayed messages can overtake the answer, so hold candidates until then.
        if (this.peerConnection?.remoteDescription) {
          await this.peerConnection.addIceCandidate(candidate);
        } else {
          this.pendingRemoteCandidates.push(candidate);
        }
      } else if (message.type === "error" && message.reason === "no-peer") {
        this.stop("no-receiver");
      } else if (message.type === "peer-left") {
        this.stop("receiver-left");
      }
    } catch (error) {
      this.onStateChange("error", error.message);
    }
  }

  sendSignal(message) {
    if (this.signalingSocket?.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(message));
    }
  }

  // Summarizes the selected ICE path and outgoing video, for showing whether
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
      hasAudio: this.stream.getAudioTracks().length > 0,
      codec: video ? stats.get(video.codecId)?.mimeType ?? null : null,
      framesPerSecond: video?.framesPerSecond ?? null,
      height: video?.frameHeight ?? null,
      localCandidate: local ? describeCandidate(local) : null,
      qualityLimitation: video?.qualityLimitationReason ?? null,
      remoteCandidate: remote ? describeCandidate(remote) : null,
      width: video?.frameWidth ?? null,
    };
  }

  stop(finalState = "stopped", detail) {
    if (this.isStopped) {
      return;
    }

    this.isStopped = true;
    clearInterval(this.keepaliveTimer);
    this.peerConnection?.close();
    this.signalingSocket?.close();
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.onStateChange(finalState, detail);
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
