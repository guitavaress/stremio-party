// Launcher: sobe um proxy local da interface do Stremio com o script da sala
// injetado, sobe o servidor de salas e abre o Stremio 5 apontando para o proxy.
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { DEFAULT_ROOM_PORT } from '../protocol';
import { startPartyServer } from '../server/server';

const UPSTREAM = 'web.stremio.com';
const UI_PORT = Number(process.env.PARTY_UI_PORT) || 11480;
const ROOM_PORT = Number(process.env.PARTY_ROOM_PORT) || DEFAULT_ROOM_PORT;
/** Porta do repasse para o servidor de streaming do Stremio (ver streamingRelay). */
const SS_PORT = Number(process.env.PARTY_SS_PORT) || 11482;
/** Servidor de streaming que o Stremio 5 sobe junto com o app. */
const STREMIO_SS_PORT = 11470;
const UI_ORIGIN = `http://127.0.0.1:${UI_PORT}`;
const SHELL_EXE = 'stremio-shell-ng.exe';
const INJECT = '<script src="/__party/client.js"></script>';

const args = process.argv.slice(2);
const noShell = args.includes('--no-shell');

function fail(message: string): never {
  console.error(`\n[Stremio Party] ${message}\n`);
  process.exit(1);
}

/** IP deste PC na rede Tailscale (faixa CGNAT 100.64.0.0/10), se houver. */
function tailscaleIp(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

function stremioDir(): string {
  const dir = process.env.STREMIO_DIR || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Stremio');
  if (!fs.existsSync(path.join(dir, SHELL_EXE))) {
    fail(`Stremio 5 não encontrado em ${dir}. Instale o Stremio ou defina STREMIO_DIR.`);
  }
  return dir;
}

function shellRunning(): boolean {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${SHELL_EXE}`, '/NH'], { encoding: 'utf8' });
    return out.toLowerCase().includes(SHELL_EXE);
  } catch {
    return false;
  }
}

function isIndex(url: string): boolean {
  const p = url.split('?')[0];
  return p === '/' || p === '/index.html';
}

/** Repassa a requisição para web.stremio.com; no index.html, injeta o script da sala. */
function proxy(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url || '/';
  const index = isIndex(url);
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: UPSTREAM };
  delete headers.origin;
  delete headers.referer;
  delete headers.connection;
  if (index) headers['accept-encoding'] = 'identity'; // precisamos do HTML em texto para injetar

  const up = https.request({ host: UPSTREAM, port: 443, path: url, method: req.method, headers }, (upRes) => {
    const out: http.OutgoingHttpHeaders = { ...upRes.headers };
    delete out['strict-transport-security'];
    delete out['content-security-policy'];
    delete out['content-security-policy-report-only'];
    const isHtml = String(upRes.headers['content-type'] || '').includes('text/html');
    if (!(index && isHtml && upRes.statusCode === 200)) {
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
      return;
    }
    const chunks: Buffer[] = [];
    upRes.on('data', (c) => chunks.push(c));
    upRes.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8');
      // Antes de qualquer script da página, para interceptar o player desde o início.
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + INJECT) : INJECT + html;
      const body = Buffer.from(html, 'utf8');
      delete out['content-encoding'];
      delete out['transfer-encoding'];
      out['content-length'] = body.length;
      out['cache-control'] = 'no-store';
      res.writeHead(200, out);
      res.end(body);
    });
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Stremio Party: não consegui alcançar ${UPSTREAM} (${e.message}). Verifique sua internet.`);
  });
  req.pipe(up);
}

/**
 * O servidor de streaming do Stremio só deixa páginas da própria Stremio lerem
 * suas respostas (CORS). Nossa interface vem de 127.0.0.1, então ela fala com
 * este repasse, que encaminha tudo para o servidor real e libera a leitura
 * apenas para a nossa página. Outros sites continuam barrados como antes.
 */
function streamingRelay(req: http.IncomingMessage, res: http.ServerResponse): void {
  const ours = req.headers.origin === UI_ORIGIN;
  if (ours && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': UI_ORIGIN,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || 'Range, Content-Type',
      'access-control-max-age': '1728000',
    });
    return void res.end();
  }
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${STREMIO_SS_PORT}` };
  if (ours) delete headers.origin;
  const up = http.request({ host: '127.0.0.1', port: STREMIO_SS_PORT, path: req.url, method: req.method, headers }, (upRes) => {
    const out: http.OutgoingHttpHeaders = { ...upRes.headers };
    if (ours) {
      out['access-control-allow-origin'] = UI_ORIGIN;
      out['access-control-expose-headers'] = 'Content-Range, Content-Length, Accept-Ranges';
    }
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, ours ? { 'access-control-allow-origin': UI_ORIGIN } : {});
    res.end();
  });
  // O player fecha a conexão ao pular no vídeo: encerra o pedido ao servidor também.
  res.on('close', () => up.destroy());
  req.pipe(up);
}

async function main(): Promise<void> {
  const clientPath = path.join(__dirname, 'client.js');
  if (!fs.existsSync(clientPath)) fail(`Arquivo ${clientPath} não encontrado. Rode "npm run build".`);

  const dir = noShell ? '' : stremioDir();
  if (!noShell && shellRunning()) {
    fail('O Stremio já está aberto. Feche-o (inclusive pelo ícone na bandeja do Windows) e rode de novo.');
  }

  const tsIp = tailscaleIp();
  const rooms = await startPartyServer({
    port: ROOM_PORT,
    hosts: tsIp ? ['127.0.0.1', tsIp] : ['127.0.0.1'],
    log: (s) => console.log(`[Stremio Party] ${s}`),
  });
  const localUp = rooms.addresses.includes(`127.0.0.1:${ROOM_PORT}`);
  const shareUp = !!tsIp && rooms.addresses.includes(`${tsIp}:${ROOM_PORT}`);
  const info = localUp
    ? { local: `ws://127.0.0.1:${ROOM_PORT}`, share: shareUp ? `${tsIp}:${ROOM_PORT}` : null }
    : null;

  const ui = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/__party/client.js') {
      // Lido a cada requisição: atualizar o arquivo não exige reabrir o launcher.
      fs.readFile(clientPath, (err, data) => {
        if (err) {
          res.writeHead(500);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(data);
      });
      return;
    }
    if (p === '/__party/info') {
      res.writeHead(info ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(info ?? {}));
    }
    proxy(req, res);
  });
  ui.on('error', (e: NodeJS.ErrnoException) => {
    fail(
      e.code === 'EADDRINUSE'
        ? `A porta ${UI_PORT} já está em uso (o Stremio Party já está rodando?).`
        : `Erro no proxy local: ${e.message}`,
    );
  });
  // Só loopback: o proxy nunca fica exposto na rede.
  await new Promise<void>((resolve) => ui.listen(UI_PORT, '127.0.0.1', resolve));

  const relay = http.createServer(streamingRelay);
  relay.on('error', (e: NodeJS.ErrnoException) => {
    fail(
      e.code === 'EADDRINUSE'
        ? `A porta ${SS_PORT} já está em uso (o Stremio Party já está rodando?).`
        : `Erro no repasse do servidor de streaming: ${e.message}`,
    );
  });
  await new Promise<void>((resolve) => relay.listen(SS_PORT, '127.0.0.1', resolve));

  // A interface troca o endereço do servidor de streaming quando recebe este parâmetro.
  const webui = `${UI_ORIGIN}/?streamingServerUrl=${encodeURIComponent(`http://127.0.0.1:${SS_PORT}/`)}`;
  console.log('[Stremio Party] Interface com a sala:', webui);
  if (!localUp) console.log('[Stremio Party] Servidor de salas local indisponível; use um servidor externo.');
  else if (shareUp) console.log(`[Stremio Party] Servidor de salas para os amigos (Tailscale): ${tsIp}:${ROOM_PORT}`);
  else console.log('[Stremio Party] Tailscale não encontrado: as salas criadas aqui só funcionam neste PC.');

  if (noShell) return;
  const child = spawn(path.join(dir, SHELL_EXE), [`--webui-url=${webui}`], { cwd: dir, stdio: 'ignore' });
  child.on('error', (e) => fail(`Não consegui abrir o Stremio: ${e.message}`));
  child.on('exit', () => {
    console.log('[Stremio Party] Stremio fechado; encerrando.');
    rooms.close();
    process.exit(0);
  });
  console.log('[Stremio Party] Stremio aberto. Mantenha esta janela aberta enquanto assiste.');
}

main().catch((e) => fail(e?.message || String(e)));
