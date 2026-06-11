# media-planner-rakuten-gateway

`media-planner-rakuten-gateway.html` を Cloud Run で配信し、IAP で `rakuten.com` ドメインの Google アカウントだけが閲覧できるようにした構成です。

## Architecture

- App: [media-planner-rakuten-gateway.html](/Users/takemasa.yamada/Documents/GitHub/media-planner/media-planner-rakuten-gateway.html)
- Runtime server: [server.js](/Users/takemasa.yamada/Documents/GitHub/media-planner/server.js)
- Container build: [Dockerfile](/Users/takemasa.yamada/Documents/GitHub/media-planner/Dockerfile)
- Infra as code: [`terraform/`](</Users/takemasa.yamada/Documents/GitHub/media-planner/terraform>)

Cloud Run の専用リソースはすべて `media-planner-rakuten-gateway` という名前で分離しています。

- Cloud Run service: `media-planner-rakuten-gateway`
- Artifact Registry repository: `media-planner-rakuten-gateway`
- Runtime service account: `media-planner-rakuten-gateway@sub-gcp-c-p-mkd-tech-sbx.iam.gserviceaccount.com`
- Build source bucket: `gs://media-planner-rakuten-gateway-776580311528-source`

## Auth Design

ブラウザ閲覧制御は Cloud Run IAM のみではなく IAP を使います。

- Cloud Run service では `iap_enabled = true`
- IAP の閲覧権限は `roles/iap.httpsResourceAccessor`
- 許可対象は `domain:rakuten.com` と必要に応じた個別ユーザー
- Cloud Run の `roles/run.invoker` は IAP service agent に付与

この構成にすると、未認証アクセスは `403` ではなく Google ログインへリダイレクトされます。

## Runtime Notes

`server.js` は次を提供します。

- `GET /` で HTML を返す
- `GET /healthz` で簡易ヘルスチェックを返す
- `POST /api/llm` を上流 LLM Gateway にプロキシする

`/api/llm` を動かすには Cloud Run に `UPSTREAM_LLM_URL` を設定してください。

例:

```bash
terraform -chdir=terraform apply \
  -var='upstream_llm_url=https://example.internal/api/llm'
```

## Terraform

Terraform は `1.6+` を前提にしています。ローカルの `Terraform 1.5.7` では `hashicorp/google v6.50.0` の provider schema 読み込みで失敗したため、このリポジトリでは新しめの Terraform を前提にします。

初期化:

```bash
terraform -chdir=terraform init
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

差分確認:

```bash
terraform -chdir=terraform plan
```

反映:

```bash
terraform -chdir=terraform apply
```

主な変数:

- `project_id`: 既定値 `sub-gcp-c-p-mkd-tech-sbx`
- `region`: 既定値 `asia-northeast1`
- `allowed_domain`: 既定値 `rakuten.com`
- `allowed_users`: 明示的に通したいユーザー
- `container_image`: Cloud Run にデプロイするイメージ
- `upstream_llm_url`: `/api/llm` の転送先

## Image Build Flow

インフラは Terraform、アプリイメージの作成は Cloud Build を使います。

```bash
gcloud builds submit \
  --project sub-gcp-c-p-mkd-tech-sbx \
  --region asia-northeast1 \
  --gcs-source-staging-dir=gs://media-planner-rakuten-gateway-776580311528-source/source \
  --tag asia-northeast1-docker.pkg.dev/sub-gcp-c-p-mkd-tech-sbx/media-planner-rakuten-gateway/media-planner-rakuten-gateway:latest \
  .
```

`latest` を使い続けることもできますが、運用ではタグや digest を固定して `container_image` を更新する方が安全です。

例:

```bash
terraform -chdir=terraform apply \
  -var='container_image=asia-northeast1-docker.pkg.dev/sub-gcp-c-p-mkd-tech-sbx/media-planner-rakuten-gateway/media-planner-rakuten-gateway:20260611-1'
```

## Existing Resource Adoption

このリポジトリの Terraform は、新規作成にも既存リソース取り込みにも使える前提で書いています。

すでに作成済みの環境へ合わせる場合は、まず `terraform plan` で差分を確認し、そのあと必要な `terraform import` を行ってください。特に次のリソースは import 対象になりやすいです。

- Cloud Run service
- Artifact Registry repository
- Runtime service account
- Build source bucket
- IAP access binding

例:

```bash
terraform -chdir=terraform import \
  google_cloud_run_v2_service.app \
  projects/sub-gcp-c-p-mkd-tech-sbx/locations/asia-northeast1/services/media-planner-rakuten-gateway

terraform -chdir=terraform import \
  'google_iap_web_cloud_run_service_iam_binding.domain_access' \
  'projects/sub-gcp-c-p-mkd-tech-sbx/iap_web/cloud_run-asia-northeast1/services/media-planner-rakuten-gateway roles/iap.httpsResourceAccessor'
```

## Security Notes

- IAP を使うため、ロードバランサーは追加していません
- リポジトリや bucket は専用作成し、他サービスと共用しない前提です
- 以前の調査で一時的に付与した Cloud Run の直接 `run.invoker` 権限が残っている場合は、IAP 導入後に整理できます
