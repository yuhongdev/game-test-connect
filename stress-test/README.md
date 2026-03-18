# s9.com Authentication — Stress Test Suite

> **Scope:** Register and Login endpoints on `https://new.98ent.com`
> **Tool:** [Locust](https://locust.io) — open-source Python load testing framework
> **Max scale:** 1,000,000 demo users · 1,000 users/burst · 1,000/s spawn rate

---

## Folder Structure

```
stress-test/
├── generate_users.js       # Step 1 — generates the user CSV (Node.js)
├── register_test.py        # Step 2a — Register-only Locust test
├── login_test.py           # Step 2b — Login-only Locust test
├── stress_test_users.csv   # Auto-generated — up to 1,000,000 test users
├── burst_register.log      # Auto-created — per-batch register results log
├── burst_login.log         # Auto-created — per-batch login results log
├── results/                # CSV output from each test run (--csv flag)
└── README.md               # This file
```

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | any LTS | `node --version` |
| Python | 3.12+ | `python --version` |
| Locust | latest | `python -m locust --version` |

**Install Locust (once):**
```powershell
python -m pip install locust
```

---

## Quick Start — 1,000,000 User Burst Test

### Step 1 — Generate Users

```powershell
# Default: 1,000 users
node stress-test/generate_users.js

# For the full 1M burst test:
node stress-test/generate_users.js --count 1000000

# Custom count + output path:
node stress-test/generate_users.js --count 50000 --output stress-test/stress_test_users.csv
```

> ⚡ **1M rows takes ~10–20 seconds** and produces ~200 MB. Progress is printed every 100,000 rows.
>
> Re-run any time you want fresh usernames. If a username already exists in the DB, `/register`
> returns `code=91` — this is automatically treated as a **soft pass** (not a failure).

---

### Step 2 — Run the Burst Stress Test

Open the Locust Web UI at **http://localhost:8089** after starting, then set:

| Setting | Value |
|---|---|
| Users/Spawn Rate | *(Hidden — the script auto-manages the "stairs" shape)* |
| Host | `https://new.98ent.com` |

#### Register Burst
```powershell
python -m locust -f stress-test/register_test.py --host https://new.98ent.com
```

#### Login Burst
> **⚠️ Run register first** so accounts exist in the DB before login testing.
```powershell
python -m locust -f stress-test/login_test.py --host https://new.98ent.com
```

#### Headless (no browser UI, CI-friendly)
```powershell
# 1000 concurrent users, spawned all at once, run for 5 minutes
python -m locust -f stress-test/register_test.py `
  --headless --users 1000 --spawn-rate 1000 --run-time 5m `
  --host https://new.98ent.com `
  --csv stress-test/results/burst_register
```

### Step 3 — How to configure for a Flat 1-Million Requests (Auto-Stop)

If you want the test to blast at top speed and **automatically stop** after exactly 1,000,000 requests (instead of stair-stepping indefinitely), apply these code changes to the script (`register_test.py` or `login_test.py`):

1. **Remove `StepLoadShape`** class from the bottom of the script (if it exists).
2. **Add a `MAX_REQUESTS` threshold** near the top of the file:
   ```python
   MAX_REQUESTS = 1_000_000
   _total_requests = 0
   ```
3. **Add the auto-quit logic** directly inside the `@task` function:
   ```python
       @task
       def user_action(self):
           global _total_requests
           with _batch_lock:
               if _total_requests >= MAX_REQUESTS:
                   self.environment.runner.quit()
                   return
               _total_requests += 1
           # ... proceed to send request ...
   ```
4. **Tune the `wait_time`** to be as aggressive as possible to hit the millions fast (e.g., `between(0.1, 0.5)`).
5. **Run the test** via terminal specifying the flat `1000` workers you want running constantly:
   ```powershell
   locust -f stress-test/register_test.py --users 1000 --spawn-rate 1000 --host https://new.98ent.com
   ```

---

## Burst Logging

Every **1,000 requests** completed, a timestamped line is appended to the log file.
This lets you pinpoint **exactly when and why** the server started failing.

### Log files
| Test | Log file |
|---|---|
| Register | `stress-test/burst_register.log` |
| Login | `stress-test/burst_login.log` |

### Log format (register)
```
========================================================================
  Session started: 2026-03-16 13:05:00
  CSV: stress-test/stress_test_users.csv  (1,000,000 users)
========================================================================
[2026-03-16 13:05:12] Batch #   1 | users       1-   1000 | ok=  981 dup=   14 fail=    5 |   83.2 req/s | elapsed=12.0s
[2026-03-16 13:05:25] Batch #   2 | users    1001-   2000 | ok=  972 dup=    0 fail=   28 |   76.9 req/s | elapsed=13.0s
[2026-03-16 13:05:25] Batch #   3 (partial) | users 2001-2347 | ok=  290 fail=  57 |   42.1 req/s | elapsed=8.2s
  Session ended: 2026-03-16 13:05:33
========================================================================
```

### Diagnosing a server crash from the log
1. Find the batch where `fail` count **spikes** — that's the breaking point.
2. The **timestamp** on that line is when the server started struggling.
3. Cross-reference with server-side logs/monitoring at that timestamp.
4. `(partial)` line = the test was stopped before a full batch of 1,000 finished.

---

## Ramp-Up Strategy (4 Phases to Find the Breaking Point)

Run phases in order. Stop and note the user count when the server breaks.

### Phase 1 — Baseline (5 min, 5 users)
```powershell
python -m locust -f stress-test/register_test.py --headless --users 5 --spawn-rate 1 --run-time 5m --host https://new.98ent.com --csv stress-test/results/phase1_baseline
```
**Pass criteria:** 0% errors, P99 < 500 ms

### Phase 2 — Ramp-Up (30 min, up to 100 users)
```powershell
python -m locust -f stress-test/register_test.py --headless --users 100 --spawn-rate 5 --run-time 30m --host https://new.98ent.com --csv stress-test/results/phase2_rampup
```
**Watch for:** Error rate > 1% or P95 > 1,000 ms → that user count = **degradation point**

### Phase 3 — Soak (10 min at 80% of degradation point)
```powershell
# Replace --users with 80% of the degradation-point count found in Phase 2
python -m locust -f stress-test/register_test.py --headless --users 60 --spawn-rate 60 --run-time 10m --host https://new.98ent.com --csv stress-test/results/phase3_soak
```
**Watch for:** P99 drift > ±20%, memory leak signs

### Phase 4 — Spike (2 min burst at max intensity)
```powershell
python -m locust -f stress-test/register_test.py --headless --users 1000 --spawn-rate 1000 --run-time 2m --host https://new.98ent.com --csv stress-test/results/phase4_spike
```
**Watch for:** Does the system recover within 60 seconds after the spike?

---

## Reading Results

### Locust Web UI Columns
| Column | Healthy | Stop test if |
|---|---|---|
| `Failures` | 0% | > 1% |
| `P95 (ms)` | < 1,000 ms | > 1,000 ms |
| `P99 (ms)` | < 2,000 ms | > 2,000 ms |
| `req/s` | Stable or rising | Sudden drop |

### `--csv` Output Files (in `results/`)
Locust creates two files per run:
- `<name>_stats.csv` — per-endpoint summary (P50, P95, P99, RPS, failures)
- `<name>_failures.csv` — full list of each unique failure with count

Open in Excel or any CSV viewer.

---

## Developer Guide — Testing a New API Endpoint

Follow these steps when you want to stress-test a different endpoint.

### Step 1 — Capture the Real Request

1. Open the target page in Chrome → **DevTools → Network** → filter `Fetch/XHR`
2. Trigger the action (e.g. click Submit)
3. Click the matching request → **Copy as cURL** or inspect:
   - Request URL (path only, e.g. `/ns9/api/something/do`)
   - Request Method (`POST`, `GET`, etc.)
   - Request Headers (especially `Content-Type`, `Authorization`, `Referer`, `Origin`)
   - Request Body (JSON payload)
   - Response codes for success (`code=1`) and expected soft failures (e.g. `code=91`)

> **⚠️ CAUTION: The s9.com API validates device fingerprints.**
> Do **not** generate random `device_id`, `fingerprint`, or `udid` — the server rejects them with `code=33 "bad device id"`.
> Always reuse the **known-working values** already in `generate_users.js`:
> ```javascript
> const KNOWN_DEVICE_ID   = 1615238534;
> const KNOWN_FINGERPRINT = '9A4lq0m2JTwBOjqyu75K';
> const KNOWN_UDID        = '1fb8db40cffb8f82535ab3685535e5065dfa7676825d72bf9bc50f66ea75928e';
> ```

### Step 2 — Create a New Test Script

Copy `login_test.py` as your starting point (it's the cleanest template). Rename it, e.g. `deposit_test.py`.

**Minimum changes required:**
```python
# 1. Update the endpoint path
DEPOSIT_PATH = "/ns9/api/payment/deposit"

# 2. Update the payload builder
def build_deposit_payload(user: dict) -> dict:
    return {
        "header": { ... },
        "param": {
            "username": user["username"],
            # ... your fields here
        },
    }

# 3. Update the task
class DepositUser(HttpUser):
    @task
    def deposit(self):
        user_data = next_user()
        with self.client.post(DEPOSIT_PATH, json=build_deposit_payload(user_data), ...) as resp:
            handle_response(resp, "DEPOSIT")
```

**The burst logger, user loader, and CSV machinery are already wired in — no changes needed there.**

### Step 3 — Handle Response Codes

Update `handle_response` for any endpoint-specific soft failures:
```python
# Example: treat code=402 ("already deposited today") as a soft pass
if code == 402:
    resp.success()
    _record_request("dup")   # reuse 'dup' bucket for soft passes
    return True, None
```

### Step 4 — Test Configuration Checklist

Before running:
- [ ] Does this endpoint require a **Bearer token**? If yes, you need login first → add a `token` field to your user, set `Authorization: Bearer <token>` in headers.
- [ ] Does this endpoint use a **different host**? Update `--host` in the command.
- [ ] Are there **rate limits per user**? If yes, increase `wait_time` (e.g. `between(5, 10)`).
- [ ] Does the endpoint **mutate data** (e.g. create orders, transfer funds)? Add a cleanup step or use a dedicated test environment.
- [ ] Update `LOG_PATH` to a new filename (e.g. `burst_deposit.log`) so logs don't mix.

### Step 5 — Run and Monitor
```powershell
python -m locust -f stress-test/deposit_test.py --host https://new.98ent.com
```

---

## Technical Notes

### API Endpoints (current tests)

| | Register | Login |
|---|---|---|
| **Endpoint** | `POST /ns9/api/register/game-user/do` | `POST /ns9/api/auth/game-user/login` |
| **page_url** | `https://shop01.98ent.com/login?isLogin=false` | `https://shop01.98ent.com/login` |
| **Password** | SHA-256 hash of plaintext | SHA-256 hash of plaintext |
| **device_id** | `1615238534` (server-validated) | `1615238534` |
| **Token out** | `info.login.token` | `info.login.token` |
| **Soft-pass code** | `91` (username taken) | *(none)* |

### Password Hashing
The s9.com frontend **never** sends the plaintext password. It sends a SHA-256 hex hash:
```
TestPass123!  →  sha256  →  724936cd9b665b34b178904d938970b9fffede7f6f...
```
This is pre-computed in `generate_users.js` and stored in the CSV column `password_hash`.

### Username Format
Users are named `st0000001` through `st1000000` (7-digit padding for 1M scale).
This is because the server's `username` validation tag strictly caps lengths at 16 chars max, so the 9-character format keeps us well within limits.
The CSV index column (`1`, `2`, `3`, …) is for human reference only — not sent to the API.

### Why `device_id` / `fingerprint` / `udid` Are Fixed
The s9.com client SDK computes these from the real browser environment (canvas, WebGL, fonts, etc.).
The server validates them as a **coherent set**. Random values always return `code=33`.
For load testing purposes, sharing the same known-good fingerprint across all virtual users is valid —
it models many real users on the same browser type.

### CSV Memory Note for 1M Users
Loading the full 1M-row CSV into Python RAM uses ~500 MB. If memory is constrained:
- Use a smaller slice: `node stress-test/generate_users.js --count 100000`
- Or implement streaming CSV reading (replace `list(csv.DictReader(f))` with an iterator + ring buffer)

---

## Configuration Reference

### `generate_users.js`
```javascript
const DEFAULT_COUNT    = 1000;           // Users generated if --count not given
const PLAIN_PASSWORD   = 'TestPass123!'; // Plaintext password for all test users
```

### `register_test.py` / `login_test.py`
```python
BATCH_SIZE = 1_000   # Requests per burst log line

# ── Load Profile (Step Up) ──────────────────────────────────────────────────
STEP_USERS = 1_000      # How many concurrent users to add per step
STEP_TIME  = 60         # How long to run each step (in seconds)
SPAWN_RATE = 100        # How fast to add users during the ramp-up phase (users/sec)
MAX_USERS  = 1_000_000  # Global limit for the entire test

class RegisterUser(HttpUser):
    wait_time = between(1, 3)      # Seconds between tasks per virtual user
                                   # Increase to reduce WAF/403 pressure
```
