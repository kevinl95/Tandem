import {
  createReceiverRuntimeConfig,
  prioritizeIceCandidates,
} from "./config.js";

export class ScreenMirrorReceiver {
  constructor(videoElement, options = {}) {
    if (!videoElement) {
      throw new Error("A target video element is required.");
    }

    this.videoElement = videoElement;
    this.runtimeConfig = createReceiverRuntimeConfig(options);
    this.isFlushingRemoteCandidates = false;
    this.pendingRemoteCandidates = [];
    this.pendingRemoteEndOfCandidates = undefined;
    this.signalingSocket = null;
    this.peerConnection = new RTCPeerConnection(
      this.runtimeConfig.peerConfiguration,
    );

    this.peerConnection.addEventListener("track", (event) => {
      const [stream] = event.streams;
      if (stream) {
        this.videoElement.srcObject = stream;
      }
    });
  }

  async connectSignaling(onSignalStateChange = () => {}) {
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

    this.signalingSocket = new WebSocket(String(signalingUrl));
    this.signalingSocket.addEventListener("open", () =>
      onSignalStateChange("connected"),
    );
    this.signalingSocket.addEventListener("error", () =>
      onSignalStateChange("error"),
    );
    this.signalingSocket.addEventListener("close", () =>
      onSignalStateChange("disconnected"),
    );
    this.signalingSocket.addEventListener("message", async (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === "offer" && message.sdp) {
          const answer = await this.acceptOffer({ sdp: message.sdp });
          this.sendSignal({
            sessionId: this.runtimeConfig.sessionId,
            type: "answer",
            ...answer,
          });
        }

        if (message.type === "ice") {
          await this.addIceCandidate(
            Object.hasOwn(message, "candidate") ? message.candidate : null,
          );
        }
      } catch (error) {
        onSignalStateChange("error");
      }
    });

    this.peerConnection.addEventListener("icecandidate", (event) => {
      this.sendSignal({
        candidate: event.candidate ? event.candidate.toJSON() : null,
        sessionId: this.runtimeConfig.sessionId,
        type: "ice",
      });
    });

    return this.signalingSocket;
  }

  sendSignal(message) {
    if (this.signalingSocket?.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(message));
    }
  }

  async acceptOffer({ sdp, type = "offer" }) {
    await this.peerConnection.setRemoteDescription({ sdp, type });
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    await this.flushPendingIceCandidates();

    return {
      sdp: this.peerConnection.localDescription?.sdp ?? answer.sdp,
      type: this.peerConnection.localDescription?.type ?? answer.type,
    };
  }

  async addIceCandidate(candidate) {
    if (candidate == null || candidate.candidate === "") {
      if (!this.peerConnection.remoteDescription) {
        this.pendingRemoteEndOfCandidates = candidate;
        return;
      }

      await this.peerConnection.addIceCandidate(candidate);
      return;
    }

    if (
      this.isFlushingRemoteCandidates ||
      !this.peerConnection.remoteDescription
    ) {
      this.pendingRemoteCandidates.push(candidate);
      this.pendingRemoteCandidates = prioritizeIceCandidates(
        this.pendingRemoteCandidates,
      );
      return;
    }

    await this.peerConnection.addIceCandidate(candidate);
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
          await this.peerConnection.addIceCandidate(candidate);
        }
      }

      if (this.pendingRemoteEndOfCandidates !== undefined) {
        await this.peerConnection.addIceCandidate(
          this.pendingRemoteEndOfCandidates,
        );
        this.pendingRemoteEndOfCandidates = undefined;
      }
    } finally {
      this.isFlushingRemoteCandidates = false;
    }
  }

  dispose() {
    if (this.signalingSocket) {
      this.signalingSocket.close();
      this.signalingSocket = null;
    }

    this.peerConnection.close();
    this.videoElement.srcObject = null;
  }
}
