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

export interface ThreadMessage {
  id: string;
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
  };
  /** Slack-specific */
  slack?: { channel: string; channelName?: string; threadTs: string };
  /** Gmail-specific */
  gmail?: { threadId: string; lastMessageIdHeader?: string; references?: string };
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
    selectedItemId?: string;
    toolCalls?: { name: string; input: unknown }[];
    runId?: string;
  };
  createdAt: string;
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
export type BackgroundTask = 'triage' | 'topicSplit' | 'slackContext' | 'mcpIngest';
export const BACKGROUND_TASKS: { id: BackgroundTask; label: string; hint: string }[] = [
  { id: 'triage', label: 'Triage', hint: 'Whether a message needs you, which work stream it belongs to, and what to do next.' },
  { id: 'topicSplit', label: 'Slack topic splitting', hint: 'Sorting a Slack conversation that runs several topics into the right work streams.' },
  { id: 'slackContext', label: 'Slack context', hint: 'Picking the earlier Slack messages a linked message depends on.' },
  { id: 'mcpIngest', label: 'MCP items', hint: 'Pulling new items in from a system connected through an MCP server.' },
];
/** 'main' = the main model; otherwise a Claude model alias. */
export type ModelChoice = 'main' | 'haiku' | 'sonnet' | 'opus';
export type TaskModels = Record<BackgroundTask, ModelChoice>;

/** Every kind of call usage is recorded for. */
/** 'agent' is Claude's stream work before turns were told apart (chat, drafting, hand-offs, keeping streams current). */
export type UsageKind = BackgroundTask | 'agent' | 'agentChat' | 'agentDraft' | 'agentHandoff' | 'agentReview' | 'newStream' | 'overview' | 'test' | 'laya';
export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  triage: 'Triage',
  topicSplit: 'Slack topic splitting',
  slackContext: 'Slack context',
  mcpIngest: 'MCP items',
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
export type UsageCategory = 'triage' | 'reading' | 'drafting' | 'handoff' | 'chat' | 'review' | 'overview' | 'other';
export const USAGE_CATEGORIES: { id: UsageCategory; label: string; hint: string; kinds: UsageKind[] }[] = [
  { id: 'triage', label: 'Triage', hint: 'Deciding whether new activity needs you and which work stream it belongs to, naming new streams, sorting Slack conversations by topic', kinds: ['triage', 'newStream', 'topicSplit'] },
  { id: 'reading', label: 'Reading Slack and other sources', hint: 'Checking for new activity through MCP servers, and finding the later Slack messages a linked one leads to', kinds: ['mcpIngest', 'slackContext'] },
  { id: 'drafting', label: 'Drafting messages', hint: "Claude's turns that prepared replies, messages or ticket changes for you to approve", kinds: ['agentDraft'] },
  { id: 'handoff', label: 'Claude Code hand-offs', hint: 'Taking in what Claude Code reports back', kinds: ['agentHandoff'] },
  { id: 'chat', label: 'Chatting with you', hint: 'Your messages to Claude and its answers (when it drafted something, that turn counts as drafting)', kinds: ['agentChat'] },
  { id: 'review', label: 'Keeping streams up to date', hint: 'Claude reviewing new items, your direct replies and finished drafts, and updating the work stream', kinds: ['agentReview'] },
  { id: 'overview', label: 'Overview refreshes', hint: 'Refresh overview, and overviews for streams you start by dropping an item on "+"', kinds: ['overview'] },
  { id: 'other', label: 'Other', hint: 'Connection tests, and Claude stream work from before usage was split by category', kinds: ['agent', 'test', 'laya'] },
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
    /** Keep the Drafts pane open even when nothing is waiting for review. Default off (it appears only when there are drafts). */
    keepDraftsOpen?: boolean;
  };
  backup: BackupSettings;
  /** How silenced work items behave. */
  silencing: SilencingSettings;
  /** When snoozed (Pending) work streams are surfaced again. */
  reminders: ReminderSettings;
  usage: UsageSettings;
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
  | { type: 'ingest.status'; system: SystemId; ok: boolean; message: string; at: string };

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

