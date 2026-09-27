package com.kloeffler.tandem.sender

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity(), TandemController.Observer {
    private lateinit var tvList: LinearLayout
    private lateinit var tvListEmpty: TextView
    private lateinit var vpnHint: TextView
    private lateinit var codeInput: EditText
    private lateinit var shareCodeButton: Button
    private lateinit var statusText: TextView
    private lateinit var stopButton: Button
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingSessionId: String? = null
    private var askedForAudio = false

    // Keep the TV list fresh while the app is open and idle.
    private val discoveryLoop = object : Runnable {
        override fun run() {
            TandemController.discover()
            mainHandler.postDelayed(this, DISCOVERY_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        tvList = findViewById(R.id.tv_list)
        tvListEmpty = findViewById(R.id.tv_list_empty)
        vpnHint = findViewById(R.id.vpn_hint)
        codeInput = findViewById(R.id.session_code)
        shareCodeButton = findViewById(R.id.share_code)
        statusText = findViewById(R.id.status)
        stopButton = findViewById(R.id.stop_sharing)

        shareCodeButton.setOnClickListener { shareTypedCode() }
        codeInput.setOnEditorActionListener { _, actionId, _ ->
            (actionId == EditorInfo.IME_ACTION_GO).also { if (it) shareTypedCode() }
        }
        stopButton.setOnClickListener { ShareService.stop(this) }

        // Android 13+ hides the sharing notification (and its Stop button) without this.
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
        }
    }

    override fun onStart() {
        super.onStart()
        TandemController.addObserver(this)
        TandemController.connect()
        mainHandler.post(discoveryLoop)
        render()
    }

    override fun onStop() {
        TandemController.removeObserver(this)
        mainHandler.removeCallbacks(discoveryLoop)
        super.onStop()
    }

    override fun onChanged() = render()

    private fun shareTypedCode() {
        val code = codeInput.text.toString().replace(Regex("[\\s-]"), "").uppercase()
        if (!Regex("^[A-Z0-9]{6}$").matches(code)) {
            statusText.setText(R.string.enter_code)
            codeInput.requestFocus()
            return
        }
        requestCapture(code)
    }

    // Ask for audio first (once); sharing continues video-only if it's refused.
    private fun requestCapture(sessionId: String) {
        pendingSessionId = sessionId
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED &&
            !askedForAudio
        ) {
            askedForAudio = true
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
            return
        }
        launchCapturePrompt()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO && pendingSessionId != null) launchCapturePrompt()
    }

    private fun launchCapturePrompt() {
        val projectionManager = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        startActivityForResult(projectionManager.createScreenCaptureIntent(), REQUEST_CAPTURE)
    }

    @Deprecated("Platform Activity result API; no AndroidX dependency needed.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CAPTURE) return

        val sessionId = pendingSessionId
        pendingSessionId = null
        if (resultCode == RESULT_OK && data != null && sessionId != null) {
            ShareService.start(this, data, sessionId)
        } else {
            statusText.setText(R.string.capture_denied)
        }
    }

    private fun render() {
        if (!TandemController.isConfigured) {
            tvListEmpty.setText(R.string.not_configured)
            shareCodeButton.isEnabled = false
            return
        }

        val sharing = TandemController.isSharing
        tvList.removeAllViews()
        for (receiver in TandemController.receivers) {
            tvList.addView(
                Button(this).apply {
                    text = getString(R.string.tv_button, receiver.name, receiver.sessionId)
                    isAllCaps = false
                    isEnabled = !sharing
                    setOnClickListener { requestCapture(receiver.sessionId) }
                },
            )
        }
        tvListEmpty.visibility = if (TandemController.receivers.isEmpty()) View.VISIBLE else View.GONE
        tvListEmpty.setText(
            if (TandemController.hasDiscovered) R.string.no_tvs else R.string.looking_for_tvs,
        )

        val vpnActive = isVpnActive()
        vpnHint.visibility = if (vpnActive && !sharing) View.VISIBLE else View.GONE

        shareCodeButton.isEnabled = !sharing
        codeInput.isEnabled = !sharing
        stopButton.visibility = if (sharing) View.VISIBLE else View.GONE
        TandemController.lastShareState?.let { statusText.setText(statusMessage(it, vpnActive)) }
    }

    // VPNs usually route LAN traffic through the tunnel or block it, which
    // breaks both discovery (a different public IP) and the direct connection.
    private fun isVpnActive(): Boolean {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    private fun statusMessage(state: ShareState, vpnActive: Boolean): Int = when (state) {
        ShareState.OFFERING -> R.string.state_offering
        ShareState.AWAITING_APPROVAL -> R.string.state_awaiting_approval
        ShareState.CONNECTING -> R.string.state_connecting
        ShareState.STREAMING -> R.string.state_streaming
        ShareState.DECLINED -> R.string.state_declined
        ShareState.NO_RECEIVER -> R.string.state_no_receiver
        ShareState.RATE_LIMITED -> R.string.state_rate_limited
        ShareState.RECEIVER_LEFT -> R.string.state_receiver_left
        ShareState.FAILED -> if (vpnActive) R.string.state_failed_vpn else R.string.state_failed
        ShareState.STOPPED -> R.string.state_stopped
    }

    private companion object {
        const val REQUEST_CAPTURE = 1
        const val REQUEST_AUDIO = 2
        const val DISCOVERY_INTERVAL_MS = 5000L
    }
}
