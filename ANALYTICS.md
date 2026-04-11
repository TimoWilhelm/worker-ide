# Analytics Engine Schema

This document describes all Cloudflare Workers Analytics Engine datasets.

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

## Important Notes

- Always use `SUM(_sample_interval)` instead of `COUNT(*)` for accurate counts under sampling
- Use `quantileExactWeighted()` for percentile calculations with sampling
- Data is retained for **3 months**
- Timestamps are UTC
- The `index1` column is used as the sampling key for fair per-entity sampling
