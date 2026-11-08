terraform {
  required_version = ">= 1.6"
  required_providers {
    google      = { source = "hashicorp/google", version = ">= 6.10" }
    google-beta = { source = "hashicorp/google-beta", version = ">= 6.10" }
    random      = { source = "hashicorp/random", version = ">= 3.5" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}

locals {
  name           = var.name
  sa_iap         = "service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"
  iap_audience   = "/projects/${data.google_project.this.number}/locations/${var.region}/services/${var.name}"
  image          = var.image
  database_name  = "workcommander"
  database_user  = "workcommander"
}

# ---------------------------------------------------------------- APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "pubsub.googleapis.com",
    "iap.googleapis.com",
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "gmail.googleapis.com",
    "drive.googleapis.com",
    "calendar-json.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  repository_id = local.name
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

# ---------------------------------------------------------------- identities
resource "google_service_account" "app" {
  account_id   = "${local.name}-app"
  display_name = "Work Commander dashboard"
}

resource "google_service_account" "relay" {
  account_id   = "${local.name}-relay"
  display_name = "Work Commander Jira webhook relay"
}

# The dashboard stores PU credentials in Secret Manager (one secret per credential, created at
# runtime), calls Claude on Vertex AI, pulls Pub/Sub notifications and connects to Cloud SQL.
resource "google_project_iam_member" "app_roles" {
  for_each = toset([
    "roles/secretmanager.admin",
    "roles/aiplatform.user",
    "roles/pubsub.subscriber",
    "roles/cloudsql.client",
    "roles/logging.logWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.app.email}"
}

# ---------------------------------------------------------------- database
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "db" {
  name             = "${local.name}-db"
  database_version = "POSTGRES_16"
  region           = var.region
  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    backup_configuration {
      enabled = true
    }
    ip_configuration {
      ipv4_enabled = true # reached only through the Cloud SQL connector (IAM-authorized), no authorized networks
    }
  }
  deletion_protection = var.deletion_protection
  depends_on          = [google_project_service.apis]
}

resource "google_sql_database" "db" {
  name     = local.database_name
  instance = google_sql_database_instance.db.name
}

resource "google_sql_user" "app" {
  name     = local.database_user
  instance = google_sql_database_instance.db.name
  password = random_password.db.result
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "${local.name}-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${local.database_user}:${random_password.db.result}@/${local.database_name}?host=/cloudsql/${google_sql_database_instance.db.connection_name}"
}

resource "google_secret_manager_secret_iam_member" "app_db" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

# ---------------------------------------------------------------- Pub/Sub: Gmail push
resource "google_pubsub_topic" "gmail" {
  name       = "${local.name}-gmail"
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  topic  = google_pubsub_topic.gmail.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

resource "google_pubsub_subscription" "gmail" {
  name                       = "${local.name}-gmail-pull"
  topic                      = google_pubsub_topic.gmail.id
  ack_deadline_seconds       = 30
  message_retention_duration = "86400s"
}

# ---------------------------------------------------------------- Pub/Sub + relay: Jira webhooks
# The dashboard sits behind IAP, which Jira can't pass. A tiny public relay checks the shared
# secret and forwards webhook payloads through Pub/Sub. It has no other permissions.
resource "google_pubsub_topic" "jira" {
  name       = "${local.name}-jira"
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "jira" {
  name                       = "${local.name}-jira-pull"
  topic                      = google_pubsub_topic.jira.id
  ack_deadline_seconds       = 30
  message_retention_duration = "86400s"
}

resource "google_pubsub_topic_iam_member" "relay_publisher" {
  topic  = google_pubsub_topic.jira.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.relay.email}"
}

resource "random_password" "jira_webhook" {
  length  = 40
  special = false
}

resource "google_secret_manager_secret" "jira_webhook" {
  secret_id = "${local.name}-jira-webhook-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "jira_webhook" {
  secret      = google_secret_manager_secret.jira_webhook.id
  secret_data = random_password.jira_webhook.result
}

resource "google_secret_manager_secret_iam_member" "relay_secret" {
  secret_id = google_secret_manager_secret.jira_webhook.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.relay.email}"
}

resource "google_cloud_run_v2_service" "relay" {
  count    = var.enable_jira_relay ? 1 : 0
  name     = "${local.name}-jira-relay"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.relay.email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = local.image
      env {
        name  = "WC_ROLE"
        value = "webhook-relay"
      }
      env {
        name  = "WC_JIRA_TOPIC"
        value = google_pubsub_topic.jira.id
      }
      env {
        name = "WC_JIRA_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jira_webhook.secret_id
            version = "latest"
          }
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.relay_secret]
}

resource "google_cloud_run_v2_service_iam_member" "relay_public" {
  count    = var.enable_jira_relay ? 1 : 0
  name     = google_cloud_run_v2_service.relay[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------- dashboard (Cloud Run + IAP)
resource "google_cloud_run_v2_service" "app" {
  provider     = google-beta
  name         = local.name
  location     = var.region
  ingress      = "INGRESS_TRAFFIC_ALL"
  launch_stage = "BETA"
  iap_enabled  = true

  template {
    service_account = google_service_account.app.email
    # One PU per instance and in-process work queues: exactly one always-on instance, CPU always
    # allocated so polling, Socket Mode and Pub/Sub pulls keep running between requests.
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    timeout = "3600s"
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.db.connection_name]
      }
    }
    containers {
      image = local.image
      resources {
        limits            = { cpu = "1", memory = "2Gi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }
      env {
        name  = "WC_HOSTING"
        value = "gcp"
      }
      env {
        name  = "WC_AUTH_MODE"
        value = "iap"
      }
      env {
        name  = "WC_IAP_AUDIENCE"
        value = local.iap_audience
      }
      env {
        name  = "WC_ALLOWED_EMAIL"
        value = var.pu_email
      }
      env {
        name  = "WC_PUBLIC_URL"
        value = var.public_url
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "WC_JIRA_SUBSCRIPTION"
        value = var.enable_jira_relay ? google_pubsub_subscription.jira.id : ""
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 24
      }
    }
  }
  depends_on = [
    google_project_iam_member.app_roles,
    google_secret_manager_secret_iam_member.app_db,
    google_secret_manager_secret_version.database_url,
  ]
}

# IAP needs to invoke the service; only the PU may pass IAP.
resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.sa_iap}"
}

resource "google_iap_web_cloud_run_service_iam_member" "pu" {
  provider               = google-beta
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "user:${var.pu_email}"
}
