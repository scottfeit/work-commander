import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { McpServerConfig, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerSettings, Settings, SystemId } from '@wc/shared';
import type { AppConfig } from '../config.js';
import type { SecretStore } from '../secrets/store.js';

/** A tool the dashboard exposes to Claude. `run` performs the effect; policy wrapping happens in tools.ts. */
export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  access: 'read' | 'write' | 'internal';
  system: SystemId | 'internal';
  handler: (args: any) => Promise<string>;
}

export interface ExternalMcp {
  name: string; // key in mcpServers, e.g. "atlassian"
  system: SystemId;
  config: McpServerConfig;
  settings: McpServerSettings;
}

export interface TurnInput {
  systemPrompt: string;
  prompt: string;
  sessionId?: string | null;
  tools: ToolDef[];
  external: ExternalMcp[];
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  /** Called for external MCP tool calls; decides allow (possibly with edited input) or deny. */
  canUseExternal?: (server: ExternalMcp, tool: string, input: Record<string, unknown>) => Promise<PermissionResult>;
}

export interface TurnOutput {
  sessionId: string;
  text: string;
}

export interface AgentBackend {
  turn(i: TurnInput): Promise<TurnOutput>;
  structured<T>(i: { systemPrompt: string; prompt: string; schema: z.ZodType<T>; external?: ExternalMcp[]; canUseExternal?: TurnInput['canUseExternal'] }): Promise<T>;
  test(): Promise<string>;
}

/** Environment for the Claude Code process the Agent SDK drives, per the provider chosen in Settings. */
export async function providerEnv(s: Settings, cfg: AppConfig, secrets: SecretStore): Promise<Record<string, string | undefined>> {
  const base: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `work-commander/${cfg.version}` };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION']) delete base[k];
  switch (s.claude.provider) {
    case 'claude-code-login':
      // Uses the PU's own `claude` sign-in on this machine. Anthropic's terms don't allow offering
      // claude.ai login to other users, so this is only permitted for a local, single-PU instance.
      if (cfg.hosting !== 'local') throw new Error('Claude Code login is only available when hosted locally. Choose Vertex AI or an API key.');
      return base;
    case 'vertex':
      if (!s.claude.vertex.projectId) throw new Error('Set the Vertex AI project in Settings → Claude');
      return { ...base, CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: s.claude.vertex.projectId, CLOUD_ML_REGION: s.claude.vertex.region || 'global' };
    case 'api-key':
      if (!s.claude.apiKeyId) throw new Error('Add an Anthropic API key in Settings → Claude');
      return { ...base, ANTHROPIC_API_KEY: await secrets.get(s.claude.apiKeyId) };
  }
}

async function* single(prompt: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null } as SDKUserMessage;
}

export class ClaudeAgentBackend implements AgentBackend {
  private cwd: string;
  constructor(
    private cfg: AppConfig,
    private getSettings: () => Promise<Settings>,
    private secrets: SecretStore,
  ) {
    // Sessions are persisted by the SDK relative to cwd; keep them in the app's data dir.
    this.cwd = path.join(cfg.dataDir, 'agent-workspace');
    fs.mkdirSync(this.cwd, { recursive: true });
  }

  private async base() {
    const s = await this.getSettings();
    const env = await providerEnv(s, this.cfg, this.secrets);
    const builtins = s.claude.allowWebResearch ? ['WebSearch', 'WebFetch'] : [];
    return { s, env, builtins };
  }

  async turn(i: TurnInput): Promise<TurnOutput> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { s, env, builtins } = await this.base();
    const wc = sdk.createSdkMcpServer({
      name: 'wc',
      version: '0.1.0',
      alwaysLoad: true,
      tools: i.tools.map((t) =>
        sdk.tool(t.name, t.description, t.shape, async (args: any) => {
          try {
            return { content: [{ type: 'text', text: await t.handler(args) }] };
          } catch (e: any) {
            return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
          }
        }),
      ),
    });
    const external = Object.fromEntries(i.external.map((e) => [e.name, e.config]));
    const byName = new Map(i.external.map((e) => [e.name, e]));
    const q = sdk.query({
      prompt: single(i.prompt),
      options: {
        cwd: this.cwd,
        model: s.claude.model || undefined,
        maxTurns: s.claude.maxTurns,
        systemPrompt: i.systemPrompt,
        settingSources: [],
        tools: builtins,
        mcpServers: { wc, ...external },
        allowedTools: [...i.tools.map((t) => `mcp__wc__${t.name}`), ...builtins],
        includePartialMessages: true,
        resume: i.sessionId ?? undefined,
        env,
        canUseTool: async (toolName, input, opts) => {
          const server = opts.mcpServer ? byName.get(opts.mcpServer.name) : undefined;
          if (server && opts.mcpServer?.source !== 'sdk' && i.canUseExternal) {
            const tool = toolName.replace(`mcp__${server.name}__`, '');
            return i.canUseExternal(server, tool, input);
          }
          return { behavior: 'deny', message: `Tool ${toolName} is not available in Work Commander.` };
        },
      },
    });
    let sessionId = i.sessionId ?? '';
    let text = '';
    let lastAssistantText = '';
    for await (const m of q) {
      if ('session_id' in m && m.session_id) sessionId = m.session_id;
      if (m.type === 'stream_event') {
        const ev: any = m.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && !m.parent_tool_use_id) i.onText?.(ev.delta.text);
        if (ev.type === 'message_start') i.onText?.('\n');
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message.content as any[]) {
          if (b.type === 'tool_use') i.onToolCall?.(b.name, b.input);
          if (b.type === 'text') lastAssistantText = b.text;
        }
      } else if (m.type === 'result') {
        if (m.subtype === 'success') text = m.result || lastAssistantText;
        else throw new Error(`Agent stopped: ${m.subtype}`);
      }
    }
    return { sessionId, text };
  }

  async structured<T>(i: { systemPrompt: string; prompt: string; schema: z.ZodType<T>; external?: ExternalMcp[]; canUseExternal?: TurnInput['canUseExternal'] }): Promise<T> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { s, env } = await this.base();
    const jsonSchema = z.toJSONSchema(i.schema, { target: 'draft-7' }) as Record<string, unknown>;
    const ext = i.external ?? [];
    const byName = new Map(ext.map((e) => [e.name, e]));
    const q = sdk.query({
      prompt: single(i.prompt),
      options: {
        cwd: this.cwd,
        model: s.claude.model || undefined,
        maxTurns: ext.length ? 15 : 3,
        systemPrompt: i.systemPrompt,
        settingSources: [],
        tools: [],
        mcpServers: Object.fromEntries(ext.map((e) => [e.name, e.config])),
        persistSession: false,
        outputFormat: { type: 'json_schema', schema: jsonSchema },
        env,
        canUseTool: async (toolName, input, opts) => {
          const server = opts.mcpServer ? byName.get(opts.mcpServer.name) : undefined;
          if (server && i.canUseExternal) return i.canUseExternal(server, toolName.replace(`mcp__${server.name}__`, ''), input);
          return { behavior: 'deny', message: 'Not allowed' };
        },
      },
    });
    let out: unknown;
    let text = '';
    for await (const m of q) {
      if (m.type === 'result') {
        if (m.subtype !== 'success') throw new Error(`Structured call failed: ${m.subtype}`);
        out = m.structured_output;
        text = m.result;
      }
    }
    if (out === undefined) {
      const match = text.match(/\{[\s\S]*\}$/);
      out = match ? JSON.parse(match[0]) : undefined;
    }
    return i.schema.parse(out);
  }

  async test() {
    const r = await this.turn({ systemPrompt: 'Reply with exactly: ok', prompt: 'ping', tools: [], external: [] });
    return r.text.trim();
  }
}
