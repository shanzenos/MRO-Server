const fs = require('fs');
const path = require('path');

const GAMEFILES_DIR = path.join(__dirname, '..', 'static', 'gamefiles');

class GameFilesError extends Error {}

function isFile(filename)
{
    try {
        return fs.statSync(filename).isFile();
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw err;
    }
}

function findCacheBinPath(gamefilesDir = GAMEFILES_DIR)
{
    for (const name of ['Cache.Bin', 'cache.bin']) {
        const filename = path.join(gamefilesDir, name);
        if (isFile(filename)) return filename;
    }
    throw new GameFilesError(`Cache.Bin is missing from ${gamefilesDir}`);
}

function checkGameFiles(gamefilesDir = GAMEFILES_DIR)
{
    const missing = [];
    const decrypted = path.join(gamefilesDir, 'decrypted');
    let entries;
    try {
        entries = fs.readdirSync(decrypted);
    } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        entries = [];
    }
    if (!entries.some(name => /\.unr$/i.test(name) && isFile(path.join(decrypted, name)))) {
        missing.push(`${decrypted} (must contain game .unr assets)`);
    }
    const keys = path.join(gamefilesDir, 'keys.bin');
    if (!isFile(keys)) missing.push(keys);
    try {
        findCacheBinPath(gamefilesDir);
    } catch (err) {
        if (!(err instanceof GameFilesError)) throw err;
        missing.push(path.join(gamefilesDir, 'Cache.Bin'));
    }
    if (missing.length) {
        throw new GameFilesError(`Missing gamefiles server asset data:\n  ${missing.join('\n  ')}\nAdd these files to the static/gamefiles directory before starting the server.`);
    }
}

module.exports = { GameFilesError, checkGameFiles, findCacheBinPath };
