package com.kloeffler.tandem.sender

import android.app.ActivityManager
import android.content.Context
import android.os.Build

/** What kind of device the app runs on, for picking capture and encoder settings. */
object DeviceProfile {
    private const val LOW_MEMORY_THRESHOLD_BYTES = 2L * 1024 * 1024 * 1024

    // Older Fire tablets have 1-1.5 GB of RAM and slow encoders.
    fun isLowMemory(context: Context): Boolean {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo().also(activityManager::getMemoryInfo)
        return activityManager.isLowRamDevice || memory.totalMem < LOW_MEMORY_THRESHOLD_BYTES
    }

    // Android 7.1 and older (Fire OS 5 and 6) or low-memory devices: hardware
    // encoders there are the likeliest to produce corrupt video, so default to
    // software encoding.
    fun needsCompatibilityMode(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || isLowMemory(context)
}
