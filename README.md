# media-planner-rakuten-gateway

`media-planner-rakuten-gateway.html` を Cloud Run で配信し、IAP で `rakuten.com` ドメインの Google アカウントだけが閲覧できるようにした構成です。

現在は `gmd-tech` 上で運用し、利用状況トラッキング機能を含む `v1.1.0` を前提にしています。

## Architecture

- App: [media-planner-rakuten-gateway.html](/Users/takemasa.yamada/Documents/GitHub/media-planner/media-planner-rakuten-gateway.html)
- Runtime server: [server.js](/Users/takemasa.yamada/Documents/GitHub/media-planner/server.js)
- Legacy proxy: [legacy/proxy.rb](/Users/takemasa.yamada/Documents/GitHub/media-planner/legacy/proxy.rb)
- Infra as code: [`terraform/`](</Users/takemasa.yamada/Documents/GitHub/media-planner/terraform>)

アプリ固有リソースは `media-planner-rakuten-gateway` 名で専用作成し、外向き固定 IP のためのネットワーク経路だけ `gmd-tech` の既存 staging 基盤を使います。

専用作成するリソース:

- Cloud Run service: `media-planner-rakuten-gateway`
- Artifact Registry repository: `media-planner-rakuten-gateway`
- Runtime service account: `media-planner-rakuten-gateway@gmd-tech.iam.gserviceaccount.com`
- Build source bucket: `gs://media-planner-rakuten-gateway-<PROJECT_NUMBER>-source`

共有利用する既存ネットワーク基盤:

- VPC: `jackrabbit-vpc-stg`
- Serverless VPC Access connector: `gmd-vpc-conn-stg`
- Cloud Router: `gmd-tech-shared-router-staging`
- Cloud NAT: `gmd-tech-shared-nat-staging`
- Static outbound IP: `34.85.112.169`

## Auth Design

ブラウザ閲覧制御は Cloud Run IAM のみではなく IAP を使います。

- Cloud Run service では `iap_enabled = true`
- IAP の閲覧権限は `roles/iap.httpsResourceAccessor`
- 許可対象は `domain:rakuten.com` と必要に応じた個別ユーザー
- Cloud Run の `roles/run.invoker` は IAP service agent に付与

この構成にすると、未認証アクセスは Google ログインへ誘導され、許可されていないユーザーだけが拒否されます。

## Runtime Notes

`server.js` は次を提供します。

- `GET /` で HTML を返す
- `GET /usage` で利用状況ダッシュボードを返す
- `GET /healthz` で簡易ヘルスチェックを返す
- `POST /api/llm` で Rakuten Gateway の各 API へ直接プロキシする
- `GET /api/usage/summary` で利用状況集計を返す

`proxy.rb` にあった provider 別の変換ロジックは `server.js` に統合済みです。通常運用では追加の upstream proxy は不要です。

## Usage Tracking Design

2026-06-11 時点で、Cloud SQL インスタンス `gmd-tech-shared` に専用データベース `media_planner_rakuten_gateway` を作成し、Cloud Run 起動時に Prisma migration を自動適用する構成にしています。

この機能では、IAP が Cloud Run に渡す Google ユーザーヘッダーを使って利用状況を保存します。

- 取得ヘッダー: `X-Goog-Authenticated-User-Email`
- 保存先 DB: `gmd-tech:asia-northeast1:gmd-tech-shared` / `media_planner_rakuten_gateway`
- 専用 DB ユーザー: `media_planner_gateway_user`
- Secret Manager: `media-planner-rakuten-gateway-database-url`
- スキーマ管理: [prisma/schema.prisma](/Users/takemasa.yamada/Documents/GitHub/media-planner/prisma/schema.prisma)
- 一覧画面: `/usage`

保存するイベント:

- `PAGE_VIEW`: `/` と `/usage` の表示
- `LLM_REQUEST`: `/api/llm` を経由したモデル呼び出し

主な保存項目:

- `userEmail`
- `pagePath`
- `eventType`
- `provider`, `model`
- `success`, `statusCode`, `durationMs`
- `requestBytes`, `responseBytes`
- `systemLength`, `userLength`
- `traceId`

`DATABASE_URL` が未設定の環境では、既存アプリはそのまま動作し、利用状況保存だけが無効になります。これによりローカル開発や段階導入でも既存フローを壊しません。

運用中の初回 migration:

- `20260611202000_init_usage_events`

## Usage Screen

`/usage` は既存の [media-planner-rakuten-gateway.html](/Users/takemasa.yamada/Documents/GitHub/media-planner/media-planner-rakuten-gateway.html) と同じカラースキームを継承したダッシュボードです。

画面構成:

- Header: タイトル、期間切り替え、再読み込み、Planner 戻るリンク、現在ユーザー表示
- Overview: 総イベント数、LLM 呼び出し数、成功率、アクティブユーザー数
- Top Users: ユーザー別の総イベント数、LLM 呼び出し数、ページ閲覧数
- Model Usage: provider / model ごとの利用回数と成功・失敗件数
- Recent Events: 最新イベント一覧

想定クエリ:

- `GET /usage`
- `GET /api/usage/summary?days=7`

反映済みの構成:

- Secret Manager から `DATABASE_URL` を Cloud Run に注入
- Cloud Run ランタイム SA に `roles/cloudsql.client` を付与
- Cloud Run 起動時に `prisma migrate deploy` を実行
- `usage_events` テーブルを Prisma migration で管理

`UPSTREAM_LLM_URL` は必要な場合だけ使うオプションです。この環境変数を入れると、`/api/llm` のリクエストをその URL に丸ごと転送します。

例:

```bash
terraform -chdir=terraform apply \
  -var='upstream_llm_url=https://example.internal/api/llm'
```

## Terraform

Terraform は `1.6+` を前提にしています。ローカルの `Terraform 1.5.7` では `hashicorp/google v6.50.0` の provider schema 読み込みで失敗したため、このリポジトリでは新しめの Terraform を前提にします。

この環境では一時バイナリ `/private/tmp/terraform-1.15.6/terraform` を使って apply しています。

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

- `project_id`: 既定値 `gmd-tech`
- `region`: 既定値 `asia-northeast1`
- `allowed_domain`: 既定値 `rakuten.com`
- `allowed_users`: 明示的に通したいユーザー
- `container_image`: `gmd-tech` の Artifact Registry に push したイメージ
- `cloudsql_instance_connection_name`: 既定値 `gmd-tech:asia-northeast1:gmd-tech-shared`
- `database_url_secret_name`: 既定値 `media-planner-rakuten-gateway-database-url`
- `database_url_secret_version`: 既定値 `latest`
- `vpc_connector`: 既定値 `projects/gmd-tech/locations/asia-northeast1/connectors/gmd-vpc-conn-stg`
- `vpc_egress`: 既定値 `ALL_TRAFFIC`
- `upstream_llm_url`: 必要な場合だけ使う `/api/llm` の転送先

`vpc_connector` を設定すると Cloud Run の outbound は VPC Connector を経由し、`ALL_TRAFFIC` のためインターネット向け通信も Cloud NAT から出ます。

## Image Build Flow

インフラは Terraform、アプリイメージの作成は Cloud Build を使います。

```bash
gcloud builds submit \
  --project gmd-tech \
  --region asia-northeast1 \
  --gcs-source-staging-dir=gs://media-planner-rakuten-gateway-<PROJECT_NUMBER>-source/source \
  --tag asia-northeast1-docker.pkg.dev/gmd-tech/media-planner-rakuten-gateway/media-planner-rakuten-gateway:latest \
  .
```

`latest` を使い続けることもできますが、運用ではタグや digest を固定して `container_image` を更新する方が安全です。

例:

```bash
terraform -chdir=terraform apply \
  -var='container_image=asia-northeast1-docker.pkg.dev/gmd-tech/media-planner-rakuten-gateway/media-planner-rakuten-gateway:20260611-1'
```

## Deployment Notes For gmd-tech

`gmd-tech` に新規作成する前提なので、基本的には import より新規 apply を想定しています。

手順の流れ:

1. `terraform.tfvars` で `project_id`, `container_image`, `allowed_users` を確認する
2. Terraform で専用リソースを作成する
3. Cloud Build で `gmd-tech` の Artifact Registry にイメージを push する
4. Cloud Run を `gmd-vpc-conn-stg` + `ALL_TRAFFIC` + Cloud SQL mount で起動する
5. IAP ログインと `/usage`、`/api/llm` を確認する

もし既存リソースを取り込む場合は、まず `terraform plan` で差分を確認してから import を行ってください。

## Local Development

社内CAが必要なため、`npm` や `prisma` 実行時は次の PEM を使う想定です。

```bash
NODE_EXTRA_CA_CERTS=/Users/takemasa.yamada/certs/rakuten_CA_only.pem npm install
NODE_EXTRA_CA_CERTS=/Users/takemasa.yamada/certs/rakuten_CA_only.pem npx prisma generate
```

## Security Notes

- IAP を使うため、ロードバランサーは追加していません
- アプリ用の Artifact Registry、service account、bucket は他サービスと共用しません
- 外向き通信だけ `gmd-tech` の共有 NAT を使う前提です
