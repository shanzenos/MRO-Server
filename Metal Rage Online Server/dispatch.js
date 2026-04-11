const ZAccountDispatch = require('./dispatch/account.dispatch');
const ZGateDispatch = require('./dispatch/gate.dispatch');
const ZGateSocialDispatch = require('./dispatch/gate.social.dispatch');

// Dispatch server services (port 9211)
//
// Message naming convention:
//   CQ = Client Question (client sends request)
//   SA = Server Answer (server responds to request)
//   SN = Server Notification (server pushes to client)
//   CN = Client Notification (client pushes to server)
//   CA = Client Answer (client responds to server query)
//   SQ = Server Query (server asks client)
//
// Response format (FNETWORK_EVENT_INFO):
//   ushort EventMessage (0 = OK)
//   uint   ErrorMessage (0 = OK)

module.exports = [
    new ZAccountDispatch(),
    new ZGateDispatch(),
    new ZGateSocialDispatch(),
];
