package com.kloeffler.tandem.sender

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.util.Log
import org.webrtc.audio.AudioRecordDataCallback
import java.nio.ByteBuffer

/**
 * Sends the phone's media playback instead of its microphone.
 *
 * WebRTC's Android audio pipeline is paced by a microphone AudioRecord. This
 * callback runs on every recorded buffer before WebRTC consumes it, and
 * overwrites the microphone samples with audio from an AudioPlaybackCapture
 * recorder (Android 10+) in the same format. Microphone audio is never sent:
 * when playback capture isn't running, the buffer is zeroed.
 */
object ShareAudio : AudioRecordDataCallback {
    private const val TAG = "TandemAudio"

    private var projection: MediaProjection? = null
    private var playbackRecord: AudioRecord? = null
    private var playbackFormat: Triple<Int, Int, Int>? = null
    private var scratch = ByteArray(0)

    /** Starts replacing microphone audio with playback captured through [projection]. */
    @Synchronized
    fun start(projection: MediaProjection) {
        this.projection = projection
    }

    @Synchronized
    fun stop() {
        projection = null
        releasePlaybackRecord()
    }

    @Synchronized
    override fun onAudioDataRecorded(audioFormat: Int, channelCount: Int, sampleRate: Int, buffer: ByteBuffer) {
        val target = buffer.duplicate().apply { clear() }
        val length = target.capacity()
        if (scratch.size < length) scratch = ByteArray(length)

        val record = playbackRecordFor(audioFormat, channelCount, sampleRate)
        // Non-blocking, so a quiet phone (nothing playing) can't stall WebRTC's
        // audio thread; missing samples become silence.
        val read = record?.read(scratch, 0, length, AudioRecord.READ_NON_BLOCKING)?.coerceAtLeast(0) ?: 0
        scratch.fill(0, read, length)
        target.put(scratch, 0, length)
    }

    // Created lazily on the audio thread so it matches the format WebRTC's
    // microphone recorder chose.
    @SuppressLint("MissingPermission") // Only started after RECORD_AUDIO is granted.
    private fun playbackRecordFor(audioFormat: Int, channelCount: Int, sampleRate: Int): AudioRecord? {
        val activeProjection = projection ?: return null
        val format = Triple(audioFormat, channelCount, sampleRate)
        if (playbackRecord != null && playbackFormat == format) return playbackRecord

        releasePlaybackRecord()
        return runCatching {
            val channelMask = if (channelCount == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
            val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelMask, audioFormat)
            val captureConfig = AudioPlaybackCaptureConfiguration.Builder(activeProjection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            AudioRecord.Builder()
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(audioFormat)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minBuffer, scratch.size) * 4)
                .setAudioPlaybackCaptureConfig(captureConfig)
                .build()
                .also {
                    it.startRecording()
                    Log.i(TAG, "Capturing playback audio: $sampleRate Hz, $channelCount ch")
                }
        }.onFailure {
            Log.w(TAG, "Playback audio capture unavailable; sending silence", it)
            // Don't retry on every buffer.
            projection = null
        }.getOrNull().also {
            playbackRecord = it
            playbackFormat = format
        }
    }

    private fun releasePlaybackRecord() {
        playbackRecord?.run {
            runCatching { stop() }
            release()
        }
        playbackRecord = null
        playbackFormat = null
    }
}
