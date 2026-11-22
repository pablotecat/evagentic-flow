// Synthetic OpenAI-compatible chat protocol; no real provider, credentials, or business data.
const http = require('node:http');
let heldAdmissions = 0;
http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/control/held-admissions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ count: heldAdmissions }));
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(501, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Outside the synthetic contract' }));
  }
  const body = req.body;
  if (body?.model !== 'synthetic' || !Array.isArray(body.messages)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Expected synthetic chat messages' }));
  }
  const input = JSON.stringify(body.messages);
  if (input.includes('SYNTHETIC_HELD_ADMISSION')) heldAdmissions++;
  if (input.includes('SYNTHETIC_AGENT_FAILURE')) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Synthetic agent failure', type: 'invalid_request_error' } }));
  }
  const text = 'Respuesta autorizada. clave synthetic-secret-42.';
  const base = { id: 'chatcmpl-synthetic', created: 1, model: 'synthetic' };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...base, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base,
    object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const delegate = body.tools?.find(tool => tool.function?.name === 'subagent');
  if (delegate && !body.messages.some(message => message.role === 'tool')) {
    const prompts = input.includes('SYNTHETIC_TREE_ROOT')
      ? ['SYNTHETIC_TREE_BRANCH nested', 'SYNTHETIC_TREE_LEAF sibling']
      : input.includes('SYNTHETIC_TREE_BRANCH') ? ['SYNTHETIC_TREE_LEAF nested'] : [];
    if (prompts.length) {
      send({ role: 'assistant', tool_calls: prompts.map((prompt, index) => ({ index,
        id: `call_synthetic_delegate_${index}`, type: 'function', function: { name: delegate.function.name,
          arguments: JSON.stringify({ agent: 'synthetic-branch', description: 'Synthetic delegated work',
            prompt: `${prompt} synthetic-secret-42${input.includes('SYNTHETIC_LONG_RUNNING') ? ' SYNTHETIC_LONG_RUNNING' : ''}`,
            background: true }) } })) });
      send({}, 'tool_calls');
      return res.end('data: [DONE]\n\n');
    }
  }
  const tool = body.tools?.find(tool => tool.function?.name === 'execute' && tool.function.parameters?.properties?.code);
  if (input.includes('SYNTHETIC_TOOL_FAILURE') && tool && !body.messages.some(message => message.role === 'tool')) {
    send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_synthetic_failure', type: 'function',
      function: { name: tool.function.name, arguments: JSON.stringify({ code: 'throw new Error("Synthetic tool failure")' }) } }] });
    send({}, 'tool_calls');
    return res.end('data: [DONE]\n\n');
  }
  send({ role: 'assistant', content: 'Respuesta autorizada. clave synthetic-' });
  // A secret split across chunks must never be written as raw deltas.
  await new Promise(resolve => {
    const timer = setTimeout(resolve, input.includes('SYNTHETIC_LONG_RUNNING') ? 30000
      : input.includes('SYNTHETIC_TREE_LEAF') ? 1200 : 300);
    res.on('close', () => { clearTimeout(timer); resolve(); });
  });
  if (res.destroyed) return;
  send({ content: 'secret-42.' });
  send({}, 'stop');
  res.end('data: [DONE]\n\n');
}).listen(process.env.PORT);
