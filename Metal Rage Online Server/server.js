const NetworkClient = require('./client.js');
const { createServer } = require('net');
const db = require('./database/db');
const rooms = require('./rooms');
const { leaveRoomAndNotify } = require('./dispatch/room/room-leave');

const SERVER_PORT = 9211;
const GAME_PORT = 30907;

class DispatchServer
{
    constructor(name, port, services)
    {
        this.name = name;
        this.port = port;
        this.server = createServer();
        this.services = services;
        this.clients = [];

        this.server.on('connection', (socket) => this.onConnection(socket));
    }

    start()
    {
        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`[${this.name}] Listening on port: ${this.port}`);
        });
    }

    onConnection(socket)
    {
        console.log(`[${this.name}] New connection from ${socket.remoteAddress}:${socket.remotePort}`);
        let pending = Promise.resolve();
        const client = new NetworkClient(socket, (client, type, data) => {
            pending = pending.then(async () => {
                if (socket.destroyed || socket.writableEnded) return;
                if (this.name === 'GameServer' && !client.accountId_ && type !== 0x00110124) {
                    client.disconnect();
                    return;
                }
                for (const service of this.services) {
                    if (await service.dispatch(client, type, data)) return;
                }
                console.log(`[${this.name}] Unhandled message type 0x${type.toString(16)}`);
            }).catch(err => {
                console.error(`[${this.name}] Dispatch error:`, err.message);
                socket.destroy();
            });
        });

        this.clients.push(client);

        socket.on('error', (err) => {
            console.log(`[${this.name}] Socket error: ${err.code}`);
        });

        socket.on('close', () => {
            const idx = this.clients.indexOf(client);
            if (idx !== -1) this.clients.splice(idx, 1);
            console.log(`[${this.name}] Connection closed (${this.clients.length} remaining)`);
            const room = rooms.getRoomByAccount(client.accountId_);
            if (room && room.members.get(client.accountId_)?.client === client) {
                leaveRoomAndNotify(client.accountId_);
            }
        });
    }
};

async function start()
{
    require('./config/server').load();
    require('./config/whitelist').initialize();
    await db.verifyConnection();
    const dispatch = new DispatchServer('DispatchServer', SERVER_PORT, require('./dispatch.js'));
    const game = new DispatchServer('GameServer', GAME_PORT, require('./game.js'));
    rooms.registerLobbyClientSource(game.clients);
    dispatch.start();
    game.start();
}

if (require.main === module) {
    start().catch(err => {
        console.error('[Server] Startup failed:', err.message);
        db.pool.end().finally(() => { process.exitCode = 1; });
    });
}

module.exports = { DispatchServer, start };
