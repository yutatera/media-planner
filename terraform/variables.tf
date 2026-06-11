variable "project_id" {
  description = "GCP project ID."
  type        = string
  default     = "gmd-tech"
}

variable "region" {
  description = "Primary region for Cloud Run and regional resources."
  type        = string
  default     = "asia-northeast1"
}

variable "service_name" {
  description = "Base name for dedicated resources."
  type        = string
  default     = "media-planner-rakuten-gateway"
}

variable "allowed_domain" {
  description = "Google Workspace domain allowed through IAP."
  type        = string
  default     = "rakuten.com"
}

variable "allowed_users" {
  description = "Additional explicit users allowed through IAP."
  type        = set(string)
  default     = ["takemasa.yamada@rakuten.com"]
}

variable "container_image" {
  description = "Container image deployed to Cloud Run."
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/gmd-tech/media-planner-rakuten-gateway/media-planner-rakuten-gateway:latest"
}

variable "upstream_llm_url" {
  description = "Optional override endpoint for /api/llm. Leave empty to use the built-in Node proxy logic."
  type        = string
  default     = ""
}

variable "cloudsql_instance_connection_name" {
  description = "Cloud SQL instance connection name mounted into Cloud Run for Prisma."
  type        = string
  default     = "gmd-tech:asia-northeast1:gmd-tech-shared"
}

variable "database_url_secret_name" {
  description = "Secret Manager secret name that stores DATABASE_URL."
  type        = string
  default     = "media-planner-rakuten-gateway-database-url"
}

variable "database_url_secret_version" {
  description = "Secret Manager secret version for DATABASE_URL."
  type        = string
  default     = "latest"
}

variable "vpc_connector" {
  description = "Existing Serverless VPC Access connector name or fully qualified resource ID. Leave empty to disable VPC egress."
  type        = string
  default     = "projects/gmd-tech/locations/asia-northeast1/connectors/gmd-vpc-conn-stg"
}

variable "vpc_egress" {
  description = "Cloud Run VPC egress setting when vpc_connector is set."
  type        = string
  default     = "ALL_TRAFFIC"

  validation {
    condition     = contains(["ALL_TRAFFIC", "PRIVATE_RANGES_ONLY"], var.vpc_egress)
    error_message = "vpc_egress must be ALL_TRAFFIC or PRIVATE_RANGES_ONLY."
  }
}

variable "max_instance_count" {
  description = "Cloud Run max instance count."
  type        = number
  default     = 100
}

variable "min_instance_count" {
  description = "Cloud Run min instance count."
  type        = number
  default     = 0
}
