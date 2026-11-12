import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'fs';

mkdirSync('dist', { recursive: true });

// Node 18 = versão do stremio-runtime.exe, que executa o launcher nos PCs dos amigos.
const node = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', logLevel: 'info' };

await Promise.all([
  build({ ...node, entryPoints: ['src/launcher/main.ts'], outfile: 'dist/party.js' }),
  build({ ...node, entryPoints: ['src/server/main.ts'], outfile: 'dist/server.js' }),
  build({
    entryPoints: ['src/client/main.ts'],
    outfile: 'dist/client.js',
    bundle: true,
    platform: 'browser',
    target: 'chrome110',
    format: 'iife',
    logLevel: 'info',
  }),
]);

// Atalho para os amigos: usa o Node que já vem com o Stremio, sem instalar nada.
writeFileSync(
  'dist/StremioParty.cmd',
  [
    '@echo off',
    'title Stremio Party',
    'set "RT=%LOCALAPPDATA%\\Programs\\Stremio\\stremio-runtime.exe"',
    'if not exist "%RT%" (',
    '  echo Stremio 5 nao encontrado em %LOCALAPPDATA%\\Programs\\Stremio',
    '  pause',
    '  exit /b 1',
    ')',
    '"%RT%" "%~dp0party.js" %*',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n'),
);
