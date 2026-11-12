import {
  ALL_PERMS,
  ClientMsg,
  LIMITS,
  Media,
  MemberStatus,
  MemberView,
  NO_PERMS,
  Perms,
  Playback,
  RoomView,
  ServerMsg,
} from '../protocol';

/** Atraso entre "todos prontos" e o play, para o comando chegar a todos antes da hora. */
export const START_DELAY_MS = 600;

interface Member {
  id: string;
  name: string;
  perms: Perms;
  status: MemberStatus | null;
}

export type Send = (memberId: string, msg: ServerMsg) => void;

/**
 * Estado autoritativo de uma sala. Não conhece sockets: recebe mensagens já
 * decodificadas e devolve mensagens por `send`, o que permite testar a
 * máquina de sincronia sem rede.
 */
export class Room {
  readonly members = new Map<string, Member>();
  adminId = '';
  media: Media | null = null;
  playback: Playback = { phase: 'idle', position: 0, at: 0, seq: 0 };

  constructor(
    readonly code: string,
    private readonly now: () => number,
    private readonly send: Send,
  ) {}

  get empty(): boolean {
    return this.members.size === 0;
  }

  add(id: string, name: string): void {
    const first = this.members.size === 0;
    this.members.set(id, { id, name, perms: first ? { ...ALL_PERMS } : { ...NO_PERMS }, status: null });
    if (first) this.adminId = id;
    // Quem entra no meio do filme precisa carregar: todos esperam por ele.
    if (this.playback.phase === 'playing') this.startSync(this.currentPosition());
    this.send(id, { t: 'joined', you: id, room: this.view() });
    this.broadcast();
  }

  remove(id: string, reason: 'left' | 'kicked' | 'disconnected'): void {
    if (!this.members.delete(id)) return;
    if (reason !== 'disconnected') this.send(id, { t: 'left', reason });
    if (this.adminId === id) {
      const next = this.members.values().next().value as Member | undefined;
      if (next) {
        this.adminId = next.id;
        next.perms = { ...ALL_PERMS };
      }
    }
    // Quem saiu não segura mais a barreira de sincronia.
    this.evaluate();
    this.broadcast();
  }

  handle(id: string, msg: ClientMsg): void {
    const me = this.members.get(id);
    if (!me) return;
    switch (msg.t) {
      case 'status':
        me.status = msg.status;
        this.evaluate();
        this.broadcast();
        return;

      case 'cmd':
        if (!this.media) return;
        if (msg.action === 'seek' ? !me.perms.seek : !me.perms.pause) return this.deny(id);
        this.command(msg.action, msg.position);
        this.broadcast();
        return;

      case 'setMedia':
        if (!me.perms.media) return this.deny(id);
        if (!msg.media) {
          this.media = null;
          this.setPlayback('idle', 0);
        } else if (this.media && this.media.hash === msg.media.hash) {
          // Mesmo vídeo: só atualiza o título, sem reiniciar a sincronia.
          if (msg.media.title) this.media.title = msg.media.title;
        } else {
          this.media = { hash: msg.media.hash, title: msg.media.title, by: id };
          for (const m of this.members.values()) m.status = null;
          this.startSync(0);
        }
        this.broadcast();
        return;

      case 'setPerms': {
        if (id !== this.adminId) return this.deny(id);
        const target = this.members.get(msg.memberId);
        if (!target || target.id === this.adminId) return;
        target.perms = { pause: !!msg.perms.pause, seek: !!msg.perms.seek, media: !!msg.perms.media };
        this.broadcast();
        return;
      }

      case 'kick':
        if (id !== this.adminId) return this.deny(id);
        if (msg.memberId !== this.adminId) this.remove(msg.memberId, 'kicked');
        return;

      case 'transfer': {
        if (id !== this.adminId) return this.deny(id);
        const target = this.members.get(msg.memberId);
        if (!target) return;
        this.adminId = target.id;
        target.perms = { ...ALL_PERMS };
        this.broadcast();
        return;
      }
    }
  }

  /** Tempo do vídeo agora, segundo o estado da sala. */
  currentPosition(): number {
    const p = this.playback;
    if (p.phase !== 'playing') return p.position;
    return p.position + Math.max(0, this.now() - p.at) / 1000;
  }

  view(): RoomView {
    const members: MemberView[] = [];
    for (const m of this.members.values()) members.push({ id: m.id, name: m.name, perms: m.perms, status: m.status });
    return { code: this.code, adminId: this.adminId, members, media: this.media, playback: this.playback };
  }

  private command(action: 'play' | 'pause' | 'seek', position?: number): void {
    const phase = this.playback.phase;
    const valid = typeof position === 'number' && isFinite(position) && position >= 0;
    if (action === 'pause') {
      if (phase === 'playing' || phase === 'syncing') {
        this.setPlayback('paused', valid ? position! : this.currentPosition());
      }
    } else if (action === 'play') {
      // Retomar sempre passa pela barreira: só toca quando todos estiverem prontos.
      if (phase === 'paused') this.startSync(this.playback.position);
    } else if (valid) {
      if (phase === 'paused') this.setPlayback('paused', position!);
      else this.startSync(position!);
    }
  }

  /** Avança a máquina de estados a partir do status que os membros reportaram. */
  private evaluate(): void {
    const p = this.playback;
    if (this.members.size === 0) return;
    if (p.phase === 'syncing') {
      for (const m of this.members.values()) {
        if (!m.status || m.status.seq !== p.seq || !m.status.ready) return;
      }
      this.setPlayback('playing', p.position, this.now() + START_DELAY_MS);
    } else if (p.phase === 'playing') {
      let stalled = false;
      let earliest = this.currentPosition();
      for (const m of this.members.values()) {
        const s = m.status;
        if (!s || s.seq !== p.seq) continue; // ainda não aplicou este estado
        if (s.buffering || !s.onMedia) {
          stalled = true;
          if (typeof s.time === 'number' && s.onMedia) earliest = Math.min(earliest, s.time);
        }
      }
      // Alguém travou: pausa para todos e volta ao ponto de quem ficou para trás.
      if (stalled) this.startSync(Math.max(0, earliest));
    }
  }

  private startSync(position: number): void {
    this.setPlayback('syncing', position);
  }

  private setPlayback(phase: Playback['phase'], position: number, at = 0): void {
    this.playback = { phase, position, at, seq: this.playback.seq + 1 };
  }

  private deny(id: string): void {
    this.send(id, { t: 'error', code: 'denied', message: 'Você não tem permissão para isso nesta sala.' });
  }

  private broadcast(): void {
    const msg: ServerMsg = { t: 'room', room: this.view() };
    for (const id of this.members.keys()) this.send(id, msg);
  }
}

/** Valida e normaliza uma mensagem vinda da rede. Devolve null se for inválida. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, any>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
  switch (m.t) {
    case 'create': {
      const name = str(m.name, 200);
      return name === null ? null : { t: 'create', name: cleanName(name) };
    }
    case 'join': {
      const name = str(m.name, 200);
      const code = str(m.code, 16);
      return name === null || code === null ? null : { t: 'join', code: code.trim().toUpperCase(), name: cleanName(name) };
    }
    case 'leave':
      return { t: 'leave' };
    case 'ping':
      return typeof m.c === 'number' ? { t: 'ping', c: m.c } : null;
    case 'status': {
      const s = m.status;
      if (!s || typeof s !== 'object' || typeof s.seq !== 'number') return null;
      return {
        t: 'status',
        status: {
          seq: s.seq,
          onMedia: !!s.onMedia,
          ready: !!s.ready,
          buffering: !!s.buffering,
          time: typeof s.time === 'number' && isFinite(s.time) ? s.time : null,
          paused: !!s.paused,
          cacheAhead: typeof s.cacheAhead === 'number' && isFinite(s.cacheAhead) ? s.cacheAhead : 0,
        },
      };
    }
    case 'cmd':
      if (m.action !== 'play' && m.action !== 'pause' && m.action !== 'seek') return null;
      return { t: 'cmd', action: m.action, position: typeof m.position === 'number' ? m.position : undefined };
    case 'setMedia': {
      if (m.media === null) return { t: 'setMedia', media: null };
      if (!m.media || typeof m.media !== 'object') return null;
      const hash = str(m.media.hash, LIMITS.hash);
      if (hash === null || !hash.startsWith('#/player/')) return null;
      const title = typeof m.media.title === 'string' ? m.media.title.slice(0, LIMITS.title) : '';
      return { t: 'setMedia', media: { hash, title } };
    }
    case 'setPerms': {
      const memberId = str(m.memberId, 64);
      if (memberId === null || !m.perms || typeof m.perms !== 'object') return null;
      return { t: 'setPerms', memberId, perms: { pause: !!m.perms.pause, seek: !!m.perms.seek, media: !!m.perms.media } };
    }
    case 'kick':
    case 'transfer': {
      const memberId = str(m.memberId, 64);
      return memberId === null ? null : { t: m.t, memberId };
    }
    default:
      return null;
  }
}

function cleanName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
  return n || 'Convidado';
}
