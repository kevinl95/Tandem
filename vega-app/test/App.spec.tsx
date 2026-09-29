import * as React from 'react';
import {render} from '@testing-library/react-native';
import {App, BACK_SCRIPT, appStateScript, logWebMessage} from '../src/App';

jest.mock('@amazon-devices/webview', () => ({
  WebView: 'WebView',
}));

jest.mock('@amazon-devices/react-native-kepler', () => ({
  usePreventHideSplashScreen: jest.fn(),
  useHideSplashScreenCallback: jest.fn(() => jest.fn()),
  useKeplerAppStateManager: jest.fn(() => ({
    addAppStateListener: jest.fn(() => ({remove: jest.fn()})),
  })),
  useKeplerBackHandler: jest.fn(() => ({
    addEventListener: jest.fn(() => ({remove: jest.fn()})),
    exitApp: jest.fn(),
  })),
  StyleSheet: {create: (styles: unknown) => styles},
  View: 'View',
}));

describe('App', () => {
  it('renders without crashing', () => {
    const {toJSON} = render(<App />);
    expect(toJSON()).toBeTruthy();
  });
});

describe('logWebMessage', () => {
  it('tags JSON messages with their type', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    logWebMessage('{"type":"probe-report","report":{}}');
    expect(info).toHaveBeenCalledWith(
      '[tandem] probe-report: {"type":"probe-report","report":{}}',
    );
    info.mockRestore();
  });

  it('logs non-JSON messages as-is', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    logWebMessage('hello');
    expect(info).toHaveBeenCalledWith('[tandem] message: hello');
    info.mockRestore();
  });
});

describe('appStateScript', () => {
  it('tells the page when the app leaves and returns to the screen', () => {
    expect(appStateScript('background')).toContain('onBackground()');
    expect(appStateScript('active')).toContain('onForeground()');
    expect(appStateScript('inactive')).toBeUndefined();
  });
});

describe('logWebMessage return value', () => {
  it('returns the message type for the shell to act on', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    expect(logWebMessage('{"type":"exit-app"}')).toBe('exit-app');
    expect(logWebMessage('not json')).toBeUndefined();
    info.mockRestore();
  });
});

// Jest runs on Node; this project has no Node typings, so type the one call used.
const vm: {runInNewContext: (code: string, context: object) => unknown} = require('vm');

describe('BACK_SCRIPT', () => {
  const runBack = (context: Record<string, unknown>) =>
    vm.runInNewContext(BACK_SCRIPT, {history: {length: 1, back: jest.fn()}, ...context});

  it('lets the receiver page decide what Back does', () => {
    const handleBack = jest.fn();
    runBack({window: {tandemHost: {handleBack}}});
    expect(handleBack).toHaveBeenCalled();
  });

  it('goes back in history on pages without the hook', () => {
    const back = jest.fn();
    runBack({history: {length: 2, back}, window: {}});
    expect(back).toHaveBeenCalled();
  });

  it('asks the shell to exit when there is nowhere to go back to', () => {
    const postMessage = jest.fn();
    runBack({window: {ReactNativeWebView: {postMessage}}});
    expect(postMessage).toHaveBeenCalledWith('{"type":"exit-app"}');
  });
});
