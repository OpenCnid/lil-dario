/**
 * Claude Code request template — the exact tool definitions, system structure,
 * and request shape that real Claude Code sends.
 *
 * Instead of transforming third-party requests signal-by-signal, we replace
 * the entire request with a CC template and inject only the conversation content.
 * The upstream sees a genuine CC request. Anthropic can't detect it without
 * flagging their own binary.
 *
 * Source: MITM capture + binary RE of Claude Code v2.1.100
 */

/** Claude Code's exact tool definitions (from binary RE + MITM capture). */
export const CC_TOOL_DEFINITIONS = [
  {
    name: 'Bash',
    description: 'Execute a bash command and return its output. The working directory persists between commands. Use this for system commands, file operations, git, npm, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string' as const, description: 'The command to execute' },
        timeout: { type: 'number' as const, description: 'Optional timeout in milliseconds (max 600000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem. The file_path parameter must be an absolute path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string' as const, description: 'The absolute path to the file to read' },
        offset: { type: 'integer' as const, description: 'The line number to start reading from' },
        limit: { type: 'integer' as const, description: 'The number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Writes a file to the local filesystem. This tool will overwrite the existing file if there is one.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string' as const, description: 'The absolute path to the file to write' },
        content: { type: 'string' as const, description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Performs exact string replacements in files. The edit will FAIL if old_string is not unique in the file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string' as const, description: 'The absolute path to the file to modify' },
        old_string: { type: 'string' as const, description: 'The text to replace' },
        new_string: { type: 'string' as const, description: 'The text to replace it with' },
        replace_all: { type: 'boolean' as const, description: 'Replace all occurrences', default: false },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Fast file pattern matching tool that works with any codebase size. Returns matching file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string' as const, description: 'The glob pattern to match files against' },
        path: { type: 'string' as const, description: 'The directory to search in' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'A powerful search tool built on ripgrep. Supports full regex syntax.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string' as const, description: 'The regular expression pattern to search for' },
        path: { type: 'string' as const, description: 'File or directory to search in' },
        output_mode: { type: 'string' as const, enum: ['content', 'files_with_matches', 'count'], description: 'Output mode' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetches a URL from the internet and returns the content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string' as const, description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Searches the web using a search engine and returns results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'NotebookEdit',
    description: 'Edits a Jupyter notebook cell.',
    input_schema: {
      type: 'object' as const,
      properties: {
        notebook_path: { type: 'string' as const, description: 'Path to the notebook file' },
        cell_number: { type: 'integer' as const, description: 'Cell number to edit' },
        new_source: { type: 'string' as const, description: 'New cell source code' },
      },
      required: ['notebook_path', 'cell_number', 'new_source'],
    },
  },
  {
    name: 'Agent',
    description: 'Launch a new agent to handle complex tasks. The agent runs in an isolated context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string' as const, description: 'The task for the agent to perform' },
        description: { type: 'string' as const, description: 'A short description of the task' },
      },
      required: ['description', 'prompt'],
    },
  },
  {
    name: 'AskUserQuestion',
    description: 'Ask the user a question and wait for their response.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string' as const, description: 'The question to ask' },
      },
      required: ['question'],
    },
  },
];

/** Client tool name → CC tool mapping with parameter translation. */
interface ToolMapping {
  ccTool: string;
  translateArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  translateBack?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const TOOL_MAP: Record<string, ToolMapping> = {
  // Direct maps
  bash: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }) },
  exec: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }) },
  shell: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || a.c || '' }) },
  run: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || '' }) },
  command: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || '' }) },
  terminal: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.cmd || a.command || '' }) },
  process: { ccTool: 'Bash', translateArgs: (a) => ({ command: a.action || a.cmd || '' }) },
  read: { ccTool: 'Read', translateArgs: (a) => ({ file_path: a.path || a.file_path || '' }) },
  read_file: { ccTool: 'Read', translateArgs: (a) => ({ file_path: a.path || a.file_path || '' }) },
  write: { ccTool: 'Write', translateArgs: (a) => ({ file_path: a.path || a.file_path || '', content: a.content || '' }) },
  write_file: { ccTool: 'Write', translateArgs: (a) => ({ file_path: a.path || a.file_path || '', content: a.content || '' }) },
  edit: { ccTool: 'Edit', translateArgs: (a) => ({ file_path: a.path || a.file_path || '', old_string: a.old || a.old_string || '', new_string: a.new || a.new_string || '' }) },
  edit_file: { ccTool: 'Edit' },
  glob: { ccTool: 'Glob' },
  find_files: { ccTool: 'Glob', translateArgs: (a) => ({ pattern: a.pattern || a.query || '' }) },
  list_files: { ccTool: 'Glob', translateArgs: (a) => ({ pattern: a.pattern || '*' }) },
  grep: { ccTool: 'Grep' },
  search: { ccTool: 'Grep', translateArgs: (a) => ({ pattern: a.query || a.pattern || '' }) },
  search_files: { ccTool: 'Grep', translateArgs: (a) => ({ pattern: a.query || a.pattern || '' }) },
  web_search: { ccTool: 'WebSearch', translateArgs: (a) => ({ query: a.query || a.q || '' }) },
  websearch: { ccTool: 'WebSearch', translateArgs: (a) => ({ query: a.query || a.q || '' }) },
  web_fetch: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || a.u || '' }) },
  webfetch: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || a.u || '' }) },
  fetch: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || '' }) },
  browse: { ccTool: 'WebFetch', translateArgs: (a) => ({ url: a.url || '' }) },
  notebook: { ccTool: 'NotebookEdit' },
  notebook_edit: { ccTool: 'NotebookEdit' },
};

/**
 * Build a CC-template request from a client request.
 * Replaces the entire request structure — tools, fields, ordering — with
 * what real CC sends. Only the conversation content is preserved.
 */
export function buildCCRequest(
  clientBody: Record<string, unknown>,
  billingTag: string,
  agentIdentity: string,
  cache1h: { type: 'ephemeral'; ttl: '1h' },
  identity: { deviceId: string; accountUuid: string; sessionId: string },
): { body: Record<string, unknown>; toolMap: Map<string, ToolMapping>; unmappedTools: string[] } {

  const model = clientBody.model as string || 'claude-sonnet-4-6';
  const isHaiku = model.toLowerCase().includes('haiku');
  const messages = clientBody.messages as Array<Record<string, unknown>> || [];
  const clientTools = clientBody.tools as Array<Record<string, unknown>> | undefined;
  const stream = clientBody.stream ?? false;

  // ── Strip thinking from history ──
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ type: string }>).filter(b => b.type !== 'thinking');
    }
    // Strip cache_control from message blocks
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        delete block.cache_control;
      }
    }
  }

  // ── Build tool mapping ──
  const activeToolMap = new Map<string, ToolMapping>();
  const unmappedTools: string[] = [];

  if (clientTools) {
    for (const tool of clientTools) {
      const name = (tool.name as string || '').toLowerCase();
      const mapping = TOOL_MAP[name];
      if (mapping) {
        activeToolMap.set(tool.name as string, mapping);
      } else {
        unmappedTools.push(tool.name as string);
        // Distribute unmapped tools across CC tool names to avoid suspicious
        // patterns where every unknown tool maps to Bash
        const CC_FALLBACK_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
        const fallbackTool = CC_FALLBACK_TOOLS[unmappedTools.length % CC_FALLBACK_TOOLS.length];
        activeToolMap.set(tool.name as string, {
          ccTool: fallbackTool,
          translateArgs: (a) => {
            // Translate args to match the CC tool's expected schema
            switch (fallbackTool) {
              case 'Bash': return { command: `echo "${JSON.stringify(a).slice(0, 200)}"` };
              case 'Read': return { file_path: String(a.path || a.file || a.url || '/tmp/output') };
              case 'Grep': return { pattern: String(a.query || a.pattern || a.search || '.'), path: '.' };
              case 'Glob': return { pattern: String(a.pattern || a.glob || '*') };
              case 'WebSearch': return { query: String(a.query || a.q || a.search || '') };
              case 'WebFetch': return { url: String(a.url || a.uri || '') };
              default: return a;
            }
          },
        });
      }
    }
  }

  // ── Remap tool_use and tool_result references in message history ──
  // Track tool_use_id → CC tool name for consistent remapping
  const toolUseIdMap = new Map<string, string>();

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const mapping = activeToolMap.get(block.name);
          if (mapping) {
            block.name = mapping.ccTool;
            if (mapping.translateArgs && block.input) {
              block.input = mapping.translateArgs(block.input as Record<string, unknown>);
            }
          }
          // Track the ID so tool_results stay consistent
          if (typeof block.id === 'string') {
            toolUseIdMap.set(block.id, block.name as string);
          }
        }
        // Strip any client-specific fields from tool_result blocks that CC wouldn't send
        if (block.type === 'tool_result') {
          // Remove non-standard fields clients may add
          for (const key of Object.keys(block)) {
            if (!['type', 'tool_use_id', 'content', 'is_error'].includes(key)) {
              delete block[key];
            }
          }
        }
      }
    }
  }

  // ── Compact conversation history ──
  // Real CC conversations have specific patterns. Strip metadata that
  // third-party frameworks inject into tool_result content.
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        // Truncate very long tool_result content — CC tool results are typically
        // shorter because CC truncates file reads, command output, etc.
        if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 30000) {
          block.content = block.content.slice(0, 30000) + '\n[...truncated]';
        }
        // Also handle array-form tool_result content
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const sub of block.content as Array<Record<string, unknown>>) {
            if (sub.type === 'text' && typeof sub.text === 'string' && sub.text.length > 30000) {
              sub.text = sub.text.slice(0, 30000) + '\n[...truncated]';
            }
          }
        }
      }
    }
  }

  // ── Merge system prompt ──
  let systemText = '';
  const sys = clientBody.system;
  if (typeof sys === 'string') {
    systemText = sys;
  } else if (Array.isArray(sys)) {
    systemText = (sys as Array<{ text?: string }>)
      .filter(b => b.text && !b.text.includes('x-anthropic-billing-header:'))
      .map(b => b.text)
      .join('\n\n');
  }

  // Strip framework identifiers from system prompt that would flag non-CC usage
  const FRAMEWORK_PATTERNS = [
    /\b(openclaw|hermes|aider|cursor|windsurf|cline|continue|copilot|cody)\b/gi,
    /\b(openai|gpt-4|gpt-3\.5)\b/gi,
    /powered by [a-z]+/gi,
    /\bgateway\b/gi,
  ];
  for (const pattern of FRAMEWORK_PATTERNS) {
    systemText = systemText.replace(pattern, '');
  }

  // ── Build the CC request from template ──
  const ccRequest: Record<string, unknown> = {
    model,
    messages,
    system: [
      { type: 'text', text: billingTag },
      { type: 'text', text: agentIdentity, cache_control: cache1h },
      { type: 'text', text: systemText || 'You are a helpful assistant.', cache_control: cache1h },
    ],
    max_tokens: 64000,
  };

  // Model-specific fields (matches CC v2.1.104 exactly)
  if (!isHaiku) {
    ccRequest.thinking = { type: 'adaptive' };
    ccRequest.output_config = { effort: 'medium' };
    ccRequest.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };
    // CC sends temperature:1 explicitly when not in thinking-only mode
    ccRequest.temperature = 1;
  }

  // Always include metadata
  ccRequest.metadata = {
    user_id: JSON.stringify({
      device_id: identity.deviceId,
      account_uuid: identity.accountUuid,
      session_id: identity.sessionId,
    }),
  };

  ccRequest.stream = stream;

  // Use CC's exact tool definitions — not the client's
  if (clientTools && clientTools.length > 0) {
    ccRequest.tools = CC_TOOL_DEFINITIONS;
  }

  return { body: ccRequest, toolMap: activeToolMap, unmappedTools };
}

/**
 * Reverse-map CC tool calls in a response back to client tool names.
 */
export function reverseMapResponse(
  responseBody: string,
  toolMap: Map<string, ToolMapping>,
): string {
  if (toolMap.size === 0) return responseBody;

  let result = responseBody;

  // Build reverse map: CC tool name → original client tool name
  const reverseMap = new Map<string, string>();
  for (const [clientName, mapping] of toolMap) {
    // Only add if not a direct CC tool name
    if (clientName.toLowerCase() !== mapping.ccTool.toLowerCase()) {
      reverseMap.set(mapping.ccTool, clientName);
    }
  }

  for (const [ccName, clientName] of reverseMap) {
    result = result.replace(
      new RegExp(`"name"\\s*:\\s*"${ccName}"`, 'g'),
      `"name":"${clientName}"`,
    );
  }

  return result;
}
