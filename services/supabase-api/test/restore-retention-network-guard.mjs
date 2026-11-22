// Offline CI lanes use in-memory ports. Fail any incidental outbound socket or
// global fetch before loading the selected synthetic test module.
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('offline_network_prohibited'); };
net.connect = denied;
net.createConnection = denied;
net.Socket.prototype.connect = denied;
tls.connect = denied;
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('offline_network_prohibited'); };
