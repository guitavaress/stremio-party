// Sessão completa: Stremio real (admin, via CDP) + um membro simulado.
import zlib from 'zlib';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failed++; };

// --- CDP
const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (cdp.onopen = r));
let id = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const js = (expression) => new Promise((r) => { const i = ++id; pending.set(i, (m) => r(m.result?.result?.value ?? JSON.stringify(m.result?.exceptionDetails ?? m))); cdp.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
const ROOT = `document.getElementById('stremio-party').shadowRoot`;
const uiSend = (ev, arg) => js(`window.chrome.webview.postMessage(${JSON.stringify(JSON.stringify({ id: 0, type: 6, args: [ev, arg] }))})`);

// --- admin cria a sala pelo painel
await js(`(() => { const r = ${ROOT}; if (r.querySelector('.panel').hidden) r.querySelector('.fab').click(); const n = r.querySelector('[data-f=name]'); n.value = 'Admin real'; n.dispatchEvent(new Event('input', { bubbles: true })); const s = r.querySelector('[data-f=server]'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); r.querySelector('[data-act=create]').click(); })()`);
await wait(1500);
const code = await js(`(${ROOT}.querySelector('h2')?.textContent || '').replace('Sala ', '')`);
check('admin criou a sala pelo painel', /^[A-Z0-9]{5}$/.test(code), code);

// --- membro simulado
const sim = { room: null, id: null, errors: [] };
const ws = new WebSocket('ws://127.0.0.1:11481');
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'joined') { sim.id = m.you; sim.room = m.room; } else if (m.t === 'room') sim.room = m.room; else if (m.t === 'error') sim.errors.push(m.code); };
const send = (m) => ws.send(JSON.stringify(m));
const simStatus = (over = {}) => send({ t: 'status', status: { seq: sim.room.playback.seq, onMedia: true, ready: true, buffering: false, time: sim.room.playback.position, paused: true, cacheAhead: 9, ...over } });
const admin = () => sim.room.members.find((m) => m.id === sim.room.adminId);
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(100); } return false; };
send({ t: 'join', code, name: 'Bia (simulada)' });
await until(() => sim.room);
check('membro simulado entrou', sim.room?.members.length === 2);
check('painel do admin lista os dois', (await js(`${ROOT}.querySelectorAll('.member').length`)) === 2);

// --- admin abre um vídeo pela rota do player do Stremio
const stream = encodeURIComponent(zlib.deflateSync(JSON.stringify({ url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4' }), { level: 0 }).toString('base64'));
await js(`location.hash = '#/player/${stream}'`);
check('abrir o vídeo no admin o define para a sala', await until(() => sim.room.media?.hash === '#/player/' + stream, 5000), sim.room.playback.phase);
await wait(500); await uiSend('mpv-set-prop', ['volume', 0]);
const adminReady = await until(() => admin().status?.seq === sim.room.playback.seq && admin().status.ready, 30000);
check('player real carregou, ficou pausado no tempo alvo e reportou pronto', adminReady && admin().status.paused && sim.room.playback.phase === 'syncing', JSON.stringify(admin().status));
await wait(1500);
check('não toca enquanto o outro membro não está pronto', sim.room.playback.phase === 'syncing' && admin().status.paused);

simStatus();
await until(() => sim.room.playback.phase === 'playing', 3000);
const pb = { ...sim.room.playback };
await wait(4000);
const st = admin().status; const expected = pb.position + (Date.now() - pb.at) / 1000;
check('todos prontos → player real tocando', sim.room.playback.phase === 'playing' && st.paused === false && st.time > 1, JSON.stringify(st));
// O status chega com até 1s de atraso, então a tolerância aqui é folgada; a deriva fina é medida à parte.
check('tempo do player real acompanha o relógio da sala', Math.abs(st.time - expected) < 1.6, `time=${st.time} esperado≈${expected.toFixed(2)}`);

simStatus({ buffering: true, ready: false, paused: false, time: Math.max(0, expected - 1) });
await until(() => sim.room.playback.phase === 'syncing' && admin().status?.seq === sim.room.playback.seq && admin().status.paused, 5000);
check('buffering do outro membro pausa o player real', sim.room.playback.phase === 'syncing' && admin().status.paused, JSON.stringify(sim.room.playback));
const target = sim.room.playback.position;
await until(() => admin().status.ready, 8000);
check('player real voltou para o ponto de quem travou', Math.abs(admin().status.time - target) <= 0.7, `time=${admin().status.time} alvo=${target.toFixed(2)}`);
simStatus(); await until(() => sim.room.playback.phase === 'playing', 3000); await wait(2500);
check('retomou junto depois do buffering', sim.room.playback.phase === 'playing' && admin().status.paused === false);

// --- ações na interface do Stremio viram comandos da sala
await uiSend('mpv-set-prop', ['pause', true]);
await until(() => sim.room.playback.phase === 'paused', 3000);
check('pause na interface do admin pausa a sala', sim.room.playback.phase === 'paused');
await uiSend('mpv-set-prop', ['pause', false]); await wait(1200);
check('play do admin espera a barreira (não toca sozinho)', sim.room.playback.phase === 'syncing' && admin().status.paused);
simStatus(); await until(() => sim.room.playback.phase === 'playing', 3000); await wait(1500);
await uiSend('mpv-set-prop', ['time-pos', 30]);
await until(() => sim.room.playback.phase === 'syncing' && Math.abs(sim.room.playback.position - 30) < 0.01, 3000);
check('seek na interface do admin ressincroniza a sala em 30s', Math.abs(sim.room.playback.position - 30) < 0.01, JSON.stringify(sim.room.playback));
send({ t: 'cmd', action: 'pause' }); await wait(400);
check('membro sem permissão não pausa', sim.errors.includes('denied') && sim.room.playback.phase === 'syncing');

// --- admin concede permissão pelo painel
await js(`(() => { const c = ${ROOT}.querySelector('input[data-perm=pause]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await until(() => sim.room.members.find((m) => m.id === sim.id).perms.pause, 3000);
send({ t: 'cmd', action: 'pause', position: 30 }); await until(() => sim.room.playback.phase === 'paused', 3000);
check('com a permissão concedida no painel, o membro pausa a sala', sim.room.playback.phase === 'paused');

// --- encerrar
await uiSend('mpv-set-prop', ['volume', 100]);
await js(`location.hash = '#/'`);
check('admin sair do player encerra o vídeo da sala', await until(() => sim.room.media === null && sim.room.playback.phase === 'idle', 4000));
await js(`${ROOT}.querySelector('[data-act=leave]').click()`);
await until(() => sim.room.members.length === 1, 3000);
check('admin saiu da sala; o membro restante virou admin', sim.room.members.length === 1 && sim.room.adminId === sim.id);
ws.close(); cdp.close();
console.log(failed ? `\n${failed} falha(s)` : '\nTudo certo');
process.exit(failed ? 1 : 0);
