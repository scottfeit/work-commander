# Setup guide

Everything below is configured in the dashboard's **Settings** page unless noted otherwise. Save at the top of the page before testing a connection.

## 1. Primary user

Settings → **Primary user & org chart**: name, work email, org function, other names (aliases, secondary emails), and free-text notes on what matters and what's noise. Claude uses all of this to decide relevance. The Slack and Atlassian identities are filled in when you press **Test** in those sections.

### Org chart (optional, recommended)

Choose a source, adjust the field mapping, press **Preview** to see the available fields and the first mapped people, then **Import**.

| Source | What you need |
|---|---|
| Workday REST | Register an API client in Workday (*Register API Client for Integrations*) with a scope that covers Staffing/Workers; generate a refresh token. Enter host, tenant, client id; store secret and refresh token. |
| Workday RaaS | A custom report with name, work email, title, org, manager email, shared as a web service; an integration system user with access. Paste the report URL. |
| File upload | CSV or XLSX export with a header row. |
| Jira Assets | Uses the Atlassian credentials from the Atlassian section. Find the workspace id at `https://<site>.atlassian.net/rest/servicedeskapi/assets/workspace`; write an AQL query such as `objectType = "Employee"`. |

## 2. Claude

| Provider | Steps |
|---|---|
| Claude Code login (local only) | Install Claude Code, run `claude`, log in. Nothing to store here. |
| Vertex AI | Enable Claude models in Vertex AI Model Garden for your project; locally run `gcloud auth application-default login`; on GCP the service account already has `roles/aiplatform.user`. Enter project id and region. |
| API key | Store the key (choose where it lives). |

Model accepts aliases (`sonnet`, `opus`) or a full model id. **Test Claude connection** sends a one-line prompt.

**Models for background calls.** Triage, Slack topic splitting, Slack context and MCP item polling each have their own model (default Haiku). The chat agent and drafting always use the main model.

**Usage** (Settings → Usage) records every Claude call: tokens, and an estimated cost at API prices (with a Claude Code login you pay by subscription). Show it as tokens or dollars, set a daily budget, and choose where the alert goes: a banner, a desktop notification, or an email to yourself (needs Google connected with OAuth). Usage is grouped by what it was for: triage, reading Slack and other sources, drafting messages, Claude Code hand-offs, chatting with you, keeping streams up to date, overview refreshes and other. Per-call records are kept for a year; daily totals for good. Each work stream's Overview has a pie chart of its estimated cost by those categories.

**Laya** (Settings → Triage, local hosting only) is a small model that runs on this computer and can take over triage from Claude:

1. Choose *Laya, learning from Claude* and save. Work Commander starts collecting training examples from Claude's triage decisions and your corrections (marking an item not relevant, moving it, accepting a skipped item).
2. Press **Install Laya**. It downloads the uv tool, a private Python 3.12, Laya and its model (about 2 GB) into `~/.work-commander/laya`. Your own Python is not touched.
3. Each part (*Needs you?*, *Which work stream*, *Next step*) is trained automatically once it has enough examples, then shadows Claude. When it agrees at least 95% of the time over 200 messages (both adjustable), Work Commander asks you before switching that part to Laya.
4. Until then, and whenever Laya isn't sure, the Claude triage model decides. If your corrections show a live part slipping, Work Commander suggests **Retrain**; retraining puts that part back to shadowing.

## 3. Google Workspace

**OAuth mode**

1. In a GCP project you control: enable the Gmail, Drive and Calendar APIs; configure the OAuth consent screen (Internal, if you're on Workspace).
2. Create an OAuth client of type *Web application*. Add the redirect URI shown in Settings: `<dashboard URL>/api/oauth/google/callback`.
3. Enter the client id, store the client secret, save, then press **Connect Google**.
4. Real-time (optional): create a Pub/Sub topic and grant `gmail-api-push@system.gserviceaccount.com` the Publisher role on it. Create a **pull** subscription and enter both. Terraform creates these on GCP; see the outputs. The watch is renewed daily.

**MCP mode**: enter your Google MCP server's transport and URL or command, plus headers or env (values can reference stored credentials). Adjust the read-only patterns so that only true reads match. Ingestion is by polling.

## 4. Slack

1. Create an app from `deploy/slack-app-manifest.yaml` (*Create New App → From an app manifest*) and install it.
2. Store the **User OAuth Token** (`xoxp-…`). Messages are posted as you.
3. For real time, create an **App-Level Token** with `connections:write` (`xapp-…`) and store it. Socket Mode needs no public URL.
4. Press **Test**. This records your Slack user id.

In **MCP mode**, *Read Slack without Claude* (on by default) checks for new activity with plain calls to Slack's MCP server (searches for your mentions and DMs, reads of watched channels and of conversations already in work streams), so checking costs no Claude tokens. If a direct read fails, that check falls back to Claude.

## 5. Atlassian

**API mode**: site URL, your account email, and an API token from https://id.atlassian.com/manage-profile/security/api-tokens. Press **Test**. Then set the default ticket target: **Load from Jira** lists service desks and request types for JSM, or enter a project key and issue type for Jira. Each stream can override the target from its Overview pane.

Real time: store a webhook shared secret, then in Jira → Settings → System → WebHooks add the URL shown, with events *issue created, issue updated, comment created*. Locally this needs a tunnel. On GCP, use the relay URL from the Terraform outputs and the generated secret (`terraform output jira_webhook_secret_command`).

**MCP mode**: e.g. Atlassian's remote MCP server. Configure its URL and auth headers. Ingestion is by polling.

## MCP servers that need sign-in (OAuth)

Any integration in **MCP mode** with an HTTP or SSE server can sign in with OAuth (MCP authorization spec): turn on **Sign in with OAuth**, save, then press **Sign in**.

- **Servers that support automatic registration**: leave **Client id** blank. Work Commander registers itself.
- **Servers that need a registered app** (e.g. Slack's hosted server at `https://mcp.slack.com/mcp`, which also needs workspace-admin approval): create the app on that platform, add `<dashboard URL>/api/oauth/mcp/callback` as a redirect URL, then enter its client id (and secret, if it has one).

Tokens are kept in your secret store and refreshed automatically; if a refresh token expires you'll be asked to sign in again. **Sign out** deletes them.

## 6. 1Password

Choose how the dashboard reaches 1Password:

| Mode | Use when | Store |
|---|---|---|
| Service account | Local or GCP | Service account token (`ops_…`). Grant it read access to the agent-access vault (and write access to the secrets vault if you store dashboard credentials in 1Password). |
| Connect server | You run 1Password Connect | Connect URL and token |
| CLI + desktop app | Local only | Install `op`, enable *Integrate with 1Password CLI* in the desktop app |

Set the **vault agents may request from**. Put items for systems Claude may access there, with the system's URL on each item; that URL becomes the default allowed host. Set grant expiry.

## 7. Secrets

Every credential field has its own storage selector: OS keychain (local only), GCP Secret Manager (set the project; uses ADC), or 1Password (uses the secrets vault). **Existing secret** lets you point at a secret you already manage, e.g. `op://Vault/Item/field` or `projects/p/secrets/s/versions/latest`. 1Password's own access token can't be stored in 1Password.

## 8. Approvals and ingestion

Each integration section has:

- **Pick up new activity**: real time, polling at an interval, or off.
- **Approvals**: reads and writes each set to *Run automatically* or *Ask me first*.

**Triage → New work streams** chooses what happens when triage finds new work. *Create them automatically* (the default) starts a work stream itself. *Ask me first* shows it in the list as a proposed work stream (marked **New?**) with **Accept** and **Decline**. Activity that belongs to an existing work stream is always added to it. A declined proposal comes back if the conversation has new activity.

**Claude → Draft automatically** (off by default) controls whether Claude drafts replies and ticket changes on its own when new activity arrives, or posts an offer and drafts only once you accept. Drafts you ask for in chat are always made.

## Deploying to GCP

Prerequisites: `gcloud` authenticated, Terraform ≥ 1.6, a project with billing.

```bash
cp deploy/terraform/terraform.tfvars.example deploy/terraform/terraform.tfvars   # set pu_email etc.
deploy/gcp-deploy.sh <project-id> us-central1
```

After the first apply:

1. Put the `dashboard_url` output into `public_url` in `terraform.tfvars` and apply again. This makes the OAuth redirect URI correct.
2. Add `google_oauth_redirect_uri` to your OAuth client.
3. Open the dashboard (IAP signs you in), choose **Vertex AI** or **API key** for Claude, and set Secret Manager or 1Password as the default secret storage.

The dashboard runs as a single, always-on Cloud Run instance (one PU, in-process queues). Cloud SQL is `db-f1-micro` by default.
