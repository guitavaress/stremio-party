// Script injetado na interface do Stremio pelo launcher.
import { Mpv } from './mpv';
import { Net } from './net';
import { Sync } from './sync';
import { UI } from './ui';

const PLAYER_PREFIX = '#/player/';
/** Logo após abrir um vídeo a interface manda "despausar" sozinha; não é ação do usuário. */
const LOAD_GRACE_MS = 4000;

/**
 * Chama `cb` sempre que o endereço da página muda. O Stremio navega pelo
 * roteador (history.pushState/replaceState), que não dispara "hashchange",
 * então observamos as três formas e ainda conferimos periodicamente.
 */
function watchLocation(cb: () => void): void {
  let last = location.hash;
  const check = () => {
    if (location.hash === last) return;
    last = location.hash;
    cb();
  };
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      // Depois que o roteador terminar de processar a navegação.
      setTimeout(check, 0);
      return result;
    };
  }
  window.addEventListener('popstate', check);
  window.addEventListener('hashchange', check);
  window.setInterval(check, 500);
}

function start(): void {
  const w = window as any;
  if (w.__stremioParty) return;
  w.__stremioParty = true;

  const mpv = new Mpv();
  const net = new Net();
  const sync = new Sync(mpv, net);
  const ui = new UI(net, {
    onRoomMedia: () => sync.onRoomMedia(),
    goToRoomMedia: () => {
      const media = net.room?.media;
      if (media) location.hash = media.hash;
    },
  });

  /** Hash do vídeo da sala para o qual já navegamos (evita puxar o usuário de volta em loop). */
  let followed: string | null = null;
  let titleTimer = 0;

  /** Nome do vídeo, lido da barra do topo do player (o título da aba é sempre o genérico do Stremio). */
  const pageTitle = (): string => {
    // As classes têm um sufixo que muda a cada versão do Stremio, por isso a busca por trecho.
    const el = document.querySelector('[class*="horizontal-nav-bar-container"] [class*="title-"]');
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  };

  /** A sala mudou: acompanha o vídeo escolhido. */
  const followMedia = () => {
    const room = net.room;
    if (!room) {
      followed = null;
      return;
    }
    const media = room.media;
    if (media) {
      if (media.hash !== followed) {
        followed = media.hash;
        if (location.hash !== media.hash) {
          ui.toast('Abrindo o vídeo da sala…');
          location.hash = media.hash;
        }
      }
    } else if (followed) {
      // O vídeo da sala foi encerrado: sai do player junto.
      if (location.hash === followed) history.back();
      followed = null;
    }
  };

  /** O usuário navegou: se abriu (ou fechou) um vídeo, reflete na sala. */
  const onLocation = () => {
    const room = net.room;
    if (!room) return;
    const hash = location.hash;
    const media = room.media;
    if (hash.startsWith(PLAYER_PREFIX)) {
      if (media && media.hash === hash) return;
      if (net.perms.media) {
        followed = hash;
        net.setMedia({ hash, title: '' });
        // O nome só aparece depois que o player carrega os dados do filme: tenta algumas vezes.
        window.clearTimeout(titleTimer);
        let tries = 0;
        const sendTitle = () => {
          const current = net.room?.media;
          if (location.hash !== hash || current?.hash !== hash) return;
          const title = pageTitle();
          if (title && title !== current.title) net.setMedia({ hash, title });
          if (++tries < 8) titleTimer = window.setTimeout(sendTitle, 2500);
        };
        titleTimer = window.setTimeout(sendTitle, 1500);
      } else if (media) {
        ui.toast('Só quem tem permissão escolhe o filme da sala.');
        location.hash = media.hash;
      } else {
        ui.toast('Este vídeo não está sendo compartilhado: você não tem permissão para escolher o filme da sala.');
      }
    } else if (media && media.by === net.myId && net.perms.media) {
      // Quem escolheu o vídeo saiu do player: encerra para a sala.
      net.setMedia(null);
    }
    ui.render();
  };

  // Ações do usuário na interface do Stremio (play/pause/seek) viram comandos da sala.
  mpv.filter = (name, value) => {
    const room = net.room;
    if (!room || !room.media || !sync.onRoomMedia()) return true;
    const perms = net.perms;
    if (name === 'pause') {
      if (Date.now() - mpv.state.loadAt < LOAD_GRACE_MS) return value === true; // a sala decide quando tocar
      if (value === true) {
        if (!perms.pause) {
          ui.toast('Você não tem permissão para pausar.');
          return false;
        }
        net.cmd('pause', mpv.state.time ?? undefined);
        return true;
      }
      if (!perms.pause) ui.toast('Você não tem permissão para retomar.');
      else if (room.playback.phase === 'paused') net.cmd('play');
      return false; // quem solta o pause é a sala, quando todos estiverem prontos
    }
    if (name === 'time-pos') {
      if (typeof value !== 'number') return true;
      if (!perms.seek) {
        ui.toast('Você não tem permissão para mudar o tempo.');
        return false;
      }
      net.cmd('seek', value);
      return true;
    }
    if (name === 'speed') {
      if (value === 1) return true;
      ui.toast('Em sala, a velocidade fica em 1x para manter todos sincronizados.');
      return false;
    }
    return true;
  };

  mpv.onChange = () => sync.tick();
  net.onNotice = (text) => ui.toast(text);

  let wasInRoom = false;
  net.onUpdate = () => {
    followMedia();
    // Ao entrar numa sala já com um vídeo aberto, trata como se tivesse acabado de abri-lo.
    if (net.room && !wasInRoom) onLocation();
    wasInRoom = !!net.room;
    sync.tick();
    ui.render();
  };
  watchLocation(onLocation);

  fetch('/__party/info')
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (info && typeof info.local === 'string') {
        ui.host = { local: info.local, share: typeof info.share === 'string' ? info.share : null, tunnel: info.tunnel === true };
        ui.render();
      }
    })
    .catch(() => {
      /* sem launcher (ex.: página aberta direto): só servidor externo */
    });

  console.log('[party] Stremio Party carregado; player nativo:', mpv.available);
}

start();
