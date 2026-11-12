# Guia para agentes

Watch party para o Stremio 5 (Windows). Leia o `README.md` para a visão de produto; este arquivo cobre o que não é óbvio pelo código.

## Comandos

```
npm test            # vitest: máquina de estados da sala
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/ (party.js, server.js, client.js, StremioParty.cmd)
```

Rode os três antes de dar uma mudança por pronta. `dist/` não é versionado.

## Estrutura

- `src/protocol.ts`: tipos das mensagens cliente↔servidor. Mudou aqui, mude `parseClientMsg` em `room.ts`.
- `src/server/room.ts`: estado autoritativo da sala, sem sockets (testável). `server.ts` é a casca WebSocket; `main.ts` é o servidor avulso.
- `src/client/`: script injetado na interface do Stremio. `mpv.ts` (ponte com o player), `net.ts` (conexão e relógio), `sync.ts` (aplica o estado no player e reporta status), `ui.ts` (painel em Shadow DOM), `main.ts` (liga tudo).
- `src/launcher/main.ts`: proxy da interface, repasse do servidor de streaming, servidor de salas, abre o shell.

## Restrições que mordem

- **O launcher roda no `stremio-runtime.exe`, que é Node 18.12.** O bundle usa `target: node18`; não use APIs de Node mais novas nem dependências nativas.
- **O Stremio navega por `history.pushState`**, que não dispara `hashchange`. Use `watchLocation` em `client/main.ts`; não escute `hashchange` direto.
- **O servidor de streaming do Stremio (11470) só libera CORS para origens da Stremio.** Por isso existe o repasse na 11482 e o parâmetro `?streamingServerUrl=` na URL. Não troque por `NO_CORS=1`: isso abriria o servidor para qualquer site.
- **Formato das mensagens do player** (`window.chrome.webview`): página → shell `{id:0, type:6, args:[evento, arg]}`; shell → página `{type:1, args:["mpv-prop-change", {name, data}]}`. Comandos nossos vão pelo `postMessage` original, para não passarem pelo próprio filtro.
- **Link do player**: `#/player/` + `encodeURIComponent(base64(zlib nível 0 do JSON do stream))`. A sala compartilha o `location.hash` inteiro; não tente reconstruí-lo.
- Logo após um `loadfile`, a interface manda `pause=false` sozinha. `LOAD_GRACE_MS` em `client/main.ts` evita tratar isso como ação do usuário.
- O painel só recria o DOM quando o HTML muda (`lastHtml`), para não perder foco e cliques. Não coloque nele valores que mudam a cada segundo.
- O proxy da interface e o repasse escutam só em `127.0.0.1`. Mantenha assim.

## Sincronia (resumo)

Fases da sala: `idle`, `syncing`, `playing`, `paused`. Toda mudança incrementa `playback.seq`, e o servidor ignora status de um `seq` antigo. Em `syncing` todos pausam no alvo e reportam `ready`; com todos prontos, o servidor marca `playing` com início em `agora + START_DELAY_MS`. Em `playing`, um membro travado (ou fora do vídeo) leva a sala de volta a `syncing` no tempo dele. `play` depois de `paused` também passa por `syncing`.

## Testar no app real

Nada disso roda em navegador comum (precisa do shell com mpv). O Stremio precisa estar fechado antes de abrir o launcher.

```
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
npm start
node scripts/e2e-real.mjs
```

`e2e-real.mjs` abre o vídeo com `location.hash`, então não cobre a navegação por clique na interface nem o lado do convidado em um segundo PC. Mudou algo nessa área, teste à mão.

## Convenções

- Código, comentários e textos da interface em português.
- Comentários explicam o porquê, não o quê.
- Sem dependências novas em runtime além de `ws` sem um bom motivo: o bundle vai para o PC dos amigos.
