package com.kloeffler.tandem.sender

import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.SoftwareVideoEncoderFactory
import org.webrtc.VideoEncoderFactory
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.UUID

/**
 * Process-wide Tandem state: one signaling connection used for discovery and
 * for the current share, which the activity observes and the foreground
 * service drives. Main thread only.
 */
object TandemController {
    interface Observer {
        fun onChanged()
    }

    private lateinit var appContext: Context
    private var signaling: TandemSignaling? = null
    private val observers = mutableSetOf<Observer>()
    private val eglBase: EglBase by lazy { EglBase.create() }
    private val hardwareFactory: PeerConnectionFactory by lazy {
        createFactory { DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true) }
    }

    // Compatibility mode: encode video in software (VP8), for devices whose
    // hardware encoder produces corrupted frames, such as some older Fire tablets.
    private val softwareFactory: PeerConnectionFactory by lazy {
        createFactory { SoftwareVideoEncoderFactory() }
    }

    private val isWebRtcInitialized by lazy {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions(),
        )
        true
    }

    // Encoder factories call into WebRTC's native library, so they must be
    // constructed only after PeerConnectionFactory.initialize() has loaded it.
    private fun createFactory(encoderFactory: () -> VideoEncoderFactory): PeerConnectionFactory {
        check(isWebRtcInitialized)
        val audioDeviceModule = JavaAudioDeviceModule.builder(appContext)
            // Playback audio replaces the microphone signal (see ShareAudio),
            // so skip voice processing meant for the microphone.
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setUseStereoInput(true)
            .setAudioRecordDataCallback(ShareAudio)
            .createAudioDeviceModule()
        return PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDeviceModule)
            .setVideoEncoderFactory(encoderFactory())
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private val preferences by lazy { appContext.getSharedPreferences("tandem", Context.MODE_PRIVATE) }

    // On by default for devices whose hardware encoders are known to corrupt
    // frames (a 2016 Fire tablet on Fire OS 5 did), until the user chooses.
    var compatibilityMode: Boolean
        get() = if (preferences.contains("compatibilityMode")) {
            preferences.getBoolean("compatibilityMode", false)
        } else {
            DeviceProfile.needsCompatibilityMode(appContext)
        }
        set(value) = preferences.edit().putBoolean("compatibilityMode", value).apply()

    /** What the current share is sending, e.g. for spotting encoder problems. */
    var shareDetails: String? = null
        private set

    fun refreshShareDetails() {
        session?.describe { details ->
            shareDetails = details
            notifyObservers()
        }
    }

    var receivers: List<TandemSignaling.Receiver> = emptyList()
        private set
    var isConnected = false
        private set
    var hasDiscovered = false
        private set
    var session: ScreenShareSession? = null
        private set

    /** The latest share outcome, including terminal ones, for the status line. */
    var lastShareState: ShareState? = null
        private set

    val isConfigured: Boolean get() = BuildConfig.SIGNALING_ENDPOINT.isNotBlank()
    val isSharing: Boolean get() = session?.state?.isTerminal == false

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    fun connect() {
        if (signaling != null || !isConfigured) return
        signaling = TandemSignaling(
            endpoint = BuildConfig.SIGNALING_ENDPOINT,
            clientId = clientId(),
            name = deviceName(),
            listener = object : TandemSignaling.Listener {
                override fun onConnectionChanged(connected: Boolean) {
                    isConnected = connected
                    if (connected) discover()
                    notifyObservers()
                }

                override fun onReceivers(receivers: List<TandemSignaling.Receiver>) {
                    this@TandemController.receivers = receivers
                    hasDiscovered = true
                    notifyObservers()
                }

                override fun onShareMessage(message: JSONObject) {
                    val current = session ?: return
                    // Drop leftovers addressed to a TV this phone no longer shares to.
                    val sessionId = message.optString("sessionId")
                    if (sessionId.isEmpty() || sessionId == current.sessionId) {
                        current.handleMessage(message)
                    }
                }
            },
        ).also { it.connect() }
    }

    /** Whether the Tandem screen is showing; set by the activity. */
    var isUiVisible = false
        set(value) {
            field = value
            disconnectIfIdle()
        }

    // An open connection is billed by the minute, so only hold one while the
    // app is on screen or sharing.
    fun disconnectIfIdle() {
        if (isUiVisible || isSharing) return
        signaling?.close()
        signaling = null
        isConnected = false
        receivers = emptyList()
        hasDiscovered = false
    }

    fun discover() {
        if (!isSharing) signaling?.discover()
    }

    /** Starts sharing to [sessionId]; call from the running foreground service. */
    fun startShare(projectionData: Intent, sessionId: String, includeAudio: Boolean) {
        session?.stop(ShareState.STOPPED)
        val activeSignaling = signaling
        if (activeSignaling == null || !activeSignaling.isConnected) {
            lastShareState = ShareState.FAILED
            notifyObservers()
            return
        }

        shareDetails = null
        val compatible = compatibilityMode
        session = ScreenShareSession(
            context = appContext,
            factory = if (compatible) softwareFactory else hardwareFactory,
            compatibilityMode = compatible,
            eglBase = eglBase,
            projectionData = projectionData,
            sessionId = sessionId,
            includeAudio = includeAudio,
            send = activeSignaling::send,
            onState = { state ->
                lastShareState = state
                notifyObservers()
            },
        ).also { it.start() }
        notifyObservers()
    }

    fun stopShare() {
        session?.stop(ShareState.STOPPED)
    }

    fun addObserver(observer: Observer) {
        observers += observer
    }

    fun removeObserver(observer: Observer) {
        observers -= observer
    }

    private fun notifyObservers() {
        observers.toList().forEach { it.onChanged() }
    }

    // A stable id lets the TV remember that it already allowed this phone.
    private fun clientId(): String {
        return preferences.getString("clientId", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("clientId", it).apply()
        }
    }

    private fun deviceName(): String {
        // Fire tablets report model codes such as "KFFOWI"; show something readable.
        if (Build.MANUFACTURER.equals("Amazon", ignoreCase = true) && Build.MODEL.orEmpty().startsWith("KF")) {
            return "Fire tablet"
        }
        val model = Build.MODEL.orEmpty()
        val manufacturer = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
        return if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model".trim()
    }
}
