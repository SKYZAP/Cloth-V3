# HTTP and REST API reference

## Methods

| Method | Purpose | Safe | Idempotent | Body |
|---|---|---|---|---|
| GET | Read a resource | yes | yes | no |
| HEAD | Like GET, headers only | yes | yes | no |
| POST | Create a resource or run an action | no | no | yes |
| PUT | Replace a resource entirely | no | yes | yes |
| PATCH | Partially update a resource | no | not guaranteed | yes |
| DELETE | Remove a resource | no | yes | optional |
| OPTIONS | Discover allowed methods (CORS preflight) | yes | yes | no |

*Safe* means the request does not change server state. *Idempotent* means repeating the request has the same effect as sending it once, which makes retries safe. To make POST retry-safe, accept an `Idempotency-Key` header and store the first response for each key.

## Status codes

### 2xx success
- **200 OK** — the response body contains the result.
- **201 Created** — a resource was created; include a `Location` header pointing at it.
- **202 Accepted** — work was queued and will finish later.
- **204 No Content** — success with no body (common for DELETE).

### 3xx redirection
- **301 Moved Permanently** / **308 Permanent Redirect** — use the new URL from now on (308 keeps the method and body).
- **302 Found** / **307 Temporary Redirect** — temporary move (307 keeps the method and body).
- **304 Not Modified** — the cached copy is still valid (after `If-None-Match` or `If-Modified-Since`).

### 4xx client errors
- **400 Bad Request** — malformed syntax.
- **401 Unauthorized** — missing or invalid credentials; send `WWW-Authenticate`.
- **403 Forbidden** — authenticated but not allowed.
- **404 Not Found** — no such resource.
- **405 Method Not Allowed** — include an `Allow` header.
- **409 Conflict** — the request conflicts with current state (for example, a duplicate or a version mismatch).
- **412 Precondition Failed** — an `If-Match` check failed.
- **415 Unsupported Media Type** — wrong `Content-Type`.
- **422 Unprocessable Content** — well-formed but fails validation.
- **429 Too Many Requests** — rate limited; send `Retry-After`.

### 5xx server errors
- **500 Internal Server Error** — unexpected failure.
- **502 Bad Gateway** — an upstream server returned an invalid response.
- **503 Service Unavailable** — overloaded or in maintenance; send `Retry-After`.
- **504 Gateway Timeout** — an upstream server did not answer in time.

## Useful headers

- `Content-Type: application/json` describes the body; `Accept` says what the client wants back.
- `Authorization: Bearer <token>` carries an access token.
- `ETag` plus `If-None-Match` enables cheap cache revalidation; `ETag` plus `If-Match` enables optimistic concurrency for updates.
- `Cache-Control: no-store` forbids caching; `max-age=60` allows it for 60 seconds.
- `Retry-After` tells clients how many seconds to wait.

## Resource design

- Use plural nouns: `/users`, `/users/42`, `/users/42/orders`.
- Filter, sort and paginate with query parameters: `/orders?status=open&sort=-created_at&limit=50`.
- Prefer **cursor pagination** (`?cursor=abc&limit=50`, returning `next_cursor`) over offsets for large or changing data sets.
- Version the API in the path (`/v1/...`) or with a header, and never break a published version.

## Error bodies

Return a consistent machine-readable error, for example the RFC 9457 *problem details* format:

```json
{
  "type": "https://example.com/errors/validation",
  "title": "Validation failed",
  "status": 422,
  "detail": "email must be a valid address",
  "errors": [{ "field": "email", "message": "invalid format" }]
}
```

## CORS in brief

Browsers send a preflight `OPTIONS` request for non-simple cross-origin calls. The server answers with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`. Credentials (cookies) require an explicit origin rather than `*`, plus `Access-Control-Allow-Credentials: true`.
