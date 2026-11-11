import { nanoid } from 'nanoid';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Proposal, Settings } from '@wc/shared';
import type { Repo } from '../core/repo.js';
import type { Executor } from '../core/executor.js';
import type { IntegrationHub } from '../integrations/hub.js';
import type { SecretStore } from '../secrets/store.js';
import { bus } from '../core/bus.js';
import { isReadOnlyTool, toSdkMcpConfig } from '../integrations/mcp.js';
import type { AgentBackend, ExternalMcp } from './backend.js';
import { buildTools, type ToolDeps } from './tools.js';
import { STREAM_AGENT_RULES, itemsBlock, puBlock, streamsBlock } from './prompts.js';

export interface TurnRequest {
  streamId: string | null;
  prompt: string;
  origin: 'user' | 'system' | 'resume';
  selectedItemId?: string;
}

/**
 * Runs the per-stream agent. Each stream has its own Agent SDK session (resumed across turns) and
 * a queue so turns never overlap. When all drafts from a turn have been decided and executed, the
 * agent is resumed with the outcome so it can carry the work forward.
 */
export class StreamAgentRunner {
  private queues = new Map<string, Promise<unknown>>();
  private activeRuns = new Set<string>();

  constructor(
    private repo: Repo,
    private backend: AgentBackend,
    private hub: IntegrationHub,
    private executor: Executor,
    private secrets: SecretStore,
    private settings: () => Promise<Settings>,
    private toolDeps: ToolDeps,
  ) {
    executor.onRunSettled = (runId, streamId, proposals) => this.onRunSettled(runId, streamId, proposals);
  }

  /** Queue a turn; resolves when the turn finishes. */
  run(req: TurnRequest) {
    const key = req.streamId ?? '__general__';
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.execTurn(req));
    this.queues.set(key, next);
    return next;
  }

  private async sessionFor(streamId: string | null) {
    if (streamId) return (await this.repo.getStreamRow(streamId))?.agent_session_id ?? null;
    return (await this.repo.getSync('general.sessionId')) || null;
  }
  private async saveSession(streamId: string | null, id: string) {
    if (streamId) await this.repo.updateStream(streamId, { agentSessionId: id });
    else await this.repo.setSync('general.sessionId', id);
  }

  async externalServers(): Promise<ExternalMcp[]> {
    const s = await this.settings();
    const out: ExternalMcp[] = [];
    for (const sys of ['google', 'slack', 'atlassian'] as const) {
      if ((await this.hub.systemMode(sys)) !== 'mcp') continue;
      const m = s[sys].mcp;
      if (!m) continue;
      try {
        out.push({ name: sys, system: sys, settings: m, config: await toSdkMcpConfig(m, (id) => this.secrets.get(id)) });
      } catch (e: any) {
        console.warn(`[agent] MCP ${sys} unavailable: ${e.message}`);
      }
    }
    return out;
  }

  /**
   * Permission gate for tools served by the PU's own MCP servers. Reads follow the read policy;
   * every write becomes a proposal and the agent is told it was queued (the server executes it
   * with the approved arguments later).
   */
  externalGate(streamId: string | null, runId: string) {
    return async (server: ExternalMcp, tool: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      const s = await this.settings();
      const pol = s[server.system].policy;
      const readOnly = isReadOnlyTool(tool, server.settings);
      if (readOnly && pol.read === 'auto') return { behavior: 'allow', updatedInput: input };
      if (!readOnly && pol.write === 'auto') {
        await this.repo.audit('policy', 'mcp.write.auto', { server: server.name, tool, input });
        return { behavior: 'allow', updatedInput: input };
      }
      const isNativeDraft = !readOnly && /draft/i.test(tool);
      const label = server.system[0].toUpperCase() + server.system.slice(1);
      const editable = Object.entries(input).map(([k, v]) => ({ key: `args.${k}`, label: k, type: typeof v === 'string' ? (String(v).length > 80 ? 'textarea' : 'text') : 'readonly' }) as const);
      const p = await this.repo.createProposal({
        streamId,
        runId,
        kind: readOnly ? 'read_approval' : 'mcp_tool_call',
        system: server.system,
        // A system's own draft tool doesn't send anything; say so plainly so it isn't mistaken for a send.
        title: isNativeDraft ? `${label}: save as a draft in ${label} (not sent; you send it there)` : `${server.name}: ${tool}`,
        rationale: readOnly
          ? `Your policy requires approval for ${server.system} reads.`
          : isNativeDraft
            ? `Approving creates a draft inside ${label} (${tool}); it is not sent until you send it there yourself.`
            : `Agent wants to run ${tool} on ${server.name}.`,
        payload: { server: server.name, system: server.system, tool, args: input },
        editable: [...editable],
      });
      return {
        behavior: 'deny',
        message: `Not executed yet: queued for PU approval as proposal ${p.id}. The dashboard will run it with the approved arguments and report the result. Do not retry; continue with other preparation or end your turn.`,
      };
    };
  }

  private async systemPrompt(streamId: string | null, selectedItemId?: string) {
    const s = await this.settings();
    const self = s.pu.email ? await this.repo.findPersonByEmail(s.pu.email) : null;
    const people = await this.repo.listPeople();
    const manager = self?.managerEmail ? people.find((p) => p.email === self.managerEmail) : null;
    const reports = self ? people.filter((p) => p.managerEmail === self.email) : [];
    const open = await this.repo.listStreams(false);
    const parts = [STREAM_AGENT_RULES, puBlock(s.pu, { self, manager, reports }), streamsBlock(open), `Current time: ${new Date().toISOString()}`];
    if (streamId) {
      const st = await this.repo.getStream(streamId);
      const items = await this.repo.listItems(streamId);
      parts.push(
        `You are working on stream [${streamId}] "${st?.title}" (status ${st?.status}).\nSummary: ${st?.summary}\nTicket target: ${st?.ticketTarget ? JSON.stringify(st.ticketTarget) : s.atlassian.defaultTicketTarget ? `default ${JSON.stringify(s.atlassian.defaultTicketTarget)}` : 'not set'}`,
        itemsBlock(items, selectedItemId),
      );
      const pend = await this.repo.listProposals({ streamId, status: ['pending'] });
      if (pend.length) parts.push('Drafts currently awaiting the PU:\n' + pend.map((p) => `- ${p.id}: ${p.title}`).join('\n'));
    } else {
      parts.push('You are in the general chat, not tied to one stream. Help the PU across all open streams; use create_stream for new work.');
    }
    return parts.join('\n\n');
  }

  private async recap(streamId: string | null) {
    const chat = (await this.repo.listChat(streamId, 40)).filter((m) => m.role !== 'system');
    return chat.length ? `\n\n(Previous session unavailable; recent conversation recap)\n${chat.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join('\n')}` : '';
  }

  private async execTurn(req: TurnRequest) {
    const runId = `r_${nanoid(8)}`;
    const { streamId } = req;
    this.activeRuns.add(runId);
    this.repo.setRunState(streamId, 'running');
    bus.publish({ type: 'run.state', streamId, runId, state: 'running' });
    let text = '';
    const toolCalls: { name: string; input: unknown }[] = [];
    try {
      const tools = await buildTools({ streamId, runId }, this.toolDeps);
      const external = await this.externalServers();
      const systemPrompt = await this.systemPrompt(streamId, req.selectedItemId);
      const prefix = req.origin === 'user' && req.selectedItemId ? `[PU is viewing item ${req.selectedItemId}]\n` : '';
      const base = {
        systemPrompt,
        tools,
        external,
        onText: (t: string) => {
          text += t;
          bus.publish({ type: 'chat.delta', streamId, runId, text: t });
        },
        onToolCall: (name: string, input: unknown) => toolCalls.push({ name: name.replace(/^mcp__wc__/, ''), input }),
        canUseExternal: this.externalGate(streamId, runId),
      };
      const sessionId = await this.sessionFor(streamId);
      let out;
      try {
        out = await this.backend.turn({ ...base, prompt: prefix + req.prompt, sessionId });
      } catch (e) {
        if (!sessionId) throw e;
        // Session lost (e.g. Cloud Run restart wiped local session files): start fresh with a recap.
        out = await this.backend.turn({ ...base, prompt: prefix + req.prompt + (await this.recap(streamId)), sessionId: null });
      }
      if (out.sessionId) await this.saveSession(streamId, out.sessionId);
      const final = (out.text || text).trim();
      if (final) await this.repo.addChat({ streamId, role: 'assistant', content: final, meta: { runId, toolCalls } });
      bus.publish({ type: 'run.state', streamId, runId, state: 'done' });
    } catch (e: any) {
      await this.repo.addChat({ streamId, role: 'system', content: `Agent error: ${e.message}`, meta: { runId } });
      bus.publish({ type: 'run.state', streamId, runId, state: 'error', error: e.message });
    } finally {
      this.activeRuns.delete(runId);
      const pending = await this.repo.listProposals({ runId, status: ['pending'] });
      this.repo.setRunState(streamId, pending.length ? 'waiting_approval' : 'idle');
      if (streamId) await this.repo.updateStream(streamId, { touch: true });
      // The PU may have decided drafts while the turn was still running.
      const all = await this.repo.listProposals({ runId });
      if (all.length && !all.some((p) => ['pending', 'approved', 'executing'].includes(p.status))) {
        void this.onRunSettled(runId, streamId, all);
      }
    }
  }

  private reported = new Set<string>();

  private async onRunSettled(runId: string, streamId: string | null, proposals: Proposal[]) {
    if (this.activeRuns.has(runId) || this.reported.has(runId)) return;
    // Drafts executed automatically by policy were already reported to the agent as tool results.
    if (proposals.every((p) => this.executor.autoApproved.has(p.id))) return;
    this.reported.add(runId);
    const lines = proposals.map((p) => {
      const edited = JSON.stringify(p.payload) !== JSON.stringify(p.originalPayload);
      const outcome =
        p.status === 'executed'
          ? `approved${edited ? ' WITH PU EDITS' : ''} and executed. Result: ${JSON.stringify(p.result).slice(0, 4000)}`
          : p.status === 'rejected'
            ? `rejected by the PU${p.error ? `: "${p.error}"` : ''}`
            : `${p.status}${p.error ? `: ${p.error}` : ''}`;
      return `- ${p.id} (${p.kind}: ${p.title}) ${outcome}`;
    });
    const anyEdited = proposals.some((p) => p.status === 'executed' && JSON.stringify(p.payload) !== JSON.stringify(p.originalPayload));
    const prompt =
      `[Dashboard event] The PU has decided on your drafts:\n${lines.join('\n')}\n` +
      (anyEdited ? 'Note how the PU edited the wording and match their style in future drafts.\n' : '') +
      'Continue the work stream: take the next step if one is clear (drafting it for approval), otherwise give the PU a one-line status.';
    await this.run({ streamId, prompt, origin: 'resume' });
  }
}
