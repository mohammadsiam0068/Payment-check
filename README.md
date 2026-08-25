# bKash/Nagad/TallyPay Payment Verification System

Automated payment verification for a Telegram bot. An Android SMS forwarder posts incoming payment SMS to a Cloudflare Worker, which parses and stores transactions in D1. The Telegram bot verifies transactions against the Worker API.

## Structure

```
worker/
  index.js       Cloudflare Worker API (/add-sms, /verify-trx)
  wrangler.toml  Worker + D1 config
  schema.sql     D1 table schema
bot/
  verify_trx.py  Python function to call /verify-trx from the bot
```

## Setup

### 1. Create the D1 database

```
wrangler d1 create payments_db
```

Copy the returned `database_id` into `worker/wrangler.toml`.

### 2. Apply the schema

```
wrangler d1 execute payments_db --file=worker/schema.sql
```

### 3. Set the API secret (not committed to git)

```
cd worker
wrangler secret put API_SECRET_KEY
```

### 4. Deploy the Worker

```
wrangler deploy
```

### 5. Configure the bot

Set environment variables before running the bot:

```
export WORKER_URL="https://your-worker.your-subdomain.workers.dev"
export API_SECRET_KEY="same-value-as-worker-secret"
```

## Supported SMS formats

The parser in `worker/index.js` currently handles:
- bKash "received" SMS
- Nagad "Money Received" SMS
- TallyPay QR payment SMS (sender number is masked in these, e.g. `016***4467`)

## API

All requests require `Authorization: Bearer <API_SECRET_KEY>`.

**POST /add-sms**
```json
{ "sms_text": "..." }
```

**POST /verify-trx**
```json
{ "trx_id": "..." }
```
