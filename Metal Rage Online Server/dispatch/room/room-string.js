

const ROOM_STRING_MAX_CHARS = 25;

function toSafeAscii(value) {
    const source = String(value ?? '');
    let result = '';
    for (const character of source) {
        if (result.length >= ROOM_STRING_MAX_CHARS) break;
        const codePoint = character.codePointAt(0);
        result += codePoint <= 0x7F ? character : '?';
    }
    return result;
}

function decodeAnsiBytes(buffer) {
    const encoding = 'latin1';
    return buffer.toString(encoding).split('\0').shift();
}

function decodeBig5ForLog(value) {

    try {
        const bytes = Buffer.from(String(value ?? ''), 'latin1');
        return new TextDecoder('big5', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

function writeAnsiStringField(buffer, value, offset, fieldSize) {
    buffer.fill(0, offset, offset + fieldSize);
    {

        const raw = String(value ?? '');
        const maxBytes = Math.max(0, fieldSize - 1);
        const byteLen = Math.min(raw.length, maxBytes);
        buffer.write(raw, offset, byteLen, 'latin1');
        return;
    }

}

function toRoomNameWireBytes(value, maxBytes) {
    {
        const raw = String(value ?? '');
        const text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
        return { text, encoding: 'latin1' };
    }

}

module.exports = { writeAnsiStringField, toSafeAscii, decodeAnsiBytes, decodeBig5ForLog, toRoomNameWireBytes };
