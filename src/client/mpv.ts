// Ponte com o player mpv do Stremio 5.
//
// A interface do Stremio fala com o shell por `window.chrome.webview`:
//   página → shell: postMessage(JSON.stringify({id:0, type:6, args:[evento, ...args]}))
//   shell → página: evento "message" com {type:1, args:[evento, dados]}
// Envolvemos o postMessage para enxergar (e poder barrar) os comandos que a
// interface manda ao player, e escutamos as mudanças de propriedade do mpv.
// Comandos nossos vão pelo postMessage original, então não passam pelo filtro.

const INVOKE_METHOD = 6;
const SIGNAL = 1;

export interface MpvState {
  time: number | null;
  pause: boolean;
  pausedForCache: boolean;
  seeking: boolean;
  /** Tempo do vídeo até onde o buffer alcança (segundos). */
  cacheTime: number;
  duration: number;
  speed: number;
  /** Date.now() do último `loadfile` enviado pela interface. */
  loadAt: number;
  /** Date.now() em que `pausedForCache` passou a ser true (0 se não está). */
  stallAt: number;
}

/** Decide se um `mpv-set-prop` vindo da interface do Stremio pode seguir para o player. */
export type UserSetFilter = (name: string, value: unknown) => boolean;

export class Mpv {
  readonly state: MpvState = {
    time: null,
    pause: false,
    pausedForCache: false,
    seeking: false,
    cacheTime: 0,
    duration: 0,
    speed: 1,
    loadAt: 0,
    stallAt: 0,
  };
  /** false no navegador comum (sem shell): o lobby funciona, o controle do player não. */
  readonly available: boolean;
  filter: UserSetFilter = () => true;
  onChange: () => void = () => {};

  private readonly webview: any;
  private readonly post: ((data: string) => void) | null = null;

  constructor() {
    this.webview = (window as any).chrome?.webview;
    this.available = !!this.webview && typeof this.webview.postMessage === 'function';
    if (!this.available) return;

    const original = this.webview.postMessage.bind(this.webview);
    this.post = original;
    const wrapped = (data: unknown) => {
      if (this.allow(data)) original(data);
    };
    try {
      this.webview.postMessage = wrapped;
    } catch {
      /* tenta defineProperty abaixo */
    }
    if (this.webview.postMessage !== wrapped) {
      try {
        Object.defineProperty(this.webview, 'postMessage', { value: wrapped, configurable: true, writable: true });
      } catch (e) {
        console.error('[party] não consegui interceptar o player; ações locais não serão compartilhadas', e);
      }
    }
    this.webview.addEventListener('message', (e: MessageEvent) => this.onMessage(e.data));
    // A interface só observa estas propriedades depois de abrir o player; pedir de novo é inofensivo.
    for (const p of ['time-pos', 'pause', 'paused-for-cache', 'seeking', 'demuxer-cache-time', 'duration', 'speed']) {
      this.send('mpv-observe-prop', p);
    }
  }

  set(name: 'pause' | 'time-pos' | 'speed', value: boolean | number): void {
    this.send('mpv-set-prop', [name, value]);
  }

  private send(event: string, arg: unknown): void {
    try {
      this.post?.(JSON.stringify({ id: 0, type: INVOKE_METHOD, args: [event, arg] }));
    } catch (e) {
      console.error('[party] falha ao enviar comando ao player', e);
    }
  }

  /** Filtra o que a interface do Stremio manda ao shell. */
  private allow(data: unknown): boolean {
    if (typeof data !== 'string') return true;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return true;
    }
    if (!msg || msg.type !== INVOKE_METHOD || !Array.isArray(msg.args)) return true;
    const [event, arg] = msg.args;
    if (event === 'mpv-command' && Array.isArray(arg)) {
      if (arg[0] === 'loadfile') {
        this.state.loadAt = Date.now();
        this.state.time = null;
        this.state.duration = 0;
        this.state.cacheTime = 0;
      } else if (arg[0] === 'stop') {
        this.state.time = null;
        this.state.duration = 0;
      }
      return true;
    }
    if (event === 'mpv-set-prop' && Array.isArray(arg) && typeof arg[0] === 'string') {
      try {
        return this.filter(arg[0], arg[1]);
      } catch (e) {
        console.error('[party] erro no filtro de comandos', e);
        return true;
      }
    }
    return true;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || msg.type !== SIGNAL || !Array.isArray(msg.args) || msg.args[0] !== 'mpv-prop-change') return;
    const prop = msg.args[1];
    if (!prop || typeof prop.name !== 'string') return;
    const s = this.state;
    const v = prop.data;
    switch (prop.name) {
      case 'time-pos':
        s.time = typeof v === 'number' && isFinite(v) ? v : null;
        break;
      case 'pause':
        s.pause = !!v;
        break;
      case 'paused-for-cache':
        s.pausedForCache = !!v;
        s.stallAt = s.pausedForCache ? s.stallAt || Date.now() : 0;
        break;
      case 'seeking':
        s.seeking = !!v;
        break;
      case 'demuxer-cache-time':
        s.cacheTime = typeof v === 'number' && isFinite(v) ? v : 0;
        break;
      case 'duration':
        s.duration = typeof v === 'number' && isFinite(v) ? v : 0;
        break;
      case 'speed':
        s.speed = typeof v === 'number' && isFinite(v) ? v : 1;
        break;
      default:
        return;
    }
    this.onChange();
  }
}
