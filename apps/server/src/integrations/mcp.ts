import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerSettings } from '@wc/shared';

type SecretFn = (id: string) => Promise<string>;

async function resolveMap(m: Record<string, string | { secretId: string }> | undefined, secret: SecretFn) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k] = typeof v === 'string' ? v : await secret(v.secretId);
  return out;
}

/** Turn a PU-configured MCP server into the Agent SDK's config shape, with secrets resolved. */
export async function toSdkMcpConfig(s: McpServerSettings, secret: SecretFn): Promise<McpServerConfig> {
  if (s.transport === 'stdio') {
    if (!s.command) throw new Error('MCP stdio server needs a command');
    return { type: 'stdio', command: s.command, args: s.args ?? [], env: { ...(process.env as Record<string, string>), ...(await resolveMap(s.env, secret)) } };
  }
  if (!s.url) throw new Error('MCP server needs a URL');
  return { type: s.transport, url: s.url, headers: await resolveMap(s.headers, secret) } as McpServerConfig;
}

export function isReadOnlyTool(name: string, s: McpServerSettings, annotations?: { readOnlyHint?: boolean }) {
  if (annotations?.readOnlyHint === true) return true;
  if (annotations?.readOnlyHint === false) return false;
  return (s.readOnlyToolPatterns ?? []).some((p) => {
    try {
      return new RegExp(p, 'i').test(name);
    } catch {
      return false;
    }
  });
}

/**
 * Direct MCP client used by the server itself: to list tools (Settings → Test), and to execute a
 * tool call the PU approved, with exactly the arguments they approved.
 */
export class McpConnection {
  private client: any;
  private constructor() {}

  static async open(s: McpServerSettings, secret: SecretFn) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const conn = new McpConnection();
    conn.client = new Client({ name: 'work-commander', version: '0.1.0' });
    let transport: any;
    if (s.transport === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      transport = new StdioClientTransport({ command: s.command!, args: s.args ?? [], env: { ...(process.env as Record<string, string>), ...(await resolveMap(s.env, secret)) } });
    } else if (s.transport === 'sse') {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      const headers = await resolveMap(s.headers, secret);
      transport = new SSEClientTransport(new URL(s.url!), { requestInit: { headers }, eventSourceInit: { fetch: (u: any, i: any) => fetch(u, { ...i, headers: { ...(i?.headers ?? {}), ...headers } }) } as any });
    } else {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      transport = new StreamableHTTPClientTransport(new URL(s.url!), { requestInit: { headers: await resolveMap(s.headers, secret) } });
    }
    await conn.client.connect(transport);
    return conn;
  }

  async listTools(): Promise<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean } }[]> {
    const r = await this.client.listTools();
    return r.tools;
  }

  async call(name: string, args: Record<string, unknown>) {
    const r = await this.client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
    if (r.isError) throw new Error(text || 'MCP tool returned an error');
    return { text, structured: r.structuredContent };
  }

  async close() {
    await this.client.close().catch(() => undefined);
  }
}

/** Pull a ticket key and a URL out of free-form MCP tool output (for {{ticket.key}} placeholders). */
export function extractRefs(text: string) {
  return {
    key: text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/)?.[0],
    url: text.match(/https?:\/\/[^\s"'<>)]+/)?.[0]?.replace(/[.,;:!?]+$/, ''),
  };
}
