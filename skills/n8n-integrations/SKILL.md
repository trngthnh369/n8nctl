---
name: n8n-integrations
description: Reference for n8n integration patterns with Meta/Facebook API, Google Sheets, social platforms, and AI services. Use when building workflows that connect to these services.
---

# n8n Integration Patterns

> **🎯 Node selection rule (MANDATORY):** For any REST/Graph API integration (Meta, Shopee, Lazada, OpenAI custom, internal APIs), **use `n8n-nodes-base.httpRequest` (typeVersion 4.2) by default**. Only use a specialized native node (googleSheets, gmail, slack, telegram) when the service needs OAuth2 UI flow or the native node adds non-trivial functionality (batch upload, auto-pagination, file streaming). Never reach for community/custom nodes first.

Quick reference for commonly used integrations in n8n workflows.

---

## Meta / Facebook API

### Graph API (Page Posts)

```
GET /{page-id}/feed?fields=id,message,created_time,full_picture,permalink_url,
    shares,likes.summary(true),comments.summary(true),attachments
    &access_token={token}&limit=25
```

**Version**: v19.0 (`https://graph.facebook.com/v19.0/`)

**Node config** (HTTP Request):
```json
{
  "method": "GET",
  "url": "=https://graph.facebook.com/v19.0/{{ $json.page_id }}/feed",
  "qs": {
    "fields": "id,message,created_time,full_picture,permalink_url,shares,likes.summary(true),comments.summary(true),attachments",
    "access_token": "={{ $json.access_token }}",
    "limit": 25
  },
  "options": { "fullResponse": false, "neverError": true }
}
```

**Pagination**: Response có `paging.next` URL → loop until empty.

**Post type detection** (Code node):
```javascript
const items = $input.all();
return items.map(item => {
  const attachments = item.json.attachments?.data?.[0];
  const type = attachments?.type || 'status';
  let mediaType = 'text';
  if (type === 'photo' || type === 'cover_photo') mediaType = 'photo';
  else if (type === 'video_inline' || type === 'video') mediaType = 'video';
  else if (type === 'share') mediaType = 'link';
  return { json: { ...item.json, media_type: mediaType } };
});
```

### Meta Ads API (Campaign Management)

**Hierarchy**: Campaign → Ad Set → Ad

```
# Create Campaign
POST /act_{ad_account_id}/campaigns
Body: { name, objective, status, special_ad_categories }

# Create Ad Set
POST /act_{ad_account_id}/adsets
Body: { name, campaign_id, billing_event, optimization_goal,
        bid_amount, daily_budget, targeting, start_time }

# Create Ad
POST /act_{ad_account_id}/ads
Body: { name, adset_id, creative: { creative_id }, status }
```

**Cascade Pause Pattern**: When budget limit reached:
1. List active campaigns → 2. Pause each → 3. Log to Sheets

---

## Google Sheets

### Node Configuration

```json
{
  "operation": "append",
  "documentId": { "value": "SPREADSHEET_ID" },
  "sheetName": { "value": "Sheet1" },
  "columns": {
    "mappingMode": "defineBelow",
    "value": {
      "timestamp": "={{ DateTime.now().setZone('Asia/Ho_Chi_Minh').toISO() }}",
      "status": "={{ $json.status }}",
      "data": "={{ JSON.stringify($json.result) }}"
    }
  },
  "options": {
    "useAppend": true
  }
}
```

**Authentication**: Service Account (recommended)
- Credential type: `googleSheetsOAuth2Api` or `googleApi` (service account)
- Share spreadsheet with service account email

**Retry Config** (critical for rate limits):
```json
{
  "retryOnFail": true,
  "maxTries": 3,
  "waitBetweenTries": 5000
}
```

### Common Operations

| Operation | Use case |
|-----------|---------|
| `append` | Audit logging, data collection |
| `read` | Load config, read data |
| `update` | Update status columns |
| `clear` | Reset sheet before re-import |

### GID Pattern (Sheet Tab Reference)
- URL: `https://docs.google.com/spreadsheets/d/{ID}/edit#gid={GID}`
- API uses sheet name (not GID): `"sheetName": "Data"`

---

## Social Platforms

### TikTok Research API

```
POST https://open.tiktokapis.com/v2/research/video/query/
Headers: { Authorization: "Bearer {token}" }
Body: {
  "query": { "and": [{ "field_name": "keyword", "field_values": ["search term"] }] },
  "start_date": "20260101",
  "end_date": "20260408",
  "max_count": 100,
  "search_id": ""  // for pagination
}
```

### Instagram (via Facebook Graph API)

```
# Hashtag Search
GET /ig_hashtag_search?user_id={user_id}&q={hashtag}

# Hashtag Recent Media
GET /{hashtag_id}/recent_media?user_id={user_id}&fields=id,caption,timestamp,like_count,comments_count,permalink
```

### LinkedIn (via Apify)

```
# Use Apify LinkedIn Scraper
POST https://api.apify.com/v2/acts/johnvc~linkedin-post-search-api/runs
Body: { "keywords": ["keyword"], "maxPostsPerKeyword": 50 }
# Rows: postId, postUrl, text, authorName, datePosted, numLikes, numComments
```

### Threads API

```
GET https://graph.threads.net/v1.0/{user_id}/threads
    ?fields=id,text,timestamp,likes,replies
    &access_token={token}
```

---

## AI Services (Claude API)

### n8n HTTP Request to Claude

```json
{
  "method": "POST",
  "url": "https://api.anthropic.com/v1/messages",
  "headers": {
    "x-api-key": "={{ $env.ANTHROPIC_API_KEY }}",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  "body": {
    "model": "claude-sonnet-4-6-20250514",
    "max_tokens": 4096,
    "messages": [
      { "role": "user", "content": "={{ $json.prompt }}" }
    ]
  },
  "options": { "neverError": true }
}
```

### Response Parsing (Code node)

```javascript
const response = $input.first().json;
const content = response.content?.[0]?.text || '';

// If expecting JSON
try {
  const parsed = JSON.parse(content);
  return [{ json: parsed }];
} catch {
  return [{ json: { raw: content, parse_error: true } }];
}
```

---

## Data Normalization Standard

All social data → platform-agnostic schema:

```javascript
function normalize(platform, raw) {
  return {
    platform,                           // "facebook"|"instagram"|"tiktok"|"linkedin"|"threads"
    raw_id: raw.id,
    dedup_key: `${platform}::${raw.id}`,
    text: raw.message || raw.caption || raw.text || '',
    author: raw.from?.name || raw.author || '',
    timestamp: DateTime.fromISO(raw.created_time || raw.timestamp)
                .setZone('Asia/Ho_Chi_Minh').toISO(),
    url: raw.permalink_url || raw.permalink || '',
    likes: raw.likes?.summary?.total_count || raw.like_count || raw.likes || 0,
    comments: raw.comments?.summary?.total_count || raw.comments_count || raw.replies || 0,
    shares: raw.shares?.count || 0,
    engagement_score: (raw.likes || 0) + (raw.comments || 0) * 2 + (raw.shares || 0) * 3
  };
}
```

---

## Error Handling Patterns

### HTTP Node — Always use neverError

```json
{
  "options": {
    "fullResponse": true,
    "neverError": true,
    "redirect": { "followRedirects": true }
  }
}
```

Then in next Code node:
```javascript
const resp = $input.first().json;
if (resp.statusCode >= 400) {
  return [{ json: { error: true, status: resp.statusCode, body: resp.body } }];
}
return [{ json: resp.body }];
```

### Google Sheets — Retry on rate limit

Node settings:
```json
{ "retryOnFail": true, "maxTries": 3, "waitBetweenTries": 5000 }
```

### Sub-workflow — Continue on error

Execute Workflow node:
```json
{ "onError": "continueErrorOutput" }
```
Then handle error output branch separately.
