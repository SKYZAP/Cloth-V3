# Regular expression reference

Syntax below follows JavaScript / PCRE conventions, which most languages share.

## Characters and classes

| Pattern | Matches |
|---|---|
| `.` | any character except a newline (all characters with the `s` flag) |
| `\d` `\D` | a digit / a non-digit |
| `\w` `\W` | a word character `[A-Za-z0-9_]` / anything else |
| `\s` `\S` | whitespace / non-whitespace |
| `[abc]` | one of a, b or c |
| `[^abc]` | any character except a, b or c |
| `[a-z0-9]` | a range |
| `\p{L}` | any Unicode letter (needs the `u` flag in JavaScript) |

Escape special characters with a backslash: `\.` `\*` `\(` `\[` `\\`.

## Anchors and boundaries

- `^` start of input (start of each line with the `m` flag)
- `$` end of input (end of each line with `m`)
- `\b` word boundary, `\B` not a boundary

## Quantifiers

| Pattern | Meaning |
|---|---|
| `*` | 0 or more |
| `+` | 1 or more |
| `?` | 0 or 1 |
| `{3}` | exactly 3 |
| `{2,5}` | 2 to 5 |
| `{2,}` | 2 or more |

Quantifiers are **greedy** by default. Add `?` to make them lazy: `<.+?>` matches a single HTML tag instead of everything up to the last `>`.

## Groups

- `(abc)` capturing group, referenced as `$1` in replacements or `\1` inside the pattern
- `(?<year>\d{4})` named group, referenced as `$<year>`
- `(?:abc)` non-capturing group
- `a|b` alternation

## Lookaround

- `(?=x)` followed by x
- `(?!x)` not followed by x
- `(?<=x)` preceded by x
- `(?<!x)` not preceded by x

Example — a number followed by "px", without capturing the unit: `\d+(?=px)`.

## Flags (JavaScript)

`g` global, `i` ignore case, `m` multiline anchors, `s` dot matches newlines, `u` Unicode, `y` sticky, `d` match indices.

## Common patterns

| Purpose | Pattern |
|---|---|
| ISO date | `^\d{4}-\d{2}-\d{2}$` |
| Semantic version | `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$` |
| Hex colour | `^#(?:[0-9a-fA-F]{3}){1,2}$` |
| UUID | `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| Trailing whitespace | `[ \t]+$` (with `m`) |
| Duplicate adjacent words | `\b(\w+)\s+\1\b` |
| snake_case to camelCase | replace `_(\w)` with an uppercase `$1` in a callback |

Validating email addresses with a regex is a trap; check for a single `@` and send a confirmation message instead.

## Performance

Nested quantifiers such as `(a+)+$` can backtrack catastrophically on inputs like `aaaaaaaaaaaaaaaaaaaaaaaa!`. Avoid overlapping alternatives, prefer specific classes over `.*`, and set time or length limits on user-supplied patterns.

## In code

```ts
const re = /(?<key>\w+)=(?<value>[^;]+)/g
for (const m of 'a=1; b=two'.matchAll(re)) console.log(m.groups!.key, m.groups!.value)

'2026-09-27'.replace(/(\d+)-(\d+)-(\d+)/, '$3/$2/$1') // "27/09/2026"
```

```python
import re
re.findall(r"\b\w+@\w+\.\w+\b", text)
re.sub(r"\s+", " ", text).strip()
```
