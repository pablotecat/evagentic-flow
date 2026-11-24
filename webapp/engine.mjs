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
  };
}
