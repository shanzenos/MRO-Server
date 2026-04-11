const { readFileSync, writeFileSync } = require('fs');


const basedir = "Z:/games/MetalRage Online/data";

const names = readFileSync(`${basedir}/System/File.so`, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean);
const seeds = readFileSync(`${basedir}/System/iFile.so`, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean).map(x => parseInt(x));
const keys = readFileSync('keys.bin');


for (const index in names) {
    const name = names[index];
    const seed = seeds[index];

    const file = readFileSync(`${basedir}/MUD/${name}`);
    for (let i = 0; i < file.length; ++i) 
        file[i] ^= keys[(seed * 0x400 + (i % 0x400)) * 4];

    writeFileSync('./out/' + name.replace('.tzp', '.unr'), file);
}