import {
  createReceiverRuntimeConfig,
  enableStereoOpus,
  prioritizeIceCandidates,
} from "./config.js";

// API Gateway closes WebSockets that are idle for 10 minutes.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
const RECONNECT_DELAY_MS = 3000;

// Receiver states reported through onStateChange:
//   signaling-connecting → waiting → connecting → streaming
//   signaling-closed while the socket reconnects, error for failed signals.
export class ScreenMirrorReceiver {
  constructor(videoElement, options = {}) {
    if (!videoElement) {
      throw new Error("A target video element is required.");
    }

    this.videoElement = videoElement;
    this.runtimeConfig = createReceiverRuntimeConfig(options);
    this.onStateChange = options.onStateChange ?? (() => {});
    this.isDisposed = false;
    this.isFlushingRemoteCandidates = false;
    this.pendingRemoteCandidates = [];
    this.pendingRemoteEndOfCandidates = undefined;
    this.peerConnection = null;
    this.signalingSocket = null;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
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
        const answer = await this.acceptOffer({ sdp: message.sdp });
        this.sendSignal({ ...answer, type: "answer" });
      } else if (message.type === "ice") {
        await this.addIceCandidate(
          Object.hasOwn(message, "candidate") ? message.candidate : null,
        );
      } else if (message.type === "peer-left") {
        this.resetPeerConnection();
        this.onStateChange("waiting");
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

  resetPeerConnection() {
    this.peerConnection?.close();
    this.peerConnection = null;
    this.videoElement.srcObject = null;
  }

  createPeerConnection() {
    this.resetPeerConnection();

    const peerConnection = new RTCPeerConnection(
      this.runtimeConfig.peerConfiguration,
    );
    this.peerConnection = peerConnection;

    peerConnection.addEventListener("track", (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.videoElement.srcObject = stream;
      }
    });
    peerConnection.addEventListener("icecandidate", (event) => {
      this.sendSignal({
        candidate: event.candidate ? event.candidate.toJSON() : null,
        type: "ice",
      });
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (this.peerConnection !== peerConnection) {
        return;
      }

      // "disconnected" is often transient, so only react to terminal states.
      if (peerConnection.connectionState === "connected") {
        this.onStateChange("streaming");
      } else if (peerConnection.connectionState === "failed") {
        this.resetPeerConnection();
        this.onStateChange("waiting", "The connection to the sender failed.");
      }
    });

    return peerConnection;
  }

  // Each offer starts a fresh peer connection, so a new sender can take over
  // after the previous one leaves or fails.
  async acceptOffer({ sdp, type = "offer" }) {
    const peerConnection = this.createPeerConnection();
    this.onStateChange("connecting");

    await peerConnection.setRemoteDescription({ sdp, type });
    const createdAnswer = await peerConnection.createAnswer();
    // Chrome may return a read-only RTCSessionDescription, so copy it.
    const answer = { sdp: enableStereoOpus(createdAnswer.sdp), type: createdAnswer.type };
    await peerConnection.setLocalDescription(answer);
    await this.flushPendingIceCandidates();

    return {
      sdp: peerConnection.localDescription?.sdp ?? answer.sdp,
      type: peerConnection.localDescription?.type ?? answer.type,
    };
  }

  // Signaling messages are relayed by concurrent Lambda invocations, so ICE
  // candidates can arrive before the offer they belong to.
  async addIceCandidate(candidate) {
    if (candidate == null || candidate.candidate === "") {
      if (!this.peerConnection?.remoteDescription) {
        this.pendingRemoteEndOfCandidates = candidate;
        return;
      }

      await this.applyIceCandidate(candidate);
      return;
    }

    if (
      this.isFlushingRemoteCandidates ||
      !this.peerConnection?.remoteDescription
    ) {
      this.pendingRemoteCandidates.push(candidate);
      this.pendingRemoteCandidates = prioritizeIceCandidates(
        this.pendingRemoteCandidates,
      );
      return;
    }

    await this.applyIceCandidate(candidate);
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
    this.isFlushingRemoteCandidates = true;

    try {
      while (this.pendingRemoteCandidates.length > 0) {
        const prioritizedCandidates = prioritizeIceCandidates(
          this.pendingRemoteCandidates,
        );

        this.pendingRemoteCandidates = [];
        for (const candidate of prioritizedCandidates) {
          await this.applyIceCandidate(candidate);
        }
      }

      if (this.pendingRemoteEndOfCandidates !== undefined) {
        await this.applyIceCandidate(this.pendingRemoteEndOfCandidates);
        this.pendingRemoteEndOfCandidates = undefined;
      }
    } finally {
      this.isFlushingRemoteCandidates = false;
    }
  }

  dispose() {
    this.isDisposed = true;
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.reconnectTimer);

    if (this.signalingSocket) {
      this.signalingSocket.close();
      this.signalingSocket = null;
    }

    this.resetPeerConnection();
  }
}
