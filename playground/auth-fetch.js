/**
 * Same-origin KGM API authentication for Playground pages.
 * The master key is session-scoped and is never persisted in localStorage.
 */
(function () {
  const storageKey = "kgmAdminMasterKey";
  const legacyLocalKeys = ["kgm_master_api_key", "kgm_http_api_key"];
  const nativeFetch = window.fetch.bind(window);

  // One-time migrate old long-lived localStorage masters into session scope.
  try {
    if (!window.sessionStorage.getItem(storageKey)) {
      for (const legacy of legacyLocalKeys) {
        const value = window.localStorage.getItem(legacy);
        if (value && value.trim()) {
          window.sessionStorage.setItem(storageKey, value.trim());
          break;
        }
      }
    }
    for (const legacy of legacyLocalKeys) {
      window.localStorage.removeItem(legacy);
    }
  } catch {
    // Ignore private-mode / storage failures.
  }

  window.KGM_AUTH = {
    storageKey,
    hasMasterKey() {
      return Boolean(window.sessionStorage.getItem(storageKey));
    },
    setMasterKey(value) {
      window.sessionStorage.setItem(storageKey, String(value));
      for (const legacy of legacyLocalKeys) {
        window.localStorage.removeItem(legacy);
      }
    },
    clearMasterKey() {
      window.sessionStorage.removeItem(storageKey);
      for (const legacy of legacyLocalKeys) {
        window.localStorage.removeItem(legacy);
      }
    },
  };

  window.fetch = (input, init = {}) => {
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      window.location.href,
    );
    const masterKey = window.sessionStorage.getItem(storageKey);
    if (
      masterKey &&
      requestUrl.origin === window.location.origin &&
      requestUrl.pathname.startsWith("/v1/")
    ) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
      if (!headers.has("authorization") && !headers.has("x-api-key")) {
        headers.set("x-api-key", masterKey);
      }
      return nativeFetch(input, { ...init, headers });
    }
    return nativeFetch(input, init);
  };
})();
