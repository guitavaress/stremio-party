// Túnel rápido da Cloudflare (cloudflared): publica o servidor de salas deste PC
// em um endereço wss://….trycloudflare.com, para os amigos entrarem sem Tailscale.
import { ChildProcess, execFileSync, spawn } from 'child_process';
import dns from 'dns';
import fs from 'fs';
import path from 'path';

const EXE = 'cloudflared.exe';
// O log também cita api.trycloudflare.com quando o pedido do túnel falha; esse não é o nosso endereço.
const URL_RE = /https:\/\/(?!api\.)([a-z0-9-]+\.trycloudflare\.com)/i;
const READY_RE = /Registered tunnel connection/i;
const TIMEOUT_MS = 30_000;
const DNS_WAIT_MS = 20_000;

/** Extrai o endereço público de uma linha do log do cloudflared, já como `wss://`. */
export function parseTunnelUrl(line: string): string | null {
  const m = URL_RE.exec(line);
  return m ? `wss://${m[1].toLowerCase()}` : null;
}

/** Procura o cloudflared: variável PARTY_CLOUDFLARED, pasta do launcher, depois o PATH. */
export function findCloudflared(): string | null {
  const fromEnv = process.env.PARTY_CLOUDFLARED;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  const beside = path.join(__dirname, EXE);
  if (fs.existsSync(beside)) return beside;
  try {
    const out = execFileSync('where', ['cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * O endereço leva alguns segundos para existir no DNS depois que o túnel sobe.
 * Quem consulta antes disso guarda a falha em cache e passa minutos sem conseguir
 * entrar, então só entregamos o convite quando o nome já resolve. A consulta vai
 * direto a resolvedores públicos para não sujar o cache deste PC.
 */
async function waitForDns(host: string): Promise<void> {
  const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const deadline = Date.now() + DNS_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await resolver.resolve4(host)).length) return;
    } catch {
      /* ainda não publicado */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let proc: ChildProcess | null = null;
let pending: Promise<string> | null = null;

/**
 * Abre o túnel para a porta local e devolve o endereço `wss://`. Há no máximo um
 * túnel por launcher: chamadas repetidas recebem o mesmo endereço.
 */
export function openTunnel(exe: string, port: number, log: (s: string) => void = () => {}): Promise<string> {
  if (pending) return pending;

  const p = new Promise<string>((resolve, reject) => {
    const child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc = child;
    let url: string | null = null;
    let ready = false;
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(url as string);
    };
    const forget = () => {
      if (proc !== child) return;
      proc = null;
      pending = null;
    };

    const timer = setTimeout(() => {
      // O formato do log pode mudar: se o endereço já saiu, confia nele mesmo sem a confirmação.
      if (url) return finish();
      forget();
      child.kill();
      finish(new Error('o cloudflared não respondeu a tempo'));
    }, TIMEOUT_MS);

    const onLine = (line: string) => {
      url = url ?? parseTunnelUrl(line);
      // O endereço aparece antes de o túnel aceitar conexões; espera a confirmação.
      if (READY_RE.test(line)) ready = true;
      if (url && ready) finish();
    };
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? '';
        lines.forEach(onLine);
      });
    }

    child.on('error', (e) => {
      forget();
      finish(new Error(`não consegui executar o cloudflared (${e.message})`));
    });
    child.on('exit', (code) => {
      // Túnel caiu: libera o estado para a próxima sala abrir um novo.
      forget();
      if (settled) log('Túnel da Cloudflare encerrado.');
      finish(new Error(`o cloudflared encerrou (código ${code ?? '?'})`));
    });
  });

  const live = p.then(async (url) => {
    await waitForDns(url.replace(/^wss:\/\//, ''));
    return url;
  });
  live.catch(() => {});
  pending = live;
  return live;
}

export function closeTunnel(): void {
  const child = proc;
  proc = null;
  pending = null;
  if (child) child.kill();
}
