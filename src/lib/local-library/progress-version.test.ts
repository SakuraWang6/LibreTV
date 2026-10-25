import { describe, expect, it } from 'vitest';
import { canAdoptLibraryProgressVersion } from './progress-version';

describe('catalog progress versions after an acknowledged save', () => {
  const beforeSave = '2026-10-25T12:00:00.000Z';
  const confirmedSave = '2026-10-25T12:00:05.000Z';
  const laterSave = '2026-10-25T12:00:10.000Z';

  it('rejects a delayed older refresh after a pause has saved a newer position', () => {
    // The GET started at 90s; the subsequent pause at 100s was acknowledged
    // before that GET completed. Its older version must not trigger a seek.
    expect(canAdoptLibraryProgressVersion(beforeSave, confirmedSave)).toBe(false);
  });

  it('rejects missing or invalid versions when a successful save is already known', () => {
    expect(canAdoptLibraryProgressVersion(undefined, confirmedSave)).toBe(false);
    expect(canAdoptLibraryProgressVersion('', confirmedSave)).toBe(false);
    expect(canAdoptLibraryProgressVersion('invalid', confirmedSave)).toBe(false);
  });

  it('allows the confirmed save and genuinely newer progress, including an intentional rewind', () => {
    expect(canAdoptLibraryProgressVersion(confirmedSave, confirmedSave)).toBe(true);
    expect(canAdoptLibraryProgressVersion(laterSave, confirmedSave)).toBe(true);
  });

  it('keeps legacy records usable until a server version is known', () => {
    expect(canAdoptLibraryProgressVersion(beforeSave)).toBe(true);
    expect(canAdoptLibraryProgressVersion(undefined)).toBe(true);
    expect(canAdoptLibraryProgressVersion(beforeSave, 'invalid')).toBe(true);
  });
});
