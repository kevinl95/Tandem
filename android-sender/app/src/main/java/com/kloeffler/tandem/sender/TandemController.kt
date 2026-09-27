package com.kloeffler.tandem.sender

import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
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
    private val factory: PeerConnectionFactory by lazy {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions(),
        )
        val audioDeviceModule = JavaAudioDeviceModule.builder(appContext)
            // Playback audio replaces the microphone signal (see ShareAudio),
            // so skip voice processing meant for the microphone.
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setUseStereoInput(true)
            .setAudioRecordDataCallback(ShareAudio)
            .createAudioDeviceModule()
        PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDeviceModule)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
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

        session = ScreenShareSession(
            context = appContext,
            factory = factory,
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
        val preferences = appContext.getSharedPreferences("tandem", Context.MODE_PRIVATE)
        return preferences.getString("clientId", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("clientId", it).apply()
        }
    }

    private fun deviceName(): String {
        val model = Build.MODEL.orEmpty()
        val manufacturer = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
        return if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model".trim()
    }
}
