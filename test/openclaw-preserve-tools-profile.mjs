#!/usr/bin/env node

import {
  buildCCRequest,
  createStreamingReverseMapper,
  reverseMapResponse,
} from '../dist/cc-template.js';

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
    return;
  }
  fail++;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const billingTag = 'billing-tag';
const cache1h = { type: 'ephemeral' };
const identity = { deviceId: 'device', accountUuid: 'account', sessionId: 'session' };
const triggerPhrases = [
  'OpenClaw',
  'openclaw',
  'sessions_list',
  'sessions_send',
  'HEARTBEAT_OK',
  'HEARTBEAT',
  'heartbeat',
  'running inside',
  'Prometheus',
  'prometheus',
  'clawhub.com',
  'clawhub',
  'clawd',
  'lossless-claw',
  'third-party',
  'billing proxy',
  'billing-proxy',
  'x-anthropic-billing-header',
  'x-anthropic-billing',
  'cch=00000',
  'cc_version',
  'cc_entrypoint',
  'billing header',
  'extra usage',
  'assistant platform',
];

const clientTools = [
  {
    name: 'session_status',
    description: 'Show status',
    input_schema: {
      type: 'object',
      properties: {
        sessionKey: { type: 'string' },
        session_id: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['sessionKey', 'session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'gateway',
    description: 'Gateway control',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        gatewayUrl: { type: 'string' },
        gatewayToken: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'nodes',
    description: 'Nodes control',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

const clientBody = {
  model: 'claude-sonnet-4-6',
  system: 'You are a personal assistant running inside OpenClaw.\n\n## Tooling\n'
    + `${triggerPhrases.join(' | ')}\n`
    + `${'tool config line\n'.repeat(160)}`
    + '\n## /home/molt/clawd/AGENTS.md\nkeep this workspace doc\n',
  messages: [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_hist_1',
          name: 'session_status',
          input: { sessionKey: 'agent:main', session_id: 'thread-123' },
        },
        {
          type: 'tool_use',
          id: 'toolu_hist_2',
          name: 'gateway',
          input: { action: 'config.get', gatewayUrl: 'https://relay.local', gatewayToken: 'secret' },
        },
      ],
    },
    { role: 'user', content: `continue ${triggerPhrases.join(' | ')}` },
  ],
  tools: structuredClone(clientTools),
  stream: false,
};

header('openclaw preserve-tools profile emits only aliased subset tools');
const built = buildCCRequest(clientBody, billingTag, cache1h, identity, {
  preserveTools: true,
  preserveToolsProfile: 'openclaw-subset',
});
const outboundTools = built.body.tools;
check('tool list preserved as array', Array.isArray(outboundTools));
check('only subset tools are emitted', outboundTools.length === 2);
check(
  'emitted subset tool names are aliased',
  JSON.stringify(outboundTools.map((tool) => tool?.name)) === JSON.stringify(['StatusCheck', 'SystemCtl']),
);
check('non-profile tool is not emitted', !outboundTools.some((tool) => tool?.name === 'nodes'));
check('subset tool descriptions are preserved', outboundTools[0]?.description === 'Show session status and active model details.');
check(
  'session_status schema renamed sessionKey -> threadKey',
  Boolean(outboundTools[0]?.input_schema?.properties?.threadKey)
    && !outboundTools[0]?.input_schema?.properties?.sessionKey,
);
check(
  'generic property rename session_id -> thread_id applied in schema',
  Boolean(outboundTools[0]?.input_schema?.properties?.thread_id)
    && !outboundTools[0]?.input_schema?.properties?.session_id
    && outboundTools[0]?.input_schema?.required?.includes('thread_id'),
);
check(
  'gateway schema renamed gatewayUrl/gatewayToken',
  Boolean(outboundTools[1]?.input_schema?.properties?.relayUrl)
    && Boolean(outboundTools[1]?.input_schema?.properties?.relayToken)
    && !outboundTools[1]?.input_schema?.properties?.gatewayUrl,
);

const histBlocks = built.body.messages[0].content;
check('history tool_use name rewritten for session_status', histBlocks[0]?.name === 'StatusCheck');
check(
  'history tool_use input rewritten for session_status',
  histBlocks[0]?.input?.threadKey === 'agent:main' && histBlocks[0]?.input?.thread_id === 'thread-123',
);
check('history tool_use name rewritten for gateway', histBlocks[1]?.name === 'SystemCtl');
check(
  'history tool_use input rewritten for gateway',
  histBlocks[1]?.input?.relayUrl === 'https://relay.local'
    && histBlocks[1]?.input?.relayToken === 'secret',
);
check('toolMap contains only emitted subset tools', built.toolMap.size === 2 && !built.toolMap.has('nodes'));
check('system config section compacted', !built.body.system[2]?.text.includes('## Tooling'));
check('compact system paraphrase inserted', built.body.system[2]?.text.includes('AI operations assistant with access to the tools listed in this request'));
check('workspace doc header preserved after compaction', built.body.system[2]?.text.includes('## /home/molt/clawd/AGENTS.md'));
const outboundJson = JSON.stringify(built.body);
const sanitizedUserText = typeof built.body.messages[1]?.content === 'string'
  ? built.body.messages[1].content
  : JSON.stringify(built.body.messages[1]?.content ?? '');
check(
  'billing-proxy trigger phrases scrubbed from user text blocks',
  triggerPhrases.every((phrase) => !sanitizedUserText.includes(phrase)),
);
check('session text replacements inserted', outboundJson.includes('HB_SIGNAL') && outboundJson.includes('routing layer') && outboundJson.includes('skillhub.example.com'));

header('openclaw wide alias profile preserves the broad tool set and PascalCases names');
const wideToolNames = [
  'read',
  'edit',
  'write',
  'exec',
  'process',
  'canvas',
  'message',
  'agents_list',
  'sessions_list',
  'sessions_history',
  'sessions_send',
  'sessions_yield',
  'sessions_spawn',
  'subagents',
  'session_status',
  'web_search',
  'web_fetch',
  'image',
  'browser',
  'memory_search',
  'memory_store',
  'memory_get',
  'memory_list',
  'memory_forget',
];
const wideClientBody = {
  model: 'claude-sonnet-4-6',
  system: 'Use sessions_send and session_status when needed. The message body should stay ordinary prose. Use `message` only when you mean the tool. read write edit exec browser web_search web_fetch.',
  messages: [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_wide_hist_1',
          name: 'sessions_send',
          input: { sessionKey: 'agent:main', message: 'hello' },
        },
      ],
    },
    { role: 'user', content: 'Use session_status exactly once, then maybe sessions_send. Keep the message body wording untouched unless `message` is explicitly code-ish.' },
  ],
  tools: wideToolNames.map((name) => {
    const description = name === 'sessions_list'
      ? 'List sessions before calling sessions_history or sessions_send.'
      : `Description for ${name}`;
    const valueSchema = name === 'session_status'
      ? {
          type: 'string',
          description: 'Use session_status before sessions_send.',
          title: 'session_status payload',
        }
      : { type: 'string' };
    return {
      name,
      description,
      input_schema: {
        type: 'object',
        properties: {
          value: valueSchema,
        },
        additionalProperties: false,
      },
    };
  }),
  stream: false,
};
const wideBuilt = buildCCRequest(wideClientBody, billingTag, cache1h, identity, {
  preserveTools: true,
  preserveToolsProfile: 'openclaw-wide-alias',
});
const wideToolNamesOut = wideBuilt.body.tools.map((tool) => tool?.name);
check('wide profile keeps all tools', wideBuilt.body.tools.length === wideToolNames.length);
check('wide profile aliases exec -> Bash', wideToolNamesOut.includes('Bash') && !wideToolNamesOut.includes('exec'));
check('wide profile aliases message -> SendMessage', wideToolNamesOut.includes('SendMessage') && !wideToolNamesOut.includes('message'));
check('wide profile aliases sessions_send -> TaskSend', wideToolNamesOut.includes('TaskSend') && !wideToolNamesOut.includes('sessions_send'));
check('wide profile aliases session_status -> StatusCheck', wideToolNamesOut.includes('StatusCheck') && !wideToolNamesOut.includes('session_status'));
check(
  'wide profile aliases raw tool names inside descriptions',
  wideBuilt.body.tools.find((tool) => tool?.name === 'TaskList')?.description === 'List sessions before calling TaskHistory or TaskSend.',
);
check(
  'wide profile aliases raw tool names inside schema text',
  wideBuilt.body.tools.find((tool) => tool?.name === 'StatusCheck')?.input_schema?.properties?.value?.description === 'Use StatusCheck before TaskSend.'
    && wideBuilt.body.tools.find((tool) => tool?.name === 'StatusCheck')?.input_schema?.properties?.value?.title === 'StatusCheck payload',
);
check('wide history tool_use name rewritten', wideBuilt.body.messages[0].content[0]?.name === 'TaskSend');
check('wide user text rewritten for aliased tool names', typeof wideBuilt.body.messages[1]?.content === 'string' && wideBuilt.body.messages[1].content.includes('StatusCheck') && !wideBuilt.body.messages[1].content.includes('session_status'));
check('wide system text rewritten for aliased tool names', wideBuilt.body.system[2]?.text.includes('TaskSend') && !wideBuilt.body.system[2]?.text.includes('sessions_send'));
check('wide prose keeps ordinary message wording', wideBuilt.body.system[2]?.text.includes('message body should stay ordinary prose'));
check('wide code-ish generic tool mentions are still aliased', wideBuilt.body.system[2]?.text.includes('`SendMessage`'));

const wideUpstreamResponse = JSON.stringify({
  content: [
    {
      type: 'tool_use',
      id: 'toolu_wide_reply_1',
      name: 'TaskSend',
      input: { sessionKey: 'agent:main', message: 'hello' },
    },
  ],
});
const wideRemapped = JSON.parse(reverseMapResponse(wideUpstreamResponse, wideBuilt.toolMap));
check('wide reverse maps TaskSend -> sessions_send', wideRemapped.content[0]?.name === 'sessions_send');

const wideEncoder = new TextEncoder();
const wideDecoder = new TextDecoder();
const wideMapper = createStreamingReverseMapper(wideBuilt.toolMap);
let wideStreamed = '';
wideStreamed += wideDecoder.decode(wideMapper.feed(wideEncoder.encode(
  'event: content_block_start\n'
  + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_wide_stream_1","name":"StatusCheck","input":{}}}\n\n',
)), { stream: true });
wideStreamed += wideDecoder.decode(wideMapper.end());
check('wide streaming reverse maps StatusCheck -> session_status', wideStreamed.includes('"name":"session_status"'));

header('non-streaming reverse map restores original names and fields');
const upstreamResponse = JSON.stringify({
  content: [
    {
      type: 'tool_use',
      id: 'toolu_reply_1',
      name: 'StatusCheck',
      input: { threadKey: 'agent:main', thread_id: 'thread-123' },
    },
    {
      type: 'tool_use',
      id: 'toolu_reply_2',
      name: 'SystemCtl',
      input: { action: 'config.get', relayUrl: 'https://relay.local', relayToken: 'secret' },
    },
  ],
});
const remapped = JSON.parse(reverseMapResponse(upstreamResponse, built.toolMap));
check('reverse maps StatusCheck -> session_status', remapped.content[0]?.name === 'session_status');
check(
  'reverse restores threadKey/thread_id -> sessionKey/session_id',
  remapped.content[0]?.input?.sessionKey === 'agent:main'
    && remapped.content[0]?.input?.session_id === 'thread-123',
);
check('reverse maps SystemCtl -> gateway', remapped.content[1]?.name === 'gateway');
check(
  'reverse restores relayUrl/relayToken -> gatewayUrl/gatewayToken',
  remapped.content[1]?.input?.gatewayUrl === 'https://relay.local'
    && remapped.content[1]?.input?.gatewayToken === 'secret',
);

header('streaming reverse map restores original names and fields');
const mapper = createStreamingReverseMapper(built.toolMap);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let streamed = '';
streamed += decoder.decode(mapper.feed(encoder.encode(
  'event: content_block_start\n'
  + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_stream_1","name":"StatusCheck","input":{}}}\n\n',
)), { stream: true });
streamed += decoder.decode(mapper.feed(encoder.encode(
  'event: content_block_delta\n'
  + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"threadKey\\":\\"agent:main\\",\\"thread_id\\":\\"thread-123\\"}"}}\n\n',
)), { stream: true });
streamed += decoder.decode(mapper.feed(encoder.encode(
  'event: content_block_stop\n'
  + 'data: {"type":"content_block_stop","index":0}\n\n',
)), { stream: true });
streamed += decoder.decode(mapper.end());
check('streaming start event uses original tool name', streamed.includes('"name":"session_status"'));
check(
  'streaming synthetic delta restores sessionKey and session_id',
  streamed.includes('sessionKey')
    && streamed.includes('agent:main')
    && streamed.includes('session_id')
    && streamed.includes('thread-123'),
);

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
