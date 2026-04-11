const crypto = require('crypto');
const { Socket } = require('net');
const { pack, unpack, peekLength } = require('./message.js');

const MSG_HEADER_SIZE = 0x10;
const MSG_DEFAULT_SALT = 0xf0f00f0f;
const MSG_MAX_SIZE = 0x400;

const MSG_HANDSHAKE = 0x00020080;
const MSG_HANDSHAKE_RESPONSE = 0x00020081;
const MSG_TIME_SYNC = 0x00020082;
const MSG_KEEP_ALIVE = 0x00020083;
const MSG_ACKNOWLEDGE = 0x00020084;

module.exports = 
class NetworkClient 
{
    /**
     * Creates a network client from a socket and dispatch callback
     * @param {Socket} socket - The network socket associated with this client
     * @param {DispatchCallback} callback - The callback triggered when a message is received
     */
    constructor(socket, callback)
    {
        /** @private @const {Socket} - The socket associated with this client */
        this.socket_ = socket;

        /** @private @const {Buffer} - Reserved buffer for network messages */
        this.sndbuf_ = Buffer.alloc(MSG_MAX_SIZE);

        /** @private {number} - XOR cipher key used for encrypting/decrypting messages */
        this.salt_ = MSG_DEFAULT_SALT;

        /** @private {boolean} - Whether or not the client has completed the connection process */
        this.connecting_ = true;

        /** @private {number} - Current request counter */
        this.sequence_ = 0;

        /** @private {number} - Secret */
        this.secret_ = 0;

        /** @private {number} - The time in milliseconds when this connection was started. */
        this.start_ = 0;

        /** @private {Buffer} - Accumulator for incomplete TCP frames */
        this.recvbuf_ = Buffer.alloc(0);

        /** @private {DispatchCallback} - Dispatch callback for received messages */
        this.callback_ = callback;

        socket.on('data', (data) => this.onData(data));
    }

    /**
     * Gets the number of milliseconds since this connection was started
     * @public
     * @returns {number} - Number of milliseconds
     */
    getLocalTime()
    {
        // Use process.hrtime.bigint() for monotonic high-resolution timing,
        // or Date.now() for milliseconds since epoch (cheap, no allocation).
        // The original used getMilliseconds() which only returns 0-999 (ms within the current second),
        // not total elapsed time. Date.now() returns absolute ms since epoch.
        return Date.now() - this.start_;
    }

    /**
     * Reserves a network message from internal buffer
     * *Only one message can be acquired at a time*
     * @public
     * @param {number} type - The type of network message 
     * @param {number} size - The size of the data contained by the message
     * @returns {[Buffer, Buffer]} - Tuple containing message and body subarray buffers
     */
    getMessageBuffer(type, size)
    {
        size += MSG_HEADER_SIZE;
        if (size % 0x10 != 0)
            size += 0x10 - (size % 0x10);

        const msg = this.sndbuf_.subarray(0, size);
        
        msg.fill(0);
        msg.writeUint16BE(size, 0x6);
        msg.writeUint32BE(type, 0xC);
        
        return [msg, msg.subarray(MSG_HEADER_SIZE)];
    }

    /**
     * Processes a system dispatch message
     * @private
     * @param {number} type - The type of network message
     * @param {Buffer} data  - The data contained by the message
     */
    onInternalMessage(type, data)
    {
        switch (type)
        {
            case MSG_HANDSHAKE:
            {
                const [msg, body] = this.getMessageBuffer(MSG_HANDSHAKE_RESPONSE, 0x10);
                this.secret_ = crypto.randomBytes(4).readUint32BE(0);


                // I assume this is some kind of handshake secret?
                body.writeUint32BE(this.secret_, 0x0);
                // Number of milliseconds since connection started, it'll always be 0 at this point
                body.writeUint32BE(0, 0x4);

                // Generate random salt to use
                const bytes = crypto.randomBytes(4);
                const le = bytes.readUint32LE();
                const be = bytes.readUint32BE();
                body.writeUint32BE(be, 0x8);
                body.writeUint32BE(le, 0xC);

                this.send(msg);

                this.salt_ = le ^ be;

                break;
            }

            // I don't know if this is actually a time sync message,
            // or if we even have to reply to it, but it doesn't seem to pose an issue?
            case MSG_TIME_SYNC:
            {
                if (data.length != 0x8)
                {
                    this.socket_.end();
                    return;
                }

                const secret = data.readUint32BE(0);
                const ticks = data.readUint32BE(0x4);

                if (secret != this.secret_)
                {
                    this.socket_.end();
                    return;
                }

                this.start_ = Date.now();
                break;
            }

            // Keep Alive, client sends it every 30seconds?
            case MSG_KEEP_ALIVE:
            {
                if (data.length != 0x4)
                {
                    this.socket_.end();
                    return;
                }

                const [msg, body] = this.getMessageBuffer(MSG_ACKNOWLEDGE, 0x4);
                body.writeUint32BE(this.getLocalTime(), 0);
                this.send(msg);

                break;
            }
        }
    }

    /**
     * Handles data received from associated socket.
     * TCP can deliver multiple messages in one chunk or split a message
     * across chunks, so we accumulate into recvbuf_ and process complete frames.
     * @private
     * @param {Buffer} data - The data received from the socket
     */
    onData(data)
    {
        // Debug: log raw incoming bytes
        console.log(`[NetworkClient] RAW DATA: ${data.length} bytes: ${data.subarray(0, Math.min(64, data.length)).toString('hex')}`);

        // Accumulate incoming data
        this.recvbuf_ = Buffer.concat([this.recvbuf_, data]);

        // Process all complete messages in the buffer
        while (this.recvbuf_.length >= MSG_HEADER_SIZE)
        {
            const len = peekLength(this.recvbuf_, this.salt_);

            if (len < MSG_HEADER_SIZE || len > MSG_MAX_SIZE) {
                console.log(`[NetworkClient] Invalid message length: ${len}, disconnecting`);
                this.socket_.end();
                return;
            }

            // Wait for at least the declared message length
            // (client may or may not pad to 16-byte alignment)
            if (this.recvbuf_.length < len)
                return;

            // Determine how many bytes to consume: use padded size if available
            let consumeLen = len;
            let paddedLen = len;
            if (paddedLen % 0x10 !== 0)
                paddedLen += 0x10 - (paddedLen % 0x10);
            if (this.recvbuf_.length >= paddedLen)
                consumeLen = paddedLen;

            // Use exact message length for CRC (client computes CRC over actual bytes, not padding)
            const msgBuf = Buffer.from(this.recvbuf_.subarray(0, len));

            if (!unpack(msgBuf, this.salt_))
            {
                console.log(`[NetworkClient] CRC check failed, disconnecting`);
                this.socket_.end();
                return;
            }

            const type = msgBuf.readUint32BE(0xC);
            const body = msgBuf.subarray(0x10, len);

            console.log(`[NetworkClient] RECV: 0x${type.toString(16).padStart(8, '0')} len=0x${len.toString(16)} body=${body.length}b`);

            if (type & 0x80)
            {
                this.onInternalMessage(type, body);
            }
            else
            {
                this.callback_(this, type, body);
            }

            this.recvbuf_ = this.recvbuf_.subarray(consumeLen);
        }
    }

    /**
     * Sends a network message to the client
     * @public
     * @param {Buffer} data - Network message to send to the client 
     */
    send(data)
    {
        data = pack(data, this.salt_);
        this.socket_.write(data);
    }

    /**
     * Closes the connection
     * @public
     */
    disconnect()
    {
        this.socket_.end();
    }
}

/**
 * @callback DispatchCallback
 * @param {NetworkClient} client
 * @param {number} type
 * @param {Buffer} data
 */