import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useEffect, useRef} from 'react';
import {View, StyleSheet} from 'react-native';
import {
  useHideSplashScreenCallback,
  useKeplerAppStateManager,
  useKeplerBackHandler,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import {
  SslErrorData,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigationEvent,
} from '@amazon-devices/webview/dist/types/WebViewTypes';

// Pages post JSON strings through window.ReactNativeWebView.postMessage. Log
// them so results (e.g. the WebRTC probe report) show up in device logs, and
// return the message type so the shell can act on it.
export const logWebMessage = (data: string): string | undefined => {
  try {
    const message = JSON.parse(data);
    console.info(`[tandem] ${message.type ?? 'message'}: ${data}`);
    return message.type;
  } catch {
    console.info(`[tandem] message: ${data}`);
    return undefined;
  }
};

// The receiver page exposes window.tandemHost; tell it when the app leaves or
// returns to the screen so it can end shares and disconnect meanwhile.
export const appStateScript = (state: string): string | undefined => {
  if (state === 'background') {
    return 'window.tandemHost && window.tandemHost.onBackground(); true;';
  }
  if (state === 'active') {
    return 'window.tandemHost && window.tandemHost.onForeground(); true;';
  }
  return undefined;
};

// Back is owned by the shell: Vega delivers it natively, not to the page. The
// page decides what Back means (close a dialog, end a share, or exit); pages
// without the hook (diagnostics) go back in history, else the app exits.
export const BACK_SCRIPT = [
  'if (window.tandemHost) { window.tandemHost.handleBack(); }',
  'else if (history.length > 1) { history.back(); }',
  "else if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage('{\"type\":\"exit-app\"}'); }",
  'true;',
].join(' ');

export const App = () => {
  const webRef = useRef<React.ElementRef<typeof WebView>>(null);
  const backHandler = useKeplerBackHandler();
  const appStateManager = useKeplerAppStateManager();

  useEffect(() => {
    const subscription = appStateManager.addAppStateListener('change', state => {
      console.info(`[tandem] app state: ${String(state)}`);
      const script = appStateScript(String(state));
      if (script) {
        webRef.current?.injectJavaScript(script);
      }
    });
    return () => subscription.remove();
  }, [appStateManager]);

  useEffect(() => {
    const subscription = backHandler.addEventListener('backPress', () => {
      webRef.current?.injectJavaScript(BACK_SCRIPT);
      // Consumed: the page exits the app itself when Back has nothing to close.
      return true;
    });
    return () => subscription.remove();
  }, [backHandler]);

  // By default splash screen is shown in app launch, as the splash
  // screen images are bundled in this app (assets/raw/ folder)
  // Declare that application wants to extend splash screen lifecycle
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();
  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        style={styles.webview}
        allowSystemKeyEvents
        allowsDefaultMediaControl
        domStorageEnabled
        hasTVPreferredFocus
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="compatibility"
        // thirdPartyCookiesEnabled
        // userAgent={''}
        source={{
          // headers: {},
          uri: "file:///pkg/assets/index.html",
        }}
        onLoad={(_event: WebViewNavigationEvent) => {
          console.info('Page loading completed...');
          // Hide the splash screen
          hideSplashScreenCallback();
        }}
        onMessage={(event: WebViewMessageEvent) => {
          if (logWebMessage(event.nativeEvent.data) === 'exit-app') {
            backHandler.exitApp();
          }
        }}
        onLoadStart={(_event: WebViewNavigationEvent) => {
          console.info('Page loading started...');
        }}
        onError={({
          nativeEvent: {code, url, description},
        }: WebViewErrorEvent) => {
          console.error(`[onError]: (${code}: ${url}) ${description}`);
        }}
        onHttpError={({
          nativeEvent: {url, statusCode: code, description, isMainFrame},
        }: WebViewHttpErrorEvent) => {
          console.error(`[onHttpError]: (${code}: ${url}) ${description}`);
          console.error(`[onHttpError]: isMainFrame: ${isMainFrame}`);
        }}
        onSslError={({code, url, description}: SslErrorData) => {
          console.error(`[onSslError]: (${code}: ${url}) ${description}`);
        }}
      />
    </View>
  );
};

// Styles for layout, which are necessary for proper focus behavior
const styles = StyleSheet.create({
  container: {flex: 1},
  webview: {backgroundColor: '#000000'},
});
