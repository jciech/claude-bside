// The anonymous listener id and the server-signed token that lets a returning listener keep their
// trust. Stored in localStorage when it is available; otherwise the identity lasts for the page.

const ID_KEY = 'bside.anonId';
const TOKEN_KEY = 'bside.token';
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface Identity {
  anonId: string;
  token(): string | null;
  setToken(token: string): void;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Quota or privacy mode: keep it in memory only.
  }
}

export function loadIdentity(storage: Storage | null): Identity {
  const stored = read(storage, ID_KEY);
  const anonId = stored && ID_PATTERN.test(stored) ? stored : randomId();
  if (anonId !== stored) write(storage, ID_KEY, anonId);
  let token = read(storage, TOKEN_KEY);
  if (token !== null && token.length > 200) token = null;
  return {
    anonId,
    token: () => token,
    setToken(next) {
      if (next === token || next.length > 200) return;
      token = next;
      write(storage, TOKEN_KEY, next);
    },
  };
}
