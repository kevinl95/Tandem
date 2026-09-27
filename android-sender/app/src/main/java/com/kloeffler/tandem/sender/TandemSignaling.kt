package com.kloeffler.tandem.sender

import android.os.Handler
import android.os.Looper
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/**
 * Sender side of the Tandem signaling protocol (see infra/lambda/signaling.py).
 *
 * Connects as a sender with a stable client id and display name, lists TVs on
 * the same network, and relays share messages. All listener callbacks run on
 * the main thread. The connection reconnects by itself until [close].
 */
class TandemSignaling(
    private val endpoint: String,
    private val clientId: String,
    private val name: String,
    private val listener: Listener,
) {
    data class Receiver(val sessionId: String, val name: String)

    interface Listener {
        fun onConnectionChanged(connected: Boolean)
        fun onReceivers(receivers: List<Receiver>)
        fun onShareMessage(message: JSONObject)
    }

    private val client = OkHttpClient()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var webSocket: WebSocket? = null
    private var isClosed = false
    var isConnected = false
        private set

    private val keepalive = object : Runnable {
        override fun run() {
            send(JSONObject().put("type", "ping"))
            mainHandler.postDelayed(this, KEEPALIVE_INTERVAL_MS)
        }
    }

    fun connect() {
        val url = endpoint.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://")
            .toHttpUrl().newBuilder()
            .addQueryParameter("role", "sender")
            .addQueryParameter("clientId", clientId)
            .addQueryParameter("name", name)
            .build()
        webSocket = client.newWebSocket(Request.Builder().url(url).build(), SocketListener())
    }

    fun discover() {
        send(JSONObject().put("type", "discover"))
    }

    fun send(message: JSONObject): Boolean = isConnected && webSocket?.send(message.toString()) == true

    fun close() {
        isClosed = true
        mainHandler.removeCallbacksAndMessages(null)
        webSocket?.close(1000, null)
        webSocket = null
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            mainHandler.post {
                if (webSocket !== this@TandemSignaling.webSocket) return@post
                isConnected = true
                mainHandler.removeCallbacks(keepalive)
                mainHandler.postDelayed(keepalive, KEEPALIVE_INTERVAL_MS)
                listener.onConnectionChanged(true)
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = runCatching { JSONObject(text) }.getOrNull() ?: return
            mainHandler.post {
                if (message.optString("type") == "receivers") {
                    val list = message.optJSONArray("receivers")
                    val receivers = (0 until (list?.length() ?: 0)).mapNotNull { index ->
                        val item = list?.optJSONObject(index) ?: return@mapNotNull null
                        Receiver(item.optString("sessionId"), item.optString("name"))
                    }
                    listener.onReceivers(receivers)
                } else {
                    listener.onShareMessage(message)
                }
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = handleDrop(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = handleDrop(webSocket)

        private fun handleDrop(socket: WebSocket) {
            mainHandler.post {
                if (socket !== webSocket || isClosed) return@post
                isConnected = false
                mainHandler.removeCallbacks(keepalive)
                listener.onConnectionChanged(false)
                mainHandler.postDelayed({ if (!isClosed) connect() }, RECONNECT_DELAY_MS)
            }
        }
    }

    private companion object {
        // API Gateway closes WebSockets that are idle for 10 minutes; each ping
        // is a billed message, so send them as rarely as that allows.
        const val KEEPALIVE_INTERVAL_MS = 9 * 60 * 1000L
        const val RECONNECT_DELAY_MS = 3000L
    }
}
