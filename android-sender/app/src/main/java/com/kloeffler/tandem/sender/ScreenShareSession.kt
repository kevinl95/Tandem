package com.kloeffler.tandem.sender

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import kotlin.math.max
import kotlin.math.roundToInt

/** Share progress, mirroring the web sender's states in src/sender/sender.js. */
enum class ShareState(val isTerminal: Boolean = false) {
    OFFERING,
    AWAITING_APPROVAL,
    CONNECTING,
    STREAMING,
    DECLINED(true),
    NO_RECEIVER(true),
    RATE_LIMITED(true),
    RECEIVER_LEFT(true),
    FAILED(true),
    STOPPED(true),
}

/**
 * One screen share to one TV: captures the screen with MediaProjection and
 * streams it send-only over WebRTC, using [send] for signaling. Must be started
 * from a foreground service of type mediaProjection. Runs on the main thread.
 */
class ScreenShareSession(
    private val context: Context,
    private val factory: PeerConnectionFactory,
    private val eglBase: EglBase,
    private val projectionData: Intent,
    val sessionId: String,
    private val includeAudio: Boolean,
    private val send: (JSONObject) -> Boolean,
    private val onState: (ShareState) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var capturer: ScreenCapturerAndroid? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var peerConnection: PeerConnection? = null
    private var hasRemoteDescription = false
    private val pendingRemoteCandidates = mutableListOf<IceCandidate>()
    private var isOfferAcknowledged = false
    private val pendingLocalCandidates = mutableListOf<JSONObject>()
    private val connectTimeout = Runnable {
        if (state != ShareState.STREAMING) {
            Log.w(TAG, "The TV answered but the connection never completed")
            stop(ShareState.FAILED)
        }
    }
    var state: ShareState = ShareState.OFFERING
        private set

    fun start() {
        val source = factory.createVideoSource(/* isScreencast = */ true)
        videoSource = source
        val helper = SurfaceTextureHelper.create("TandemCapture", eglBase.eglBaseContext)
        val screenCapturer = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {
            // The user ended the capture from the system UI.
            override fun onStop() {
                mainHandler.post { stop(ShareState.STOPPED) }
            }
        })
        surfaceTextureHelper = helper
        capturer = screenCapturer
        screenCapturer.initialize(helper, context, source.capturerObserver)
        val (width, height) = captureSize()
        screenCapturer.startCapture(width, height, CAPTURE_FPS)

        val configuration = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val connection = factory.createPeerConnection(configuration, PeerObserver())
            ?: return stop(ShareState.FAILED)
        peerConnection = connection

        val track = factory.createVideoTrack("tandem-screen", source)
        videoTrack = track
        val transceiver = connection.addTransceiver(
            track,
            RtpTransceiver.RtpTransceiverInit(
                RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                listOf(STREAM_ID),
            ),
        )
        preferH264(transceiver)

        if (includeAudio) {
            screenCapturer.mediaProjection?.let { projection ->
                // Turn off voice processing, which degrades music and video soundtracks.
                val constraints = MediaConstraints().apply {
                    listOf("googEchoCancellation", "googAutoGainControl", "googNoiseSuppression", "googHighpassFilter")
                        .forEach { mandatory += MediaConstraints.KeyValuePair(it, "false") }
                }
                val source = factory.createAudioSource(constraints)
                val track = factory.createAudioTrack("tandem-audio", source)
                audioSource = source
                audioTrack = track
                connection.addTransceiver(
                    track,
                    RtpTransceiver.RtpTransceiverInit(
                        RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                        listOf(STREAM_ID),
                    ),
                )
                ShareAudio.start(projection)
            }
        }

        connection.createOffer(object : SimpleSdpObserver("createOffer") {
            override fun onCreateSuccess(description: SessionDescription) {
                connection.setLocalDescription(object : SimpleSdpObserver("setLocalDescription") {
                    override fun onSetSuccess() {
                        mainHandler.post {
                            if (state.isTerminal) return@post
                            send(
                                JSONObject()
                                    .put("type", "offer")
                                    .put("sdp", description.description)
                                    .put("sessionId", sessionId),
                            )
                            setState(ShareState.OFFERING)
                        }
                    }
                }, description)
            }
        }, MediaConstraints())
    }

    /** Handles a signaling message addressed to this share. */
    fun handleMessage(message: JSONObject) {
        val connection = peerConnection ?: return
        val type = message.optString("type")
        if (type == "pending" || type == "answer") acknowledgeOffer()
        when (type) {
            "answer" -> connection.setRemoteDescription(object : SimpleSdpObserver("setRemoteDescription") {
                override fun onSetSuccess() {
                    mainHandler.post {
                        hasRemoteDescription = true
                        pendingRemoteCandidates.forEach { connection.addIceCandidate(it) }
                        pendingRemoteCandidates.clear()
                        if (state != ShareState.STREAMING) {
                            setState(ShareState.CONNECTING)
                            mainHandler.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS)
                        }
                    }
                }
            }, SessionDescription(SessionDescription.Type.ANSWER, message.optString("sdp")))

            "ice" -> {
                // A null candidate only marks the end of gathering.
                val json = message.optJSONObject("candidate") ?: return
                val candidate = IceCandidate(
                    json.optString("sdpMid"),
                    json.optInt("sdpMLineIndex"),
                    json.optString("candidate"),
                )
                Log.i(TAG, "Remote ICE candidate: ${candidate.sdp}")
                // Relayed messages can overtake the answer, so hold candidates until then.
                if (hasRemoteDescription) connection.addIceCandidate(candidate)
                else pendingRemoteCandidates += candidate
            }

            "pending" -> setState(ShareState.AWAITING_APPROVAL)
            "decline" -> stop(ShareState.DECLINED)
            "peer-left" -> stop(ShareState.RECEIVER_LEFT)
            "error" -> when (message.optString("reason")) {
                "no-peer" -> stop(ShareState.NO_RECEIVER)
                "rate-limited" -> stop(ShareState.RATE_LIMITED)
            }
        }
    }

    fun stop(finalState: ShareState = ShareState.STOPPED) {
        if (state.isTerminal) return
        Log.i(TAG, "Share to $sessionId ended: $finalState")
        state = finalState
        mainHandler.removeCallbacks(connectTimeout)

        ShareAudio.stop()
        runCatching { capturer?.stopCapture() }
        capturer?.dispose()
        capturer = null
        peerConnection?.dispose()
        peerConnection = null
        videoTrack?.dispose()
        videoTrack = null
        videoSource?.dispose()
        videoSource = null
        audioTrack?.dispose()
        audioTrack = null
        audioSource?.dispose()
        audioSource = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null
        onState(finalState)
    }

    private fun setState(newState: ShareState) {
        if (state.isTerminal || state == newState) return
        Log.i(TAG, "Share to $sessionId: $newState")
        if (newState == ShareState.STREAMING) mainHandler.removeCallbacks(connectTimeout)
        state = newState
        onState(newState)
    }

    // Scale the display down so its long edge fits what the TV decodes smoothly.
    private fun captureSize(): Pair<Int, Int> {
        val metrics = context.resources.displayMetrics
        val scale = minOf(1.0, MAX_CAPTURE_EDGE.toDouble() / max(metrics.widthPixels, metrics.heightPixels))
        fun even(value: Double) = (value.roundToInt() / 2) * 2
        return even(metrics.widthPixels * scale) to even(metrics.heightPixels * scale)
    }

    private fun preferH264(transceiver: RtpTransceiver) {
        val codecs = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
        val (h264, others) = codecs.partition { it.name.equals("H264", ignoreCase = true) }
        if (h264.isNotEmpty()) {
            runCatching { transceiver.setCodecPreferences(h264 + others) }
                .onFailure { Log.w(TAG, "Could not prefer H264", it) }
        }
    }

    // The relay handles each message in a separate Lambda invocation, so ICE
    // sent right behind the offer can arrive before the server has bound this
    // sender to the TV's session, and get dropped. Hold it until the TV
    // acknowledges the offer with "pending" or "answer".
    private fun sendIce(candidate: Any) {
        val message = JSONObject().put("type", "ice").put("candidate", candidate)
        if (isOfferAcknowledged) send(message) else pendingLocalCandidates += message
    }

    private fun acknowledgeOffer() {
        if (isOfferAcknowledged) return
        isOfferAcknowledged = true
        pendingLocalCandidates.forEach { send(it) }
        pendingLocalCandidates.clear()
    }

    private inner class PeerObserver : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            Log.i(TAG, "Local ICE candidate: ${candidate.sdp}")
            mainHandler.post {
                sendIce(
                    JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex),
                )
            }
        }

        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {
            if (newState == PeerConnection.IceGatheringState.COMPLETE) {
                mainHandler.post { sendIce(JSONObject.NULL) }
            }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            Log.i(TAG, "Peer connection state: $newState")
            mainHandler.post {
                when (newState) {
                    PeerConnection.PeerConnectionState.CONNECTED -> setState(ShareState.STREAMING)
                    PeerConnection.PeerConnectionState.FAILED -> stop(ShareState.FAILED)
                    else -> Unit
                }
            }
        }

        override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
            Log.i(TAG, "ICE connection state: $newState")
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: org.webrtc.MediaStream) = Unit
        override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
        override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
    }

    private open inner class SimpleSdpObserver(private val operation: String) : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = fail(error)
        override fun onSetFailure(error: String) = fail(error)

        private fun fail(error: String) {
            Log.e(TAG, "$operation failed: $error")
            mainHandler.post { stop(ShareState.FAILED) }
        }
    }

    private companion object {
        const val TAG = "TandemShare"
        const val STREAM_ID = "tandem"
        const val CAPTURE_FPS = 30
        const val MAX_CAPTURE_EDGE = 1920
        const val CONNECT_TIMEOUT_MS = 20_000L
    }
}
