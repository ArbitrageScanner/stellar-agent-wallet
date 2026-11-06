// HTTP + SSE client for the agentwallet API (see agentwallet/docs/API.md).
// URLs are relative so the UI also works under a path prefix.
//
// Every request uses credentials: 'same-origin' (the aw_session cookie) and
// every non-GET request sends "X-Agentwallet: 1" (the server's CSRF guard).
// A 401 from a session-protected endpoint calls the handler set with
// onUnauthorized(), which takes the UI back to the signed-out screen.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code || `http_${status}`;
    this.details = details ?? null;
  }
}

let unauthorized = null;
export function onUnauthorized(fn) { unauthorized = fn; }

async function errorFrom(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const e = body && body.error;
  if (e && typeof e === 'object') return new ApiError(res.status, e.code, e.message, e.details);
  return new ApiError(res.status, null, res.statusText || `HTTP ${res.status}`);
}

/**
 * fetch() wrapper. opts.public = true for endpoints that are not 🔒 (a 401
 * there does not sign the user out). Returns the Response.
 */
async function request(method, path, body, { signal, accept = 'application/json', public: isPublic = false } = {}) {
  const headers = { accept };
  const init = { method, headers, signal, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-Agentwallet'] = '1';
    if (method !== 'DELETE') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach the server');
  }
  if (!res.ok) {
    const err = await errorFrom(res);
    if (res.status === 401 && !isPublic && unauthorized) unauthorized(err);
    throw err;
  }
  return res;
}

const json = async (p) => {
  const res = await p;
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new ApiError(res.status, 'bad_response', 'The server returned invalid JSON'); }
};

export const get = (path, opts) => json(request('GET', path, undefined, opts));
export const post = (path, body, opts) => json(request('POST', path, body, opts));
export const del = (path, opts) => json(request('DELETE', path, undefined, opts));

const enc = encodeURIComponent;

export const api = {
  // public
  config: () => get('api/config', { public: true }),
  challenge: (address) => post('api/auth/challenge', { address }, { public: true }),
  login: (body) => post('api/auth/login', body, { public: true }),
  logout: () => post('api/auth/logout', {}, { public: true }),
  devFund: (address) => post('api/dev/fund', { address }, { public: true }),
  // 🔒
  me: () => get('api/me'),
  createAccount: () => post('api/account', {}),
  account: () => get('api/account'),
  testUsdc: (amount) => post('api/account/test-usdc/prepare', { amount }),
  fund: (amount) => post('api/account/fund/prepare', { amount }),
  withdraw: (amount) => post('api/account/withdraw/prepare', { amount }),
  submitOp: (opId, body) => post(`api/ops/${enc(opId)}/submit`, body),
  agents: () => get('api/agents'),
  addAgent: (body) => post('api/agents/prepare', body),
  setLimit: (id, dailyLimit) => post(`api/agents/${enc(id)}/limit/prepare`, { daily_limit: dailyLimit }),
  revoke: (id) => post(`api/agents/${enc(id)}/revoke/prepare`, {}),
  restore: (id) => post(`api/agents/${enc(id)}/restore/prepare`, {}),
  createKey: (id) => post(`api/agents/${enc(id)}/keys`, {}),
  revokeKey: (id, prefix) => del(`api/agents/${enc(id)}/keys/${enc(prefix)}`),
  payments: ({ agent = null, limit = 20 } = {}) => get(`api/payments?${agent ? `agent=${enc(agent)}&` : ''}limit=${limit}`),
  models: () => get('api/models'),
  conversation: (id) => get(`api/conversations/${enc(id)}`),
  approve: (conv, approval, approve) => post(`api/chat/${enc(conv)}/approvals/${enc(approval)}`, { approve }),
};

/**
 * POST /api/chat and yield {event, data} objects as they arrive.
 * Throws ApiError for non-2xx responses and AbortError when the signal fires.
 */
export async function* chatStream(body, signal) {
  const res = await request('POST', 'api/chat', body, { signal, accept: 'text/event-stream' });
  if (!res.body) throw new ApiError(res.status, 'no_body', 'Empty response from the server');
  yield* parseSSE(res.body);
}

/** Minimal text/event-stream parser (event, data, multi-line data, comments, CRLF). */
export async function* parseSSE(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data = [];
  const flush = function* () {
    if (data.length) {
      const raw = data.join('\n');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
      yield { event, data: parsed };
    }
    event = 'message';
    data = [];
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        if (line === '') { yield* flush(); continue; }
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        let val = i < 0 ? '' : line.slice(i + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val || 'message';
        else if (field === 'data') data.push(val);
      }
    }
    buf += dec.decode();
    if (buf) {
      // Unterminated trailing line.
      const m = /^data: ?(.*)$/.exec(buf);
      if (m) data.push(m[1]);
    }
    yield* flush();
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/** Human-readable text for an ApiError. */
export function describeError(err) {
  if (!err) return 'Unknown error';
  if (err.status === 401) return 'Your session has ended. Sign in again.';
  if (err.status === 403 && err.code === 'csrf') return 'The request was blocked by the CSRF guard (403).';
  if (err.status === 403) return err.message && err.message !== 'Forbidden' ? err.message : 'Access denied (403).';
  if (err.code === 'network') return 'Cannot reach the server. Check that agentwallet is running.';
  return err.message || String(err);
}
