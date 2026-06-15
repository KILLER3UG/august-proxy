const fs = require('fs');
const path = require('path');

function getDataDir() {
    return path.resolve(process.env.AUGUST_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
}

function ensureDataDir() {
    const dir = getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function dataPath(...parts) {
    return path.join(ensureDataDir(), ...parts);
}

module.exports = {
    dataPath,
    ensureDataDir,
    getDataDir,
};
