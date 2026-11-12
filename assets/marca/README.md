# Marca do Stremio Party

Um play cercado por três arcos: o vídeo no centro e os amigos em volta. A roda só fecha, e o filme só toca, quando todos estão no mesmo ponto.

## Arquivos

| Arquivo | Uso |
|---|---|
| `icone.svg` | Atalho, favicon, avatar. É a versão para tamanhos abaixo de 24 px. |
| `simbolo.svg` | Fundo escuro: arcos roxos, play branco. |
| `simbolo-claro.svg` | Fundo claro: arcos roxos, play azul-noite. |
| `simbolo-mono.svg` | Uma cor só; herda a cor do texto (`currentColor`). |

Não há logo com o nome em SVG: o texto dependeria da fonte instalada em quem abre. Escreva o nome ao lado do símbolo, com **Stremio** em peso 500 e **Party** em peso 800 na cor lilás.

## Cores

São as que o painel da sala já usa (`src/client/ui.ts`).

| Nome | Hex | Papel |
|---|---|---|
| Roxo sala | `#7B5BF5` | Cor de ação: botões, ícone, sala ativa. |
| Lilás | `#A99BFF` | Destaque de texto e links em fundo escuro. |
| Azul-noite | `#1B1A2E` | Fundo do painel. |
| Azul-noite profundo | `#12111F` | Campos e caixas dentro do painel. |
| Superfície | `#2A2843` | Botão flutuante e avisos. |
| Névoa | `#ECEAF7` | Texto. |
| Texto secundário | `#A8A3C7` | Rótulos e explicações. |
| Pronto | `#7BE0A6` | Estado de um amigo, sempre com texto ao lado. |
| Aguardando | `#F2C06F` | Estado de um amigo, sempre com texto ao lado. |

Texto branco sobre o roxo só em negrito ou a partir de 16 px. Em fundo claro, escreva em azul-noite.

## Tipografia

Plus Jakarta Sans, a mesma família da interface do Stremio; reserva Segoe UI. Títulos em 800, nomes e títulos do painel em 600, texto em 400. Endereços e convites em Consolas.

## Uso

- Deixe em volta do símbolo uma margem livre igual à largura de um arco.
- Não gire, não estique e não troque as cores entre arcos e play.
- Voz: direta, em português do dia a dia, sem exclamação nem emoji.

Projeto independente, sem vínculo com a Stremio. O símbolo é próprio e não usa o logotipo da Stremio.
