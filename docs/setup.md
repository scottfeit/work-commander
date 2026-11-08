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

## 5. Atlassian

**API mode**: site URL, your account email, and an API token from https://id.atlassian.com/manage-profile/security/api-tokens. Press **Test**. Then set the default ticket target: **Load from Jira** lists service desks and request types for JSM, or enter a project key and issue type for Jira. Each stream can override the target from its Overview tab.

Real time: store a webhook shared secret, then in Jira → Settings → System → WebHooks add the URL shown, with events *issue created, issue updated, comment created*. Locally this needs a tunnel. On GCP, use the relay URL from the Terraform outputs and the generated secret (`terraform output jira_webhook_secret_command`).

**MCP mode**: e.g. Atlassian's remote MCP server. Configure its URL and auth headers. Ingestion is by polling.

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

**Claude → Draft automatically** controls whether triage starts drafting immediately or posts an offer you accept first.

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
