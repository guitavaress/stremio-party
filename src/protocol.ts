// Mensagens trocadas entre o cliente injetado no Stremio e o servidor de salas.

export interface Perms {
  /** Pode pausar e retomar para todos. */
  pause: boolean;
  /** Pode mudar o tempo do vídeo para todos. */
  seek: boolean;
  /** Pode escolher o filme/stream da sala. */
  media: boolean;
}

export const NO_PERMS: Perms = { pause: false, seek: false, media: false };
export const ALL_PERMS: Perms = { pause: true, seek: true, media: true };

/**
 * idle    – sala sem vídeo
 * syncing – todos pausados indo para `position`; só toca quando todos estiverem prontos
 * playing – tocando; `position` era o tempo do vídeo no instante `at` (relógio do servidor, ms)
 * paused  – pausado em `position`
 */
export type Phase = 'idle' | 'syncing' | 'playing' | 'paused';

export interface Playback {
  phase: Phase;
  /** Segundos. */
  position: number;
  /** Relógio do servidor (ms) em que `position` vale; só usado em `playing`. */
  at: number;
  /** Incrementa a cada mudança; o cliente carimba o status com o seq que aplicou. */
  seq: number;
}

export interface MemberStatus {
  seq: number;
  /** O player está aberto no vídeo da sala e carregado. */
  onMedia: boolean;
  /** Em `syncing`: pausado no tempo alvo e com buffer suficiente. */
  ready: boolean;
  /** Em `playing`: travado carregando (ou fora do vídeo). */
  buffering: boolean;
  time: number | null;
  paused: boolean;
  /** Segundos de vídeo já em buffer à frente. */
  cacheAhead: number;
}

export interface Media {
  /** `location.hash` da rota do player do Stremio (contém o stream codificado). */
  hash: string;
  title: string;
  /** Id do membro que escolheu. */
  by: string;
}

export interface MemberView {
  id: string;
  name: string;
  perms: Perms;
  status: MemberStatus | null;
}

export interface RoomView {
  code: string;
  adminId: string;
  members: MemberView[];
  media: Media | null;
  playback: Playback;
}

export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'leave' }
  | { t: 'ping'; c: number }
  | { t: 'status'; status: MemberStatus }
  | { t: 'cmd'; action: 'play' | 'pause' | 'seek'; position?: number }
  | { t: 'setMedia'; media: { hash: string; title: string } | null }
  | { t: 'setPerms'; memberId: string; perms: Perms }
  | { t: 'kick'; memberId: string }
  | { t: 'transfer'; memberId: string };

export type ServerMsg =
  | { t: 'joined'; you: string; room: RoomView }
  | { t: 'room'; room: RoomView }
  | { t: 'pong'; c: number; s: number }
  | { t: 'left'; reason: 'left' | 'kicked' }
  | { t: 'error'; code: 'no_room' | 'bad_request' | 'denied' | 'full'; message: string };

export const LIMITS = {
  name: 24,
  title: 160,
  hash: 32 * 1024,
  members: 16,
};

export const DEFAULT_ROOM_PORT = 11481;
