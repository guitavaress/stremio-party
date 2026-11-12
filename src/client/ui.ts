import { DEFAULT_ROOM_PORT, MemberView, Perms, RoomView } from '../protocol';
import { Net, normalizeServerUrl } from './net';

/** O que o launcher informa sobre o servidor de salas que roda neste PC. */
export interface HostInfo {
  /** URL para este PC criar a sala (loopback). */
  local: string;
  /** Endereço `ip:porta` que os amigos usam (IP Tailscale), se houver. */
  share: string | null;
}

export interface UiActions {
  /** O player local está no vídeo da sala? */
  onRoomMedia(): boolean;
  goToRoomMedia(): void;
}

const STORE_KEY = 'stremioParty';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "PlusJakartaSans", "Segoe UI", system-ui, sans-serif; }
.fab { position: fixed; right: 14px; top: 50%; transform: translateY(-50%); z-index: 2147483000;
  width: 44px; height: 44px; border-radius: 22px; border: 1px solid rgba(255,255,255,.18);
  background: #2a2843; color: #fff; font-size: 20px; cursor: pointer; opacity: .45; transition: opacity .15s; }
.fab:hover, .fab.open, .fab.live { opacity: 1; }
.fab.live { background: #7b5bf5; }
.panel { position: fixed; right: 68px; top: 50%; transform: translateY(-50%); z-index: 2147483000;
  width: 340px; max-height: 80vh; overflow: auto; padding: 16px; border-radius: 14px;
  background: #1b1a2e; color: #eceaf7; border: 1px solid rgba(255,255,255,.12);
  box-shadow: 0 12px 40px rgba(0,0,0,.55); font-size: 13px; line-height: 1.45; }
h2 { margin: 0 0 10px; font-size: 16px; font-weight: 600; }
h3 { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #a8a3c7; }
label { display: block; margin: 8px 0 4px; color: #a8a3c7; font-size: 12px; }
input[type=text] { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.16);
  background: #12111f; color: #fff; font-size: 13px; outline: none; }
input[type=text]:focus { border-color: #7b5bf5; }
button.btn { margin-top: 10px; width: 100%; padding: 9px 10px; border-radius: 8px; border: 0; cursor: pointer;
  background: #7b5bf5; color: #fff; font-size: 13px; font-weight: 600; }
button.btn.ghost { background: rgba(255,255,255,.08); font-weight: 500; }
button.btn:disabled { opacity: .5; cursor: default; }
.muted { color: #a8a3c7; }
.box { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: #12111f; word-break: break-all; }
.code { font-family: Consolas, monospace; font-size: 13px; color: #fff; user-select: all; }
.row { display: flex; align-items: center; gap: 8px; }
.member { padding: 8px 0; border-top: 1px solid rgba(255,255,255,.08); }
.member .name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { padding: 1px 7px; border-radius: 10px; font-size: 11px; background: rgba(255,255,255,.1); white-space: nowrap; }
.tag.ok { background: rgba(60,200,120,.2); color: #7be0a6; }
.tag.wait { background: rgba(240,170,60,.2); color: #f2c06f; }
.perms { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
.perms label { display: flex; align-items: center; gap: 5px; margin: 0; color: #eceaf7; cursor: pointer; }
.link { background: none; border: 0; padding: 0; color: #a99bff; cursor: pointer; font-size: 12px; }
.banner { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); z-index: 2147483000;
  padding: 8px 16px; border-radius: 20px; background: rgba(27,26,46,.92); color: #fff; font-size: 13px;
  border: 1px solid rgba(255,255,255,.14); pointer-events: none; max-width: 80vw; text-align: center; }
.toast { position: fixed; left: 50%; bottom: 110px; transform: translateX(-50%); z-index: 2147483000;
  padding: 9px 16px; border-radius: 10px; background: #2a2843; color: #fff; font-size: 13px;
  border: 1px solid rgba(255,255,255,.16); max-width: 80vw; text-align: center; }
`;

export class UI {
  host: HostInfo | null = null;

  private readonly root: ShadowRoot;
  private readonly fab: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private open = false;
  private lastHtml = '';
  private toastTimer = 0;
  private lastToast = '';
  private lastToastAt = 0;
  private form = { name: '', invite: '', server: '' };
  /** Endereço (ip:porta ou URL) pelo qual entramos na sala atual, para montar o convite. */
  private joinedVia = '';

  constructor(
    private readonly net: Net,
    private readonly actions: UiActions,
  ) {
    try {
      Object.assign(this.form, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
    } catch {
      /* sem preferências salvas */
    }

    const el = document.createElement('div');
    el.id = 'stremio-party';
    this.root = el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.fab = document.createElement('button');
    this.fab.className = 'fab';
    this.fab.textContent = '👥';
    this.fab.title = 'Stremio Party';
    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    this.panel.hidden = true;
    this.banner = document.createElement('div');
    this.banner.className = 'banner';
    this.banner.hidden = true;
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';
    this.toastEl.hidden = true;
    this.root.append(style, this.fab, this.panel, this.banner, this.toastEl);

    // Digitar no painel não pode acionar os atalhos do Stremio (espaço = pause etc.).
    for (const type of ['keydown', 'keyup', 'keypress'] as const) el.addEventListener(type, (e) => e.stopPropagation());

    this.fab.addEventListener('click', () => {
      this.open = !this.open;
      this.render();
    });
    this.panel.addEventListener('input', (e) => this.onInput(e));
    this.panel.addEventListener('change', (e) => this.onChange(e));
    this.panel.addEventListener('click', (e) => this.onClick(e));

    const mount = () => document.body.appendChild(el);
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
    this.render();
  }

  toast(text: string): void {
    const now = Date.now();
    if (text === this.lastToast && now - this.lastToastAt < 2500) return;
    this.lastToast = text;
    this.lastToastAt = now;
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), 3500);
  }

  render(): void {
    const room = this.net.room;
    this.fab.classList.toggle('open', this.open);
    this.fab.classList.toggle('live', !!room);
    this.panel.hidden = !this.open;

    const bannerText = room ? this.bannerText(room) : '';
    this.banner.hidden = !bannerText;
    this.banner.textContent = bannerText;

    if (!this.open) return;
    const html = room ? this.roomHtml(room) : this.lobbyHtml();
    if (html === this.lastHtml) return; // não recria o DOM à toa (preserva foco e cliques)
    this.lastHtml = html;
    this.panel.innerHTML = html;
  }

  private lobbyHtml(): string {
    const busy = this.net.state === 'connecting';
    const dis = busy ? 'disabled' : '';
    const share = this.host?.share;
    return `
      <h2>Stremio Party</h2>
      <label>Seu apelido</label>
      <input type="text" data-f="name" maxlength="24" value="${esc(this.form.name)}" placeholder="Como os amigos vão te ver">

      <h3>Entrar em uma sala</h3>
      <label>Convite do admin</label>
      <input type="text" data-f="invite" value="${esc(this.form.invite)}" placeholder="100.x.y.z:${DEFAULT_ROOM_PORT}/ABCDE">
      <button class="btn" data-act="join" ${dis}>${busy ? 'Conectando…' : 'Entrar'}</button>

      <h3>Criar uma sala</h3>
      <div class="muted">${
        this.host
          ? share
            ? 'A sala fica neste PC e seus amigos entram pela rede Tailscale.'
            : 'Tailscale não encontrado neste PC: a sala só será alcançável por um servidor externo.'
          : 'Sem launcher local: informe um servidor de salas.'
      }</div>
      <label>Servidor externo (opcional)</label>
      <input type="text" data-f="server" value="${esc(this.form.server)}" placeholder="vazio = este PC">
      <button class="btn ghost" data-act="create" ${dis}>Criar sala</button>
    `;
  }

  private roomHtml(room: RoomView): string {
    const admin = this.net.isAdmin;
    const invite = `${this.joinedVia}/${room.code}`;
    const media = room.media;
    const away = !!media && !this.actions.onRoomMedia();
    const members = room.members.map((m) => this.memberHtml(room, m, admin)).join('');
    return `
      <h2>Sala ${esc(room.code)}</h2>
      <div class="muted">Convite para os amigos:</div>
      <div class="box"><span class="code">${esc(invite)}</span></div>
      <button class="link" data-act="copy" data-v="${esc(invite)}">Copiar convite</button>

      <h3>Vídeo</h3>
      <div>${media ? esc(media.title || 'Vídeo em reprodução') : '<span class="muted">Nenhum vídeo ainda.</span>'}</div>
      <div class="muted">${esc(this.phaseText(room))}</div>
      ${away ? '<button class="btn" data-act="goto">Ir para o vídeo da sala</button>' : ''}
      ${
        !media
          ? `<div class="muted" style="margin-top:6px">${
              this.net.perms.media
                ? 'Abra um filme e escolha o stream normalmente: ele será aberto para todos.'
                : 'Aguardando alguém com permissão escolher o filme.'
            }</div>`
          : ''
      }

      <h3>Membros (${room.members.length})</h3>
      ${members}
      <button class="btn ghost" data-act="leave">Sair da sala</button>
    `;
  }

  private memberHtml(room: RoomView, m: MemberView, iAmAdmin: boolean): string {
    const isAdmin = m.id === room.adminId;
    const you = m.id === this.net.myId ? ' (você)' : '';
    const st = this.memberState(room, m);
    const perm = (key: keyof Perms, label: string) =>
      `<label><input type="checkbox" data-perm="${key}" data-id="${esc(m.id)}" ${m.perms[key] ? 'checked' : ''}>${label}</label>`;
    const controls =
      iAmAdmin && !isAdmin
        ? `<div class="perms">${perm('pause', 'Pausar/retomar')}${perm('seek', 'Mudar o tempo')}${perm('media', 'Escolher filme')}</div>
           <div class="row" style="margin-top:6px">
             <button class="link" data-act="transfer" data-id="${esc(m.id)}">Tornar admin</button>
             <button class="link" data-act="kick" data-id="${esc(m.id)}">Remover</button>
           </div>`
        : !isAdmin
          ? `<div class="muted">${this.permsText(m.perms)}</div>`
          : '';
    return `
      <div class="member">
        <div class="row">
          <span class="name">${esc(m.name)}${you}</span>
          ${isAdmin ? '<span class="tag">admin</span>' : ''}
          ${st ? `<span class="tag ${st.ok ? 'ok' : 'wait'}">${st.text}</span>` : ''}
        </div>
        ${controls}
      </div>`;
  }

  private permsText(p: Perms): string {
    const list = [p.pause && 'pausar/retomar', p.seek && 'mudar o tempo', p.media && 'escolher filme'].filter(Boolean);
    return list.length ? `Pode: ${list.join(', ')}` : 'Só assiste';
  }

  /** Situação de um membro em relação ao estado atual da sala. */
  private memberState(room: RoomView, m: MemberView): { ok: boolean; text: string } | null {
    if (!room.media) return null;
    const s = m.status;
    const pb = room.playback;
    if (!s || s.seq !== pb.seq) return { ok: false, text: 'sincronizando' };
    if (!s.onMedia) return { ok: false, text: 'abrindo o vídeo' };
    if (pb.phase === 'syncing') return s.ready ? { ok: true, text: 'pronto' } : { ok: false, text: 'carregando' };
    if (pb.phase === 'playing') return s.buffering ? { ok: false, text: 'carregando' } : { ok: true, text: 'assistindo' };
    return { ok: true, text: 'pausado' };
  }

  private waitingFor(room: RoomView): string[] {
    return room.members.filter((m) => this.memberState(room, m)?.ok === false).map((m) => m.name);
  }

  private phaseText(room: RoomView): string {
    switch (room.playback.phase) {
      case 'syncing':
        return 'Sincronizando: toca quando todos estiverem prontos.';
      case 'playing':
        return 'Tocando para todos.';
      case 'paused':
        return 'Pausado para todos.';
      default:
        return '';
    }
  }

  private bannerText(room: RoomView): string {
    if (!room.media || room.playback.phase !== 'syncing') return '';
    const names = this.waitingFor(room);
    return names.length ? `Sincronizando… aguardando ${names.join(', ')}` : 'Sincronizando…';
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    const f = t.dataset?.f as keyof UI['form'] | undefined;
    if (!f) return;
    this.form[f] = t.value;
    // Mantém o HTML em cache coerente com o que foi digitado, para o próximo render não apagar.
    this.lastHtml = '';
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.form));
    } catch {
      /* armazenamento indisponível */
    }
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    const key = t.dataset?.perm as keyof Perms | undefined;
    const id = t.dataset?.id;
    if (!key || !id) return;
    const member = this.net.room?.members.find((m) => m.id === id);
    if (!member) return;
    this.net.setPerms(id, { ...member.perms, [key]: t.checked });
  }

  private onClick(e: Event): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const id = t.dataset.id || '';
    switch (t.dataset.act) {
      case 'join':
        return this.join();
      case 'create':
        return this.create();
      case 'leave':
        return this.net.leave();
      case 'goto':
        return this.actions.goToRoomMedia();
      case 'kick':
        return this.net.kick(id);
      case 'transfer':
        return this.net.transfer(id);
      case 'copy':
        navigator.clipboard?.writeText(t.dataset.v || '').then(
          () => this.toast('Convite copiado.'),
          () => this.toast('Não deu para copiar; selecione o texto do convite.'),
        );
        return;
    }
  }

  private name(): string {
    return this.form.name.trim() || 'Convidado';
  }

  private join(): void {
    const invite = this.form.invite.trim();
    const cut = invite.lastIndexOf('/');
    const code = cut >= 0 ? invite.slice(cut + 1).trim() : '';
    const addr = cut >= 0 ? invite.slice(0, cut) : '';
    const url = normalizeServerUrl(addr, DEFAULT_ROOM_PORT);
    if (!url || !/^[A-Za-z0-9]{4,8}$/.test(code)) {
      return this.toast(`Convite inválido. O formato é endereço/CÓDIGO, ex.: 100.64.0.1:${DEFAULT_ROOM_PORT}/ABCDE`);
    }
    this.joinedVia = addr.trim();
    this.net.join(url, this.name(), code);
  }

  private create(): void {
    const external = this.form.server.trim();
    if (external) {
      this.joinedVia = external;
      return this.net.create(normalizeServerUrl(external, DEFAULT_ROOM_PORT), this.name());
    }
    if (!this.host) return this.toast('Informe um servidor de salas para criar.');
    if (!this.host.share) this.toast('Tailscale não encontrado: seus amigos não vão alcançar esta sala.');
    this.joinedVia = this.host.share || this.host.local.replace(/^ws:\/\//, '');
    this.net.create(this.host.local, this.name());
  }
}
