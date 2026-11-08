/** A remembered choice is only a preference; the current server list must still authorize it. */
export function readWorkspaceChoice(storage: Storage, did: string, personal: string): string {
  try {
    const saved = JSON.parse(storage.getItem(`ephyra.workspace:${did}`) ?? "null");
    if (typeof saved?.id !== "string" || saved.id.length > 200 || !saved.id) return personal;
    return saved.id === saved.personal ? personal : saved.id;
  } catch { return personal; }
}
export function rememberWorkspace(storage: Storage, did: string, personal: string, id: string) {
  try { storage.setItem(`ephyra.workspace:${did}`, JSON.stringify({ personal, id })); } catch { /* Memory only. */ }
}
