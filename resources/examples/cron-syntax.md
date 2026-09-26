# Cron syntax

Cloth schedules workflows with standard five-field cron expressions (an optional sixth leading field adds seconds).

```
┌──────── minute (0–59)
│ ┌────── hour (0–23)
│ │ ┌──── day of month (1–31)
│ │ │ ┌── month (1–12 or JAN–DEC)
│ │ │ │ ┌ day of week (0–7 or SUN–SAT; 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
```

## Operators

| Operator | Meaning | Example |
|---|---|---|
| `*` | every value | `* * * * *` every minute |
| `,` | list | `0 9,17 * * *` at 09:00 and 17:00 |
| `-` | range | `0 9 * * 1-5` 09:00 on weekdays |
| `/` | step | `*/15 * * * *` every 15 minutes |
| `L` | last | `0 18 L * *` 18:00 on the last day of the month |
| `#` | nth weekday | `0 10 * * 1#1` 10:00 on the first Monday |

## Common schedules

| Expression | Runs |
|---|---|
| `*/5 * * * *` | every 5 minutes |
| `0 * * * *` | at the top of every hour |
| `30 2 * * *` | daily at 02:30 |
| `0 9 * * 1-5` | weekdays at 09:00 |
| `0 0 * * 0` | Sundays at midnight |
| `0 8 1 * *` | 08:00 on the 1st of each month |
| `0 12 1 1,4,7,10 *` | noon on the first day of each quarter |
| `0 */6 * * *` | every 6 hours |

## Gotchas

- When both day-of-month and day-of-week are restricted, most implementations run when **either** matches: `0 9 13 * 5` runs on the 13th *and* on every Friday.
- Schedules use the machine's local time zone. Around daylight-saving changes a 02:30 job may be skipped or run twice; schedule critical jobs outside 01:00–03:00.
- Cloth only runs schedules while the app is open. A missed run is not replayed when the app starts again.
- Cloth prevents overlap: if a run is still going when the next one is due, the new run is skipped.
- `@daily`, `@hourly`, `@weekly` and `@monthly` nicknames are accepted.
