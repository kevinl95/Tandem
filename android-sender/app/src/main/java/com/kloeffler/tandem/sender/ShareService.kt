package com.kloeffler.tandem.sender

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that keeps a share alive while the phone shows other
 * apps. Android requires MediaProjection capture to run inside a foreground
 * service of type mediaProjection, started before the projection is created.
 */
class ShareService : Service(), TandemController.Observer {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val projectionData = intent.getParcelableExtraCompat(EXTRA_PROJECTION_DATA)
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
                if (projectionData == null || sessionId == null) {
                    stopSelf()
                    return START_NOT_STICKY
                }

                // Playback audio capture exists from Android 10; older devices
                // share video only.
                val includeAudio = Build.VERSION.SDK_INT >= 29 &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                startForegroundForShare(includeAudio)
                // Observe only after starting, so ending a previous share
                // doesn't stop the service; then catch an immediate failure.
                TandemController.startShare(projectionData, sessionId, includeAudio)
                TandemController.addObserver(this)
                onChanged()
            }

            ACTION_STOP -> TandemController.stopShare()
        }
        // A projection can't be recreated without the user, so don't restart.
        return START_NOT_STICKY
    }

    override fun onChanged() {
        if (!TandemController.isSharing) {
            TandemController.removeObserver(this)
            TandemController.disconnectIfIdle()
            if (Build.VERSION.SDK_INT >= 24) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            stopSelf()
        }
    }

    override fun onDestroy() {
        TandemController.removeObserver(this)
        TandemController.stopShare()
        super.onDestroy()
    }

    private fun startForegroundForShare(includeAudio: Boolean) {
        val notification = buildNotification()
        when {
            // Sending playback audio keeps WebRTC's microphone recorder running,
            // which Android 11+ only allows with the microphone service type.
            Build.VERSION.SDK_INT >= 30 -> startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or
                    (if (includeAudio) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0),
            )
            Build.VERSION.SDK_INT >= 29 -> startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
            else -> startForeground(NOTIFICATION_ID, notification)
        }
    }

    @Suppress("DEPRECATION") // Pre-Android 8 notification and action builders.
    private fun buildNotification(): Notification {
        val immutable = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0
        val openApp = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), immutable)
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, ShareService::class.java).setAction(ACTION_STOP),
            immutable,
        )

        val builder = if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
            )
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
        }

        return builder
            .setSmallIcon(R.drawable.ic_tandem)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setContentIntent(openApp)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(R.drawable.ic_tandem, getString(R.string.stop_sharing), stop).build(),
            )
            .build()
    }

    companion object {
        private const val ACTION_START = "com.kloeffler.tandem.sender.START"
        private const val ACTION_STOP = "com.kloeffler.tandem.sender.STOP"
        private const val EXTRA_PROJECTION_DATA = "projectionData"
        private const val EXTRA_SESSION_ID = "sessionId"
        private const val CHANNEL_ID = "sharing"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context, projectionData: Intent, sessionId: String) {
            val intent = Intent(context, ShareService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_PROJECTION_DATA, projectionData)
                .putExtra(EXTRA_SESSION_ID, sessionId)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, ShareService::class.java).setAction(ACTION_STOP))
        }

        @Suppress("DEPRECATION")
        private fun Intent.getParcelableExtraCompat(name: String): Intent? =
            if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(name, Intent::class.java)
            else getParcelableExtra(name)
    }
}
