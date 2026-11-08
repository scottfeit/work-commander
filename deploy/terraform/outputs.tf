output "dashboard_url" {
  value = google_cloud_run_v2_service.app.uri
}

output "jira_webhook_url" {
  description = "Paste into Jira (Settings → System → WebHooks), adding ?secret=<jira_webhook_secret>"
  value       = var.enable_jira_relay ? "${google_cloud_run_v2_service.relay[0].uri}/api/webhooks/jira" : null
}

output "jira_webhook_secret_command" {
  description = "Prints the generated webhook secret"
  value       = "gcloud secrets versions access latest --secret=${google_secret_manager_secret.jira_webhook.secret_id} --project=${var.project_id}"
}

output "gmail_pubsub_topic" {
  description = "Settings → Google → Pub/Sub topic (for real-time Gmail)"
  value       = google_pubsub_topic.gmail.id
}

output "gmail_pubsub_subscription" {
  description = "Settings → Google → Pull subscription"
  value       = google_pubsub_subscription.gmail.id
}

output "google_oauth_redirect_uri" {
  description = "Add to your Google OAuth client's authorized redirect URIs"
  value       = "${var.public_url != "" ? var.public_url : google_cloud_run_v2_service.app.uri}/api/oauth/google/callback"
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}
