// Shared app state with a tiny pub/sub.

export const state = {
  config: null,
  session: null,       // {address, signer: 'freighter' | 'dev'} while signed in
  me: null,            // last GET /api/me
  account: null,       // last GET /api/account
  agents: null,        // last GET /api/agents items
  agentsAt: 0,         // Date.now() when agents were fetched (for countdowns)
  payments: null,      // last GET /api/payments items (dashboard filter applied)
  payFilter: '',       // dashboard payments filter: '' = all agents
  chatAgent: null,     // agent id selected in the chat
};

const subs = new Map();

export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}

export function emit(evt, payload) {
  for (const fn of subs.get(evt) || []) {
    try { fn(payload); } catch (e) { console.warn('[state]', evt, e); }
  }
}

export const explorer = (kind, id) => {
  const base = (state.config && state.config.explorer) || 'https://stellar.expert/explorer/testnet';
  return `${base.replace(/\/$/, '')}/${kind}/${id}`;
};

export const accountUrl = (addr) => (addr && addr[0] === 'C' ? explorer('contract', addr) : explorer('account', addr));

export const agentById = (id) => (state.agents || []).find((a) => a.id === id) || null;

/** Default period in ledgers from config (17280 ≈ 1 day). */
export const periodLedgers = () => (state.config && state.config.period_ledgers) || 17280;
export const ledgerSeconds = () => (state.config && state.config.ledger_seconds) || 5;
