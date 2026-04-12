# FlowState Roadmap

> *"I've got you. Let's work."*  
> Version 3.0 — Last updated: April 2026

---

## 🟢 Phase 1 — Foundation (COMPLETE)

**Core timer & tracking infrastructure**

| Feature | Status |
|---|---|
| Pomodoro Timer (25/5/15 phases, custom duration 1–480 min) | ✅ |
| Animated ring progress + glow + celebration effects | ✅ |
| FlowScore formula (focus minutes × session quality) | ✅ |
| Session history stored in Cloudflare D1 | ✅ |
| Streak tracking + break streak logic | ✅ |
| Kanban board with drag-and-drop + D1 sync (Pro) | ✅ |
| Smart Deadlines with AI risk badge (Pro) | ✅ |
| Google OAuth sign-in | ✅ |
| Magic Link sign-in (email) | ✅ |
| Onboarding flow (goals, timezone, work hours) | ✅ |
| Session intent (set intention before focus) | ✅ |
| Session share card (`/u/:slug`) | ✅ |
| Public FlowScore widget (embed JS at `/widget.js`) | ✅ |
| Ambient sounds via Web Audio API | ✅ |

---

## 🟢 Phase 2 — Intelligence Layer (COMPLETE)

**AI routing, behavioral intelligence, team features**

| Feature | Status |
|---|---|
| Multi-LLM AI Chat (auto-routing: Claude, GPT-4o, Gemini, Grok, Mistral, DeepSeek) | ✅ |
| AI Flow Coach (behavioral patterns, peak hours, output analysis) | ✅ |
| Behavior Insight API (`/api/behavior/insight`) | ✅ |
| Weekly AI Digest email (cron trigger via Resend) | ✅ |
| Streak reminder emails | ✅ |
| Team Hub (standup updates, leaderboard, burnout risk, sprint health) | ✅ |
| Accountability Pairing (real-time pair focus with timer sync) | ✅ |
| Team leaderboard with avatar + FlowScore rank | ✅ |
| Smart Schedule suggestions (AI-powered focus time recommender) | ✅ |
| Google Calendar integration (read + create focus blocks) | ✅ |
| Notion integration (sync tasks + create pages) | ✅ |
| Slack integration (standup notifications) | ✅ |
| Referral program (invite friends → earn tokens) | ✅ |
| Stripe billing (Pro $18/mo monthly · $14/mo annual; Team $15/seat/mo monthly · $12/seat/mo annual; Enterprise contact us) | ✅ |
| Token top-ups (50k / 200k / 500k packs via Stripe) | ✅ |
| Daily AI token budgets with purchased-token overflow | ✅ |
| AI Coach onboarding modal (3-step, localStorage gated) | ✅ |
| Pairing onboarding modal (3-step, localStorage gated) | ✅ |

---

## 🟢 Phase 3 — Full Architecture (COMPLETE — Current)

**Creative tools, music AI, distribution pipeline, generate tab, legal**

| Feature | Status |
|---|---|
| Generate Tab — AI image generation (FLUX, Ideogram, DALL-E 3, Recraft, Seedream) | ✅ |
| Generate Tab — AI video generation (Runway, Kling, MiniMax, Luma, HunyuanVideo, LTX) | ✅ |
| Generate Tab — AI audio / TTS (ElevenLabs voices) | ✅ |
| Higgsfield AI — cinematic video (Seedance 2.0, Wan 2.6) | ✅ |
| FlowState Audio (FSAudio) — AI music arrangement, track gen, audio analysis | ✅ |
| ClawBot — AI creative assistant for music & content creators | ✅ |
| CLAW Release Manager — full pipeline (cover art → pitch → DistroKid / UnitedMasters / SubmitHub) | ✅ |
| 264Pro Integration — project sync, AI context memory, video gen, diagnostics | ✅ |
| File Tools — PDF↔Images, SVG→PNG, TXT→PDF, CSV→JSON, PPTX→PDF | ✅ |
| YouTube Playlist Manager (multi-URL, drag reorder, shuffle, sequential) | ✅ |
| Spotify embed support in music player | ✅ |
| Music Volume Slider (gradient thumb, mute toggle, now-playing pill, persists to localStorage) | ✅ |
| Custom Pomodoro Duration (presets 25/45/90 + custom 1–480 in Settings) | ✅ |
| Token Balance Display fix (daily remaining clearly separated from purchased) | ✅ |
| Duplicate function stubs cleaned (renderStandups, renderDeadlines, addMyStandup) | ✅ |
| Product Hunt Launch Page (`/launch`) with OG images | ✅ |
| Pricing page with comparison table | ✅ |
| **Privacy Policy** (full-scope: AI, billing, integrations, GDPR, CCPA) | ✅ |
| **Terms of Use** (full-scope: all features, AI disclaimers, music distribution, arbitration) | ✅ |
| `/legal` route — in-app tabbed legal viewer with FlowState theme | ✅ |
| Legal links in Settings modal, login page, auth page | ✅ |
| Cloudflare R2 file storage for AI outputs + cover art | ✅ |

---

## 🟡 Phase 4 — Polish & Scale (NEXT UP)

**Target: Q2 2026**

### 🔴 High Priority — Bug Fixes & Missing Features

| Item | Notes |
|---|---|
| `og-card.svg` 404 fix | OG image for social share cards returns 404 — regenerate or serve from R2 |
| `/api/email/streak-reminder` 404 fix | POST route missing or broken — audit and restore |
| Migration 0003 empty | Fill in migration 0003 with any schema changes it should contain |
| Domain link misconfiguration | Ensure `CANONICAL_ORIGIN` is correctly set to `flowst8.cc` in all envs |
| Comparison table false positive | Audit pricing comparison table for incorrect feature checkmarks |
| Token balance: verify purchased tokens write to Redis correctly after top-up | Confirm `token_balance:{email}` is set in Redis after Stripe webhook fires |

### 🟡 Medium Priority — Feature Completion

| Feature | Notes |
|---|---|
| **Smart Deadlines — AI timeline generator** | From a project brief, auto-generate a set of milestones with AI-suggested dates and owners |
| **Session Replay / Focus Journal** | Daily log view showing each session with intention, duration, FlowScore, and output note |
| **Mobile PWA (Progressive Web App)** | Manifest + service worker for "Add to Home Screen" on iOS/Android |
| **Dark/Light/Dim theme toggle** | User-selectable theme (currently always dark) |
| **Notification system** | Browser push notifications for break reminders and streak milestones |
| **Keyboard shortcuts overlay** | `?` hotkey to show all keyboard shortcuts |
| **Export session history** | CSV / JSON export of full session history from D1 |
| **Onboarding re-run button** | Allow users to redo onboarding from Settings |
| **AI Coach scheduling** | Schedule weekly AI Coach insight delivery via email |
| **Team invites via email** | Full invite flow — currently generates a link but no email delivery |

### 🟢 Low Priority — Nice to Have

| Feature | Notes |
|---|---|
| **Pomodoro music — Soundcloud embed** | Add SoundCloud as a third playlist source alongside YouTube and Spotify |
| **Focus Rooms** | Shared ambient focus rooms — multiple users in same timer session |
| **Leaderboard — weekly reset** | Rolling 7-day leaderboard instead of all-time |
| **FlowScore badge tiers** | Bronze / Silver / Gold / Obsidian visual tiers based on cumulative score |
| **AI-generated session affirmations** | Short GPT-generated affirmation shown at session end |
| **Customizable celebration animations** | User can choose confetti vs. sparks vs. stars |
| **CLAW — YouTube video upload** | After video generation, upload directly to YouTube via YouTube Data API |
| **CLAW — Spotify artist submission** | Pitch to Spotify editorial via SubmitHub |
| **264Pro — video auto-captioning** | Auto-transcribe and burn captions using Whisper |
| **Language learning flashcards in Learn tab** | Expand the Learn tab cards to support user-added vocab decks |

---

## 🔵 Phase 5 — Monetization & Growth (Q3–Q4 2026)

| Item | Notes |
|---|---|
| **Team plan billing activation** | Team monthly $15/seat, annual $12/seat — Stripe price IDs wired, confirm live activation |
| **Annual plan discount** | 2 months free on annual (already wired in Stripe, needs activation) |
| **Affiliate program** | Extend referral system to support affiliate links with custom tracking |
| **Public API** | Documented public API for FlowScore read access — developers can embed scores |
| **Zapier / Make integration** | Trigger Zaps on session complete, streak milestone, or deadline alert |
| **iOS / Android app** | Native wrapper (Capacitor or React Native) around existing web app |
| **CLAW Enterprise** | White-label CLAW Release Manager for record labels and management companies |
| **FlowState for EDU** | Academic version with teacher dashboards, class streaks, and focus tracking |

---

## 📋 Immediate Next Actions (This Week)

1. ✅ Ship Privacy Policy & Terms of Use at `/legal`
2. 🔧 Fix `og-card.svg` 404 (serve from `/api/generate/og-card` or R2)
3. 🔧 Fix `/api/email/streak-reminder` 404
4. 🔧 Verify token top-up writes to Redis (`token_balance:{email}`)
5. 🔧 Fill in migration 0003 if pending schema changes exist
6. 📱 Begin Mobile PWA manifest — low-lift, high-impact for mobile users
7. 📓 Add Session Replay / Focus Journal view to Metrics tab

---

## 🏛️ Architecture Notes

- **Backend**: Hono on Cloudflare Workers (edge-first, global)
- **Persistent data**: Cloudflare D1 (SQLite) — users, sessions, tasks, subscriptions, referrals
- **Ephemeral data**: Upstash Redis — token limits, rate limits, tier cache, pairing queue
- **File storage**: Cloudflare R2 — AI outputs, cover art, uploaded files
- **Browser storage**: localStorage — timer state, preferences, offline-first task fallback
- **Auth**: Google OAuth + Magic Link → HTTP-only `fs_session` cookie (7 days)
- **Billing**: Stripe subscriptions + one-time token top-ups via Checkout Sessions
- **Email**: Resend transactional API
- **AI routing**: OpenRouter (chat), direct API calls for specialized models
- **Build**: Vite + @hono/vite-cloudflare-pages → Cloudflare Pages

---

*For questions or to contribute ideas: open an issue on [GitHub](https://github.com/mkbrown261/FLOWSTATE) or email [hello@flowst8.cc](mailto:hello@flowst8.cc)*
