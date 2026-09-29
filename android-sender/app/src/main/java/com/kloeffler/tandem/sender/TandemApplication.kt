package com.kloeffler.tandem.sender

import android.app.Application
import android.content.Context
import java.io.File

class TandemApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        TandemController.init(this)
        CrashReport.install(this)
    }
}

/**
 * Saves the stack trace of a crash so the next launch can show it. Devices such
 * as old Fire tablets often can't be debugged over USB, so this is the only way
 * to see why a share failed there. Native crashes inside WebRTC aren't caught.
 */
object CrashReport {
    private const val FILE_NAME = "last-crash.txt"
    private const val MAX_LENGTH = 4000

    fun install(context: Context) {
        val file = File(context.filesDir, FILE_NAME)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                val report = "Android ${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT}), " +
                    "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}\n${error.stackTraceToString()}"
                file.writeText(report.take(MAX_LENGTH))
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Returns the last crash report, if any, and clears it. */
    fun takeLast(context: Context): String? {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists()) return null
        return runCatching { file.readText() }.getOrNull().also { file.delete() }
    }
}
