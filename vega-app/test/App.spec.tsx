import * as React from 'react';
import {render} from '@testing-library/react-native';
import {App, logWebMessage} from '../src/App';

jest.mock('@amazon-devices/webview', () => ({
  WebView: 'WebView',
}));

jest.mock('@amazon-devices/react-native-kepler', () => ({
  usePreventHideSplashScreen: jest.fn(),
  useHideSplashScreenCallback: jest.fn(() => jest.fn()),
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
