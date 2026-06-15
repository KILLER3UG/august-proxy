const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { dataPath } = require('../../lib/data-paths');

const DEFAULT_MANIFEST_URL = process.env.AUGUST_UPDATE_MANIFEST_URL || 'https://github.com/KILLER3UG/august-proxy/releases/latest/download/august-desktop-manifest.json';
const UPDATE_CACHE_DIR = dataPath('updates');
const INSTALLED_MANIFEST_PATH = dataPath('manifest.json');

function log(message) {
    console.log(`[asset-updater] ${message}`);
}

function warn(message, error) {
    console.warn(`[asset-updater] ${message}${error ? `: ${error.message || error}` : ''}`);
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`manifest request failed: ${response.status} ${response.statusText}`);
    return response.json();
}

async function downloadFile(url, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText} ${url}`);
    if (!response.body) throw new Error(`download response has no body: ${url}`);

    const stream = fs.createWriteStream(destination);
    await new Promise((resolve, reject) => {
        response.body.pipe(stream);
        stream.on('finish', resolve);
        stream.on('error', reject);
        response.body.on('error', reject);
    });
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: options.stdio || 'pipe',
            shell: options.shell || false,
            env: { ...process.env, ...(options.env || {}) }
        });
        let stdout = '';
        let stderr = '';
        if (!options.silent) {
            child.stdout?.on('data', chunk => { stdout += chunk.toString(); process.stdout.write(chunk); });
            child.stderr?.on('data', chunk => { stderr += chunk.toString(); process.stderr.write(chunk); });
        } else {
            child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
            child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
        }
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stderr}`));
        });
    });
}

async function extractZip(zipPath, destination) {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });

    if (process.platform === 'win32') {
        await run('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `Expand-Archive -Path "${zipPath.replace(/"/g, '`"')}" -DestinationPath "${destination.replace(/"/g, '`"')}" -Force`
        ], { shell: true, silent: true });
        return;
    }

    const unzip = await new Promise(resolve => {
        const child = spawn('sh', ['-lc', 'command -v unzip || command -v 7z || true']);
        child.stdout.on('data', chunk => resolve(chunk.toString().trim()));
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(''));
    });

    if (unzip.includes('unzip')) {
        await run('unzip', ['-q', zipPath, '-d', destination], { silent: true });
        return;
    }

    if (unzip.includes('7z')) {
        await run('7z', ['x', zipPath, `-o${destination}`, '-y'], { silent: true });
        return;
    }

    throw new Error('no zip extractor found; install unzip or 7z for asset updates');
}

function normalizeAsset(asset, name) {
    if (!asset || !asset.url || !asset.sha256) {
        throw new Error(`manifest is missing ${name}.url or ${name}.sha256`);
    }
    return {
        url: asset.url,
        sha256: asset.sha256.toLowerCase(),
        path: asset.path || name
    };
}

function getAssets(manifest) {
    if (manifest.assets) {
        return {
            web: normalizeAsset(manifest.assets.web, 'web'),
            backend: normalizeAsset(manifest.assets.backend, 'backend')
        };
    }

    return {
        web: normalizeAsset(manifest.web, 'web'),
        backend: normalizeAsset(manifest.backend, 'backend')
    };
}

async function verifyAsset(zipPath, expectedSha256, name) {
    const actual = await sha256File(zipPath);
    if (actual !== expectedSha256) {
        throw new Error(`${name} sha256 mismatch: expected ${expectedSha256}, got ${actual}`);
    }
}

function removeDir(pathToRemove) {
    try {
        fs.rmSync(pathToRemove, { recursive: true, force: true });
    } catch (error) {
        warn(`failed to remove ${pathToRemove}`, error);
    }
}

async function applyAsset(asset, name, manifestVersion, cacheDir) {
    const zipPath = path.join(cacheDir, `${name}-${manifestVersion}.zip`);
    const extractDir = path.join(cacheDir, `${name}-${manifestVersion}`);
    const targetDir = dataPath(asset.path);
    const oldDir = path.join(path.dirname(targetDir), `${asset.path}.old-${Date.now()}`);

    log(`downloading ${name} update from ${asset.url}`);
    await downloadFile(asset.url, zipPath);
    await verifyAsset(zipPath, asset.sha256, name);

    log(`extracting ${name} update`);
    await extractZip(zipPath, extractDir);

    const extractedRoot = path.join(extractDir, asset.path);
    if (!fs.existsSync(extractedRoot)) {
        throw new Error(`${name} zip did not contain ${asset.path}/`);
    }

    if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, oldDir);
    }
    fs.renameSync(extractedRoot, targetDir);
    removeDir(extractDir);
    removeDir(oldDir);

    log(`${name} updated to ${manifestVersion}`);
}

async function checkForUpdates(options = {}) {
    const manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
    const manifest = await fetchJson(manifestUrl);
    const assets = getAssets(manifest);
    const installed = fs.existsSync(INSTALLED_MANIFEST_PATH)
        ? JSON.parse(fs.readFileSync(INSTALLED_MANIFEST_PATH, 'utf8'))
        : { version: null };

    if (installed.version === manifest.version) {
        log(`already on manifest ${manifest.version}`);
        return { applied: false, version: manifest.version };
    }

    const cacheDir = path.join(UPDATE_CACHE_DIR, manifest.version);
    fs.mkdirSync(cacheDir, { recursive: true });

    await applyAsset(assets.web, 'web', manifest.version, cacheDir);
    await applyAsset(assets.backend, 'backend', manifest.version, cacheDir);

    fs.writeFileSync(INSTALLED_MANIFEST_PATH, JSON.stringify({
        version: manifest.version,
        updatedAt: new Date().toISOString()
    }, null, 2));

    log(`installed manifest ${manifest.version}`);
    return { applied: true, version: manifest.version };
}

module.exports = {
    DEFAULT_MANIFEST_URL,
    checkForUpdates
};

if (require.main === module) {
    checkForUpdates()
        .then(result => {
            console.log(JSON.stringify(result, null, 2));
            if (result.applied) process.exit(2);
        })
        .catch(error => {
            warn('update check failed', error);
            process.exit(1);
        });
}
