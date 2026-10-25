import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSupportedSource } from './source-config';
import { getEnvSources } from './env-sources';
import { parseSourceListPayload } from './source-list';

const cms = { key: 'cms', name: 'CMS', url: 'https://api.example.com/vod' };
afterEach(() => { vi.unstubAllEnvs(); });

describe('CMS source boundary compatibility', () => {
  it('accepts ordinary CMS sources and their old explicit cms marker', () => {
    expect(isSupportedSource(cms)).toBe(true);
    expect(isSupportedSource({ ...cms, kind: 'cms' })).toBe(true);
    expect(isSupportedSource({ ...cms, sourceKind: 'cms' })).toBe(true);
  });

  it.each([
    { ...cms, kind: 'libvio' }, { ...cms, sourceKind: 'libvio' },
    { ...cms, kind: 'unsupported' }, { ...cms, url: 'https://libvio.host' },
    { ...cms, url: 'https://www.libvio.app/' }, { ...cms, detail: 'https://libvio.to' },
    null, {}, { ...cms, url: '' }, { ...cms, url: 'javascript:alert(1)' },
  ])('rejects a retired or malformed source without converting it to CMS', (source) => {
    expect(isSupportedSource(source)).toBe(false);
  });

  it('filters retired environment sources while retaining original CMS keys', () => {
    vi.stubEnv('DEFAULT_SOURCES', JSON.stringify([
      { name: 'Retired', url: 'https://libvio.host', kind: 'libvio' },
      { name: 'CMS', url: cms.url, kind: 'cms' },
      { name: 'Old website', url: 'https://www.libvio.app/' },
      { name: 'Next CMS', url: 'https://another.example.com/vod' },
    ]));
    expect(getEnvSources()).toEqual([
      { key: 'env_1', name: 'CMS', url: cms.url, isAdult: false },
      { key: 'env_3', name: 'Next CMS', url: 'https://another.example.com/vod', isAdult: false },
    ]);
  });

  it('filters retired subscriptions without losing usable CMS entries', () => {
    const payload = parseSourceListPayload([
      { ...cms, kind: 'libvio' }, { ...cms, url: 'https://libvio.host' }, cms,
      { ...cms, url: 'https://other.example.com/vod', kind: 'cms' },
    ]);
    expect(payload.sources.map((source) => source.url)).toEqual([cms.url, 'https://other.example.com/vod']);
    expect(payload.sources.every((source) => !('kind' in source))).toBe(true);
  });
});
