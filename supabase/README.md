# Noteject accounts, AI, and subscriptions

Noteject uses one owner-controlled `OPENAI_API_KEY` for all hosted AI requests. It stays in Vercel; users sign in to Noteject and use their plan allowance. It is never included in the web app, Android APK, Windows installer, public configuration, or source archive. OpenAI API usage is billed to the owner separately from ChatGPT subscriptions.

Supabase credentials provide accounts, private workspace backups, and authoritative plan usage. Paddle handles new subscription checkout, while existing Stripe subscriptions remain manageable. These are separate service credentials, not extra AI keys. Never paste a secret into chat or source code.

## 1. Create the Supabase project

1. Open https://supabase.com/dashboard and create a project named Noteject. Keep its database password private.
2. In SQL Editor, run all of `schema.sql`, then all of `billing.sql`. Run both in this order even if the original schema was installed earlier. Both scripts can be rerun without removing account data. The billing migration revokes the old user-writable usage functions.
3. The hosted Noteject app clears backups through its authenticated server endpoint and does not require a separate deletion-function migration. For a standalone deployment that calls `noteject_clear_workspace` directly, run `delete_workspace_backup.sql`; fresh installs already get this function from `schema.sql`.
4. In Authentication, enable Email sign-in and keep email confirmation enabled. Under URL Configuration set the Site URL to `https://noteject.vercel.app/app` so confirmation links return to the web app. Users confirm their email and then sign in to Noteject normally. Configure custom SMTP before opening registration to general users; Supabase's default mail service is intended for testing and has delivery restrictions.
5. In Connect or Settings → API Keys, copy the project URL, publishable key, and server secret key into the matching Vercel settings below. The server secret is only for server functions; never put it in the public-key setting.

Official instructions: [API keys](https://supabase.com/docs/guides/getting-started/api-keys), [email sign-in](https://supabase.com/docs/guides/auth/passwords), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).

## 2. Configure Vercel

Open the `noteject` project → Settings → Environment Variables. Add these to Production. Use test credentials in a separate Preview environment while checking payments.

| Variable | Value | Type |
| --- | --- | --- |
| `NOTEJECT_SITE_URL` | `https://noteject.vercel.app` | Config |
| `SUPABASE_URL` | Your project URL | Config |
| `SUPABASE_PUBLISHABLE_KEY` | Your `sb_publishable_…` key | Config |
| `SUPABASE_SECRET_KEY` | Your `sb_secret_…` server key | Secret |
| `OPENAI_API_KEY` | A fresh owner-controlled OpenAI project key | Secret |
| `OPENAI_MODEL` | Optional; default `gpt-5-nano` for Basic | Config |
| `OPENAI_ADVANCED_MODEL` | Optional; default `gpt-5-mini` for Advanced | Config |

`SUPABASE_ANON_KEY` remains a fallback name for the publishable key. `SUPABASE_SERVICE_ROLE_KEY` remains a legacy server-key fallback. The publishable setting rejects recognizable server keys instead of publishing them.

Revoke any OpenAI key previously shared in chat. Create its replacement in the OpenAI API project and paste it directly into Vercel. The server ignores client-provided model names, plan names, and quotas. Changing environment variables requires a new deployment.

Without payment configuration, new accounts receive Free. AI remains disabled until the AI key and account/metering configuration are present. Sync can operate independently of OpenAI and Paddle.

## 3. Configure Paddle in sandbox mode

1. In Paddle Sandbox, create a Noteject Starter product with a recurring USD monthly price of **$5.99** and a Noteject Pro product at **$12.99/month**. Copy both Paddle price IDs (`pri_…`). The server checks the price is active, USD, the expected amount, and monthly before creating a transaction.
2. Under **Checkout → Checkout configuration**, set a default payment link. Use an approved Noteject site domain; Paddle checkout needs a configured default link.
3. Create a sandbox API key with permissions for `customer.write`, `price.read`, `transaction.read`, `transaction.write`, and `customer_portal_session.write`. Create a Paddle.js client-side token. The client-side token is designed to be public; the API key and notification secret are not.
4. Create a notification destination at `https://noteject.vercel.app/api/paddle-webhook`. Subscribe to `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.trialing`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, and `subscription.canceled`. Copy its endpoint secret.
5. Run `billing.sql` in the Supabase SQL Editor after `schema.sql`. This migration adds provider-separated customer/subscription records and keeps existing Stripe records intact. If the old SQL was already run, rerun `billing.sql`; it is designed to be safe to rerun.
6. Add these values to Vercel's **Preview** environment for sandbox checkout:

| Variable | Value | Type |
| --- | --- | --- |
| `PADDLE_ENVIRONMENT` | `sandbox` | Config |
| `PADDLE_API_KEY` | Paddle sandbox API key | Secret |
| `PADDLE_CLIENT_TOKEN` | Paddle sandbox client-side token | Config |
| `PADDLE_WEBHOOK_SECRET` | Webhook destination secret | Secret |
| `PADDLE_PRICE_STARTER` | Starter sandbox `pri_…` price ID | Config |
| `PADDLE_PRICE_PRO` | Pro sandbox `pri_…` price ID | Config |
| `NOTEJECT_BILLING_ENABLED` | `true` | Config |

7. Redeploy Preview and complete a sandbox checkout, cancellation, and portal visit. The plan changes only after a valid signed Paddle notification; returning to the app alone never grants paid access. Sandbox customers, subscriptions, and action allowances are isolated from live mode.
8. After sandbox checks succeed and Paddle has approved the live checkout domain, repeat with Paddle Live credentials, live price IDs, and a live notification destination in Vercel Production. Set `PADDLE_ENVIRONMENT=live`. Keep old `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_*` settings until existing Stripe subscribers have canceled or been migrated.

Paddle checkout is not active until the Supabase migration is applied, Paddle products and a default payment link exist, the webhook is configured, and the matching Vercel variables are deployed. The public `PADDLE_CLIENT_TOKEN` is intentionally sent to the app; Paddle API and webhook secrets stay server-only. Team checkout remains closed until shared seats and workspaces are implemented.

Official instructions: [Paddle.js overlay checkout](https://developer.paddle.com/build/checkout/build-overlay-checkout/), [prices](https://developer.paddle.com/api-reference/prices/), [webhook signatures](https://developer.paddle.com/webhooks/about/signature-verification/), [customer portal sessions](https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session/).

## Plan limits and cost controls

| Plan | USD/month | Basic actions | Advanced actions | Backup limit | Availability |
| --- | ---: | ---: | ---: | ---: | --- |
| Free | 0 | 10 per UTC calendar month | 0 | 50 MiB | Free account |
| Starter | 5.99 | 200 | 10 | 1 GiB | Available after setup |
| Pro | 12.99 | 1,000 | 100 | 5 GiB | Available after setup |
| Team | 34.99 | 5,000 | 250 | 15 GiB shared | Disabled until team features ship |

Backup space is the maximum size of the account's one current ZIP, including original documents; it is not a history of multiple backups. The app displays each account's effective limit. The plan limits are 50 MiB / 1 GiB / 5 GiB / 15 GiB. Supabase Free limits both the project to 1 GB of total file storage and each individual file to 50 MB. The hosted site therefore defaults `NOTEJECT_SYNC_MAX_BYTES` to 50 MiB until the owner upgrades Supabase, raises the global Storage file-size setting, runs `plan_backup_quotas.sql` in SQL Editor, and sets `NOTEJECT_SYNC_MAX_BYTES=16106127360` in Vercel Production before redeploying. The migration enforces subscription-specific limits in Storage upload policies and the revision RPC. Team is planned with unlimited users and 15 GiB of shared-workspace backup storage; checkout remains unavailable until team collaboration ships.

## Storage and plan economics

Paddle's current pay-as-you-go fee is 5% plus $0.50 per checkout. The estimate below charges every plan its full monthly allowance and assumes about 15,000 Basic input tokens and 36,000 Advanced input tokens per action, with each response reaching its current output-token cap. It uses this repository's current default GPT-5 nano/mini API rates. Actual spend depends on real token counts and configured models.

| Plan | Paddle fee | Estimated full-allowance AI cost | Revenue after Paddle and AI, before hosting and support |
| --- | ---: | ---: | ---: |
| Starter $5.99 | $0.80 | $0.42 | $4.77 |
| Pro $12.99 | $1.15 | $2.77 | $9.07 |
| Team $34.99 | $2.25 | $10.40 | $22.34 |

On Supabase Pro, the first 100 GB of file storage and 250 GB of egress are included in its $25/month starting plan. Above the storage allowance, the current rate is $0.0213/GB/month. At that overage rate, a full Starter, Pro, or Team backup represents about $0.021, $0.107, or $0.320 per month of stored data; actual storage is covered by the included 100 GB until the organization exceeds it. A 15 GB restore uses about $1.35 of egress only after included egress is exhausted. The $25 Supabase subscription alone requires roughly six full-use Starter accounts or three full-use Pro accounts to cover, before other fixed expenses. Team is shown for planning only; it is not currently purchasable.

These estimates exclude refunds, chargebacks, taxes outside Paddle's quoted fee, Vercel, email, support, compliance, and the effect of the GPT-5 model deprecation schedule. Recalculate before launch if the model IDs or quotas change. The default GPT-5 nano and GPT-5 mini models are marked deprecated by OpenAI; check the current model replacement and pricing before their announced retirement.

Each submitted question or summary consumes one action in the selected mode. All plan allowances reset monthly at 00:00 UTC on the first day of each calendar month, independently of subscription billing dates. The current paid plan requires an active/trialing subscription whose paid period has not ended. Past-due, unpaid, canceled, expired, and unknown-price subscriptions receive Free access. Canceling at the end of a paid period keeps access until that period ends.

Basic requests use at most 32,000 passage characters and 1,600 output tokens. Advanced requests use at most 120,000 passage characters and 2,400 output tokens. Recent chat history is bounded to 12,000 characters. A maximum of two recent pending requests and ten starts per minute is enforced per account. Configure provider project spending alerts/rate limits as well; selling an action allowance does not cap the owner's total provider bill.

Only the server can reserve, complete, or release an action. Reservations are atomic and request IDs prevent repeat submissions from invoking the provider again. Explicit provider rejections release their reservation. A timeout or uncertain provider outcome remains counted until reconciled; the server does not silently refund a request that may have generated a bill. If an answer was generated but recording its token usage fails, the answer is returned and the reservation remains counted.

OCR and team collaboration are still planned; their availability is stated on the plan cards. Current paid features are the AI modes, document answers, and larger action allowances.

## Workspace transfer and downloads

The `noteject-workspaces` bucket is private; accounts can access only their own paths. Transfer uses Upload this device / Restore from cloud, not continuous background merging. A revision check protects against overwriting another device's newer upload. Portable backups use ZIP64 when needed, with a 15 GiB safety ceiling. Until the Supabase Pro upgrade, global file-size setting, migration, and Vercel ceiling are configured, the effective maximum remains 50 MiB.

The website uses `WINDOWS_DOWNLOAD_URL` and `ANDROID_DOWNLOAD_URL` for public installer links. Existing configured download URLs do not need to change for these server updates.

## Local checks

Run `npm ci`, then `npm run test:cloud`. Tests use a local PostgreSQL runtime, simulated provider responses, Stripe signature verification, and Chrome through Playwright. They do not send paid AI requests or create real subscriptions. Set `NOTEJECT_TEST_BROWSER` if Chrome is installed elsewhere. Run `npm run build:web` to generate the website and corresponding AGPL source archive.

Existing Stripe billing secrets and webhook configuration remain necessary only while Stripe subscribers need management. Real Paddle sandbox checkout and live billing still require the owner's Paddle products, credentials, webhook, and Vercel deployment.
