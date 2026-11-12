import { describe, expect, it } from 'vitest';
import { parseTunnelUrl } from '../src/launcher/tunnel';

describe('parseTunnelUrl', () => {
  it('extrai o endereço do quadro que o cloudflared imprime', () => {
    const line = '2026-11-12T20:01:02Z INF |  https://Quiet-river-example-words.trycloudflare.com                              |';
    expect(parseTunnelUrl(line)).toBe('wss://quiet-river-example-words.trycloudflare.com');
  });

  it('ignora linhas sem endereço', () => {
    expect(parseTunnelUrl('2026-11-12T20:01:03Z INF Registered tunnel connection connIndex=0 protocol=quic')).toBeNull();
    expect(parseTunnelUrl('')).toBeNull();
  });

  it('ignora links de outros domínios', () => {
    expect(parseTunnelUrl('INF Thank you for trying Cloudflare Tunnel. https://developers.cloudflare.com/cloudflare-one/')).toBeNull();
    expect(parseTunnelUrl('https://trycloudflare.com.exemplo.net')).toBeNull();
  });

  it('não confunde a API do serviço com o endereço do túnel', () => {
    const line = 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": timeout';
    expect(parseTunnelUrl(line)).toBeNull();
  });
});
