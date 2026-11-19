// Shared domain types and API contracts used by both server and web.

export type SystemId = 'google' | 'slack' | 'atlassian' | 'onepassword';
export const SYSTEMS: SystemId[] = ['google', 'slack', 'atlassian', 'onepassword'];

export type ItemSource =
  | 'gmail'
  | 'slack'
  | 'jira'
  | 'jsm'
  | 'confluence'
  | 'drive'
  | 'calendar'
  | 'grant'
  | 'mcp'
  | 'note';

export type StreamStatus = 'open' | 'closed';

export interface PrimaryUser {
  name: string;
  email: string;
  orgFunction: string;
  /** Extra identities the PU is known by (aliases, secondary emails, Slack handle). */
  aliases: string[];
  slackUserId?: string;
  atlassianAccountId?: string;
  /** Free-text guidance on what matters to the PU and what is noise. */
  relevanceNotes: string;
}

export interface Person {
  id: string;
  name: string;
  email: string;
  title?: string;
  department?: string;
  managerEmail?: string;
  slackUserId?: string;
  atlassianAccountId?: string;
  source: 'workday-rest' | 'workday-raas' | 'file' | 'jira-assets' | 'manual';
}

/** A deadline on a work stream, read from a message (or set by the PU). */
export interface StreamDeadline {
  at: string;
  /** Only a day was given (shown without a time; counts as end of that day). */
  allDay?: boolean;
  quote?: string;
  who?: string;
  source?: string;
  itemId?: string;
  by: 'triage' | 'you';
}

export interface WorkStream {
  id: string;
  title: string;
  summary: string;
  status: StreamStatus;
  labels: string[];
  ticketTarget?: TicketTarget;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  lastActivityAt: string;
  pendingProposals: number;
  unread: boolean;
  /** The PU has done all they can for now and is waiting on others. Still open; listed under "Pending" until something new arrives. */
  pending: boolean;
  /** Set while the stream is surfaced as a reminder: it sat in Pending untouched for the configured days. Cleared when it is snoozed again, closed, or others write. */
  reminderAt?: string | null;
  /** Pending until this moment (snoozed to a date); then it comes back to the top of Open, unread, marked Back. Null for plain Pending. */
  snoozeUntil?: string | null;
  /** Set while the stream is back from a snooze that ran out. Cleared like reminderAt. */
  backAt?: string | null;
  /** New activity reopened this closed stream at this moment. Cleared by your next move on it: a reply, Pending, closing it again. */
  reopenedAt?: string | null;
  /** When the PU must deliver ("I need this by Friday"). */
  due?: StreamDeadline | null;
  /** When someone else said they'd deliver to the PU ("I'll get it to you by Friday"): offered in the Pending ▾ menu. */
  promised?: StreamDeadline | null;
  /** Both, as stored. */
  deadlines?: { due?: StreamDeadline | null; promised?: StreamDeadline | null };
  /** The tool the most recently updated item came from (shown as an icon on the stream). */
  lastSource?: ItemSource;
  runState: 'idle' | 'running' | 'waiting_approval';
}

export interface TicketTarget {
  flavor: 'jsm' | 'jira';
  projectKey: string;
  /** JSM: request type id. Jira: issue type name. */
  typeId: string;
  /** JSM only: service desk id. */
  serviceDeskId?: string;
}

/** A file attached to a message (or a ticket). The bytes stay at the source; `ref` is how to fetch them there. */
export interface MessageAttachment {
  /** Stable within the item (Gmail part id, Slack file id, Jira attachment id). */
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  /** Gmail attachment id, Slack url_private, or Jira content URL. */
  ref: string;
}

export interface ThreadMessage {
  id: string;
  attachments?: MessageAttachment[];
  /** Slack emoji reactions on the message: name, how many, and whether one of them is the PU's. */
  reactions?: { name: string; count: number; mine: boolean }[];
  author: { name?: string; email?: string; slackUserId?: string; accountId?: string };
  to?: string[];
  cc?: string[];
  subject?: string;
  text: string;
  html?: string;
  at: string;
  isFromPU?: boolean;
}

export interface StreamItem {
  id: string;
  streamId: string | null;
  source: ItemSource;
  kind: 'email_thread' | 'slack_thread' | 'ticket' | 'doc' | 'event' | 'grant' | 'other';
  externalId: string;
  title: string;
  url?: string;
  data: ItemData;
  updatedAt: string;
}

export interface ItemData {
  messages?: ThreadMessage[];
  /** Work streams the PU said this item does not belong to; triage won't put it back there. */
  notRelevantTo?: string[];
  /** The PU dismissed this from the Skipped list at this time; new activity after it brings it back. */
  dismissedAt?: string;
  /** When Work Commander last changed this ticket's status itself (so the resulting state isn't mistaken for new activity). */
  wcTransitionAt?: string;
  /** New activity arrived on this item that the PU hasn't opened yet (a dot on its tab). */
  unread?: boolean;
  /** Position of this item's tab within its work stream when the PU has rearranged them. */
  tabOrder?: number;
  /** When the PU last arranged this stream's tabs; the "most recent tab first" setting only applies to activity newer than this. */
  tabOrderAt?: string;
  /** External ids of items folded into this one (Slack messages from the same channel discussion), so re-ingesting them lands here. */
  mergedExternalIds?: string[];
  /** Triage wants this to be a new work stream and is waiting for the PU to accept or decline (Settings → Triage, "Ask me first"). */
  proposedStream?: { title: string; summary: string; labels: string[]; reason: string; at: string; decision: unknown };
  /** The PU used "Dismiss and mute" on a skipped item or a proposed work stream: later updates to this item are stored but never triaged again (so it does not come back or get re-proposed). Ends once it is in a work stream. */
  proposalsMuted?: boolean;
  /** The PU silenced this item: updates are still pulled in, but they don't notify, mark the stream unread or reopen it. */
  muted?: boolean;
  /** Ticket-specific */
  ticket?: {
    key: string;
    summary: string;
    status: string;
    assignee?: string;
    reporter?: string;
    requester?: string;
    description?: string;
    flavor: 'jsm' | 'jira';
    comments: ThreadMessage[];
    /** Files attached to the issue. */
    attachments?: MessageAttachment[];
  };
  /** Slack-specific */
  slack?: { channel: string; channelName?: string; threadTs: string };
  /** Gmail-specific */
  gmail?: { threadId: string; lastMessageIdHeader?: string; references?: string; state?: GmailThreadState };
  /** Calendar meeting linked to the stream: when, who, and whether it was briefed / followed up. */
  meeting?: { start: string; end: string; attendees: string[]; briefedAt?: string; followedUpAt?: string };
  /** Generic body for docs/other */
  body?: string;
  raw?: unknown;
}

export type ProposalKind =
  | 'email_reply'
  | 'email_send'
  | 'slack_post'
  | 'ticket_create'
  | 'ticket_comment'
  | 'ticket_transition'
  | 'ticket_assign'
  | 'playbook'
  | 'credential_request'
  | 'stream_close'
  | 'mcp_tool_call'
  | 'read_approval';

/** Someone @-mentioned in a draft. On sending it becomes a real mention where the tool has them (Slack, Jira/JSM). */
export interface DraftMention {
  name: string;
  email?: string;
  slackUserId?: string;
}

/** A file attached to a draft. The bytes live server-side; drafts carry only this reference in payload.attachments. */
export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}
/** Draft kinds that can carry attachments. */
export const ATTACHABLE_KINDS: ProposalKind[] = ['email_reply', 'email_send', 'slack_post', 'ticket_create', 'ticket_comment'];

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'expired'
  /** Superseded without the PU deciding, e.g. a close suggestion once work on the stream continued. */
  | 'withdrawn';

export interface Proposal {
  id: string;
  streamId: string | null;
  runId: string;
  kind: ProposalKind;
  system: SystemId | 'internal';
  title: string;
  /** Agent's one-line explanation of why. */
  rationale: string;
  payload: Record<string, unknown>;
  originalPayload: Record<string, unknown>;
  /** Fields the PU may edit, in display order. */
  editable: EditableField[];
  dependsOn: string[];
  status: ProposalStatus;
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  decidedAt?: string | null;
  executedAt?: string | null;
}

export interface EditableField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'list' | 'readonly' | 'select';
  options?: string[];
}

export interface ChatMessage {
  id: string;
  streamId: string | null;
  role: 'user' | 'assistant' | 'system' | 'suggestion' | 'question';
  content: string;
  meta: {
    suggestion?: { instruction: string; status: 'open' | 'accepted' | 'dismissed' };
    question?: { options?: string[]; answered?: boolean };
    /** Claude asks whether to send an "I'm looking into it" reply or hand the work to Claude Code (one click each). */
    handoffOffer?: { task: string; done: ('reply' | 'handoff')[]; dismissed?: boolean };
    /** A message said someone added the PU to a chat; WC found a conversation that looks like it and offers to add it to the work stream. */
    chatOffer?: { channel: string; label: string; participants: string[]; reason: string; state: 'open' | 'added' | 'dismissed'; added?: number };
    selectedItemId?: string;
    toolCalls?: { name: string; input: unknown }[];
    runId?: string;
    /** Written by a Claude Code session running inside WC (Settings → Claude Code), not WC's own Claude. */
    claudeCode?: boolean;
    /** Claude Code asks to use a tool (run a command, edit a file, fetch a site); waits here for Allow / Deny. */
    ccApproval?: { id: string; tool: string; summary: string; detail: string; status: 'waiting' | 'allowed' | 'denied' | 'expired' };
  };
  createdAt: string;
}

/** A Claude Code session running inside WC for a work stream. */
export interface ClaudeCodeStatus {
  /** Settings → Claude Code is on, WC runs on this machine and listens only on it. */
  enabled: boolean;
  /** Why it can't run here, when it can't. */
  unavailable?: string;
  /** Sent back with every Claude Code request (only WC's own pages can read it). */
  token?: string;
  session?: { state: 'running' | 'waiting' | 'done' | 'stopped' | 'failed' | 'interrupted'; folder: string; startedAt: string; error?: string } | null;
}

// ---------- Settings ----------

export type ClaudeProvider = 'claude-code-login' | 'vertex' | 'api-key';
export type SecretBackend = 'keychain' | 'gcp-secret-manager' | 'onepassword';
export type OnePasswordMode = 'service-account' | 'connect' | 'cli';
export type IngestionMode = 'realtime' | 'polling' | 'off';
export type PolicyMode = 'auto' | 'approve';

export interface McpServerSettings {
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  /** Header or env name -> plain value or {secretId} */
  headers?: Record<string, string | { secretId: string }>;
  env?: Record<string, string | { secretId: string }>;
  /**
   * OAuth sign-in for remote (http/sse) servers that require it, e.g. Slack's or Atlassian's hosted MCP servers.
   * Leave clientId empty to register automatically (dynamic client registration) when the server supports it.
   */
  oauth?: { enabled: boolean; clientId?: string; clientSecretId?: string; scope?: string; connectedAs?: string; connectedAt?: string };
  /** Regexes over tool names considered read-only. */
  readOnlyToolPatterns: string[];
  /** Agent-driven ingestion instructions (MCP mode only has polling). */
  ingestionPrompt?: string;
}

export interface GoogleSettings {
  enabled: boolean;
  mode: 'oauth' | 'mcp';
  oauth: {
    clientId: string;
    clientSecretId?: string; // credential id
    refreshTokenId?: string;
    connectedEmail?: string;
    gmailQuery: string;
    pubsubTopic?: string; // projects/x/topics/y for realtime
    pubsubSubscription?: string;
  };
  mcp?: McpServerSettings;
  ingestion: IngestionMode;
  pollSeconds: number;
  policy: { read: PolicyMode; write: PolicyMode };
}

export interface SlackSettings {
  enabled: boolean;
  mode: 'api' | 'mcp';
  api: { userTokenId?: string; appTokenId?: string; teamUrl?: string };
  mcp?: McpServerSettings;
  /** Channels to watch for new messages even when they don't mention the PU: names (#sys-eng) or ids, separated by commas or new lines. */
  watchedChannels: string;
  /**
   * MCP mode: read Slack with plain tool calls (no Claude, no tokens). Off: Claude collects activity with the same tools,
   * following the server's ingestion instructions. If a direct read fails, that poll falls back to Claude. Default on.
   */
  mcpDirect?: boolean;
  ingestion: IngestionMode;
  pollSeconds: number;
  policy: { read: PolicyMode; write: PolicyMode };
  /** The five emoji offered first for reacting to a Slack message (Slack names, e.g. "+1"). */
  quickReactions?: string[];
}

/** The emoji you can react with: Slack's standard set and your workspace's own. */
export interface EmojiCatalog {
  standard: { n: string; a?: string[]; c: string; cat: string }[];
  /** Workspace emoji: name -> image URL. */
  custom: Record<string, string>;
}

export interface AtlassianSettings {
  enabled: boolean;
  mode: 'api' | 'mcp';
  api: { siteUrl: string; email: string; apiTokenId?: string; webhookSecretId?: string };
  mcp?: McpServerSettings;
  defaultTicketTarget?: TicketTarget;
  jql: string;
  ingestion: IngestionMode;
  pollSeconds: number;
  policy: { read: PolicyMode; write: PolicyMode };
}

export interface OnePasswordSettings {
  enabled: boolean;
  mode: OnePasswordMode;
  serviceAccountTokenId?: string;
  connect?: { url: string; tokenId?: string };
  cli?: { account?: string };
  /** Vault agents may request items from. */
  accessVault: string;
  /** Vault used when 1Password is chosen as a secret backend. */
  secretsVault: string;
  grantTtlMinutes: number;
  policy: { read: PolicyMode; write: PolicyMode };
}

export type OrgChartSourceSettings =
  | { type: 'none' }
  | {
      type: 'workday-rest';
      host: string;
      tenant: string;
      clientId: string;
      clientSecretId?: string;
      refreshTokenId?: string;
      mapping: FieldMapping;
    }
  | { type: 'workday-raas'; url: string; username: string; passwordId?: string; /** How often to re-pull the report, in hours (default 24). */ updateEveryHours?: number; mapping: FieldMapping }
  | { type: 'file'; mapping: FieldMapping }
  | { type: 'jira-assets'; workspaceId: string; aql: string; mapping: FieldMapping };

export interface OrgChartSyncStatus {
  /** Last attempt, successful or not (ISO). */
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  /** Set when the last attempt failed; the existing org chart was left as it was. */
  lastError?: string;
  lastCount?: number;
}

/** Background calls that can run on their own model. */
export type BackgroundTask = 'triage' | 'topicSplit' | 'slackContext' | 'mcpIngest' | 'dateParse' | 'writingStyle' | 'meetingLink' | 'deadlines';
export const BACKGROUND_TASKS: { id: BackgroundTask; label: string; hint: string }[] = [
  { id: 'triage', label: 'Triage', hint: 'Whether a message needs you, which work stream it belongs to, and what to do next.' },
  { id: 'topicSplit', label: 'Slack topic splitting', hint: 'Sorting a Slack conversation that runs several topics into the right work streams.' },
  { id: 'slackContext', label: 'Slack context', hint: 'Picking the earlier Slack messages a linked message depends on.' },
  { id: 'mcpIngest', label: 'MCP items', hint: 'Pulling new items in from a system connected through an MCP server.' },
  { id: 'writingStyle', label: 'Learning your writing style', hint: 'Describing how you write from your own sent messages (run when you ask, in Settings → Writing style).' },
  { id: 'meetingLink', label: 'Linking meetings', hint: 'Deciding which work stream a calendar meeting is about (only asked when a meeting shares people or words with a stream).' },
  { id: 'deadlines', label: 'Spotting deadlines', hint: 'Reading a deadline ("I need this by Friday") from a message when triage didn\'t already ask Claude (Laya, a rule, or your own message). Only asked when the words look like a deadline.' },
  { id: 'dateParse', label: 'Reading dates', hint: 'Turning a time you type ("the Thursday after next, 2pm") into a date, e.g. for snoozing a work stream.' },
];
/** 'main' = the main model; otherwise a Claude model alias. */
export type ModelChoice = 'main' | 'haiku' | 'sonnet' | 'opus';
export type TaskModels = Record<BackgroundTask, ModelChoice>;

/** Every kind of call usage is recorded for. */
/** 'agent' is Claude's stream work before turns were told apart (chat, drafting, hand-offs, keeping streams current). */
export type UsageKind = BackgroundTask | 'agent' | 'agentChat' | 'agentDraft' | 'agentHandoff' | 'agentReview' | 'newStream' | 'overview' | 'test' | 'laya' | 'claudeCode';
export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  triage: 'Triage',
  topicSplit: 'Slack topic splitting',
  slackContext: 'Slack context',
  mcpIngest: 'MCP items',
  dateParse: 'Reading dates',
  writingStyle: 'Learning your writing style',
  meetingLink: 'Linking meetings',
  deadlines: 'Spotting deadlines',
  claudeCode: 'Claude Code (hand-off work)',
  agent: 'Agent (before categories)',
  agentChat: 'Chatting with you',
  agentDraft: 'Drafting messages',
  agentHandoff: 'Claude Code hand-offs',
  agentReview: 'Keeping streams up to date',
  newStream: 'New stream overviews',
  overview: 'Overview refreshes',
  test: 'Connection tests',
  laya: 'Laya (local)',
};

/** What usage is shown by (Settings → Usage, and each work stream's Overview). Fixed order: it is also the colour order. */
export type UsageCategory = 'triage' | 'reading' | 'drafting' | 'handoff' | 'claudeCode' | 'chat' | 'review' | 'overview' | 'other';
export const USAGE_CATEGORIES: { id: UsageCategory; label: string; hint: string; kinds: UsageKind[] }[] = [
  { id: 'triage', label: 'Triage', hint: 'Deciding whether new activity needs you and which work stream it belongs to, naming new streams, sorting Slack conversations by topic', kinds: ['triage', 'newStream', 'topicSplit', 'deadlines'] },
  { id: 'reading', label: 'Reading Slack and other sources', hint: 'Checking for new activity through MCP servers, and finding the later Slack messages a linked one leads to', kinds: ['mcpIngest', 'slackContext', 'meetingLink'] },
  { id: 'drafting', label: 'Drafting messages', hint: "Claude's turns that prepared replies, messages or ticket changes for you to approve", kinds: ['agentDraft'] },
  { id: 'handoff', label: 'Claude Code hand-offs', hint: 'Taking in what Claude Code reports back', kinds: ['agentHandoff'] },
  { id: 'claudeCode', label: 'Claude Code (hand-off work)', hint: "Claude Code's own work on hand-offs, read from its session transcripts when the results come back (cost estimated at API list prices)", kinds: ['claudeCode'] },
  { id: 'chat', label: 'Chatting with you', hint: 'Your messages to Claude and its answers (when it drafted something, that turn counts as drafting)', kinds: ['agentChat'] },
  { id: 'review', label: 'Keeping streams up to date', hint: 'Claude reviewing new items, your direct replies and finished drafts, and updating the work stream', kinds: ['agentReview'] },
  { id: 'overview', label: 'Overview refreshes', hint: 'Refresh overview, and overviews for streams you start by dropping an item on "+"', kinds: ['overview'] },
  { id: 'other', label: 'Other', hint: 'Connection tests, and Claude stream work from before usage was split by category', kinds: ['agent', 'test', 'laya', 'dateParse', 'writingStyle'] },
];
export const usageCategoryOf = (k: UsageKind): UsageCategory => USAGE_CATEGORIES.find((c) => c.kinds.includes(k))?.id ?? 'other';


export interface UsageSettings {
  /** How usage figures (and the budget) are shown everywhere. */
  unit: 'tokens' | 'dollars';
  /** Daily budget in the chosen unit; 0 = no budget. An estimate at API prices when shown in dollars. */
  dailyBudget: number;
  /** Where the alert goes when today's usage passes the budget. */
  alertBanner: boolean;
  alertDesktop: boolean;
  alertEmail: boolean;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated cost at API list prices. */
  costUsd: number;
}
/** All tokens a call used: input (including cached) plus output. */
export const totalTokens = (t: UsageTotals) => t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
/** "12.3k tokens", or "$0.042" (dollar figures are estimates at API prices). */
export function formatUsage(t: UsageTotals, unit: 'tokens' | 'dollars') {
  if (unit === 'dollars') return `$${t.costUsd < 1 ? t.costUsd.toFixed(3) : t.costUsd.toFixed(2)}`;
  const n = totalTokens(t);
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M tokens` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k tokens` : `${n} tokens`;
}

export interface UsageReport {
  days: { day: string; byKind: Partial<Record<UsageKind, UsageTotals>>; total: UsageTotals }[];
  byModel: { model: string; totals: UsageTotals }[];
  byKind: { kind: UsageKind; totals: UsageTotals }[];
  today: UsageTotals;
  /** Set while today's usage is over the budget and the banner hasn't been dismissed. */
  alert: { day: string; message: string } | null;
}

export interface StreamUsage {
  /** The unit chosen in Settings → Usage. */
  unit: 'tokens' | 'dollars';
  triage: UsageTotals;
  agent: UsageTotals;
  total: UsageTotals;
  byCategory: Partial<Record<UsageCategory, UsageTotals>>;
}

// ---------- Laya (local triage model) ----------

/** The three parts of triage Laya can take over, each judged separately. */
export type LayaPart = 'relevance' | 'stream' | 'next';
export const LAYA_PARTS: { id: LayaPart; label: string }[] = [
  { id: 'relevance', label: 'Needs you?' },
  { id: 'stream', label: 'Which work stream' },
  { id: 'next', label: 'Next step' },
];
/** collecting: not enough examples to train yet; shadowing: trained, compared with Claude; proposed: qualified, waiting for the PU; live: Laya decides. */
export type LayaPartState = 'collecting' | 'shadowing' | 'proposed' | 'live';

export interface TriageEngineSettings {
  engine: 'claude' | 'laya';
  /** 'create': triage starts new work streams itself. 'ask': it proposes them, and the PU accepts or declines each one. */
  newStreams: 'create' | 'ask';
  /** Agreement with Claude needed before WC offers to switch a part to Laya. */
  agreeThreshold: number;
  /** Over at least this many recent messages. */
  minMessages: number;
}

export interface LayaPartStatus {
  part: LayaPart;
  state: LayaPartState;
  /** Training examples collected for this part / needed for the first training. */
  examples: number;
  examplesNeeded: number;
  /** Shadowing (or, once live, measured against the PU's corrections): compared messages in the window and how many agreed. */
  compared: number;
  agreed: number;
  /** Live only: share of recent decisions the PU corrected, and whether WC suggests retraining. */
  suggestRetrain: boolean;
  trainedAt: string | null;
  version: number;
}

export interface LayaStatus {
  install: { state: 'absent' | 'installing' | 'installed' | 'failed'; message?: string; progress?: string };
  server: { running: boolean; message?: string };
  training: { running: boolean; message?: string };
  parts: LayaPartStatus[];
  /** Recent cases where Laya and Claude (or the PU) disagreed. */
  disagreements: { at: string; part: LayaPart; itemId: string; title: string; laya: string; claude: string }[];
}

export interface ReminderSettings {
  /** Pending work streams untouched this many days come back to the top as a Reminder. 0 = never. */
  pendingDays: number;
}

export interface SilencingSettings {
  /** Don't check silenced items for updates at all (nothing about them is stored or re-read while they are silenced). */
  skipPolling: boolean;
  /** An update that directly refers to the PU (a mention, their name or email) breaks through a silenced item. Ignored when skipPolling is on. */
  mentionsOverride: boolean;
}

/** Scheduled copies of Work Commander's local database into a folder (e.g. a Google Drive folder). */
export interface BackupSettings {
  enabled: boolean;
  folder: string;
  everyHours: number;
  /** How many backups to keep in the folder; older ones are deleted. */
  keep: number;
}

export interface BackupStatus {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastError?: string;
}

export interface FieldMapping {
  name: string;
  email: string;
  title?: string;
  department?: string;
  managerEmail?: string;
  /** This person's employee ID (needed when managers are linked by employee ID). */
  employeeId?: string;
  /** The manager's employee ID. */
  managerEmployeeId?: string;
  /** Which field links a person to their manager. Defaults to 'email'. */
  managerLink?: 'email' | 'employeeId';
}

/**
 * A rule applied before triage to an update that isn't in a work stream yet: matching updates are ignored, or filed into a
 * work stream, without asking Claude (or Laya). Every condition filled in must match (case-insensitive "contains").
 */
export interface TriageRule {
  id: string;
  source: 'any' | 'gmail' | 'slack' | 'jira';
  /** The sender's name or address contains this (e.g. "@news.example.com"). */
  from?: string;
  /** The subject or title contains this. */
  subject?: string;
  /** A new message's text contains this. */
  text?: string;
  action: 'ignore' | 'stream';
  /** For 'stream': where it goes. */
  streamId?: string;
  /** Off rules are kept but not applied. Default on. */
  enabled?: boolean;
}

/** One result of a search across everything (Search, ⌘K). */
export interface SearchHit {
  kind: 'stream' | 'message' | 'chat';
  streamId: string | null;
  streamTitle: string | null;
  streamStatus: StreamStatus | null;
  itemId?: string;
  itemTitle?: string;
  source?: ItemSource;
  /** Who wrote the message (messages and chat). */
  who?: string;
  snippet: string;
  at: string;
}

/** Whether polling and triage are paused (after a long gap, or by hand), and what is waiting for Resume. */
export interface PollingState {
  paused: { since: string; reason: 'gap' | 'manual'; /** When polling last ran before the gap. */ gapFrom?: string } | null;
  /** Live updates (Slack events, Jira webhooks) held while paused; handled on Resume. */
  held: number;
  /** Resume is catching up on the gap. */
  catchingUp: boolean;
  /** How the catch-up is going: reading the sources (round by round, until a round finds nothing new), then triaging what was found. */
  progress?: { phase: 'reading' | 'triaging'; round: number; found: number; done: number; total: number; retrying?: string };
}

export interface Settings {
  pu: PrimaryUser;
  claude: {
    provider: ClaudeProvider;
    model: string;
    vertex: { projectId: string; region: string };
    apiKeyId?: string;
    allowWebResearch: boolean;
    autoDraft: boolean;
    /** Sort a Slack DM's new messages into the work stream each one belongs to (a conversation can run several topics). Default on. */
    splitSlackByTopic?: boolean;
    /** New activity on a closed stream reopens it only if it closed within this many days; otherwise a new stream starts. */
    reopenClosedWithinDays: number;
    maxTurns: number;
    /** Model for each background call; 'main' means the model above. The chat agent and drafting always use the main model. */
    taskModels?: TaskModels;
  };
  secrets: { defaultBackend: SecretBackend; gcpProjectId: string };
  google: GoogleSettings;
  slack: SlackSettings;
  atlassian: AtlassianSettings;
  onepassword: OnePasswordSettings;
  orgChart: OrgChartSourceSettings;
  ui: { showClosedByDefault: boolean; /** Put the most recently active item tab right after Overview. */ recentTabFirst?: boolean;
    /** What a work stream shows when you open it: its Overview, or its most recently updated item tab. */
    openTab?: 'overview' | 'recent';
    /** How emails show by default: the plain-text copy, or the original HTML. Each message can still be flipped. */
    emailView?: 'text' | 'original';
    /** Closing a work stream takes two clicks (the first arms the button). Default on. */
    confirmClose?: boolean;
    /** After Undo, show a short message saying what was undone. Default on. */
    undoToast?: boolean;
    /** When you close the work stream you're on: keep showing it, open the next one in the list (default), or go to All open work. */
    afterClose?: 'stay' | 'next' | 'all';
    /** Show the newest message first in work items, per kind (default oldest first). */
    newestFirst?: { email?: boolean; slack?: boolean; tickets?: boolean };
    /** Work streams stay unread until you click Read (opening one doesn't mark it read). Default off. */
    manualStreamRead?: boolean;
    /** Work items stay unread until you click Read on the item (opening its tab doesn't). Default off. */
    manualItemRead?: boolean;
  };
  backup: BackupSettings;
  /** How silenced work items behave. */
  silencing: SilencingSettings;
  /** When snoozed (Pending) work streams are surfaced again. */
  reminders: ReminderSettings;
  usage: UsageSettings;
  /**
   * Claude Code inside WC (local only, off by default): runs in the hand-off folder in the OS sandbox; commands, edits, reading
   * outside the folder and web fetches wait for your Allow. Network only to the allow-listed sites.
   */
  claudeCode?: {
    enabled: boolean;
    allowedDomains: string[];
    maxMinutes: number;
    maxTurns: number;
    maxBudgetUsd: number;
    /** Read CLAUDE.md instructions (yours and the project's) into it. Settings files are never read. Default off. */
    loadClaudeMd?: boolean;
    /** Skills it may use: 'all' (yours and the project's) or the names you picked. Default none. */
    skills?: 'all' | string[];
  };
  /** Calendar meetings linked to work streams: a brief before, a follow-up after. */
  meetings?: { enabled: boolean; /** Minutes before the start to post the brief (0 = no brief). */ briefMinutes: number; followUp: 'offer' | 'draft' | 'off' };
  /** Drafts written the way the PU writes: a guide learned from their sent messages, which they can edit. */
  style?: { enabled: boolean; guide: string; learnedAt?: string };
  /** Rules applied before triage (first match wins). */
  rules?: TriageRule[];
  /** Polling pauses itself after a long gap (the computer slept, or the server was off) until the PU resumes it. */
  polling?: { pauseAfterGapHours: number };
  triage: TriageEngineSettings;
  /** The PU's standing instructions ("playbooks"): what to suggest when a kind of thing comes up. Given to triage and to Claude. */
  playbooks: string;
  setupComplete: boolean;
}

export interface CredentialInfo {
  id: string;
  label: string;
  backend: SecretBackend;
  ref: string;
  isSet: boolean;
  updatedAt: string;
}

export interface EnvironmentInfo {
  hosting: 'local' | 'gcp';
  demoMode: boolean;
  availableBackends: SecretBackend[];
  availableProviders: ClaudeProvider[];
  publicUrl: string;
  version: string;
  /** Backups need the local SQLite database. */
  backupAvailable: boolean;
}

// ---------- Server-sent events ----------

/** Where an email thread is in Gmail: unread (any message), in the Inbox (not archived), in Trash. */
export interface GmailThreadState {
  unread: boolean;
  inbox: boolean;
  trash: boolean;
}
export type GmailAction = 'read' | 'unread' | 'archive' | 'unarchive' | 'trash' | 'untrash';

/** The system-wide Undo: what the next undo would reverse (null: nothing), and how many steps are kept (at most 3). */
export interface UndoInfo {
  next: string | null;
  count: number;
}

export type ServerEvent =
  | { type: 'stream.updated'; stream: WorkStream }
  /** The PU moved the last work item out of this stream, so it was removed. `movedTo` is where that item went (null: out of every stream). */
  | { type: 'stream.deleted'; streamId: string; movedTo: string | null }
  | { type: 'item.updated'; item: StreamItem }
  | { type: 'proposal.updated'; proposal: Proposal }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'chat.delta'; streamId: string | null; runId: string; text: string }
  | { type: 'run.state'; streamId: string | null; runId: string; state: 'running' | 'done' | 'error'; error?: string }
  | { type: 'notify'; streamId: string | null; title: string; body: string }
  /** Today's usage passed the budget. `desktop`: also show a desktop notification; `banner`: show the in-app banner. */
  | { type: 'usage.alert'; day: string; message: string; desktop: boolean; banner: boolean }
  | { type: 'laya.status'; status: LayaStatus }
  | { type: 'undo.changed'; undo: UndoInfo }
  | { type: 'ingest.status'; system: SystemId; ok: boolean; message: string; at: string }
  | { type: 'polling.changed'; polling: PollingState }
  | { type: 'claudecode.state'; streamId: string; session: ClaudeCodeStatus['session'] };

export const GENERAL_STREAM = '__general__';

/** Tab order for a work stream: the PU's arrangement first, and optionally the most recently active tab hoisted next to Overview. */
export function orderTabs(items: StreamItem[], recentFirst: boolean): StreamItem[] {
  const arranged = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it.data.tabOrder ?? Infinity) - (b.it.data.tabOrder ?? Infinity) || a.i - b.i)
    .map((x) => x.it);
  if (!recentFirst || arranged.length < 2) return arranged;
  const latest = arranged.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  // Rearranging the tabs yourself wins until something newer happens.
  const arrangedAt = arranged.reduce((m, i) => (i.data.tabOrderAt && i.data.tabOrderAt > m ? i.data.tabOrderAt : m), '');
  if (arrangedAt && latest.updatedAt <= arrangedAt) return arranged;
  return [latest, ...arranged.filter((i) => i.id !== latest.id)];
}

