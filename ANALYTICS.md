# Analytics Engine Schema

This document describes all Cloudflare Workers Analytics Engine datasets used by `worker-ide` and how to query them from Grafana or the admin panel.

## Overview

| Dataset               | Purpose                           | Sampling Key (index) |
| --------------------- | --------------------------------- | -------------------- |
| `worker_ide_api`      | HTTP API request metrics          | User ID              |
| `worker_ide_projects` | Project lifecycle events          | Organization ID      |
| `worker_ide_ai`       | AI agent session/turn tracking    | User ID              |
| `worker_ide_preview`  | Preview subdomain request metrics | Project ID           |
| `worker_ide_auth`     | Authentication & user events      | User ID              |
| `worker_ide_ws`       | WebSocket connection metrics      | Project ID           |
| `worker_ide_stt`      | Speech-to-text session tracking   | User ID              |

---

## Dataset Schemas

### `worker_ide_api` — API Request Metrics

| Column  | AE Field     | Type   | Description                                  |
| ------- | ------------ | ------ | -------------------------------------------- |
| index1  | `indexes[0]` | string | User ID (sampling key)                       |
| blob1   | `blobs[0]`   | string | Route pattern (e.g. `POST /api/new-project`) |
| blob2   | `blobs[1]`   | string | Project ID (empty for root routes)           |
| blob3   | `blobs[2]`   | string | Organization ID                              |
| blob4   | `blobs[3]`   | string | HTTP method                                  |
| blob5   | `blobs[4]`   | string | Colo (`request.cf.colo`)                     |
| blob6   | `blobs[5]`   | string | Country (`request.cf.country`)               |
| blob7   | `blobs[6]`   | string | Error message (empty on success)             |
| blob8   | `blobs[7]`   | string | Worker version tag                           |
| blob9   | `blobs[8]`   | string | Organization plan                            |
| double1 | `doubles[0]` | number | Response time (ms)                           |
| double2 | `doubles[1]` | number | HTTP status code                             |

### `worker_ide_projects` — Project Lifecycle Events

| Column  | AE Field     | Type   | Description                                                              |
| ------- | ------------ | ------ | ------------------------------------------------------------------------ |
| index1  | `indexes[0]` | string | Organization ID (sampling key)                                           |
| blob1   | `blobs[0]`   | string | Event type: `create`, `clone`, `delete`, `restore`, `deploy`, `download` |
| blob2   | `blobs[1]`   | string | Project ID                                                               |
| blob3   | `blobs[2]`   | string | User ID                                                                  |
| blob4   | `blobs[3]`   | string | Detail (template/source project/worker name)                             |
| blob5   | `blobs[4]`   | string | Plan                                                                     |
| blob6   | `blobs[5]`   | string | Error message                                                            |
| blob7   | `blobs[6]`   | string | Colo                                                                     |
| double1 | `doubles[0]` | number | Duration (ms)                                                            |
| double2 | `doubles[1]` | number | Success (1) or failure (0)                                               |

### `worker_ide_ai` — AI Agent Usage

| Column  | AE Field     | Type   | Description                                                 |
| ------- | ------------ | ------ | ----------------------------------------------------------- |
| index1  | `indexes[0]` | string | User ID (sampling key)                                      |
| blob1   | `blobs[0]`   | string | Event type: `session_start`, `session_end`, `turn_complete` |
| blob2   | `blobs[1]`   | string | Project ID                                                  |
| blob3   | `blobs[2]`   | string | Organization ID                                             |
| blob4   | `blobs[3]`   | string | Model ID (e.g. `@cf/google/gemma-4-26b-a4b-it`)             |
| blob5   | `blobs[4]`   | string | Session ID                                                  |
| blob6   | `blobs[5]`   | string | Agent mode (`code`, `plan`, `ask`)                          |
| blob7   | `blobs[6]`   | string | Error message                                               |
| blob8   | `blobs[7]`   | string | Plan                                                        |
| double1 | `doubles[0]` | number | Input tokens                                                |
| double2 | `doubles[1]` | number | Output tokens                                               |
| double3 | `doubles[2]` | number | Duration (ms)                                               |
| double4 | `doubles[3]` | number | Tool call count                                             |
| double5 | `doubles[4]` | number | Turn number                                                 |

### `worker_ide_preview` — Preview Request Metrics

| Column  | AE Field     | Type   | Description                             |
| ------- | ------------ | ------ | --------------------------------------- |
| index1  | `indexes[0]` | string | Project ID (sampling key)               |
| blob1   | `blobs[0]`   | string | Request pathname                        |
| blob2   | `blobs[1]`   | string | Colo                                    |
| blob3   | `blobs[2]`   | string | Country                                 |
| blob4   | `blobs[3]`   | string | Error message                           |
| blob5   | `blobs[4]`   | string | Content type                            |
| blob6   | `blobs[5]`   | string | Preview visibility (`public`/`private`) |
| double1 | `doubles[0]` | number | Response time (ms)                      |
| double2 | `doubles[1]` | number | HTTP status code                        |
| double3 | `doubles[2]` | number | Response body size (bytes)              |

### `worker_ide_auth` — Authentication & User Events

| Column  | AE Field     | Type   | Description                                                                                                 |
| ------- | ------------ | ------ | ----------------------------------------------------------------------------------------------------------- |
| index1  | `indexes[0]` | string | User ID (sampling key)                                                                                      |
| blob1   | `blobs[0]`   | string | Event type: `signup`, `login`, `org_create`, `org_invite`, `org_join`, `project_transfer`, `account_delete` |
| blob2   | `blobs[1]`   | string | Organization ID                                                                                             |
| blob3   | `blobs[2]`   | string | Auth provider (`github`, `google`, `email`)                                                                 |
| blob4   | `blobs[3]`   | string | Plan                                                                                                        |
| blob5   | `blobs[4]`   | string | Colo                                                                                                        |
| blob6   | `blobs[5]`   | string | Country                                                                                                     |
| double1 | `doubles[0]` | number | 1 (count)                                                                                                   |

### `worker_ide_ws` — WebSocket Connection Metrics

| Column  | AE Field     | Type   | Description                             |
| ------- | ------------ | ------ | --------------------------------------- |
| index1  | `indexes[0]` | string | Project ID (sampling key)               |
| blob1   | `blobs[0]`   | string | Event type: `connect`, `disconnect`     |
| blob2   | `blobs[1]`   | string | Connection type: `coordinator`, `agent` |
| blob3   | `blobs[2]`   | string | User ID                                 |
| double1 | `doubles[0]` | number | Concurrent connections at event time    |
| double2 | `doubles[1]` | number | Duration (ms, disconnect only)          |

### `worker_ide_stt` — Speech-to-Text Usage

| Column  | AE Field     | Type   | Description                                |
| ------- | ------------ | ------ | ------------------------------------------ |
| index1  | `indexes[0]` | string | User ID (sampling key)                     |
| blob1   | `blobs[0]`   | string | Event type: `session_start`, `session_end` |
| blob2   | `blobs[1]`   | string | Project ID                                 |
| blob3   | `blobs[2]`   | string | Error message                              |
| blob4   | `blobs[3]`   | string | Colo                                       |
| blob5   | `blobs[4]`   | string | Country                                    |
| double1 | `doubles[0]` | number | Duration (ms)                              |

---

## Example Queries

### Request volume by route (last 24h)

```sql
SELECT blob1 AS route, SUM(_sample_interval) AS count
FROM worker_ide_api
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY route
ORDER BY count DESC
LIMIT 20
```

### P95 latency per route

```sql
SELECT blob1 AS route,
       quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms
FROM worker_ide_api
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY route
ORDER BY p95_ms DESC
```

### API error rate over time

```sql
SELECT toStartOfHour(timestamp) AS ts,
       SUM(IF(double2 >= 400, _sample_interval, 0)) / SUM(_sample_interval) * 100 AS error_rate
FROM worker_ide_api
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY ts
ORDER BY ts
```

### AI sessions per model per day

```sql
SELECT toDate(timestamp) AS day, blob4 AS model, SUM(_sample_interval) AS sessions
FROM worker_ide_ai
WHERE blob1 = 'session_start' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, model
ORDER BY day
```

### Project creation rate

```sql
SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS projects_created
FROM worker_ide_projects
WHERE blob1 = 'create' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

### Concurrent WebSocket connections over time

```sql
SELECT toStartOfHour(timestamp) AS ts, blob2 AS type,
       SUM(_sample_interval) AS connections
FROM worker_ide_ws
WHERE blob1 = 'connect' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY ts, type
ORDER BY ts
```

### Speech-to-text sessions per day

```sql
SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS stt_sessions
FROM worker_ide_stt
WHERE blob1 = 'session_start' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day
```

---

## Grafana Setup

1. Install the [Altinity ClickHouse plugin](https://grafana.com/grafana/plugins/vertamedia-clickhouse-datasource/)
2. Configure the datasource:
   - **URL**: `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql`
   - **Auth**: Add custom header `Authorization: Bearer <ANALYTICS_TOKEN>`
   - Leave all other auth settings off
3. Create panels using the SQL queries above

### Important Notes

- Always use `SUM(_sample_interval)` instead of `COUNT(*)` for accurate counts under sampling
- Use `quantileExactWeighted()` for percentile calculations with sampling
- Data is retained for **3 months**
- Timestamps are UTC
- The `index1` column is used as the sampling key for fair per-entity sampling

---

## Admin Panel

The admin panel includes an in-app analytics dashboard at `/analytics` with real-time charts for:

- API request volume and error rates
- AI session counts and model distribution
- Project lifecycle events
- WebSocket connection metrics
- Preview request traffic
- Speech-to-text usage

Charts auto-refresh every 60 seconds and support 1h/24h/7d/30d time ranges.
