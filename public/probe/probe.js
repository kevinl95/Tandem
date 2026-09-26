// WebRTC capability probe for the Vega WebView. Classic script (no modules) so it
// loads from file:///pkg/assets on device as well as from a local dev server.
(() => {
  "use strict";

  const STEP_TIMEOUT_MS = 10000;
  const resultsList = document.querySelector("#results");
  const summary = document.querySelector("#summary");
  const report = { userAgent: navigator.userAgent, results: [] };

  function record(name, status, detail = "") {
    report.results.push({ name, status, detail });

    const item = document.createElement("li");
    item.className = status;
    item.textContent = `${status.toUpperCase()}  ${name}${detail ? ` — ${detail}` : ""}`;
    resultsList.append(item);
    console.info(`[tandem-probe] ${status} ${name} ${detail}`);
  }

  function withTimeout(promise, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)),
          STEP_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function publishReport() {
    const failed = report.results.filter((result) => result.status === "fail");
    report.verdict = failed.length === 0 ? "webrtc-receive-supported" : "webrtc-receive-blocked";
    summary.textContent =
      failed.length === 0
        ? "This device can receive WebRTC video."
        : `This device cannot receive WebRTC video yet (${failed.length} failed checks).`;

    const serialized = JSON.stringify(report);
    console.info(`[tandem-probe] report ${serialized}`);
    window.ReactNativeWebView?.postMessage(
      JSON.stringify({ type: "probe-report", report }),
    );
  }

  function checkApis() {
    const apis = {
      RTCPeerConnection: typeof window.RTCPeerConnection === "function",
      RTCRtpReceiver: typeof window.RTCRtpReceiver === "function",
      MediaStream: typeof window.MediaStream === "function",
      WebSocket: typeof window.WebSocket === "function",
      "HTMLVideoElement.srcObject": "srcObject" in HTMLVideoElement.prototype,
    };

    for (const [name, present] of Object.entries(apis)) {
      record(`API ${name}`, present ? "pass" : "fail");
    }

    return apis.RTCPeerConnection;
  }

  function checkReceiveCodecs() {
    const capabilities = window.RTCRtpReceiver?.getCapabilities?.("video");
    if (!capabilities) {
      record("Video receive codecs", "fail", "RTCRtpReceiver.getCapabilities unavailable");
      return;
    }

    const codecs = [
      ...new Set(
        capabilities.codecs
          .map((codec) => codec.mimeType)
          .filter((mimeType) => !/rtx|red|ulpfec|flexfec/i.test(mimeType)),
      ),
    ];
    const hasH264 = codecs.some((mimeType) => /h264/i.test(mimeType));
    record(
      "Video receive codecs",
      codecs.length === 0 ? "fail" : hasH264 ? "pass" : "warn",
      codecs.join(", ") + (hasH264 ? "" : " (no H264: phones prefer it for hardware encode)"),
    );
  }

  async function checkIceGathering() {
    const peerConnection = new RTCPeerConnection();
    const candidates = [];

    try {
      peerConnection.createDataChannel("probe");
      const gatheringComplete = new Promise((resolve) => {
        peerConnection.addEventListener("icecandidate", (event) => {
          if (event.candidate) {
            candidates.push(event.candidate.candidate);
          } else {
            resolve();
          }
        });
      });

      await peerConnection.setLocalDescription(await peerConnection.createOffer());
      await withTimeout(gatheringComplete, "ICE gathering");
    } catch (error) {
      record("ICE host candidates", candidates.length ? "warn" : "fail", error.message);
      return;
    } finally {
      peerConnection.close();
    }

    const hostCandidates = candidates.filter((line) => /\btyp host\b/.test(line));
    const mdnsHosts = hostCandidates.filter((line) => /\s[\w-]+\.local\s/.test(line));

    if (hostCandidates.length === 0) {
      record("ICE host candidates", "fail", `none gathered (${candidates.length} total)`);
      return;
    }

    record(
      "ICE host candidates",
      mdnsHosts.length === hostCandidates.length ? "warn" : "pass",
      mdnsHosts.length === hostCandidates.length
        ? `${hostCandidates.length} gathered, all mDNS-obfuscated (.local): LAN peers must resolve mDNS`
        : `${hostCandidates.length} gathered with raw IPs`,
    );
  }

  function startSyntheticVideo() {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    let frame = 0;
    const interval = setInterval(() => {
      frame += 1;
      context.fillStyle = `hsl(${(frame * 7) % 360} 70% 40%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "white";
      context.font = "48px sans-serif";
      context.fillText(`frame ${frame}`, 40, 200);
    }, 1000 / 15);

    return { stream: canvas.captureStream(15), stop: () => clearInterval(interval) };
  }

  async function checkLoopbackVideo() {
    if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
      record(
        "Loopback video decode",
        "warn",
        "skipped: canvas.captureStream unavailable, so there is no local sender to test with",
      );
      return;
    }

    const sender = new RTCPeerConnection();
    const receiver = new RTCPeerConnection();
    const video = document.querySelector("#loopback-video");
    const synthetic = startSyntheticVideo();

    try {
      sender.addEventListener("icecandidate", (event) =>
        receiver.addIceCandidate(event.candidate),
      );
      receiver.addEventListener("icecandidate", (event) =>
        sender.addIceCandidate(event.candidate),
      );
      const trackReceived = new Promise((resolve) =>
        receiver.addEventListener("track", (event) => resolve(event.streams[0])),
      );

      for (const track of synthetic.stream.getTracks()) {
        sender.addTrack(track, synthetic.stream);
      }

      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription);

      video.srcObject = await withTimeout(trackReceived, "Remote track");
      await withTimeout(waitForDecodedFrames(receiver), "Frame decode");

      const decoder = await describeInboundVideo(receiver);
      record(
        "Loopback video decode",
        "pass",
        `${video.videoWidth}x${video.videoHeight}, ${decoder}`,
      );
    } catch (error) {
      record("Loopback video decode", "fail", error.message);
    } finally {
      synthetic.stop();
      sender.close();
      receiver.close();
    }
  }

  async function waitForDecodedFrames(peerConnection) {
    for (;;) {
      const stats = await peerConnection.getStats();
      for (const entry of stats.values()) {
        if (entry.type === "inbound-rtp" && entry.kind === "video" && entry.framesDecoded > 5) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function describeInboundVideo(peerConnection) {
    const stats = await peerConnection.getStats();
    for (const entry of stats.values()) {
      if (entry.type === "inbound-rtp" && entry.kind === "video") {
        const codec = stats.get(entry.codecId)?.mimeType ?? "unknown codec";
        return `${codec} via ${entry.decoderImplementation ?? "unknown decoder"}`;
      }
    }
    return "no inbound video stats";
  }

  async function run() {
    record("Environment", "info", navigator.userAgent);

    if (!checkApis()) {
      publishReport();
      return;
    }

    checkReceiveCodecs();
    await checkIceGathering();
    await checkLoopbackVideo();
    publishReport();
  }

  document.addEventListener("keydown", (event) => {
    // Vega remote Back arrives as keyCode 27.
    if (event.keyCode === 27 || event.key === "Escape") {
      document.querySelector("#back-link").click();
    }
  });

  run().catch((error) => {
    record("Probe", "fail", error.message);
    publishReport();
  });
})();
