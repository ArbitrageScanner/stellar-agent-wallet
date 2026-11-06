// A scripted stand-in for OpenRouter (OpenAI-compatible, streaming), so the
// real agentwallet server can be exercised end to end without an API key:
//
//   node web/e2e/mock-llm.mjs                       # :8799
//   OPENROUTER_URL=http://127.0.0.1:8799/api/v1 OPENROUTER_API_KEY=mock agentwallet serve
//
// It is not a model: it maps a few phrases to tool calls and turns tool
// results into short English answers. The wallet, signatures and
// transactions behind it are real.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8799);
const G = /\bG[A-Z2-7]{55}\b/;

function decide(messages) {
  const last = messages[messages.length - 1];
  if (last.role === 'tool') return { text: answer(last, messages) };
  const text = String(last.content || '').toLowerCase();
  const payee = (String(last.content).match(G) || String(messages[0].content).match(G) || [])[0];
  const amount = (text.match(/(\d+(?:[.,]\d+)?)\s*(usdc)?/) || [])[1]?.replace(',', '.');
  if (/\b(pay|send|transfer)\b/.test(text) && amount && payee) {
    return { call: { name: /simulat|dry.?run|check/.test(text) ? 'simulate_payment' : 'pay', args: { to: payee, amount } } };
  }
  if (/history|payments/.test(text)) return { call: { name: 'payment_history', args: { limit: 5 } } };
  if (/\bwhy\b/.test(text)) return { text: explainLastError(messages) };
  if (/how much|balance|limit|money/.test(text)) return { call: { name: 'wallet_info', args: {} } };
  return { text: 'I am a scripted demo model, not an LLM. Try: "How much money do I have?", "Pay 1 USDC to G…", "Show payment history".' };
}

function parse(content) {
  try { return JSON.parse(content); } catch { return null; }
}

function limitText(d = {}) {
  const h = d.resets_in_seconds ? ` The limit resets in about ${Math.round(d.resets_in_seconds / 3600)} h.` : '';
  return `the limit is ${d.limit} USDC per day, ${d.spent} is already spent, ${d.remaining} remains, and ${d.requested} was requested.${h}`;
}

function answer(tool, messages) {
  const r = parse(tool.content) || {};
  if (r.error) {
    const e = r.error;
    const link = e.details?.rejected_tx ? `\n\nThe rejection is recorded on-chain: [transaction](${e.details.rejected_tx})` : '';
    if (e.code === 'spending_limit_exceeded') return `The payment was **rejected by the smart account**: ${limitText(e.details)}${link}`;
    if (e.code === 'rejected_by_user') return 'OK, the payment is cancelled: you did not approve it.';
    if (e.code === 'agent_inactive') return 'I cannot pay: the owner has revoked my access to the wallet.';
    return `That failed: \`${e.code}\` — ${e.message}`;
  }
  switch (tool.name) {
    case 'wallet_info': {
      const l = r.spending_limit;
      const lim = typeof l === 'object' ? ` Daily limit ${l.limit_usdc} USDC, **${l.remaining_usdc} USDC** left (resets in ${l.next_reset_in ?? '—'}).` : '';
      return `The wallet holds **${r.balance_usdc} USDC**.${lim}`;
    }
    case 'pay':
      if (r.duplicate) return `This payment was already sent earlier: [transaction](${r.payment?.url}).`;
      return `Done: sent **${r.amount} USDC** to \`${r.to.slice(0, 4)}…${r.to.slice(-4)}\`. [Transaction](${r.url}). Wallet balance ${r.balance_after_usdc} USDC, ${r.limit_remaining_usdc ?? '∞'} USDC left of today's limit.`;
    case 'simulate_payment':
      return r.would_succeed ? `Simulation passed: ${r.amount} USDC can be sent.` : `Simulation: it would fail — ${r.error?.code === 'spending_limit_exceeded' ? limitText(r.error.details) : r.error?.message}`;
    case 'payment_history': {
      const items = r.payments || [];
      if (!items.length) return 'No payments yet.';
      return 'Recent payments:\n' + items.map((p) => `- ${p.status === 'SUCCESS' ? '✅' : '❌'} ${p.amount} USDC → \`${p.to.slice(0, 4)}…${p.to.slice(-4)}\` — [tx](${p.url})`).join('\n');
    }
  }
  return 'Done.';
}

function explainLastError(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const r = parse(m.content);
    if (r?.error?.code === 'spending_limit_exceeded') {
      return `Because the on-chain spending-limit policy kicked in: ${limitText(r.error.details)} The smart account checks this itself in \`__check_auth\`, so I cannot get around it. You can pay less or ask the owner to raise the limit.`;
    }
    if (r?.error) return `The last error was \`${r.error.code}\` — ${r.error.message}`;
  }
  return 'There were no errors in this conversation.';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock/scripted', name: 'Mock (scripted)', context_length: 8192 }] }));
  }
  if (req.method !== 'POST' || !req.url.startsWith('/api/v1/chat/completions')) {
    res.writeHead(404);
    return res.end();
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const { messages } = JSON.parse(body);
  const d = decide(messages);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  if (d.call) {
    const args = JSON.stringify(d.call.args);
    send({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: d.call.name, arguments: args.slice(0, 5) } }] });
    send({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] });
  } else {
    for (const word of d.text.match(/\S+\s*/g) || []) {
      send({ content: word });
      await sleep(15);
    }
  }
  res.end('data: [DONE]\n\n');
}).listen(PORT, '127.0.0.1', () => console.log(`mock LLM on http://127.0.0.1:${PORT}/api/v1`));
