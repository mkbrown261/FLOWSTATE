import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import {
  declareModelRouting,
  declareTipIntent,
  declareCelebration,
  declareBehaviorInsight,
  declareTierCapabilities,
  declareIntegrations,
  type SessionIntent,
} from './intent-layer'

type Bindings = {
  OPENAI_API_KEY: string
  ANTHROPIC_API_KEY: string
  GOOGLE_API_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

app.use('/static/*', serveStatic({ root: './' }))

// ── API: Chat with multi-LLM routing (Intent Layer decides) ────────────────
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  const { message, session } = body as { message: string; session: SessionIntent }

  const intent = declareModelRouting(message, session)

  // Action Layer executes — does not decide
  try {
    let responseText = ''
    const model = intent.selectedModel
    const apiKey = c.env?.OPENAI_API_KEY

    if (model.startsWith('gpt') || model.startsWith('o1')) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model === 'gpt-4o-mini' ? 'gpt-4o-mini' : 'gpt-4o',
          messages: [
            { role: 'system', content: intent.systemPrompt },
            { role: 'user', content: message }
          ],
          max_tokens: 1500,
          temperature: intent.detectedCapability === 'creative' ? 0.9 : 0.7
        })
      })
      const data: any = await res.json()
      responseText = data.choices?.[0]?.message?.content || 'Model response unavailable.'
    } else if (model.startsWith('claude')) {
      const anthropicKey = c.env?.ANTHROPIC_API_KEY || apiKey
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1500,
          system: intent.systemPrompt,
          messages: [{ role: 'user', content: message }]
        })
      })
      const data: any = await res.json()
      responseText = data.content?.[0]?.text || 'Model response unavailable.'
    } else {
      // Fallback: demo mode with smart pre-written responses
      responseText = await generateDemoResponse(message, intent)
    }

    return c.json({
      response: responseText,
      model: intent.selectedModel,
      capability: intent.detectedCapability,
      rationale: intent.rationale
    })
  } catch (err) {
    const demoResp = await generateDemoResponse(message, intent)
    return c.json({
      response: demoResp,
      model: `${intent.selectedModel} (demo)`,
      capability: intent.detectedCapability,
      rationale: intent.rationale
    })
  }
})

// ── API: Get Tip Bubble (Intent Layer decides) ─────────────────────────────
app.post('/api/tip', async (c) => {
  const session = await c.req.json() as SessionIntent
  const intent = declareTipIntent(session)

  if (!intent) return c.json({ tip: null })

  // Action Layer: generate tip text
  const tip = await generateTip(intent.aiPromptContext, c.env?.OPENAI_API_KEY)

  return c.json({
    tip,
    category: intent.category,
    urgency: intent.urgency
  })
})

// ── API: Get Celebration (Intent Layer decides) ────────────────────────────
app.post('/api/celebrate', async (c) => {
  const session = await c.req.json() as SessionIntent
  const intent = declareCelebration(session)
  return c.json(intent)
})

// ── API: Behavior Insight (Intent Layer decides) ───────────────────────────
app.post('/api/insight', async (c) => {
  const data = await c.req.json()
  const intent = declareBehaviorInsight(data)
  return c.json({ insight: intent })
})

// ── API: Tier capabilities ─────────────────────────────────────────────────
app.get('/api/tier/:tier', (c) => {
  const tier = c.req.param('tier') as any
  return c.json(declareTierCapabilities(tier))
})

// ── API: Integrations status ───────────────────────────────────────────────
app.get('/api/integrations', (c) => {
  return c.json(declareIntegrations())
})

// ── API: Generate image (proxied) ──────────────────────────────────────────
app.post('/api/image', async (c) => {
  const { prompt } = await c.req.json()
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env?.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024' })
    })
    const data: any = await res.json()
    return c.json({ url: data.data?.[0]?.url || null })
  } catch {
    return c.json({ url: null, error: 'Image generation unavailable in demo mode' })
  }
})

// ── API: Health check ─────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ status: 'alive', version: '1.0.0', name: 'FlowState' }))

// ── Serve static assets ────────────────────────────────────────────────────
app.get('/static/*', serveStatic({ root: './' }))

// ── Main app shell ─────────────────────────────────────────────────────────
app.get('*', (c) => {
  return c.html(getAppHTML())
})

// ── Demo response generator ────────────────────────────────────────────────
async function generateDemoResponse(message: string, intent: any): Promise<string> {
  const msg = message.toLowerCase()

  if (intent.detectedCapability === 'code') {
    return `**FlowState AI** (${intent.selectedModel}) — Code Analysis\n\nI can see what's happening here. Let me break it down:\n\n**Root Cause:** Based on what you've shared, this looks like a classic scope/timing issue. The variable is being referenced before it's fully initialized.\n\n**Fix:**\n\`\`\`javascript\n// Before (broken)\nconst result = getData()\nconsole.log(result.value) // undefined!\n\n// After (correct)\nconst result = await getData()\nconsole.log(result.value) // works\n\`\`\`\n\n**Why this works:** The async nature of the call means the data isn't ready when you try to access it. Adding \`await\` ensures you have the full object before proceeding.\n\nYou've been at this a while — clean error, clean fix. Take a breath. 🎯`
  }

  if (intent.detectedCapability === 'creative') {
    return `**FlowState AI** (${intent.selectedModel}) — Creative Mode\n\nHere's what came through for me:\n\n*The screen glows like a city that never sleeps,\nfingers moving across keys like someone who knows\nexactly what they're building — even when they don't.\nEvery line of code is a small act of faith\nthat tomorrow, it will all make sense.*\n\nWant me to take this in a different direction? Different tone, different format — just say the word.`
  }

  if (intent.detectedCapability === 'analysis') {
    return `**FlowState AI** (${intent.selectedModel}) — Deep Analysis\n\n**Summary of key insights:**\n\n1. **Core Pattern** — The data suggests a recurring cycle rather than a linear trend. This is important because it means optimization should target the cycle, not individual data points.\n\n2. **Critical Variable** — The most impactful lever appears to be timing and sequencing, not volume or intensity.\n\n3. **Recommended approach** — Start with the highest-leverage action (addressing the bottleneck in phase 2), then iterate based on what the data shows.\n\n4. **What to watch** — Monitor the feedback loop between inputs and outputs over the next 7-day window.\n\nWant me to go deeper on any of these points?`
  }

  return `**FlowState AI** (${intent.selectedModel})\n\n${message.length < 20 ? "That's a sharp question." : "Interesting — let me think through this with you."}\n\nBased on what you're asking: the most direct answer is that it depends on the context you're operating in, but there's a framework that usually cuts through the noise:\n\n**The 3-question check:**\n1. What's the actual goal? (Not the stated goal — the real one)\n2. What's the fastest path to a signal that tells you if you're right?\n3. What would it take to be wrong about this?\n\nThat structure usually reveals the answer or at least the next right move. What's the underlying thing you're trying to solve?`
}

async function generateTip(context: string, apiKey?: string): Promise<string> {
  // Pre-written high-quality tips keyed by context keywords
  if (context.includes('posture')) {
    const tips = [
      "You've been locked in for a while. Roll your shoulders back. Chin up. Your spine will thank you tomorrow.",
      "45 minutes of deep work — impressive. Take 20 seconds: shoulders back, deep breath, eyes off the screen. You've earned the reset.",
      "Long session detected. Quick body scan: jaw unclenched? Shoulders dropped? Wrists neutral? Good. Back to it."
    ]
    return tips[Math.floor(Math.random() * tips.length)]
  }
  if (context.includes('hydration')) {
    const tips = [
      "Your brain is 73% water. You've been running hard — refill the tank. One glass. Right now.",
      "Water check. No judgment — just a reminder that dehydration looks a lot like brain fog, and you're too close to great work to let that happen.",
      "60 minutes of solid output. Drink something. Your next hour will be sharper for it."
    ]
    return tips[Math.floor(Math.random() * tips.length)]
  }
  if (context.includes('debug')) {
    const tips = [
      "You've been in the weeds for a while. The answer is closer than it feels. Take one breath and re-read the error message like it's the first time.",
      "Deep in a debug session. Classic move: explain the bug out loud, even to yourself. You'll find it in the explanation.",
      "If you've been looking at this for 40+ minutes, the bug probably isn't where you think it is. Expand your search by one layer."
    ]
    return tips[Math.floor(Math.random() * tips.length)]
  }
  if (context.includes('idle')) {
    const tips = [
      "Still there? No pressure — sometimes the best thinking happens when hands aren't moving. When you're ready, the timer's still running.",
      "Drifted for a bit. Totally normal. What's the one thing you need to do in this session to make it count?",
      "You went quiet. That's okay. Sometimes you need a minute before you take the next step. Take it. Then go."
    ]
    return tips[Math.floor(Math.random() * tips.length)]
  }
  if (context.includes('session 3') || context.includes('session 5') || context.includes('completed')) {
    const tips = [
      "Three sessions deep. That's not just productivity — that's discipline. Most people don't make it here. You did.",
      "Five sessions. Five. You're in the top 1% of focused work today. Rest like you've earned it — because you have.",
      "Look at the number next to 'sessions today.' That's not a stat. That's a record of who you are when you decide to show up."
    ]
    return tips[Math.floor(Math.random() * tips.length)]
  }

  return "You're doing better than you think. Keep going."
}

function getAppHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FlowState — Intelligent Workspace</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    ${getStyles()}
  </style>
</head>
<body>
  <div id="app">
    ${getAppShell()}
  </div>
  <canvas id="celebration-canvas" style="position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;display:none;"></canvas>
  <div id="tip-bubble" class="tip-bubble" style="display:none;"></div>
  <script>
    ${getAppScript()}
  </script>
</body>
</html>`
}

function getStyles(): string {
  return `
    :root {
      --primary: #7c3aed;
      --primary-light: #a78bfa;
      --primary-dark: #5b21b6;
      --accent: #f59e0b;
      --accent-light: #fbbf24;
      --bg-deep: #0a0a0f;
      --bg-card: #12121a;
      --bg-panel: #1a1a2e;
      --bg-hover: #1e1e30;
      --text-primary: #f1f0ff;
      --text-secondary: #9d9bb5;
      --text-muted: #6b6880;
      --border: #2a2a3e;
      --border-glow: #7c3aed44;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --focus-color: #7c3aed;
      --break-color: #10b981;
      --glow-purple: 0 0 30px #7c3aed55, 0 0 60px #7c3aed22;
      --glow-green: 0 0 30px #10b98155, 0 0 60px #10b98122;
      --glow-amber: 0 0 30px #f59e0b55;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: var(--bg-deep);
      color: var(--text-primary);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Ambient background */
    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at 30% 20%, #7c3aed08 0%, transparent 50%),
                  radial-gradient(ellipse at 70% 80%, #10b98108 0%, transparent 50%),
                  radial-gradient(ellipse at 50% 50%, #0a0a0f 40%, #070712 100%);
      animation: ambientPulse 8s ease-in-out infinite;
      z-index: -1;
    }

    @keyframes ambientPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.85; transform: scale(1.02); }
    }

    /* Header */
    .flowstate-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: rgba(10,10,15,0.8);
      backdrop-filter: blur(20px);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .logo-icon {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      box-shadow: var(--glow-purple);
      animation: logoPulse 4s ease-in-out infinite;
    }

    @keyframes logoPulse {
      0%, 100% { box-shadow: 0 0 20px #7c3aed44; }
      50% { box-shadow: 0 0 40px #7c3aed88, 0 0 80px #7c3aed22; }
    }

    .logo-text {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, var(--text-primary), var(--primary-light));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo-subtitle {
      font-size: 9px;
      letter-spacing: 2px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
    }

    /* Main layout */
    .main-layout {
      display: grid;
      grid-template-columns: 1fr 400px;
      gap: 0;
      min-height: calc(100vh - 69px);
    }

    @media (max-width: 1100px) {
      .main-layout { grid-template-columns: 1fr; }
      .sidebar { display: none; }
    }

    /* Timer section */
    .timer-section {
      padding: 32px 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
    }

    /* Tab navigation */
    .tab-nav {
      display: flex;
      gap: 4px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 4px;
      width: 100%;
      max-width: 560px;
    }

    .tab-btn {
      flex: 1;
      padding: 8px 12px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      border-radius: 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.3px;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      white-space: nowrap;
    }

    .tab-btn:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .tab-btn.active {
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      color: white;
      box-shadow: 0 2px 12px #7c3aed44;
    }

    /* Tab content */
    .tab-content {
      width: 100%;
      max-width: 560px;
    }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* Timer card */
    .timer-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 40px;
      text-align: center;
      position: relative;
      overflow: hidden;
      width: 100%;
      transition: border-color 0.5s ease, box-shadow 0.5s ease;
    }

    .timer-card.focus-active {
      border-color: var(--primary);
      box-shadow: var(--glow-purple);
    }

    .timer-card.break-active {
      border-color: var(--success);
      box-shadow: var(--glow-green);
    }

    .timer-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--primary), var(--accent), transparent);
      opacity: 0;
      transition: opacity 0.5s;
    }

    .timer-card.focus-active::before { opacity: 1; }

    /* Phase selector */
    .phase-selector {
      display: flex;
      gap: 8px;
      justify-content: center;
      margin-bottom: 32px;
    }

    .phase-btn {
      padding: 6px 16px;
      border: 1px solid var(--border);
      border-radius: 20px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .phase-btn:hover { border-color: var(--primary-light); color: var(--text-primary); }
    .phase-btn.active {
      background: var(--primary);
      border-color: var(--primary);
      color: white;
      box-shadow: 0 0 16px #7c3aed44;
    }

    .phase-btn.break-btn.active {
      background: var(--success);
      border-color: var(--success);
      box-shadow: 0 0 16px #10b98144;
    }

    /* Timer ring */
    .timer-ring-container {
      position: relative;
      width: 220px;
      height: 220px;
      margin: 0 auto 32px;
    }

    .timer-ring-svg {
      transform: rotate(-90deg);
      filter: drop-shadow(0 0 12px #7c3aed44);
    }

    .timer-ring-bg { fill: none; stroke: var(--border); stroke-width: 6; }
    .timer-ring-progress {
      fill: none;
      stroke: url(#ringGradient);
      stroke-width: 6;
      stroke-linecap: round;
      transition: stroke-dashoffset 1s linear;
    }

    .timer-display {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
    }

    .timer-time {
      font-size: 52px;
      font-weight: 800;
      letter-spacing: -2px;
      line-height: 1;
      background: linear-gradient(135deg, var(--text-primary), var(--primary-light));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      transition: all 0.3s;
    }

    .timer-phase-label {
      font-size: 11px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-top: 6px;
      font-weight: 600;
    }

    /* Timer controls */
    .timer-controls {
      display: flex;
      gap: 12px;
      justify-content: center;
      align-items: center;
    }

    .btn-control {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--bg-panel);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }

    .btn-control:hover {
      border-color: var(--primary-light);
      color: var(--text-primary);
      transform: scale(1.05);
    }

    .btn-play {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      border: none;
      color: white;
      font-size: 22px;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      box-shadow: 0 4px 24px #7c3aed55;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .btn-play:hover {
      transform: scale(1.08);
      box-shadow: 0 8px 40px #7c3aed77;
    }

    .btn-play:active { transform: scale(0.96); }

    .btn-play.running {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      box-shadow: 0 4px 24px #ef444455;
    }

    /* Session stats */
    .session-stats {
      display: flex;
      gap: 20px;
      justify-content: center;
      margin-top: 24px;
    }

    .stat-item {
      text-align: center;
    }

    .stat-value {
      font-size: 22px;
      font-weight: 800;
      color: var(--primary-light);
    }

    .stat-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 2px;
    }

    .stat-divider {
      width: 1px;
      background: var(--border);
      align-self: stretch;
    }

    /* Chat tab */
    .chat-container {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      overflow: hidden;
      height: 520px;
      display: flex;
      flex-direction: column;
    }

    .chat-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .chat-model-badge {
      font-size: 10px;
      padding: 3px 10px;
      border-radius: 20px;
      border: 1px solid var(--primary);
      color: var(--primary-light);
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    .chat-message {
      display: flex;
      gap: 10px;
      animation: messageIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes messageIn {
      from { opacity: 0; transform: translateY(10px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .chat-message.user { flex-direction: row-reverse; }

    .msg-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }

    .msg-avatar.ai {
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      box-shadow: 0 0 12px #7c3aed44;
    }

    .msg-avatar.user {
      background: linear-gradient(135deg, var(--accent), #d97706);
    }

    .msg-bubble {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 16px;
      font-size: 13.5px;
      line-height: 1.6;
    }

    .msg-bubble.ai {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 4px 16px 16px 16px;
      color: var(--text-primary);
    }

    .msg-bubble.user {
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      border-radius: 16px 4px 16px 16px;
      color: white;
    }

    .msg-bubble code {
      background: rgba(0,0,0,0.3);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }

    .msg-bubble pre {
      background: rgba(0,0,0,0.4);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
      margin-top: 8px;
      font-size: 12px;
      font-family: monospace;
    }

    .msg-meta {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 4px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .chat-input-area {
      padding: 14px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }

    .chat-input {
      flex: 1;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 14px;
      color: var(--text-primary);
      font-size: 13.5px;
      resize: none;
      min-height: 40px;
      max-height: 120px;
      outline: none;
      font-family: inherit;
      transition: border-color 0.2s;
    }

    .chat-input:focus { border-color: var(--primary); }
    .chat-input::placeholder { color: var(--text-muted); }

    .btn-send {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      border: none;
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      flex-shrink: 0;
    }

    .btn-send:hover { transform: scale(1.05); box-shadow: 0 4px 16px #7c3aed44; }
    .btn-send:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Calendar tab */
    .calendar-grid {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      overflow: hidden;
    }

    .calendar-header-row {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
    }

    .cal-day-name {
      padding: 10px 4px;
      text-align: center;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      letter-spacing: 0.5px;
    }

    .calendar-body {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
    }

    .cal-cell {
      padding: 8px 4px;
      text-align: center;
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      min-height: 64px;
      cursor: pointer;
      transition: background 0.2s;
      position: relative;
    }

    .cal-cell:hover { background: var(--bg-hover); }

    .cal-cell.today { background: rgba(124,58,237,0.1); }
    .cal-cell.today .cal-date { color: var(--primary-light); font-weight: 800; }

    .cal-date {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }

    .cal-event {
      font-size: 9px;
      padding: 2px 4px;
      border-radius: 4px;
      background: rgba(124,58,237,0.3);
      color: var(--primary-light);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .cal-event.focus-block {
      background: rgba(124,58,237,0.3);
      color: var(--primary-light);
    }

    .cal-event.meeting {
      background: rgba(245,158,11,0.2);
      color: var(--accent-light);
    }

    /* Kanban/Board tab */
    .kanban-board {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }

    @media (max-width: 600px) {
      .kanban-board { grid-template-columns: 1fr; }
    }

    .kanban-col {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
    }

    .kanban-col-header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .kanban-col-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .kanban-count {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--bg-panel);
      color: var(--text-muted);
    }

    .kanban-cards {
      padding: 10px;
      min-height: 200px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .kanban-card {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      cursor: grab;
      transition: all 0.2s;
      position: relative;
    }

    .kanban-card:hover {
      border-color: var(--primary);
      transform: translateY(-1px);
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }

    .kanban-card:active { cursor: grabbing; }

    .card-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .card-tag {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      background: rgba(124,58,237,0.2);
      color: var(--primary-light);
      display: inline-block;
    }

    .card-tag.design { background: rgba(245,158,11,0.2); color: var(--accent-light); }
    .card-tag.research { background: rgba(16,185,129,0.2); color: #6ee7b7; }

    .kanban-add-btn {
      width: 100%;
      padding: 8px;
      background: transparent;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s;
      margin: 0 0 4px;
    }

    .kanban-add-btn:hover { border-color: var(--primary); color: var(--primary-light); }

    /* Metrics tab */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .metric-card:hover {
      border-color: var(--primary);
      box-shadow: 0 4px 20px rgba(124,58,237,0.1);
    }

    .metric-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      margin-bottom: 10px;
    }

    .metric-value {
      font-size: 28px;
      font-weight: 800;
      line-height: 1;
      margin-bottom: 4px;
    }

    .metric-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .metric-trend {
      font-size: 11px;
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .trend-up { color: var(--success); }
    .trend-down { color: var(--danger); }

    /* Learn tab */
    .learn-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 28px;
      margin-bottom: 12px;
      position: relative;
      overflow: hidden;
    }

    .learn-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
    }

    .learn-card.quote::before { background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .learn-card.language::before { background: linear-gradient(90deg, var(--success), #34d399); }
    .learn-card.health::before { background: linear-gradient(90deg, #f43f5e, #fb7185); }

    .learn-tag {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 10px;
    }

    .learn-content {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.6;
    }

    .learn-author {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 10px;
      font-style: italic;
    }

    /* Sidebar */
    .sidebar {
      border-left: 1px solid var(--border);
      background: var(--bg-card);
      display: flex;
      flex-direction: column;
      gap: 0;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    .sidebar-section {
      padding: 20px;
      border-bottom: 1px solid var(--border);
    }

    .sidebar-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .sidebar-title i {
      color: var(--primary-light);
      font-size: 10px;
    }

    /* Upcoming events */
    .event-item {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }

    .event-item:last-child { border-bottom: none; }

    .event-time {
      font-size: 11px;
      font-weight: 700;
      color: var(--primary-light);
      min-width: 40px;
      padding-top: 2px;
    }

    .event-title {
      font-size: 13px;
      color: var(--text-primary);
      font-weight: 500;
    }

    .event-type {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    /* Integration status */
    .integration-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
    }

    .integration-info {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .integration-icon {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }

    .integration-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .integration-status {
      font-size: 10px;
      color: var(--text-muted);
    }

    .connect-btn {
      font-size: 10px;
      padding: 4px 10px;
      border-radius: 8px;
      border: 1px solid var(--primary);
      background: transparent;
      color: var(--primary-light);
      cursor: pointer;
      transition: all 0.2s;
    }

    .connect-btn:hover {
      background: var(--primary);
      color: white;
    }

    .connected-badge {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 6px var(--success);
    }

    /* Premium section */
    .premium-card {
      background: linear-gradient(135deg, rgba(124,58,237,0.15), rgba(245,158,11,0.08));
      border: 1px solid rgba(124,58,237,0.3);
      border-radius: 16px;
      padding: 16px;
      position: relative;
      overflow: hidden;
    }

    .premium-card::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -50%;
      width: 100%;
      height: 100%;
      background: radial-gradient(circle, rgba(245,158,11,0.1) 0%, transparent 70%);
    }

    .premium-title {
      font-size: 13px;
      font-weight: 800;
      color: var(--accent-light);
      margin-bottom: 6px;
    }

    .premium-desc {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: 12px;
    }

    .premium-features {
      list-style: none;
      margin-bottom: 14px;
    }

    .premium-features li {
      font-size: 11px;
      color: var(--text-secondary);
      padding: 2px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .premium-features li::before {
      content: '✦';
      color: var(--accent);
      font-size: 8px;
    }

    .btn-upgrade {
      width: 100%;
      padding: 10px;
      background: linear-gradient(135deg, var(--accent), #d97706);
      border: none;
      border-radius: 10px;
      color: #1a1a1a;
      font-weight: 800;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      letter-spacing: 0.5px;
    }

    .btn-upgrade:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(245,158,11,0.4);
    }

    /* Tip bubble */
    .tip-bubble {
      position: fixed;
      bottom: 80px;
      right: 24px;
      max-width: 300px;
      background: var(--bg-panel);
      border: 1px solid var(--primary);
      border-radius: 16px;
      padding: 14px 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.4), 0 0 20px #7c3aed33;
      z-index: 1000;
      animation: tipIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes tipIn {
      from { opacity: 0; transform: translateY(20px) scale(0.9); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes tipOut {
      from { opacity: 1; transform: translateY(0) scale(1); }
      to { opacity: 0; transform: translateY(10px) scale(0.95); }
    }

    .tip-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .tip-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--primary-light);
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .tip-close {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0;
      transition: color 0.2s;
    }

    .tip-close:hover { color: var(--text-primary); }

    .tip-text {
      font-size: 13px;
      color: var(--text-primary);
      line-height: 1.6;
    }

    /* Music controls */
    .music-player {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 12px;
    }

    .music-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }

    .music-info { flex: 1; min-width: 0; }

    .music-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .music-sub {
      font-size: 10px;
      color: var(--text-muted);
    }

    .music-controls { display: flex; gap: 6px; align-items: center; }

    .music-btn {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: var(--bg-card);
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      transition: all 0.2s;
    }

    .music-btn:hover { color: var(--text-primary); background: var(--border); }
    .music-btn.active { color: var(--primary-light); }

    /* Typing indicator */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 10px 14px;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 4px 16px 16px 16px;
      width: fit-content;
    }

    .typing-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--primary-light);
      animation: typingDot 1.4s ease-in-out infinite;
    }

    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typingDot {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
      30% { transform: translateY(-6px); opacity: 1; }
    }

    /* Celebration overlay */
    .celebration-message {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      z-index: 10000;
      pointer-events: none;
      animation: celebrationMsg 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }

    @keyframes celebrationMsg {
      from { opacity: 0; transform: translate(-50%, -60%) scale(0.8); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    .celebration-text {
      font-size: 22px;
      font-weight: 800;
      color: var(--text-primary);
      text-shadow: 0 0 40px var(--primary);
      max-width: 400px;
      line-height: 1.4;
      padding: 24px 32px;
      background: rgba(10,10,15,0.85);
      backdrop-filter: blur(20px);
      border: 1px solid var(--primary);
      border-radius: 20px;
      box-shadow: var(--glow-purple);
    }

    /* Ambient modes */
    .ambient-selector {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .ambient-btn {
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .ambient-btn:hover { border-color: var(--primary-light); color: var(--text-primary); }
    .ambient-btn.active { background: rgba(124,58,237,0.2); border-color: var(--primary); color: var(--primary-light); }

    /* Loading shimmer */
    .shimmer {
      background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-hover) 50%, var(--bg-card) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 6px;
    }

    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    /* Responsive */
    @media (max-width: 768px) {
      .timer-card { padding: 24px 16px; }
      .timer-time { font-size: 40px; }
      .timer-ring-container { width: 180px; height: 180px; }
      .metrics-grid { grid-template-columns: 1fr 1fr; }
      .tab-btn { font-size: 10px; padding: 6px 8px; }
    }

    /* Pulse animation for running timer */
    @keyframes timerPulse {
      0%, 100% { text-shadow: 0 0 20px rgba(124,58,237,0); }
      50% { text-shadow: 0 0 30px rgba(124,58,237,0.6), 0 0 60px rgba(124,58,237,0.3); }
    }

    .timer-running .timer-time {
      animation: timerPulse 2s ease-in-out infinite;
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(6px);
      z-index: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 32px;
      max-width: 480px;
      width: 90%;
      animation: modalIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes modalIn {
      from { opacity: 0; transform: scale(0.9) translateY(20px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }

    .input-field {
      width: 100%;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      color: var(--text-primary);
      font-size: 13.5px;
      outline: none;
      font-family: inherit;
      transition: border-color 0.2s;
      margin-bottom: 10px;
    }
    .input-field:focus { border-color: var(--primary); }
    .input-field::placeholder { color: var(--text-muted); }

    .btn-primary {
      padding: 10px 20px;
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      border: none;
      border-radius: 10px;
      color: white;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 20px #7c3aed44; }

    .btn-ghost {
      padding: 10px 20px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text-secondary);
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-ghost:hover { border-color: var(--primary); color: var(--text-primary); }
  `
}

function getAppShell(): string {
  return `
    <!-- Header -->
    <header class="flowstate-header">
      <div class="logo">
        <div class="logo-icon">⚡</div>
        <div>
          <div class="logo-text">FLOWSTATE</div>
          <div class="logo-subtitle">Intelligent Workspace</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div id="session-indicator" style="display:none;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;background:rgba(124,58,237,0.15);border:1px solid rgba(124,58,237,0.3)">
          <div style="width:7px;height:7px;border-radius:50%;background:#7c3aed;animation:logoPulse 2s infinite"></div>
          <span style="font-size:11px;font-weight:700;color:#a78bfa">IN FLOW</span>
        </div>
        <button id="settings-btn" class="btn-control" onclick="openSettings()" title="Settings">
          <i class="fas fa-cog"></i>
        </button>
        <button class="btn-control" onclick="openPremiumModal()" title="Upgrade" style="border-color:rgba(245,158,11,0.4);color:#fbbf24">
          <i class="fas fa-crown"></i>
        </button>
      </div>
    </header>

    <!-- Main layout -->
    <div class="main-layout">
      <!-- Center: Timer + Tabs -->
      <div class="timer-section">

        <!-- Tab navigation -->
        <nav class="tab-nav">
          <button class="tab-btn active" onclick="switchTab('focus')">
            <i class="fas fa-circle-dot"></i> Focus
          </button>
          <button class="tab-btn" onclick="switchTab('chat')">
            <i class="fas fa-bolt"></i> Chat
          </button>
          <button class="tab-btn" onclick="switchTab('calendar')">
            <i class="fas fa-calendar"></i> Calendar
          </button>
          <button class="tab-btn" onclick="switchTab('board')">
            <i class="fas fa-columns"></i> Board
          </button>
          <button class="tab-btn" onclick="switchTab('metrics')">
            <i class="fas fa-chart-line"></i> Metrics
          </button>
          <button class="tab-btn" onclick="switchTab('learn')">
            <i class="fas fa-sparkles"></i> Learn
          </button>
        </nav>

        <!-- Tab content -->
        <div class="tab-content">

          <!-- FOCUS TAB -->
          <div id="tab-focus" class="tab-panel active">
            <div id="timer-card" class="timer-card">
              <!-- Phase selector -->
              <div class="phase-selector">
                <button class="phase-btn active" onclick="setPhase('focus',25)" id="phase-focus">Focus</button>
                <button class="phase-btn break-btn" onclick="setPhase('short_break',5)" id="phase-short">Short Break</button>
                <button class="phase-btn break-btn" onclick="setPhase('long_break',15)" id="phase-long">Long Break</button>
              </div>

              <!-- Timer ring -->
              <div class="timer-ring-container">
                <svg class="timer-ring-svg" width="220" height="220" viewBox="0 0 220 220">
                  <defs>
                    <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" style="stop-color:#7c3aed"/>
                      <stop offset="100%" style="stop-color:#f59e0b"/>
                    </linearGradient>
                    <linearGradient id="ringGradientBreak" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" style="stop-color:#10b981"/>
                      <stop offset="100%" style="stop-color:#34d399"/>
                    </linearGradient>
                  </defs>
                  <circle class="timer-ring-bg" cx="110" cy="110" r="100"/>
                  <circle class="timer-ring-progress" id="timer-ring" cx="110" cy="110" r="100"
                    stroke-dasharray="628.3" stroke-dashoffset="0"/>
                </svg>
                <div class="timer-display">
                  <div class="timer-time" id="timer-display">25:00</div>
                  <div class="timer-phase-label" id="phase-label">FOCUS</div>
                </div>
              </div>

              <!-- Controls -->
              <div class="timer-controls">
                <button class="btn-control" onclick="resetTimer()" title="Reset">
                  <i class="fas fa-rotate-left"></i>
                </button>
                <button class="btn-play" id="play-btn" onclick="toggleTimer()">
                  <i class="fas fa-play" id="play-icon"></i>
                </button>
                <button class="btn-control" onclick="skipSession()" title="Skip">
                  <i class="fas fa-forward-step"></i>
                </button>
              </div>

              <!-- Session stats -->
              <div class="session-stats">
                <div class="stat-item">
                  <div class="stat-value" id="stat-sessions">0</div>
                  <div class="stat-label">Sessions</div>
                </div>
                <div class="stat-divider"></div>
                <div class="stat-item">
                  <div class="stat-value" id="stat-focus-time">0m</div>
                  <div class="stat-label">Focus Time</div>
                </div>
                <div class="stat-divider"></div>
                <div class="stat-item">
                  <div class="stat-value" id="stat-streak">🔥 0</div>
                  <div class="stat-label">Streak</div>
                </div>
              </div>
            </div>

            <!-- Ambient & Music -->
            <div style="width:100%;margin-top:12px">
              <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px;display:flex;align-items:center;gap:6px">
                <i class="fas fa-wave-square" style="color:var(--primary-light)"></i> AMBIENT MODE
              </div>
              <div class="ambient-selector">
                <button class="ambient-btn active" onclick="setAmbient(this,'none')">🔇 Silence</button>
                <button class="ambient-btn" onclick="setAmbient(this,'lofi')">🎵 Lo-Fi</button>
                <button class="ambient-btn" onclick="setAmbient(this,'rain')">🌧️ Rain</button>
                <button class="ambient-btn" onclick="setAmbient(this,'forest')">🌲 Forest</button>
                <button class="ambient-btn" onclick="setAmbient(this,'space')">🌌 Deep Space</button>
                <button class="ambient-btn" onclick="setAmbient(this,'cafe')">☕ Café</button>
              </div>
            </div>
          </div>

          <!-- CHAT TAB -->
          <div id="tab-chat" class="tab-panel">
            <div class="chat-container">
              <div class="chat-header">
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="width:8px;height:8px;border-radius:50%;background:var(--success);box-shadow:0 0 8px var(--success)"></div>
                  <span style="font-size:13px;font-weight:600">FlowState AI</span>
                  <span style="font-size:10px;color:var(--text-muted)">Multi-model</span>
                </div>
                <div class="chat-model-badge" id="model-badge">GPT-4o-mini</div>
              </div>
              <div class="chat-messages" id="chat-messages">
                <div class="chat-message">
                  <div class="msg-avatar ai">⚡</div>
                  <div>
                    <div class="msg-bubble ai">I'm FlowState AI — your intelligent work companion. I route your questions to the right model automatically.<br><br>Code debugging goes to Claude. Creative work to GPT-4o. Quick answers stay local. Long analysis? Gemini's got the context.<br><br>What are we working on?</div>
                    <div class="msg-meta"><i class="fas fa-brain"></i> Auto-routing active</div>
                  </div>
                </div>
              </div>
              <div class="chat-input-area">
                <textarea class="chat-input" id="chat-input" placeholder="Ask anything — debug code, write copy, generate an image, analyze data..." rows="1"
                  onkeydown="handleChatKey(event)" oninput="autoResize(this)"></textarea>
                <button class="btn-send" onclick="sendMessage()" id="send-btn">
                  <i class="fas fa-paper-plane"></i>
                </button>
              </div>
            </div>
          </div>

          <!-- CALENDAR TAB -->
          <div id="tab-calendar" class="tab-panel">
            <div class="calendar-grid">
              <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
                <div style="display:flex;align-items:center;gap:10px">
                  <button class="btn-control" style="width:32px;height:32px;font-size:12px" onclick="prevMonth()">
                    <i class="fas fa-chevron-left"></i>
                  </button>
                  <span style="font-size:14px;font-weight:700" id="cal-month-label">April 2026</span>
                  <button class="btn-control" style="width:32px;height:32px;font-size:12px" onclick="nextMonth()">
                    <i class="fas fa-chevron-right"></i>
                  </button>
                </div>
                <button class="btn-primary" style="font-size:11px;padding:6px 14px" onclick="blockFocusTime()">
                  <i class="fas fa-lock"></i> Block Focus Time
                </button>
              </div>
              <div class="calendar-header-row">
                <div class="cal-day-name">Sun</div>
                <div class="cal-day-name">Mon</div>
                <div class="cal-day-name">Tue</div>
                <div class="cal-day-name">Wed</div>
                <div class="cal-day-name">Thu</div>
                <div class="cal-day-name">Fri</div>
                <div class="cal-day-name">Sat</div>
              </div>
              <div class="calendar-body" id="cal-body">
                <!-- Rendered by JS -->
              </div>
            </div>
            <div style="margin-top:14px">
              <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:10px">UPCOMING TODAY</div>
              <div id="upcoming-events">
                <!-- Rendered by JS -->
              </div>
            </div>
          </div>

          <!-- BOARD TAB -->
          <div id="tab-board" class="tab-panel">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div>
                <div style="font-size:15px;font-weight:700">Project Board</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Syncs with Notion when connected</div>
              </div>
              <button class="btn-primary" style="font-size:11px;padding:7px 14px" onclick="addCard()">
                <i class="fas fa-plus"></i> Add Card
              </button>
            </div>
            <div class="kanban-board" id="kanban-board">
              <!-- Rendered by JS -->
            </div>
          </div>

          <!-- METRICS TAB -->
          <div id="tab-metrics" class="tab-panel">
            <div style="margin-bottom:14px">
              <div style="font-size:15px;font-weight:700">Your Numbers</div>
              <div style="font-size:11px;color:var(--text-muted)">The data that matters, when it matters</div>
            </div>
            <div class="metrics-grid" id="metrics-grid">
              <!-- Rendered by JS -->
            </div>
            <div style="margin-top:16px;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:16px">
              <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:12px">FOCUS CHART — TODAY</div>
              <canvas id="focus-chart" style="max-height:160px"></canvas>
            </div>
          </div>

          <!-- LEARN TAB -->
          <div id="tab-learn" class="tab-panel">
            <div style="margin-bottom:14px">
              <div style="font-size:15px;font-weight:700">Learn & Restore</div>
              <div style="font-size:11px;color:var(--text-muted)">Surfaced when you need it, not when you don't</div>
            </div>
            <div id="learn-content">
              <!-- Rendered by JS -->
            </div>
          </div>

        </div>
      </div>

      <!-- Sidebar -->
      <aside class="sidebar">
        <!-- Upcoming events -->
        <div class="sidebar-section">
          <div class="sidebar-title"><i class="fas fa-calendar-check"></i> COMING UP</div>
          <div id="sidebar-events">
            <div class="event-item">
              <div class="event-time">9:00</div>
              <div>
                <div class="event-title">Deep Work Block</div>
                <div class="event-type">Focus Session · 90 min</div>
              </div>
            </div>
            <div class="event-item">
              <div class="event-time">11:00</div>
              <div>
                <div class="event-title">Team Standup</div>
                <div class="event-type">Meeting · 30 min</div>
              </div>
            </div>
            <div class="event-item">
              <div class="event-time">2:00</div>
              <div>
                <div class="event-title">Product Review</div>
                <div class="event-type">Meeting · 60 min</div>
              </div>
            </div>
            <div class="event-item">
              <div class="event-time">4:30</div>
              <div>
                <div class="event-title">Focus Block (Auto)</div>
                <div class="event-type">FlowState Protected · 90 min</div>
              </div>
            </div>
          </div>
        </div>

        <!-- AI Insight -->
        <div class="sidebar-section" id="behavior-insight-section">
          <div class="sidebar-title"><i class="fas fa-brain"></i> BEHAVIOR INSIGHT</div>
          <div id="behavior-insight" style="font-size:12px;color:var(--text-secondary);line-height:1.6">
            Start your first session and FlowState begins learning your patterns.
          </div>
        </div>

        <!-- Integrations -->
        <div class="sidebar-section">
          <div class="sidebar-title"><i class="fas fa-plug"></i> INTEGRATIONS</div>
          <div id="integrations-list">
            <div class="integration-item">
              <div class="integration-info">
                <div class="integration-icon" style="background:rgba(66,133,244,0.15)">📅</div>
                <div>
                  <div class="integration-name">Google Calendar</div>
                  <div class="integration-status">Not connected</div>
                </div>
              </div>
              <button class="connect-btn" onclick="connectIntegration('google_calendar')">Connect</button>
            </div>
            <div class="integration-item">
              <div class="integration-info">
                <div class="integration-icon" style="background:rgba(255,255,255,0.08)">📋</div>
                <div>
                  <div class="integration-name">Notion</div>
                  <div class="integration-status">Not connected</div>
                </div>
              </div>
              <button class="connect-btn" onclick="connectIntegration('notion')">Connect</button>
            </div>
            <div class="integration-item">
              <div class="integration-info">
                <div class="integration-icon" style="background:rgba(138,180,248,0.15)">📓</div>
                <div>
                  <div class="integration-name">NotebookLM</div>
                  <div class="integration-status">Not connected</div>
                </div>
              </div>
              <button class="connect-btn" onclick="connectIntegration('notebooklm')">Connect</button>
            </div>
          </div>
        </div>

        <!-- Ambient music -->
        <div class="sidebar-section">
          <div class="sidebar-title"><i class="fas fa-music"></i> AMBIENT SOUND</div>
          <div class="music-player">
            <div class="music-icon">🎵</div>
            <div class="music-info">
              <div class="music-title" id="music-title">Lo-Fi Focus</div>
              <div class="music-sub" id="music-sub">Silence selected</div>
            </div>
            <div class="music-controls">
              <button class="music-btn" onclick="prevTrack()"><i class="fas fa-backward-step"></i></button>
              <button class="music-btn active" id="music-play-btn" onclick="toggleMusic()"><i class="fas fa-play"></i></button>
              <button class="music-btn" onclick="nextTrack()"><i class="fas fa-forward-step"></i></button>
            </div>
          </div>
        </div>

        <!-- Premium CTA -->
        <div class="sidebar-section">
          <div class="premium-card">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <span style="font-size:20px">✦</span>
              <div class="premium-title">Behavior System</div>
            </div>
            <div class="premium-desc">The layer that thinks about you so you don't have to think about the system.</div>
            <ul class="premium-features">
              <li>Cross-source intelligence aggregation</li>
              <li>Predictive focus scheduling</li>
              <li>Health + finance + language sync</li>
              <li>AI tip bubbles with real context</li>
              <li>NotebookLM session context</li>
            </ul>
            <button class="btn-upgrade" onclick="openPremiumModal()">Unlock FlowState Pro →</button>
          </div>
        </div>
      </aside>
    </div>
  `
}

function getAppScript(): string {
  return `
    // ═══════════════════════════════════════════════════
    // FLOWSTATE CLIENT — Action Layer
    // Executes intents declared server-side.
    // Does not contain routing logic or decisions.
    // ═══════════════════════════════════════════════════

    // ── State ────────────────────────────────────────
    const state = {
      timer: {
        remaining: 25 * 60,
        total: 25 * 60,
        running: false,
        interval: null,
        phase: 'focus',
        sessionNumber: 0,
        totalFocusSeconds: 0,
        startedAt: null,
        idleSeconds: 0,
      },
      chat: {
        messages: [],
        loading: false,
      },
      calendar: {
        year: 2026,
        month: 3, // April (0-indexed)
        events: {
          '2026-04-02': [{ title: 'Deep Work', type: 'focus-block' }],
          '2026-04-07': [{ title: 'Team Review', type: 'meeting' }],
          '2026-04-14': [{ title: 'Sprint Planning', type: 'meeting' }],
          '2026-04-15': [{ title: 'Focus Block', type: 'focus-block' }],
          '2026-04-21': [{ title: 'Retrospective', type: 'meeting' }],
          '2026-04-28': [{ title: 'Deep Work', type: 'focus-block' }],
        }
      },
      kanban: {
        columns: {
          todo: [
            { id: '1', title: 'Design system tokens', tag: 'design' },
            { id: '2', title: 'Write API documentation', tag: 'dev' },
            { id: '3', title: 'User research synthesis', tag: 'research' },
          ],
          inprogress: [
            { id: '4', title: 'FlowState timer logic', tag: 'dev' },
            { id: '5', title: 'AI routing integration', tag: 'dev' },
          ],
          done: [
            { id: '6', title: 'Project scaffolding', tag: 'dev' },
            { id: '7', title: 'Color system setup', tag: 'design' },
          ]
        }
      },
      user: {
        tier: 'free',
        sessions: JSON.parse(localStorage.getItem('fs_sessions') || '[]'),
        streak: parseInt(localStorage.getItem('fs_streak') || '0'),
      },
      ambient: 'none',
      tipShown: false,
      lastTipTime: 0,
      focusChart: null,
    };

    // ── Tab Switching ─────────────────────────────────
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach((b, i) => {
        const tabs = ['focus','chat','calendar','board','metrics','learn'];
        b.classList.toggle('active', tabs[i] === tab);
      });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('tab-' + tab);
      if (panel) panel.classList.add('active');

      if (tab === 'calendar') renderCalendar();
      if (tab === 'board') renderKanban();
      if (tab === 'metrics') renderMetrics();
      if (tab === 'learn') renderLearn();
    }

    // ── Timer ─────────────────────────────────────────
    function setPhase(phase, minutes) {
      if (state.timer.running) return;
      state.timer.phase = phase;
      state.timer.total = minutes * 60;
      state.timer.remaining = minutes * 60;
      updateTimerDisplay();
      updateRing();

      document.querySelectorAll('.phase-btn').forEach(b => b.classList.remove('active'));
      const phaseMap = { focus: 'phase-focus', short_break: 'phase-short', long_break: 'phase-long' };
      const btn = document.getElementById(phaseMap[phase]);
      if (btn) btn.classList.add('active');

      const card = document.getElementById('timer-card');
      if (phase === 'focus') {
        card.classList.remove('break-active');
        card.classList.add('focus-active');
        document.getElementById('phase-label').textContent = 'FOCUS';
      } else {
        card.classList.remove('focus-active');
        card.classList.add('break-active');
        document.getElementById('phase-label').textContent = phase === 'short_break' ? 'SHORT BREAK' : 'LONG BREAK';
      }
    }

    function toggleTimer() {
      if (state.timer.running) {
        pauseTimer();
      } else {
        startTimer();
      }
    }

    function startTimer() {
      state.timer.running = true;
      state.timer.startedAt = Date.now();
      const btn = document.getElementById('play-btn');
      const icon = document.getElementById('play-icon');
      btn.classList.add('running');
      icon.className = 'fas fa-pause';
      document.getElementById('session-indicator').style.display = 'flex';
      document.getElementById('timer-card').classList.add('timer-running');

      state.timer.interval = setInterval(() => {
        state.timer.remaining--;
        if (state.timer.phase === 'focus') {
          state.timer.totalFocusSeconds++;
        }

        updateTimerDisplay();
        updateRing();
        checkTipBubble();
        saveSession();

        if (state.timer.remaining <= 0) {
          sessionComplete();
        }
      }, 1000);
    }

    function pauseTimer() {
      state.timer.running = false;
      clearInterval(state.timer.interval);
      const btn = document.getElementById('play-btn');
      const icon = document.getElementById('play-icon');
      btn.classList.remove('running');
      icon.className = 'fas fa-play';
      document.getElementById('timer-card').classList.remove('timer-running');
    }

    function resetTimer() {
      pauseTimer();
      state.timer.remaining = state.timer.total;
      state.timer.startedAt = null;
      document.getElementById('session-indicator').style.display = 'none';
      updateTimerDisplay();
      updateRing();
    }

    function skipSession() {
      if (state.timer.running) sessionComplete();
    }

    function sessionComplete() {
      pauseTimer();
      document.getElementById('session-indicator').style.display = 'none';

      if (state.timer.phase === 'focus') {
        state.timer.sessionNumber++;
        state.timer.totalFocusSeconds += state.timer.remaining; // count remainder
        document.getElementById('stat-sessions').textContent = state.timer.sessionNumber;
        document.getElementById('stat-focus-time').textContent = Math.round(state.timer.totalFocusSeconds / 60) + 'm';
        state.user.streak++;
        document.getElementById('stat-streak').textContent = '🔥 ' + state.user.streak;
        localStorage.setItem('fs_streak', state.user.streak);
        triggerCelebration();
      }

      // Auto-switch to break
      if (state.timer.phase === 'focus') {
        const nextPhase = state.timer.sessionNumber % 4 === 0 ? 'long_break' : 'short_break';
        const nextMin = nextPhase === 'long_break' ? 15 : 5;
        setTimeout(() => setPhase(nextPhase, nextMin), 2500);
      } else {
        setTimeout(() => setPhase('focus', 25), 1500);
      }

      updateBehaviorInsight();
    }

    function updateTimerDisplay() {
      const m = Math.floor(state.timer.remaining / 60);
      const s = state.timer.remaining % 60;
      document.getElementById('timer-display').textContent =
        String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }

    function updateRing() {
      const ring = document.getElementById('timer-ring');
      const circumference = 628.3;
      const progress = state.timer.remaining / state.timer.total;
      ring.style.strokeDashoffset = circumference * (1 - progress);

      if (state.timer.phase !== 'focus') {
        ring.setAttribute('stroke', 'url(#ringGradientBreak)');
      } else {
        ring.setAttribute('stroke', 'url(#ringGradient)');
      }
    }

    // ── Chat ──────────────────────────────────────────
    function handleChatKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }

    function autoResize(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    async function sendMessage() {
      const input = document.getElementById('chat-input');
      const msg = input.value.trim();
      if (!msg || state.chat.loading) return;

      addChatMessage('user', msg);
      input.value = '';
      input.style.height = 'auto';

      state.chat.loading = true;
      document.getElementById('send-btn').disabled = true;

      // Typing indicator
      const typingId = addTypingIndicator();

      try {
        const session = {
          phase: state.timer.phase,
          duration: state.timer.total - state.timer.remaining,
          sessionNumber: state.timer.sessionNumber,
          totalFocusMinutes: state.timer.totalFocusSeconds / 60,
          idleSeconds: state.timer.idleSeconds,
          startedAt: state.timer.startedAt || Date.now(),
        };

        const res = await axios.post('/api/chat', { message: msg, session });
        removeTypingIndicator(typingId);

        const { response, model, capability, rationale } = res.data;
        document.getElementById('model-badge').textContent = model.split('/').pop() || model;

        addChatMessage('ai', response, model, capability);
      } catch (err) {
        removeTypingIndicator(typingId);
        addChatMessage('ai', "I'm running in offline mode right now. Add your API keys in Settings to enable full AI routing.", 'offline');
      }

      state.chat.loading = false;
      document.getElementById('send-btn').disabled = false;
    }

    function addChatMessage(role, text, model, capability) {
      const container = document.getElementById('chat-messages');
      const div = document.createElement('div');
      div.className = 'chat-message ' + role;

      const formattedText = formatMessage(text);
      const capIcon = { code: '🔧', creative: '🎨', analysis: '🔬', quick: '⚡', vision: '👁️', long_form: '📝' };

      if (role === 'ai') {
        div.innerHTML = \`
          <div class="msg-avatar ai">⚡</div>
          <div>
            <div class="msg-bubble ai">\${formattedText}</div>
            \${model ? \`<div class="msg-meta"><i class="fas fa-microchip"></i> \${model} \${capability ? \`· \${capIcon[capability] || ''} \${capability}\` : ''}</div>\` : ''}
          </div>
        \`;
      } else {
        div.innerHTML = \`
          <div class="msg-avatar user">👤</div>
          <div>
            <div class="msg-bubble user">\${text}</div>
          </div>
        \`;
      }

      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    function formatMessage(text) {
      if (!text) return '';
      let t = text
        .replace(new RegExp('&', 'g'), '&amp;')
        .replace(new RegExp('<', 'g'), '&lt;')
        .replace(new RegExp('>', 'g'), '&gt;');
      // Code blocks (triple backtick)
      t = t.replace(new RegExp('\x60\x60\x60(\\w+)?\\n?([\\s\\S]*?)\x60\x60\x60', 'g'), '<pre><code>$2</code></pre>');
      // Inline code (single backtick)
      t = t.replace(new RegExp('\x60([^\x60]+)\x60', 'g'), '<code>$1</code>');
      // Bold (using RegExp constructor to avoid template literal issues)
      t = t.replace(new RegExp('\\*\\*([^*]+)\\*\\*', 'g'), '<strong>$1</strong>');
      // Italic
      t = t.replace(new RegExp('\\*([^*\\n]+)\\*', 'g'), '<em>$1</em>');
      // Newlines
      t = t.replace(new RegExp('\\n', 'g'), '<br>');
      return t;
    }

    function addTypingIndicator() {
      const container = document.getElementById('chat-messages');
      const id = 'typing-' + Date.now();
      const div = document.createElement('div');
      div.className = 'chat-message';
      div.id = id;
      div.innerHTML = \`
        <div class="msg-avatar ai">⚡</div>
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      \`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return id;
    }

    function removeTypingIndicator(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }

    // ── Calendar ──────────────────────────────────────
    function renderCalendar() {
      const { year, month, events } = state.calendar;
      const today = new Date();
      const firstDay = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

      document.getElementById('cal-month-label').textContent = monthNames[month] + ' ' + year;

      const body = document.getElementById('cal-body');
      body.innerHTML = '';

      // Empty cells
      for (let i = 0; i < firstDay; i++) {
        const cell = document.createElement('div');
        cell.className = 'cal-cell';
        cell.style.background = 'transparent';
        body.appendChild(cell);
      }

      for (let d = 1; d <= daysInMonth; d++) {
        const cell = document.createElement('div');
        const dateStr = year + '-' + String(month+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
        cell.className = 'cal-cell' + (isToday ? ' today' : '');

        let html = \`<div class="cal-date">\${d}</div>\`;
        if (events[dateStr]) {
          events[dateStr].forEach(ev => {
            html += \`<div class="cal-event \${ev.type}">\${ev.title}</div>\`;
          });
        }
        cell.innerHTML = html;
        body.appendChild(cell);
      }
    }

    function prevMonth() {
      state.calendar.month--;
      if (state.calendar.month < 0) { state.calendar.month = 11; state.calendar.year--; }
      renderCalendar();
    }

    function nextMonth() {
      state.calendar.month++;
      if (state.calendar.month > 11) { state.calendar.month = 0; state.calendar.year++; }
      renderCalendar();
    }

    function blockFocusTime() {
      const today = new Date();
      const dateStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      if (!state.calendar.events[dateStr]) state.calendar.events[dateStr] = [];
      state.calendar.events[dateStr].push({ title: 'FlowState Focus', type: 'focus-block' });
      renderCalendar();
      showNotification('Focus block added to today ✓', 'success');
    }

    // ── Kanban Board ──────────────────────────────────
    function renderKanban() {
      const board = document.getElementById('kanban-board');
      const cols = {
        todo: { label: 'To Do', color: 'var(--text-muted)' },
        inprogress: { label: 'In Progress', color: 'var(--accent-light)' },
        done: { label: 'Done', color: 'var(--success)' }
      };

      board.innerHTML = Object.entries(cols).map(([colId, col]) => {
        const cards = state.kanban.columns[colId] || [];
        return \`
          <div class="kanban-col" ondragover="allowDrop(event)" ondrop="dropCard(event, '\${colId}')">
            <div class="kanban-col-header">
              <div class="kanban-col-title" style="color:\${col.color}">\${col.label}</div>
              <div class="kanban-count">\${cards.length}</div>
            </div>
            <div class="kanban-cards" id="col-\${colId}">
              \${cards.map(card => \`
                <div class="kanban-card" draggable="true"
                  ondragstart="dragStart(event, '\${card.id}', '\${colId}')"
                  id="card-\${card.id}">
                  <div class="card-title">\${card.title}</div>
                  <span class="card-tag \${card.tag}">\${card.tag}</span>
                </div>
              \`).join('')}
              <button class="kanban-add-btn" onclick="addCardToCol('\${colId}')">
                <i class="fas fa-plus"></i> Add card
              </button>
            </div>
          </div>
        \`;
      }).join('');
    }

    let draggedCard = null;
    let draggedFrom = null;

    function dragStart(e, cardId, colId) {
      draggedCard = cardId;
      draggedFrom = colId;
      e.dataTransfer.effectAllowed = 'move';
    }

    function allowDrop(e) { e.preventDefault(); }

    function dropCard(e, targetCol) {
      e.preventDefault();
      if (!draggedCard || draggedFrom === targetCol) return;

      const card = state.kanban.columns[draggedFrom].find(c => c.id === draggedCard);
      if (!card) return;

      state.kanban.columns[draggedFrom] = state.kanban.columns[draggedFrom].filter(c => c.id !== draggedCard);
      state.kanban.columns[targetCol].push(card);

      draggedCard = null;
      draggedFrom = null;
      renderKanban();
    }

    function addCardToCol(colId) {
      const title = prompt('Card title:');
      if (!title) return;
      const tag = prompt('Tag (dev/design/research):', 'dev') || 'dev';
      const id = Date.now().toString();
      state.kanban.columns[colId].push({ id, title, tag });
      renderKanban();
    }

    function addCard() {
      addCardToCol('todo');
    }

    // ── Metrics ───────────────────────────────────────
    function renderMetrics() {
      const sessions = state.timer.sessionNumber;
      const focusMin = Math.round(state.timer.totalFocusSeconds / 60);

      const metrics = [
        { icon: '⏱️', iconBg: 'rgba(124,58,237,0.2)', value: focusMin + 'm', label: 'Focus Time', trend: '+12% vs yesterday', trendUp: true },
        { icon: '🎯', iconBg: 'rgba(245,158,11,0.2)', value: sessions, label: 'Sessions', trend: 'Today', trendUp: true },
        { icon: '🔥', iconBg: 'rgba(239,68,68,0.2)', value: state.user.streak, label: 'Day Streak', trend: 'Keep going!', trendUp: true },
        { icon: '💧', iconBg: 'rgba(59,130,246,0.2)', value: '6/8', label: 'Hydration', trend: '2 glasses left', trendUp: true },
        { icon: '🚶', iconBg: 'rgba(16,185,129,0.2)', value: '4,230', label: 'Steps', trend: '-800 from goal', trendUp: false },
        { icon: '🧠', iconBg: 'rgba(139,92,246,0.2)', value: '94%', label: 'Focus Score', trend: '+8% this week', trendUp: true },
      ];

      document.getElementById('metrics-grid').innerHTML = metrics.map(m => \`
        <div class="metric-card">
          <div class="metric-icon" style="background:\${m.iconBg}">\${m.icon}</div>
          <div class="metric-value" style="color:var(--primary-light)">\${m.value}</div>
          <div class="metric-label">\${m.label}</div>
          <div class="metric-trend \${m.trendUp ? 'trend-up' : 'trend-down'}">
            <i class="fas fa-arrow-\${m.trendUp ? 'up' : 'down'}"></i> \${m.trend}
          </div>
        </div>
      \`).join('');

      // Focus chart
      renderFocusChart();
    }

    function renderFocusChart() {
      const ctx = document.getElementById('focus-chart');
      if (!ctx) return;

      if (state.focusChart) state.focusChart.destroy();

      const hours = ['8am','9am','10am','11am','12pm','1pm','2pm','3pm','4pm','5pm'];
      const data = [0, 25, 25, 15, 0, 25, 20, 25, 10, 0];

      state.focusChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: hours,
          datasets: [{
            data,
            backgroundColor: data.map(v => v > 20 ? 'rgba(124,58,237,0.7)' : 'rgba(124,58,237,0.25)'),
            borderRadius: 6,
            borderSkipped: false,
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.04)' },
              ticks: { color: '#6b6880', font: { size: 10 } }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.04)' },
              ticks: { color: '#6b6880', font: { size: 10 }, stepSize: 5 },
              max: 30
            }
          }
        }
      });
    }

    // ── Learn tab ─────────────────────────────────────
    function renderLearn() {
      const content = document.getElementById('learn-content');
      content.innerHTML = \`
        <div class="learn-card quote">
          <div class="learn-tag">✦ Daily Wisdom</div>
          <div class="learn-content">"The secret of getting ahead is getting started. The secret of getting started is breaking your complex overwhelming tasks into small manageable ones, and then starting on the first one."</div>
          <div class="learn-author">— Mark Twain</div>
        </div>

        <div class="learn-card language">
          <div class="learn-tag">🇯🇵 Japanese · N5 Vocabulary</div>
          <div class="learn-content">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <div style="font-size:32px;font-weight:800;color:var(--success)">集中</div>
                <div style="font-size:14px;color:var(--text-secondary);margin-top:4px">shūchū — concentration, focus</div>
              </div>
              <button class="btn-primary" style="font-size:11px;padding:6px 12px" onclick="nextCard()">Next →</button>
            </div>
            <div style="margin-top:14px;padding:10px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:10px;font-size:12px;color:var(--text-secondary)">
              <strong style="color:var(--success)">Example:</strong> 仕事に集中しています。<br>
              <em>Shigoto ni shūchū shite imasu.</em><br>
              "I am concentrating on my work."
            </div>
          </div>
        </div>

        <div class="learn-card health">
          <div class="learn-tag" style="color:#fb7185">❤️ Health Insight</div>
          <div class="learn-content" style="font-size:14px">
            The Pomodoro technique was designed around the brain's natural ultradian rhythms — 90-minute cycles of peak focus followed by rest.
          </div>
          <div style="margin-top:12px;font-size:12px;color:var(--text-secondary)">
            Your current session pattern aligns well with these rhythms. The 25-minute blocks prevent cognitive fatigue while maintaining depth. <strong style="color:#fb7185">You're using your brain correctly.</strong>
          </div>
        </div>

        <div class="learn-card" style="background:linear-gradient(135deg,rgba(124,58,237,0.08),rgba(245,158,11,0.05))">
          <div class="learn-tag" style="color:var(--accent-light)">⚡ FlowState Tip</div>
          <div class="learn-content" style="font-size:14px">
            The best time to plan tomorrow is at the end of today's last session.
          </div>
          <div style="margin-top:10px;font-size:12px;color:var(--text-secondary)">
            When you finish your last Pomodoro today, spend 5 minutes capturing your next 3 priorities. Your brain will process them while you sleep — and tomorrow you'll start with clarity instead of searching for momentum.
          </div>
        </div>
      \`;
    }

    function nextCard() {
      showNotification('Next card loaded ✓', 'success');
    }

    // ── Tip Bubbles ───────────────────────────────────
    async function checkTipBubble() {
      if (state.tipShown) return;
      const now = Date.now();
      if (now - state.lastTipTime < 5 * 60 * 1000) return; // 5min cooldown

      const focusMin = state.timer.totalFocusSeconds / 60;

      // Only trigger tips at meaningful moments
      const shouldTrigger =
        (focusMin >= 25 && Math.floor(focusMin) % 25 === 0) ||
        (focusMin >= 45 && Math.floor(focusMin) % 45 === 0) ||
        (state.timer.sessionNumber > 0 && state.timer.sessionNumber % 3 === 0);

      if (!shouldTrigger) return;

      state.lastTipTime = now;
      state.tipShown = true;

      const session = {
        phase: state.timer.phase,
        duration: state.timer.total - state.timer.remaining,
        sessionNumber: state.timer.sessionNumber,
        totalFocusMinutes: focusMin,
        idleSeconds: state.timer.idleSeconds,
        startedAt: state.timer.startedAt || Date.now(),
      };

      try {
        const res = await axios.post('/api/tip', session);
        if (res.data.tip) {
          showTipBubble(res.data.tip, res.data.category);
        }
      } catch {}
    }

    function showTipBubble(text, category) {
      const bubble = document.getElementById('tip-bubble');
      const icons = { posture: '🧘', hydration: '💧', focus: '🎯', debugging: '🔧', celebration: '✨', encouragement: '🔥', break: '☕' };

      bubble.innerHTML = \`
        <div class="tip-header">
          <div class="tip-label">\${icons[category] || '⚡'} FlowState</div>
          <button class="tip-close" onclick="closeTip()">✕</button>
        </div>
        <div class="tip-text">\${text}</div>
      \`;
      bubble.style.display = 'block';

      setTimeout(() => closeTip(), 12000);
    }

    function closeTip() {
      const bubble = document.getElementById('tip-bubble');
      bubble.style.animation = 'tipOut 0.3s ease forwards';
      setTimeout(() => {
        bubble.style.display = 'none';
        bubble.style.animation = '';
        state.tipShown = false;
      }, 300);
    }

    // ── Celebrations ──────────────────────────────────
    async function triggerCelebration() {
      try {
        const session = {
          phase: state.timer.phase,
          duration: state.timer.total,
          sessionNumber: state.timer.sessionNumber,
          totalFocusMinutes: state.timer.totalFocusSeconds / 60,
          idleSeconds: 0,
          startedAt: state.timer.startedAt || Date.now(),
        };
        const res = await axios.post('/api/celebrate', session);
        const intent = res.data;
        showCelebration(intent);
      } catch {
        showCelebration({
          type: 'focus_complete',
          message: 'Session complete. That focus was real. ✦',
          visualIntensity: 'medium',
          durationMs: 3000,
          particle: 'sparks'
        });
      }
    }

    function showCelebration(intent) {
      const canvas = document.getElementById('celebration-canvas');
      const ctx = canvas.getContext('2d');
      canvas.style.display = 'block';
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      // Celebration message
      const msgDiv = document.createElement('div');
      msgDiv.className = 'celebration-message';
      msgDiv.innerHTML = \`<div class="celebration-text">\${intent.message}</div>\`;
      document.body.appendChild(msgDiv);

      // Particle system
      const particles = [];
      const count = intent.visualIntensity === 'full' ? 200 : intent.visualIntensity === 'medium' ? 100 : 40;

      for (let i = 0; i < count; i++) {
        const colors = ['#7c3aed','#a78bfa','#f59e0b','#fbbf24','#10b981','#34d399','#f43f5e','#60a5fa'];
        particles.push({
          x: Math.random() * canvas.width,
          y: canvas.height * 0.4 + Math.random() * canvas.height * 0.2,
          vx: (Math.random() - 0.5) * (intent.visualIntensity === 'full' ? 12 : 6),
          vy: -(Math.random() * 8 + 3),
          color: colors[Math.floor(Math.random() * colors.length)],
          size: Math.random() * (intent.visualIntensity === 'full' ? 8 : 5) + 2,
          life: 1,
          decay: Math.random() * 0.02 + 0.008,
          shape: intent.particle === 'confetti' ? 'rect' : 'circle',
        });
      }

      let startTime = Date.now();
      function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;

        particles.forEach(p => {
          p.vy += 0.15;
          p.vx *= 0.99;
          p.x += p.vx;
          p.y += p.vy;
          p.life -= p.decay;

          if (p.life > 0) {
            alive = true;
            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;

            if (p.shape === 'rect') {
              ctx.fillRect(p.x, p.y, p.size * 1.5, p.size * 0.6);
            } else {
              ctx.beginPath();
              ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        });

        ctx.globalAlpha = 1;
        if (alive && Date.now() - startTime < intent.durationMs + 1000) {
          requestAnimationFrame(animate);
        } else {
          canvas.style.display = 'none';
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          msgDiv.remove();
        }
      }

      animate();
      setTimeout(() => { msgDiv.remove(); }, intent.durationMs);
    }

    // ── Behavior insight ──────────────────────────────
    async function updateBehaviorInsight() {
      try {
        const data = {
          focusMinutes: state.timer.totalFocusSeconds / 60,
          sessionsToday: state.timer.sessionNumber,
          breaksTaken: Math.max(0, state.timer.sessionNumber - 1),
          tipsAcknowledged: 0,
          idleEvents: 0,
          hour: new Date().getHours(),
        };
        const res = await axios.post('/api/insight', data);
        if (res.data.insight) {
          document.getElementById('behavior-insight').textContent = res.data.insight.insight;
        }
      } catch {}
    }

    // ── Ambient ───────────────────────────────────────
    function setAmbient(btn, mode) {
      state.ambient = mode;
      document.querySelectorAll('.ambient-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const labels = {
        none: 'Silence',
        lofi: 'Lo-Fi Focus',
        rain: 'Rainy Day',
        forest: 'Forest Walk',
        space: 'Deep Space',
        cafe: 'Café Paris'
      };

      document.getElementById('music-title').textContent = labels[mode] || mode;
      document.getElementById('music-sub').textContent = mode === 'none' ? 'Silence selected' : 'Ambient mode';
      showNotification('Ambient: ' + (labels[mode] || mode), 'success');
    }

    function toggleMusic() {
      const btn = document.getElementById('music-play-btn');
      const icon = btn.querySelector('i');
      icon.className = icon.className.includes('fa-play') ? 'fas fa-pause' : 'fas fa-play';
    }

    function prevTrack() { showNotification('← Previous track', 'info'); }
    function nextTrack() { showNotification('Next track →', 'info'); }

    // ── Integration Connect ───────────────────────────
    function connectIntegration(id) {
      openModal('Connect Integration', \`
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;line-height:1.6">
          Connecting <strong style="color:var(--text-primary)">\${id.replace(/_/g,' ')}</strong> enables FlowState to read your data and surface the right context at the right moment.
        </p>
        <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:16px;font-size:12px;color:var(--text-muted)">
          <i class="fas fa-lock" style="color:var(--primary-light)"></i> OAuth authentication — we never see your password. You can disconnect at any time.
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn-primary" onclick="simulateConnect('\${id}');closeModal()">Connect with OAuth</button>
          <button class="btn-ghost" onclick="closeModal()">Cancel</button>
        </div>
      \`);
    }

    function simulateConnect(id) {
      showNotification(id.replace(/_/g,' ') + ' connected ✓', 'success');
    }

    // ── Premium modal ─────────────────────────────────
    function openPremiumModal() {
      openModal('Unlock FlowState Pro', \`
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:40px;margin-bottom:8px">✦</div>
          <div style="font-size:18px;font-weight:800;color:var(--accent-light)">FlowState Behavior System</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-top:6px">The layer that thinks about you so you don't have to think about the system.</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px">
          <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:14px">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px">FREE</div>
            <div style="font-size:22px;font-weight:800;color:var(--text-primary)">$0</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Forever</div>
            <ul style="list-style:none;font-size:11px;color:var(--text-secondary)">
              <li style="padding:2px 0">✓ Pomodoro timer</li>
              <li style="padding:2px 0">✓ Basic AI chat</li>
              <li style="padding:2px 0">✓ Manual Kanban</li>
              <li style="padding:2px 0">✓ Local metrics</li>
            </ul>
          </div>
          <div style="background:linear-gradient(135deg,rgba(124,58,237,0.2),rgba(245,158,11,0.1));border:1px solid rgba(124,58,237,0.4);border-radius:12px;padding:14px;position:relative">
            <div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--accent);color:#1a1a1a;font-size:9px;font-weight:800;padding:2px 10px;border-radius:10px;letter-spacing:1px">POPULAR</div>
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:var(--primary-light);margin-bottom:8px">BEHAVIOR</div>
            <div style="font-size:22px;font-weight:800;color:var(--accent-light)">$12<span style="font-size:13px;color:var(--text-muted)">/mo</span></div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Cancel anytime</div>
            <ul style="list-style:none;font-size:11px;color:var(--text-secondary)">
              <li style="padding:2px 0">✦ Everything in Free</li>
              <li style="padding:2px 0">✦ Multi-LLM routing</li>
              <li style="padding:2px 0">✦ All integrations</li>
              <li style="padding:2px 0">✦ AI Tip Bubbles</li>
              <li style="padding:2px 0">✦ Behavior intelligence</li>
              <li style="padding:2px 0">✦ Health + finance sync</li>
            </ul>
          </div>
        </div>

        <button class="btn-upgrade" onclick="closeModal();showNotification('Welcome to FlowState Pro! ✦','success')" style="width:100%;padding:12px;font-size:13px">
          Start 14-day free trial →
        </button>
        <div style="text-align:center;font-size:10px;color:var(--text-muted);margin-top:8px">No credit card required for trial</div>
      \`);
    }

    // ── Settings modal ────────────────────────────────
    function openSettings() {
      openModal('Settings', \`
        <div style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">AI API Keys (Optional)</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;line-height:1.6">Add your own keys to enable full AI routing. Without keys, FlowState uses intelligent pre-built responses.</div>
            <input class="input-field" type="password" placeholder="OpenAI API Key (sk-...)" id="settings-openai">
            <input class="input-field" type="password" placeholder="Anthropic API Key (sk-ant-...)" id="settings-anthropic">
            <input class="input-field" type="password" placeholder="Google AI Key (AIza...)" id="settings-google">
          </div>
          <div>
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">Timer Defaults</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
              <div>
                <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Focus</div>
                <input class="input-field" type="number" value="25" min="1" max="90" style="margin:0">
              </div>
              <div>
                <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Short Break</div>
                <input class="input-field" type="number" value="5" min="1" max="30" style="margin:0">
              </div>
              <div>
                <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Long Break</div>
                <input class="input-field" type="number" value="15" min="5" max="60" style="margin:0">
              </div>
            </div>
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn-primary" onclick="saveSettings()">Save Settings</button>
            <button class="btn-ghost" onclick="closeModal()">Cancel</button>
          </div>
        </div>
      \`);
    }

    function saveSettings() {
      closeModal();
      showNotification('Settings saved ✓', 'success');
    }

    // ── Modal system ──────────────────────────────────
    function openModal(title, content) {
      closeModal();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'modal-overlay';
      overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
      overlay.innerHTML = \`
        <div class="modal-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
            <div style="font-size:16px;font-weight:800">\${title}</div>
            <button class="tip-close" onclick="closeModal()" style="font-size:18px">✕</button>
          </div>
          \${content}
        </div>
      \`;
      document.body.appendChild(overlay);
    }

    function closeModal() {
      const overlay = document.getElementById('modal-overlay');
      if (overlay) overlay.remove();
    }

    // ── Notification ──────────────────────────────────
    function showNotification(msg, type = 'info') {
      const el = document.createElement('div');
      el.style.cssText = \`
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: var(--bg-panel); border: 1px solid \${type === 'success' ? 'var(--success)' : 'var(--border)'};
        color: \${type === 'success' ? 'var(--success)' : 'var(--text-primary)'};
        padding: 10px 20px; border-radius: 12px; font-size: 13px; font-weight: 600;
        z-index: 9999; animation: messageIn 0.3s ease; white-space: nowrap;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      \`;
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }

    // ── Session persistence ───────────────────────────
    function saveSession() {
      // Lightweight save — just key stats
      localStorage.setItem('fs_total_focus', state.timer.totalFocusSeconds);
      localStorage.setItem('fs_sessions', state.timer.sessionNumber);
    }

    // ── Init ──────────────────────────────────────────
    function init() {
      // Restore session data
      const savedFocus = parseInt(localStorage.getItem('fs_total_focus') || '0');
      const savedSessions = parseInt(localStorage.getItem('fs_sessions') || '0');
      if (savedFocus) state.timer.totalFocusSeconds = savedFocus;
      if (savedSessions) state.timer.sessionNumber = savedSessions;

      document.getElementById('stat-sessions').textContent = state.timer.sessionNumber;
      document.getElementById('stat-focus-time').textContent = Math.round(state.timer.totalFocusSeconds / 60) + 'm';
      document.getElementById('stat-streak').textContent = '🔥 ' + state.user.streak;

      updateTimerDisplay();
      updateRing();
      renderCalendar();

      // Keyboard shortcut
      document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && e.target === document.body) {
          e.preventDefault();
          toggleTimer();
        }
        if (e.code === 'Escape') closeModal();
      });

      // Check for insight on load
      setTimeout(updateBehaviorInsight, 2000);
    }

    init();
  `
}

export default app
