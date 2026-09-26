# SQL quick reference

Examples use SQLite / PostgreSQL syntax unless noted.

## Joins

| Join | Returns |
|---|---|
| `INNER JOIN` | rows with a match on both sides |
| `LEFT JOIN` | every left row, with NULLs where the right side has no match |
| `FULL OUTER JOIN` | every row from both sides |
| `CROSS JOIN` | every combination |

Find rows with **no** match (anti-join):

```sql
SELECT u.id FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.id IS NULL;
```

`NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)` does the same and handles NULLs more predictably than `NOT IN`.

## Aggregation

```sql
SELECT status, COUNT(*) AS n, AVG(total) AS avg_total
FROM orders
GROUP BY status
HAVING COUNT(*) > 10
ORDER BY n DESC;
```

`WHERE` filters rows before grouping; `HAVING` filters groups after.

## Common table expressions

```sql
WITH recent AS (
  SELECT * FROM orders WHERE created_at > date('now', '-30 days')
)
SELECT user_id, SUM(total) FROM recent GROUP BY user_id;
```

A recursive CTE walks a hierarchy:

```sql
WITH RECURSIVE tree(id, parent_id, depth) AS (
  SELECT id, parent_id, 0 FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, t.depth + 1 FROM categories c JOIN tree t ON c.parent_id = t.id
)
SELECT * FROM tree;
```

## Window functions

Window functions compute across related rows without collapsing them.

```sql
SELECT
  user_id,
  created_at,
  total,
  ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn,
  SUM(total)  OVER (PARTITION BY user_id ORDER BY created_at) AS running_total,
  LAG(total)  OVER (PARTITION BY user_id ORDER BY created_at) AS previous_total
FROM orders;
```

Latest order per user: wrap the query above and keep `rn = 1`.

## Upserts

```sql
INSERT INTO settings (key, value) VALUES ('theme', 'dark')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

## Indexes

- Index columns used in `WHERE`, `JOIN` and `ORDER BY`.
- A composite index `(a, b)` serves filters on `a` alone or on `a` and `b`, but not on `b` alone.
- A **covering** index contains every column the query reads, so the table is never touched.
- Check the plan with `EXPLAIN QUERY PLAN` (SQLite) or `EXPLAIN ANALYZE` (PostgreSQL).
- Every index slows writes; drop ones the planner never uses.

## SQLite full-text search (FTS5)

```sql
CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, tokenize = 'porter unicode61');
INSERT INTO docs_fts (title, body) VALUES ('Guards', 'A guard decides whether a request is handled');

SELECT title, bm25(docs_fts) AS score
FROM docs_fts
WHERE docs_fts MATCH 'guard OR request'
ORDER BY score;           -- lower bm25 = better match
```

- Quote terms to avoid syntax errors from user input: `"guard" OR "request"`.
- `bm25(docs_fts, 3.0, 1.0)` weights the title column three times higher.
- `snippet(docs_fts, 1, '[', ']', '…', 12)` returns a highlighted excerpt.

## Transactions

```sql
BEGIN;
UPDATE accounts SET balance = balance - 50 WHERE id = 1;
UPDATE accounts SET balance = balance + 50 WHERE id = 2;
COMMIT;   -- or ROLLBACK;
```

In SQLite, enable write-ahead logging (`PRAGMA journal_mode = WAL`) so readers are not blocked by a writer, and set `PRAGMA foreign_keys = ON` per connection to enforce foreign keys.
