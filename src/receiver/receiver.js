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
    this.pendingRemoteCandidates = [];
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
    this.signalingSocket.addEventListener("close", () =>
      onSignalStateChange("disconnected"),
    );
    this.signalingSocket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "offer" && message.sdp) {
        const answer = await this.acceptOffer({ sdp: message.sdp });
        this.sendSignal({
          sessionId: this.runtimeConfig.sessionId,
          type: "answer",
          ...answer,
        });
      }

      if (message.type === "ice" && message.candidate) {
        await this.addIceCandidate(message.candidate);
      }
    });

    this.peerConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) {
        return;
      }

      this.sendSignal({
        candidate: event.candidate.toJSON(),
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
      sdp: answer.sdp,
      type: answer.type,
    };
  }

  async addIceCandidate(candidate) {
    if (candidate == null || candidate.candidate === "") {
      if (!this.peerConnection.remoteDescription) {
        this.pendingRemoteCandidates.push(null);
        return;
      }

      await this.peerConnection.addIceCandidate(null);
      return;
    }

    if (!this.peerConnection.remoteDescription) {
      this.pendingRemoteCandidates.push(candidate);
      this.pendingRemoteCandidates = prioritizeIceCandidates(
        this.pendingRemoteCandidates,
      );
      return;
    }

    await this.peerConnection.addIceCandidate(candidate);
  }

  async flushPendingIceCandidates() {
    const prioritizedCandidates = prioritizeIceCandidates(
      this.pendingRemoteCandidates,
    );

    this.pendingRemoteCandidates = [];
    for (const candidate of prioritizedCandidates) {
      await this.peerConnection.addIceCandidate(candidate);
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
