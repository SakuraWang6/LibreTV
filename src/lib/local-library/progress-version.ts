/** A delayed catalog response must not undo a save already acknowledged by the server. */
export function canAdoptLibraryProgressVersion(incoming?: string, confirmed?: string): boolean {
  const known = Date.parse(confirmed || '');
  if (!Number.isFinite(known)) return true;
  const candidate = Date.parse(incoming || '');
  return Number.isFinite(candidate) && candidate >= known;
}
