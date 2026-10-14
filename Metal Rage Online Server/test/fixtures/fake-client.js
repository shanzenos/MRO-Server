function assertFrame(data) { if (data.length > 1024) throw new Error('Oversized client packet'); }

const MSG_HEADER_SIZE = 0x10;

function getMessageBuffer(type, size) {
    return require('../../client').prototype.getMessageBuffer.call({ sndbuf_: Buffer.alloc(4096) }, type, size);
}

function makeFakeClient(connId, port)
{
    const sent = [];

    const client = {
        connId_: connId,
        socket_: {
            localPort: port, remoteAddress: '127.0.0.1', remotePort: 0,

            destroy() { client.destroyed_ = true; },
        },

        getMessageBuffer,

        send(data)
        {
            if (data.length < MSG_HEADER_SIZE)
                throw new Error(`fake-client: send() called with a buffer shorter than the header (${data.length} bytes)`);

            assertFrame(data);
            const op = data.readUInt32BE(0xC);
            const body = data.subarray(MSG_HEADER_SIZE);
            sent.push({
                op: '0x' + (op >>> 0).toString(16).padStart(8, '0'),
                len: body.length,
                hex: Buffer.from(body).toString('hex'),
            });
        },

        disconnect()
        {
            client.disconnected_ = true;
        },

        _sent: sent,
    };

    return client;
}

module.exports = { makeFakeClient, getMessageBuffer, MSG_HEADER_SIZE };
