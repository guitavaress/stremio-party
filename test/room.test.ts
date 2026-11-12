import { beforeEach, describe, expect, it } from 'vitest';
import { MemberStatus, ServerMsg } from '../src/protocol';
import { Room, START_DELAY_MS, parseClientMsg } from '../src/server/room';

const HASH = '#/player/abc';

describe('Room', () => {
  let now: number;
  let sent: Array<{ to: string; msg: ServerMsg }>;
  let room: Room;

  /** Status de um membro que já aplicou o estado atual da sala. */
  const status = (over: Partial<MemberStatus> = {}): MemberStatus => ({
    seq: room.playback.seq,
    onMedia: true,
    ready: true,
    buffering: false,
    time: room.playback.position,
    paused: true,
    cacheAhead: 10,
    ...over,
  });
  const report = (id: string, over: Partial<MemberStatus> = {}) => room.handle(id, { t: 'status', status: status(over) });
  const errorsFor = (id: string) => sent.filter((s) => s.to === id && s.msg.t === 'error');

  beforeEach(() => {
    now = 1_000_000;
    sent = [];
    room = new Room('TEST1', () => now, (to, msg) => sent.push({ to, msg }));
    room.add('admin', 'Admin');
    room.add('bia', 'Bia');
  });

  /** Leva a sala até `playing` com os dois membros prontos. */
  const startPlaying = () => {
    room.handle('admin', { t: 'setMedia', media: { hash: HASH, title: 'Filme' } });
    report('admin');
    report('bia');
    expect(room.playback.phase).toBe('playing');
  };

  it('dá todas as permissões ao criador e nenhuma a quem entra depois', () => {
    const v = room.view();
    expect(v.adminId).toBe('admin');
    expect(v.members[0].perms).toEqual({ pause: true, seek: true, media: true });
    expect(v.members[1].perms).toEqual({ pause: false, seek: false, media: false });
  });

  it('só começa a tocar quando todos estão prontos', () => {
    room.handle('admin', { t: 'setMedia', media: { hash: HASH, title: 'Filme' } });
    expect(room.playback.phase).toBe('syncing');

    report('admin');
    expect(room.playback.phase).toBe('syncing');

    report('bia', { ready: false });
    expect(room.playback.phase).toBe('syncing');

    report('bia');
    expect(room.playback.phase).toBe('playing');
    expect(room.playback.at).toBe(now + START_DELAY_MS);
  });

  it('ignora status "pronto" de um estado antigo', () => {
    room.handle('admin', { t: 'setMedia', media: { hash: HASH, title: 'Filme' } });
    report('admin');
    room.handle('bia', { t: 'status', status: status({ seq: room.playback.seq - 1 }) });
    expect(room.playback.phase).toBe('syncing');
  });

  it('pausa para todos quando alguém trava e volta ao ponto de quem ficou para trás', () => {
    startPlaying();
    now += START_DELAY_MS + 60_000; // 60s de filme
    report('bia', { buffering: true, time: 57.5, paused: false });
    expect(room.playback.phase).toBe('syncing');
    expect(room.playback.position).toBe(57.5);

    // Só volta a tocar depois que os dois reportarem prontos no novo estado.
    report('admin');
    expect(room.playback.phase).toBe('syncing');
    report('bia');
    expect(room.playback.phase).toBe('playing');
  });

  it('nega pause e seek a quem não tem permissão', () => {
    startPlaying();
    room.handle('bia', { t: 'cmd', action: 'pause', position: 5 });
    room.handle('bia', { t: 'cmd', action: 'seek', position: 500 });
    expect(room.playback.phase).toBe('playing');
    expect(errorsFor('bia')).toHaveLength(2);
  });

  it('permite pausar e dar seek depois que o admin concede', () => {
    startPlaying();
    room.handle('admin', { t: 'setPerms', memberId: 'bia', perms: { pause: true, seek: false, media: false } });

    room.handle('bia', { t: 'cmd', action: 'pause', position: 12 });
    expect(room.playback).toMatchObject({ phase: 'paused', position: 12 });

    room.handle('bia', { t: 'cmd', action: 'seek', position: 500 });
    expect(room.playback.position).toBe(12); // seek continua negado

    room.handle('admin', { t: 'setPerms', memberId: 'bia', perms: { pause: true, seek: true, media: false } });
    room.handle('bia', { t: 'cmd', action: 'seek', position: 500 });
    expect(room.playback).toMatchObject({ phase: 'paused', position: 500 });
  });

  it('só o admin altera permissões', () => {
    room.handle('bia', { t: 'setPerms', memberId: 'bia', perms: { pause: true, seek: true, media: true } });
    expect(room.members.get('bia')!.perms.pause).toBe(false);
    expect(errorsFor('bia')).toHaveLength(1);
  });

  it('retomar depois de uma pausa passa de novo pela barreira', () => {
    startPlaying();
    room.handle('admin', { t: 'cmd', action: 'pause', position: 30 });
    room.handle('admin', { t: 'cmd', action: 'play' });
    expect(room.playback).toMatchObject({ phase: 'syncing', position: 30 });
    report('admin');
    report('bia');
    expect(room.playback.phase).toBe('playing');
  });

  it('seek durante a reprodução ressincroniza no novo tempo', () => {
    startPlaying();
    room.handle('admin', { t: 'cmd', action: 'seek', position: 900 });
    expect(room.playback).toMatchObject({ phase: 'syncing', position: 900 });
  });

  it('quem entra no meio do filme faz todos esperarem por ele', () => {
    startPlaying();
    now += START_DELAY_MS + 10_000;
    room.add('caio', 'Caio');
    expect(room.playback.phase).toBe('syncing');
    expect(room.playback.position).toBeCloseTo(10, 5);
    report('admin');
    report('bia');
    expect(room.playback.phase).toBe('syncing');
    report('caio');
    expect(room.playback.phase).toBe('playing');
  });

  it('a saída de quem não estava pronto libera a sala', () => {
    room.handle('admin', { t: 'setMedia', media: { hash: HASH, title: 'Filme' } });
    report('admin');
    room.remove('bia', 'disconnected');
    expect(room.playback.phase).toBe('playing');
  });

  it('passa a sala adiante quando o admin sai', () => {
    room.remove('admin', 'disconnected');
    expect(room.adminId).toBe('bia');
    expect(room.members.get('bia')!.perms).toEqual({ pause: true, seek: true, media: true });
  });

  it('atualizar o título do mesmo vídeo não reinicia a sincronia', () => {
    startPlaying();
    const seq = room.playback.seq;
    room.handle('admin', { t: 'setMedia', media: { hash: HASH, title: 'Título novo' } });
    expect(room.playback.seq).toBe(seq);
    expect(room.media!.title).toBe('Título novo');
  });

  it('remover o vídeo deixa a sala ociosa', () => {
    startPlaying();
    room.handle('admin', { t: 'setMedia', media: null });
    expect(room.playback.phase).toBe('idle');
    expect(room.media).toBeNull();
  });

  it('expulsar remove o membro e o avisa', () => {
    room.handle('admin', { t: 'kick', memberId: 'bia' });
    expect(room.members.has('bia')).toBe(false);
    expect(sent.some((s) => s.to === 'bia' && s.msg.t === 'left' && s.msg.reason === 'kicked')).toBe(true);
  });
});

describe('parseClientMsg', () => {
  it('rejeita mensagens malformadas', () => {
    expect(parseClientMsg(null)).toBeNull();
    expect(parseClientMsg({ t: 'nope' })).toBeNull();
    expect(parseClientMsg({ t: 'cmd', action: 'explode' })).toBeNull();
    expect(parseClientMsg({ t: 'setMedia', media: { hash: 'https://evil.example/', title: '' } })).toBeNull();
    expect(parseClientMsg({ t: 'join', code: 123, name: 'x' })).toBeNull();
  });

  it('normaliza nome e código', () => {
    expect(parseClientMsg({ t: 'join', code: ' abc12 ', name: '   ' })).toEqual({ t: 'join', code: 'ABC12', name: 'Convidado' });
  });
});
