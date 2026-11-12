import { MemberStatus } from '../protocol';
import { Mpv } from './mpv';
import { Net } from './net';

const TICK_MS = 200;
/** Diferença tolerada para considerar "no mesmo tempo" quando pausado. */
const SEEK_TOLERANCE = 0.5;
/** Buffer mínimo à frente para se declarar pronto. */
const MIN_CACHE_AHEAD = 3;
/** Tocando: acima disto corrige com seek; abaixo, só acelera/desacelera. */
const HARD_DRIFT = 1.5;
const SOFT_DRIFT = 0.25;
/** Travado por mais que isto conta como buffering (evita falso alarme em micro-pausas). */
const STALL_MS = 800;
/** Se o buffer não reportar nada, não segura a sala para sempre. */
const CACHE_WAIT_MS = 15_000;

/**
 * Aplica no player local o estado da sala e reporta ao servidor se este
 * cliente está pronto / travado. Roda em um laço curto e sempre que o mpv
 * ou a sala mudam.
 */
export class Sync {
  private lastSeekAt = 0;
  private lastSetAt = 0;
  private lastSent = '';
  private lastSentAt = 0;
  private seq = -1;
  private seqSince = 0;
  private startTimer = 0;

  constructor(
    private readonly mpv: Mpv,
    private readonly net: Net,
  ) {
    window.setInterval(() => this.tick(), TICK_MS);
  }

  /** O player local está aberto no vídeo da sala? */
  onRoomMedia(): boolean {
    const media = this.net.room?.media;
    return !!media && location.hash === media.hash;
  }

  tick(): void {
    const room = this.net.room;
    if (!room) {
      this.seq = -1;
      return;
    }
    const pb = room.playback;
    const st = this.mpv.state;
    const now = Date.now();
    if (pb.seq !== this.seq) {
      this.seq = pb.seq;
      this.seqSince = now;
      window.clearTimeout(this.startTimer);
      this.startTimer = 0;
    }

    const loaded = this.onRoomMedia() && this.mpv.available && st.duration > 0 && st.time !== null;
    let ready = false;
    let buffering = false;

    if (loaded) {
      const time = st.time as number;
      if (pb.phase === 'syncing') {
        this.pause(true);
        this.speed(1);
        this.seekIfOff(pb.position, SEEK_TOLERANCE);
        const cacheAhead = st.cacheTime - time;
        const cacheOk =
          cacheAhead >= MIN_CACHE_AHEAD || st.cacheTime >= st.duration - 2 || now - this.seqSince > CACHE_WAIT_MS;
        ready = st.pause && !st.seeking && Math.abs(time - pb.position) <= SEEK_TOLERANCE + 0.1 && cacheOk;
      } else if (pb.phase === 'paused') {
        this.pause(true);
        this.speed(1);
        this.seekIfOff(pb.position, SEEK_TOLERANCE);
        ready = true;
      } else if (pb.phase === 'playing') {
        const untilStart = pb.at - this.net.serverNow();
        if (untilStart > 0) {
          // Todos soltam o pause no mesmo instante do relógio do servidor.
          this.pause(true);
          if (untilStart <= TICK_MS + 50 && !this.startTimer) {
            const seq = pb.seq;
            this.startTimer = window.setTimeout(() => {
              this.startTimer = 0;
              if (this.net.room?.playback.seq === seq) this.mpv.set('pause', false);
            }, untilStart);
          }
        } else {
          this.pause(false);
          const expected = pb.position + -untilStart / 1000;
          const drift = time - expected;
          const stalled = st.pausedForCache && now - st.stallAt > STALL_MS;
          if (!st.seeking && !st.pausedForCache) {
            if (Math.abs(drift) > HARD_DRIFT) {
              if (now - this.lastSeekAt > 3000) this.seek(Math.min(expected + 0.3, Math.max(0, st.duration - 1)));
              this.speed(1);
            } else if (Math.abs(drift) > SOFT_DRIFT) {
              this.speed(drift > 0 ? 0.95 : 1.05);
            } else if (Math.abs(drift) < 0.08) {
              this.speed(1);
            }
          }
          buffering = stalled;
          ready = !stalled;
        }
      }
    }

    const status: MemberStatus = {
      seq: pb.seq,
      onMedia: loaded,
      ready,
      // Tocando, quem não está com o vídeo aberto também segura a sala.
      buffering: pb.phase === 'playing' && this.net.serverNow() >= pb.at && (buffering || !loaded),
      time: loaded ? Math.round((st.time as number) * 10) / 10 : null,
      paused: st.pause,
      cacheAhead: loaded ? Math.max(0, Math.round(st.cacheTime - (st.time as number))) : 0,
    };
    // Manda quando algo relevante muda, e ao menos 1x por segundo para o tempo aparecer no painel.
    const key = JSON.stringify({ ...status, time: null, cacheAhead: null });
    if (key !== this.lastSent || now - this.lastSentAt > 1000) {
      this.lastSent = key;
      this.lastSentAt = now;
      this.net.sendStatus(status);
    }
  }

  private pause(value: boolean): void {
    const now = Date.now();
    if (this.mpv.state.pause === value || now - this.lastSetAt < 300) return;
    this.lastSetAt = now;
    this.mpv.set('pause', value);
  }

  private speed(value: number): void {
    if (Math.abs(this.mpv.state.speed - value) < 0.001) return;
    this.mpv.state.speed = value;
    this.mpv.set('speed', value);
  }

  private seekIfOff(target: number, tolerance: number): void {
    const st = this.mpv.state;
    if (st.time === null || st.seeking) return;
    if (Math.abs(st.time - target) <= tolerance) return;
    if (Date.now() - this.lastSeekAt < 1500) return;
    this.seek(target);
  }

  private seek(target: number): void {
    this.lastSeekAt = Date.now();
    this.mpv.set('time-pos', target);
  }
}
