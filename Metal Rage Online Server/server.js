const NetworkClient = require('./client.js');
const { createServer } = require('net');

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
        this.server.listen(this.port, () => {
            console.log(`[${this.name}] Listening on port: ${this.port}`);
        });
    }

    onConnection(socket)
    {
        console.log(`[${this.name}] New connection from ${socket.remoteAddress}:${socket.remotePort}`);
        const client = new NetworkClient(socket, (client, type, data) => {
            for (const service of this.services)
            {
                if (service.dispatch(client, type, data))
                    return;
            }

            // Log unhandled messages with full hex dump for reverse engineering
            console.log(`[${this.name}] Unhandled message type 0x${type.toString(16).padStart(8, '0')} (${data.length} bytes)`);
            if (data.length > 0) {
                console.log(`[${this.name}] Body hex:`, data.toString('hex'));
            }
        });

        this.clients.push(client);

        socket.on('error', (err) => {
            console.log(`[${this.name}] Socket error: ${err.code}`);
        });

        socket.on('close', () => {
            const idx = this.clients.indexOf(client);
            if (idx !== -1) this.clients.splice(idx, 1);
            console.log(`[${this.name}] Connection closed (${this.clients.length} remaining)`);
        });
    }
};

// Dispatch server handles: Account login, Gate (server/channel selection)
const dispatchServices = require('./dispatch.js');
new DispatchServer('DispatchServer', SERVER_PORT, dispatchServices).start();

// Game server handles: Lobby, Room, Game, Hangar, Community, etc.
const gameServices = require('./game.js');
new DispatchServer('GameServer', GAME_PORT, gameServices).start();