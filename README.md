# FlowState — The Intelligent Workspace

> *"I've got you. Let's work."*

FlowState is an AI-native personal operating system built around a Pomodoro timer. It's not a productivity app — it's a digital companion that knows when you're in flow, when you're stuck, when you need a break, and when you deserve to celebrate.

## 🌐 Live URLs
- **Production**: https://flowstate-67g.pages.dev ✅ Live
- **GitHub**: https://github.com/mkbrown261/pomodoro-timer-lab

## ✨ What's Built

### Core Architecture
- **Intent Layer** (`src/intent-layer.ts`) — The brain. All routing decisions, behavioral logic, model selection, tip bubble triggers, and celebration logic live here. The Action Layer executes. It does not decide.
- **Action Layer** (`src/index.tsx`) — Executes intents. Zero decision logic.

### Features Live
| Feature | Status |
|---|---|
| Pomodoro Timer (25/5/15 phases) | ✅ Live |
| Animated ring progress + glow effects | ✅ Live |
| Session stats & streak tracking | ✅ Live |
| Multi-LLM AI Chat (auto-routing) | ✅ Live |
| Chat routes code → Claude, creative → GPT-4o, quick → mini | ✅ Live |
| Celebration system (confetti, sparks, stars, glow) | ✅ Live |
| Tip Bubbles (posture, hydration, debugging, encouragement) | ✅ Live |
| Calendar tab with focus block protection | ✅ Live |
| Kanban Board with drag & drop | ✅ Live |
| Metrics dashboard with Chart.js | ✅ Live |
| Learn tab (quotes, language, health insights) | ✅ Live |
| Ambient sound mode selector | ✅ Live |
| Integration panel (Google Calendar, Notion, NotebookLM) | ✅ Live |
| Premium tier modal (Free / Pro / Behavior $12/mo) | ✅ Live |
| Behavior Intelligence sidebar | ✅ Live |
| Behavior aggregate insights API | ✅ Live |

### Integration Status
All integrations are architecture-ready. OAuth flows wired. Needs API credentials:
- Google Calendar — OAuth ready
- Notion — OAuth ready  
- NotebookLM — OAuth ready
- OpenAI (GPT-4o, DALL-E 3) — needs `OPENAI_API_KEY`
- Anthropic (Claude) — needs `ANTHROPIC_API_KEY`
- Google AI (Gemini) — needs `GOOGLE_API_KEY`

## 🏗️ Architecture

```
FlowState
├── Intent Layer (src/intent-layer.ts)
│   ├── declareModelRouting() — picks the right LLM per task
│   ├── declareTipIntent() — triggers tip bubbles at right moments
│   ├── declareCelebration() — session celebration config
│   ├── declareBehaviorInsight() — aggregates 6+ data sources
│   ├── declareTierCapabilities() — free/pro/behavior gating
│   └── declareIntegrations() — OAuth integration registry
│
└── Action Layer (src/index.tsx)
    ├── POST /api/chat — executes model routing intent
    ├── POST /api/tip — surfaces AI-written tip bubbles
    ├── POST /api/celebrate — returns celebration config
    ├── POST /api/insight — behavior aggregate endpoint
    ├── GET /api/tier/:tier — tier capability lookup
    ├── GET /api/integrations — integration status
    └── GET /* — full FlowState app shell
```

## 🚀 Tech Stack
- **Runtime**: Cloudflare Pages + Workers
- **Backend**: Hono (TypeScript)
- **Frontend**: Vanilla JS + Tailwind CSS CDN + Chart.js
- **Build**: Vite + @hono/vite-build
- **AI**: Multi-model routing (OpenAI, Anthropic, Google)

## 🔑 API Keys Needed
Add these as Cloudflare Pages secrets for full AI functionality:
```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...
```

## 💰 Pricing Tiers
| Tier | Price | Key Feature |
|---|---|---|
| Free | $0 | Timer, basic chat, local Kanban |
| Pro | $12/mo | Multi-LLM routing, all integrations, AI tips |
| Behavior | TBD | Full intelligence system, health/finance/language sync |

## 🛠️ Development
```bash
npm run build          # Build for production
npm run preview        # Preview locally
npm run deploy         # Deploy to Cloudflare Pages
```

## 🎨 Design Language
- Dark ambient base: `#0a0a0f`
- Primary: Purple `#7c3aed` + Amber `#f59e0b`
- Subtle breathing animations, glow effects, earned transitions
- Celebration particles: confetti, sparks, stars, glow bursts

---
*Built with FlowState architecture law: All logic lives in the Intent Layer. The Action Layer executes. It does not decide.*
