# Deployment

Two paths. The first is a throwaway demo on free infrastructure. The second is a
real deployment on your own.

Both share the same architecture decision, and it is the important one:

> **Seed the database from a machine that stays awake. Deploy only the API.**

Ingestion takes hours and is paced deliberately slowly so Google Play does not
ban the IP. Every free tier suspends a service after minutes of inactivity, which
would kill a run halfway and leave the catalogue half written with nothing to say
where it stopped. So the deployed service is a light reader over a database that
was filled from somewhere else. That also keeps the deployment's outbound
footprint at zero, which is the safest place for it to be.

---

## Provider terms, checked 2026-07-27

Verify before relying on any of it; these change often.

### Databases

| | Free storage | Idle behaviour | Card required |
|---|---|---|---|
| **Neon** | 0.5 GB per project, up to 100 projects | Compute scales to zero after 5 min; wakes in well under a second | No |
| **Supabase** | 0.5 GB | Project **paused** after a week of inactivity; needs a manual restore from the dashboard | No |

**Recommendation: Neon.** Both give the same storage, but Supabase pausing a
project after a week of no traffic is exactly wrong for a demo that sits idle
between the day you send the link and the day the client opens it. Neon just
sleeps and wakes on the next query.

Sizing, measured on this project:

| What | Per app | 20,000 apps |
|---|---|---|
| Listing, plus its raw API payload | ~25 KB | ~500 MB |
| Google Play page HTML, sampled 1 in 100 | ~3.4 KB amortised | ~69 MB |

So about **570 MB for 20,000 apps**, which is over a 0.5 GB free tier. For a
demo, seed 10,000-15,000 and it fits comfortably; for a full catalogue, budget a
paid tier or raise `PLAY_HTML_SAMPLE_RATE`.

The page HTML deserves the note. A Play page is 1.3 MB, 338 KB once Postgres
compresses it, and an earlier version of this service stored every one of them:
6.5 GB at twenty thousand apps, filling a free tier at around fifteen hundred.
It is now sampled and each app keeps only its most recent page, so the corpus is
a fixed cost. `PLAY_STORE_HTML=false` removes it entirely, at the price of
needing to re-fetch from Google the day a parser has to be rebuilt.

### API hosting

| | Free instance | Sleeps after | Cold start | Card required |
|---|---|---|---|---|
| **Koyeb** | 512 MB RAM, 0.1 vCPU, 2 GB SSD | **1 hour** idle | ~5 s | Usually no; may ask if it cannot verify you are human |
| **Render** | 512 MB | **15 min** idle | **30-60 s** | No |
| **Fly.io** | none. Trial of 2 VM-hours or 7 days | n/a | n/a | **Yes**, after the trial |

**Recommendation: Koyeb.** Four times the idle window and roughly ten times
faster to wake. Render's 30-60 second cold start is the difference between a
client thinking "it is loading" and "it is broken".

**Fly.io is ruled out for the demo** — it no longer has a free tier. It remains a
good target for the client's own paid infrastructure, and `fly.toml` is in the
repo for that.

### What to tell the client before they open the link

With Koyeb: *"if nobody has touched it for over an hour the first request takes
about five seconds while it wakes up. After that it is instant."*

With Render: *"the first request can take up to a minute while it wakes up. Give
it a moment before deciding it is broken."*

If the wake-up is unacceptable, either paid tier removes it, or a cron hitting
`/health` every 10 minutes keeps it warm. Note that keeping it warm on Render
burns the 750 monthly instance-hours in about 31 days, so it only works for one
service.

---

## Path 1: the demo

### 1. Database

Create a project at neon.tech (no card). Copy the **pooled** connection string;
it looks like:

```
postgres://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/DBNAME?sslmode=require
```

Pooled matters: a serverless API opens and closes connections constantly and will
exhaust a direct connection limit.

### 2. Seed it from your machine

```bash
export DATABASE_URL='postgres://...pooler...neon.tech/...?sslmode=require'
export API_BEARER_TOKEN=$(openssl rand -hex 32)   # keep this, the API needs it too

bun install
bun run db:migrate
bun run seed --apps 1500 --categories 12 --markets us:en,es:es
```

Budget roughly **1 hour per 1,500 listings**, dominated by Google Play at about
1,600/hour. It is safe to interrupt and re-run: the queue is durable and
deduplicated, so a second run continues rather than restarting.

Check what landed:

```bash
bun run ingest status
```

### 3. Deploy the API

Push the repo to GitHub first, then:

**Koyeb** — from the dashboard, "Create Service" → GitHub → this repo →
Dockerfile. Or with the CLI:

```bash
koyeb app init store-data-api \
  --git github.com/YOUR_ORG/store-data-api \
  --git-branch main \
  --git-builder docker \
  --ports 3000:http \
  --routes /:3000 \
  --instance-type free \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env INGEST_WORKER_ENABLED=false \
  --env LIVE_SEARCH_ENABLED=false \
  --env DATABASE_URL=@database-url \
  --env API_BEARER_TOKEN=@api-token
```

Create the two secrets first so they never touch the repo:

```bash
koyeb secret create database-url --value 'postgres://...'
koyeb secret create api-token    --value 'the token from step 2'
```

**Render** — `render.yaml` is a blueprint; point Render at the repo and it picks
it up. `DATABASE_URL` and `API_BEARER_TOKEN` are marked `sync: false` there
precisely so they are set in the dashboard and never in git.

Both give HTTPS on their own domain automatically.

### 4. Verify before sending the link

```bash
API=https://your-service.koyeb.app
TOKEN=the-token

curl -s $API/health
curl -s $API/v1/apps                                  # expect 401
curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/apps?per_page=3"
curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/steam?per_page=3"
curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/top?sort=TOP_FREE"
curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/search?q=translate"
curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/categories" | grep -c '"id"'
curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/status"
```

`/v1/status` is the one to read: it reports counts per source, the age of the
oldest listing, and whether anything is failing.

---

## Path 2: their own infrastructure

Everything needed is in the repo. No provider is assumed.

### Docker, standalone

```bash
docker build -t store-data-api .
docker run -d --name store-data-api -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@db-host:5432/storedata' \
  -e API_BEARER_TOKEN='...' \
  store-data-api
```

The image is 247 MB, runs as a non-root user, and carries a healthcheck on
`/health`. Migrations are applied at boot, so there is no separate step and a
deploy cannot serve against a schema it does not have.

### Docker Compose, API plus database

```bash
cp .env.example .env      # set API_BEARER_TOKEN
docker compose up --build
```

### Refreshing the data

Ingestion is a separate, re-runnable command. It never runs as part of serving.

```bash
# whole cycle: discover, promote, fetch
docker compose run --rm api bun run seed --apps 2000 --categories 20

# or the phases separately, for finer control
docker compose run --rm api bun run ingest seed    --source play,ios,steam
docker compose run --rm api bun run ingest promote --limit 500
docker compose run --rm api bun run ingest drain   --limit 500
```

Re-running refreshes what is stale and adds what is missing. It never duplicates:
discovery deduplicates on insert and the fetch queue on a stable key.

A daily refresh as a cron:

```
0 3 * * *  docker run --rm --env-file /etc/store-data-api.env store-data-api bun run seed --apps 2000
```

### Continuous ingestion instead

On infrastructure that does not sleep, run the worker as a second container from
the same image:

```bash
docker run -d --name store-data-ingest \
  --env-file /etc/store-data-api.env \
  -e INGEST_WORKER_ENABLED=true \
  store-data-api
```

Keep it separate from the API container. They scale differently, and a worker
that crashes must not take the reader down with it.

### Reprocessing without re-fetching

Every source response is stored untouched next to the normalized row. When a
store changes a field, and it will, fix the normalizer and re-run over what is
already on disk:

```bash
docker compose run --rm api bun run ingest renormalize --source play --limit 5000
```

No network calls, no risk of a block. This is the difference between an afternoon
and a week.

---

## Operational notes

**Secrets.** `DATABASE_URL` and `API_BEARER_TOKEN` are read from the environment
and nothing else. `.env` is gitignored, `.dockerignore` excludes it from the
image, and the deploy configs mark both as dashboard-set values. Rotating the
token is an environment change and a restart.

**Connection pooling.** Use the pooled string on any managed Postgres. The client
opens up to 10 connections per instance.

**Scaling the API.** It is stateless; run as many as you like behind a load
balancer. The ingest worker is not: run exactly one, or accept that the pacing is
multiplied by the number of workers, which is how an IP gets banned.

**Backups.** `raw_payloads` is the valuable table. Everything else can be rebuilt
from it with `renormalize`, without contacting a store.

**The rate limiter is in-memory.** With more than one API instance the live
search limit becomes per-instance rather than global. Either accept it, or set
`LIVE_SEARCH_ENABLED=false` on all but one, or move the limiter to Postgres,
which is a small change behind the existing interface.

---

## Cost, if they outgrow the free tiers

| | Free | Paid entry |
|---|---|---|
| Neon | 0.5 GB, 100 compute-h | ~$5/mo higher storage, no autosuspend |
| Koyeb | 1 instance, sleeps at 1 h | ~$2-5/mo instance that never sleeps |
| Render | 750 instance-h, sleeps at 15 min | $7/mo per service, no sleep |

Realistically: about **$10-15/month** removes every free-tier limitation for this
workload. Which is worth saying to a client who is deciding whether the demo is
representative.
