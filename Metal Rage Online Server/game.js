const ZGameLoginDispatch = require('./dispatch/gamelogin.dispatch');
const ZGateGameDispatch = require('./dispatch/gate.game.dispatch');
const ZLobbyDispatch = require('./dispatch/lobby.dispatch');
const ZRoomDispatch = require('./dispatch/room.dispatch');
const ZGameDispatch = require('./dispatch/game.dispatch');
const ZCommunityDispatch = require('./dispatch/community.dispatch');

// Game server dispatch services
// These handle everything after the player leaves the Gate and connects to a game server.
//
// Flow: Gate (dispatch server) -> Lobby -> Room -> Game (game server)
//
// Message ID pattern (confirmed from client traffic):
//   0x11XXXX = Login (game server re-auth)
//   0x21XXXX = ZDispatchAccount (info/create)
//   0x22XXXX = ZDispatchGate (server/channel + room create + social)
//   0x23XXXX = ZDispatchLobby
//   0x24XXXX = ZDispatchRoom
//   0x25XXXX = ZDispatchGame
//   0x26XXXX = ZDispatchQuest/Hangar
//   0x31XXXX = ZDispatchHangar
//   0x32XXXX = ZDispatchCard
//   0x36XXXX = ZDispatchClan
//
// Dispatch order matters! ZGameLoginDispatch handles only login + channel enter,
// then ZGateGameDispatch catches remaining 0x22XXXX (room create, social, etc.)

module.exports = [
    new ZGameLoginDispatch(),   // 0x110124 login + 0x220111 channel enter only
    new ZGateGameDispatch(),    // Remaining 0x22XXXX (room create, social, config reports)
    new ZLobbyDispatch(),       // 0x23XXXX
    new ZRoomDispatch(),        // 0x24XXXX
    new ZGameDispatch(),        // 0x25XXXX
    new ZCommunityDispatch(),   // 0x26/0x31/0x32/0x36/0x41/0x42/0x51
];
