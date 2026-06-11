output "cloud_run_service_name" {
  value = google_cloud_run_v2_service.app.name
}

output "cloud_run_url" {
  value = google_cloud_run_v2_service.app.uri
}

output "runtime_service_account_email" {
  value = google_service_account.runtime.email
}

output "artifact_registry_repository" {
  value = google_artifact_registry_repository.app.id
}

output "build_source_bucket" {
  value = google_storage_bucket.build_source.name
}
