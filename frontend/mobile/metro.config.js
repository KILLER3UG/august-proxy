// Monorepo Metro setup for the standalone (CNG) Android build.
//
// Expo derives the Metro *server root* from the nearest package.json that
// declares `workspaces` — the repo root here — and the release bundler is
// handed `--entry-file index.ts` as a path relative to that server root, so
// it asks Metro for `<repo>/index.ts`, which does not exist. Pinning the
// server root to this directory makes the entry resolve to
// `frontend/mobile/index.ts`; the hoisted dependencies stay reachable through
// `watchFolders` + `nodeModulesPaths` because `expo` is installed at the root.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];
config.server.unstable_serverRoot = projectRoot;

// `react` exists twice in this workspace: 19.1.0 under this app (what
// package.json pins) and 19.2.7 at the root (what the desktop uses). Metro's
// hierarchical lookup resolves `react` from wherever the requiring file lives,
// so `index.ts` gets one copy and `react-native` the other and the bundle
// ships both — the second copy's hook dispatcher is never initialised, so the
// app dies at launch with "TypeError: Cannot read property useRef of null".
// Turning the walk off is what forces every importer through
// `nodeModulesPaths` above, where this app's own copy wins for all of them;
// `extraNodeModules` cannot do it, because it is only a fallback for names the
// hierarchical walk misses.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
