import { randomBytes, randomInt } from 'crypto';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { LIMITS, ServerMsg } from '../protocol';
import { Room, parseClientMsg } from './room';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L
const HEARTBEAT_MS = 10_000;

interface Conn {
  id: string;
  ws: WebSocket;
  room: Room | null;
  alive: boolean;
}

export interface PartyServer {
  /** Endereços em que o servidor está escutando, como `host:porta`. */
  addresses: string[];
  close(): void;
}

/**
 * Servidor de salas. Escuta em cada host informado (ex.: 127.0.0.1 e o IP
 * Tailscale). Hosts que falharem ao abrir são ignorados com um aviso.
 */
export async function startPartyServer(opts: { port: number; hosts: string[]; log?: (s: string) => void }): Promise<PartyServer> {
  const log = opts.log ?? (() => {});
  const rooms = new Map<string, Room>();
  const conns = new Map<string, Conn>();

  const send = (memberId: string, msg: ServerMsg) => {
    const c = conns.get(memberId);
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };

  const newCode = (): string => {
    for (;;) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  const leave = (c: Conn, reason: 'left' | 'disconnected') => {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.remove(c.id, reason);
    if (room.empty) rooms.delete(room.code);
  };

  const onConnection = (ws: WebSocket) => {
    const c: Conn = { id: randomBytes(8).toString('hex'), ws, room: null, alive: true };
    conns.set(c.id, c);
    const reply = (msg: ServerMsg) => ws.send(JSON.stringify(msg));

    ws.on('pong', () => (c.alive = true));
    ws.on('close', () => {
      leave(c, 'disconnected');
      conns.delete(c.id);
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data) => {
      let msg;
      try {
        msg = parseClientMsg(JSON.parse(data.toString()));
      } catch {
        msg = null;
      }
      if (!msg) return reply({ t: 'error', code: 'bad_request', message: 'Mensagem inválida.' });

      if (msg.t === 'ping') return reply({ t: 'pong', c: msg.c, s: Date.now() });

      if (msg.t === 'create' || msg.t === 'join') {
        leave(c, 'left');
        let room: Room | undefined;
        if (msg.t === 'create') {
          room = new Room(newCode(), Date.now, send);
          rooms.set(room.code, room);
        } else {
          room = rooms.get(msg.code);
          if (!room) return reply({ t: 'error', code: 'no_room', message: `Sala ${msg.code} não existe.` });
          if (room.members.size >= LIMITS.members) return reply({ t: 'error', code: 'full', message: 'A sala está cheia.' });
        }
        c.room = room;
        room.add(c.id, msg.name);
        return;
      }

      if (msg.t === 'leave') return leave(c, 'left');

      if (!c.room) return;
      const room = c.room;
      room.handle(c.id, msg);
      // Um kick pode ter removido outro membro: solta a conexão dele da sala.
      if (msg.t === 'kick') {
        const kicked = conns.get(msg.memberId);
        if (kicked && kicked.room === room && !room.members.has(kicked.id)) kicked.room = null;
      }
    });
  };

  const servers: http.Server[] = [];
  const addresses: string[] = [];
  for (const host of opts.hosts) {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Stremio Party: servidor de salas no ar.\n');
    });
    const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
    wss.on('connection', onConnection);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, host, resolve);
      });
      servers.push(server);
      addresses.push(`${host}:${opts.port}`);
    } catch (e: any) {
      log(`Não foi possível abrir o servidor de salas em ${host}:${opts.port} (${e.code ?? e.message}).`);
    }
  }

  // Derruba conexões que pararam de responder, para não travarem a sincronia.
  const heartbeat = setInterval(() => {
    for (const c of conns.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);

  return {
    addresses,
    close() {
      clearInterval(heartbeat);
      for (const c of conns.values()) c.ws.terminate();
      for (const s of servers) s.close();
    },
  };
}
