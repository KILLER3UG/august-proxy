// Write `android:usesCleartextTraffic` into the generated manifest.
//
// August's pairing contract is `http://<lan-address>:<port>` — the local
// backend has no certificate — so a WebView that refuses cleartext cannot
// reach it at all. `app.json` has carried `android.usesCleartextTraffic: true`
// since this package existed, but `@expo/prebuild-config` (SDK 54) never reads
// that key: grepping its build output for the string returns nothing, and the
// `<application>` tag a prebuild produces has no cleartext attribute. The
// field is decorative, and the installed app fails with
// `net::ERR_CLEARTEXT_NOT_PERMITTED` while Expo Go — whose own manifest allows
// cleartext — works, which is what hides it.
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:usesCleartextTraffic'] = 'true';
    }
    return cfg;
  });
};
