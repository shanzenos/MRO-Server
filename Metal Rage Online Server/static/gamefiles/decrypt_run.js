const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('fs');
const path = require('path');

const basedir = "C:/Users/Sani/Desktop/MetalRage/Data";
const outdir = path.join(__dirname, 'decrypted');

if (!existsSync(outdir)) mkdirSync(outdir);

const names = readFileSync(`${basedir}/System/File.so`, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean);
const seeds = readFileSync(`${basedir}/System/iFile.so`, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean).map(x => parseInt(x));
const keys = readFileSync(path.join(__dirname, 'keys.bin'));

let count = 0;
for (const index in names) {
    const name = names[index];
    const seed = seeds[index];
    const inputPath = `${basedir}/MUD/${name}`;

    try {
        const file = Buffer.from(readFileSync(inputPath));
        for (let i = 0; i < file.length; ++i)
            file[i] ^= keys[(seed * 0x400 + (i % 0x400)) * 4];
        const outName = name.replace('.tzp', '.unr');
        writeFileSync(path.join(outdir, outName), file);
        count++;
        if (count % 50 === 0) process.stdout.write(`\r[${count}/${names.length}] 복호화 중...`);
    } catch (e) {
        // 파일 없으면 건너뜀
    }
}
console.log(`\n완료: ${count}개 파일 복호화 -> decrypted/`);
