import { describe, expect, it } from 'vitest';
import { buildMediaProxyUrl, mediaContextHeaders, mediaProxyPrefix, parseMediaContext } from './media-context';

describe('public media source context', () => {
  it('accepts only the fixed public LIBVIO context, never arbitrary headers or cookies', () => {
    expect(parseMediaContext(undefined)).toBeUndefined();
    expect(parseMediaContext('libvio')).toBe('libvio');
    expect(mediaContextHeaders('libvio')).toEqual({ Referer: 'https://libvio.host/' });
    expect(mediaContextHeaders()).toEqual({});
    for (const value of [null, '', 'https://attacker.example', { Referer: 'https://attacker.example', Cookie: 'secret' }]) {
      expect(() => parseMediaContext(value)).toThrow('不支持');
    }
  });

  it('keeps default playback direct and uses one proxy layer for contextual media', () => {
    const original = 'https://cdn.example/movie.mp4?a=1&b=2';
    expect(buildMediaProxyUrl(original)).toBe(original);
    expect(buildMediaProxyUrl(original, 'libvio')).toBe(`${mediaProxyPrefix('libvio')}${encodeURIComponent(original)}`);
    const proxied = `/api/proxy?url=${encodeURIComponent(original)}`;
    const result = new URL(buildMediaProxyUrl(proxied, 'libvio'), 'https://local.example');
    expect(result.searchParams.get('url')).toBe(original);
    expect(result.searchParams.get('mediaContext')).toBe('libvio');
    expect(buildMediaProxyUrl(buildMediaProxyUrl(original, 'libvio'), 'libvio')).toBe(buildMediaProxyUrl(original, 'libvio'));
  });
});
