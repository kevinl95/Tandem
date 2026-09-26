const HOST_CANDIDATE_PATTERN = /\btyp host\b/;

export function buildPeerConfiguration({ stunServerUrl = "" } = {}) {
  const normalizedStunServerUrl = stunServerUrl.trim();

  return {
    bundlePolicy: "balanced",
    iceCandidatePoolSize: 0,
    iceServers: normalizedStunServerUrl ? [{ urls: normalizedStunServerUrl }] : [],
    iceTransportPolicy: "all",
    rtcpMuxPolicy: "require",
  };
}

export function createReceiverRuntimeConfig({
  sessionId = "",
  signalingEndpoint = "",
  stunServerUrl = "",
} = {}) {
  return {
    peerConfiguration: buildPeerConfiguration({ stunServerUrl }),
    preferHostIceCandidates: true,
    sessionId: sessionId.trim(),
    signalingEndpoint: signalingEndpoint.trim(),
    stunServerUrl: stunServerUrl.trim(),
  };
}

export function isHostIceCandidate(candidateLine = "") {
  return HOST_CANDIDATE_PATTERN.test(candidateLine);
}

export function prioritizeIceCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    const leftPriority = isHostIceCandidate(left?.candidate) ? 0 : 1;
    const rightPriority = isHostIceCandidate(right?.candidate) ? 0 : 1;
    return leftPriority - rightPriority;
  });
}
