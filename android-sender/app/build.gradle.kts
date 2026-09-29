import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// The signaling endpoint written by `npm run deploy:signaling`; override with
// -Ptandem.signalingEndpoint=wss://...
val signalingEndpoint: String = providers.gradleProperty("tandem.signalingEndpoint").orNull
    ?: rootProject.file("../tandem.config.json").takeIf { it.exists() }?.let { file ->
        @Suppress("UNCHECKED_CAST")
        (JsonSlurper().parse(file) as Map<String, Any?>)["signalingEndpoint"] as String?
    }
    ?: ""

android {
    namespace = "com.kloeffler.tandem.sender"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kloeffler.tandem.sender"
        // Android 5.1 (Fire OS 5), so Fire tablets that can't send Miracast
        // can share. Playback audio capture needs Android 10, so older
        // devices share video only.
        minSdk = 22
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "SIGNALING_ENDPOINT", "\"$signalingEndpoint\"")
        // Phones only; the WebRTC native libraries dominate the APK size.
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // 1.1.3 is the newest release whose AudioRecordDataCallback runs before
    // recorded audio reaches WebRTC; later releases accept the callback but
    // never call it. ShareAudio relies on it to send phone playback audio.
    implementation("io.getstream:stream-webrtc-android:1.1.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
