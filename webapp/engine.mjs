export function createEngine({ baseURL, password }) {
  const authorization = password ? `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` : null;
  const send = async (path, { method = 'GET', body, timeout = 10000, signal } = {}) => {
    const headers = authorization ? { authorization } : {};
    const init = {
      method,
      headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseURL}${path}`, init);
    const text = await response.text();
    return { ok: response.ok, status: response.status, data: text ? JSON.parse(text) : null };
  };
  return {
    async info() {
      try { return await send('/api/info', { timeout: 3000 }); }
      catch { return { ok: false, status: 0, data: null }; }
    },
    async createSession(payload, signal) {
      const result = await send('/api/session', { method: 'POST', body: payload, timeout: 30000, signal });
      if (!result.ok) throw new Error(`session creation failed: ${result.status}`);
      return result.data?.data ?? null;
    },
    async prompt(sessionID, text, signal) {
      const result = await send(`/api/session/${sessionID}/prompt`, { method: 'POST', body: { text }, timeout: 300000, signal });
      if (!result.ok) throw new Error(`prompt failed: ${result.status}`);
      return result.data?.data ?? null;
    },
    async scope(directory, rootID, knownIDs) {
      const get = async path => {
        const result = await send(path);
        if (!result.ok) throw new Error('cannot verify execution scope');
        return result.data?.data;
      };
      const [sessions, active] = await Promise.all([
        get(`/api/session?directory=${encodeURIComponent(directory)}`), get('/api/session/active'),
      ]);
      if (!Array.isArray(sessions) || !active || typeof active !== 'object') throw new Error('unknown execution scope');
      const ids = new Set([rootID, ...knownIDs]);
      for (let size = -1; size !== ids.size;) {
        size = ids.size;
        for (const session of sessions) if (ids.has(session.parentID)) ids.add(session.id);
      }
      const scoped = sessions.filter(session => ids.has(session.id));
      if (scoped.length !== ids.size) throw new Error('known session unavailable');
      const clear = await Promise.all(scoped.map(async session => {
        const [forms, permissions] = await Promise.all([
          get(`/api/session/${session.id}/form`), get(`/api/session/${session.id}/permission`),
        ]);
        return Array.isArray(forms) && forms.length === 0 && Array.isArray(permissions) && permissions.length === 0
          && !active[session.id] && ['succeeded', 'failed', 'interrupted'].includes(session.outcome);
      }));
      const [verified, finalActive] = await Promise.all([
        get(`/api/session?directory=${encodeURIComponent(directory)}`), get('/api/session/active'),
      ]);
      if (!Array.isArray(verified) || !finalActive || typeof finalActive !== 'object') throw new Error('unknown final scope');
      const stable = !verified.some(session => ids.has(session.parentID) && !ids.has(session.id))
        && [...ids].every(id => verified.some(session => session.id === id
          && ['succeeded', 'failed', 'interrupted'].includes(session.outcome)) && !finalActive[id]);
      return { sessionIDs: [...ids], clear: clear.every(Boolean) && stable };
    },
  };
}
