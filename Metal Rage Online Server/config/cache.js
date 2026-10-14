const fs = require('fs');
const path = require('path');
const { load } = require('./server');

function findCacheBinPath()
{
    const configured = load().cachePath;
    if (configured) {
        let filename = path.resolve(__dirname, '..', configured);
        if (fs.existsSync(filename) && fs.statSync(filename).isDirectory()) filename = path.join(filename, 'Cache.Bin');
        if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
            throw new Error(`cachePath does not point to Cache.Bin or its containing directory: ${filename}`);
        }
        return filename;
    }
    const local = path.join(__dirname, '..', 'static', 'Cache.Bin');
    if (fs.existsSync(local)) return local;
    for (const start of [__dirname, process.cwd()]) {
        let dir = start;
        while (true) {
            const candidate = path.join(dir, 'MetalRage', 'Data', 'System', 'Cache.Bin');
            if (fs.existsSync(candidate)) return candidate;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new Error('Set cachePath in config/server.json to the game client Cache.Bin');
}

module.exports = { findCacheBinPath };
