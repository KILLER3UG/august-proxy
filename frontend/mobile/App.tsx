import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import WebView from 'react-native-webview';
import { parsePairingInput, tokenBootstrapScript } from './pairing';

// Follow the desktop backend's port when overridden at build time
// (EXPO_PUBLIC_PROXY_PORT, e.g. to match HARNESS_PROXY_PORT); default 8085.
const PROXY_PORT = process.env.EXPO_PUBLIC_PROXY_PORT || '8085';

const MOBILE_WEB_BOOTSTRAP = `
(function () {
  document.documentElement.dataset.augustMobileShell = 'true';

  var viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) {
    viewport = document.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    document.head.appendChild(viewport);
  }
  viewport.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');

  var style = document.createElement('style');
  style.textContent = [
    ':root { color-scheme: light dark; }',
    /* Kill browser behaviors that fight a chat surface. */
    'html, body { overscroll-behavior: none; -webkit-overflow-scrolling: touch; }',
    'body { -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }',
    'input, textarea, [contenteditable] { -webkit-user-select: text; user-select: text; }',
    '* { touch-action: manipulation; -webkit-user-drag: none; }',
    'html[data-august-mobile-shell="true"] body { -webkit-font-smoothing: antialiased; }',
    /* Text entry keeps 16px so iOS does not zoom on focus. */
    'html[data-august-mobile-shell="true"] input, html[data-august-mobile-shell="true"] textarea, html[data-august-mobile-shell="true"] select { font-size: 16px !important; }',
    /* Phone-width guards: long code/links must wrap, never scroll sideways. */
    'html[data-august-mobile-shell="true"] pre, html[data-august-mobile-shell="true"] code { max-width: 100% !important; white-space: pre-wrap !important; word-break: break-word !important; }',
    'html[data-august-mobile-shell="true"] .overflow-x-auto { max-width: 100% !important; min-width: 0 !important; }',
    'html[data-august-mobile-shell="true"] .august-drawer { max-width: 100vw !important; }',
    /* The dashboard-era selectors (.dashboard-shell, .bottom-nav, .period-btn,
       button[onclick="loadModels()"], #voicePanel, and the purple de-branding
       set) matched NOTHING since the desktop moved to React in June — they
       were silently dead. The de-branding itself is now unnecessary: the
       desktop tokenized those colors in phase 3. */
  ].join('
');
  document.head.appendChild(style);

  // Theme bridge: the native chrome follows the WEB app's resolved theme,
  // not the OS setting, so shell and content can never disagree.
  function postTheme() {
    try {
      var dark = document.documentElement.classList.contains('dark');
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'august-theme', dark: dark })
        );
      }
    } catch (e) { /* not in a WebView host */ }
  }
  postTheme();
  new MutationObserver(postTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });

})();
true;
`;

type ShellColors = {
  background: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  muted: string;
  subtle: string;
  border: string;
  button: string;
  buttonText: string;
  danger: string;
};

function getShellColors(isDark: boolean): ShellColors {
  if (isDark) {
    return {
      background: '#0f0f0f',
      surface: '#171717',
      surfaceMuted: '#202020',
      text: '#f4f4f5',
      muted: '#a1a1aa',
      subtle: '#71717a',
      border: '#2f2f31',
      button: '#f4f4f5',
      buttonText: '#111111',
      danger: '#fca5a5',
    };
  }

  return {
    background: '#f7f7f5',
    surface: '#ffffff',
    surfaceMuted: '#ededeb',
    text: '#18181b',
    muted: '#52525b',
    subtle: '#71717a',
    border: '#dededb',
    button: '#18181b',
    buttonText: '#ffffff',
    danger: '#b91c1c',
  };
}

function normalizeProxyUrl(value: string): string {
  const clean = value.trim().replace(/\/+$/, '');
  if (!clean) return getDefaultProxyUrl();
  if (/^https?:\/\//i.test(clean)) return clean;
  return `http://${clean}`;
}

function getDefaultProxyUrl(): string {
  const constants = Constants as unknown as {
    expoConfig?: { hostUri?: string };
    manifest?: { debuggerHost?: string; hostUri?: string };
    manifest2?: { extra?: { expoClient?: { hostUri?: string } } };
  };
  const hostUri =
    constants.expoConfig?.hostUri ||
    constants.manifest?.hostUri ||
    constants.manifest?.debuggerHost ||
    constants.manifest2?.extra?.expoClient?.hostUri;
  const host = hostUri?.replace(/^https?:\/\//i, '').split(':')[0];

  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    return `http://${host}:${PROXY_PORT}`;
  }

  if (Platform.OS === 'android') {
    return `http://10.0.2.2:${PROXY_PORT}`;
  }

  return `http://localhost:${PROXY_PORT}`;
}

export default function App() {
  const webViewRef = useRef<WebView>(null);
  // The native chrome follows the WEB app's resolved theme (it posts
  // {type:'august-theme'}) and only falls back to the OS setting before the
  // first message — the two used to disagree whenever the user picked a
  // theme in the app that differed from their phone.
  const osDark = useColorScheme() === 'dark';
  const [webTheme, setWebTheme] = useState<boolean | null>(null);
  const isDark = webTheme ?? osDark;
  const colors = useMemo(() => getShellColors(isDark), [isDark]);
  const [proxyUrl, setProxyUrl] = useState(() =>
    normalizeProxyUrl(process.env.EXPO_PUBLIC_PROXY_URL || getDefaultProxyUrl()),
  );
  const [draftUrl, setDraftUrl] = useState(proxyUrl);
  // The per-install token the backend's sensitive local routes require.
  //
  // It is held in MEMORY ONLY. `expo-secure-store` is not a dependency of
  // this package, and the repo forbids a dependency change without the
  // owner, so there is no secure store to put it in: the token lives in
  // this one state variable for the lifetime of the process and is gone
  // when the app is killed. Re-pairing after a restart is the price, and
  // it is the price the "no dependency without the owner" rule buys.
  const [localToken, setLocalToken] = useState<string | null>(null);
  const [draftToken, setDraftToken] = useState('');
  const [showConnect, setShowConnect] = useState(false);
  const [webViewKey, setWebViewKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The address field accepts a PAIRING URL as well as a plain address.
  // When the pasted text carries a token, take it out of the address and
  // show it in the token field — the URL the WebView loads never has the
  // token in it.
  const onDraftUrlChange = (value: string) => {
    setDraftUrl(value);
    const parsed = parsePairingInput(value);
    if (parsed.token) setDraftToken(parsed.token);
  };

  const reload = () => {
    const parsed = parsePairingInput(draftUrl);
    const nextUrl = normalizeProxyUrl(parsed.baseUrl || draftUrl);
    const nextToken = (draftToken.trim() || parsed.token || '').trim() || null;
    setProxyUrl(nextUrl);
    setDraftUrl(nextUrl);
    setLocalToken(nextToken);
    setDraftToken(nextToken ?? '');
    setLoadError(null);
    setShowConnect(false);
    setIsLoading(true);
    // Remount rather than reload: the token is published by
    // `injectedJavaScriptBeforeContentLoaded`, which only runs on a fresh
    // document load, and a change of token has to reach the page.
    setWebViewKey((key) => key + 1);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: 'padding', default: undefined })}
      style={[styles.root, { backgroundColor: colors.background }]}
    >
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <View style={[styles.statusBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <View style={[styles.statusDot, { backgroundColor: localToken ? colors.button : colors.subtle }]} />
        <Text style={[styles.statusText, { color: colors.muted }]} numberOfLines={1}>
          {proxyUrl.replace(/^https?:\/\//, '')} · {localToken ? 'paired' : 'not paired'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Pair with August"
          onPress={() => setShowConnect(true)}
          style={[styles.statusButton, { borderColor: colors.border }]}
        >
          <Text style={[styles.statusButtonText, { color: colors.text }]}>{localToken ? 'Pairing' : 'Pair'}</Text>
        </Pressable>
      </View>
      <WebView
        key={`${proxyUrl}-${webViewKey}`}
        ref={webViewRef}
        source={{ uri: proxyUrl }}
        style={[styles.webview, { backgroundColor: colors.background }]}
        containerStyle={styles.webviewContainer}
        originWhitelist={['http://*', 'https://*']}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled={false}
        setSupportMultipleWindows={false}
        applicationNameForUserAgent="AugustProxyMobile"
        injectedJavaScriptBeforeContentLoaded={`${MOBILE_WEB_BOOTSTRAP}
${tokenBootstrapScript(localToken)}`}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        accessibilityLabel="August Proxy"
        onMessage={(event) => {
          try {
            const msg = JSON.parse(event.nativeEvent.data) as { type?: string; dark?: boolean };
            if (msg?.type === 'august-theme' && typeof msg.dark === 'boolean') {
              setWebTheme(msg.dark);
            }
          } catch {
            /* not one of ours */
          }
        }}
        onLoadStart={() => {
          setIsLoading(true);
          setLoadError(null);
        }}
        onLoadEnd={() => setIsLoading(false)}
        onError={(event) => {
          setIsLoading(false);
          setLoadError(event.nativeEvent.description || 'Unable to load August Proxy.');
        }}
        onHttpError={(event) => {
          if (event.nativeEvent.statusCode >= 500) {
            setLoadError(`HTTP ${event.nativeEvent.statusCode}`);
          }
        }}
      />

      {isLoading && !loadError ? (
        <View pointerEvents="none" style={styles.loadingOverlay}>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Connecting to August Proxy"
            style={[styles.loadingPill, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <ActivityIndicator color={colors.text} />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Connecting</Text>
          </View>
        </View>
      ) : null}

      {showConnect || loadError ? (
        <View accessibilityRole="alert" style={[styles.fallback, { backgroundColor: colors.background }]}>
          <View style={[styles.fallbackCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.eyebrow, { color: colors.subtle }]}>AUGUST PROXY</Text>
            <Text style={[styles.title, { color: colors.text }]}>
              {loadError ? 'Connect to the web app' : 'Pair with August'}
            </Text>
            <Text style={[styles.body, { color: colors.muted }]}>
              {loadError
                ? 'Mobile now runs the same dashboard and Workbench as the browser. Start the proxy, confirm the URL, then reconnect.'
                : 'Paste the pairing URL from Settings → Phone pairing on the desktop, or type the address and the token separately. The token is read out of the URL and the URL is cleaned.'}
            </Text>
            <TextInput
              value={draftUrl}
              onChangeText={onDraftUrlChange}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="August Proxy address"
              placeholder="http://192.168.1.10:8085"
              placeholderTextColor={colors.subtle}
              style={[
                styles.input,
                {
                  backgroundColor: colors.surfaceMuted,
                  borderColor: colors.border,
                  color: colors.text,
                },
              ]}
              onSubmitEditing={reload}
            />
            <TextInput
              value={draftToken}
              onChangeText={setDraftToken}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              accessibilityLabel="August Proxy local token"
              placeholder="local token (optional)"
              placeholderTextColor={colors.subtle}
              style={[
                styles.input,
                {
                  backgroundColor: colors.surfaceMuted,
                  borderColor: colors.border,
                  color: colors.text,
                },
              ]}
            />
            <Text style={[styles.hint, { color: colors.subtle }]}>
              The token is kept in memory only — this app has no secure store, so re-pair after it restarts. A backend
              started without a token needs none at all.
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setDraftUrl(proxyUrl);
                  setDraftToken(localToken ?? '');
                  webViewRef.current?.reload();
                  setLoadError(null);
                  setIsLoading(true);
                }}
                style={[styles.secondaryButton, { borderColor: colors.border }]}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Reload</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={reload}
                style={[styles.primaryButton, { backgroundColor: colors.button }]}
              >
                <Text style={[styles.primaryButtonText, { color: colors.buttonText }]}>Connect</Text>
              </Pressable>
            </View>
            {loadError ? (
              <Text style={[styles.error, { color: colors.danger }]} numberOfLines={3}>
                {loadError}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  statusBar: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  statusText: {
    flex: 1,
    fontSize: 12,
  },
  statusButton: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  webviewContainer: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingPill: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  loadingText: {
    fontSize: 13,
    fontWeight: '600',
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  fallbackCard: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 420,
    padding: 20,
    width: '100%',
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0,
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 30,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  input: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
    marginTop: 18,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 12,
    flex: 1,
    paddingVertical: 12,
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  error: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 12,
  },
});
