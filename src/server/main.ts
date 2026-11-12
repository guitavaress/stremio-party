// Servidor de salas avulso (sem launcher): `node dist/server.js`.
// É o ponto de entrada para hospedar em um VPS ou nuvem; a porta vem de PORT.
import { DEFAULT_ROOM_PORT } from '../protocol';
import { startPartyServer } from './server';

const port = Number(process.env.PORT) || DEFAULT_ROOM_PORT;
const host = process.env.HOST || '0.0.0.0';

startPartyServer({ port, hosts: [host], log: console.log }).then((s) => {
  if (s.addresses.length === 0) process.exit(1);
  console.log(`Stremio Party: servidor de salas em ${s.addresses.join(', ')}`);
});
