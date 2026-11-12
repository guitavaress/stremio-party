// Dois clientes simulados contra o servidor de salas real (porta 11481).
// Uso: node scripts/e2e-server.mjs [url] [espera em ms]
// Pelo túnel, passe a URL wss:// e uma espera maior (ex.: 800), por causa da latência.
const URL = process.argv[2] || 'ws://127.0.0.1:11481';
const STEP = Number(process.argv[3]) || 150;
const wait = (ms) => new Promise((r) => setTimeout(r, ms === 150 ? STEP : ms));
function client(label) {
  const ws = new WebSocket(URL);
  const c = { label, ws, room: null, id: null, errors: [], left: null };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'joined') { c.id = m.you; c.room = m.room; }
    else if (m.t === 'room') c.room = m.room;
    else if (m.t === 'error') c.errors.push(m.code);
    else if (m.t === 'left') c.left = m.reason;
  };
  c.send = (m) => ws.send(JSON.stringify(m));
  c.ready = (over = {}) => c.send({ t: 'status', status: { seq: c.room.playback.seq, onMedia: true, ready: true, buffering: false, time: c.room.playback.position, paused: true, cacheAhead: 9, ...over } });
  c.opened = new Promise((r) => (ws.onopen = r));
  return c;
}
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failed++; };

const a = client('admin'), b = client('bia');
await Promise.all([a.opened, b.opened]);
a.send({ t: 'create', name: 'Admin' }); await wait(150);
check('sala criada com código de 5 caracteres', /^[A-Z0-9]{5}$/.test(a.room?.code || ''), a.room?.code);
b.send({ t: 'join', code: 'ZZZZZ', name: 'Bia' }); await wait(150);
check('sala inexistente é recusada', b.errors.includes('no_room'));
b.send({ t: 'join', code: a.room.code.toLowerCase(), name: 'Bia' }); await wait(150);
check('entrou na sala (código em minúsculas)', b.room?.members.length === 2);

b.send({ t: 'setMedia', media: { hash: '#/player/x', title: 'X' } }); await wait(150);
check('membro sem permissão não escolhe filme', a.room.media === null && b.errors.includes('denied'));
a.send({ t: 'setMedia', media: { hash: '#/player/filme', title: 'Filme' } }); await wait(150);
check('admin escolhe o filme → sincronizando', b.room.media?.hash === '#/player/filme' && b.room.playback.phase === 'syncing');
a.ready(); await wait(150);
check('só um pronto → continua sincronizando', a.room.playback.phase === 'syncing');
b.ready(); await wait(150);
check('todos prontos → tocando, com início agendado', a.room.playback.phase === 'playing' && a.room.playback.at > Date.now() - 1000);

b.send({ t: 'cmd', action: 'pause', position: 3 }); await wait(150);
check('pause sem permissão é negado', a.room.playback.phase === 'playing');
a.send({ t: 'setPerms', memberId: b.id, perms: { pause: true, seek: false, media: false } }); await wait(150);
b.send({ t: 'cmd', action: 'pause', position: 3 }); await wait(150);
check('pause com permissão concedida', a.room.playback.phase === 'paused' && a.room.playback.position === 3);
b.send({ t: 'cmd', action: 'play' }); await wait(150);
a.ready(); b.ready(); await wait(150);
check('retomar passa pela barreira e volta a tocar', a.room.playback.phase === 'playing');
await wait(700);
b.ready({ buffering: true, ready: false, time: 3.2, paused: false }); await wait(150);
check('buffering de um membro pausa para todos', a.room.playback.phase === 'syncing' && Math.abs(a.room.playback.position - 3.2) < 0.01, JSON.stringify(a.room.playback));

b.ws.close(); await wait(200);
check('queda de membro o remove da sala', a.room.members.length === 1);
a.ready(); await wait(150);
check('sala segue sem quem caiu', a.room.playback.phase === 'playing');
a.ws.close();
await wait(100);
console.log(failed ? `\n${failed} falha(s)` : '\nTudo certo');
process.exit(failed ? 1 : 0);
