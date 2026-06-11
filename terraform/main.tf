data "google_project" "current" {
  project_id = var.project_id
}

locals {
  build_source_bucket_name = "${var.service_name}-${data.google_project.current.number}-source"
  runtime_service_account  = "${var.service_name}@${var.project_id}.iam.gserviceaccount.com"
  iap_service_agent_member = google_project_service_identity.iap.member
  build_service_accounts = toset([
    "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com",
    "serviceAccount:${data.google_project.current.number}@cloudbuild.gserviceaccount.com",
  ])
}

resource "google_project_service" "artifactregistry" {
  project            = var.project_id
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudbuild" {
  project            = var.project_id
  service            = "cloudbuild.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iap" {
  project            = var.project_id
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager" {
  project            = var.project_id
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "run" {
  project            = var.project_id
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "sqladmin" {
  project            = var.project_id
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service_identity" "iap" {
  provider   = google-beta
  project    = var.project_id
  service    = "iap.googleapis.com"
  depends_on = [google_project_service.iap]
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = var.service_name
  display_name = "${var.service_name} runtime"
}

resource "google_artifact_registry_repository" "app" {
  project       = var.project_id
  location      = var.region
  repository_id = var.service_name
  description   = "Dedicated Docker repository for ${var.service_name}"
  format        = "DOCKER"

  depends_on = [google_project_service.artifactregistry]
}

resource "google_artifact_registry_repository_iam_member" "build_writer" {
  for_each   = local.build_service_accounts
  project    = var.project_id
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.repository_id
  role       = "roles/artifactregistry.writer"
  member     = each.value
}

resource "google_storage_bucket" "build_source" {
  name                        = local.build_source_bucket_name
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true

  depends_on = [google_project_service.cloudbuild]
}

resource "google_storage_bucket_iam_member" "build_source_viewer" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "runtime_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_database_url_accessor" {
  project   = var.project_id
  secret_id = var.database_url_secret_name
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"

  depends_on = [google_project_service.secretmanager]
}

resource "google_cloud_run_v2_service" "app" {
  provider            = google-beta
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  iap_enabled         = true
  deletion_protection = true

  scaling {
    min_instance_count = var.min_instance_count
  }

  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = "300s"
    max_instance_request_concurrency = 80

    dynamic "vpc_access" {
      for_each = var.vpc_connector == "" ? [] : [var.vpc_connector]
      content {
        connector = vpc_access.value
        egress    = var.vpc_egress
      }
    }

    scaling {
      max_instance_count = var.max_instance_count
    }

    dynamic "volumes" {
      for_each = var.cloudsql_instance_connection_name == "" ? [] : [var.cloudsql_instance_connection_name]
      content {
        name = "cloudsql"

        cloud_sql_instance {
          instances = [volumes.value]
        }
      }
    }

    containers {
      image = var.container_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      dynamic "env" {
        for_each = var.upstream_llm_url == "" ? [] : [var.upstream_llm_url]
        content {
          name  = "UPSTREAM_LLM_URL"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.database_url_secret_name == "" ? [] : [1]
        content {
          name = "DATABASE_URL"

          value_source {
            secret_key_ref {
              secret  = var.database_url_secret_name
              version = var.database_url_secret_version
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = var.cloudsql_instance_connection_name == "" ? [] : [1]
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      startup_probe {
        failure_threshold = 1
        period_seconds    = 240
        timeout_seconds   = 240

        tcp_socket {
          port = 8080
        }
      }
    }
  }

  depends_on = [
    google_project_service.run,
    google_project_service.iap,
    google_project_service.secretmanager,
    google_project_service.sqladmin,
    google_project_service_identity.iap,
    google_project_iam_member.runtime_cloudsql_client,
    google_secret_manager_secret_iam_member.runtime_database_url_accessor,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.app.location
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = local.iap_service_agent_member
}

resource "google_iap_web_cloud_run_service_iam_binding" "domain_access" {
  provider               = google-beta
  project                = var.project_id
  location               = google_cloud_run_v2_service.app.location
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  members = concat(
    ["domain:${var.allowed_domain}"],
    [for user in sort(tolist(var.allowed_users)) : "user:${user}"]
  )
}
