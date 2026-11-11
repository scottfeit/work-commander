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
    /** New activity on a closed stream reopens it only if it closed within this many days; otherwise a new stream starts. */
    reopenClosedWithinDays: number;
    maxTurns: number;
  };
  secrets: { defaultBackend: SecretBackend; gcpProjectId: string };
  google: GoogleSettings;
  slack: SlackSettings;
  atlassian: AtlassianSettings;
  onepassword: OnePasswordSettings;
  orgChart: OrgChartSourceSettings;
  ui: { showClosedByDefault: boolean };
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
}

// ---------- Server-sent events ----------

export type ServerEvent =
  | { type: 'stream.updated'; stream: WorkStream }
  | { type: 'item.updated'; item: StreamItem }
  | { type: 'proposal.updated'; proposal: Proposal }
  | { type: 'chat.message'; message: ChatMessage }
  | { type: 'chat.delta'; streamId: string | null; runId: string; text: string }
  | { type: 'run.state'; streamId: string | null; runId: string; state: 'running' | 'done' | 'error'; error?: string }
  | { type: 'notify'; streamId: string | null; title: string; body: string }
  | { type: 'ingest.status'; system: SystemId; ok: boolean; message: string; at: string };

export const GENERAL_STREAM = '__general__';
