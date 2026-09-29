// Minimal WebRTC and WebSocket stand-ins for exercising the signaling flows
// in Node, where neither API exists.
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = {};
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    (this.listeners[name] ??= []).push(listener);
  }

  emit(name, event = {}) {
    for (const listener of this.listeners[name] ?? []) {
      listener(event);
    }
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(message) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
}

export class FakePeerConnection {
  static instances = [];

  constructor(configuration) {
    this.configuration = configuration;
    this.addedIceCandidates = [];
    this.transceivers = [];
    this.listeners = {};
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = "new";
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  addEventListener(name, listener) {
    (this.listeners[name] ??= []).push(listener);
  }

  emit(name, event = {}) {
    for (const listener of this.listeners[name] ?? []) {
      listener(event);
    }
  }

  setConnectionState(state) {
    this.connectionState = state;
    this.emit("connectionstatechange");
  }

  addTransceiver(track, init) {
    const transceiver = { init, track };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  async addIceCandidate(candidate) {
    this.addedIceCandidates.push(candidate);
  }

  async createOffer() {
    return { sdp: "offer-sdp", type: "offer" };
  }

  async createAnswer() {
    return { sdp: "answer-sdp", type: "answer" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }

  // Tests set this.stats to a Map of stats entries.
  async getStats() {
    return this.stats ?? new Map();
  }
}

// Installs the fakes as globals for one test and restores the originals after.
export function installFakes(t) {
  const originals = {
    RTCPeerConnection: globalThis.RTCPeerConnection,
    WebSocket: globalThis.WebSocket,
  };

  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => Object.assign(globalThis, originals));
}

// Lets pending promise chains (async message handlers) run to completion.
export function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}
