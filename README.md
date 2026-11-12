# Stremio Party

Watch party para o **Stremio 5 no Windows**: uma sala, o mesmo filme, play/pause/seek compartilhados entre amigos.

- O admin escolhe o filme e o stream normalmente no Stremio; ele abre para todos.
- Cada PC baixa e cacheia pelo próprio Stremio.
- O vídeo só toca quando **todos** estão no mesmo ponto e com buffer. Se alguém travar, pausa para todos.
- O admin decide, por membro, quem pode pausar/retomar, mudar o tempo e escolher o filme.

Não altera a instalação do Stremio: um launcher abre o Stremio oficial apontando para uma cópia local da interface com o painel da sala.

> Projeto independente, sem vínculo com a Stremio. Use com conteúdo que você tem direito de assistir.

## Requisitos

- Windows com [Stremio 5](https://www.stremio.com/downloads) instalado no local padrão.
- [Tailscale](https://tailscale.com/) conectado, com todos na mesma rede (tailnet), ou um servidor de salas externo (veja abaixo).
- Node.js 18+ só para quem for gerar a pasta `dist`. Quem só usa não precisa instalar nada.

## Gerar a pasta `dist`

```
npm install
npm run build
```

Mande a pasta `dist` para os amigos (ela tem tudo: `StremioParty.cmd`, `party.js`, `client.js`, `server.js`).

## Usar

1. Feche o Stremio, inclusive o ícone da bandeja.
2. Abra `dist\StremioParty.cmd` e deixe a janela preta aberta enquanto assiste.
3. Na primeira vez, entre na sua conta do Stremio de novo. O login daqui é separado do Stremio normal; ao entrar, seus addons vêm junto.

**Admin:** botão 👥 na lateral direita → apelido → *Criar sala* → *Copiar convite* e mande aos amigos. Depois abra o filme e escolha o stream (ou cole um magnet na busca).

**Amigos:** botão 👥 → apelido → cole o convite (`100.x.y.z:11481/ABCDE`) → *Entrar*.

Quem não tem permissão e tenta mexer no player recebe um aviso e nada muda. Os amigos não precisam ter os mesmos addons do admin: o convite do vídeo já carrega o stream escolhido.

Se o Windows perguntar sobre o firewall para `stremio-runtime.exe`, permita em redes privadas (é o servidor da sala, no PC do admin).

## Como funciona

O launcher (`dist/party.js`) roda com o Node que já vem no Stremio (`stremio-runtime.exe`) e abre:

| Porta | Onde escuta | O que é |
|---|---|---|
| 11480 | 127.0.0.1 | Interface do Stremio (proxy de `web.stremio.com`) com `client.js` injetado |
| 11482 | 127.0.0.1 | Repasse para o servidor de streaming do Stremio (11470), que só aceita páginas da própria Stremio |
| 11481 | 127.0.0.1 e IP Tailscale | Servidor de salas (WebSocket) |

`client.js` intercepta as mensagens entre a interface e o player (mpv) para aplicar o estado da sala e transformar play/pause/seek do usuário em comandos da sala. O servidor de salas é autoritativo: valida permissões e só libera o play quando todos reportam prontos.

## Desenvolvimento

```
npm test                      # máquina de sincronia do servidor
npm run typecheck
npm run build
npm start                     # launcher com o Node do sistema
node scripts/e2e-server.mjs   # dois clientes simulados (launcher rodando)
node scripts/e2e-real.mjs     # Stremio real como admin + membro simulado
```

`scripts/e2e-real.mjs` controla o Stremio pela depuração remota do WebView2. Abra o launcher assim antes:

```
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
npm start
```

Variáveis do launcher: `STREMIO_DIR`, `PARTY_UI_PORT`, `PARTY_ROOM_PORT`, `PARTY_SS_PORT`. Com `--no-shell` ele sobe só os servidores.

## Limitações conhecidas

- Só Windows com Stremio 5 oficial.
- Em sala, a velocidade fica em 1x.
- Um vídeo novo sempre começa do zero para a sala; para continuar de onde pararam, o admin dá seek.
- Quem cai e reconecta volta sem as permissões que tinha. Se o admin cair, a sala passa para outro membro.
- O nome do filme no painel depende dos nomes de classe da interface do Stremio; se mudarem, aparece "Vídeo em reprodução".

## Servidor de salas externo (sem Tailscale)

`dist/server.js` é o servidor de salas sozinho (`PORT` e `HOST` por variável de ambiente). Publicado em um serviço como Render ou Fly.io, basta preencher *Servidor externo* ao criar a sala (`wss://seu-servidor`), e os amigos não precisam de Tailscale. Ainda não foi testado em nuvem.
