// Onboarding (signed in, account not deployed yet): deploy, then fund.
// fundingPanel() is also used by the dashboard's "Add funds" modal.

import { api, describeError } from './api.js';
import { state, on, emit, accountUrl } from './state.js';
import { refreshAll, expectUsdc, balancesSyncing } from './data.js';
import { runOp, txLink } from './ops.js';
import { h, icon, ICONS, fmtAmount, normAmount, extLink, waitLine } from './util.js';
import { addrLine } from './widgets.js';
import { isModalOpen } from './modal.js';

let list;
let deploying = false;
let deployResult = null;
let deployError = null;
let fundingXlm = false;   // friendbot request in flight (it takes 10-20 s)
let xlmError = null;
let deployStartedAt = 0;
let goDashboard = () => {};

export function initOnboarding({ onDone }) {
  goDashboard = onDone;
  list = document.getElementById('onboarding-steps');
  // The funding panel updates itself; the step list is rebuilt only when the
  // deploy state or readiness (the account holds USDC) changes.
  const maybe = () => {
    if (document.body.dataset.view !== 'onboarding') return;
    if (renderedKey !== stepsKey()) renderOnboarding();
    else revealReady();
  };
  for (const evt of ['me', 'account', 'sync', 'modal-closed']) on(evt, maybe);
}

let renderedKey = null; // stepsKey() at the last render
let wasReady = false;
let revealPending = false; // scroll to the "ready" step once nothing covers it

function stepsKey() {
  const deployed = !!(state.me && state.me.account_deployed);
  return `${deployed}:${deployed && (Number(accountUsdc()) || 0) > 0}`;
}

/** Brings the "open the dashboard" step into view the first time the wallet is ready. */
function revealReady() {
  if (!revealPending || isModalOpen()) return;
  const cta = list && list.querySelector('[data-testid=onboarding-ready] [data-testid=onboarding-done]');
  if (!cta) return;
  revealPending = false;
  requestAnimationFrame(() => {
    cta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    cta.focus({ preventScroll: true });
  });
}

export function resetOnboarding() {
  renderedKey = null;
  wasReady = false;
  revealPending = false;
  deploying = false;
  deployResult = null;
  deployError = null;
}

export function renderOnboarding() {
  const me = state.me || {};
  const deployed = !!me.account_deployed;
  renderedKey = stepsKey();
  const accUsdc = deployed ? Number(accountUsdc()) || 0 : 0;
  const ready = deployed && accUsdc > 0;
  const cta = ready
    ? h('button', { class: 'btn btn-primary btn-lg', type: 'button', 'data-testid': 'onboarding-done', onClick: () => goDashboard() },
      icon(ICONS.wallet), ' Open the dashboard')
    : null;
  list.replaceChildren(...[
    stepCard(1, 'Create my agent wallet', deployed ? 'done' : 'active', deployStep(me, deployed)),
    stepCard(2, 'Fund it with test USDC', ready ? 'done' : deployed ? 'active' : 'todo', deployed ? fundingPanel() : h('p', { class: 'muted' }, 'Available once your smart account is deployed.')),
    stepCard(3, 'Add your agents', ready ? 'active' : 'todo', ready
      ? h('div', { class: 'stack', 'data-testid': 'onboarding-ready' },
        h('p', {}, h('b', {}, 'Your agent wallet is ready'), ` with ${fmtAmount(accUsdc)} USDC. Next, open the dashboard and add your first agent with a daily limit; you sign it once in your wallet and get the agent's API key.`),
        cta)
      : h('p', { class: 'muted' }, 'Once your agent wallet holds USDC, you add agents with daily limits in the dashboard.')),
    ready ? null : h('li', { class: 'steps-foot' },
      h('button', { class: 'btn btn-ghost', type: 'button', 'data-testid': 'onboarding-done', disabled: !deployed, onClick: () => goDashboard() },
        'Skip funding for now'),
      deployed ? h('span', { class: 'muted small' }, 'You can add funds later from the dashboard too.') : null)].filter(Boolean));
  // the moment the wallet becomes ready, bring the next step into view (after
  // the fund op's modal, which is usually still open, is closed)
  if (ready && !wasReady) revealPending = true;
  wasReady = ready;
  revealReady();
}

function stepCard(n, title, st, body) {
  return h('li', { class: 'step card', dataset: { state: st }, 'data-testid': `step-${n}` },
    h('div', { class: 'step-head' },
      h('span', { class: 'step-num', 'aria-hidden': 'true' }, st === 'done' ? icon(ICONS.check) : String(n)),
      h('h3', {}, title),
      st === 'done' ? h('span', { class: 'badge badge-ok' }, 'done') : null),
    h('div', { class: 'step-body' }, body));
}

function deployStep(me, deployed) {
  if (deployed) {
    return h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Your smart account is live. Rule 0 is a Delegated signer for your wallet, so only you can manage it.'),
      addrLine(me.account, me.account_url || accountUrl(me.account), 'account-address'),
      deployResult && deployResult.tx && deployResult.tx.hash ? h('div', { class: 'small' }, 'Deployment ', txLink(deployResult.tx)) : null);
  }
  const btn = h('button', { class: 'btn btn-primary', type: 'button', 'data-testid': 'create-account', disabled: deploying, onClick: deploy },
    [icon(ICONS.wallet), deploying ? ' Deploying…' : ' Create my agent wallet']);
  return h('div', { class: 'stack' },
    h('p', {}, 'We deploy an OpenZeppelin smart account for you on Stellar testnet. Its address is derived from your wallet address, and its admin rule (rule 0) is your wallet. The relayer pays the fee, so there is nothing to sign.'),
    me.account ? h('div', { class: 'muted small addr-preview' }, 'Your account address will be ', h('code', { title: me.account }, me.account)) : null,
    btn,
    deploying ? waitLine('Deploying your smart account on Stellar testnet…', [
      [0, 'Deploying a contract takes a little while: usually 15 to 40 seconds. The relayer submits it and waits for the ledger to confirm.'],
      [45_000, 'Taking longer than usual. The public testnet RPC is slow right now; keep this tab open, this step finishes on its own.'],
    ], { since: deployStartedAt, testid: 'deploy-progress' }) : null,
    deployError ? h('div', { class: 'res res-bad', role: 'alert', 'data-testid': 'deploy-error' }, icon(ICONS.alert), h('span', {}, describeError(deployError))) : null);
}

async function getTestXlm() {
  if (fundingXlm) return;
  fundingXlm = true;
  xlmError = null;
  renderOnboarding();
  try {
    const r = await api.friendbot();
    if (r && r.wallet && r.wallet.funded && state.me) { state.me.wallet = r.wallet; emit('me', state.me); }
    await refreshAll();
  } catch (e) {
    xlmError = e;
  } finally {
    fundingXlm = false;
    renderOnboarding();
  }
}

async function deploy() {
  if (deploying) return;
  deploying = true;
  deployStartedAt = Date.now();
  deployError = null;
  state.onboarding = true; // stay here for the funding step after the deploy
  renderOnboarding();
  try {
    deployResult = await api.createAccount();
    await refreshAll();
  } catch (e) {
    deployError = e;
  } finally {
    deploying = false;
    renderOnboarding();
  }
}

/* ---------- funding ---------- */

const friendbot = (addr) => `https://friendbot.stellar.org/?addr=${encodeURIComponent(addr)}`;

function accountUsdc() {
  const b = ((state.account && state.account.balances) || []).find((x) => /^usdc/i.test(x.asset || ''));
  return b ? b.amount : null;
}

/** Wallet balances + "Get 10 test USDC" + "Fund agent wallet". Live: re-renders on data changes. */
export function fundingPanel({ inModal = false } = {}) {
  const root = h('div', { class: 'funding', 'data-testid': 'funding' });
  let amountValue = '';
  let mounted = false;
  let offs = [];
  let stale = false; // a render was skipped while the amount field had focus
  const render = () => {
    if (root.isConnected) mounted = true;
    else if (mounted) { offs.forEach((f) => f()); offs = []; return; }
    // Do not rebuild under the user's cursor; catch up when the field loses focus.
    if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { stale = true; return; }
    stale = false;
    const me = state.me || {};
    const w = me.wallet || {};
    const xlm = Number(w.xlm) || 0;
    const usdc = Number(w.usdc) || 0;
    const noXlm = xlm <= 0;
    const input = h('input', {
      class: 'input', id: inModal ? 'fund-amount-modal' : 'fund-amount', type: 'text', inputmode: 'decimal', 'data-testid': 'fund-amount',
      value: amountValue || (usdc > 0 ? String(Math.min(usdc, 5)) : '5'), 'aria-label': 'Amount to move into the agent wallet',
      onInput: (e) => { amountValue = e.target.value; },
    });
    const err = h('div', { class: 'field-err', role: 'alert' });
    const fundForm = h('form', { class: 'fund-row', novalidate: true },
      h('div', { class: 'input-affix' }, input, h('span', {}, 'USDC')),
      h('button', { class: (Number(accountUsdc()) || 0) > 0 && !inModal ? 'btn btn-ghost' : 'btn btn-primary', type: 'submit', 'data-testid': 'fund-account', disabled: usdc <= 0 }, icon(ICONS.down), (Number(accountUsdc()) || 0) > 0 ? 'Add more' : 'Fund agent wallet'));
    fundForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = normAmount(input.value);
      if (!v) { err.textContent = 'Enter a positive amount, e.g. 5 or 2.5.'; return; }
      if (Number(v) > usdc) {
        err.textContent = usdc > 0
          ? `Your wallet holds only ${fmtAmount(usdc)} USDC. Enter ${fmtAmount(usdc)} or less.`
          : 'Your wallet has no USDC yet. Get test USDC first.';
        return;
      }
      amountValue = '';
      runOp({
        title: 'Fund agent wallet',
        prepare: () => api.fund(v),
        okText: () => `Moved ${fmtAmount(v)} USDC into your agent wallet.`,
        done: () => expectUsdc({ wallet: -Number(v), account: Number(v) }),
        after: () => refreshAll(),
      });
    });
    const accUsdc = Number(accountUsdc()) || 0;
    const syncing = balancesSyncing();

    root.replaceChildren(...[ // filtered: replaceChildren would print a null child as "null"
      h('div', { class: 'balances' },
        h('div', { class: 'bal' },
          h('span', { class: 'w-label' }, 'Your wallet'),
          h('code', { class: 'bal-addr', title: me.address }, me.address ? `${me.address.slice(0, 5)}…${me.address.slice(-5)}` : '—'),
          h('div', { class: 'bal-nums' },
            h('span', {}, h('b', { 'data-testid': 'wallet-xlm' }, fmtAmount(w.xlm ?? 0)), ' XLM'),
            h('span', {}, h('b', { 'data-testid': 'wallet-usdc' }, fmtAmount(w.usdc ?? 0)), ' USDC'),
            w.usdc_trustline === false ? h('span', { class: 'tag' }, 'no USDC trustline yet') : null)),
        h('div', { class: 'bal bal-accent' },
          h('span', { class: 'w-label' }, 'Agent wallet (smart account)'),
          h('div', { class: 'bal-big' }, h('b', { 'data-testid': 'account-usdc-onb' }, fmtAmount(accountUsdc() ?? 0)), ' USDC'))),
      syncing ? h('div', { class: 'sync-note', 'data-testid': 'syncing', role: 'status' },
        h('span', { class: 'spinner' }), 'Confirmed on-chain. Stellar RPC is catching up, so the balances above are the expected ones for a few seconds.') : null,
      noXlm ? h('div', { class: 'notice notice-warn', 'data-testid': 'friendbot-notice' },
        h('strong', {}, 'Your wallet has no XLM yet.'), ' Buying test USDC costs a little XLM. Get free test XLM from friendbot. ',
        h('span', { class: 'row-inline' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-testid': 'get-test-xlm', disabled: fundingXlm, onClick: getTestXlm },
            fundingXlm ? [h('span', { class: 'spinner' }), ' Asking friendbot…'] : [icon(ICONS.plus), ' Get test XLM']),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: fundingXlm, onClick: () => refreshAll() }, icon(ICONS.retry), 'Refresh')),
        fundingXlm ? h('div', { class: 'muted small', role: 'status', 'data-testid': 'friendbot-progress' },
          'Friendbot usually answers in 10 to 20 seconds; your balance updates by itself.') : null,
        xlmError ? h('div', { class: 'res res-bad', role: 'alert', 'data-testid': 'friendbot-error' }, icon(ICONS.alert),
          h('span', {}, describeError(xlmError), ' You can also ', extLink(friendbot(me.address || ''), 'open friendbot', 'tx-link'), ' in a new tab and refresh.')) : null) : null,
      h('div', { class: 'fund-action' },
        h('div', {},
          h('b', {}, '1. Get test USDC'),
          h('p', { class: 'muted small' }, 'Adds a USDC trustline to your wallet if needed and buys 10 USDC for XLM on the testnet DEX. You sign a transaction.')),
        h('button', {
          class: 'btn btn-ghost', type: 'button', 'data-testid': 'get-test-usdc', disabled: noXlm,
          title: noXlm ? 'Fund your wallet with XLM first (friendbot)' : null,
          onClick: () => runOp({
            title: 'Get 10 test USDC',
            prepare: () => api.testUsdc('10'),
            okText: () => '10 test USDC are now in your wallet.',
            done: () => expectUsdc({ wallet: 10 }),
            after: () => refreshAll(),
          }),
        }, icon(ICONS.plus), 'Get 10 test USDC')),
      h('div', { class: 'fund-action fund-action-col' },
        h('div', {},
          h('b', {}, '2. Fund your agent wallet'),
          h('p', { class: 'muted small' }, 'Moves USDC from your wallet into your smart account, where your agents can spend it within their limits.')),
        fundForm, err)].filter(Boolean));
  };
  root.addEventListener('focusout', () => setTimeout(() => { if (stale && !root.contains(document.activeElement)) render(); }, 0));
  render();
  offs = [on('me', render), on('account', render), on('sync', render)];
  return root;
}
