variable "project_id" {
  description = "GCP project to deploy into"
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and Artifact Registry"
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Base name for resources (also the Cloud Run service name)"
  type        = string
  default     = "work-commander"
}

variable "pu_email" {
  description = "The primary user's Google identity. Only this account can pass IAP and use the dashboard."
  type        = string
}

variable "image" {
  description = "Container image, e.g. REGION-docker.pkg.dev/PROJECT/work-commander/app:TAG (built by deploy/gcp-deploy.sh)"
  type        = string
}

variable "public_url" {
  description = "The dashboard's URL (Cloud Run URL or a custom domain). Used for the Google OAuth redirect. Set after the first apply if unknown."
  type        = string
  default     = ""
}

variable "db_tier" {
  description = "Cloud SQL machine tier"
  type        = string
  default     = "db-f1-micro"
}

variable "enable_jira_relay" {
  description = "Deploy the public Jira webhook relay (needed only for real-time Jira ingestion)"
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Protect the Cloud SQL instance from terraform destroy"
  type        = bool
  default     = true
}
