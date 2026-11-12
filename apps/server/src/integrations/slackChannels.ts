import type { Settings } from '@wc/shared';
import { McpConnection } from './mcp.js';
import { SlackWorkspace } from './slack.js';

export interface SlackChannelInfo {
  id: string;
  name: string;
  private: boolean;
}

/** Parse the Slack MCP server's markdown channel list: "### #name\n- **ID:** C123\n- **Type:** Private Channel\n- **Archived:** No". */
export function parseChannelMarkdown(text: string): SlackChannelInfo[] {
  let body = text;
  try {
    const j = JSON.parse(text);
    if (typeof j?.result === 'string') body = j.result;
  } catch {
    /* plain text */
  }
  const out: SlackChannelInfo[] = [];
  for (const block of body.split(/\n(?=### )/)) {
    const name = /^### #?(\S+)/m.exec(block)?.[1];
    const id = /\*\*ID:\*\*\s*([A-Z0-9]+)/.exec(block)?.[1];
    if (!name || !id || /\*\*Archived:\*\*\s*Yes/i.test(block)) continue;
    out.push({ id, name, private: /\*\*Type:\*\*\s*Private/i.test(block) });
  }
  return out;
}

/** Channels the PU is a member of (public and private, not DMs), sorted by name. */
export async function listMemberChannels(s: Settings, secret: (id: string) => Promise<string>): Promise<SlackChannelInfo[]> {
  let out: SlackChannelInfo[] = [];
  if (s.slack.mode === 'mcp') {
    if (!s.slack.mcp) throw new Error('Slack MCP server is not configured');
    const conn = await McpConnection.open(s.slack.mcp, secret);
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await conn.call('slack_list_user_channels', { limit: 200, exclude_archived: true, ...(cursor ? { cursor } : {}) });
        out.push(...parseChannelMarkdown(r.text));
        cursor = /more results available/i.test(r.text) ? /next[_ ]cursor\W+([A-Za-z0-9=_-]+)/i.exec(r.text)?.[1] : undefined;
        if (!cursor) break;
      }
    } finally {
      await conn.close();
    }
  } else {
    if (!s.slack.api.userTokenId) throw new Error('Add the Slack user token first');
    const slack = new SlackWorkspace(await secret(s.slack.api.userTokenId));
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await slack.web.users.conversations({ types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
      for (const c of r.channels ?? []) if (c.id && c.name) out.push({ id: c.id, name: c.name, private: !!c.is_private });
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  }
  const seen = new Set<string>();
  out = out.filter((c) => !seen.has(c.id) && seen.add(c.id));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
