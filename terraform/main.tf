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

resource "google_project_service" "run" {
  project            = var.project_id
  service            = "run.googleapis.com"
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
  bucket  = google_storage_bucket.build_source.name
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
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

    scaling {
      max_instance_count = var.max_instance_count
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
    google_project_service_identity.iap,
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
