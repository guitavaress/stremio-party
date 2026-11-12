import { ClientMsg, MemberStatus, MemberView, Perms, RoomView, ServerMsg } from '../protocol';

export type ConnState = 'offline' | 'connecting' | 'online';

/** Aceita `host`, `host:porta`, `ws://…` ou `wss://…`. */
export function normalizeServerUrl(input: string, defaultPort: number): string {
  let s = input.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(s)) {
    if (!/:\d+$/.test(s)) s += `:${defaultPort}`;
    s = `ws://${s}`;
  }
  return s.replace(/\/+$/, '');
}

/** Conexão com o servidor de salas, com reconexão e relógio sincronizado. */
export class Net {
  state: ConnState = 'offline';
  room: RoomView | null = null;
  myId = '';
  onUpdate: () => void = () => {};
  onNotice: (text: string) => void = () => {};

  private ws: WebSocket | null = null;
  private url = '';
  private name = '';
  /** O que mandar assim que conectar: criar ou entrar. */
  private intent: { t: 'create' } | { t: 'join'; code: string } | null = null;
  private retry = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  /** serverNow ≈ Date.now() + offset */
  private offset = 0;
  private bestRtt = Infinity;

  get me(): MemberView | null {
    return this.room?.members.find((m) => m.id === this.myId) ?? null;
  }

  get perms(): Perms {
    return this.me?.perms ?? { pause: false, seek: false, media: false };
  }

  get isAdmin(): boolean {
    return !!this.room && this.room.adminId === this.myId;
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }

  create(url: string, name: string): void {
    this.open(url, name, { t: 'create' });
  }

  join(url: string, name: string, code: string): void {
    this.open(url, name, { t: 'join', code });
  }

  leave(): void {
    this.intent = null;
    this.send({ t: 'leave' });
    this.close();
  }

  sendStatus(status: MemberStatus): void {
    this.send({ t: 'status', status });
  }

  cmd(action: 'play' | 'pause' | 'seek', position?: number): void {
    this.send({ t: 'cmd', action, position });
  }

  setMedia(media: { hash: string; title: string } | null): void {
    this.send({ t: 'setMedia', media });
  }

  setPerms(memberId: string, perms: Perms): void {
    this.send({ t: 'setPerms', memberId, perms });
  }

  kick(memberId: string): void {
    this.send({ t: 'kick', memberId });
  }

  transfer(memberId: string): void {
    this.send({ t: 'transfer', memberId });
  }

  private open(url: string, name: string, intent: NonNullable<Net['intent']>): void {
    this.close();
    this.url = url;
    this.name = name;
    this.intent = intent;
    this.retry = 0;
    this.connect();
  }

  private connect(): void {
    this.state = 'connecting';
    this.onUpdate();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.state = 'offline';
      this.intent = null;
      this.onNotice('Endereço do servidor inválido.');
      this.onUpdate();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || !this.intent) return;
      this.state = 'online';
      this.bestRtt = Infinity;
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), 5000);
      this.send(this.intent.t === 'create' ? { t: 'create', name: this.name } : { t: 'join', code: this.intent.code, name: this.name });
      this.onUpdate();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      try {
        this.receive(JSON.parse(String(e.data)));
      } catch (err) {
        console.error('[party] mensagem inválida do servidor', err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      window.clearInterval(this.pingTimer);
      this.ws = null;
      const wasInRoom = !!this.room;
      this.room = null;
      // Caiu no meio da sessão: tenta voltar para a mesma sala.
      if (this.intent && this.retry < 8) {
        this.retry++;
        this.state = 'connecting';
        if (wasInRoom) this.onNotice('Conexão com a sala caiu. Reconectando…');
        this.retryTimer = window.setTimeout(() => this.connect(), Math.min(1000 * this.retry, 5000));
      } else {
        if (this.intent) this.onNotice('Não foi possível conectar ao servidor da sala.');
        this.intent = null;
        this.state = 'offline';
      }
      this.onUpdate();
    };
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'joined':
        this.myId = msg.you;
        this.room = msg.room;
        // Reconexões futuras entram na mesma sala, mesmo que tenha sido criada agora.
        this.intent = { t: 'join', code: msg.room.code };
        this.retry = 0;
        break;
      case 'room':
        this.room = msg.room;
        break;
      case 'pong': {
        const now = Date.now();
        const rtt = now - msg.c;
        // A amostra com menor ida-e-volta é a estimativa mais confiável do relógio.
        if (rtt <= this.bestRtt + 20) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.offset = msg.s - (msg.c + rtt / 2);
        }
        return;
      }
      case 'left':
        this.intent = null;
        this.room = null;
        if (msg.reason === 'kicked') this.onNotice('Você foi removido da sala.');
        this.close();
        break;
      case 'error':
        this.onNotice(msg.message);
        if (msg.code === 'no_room' || msg.code === 'full') {
          this.intent = null;
          this.close();
        }
        break;
    }
    this.onUpdate();
  }

  private ping(): void {
    this.send({ t: 'ping', c: Date.now() });
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private close(): void {
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.room = null;
    this.state = 'offline';
    if (ws) {
      try {
        ws.close();
      } catch {
        /* já fechado */
      }
    }
    this.onUpdate();
  }
}
