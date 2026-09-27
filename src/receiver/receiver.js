import {
  createReceiverRuntimeConfig,
  enableStereoOpus,
  prioritizeIceCandidates,
} from "./config.js";

// API Gateway closes WebSockets that are idle for 10 minutes.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
const RECONNECT_DELAY_MS = 3000;
// An accepted sender that hasn't connected this long after the answer has failed.
const CONNECT_TIMEOUT_MS = 30000;
// Bounds for ICE candidates held for senders the TV hasn't accepted yet.
const MAX_BUFFERED_CANDIDATES_PER_SENDER = 64;
const MAX_BUFFERED_SENDERS = 8;

function isEndOfCandidates(candidate) {
  return candidate == null || candidate.candidate === "";
}

// Receiver states reported through onStateChange:
//   signaling-connecting → waiting → connecting → streaming
//   signaling-closed while the socket reconnects, error for failed signals.
//
// Offers from senders that isTrustedSender() doesn't recognize go through
// requestApproval(), which the page implements (e.g. an Allow/Decline prompt).
// The TV only answers approved senders, so approval is enforced here, not by
// the signaling server.
export class ScreenMirrorReceiver {
  constructor(videoElement, options = {}) {
    if (!videoElement) {
      throw new Error("A target video element is required.");
    }

    this.videoElement = videoElement;
    this.runtimeConfig = createReceiverRuntimeConfig(options);
    this.receiverName = options.receiverName ?? "";
    this.onStateChange = options.onStateChange ?? (() => {});
    this.isTrustedSender = options.isTrustedSender ?? (() => false);
    this.requestApproval = options.requestApproval ?? (async () => false);
    this.isDisposed = false;
    this.isFlushingRemoteCandidates = false;
    this.bufferedCandidates = new Map();
    this.activeSenderId = null;
    this.pendingApproval = null;
    this.peerConnection = null;
    this.signalingSocket = null;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
  }

  connectSignaling() {
    if (!this.runtimeConfig.signalingEndpoint || !this.runtimeConfig.sessionId) {
      return null;
    }

    if (
      this.signalingSocket &&
      this.signalingSocket.readyState !== WebSocket.CLOSED
    ) {
      return this.signalingSocket;
    }

    const signalingUrl = new URL(this.runtimeConfig.signalingEndpoint);
    signalingUrl.searchParams.set("sessionId", this.runtimeConfig.sessionId);
    signalingUrl.searchParams.set("role", "receiver");
    if (this.receiverName) {
      signalingUrl.searchParams.set("name", this.receiverName);
    }

    const socket = new WebSocket(String(signalingUrl));
    this.signalingSocket = socket;
    this.onStateChange("signaling-connecting");

    socket.addEventListener("open", () => {
      this.onStateChange(this.peerConnection ? "streaming" : "waiting");
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = setInterval(
        () => this.sendSignal({ type: "ping" }),
        KEEPALIVE_INTERVAL_MS,
      );
    });
    socket.addEventListener("close", () => {
      if (this.signalingSocket !== socket || this.isDisposed) {
        return;
      }

      clearInterval(this.keepaliveTimer);
      this.onStateChange("signaling-closed");
      this.reconnectTimer = setTimeout(
        () => this.connectSignaling(),
        RECONNECT_DELAY_MS,
      );
    });
    socket.addEventListener("message", (event) => this.handleSignal(event.data));

    return socket;
  }

  async handleSignal(data) {
    try {
      const message = JSON.parse(data);

      if (message.type === "offer" && message.sdp) {
        await this.handleOffer(message);
      } else if (message.type === "ice") {
        await this.addIceCandidate(
          Object.hasOwn(message, "candidate") ? message.candidate : null,
          message.senderId ?? null,
        );
      } else if (message.type === "peer-left") {
        this.handleSenderLeft(message.senderId ?? null);
      }
    } catch (error) {
      this.onStateChange("error", error.message);
    }
  }

  async handleOffer({
    sdp,
    senderId = null,
    senderName = "A device",
    clientId = "",
    sameNetwork = true,
  }) {
    if (!this.isTrustedSender(clientId)) {
      if (this.pendingApproval) {
        this.sendSignal({ reason: "busy", to: senderId, type: "decline" });
        return;
      }

      const controller = new AbortController();
      this.pendingApproval = { controller, senderId };
      this.sendSignal({ to: senderId, type: "pending" });

      let approved = false;
      try {
        approved = await this.requestApproval({
          clientId,
          sameNetwork,
          senderName,
          signal: controller.signal,
        });
      } finally {
        if (this.pendingApproval?.controller === controller) {
          this.pendingApproval = null;
        }
      }

      if (!approved || controller.signal.aborted) {
        this.bufferedCandidates.delete(senderId);
        if (!controller.signal.aborted) {
          this.sendSignal({ to: senderId, type: "decline" });
        }
        return;
      }
    }

    const answer = await this.acceptOffer({ sdp, senderId });
    this.sendSignal({ ...answer, to: senderId, type: "answer" });
  }

  handleSenderLeft(senderId) {
    if (this.pendingApproval?.senderId === senderId) {
      this.pendingApproval.controller.abort();
    }
    this.bufferedCandidates.delete(senderId);

    if (senderId === this.activeSenderId) {
      this.resetPeerConnection();
      this.onStateChange("waiting");
    }
  }

  sendSignal(message) {
    if (this.signalingSocket?.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(message));
    }
  }

  resetPeerConnection() {
    clearTimeout(this.connectTimer);
    this.peerConnection?.close();
    this.peerConnection = null;
    this.activeSenderId = null;
    this.videoElement.srcObject = null;
  }

  createPeerConnection(senderId) {
    this.resetPeerConnection();

    const peerConnection = new RTCPeerConnection(
      this.runtimeConfig.peerConfiguration,
    );
    this.peerConnection = peerConnection;
    this.activeSenderId = senderId;

    peerConnection.addEventListener("track", (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.videoElement.srcObject = stream;
      }
    });
    peerConnection.addEventListener("icecandidate", (event) => {
      this.sendSignal({
        candidate: event.candidate ? event.candidate.toJSON() : null,
        to: senderId,
        type: "ice",
      });
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (this.peerConnection !== peerConnection) {
        return;
      }

      // "disconnected" is often transient, so only react to terminal states.
      if (peerConnection.connectionState === "connected") {
        clearTimeout(this.connectTimer);
        this.onStateChange("streaming");
      } else if (peerConnection.connectionState === "failed") {
        this.resetPeerConnection();
        this.onStateChange("waiting", "The connection to the sender failed.");
      }
    });

    return peerConnection;
  }

  // Each accepted offer starts a fresh peer connection, so a new sender can
  // take over after the previous one leaves or fails.
  async acceptOffer({ sdp, senderId = null, type = "offer" }) {
    const peerConnection = this.createPeerConnection(senderId);
    this.onStateChange("connecting");

    await peerConnection.setRemoteDescription({ sdp, type });
    const createdAnswer = await peerConnection.createAnswer();
    // Chrome may return a read-only RTCSessionDescription, so copy it.
    const answer = { sdp: enableStereoOpus(createdAnswer.sdp), type: createdAnswer.type };
    await peerConnection.setLocalDescription(answer);
    await this.flushPendingIceCandidates();

    this.connectTimer = setTimeout(() => {
      if (this.peerConnection === peerConnection && peerConnection.connectionState !== "connected") {
        this.resetPeerConnection();
        this.onStateChange("waiting", "The connection to the sender timed out.");
      }
    }, CONNECT_TIMEOUT_MS);

    return {
      sdp: peerConnection.localDescription?.sdp ?? answer.sdp,
      type: peerConnection.localDescription?.type ?? answer.type,
    };
  }

  // Signaling messages are relayed by concurrent Lambda invocations, so ICE
  // candidates can arrive before the offer they belong to, or while the TV is
  // still asking whether to accept that sender.
  async addIceCandidate(candidate, senderId = null) {
    const isForReadyConnection =
      senderId === this.activeSenderId &&
      this.peerConnection?.remoteDescription &&
      !this.isFlushingRemoteCandidates;

    if (isForReadyConnection) {
      await this.applyIceCandidate(candidate);
      return;
    }

    this.bufferCandidate(senderId, candidate);
  }

  bufferCandidate(senderId, candidate) {
    if (!this.bufferedCandidates.has(senderId)) {
      if (this.bufferedCandidates.size >= MAX_BUFFERED_SENDERS) {
        const [oldest] = this.bufferedCandidates.keys();
        this.bufferedCandidates.delete(oldest);
      }
      this.bufferedCandidates.set(senderId, []);
    }

    const queue = this.bufferedCandidates.get(senderId);
    if (queue.length < MAX_BUFFERED_CANDIDATES_PER_SENDER) {
      queue.push(candidate);
    }
  }

  async applyIceCandidate(candidate) {
    try {
      await this.peerConnection.addIceCandidate(candidate);
    } catch (error) {
      // Late candidates from a previous sender no longer match the session.
      console.warn(`Ignoring ICE candidate: ${error.message}`);
    }
  }

  async flushPendingIceCandidates() {
    const senderId = this.activeSenderId;
    let sawEndOfCandidates = false;
    let endOfCandidates = null;
    this.isFlushingRemoteCandidates = true;

    try {
      // Candidates can keep arriving while earlier ones are applied.
      while (this.bufferedCandidates.get(senderId)?.length) {
        const queued = this.bufferedCandidates.get(senderId);
        this.bufferedCandidates.delete(senderId);

        const endMarkerIndex = queued.findIndex(isEndOfCandidates);
        if (!sawEndOfCandidates && endMarkerIndex !== -1) {
          sawEndOfCandidates = true;
          endOfCandidates = queued[endMarkerIndex];
        }
        for (const candidate of prioritizeIceCandidates(
          queued.filter((candidate) => !isEndOfCandidates(candidate)),
        )) {
          await this.applyIceCandidate(candidate);
        }
      }

      if (sawEndOfCandidates) {
        await this.applyIceCandidate(endOfCandidates);
      }
    } finally {
      this.isFlushingRemoteCandidates = false;
    }
  }

  dispose() {
    this.isDisposed = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    this.pendingApproval?.controller.abort();

    if (this.signalingSocket) {
      this.signalingSocket.close();
      this.signalingSocket = null;
    }

    this.resetPeerConnection();
  }
}
