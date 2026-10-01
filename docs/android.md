# Android sender

`android-sender` is a Kotlin app that lists TVs on the Wi-Fi and shares the screen through a `mediaProjection` foreground service. It runs on Android 5.1 (API 22) and newer, which covers Fire tablets back to Fire OS 5, and it doesn't need Google Play. The build bakes in the signaling endpoint from `tandem.config.json`. It needs a full JDK 17 or newer (a JRE isn't enough) and the Android SDK.

```bash
cd android-sender
JAVA_HOME=/path/to/jdk-21 ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Release signing

`./gradlew assembleRelease` signs with a key kept outside the repo. `~/.gradle/gradle.properties` sets `tandem.keystore.file`, `tandem.keystore.password`, `tandem.key.alias` and `tandem.key.password`. Back up the keystore and its password together: app updates must be signed with the same key. Android won't install a build signed with a different key over an existing install, so switching between debug and release builds means uninstalling first.

## Video

- **Capture size:** 1920 px on the long edge at 30 fps. Devices under 2 GB of RAM, or marked low-RAM, use 1280 px at 24 fps. Capture sizes are multiples of 16, since some older encoders scramble other sizes.
- **Compatibility mode** encodes in software (VP8) at 960 px and 24 fps instead of using the hardware encoder. On a 2016 Fire tablet (Fire OS 5), the hardware encoder produced corrupt frames, seen on the TV as horizontal lines. Compatibility mode is on by default for Android 7.1 and older and for devices under 2 GB of RAM, and the checkbox in the app overrides the default.

## Audio

On Android 10 and later, the app sends the device's media playback using Android playback capture. Older devices share video only. Calls, notifications and apps that opt out of capture (typically DRM streaming apps) aren't included.

WebRTC's Android audio pipeline is paced by a microphone recorder, so the app needs the microphone permission and shows the mic indicator while sharing. It overwrites every recorded buffer with playback audio or silence, so microphone audio is never sent. If the permission is denied, sharing continues video-only.

This relies on `stream-webrtc-android` 1.1.3; later releases no longer call the record-data callback. The trade-off is that 1.1.3's arm64 native library isn't aligned for 16 KB memory pages, so it may fail to load on newer Android 15+ phones that use them, and Android 17 shows a warning for debug builds.

## VPNs

A phone on a VPN reaches AWS from the VPN's IP, so TVs on its Wi-Fi aren't listed (enter the code instead). An always-on VPN that blocks non-VPN traffic also blocks the direct LAN connection to the TV, and the share fails. Allow local network (LAN) access in the VPN app, or exclude Tandem from the tunnel. The app shows a hint when a VPN is active.

## Diagnosing problems

- **Connection details:** "Show connection details" in the app, while sharing, shows the capture size, codec and encoder.
- **Crashes:** if the app crashes with a Java error, the next launch shows the stack trace on screen, since old tablets often can't be debugged over USB.
- **TV-side stats:** the Fire TV app logs incoming video stats every 10 seconds during a share, so `vega device start-log-stream` shows whether a sender's stream decodes cleanly. Rising keyframe requests (`pliCount`) with few decoded frames point to a broken encoder.
