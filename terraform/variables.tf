variable "project_id" {
  description = "GCP project ID."
  type        = string
  default     = "sub-gcp-c-p-mkd-tech-sbx"
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
  default     = "asia-northeast1-docker.pkg.dev/sub-gcp-c-p-mkd-tech-sbx/media-planner-rakuten-gateway/media-planner-rakuten-gateway:latest"
}

variable "upstream_llm_url" {
  description = "Optional upstream endpoint used by /api/llm."
  type        = string
  default     = ""
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
