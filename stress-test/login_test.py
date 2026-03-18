"""
login_test.py — 98ent.com Authentication Stress Test (Login Only)
=================================================================

This script solely performs the LOGIN step for up to 1,000,000 demo users.
Ensure users are registered before running this (run register_test.py first)!
Designed for short, intense bursts: spawn 1 000 users at a time with a spawn rate
of 1 000/s to find the server's breaking point.

Burst Logging
─────────────
Every BATCH_SIZE logins a line is appended to burst_login.log, e.g.:
  [2026-03-16 13:05:01] Batch #3 | users 2001-3000 | ok=993 fail=7 | 18.2 req/s

Usage:
    # Web UI (set Users=1000, Spawn rate=1000 in the Locust UI)
    python -m locust -f stress-test/login_test.py --host https://new.98ent.com

    # Headless 1000-user burst, ramping at 1000/s
    python -m locust -f stress-test/login_test.py \\
        --headless --users 1000 --spawn-rate 1000 \\
        --run-time 2m --host https://new.98ent.com
"""

import csv
import os
import threading
import time
from datetime import datetime
from locust import HttpUser, task, between, events, LoadTestShape

# ── Configuration ─────────────────────────────────────────────────────────────

CSV_PATH   = os.path.join(os.path.dirname(__file__), "stress_test_users.csv")
LOG_PATH   = os.path.join(os.path.dirname(__file__), "burst_login.log")
LOGIN_PATH = "/ns9/api/auth/game-user/login"

# How many logins constitute one "burst batch" for logging purposes.
BATCH_SIZE = 100

MAX_REQUESTS = 10_000
_total_requests = 0

# Confirmed constants from DevTools capture
AGENT_MODE        = 1
CLIENT_TYPE       = 2
METHOD            = 1
PLATFORM          = 3
LOGIN_PAGE_URL    = "https://shop01.98ent.com/login"

BASE_HEADERS = {
    "Content-Type":    "application/json",
    "Accept":          "application/json",
    "Referer":         "https://shop01.98ent.com/",
    "Origin":          "https://shop01.98ent.com",
    "Accept-Language": "en-US,en;q=0.9",
}

# ── User Data Loader ─────────────────────────────────────────────────────────

_users: list[dict] = []
_user_lock  = threading.Lock()
_user_index = 0

def load_users() -> list[dict]:
    if not os.path.exists(CSV_PATH):
        raise FileNotFoundError(
            f"\n\n[ERROR] User CSV not found: {CSV_PATH}\n"
            f"  Generate it first:\n"
            f"    node stress-test/generate_users.js --count 1000000\n"
        )
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))

def next_user() -> dict:
    """Thread-safe sequential user assignment. Cycles when list is exhausted."""
    global _user_index
    with _user_lock:
        user = _users[_user_index % len(_users)]
        _user_index += 1
        return user

@events.init.add_listener
def on_locust_init(environment, **kwargs):
    global _users
    _users = load_users()
    total = len(_users)
    print(f"\n[OK] Loaded {total:,} users from {CSV_PATH}")
    print(f"     Scope: LOGIN ONLY")
    print(f"     Burst log → {LOG_PATH}")
    print(f"     Batch size: {BATCH_SIZE:,} logins per log entry\n")
    with open(LOG_PATH, "a", encoding="utf-8") as lf:
        lf.write(
            f"\n{'='*72}\n"
            f"  Session started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"  CSV: {CSV_PATH}  ({total:,} users)\n"
            f"{'='*72}\n"
        )

# ── Burst Logger ──────────────────────────────────────────────────────────────

_batch_lock       = threading.Lock()
_batch_number     = 0
_batch_ok         = 0
_batch_fail       = 0
_batch_start_time = time.time()
_batch_start_idx  = 1

def _record_request(outcome: str) -> None:
    """
    Call once per request with outcome = 'ok' | 'fail'.
    Flushes a log line every BATCH_SIZE requests.
    """
    global _batch_ok, _batch_fail
    global _batch_number, _batch_start_time, _batch_start_idx

    with _batch_lock:
        if outcome == "ok":
            _batch_ok += 1
        else:
            _batch_fail += 1

        total_in_batch = _batch_ok + _batch_fail

        if total_in_batch >= BATCH_SIZE:
            _batch_number += 1
            elapsed = time.time() - _batch_start_time
            rps     = BATCH_SIZE / elapsed if elapsed > 0 else 0
            end_idx = _batch_start_idx + total_in_batch - 1
            ts      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            line = (
                f"[{ts}] Batch #{_batch_number:>4} | "
                f"users {_batch_start_idx:>7}-{end_idx:>7} | "
                f"ok={_batch_ok:>5} fail={_batch_fail:>5} | "
                f"{rps:>7.1f} req/s | elapsed={elapsed:.1f}s\n"
            )
            print(f"  📊 {line.strip()}")

            with open(LOG_PATH, "a", encoding="utf-8") as lf:
                lf.write(line)

            _batch_start_idx  = end_idx + 1
            _batch_ok         = 0
            _batch_fail       = 0
            _batch_start_time = time.time()

# ── Payload Builders ─────────────────────────────────────────────────────────

def build_login_payload(user: dict) -> dict:
    """Exact payload structure from DevTools login capture."""
    return {
        "header": {
            "page_url": LOGIN_PAGE_URL,
            "version":  "v0.0.1",
        },
        "param": {
            "agent_mode":  AGENT_MODE,
            "client_type": CLIENT_TYPE,
            "method":      METHOD,
            "device_id":   int(user["device_id"]),
            "fingerprint": user["fingerprint"],
            "password":    user["password_hash"],    # SHA-256 hex
            "username":    user["username"],
            "platform":    PLATFORM,
            "udid":        user["udid"],
            "user_agent":  user["user_agent"].strip('"'),
            "page_url":    LOGIN_PAGE_URL,
            "email":       "",
            "mobile_cc":   "",
            "mobile_no":   "",
        },
    }

# ── Response Helper ───────────────────────────────────────────────────────────

def handle_response(resp, label: str) -> tuple[bool, str | None]:
    if resp.status_code == 429:
        resp.failure(f"[{label}] HTTP 429 — Rate Limited")
        _record_request("fail")
        return False, None

    if resp.status_code >= 500:
        resp.failure(f"[{label}] HTTP {resp.status_code} — Server Error")
        _record_request("fail")
        return False, None

    try:
        body = resp.json()
    except Exception:
        resp.failure(f"[{label}] Non-JSON response (HTTP {resp.status_code})")
        _record_request("fail")
        return False, None

    code = body.get("code", -1)
    msg  = body.get("msg", "")

    if code == 1:
        resp.success()
        token = body.get("info", {}).get("login", {}).get("token")
        _record_request("ok")
        return True, token

    resp.failure(f"[{label}] code={code} msg='{msg}' HTTP {resp.status_code}")
    _record_request("fail")
    return False, None

# ── Shutdown hook — flush any partial batch ────────────────────────────────────

@events.quitting.add_listener
def on_quit(environment, **kwargs):
    with _batch_lock:
        total_in_batch = _batch_ok + _batch_fail
        if total_in_batch == 0:
            return
        global _batch_number
        _batch_number += 1
        elapsed = time.time() - _batch_start_time
        rps     = total_in_batch / elapsed if elapsed > 0 else 0
        end_idx = _batch_start_idx + total_in_batch - 1
        ts      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = (
            f"[{ts}] Batch #{_batch_number:>4} (partial) | "
            f"users {_batch_start_idx:>7}-{end_idx:>7} | "
            f"ok={_batch_ok:>5} fail={_batch_fail:>5} | "
            f"{rps:>7.1f} req/s | elapsed={elapsed:.1f}s\n"
        )
        print(f"  📊 {line.strip()}")
        with open(LOG_PATH, "a", encoding="utf-8") as lf:
            lf.write(line)
            lf.write(f"  Session ended: {ts}\n{'='*72}\n")

# ── Main User Class ───────────────────────────────────────────────────────────

class LoginUser(HttpUser):
    # wait 1.5 - 2.0s to simulate realistic speed and hit ~10,000 requests in 30m with 10 users
    wait_time = between(1.5, 2.0)

    @task
    def login_only(self):
        global _total_requests
        with _batch_lock:
            if _total_requests >= MAX_REQUESTS:
                self.environment.runner.quit()
                return
            _total_requests += 1
            
        user_data = next_user()
        headers = {
            **BASE_HEADERS,
            "User-Agent": user_data["user_agent"].strip('"'),
        }

        login_payload = build_login_payload(user_data)
        with self.client.post(
            LOGIN_PATH,
            json=login_payload,
            headers=headers,
            catch_response=True,
            name="POST /login",
        ) as resp:
            handle_response(resp, "LOGIN")

# (Removed StepLoadShape to allow flat 10-user continuous running)
