/** Browser preferences must never block login, editing or sending. */
export const browserStorage = {
  getItem(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { window.localStorage.setItem(key, value); } catch { /* Optional preference. */ }
  },
  removeItem(key: string): void {
    try { window.localStorage.removeItem(key); } catch { /* Optional preference. */ }
  }
};
