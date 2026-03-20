# 🧪 Automation Test Cases — s9.com / shop01.98ent.com

| Domain | Test Account | Notes |
|---|---|---|
| `https://s9.com` | `yoongtest05` / `Yoong01!` | **Main domain** — Deposit & Withdrawal fully live |
| `https://shop01.98ent.com` | `yoongfriend2` / `Yoong01!` | Staging/test — Deposit not yet available |

**Generated:** 2026-03-20  
**Framework:** Playwright + TypeScript (Page Object Model)

> ⚠️ **Automation Challenge — Randomized Fund Password Keyboard**  
> The fund password input uses a **randomized on-screen numeric keypad** (digits shuffled each time).  
> Standard `fill()` / `type()` will NOT work. You must locate buttons by their **text label** at runtime.

---

## 📐 Site Navigation Structure

```
Bottom Navigation Bar (always visible post-login):
  ├── Home           → /
  ├── Deposit        → /personal/recharge
  ├── Promotions     → /promotion
  ├── Referral       → /agency
  └── Profile        → /personal

Hamburger Sidebar Menu (top-left):
  ├── Live TV
  ├── Withdrawal     → /personal/withdraw
  ├── Deposit        → /personal/recharge
  ├── Promotions     → /promotion
  ├── Task Center
  ├── Chat Room      → /chatroom
  └── [Language Selector]

Profile Page (/personal) — 3 Tabs:
  ├── Personal Info
  ├── Deposit & Withdrawal Account
  └── Security Settings
```

---

## 1️⃣ Authentication

### TC-AUTH-001 — Valid Login
| Field | Value |
|---|---|
| **URL** | `/login` |
| **Precondition** | User is logged out |
| **Steps** | 1. Navigate to `/login`<br>2. Enter username in Account field<br>3. Enter password in Password field<br>4. Click **Login** button |
| **Expected** | Redirect to `/` (Home). User avatar and wallet balance visible in header. |

### TC-AUTH-002 — Invalid Login (Wrong Password)
| Field | Value |
|---|---|
| **Steps** | Enter valid username + wrong password → Click Login |
| **Expected** | Error toast/message displayed. User stays on `/login`. No redirect. |

### TC-AUTH-003 — Invalid Login (Empty Fields)
| Field | Value |
|---|---|
| **Steps** | Leave Account or Password empty → Click Login |
| **Expected** | Inline validation error shown. Login button blocked or error message displayed. |

### TC-AUTH-004 — Remember Password
| Field | Value |
|---|---|
| **Steps** | Check "Remember Password" checkbox → Login → Logout → Revisit `/login` |
| **Expected** | Account field pre-filled with previous username. |

### TC-AUTH-005 — Logout
| Field | Value |
|---|---|
| **Precondition** | User is logged in |
| **Steps** | Navigate to Profile → Scroll to bottom → Click **Sign Out** |
| **Expected** | Redirected to `/login`. Attempting to access `/personal` redirects back to login. |

### TC-AUTH-006 — Session Persistence
| Field | Value |
|---|---|
| **Steps** | Login → Refresh the page (`F5`) |
| **Expected** | User remains logged in. Wallet balance and avatar still visible. |

### TC-AUTH-007 — Login Page UI Elements Check
| Field | Value |
|---|---|
| **Expected Elements** | Account input, Password input, "Remember Password" checkbox, "Forgot the password?" link, "Sign Up" link, Login button, WalletConnect button, Google/Facebook/Line/WhatsApp/Telegram social icons |

---

## 2️⃣ Home Page (Dashboard)

### TC-HOME-001 — Dashboard Render After Login
| Field | Value |
|---|---|
| **URL** | `/` |
| **Expected** | Wallet balance (USD), Withdrawal button, Deposit button, Rotating banners, Game category tabs, Bottom navigation all visible |

### TC-HOME-002 — Promotional Banners (Auto-Scroll)
| Field | Value |
|---|---|
| **Steps** | Watch home page for 5+ seconds |
| **Expected** | Banner carousel auto-rotates to next slide |

### TC-HOME-003 — Game Category Tab Switching
| Field | Value |
|---|---|
| **Steps** | Click **Popular Games** tab → Click **My Collection** tab → Click **All** tab |
| **Expected** | Game cards update to match selected category. Active tab is visually highlighted. |

### TC-HOME-004 — Electronic Games Swiper
| Field | Value |
|---|---|
| **Steps** | Swipe/drag the E-Game horizontal carousel |
| **Expected** | More game cards revealed. Scroll is smooth. |

### TC-HOME-005 — Live Casino Swiper
| Field | Value |
|---|---|
| **Steps** | Swipe/drag the Live Casino horizontal carousel |
| **Expected** | Live casino game cards revealed and scrollable. |

### TC-HOME-006 — Chatroom Widget (Online Count)
| Field | Value |
|---|---|
| **Expected** | A small overlay widget on the home page shows the number of users currently online. |

### TC-HOME-007 — Quick Feature Links
| Field | Value |
|---|---|
| **Steps** | Click each icon: **Referral**, **Chat Room**, **Scoreboard**, **Live Broadcast** |
| **Expected** | Referral → `/agency`; Chat Room → chatroom page; Scoreboard → "Under construction" alert; Live Broadcast → "Under construction" alert |

### TC-HOME-008 — Notification Icon
| Field | Value |
|---|---|
| **Steps** | Click the notification bell/icon in the header |
| **Expected** | Notification list/drawer opens showing system alerts |

---

## 3️⃣ Bottom Navigation Bar

### TC-NAV-001 — Active Route Highlighting
| Field | Value |
|---|---|
| **Steps** | Click each item in the bottom nav (Home, Deposit, Promotions, Referral, Profile) |
| **Expected** | Active tab icon/label is visually highlighted for the current route |

### TC-NAV-002 — Navigation Routing
| Field | Value |
|---|---|
| **Steps** | Click each bottom nav item |
| **Expected** | Home→`/`, Deposit→`/personal/recharge`, Promotions→`/promotion`, Referral→`/agency`, Profile→`/personal` |

---

## 4️⃣ Profile / Personal Center (`/personal`)

### TC-PROFILE-001 — User Info Display
| Field | Value |
|---|---|
| **Expected** | Nickname, User ID, identity verification status, level badge, avatar all displayed |

### TC-PROFILE-002 — Quick Stats Links
| Field | Value |
|---|---|
| **Steps** | Click **Bet Records** → Back → Click **Transaction Records** → Back → Click **Collections** |
| **Expected** | Each navigates to the respective sub-page. |

### TC-PROFILE-003 — Personal Info Tab (Contact Info Form)
| Field | Value |
|---|---|
| **Steps** | Navigate to Profile → Select **Personal Info** tab |
| **Expected** | Form with fields: Name, Identity ID/CPF, Birthday, Phone (with Verify button), Email (with Verify button), WhatsApp, Facebook, Telegram |

### TC-PROFILE-004 — Phone/Email Verify Button
| Field | Value |
|---|---|
| **Steps** | Click **Verify** next to Phone or Email |
| **Expected** | OTP / verification flow is triggered |

### TC-PROFILE-005 — Deposit & Withdrawal Account Tab
| Field | Value |
|---|---|
| **Steps** | Profile → **Deposit & Withdrawal Account** tab |
| **Expected** | "Add Account" button visible (supports USDT / Bank). "Change Fund Password" button visible. |

### TC-PROFILE-006 — Add USDT Wallet Account
| Field | Value |
|---|---|
| **Steps** | Click **Add Account** → Select USDT |
| **Expected** | Form opens with: Network selector (TRC20 / ERC20 / etc.), Wallet Address input, Account Remark (optional), Fund Password (6-digit, randomized keyboard ⚠️) |

### TC-PROFILE-006b — Add Bank Account
| Field | Value |
|---|---|
| **Steps** | Click **Add Account** → Select Bank |
| **Expected** | Form opens with: Bank Name dropdown, Account Number input, Holder Name input, Fund Password (6-digit, randomized keyboard ⚠️) |

### TC-PROFILE-006c — Fund Password Required Before Account Add
| Field | Value |
|---|---|
| **Steps** | Click **Add Account** without having set a fund password |
| **Expected** | Prompted to set a fund password first (6-digit PIN via randomized keyboard, enter twice to confirm) |

### TC-PROFILE-007 — Security Settings Tab
| Field | Value |
|---|---|
| **Steps** | Profile → **Security Settings** tab |
| **Expected** | **Change Password** (login password) button visible |

### TC-PROFILE-008 — Change Password Flow
| Field | Value |
|---|---|
| **Steps** | Click **Change Password** → Enter old password → Enter new password → Confirm |
| **Expected** | Password updated successfully. Success toast shown. |

### TC-PROFILE-009 — Dark/Light Theme Toggle
| Field | Value |
|---|---|
| **Steps** | Click the theme toggle in Profile |
| **Expected** | Site switches between dark and light color schemes. |

### TC-PROFILE-010 — Language Selector
| Field | Value |
|---|---|
| **Steps** | Click language selector in sidebar → Switch to a different language |
| **Expected** | UI text changes to the selected language |

---

## 5️⃣ Deposit (`/personal/recharge`)

> **Live on:** `s9.com` | **Not yet available on:** `shop01.98ent.com`

**Deposit Structure (s9.com):**
```
Deposit Page
  ├── Tab: Digital Wallet (default)
  │     ├── Sub-tab: Wallet QR  → Shows QR code + wallet address + Copy button
  │     └── Sub-tab: Wallet Link → "Wallet Link" button + Deposit amount input
  └── Tab: Crypto Payment
        └── Select payment channel (e.g., RCPAY) + Deposit amount input

Dropdowns:
  ├── Deposit Currency: USDT
  └── Network: Ethereum Mainnet (ERC-20) | TRON (TRC-20) | BNB Smart Chain (BEP-20)
                Arbitrum One | Optimism | Polygon | Base

Notices:
  - "1 USDT = 1 USD" fixed rate
  - "Transfers from unregistered wallets may not be credited"
  - Exchange rate fluctuation warning
```

### TC-DEP-001 — Deposit Page Render
| Field | Value |
|---|---|
| **URL** | `/personal/recharge` |
| **s9.com** | Currency dropdown (USDT), Network dropdown, two main tabs visible |
| **shop01.98ent.com** | "This feature is not yet available" message shown |

### TC-DEP-002 — Digital Wallet Tab — Wallet QR Sub-tab
| Field | Value |
|---|---|
| **Steps** | Deposit → Digital Wallet tab → Wallet QR sub-tab |
| **Expected** | QR code image rendered. Wallet address string displayed. Copy icon present. Rate notice "1 USDT = 1 USD" visible. |

### TC-DEP-003 — Digital Wallet Tab — Wallet Link Sub-tab
| Field | Value |
|---|---|
| **Steps** | Deposit → Digital Wallet tab → Wallet Link sub-tab |
| **Expected** | "Wallet Link" button visible. Deposit amount input field present. |

### TC-DEP-004 — Crypto Payment Tab
| Field | Value |
|---|---|
| **Steps** | Deposit → Crypto Payment tab |
| **Expected** | "Select payment channel" dropdown shown (e.g., RCPAY). Deposit amount input present. |

### TC-DEP-005 — Network Dropdown Options
| Field | Value |
|---|---|
| **Steps** | Select USDT currency → Click Network dropdown |
| **Expected** | Lists all 7 networks: ERC-20, TRC-20, BEP-20, Arbitrum One, Optimism, Polygon, Base |

### TC-DEP-006 — Copy Wallet Address
| Field | Value |
|---|---|
| **Steps** | Wallet QR sub-tab → Click Copy icon next to the wallet address |
| **Expected** | Success toast shown. Clipboard contains the exact wallet address string. |

### TC-DEP-007 — Deposit Warning Notices
| Field | Value |
|---|---|
| **Expected** | Warning text: "Transfers from unregistered wallets may not be credited." Exchange rate fluctuation warning also shown. |

---

## 6️⃣ Withdrawal (`/personal/withdraw`)

> **Live on:** `s9.com`

**Withdrawal Form Fields (s9.com):**
```
Withdrawal Page
  ├── Tab: Digital Wallet
  │     ├── Withdraw Currency: USDT
  │     ├── Network: (same 7 options as Deposit)
  │     ├── Withdraw Address: dropdown (saved addresses)
  │     ├── Withdraw Amount: numeric input (min: 1 USDT)
  │     └── Fund Password: 6-digit PIN via randomized on-screen keyboard ⚠️
  └── Tab: Crypto Payment

Dashboard info shown: Available Balance | Turnover Required
Security notice: Large/suspicious withdrawals → 1–6 hour manual review
```

### TC-WD-001 — Special Offer Modal on Withdrawal
| Field | Value |
|---|---|
| **Steps** | Click Withdrawal button from Home |
| **Expected** | A **Special Offer** modal appears first. User must close it before reaching the withdrawal form. |

### TC-WD-002 — Account Binding Enforcement
| Field | Value |
|---|---|
| **Precondition** | User has NOT bound a USDT/bank account |
| **Steps** | Navigate to `/personal/withdraw` |
| **Expected** | "Account Binding Required" modal appears. Withdrawal form not accessible. |

### TC-WD-003 — Withdrawal Form Fields Render
| Field | Value |
|---|---|
| **Precondition** | User has a bound withdrawal account |
| **Expected** | Currency (USDT), Network dropdown, Address dropdown (pre-filled from saved accounts), Amount input, Fund Password field, Withdraw button all visible |

### TC-WD-004 — Minimum Withdrawal Amount
| Field | Value |
|---|---|
| **Steps** | Enter amount below `1` USDT → Submit |
| **Expected** | Validation error shown. Submission blocked. |

### TC-WD-005 — Turnover Requirement Display
| Field | Value |
|---|---|
| **Expected** | "Turnover Required" amount displayed on the withdrawal page. Withdrawal blocked if turnover not met. |

### TC-WD-006 — Fund Password Entry (Randomized Keyboard)
| Field | Value |
|---|---|
| **Steps** | Enter amount → Click Fund Password field → Enter 6-digit PIN using on-screen keyboard |
| **Expected** | Random keyboard appears with shuffled digit positions. PIN accepted when correct 6 digits clicked. |
| **⚠️ Automation Note** | Keyboard digits are randomized each render. Must locate buttons by their **text label** at runtime, not by fixed coordinates. |

### TC-WD-007 — Withdrawal Submit & Confirmation
| Field | Value |
|---|---|
| **Precondition** | Valid account bound, turnover met, sufficient balance |
| **Steps** | Fill all fields → Enter fund password → Click **Withdraw** |
| **Expected** | Withdrawal request submitted. Success toast shown. Large amounts may show a notice: "1–6 hours for manual review". |

---

## 7️⃣ Promotions (`/promotion`)

### TC-PROMO-001 — Promotions Page Render
| Field | Value |
|---|---|
| **URL** | `/promotion` |
| **Expected** | List of promotion cards visible (e.g., Lucky Spin, Wagering Rebate). Each card shows image, title, and status badge ("Permanent" / "Ongoing"). |

### TC-PROMO-002 — Category Filter Tabs
| Field | Value |
|---|---|
| **Steps** | Click category tabs: **All**, **Electronic**, **Sports**, **General** |
| **Expected** | Promotion cards filter to match the selected category. Active tab highlighted. |

### TC-PROMO-003 — Promotion Card Click
| Field | Value |
|---|---|
| **Steps** | Click on a promotion card |
| **Expected** | Navigates to promotion detail page or opens a modal with detailed info |

---

## 8️⃣ Referral / Agency (`/agency`)

### TC-REF-001 — Referral Page Render
| Field | Value |
|---|---|
| **URL** | `/agency` |
| **Expected** | Two tabs: **Invite Link** and **My Team** |

### TC-REF-002 — Invite Link Tab
| Field | Value |
|---|---|
| **Steps** | Click **Invite Link** tab |
| **Expected** | Unique referral URL displayed. QR code image rendered. Copy button available. |

### TC-REF-003 — Copy Referral Link
| Field | Value |
|---|---|
| **Steps** | Click the **Copy** button next to the referral link |
| **Expected** | Success toast shown ("Copied!"). Clipboard contains the correct referral URL. |

### TC-REF-004 — QR Code Display
| Field | Value |
|---|---|
| **Expected** | QR code image is generated and rendered correctly (not broken/blank) |

### TC-REF-005 — My Team Tab
| Field | Value |
|---|---|
| **Steps** | Click **My Team** tab |
| **Expected** | Shows direct/indirect subordinate count, referral bonus summary, commission level hierarchy |

---

## 9️⃣ Chat Room

### TC-CHAT-001 — Chat Room Render
| Field | Value |
|---|---|
| **Steps** | Navigate to Chat Room via home page icon or sidebar |
| **Expected** | Public chat interface loaded. Message list visible. Text input field and **Send** button present. |

### TC-CHAT-002 — Send a Message
| Field | Value |
|---|---|
| **Steps** | Type a message in input → Click **Send** |
| **Expected** | Message appears in the chat list with the current user's name. Input field clears after sending. |

---

## 🔟 Bet History (`/personal/bet`)

### TC-BET-001 — Bet History Render
| Field | Value |
|---|---|
| **URL** | `/personal/bet` |
| **Expected** | Filter row with: Game Manufacturer dropdown, Select Game dropdown, Betting Time range. Table with columns: Type (Game/Time), Bet (Amount/Profit-Loss). |

### TC-BET-002 — Filter by Game Manufacturer
| Field | Value |
|---|---|
| **Steps** | Select a manufacturer from dropdown → Apply |
| **Expected** | Table updates to show only bets from that manufacturer |

### TC-BET-003 — Filter by Date Range
| Field | Value |
|---|---|
| **Steps** | Set a start and end date → Apply |
| **Expected** | Table shows only bets within the selected date range |

---

## 1️⃣1️⃣ Transaction Records (`/personal/transaction`)

### TC-TXN-001 — Transaction Records Render
| Field | Value |
|---|---|
| **Expected** | Currency filter (USD), Time range filter. List of transactions with: Type (Deposit, Withdrawal, Reward), Date, Amount, Status. |

### TC-TXN-002 — Filter by Time Range
| Field | Value |
|---|---|
| **Steps** | Select a time range from filter → Apply |
| **Expected** | List updates to show only transactions in the selected range |

---

## 1️⃣2️⃣ Notifications

### TC-NOTIF-001 — Notification List Render
| Field | Value |
|---|---|
| **Steps** | Click notification icon in header |
| **Expected** | Notification drawer/list opens. Shows system alerts. |

### TC-NOTIF-002 — Mark as Read
| Field | Value |
|---|---|
| **Steps** | Click an unread notification |
| **Expected** | Notification marked as read. Unread badge count decremented. |

---

## 1️⃣3️⃣ Under-Construction Features

| Feature | Expected Test Behavior |
|---|---|
| **Scoreboard** | Clicking shows "Under construction" alert. Test: confirm alert text is present. |
| **Live Broadcast** | Clicking shows "Under construction" alert. Test: confirm alert text is present. |
| **Task Center** | Page loads without crash or 404. |

---

## 1️⃣4️⃣ Cross-Cutting / Non-Functional

### TC-NFR-001 — Loading Spinner Visibility
| Field | Value |
|---|---|
| **Steps** | Navigate between any two pages |
| **Expected** | A loading spinner appears during page transitions and disappears when content is loaded |

### TC-NFR-002 — Responsive Layout (Mobile)
| Field | Value |
|---|---|
| **Steps** | Run all tests with viewport `375x812` (iPhone) |
| **Expected** | All UI elements visible, no overflow, bottom nav accessible |

### TC-NFR-003 — Cross-Browser Compatibility
| Field | Value |
|---|---|
| **Steps** | Run critical path tests on Chromium, Firefox, WebKit |
| **Expected** | All core flows pass on each browser engine |

### TC-NFR-004 — Protected Routes (Unauthenticated Access)
| Field | Value |
|---|---|
| **Steps** | While logged out, attempt to directly navigate to `/personal`, `/agency`, `/promotion` |
| **Expected** | Redirected to `/login` for all protected routes |

---

## 📌 Key Test Data & Notes

| Item | s9.com | shop01.98ent.com |
|---|---|---|
| Test Account | `yoongtest05` / `Yoong01!` | `yoongfriend2` / `Yoong01!` |
| Base URL | `https://s9.com` | `https://shop01.98ent.com` |
| Deposit | ✅ Live | ❌ Not yet available |
| Withdrawal | ✅ Live | ❌ Blocked (account binding required) |
| Min Withdrawal | 1 USDT | — |
| Supported Networks | ERC-20, TRC-20, BEP-20, Arbitrum, Optimism, Polygon, Base | Same |
| Currency | USDT / USD | USDT / USD |
| Features Under Construction | Scoreboard, Live Broadcast | Scoreboard, Live Broadcast |
| Mandatory Before Withdrawal | Bind USDT/bank account + set Fund Password | Same |

### ⚠️ Critical Automation Notes

| Challenge | Detail | Playwright Approach |
|---|---|---|
| **Randomized Fund Password Keyboard** | Digit positions shuffle every render | Locate each digit button by `text()` label at runtime, not by coordinate |
| **Special Offer Modal** | Appears when clicking Withdrawal from Home | Must dismiss modal before interacting with withdrawal form |
| **Turnover Requirement** | Withdrawal blocked until wagering turnover met | Use a fresh test account with cleared turnover for withdrawal tests |
| **Manual Review** | Large withdrawals queued 1–6 hours | Flag in test: assert "pending" status, not instant confirmation |
