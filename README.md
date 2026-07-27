# Store Data API

Normalized app data from **Google Play**, the **App Store** and **Steam**, behind one
versioned, token-protected REST API.

Every record comes back in the same flat shape regardless of which store it came
from, with a permanent slug, an explanation for every null, and the age of the
data attached.

- Stack: Bun + Hono + TypeScript + Drizzle ORM + PostgreSQL
- Auth: `Authorization: Bearer <token>` on every `/v1` route
- Language: API messages in English; content language is per request

---

## Quick start

Everything, including a database, in one command:

```bash
cp .env.example .env      # set API_BEARER_TOKEN (openssl rand -hex 32)
docker compose up --build # API on http://localhost:3000
```

Or without Docker, against a Postgres you start yourself:

```bash
docker run -d --name storedata-pg \
  -e POSTGRES_PASSWORD=storedata -e POSTGRES_USER=storedata -e POSTGRES_DB=storedata \
  -p 55432:5432 postgres:17-alpine

cp .env.example .env      # set API_BEARER_TOKEN
bun install
bun run db:migrate
bun run start
```

```bash
bun test
bun run typecheck
```

**The service starts with an empty catalogue.** Only `/v1/categories` has data
out of the box, because it is a static file. Fill the rest:

```bash
bun run seed --apps 500
```

### About `pglite://`

`DATABASE_URL` also accepts `pglite://./data/pgdata`, an embedded Postgres that
needs no server at all. Same engine, same schema, same SQL: it is what the test
suite runs on.

**It is single-process.** Two processes opening the same directory do not share
it, they overwrite each other. Left unguarded the symptom is brutal: the ingest
reports rows written, the API keeps answering zero, and restarting does not help
because the server flushes its own stale state back over the file on shutdown.
Every part of that looks like success, so the natural conclusion is that the
ingest is broken, and it is not.

| Use `pglite://` for | Use Postgres for |
|---|---|
| `bun test` | the API and an ingest running together |
| one `bun run ingest ...` with nothing else running | anything shared, and every deployment |

The service enforces this rather than trusting you to remember it. A second
process opening the same directory refuses to start, names the PID holding it,
and prints the Postgres command to use instead. It will never silently serve an
empty catalogue.

---

## Filling the catalogue

Ingestion is a **separate, re-runnable command**. It is never part of serving a
request, and the worker is off by default: starting a process should not begin
hitting the stores by surprise.

```bash
# whole cycle: discover, promote, fetch
bun run seed --apps 2000 --categories 20 --markets us:en,es:es

# or the phases separately
bun run ingest seed    --source play,ios,steam --categories 12 --num 50
bun run ingest promote --limit 500
bun run ingest drain   --limit 500

bun run ingest status
```

Re-running refreshes what is stale and adds what is missing. It never duplicates:
discovery deduplicates on insert, the fetch queue on a stable key. It is safe to
interrupt; the queue is durable and a second run continues where the first
stopped.

Budget about **one hour per 1,500 listings**, dominated by Google Play.

Rebuild from stored payloads, with no network calls at all:

```bash
bun run ingest renormalize --source play --limit 5000
```

**Do not run ingestion on a free-tier web instance.** They sleep after minutes of
inactivity and would abandon a run halfway. Run it from a machine that stays
awake, pointed at the same database the API reads. See [DEPLOY.md](DEPLOY.md).

---

## Deploying

Full runbook in **[DEPLOY.md](DEPLOY.md)**, including current free-tier terms,
cold-start times and a cost comparison. The short version:

| | |
|---|---|
| Docker | `docker build -t store-data-api . && docker run -p 3000:3000 -e DATABASE_URL=... -e API_BEARER_TOKEN=... store-data-api` |
| Compose | `docker compose up --build` |
| Render | `render.yaml` blueprint, secrets set in the dashboard |
| Fly.io | `fly.toml`, `fly secrets set ...` |
| Koyeb | CLI command in DEPLOY.md |

The architecture decision that matters: **seed the database from a machine that
stays awake, deploy only the API.** The deployed service is then a light reader
with zero outbound footprint, which is both the safest and the cheapest place for
it to be.

Migrations run at boot, so a deploy cannot serve against a schema it does not
have. `DATABASE_URL` and `API_BEARER_TOKEN` come from the environment and nothing
else; `.env` is gitignored and excluded from the image.

---

## Endpoints

Every route below requires the Bearer token. `/health` does not, and exposes
nothing beyond liveness.

| Route | What it returns |
|---|---|
| `GET /v1/apps` | Google Play and App Store listings |
| `GET /v1/apps/:slug` | One listing, by permanent slug |
| `GET /v1/apps/:source/:sourceId` | One listing, by native store id |
| `GET /v1/steam` | Steam titles |
| `GET /v1/steam/:slug` | One Steam title (slug or appid) |
| `GET /v1/search?q=` | Search over the local index |
| `GET /v1/top?sort=` | `TOP_FREE`, `TOP_PAID`, `GROSSING` |
| `GET /v1/categories` | The 55 canonical categories, verbatim |
| `GET /v1/coverage` | What each source covers, what it does not, and why |
| `GET /v1/export/apps` | Bulk export with a keyset cursor |
| `GET /v1/status` | Operational health, per source |
| `GET /health` | Liveness, no token needed |

### Common parameters

| Parameter | Default | Notes |
|---|---|---|
| `country` | `us` | Any ISO 3166-1 alpha-2 code |
| `lang` | `en` | Any language code |
| `page` | `1` | Clamped to `max(1, value)` |
| `per_page` | `50` | Clamped to `max(1, min(200, value))` |
| `source` | all | `play`, `ios`, `steam`, comma separated |
| `type` | all | `app` or `game` |
| `sort_by` | `score` | `score`, `ratings`, `updated`, `title`, `price` |
| `order` | `desc` | `asc` or `desc` |
| `include_delisted` | `false` | `true` on `/v1/export/apps` |

Unparseable values fall back to the default rather than returning a 400: one bad
link in a page should not take the whole page down. Unknown enum values (an
invalid `source`, `sort` or `category`) do return 400, because silently
substituting a different one would be worse.

---

## API reference

Every example below is a real response, trimmed for length. Set these first:

```bash
API=http://localhost:3000
TOKEN=your-token
AUTH="Authorization: Bearer $TOKEN"
```

### Authentication

```bash
curl -s "$API/v1/apps"
```

```json
{
  "code": "store_unauthorized",
  "message": "Unauthorized: Authorization: Bearer <token> is required.",
  "data": { "status": 401 }
}
```

If the *server* has no token configured the answer is **503
`store_no_token_configured`**, not 401. The caller must be able to tell "you are
not authorized" from "this service is misconfigured".

---

### `GET /v1/apps`

Google Play and App Store listings.

```bash
curl -s -H "$AUTH" "$API/v1/apps?per_page=1&country=us&lang=en&type=app&sort_by=score"
```

```json
{
  "version": "v1",
  "generated_at": "2026-07-27T00:05:25+00:00",
  "lang": "en",
  "country": "us",
  "total": 66,
  "pages": 66,
  "page": 1,
  "per_page": 1,
  "items": [
    {
      "slug": "paprika-recipe-manager-3",
      "appId": "id1303222868",
      "iosId": "id1303222868",
      "title": "Paprika Recipe Manager 3",
      "summary": null,
      "developer": "Hindsight Labs LLC",
      "icon": "https://is1-ssl.mzstatic.com/image/thumb/.../512x512bb.jpg",
      "score": 4.89907,
      "scoreText": "4.9",
      "ratings": 53259,
      "price": 4.99,
      "free": false,
      "priceText": "$4.99",
      "genre": "Food & Drink",
      "genreId": "6023",
      "type": "app",
      "url": "https://apps.apple.com/us/app/paprika-recipe-manager-3/id1303222868?uo=4",
      "_meta": {
        "source": "ios",
        "sourceId": "id1303222868",
        "market": { "country": "us", "lang": "en" },
        "fetchedAt": "2026-07-26T23:24:41.000Z",
        "ageSeconds": 2444,
        "status": "active"
      }
    }
  ]
}
```

List items are summaries. For the full 58-field contract, request one app.

---

### `GET /v1/apps/:slug`

One listing, complete. Also accepts `/v1/apps/:source/:sourceId` if you hold a
package name or an iTunes id instead of our slug.

```bash
curl -s -H "$AUTH" "$API/v1/apps/google-translate"
```

```json
{
  "title": "Google Translate",
  "description": "Translate between 100+ languages...",
  "descriptionHTML": "Translate between 100+ languages...<br>",
  "summary": "The world is closer than ever with over 100 languages",
  "installs": "1,000,000,000+",
  "minInstalls": 1000000000,
  "maxInstalls": 1898626813,
  "score": 4.2657614,
  "scoreText": "4.3",
  "ratings": 9037501,
  "reviews": 187726,
  "histogram": { "1": 971804, "2": 306451, "3": 475674, "4": 877707, "5": 6405834 },
  "price": 0,
  "free": true,
  "currency": "USD",
  "priceText": "Free",
  "offersIAP": false,
  "IAPRange": null,
  "androidVersion": "VARY",
  "developer": "Google LLC",
  "developerEmail": "translate-mobile-support@google.com",
  "genre": "Tools",
  "genreId": "TOOLS",
  "categories": [{ "name": "Tools", "id": "TOOLS" }],
  "icon": "https://play-lh.googleusercontent.com/...",
  "screenshots": ["https://play-lh.googleusercontent.com/...", "..."],
  "contentRating": "Everyone",
  "editorsChoice": null,
  "features": [],
  "appId": "com.google.android.apps.translate",
  "iosId": null,
  "url": "https://play.google.com/store/apps/details?id=com.google.android.apps.translate&hl=en&gl=us",
  "type": "app",

  "slug": "google-translate",
  "extra": { "play": { "available": true } },
  "_meta": {
    "source": "play",
    "sourceId": "com.google.android.apps.translate",
    "market": { "country": "us", "lang": "en" },
    "fetchedAt": "2026-07-26T23:04:34.000Z",
    "ageSeconds": 1988,
    "lastChangedAt": "2026-07-26T23:04:34.000Z",
    "schemaVersion": "1.0.0",
    "status": "active",
    "fieldCoverage": { "editorsChoice": "not_available", "features": "not_available" },
    "derivedFields": {}
  }
}
```

61 keys: the 58 canonical fields, plus `slug`, `extra` and `_meta`.

`404` for an unknown slug, and a Steam title asked for here returns 404 pointing
at `/v1/steam/:slug` rather than pretending not to exist.

---

### `GET /v1/steam`

Same contract, Steam data.

```bash
curl -s -H "$AUTH" "$API/v1/steam/730"
```

```json
{
  "title": "Counter-Strike 2",
  "summary": "For over two decades, Counter-Strike has offered an elite competitive experience...",
  "score": 4.3031,
  "scoreText": "4.3",
  "ratings": 9747318,
  "histogram": null,
  "price": 0,
  "free": true,
  "priceText": "Free",
  "installs": null,
  "androidVersion": null,
  "developer": "Valve",
  "genre": "Action",
  "genreId": "1",
  "appId": "730",
  "iosId": null,
  "type": "game",
  "url": "https://store.steampowered.com/app/730/?cc=us&l=en",

  "slug": "counter-strike-2",
  "extra": {
    "steam": {
      "platforms": { "windows": true, "mac": false, "linux": true },
      "metacritic": null,
      "categories": [{ "id": 1, "description": "Multi-player" }],
      "reviewSummary": {
        "reviewScore": 8,
        "reviewScoreDesc": "Very Positive",
        "totalPositive": 8388604,
        "totalNegative": 1358714,
        "totalReviews": 9747318
      }
    }
  },
  "_meta": {
    "source": "steam",
    "fieldCoverage": {
      "histogram": "not_available",
      "installs": "not_applicable",
      "androidVersion": "not_applicable"
    },
    "derivedFields": {
      "score": "total_positive / total_reviews * 5 (Steam publishes no star average)",
      "offersIAP": "presence of Steam store category 35 (In-App Purchases)"
    }
  }
}
```

Note `histogram: null` with `not_available`, and `score` present but flagged as
derived with the formula attached. Steam publishes a positive/negative split, not
a star average; the real numbers are untouched in `extra.steam.reviewSummary`.

---

### `GET /v1/top`

```bash
curl -s -H "$AUTH" "$API/v1/top?sort=TOP_FREE&source=play&category=TOOLS&per_page=2"
```

```json
{
  "version": "v1",
  "generated_at": "2026-07-27T00:05:25+00:00",
  "lang": "en",
  "country": "us",
  "total": 40,
  "pages": 20,
  "page": 1,
  "per_page": 2,
  "items": [
    {
      "slug": "chatgpt-6ebf5fc",
      "appId": "com.openai.chatgpt",
      "title": "ChatGPT",
      "developer": "OpenAI",
      "score": 4.7690077,
      "ratings": 51159005,
      "priceText": "Free",
      "type": "app"
    }
  ],
  "source": "play",
  "sort": "TOP_FREE",
  "category": "APPLICATION",
  "items_ingested": 40,
  "captured_at": "2026-07-26T23:31:15.151Z",
  "expires_at": "2026-07-27T05:31:15.151Z",
  "age_seconds": 2050,
  "stale": false
}
```

Items come back in stored ranking position and are never re-sorted, so the same
snapshot always renders identically. The freshness of the *chart* is reported
separately from the freshness of the listings inside it.

`total` is the size of the chart Google published; `items_ingested` is how many
of those listings we hold. On a fresh catalogue they differ, and a chart of
twenty with an empty page is not a failure, it is twenty apps we know about and
have not fetched yet. Run the seed for longer and the two converge.

Charts that do not exist are refused with an explanation rather than substituted:

```bash
curl -s -H "$AUTH" "$API/v1/top?sort=GROSSING&source=ios"
```

```json
{
  "code": "store_bad_request",
  "message": "Apple publishes no public grossing chart. Only TOP_FREE and TOP_PAID are available for source=ios.",
  "data": { "status": 400, "source": "ios", "sort": "GROSSING", "supported": ["TOP_FREE", "TOP_PAID"] }
}
```

---

### `GET /v1/search`

```bash
curl -s -H "$AUTH" "$API/v1/search?q=translate&per_page=1"
```

```json
{
  "version": "v1",
  "generated_at": "2026-07-27T00:05:25+00:00",
  "lang": "en",
  "country": "us",
  "total": 3,
  "pages": 3,
  "page": 1,
  "per_page": 1,
  "items": [
    {
      "slug": "google-translate",
      "appId": "com.google.android.apps.translate",
      "title": "Google Translate",
      "developer": "Google LLC",
      "score": 4.2657614,
      "ratings": 9037501,
      "type": "app"
    }
  ],
  "query": "translate",
  "live_fallback_used": false,
  "queued_for_ingest": 0
}
```

Searches the local Postgres index, over titles *and* descriptions. It never
queries Google Play. When nothing matches locally it may query App Store and
Steam, bounded by a short deadline and a per-caller rate limit, and queues what it
finds so the next identical search is served locally. `live_fallback_used` and
`queued_for_ingest` tell you when that happened.

---

### `GET /v1/categories`

```bash
curl -s -H "$AUTH" "$API/v1/categories"
```

```json
{
  "version": "v1",
  "generated_at": "2026-07-27T00:05:25+00:00",
  "lang": "en",
  "country": "us",
  "total": 55,
  "items": [
    { "id": "APPLICATION", "slug": "application", "name": "Application", "type": "app", "ingestable": true },
    { "id": "GAME_ACTION", "slug": "game-action", "name": "Game Action", "type": "game", "ingestable": true },
    { "id": "GAME_WORLD", "slug": "game-world", "name": "Game World", "type": "game", "ingestable": false }
  ]
}
```

Not paginated: it is a fixed reference list. `id`, `slug` and `name` are served
exactly as supplied, in the order supplied.

`ingestable: false` marks `GAME_WORLD`, which is in the canonical list but is not
part of Google Play's taxonomy, so no ranking can be fetched for it.

---

### `GET /v1/coverage`

What each source can give, what it cannot, and why. This is the endpoint that
stops an empty field from looking like a bug in the integration.

```bash
curl -s -H "$AUTH" "$API/v1/coverage?source=ios&only=gaps"
```

```json
{
  "sources": [{
    "source": "ios",
    "listings": 40,
    "gaps": [
      { "field": "installs", "reason": "not_applicable" },
      { "field": "histogram", "reason": "not_available" }
    ],
    "common": [
      { "field": "downloadSizeBytes", "filledFrom": "fileSizeBytes",
        "note": "Apple publishes this; Google Play does not" }
    ],
    "notes": ["Chart position is the closest thing to a popularity signal for this source, because Apple publishes no install counts anywhere."]
  }]
}
```

Without `only=gaps` it reports all 58 fields per source with a **measured fill
rate** across the stored listings. The two numbers answer different questions:

- `declared: "not_applicable"` — the store has no such concept. A property of the
  store, permanent.
- `declared: "not_available"` — the concept exists but the official API does not
  return it. Could be filled later, at a cost worth weighing.
- `declared: null` with a low fill rate — the source *can* fill it and the
  developers left it blank. Working correctly. On our sample, `video` sits at 19%
  for Google Play because four listings in five have no promo video.

### `GET /v1/export/apps`

```bash
curl -s -H "$AUTH" "$API/v1/export/apps?limit=500&since=2026-07-26T00:00:00Z"
```

```json
{
  "version": "v1",
  "generated_at": "2026-07-27T00:05:25+00:00",
  "lang": "en",
  "country": "us",
  "count": 500,
  "has_more": true,
  "next_cursor": "eyJsYXN0Q2hhbmdlZEF0IjoiMjAyNi0wNy0yNlQyMzowNDozNC4wMzNaIiwiaWQiOjF9",
  "since": "2026-07-26T00:00:00.000Z",
  "items": ["... full 61-key records ..."]
}
```

Pass `next_cursor` back verbatim as `?cursor=` for the next page. Items are the
complete contract, ready to build a page from.

---

### `GET /v1/status`

```bash
curl -s -H "$AUTH" "$API/v1/status"
```

```json
{
  "generated_at": "2026-07-27T00:05:25.000Z",
  "healthy": true,
  "warnings": [],
  "totals": { "apps": 86, "listings": 86, "rankings": 6, "crossLinked": 18 },
  "sources": [
    {
      "source": "play",
      "apps": 26,
      "listings": 26,
      "delisted": 0,
      "markets": 1,
      "oldestAgeSeconds": 1478,
      "staleListings": 0,
      "events24h": { "ok": 30 },
      "breaker": { "state": "ok", "consecutiveFailures": 0, "blockedUntil": null }
    }
  ],
  "queue": {
    "ingest": { "done": 85 },
    "discovery": { "pending": 183, "ingested": 85 },
    "stalledRunningJobs": 0,
    "movingLastHour": 90
  }
}
```

---

### `GET /health`

No token needed, exposes nothing else.

```json
{ "status": "ok", "version": "v1", "generated_at": "2026-07-27T00:03:43+00:00" }
```

---

## Response shape

### Envelope

Identical to the coupons API your team already parses, with one additive field.

Paginated:

```json
{
  "version": "v1",
  "generated_at": "2026-07-26T23:28:28+00:00",
  "lang": "en",
  "country": "us",
  "total": 13987,
  "pages": 6994,
  "page": 1,
  "per_page": 2,
  "items": []
}
```

Unpaginated (`/v1/categories`): the same without `pages`, `page` and `per_page`.

**The one addition is `country`.** The coupons feed is single-market so `lang`
identified it on its own; here the data depends on country *and* language, and a
consumer that cannot tell which market it received cannot cache or compare
anything. Nothing was renamed or removed.

### One app

Three levels, all additive. A consumer written against the original object works
untouched.

```jsonc
{
  // 1. The canonical core: the 58 fields you specified, exact names,
  //    ALWAYS all present, null when the source has no value.
  "title": "Wallpaper Engine",
  "description": "...",
  "descriptionHTML": "...",
  "histogram": null,
  "installs": null,
  // ... 53 more

  // 2. Permanent URL segment. Generated once, never recomputed.
  "slug": "wallpaper-engine",

  // 3. Source-specific data that has no place in a Play-shaped schema.
  "extra": {
    "steam": { "metacritic": {}, "platforms": {}, "dlc": [], "reviewSummary": {} }
  },

  // 4. Provenance and freshness.
  "_meta": {
    "source": "steam",
    "sourceId": "431960",
    "market": { "country": "us", "lang": "en" },
    "fetchedAt": "2026-07-26T23:25:11.000Z",
    "ageSeconds": 148,
    "lastChangedAt": "2026-07-26T23:25:11.000Z",
    "schemaVersion": "1.0.0",
    "status": "active",
    "fieldCoverage": { "histogram": "not_available", "installs": "not_applicable" },
    "derivedFields": { "score": "total_positive / total_reviews * 5" },
    "iosMatch": { "confidence": 1, "method": "bundle_id_exact" }
  }
}
```

### Two contract details worth stating outright

**`undefined` becomes `null`.** Your example is JavaScript and uses `undefined`
for `IAPRange`, `video`, `released` and others. JSON has no `undefined`; a key
holding it would simply vanish on serialisation, breaking the "every key always
present" guarantee. Those fields are served as `null`.

**Keys are never omitted.** Every one of the 58 canonical fields is present on
every record from every source. That is what lets you type the payload once in
Flutter or Astro instead of guarding each field.

### `common`: cross-store equivalents

A null is not always honest. `androidVersion` is null on an App Store listing and
that is **correct** — writing Apple's `minimumOsVersion` into a field named
`androidVersion` would assert something false. But the question underneath, "what
does this need to run", has an answer on all three stores.

So the canonical fields keep their platform-specific meaning and stay null where
they do not apply, and `common` answers the same question in a platform-neutral
shape, next to them. Every value records the field it came from.

| Field | Play | App Store | Steam |
|---|---|---|---|
| `minimumOs` | `androidVersion` (null version on VARY) | `minimumOsVersion` | `platforms` + `pc_requirements` |
| `downloadSizeBytes` | not published | `fileSizeBytes` | not published |
| `supportedLanguages` | not published | `languageCodesISO2A` | `supported_languages` |
| `publisher` | no separate publisher | `sellerName` when it differs | `publishers[0]` |
| `reviewSummary` | derived from `histogram` | not derivable from a mean | `appreviews` or SteamSpy |
| `rankings`, `bestRank` | chart positions | chart positions | chart positions |

```jsonc
"common": {
  "minimumOs": { "platform": "windows", "version": "10", "text": "Windows® 10",
                 "sourceField": "pc_requirements.minimum" },
  "downloadSizeBytes": null,
  "supportedLanguages": ["English", "French", "..."],
  "publisher": "Valve",
  "reviewSummary": {
    "positive": 8387537, "negative": 1359781, "total": 9747318,
    "percentPositive": 86, "label": "Very Positive",
    "provenance": { "provider": "steam", "authoritative": true, "fetchedAt": "..." }
  },
  "rankings": [{ "collection": "TOP_FREE", "categoryId": "APPLICATION",
                 "country": "us", "position": 1, "capturedAt": "..." }],
  "bestRank": { "collection": "TOP_FREE", "position": 1 }
}
```

**Ranking position matters most for the App Store.** Apple publishes no install
counts anywhere, so a chart placement is the only popularity signal that exists
for an iOS listing. It is in the compact list form too, not just the full record.
An app in no chart gets `[]` and `null`, which is a real answer: most apps are in
no chart.

**`reviewSummary` is not a histogram.** A histogram needs five real per-star
buckets and only Google Play publishes those. A positive/negative split is weaker
but genuinely comparable, and all three can produce one — two directly, one by
derivation. Where it is derived, `derivedFrom` says exactly how. `histogram` still
stays null for Steam rather than being reconstructed.

For Play the split excludes three-star ratings from the **ratio** and reports them
in `neutral`, so the whole distribution is visible:

```json
"reviewSummary": {
  "positive": 218322156,   // 4-5 stars
  "neutral":    8342491,   // 3 stars, outside the ratio
  "negative":  13090681,   // 1-2 stars
  "total":    231412837,   // positive + negative
  "percentPositive": 94.3
}
```

Why exclude rather than pick a side: a Steam thumbs-up means "I recommend this"
and a three-star rating means "it is okay". Measured across our corpus, counting
three stars as positive moves the figure by 0.1 to 1.2 points; counting it as
negative moves it by 3 to 4. Excluding it and exposing the count is the only
option that does not quietly assert one of those.

**`total` is smaller than `ratings`, and no convention fixes that.** Google's own
five buckets do not sum to its own `ratings` count: on every app measured the
histogram is 24 to 82 ratings short. Since nothing reconciles them exactly,
exposing `neutral` is better than picking a convention that appears to.

A consumer who prefers a different convention computes it from the fields:

```js
// three stars as positive
const pct = (positive + neutral) / (total + neutral) * 100   // 94.5 vs 94.3
```

`neutral` is null for Steam: its thumb is binary, so there is no middle to report.
Null rather than zero, because zero would claim nobody was ambivalent, and that is
not something Valve measures.

**`provenance` exists because not every provider is the store.** Steam review
counts come from Valve when we have them and from SteamSpy in bulk otherwise;
`authoritative` tells you which. See below.

### Google Play: our own parser

The client's position is that this service should own its scraping rather than
delegate it. App Store and Steam always did: both are our own requests against
Apple's and Valve's public APIs. Play was the exception, and this closes it.

| Operation | Parser |
|---|---|
| App listing | **ours** |
| Search | **ours** |
| Developer catalogue | **ours** |
| Similar apps | **ours** |
| Category page | **ours** |
| Top charts | **ours** |

**Why it is better, not merely independent.** Play ships its data as an
obfuscated array addressed by numeric position, which is why every parser for it
needs constant maintenance and why they all fail the same way: Google reorders
something, every coordinate dies at once, and the parser returns undefined for
everything without noticing.

The same page also carries a schema.org `SoftwareApplication` block, Open Graph
tags and microdata, which Google renders its own search results from. Those give
title, developer, rating, rating count, price, currency, category, icon and
content rating from a published contract Google has an interest in keeping
stable.

Reading the page twice makes the two readings comparable. When a coordinate
drifts, its value stops matching the structured one and `_meta` reports the
disagreement before anything is stored. A position-addressed parser cannot tell
"this app has no rating" from "ratings moved"; this one can.

It already pays for itself: `google-play-scraper` reports Google Translate's
minimum Android version as "Varies with device", because its coordinate no
longer resolves and it falls back to a placeholder. Ours reads the real value,
6.0.

**Verified, not asserted.** `bun run compare-parsers` runs both parsers over
real listings and diffs them field by field:

```
apps: 6 | fields compared: 47 | identical: 47 | differing: 0
```

Excluded from that count, each with a stated reason: `url`, `score`, `ratings`
and `price` (formatting), `reviews` and `histogram` (live counters, since the
library insists on its own fetch), `androidVersion` (ours is right), `summary`
(the library leaves HTML entities encoded and we decode them, which is the exact
defect the client reported on the previous project) and `description`
(whitespace).

**Top charts** come through `batchexecute`, Google's internal RPC, because there
is no HTML to parse: the category page carries the words "Top free" with no app
data underneath. That request is built here from its parts; the only transcribed
piece is the field selector in `list-protocol.ts`, a wire-format constant with no
logic in it. Verified against the reference implementation: all three charts,
same apps, same order.

`google-play-scraper` is a **dev dependency**. It is imported by
`bun run compare-parsers` and by one test that checks our category list still
matches its constants. The production image is built with `--production` and does
not contain it; nothing under `src/` outside that one CLI imports it.

### SteamSpy: cost versus accuracy, stated plainly

Valve's `appreviews` is one request per game. Three thousand Steam titles is three
thousand requests for a number that moves slowly. SteamSpy's bulk export returns
1,000 games per request with the counts already in it.

Measured 2026-07-27 on Counter-Strike 2:

| | Positive | Negative | Ratio |
|---|---|---|---|
| SteamSpy | 7,642,084 | 1,173,003 | 86.7% |
| Valve | 8,387,623 | 1,359,828 | 86.0% |

About 9% low on absolute counts, within 0.7 points on the ratio. So SteamSpy
pre-fills and Valve overrides, every summary is labelled with which one produced
it, and `authoritative: false` travels with the approximation.

```bash
bun run ingest steamspy --pages 3   # top 3,000 games by owners, 3 requests
```

**Off by default**, because SteamSpy is a third-party service and the client's
position is not to depend on ones we do not control. With it off, review counts
come from Valve's own endpoint at one request per game. `STEAMSPY_ENABLED=true`
trades that independence for roughly a thousandfold reduction in requests, at
about nine percent lower counts.

SteamSpy's `owners` estimate spans an order of magnitude ("100,000,000 ..
200,000,000") and is **not** surfaced as an install count anywhere in the
contract. It sits in `extra.steam.steamSpy`, labelled.

### `fieldCoverage`: why a null is null

The single most useful field in `_meta`. Every null in the core has a reason:

- `not_applicable` — the store has no such concept. An Android minimum version
  for a Steam game is not missing data, it is a category error.
- `not_available` — the concept exists in that store but the official API we use
  does not return it. These are the ones that *could* be filled later, at a cost
  worth weighing.

---

## What each source can and cannot fill

### Google Play — `google-play-scraper`

The object you specified **is** this library's output, so it is the source of
truth for this store and we did not write a competing HTML parser.

| Field | Status | Why |
|---|---|---|
| `editorsChoice` | `not_available` | In your example, no longer produced by the current library version. Google stopped exposing it in the page payload. |
| `features` | `not_available` | Same: the "Uses Google Play Games / Achievements" block. |
| `iosId` | filled when confident | See cross-store matching below. |

Everything else comes through as-is.

### App Store — official iTunes Search/Lookup API

Public, documented, not scraping.

| Field | Status | Why |
|---|---|---|
| `installs`, `minInstalls`, `maxInstalls` | `not_applicable` | Apple does not publish install counts anywhere. |
| `androidVersion`, `androidVersionText`, `androidMaxVersion` | `not_applicable` | Android concepts. |
| `isAvailableInPlayPass`, `preregister`, `earlyAccessEnabled`, `adSupported`, `features` | `not_applicable` | Google Play mechanics. |
| `histogram` | `not_available` | Only the average and the total count are exposed. |
| `summary` | `not_available` | The App Store subtitle is on the page, not in the API. |
| `developerEmail`, `developerAddress`, `developerLegal*`, `privacyPolicy` | `not_available` | On the page, not in the API. |
| `offersIAP`, `IAPRange` | `not_available` | Not in the API. |
| `video`, `videoImage`, `previewVideo`, `headerImage` | `not_available` | Not in the API. |
| `reviews` | `not_available` | Apple exposes a *rating* count, not a written-review count. Reusing one as the other would overstate it, so `ratings` is filled and `reviews` is not. |

Filling any `not_available` above means scraping Apple, which is exactly what
using the official API was meant to avoid. It is your call, not ours.

### Steam — public store endpoints

| Field | Status | Why |
|---|---|---|
| `histogram` | `not_available` | Steam publishes a positive/negative split, not a per-star breakdown. **Not simulated.** Two numbers cannot honestly become five. |
| `score`, `scoreText` | **derived** | `total_positive / total_reviews * 5`, recorded in `_meta.derivedFields`. Without it Steam titles could not be ordered next to the other two sources at all. The untouched numbers are in `extra.steam.reviewSummary`. |
| `offersIAP` | **derived** | Presence of Steam store category 35 (In-App Purchases). Also recorded. |
| `installs*`, `android*`, `version`, `developerId`, `editorsChoice`, `features` | `not_applicable` | No Steam equivalent. |
| `updated`, `recentChanges` | `not_available` | `appdetails` has no update timestamp; patch notes live in the news API. |
| `appId` | Steam appid | Steam has no Android package name, so `appId` carries the Steam appid. |

---

## Cross-store matching (`iosId`)

Google Play and the App Store share no identifier, so the link is inferred. The
governing rule is that **a wrong link is worse than no link**: it sends a user to
a different product and, unlike a null, it looks correct.

Order of attempts, cheapest and most certain first:

1. **Our own index**, no network call. An exact title plus developer match wins outright.
2. **Bundle id**, when the publisher reused the Android package name on iOS. Conclusive.
3. **Name plus developer** against Apple's search API.

A candidate is accepted only when confidence is at least 0.86, it leads the
runner-up by 0.08, and the developer names agree at 0.5 or better. That last
condition is what stops two unrelated "Solitaire" apps from linking to each other.

Anything short of that leaves `iosId` null and files the candidates in
`match_candidates` for review, so a later pass does not repeat the search. On the
sample run: 18 accepted, 52 held for review, 15 rejected.

---

## Freshness

| Data | TTL |
|---|---|
| Listing of an app that charts | 24 h |
| Listing in the long tail | 7 d |
| Rankings and charts | 6 h |
| Steam review summary | 12 h |
| Steam catalogue | 24 h |
| Categories | never (static file) |

Every response carries `_meta.ageSeconds`, and `/v1/top` additionally carries
`captured_at`, `age_seconds` and `stale` for the chart itself, separately from
the listings inside it.

---

## Measured rates

Measured from this machine on 2026-07-26, not copied from documentation. Re-run
before promising anything: `bun run ratecheck --source play --n 10`.

| Source | Pacing | Result | Sustained |
|---|---|---|---|
| Google Play | 2000-3000 ms, jittered | 8/8 ok | ~1600 listings/h |
| App Store | 3000-3500 ms | 10/10 ok | ~1225 listings/h *per single lookup* |
| Steam | 1500-2000 ms | 10/10 ok | ~2260 listings/h |

The App Store figure understates it badly: `lookup` accepts **200 ids per call**,
so a bulk refresh there costs a fraction of what Google Play costs. Google Play
is one request per app and there is no way around that.

Full pipeline run: 85 listings ingested across the three sources, zero failures,
zero circuit-breaker trips.

---

## Not getting blocked

Google Play is the only source that bans by IP, and the only one where scraping
is involved at all. The whole ingest is built so it does not happen, rather than
to react once it has.

- **Paced and serialised per source**, with randomised intervals. A fixed interval
  is itself a fingerprint.
- **Circuit breaker** per source: a block, a throttle or a malformed payload opens
  it with exponential backoff up to 30 minutes. While open, nothing is sent.
- **Block detection before parsing.** 403, 429, a consent wall, a captcha page, or
  a 200 whose body does not match the expected shape all become classified errors.
  A shape mismatch is `malformed`: the job is recorded and **nothing is written**.
  A silently empty field is worse than a loud failure, because it looks like real
  data forever.
- **`got` is muzzled.** The Play library uses `got`, which by default waits
  forever and retries every GET twice. Without overriding both, one stalled
  request hangs the worker indefinitely and the pacer counts one request while
  three leave the machine. Both are overridden.
- **Discovery and download are separate tables.** Discovery is cheap and safe,
  downloading is expensive and blockable. A burst of discoveries must never become
  a burst of requests.
- **`/v1/search` never touches Google Play.** A live query to Play on every user
  search would lose the IP on day one.

---

## Where the apps come from

Google Play cannot be enumerated. There is no "give me every app", so the
catalogue is grown, in this order of value per unit of risk:

1. **Rankings by category and country.** Three collections across 54 ingestable
   categories per market: thousands of apps, specifically the ones with traffic.
2. **Similarity and same-developer traversal.** Breadth-first from the seeds,
   depth-bounded, visited-checked. The corpus grows with no external input.
3. **Term search**, for the long tail that never charts.
4. **Steam** publishes its whole catalogue in one call, so there the problem is
   volume, not discovery: it is prioritised by the charts, not swallowed whole.
5. **Apple** publishes official charts per country, plus the search API.

Every discovered id lands in `discovery_queue` with its origin and priority,
deduplicated on insert. `promoteDiscoveries` is the rate valve between that table
and the paced fetch queue.

---

## Ingest CLI

```bash
bun run ingest seed        --source play,ios,steam --country us --lang en --categories 3 --num 50
bun run ingest promote     --source play --limit 200
bun run ingest drain       --limit 50
bun run ingest app         --source play --id com.google.android.apps.translate
bun run ingest renormalize --source play --limit 500
bun run ingest status
bun run ratecheck          --source play --n 10
```

`seed` discovers, `drain` downloads. They are separate commands for the same
reason they are separate tables.

`renormalize` rebuilds listings from stored raw payloads **without touching the
network**. Every source response is kept untouched in `raw_payloads` next to the
normalized row. The day a store changes a field, and it will, the fix is a code
change plus this command: an afternoon rather than a week of re-fetching, with a
fresh chance of being blocked.

The background worker is off by default (`INGEST_WORKER_ENABLED=false`). Starting
a process should never begin hitting the stores by surprise.

---

## Built for a content site

If these pages are going to be generated and indexed, five things follow.

**Permanent slugs.** Generated once from the first title seen, then frozen. An app
renamed in the store keeps its URL. Collisions resolve deterministically from the
native id, so the same app always produces the same slug. This happens for real:
WhatsApp exists on both stores, so the Play record became
`whatsapp-messenger-b9909d6` while the App Store one kept `whatsapp-messenger`.

**Bulk export with a real cursor.** `/v1/export/apps` uses keyset pagination over
`(last_changed_at, id)`. Offset pagination over tens of thousands of rows gets
slower every page and, worse, skips or duplicates rows when an ingest writes
mid-crawl.

**Incremental rebuilds.** `?since=` filters on `last_changed_at`, which moves only
when the content actually differs, not on `fetched_at`, which moves on every
refresh. Keying a build off the wrong one rebuilds every page every time.

```bash
# full build
curl -H "$AUTH" "$API/v1/export/apps?limit=500"          # follow next_cursor
# incremental
curl -H "$AUTH" "$API/v1/export/apps?since=2026-07-26T00:00:00Z&limit=500"
```

**Delisted apps are flagged, never deleted.** `_meta.status` and
`_meta.delistedAt`. A deleted row leaves an empty page behind with no way to know
why; a flagged one lets the front end redirect, annotate or retire it.

**Ranking order is stable.** `/v1/top` serves stored positions and never re-sorts.
Every list ends with a unique tie-break, so identical data produces an identical
page every time.

Coverage is prioritised over freshness throughout: full descriptions,
`descriptionHTML`, all screenshots and the histogram are kept, and the ingest
quality gate refuses to store a listing with no title, no id, or neither text nor
imagery. A catalogue of empty listings is worse than a smaller complete one.

---

## Operations

`GET /v1/status` answers, in one request: how much do we have, how old is the
oldest of it, what failed in the last 24 hours, and is the queue actually moving.

```json
{
  "healthy": true,
  "warnings": [],
  "totals": { "apps": 86, "listings": 86, "rankings": 6, "crossLinked": 18 },
  "sources": [{ "source": "play", "apps": 26, "oldestAgeSeconds": 1478,
                "staleListings": 0, "events24h": { "ok": 30 },
                "breaker": { "state": "ok" } }],
  "queue": { "ingest": { "done": 85 }, "discovery": { "pending": 183 },
             "stalledRunningJobs": 0, "movingLastHour": 90 }
}
```

`warnings` is populated automatically when: a breaker is open, malformed payloads
appeared (a format may have changed), failures outnumber successes, over half the
listings are past their TTL, jobs are pending but nothing has moved in an hour, or
jobs have been stuck in `running` for over 30 minutes.

That last pair matters most. An ingest that quietly stops is the most expensive
failure there is: nobody notices until the data is stale and the pages built from
it are wrong.

---

## Schema

| Table | Holds |
|---|---|
| `apps` | Identity per `(source, source_id)`: slug, type, status, cross-link |
| `app_locales` | The listing per `(app, country, lang)`: core, extra, coverage, search text |
| `ranking_snapshots` / `ranking_items` | Current chart per source, collection, category, market |
| `raw_payloads` | Untouched source responses |
| `discovery_queue` | Every id ever seen, with origin and priority |
| `ingest_jobs` | Paced work list with attempts and backoff |
| `match_candidates` | Cross-store candidates and their confidence |
| `ingest_events` | What happened, for `/v1/status` |
| `source_health` | Breaker state, so a restart does not forget |

The shape follows one decision: an app's **identity** and its **appearance in a
market** are different things. Title, description, price, install count and rank
all change with country and language, so they live in `app_locales`. Getting this
wrong is the mistake that cannot be fixed later without a migration and a broken
contract.

Search uses Postgres full text with the `simple` dictionary. A language
configuration would stem correctly for one market and incorrectly for the rest,
and the query language is unknown in advance.

---

## Legal

Store listing data is public and aggregating it is standard practice in this
sector. Of the three sources:

- **App Store** and **Steam** are read through public endpoints Apple and Valve
  publish for the purpose. No scraping.
- **Google Play** is real scraping and does sit against Google's terms of use.

The risk is therefore concentrated in one of three sources rather than spread
across all of them. Worth a decision, not a panic.

One honest caveat: Steam's `appdetails` is public and universally used but Valve
does not formally document it. Its shape is validated on every call for that
reason, so a change surfaces as a loud error rather than a table of nulls.

---

## Configuration

See `.env.example`. The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `API_BEARER_TOKEN` | — | Required. Without it every `/v1` route answers **503 `store_no_token_configured`**, not 401. "You are not authorized" and "this service is misconfigured" are different problems. |
| `AUTH_FALLBACK_HEADER` | `x-authorization` | Some proxies strip `Authorization`. |
| `RATE_PLAY_*` | 2000-3000 ms | Treat as a floor. |
| `LIVE_SEARCH_ENABLED` | `true` | App Store and Steam only. Never Play. |
| `LIVE_SEARCH_RATE_LIMIT_PER_MIN` | 20 | Per token, or per IP when there is none. |
| `INGEST_WORKER_ENABLED` | `false` | Off by default, deliberately. |

### Errors

Same shape as the coupons API, so your existing handling works unchanged:

```json
{"code":"store_unauthorized","message":"Unauthorized: Authorization: Bearer <token> is required.","data":{"status":401}}
```

`code`, `message`, `data.status` on every error. The prefix is `store_` rather
than `ce_`, which belongs to the coupon engine. Messages are in English; the
coupons plugin answers in Spanish only because WordPress translates it.
