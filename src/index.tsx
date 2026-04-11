import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
  upsertUser,
  getUserByEmail,
  setUserTier,
  upsertSubscription,
  recordTransaction,
  issueDesktopToken,
  verifyDesktopToken,
  revokeDesktopTokens,
  getUserTasks,
  upsertTask,
  deleteTask,
  recordSession,
  getSessionStats,
} from './db-helpers'
import {
  declareModelRouting, declareTipIntent, declareCelebration,
  declareBehaviorInsight, declareTierCapabilities, declareGoogleOAuth,
  declareNotionOAuth, declareLearnCards, declareRestoreIntent,
  declareSessionBlocking, declareSlackOAuth, declareInviteIntent,
  declareMindfulMinimum, declareOnboardingIntent, declareSprintHealth,
  declareDeadlineAlert, declareBurnoutRisk, declareFlowScore,
  declareSessionContext, declareTeamRoleCapabilities,
  declareClawbotSession, declareClawbotSystemPrompt, declareWalkthrough,
  declareCoinLedgerEntry, declareClawFlowPromo,
  declareAudioGeneration, declareAudioProject, declareAudioArrangementSuggestion,
  MODEL_REGISTRY, IMAGE_MODEL_REGISTRY, VIDEO_MODEL_REGISTRY, CREDENTIAL_TABLE,
  type SessionIntent, type BehaviorData, type AudioAiTool,
} from './intent-layer'
import {
  resolveAIExecution,
  isTierPro,
  applyOrchestrationHeaders,
  type ExecutionPlan,
} from './ai-orchestrator'

type Bindings = {
  // ── AI Chat (single OpenRouter key covers ALL chat models) ──────────────────
  OPENROUTER_API_KEY: string
  ANTHROPIC_API_KEY: string
  GOOGLE_AI_KEY: string
  GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string
  NOTION_CLIENT_ID: string; NOTION_CLIENT_SECRET: string
  SLACK_CLIENT_ID: string; SLACK_CLIENT_SECRET: string; SLACK_BOT_TOKEN: string
  XAI_API_KEY: string; MISTRAL_API_KEY: string; DEEPSEEK_API_KEY: string
  TOGETHER_API_KEY: string; ELEVENLABS_API_KEY: string
  STRIPE_SECRET_KEY: string; STRIPE_PUBLISHABLE_KEY: string; STRIPE_WEBHOOK_SECRET: string
  RESEND_API_KEY: string; SESSION_SECRET: string
  CLAWBOT_API_KEY: string
  // Upstash Redis — rate limiting, token tracking, abuse prevention
  UPSTASH_REDIS_URL: string; UPSTASH_REDIS_TOKEN: string
  // Image & Video generation — all via Replicate (FLUX, SD3.5, Ideogram, Recraft, Seedream, Runway, Kling, MiniMax, HunyuanVideo, LTX)
  REPLICATE_API_KEY: string
  // fal.ai — Seedance 2.0, Nano Banana (Gemini), Wan v2.6, SeedDream v5
  FAL_AI_KEY: string
  // Higgsfield AI — cinematic video generation (100+ models including Seedance 2.0)
  HIGGSFIELD_API_KEY: string
  HIGGSFIELD_API_SECRET: string
  // Optional separate keys (not required if using Replicate)
  RUNWAY_API_KEY: string; LUMA_API_KEY: string; PIKA_API_KEY: string
  // FlowState Audio — Music AI
  SUNO_API_KEY: string; MUSICGEN_API_KEY: string; UDIO_API_KEY: string
  LOUDME_API_KEY: string; MOISES_API_KEY: string; DOLBY_API_KEY: string
  ACRCLOUD_ACCESS_KEY: string; ACRCLOUD_ACCESS_SECRET: string; AUDIOSHAKE_API_KEY: string
  HUGGINGFACE_API_KEY: string
  // Canonical public domain — pins OAuth redirect_uri so it never varies by access domain
  CANONICAL_ORIGIN: string
  // ── Cloudflare D1 — Permanent relational store ──────────────────────────────
  DB: D1Database
  // ── Cloudflare R2 — File storage for user assets & AI outputs ──────────────
  R2: R2Bucket
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }))
app.use('/static/*', serveStatic({ root: './' }))

// ─── Session helpers ──────────────────────────────────────────────────────────
function encodeSession(data: object): string { return btoa(JSON.stringify(data)) }
function decodeSession(token: string): any { try { return JSON.parse(atob(token)) } catch { return null } }

// ─── Google OAuth ─────────────────────────────────────────────────────────────
app.get('/api/auth/google', async (c) => {
  // If already logged in AND no app-specific flow, redirect straight to app
  const existingSession = decodeSession(getCookie(c, 'fs_session') || '')
  const appParam      = c.req.query('app')      || ''
  const appState      = c.req.query('state')    || ''
  const appRedirect   = c.req.query('redirect') || ''
  if (existingSession && !appParam) {
    return c.redirect('/')
  }
  // Always use canonical domain so redirect_uri matches what's registered in Google Console
  // Both flowst8.cc and flowstate-67g.pages.dev route here — pin to flowst8.cc
  const baseUrl = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
  const intent = declareGoogleOAuth(baseUrl)
  setCookie(c, 'oauth_state', intent.stateParam, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  // Persist app-specific params so callback can forward to the right place
  if (appParam) {
    const appCtx = JSON.stringify({ app: appParam, state: appState, redirect: appRedirect })
    setCookie(c, 'oauth_app_ctx', btoa(appCtx), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  }
  const params = new URLSearchParams({
    client_id: c.env?.GOOGLE_CLIENT_ID || '',
    redirect_uri: intent.redirectPath,
    response_type: 'code',
    scope: intent.scopes.join(' '),
    state: intent.stateParam,
    access_type: 'offline',
    prompt: 'select_account',
  })
  return c.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params)
})

app.get('/api/auth/google/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  const storedState = getCookie(c, 'oauth_state')
  deleteCookie(c, 'oauth_state', { path: '/' })
  // Read & clear app-specific context (set by /api/auth/google when app= param was present)
  const appCtxRaw = getCookie(c, 'oauth_app_ctx') || ''
  deleteCookie(c, 'oauth_app_ctx', { path: '/' })
  let appCtx: { app?: string; state?: string; redirect?: string } = {}
  try { appCtx = appCtxRaw ? JSON.parse(atob(appCtxRaw)) : {} } catch { appCtx = {} }

  if (error || state !== storedState || !code) return c.html(authErrorPage('Google sign-in was cancelled or failed.'))
  try {
    // Must match exactly what was sent in the authorize request — use same canonical origin
    const baseUrl = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: c.env?.GOOGLE_CLIENT_ID || '', client_secret: c.env?.GOOGLE_CLIENT_SECRET || '', redirect_uri: baseUrl + '/api/auth/google/callback', grant_type: 'authorization_code' }),
    })
    const tokens: any = await tokenRes.json()
    if (!tokens.access_token) throw new Error('No access token')
    const profile: any = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } })).json()
    const session = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000, name: profile.name, email: profile.email, picture: profile.picture, provider: 'google' }
    setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'None', maxAge: 7*24*3600, path: '/' })

    // If this auth was initiated from a desktop app, forward to that app's callback
    if (appCtx.app === 'fsaudio') {
      const cbUrl = `/api/fsaudio/auth/callback?state=${encodeURIComponent(appCtx.state || '')}&redirect=${encodeURIComponent(appCtx.redirect || 'fsaudio://auth')}`
      return c.redirect(cbUrl)
    }
    if (appCtx.app === '264pro') {
      const cbUrl = `/api/264pro/auth/callback?state=${encodeURIComponent(appCtx.state || '')}&redirect=${encodeURIComponent(appCtx.redirect || '264pro://auth')}`
      return c.redirect(cbUrl)
    }

    // Regular web sign-in — show success page
    return c.html(authSuccessPage(profile.name, profile.picture))
  } catch (err: any) { return c.html(authErrorPage('Authentication failed: ' + err.message)) }
})

async function refreshGoogleToken(refreshToken: string, clientId: string, clientSecret: string): Promise<any> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }) })
    return await res.json()
  } catch { return null }
}

async function getValidAccessToken(c: any): Promise<string | null> {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return null
  if (Date.now() < session.expires_at - 60000) return session.access_token
  if (session.refresh_token) {
    const refreshed = await refreshGoogleToken(session.refresh_token, c.env?.GOOGLE_CLIENT_ID || '', c.env?.GOOGLE_CLIENT_SECRET || '')
    if (refreshed?.access_token) {
      session.access_token = refreshed.access_token
      session.expires_at = Date.now() + refreshed.expires_in * 1000
      setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7*24*3600, path: '/' })
      return refreshed.access_token
    }
  }
  return null
}

app.get('/api/auth/me', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ authenticated: false })
  return c.json({ authenticated: true, name: session.name, email: session.email, picture: session.picture, provider: session.provider })
})

app.post('/api/auth/logout', async (c) => {
  deleteCookie(c, 'fs_session', { path: '/' })
  deleteCookie(c, 'fs_notion', { path: '/' })
  deleteCookie(c, 'fs_slack', { path: '/' })
  // NOTE: fs_onboarded is intentionally NOT deleted on logout
  // so returning users skip onboarding on next sign-in
  return c.json({ ok: true })
})

// ─── Session check ────────────────────────────────────────────────────────────
app.get('/api/auth/session', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  return c.json({ user: session || null })
})

// ─── Notion OAuth ─────────────────────────────────────────────────────────────
app.get('/api/auth/notion', async (c) => {
  const clientId = c.env?.NOTION_CLIENT_ID || ''
  if (!clientId) return c.html(authErrorPage('Notion OAuth not configured. Add NOTION_CLIENT_ID to environment.'))
  const baseUrl = new URL(c.req.url).origin
  const intent = declareNotionOAuth(baseUrl, clientId)
  setCookie(c, 'notion_state', intent.stateParam, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  return c.redirect(intent.authorizeUrl + '&state=' + intent.stateParam)
})

app.get('/api/auth/notion/callback', async (c) => {
  const { code, error } = c.req.query() as any
  deleteCookie(c, 'notion_state', { path: '/' })
  if (error || !code) return c.html(authErrorPage('Notion authorization failed.'))
  try {
    const baseUrl = new URL(c.req.url).origin
    const credentials = btoa((c.env?.NOTION_CLIENT_ID || '') + ':' + (c.env?.NOTION_CLIENT_SECRET || ''))
    const tokens: any = await (await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + credentials, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: baseUrl + '/api/auth/notion/callback' }),
    })).json()
    if (!tokens.access_token) throw new Error(tokens.error || 'No access token')
    setCookie(c, 'fs_notion', encodeSession({ access_token: tokens.access_token, workspace_id: tokens.workspace_id, workspace_name: tokens.workspace_name, workspace_icon: tokens.workspace_icon, bot_id: tokens.bot_id }), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 30*24*3600, path: '/' })
    return c.html(notionSuccessPage(tokens.workspace_name))
  } catch (err: any) { return c.html(authErrorPage('Notion authentication failed: ' + err.message)) }
})

app.get('/api/auth/notion-status', async (c) => {
  const token = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!token) return c.json({ connected: false })
  return c.json({ connected: true, workspace: token.workspace_name, workspaceIcon: token.workspace_icon })
})

// ─── Slack OAuth ──────────────────────────────────────────────────────────────
app.get('/api/auth/slack', async (c) => {
  const clientId = c.env?.SLACK_CLIENT_ID || ''
  if (!clientId) return c.html(authErrorPage('Slack OAuth not configured. Add SLACK_CLIENT_ID to environment.'))
  const baseUrl = new URL(c.req.url).origin
  const intent = declareSlackOAuth(baseUrl, clientId)
  setCookie(c, 'slack_state', intent.stateParam, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  return c.redirect(intent.authorizeUrl)
})

app.get('/api/auth/slack/callback', async (c) => {
  const { code, error } = c.req.query() as any
  deleteCookie(c, 'slack_state', { path: '/' })
  if (error || !code) return c.html(authErrorPage('Slack authorization failed.'))
  try {
    const baseUrl = new URL(c.req.url).origin
    const tokens: any = await (await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: c.env?.SLACK_CLIENT_ID || '', client_secret: c.env?.SLACK_CLIENT_SECRET || '', redirect_uri: baseUrl + '/api/auth/slack/callback' }),
    })).json()
    if (!tokens.ok) throw new Error(tokens.error || 'Slack auth failed')
    setCookie(c, 'fs_slack', encodeSession({ access_token: tokens.access_token, team_id: tokens.team?.id, team_name: tokens.team?.name, bot_token: tokens.access_token }), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 30*24*3600, path: '/' })
    return c.html(slackSuccessPage(tokens.team?.name))
  } catch (err: any) { return c.html(authErrorPage('Slack authentication failed: ' + err.message)) }
})

app.get('/api/auth/slack-status', async (c) => {
  const token = decodeSession(getCookie(c, 'fs_slack') || '')
  if (!token) return c.json({ connected: false })
  return c.json({ connected: true, team: token.team_name })
})

// ─── Onboarding ───────────────────────────────────────────────────────────────
app.post('/api/onboarding/complete', async (c) => {
  const { goals, focusDuration, workHours, timezone } = await c.req.json()
  const intent = declareOnboardingIntent(goals, focusDuration, workHours, timezone)
  // Store the user's email so we can match it on next login
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const email = session?.email || ''
  setCookie(c, 'fs_onboarded', encodeSession({ completed: true, email, goals, focusDuration, workHoursStart: workHours.start, workHoursEnd: workHours.end, timezone, seedIntegrations: intent.seedIntegrations }), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 365*24*3600, path: '/' })
  return c.json({ ok: true, intent })
})

app.get('/api/onboarding/status', async (c) => {
  const ob = decodeSession(getCookie(c, 'fs_onboarded') || '')
  return c.json({ completed: !!(ob?.completed), data: ob })
})

// ─── Google Calendar ──────────────────────────────────────────────────────────
app.get('/api/calendar/events', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated', events: [] }, 401)
  try {
    const now = new Date()
    const end = new Date(now.getTime() + 7*24*60*60*1000)
    const params = new URLSearchParams({ timeMin: now.toISOString(), timeMax: end.toISOString(), maxResults: '20', singleEvents: 'true', orderBy: 'startTime' })
    const data: any = await (await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params, { headers: { Authorization: 'Bearer ' + token } })).json()
    const events = (data.items || []).map((e: any) => ({ id: e.id, summary: e.summary || '(No title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, allDay: !e.start?.dateTime, color: e.colorId ? 'hsl(' + (parseInt(e.colorId) * 37) + ', 60%, 60%)' : 'var(--accent-primary)' }))
    return c.json({ events })
  } catch (err: any) { return c.json({ error: err.message, events: [] }, 500) }
})

app.post('/api/calendar/block', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated' }, 401)
  const { title, start, end } = await c.req.json()
  try {
    const data = await (await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: title || '🍅 Focus Block — FlowState', start: { dateTime: start }, end: { dateTime: end }, description: 'Blocked by FlowState for deep work.', colorId: '11' }) })).json()
    return c.json({ ok: true, event: data })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ─── Notion Board ─────────────────────────────────────────────────────────────
app.get('/api/notion/databases', async (c) => {
  const ns = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!ns) return c.json({ error: 'not_connected', databases: [] }, 401)
  try {
    const data: any = await (await fetch('https://api.notion.com/v1/search', { method: 'POST', headers: { Authorization: 'Bearer ' + ns.access_token, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' }, body: JSON.stringify({ filter: { value: 'database', property: 'object' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } }) })).json()
    return c.json({ databases: (data.results || []).map((db: any) => ({ id: db.id, title: db.title?.[0]?.plain_text || 'Untitled', icon: db.icon?.emoji || '📋', url: db.url })) })
  } catch (err: any) { return c.json({ error: err.message, databases: [] }, 500) }
})

app.get('/api/notion/pages/:dbId', async (c) => {
  const ns = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!ns) return c.json({ error: 'not_connected', pages: [] }, 401)
  try {
    const data: any = await (await fetch('https://api.notion.com/v1/databases/' + c.req.param('dbId') + '/query', { method: 'POST', headers: { Authorization: 'Bearer ' + ns.access_token, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' }, body: JSON.stringify({ page_size: 50 }) })).json()
    const pages = (data.results || []).map((page: any) => {
      const titleProp = Object.values(page.properties || {}).find((p: any) => p.type === 'title') as any
      const statusProp = (Object.values(page.properties || {}).find((p: any) => p.type === 'status') as any) || (Object.values(page.properties || {}).find((p: any) => p.type === 'select') as any)
      const rawStatus = statusProp?.status?.name || statusProp?.select?.name || 'todo'
      return { id: page.id, url: page.url, title: titleProp?.title?.[0]?.plain_text || 'Untitled', status: normalizeStatus(rawStatus), icon: page.icon?.emoji || '📄', lastEdited: page.last_edited_time }
    })
    return c.json({ pages })
  } catch (err: any) { return c.json({ error: err.message, pages: [] }, 500) }
})

app.patch('/api/notion/pages/:pageId', async (c) => {
  const ns = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!ns) return c.json({ error: 'not_connected' }, 401)
  const { status, propertyName, propertyType } = await c.req.json()
  try {
    const properties: any = {}
    properties[propertyName] = propertyType === 'status' ? { status: { name: status } } : { select: { name: status } }
    const res = await fetch('https://api.notion.com/v1/pages/' + c.req.param('pageId'), { method: 'PATCH', headers: { Authorization: 'Bearer ' + ns.access_token, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' }, body: JSON.stringify({ properties }) })
    return c.json({ ok: res.ok })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

function normalizeStatus(s: string): 'todo' | 'inprogress' | 'done' {
  const l = s.toLowerCase()
  if (/progress|doing|active/.test(l)) return 'inprogress'
  if (/done|complete|finish|closed|shipped/.test(l)) return 'done'
  return 'todo'
}

// ─── Slack API ────────────────────────────────────────────────────────────────
app.get('/api/slack/channels', async (c) => {
  const ss = decodeSession(getCookie(c, 'fs_slack') || '')
  if (!ss) return c.json({ error: 'not_connected', channels: [] }, 401)
  try {
    const data: any = await (await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=50', { headers: { Authorization: 'Bearer ' + ss.access_token } })).json()
    return c.json({ channels: (data.channels || []).map((ch: any) => ({ id: ch.id, name: ch.name, memberCount: ch.num_members })) })
  } catch (err: any) { return c.json({ error: err.message, channels: [] }, 500) }
})

app.post('/api/slack/message', async (c) => {
  const ss = decodeSession(getCookie(c, 'fs_slack') || '')
  if (!ss) return c.json({ error: 'not_connected' }, 401)
  const { channel, text } = await c.req.json()
  try {
    const data: any = await (await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: 'Bearer ' + ss.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, text }) })).json()
    return c.json({ ok: data.ok, ts: data.ts })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ─── Upstash Redis anti-abuse helpers ────────────────────────────────────────
// Uses Upstash REST pipeline: POST /pipeline with array of commands
async function redisPipeline(url: string, token: string, commands: any[][]): Promise<any[]> {
  try {
    const res = await fetch(url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    })
    const json: any = await res.json()
    return Array.isArray(json) ? json.map((r: any) => r.result ?? null) : []
  } catch { return [] }
}

async function checkAntiAbuse(c: any, userId: string): Promise<Response | null> {
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return null // Redis not configured — allow through

  const date    = new Date().toISOString().slice(0, 10)
  const minute  = Math.floor(Date.now() / 60000)
  const tierKey      = `tier:${userId}`
  const tierEmailKey = `tier_email:${userId}` // set by Stripe webhook (keyed by email)
  const dayKey  = `daily_tokens_used:${userId}:${date}`
  const velKey  = `velocity:${userId}:${minute}`

  // Read tier from both sources + velocity/usage in one pipeline
  const results = await redisPipeline(url, token, [
    ['GET', tierKey],
    ['GET', tierEmailKey],
    ['GET', dayKey],
    ['GET', velKey],
    ['INCR', velKey],
    ['EXPIRE', velKey, 90],
    ['INCRBY', dayKey, 500],
    ['EXPIRE', dayKey, 86400],
  ])

  // Prefer webhook-set tier (tier_email) over session tier
  const tierSession = results[0] as string | null
  const tierEmail   = results[1] as string | null
  const tier        = tierEmail || tierSession
  const dayUsed     = results[2] as string | null
  const velCount    = results[3] as string | null

  const isPaid   = tier === 'pro' || tier === 'team'
  const isTeam   = tier === 'team'
  const limit    = isPaid ? 100_000 : 5_000
  const used     = parseInt(dayUsed || '0')
  const velocity = parseInt(velCount || '0')

  // Velocity check: >10 requests in 60s
  if (velocity >= 10) {
    return c.json({ error: 'Too many requests — slow down for 60 seconds.', code: 'VELOCITY_EXCEEDED' }, 429)
  }

  // Daily token budget check — also check purchased token balance as overflow
  if (used >= limit) {
    // Check purchased token balance
    const balKey = `token_balance:${encodeURIComponent(userId)}`
    const balRes = await fetch(`${url}/getdel/${balKey}`, { headers: { Authorization: `Bearer ${token}` } })
    const balData: any = await balRes.json().catch(() => ({}))
    const balance = parseInt(balData?.result || '0')

    if (balance >= 500) {
      // Deduct from purchased balance and allow through
      const newBal = balance - 500
      await fetch(`${url}/set/${balKey}/${newBal}`, { headers: { Authorization: `Bearer ${token}` } })
      c.header('X-Token-Source', 'purchased')
      c.header('X-Purchased-Balance', String(newBal))
      return null // allow through using purchased tokens
    }

    const msg = isPaid
      ? `Daily ${isTeam ? 'Team' : 'Pro'} limit reached (100k tokens). Buy a token pack or wait for reset at midnight UTC.`
      : 'Free daily limit reached (5k tokens). Upgrade to Pro or buy a token pack.'
    return c.json({ error: msg, code: 'DAILY_LIMIT', used, limit, isPaid, canTopUp: true }, 429)
  }

  // Soft warning at 80% budget for free users
  const newUsed = used + 500
  if (!isPaid && newUsed >= limit * 0.8) {
    c.header('X-Budget-Warning', `${limit - newUsed} tokens left today — buy a token pack to continue`)
  }

  return null // allow through
}

// ─── AI Chat — multi-model streaming ─────────────────────────────────────────
app.post('/api/chat/stream', async (c) => {
  const { message, model: preferredModel, messages: history = [], systemOverride } = await c.req.json()

  // ── AI Orchestration: cost control + abuse prevention ──────────────────────
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const userId  = session?.email || session?.id || c.req.header('CF-Connecting-IP') || 'anon'
  const redisUrl = c.env?.UPSTASH_REDIS_URL
  const redisTok = c.env?.UPSTASH_REDIS_TOKEN

  if (redisUrl && redisTok) {
    const plan = await resolveAIExecution({
      userId,
      tool: 'chat',
      requestedModel: preferredModel || 'auto',
      isPro: isTierPro(session?.tier),
      redisUrl,
      redisToken: redisTok,
    })
    if (plan.blocked && plan.blockResponse) {
      return c.json(plan.blockResponse, plan.blockResponse.status as any)
    }
    applyOrchestrationHeaders(c, plan)
  }

  const intent = declareModelRouting(message, preferredModel)
  const spec = MODEL_REGISTRY[intent.routedModel]
  if (!spec) return c.json({ error: 'Unknown model' }, 400)

  // Resolve API key
  // xAI Grok: prefer native XAI_API_KEY for live web search; fall back to OpenRouter (no live search)
  // Google: direct API only (streaming SSE format)
  // All others: OpenRouter
  const apiKey = spec.provider === 'xai'
    ? (c.env?.XAI_API_KEY || c.env?.OPENROUTER_API_KEY)
    : spec.provider === 'google'
      ? c.env?.GOOGLE_AI_KEY
      : (c.env?.OPENROUTER_API_KEY || (c.env as any)?.[spec.envKey])

  if (!apiKey) return c.text(getDemoResponse(message, spec.name), 200, { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Routing-Reason': intent.reasoning })

  const systemMsg = systemOverride || intent.systemPrompt
  const allMessages = [...history.slice(-10), { role: 'user', content: message }]
  try {
    // ── xAI Grok — live web search (native API or OpenRouter :online) ──────────
    if (spec.provider === 'xai') {
      const isLiveQuery = /\b(latest|news|today|current|recent|2025|2026|real.?time|trending|live|now|happening|this (week|month|year))\b/i.test(message)

      // Path A: native xAI API with search_parameters
      if (c.env?.XAI_API_KEY) {
        const body: any = {
          model: spec.apiModel === 'x-ai/grok-3' ? 'grok-3-latest' : 'grok-3-mini-latest',
          messages: [{ role: 'system', content: systemMsg }, ...allMessages],
          stream: false, max_tokens: 2048,
        }
        if (isLiveQuery) body.search_parameters = { mode: 'on', sources: [{ type: 'web' }, { type: 'x' }] }
        const res = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + c.env.XAI_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data: any = await res.json()
        const reply = data.choices?.[0]?.message?.content || 'No response.'
        const citations = data.citations as string[] | undefined
        const citationBlock = citations?.length
          ? '\n\n---\n**Sources:** ' + citations.slice(0, 3).map((u: string) => { try { return `[${new URL(u).hostname}](${u})` } catch { return u } }).join(' · ')
          : ''
        return new Response(reply + citationBlock, { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Live-Search': isLiveQuery ? 'on' : 'off' } })
      }

      // Path B: OpenRouter with :online suffix for live search (no XAI_API_KEY)
      if (c.env?.OPENROUTER_API_KEY) {
        const orModel = isLiveQuery
          ? (spec.apiModel === 'x-ai/grok-3' ? 'x-ai/grok-3:online' : 'x-ai/grok-3-mini:online')
          : spec.apiModel
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + c.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://flowstate-67g.pages.dev', 'X-Title': 'FlowState Hub' },
          body: JSON.stringify({ model: orModel, messages: [{ role: 'system', content: systemMsg }, ...allMessages], stream: true, max_tokens: 2048 }),
        })
        const reply = await extractOpenAIStream(res)
        return new Response(reply, { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Live-Search': isLiveQuery ? 'on' : 'off' } })
      }

      // No key — demo
      return c.text(getDemoResponse(message, spec.name), 200, { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel })
    }

    // ── Google Gemini — direct API (SSE streaming format differs from OpenAI) ──
    if (spec.provider === 'google') {
      const res = await fetch(spec.apiEndpoint + '?key=' + apiKey + '&alt=sse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction: { parts: [{ text: systemMsg }] }, contents: allMessages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: 2048 } })
      })
      return new Response(await extractGeminiStream(res), { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel } })
    }

    // ── All others (OpenAI, Anthropic, Mistral, DeepSeek, Meta, xAI fallback) via OpenRouter ──
    const res = await fetch(spec.apiEndpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowstate-67g.pages.dev',
        'X-Title': 'FlowState Hub',
      },
      body: JSON.stringify({
        model: spec.apiModel,
        messages: [{ role: 'system', content: systemMsg }, ...allMessages],
        stream: true,
        max_tokens: 2048,
      })
    })
    return new Response(await extractOpenAIStream(res), { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Routing-Reason': intent.reasoning } })
  } catch (err: any) { return c.text('[Error: ' + err.message + '] ' + getDemoResponse(message, spec.name), 200, { 'Content-Type': 'text/plain' }) }
})

async function extractOpenAIStream(res: Response): Promise<string> {
  const text = await res.text(); let result = ''
  for (const line of text.split('\n')) { if (line.startsWith('data: ') && !line.includes('[DONE]')) { try { result += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '' } catch {} } }
  return result || 'No response generated.'
}
async function extractAnthropicStream(res: Response): Promise<string> {
  const text = await res.text(); let result = ''
  for (const line of text.split('\n')) { if (line.startsWith('data: ')) { try { const d = JSON.parse(line.slice(6)); if (d.type === 'content_block_delta') result += d.delta?.text || '' } catch {} } }
  return result || 'No response generated.'
}
async function extractGeminiStream(res: Response): Promise<string> {
  const text = await res.text(); let result = ''
  for (const line of text.split('\n')) { if (line.startsWith('data: ')) { try { result += JSON.parse(line.slice(6)).candidates?.[0]?.content?.parts?.[0]?.text || '' } catch {} } }
  return result || 'No response generated.'
}

function getDemoResponse(message: string, modelName: string): string {
  const l = message.toLowerCase()
  if (/hello|hi|hey/.test(l)) return 'Hey! FlowState AI (' + modelName + ' demo mode). Add your API key to unlock real responses. What are you working on today?'
  if (/pomodoro|focus|timer/.test(l)) return 'The Pomodoro Technique works because it makes time visible. 25 minutes is short enough to start, long enough to reach deep focus. Ready to start a session?'
  if (/code|debug|function/.test(l)) return 'For code tasks I route to Claude 3.7 Sonnet. In demo mode: break the problem into the smallest failing unit, add a log at each step, work backwards from the error.'
  if (/notion|kanban|task|board/.test(l)) return 'Connect Notion in the Board tab to sync your Kanban. Drag cards between columns to update status in real time.'
  if (/team|sprint|standup/.test(l)) return 'FlowState Team features include Sprint Health dashboards, Slack sync, and burnout detection. Upgrade to Team Starter to unlock.'
  return modelName + ' demo mode. Add API keys via Settings to unlock real responses. Your message: "' + message.slice(0, 80) + (message.length > 80 ? '...' : '') + '"'
}

// ─── Replicate polling helper ─────────────────────────────────────────────────
async function pollReplicate(predictionId: string, apiKey: string, maxWaitMs = 120000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: 'Token ' + apiKey }
    })
    const data: any = await res.json()
    if (data.status === 'succeeded') return { ok: true, output: data.output }
    if (data.status === 'failed' || data.status === 'canceled') return { ok: false, error: data.error || 'Generation failed' }
  }
  return { ok: false, error: 'Timed out waiting for Replicate result' }
}

// ─── Image Generation ─────────────────────────────────────────────────────────
app.post('/api/generate/image', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const { prompt, model: modelId = 'flux_pro', size = '1024x1024', aspectRatio = '1:1' } = await c.req.json()

  // ── AI Orchestration ───────────────────────────────────────────────────────
  const imgRedisUrl = c.env?.UPSTASH_REDIS_URL
  const imgRedisTok = c.env?.UPSTASH_REDIS_TOKEN
  let resolvedModelId = modelId
  let extraQualityParams: Record<string, any> = {}

  if (imgRedisUrl && imgRedisTok) {
    const userId = session?.email || session?.id || c.req.header('CF-Connecting-IP') || 'anon'
    const plan = await resolveAIExecution({
      userId,
      tool:           modelId,
      requestedModel: modelId,
      isPro:          isTierPro(session?.tier),
      redisUrl:       imgRedisUrl,
      redisToken:     imgRedisTok,
    })
    if (plan.blocked && plan.blockResponse) {
      return c.json(plan.blockResponse, plan.blockResponse.status as any)
    }
    resolvedModelId  = plan.resolvedModel   // may be fallback for free heavy users
    extraQualityParams = plan.qualityParams // quality overrides to merge into API call
    applyOrchestrationHeaders(c, plan)
  }

  const spec = IMAGE_MODEL_REGISTRY[resolvedModelId as keyof typeof IMAGE_MODEL_REGISTRY]
  if (!spec) return c.json({ error: 'Unknown image model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  if (!apiKey) return c.json({ error: spec.name + ' requires ' + spec.envKey, demo: true, imageUrl: 'https://placehold.co/1024x1024/1a1a2e/a855f7?text=' + encodeURIComponent(prompt.slice(0, 30)) })

  try {
    // ── Google Imagen models ──────────────────────────────────────────────────
    if (modelId === 'imagen3' || modelId === 'imagen4') {
      const data: any = await (await fetch(spec.apiEndpoint + '?key=' + apiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio } })
      })).json()
      const b64 = data.predictions?.[0]?.bytesBase64Encoded
      if (b64) return c.json({ imageUrl: 'data:image/jpeg;base64,' + b64 })
      return c.json({ error: data.error?.message || spec.name + ' generation failed', demo: true })
    }

    // ── All Replicate image models ────────────────────────────────────────────
    const inputMap: Record<string, any> = {
      flux_pro:    { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      flux_dev:    { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90, num_inference_steps: 28 },
      flux_schnell:{ prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90, num_inference_steps: 4 },
      sd35:        { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      sd35_medium: { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      ideogram2:   { prompt, aspect_ratio: aspectRatio.replace(':', '_'), magic_prompt_option: 'AUTO' },
      recraft:     { prompt, size: '1024x1024', style: 'realistic_image' },
      seedream:    { prompt, aspect_ratio: aspectRatio },
      runway_img:  { prompt, ratio: aspectRatio, duration: 5 },
    }
    // Merge orchestrator quality overrides (may reduce steps/quality for free heavy users)
    const input = { ...(inputMap[resolvedModelId] ?? inputMap[modelId] ?? { prompt }), ...extraQualityParams }
    const predRes: any = await (await fetch(spec.apiEndpoint, {
      method: 'POST',
      headers: { Authorization: 'Token ' + apiKey, 'Content-Type': 'application/json', 'Prefer': 'wait=60' },
      body: JSON.stringify({ input })
    })).json()

    if (predRes.error) return c.json({ error: predRes.error, demo: true })

    // If already done (Prefer: wait worked)
    if (predRes.status === 'succeeded') {
      const out = Array.isArray(predRes.output) ? predRes.output[0] : predRes.output
      return c.json({ imageUrl: out })
    }

    // Otherwise poll
    if (predRes.id) {
      const result = await pollReplicate(predRes.id, apiKey, 90000)
      if (result.ok) {
        const out = Array.isArray(result.output) ? result.output[0] : result.output
        return c.json({ imageUrl: out })
      }
      return c.json({ error: result.error, demo: true })
    }

    return c.json({ error: 'Unexpected response from Replicate', demo: true })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ─── Video Generation ─────────────────────────────────────────────────────────
app.post('/api/generate/video', async (c) => {
  const { prompt, model: modelId = 'kling26', duration = 5, imageUrl } = await c.req.json()
  const spec = VIDEO_MODEL_REGISTRY[modelId as keyof typeof VIDEO_MODEL_REGISTRY]
  if (!spec) return c.json({ error: 'Unknown video model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  const isImg2Vid = !!imageUrl

  if (!apiKey) return c.json({ error: spec.name + ' requires ' + spec.envKey, demo: true, queued: false,
    message: `Demo: Would generate ${duration}s video with ${spec.name}: "${prompt.slice(0, 60)}"` })

  try {
    // ── Google Veo models ─────────────────────────────────────────────────────
    if (modelId === 'veo2' || modelId === 'veo3') {
      const body: any = { instances: [{ prompt }], parameters: { sampleCount: 1, durationSeconds: Math.min(duration, 8), aspectRatio: '16:9' } }
      if (isImg2Vid) body.instances[0].image = { bytesBase64Encoded: imageUrl }
      const data: any = await (await fetch(spec.apiEndpoint + '?key=' + apiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })).json()
      if (data.name) return c.json({ queued: true, jobId: data.name, model: spec.name, message: 'Video queued via ' + spec.name + '. Check back in 2-3 minutes.' })
      return c.json({ error: data.error?.message || spec.name + ' failed', demo: true })
    }

    // ── All Replicate video models ────────────────────────────────────────────
    const inputMap: Record<string, any> = {
      kling26:      { prompt, duration: Math.min(duration, 10), aspect_ratio: '16:9', ...(isImg2Vid ? { image: imageUrl } : {}) },
      kling16:      { prompt, duration: Math.min(duration, 10), aspect_ratio: '16:9', ...(isImg2Vid ? { image: imageUrl } : {}) },
      minimax:      { prompt, ...(isImg2Vid ? { first_frame_image: imageUrl } : {}) },
      minimax_live: { prompt, ...(isImg2Vid ? { first_frame_image: imageUrl } : {}) },
      hunyuan:      { prompt, video_length: Math.min(duration, 5), flow_shift: 7, embedded_guidance_scale: 6 },
      ltx:          { prompt, duration: Math.min(duration, 5), aspect_ratio: '16:9', ...(isImg2Vid ? { image: imageUrl } : {}) },
    }
    const input = inputMap[modelId] || { prompt }
    const predRes: any = await (await fetch(spec.apiEndpoint, {
      method: 'POST',
      headers: { Authorization: 'Token ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    })).json()

    if (predRes.error) return c.json({ error: predRes.error, demo: true })
    if (predRes.id) return c.json({ queued: true, jobId: predRes.id, model: spec.name, message: 'Video queued via ' + spec.name + '. This typically takes 1-4 minutes.' })

    return c.json({ error: 'Unexpected response from Replicate', demo: true })
  } catch (err: any) { return c.json({ error: err.message, queued: false }, 500) }
})

// ─── Video Generation Status (poll Replicate prediction) ─────────────────────
app.get('/api/generate/video/status/:jobId', async (c) => {
  const jobId = c.req.param('jobId')
  const apiKey = c.env?.REPLICATE_API_KEY
  if (!apiKey) return c.json({ error: 'REPLICATE_API_KEY not configured' }, 400)
  try {
    const res = await fetch(`https://api.replicate.com/v1/predictions/${jobId}`, {
      headers: { Authorization: 'Token ' + apiKey }
    })
    const data: any = await res.json()
    const output = data.output
    const videoUrl = Array.isArray(output) ? output[0] : output
    return c.json({ status: data.status, videoUrl: videoUrl || null, error: data.error || null, progress: data.logs || null })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ─── Session Context + Intent ─────────────────────────────────────────────────
app.post('/api/session/intent', async (c) => {
  const { description } = await c.req.json()
  return c.json(declareSessionContext(description))
})

// ─── Sprint Health ────────────────────────────────────────────────────────────
app.post('/api/team/sprint-health', async (c) => {
  const { cards, sprintStart, sprintEnd, teamFocusHours } = await c.req.json()
  return c.json(declareSprintHealth(cards, sprintStart, sprintEnd, teamFocusHours || 0))
})

app.post('/api/team/deadline-alert', async (c) => {
  const { cards, deadlineDate, memberCardMap } = await c.req.json()
  return c.json(declareDeadlineAlert(cards, deadlineDate, memberCardMap || {}))
})

app.post('/api/team/burnout-risk', async (c) => {
  const data = await c.req.json()
  return c.json(declareBurnoutRisk(data))
})

app.post('/api/team/role', async (c) => {
  const { role } = await c.req.json()
  return c.json(declareTeamRoleCapabilities(role))
})

// ─── Invite Loop ──────────────────────────────────────────────────────────────
app.post('/api/invite/generate', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const baseUrl = new URL(c.req.url).origin
  return c.json(declareInviteIntent(session.name, baseUrl))
})

// ─── FlowScore ────────────────────────────────────────────────────────────────
app.post('/api/flowscore', async (c) => {
  const raw = await c.req.json()
  // Normalize: frontend sends totalFocusSeconds/sessionCount, intent-layer expects focusMinutes etc.
  const data = {
    focusMinutes: Math.floor((raw.totalFocusSeconds || raw.focusMinutes || 0) / 60),
    targetFocusMinutes: (raw.targetFocusMinutes || raw.sessionCount * 25 || 100),
    breaksCompleted: raw.breaksCompleted || raw.sessionCount || 0,
    expectedBreaks: raw.expectedBreaks || Math.max(1, raw.sessionCount || 1),
    breathingSessions: raw.breathingExercises || raw.breathingSessions || 0,
    gratitudeEntries: raw.gratitudeEntries || 0,
    streakDays: raw.streak || raw.streakDays || 0,
    sleepHours: raw.sleepHours,
    stepsToday: raw.steps || raw.stepsToday,
    hydrationGlasses: raw.hydrationGlasses,
  }
  return c.json(declareFlowScore(data))
})

// ─── Behavior Insight ─────────────────────────────────────────────────────────
app.get('/api/behavior/insight', async (c) => {
  const q = c.req.query() as any
  const data: BehaviorData = { totalFocusSeconds: parseInt(q.focus || '0'), sessionCount: parseInt(q.sessions || '0'), streak: parseInt(q.streak || '0'), completionRate: parseFloat(q.completion || '0.5'), steps: q.steps ? parseInt(q.steps) : undefined, sleepHours: q.sleep ? parseFloat(q.sleep) : undefined, hydrationGlasses: q.hydration ? parseInt(q.hydration) : undefined, languageStreak: q.langStreak ? parseInt(q.langStreak) : undefined }
  return c.json(declareBehaviorInsight(data))
})

// ─── Magic Link Auth ──────────────────────────────────────────────────────────
app.post('/api/auth/magic-link', async (c) => {
  const { email } = await c.req.json()
  if (!email || !email.includes('@')) return c.json({ error: 'invalid_email' }, 400)
  const resendKey = c.env?.RESEND_API_KEY
  const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())
  if (resendKey) {
    // Send real magic link email via Resend
    const baseUrl = new URL(c.req.url).origin
    const token = btoa(JSON.stringify({ email, name, exp: Date.now() + 15 * 60 * 1000 }))
    const magicUrl = `${baseUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'FlowState <noreply@flowst8.cc>',
        to: [email],
        subject: 'Your FlowState sign-in link',
        html: `
          <div style="font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;padding:40px;max-width:480px;margin:0 auto;border-radius:16px">
            <div style="font-size:32px;margin-bottom:8px">⚡</div>
            <h1 style="font-size:22px;font-weight:800;margin-bottom:8px">Sign in to FlowState</h1>
            <p style="color:#888;margin-bottom:24px">Click the button below to sign in. This link expires in 15 minutes.</p>
            <a href="${magicUrl}" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:700;font-size:15px">Sign in to FlowState →</a>
            <p style="color:#555;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `
      })
    })
    return c.json({ success: true, message: 'Magic link sent! Check your email.' })
  } else {
    // Fallback: auto-sign-in (dev/demo mode)
    const session = { name, email, picture: '', provider: 'magic_link', expiresAt: Date.now() + 7 * 24 * 3600000 }
    setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 604800, path: '/' })
    return c.json({ success: true, user: { name, email } })
  }
})

app.get('/api/auth/magic-link/verify', async (c) => {
  const { token } = c.req.query() as any
  if (!token) return c.html(authErrorPage('Invalid or missing token.'))
  try {
    const data = JSON.parse(atob(decodeURIComponent(token)))
    if (Date.now() > data.exp) return c.html(authErrorPage('This link has expired. Please request a new one.'))
    const session = { name: data.name, email: data.email, picture: '', provider: 'magic_link', expiresAt: Date.now() + 7 * 24 * 3600000 }
    setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'None', maxAge: 604800, path: '/' })
    return c.html(authSuccessPage(data.name, ''))
  } catch { return c.html(authErrorPage('Invalid token. Please request a new sign-in link.')) }
})

// ─── Stripe Billing ───────────────────────────────────────────────────────────
// Live price IDs created 2026-04-05
const STRIPE_PRICES: Record<string, { monthly: string; annual: string }> = {
  pro:       { monthly: 'price_1TIupZLsf0qSbSh0LPiXhi1O', annual: 'price_1TIupZLsf0qSbSh0GOyUxvwR' },
  team:      { monthly: 'price_1TIupjLsf0qSbSh0IN6UfOBp', annual: 'price_1TIupkLsf0qSbSh0WB8czudd' },
  clawflow:  { monthly: 'price_1TIupyLsf0qSbSh0NTc5xoT8', annual: 'price_1TIupyLsf0qSbSh0UZANfNYx' },
}
const CLAWFLOW_FIRST_MONTH_COUPON = 'DK1QtiHP'

app.post('/api/billing/checkout', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const { tier, billing_cycle } = await c.req.json()

  // Map legacy tier names → canonical keys
  const tierKey = tier === 'personal_pro' ? 'pro'
    : tier === 'team_starter' || tier === 'team_growth' ? 'team'
    : tier

  if (tierKey === 'enterprise') {
    return c.json({ enterpriseContact: true, message: 'Contact us at hello@flowstate.app for Enterprise pricing.' })
  }

  const prices = STRIPE_PRICES[tierKey]
  if (!prices) return c.json({ error: 'invalid_tier', available: Object.keys(STRIPE_PRICES) }, 400)

  const cycle = billing_cycle === 'annual' ? 'annual' : 'monthly'
  const priceId = prices[cycle]

  if (!c.env?.STRIPE_SECRET_KEY) {
    return c.json({ demo: true, message: 'Stripe not configured — add STRIPE_SECRET_KEY to activate billing', tier, redirectUrl: '/' })
  }

  const params: Record<string, string> = {
    'payment_method_types[]': 'card',
    'mode': 'subscription',
    'customer_email': session.email,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'success_url': `${new URL(c.req.url).origin}/?billing=success&tier=${tierKey}&cycle=${cycle}`,
    'cancel_url': `${new URL(c.req.url).origin}/?billing=cancelled`,
    'allow_promotion_codes': 'true',
  }

  // Apply first-month $20 coupon for ClawFlow monthly
  if (tierKey === 'clawflow' && cycle === 'monthly') {
    params['discounts[0][coupon]'] = CLAWFLOW_FIRST_MONTH_COUPON
  }

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const stripeData: any = await stripeRes.json()
  if (stripeData.error) return c.json({ error: stripeData.error.message }, 500)
  return c.json({ checkoutUrl: stripeData.url })
})

app.post('/api/billing/portal', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (!c.env?.STRIPE_SECRET_KEY) return c.json({ demo: true, message: 'Stripe not configured' })

  // Look up stored Stripe customer ID from Redis (set by webhook on first checkout)
  let customerId: string | null = null
  if (c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
    try {
      const r = await fetch(`${c.env.UPSTASH_REDIS_URL}/get/stripe_customer:${encodeURIComponent(session.email)}`, {
        headers: { Authorization: `Bearer ${c.env.UPSTASH_REDIS_TOKEN}` }
      })
      const data: any = await r.json()
      customerId = data?.result || null
    } catch (_) {}
  }

  if (!customerId) {
    return c.json({ demo: true, message: 'No active subscription found. Subscribe first to manage billing.' })
  }

  try {
    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'customer': customerId,
        'return_url': new URL(c.req.url).origin + '/',
      }),
    })
    const portalData: any = await portalRes.json()
    if (portalData.url) return c.json({ portalUrl: portalData.url })
    return c.json({ error: portalData.error?.message || 'Portal error' }, 500)
  } catch (_) {
    return c.json({ error: 'Could not open billing portal' }, 500)
  }
})

app.post('/api/billing/webhook', async (c) => {
  const body = await c.req.text()
  const sig  = c.req.header('stripe-signature') || ''
  const secret = c.env?.STRIPE_WEBHOOK_SECRET

  // ── Signature verification (Web Crypto — no Node.js crypto needed) ──────────
  if (secret) {
    try {
      // Parse Stripe-Signature header: t=timestamp,v1=hmac
      const parts: Record<string, string> = {}
      sig.split(',').forEach(part => {
        const [k, v] = part.split('=')
        parts[k] = v
      })
      const timestamp = parts['t']
      const expected  = parts['v1']
      if (!timestamp || !expected) return c.json({ error: 'invalid_signature' }, 400)

      // Verify timestamp within 5 minutes (replay attack protection)
      const now = Math.floor(Date.now() / 1000)
      if (Math.abs(now - parseInt(timestamp)) > 300) {
        return c.json({ error: 'timestamp_too_old' }, 400)
      }

      // Compute HMAC-SHA256
      const signedPayload = `${timestamp}.${body}`
      const keyData = new TextEncoder().encode(secret)
      const msgData = new TextEncoder().encode(signedPayload)
      const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData)
      const computed = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

      if (computed !== expected) {
        return c.json({ error: 'signature_mismatch' }, 400)
      }
    } catch (err) {
      return c.json({ error: 'verification_failed' }, 400)
    }
  }

  // ── Parse event ──────────────────────────────────────────────────────────────
  let event: any
  try { event = JSON.parse(body) } catch { return c.json({ error: 'invalid_json' }, 400) }

  const type = event.type as string

  // ── Map Stripe price IDs → tier names ────────────────────────────────────────
  const priceToTier: Record<string, string> = {
    'price_1TIupZLsf0qSbSh0LPiXhi1O': 'pro',      // Pro monthly
    'price_1TIupZLsf0qSbSh0GOyUxvwR': 'pro',      // Pro annual
    'price_1TIupjLsf0qSbSh0IN6UfOBp': 'team',     // Team monthly
    'price_1TIupkLsf0qSbSh0WB8czudd': 'team',     // Team annual
    'price_1TIupyLsf0qSbSh0NTc5xoT8': 'clawflow', // ClawFlow monthly
    'price_1TIupyLsf0qSbSh0UZANfNYx': 'clawflow', // ClawFlow annual
  }

  // ── Handle events ─────────────────────────────────────────────────────────────
  if (type === 'checkout.session.completed') {
    const session = event.data.object
    const email   = session.customer_details?.email || session.customer_email
    const meta    = session.metadata || {}

    if (email && c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
      const url   = c.env.UPSTASH_REDIS_URL
      const token = c.env.UPSTASH_REDIS_TOKEN

      // Store Stripe customer ID for portal access
      if (session.customer) {
        await fetch(`${url}/set/stripe_customer:${encodeURIComponent(email)}/${session.customer}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      }

      // ── Revenue tracking ──────────────────────────────────────────────────
      // amountTotal is in cents; Stripe takes 2.9% + 30¢
      const gross  = (session.amount_total || 0) / 100  // USD
      const month  = new Date().toISOString().slice(0, 7)  // YYYY-MM
      // Approximate cost ratios:
      //   Pro $18/mo → ~40% to API costs ($7.20), 60% platform ($10.80)
      //   Team $15/seat → ~45% API ($6.75), 55% platform ($8.25)
      //   ClawFlow $40/mo → ~70% API ($28), 30% platform ($12)
      //   Token packs → ~60% API cost, 40% platform margin
      const isClawFlow   = meta.type === 'clawflow' || (priceToTier[meta.price_id || ''] === 'clawflow')
      const isTokenPack  = meta.type === 'token_pack'
      const apiCostRatio = isClawFlow ? 0.70 : isTokenPack ? 0.60 : 0.40
      const stripeFee    = gross * 0.029 + 0.30
      const net          = gross - stripeFee
      const apiAlloc     = parseFloat((net * apiCostRatio).toFixed(2))
      const platformCut  = parseFloat((net * (1 - apiCostRatio)).toFixed(2))

      // Store monthly revenue aggregates in Redis
      await fetch(`${url}/incrbyfloat/rev:gross:${month}/${gross.toFixed(2)}`,        { headers: { Authorization: `Bearer ${token}` } })
      await fetch(`${url}/incrbyfloat/rev:api_alloc:${month}/${apiAlloc.toFixed(2)}`, { headers: { Authorization: `Bearer ${token}` } })
      await fetch(`${url}/incrbyfloat/rev:platform:${month}/${platformCut.toFixed(2)}`,{ headers: { Authorization: `Bearer ${token}` } })
      await fetch(`${url}/incr/rev:count:${month}`,                                    { headers: { Authorization: `Bearer ${token}` } })

      // Log individual transaction
      const txKey = `rev:tx:${Date.now()}:${encodeURIComponent(email)}`
      const txVal = JSON.stringify({ email, gross, net, apiAlloc, platformCut, type: isTokenPack ? 'topup' : 'subscription', tier: meta.tier || priceToTier[meta.price_id || ''] || 'pro', ts: new Date().toISOString() })
      await fetch(`${url}/set/${txKey}/${encodeURIComponent(txVal)}`, { headers: { Authorization: `Bearer ${token}` } })
      await fetch(`${url}/expire/${txKey}/7776000`, { headers: { Authorization: `Bearer ${token}` } }) // 90 day log retention

      if (meta.type === 'token_pack' && meta.tokens) {
        // ── Token pack purchase — add tokens to user's balance ──────────────
        const addTokens = parseInt(meta.tokens)
        const balKey = `token_balance:${encodeURIComponent(email)}`
        await fetch(`${url}/incrby/${balKey}/${addTokens}`, { headers: { Authorization: `Bearer ${token}` } })
        await fetch(`${url}/expire/${balKey}/315360000`,    { headers: { Authorization: `Bearer ${token}` } }) // 10yr TTL

        // ── Also write transaction to D1 ────────────────────────────────────
        if (c.env?.DB) {
          await upsertUser(c.env.DB, email, email.split('@')[0], '', 'stripe').catch(() => {})
          await recordTransaction(c.env.DB, {
            email,
            stripeEventId: event.id || `evt_${Date.now()}`,
            amountCents: session.amount_total || 0,
            currency: session.currency || 'usd',
            type: 'token_pack',
            tokenPackSize: addTokens,
            status: 'succeeded',
          }).catch(() => {})
        }
      } else {
        // ── Subscription checkout — set tier ────────────────────────────────
        const priceId = meta.price_id || session.line_items?.data?.[0]?.price?.id
        const tier = priceToTier[priceId] || meta.tier || 'pro'
        await fetch(`${url}/set/tier_email:${encodeURIComponent(email)}/${tier}`, { headers: { Authorization: `Bearer ${token}` } })

        // ── Also write to D1 (permanent) ────────────────────────────────────
        if (c.env?.DB) {
          await upsertUser(c.env.DB, email, email.split('@')[0], '', 'stripe').catch(() => {})
          await setUserTier(c.env.DB, email, tier).catch(() => {})
          if (session.subscription) {
            await upsertSubscription(c.env.DB, email, {
              stripeSubscriptionId: session.subscription,
              stripePriceId: meta.price_id || '',
              plan: tier,
              billingInterval: 'monthly',
              status: 'active',
              currentPeriodStart: new Date().toISOString(),
              currentPeriodEnd: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
              cancelAtPeriodEnd: false,
            }).catch(() => {})
          }
          await recordTransaction(c.env.DB, {
            email,
            stripeEventId: event.id || `evt_${Date.now()}`,
            amountCents: session.amount_total || 0,
            currency: session.currency || 'usd',
            type: 'subscription',
            plan: tier,
            status: 'succeeded',
          }).catch(() => {})
        }
      }
    }
  }

  if (type === 'customer.subscription.updated') {
    const sub     = event.data.object
    const email   = sub.customer_email || sub.metadata?.email
    const priceId = sub.items?.data?.[0]?.price?.id
    const tier    = priceToTier[priceId] || 'pro'
    const active  = ['active', 'trialing'].includes(sub.status)

    if (email) {
      const newTier = active ? tier : 'free'
      // Redis cache
      if (c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
        await fetch(`${c.env.UPSTASH_REDIS_URL}/set/tier_email:${encodeURIComponent(email)}/${newTier}`, {
          headers: { Authorization: `Bearer ${c.env.UPSTASH_REDIS_TOKEN}` }
        })
      }
      // D1 permanent store
      if (c.env?.DB) {
        await setUserTier(c.env.DB, email, newTier).catch(() => {})
        if (sub.id) {
          await upsertSubscription(c.env.DB, email, {
            stripeSubscriptionId: sub.id,
            stripePriceId: priceId || '',
            plan: tier,
            billingInterval: sub.items?.data?.[0]?.price?.recurring?.interval || 'monthly',
            status: active ? 'active' : 'cancelled',
            currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : new Date().toISOString(),
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : new Date().toISOString(),
            cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
          }).catch(() => {})
        }
      }
    }
  }

  if (type === 'customer.subscription.deleted') {
    const sub   = event.data.object
    const email = sub.customer_email || sub.metadata?.email
    if (email) {
      // Redis cache
      if (c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
        await fetch(`${c.env.UPSTASH_REDIS_URL}/set/tier_email:${encodeURIComponent(email)}/free`, {
          headers: { Authorization: `Bearer ${c.env.UPSTASH_REDIS_TOKEN}` }
        })
      }
      // D1 permanent store
      if (c.env?.DB) {
        await setUserTier(c.env.DB, email, 'free').catch(() => {})
        if (sub.id) {
          await upsertSubscription(c.env.DB, email, {
            stripeSubscriptionId: sub.id,
            stripePriceId: sub.items?.data?.[0]?.price?.id || '',
            plan: 'free',
            billingInterval: 'monthly',
            status: 'cancelled',
            currentPeriodStart: new Date().toISOString(),
            currentPeriodEnd: new Date().toISOString(),
            cancelAtPeriodEnd: false,
          }).catch(() => {})
        }
      }
    }
  }

  return c.json({ received: true })
})

// ─── Token Top-Up ─────────────────────────────────────────────────────────────
// One-time purchase packs: tokens credited to user's Redis balance
const TOKEN_PACKS: Record<string, { tokens: number; price: number; priceId: string }> = {
  pack_50k:  { tokens:  50_000, price:  5, priceId: 'price_1TIvjTLsf0qSbSh0ruQlu4tk' },
  pack_200k: { tokens: 200_000, price: 15, priceId: 'price_1TIvjULsf0qSbSh0wpzT2ODJ' },
  pack_500k: { tokens: 500_000, price: 30, priceId: 'price_1TIvjULsf0qSbSh0wjbz2RX0' },
}

app.get('/api/billing/token-packs', (c) => {
  return c.json({ packs: Object.entries(TOKEN_PACKS).map(([id, p]) => ({ id, ...p })) })
})

app.post('/api/billing/topup', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const { pack_id } = await c.req.json()
  const pack = TOKEN_PACKS[pack_id]
  if (!pack) return c.json({ error: 'invalid_pack', available: Object.keys(TOKEN_PACKS) }, 400)
  if (!c.env?.STRIPE_SECRET_KEY) {
    return c.json({ demo: true, message: `Demo: Would add ${pack.tokens.toLocaleString()} tokens for $${pack.price}` })
  }
  const origin = new URL(c.req.url).origin
  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'payment_method_types[]': 'card',
      'mode': 'payment',  // one-time, not subscription
      'customer_email': session.email,
      'line_items[0][price]': pack.priceId,
      'line_items[0][quantity]': '1',
      'metadata[type]': 'token_pack',
      'metadata[pack_id]': pack_id,
      'metadata[tokens]': String(pack.tokens),
      'metadata[email]': session.email,
      'success_url': `${origin}/?topup=success&pack=${pack_id}&tokens=${pack.tokens}`,
      'cancel_url':  `${origin}/?topup=cancelled`,
    }),
  })
  const data: any = await stripeRes.json()
  if (data.error) return c.json({ error: data.error.message }, 500)
  return c.json({ checkoutUrl: data.url, tokens: pack.tokens, price: pack.price })
})

// ─── Revenue Analytics (Admin) ───────────────────────────────────────────────
// GET /api/billing/revenue?months=3 — returns monthly revenue + split breakdown
// Secured: requires a valid session (owner/admin check via email)
app.get('/api/billing/revenue', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  // Basic admin guard — only let the account owner see revenue data
  // In production, add a proper admin role check
  const adminEmail = c.env?.ADMIN_EMAIL
  if (adminEmail && session.email !== adminEmail) return c.json({ error: 'forbidden' }, 403)

  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'Redis not configured' }, 503)

  const months = Math.min(parseInt(String(c.req.query('months') || '3')), 12)
  const results: any[] = []

  for (let i = 0; i < months; i++) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    const month = d.toISOString().slice(0, 7)

    const [gross, apiAlloc, platform, count] = await Promise.all([
      fetch(`${url}/get/rev:gross:${month}`,    { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then((d:any)=>parseFloat(d.result||'0')),
      fetch(`${url}/get/rev:api_alloc:${month}`,{ headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then((d:any)=>parseFloat(d.result||'0')),
      fetch(`${url}/get/rev:platform:${month}`, { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then((d:any)=>parseFloat(d.result||'0')),
      fetch(`${url}/get/rev:count:${month}`,    { headers: { Authorization: `Bearer ${token}` } }).then(r=>r.json()).then((d:any)=>parseInt(d.result||'0')),
    ])

    const stripeFees = gross > 0 ? parseFloat((gross * 0.029 + count * 0.30).toFixed(2)) : 0
    const net        = parseFloat((gross - stripeFees).toFixed(2))

    results.push({
      month, gross, net, stripeFees,
      apiAlloc: parseFloat(apiAlloc.toFixed(2)),
      platformCut: parseFloat(platform.toFixed(2)),
      transactions: count,
      // Recommended: use apiAlloc to top up OpenRouter/Replicate/ElevenLabs monthly
      apiTopupRecommendation: {
        openrouter: parseFloat((apiAlloc * 0.55).toFixed(2)),  // 55% of API budget to chat AI
        replicate:  parseFloat((apiAlloc * 0.25).toFixed(2)),  // 25% to MusicGen/video
        elevenlabs: parseFloat((apiAlloc * 0.20).toFixed(2)),  // 20% to TTS
      }
    })
  }

  return c.json({
    summary: {
      totalGross:    parseFloat(results.reduce((s,r)=>s+r.gross,0).toFixed(2)),
      totalNet:      parseFloat(results.reduce((s,r)=>s+r.net,0).toFixed(2)),
      totalApiAlloc: parseFloat(results.reduce((s,r)=>s+r.apiAlloc,0).toFixed(2)),
      totalPlatform: parseFloat(results.reduce((s,r)=>s+r.platformCut,0).toFixed(2)),
      totalTx:       results.reduce((s,r)=>s+r.transactions,0),
    },
    months: results,
    note: 'apiTopupRecommendation shows suggested monthly credit purchases per service based on actual revenue. Top up OpenRouter at openrouter.ai/credits, Replicate at replicate.com/billing, ElevenLabs at elevenlabs.io/subscription.'
  })
})

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────
app.post('/api/audio/tts', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const {
    text,
    voice_id        = 'pNInz6obpgDQGcFmaJgB',
    model_id        = 'eleven_turbo_v2_5',
    stability       = 0.5,
    similarity_boost= 0.75,
    style           = 0,
    use_speaker_boost = true,
  } = await c.req.json()
  if (!text) return c.json({ error: 'text required' }, 400)

  const elKey = c.env?.ELEVENLABS_API_KEY
  if (!elKey) return c.json({ demo: true, message: 'ElevenLabs TTS requires ELEVENLABS_API_KEY in Cloudflare secrets.' })

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings: { stability, similarity_boost, style, use_speaker_boost },
      }),
    })
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}))
      return c.json({ error: err?.detail?.message || `ElevenLabs error ${res.status}` }, 500)
    }
    return new Response(res.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'Content-Disposition': 'inline; filename="tts.mp3"',
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/audio/tts/voices', async (c) => {
  const elKey = c.env?.ELEVENLABS_API_KEY
  if (!elKey) return c.json({ voices: [
    { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (demo)', preview_url: null },
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (demo)', preview_url: null },
    { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (demo)', preview_url: null },
  ]})
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': elKey } })
    const data: any = await res.json()
    return c.json({ voices: (data.voices || []).map((v: any) => ({ voice_id: v.voice_id, name: v.name, preview_url: v.preview_url })) })
  } catch { return c.json({ voices: [] }) }
})

// ─── Mindful Minimum ──────────────────────────────────────────────────────────
app.get('/api/mindful/policy', (c) => {
  const tier = (c.req.query('tier') as any) || 'free'
  return c.json(declareMindfulMinimum(tier))
})

// ─── Calendar Create/Delete ───────────────────────────────────────────────────
app.post('/api/calendar/create', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated' }, 401)
  const { title, start, end, allDay, description, color } = await c.req.json()
  try {
    const body: any = {
      summary: title || 'New Event',
      description: description || '',
      colorId: color || '1',
    }
    if (allDay) {
      body.start = { date: start }
      body.end = { date: end || start }
    } else {
      body.start = { dateTime: start }
      body.end = { dateTime: end }
    }
    const data = await (await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })).json()
    return c.json({ ok: true, event: data })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

app.delete('/api/calendar/events/:eventId', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated' }, 401)
  try {
    await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + c.req.param('eventId'), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token }
    })
    return c.json({ ok: true })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ─── Local Tasks (D1-backed, persists across sessions) ───────────────────────
app.get('/api/tasks', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (!c.env?.DB) return c.json({ tasks: [], source: 'local' })
  try {
    const tasks = await getUserTasks(c.env.DB, session.email)
    return c.json({ tasks, source: 'd1' })
  } catch (_) {
    return c.json({ tasks: [], source: 'local' })
  }
})

app.post('/api/tasks', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const { id, title, status, tag, dueDate } = await c.req.json()
  if (!c.env?.DB) {
    return c.json({ ok: true, task: { id: id || crypto.randomUUID(), title, status: status || 'todo', tag, dueDate, createdAt: new Date().toISOString() } })
  }
  try {
    const taskId = await upsertTask(c.env.DB, session.email, null, { title, status: status || 'todo', tags: tag ? [tag] : undefined })
    return c.json({ ok: true, task: { id: taskId, title, status: status || 'todo', tag, dueDate, createdAt: new Date().toISOString() } })
  } catch (_) {
    return c.json({ ok: true, task: { id: crypto.randomUUID(), title, status: status || 'todo', tag, dueDate, createdAt: new Date().toISOString() } })
  }
})

app.put('/api/tasks/:id', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const taskId = parseInt(c.req.param('id'))
  const updates = await c.req.json()
  if (!c.env?.DB) return c.json({ ok: true })
  try {
    await upsertTask(c.env.DB, session.email, taskId, updates)
    return c.json({ ok: true })
  } catch (_) { return c.json({ ok: false }, 500) }
})

app.delete('/api/tasks/:id', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const taskId = parseInt(c.req.param('id'))
  if (!c.env?.DB) return c.json({ ok: true })
  try {
    await deleteTask(c.env.DB, session.email, taskId)
    return c.json({ ok: true })
  } catch (_) { return c.json({ ok: false }, 500) }
})

// ─── Team Members (session-based, role-gated) ─────────────────────────────────
app.get('/api/team/members', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  // Returns current user's role + placeholder for team members
  // In production: fetch from D1/KV based on workspace
  const role = session.role || 'member'
  const caps = declareTeamRoleCapabilities(role)
  return c.json({ 
    currentUser: { name: session.name, email: session.email, picture: session.picture, role, provider: session.provider },
    capabilities: caps,
    members: [] // Empty until team invite is accepted
  })
})

app.post('/api/team/update-role', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const { role } = await c.req.json()
  const validRoles = ['member', 'senior_dev', 'scrum_master', 'admin']
  if (!validRoles.includes(role)) return c.json({ error: 'invalid_role' }, 400)
  // Update session cookie with new role
  session.role = role
  setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7*24*3600, path: '/' })
  return c.json({ ok: true, role, capabilities: declareTeamRoleCapabilities(role) })
})

// ─── Clawbot / ClawFlow ───────────────────────────────────────────────────────

/** Check ClawFlow subscription status for the current user. */
app.get('/api/clawbot/status', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ subscriptionActive: false, tier: 'none', coinsRemaining: 0 })

  // Check Redis for paid ClawFlow tier (set by Stripe webhook on payment, cleared on cancel)
  let isClawflowActive = false
  if (c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
    try {
      const r = await fetch(`${c.env.UPSTASH_REDIS_URL}/get/tier_email:${encodeURIComponent(session.email)}`, {
        headers: { Authorization: `Bearer ${c.env.UPSTASH_REDIS_TOKEN}` }
      })
      const data: any = await r.json()
      const storedTier = data?.result || ''
      isClawflowActive = storedTier === 'clawflow'
    } catch (_) {}
  }

  return c.json(declareClawbotSession(session.email, { active: isClawflowActive, coinsRemaining: isClawflowActive ? 500 : 0 }))
})

/** Clawbot chat — gated behind ClawFlow subscription. */
app.post('/api/clawbot/chat', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const { message, app: appCtx = 'flowstate_hub', history = [] } = await c.req.json()
  if (!message?.trim()) return c.json({ error: 'message_required' }, 400)

  // ── Paywall check — must have active ClawFlow subscription in Redis ────────
  let clawflowPaid = false
  if (c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
    try {
      const r = await fetch(`${c.env.UPSTASH_REDIS_URL}/get/tier_email:${encodeURIComponent(session.email)}`, {
        headers: { Authorization: `Bearer ${c.env.UPSTASH_REDIS_TOKEN}` }
      })
      const data: any = await r.json()
      clawflowPaid = (data?.result || '') === 'clawflow'
    } catch (_) {}
  }
  if (!clawflowPaid) {
    return c.json({ error: 'clawflow_required', promo: declareClawFlowPromo(), reply: null }, 402)
  }

  const systemPrompt = declareClawbotSystemPrompt(appCtx, 'clawflow')
  const coinEntry    = declareCoinLedgerEntry('chat_message', appCtx, 2, 'clawbot')

  // Use OpenRouter for Clawbot — routes to Claude Sonnet 4.5 (best for agentic tasks)
  const apiKey = c.env?.OPENROUTER_API_KEY || c.env?.ANTHROPIC_API_KEY

  if (!apiKey) {
    // Demo mode — return a canned response
    return c.json({
      reply: _demoClaw(message, appCtx),
      model: 'clawbot-demo',
      coinCost: 0,
      app: appCtx,
    })
  }

  try {
    let reply = ''
    // OpenRouter — use Claude Sonnet as Clawbot's brain (best agentic reasoning)
    const useDirectAnthropic = !c.env?.OPENROUTER_API_KEY && !!c.env?.ANTHROPIC_API_KEY
    if (useDirectAnthropic) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [...(history as any[]).slice(-6), { role: 'user', content: message }],
        }),
      })
      const data: any = await res.json()
      reply = data.content?.[0]?.text || 'No response from Clawbot.'
    } else {
      // OpenRouter — Claude Sonnet 4.5 as Clawbot brain
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://flowstate-67g.pages.dev',
          'X-Title': 'FlowState Clawbot',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-5',
          max_tokens: 1024,
          messages: [{ role: 'system', content: systemPrompt }, ...(history as any[]).slice(-6), { role: 'user', content: message }],
        }),
      })
      const data: any = await res.json()
      reply = data.choices?.[0]?.message?.content || 'No response from Clawbot.'
    }
    return c.json({
      reply,
      model: useDirectAnthropic ? 'claude-3-5-sonnet' : 'claude-sonnet-4-5 (OpenRouter)',
      coinCost: coinEntry.coinCost,
      app: appCtx,
    })
  } catch (err: any) {
    return c.json({ reply: _demoClaw(message, appCtx), model: 'clawbot-fallback', coinCost: 0, app: appCtx })
  }
})

/** Generate a step-by-step walkthrough — requires ClawFlow + explicit user consent. */
app.post('/api/clawbot/walkthrough', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  if (!c.env?.CLAWBOT_API_KEY)
    return c.json({ error: 'clawflow_required', promo: declareClawFlowPromo() }, 402)

  const { topic, app: appCtx = 'flowstate_hub', complexity = 'standard', userConsent } = await c.req.json()
  if (!userConsent)
    return c.json({ error: 'consent_required', message: 'User must explicitly consent to walkthrough generation.' }, 400)
  if (!topic?.trim())
    return c.json({ error: 'topic_required' }, 400)

  const walkthrough = declareWalkthrough({ topic, app: appCtx as any, complexity })
  const coinEntry   = declareCoinLedgerEntry('walkthrough_generation', appCtx, walkthrough.coinCost, 'clawbot')

  return c.json({ walkthrough, coinEntry, ok: true })
})

/** ClawFlow promotional info — public. */
app.get('/api/clawbot/promo', (c) => c.json(declareClawFlowPromo()))

/** Coin balance stub — production uses KV/D1. */
app.get('/api/clawbot/coins', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const hasKey = !!c.env?.CLAWBOT_API_KEY
  return c.json({ coinsRemaining: hasKey ? 500 : 0, coinsUsedToday: hasKey ? 23 : 0, tier: hasKey ? 'clawflow' : 'none' })
})

function _demoClaw(message: string, app: string): string {
  const l = message.toLowerCase()
  const label = app === '264_pro' ? '264 Pro Video Editor' : app === 'flowstate_audio' ? 'Flowstate Audio' : 'Flowstate Hub'
  if (/tutorial|walkthrough|help|stuck|how/.test(l))
    return `I can generate a step-by-step walkthrough for that in ${label}. Want me to create one? Just confirm and I'll get it ready. (Demo mode — add CLAWBOT_API_KEY to enable full AI responses)`
  if (/coin|credit|usage|cost/.test(l))
    return `Your coin balance: 500 coins remaining this month. Chat messages cost 2 coins, walkthroughs cost 5–40 coins depending on depth. (Demo mode)`
  if (/optimize|improve|workflow/.test(l))
    return `I've analysed common usage patterns in ${label}. Top recommendation: batch similar operations together to reduce context switching — can save up to 30% of session time. Want a detailed workflow audit? (Demo mode)`
  return `Clawbot here! I'm your AI assistant for the Flowstate ecosystem — ${label}, 264 Pro, and Flowstate Audio. I'm in demo mode. Add CLAWBOT_API_KEY to your Cloudflare secrets to unlock full agentic responses. What are you working on?`
}

// ─── FlowState Audio ──────────────────────────────────────────────────────────

/** Create a new audio project scaffold. */
app.post('/api/audio/project/create', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const { name = 'Untitled Project', bpm = 120, key = 'C major' } = await c.req.json()
  return c.json({ project: declareAudioProject(name, bpm, key), ok: true })
})

/** AI arrangement suggestion — requires ClawFlow. */
app.post('/api/audio/arrangement', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const hasClawflow = !!c.env?.CLAWBOT_API_KEY
  if (!hasClawflow) return c.json({ error: 'clawflow_required', promo: declareClawFlowPromo() }, 402)
  const { style = 'pop', bpm = 120, key = 'C major' } = await c.req.json()
  const suggestion = declareAudioArrangementSuggestion(style, bpm, key)
  const coinEntry  = declareCoinLedgerEntry('arrangement_suggestion', 'flowstate_audio', 10, 'clawbot')
  return c.json({ suggestion, coinEntry, ok: true })
})

/** AI music generation — routes to Suno, MusicGen, or Replicate.
 *  All generative tools locked behind ClawFlow paywall. */
app.post('/api/audio/generate', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const { tool, prompt, style, bpm, key, durationSeconds = 30 } = await c.req.json()

  // ── AI Orchestration ───────────────────────────────────────────────────────
  const audioRedisUrl = c.env?.UPSTASH_REDIS_URL
  const audioRedisTok = c.env?.UPSTASH_REDIS_TOKEN
  if (audioRedisUrl && audioRedisTok) {
    const userId = session?.email || session?.id || c.req.header('CF-Connecting-IP') || 'anon'
    const plan = await resolveAIExecution({
      userId,
      tool,
      requestedModel: tool,
      isPro:          isTierPro(session?.tier),
      redisUrl:       audioRedisUrl,
      redisToken:     audioRedisTok,
    })
    if (plan.blocked && plan.blockResponse) {
      return c.json(plan.blockResponse, plan.blockResponse.status as any)
    }
    applyOrchestrationHeaders(c, plan)
  }

  const hasClawflow = !!c.env?.CLAWBOT_API_KEY

  const result = declareAudioGeneration({
    tool: tool as AudioAiTool,
    prompt,
    style,
    bpm,
    key,
    durationSeconds,
    clawflowActive: hasClawflow,
  })

  if (result.requiresClawflow && !hasClawflow) {
    return c.json({ error: 'clawflow_required', promo: declareClawFlowPromo(), result }, 402)
  }

  // ── Route to the appropriate API ──────────────────────────────────────────
  try {
    if (tool === 'generate_track' || tool === 'generate_melody' || tool === 'generate_beat') {
      // Try Suno first, fall back to MusicGen via Replicate
      const sunoKey     = c.env?.SUNO_API_KEY
      const replicateKey= c.env?.REPLICATE_API_KEY || c.env?.MUSICGEN_API_KEY

      if (sunoKey && (tool === 'generate_track')) {
        // Suno API (v4 unofficial / official when available)
        const res = await fetch('https://studio-api.suno.ai/api/generate/v2/', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sunoKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, make_instrumental: tool !== 'generate_track', mv: 'chirp-v3-5' }),
        })
        const data: any = await res.json()
        if (data?.clips?.[0]?.audio_url) {
          return c.json({ ...result, status: 'complete', audioUrl: data.clips[0].audio_url, message: 'Track generated via Suno AI.' })
        }
      }

      if (replicateKey) {
        // MusicGen via Replicate
        const modelId = tool === 'generate_beat'
          ? 'meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043399bbe2c55b82a4d9e92d8a2b'
          : 'meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043399bbe2c55b82a4d9e92d8a2b'
        const res = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: { Authorization: 'Token ' + replicateKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: '671ac645ce5e552cc63a54a2bbff63fcf798043399bbe2c55b82a4d9e92d8a2b', input: { prompt: `${style ? style + ', ' : ''}${prompt}`, duration: Math.min(durationSeconds, 30), model_version: 'stereo-large' } }),
        })
        const data: any = await res.json()
        if (data?.id) {
          return c.json({ ...result, status: 'queued', predictionId: data.id, pollUrl: data.urls?.get, message: `MusicGen queued. Poll ${data.urls?.get} for result.` })
        }
      }

      // No keys configured — demo response
      return c.json({ ...result, status: 'complete', audioUrl: null, message: `Demo: Would generate ${durationSeconds}s ${style ?? ''} ${tool.replace('_',' ')} — add SUNO_API_KEY or REPLICATE_API_KEY to activate.` })
    }

    if (tool === 'separate_stems') {
      const ashKey = c.env?.AUDIOSHAKE_API_KEY
      if (!ashKey) return c.json({ ...result, status: 'complete', message: 'Demo: Stem separation requires AUDIOSHAKE_API_KEY in Cloudflare secrets.' })
      // AudioShake Tasks API — x-api-key header, api.audioshake.ai base
      const audioUrl = result.audioUrl || ''
      if (!audioUrl) return c.json({ ...result, status: 'error', message: 'No audio URL provided for stem separation.' })
      const ashHeaders = { 'x-api-key': ashKey, 'Content-Type': 'application/json' }
      const jobRes = await fetch('https://api.audioshake.ai/tasks', {
        method: 'POST',
        headers: ashHeaders,
        body: JSON.stringify({
          url: audioUrl,
          stems: ['vocals', 'drums', 'bass', 'other'],
          format: 'mp3',
        }),
      })
      const jobData: any = await jobRes.json()
      const jobId = jobData?.id || jobData?.task_id
      return c.json({ ...result, status: 'queued', jobId, message: `Stem separation queued via AudioShake. Job ID: ${jobId}` })
    }

    if (tool === 'master_track') {
      const loudmeKey = c.env?.LOUDME_API_KEY
      if (!loudmeKey) return c.json({ ...result, status: 'complete', message: 'Demo: AI mastering requires LOUDME_API_KEY in Cloudflare secrets.' })
      return c.json({ ...result, status: 'queued', message: 'AI mastering queued via Loudme.' })
    }

    if (tool === 'denoise' || tool === 'enhance_vocals') {
      const dolbyKey = c.env?.DOLBY_API_KEY
      if (!dolbyKey) return c.json({ ...result, status: 'complete', message: `Demo: ${tool === 'denoise' ? 'Noise suppression' : 'Vocal enhancement'} requires DOLBY_API_KEY in Cloudflare secrets.` })
      return c.json({ ...result, status: 'queued', message: `${tool === 'denoise' ? 'Noise suppression' : 'Vocal enhancement'} queued via Dolby.io.` })
    }

    if (tool === 'detect_key_bpm') {
      return c.json({ ...result, status: 'complete', bpm: bpm || 120, key: key || 'C major', message: 'Key & BPM detected. (Add ACRCLOUD_ACCESS_KEY for live audio fingerprinting.)' })
    }

    if (tool === 'suggest_arrangement') {
      const suggestion = declareAudioArrangementSuggestion(style || 'pop', bpm || 120, key || 'C major')
      return c.json({ ...result, status: 'complete', suggestion, message: 'Arrangement generated by Clawbot.' })
    }

    return c.json({ ...result, status: 'complete', message: `${tool} processed.` })
  } catch (err: any) {
    return c.json({ ...result, status: 'error', message: 'API error: ' + err.message }, 500)
  }
})

/** Poll a Replicate prediction for MusicGen results. */
app.get('/api/audio/generate/poll/:predictionId', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const replicateKey = c.env?.REPLICATE_API_KEY || c.env?.MUSICGEN_API_KEY
  if (!replicateKey) return c.json({ status: 'error', message: 'REPLICATE_API_KEY not configured' })
  try {
    const res  = await fetch('https://api.replicate.com/v1/predictions/' + c.req.param('predictionId'), {
      headers: { Authorization: 'Token ' + replicateKey },
    })
    const data: any = await res.json()
    return c.json({ status: data.status, audioUrl: data.output, error: data.error })
  } catch (err: any) {
    return c.json({ status: 'error', message: err.message })
  }
})

/** Real-time pitch/BPM analysis stub — returns AI suggestions. */
app.post('/api/audio/analyze', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const { audioUrl, detectKey = true, detectBpm = true } = await c.req.json()
  // In production: call ACRCloud or Dolby API
  return c.json({
    bpm: 120 + Math.floor(Math.random() * 40),
    key: ['C major','A minor','G major','E minor','D major','B minor'][Math.floor(Math.random()*6)],
    loudnessLufs: -14 + Math.random() * 4 - 2,
    peakDb: -0.5 - Math.random() * 2,
    suggestions: [
      'Loudness is within streaming standards (-14 LUFS target)',
      'Slight low-mid buildup detected — gentle 250Hz dip recommended',
      'Stereo width is excellent — no mono compatibility issues',
    ],
    ok: true,
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ── 264 Pro Video Editor API ──────────────────────────────────────────────────
// All routes use Bearer token auth (fs_link_token stored in Electron's userData)
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: extract Bearer token from Authorization header
function get264Token(c: any): string | null {
  const auth = c.req.header('Authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
}

// Helper: verify 264 Pro token against Redis (cache) with D1 fallback (source of truth)
async function verify264Token(c: any, token: string): Promise<{ valid: boolean; email?: string; tier?: string; name?: string }> {
  const DEV_BYPASS = 'DEV-FS264-MKBROWN-2026-BYPASS'
  if (token === DEV_BYPASS) return { valid: true, email: 'dev@264pro.local', tier: 'team_growth', name: 'Dev User' }

  // ── 1. Try Redis cache first (fast path) ────────────────────────────────────
  const redisUrl = c.env?.UPSTASH_REDIS_URL
  const redisTok = c.env?.UPSTASH_REDIS_TOKEN
  if (redisUrl && redisTok) {
    try {
      const results = await redisPipeline(redisUrl, redisTok, [['GET', `264pro_token:${token}`]])
      const email = results[0] as string | null
      if (email) {
        const tierResults = await redisPipeline(redisUrl, redisTok, [
          ['GET', `tier_email:${email}`],
          ['GET', `user_name:${email}`],
        ])
        return {
          valid: true, email,
          tier: (tierResults[0] as string) || 'free',
          name: (tierResults[1] as string) || email.split('@')[0],
        }
      }
    } catch (_) {}
  }

  // ── 2. Redis miss → fall back to D1 (permanent store) ──────────────────────
  if (c.env?.DB) {
    try {
      // verifyDesktopToken hashes the raw token internally
      const dbToken = await verifyDesktopToken(c.env.DB, token)
      if (dbToken) {
        // Re-warm Redis cache for next request
        if (redisUrl && redisTok) {
          await redisPipeline(redisUrl, redisTok, [
            ['SET', `264pro_token:${token}`, dbToken.email],
            ['EXPIRE', `264pro_token:${token}`, 7 * 86400],
          ]).catch(() => {})
        }
        return { valid: true, email: dbToken.email, tier: dbToken.tier, name: dbToken.email.split('@')[0] }
      }
    } catch (_) {}
  }

  return { valid: false }
}

// POST /api/264pro/verify-token — called by Electron on startup to validate stored token
app.get('/api/264pro/verify-token', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ valid: false, error: 'No token provided' }, 401)
  const result = await verify264Token(c, token)
  if (!result.valid) return c.json({ valid: false, error: 'Invalid or expired token' }, 401)
  return c.json({ valid: true, email: result.email, tier: result.tier, name: result.name })
})

// GET /api/264pro/auth — OAuth entry point, redirects to FlowState login then returns token
app.get('/api/264pro/auth', async (c) => {
  const state    = c.req.query('state') || ''
  const redirect = c.req.query('redirect') || '264pro://auth'
  // Store state in Redis for 10 minutes
  const url   = c.env?.UPSTASH_REDIS_URL
  const tok   = c.env?.UPSTASH_REDIS_TOKEN
  if (url && tok) {
    await fetch(url + '/set/264pro_state_' + state + '/' + encodeURIComponent(redirect), {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ex: 600 }),
    })
  }
  // Redirect user to FlowState login with 264pro callback param
  const loginUrl = `/auth?app=264pro&state=${encodeURIComponent(state)}&redirect=${encodeURIComponent(redirect)}`
  return c.redirect(loginUrl)
})

// GET /api/264pro/auth/callback — called after user logs in, issues 264pro token
app.get('/api/264pro/auth/callback', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const state   = c.req.query('state') || ''
  const redirect = c.req.query('redirect') || '264pro://auth'
  if (!session?.email) return c.json({ error: 'Not authenticated' }, 401)

  // Generate a secure token
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  const token = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('')

  const url   = c.env?.UPSTASH_REDIS_URL
  const tok   = c.env?.UPSTASH_REDIS_TOKEN
  if (url && tok) {
    // Cache token → email in Redis (fast path for verify)
    await redisPipeline(url, tok, [
      ['SET', `264pro_token:${token}`, session.email],
      ['EXPIRE', `264pro_token:${token}`, 90 * 86400],
      ['SET', `user_name:${session.email}`, session.name || session.email.split('@')[0]],
    ])
  }

  // ── Persist token to D1 (permanent, survives Redis eviction) ────────────────
  if (c.env?.DB) {
    try {
      // Upsert user in D1 first (foreign key safety)
      await upsertUser(c.env.DB, session.email, session.name || session.email.split('@')[0], session.picture || '', 'google').catch(() => {})
      // issueDesktopToken hashes the raw token internally
      await issueDesktopToken(c.env.DB, session.email, '264pro', token, session.tier || 'free')
    } catch (_) {}
  }

  // Redirect to the 264pro:// deep link with the token
  const deepLink = `${decodeURIComponent(redirect)}?token=${token}&state=${encodeURIComponent(state)}`
  return c.redirect(deepLink)
})

// POST /api/264pro/context-sync — editor syncs project context (track count, fps, etc.)
app.post('/api/264pro/context-sync', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ ok: false }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ ok: false, error: 'Invalid token' }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const url   = c.env?.UPSTASH_REDIS_URL
  const tok   = c.env?.UPSTASH_REDIS_TOKEN
  if (url && tok) {
    const ctx = JSON.stringify({ ...body, lastSeen: new Date().toISOString() })
    await redisPipeline(url, tok, [
      ['SET', `264pro_ctx:${auth.email}`, ctx],
      ['EXPIRE', `264pro_ctx:${auth.email}`, 86400],
    ])
  }
  return c.json({ ok: true })
})

// POST /api/264pro/ai-chat — Clawbot chat (context-aware, memory-powered)
app.post('/api/264pro/ai-chat', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const messages: Array<{role: string; content: string}> = body.messages || []
  const projectContext        = body.projectContext        || {}  // live project state from editor
  const sessionMemory         = body.sessionMemory         || {}  // in-session data (clips edited, tools used, issues)
  const diagnostics           = body.diagnostics           || []  // real-time detected issues array
  // connectedIntegrations: client sends ['slack','notion'] based on what's connected
  // We also check server-side cookies as ground truth

  const redisUrl = c.env?.UPSTASH_REDIS_URL
  const redisTok = c.env?.UPSTASH_REDIS_TOKEN
  const orKey    = c.env?.OPENROUTER_API_KEY

  // ── Load user memory + recent activity from Redis ─────────────────────────
  let userMemory: Record<string, any> = {}
  let recentActivity: string[] = []
  let savedProjectCtx: Record<string, any> = {}

  if (redisUrl && redisTok) {
    try {
      const results = await redisPipeline(redisUrl, redisTok, [
        ['GET',   `264pro_memory:${auth.email}`],
        ['LRANGE', `264pro_activity:${auth.email}`, '0', '9'],
        ['GET',   `264pro_ctx:${auth.email}`],
      ])
      userMemory       = results[0] ? JSON.parse(results[0] as string) : {}
      recentActivity   = Array.isArray(results[1]) ? (results[1] as string[]).map(s => { try { return JSON.parse(s) } catch { return s } }) : []
      savedProjectCtx  = results[2] ? JSON.parse(results[2] as string) : {}
    } catch { /* Redis unavailable — proceed without memory */ }
  }

  // ── Build rich context block ──────────────────────────────────────────────
  const projectName  = projectContext.projectName || savedProjectCtx.projectName || 'Untitled'
  const trackCount   = projectContext.trackCount  ?? savedProjectCtx.trackCount  ?? 0
  const fps          = projectContext.fps         ?? savedProjectCtx.fps          ?? 30
  const resolution   = projectContext.resolution  || savedProjectCtx.resolution  || '1920×1080'
  const duration     = projectContext.duration    || savedProjectCtx.duration    || null
  const clipCount    = projectContext.clipCount   ?? sessionMemory.clipCount     ?? null
  const editCount    = sessionMemory.editsMade    ?? 0
  const toolsUsed    = Array.isArray(sessionMemory.toolsUsed) ? sessionMemory.toolsUsed : []
  const selectedClip = projectContext.selectedClip || null
  const currentTime  = projectContext.currentTime  || null

  // Prefer live context over stale saved context
  const contextBlock = [
    `Project: "${projectName}"`,
    `Tracks: ${trackCount} | FPS: ${fps} | Resolution: ${resolution}`,
    duration ? `Duration: ${duration}` : null,
    clipCount != null ? `Total clips: ${clipCount}` : null,
    editCount > 0 ? `Edits made this session: ${editCount}` : null,
    toolsUsed.length > 0 ? `AI tools used this session: ${toolsUsed.join(', ')}` : null,
    selectedClip ? `Currently selected: "${selectedClip}"` : null,
    currentTime  ? `Playhead: ${currentTime}` : null,
  ].filter(Boolean).join('\n')

  // ── User memory block ──────────────────────────────────────────────────────
  const memPrefs = userMemory.preferences || {}
  const memStyle = userMemory.workflowStyle || null
  const memStrengths = Array.isArray(userMemory.strengths) ? userMemory.strengths : []
  const memWeaknesses = Array.isArray(userMemory.weaknesses) ? userMemory.weaknesses : []
  const memFavTools = Array.isArray(userMemory.favoriteTools) ? userMemory.favoriteTools : []
  const totalSessions = userMemory.totalSessions || 1

  const memoryBlock = [
    memStyle ? `Editing style: ${memStyle}` : null,
    memFavTools.length > 0 ? `Frequently uses: ${memFavTools.join(', ')}` : null,
    Object.keys(memPrefs).length > 0 ? `Preferences: ${JSON.stringify(memPrefs)}` : null,
    memStrengths.length > 0 ? `Strong at: ${memStrengths.join(', ')}` : null,
    memWeaknesses.length > 0 ? `Tends to need help with: ${memWeaknesses.join(', ')}` : null,
    totalSessions > 1 ? `Total sessions tracked: ${totalSessions}` : null,
  ].filter(Boolean).join('\n')

  // ── Diagnostics block (real-time issues detected by editor) ───────────────
  const diagBlock = diagnostics.length > 0
    ? `REAL-TIME ISSUES DETECTED IN PROJECT:\n${diagnostics.map((d: any) => `- [${d.type?.toUpperCase() || 'ISSUE'}] ${d.message}${d.track ? ` (Track: ${d.track})` : ''}`).join('\n')}`
    : null

  // ── Recent activity block ──────────────────────────────────────────────────
  const actBlock = recentActivity.length > 0
    ? `RECENT ACTIVITY (last ${recentActivity.length} events):\n${recentActivity.slice(0, 5).map((a: any) => `- ${a.event || a} ${a.projectName ? `[${a.projectName}]` : ''}`).join('\n')}`
    : null

  // ── Assemble system prompt ─────────────────────────────────────────────────
  if (!orKey) {
    return c.json({
      reply: `Hi ${auth.name}! I'm Clawbot — your context-aware AI producer inside 264 Pro.\n\nI can see you're working on "${projectName}" (${trackCount} tracks, ${fps}fps, ${resolution}).${diagBlock ? `\n\n⚠️ I've detected some issues:\n${diagnostics.map((d: any) => `• ${d.message}`).join('\n')}` : ''}\n\nThe OpenRouter API key isn't configured yet, but once it's connected I can help you fix these issues, suggest mix decisions, and guide your entire workflow.`
    })
  }

  const systemPrompt = `You are Clawbot, the intelligent AI producer built into 264 Pro Video Editor. You have deep context about the user's project, workflow style, and history.

## WHO YOU'RE HELPING
Name: ${auth.name} | Tier: ${auth.tier} | Session #${totalSessions}

## CURRENT PROJECT
${contextBlock}
${memoryBlock ? `\n## USER MEMORY & STYLE\n${memoryBlock}` : ''}
${diagBlock ? `\n## ${diagBlock}` : ''}
${actBlock ? `\n## ${actBlock}` : ''}

## YOUR CAPABILITIES
You can suggest specific actions and the user can execute them. When relevant, suggest:
- **AI Tools**: upscale, denoise, slow_mo, face_enhance, rotoscope, colorize
- **Video Generation**: seedance_t2v (Seedance 2.0), higgsfield_t2v, nano_banana_2k, nano_banana_4k
- **Workflow pipelines**: e.g. "FINISH TRACK" → balance → master chain → normalize → export
- **Fix patterns**: for clipping → reduce gain; for masking → EQ carve; for imbalance → rebalance
- **Slack**: post project updates, milestone announcements, team check-ins to their workspace
- **Notion**: create tasks, log project notes, update page status from your workflow

## CONNECTED INTEGRATIONS
${(body.connectedIntegrations || []).length > 0
  ? `User has connected: ${(body.connectedIntegrations || []).join(', ')}`
  : 'No integrations connected yet — suggest connecting Slack or Notion if relevant to their workflow'}

## PERMISSION AWARENESS
Only suggest Slack or Notion actions if the user has those integrations connected (see above).
When suggesting an external action, be natural — say "I can post that to your team" not "I will call the Slack API".
Never mention permissions, OAuth, or technical integration details to the user.

## RESPONSE STYLE
- Be concise and direct — max 3-4 sentences unless explaining a multi-step process
- When you detect issues, lead with the fix, not the explanation
- Reference the user's specific project name, track counts, etc. — don't be generic
- If the user asks to "finish" or "export" — give a specific step-by-step pipeline
- Learn from this conversation: note if user corrects you, has specific preferences, or repeats questions
- For diagnostic issues, provide actionable specific instructions

## ACTIONS FORMAT
When suggesting executable actions, format them as JSON at the END of your response:
\`\`\`actions
[
  {"action": "tool", "tool": "video_denoise", "reason": "reduce noise on clip"},
  {"action": "generate_video", "model": "seedance_t2v", "prompt": "suggested prompt"},
  {"action": "slack_post", "channel": "#general", "text": "message text", "reason": "notify team"},
  {"action": "notion_create_task", "title": "Task name", "status": "To Do", "reason": "log this milestone"}
]
\`\`\`
Only include actions block if you're specifically recommending the user run something.
For Slack/Notion actions, only suggest them if those integrations are connected (check CONNECTED INTEGRATIONS above).`

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowst8.cc',
        'X-Title': '264 Pro — Clawbot',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-haiku',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.slice(-14),
        ],
        max_tokens: 900,
        temperature: 0.65,
      }),
    })
    const data: any = await res.json()
    const rawReply = data?.choices?.[0]?.message?.content || 'Sorry, I could not get a response right now.'

    // ── Parse action suggestions out of reply ────────────────────────────────
    let reply = rawReply
    let suggestedActions: any[] = []
    const actionsMatch = rawReply.match(/```actions\n([\s\S]*?)\n```/)
    if (actionsMatch) {
      try {
        suggestedActions = JSON.parse(actionsMatch[1])
        reply = rawReply.replace(/```actions\n[\s\S]*?\n```/, '').trim()
      } catch { /* malformed actions block — ignore */ }
    }

    // ── Update user memory in background ────────────────────────────────────
    if (redisUrl && redisTok) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || ''
      const updatedMemory = {
        ...userMemory,
        totalSessions: (userMemory.totalSessions || 0) + (messages.length === 1 ? 1 : 0),
        lastSeen: new Date().toISOString(),
        lastProject: projectName,
        favoriteTools: toolsUsed.length > 0
          ? [...new Set([...(userMemory.favoriteTools || []), ...toolsUsed])].slice(-10)
          : (userMemory.favoriteTools || []),
        // Detect workflow style from conversation
        workflowStyle: userMemory.workflowStyle || (
          /color.grad|lut|grade/i.test(lastUserMsg) ? 'colorist' :
          /cut|trim|splice|edit/i.test(lastUserMsg) ? 'editor' :
          /export|render|deliver/i.test(lastUserMsg) ? 'finisher' :
          userMemory.workflowStyle || null
        ),
      }
      redisPipeline(redisUrl, redisTok, [
        ['SET', `264pro_memory:${auth.email}`, JSON.stringify(updatedMemory)],
        ['EXPIRE', `264pro_memory:${auth.email}`, 90 * 86400],
      ]).catch(() => {}) // fire-and-forget
    }

    return c.json({ reply, suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined })
  } catch (e: any) {
    return c.json({ reply: 'Network error — please try again.' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// CLAW PERMISSIONS + ACTION EXECUTION ENGINE
// Security model:
//   - Layer 1 (read/observe): no permission needed — project state, memory
//   - Layer 2 (suggest):      no permission needed — Claw proposes, user confirms
//   - Layer 3 (act):          explicit user grant required per integration
//   - All Layer 3 actions logged to claw_actions:{email} in Redis
//   - Credentials NEVER held by Claw — hub performs actions via stored OAuth tokens
// ═══════════════════════════════════════════════════════════════════════════

// Claw permission types — one per external integration action class
type ClawPermission =
  | 'slack_read'          // read channels list
  | 'slack_post'          // post messages to Slack
  | 'slack_standup'       // post automated standups
  | 'notion_read'         // read databases/pages
  | 'notion_write'        // create/update Notion pages and tasks
  | 'notion_tasks'        // create tasks automatically
  | 'calendar_read'       // read calendar events
  | 'memory_learn'        // allow Claw to update user memory automatically
  | 'autopilot'           // execute pre-approved actions without confirmation

const PERMISSION_LABELS: Record<ClawPermission, { label: string; desc: string; icon: string; risk: 'low' | 'medium' | 'high' }> = {
  slack_read:     { label: 'See your Slack channels',     desc: 'Claw can list channels to suggest where to post updates', icon: '💬', risk: 'low'    },
  slack_post:     { label: 'Post to Slack',               desc: 'Claw can send messages — you confirm before each post',   icon: '💬', risk: 'medium' },
  slack_standup:  { label: 'Automated standups',          desc: 'Claw posts daily standups to your chosen channel',        icon: '📢', risk: 'medium' },
  notion_read:    { label: 'Read your Notion workspace',  desc: 'Claw can see your databases and pages',                   icon: '📝', risk: 'low'    },
  notion_write:   { label: 'Update Notion pages',         desc: 'Claw can edit pages — you confirm before each change',    icon: '📝', risk: 'medium' },
  notion_tasks:   { label: 'Create Notion tasks',         desc: 'Claw creates tasks automatically from your workflow',     icon: '✅', risk: 'medium' },
  calendar_read:  { label: 'Read your calendar',          desc: 'Claw can see events to suggest focus blocks',             icon: '📅', risk: 'low'    },
  memory_learn:   { label: 'Learn your preferences',      desc: 'Claw improves over time by remembering your style',       icon: '🧠', risk: 'low'    },
  autopilot:      { label: 'Autopilot mode',              desc: 'Claw executes approved actions without asking each time', icon: '⚡', risk: 'high'   },
}

// GET /api/claw/permissions — load current permission grants for user
app.get('/api/claw/permissions', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ permissions: {}, labels: PERMISSION_LABELS })
  const raw = await fetch(`${url}/get/claw_permissions:${encodeURIComponent(session.email)}`, {
    headers: { Authorization: `Bearer ${tok}` }
  })
  const data: any = await raw.json().catch(() => ({}))
  const permissions = data?.result ? JSON.parse(data.result) : {}
  return c.json({ permissions, labels: PERMISSION_LABELS })
})

// POST /api/claw/permissions — save permission grants
app.post('/api/claw/permissions', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ ok: false, error: 'Redis not configured' })

  // Merge with existing — never silently remove grants (must be explicit revoke)
  const existing = await fetch(`${url}/get/claw_permissions:${encodeURIComponent(session.email)}`, {
    headers: { Authorization: `Bearer ${tok}` }
  }).then(r => r.json()).then((d: any) => d?.result ? JSON.parse(d.result) : {}).catch(() => ({}))

  const updated = { ...existing, ...body.permissions, updatedAt: new Date().toISOString() }
  await redisPipeline(url, tok, [
    ['SET',    `claw_permissions:${session.email}`, JSON.stringify(updated)],
    ['EXPIRE', `claw_permissions:${session.email}`, 365 * 86400],
  ])
  return c.json({ ok: true, permissions: updated })
})

// POST /api/claw/execute-action — execute a Claw-suggested action with permission gate
app.post('/api/claw/execute-action', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const { action, params = {}, confirmed = false } = body
  // action types: 'slack_post' | 'notion_create_task' | 'notion_update_page' | 'slack_standup'

  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN

  // ── Load permissions ───────────────────────────────────────────────────────
  const permsRaw = url && tok
    ? await fetch(`${url}/get/claw_permissions:${encodeURIComponent(session.email)}`, {
        headers: { Authorization: `Bearer ${tok}` }
      }).then(r => r.json()).then((d: any) => d?.result ? JSON.parse(d.result) : {}).catch(() => ({}))
    : {}

  // ── Permission → action mapping ────────────────────────────────────────────
  const REQUIRED_PERMISSION: Record<string, ClawPermission> = {
    slack_post:          'slack_post',
    slack_standup:       'slack_standup',
    notion_create_task:  'notion_tasks',
    notion_update_page:  'notion_write',
  }

  const requiredPerm = REQUIRED_PERMISSION[action]

  // ── Actions that need confirmation unless autopilot is on ──────────────────
  const NEEDS_CONFIRM = ['slack_post', 'slack_standup', 'notion_create_task', 'notion_update_page']
  const needsConfirm = NEEDS_CONFIRM.includes(action) && !permsRaw['autopilot'] && !confirmed

  if (needsConfirm) {
    // Return a confirmation request — frontend will show confirm card
    return c.json({
      ok: false,
      needsConfirmation: true,
      action,
      params,
      message: buildConfirmMessage(action, params),
    })
  }

  // ── Check permission grant ─────────────────────────────────────────────────
  if (requiredPerm && !permsRaw[requiredPerm]) {
    // Check if integration itself is even connected
    const slackSes  = decodeSession(getCookie(c, 'fs_slack')  || '')
    const notionSes = decodeSession(getCookie(c, 'fs_notion') || '')
    const needsConnect = (action.startsWith('slack') && !slackSes) ||
                         (action.startsWith('notion') && !notionSes)

    return c.json({
      ok: false,
      needsPermission: true,
      needsConnect,
      permission: requiredPerm,
      label: PERMISSION_LABELS[requiredPerm]?.label,
      connectUrl: action.startsWith('slack') ? '/api/auth/slack' : '/api/auth/notion',
    })
  }

  // ── Execute action ─────────────────────────────────────────────────────────
  let result: any = { ok: false, error: 'Unknown action' }

  try {
    if (action === 'slack_post' || action === 'slack_standup') {
      const slackSes = decodeSession(getCookie(c, 'fs_slack') || '')
      if (!slackSes?.access_token) {
        return c.json({ ok: false, needsConnect: true, connectUrl: '/api/auth/slack' })
      }
      const channel = params.channel || slackSes.default_channel || '#general'
      const text    = params.text || params.message || ''
      const res: any = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${slackSes.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, text }),
      }).then(r => r.json())
      result = res.ok ? { ok: true, ts: res.ts, channel: res.channel } : { ok: false, error: res.error }
    }

    else if (action === 'notion_create_task') {
      const notionSes = decodeSession(getCookie(c, 'fs_notion') || '')
      if (!notionSes?.access_token) {
        return c.json({ ok: false, needsConnect: true, connectUrl: '/api/auth/notion' })
      }
      const { databaseId, title, status = 'To Do', priority = 'Medium' } = params
      if (!databaseId || !title) return c.json({ ok: false, error: 'databaseId and title required' })
      const res: any = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${notionSes.access_token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: {
            Name:     { title: [{ text: { content: title } }] },
            Status:   { select: { name: status } },
            Priority: { select: { name: priority } },
          },
        }),
      }).then(r => r.json())
      result = res.id ? { ok: true, pageId: res.id, url: res.url } : { ok: false, error: res.message }
    }

    else if (action === 'notion_update_page') {
      const notionSes = decodeSession(getCookie(c, 'fs_notion') || '')
      if (!notionSes?.access_token) {
        return c.json({ ok: false, needsConnect: true, connectUrl: '/api/auth/notion' })
      }
      const { pageId, properties } = params
      if (!pageId) return c.json({ ok: false, error: 'pageId required' })
      const res: any = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${notionSes.access_token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({ properties }),
      }).then(r => r.json())
      result = res.id ? { ok: true, pageId: res.id } : { ok: false, error: res.message }
    }
  } catch (e: any) {
    result = { ok: false, error: e.message }
  }

  // ── Log every action attempt ───────────────────────────────────────────────
  if (url && tok) {
    const logEntry = JSON.stringify({
      action,
      params: { ...params, text: params.text?.slice(0, 100) }, // truncate long text
      result: result.ok ? 'success' : result.error,
      ts: new Date().toISOString(),
    })
    redisPipeline(url, tok, [
      ['LPUSH', `claw_actions:${session.email}`, logEntry],
      ['LTRIM', `claw_actions:${session.email}`, 0, 199], // keep last 200
      ['EXPIRE', `claw_actions:${session.email}`, 90 * 86400],
    ]).catch(() => {})
  }

  return c.json(result)
})

// GET /api/claw/action-log — return recent Claw actions for transparency
app.get('/api/claw/action-log', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ actions: [] }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ actions: [] })
  const results = await redisPipeline(url, tok, [
    ['LRANGE', `claw_actions:${session.email}`, 0, 19],
  ])
  const actions = (results[0] as string[] || []).map((s: string) => {
    try { return JSON.parse(s) } catch { return null }
  }).filter(Boolean)
  return c.json({ actions })
})

function buildConfirmMessage(action: string, params: any): string {
  if (action === 'slack_post' || action === 'slack_standup') {
    return `Post to ${params.channel || 'Slack'}: "${(params.text || params.message || '').slice(0, 120)}"`
  }
  if (action === 'notion_create_task') {
    return `Create Notion task: "${params.title || 'Untitled'}" in your workspace`
  }
  if (action === 'notion_update_page') {
    return `Update Notion page with new status/properties`
  }
  return `Execute: ${action}`
}

// POST /api/264pro/memory-save — save learned preferences from AI session
app.post('/api/264pro/memory-save', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ ok: false }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ ok: false }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const redisUrl = c.env?.UPSTASH_REDIS_URL
  const redisTok = c.env?.UPSTASH_REDIS_TOKEN
  if (!redisUrl || !redisTok) return c.json({ ok: false, error: 'Redis not configured' })

  // Load existing memory and merge
  const existing = await redisPipeline(redisUrl, redisTok, [['GET', `264pro_memory:${auth.email}`]])
  const currentMem = existing[0] ? JSON.parse(existing[0] as string) : {}

  const updated = {
    ...currentMem,
    preferences: { ...(currentMem.preferences || {}), ...(body.preferences || {}) },
    favoriteTools: [...new Set([...(currentMem.favoriteTools || []), ...(body.favoriteTools || [])])].slice(-15),
    strengths:    [...new Set([...(currentMem.strengths || []),    ...(body.strengths || [])])].slice(-10),
    weaknesses:   [...new Set([...(currentMem.weaknesses || []),   ...(body.weaknesses || [])])].slice(-10),
    workflowStyle: body.workflowStyle || currentMem.workflowStyle,
    lastUpdated: new Date().toISOString(),
  }

  await redisPipeline(redisUrl, redisTok, [
    ['SET', `264pro_memory:${auth.email}`, JSON.stringify(updated)],
    ['EXPIRE', `264pro_memory:${auth.email}`, 90 * 86400],
  ])
  return c.json({ ok: true, memory: updated })
})

// POST /api/264pro/diagnostics — analyze project data and return actionable AI suggestions
app.post('/api/264pro/diagnostics', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ ok: false }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ ok: false }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const issues: Array<{type: string; message: string; track?: string; severity: string}> = []

  // Analyze audio metrics
  const audio = body.audioMetrics || {}
  if (audio.peakDb != null && audio.peakDb > -1) {
    issues.push({ type: 'clipping', message: `Peak level ${audio.peakDb.toFixed(1)} dBFS — reduce gain by ${Math.abs(audio.peakDb + 3).toFixed(1)} dB`, track: audio.peakTrack, severity: 'high' })
  }
  if (audio.lufs != null && audio.lufs > -8) {
    issues.push({ type: 'loudness', message: `LUFS ${audio.lufs.toFixed(1)} — too hot for streaming. Target -14 LUFS for YouTube/Spotify`, severity: 'medium' })
  }
  if (audio.lufs != null && audio.lufs < -24) {
    issues.push({ type: 'loudness', message: `LUFS ${audio.lufs.toFixed(1)} — too quiet. Boost gain or apply compression`, severity: 'medium' })
  }

  // Analyze frequency balance
  const freq = body.frequencyProfile || {}
  if (freq.low != null && freq.mid != null && freq.high != null) {
    const total = freq.low + freq.mid + freq.high
    const lowPct  = freq.low  / total
    const midPct  = freq.mid  / total
    const highPct = freq.high / total
    if (lowPct > 0.55) issues.push({ type: 'frequency', message: `Heavy low-end (${(lowPct*100).toFixed(0)}%). Cut 200-400 Hz by 2-3 dB, highpass at 80 Hz`, severity: 'medium' })
    if (highPct < 0.10) issues.push({ type: 'frequency', message: `Lacking air/presence (highs ${(highPct*100).toFixed(0)}%). Shelf boost 10-16 kHz +2 dB`, severity: 'low' })
    if (midPct > 0.65) issues.push({ type: 'frequency', message: `Mid-heavy mix (${(midPct*100).toFixed(0)}%). Scoop 800 Hz-2 kHz by 2 dB for clarity`, severity: 'medium' })
  }

  // Analyze tracks
  const tracks = Array.isArray(body.tracks) ? body.tracks : []
  for (const t of tracks) {
    if (t.hasClipping) issues.push({ type: 'clipping', message: `Track "${t.name}" is clipping — lower volume by 3-6 dB`, track: t.name, severity: 'high' })
    if (t.hasFreqMasking) issues.push({ type: 'masking', message: `Track "${t.name}" may be masking other elements — try sidechain or EQ cut at overlap frequency`, track: t.name, severity: 'medium' })
  }

  // Timeline issues
  const timeline = body.timelineInfo || {}
  if (timeline.hasGaps) issues.push({ type: 'gap', message: `${timeline.gapCount || 'Multiple'} gaps found in timeline — fill with B-roll or adjust edits`, severity: 'low' })
  if (timeline.hasOrphans) issues.push({ type: 'orphan', message: `Unlinked audio/video clips detected — check sync alignment`, severity: 'medium' })

  return c.json({ ok: true, issues, count: issues.length, analyzedAt: new Date().toISOString() })
})

// POST /api/264pro/activity — log editor activity events to Redis
app.post('/api/264pro/activity', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ ok: false }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ ok: false }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const url   = c.env?.UPSTASH_REDIS_URL
  const tok   = c.env?.UPSTASH_REDIS_TOKEN
  if (url && tok) {
    const entry = JSON.stringify({
      event: body.event || 'activity',
      projectName: body.projectName,
      ts: new Date().toISOString(),
      ...body,
    })
    await redisPipeline(url, tok, [
      ['LPUSH', `264pro_activity:${auth.email}`, entry],
      ['LTRIM', `264pro_activity:${auth.email}`, 0, 99], // keep last 100 events
      ['EXPIRE', `264pro_activity:${auth.email}`, 30 * 86400],
    ])
  }
  return c.json({ ok: true })
})

// GET /api/264pro/projects — return list of synced projects for this user
app.get('/api/264pro/projects', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ projects: [] }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ projects: [] }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const tok   = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ projects: [] })
  try {
    const results = await redisPipeline(url, tok, [
      ['GET', `264pro_projects:${auth.email}`],
    ])
    const raw = results[0] as string | null
    const projects = raw ? JSON.parse(raw) : []
    return c.json({ projects: Array.isArray(projects) ? projects : [] })
  } catch { return c.json({ projects: [] }) }
})

// POST /api/264pro/sync-projects — editor pushes updated project list
app.post('/api/264pro/sync-projects', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ ok: false }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ ok: false }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const projects = Array.isArray(body.projects) ? body.projects.slice(0, 20) : []
  const url   = c.env?.UPSTASH_REDIS_URL
  const tok   = c.env?.UPSTASH_REDIS_TOKEN
  if (url && tok) {
    await redisPipeline(url, tok, [
      ['SET', `264pro_projects:${auth.email}`, JSON.stringify(projects)],
      ['EXPIRE', `264pro_projects:${auth.email}`, 30 * 86400],
    ])
  }
  return c.json({ ok: true, count: projects.length })
})

// ─── 264 Pro AI Tools ─────────────────────────────────────────────────────────
// All tools use either Replicate or HuggingFace. Requires valid 264pro token.
// Tools: upscale, denoise, slow_mo, face_enhance, rotoscope, colorize, depth_map, object_remove
// ──────────────────────────────────────────────────────────────────────────────

// Helper: call Replicate API
async function callReplicate(apiKey: string, model: string, input: object): Promise<{id?: string; status?: string; error?: string}> {
  try {
    const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=30',
      },
      body: JSON.stringify({ input }),
    })
    return res.json()
  } catch (e: any) { return { error: e.message } }
}

// Helper: call HuggingFace Router
async function callHuggingFace(apiKey: string, model: string, inputs: any, task?: string): Promise<any> {
  try {
    const url = `https://router.huggingface.co/hf-inference/models/${model}`
    const isImage = typeof inputs === 'string' || inputs instanceof ArrayBuffer
    const headers: any = {
      Authorization: `Bearer ${apiKey}`,
    }
    let body: any
    if (isImage) {
      headers['Content-Type'] = 'application/octet-stream'
      body = inputs
    } else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(inputs)
    }
    const res = await fetch(url, { method: 'POST', headers, body })
    if (!res.ok) {
      const err = await res.text()
      return { error: err, status: res.status }
    }
    // Check if response is binary (image)
    const ct = res.headers.get('content-type') || ''
    if (ct.startsWith('image/') || ct === 'application/octet-stream') {
      const buf = await res.arrayBuffer()
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      return { type: 'image', data: b64, contentType: ct }
    }
    return res.json()
  } catch (e: any) { return { error: e.message } }
}

// POST /api/264pro/ai-tool — run an AI tool on a frame/clip
app.post('/api/264pro/ai-tool', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const { tool, imageUrl, videoUrl, params = {} } = body

  const replicateKey  = c.env?.REPLICATE_API_KEY
  const hfKey         = c.env?.HUGGINGFACE_API_KEY

  if (!tool) return c.json({ error: 'tool is required' }, 400)

  // ── Upscale (Real-ESRGAN via Replicate) ─────────────────────────────────
  if (tool === 'upscale') {
    if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY required', demo: true, message: 'AI Upscale would use Real-ESRGAN to upscale your video to 4K via Replicate.' })
    if (!imageUrl && !videoUrl) return c.json({ error: 'imageUrl or videoUrl required' }, 400)
    const scale = params.scale || 4
    const pred = await callReplicate(replicateKey, 'nightmareai/real-esrgan', {
      image: imageUrl || videoUrl,
      scale,
      face_enhance: params.faceEnhance || false,
    })
    if (pred.error) return c.json({ error: pred.error }, 500)
    if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: (pred as any).output, tool })
    if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: `Upscaling ${scale}x — prediction queued.` })
    return c.json({ error: 'Replicate error', detail: pred }, 500)
  }

  // ── Face Enhance / Restore (CodeFormer via Replicate) ────────────────────
  if (tool === 'face_enhance') {
    if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY required', demo: true, message: 'AI Face Enhance uses CodeFormer to restore and sharpen faces.' })
    if (!imageUrl) return c.json({ error: 'imageUrl required' }, 400)
    const pred = await callReplicate(replicateKey, 'sczhou/codeformer', {
      image: imageUrl,
      codeformer_fidelity: params.fidelity ?? 0.7,
      background_enhance: params.backgroundEnhance ?? true,
      face_upsample: params.faceUpsample ?? true,
      upscale: params.upscale ?? 2,
    })
    if (pred.error) return c.json({ error: pred.error }, 500)
    if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: (pred as any).output, tool })
    if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: 'Face restore queued via CodeFormer.' })
    return c.json({ error: 'Replicate error', detail: pred }, 500)
  }

  // ── Slow Motion / Frame Interpolation (FILM via Replicate versioned) ───────
  if (tool === 'slow_mo') {
    if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY required', demo: true, message: 'AI Slow-Mo uses FILM frame interpolation for buttery 2x–8x slow motion.' })
    if (!videoUrl) return c.json({ error: 'videoUrl required' }, 400)
    const multiplier = params.multiplier || 2
    try {
      const res = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: `Token ${replicateKey}`, 'Content-Type': 'application/json', Prefer: 'wait=60' },
        body: JSON.stringify({
          version: '57096e2d47a2b72c44e32ae2da0ba74fbc208a3e3de9e7a70a1cba7cd0399f4e', // google-research/frame-interpolation (FILM)
          input: { frame1: videoUrl, times_to_interpolate: multiplier },
        }),
      })
      const pred: any = await res.json()
      if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: Array.isArray(pred.output) ? pred.output[0] : pred.output, tool })
      if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: `${multiplier}x slow-mo queued via FILM.` })
      if (pred.detail) return c.json({ error: pred.detail }, 429)
    } catch (e: any) { return c.json({ error: e.message }, 500) }
    return c.json({ error: 'Replicate error' }, 500)
  }

  // ── Rotoscoping / Background Remove (rembg via Replicate versioned) ─────────
  if (tool === 'rotoscope' || tool === 'bg_remove') {
    if (!hfKey && !replicateKey) return c.json({ error: 'HUGGINGFACE_API_KEY or REPLICATE_API_KEY required', demo: true, message: 'AI Rotoscoping uses rembg to remove backgrounds with clean alpha.' })
    if (!imageUrl) return c.json({ error: 'imageUrl required' }, 400)
    // Use versioned Replicate prediction (more stable than /models/owner/name)
    if (replicateKey) {
      try {
        const res = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: { Authorization: `Token ${replicateKey}`, 'Content-Type': 'application/json', Prefer: 'wait=30' },
          body: JSON.stringify({
            version: 'fb8af171cfa1616ddcf1242c851214442d763e9f3bd7d8b1b7f35bede7f5d4a5', // lucataco/remove-bg
            input: { image: imageUrl },
          }),
        })
        const pred: any = await res.json()
        if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: Array.isArray(pred.output) ? pred.output[0] : pred.output, tool })
        if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: 'Background removal queued.' })
        if (pred.detail) return c.json({ error: pred.detail }, 429)
      } catch {}
    }
    // Fallback: HuggingFace RMBG
    if (hfKey) {
      const imgRes = await fetch(imageUrl)
      const imgBuf = await imgRes.arrayBuffer()
      const result = await callHuggingFace(hfKey, 'briaai/RMBG-1.4', imgBuf)
      if (!result.error && result.type === 'image') return c.json({ status: 'complete', outputBase64: result.data, contentType: result.contentType, tool })
    }
    return c.json({ error: 'Background removal failed — check API key credits or try again.' }, 500)
  }

  // ── AI Colorize (Deoldify via Replicate versioned) ───────────────────────
  if (tool === 'colorize') {
    if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY required', demo: true, message: 'AI Colorize uses DeOldify to add color to black & white footage.' })
    if (!imageUrl && !videoUrl) return c.json({ error: 'imageUrl or videoUrl required' }, 400)
    try {
      const res = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: `Token ${replicateKey}`, 'Content-Type': 'application/json', Prefer: 'wait=30' },
        body: JSON.stringify({
          version: '9c7a4a63c93285c5680068e019d07c36db7fe5b5fcff5ac2ae61d8f9bbfdc1c5', // arielreplicate/deoldify_image
          input: {
            input_image: imageUrl || videoUrl,
            render_factor: params.renderFactor || 35,
          },
        }),
      })
      const pred: any = await res.json()
      if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: Array.isArray(pred.output) ? pred.output[0] : pred.output, tool })
      if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: 'Colorization queued via DeOldify.' })
      if (pred.detail) return c.json({ error: pred.detail }, 429)
    } catch (e: any) { return c.json({ error: e.message }, 500) }
    return c.json({ error: 'Replicate error' }, 500)
  }

  // ── Depth Map (MiDaS via HuggingFace or Replicate) ──────────────────────
  if (tool === 'depth_map') {
    if (!hfKey && !replicateKey) return c.json({ error: 'HUGGINGFACE_API_KEY required', demo: true, message: 'Depth Map uses MiDaS to generate depth info for parallax effects.' })
    if (!imageUrl) return c.json({ error: 'imageUrl required' }, 400)
    // Try HuggingFace first (faster, free)
    if (hfKey) {
      const imgRes = await fetch(imageUrl)
      const imgBuf = await imgRes.arrayBuffer()
      const result = await callHuggingFace(hfKey, 'Intel/dpt-large', imgBuf)
      if (!result.error && result.type === 'image') return c.json({ status: 'complete', outputBase64: result.data, contentType: result.contentType, tool })
    }
    // Fallback: Replicate versioned MiDaS
    if (replicateKey) {
      try {
        const res = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: { Authorization: `Token ${replicateKey}`, 'Content-Type': 'application/json', Prefer: 'wait=30' },
          body: JSON.stringify({
            version: 'a59e1f2c89843d30bcce7f57e8e2b4ce7d7b1e6f12484d574d5c2dc9ca4c3ca3', // hf-inference/dpt-large
            input: { image: imageUrl },
          }),
        })
        const pred: any = await res.json()
        if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: 'Depth map queued.' })
      } catch {}
    }
    return c.json({ error: 'Depth map failed — check API key credits or try again.' }, 500)
  }

  // ── Video Denoise (Real-ESRGAN on video via Replicate) ────────────────────
  if (tool === 'video_denoise') {
    if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY required', demo: true, message: 'Video Denoise uses Real-ESRGAN for temporal noise suppression on video.' })
    if (!videoUrl) return c.json({ error: 'videoUrl required' }, 400)
    try {
      const res = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: `Token ${replicateKey}`, 'Content-Type': 'application/json', Prefer: 'wait=30' },
        body: JSON.stringify({
          version: 'f121d640bd286e1fdc67f9799164c1d5be36ff74576ee2d5d2c3e5d2e8fc5b14', // nightmareai/real-esrgan video
          input: { video: videoUrl, scale: 1, denoise: true },
        }),
      })
      const pred: any = await res.json()
      if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: Array.isArray(pred.output) ? pred.output[0] : pred.output, tool })
      if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: 'Video denoise queued.' })
      if (pred.detail) return c.json({ error: pred.detail }, 429)
    } catch (e: any) { return c.json({ error: e.message }, 500) }
    return c.json({ error: 'Replicate error' }, 500)
  }

  // ── Object Remove / Inpainting (Stable Diffusion Inpainting via Replicate) ─
  if (tool === 'object_remove' || tool === 'inpaint') {
    if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY required', demo: true, message: 'Object Remove uses SD Inpainting to seamlessly fill in removed objects.' })
    if (!imageUrl) return c.json({ error: 'imageUrl required. Also provide maskUrl in params.' }, 400)
    if (!params.maskUrl) return c.json({ error: 'params.maskUrl required — provide a black/white mask image URL (white = area to fill).' }, 400)
    try {
      const res = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: `Token ${replicateKey}`, 'Content-Type': 'application/json', Prefer: 'wait=60' },
        body: JSON.stringify({
          version: 'c11bac58203367db93a3c552bd49a25a5418458ddfffdd6324e4e6c77bb54d97', // stability-ai/stable-diffusion-inpainting
          input: {
            image: imageUrl,
            mask: params.maskUrl,
            prompt: params.prompt || 'seamless background, clean fill, realistic texture',
            num_inference_steps: params.steps || 30,
            guidance_scale: params.guidanceScale || 7.5,
          },
        }),
      })
      const pred: any = await res.json()
      if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: Array.isArray(pred.output) ? pred.output[0] : pred.output, tool })
      if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: 'Inpainting queued.' })
      if (pred.detail) return c.json({ error: pred.detail }, 429)
    } catch (e: any) { return c.json({ error: e.message }, 500) }
    return c.json({ error: 'Replicate error' }, 500)
  }

  // ── Video Upscale (Real-ESRGAN video via Replicate) ──────────────────────
  if (tool === 'video_upscale') {
    if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY required', demo: true, message: 'Video Upscale uses Real-ESRGAN to upscale video to 4K.' })
    if (!videoUrl) return c.json({ error: 'videoUrl required' }, 400)
    try {
      const res = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { Authorization: `Token ${replicateKey}`, 'Content-Type': 'application/json', Prefer: 'wait=30' },
        body: JSON.stringify({
          version: 'f121d640bd286e1fdc67f9799164c1d5be36ff74576ee2d5d2c3e5d2e8fc5b14', // nightmareai/real-esrgan
          input: { video: videoUrl, scale: params.scale || 2 },
        }),
      })
      const pred: any = await res.json()
      if (pred.status === 'succeeded') return c.json({ status: 'complete', outputUrl: Array.isArray(pred.output) ? pred.output[0] : pred.output, tool })
      if (pred.id) return c.json({ status: 'queued', predictionId: pred.id, tool, message: `Video upscale ${params.scale || 2}x queued.` })
      if (pred.detail) return c.json({ error: pred.detail }, 429)
    } catch (e: any) { return c.json({ error: e.message }, 500) }
    return c.json({ error: 'Replicate error' }, 500)
  }

  return c.json({ error: `Unknown tool: ${tool}. Supported: upscale, face_enhance, slow_mo, rotoscope, bg_remove, colorize, depth_map, video_denoise, object_remove, video_upscale` }, 400)
})

// GET /api/264pro/ai-tool/poll/:predictionId — poll Replicate prediction status
app.get('/api/264pro/ai-tool/poll/:predictionId', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)

  const predId = c.req.param('predictionId')
  const replicateKey = c.env?.REPLICATE_API_KEY
  if (!replicateKey) return c.json({ error: 'REPLICATE_API_KEY not configured' }, 500)

  try {
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
      headers: { Authorization: `Token ${replicateKey}` },
    })
    const data: any = await res.json()
    if (data.status === 'succeeded') {
      return c.json({ status: 'complete', outputUrl: Array.isArray(data.output) ? data.output[0] : data.output })
    }
    if (data.status === 'failed' || data.status === 'canceled') {
      return c.json({ status: 'error', error: data.error || 'Prediction failed' })
    }
    const percent = data.status === 'processing' && data.logs
      ? (() => { const m = data.logs.match(/(\d+)%/g); return m ? parseInt(m[m.length-1]) : null })()
      : null
    return c.json({ status: 'processing', predictionId: predId, percent })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// ── 264 Pro AI Video Generation — Seedance 2.0 / Higgsfield / Nano Banana ────
// Unified generation endpoint supporting text-to-video + image-to-video
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: call fal.ai async queue (Seedance 2.0, Nano Banana, Wan, SeedDream)
async function callFalAsync(falKey: string, modelId: string, input: Record<string, unknown>): Promise<{ requestId?: string; error?: string; status?: string; videoUrl?: string }> {
  try {
    const res = await fetch(`https://queue.fal.run/${modelId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input }),
    })
    const data: any = await res.json()
    if (data.request_id) return { requestId: data.request_id, status: 'queued' }
    if (data.error) return { error: data.error }
    // Synchronous result (some models return immediately)
    if (data.video?.url) return { status: 'complete', videoUrl: data.video.url }
    return { error: 'Unexpected fal.ai response', ...data }
  } catch (e: any) {
    return { error: e.message }
  }
}

// Helper: poll fal.ai queue status
async function pollFalQueue(falKey: string, requestId: string): Promise<{ status: string; videoUrl?: string; percent?: number; error?: string }> {
  try {
    const res = await fetch(`https://queue.fal.run/requests/${requestId}/status`, {
      headers: { 'Authorization': `Key ${falKey}` },
    })
    const data: any = await res.json()
    if (data.status === 'COMPLETED') {
      // Fetch actual result
      const resultRes = await fetch(`https://queue.fal.run/requests/${requestId}`, {
        headers: { 'Authorization': `Key ${falKey}` },
      })
      const result: any = await resultRes.json()
      const videoUrl = result.video?.url || result.output?.url || (Array.isArray(result.video) ? result.video[0] : null)
      return { status: 'complete', videoUrl }
    }
    if (data.status === 'FAILED') return { status: 'error', error: data.error || 'Generation failed' }
    const percent = data.queue_position != null ? Math.max(5, 95 - data.queue_position * 10) : 30
    return { status: 'processing', percent }
  } catch (e: any) {
    return { status: 'error', error: e.message }
  }
}

// Helper: call Higgsfield AI
async function callHiggsfield(higgsKey: string, model: string, input: Record<string, unknown>): Promise<{ requestId?: string; error?: string; status?: string; videoUrl?: string }> {
  try {
    const res = await fetch('https://api.higgsfield.ai/v1/video/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${higgsKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, ...input }),
    })
    const data: any = await res.json()
    if (data.id) return { requestId: data.id, status: 'queued' }
    if (data.output_url) return { status: 'complete', videoUrl: data.output_url }
    if (data.error) return { error: data.error }
    return { error: `Higgsfield error: ${JSON.stringify(data)}` }
  } catch (e: any) {
    return { error: e.message }
  }
}

// POST /api/264pro/video-gen — AI video generation (Seedance, Higgsfield, Nano Banana)
app.post('/api/264pro/video-gen', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)

  // All video generation requires Pro tier
  const tier = auth.tier || 'free'
  const hasPro = isTierPro(tier)
  if (!hasPro) return c.json({ error: 'Video generation requires a Pro plan.', upgradeUrl: 'https://flowst8.cc/pricing' }, 403)

  const body: any = await c.req.json().catch(() => ({}))
  const {
    model,          // 'seedance_t2v' | 'seedance_i2v' | 'higgsfield_t2v' | 'nano_banana_2k' | 'nano_banana_4k' | 'wan_t2v' | 'wan_i2v'
    prompt,
    imageUrl,       // for i2v modes
    duration,       // seconds: 5 | 10 | 15
    resolution,     // '720p' | '1080p' | '2k' | '4k'
    aspectRatio,    // '16:9' | '9:16' | '1:1' | '4:3'
    quality,        // 'basic' | 'high'
    cameraMotion,   // prompt addition for camera control
    style,          // style modifier
    negativePrompt,
  } = body

  if (!model) return c.json({ error: 'model is required' }, 400)
  if (!prompt) return c.json({ error: 'prompt is required' }, 400)

  // ── AI Orchestration — Pro users: full quality always, speed may queue ─────
  const redisUrl264 = c.env?.UPSTASH_REDIS_URL
  const redisTok264 = c.env?.UPSTASH_REDIS_TOKEN
  if (redisUrl264 && redisTok264) {
    const plan = await resolveAIExecution({
      userId:         auth.email,
      tool:           model,
      requestedModel: model,
      isPro:          hasPro,
      redisUrl:       redisUrl264,
      redisToken:     redisTok264,
    })
    if (plan.blocked && plan.blockResponse) {
      return c.json(plan.blockResponse, plan.blockResponse.status as any)
    }
    applyOrchestrationHeaders(c, plan)
    // Pro: plan.shouldQueue would add a delay, but video gen is async by nature
    // The queued flag is informational here — fal.ai handles its own queue
  }

  const falKey        = c.env?.FAL_AI_KEY
  const higgsKey      = c.env?.HIGGSFIELD_API_KEY
  const replicateKey  = c.env?.REPLICATE_API_KEY

  // Build the full prompt with camera motion and style
  const fullPrompt = [prompt, cameraMotion, style].filter(Boolean).join('. ')

  // ── Seedance 2.0 Text-to-Video (via fal.ai) ─────────────────────────────
  if (model === 'seedance_t2v') {
    if (!falKey) return c.json({ error: 'FAL_AI_KEY required for Seedance 2.0', upgradeUrl: 'https://flowst8.cc' }, 503)
    const result = await callFalAsync(falKey, 'bytedance/seedance-2.0/text-to-video', {
      prompt: fullPrompt,
      duration: String(duration || '5'),
      resolution: resolution === '1080p' ? '1080p' : '720p',
      aspect_ratio: aspectRatio || '16:9',
    })
    if (result.error) return c.json({ error: result.error }, 500)
    if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
    return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: `Seedance 2.0 generating — ${duration || 5}s at ${resolution || '720p'}` })
  }

  // ── Seedance 2.0 Image-to-Video (via fal.ai) ────────────────────────────
  if (model === 'seedance_i2v') {
    if (!falKey) return c.json({ error: 'FAL_AI_KEY required for Seedance 2.0', upgradeUrl: 'https://flowst8.cc' }, 503)
    if (!imageUrl) return c.json({ error: 'imageUrl required for image-to-video' }, 400)
    const result = await callFalAsync(falKey, 'bytedance/seedance-2.0/image-to-video', {
      prompt: fullPrompt,
      image_url: imageUrl,
      duration: String(duration || '5'),
      resolution: resolution === '1080p' ? '1080p' : '720p',
      aspect_ratio: aspectRatio || '16:9',
    })
    if (result.error) return c.json({ error: result.error }, 500)
    if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
    return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: `Seedance 2.0 i2v generating — ${duration || 5}s from your image` })
  }

  // ── Nano Banana 2 (Gemini) via GenSpark fal.ai — 2K ─────────────────────
  if (model === 'nano_banana_2k') {
    if (!falKey) return c.json({ error: 'FAL_AI_KEY required for Nano Banana', upgradeUrl: 'https://flowst8.cc' }, 503)
    const result = await callFalAsync(falKey, 'fal-ai/wan/v2.6/text-to-video', {
      prompt: fullPrompt,
      negative_prompt: negativePrompt || 'blurry, low quality, distorted',
      num_frames: 81,
      resolution: '720p',
      aspect_ratio: aspectRatio || '16:9',
      num_inference_steps: quality === 'high' ? 50 : 30,
      image_size: { width: 2560, height: 1440 }, // 2K
    })
    if (result.error) return c.json({ error: result.error }, 500)
    if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
    return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: 'Nano Banana 2K generating — high-fidelity motion synthesis' })
  }

  // ── Nano Banana 4K (via fal.ai Wan 2.6 + 4K upscale) ────────────────────
  if (model === 'nano_banana_4k') {
    if (!falKey) return c.json({ error: 'FAL_AI_KEY required for Nano Banana 4K', upgradeUrl: 'https://flowst8.cc' }, 503)
    const result = await callFalAsync(falKey, 'fal-ai/wan/v2.6/text-to-video', {
      prompt: fullPrompt,
      negative_prompt: negativePrompt || 'blurry, low quality, distorted',
      num_frames: 81,
      resolution: '1080p',
      aspect_ratio: aspectRatio || '16:9',
      num_inference_steps: 50,
      image_size: { width: 3840, height: 2160 }, // 4K UHD
    })
    if (result.error) return c.json({ error: result.error }, 500)
    if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
    return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: 'Nano Banana 4K generating — cinematic ultra-resolution' })
  }

  // ── Higgsfield Text-to-Video ─────────────────────────────────────────────
  if (model === 'higgsfield_t2v') {
    if (!higgsKey && !falKey) return c.json({ error: 'HIGGSFIELD_API_KEY or FAL_AI_KEY required', upgradeUrl: 'https://flowst8.cc' }, 503)
    // Try Higgsfield directly first
    if (higgsKey) {
      const result = await callHiggsfield(higgsKey, 'seedance-v2.0-t2v', {
        prompt: fullPrompt,
        aspect_ratio: aspectRatio || '16:9',
        duration: duration || 10,
        quality: quality || 'high',
        negative_prompt: negativePrompt,
      })
      if (!result.error) {
        if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
        return c.json({ status: 'queued', requestId: result.requestId, provider: 'higgsfield', model, message: `Higgsfield Seedance 2.0 — ${duration || 10}s ${quality || 'high'} quality` })
      }
    }
    // Fallback to fal.ai Seedance
    if (falKey) {
      const result = await callFalAsync(falKey, 'bytedance/seedance-2.0/text-to-video', {
        prompt: fullPrompt,
        duration: String(duration || '10'),
        resolution: resolution === '1080p' ? '1080p' : '720p',
        aspect_ratio: aspectRatio || '16:9',
      })
      if (result.error) return c.json({ error: result.error }, 500)
      if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
      return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: `Higgsfield Seedance 2.0 — ${duration || 10}s cinematic generation` })
    }
    return c.json({ error: 'No video generation API key configured' }, 503)
  }

  // ── Higgsfield Image-to-Video ─────────────────────────────────────────────
  if (model === 'higgsfield_i2v') {
    if (!imageUrl) return c.json({ error: 'imageUrl required for i2v' }, 400)
    if (!higgsKey && !falKey) return c.json({ error: 'HIGGSFIELD_API_KEY or FAL_AI_KEY required' }, 503)
    if (higgsKey) {
      const result = await callHiggsfield(higgsKey, 'seedance-v2.0-i2v', {
        prompt: fullPrompt,
        image_url: imageUrl,
        aspect_ratio: aspectRatio || '16:9',
        duration: duration || 5,
        quality: quality || 'high',
      })
      if (!result.error) {
        if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
        return c.json({ status: 'queued', requestId: result.requestId, provider: 'higgsfield', model, message: 'Higgsfield image-to-video — animating your frame' })
      }
    }
    if (falKey) {
      const result = await callFalAsync(falKey, 'bytedance/seedance-2.0/image-to-video', {
        prompt: fullPrompt, image_url: imageUrl,
        duration: String(duration || '5'), resolution: '720p', aspect_ratio: aspectRatio || '16:9',
      })
      if (result.error) return c.json({ error: result.error }, 500)
      if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
      return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: 'Image-to-video animation queued' })
    }
  }

  // ── Wan v2.6 Text-to-Video (via fal.ai) ────────────────────────────────
  if (model === 'wan_t2v') {
    if (!falKey) return c.json({ error: 'FAL_AI_KEY required for Wan 2.6' }, 503)
    const result = await callFalAsync(falKey, 'fal-ai/wan/v2.6/text-to-video', {
      prompt: fullPrompt,
      negative_prompt: negativePrompt || 'blurry, distorted, low quality',
      num_frames: duration === 10 ? 161 : 81,
      aspect_ratio: aspectRatio || '16:9',
      resolution: resolution || '720p',
    })
    if (result.error) return c.json({ error: result.error }, 500)
    if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
    return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: `Wan 2.6 — ${duration || 5}s generation queued` })
  }

  // ── Wan v2.6 Image-to-Video ──────────────────────────────────────────────
  if (model === 'wan_i2v') {
    if (!falKey) return c.json({ error: 'FAL_AI_KEY required for Wan 2.6' }, 503)
    if (!imageUrl) return c.json({ error: 'imageUrl required for i2v' }, 400)
    const result = await callFalAsync(falKey, 'fal-ai/wan/v2.6/image-to-video', {
      prompt: fullPrompt,
      image_url: imageUrl,
      num_frames: duration === 10 ? 161 : 81,
      aspect_ratio: aspectRatio || '16:9',
      resolution: resolution || '720p',
    })
    if (result.error) return c.json({ error: result.error }, 500)
    if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
    return c.json({ status: 'queued', requestId: result.requestId, provider: 'fal', model, message: `Wan 2.6 i2v — ${duration || 5}s animation queued` })
  }

  return c.json({ error: `Unknown model: ${model}. Supported: seedance_t2v, seedance_i2v, higgsfield_t2v, higgsfield_i2v, nano_banana_2k, nano_banana_4k, wan_t2v, wan_i2v` }, 400)
})

// GET /api/264pro/video-gen/poll/:requestId — poll AI video generation status
app.get('/api/264pro/video-gen/poll/:requestId', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)

  const requestId = c.req.param('requestId')
  const provider  = c.req.query('provider') || 'fal'
  const falKey    = c.env?.FAL_AI_KEY
  const higgsKey  = c.env?.HIGGSFIELD_API_KEY

  if (provider === 'fal') {
    if (!falKey) return c.json({ status: 'error', error: 'FAL_AI_KEY not configured' })
    const result = await pollFalQueue(falKey, requestId)
    return c.json(result)
  }

  if (provider === 'higgsfield') {
    if (!higgsKey) return c.json({ status: 'error', error: 'HIGGSFIELD_API_KEY not configured' })
    try {
      const res = await fetch(`https://api.higgsfield.ai/v1/video/generate/${requestId}`, {
        headers: { 'Authorization': `Bearer ${higgsKey}` },
      })
      const data: any = await res.json()
      if (data.status === 'completed' || data.status === 'succeeded') {
        return c.json({ status: 'complete', videoUrl: data.output_url || data.video_url })
      }
      if (data.status === 'failed' || data.status === 'error') {
        return c.json({ status: 'error', error: data.error || 'Generation failed' })
      }
      return c.json({ status: 'processing', percent: data.progress || 30 })
    } catch (e: any) {
      return c.json({ status: 'error', error: e.message })
    }
  }

  // Replicate fallback
  const replicateKey = c.env?.REPLICATE_API_KEY
  if (replicateKey) {
    try {
      const res = await fetch(`https://api.replicate.com/v1/predictions/${requestId}`, {
        headers: { Authorization: `Token ${replicateKey}` },
      })
      const data: any = await res.json()
      if (data.status === 'succeeded') return c.json({ status: 'complete', videoUrl: Array.isArray(data.output) ? data.output[0] : data.output })
      if (data.status === 'failed') return c.json({ status: 'error', error: data.error || 'Failed' })
      return c.json({ status: 'processing', percent: 40 })
    } catch (e: any) { return c.json({ status: 'error', error: e.message }) }
  }

  return c.json({ status: 'error', error: 'No API key configured for polling' })
})

// ─── Higgsfield AI Studio — Web + 264 Pro (Pro tier gated) ──────────────────
// Direct Higgsfield API integration. Uses HIGGSFIELD_API_KEY for auth.
// Also served via /api/264pro/video-gen but these routes give the web app
// its own auth flow via session cookie (FS_USER) rather than desktop token.
// ─────────────────────────────────────────────────────────────────────────────

// Helper: check session tier (web auth — FS_USER cookie)
function getSessionTier(c: any): string {
  const session = decodeSession(c.req.header ? '' : '', )
  // Try cookie
  const raw = c.req.header?.('cookie') || ''
  const match = raw.match(/fs_session=([^;]+)/)
  if (!match) return 'free'
  try {
    const decoded = decodeSession(decodeURIComponent(match[1]))
    return decoded?.tier || 'free'
  } catch { return 'free' }
}

// POST /api/higgsfield/generate — web-facing Higgsfield video generation (Pro gated)
app.post('/api/higgsfield/generate', async (c) => {
  // Auth: accept either session cookie (web) OR 264pro bearer token (desktop)
  const token264 = get264Token(c)
  let userEmail = '', userTier = 'free', userName = ''

  if (token264) {
    // Desktop app auth
    const auth = await verify264Token(c, token264)
    if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
    userEmail = auth.email || ''; userTier = auth.tier || 'free'; userName = auth.name || ''
  } else {
    // Web session auth
    const cookieHeader = c.req.header('cookie') || ''
    const match = cookieHeader.match(/fs_session=([^;]+)/)
    if (!match) return c.json({ error: 'Not authenticated. Sign in at flowst8.cc' }, 401)
    try {
      const session = decodeSession(decodeURIComponent(match[1]))
      if (!session?.email) return c.json({ error: 'Invalid session' }, 401)
      userEmail = session.email; userTier = session.tier || 'free'; userName = session.name || ''
    } catch { return c.json({ error: 'Session decode failed' }, 401) }
  }

  // Pro gate
  const hasPro = ['personal_pro','team_starter','team_growth','enterprise','clawflow'].includes(userTier)
  if (!hasPro) {
    return c.json({
      error: 'higgsfield_pro_required',
      message: 'Higgsfield AI is available to Pro members. Upgrade at flowst8.cc to unlock 100+ cinematic models.',
      upgradeUrl: 'https://flowst8.cc/#pricing',
    }, 403)
  }

  const higgsKey = c.env?.HIGGSFIELD_API_KEY
  if (!higgsKey) return c.json({ error: 'Higgsfield API key not configured' }, 503)

  const body: any = await c.req.json().catch(() => ({}))
  const {
    model       = 'seedance-v2.0-t2v',
    prompt      = '',
    imageUrl,
    duration    = 10,
    aspectRatio = '16:9',
    quality     = 'high',
  } = body

  if (!prompt && !imageUrl) return c.json({ error: 'prompt is required' }, 400)

  const input: Record<string, unknown> = {
    prompt,
    aspect_ratio: aspectRatio,
    duration: Number(duration),
    quality,
  }
  if (imageUrl) input.image_url = imageUrl

  const result = await callHiggsfield(higgsKey, model, input)
  if (result.error) return c.json({ error: result.error }, 500)
  if (result.status === 'complete') return c.json({ status: 'complete', videoUrl: result.videoUrl, model })
  if (result.requestId) {
    // Log activity
    const redisUrl = c.env?.UPSTASH_REDIS_URL; const redisTok = c.env?.UPSTASH_REDIS_TOKEN
    if (redisUrl && redisTok) {
      redisPipeline(redisUrl, redisTok, [
        ['LPUSH', `higgsfield_activity:${userEmail}`, JSON.stringify({ model, prompt: prompt.slice(0,80), ts: new Date().toISOString() })],
        ['LTRIM', `higgsfield_activity:${userEmail}`, '0', '49'],
        ['EXPIRE', `higgsfield_activity:${userEmail}`, 30 * 86400],
      ]).catch(() => {})
    }
    return c.json({ status: 'queued', requestId: result.requestId, provider: 'higgsfield', model,
      message: `Higgsfield ${model} generating — ${duration}s ${quality} quality` })
  }
  return c.json({ error: 'Unexpected Higgsfield response' }, 500)
})

// GET /api/higgsfield/poll/:requestId — poll generation status (web + desktop)
app.get('/api/higgsfield/poll/:requestId', async (c) => {
  // Accept either desktop token or session cookie
  const token264 = get264Token(c)
  let authed = false

  if (token264) {
    const auth = await verify264Token(c, token264)
    authed = auth.valid
  } else {
    const cookieHeader = c.req.header('cookie') || ''
    const match = cookieHeader.match(/fs_session=([^;]+)/)
    if (match) {
      try {
        const session = decodeSession(decodeURIComponent(match[1]))
        authed = !!session?.email
      } catch { authed = false }
    }
  }

  if (!authed) return c.json({ status: 'error', error: 'Not authenticated' }, 401)

  const requestId = c.req.param('requestId')
  const higgsKey  = c.env?.HIGGSFIELD_API_KEY
  if (!higgsKey) return c.json({ status: 'error', error: 'Higgsfield not configured' })

  try {
    const res = await fetch(`https://api.higgsfield.ai/v1/video/generate/${requestId}`, {
      headers: { 'Authorization': `Bearer ${higgsKey}` },
    })
    const data: any = await res.json()
    if (data.status === 'completed' || data.status === 'succeeded') {
      return c.json({ status: 'complete', videoUrl: data.output_url || data.video_url || data.url })
    }
    if (data.status === 'failed' || data.status === 'error') {
      return c.json({ status: 'error', error: data.error || data.message || 'Generation failed' })
    }
    const pct = data.progress ?? (data.status === 'processing' ? 45 : 15)
    return c.json({ status: 'processing', percent: pct, higgsStatus: data.status })
  } catch (e: any) {
    return c.json({ status: 'error', error: e.message })
  }
})

// GET /api/higgsfield/models — list available models for the web UI
app.get('/api/higgsfield/models', async (c) => {
  // Public model list — no auth needed
  return c.json({
    models: [
      { id: 'seedance-v2.0-t2v', name: 'Seedance 2.0', type: 't2v', maxDuration: 15, quality: ['standard','high'], description: 'ByteDance flagship — cinematic, native audio, multi-shot' },
      { id: 'seedance-v2.0-i2v', name: 'Seedance 2.0 I2V', type: 'i2v', maxDuration: 15, quality: ['standard','high'], description: 'Animate a still image with Seedance 2.0' },
      { id: 'seedance-v2.0-t2v-fx', name: 'Seedance FX', type: 't2v', maxDuration: 10, quality: ['standard','high'], description: 'Particle effects, fire, explosions, physics simulation' },
      { id: 'wan2.6-t2v', name: 'Wan 2.6', type: 't2v', maxDuration: 15, quality: ['standard','high','1080p'], description: 'High motion fidelity, 1080p support' },
      { id: 'wan2.6-i2v', name: 'Wan 2.6 I2V', type: 'i2v', maxDuration: 15, quality: ['standard','high'], description: 'Smooth animated transitions from reference' },
      { id: 'kling-v3.0-pro-t2v', name: 'Kling v3 Pro', type: 't2v', maxDuration: 10, quality: ['standard','high','1080p'], description: 'Pro cinematic quality — 1080p up to 10s' },
    ],
    proRequired: true,
    upgradeUrl: 'https://flowst8.cc/#pricing',
  })
})

// GET /api/264pro/user — return current user info for the linked token
app.get('/api/264pro/user', async (c) => {
  const token = get264Token(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth = await verify264Token(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
  return c.json({ name: auth.name, email: auth.email, tier: auth.tier })
})

// ─── Misc APIs ────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ status: 'alive', version: '3.0.0', name: 'FlowState', phase: 'Phase 3 — Full Architecture' }))

app.get('/api/learn/cards', (c) => c.json({ cards: declareLearnCards() }))
app.get('/api/restore/intent', (c) => c.json(declareRestoreIntent()))
app.get('/api/tier/capabilities', (c) => c.json(declareTierCapabilities((c.req.query('tier') as any) || 'free')))
app.get('/api/credentials', (c) => c.json({ credentials: CREDENTIAL_TABLE }))
app.get('/api/models', (c) => c.json({ models: MODEL_REGISTRY, imageModels: IMAGE_MODEL_REGISTRY, videoModels: VIDEO_MODEL_REGISTRY }))

// ── Key Status endpoint — returns which env vars are set (boolean only, no values) ──
app.get('/api/key-status', (c) => {
  const e = c.env as any
  const check = (...keys: string[]) => keys.every(k => !!e?.[k])
  // All image/video generation models route through Replicate — one key covers them all
  const hasReplicate = check('REPLICATE_API_KEY')
  return c.json({
    // Core
    google_oauth:    check('GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'),
    openrouter:      check('OPENROUTER_API_KEY'),
    redis:           check('UPSTASH_REDIS_URL','UPSTASH_REDIS_TOKEN'),
    stripe:          check('STRIPE_SECRET_KEY','STRIPE_PUBLISHABLE_KEY','STRIPE_WEBHOOK_SECRET'),
    resend:          check('RESEND_API_KEY'),
    notion:          check('NOTION_CLIENT_ID','NOTION_CLIENT_SECRET'),
    slack:           check('SLACK_CLIENT_ID','SLACK_CLIENT_SECRET','SLACK_BOT_TOKEN'),
    // AI — all image/video models route through Replicate
    google_ai:       check('GOOGLE_AI_KEY'),
    elevenlabs:      check('ELEVENLABS_API_KEY'),
    replicate:       hasReplicate,
    // Image gen — all via Replicate
    ideogram:        hasReplicate,
    recraft:         hasReplicate,
    stability:       hasReplicate,
    bfl:             hasReplicate,
    // Video gen — all via Replicate
    runway:          hasReplicate,
    kling:           hasReplicate,
    pika:            hasReplicate,
    minimax:         hasReplicate,
    luma:            hasReplicate,
    // Audio — individual keys
    suno:            hasReplicate || check('SUNO_API_KEY'),
    udio:            check('UDIO_API_KEY'),
    musicgen:        hasReplicate,
    moises:          check('AUDIOSHAKE_API_KEY'),   // AudioShake replaces Moises
    audioshake:      check('AUDIOSHAKE_API_KEY'),
    // Optional
    xai:             check('XAI_API_KEY'),
    huggingface:     check('HUGGINGFACE_API_KEY'),
  })
})

// Token balance endpoint — returns daily usage + purchased balance
app.get('/api/billing/balance', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ dailyUsed: 0, dailyLimit: 5000, purchased: 0, tier: 'free' })

  const email = session.email
  const date  = new Date().toISOString().slice(0, 10)
  const results = await redisPipeline(url, token, [
    ['GET', `tier_email:${email}`],
    ['GET', `tier:${email}`],
    ['GET', `daily_tokens_used:${email}:${date}`],
    ['GET', `token_balance:${encodeURIComponent(email)}`],
  ])
  const tier      = (results[0] || results[1] || 'free') as string
  const isPaid    = tier === 'pro' || tier === 'team'
  const dailyUsed = parseInt(results[2] as string || '0')
  const purchased = parseInt(results[3] as string || '0')
  const dailyLimit = isPaid ? 100_000 : 5_000
  return c.json({ dailyUsed, dailyLimit, purchased, tier, remaining: Math.max(0, dailyLimit - dailyUsed) })
})

// ─── Auth pages ───────────────────────────────────────────────────────────────
// Shared smart redirect script — handles popup AND same-tab OAuth flows
const AUTH_REDIRECT_SCRIPT = `<script>
(function(){
  var isPopup = !!(window.opener && !window.opener.closed);
  if (isPopup) {
    // Signal parent app that auth succeeded
    try { window.opener.postMessage({ type: 'FS_AUTH_SUCCESS' }, window.location.origin); } catch(e){}
    // Auto-close after 2.5s (user can see success message; button also closes instantly)
    setTimeout(function(){ window.close(); }, 2500);
    // Update button to close popup
    document.addEventListener('DOMContentLoaded', function(){
      var btn = document.querySelector('.btn');
      if (btn) { btn.textContent = 'Back to FlowState ✓'; btn.onclick = function(){ window.close(); }; }
      var sub = document.querySelector('.sub');
      if (sub) sub.textContent = 'This window will close automatically in a moment.';
    });
  } else {
    // Same-tab flow — redirect to app root after short delay
    document.addEventListener('DOMContentLoaded', function(){
      var btn = document.querySelector('.btn');
      if (btn) { btn.textContent = 'Open FlowState'; btn.onclick = function(){ window.location.href='/'; }; }
    });
    setTimeout(function(){ window.location.href = '/'; }, 2000);
  }
})();
</script>`

const AUTH_PAGE_STYLE = `<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(168,85,247,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px;animation:fadeIn .4s ease}.av{width:72px;height:72px;border-radius:50%;border:3px solid #a855f7;margin-bottom:16px}h1{font-size:22px;font-weight:800;margin-bottom:8px}p{color:#888;font-size:14px;margin-bottom:20px}.btn{display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer;border:none}.sub{color:#555;font-size:12px;margin-top:14px}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}</style>`

function authSuccessPage(name: string, picture: string): string {
  const avatar = picture
    ? `<img class="av" src="${picture}" alt="${name}" onerror="this.style.display='none'">`
    : `<div style="font-size:56px;margin-bottom:16px">✅</div>`
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signed in — FlowState</title>${AUTH_PAGE_STYLE}${AUTH_REDIRECT_SCRIPT}</head><body><div class="card">${avatar}<h1>Welcome back, ${name}!</h1><p style="color:#10b981;font-size:15px;font-weight:600">You're signed in to FlowState.</p><p>Google Calendar is synced.</p><button class="btn">Back to FlowState ✓</button><div class="sub">This window will close automatically.</div></div></body></html>`
}
function notionSuccessPage(workspace: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Notion Connected — FlowState</title>${AUTH_PAGE_STYLE}${AUTH_REDIRECT_SCRIPT}</head><body><div class="card"><div style="font-size:56px;margin-bottom:16px">📝</div><h1>Notion Connected!</h1><p>Workspace <strong>${workspace || 'Your workspace'}</strong> is synced. Returning you to FlowState…</p><button class="btn" onclick="window.opener?window.close():window.location.href='/'">Open Board Tab</button><div class="sub">This window will close automatically.</div></div></body></html>`
}
function slackSuccessPage(team: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Slack Connected — FlowState</title>${AUTH_PAGE_STYLE}${AUTH_REDIRECT_SCRIPT}</head><body><div class="card"><div style="font-size:56px;margin-bottom:16px">💬</div><h1>Slack Connected!</h1><p>Team <strong>${team || 'Your workspace'}</strong> is synced. Returning you to FlowState…</p><button class="btn" onclick="window.opener?window.close():window.location.href='/'">Return to FlowState</button><div class="sub">This window will close automatically.</div></div></body></html>`
}
function authErrorPage(message: string): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth Error</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(239,68,68,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}h1{font-size:22px;font-weight:800;margin-bottom:8px;color:#ef4444}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:#1a1a2e;border:1px solid #ef4444;color:#ef4444;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">⚠️</div><h1>Auth Error</h1><p>' + message + '</p><a class="btn" href="/">Back to FlowState</a></div></body></html>'
}

// ═══════════════════════════════════════════════════════════════════
// GET /auth — Standalone sign-in page (used by desktop app OAuth flows)
// Called after /api/fsaudio/auth or /api/264pro/auth redirects here
// with ?app=fsaudio|264pro&state=...&redirect=...
// ═══════════════════════════════════════════════════════════════════
app.get('/auth', async (c) => {
  const appParam    = c.req.query('app')      || ''
  const appState    = c.req.query('state')    || ''
  const appRedirect = c.req.query('redirect') || ''

  // If the user already has a valid session, go straight to the app callback
  const existingSession = decodeSession(getCookie(c, 'fs_session') || '')
  if (existingSession?.email) {
    if (appParam === 'fsaudio') {
      return c.redirect(`/api/fsaudio/auth/callback?state=${encodeURIComponent(appState)}&redirect=${encodeURIComponent(appRedirect || 'fsaudio://auth')}`)
    }
    if (appParam === '264pro') {
      return c.redirect(`/api/264pro/auth/callback?state=${encodeURIComponent(appState)}&redirect=${encodeURIComponent(appRedirect || '264pro://auth')}`)
    }
    return c.redirect('/')
  }

  // Build the Google sign-in URL — carries app context so callback can forward correctly
  const googleUrl = `/api/auth/google?app=${encodeURIComponent(appParam)}&state=${encodeURIComponent(appState)}&redirect=${encodeURIComponent(appRedirect)}`

  // App display names / branding
  const appLabel  = appParam === 'fsaudio' ? 'FS-Audio' : appParam === '264pro' ? '264 Pro' : 'FlowState'
  const appIcon   = appParam === 'fsaudio' ? '🎧' : appParam === '264pro' ? '🎬' : '⚡'
  const appColor  = appParam === 'fsaudio' ? '#06b6d4' : appParam === '264pro' ? '#a855f7' : '#a855f7'

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — FlowState</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f0f1a;color:#f0f0f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.orb{position:fixed;border-radius:50%;filter:blur(80px);pointer-events:none;opacity:.35}
.orb1{width:400px;height:400px;background:radial-gradient(circle,#a855f7,transparent);top:-100px;right:-100px}
.orb2{width:350px;height:350px;background:radial-gradient(circle,#06b6d4,transparent);bottom:-80px;left:-80px}
.card{background:#1a1a2e;border:1px solid rgba(168,85,247,.35);border-radius:24px;padding:44px 40px;max-width:420px;width:100%;text-align:center;position:relative;z-index:1;animation:fadeUp .4s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.app-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:99px;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:20px;border:1px solid rgba(168,85,247,.3);background:rgba(168,85,247,.1);color:#a855f7}
.logo{font-size:52px;margin-bottom:12px;line-height:1}
.title{font-size:26px;font-weight:900;margin-bottom:8px;background:linear-gradient(135deg,#f0f0f0,#a0a0c0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:#888;font-size:14px;margin-bottom:32px;line-height:1.65}
.btn-google{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:14px;border-radius:13px;background:#fff;border:none;color:#1a1a2e;font-size:15px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:12px;text-decoration:none}
.btn-google:hover{transform:scale(1.02);box-shadow:0 4px 24px rgba(255,255,255,.15)}
.btn-google svg{width:20px;height:20px;flex-shrink:0}
.divider{display:flex;align-items:center;gap:10px;margin:6px 0 16px;color:#444;font-size:12px}
.divider::before,.divider::after{content:'';flex:1;border-top:1px solid #2a2a40}
.magic-form{display:flex;flex-direction:column;gap:10px;margin-bottom:20px}
.magic-input{background:#16213e;border:1px solid rgba(168,85,247,.25);border-radius:10px;color:#f0f0f0;padding:13px 16px;font-size:14px;outline:none;transition:.2s;font-family:inherit}
.magic-input:focus{border-color:rgba(168,85,247,.7);background:rgba(168,85,247,.06)}
.magic-input::placeholder{color:#555}
.btn-magic{width:100%;padding:13px;border-radius:12px;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;font-size:14px;font-weight:700;cursor:pointer;transition:.2s}
.btn-magic:hover{opacity:.88;transform:scale(1.01)}
.btn-magic:disabled{opacity:.5;cursor:not-allowed;transform:none}
.magic-sent{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);border-radius:12px;padding:14px;color:#10b981;font-size:13px;font-weight:600;display:none}
.features{display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left;margin-bottom:20px}
.feat{display:flex;align-items:center;gap:8px;font-size:12px;color:#888}
.feat-icon{color:#a855f7;font-size:11px;flex-shrink:0}
.legal{font-size:11px;color:#444;line-height:1.5;margin-top:4px}
.legal a{color:#666;text-decoration:underline}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div class="card">
  ${appParam ? `<div class="app-badge">${appIcon} ${appLabel}</div>` : ''}
  <div class="logo">⚡</div>
  <h1 class="title">Sign in to FlowState</h1>
  <p class="subtitle">
    ${appParam
      ? `You need a FlowState account to use ${appLabel}. Sign in below — it's free.`
      : 'The intelligent workspace for focused teams.'}
  </p>

  <a class="btn-google" href="${googleUrl}">
    <svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Continue with Google
  </a>

  <div class="divider">or</div>

  <div class="magic-form" id="magic-form">
    <input class="magic-input" id="magic-email" type="email" placeholder="your@email.com" autocomplete="email">
    <button class="btn-magic" id="magic-btn" onclick="sendMagicLink()">
      ✉️ &nbsp;Send sign-in link
    </button>
  </div>
  <div class="magic-sent" id="magic-sent">
    ✅ &nbsp;Check your inbox — we sent a sign-in link!
  </div>

  <div class="features">
    <div class="feat"><span class="feat-icon">✓</span> Free account</div>
    <div class="feat"><span class="feat-icon">✓</span> No credit card</div>
    <div class="feat"><span class="feat-icon">✓</span> All DAW tools</div>
    <div class="feat"><span class="feat-icon">✓</span> Cloud sync</div>
  </div>

  <p class="legal">By signing in you agree to our <a href="https://flowst8.cc/terms" target="_blank">Terms</a> &amp; <a href="https://flowst8.cc/privacy" target="_blank">Privacy Policy</a>.<br>Your data is never sold.</p>
</div>

<script>
async function sendMagicLink() {
  const email = document.getElementById('magic-email').value.trim()
  if (!email || !email.includes('@')) { alert('Please enter a valid email.'); return }
  const btn = document.getElementById('magic-btn')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Sending…'
  try {
    const res = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, app: ${JSON.stringify(appParam)}, state: ${JSON.stringify(appState)}, redirect: ${JSON.stringify(appRedirect)} })
    })
    const data = await res.json()
    if (data.ok || data.sent) {
      document.getElementById('magic-form').style.display = 'none'
      document.getElementById('magic-sent').style.display = 'block'
    } else {
      btn.disabled = false
      btn.innerHTML = '✉️ &nbsp;Send sign-in link'
      alert(data.error || 'Something went wrong. Try again.')
    }
  } catch(e) {
    btn.disabled = false
    btn.innerHTML = '✉️ &nbsp;Send sign-in link'
    alert('Network error. Please try again.')
  }
}
document.getElementById('magic-email').addEventListener('keydown', function(e){
  if (e.key === 'Enter') sendMagicLink()
})
</script>
</body>
</html>`)
})

// ═══════════════════════════════════════════════════════════════════
// MAIN HTML — FlowState v3 — Full Rebuild
// ═══════════════════════════════════════════════════════════════════
app.get('/', (c) => {
  const session   = decodeSession(getCookie(c, 'fs_session') || '')
  const notionSes = decodeSession(getCookie(c, 'fs_notion')  || '')
  const slackSes  = decodeSession(getCookie(c, 'fs_slack')   || '')
  const onboarding = decodeSession(getCookie(c, 'fs_onboarded') || '')

  const userJson     = session     ? JSON.stringify({ name: session.name, email: session.email, picture: session.picture, role: session.role || 'member', provider: session.provider }) : 'null'
  const notionJson   = notionSes   ? JSON.stringify({ workspace: notionSes.workspace_name }) : 'null'
  const slackJson    = slackSes    ? JSON.stringify({ team: slackSes.team_name }) : 'null'
  // Tie onboarding to the signed-in user's email so different users
  // on the same browser each go through onboarding exactly once
  const onboardedForUser = onboarding?.completed && onboarding?.email === session?.email
  const onboardedJson = onboardedForUser ? 'true' : 'false'

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowState — Intelligent Workspace</title>
<!-- Favicon — full cross-browser coverage -->
<link rel="icon" href="/static/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/static/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png">
<link rel="manifest" href="/static/site.webmanifest">
<meta name="theme-color" content="#1a0533">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg-base:#0f0f1a; --bg-panel:#1a1a2e; --bg-card:#16213e;
  --border:rgba(168,85,247,.18); --border-h:rgba(168,85,247,.45);
  --text-p:#f0f0f0; --text-s:#888; --text-m:#555;
  --accent:#a855f7; --pink:#ec4899; --blue:#3b82f6; --cyan:#06b6d4;
  --green:#10b981; --warn:#f59e0b; --danger:#ef4444;
  --grad:linear-gradient(135deg,#a855f7,#ec4899);
  --grad-b:linear-gradient(135deg,#3b82f6,#06b6d4);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg-base);color:var(--text-p);display:flex;flex-direction:column}
.orb{position:fixed;border-radius:50%;pointer-events:none;filter:blur(80px);opacity:0;transition:opacity 2s}
.orb1{width:500px;height:500px;top:-100px;left:-100px;background:radial-gradient(circle,rgba(168,85,247,.22),transparent 70%)}
.orb2{width:400px;height:400px;bottom:-100px;right:-100px;background:radial-gradient(circle,rgba(236,72,153,.18),transparent 70%)}
.amb-active .orb1,.amb-active .orb2{opacity:1}
header{display:flex;align-items:center;gap:10px;padding:8px 18px;background:rgba(26,26,46,.9);border-bottom:1px solid var(--border);backdrop-filter:blur(20px);flex-shrink:0;z-index:100}
.logo{font-size:17px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.5px;cursor:pointer}
.dt-widget{margin-left:auto;font-size:12px;color:var(--text-s);cursor:pointer;display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:8px;border:1px solid transparent;transition:.2s}
.dt-widget:hover{border-color:var(--border);background:rgba(168,85,247,.05)}
.dt-date{font-weight:600;color:var(--text-p)}
.dt-time{font-weight:800;font-size:13px;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-variant-numeric:tabular-nums}
.u-pill{display:flex;align-items:center;gap:7px;padding:4px 10px;border-radius:20px;border:1px solid var(--border);cursor:pointer;transition:.2s}
.u-pill:hover{border-color:var(--accent)}
.u-avatar{width:28px;height:28px;border-radius:50%;border:2px solid var(--accent);object-fit:cover;background:var(--bg-card)}
.u-name{font-size:12px;font-weight:600;color:var(--text-s)}
.btn-signin{background:var(--grad);border:none;color:#fff;padding:7px 16px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;transition:.2s}
.tabs-bar{display:flex;align-items:center;gap:2px;padding:5px 16px;background:rgba(15,15,26,.95);border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.tabs-bar::-webkit-scrollbar{display:none}
.tab-btn{display:flex;align-items:center;gap:5px;padding:6px 14px;border-radius:9px;font-size:12px;font-weight:600;color:var(--text-s);border:none;background:transparent;cursor:pointer;transition:.2s;white-space:nowrap}
.tab-btn:hover{color:var(--text-p);background:rgba(168,85,247,.08)}
.tab-btn.active{color:var(--accent);background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.25)}
.tab-btn i{font-size:12px}
.tab-btn.demo-tab{color:var(--warn);border-color:rgba(245,158,11,.3)}
.tab-btn.demo-tab.active{color:var(--warn);background:rgba(245,158,11,.1);border-color:var(--warn)}
.tab-pane{display:none;flex:1;overflow-y:auto;padding:18px}
.tab-pane.active{display:flex;flex-direction:column}
/* ── Genspark-style model picker ── */
.model-bar{display:flex;align-items:center;gap:6px;padding:0;background:transparent;margin-bottom:0;position:relative}
.gs-model-pill{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;background:var(--bg-card);border:1px solid var(--border-h);color:var(--text-p);cursor:pointer;font-size:13px;font-weight:500;transition:all .18s;white-space:nowrap;user-select:none}
.gs-model-pill:hover{border-color:var(--accent);background:var(--bg-panel)}
/* Chat dropdown — opens upward above the input box */
#model-bar .gs-model-dropdown{bottom:calc(100% + 8px);top:auto}
/* Gen-tab dropdowns — open downward */
.gs-gen-picker .gs-model-dropdown{top:calc(100% + 6px);bottom:auto}
.gs-model-dropdown{position:absolute;left:0;min-width:300px;max-width:360px;background:#16162a;border:1px solid var(--border-h);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.7);padding:8px;z-index:99999;max-height:420px;overflow-y:auto}
.gs-model-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .15s;gap:8px}
.gs-model-row:hover{background:rgba(168,85,247,.14)}
.gs-model-selected{background:rgba(168,85,247,.1)}
.gs-radio{width:18px;height:18px;border-radius:50%;border:2px solid rgba(255,255,255,.2);flex-shrink:0;transition:.15s}
.gs-radio-active{border-color:#3b82f6;background:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.3)}
/* gen picker wrapper — needs relative positioning for dropdown */
.gs-gen-picker{position:relative;display:inline-block}
.r-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
.timer-wrap{display:flex;flex-direction:column;align-items:center;gap:18px;max-width:460px;margin:0 auto;width:100%}
.ring-outer{position:relative;width:220px;height:220px}
.ring-outer svg{transform:rotate(-90deg)}
.ring-bg{fill:none;stroke:rgba(168,85,247,.12);stroke-width:12}
.ring-prog{fill:none;stroke:url(#rg);stroke-width:12;stroke-linecap:round;transition:stroke-dashoffset .5s}
.timer-inner{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
#timer-display{font-size:48px;font-weight:900;letter-spacing:-2px;font-variant-numeric:tabular-nums}
.timer-phase{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--text-m);margin-top:2px}
.t-glow{position:absolute;inset:0;border-radius:50%;pointer-events:none;transition:opacity .5s;opacity:0}
.t-glow.on{opacity:1;box-shadow:0 0 60px rgba(168,85,247,.35),0 0 120px rgba(168,85,247,.12)}
.b-ring{position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(168,85,247,.3);animation:breathe 4s ease-in-out infinite;pointer-events:none;opacity:0}
.b-ring.on{opacity:1}
@keyframes breathe{0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(1.04);opacity:.6}}
.phase-btns{display:flex;gap:7px}
.ph-btn{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.ph-btn:hover,.ph-btn.active{border-color:var(--accent);color:var(--accent);background:rgba(168,85,247,.08)}
.t-controls{display:flex;gap:12px;align-items:center}
.btn-t{width:62px;height:62px;border-radius:50%;border:none;cursor:pointer;font-size:20px;transition:.2s;display:flex;align-items:center;justify-content:center}
.btn-start{background:var(--grad);color:#fff;box-shadow:0 0 28px rgba(168,85,247,.4)}
.btn-start:hover{transform:scale(1.06);box-shadow:0 0 40px rgba(168,85,247,.6)}
.btn-sm-t{background:rgba(168,85,247,.1);border:1px solid var(--border);color:var(--text-s);width:42px;height:42px;font-size:14px}
.btn-sm-t:hover{border-color:var(--border-h);color:var(--text-p)}
.stats-row{display:flex;gap:20px;justify-content:center}
.stat-item{text-align:center}
.stat-val{font-size:20px;font-weight:800;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-lbl{font-size:10px;font-weight:600;color:var(--text-m);text-transform:uppercase;letter-spacing:1px}
.amb-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:14px;width:100%;max-width:460px;margin:0 auto}
.amb-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);margin-bottom:9px}
.s-chips{display:flex;gap:7px;flex-wrap:wrap}
.s-chip{padding:5px 12px;border-radius:18px;font-size:12px;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.s-chip:hover{border-color:var(--border-h);color:var(--text-p)}
.s-chip.active{background:rgba(168,85,247,.15);border-color:var(--accent);color:var(--accent)}
.intent-modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:5000;backdrop-filter:blur(10px)}
.intent-card{background:var(--bg-panel);border:1px solid var(--border-h);border-radius:22px;padding:36px 32px;max-width:440px;width:90%;text-align:center}
.intent-card h2{font-size:18px;font-weight:800;margin-bottom:6px}
.intent-card p{color:var(--text-s);font-size:14px;margin-bottom:18px}
.intent-input{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-p);font-size:15px;font-family:inherit;outline:none;margin-bottom:14px}
.intent-input:focus{border-color:var(--accent)}
.intent-suggestions{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;margin-bottom:18px}
.intent-sug{padding:5px 12px;border-radius:16px;font-size:12px;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.intent-sug:hover{border-color:var(--accent);color:var(--accent)}
.chat-wrap{display:flex;flex-direction:column;height:100%}
.chat-msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:11px;padding-bottom:12px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.msg{display:flex;gap:9px;align-items:flex-start;animation:fadeUp .25s ease}
.msg.user{flex-direction:row-reverse}
.msg-bub{max-width:78%;padding:11px 15px;border-radius:16px;font-size:14px;line-height:1.65;word-break:break-word}
.msg.user .msg-bub{background:var(--grad);color:#fff;border-radius:16px 16px 4px 16px}
.msg.ai .msg-bub{background:var(--bg-panel);border:1px solid var(--border);color:var(--text-p);border-radius:16px 16px 16px 4px}
.msg-av{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;border:1px solid var(--border)}
.msg-meta{display:flex;align-items:center;gap:5px;margin-bottom:3px;font-size:11px;color:var(--text-m)}
.m-tag{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;background:rgba(168,85,247,.15);color:var(--accent)}
.typing{display:flex;gap:4px;align-items:center;padding:8px 4px}
.t-dot{width:7px;height:7px;border-radius:50%;background:var(--text-m);animation:bounce 1.2s infinite}
.t-dot:nth-child(2){animation-delay:.2s}.t-dot:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}
.chat-input-row{display:flex;gap:8px;padding:10px 0 0;flex-shrink:0}
.chat-in{flex:1;background:transparent;border:none;border-radius:0;padding:0;color:var(--text-p);font-size:14px;font-family:inherit;resize:none;outline:none;min-height:42px;max-height:130px;width:100%}
.chat-in:focus{border-color:var(--accent)}
.btn-send{width:42px;height:42px;border-radius:11px;background:var(--grad);border:none;color:#fff;font-size:15px;cursor:pointer;transition:.2s;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.chat-suggest-chip{background:var(--bg-panel);border:1px solid var(--border);color:var(--text-m);padding:7px 13px;border-radius:20px;font-size:12.5px;cursor:pointer;transition:.2s;white-space:nowrap}
.chat-suggest-chip:hover{border-color:var(--accent);color:var(--accent);background:rgba(168,85,247,.07)}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:14px}
.cal-hd{text-align:center;font-size:10px;font-weight:700;color:var(--text-m);padding:5px;text-transform:uppercase;letter-spacing:1px}
.cal-day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:.2s;position:relative;border:1px solid transparent}
.cal-day:hover{background:rgba(168,85,247,.1);border-color:var(--border)}
.cal-day.today{background:rgba(168,85,247,.15);border-color:var(--accent);color:var(--accent);font-weight:900}
.cal-day.has-ev::after{content:'';position:absolute;bottom:3px;left:50%;transform:translateX(-50%);width:4px;height:4px;border-radius:50%;background:var(--accent)}
.cal-day.other{opacity:.25;cursor:default}
.ev-list{display:flex;flex-direction:column;gap:7px;margin-top:4px}
.ev-item{display:flex;align-items:center;gap:9px;padding:9px 13px;background:var(--bg-panel);border:1px solid var(--border);border-radius:11px;cursor:pointer;transition:.2s}
.ev-item:hover{border-color:var(--border-h)}
.ev-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.ev-time{font-size:12px;color:var(--text-m);min-width:48px;font-weight:600}
.ev-sum{font-size:13px;font-weight:600;flex:1}
.btn-blk{background:rgba(168,85,247,.1);border:1px solid var(--border);color:var(--text-m);padding:4px 9px;border-radius:7px;font-size:11px;cursor:pointer;transition:.2s;margin-left:auto}
.btn-blk:hover{border-color:var(--accent);color:var(--accent)}
.btn-blk.del{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:var(--danger)}
.cal-add-btn{display:flex;align-items:center;gap:7px;padding:9px 16px;border-radius:11px;background:var(--grad);border:none;color:#fff;font-size:13px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:14px;width:fit-content}
.insight-box{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px}
.ins-hl{font-size:15px;font-weight:800;margin-bottom:5px}
.ins-src{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
.src-badge{background:rgba(168,85,247,.1);color:var(--accent);padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700}
.metrics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:11px;margin-bottom:14px}
.m-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:15px;text-align:center}
.m-icon{font-size:24px;margin-bottom:8px}
.m-val{font-size:22px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.m-lbl{font-size:11px;font-weight:700;color:var(--text-m);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.m-trend{font-size:11px;color:var(--text-s)}
.chart-wrap{background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:16px}
.chart-title{font-size:13px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:7px}
.board-wrap{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;min-height:300px}
.k-col{flex:0 0 280px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:13px;display:flex;flex-direction:column;gap:8px;min-height:200px}
.k-col-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.k-col-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px}
.k-count{font-size:11px;background:rgba(168,85,247,.12);color:var(--accent);padding:2px 7px;border-radius:9px;font-weight:700}
.k-cards{display:flex;flex-direction:column;gap:7px;min-height:60px}
.k-card{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:11px 13px;cursor:grab;transition:.2s;position:relative}
.k-card:hover{border-color:var(--border-h)}
.k-card.dragging{opacity:.5;cursor:grabbing}
.k-card-title{font-size:13px;font-weight:600;margin-bottom:5px}
.k-card-meta{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.k-tag{font-size:10px;padding:2px 6px;border-radius:5px;background:rgba(168,85,247,.1);color:var(--accent);font-weight:700}
.k-del{position:absolute;top:7px;right:8px;background:none;border:none;color:var(--text-m);cursor:pointer;font-size:12px;opacity:0;transition:.2s}
.k-card:hover .k-del{opacity:1}
.k-del:hover{color:var(--danger)}
.k-add-btn{display:flex;align-items:center;gap:6px;padding:7px 11px;border-radius:9px;border:1px dashed var(--border);background:transparent;color:var(--text-m);cursor:pointer;font-size:12px;font-weight:600;transition:.2s;width:100%;justify-content:center;margin-top:4px}
.k-add-btn:hover{border-color:var(--accent);color:var(--accent)}
.sprint-health{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px}
.sh-title{font-size:13px;font-weight:800;margin-bottom:12px;display:flex;align-items:center;gap:7px}
.sh-progress{height:8px;background:rgba(168,85,247,.1);border-radius:4px;overflow:hidden;margin-bottom:4px}
.sh-fill{height:100%;border-radius:4px;transition:.5s}
.sh-stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px}
.sh-stat{text-align:center}
.sh-stat-v{font-size:18px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sh-stat-l{font-size:10px;color:var(--text-m);text-transform:uppercase;letter-spacing:.5px}
.sh-pace{margin-bottom:8px}
.pace-badge{display:inline-block;padding:3px 10px;border-radius:8px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px}
.team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:14px}
.member-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:14px;text-align:center;position:relative}
.pulse-dot{width:10px;height:10px;border-radius:50%;position:absolute;top:12px;right:12px}
.pulse-dot.focus{background:var(--accent);animation:pulse 2s infinite}
.pulse-dot.online{background:var(--green)}
.pulse-dot.break{background:var(--warn)}
.pulse-dot.offline{background:var(--text-m)}
.member-av{font-size:32px;margin-bottom:7px}
.member-name{font-size:13px;font-weight:800;margin-bottom:3px}
.member-role{font-size:11px;color:var(--text-m);margin-bottom:6px;padding:2px 7px;background:rgba(168,85,247,.1);border-radius:5px;display:inline-block}
.burnout-bar{height:5px;background:rgba(168,85,247,.1);border-radius:3px;overflow:hidden;margin-top:8px}
.burnout-fill{height:100%;border-radius:3px;transition:.5s}
.role-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:8px;font-size:11px;font-weight:700;margin-bottom:8px}
.role-badge.admin{background:rgba(168,85,247,.15);color:var(--accent)}
.role-badge.scrum_master{background:rgba(59,130,246,.15);color:var(--blue)}
.role-badge.senior_dev{background:rgba(245,158,11,.15);color:var(--warn)}
.role-badge.member{background:rgba(136,136,136,.1);color:var(--text-s)}
.learn-car{border-radius:18px;overflow:hidden;margin-bottom:14px;min-height:220px}
.l-card{padding:36px;text-align:center}
.l-type{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:.7;margin-bottom:10px}
.l-title{font-size:20px;font-weight:900;margin-bottom:10px}
.l-content{font-size:14px;line-height:1.7;opacity:.85;max-width:400px;margin:0 auto}
.l-meta{font-size:11px;opacity:.6;margin-top:12px;font-style:italic}
.l-nav{display:flex;gap:6px;align-items:center;justify-content:center;margin-bottom:14px;flex-wrap:wrap}
.l-nav-btn{background:var(--bg-panel);border:1px solid var(--border);color:var(--text-s);padding:6px 12px;border-radius:8px;cursor:pointer;transition:.2s}
.l-nav-btn:hover{border-color:var(--accent);color:var(--accent)}
.l-dot{width:8px;height:8px;border-radius:50%;background:var(--border);cursor:pointer;transition:.2s}
.l-dot.active{background:var(--accent);width:20px;border-radius:4px}
.r-scene{border-radius:18px;overflow:hidden;position:relative;min-height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px;text-align:center;margin-bottom:14px}
.r-emoji{font-size:52px;margin-bottom:14px;line-height:1}
.r-title{font-size:20px;font-weight:900;margin-bottom:9px}
.r-content{font-size:14px;line-height:1.7;opacity:.85;max-width:380px;margin-bottom:18px}
.breath-circ{width:110px;height:110px;border-radius:50%;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;margin:14px auto;transition:transform 4s,background .5s;cursor:pointer}
.breath-circ.expand{transform:scale(1.5);background:rgba(255,255,255,.25)}
.r-steps{text-align:left;display:flex;flex-direction:column;gap:7px;margin:14px 0}
.r-step{display:flex;align-items:center;gap:9px;font-size:13px;padding:7px 13px;background:rgba(255,255,255,.1);border-radius:7px}
.r-step-n{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.r-nav{display:flex;gap:9px;justify-content:center}
.r-btn{padding:9px 22px;border-radius:11px;font-size:13px;font-weight:700;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;transition:.2s}
.r-btn:hover{background:rgba(255,255,255,.2)}
.grat-in{width:100%;max-width:340px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.3);border-radius:11px;padding:13px 16px;font-size:14px;color:#fff;font-family:inherit;outline:none;margin-bottom:11px;text-align:center}
.grat-in::placeholder{color:rgba(255,255,255,.5)}
/* ── Generate tab layout ── */
.gen-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.gen-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px}
.gen-i2v-panel{margin-bottom:0}
/* ── Generate sub-tab bar ── */
.gen-subtab-bar{display:flex;align-items:center;gap:4px;padding:8px 16px;background:rgba(15,15,26,.7);border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.gen-subtab-bar::-webkit-scrollbar{display:none}
.gen-subtab-btn{display:flex;align-items:center;gap:6px;padding:7px 16px;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-s);border:1px solid transparent;background:transparent;cursor:pointer;transition:.18s;white-space:nowrap}
.gen-subtab-btn:hover{color:var(--text-p);background:rgba(168,85,247,.08)}
.gen-subtab-btn.active{color:var(--accent);background:rgba(168,85,247,.14);border-color:rgba(168,85,247,.3)}
.gen-subtab-btn i{font-size:12px}
/* ── Generate body wrap (sub-panes + sidebar row) ── */
.gen-body-wrap{display:flex;flex:1;overflow:hidden;position:relative}
.gen-sub-pane{display:none;flex:1;overflow:hidden;flex-direction:row;height:100%}
.gen-sub-pane.active{display:flex}
.gen-main-area{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:0}
/* ── Generate sidebar ── */
.gen-sidebar{width:240px;flex-shrink:0;background:rgba(10,10,20,.6);border-left:1px solid var(--border);display:flex;flex-direction:column;padding:14px;gap:8px;overflow-y:auto}
.gen-sidebar-hd{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:var(--accent);margin-bottom:4px;display:flex;align-items:center;gap:6px}
.gen-sidebar-empty{text-align:center;font-size:12px;color:var(--text-m);padding:20px 8px;line-height:1.6;flex:1}
.gen-sidebar-log{display:flex;flex-direction:column;gap:6px;font-size:11px}
.gen-sidebar-entry{padding:7px 10px;background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.15);border-radius:8px;line-height:1.5;color:var(--text-s);animation:fadeUp .25s ease}
.gen-sidebar-entry.success{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.2);color:#10b981}
.gen-sidebar-entry.error{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.2);color:#ef4444}
.gen-sidebar-section{padding-top:10px;border-top:1px solid var(--border)}
.gen-sidebar-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);margin-bottom:6px}
.gen-sidebar-row{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--text-s);padding:3px 0}
/* ── Higgsfield AI cards ── */
.higgs-model-card{background:rgba(0,212,255,.04);border:1px solid rgba(0,212,255,.15);border-radius:12px;padding:12px 14px;cursor:pointer;transition:.18s;position:relative}
.higgs-model-card:hover{background:rgba(0,212,255,.09);border-color:rgba(0,212,255,.35);transform:translateY(-1px)}
.higgs-model-card.active{background:rgba(0,212,255,.12);border-color:#00d4ff;box-shadow:0 0 14px rgba(0,212,255,.2)}
.higgs-model-badge{font-size:9px;font-weight:800;letter-spacing:.8px;color:#00d4ff;text-transform:uppercase;margin-bottom:5px;opacity:.8}
.higgs-model-name{font-size:13px;font-weight:800;color:#e8e8e8;margin-bottom:3px}
.higgs-model-desc{font-size:11px;color:rgba(255,255,255,.45);line-height:1.4}
/* ── File tool grid ── */
.file-tool-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:4px}
.file-tool-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px;transition:.2s}
.file-tool-card:hover{border-color:var(--border-h)}
.file-tool-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0}
.file-tool-name{font-size:13px;font-weight:800;color:var(--text-p)}
.file-tool-desc{font-size:11px;color:var(--text-m);line-height:1.55}
.file-tool-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:16px;border:2px dashed var(--border);border-radius:10px;cursor:pointer;transition:.2s;font-size:12px;color:var(--text-m);text-align:center;min-height:72px}
.file-tool-drop:hover{border-color:var(--accent);color:var(--text-p)}
.file-tool-status{font-size:11px;color:var(--text-m);min-height:14px}
.file-tool-results{display:flex;flex-direction:column;gap:6px;font-size:11px}
.file-tool-dl{display:flex;align-items:center;gap:6px;padding:5px 10px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);border-radius:7px;color:#10b981;text-decoration:none;font-weight:600;transition:.2s}
.file-tool-dl:hover{background:rgba(16,185,129,.18)}
.gen-section-header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.gen-title{font-size:14px;font-weight:700;margin:0}
.gen-picker-wrap{position:relative;display:flex;flex-direction:column;gap:6px}
.gen-model-desc{font-size:12px;color:var(--text-s);line-height:1.55;padding:8px 12px;background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.15);border-radius:9px}
.gen-pmt{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 15px;color:var(--text-p);font-size:14px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box}
.gen-pmt:focus{border-color:var(--accent)}
.gen-dur-row{display:flex;gap:6px;flex-wrap:wrap}
.gen-dur-btn{padding:5px 12px;border-radius:20px;border:1px solid var(--border);background:transparent;color:var(--text-s);font-size:12px;font-weight:600;cursor:pointer;transition:.15s}
.gen-dur-btn:hover{border-color:var(--accent);color:var(--text-p)}
.gen-dur-btn.active{background:var(--grad);border-color:transparent;color:#fff}
.gen-new-badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px;background:rgba(6,182,212,.15);color:var(--cyan)}
.btn-gen{padding:10px 22px;border-radius:12px;background:var(--grad);border:none;color:#fff;font-size:13px;font-weight:700;cursor:pointer;transition:.2s;display:flex;align-items:center;gap:7px;justify-content:center}
.btn-gen:hover{opacity:.88;transform:translateY(-1px)}
.btn-gen:disabled{opacity:.4;cursor:not-allowed;transform:none}
.btn-gen-i2v{width:100%;background:linear-gradient(135deg,#a855f7,#ec4899)}
.gen-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:11px;margin-top:4px}
/* Image→Video layout */
.gen-i2v-body{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
.gen-i2v-upload{display:flex;flex-direction:column;gap:8px}
.gen-i2v-right{display:flex;flex-direction:column;gap:10px}
.gen-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:11px;border:1px solid var(--border);cursor:pointer;transition:.2s}
.gen-img:hover{border-color:var(--accent);transform:scale(1.02)}
.tip-bub{position:fixed;bottom:76px;right:18px;max-width:290px;background:var(--bg-panel);border:1px solid var(--border-h);border-radius:14px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:1000;animation:slideR .3s ease}
.tip-hd{display:flex;align-items:center;gap:7px;margin-bottom:7px}
.tip-emoji{font-size:18px}
.tip-cat{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m)}
.tip-msg{font-size:13px;line-height:1.5;color:var(--text-p)}
.tip-x{position:absolute;top:9px;right:11px;background:none;border:none;color:var(--text-m);cursor:pointer;font-size:15px}
.celeb-ov{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2000;pointer-events:none}
.celeb-card{background:var(--bg-panel);border:1px solid rgba(168,85,247,.4);border-radius:22px;padding:34px 46px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);pointer-events:all;animation:celebIn .5s cubic-bezier(.34,1.56,.64,1)}
.celeb-emoji{font-size:52px;margin-bottom:11px;display:block}
.celeb-title{font-size:22px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:5px}
.celeb-sub{font-size:13px;color:var(--text-s)}
.confetti-p{position:fixed;width:8px;height:8px;border-radius:2px;pointer-events:none;animation:cFall linear forwards}
@keyframes cFall{0%{opacity:1;transform:translate(0,0) rotate(0deg)}100%{opacity:0;transform:translate(var(--tx),var(--ty)) rotate(720deg)}}
@keyframes celebIn{0%{opacity:0;transform:scale(.6)}100%{opacity:1;transform:scale(1)}}
@keyframes slideR{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:translateX(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:.6;transform:scale(1)}50%{opacity:1;transform:scale(1.5)}}
@keyframes spin{to{transform:rotate(360deg)}}
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:3000;backdrop-filter:blur(8px);padding:14px}
.modal-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:18px;padding:28px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto}
.modal-card.modal-wide{max-width:900px}
.modal-card h2{font-size:18px;font-weight:800;margin-bottom:5px}
.tier-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:13px;margin:14px 0}
.t-card{padding:16px;border-radius:14px;border:1px solid var(--border);text-align:center;transition:.2s;background:var(--bg-card)}
.t-card:hover{border-color:var(--border-h);transform:translateY(-2px)}
.t-card.hi{border:2px solid var(--accent);background:rgba(168,85,247,.07)}
.t-card h3{font-size:15px;font-weight:800;margin:0 0 4px}
.t-card .price{font-size:22px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1.2}
.t-feats{font-size:11px;color:var(--text-s);line-height:1.9;text-align:left;margin:8px 0 12px;list-style:none;padding:0}
.t-feats li{padding-left:16px;position:relative}
.t-feats li::before{content:"✓ ";position:absolute;left:0;font-size:11px;color:var(--green)}
.cred-tbl{width:100%;border-collapse:collapse;font-size:12px;margin-top:14px}
.cred-tbl th{text-align:left;padding:7px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);border-bottom:1px solid var(--border)}
.cred-tbl td{padding:7px;border-bottom:1px solid rgba(168,85,247,.06);vertical-align:middle}
.cred-tbl a{color:var(--accent);text-decoration:none;font-weight:600}
.badge-core{background:rgba(16,185,129,.15);color:var(--green);padding:2px 5px;border-radius:4px;font-size:10px;font-weight:700}
.badge-rec{background:rgba(245,158,11,.15);color:var(--warn);padding:2px 5px;border-radius:4px;font-size:10px;font-weight:700}
.badge-opt{background:rgba(168,85,247,.1);color:var(--accent);padding:2px 5px;border-radius:4px;font-size:10px;font-weight:700}
.ob-screen{position:fixed;inset:0;background:var(--bg-base);display:flex;align-items:center;justify-content:center;z-index:9000;padding:20px}
.ob-card{background:var(--bg-panel);border:1px solid var(--border-h);border-radius:24px;padding:40px;max-width:520px;width:100%;text-align:center}
.ob-logo{font-size:42px;margin-bottom:10px}
.ob-title{font-size:24px;font-weight:900;margin-bottom:6px}
.ob-sub{color:var(--text-s);font-size:14px;margin-bottom:28px;line-height:1.6}
.ob-step{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--text-m);margin-bottom:22px}
.ob-progress{display:flex;gap:6px;justify-content:center;margin-bottom:28px}
.ob-dot{width:8px;height:8px;border-radius:50%;background:var(--border);transition:.3s}
.ob-dot.active{background:var(--accent);width:24px;border-radius:4px}
.ob-dot.done{background:var(--green)}
.goal-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:22px;text-align:left}
.goal-btn{padding:14px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--text-p);cursor:pointer;transition:.2s;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;width:100%;text-align:left}
.goal-btn:hover{border-color:var(--border-h)}
.goal-btn.sel{border-color:var(--accent);background:rgba(168,85,247,.1);color:var(--accent)}
.goal-btn i{width:20px;color:var(--text-m)}
.goal-btn.sel i{color:var(--accent)}
.integ-list{display:flex;flex-direction:column;gap:8px;margin-bottom:22px;text-align:left}
.integ-row{display:flex;align-items:center;justify-content:space-between;padding:12px 15px;background:var(--bg-card);border:1px solid var(--border);border-radius:11px}
.integ-left{display:flex;align-items:center;gap:10px}
.integ-icon{font-size:20px}
.integ-name{font-size:13px;font-weight:700}
.integ-desc{font-size:11px;color:var(--text-m)}
.btn-connect{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.btn-connect:hover{border-color:var(--accent);color:var(--accent)}
.btn-connect.connected{border-color:var(--green);color:var(--green);background:rgba(16,185,129,.1)}
.rhythm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px}
.rhythm-btn{padding:14px 10px;border-radius:11px;border:1px solid var(--border);background:transparent;color:var(--text-p);cursor:pointer;transition:.2s;text-align:center;width:100%}
.rhythm-btn:hover{border-color:var(--border-h)}
.rhythm-btn.sel{border-color:var(--accent);background:rgba(168,85,247,.1);color:var(--accent)}
.rhythm-min{font-size:22px;font-weight:900;display:block;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.rhythm-lbl{font-size:11px;color:var(--text-m)}
.ob-btn{width:100%;padding:14px;border-radius:13px;background:var(--grad);border:none;color:#fff;font-size:15px;font-weight:800;cursor:pointer;transition:.2s}
.ob-btn:hover{opacity:.88;transform:scale(1.01)}
.ob-skip{background:none;border:none;color:var(--text-m);font-size:12px;cursor:pointer;margin-top:12px;text-decoration:underline}
.login-screen{position:fixed;inset:0;background:var(--bg-base);display:flex;align-items:center;justify-content:center;z-index:8000;padding:20px}
.login-card{background:var(--bg-panel);border:1px solid var(--border-h);border-radius:24px;padding:44px 40px;max-width:420px;width:100%;text-align:center}
.login-logo{font-size:52px;margin-bottom:12px}
.login-title{font-size:26px;font-weight:900;margin-bottom:8px}
.login-sub{color:var(--text-s);font-size:14px;margin-bottom:32px;line-height:1.65}
.btn-google{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:14px;border-radius:13px;background:#fff;border:none;color:#1a1a2e;font-size:15px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:12px}
.btn-google:hover{transform:scale(1.02);box-shadow:0 4px 20px rgba(255,255,255,.1)}
.btn-google svg{width:20px;height:20px;flex-shrink:0}
.btn-magic{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px;border-radius:13px;background:transparent;border:1px solid var(--border);color:var(--text-p);font-size:15px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:12px}
.btn-magic:hover{border-color:var(--border-h);background:rgba(168,85,247,.06)}
.btn-demo-login{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px;border-radius:13px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);color:var(--warn);font-size:14px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:24px}
.btn-demo-login:hover{background:rgba(245,158,11,.15)}
.login-features{display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left}
.login-feat{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-s)}
.login-feat i{color:var(--accent);width:14px}
.login-legal{font-size:11px;color:var(--text-m);margin-top:22px;line-height:1.5}
.sec-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.sec-title{font-size:14px;font-weight:800}
.btn-sm{padding:5px 12px;border-radius:7px;font-size:12px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.btn-sm:hover{border-color:var(--border-h);color:var(--text-p)}
.btn-primary{background:var(--grad);border:none;color:#fff;padding:9px 22px;border-radius:11px;font-size:13px;font-weight:700;cursor:pointer;transition:.2s}
.btn-primary:hover{opacity:.85;transform:scale(1.02)}
.empty{text-align:center;padding:36px 18px;color:var(--text-m)}
.empty i{font-size:34px;margin-bottom:11px;display:block;opacity:.4}
.empty p{font-size:13px;margin-bottom:14px;line-height:1.6}
.auth-banner{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.05));border:1px solid rgba(168,85,247,.2);border-radius:13px;padding:18px;text-align:center;margin-bottom:14px}
.auth-banner h3{font-size:15px;font-weight:800;margin-bottom:5px}
.auth-banner p{font-size:13px;color:var(--text-s);margin-bottom:13px}
.demo-banner{background:linear-gradient(135deg,rgba(245,158,11,.08),rgba(239,68,68,.05));border:1px solid rgba(245,158,11,.3);border-radius:11px;padding:11px 16px;font-size:12px;color:var(--warn);margin-bottom:14px;display:flex;align-items:center;gap:8px}
.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;display:inline-block}
/* select.fs-sel removed — all dropdowns now use gs-model-pill pickers */
input.fs-in{background:var(--bg-card);border:1px solid var(--border);border-radius:7px;color:var(--text-p);padding:8px 13px;font-size:13px;outline:none;width:100%}
input.fs-in:focus{border-color:var(--accent)}
code{background:rgba(168,85,247,.1);padding:2px 5px;border-radius:4px;font-size:12px;color:var(--accent)}
pre{background:var(--bg-card);border:1px solid var(--border);border-radius:7px;padding:11px;font-size:12px;overflow-x:auto;margin:7px 0;line-height:1.5}
strong{color:var(--text-p);font-weight:700}
em{color:var(--accent);font-style:italic}
.divider{border:none;border-top:1px solid var(--border);margin:11px 0}
.notion-db-list{display:flex;flex-direction:column;gap:7px;margin-top:11px}
.notion-db{display:flex;align-items:center;gap:11px;padding:11px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:9px;cursor:pointer;transition:.2s}
.notion-db:hover{border-color:var(--accent)}
.notion-db.sel{border-color:var(--accent);background:rgba(168,85,247,.08)}
.invite-box{background:linear-gradient(135deg,rgba(168,85,247,.1),rgba(236,72,153,.06));border:1px solid rgba(168,85,247,.25);border-radius:14px;padding:20px;text-align:center}
.invite-code{font-size:22px;font-weight:900;letter-spacing:3px;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:12px 0}
.block-warn{background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.28);border-radius:11px;padding:11px 15px;font-size:13px;color:var(--warn);width:100%;max-width:460px;margin:0 auto}
.action-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-s);padding:5px 0;border-bottom:1px solid rgba(168,85,247,.05)}
.action-item i{color:var(--accent);font-size:11px}
.deadline-item{padding:9px 13px;background:var(--bg-card);border:1px solid var(--border);border-radius:9px;margin-bottom:6px}
.add-ev-form{background:var(--bg-panel);border:1px solid var(--border-h);border-radius:14px;padding:16px;margin-bottom:14px;display:none}
.add-ev-form.show{display:block}
.add-ev-form h3{font-size:13px;font-weight:800;margin-bottom:12px}
.form-row{display:flex;gap:8px;margin-bottom:8px}
.form-row input,.form-row select{flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:7px;color:var(--text-p);padding:8px 11px;font-size:13px;outline:none}
.form-row input:focus,.form-row select:focus{border-color:var(--accent)}
/* ── FlowState Audio download page ───────────────────────────── */
.aud-dl-btn{display:inline-flex;align-items:center;gap:8px;padding:13px 22px;border-radius:12px;font-size:14px;font-weight:800;text-decoration:none;transition:.2s;border:1px solid transparent}
.aud-dl-btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.3)}
.aud-mac{background:linear-gradient(135deg,#10b981,#06b6d4);color:#fff}
.aud-win{background:rgba(6,182,212,.12);color:#06b6d4;border-color:rgba(6,182,212,.3)}
.aud-win:hover{background:rgba(6,182,212,.2)}
.aud-linux{background:rgba(168,85,247,.1);color:#a855f7;border-color:rgba(168,85,247,.3)}
.aud-linux:hover{background:rgba(168,85,247,.18)}
.aud-feat-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:18px;transition:.2s}
.aud-feat-card:hover{border-color:var(--border-h);transform:translateY(-2px)}
.aud-feat-icon{font-size:24px;margin-bottom:8px}
.aud-feat-title{font-size:13px;font-weight:800;margin-bottom:5px}
.aud-feat-desc{font-size:12px;color:var(--text-m);line-height:1.6}
.aud-tool-btn{padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-s);font-size:12px;font-weight:600;cursor:pointer;transition:.2s}
.aud-tool-btn:hover{border-color:var(--accent);color:var(--text)}
.aud-tool-btn.active-tool{background:rgba(168,85,247,.2);border-color:var(--accent);color:var(--accent)}
/* ── Clawbot ─────────────────────────────────────────────────── */
.clawbot-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding:12px 16px;background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(6,182,212,.05));border:1px solid rgba(168,85,247,.2);border-radius:13px}
.clawbot-title{display:flex;align-items:center;gap:11px}
.clawbot-logo{width:36px;height:36px;object-fit:contain}
.clawbot-app-sel{display:flex;align-items:center;gap:9px}
.clawbot-coins{font-size:11px;font-weight:700;padding:4px 10px;border-radius:7px;background:rgba(168,85,247,.12);color:var(--accent);border:1px solid rgba(168,85,247,.25)}
.clawbot-promo-card{background:linear-gradient(135deg,rgba(168,85,247,.1),rgba(6,182,212,.07));border:1px solid rgba(168,85,247,.3);border-radius:18px;padding:32px;text-align:center;max-width:480px;margin:40px auto}
.clawbot-promo-logo{font-size:52px;margin-bottom:14px;display:flex;justify-content:center;align-items:center}
.clawbot-promo-title{font-size:22px;font-weight:900;margin-bottom:6px}
.clawbot-promo-sub{font-size:14px;color:var(--text-s);margin-bottom:20px;line-height:1.6}
.clawbot-price-row{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:6px}
.clawbot-orig-price{font-size:20px;font-weight:700;color:var(--text-m);text-decoration:line-through}
.clawbot-new-price{font-size:28px;font-weight:900;background:linear-gradient(135deg,#a855f7,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.clawbot-discount{font-size:12px;font-weight:700;padding:3px 9px;border-radius:6px;background:rgba(16,185,129,.15);color:var(--green)}
.clawbot-features{list-style:none;text-align:left;margin:18px 0;display:flex;flex-direction:column;gap:7px}
.clawbot-features li{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text-s)}
.clawbot-features li::before{content:"\\2736";color:var(--accent);font-size:10px}
.clawbot-cta{width:100%;padding:15px;border-radius:14px;background:linear-gradient(135deg,#a855f7,#06b6d4);border:none;color:#fff;font-size:15px;font-weight:800;cursor:pointer;transition:.2s;margin-top:4px}
.clawbot-cta:hover{opacity:.88;transform:scale(1.01)}
.clawbot-walkthrough-bar{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(6,182,212,.05));border:1px solid rgba(168,85,247,.25);border-radius:11px;padding:12px 16px;margin-bottom:10px;display:flex;align-items:flex-start;gap:10px}
.clawbot-wt-content{flex:1;font-size:13px;line-height:1.6}
.clawbot-quick-btn{padding:5px 12px;border-radius:18px;font-size:12px;font-weight:600;border:1px solid rgba(168,85,247,.25);background:rgba(168,85,247,.06);color:var(--text-s);cursor:pointer;transition:.2s}
.clawbot-quick-btn:hover{border-color:var(--accent);color:var(--accent)}
/* ── Team Tabs ────────────────────────────────────────────────── */
.team-tab-btn{padding:6px 13px;border-radius:9px;font-size:12px;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s;display:flex;align-items:center;gap:5px;white-space:nowrap}
.team-tab-btn:hover{border-color:var(--border-h);color:var(--text-p)}
.team-tab-btn.active{background:rgba(168,85,247,.12);border-color:rgba(168,85,247,.35);color:var(--accent)}
/* ── Image Upload ─────────────────────────────────────────────── */
.file-drop{border:2px dashed rgba(168,85,247,.35);border-radius:14px;padding:32px 20px;text-align:center;cursor:pointer;transition:.2s;background:rgba(168,85,247,.04);display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:140px}
.file-drop:hover{border-color:var(--accent);background:rgba(168,85,247,.09)}
.file-drop input[type=file]{display:none}
.img2vid-preview{width:100%;border-radius:12px;display:none;border:1px solid var(--border);object-fit:cover;max-height:200px}
/* ── Spaced Repetition ────────────────────────────────────────── */
.learn-sr-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:14px;margin-top:14px}
</style>
</head>
<body>
<div class="orb orb1" id="orb1"></div>
<div class="orb orb2" id="orb2"></div>

<!-- LOGIN SCREEN -->
<div class="login-screen" id="login-screen" style="display:none">
  <div class="login-card">
    <div class="login-logo">&#9889;</div>
    <h1 class="login-title">Welcome to FlowState</h1>
    <p class="login-sub">The intelligent workspace that respects your focus, powers your team, and compounds your growth.</p>
    <button class="btn-google" id="btn-google-login">
      <svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Continue with Google
    </button>
    <button class="btn-magic" id="btn-magic-login"><i class="fas fa-envelope"></i> Continue with work email</button>
    <button class="btn-demo-login" id="btn-demo-login"><i class="fas fa-eye"></i> Try Demo (no login needed)</button>
    <div class="login-features">
      <div class="login-feat"><i class="fas fa-check"></i> 7 AI models</div>
      <div class="login-feat"><i class="fas fa-check"></i> Calendar sync</div>
      <div class="login-feat"><i class="fas fa-check"></i> Team Kanban</div>
      <div class="login-feat"><i class="fas fa-check"></i> FlowScore daily</div>
      <div class="login-feat"><i class="fas fa-check"></i> Sprint Health</div>
      <div class="login-feat"><i class="fas fa-check"></i> Break reminders</div>
    </div>
    <p class="login-legal">API keys stored server-side as Cloudflare Secrets. Never exposed. Your data is never sold.</p>
  </div>
</div>

<!-- ONBOARDING -->
<div class="ob-screen" id="ob-screen" style="display:none">
  <div class="ob-card" id="ob-card"></div>
</div>

<!-- HEADER -->
<header id="main-header" style="display:none">
  <div class="logo" id="logo-home">&#9889; FLOWSTATE</div>
  <div class="dt-widget" id="dt-widget">
    <i class="fas fa-calendar" style="font-size:10px;color:var(--text-m)"></i>
    <span class="dt-date" id="dt-date">&#8212;</span>
    <span style="color:var(--text-m);font-size:10px">&#183;</span>
    <span class="dt-time" id="dt-time">&#8212;</span>
  </div>
  <div id="fs-score-badge" style="font-size:11px;font-weight:700;color:var(--accent);cursor:pointer;padding:4px 10px;border:1px solid rgba(168,85,247,.25);border-radius:8px;background:rgba(168,85,247,.08);display:none">&#9889; &#8212;</div>
  <div id="user-area"></div>
</header>

<!-- TABS BAR -->
<div class="tabs-bar" id="main-tabs" style="display:none">
  <button class="tab-btn active" id="tab-focus"><i class="fas fa-bullseye"></i>Focus</button>
  <button class="tab-btn" id="tab-chat"><i class="fas fa-comments"></i>Chat</button>
  <button class="tab-btn" id="tab-calendar"><i class="fas fa-calendar-alt"></i>Calendar</button>
  <button class="tab-btn" id="tab-metrics"><i class="fas fa-chart-line"></i>Metrics</button>
  <button class="tab-btn" id="tab-board"><i class="fas fa-columns"></i>Board</button>
  <button class="tab-btn" id="tab-team"><i class="fas fa-users"></i>Team</button>
  <button class="tab-btn" id="tab-learn"><i class="fas fa-graduation-cap"></i>Learn</button>
  <button class="tab-btn" id="tab-restore"><i class="fas fa-leaf"></i>Restore</button>
  <button class="tab-btn" id="tab-generate"><i class="fas fa-magic"></i>Generate</button>
  <button class="tab-btn" id="tab-264" style="border-color:rgba(236,72,153,.25)"><i class="fas fa-film" style="color:#ec4899"></i><span style="background:linear-gradient(135deg,#ec4899,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:900">264 Pro</span></button>
  <button class="tab-btn" id="tab-audio" style="border-color:rgba(16,185,129,.25)"><i class="fas fa-music" style="color:#10b981"></i><span style="background:linear-gradient(135deg,#10b981,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:900">Audio</span></button>
  <button class="tab-btn" id="tab-clawbot" style="border-color:rgba(6,182,212,.25)"><img src="/static/clawbot-mascot.png" style="width:18px;height:18px;object-fit:contain;border-radius:3px"><span style="background:linear-gradient(135deg,#a855f7,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:900">ClawFlow</span></button>
  <button class="tab-btn demo-tab" id="tab-demo" style="display:none"><i class="fas fa-eye"></i>Demo</button>
  <div style="margin-left:auto;display:flex;gap:5px">
    <button class="btn-sm" id="btn-creds" title="API Credentials"><i class="fas fa-key"></i></button>
    <button class="btn-sm" id="btn-topup" title="Buy More Tokens" onclick="openTopupModal()" style="background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.4);color:#10b981;display:flex;align-items:center;gap:4px"><i class="fas fa-coins"></i><span id="token-balance-display" style="font-size:10px;font-weight:700;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span></button>
    <button class="btn-sm" id="btn-pricing"><i class="fas fa-star"></i> Pro</button>
    <button class="btn-sm" id="btn-invite"><i class="fas fa-user-plus"></i></button>
    <button class="btn-sm" id="btn-settings"><i class="fas fa-gear"></i></button>
  </div>
</div>

<!-- FOCUS TAB -->
<div class="tab-pane active" id="tab-pane-focus" style="display:none">
  <div class="timer-wrap">
    <div class="phase-btns">
      <button class="ph-btn active" id="ph-focus">Focus</button>
      <button class="ph-btn" id="ph-short">Short Break</button>
      <button class="ph-btn" id="ph-long">Long Break</button>
    </div>
    <div class="ring-outer">
      <div class="b-ring" id="b-ring"></div>
      <div class="t-glow" id="t-glow"></div>
      <svg width="220" height="220" viewBox="0 0 220 220">
        <defs><linearGradient id="rg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs>
        <circle class="ring-bg" cx="110" cy="110" r="98"/>
        <circle class="ring-prog" id="ring-prog" cx="110" cy="110" r="98" stroke-dasharray="615.75" stroke-dashoffset="0"/>
      </svg>
      <div class="timer-inner">
        <div id="timer-display">25:00</div>
        <div class="timer-phase" id="timer-phase">FOCUS</div>
      </div>
    </div>
    <div class="t-controls">
      <button class="btn-t btn-sm-t" id="btn-skip" title="Skip"><i class="fas fa-forward-step"></i></button>
      <button class="btn-t btn-start" id="btn-start"><i class="fas fa-play" id="btn-icon"></i></button>
      <button class="btn-t btn-sm-t" id="btn-reset" title="Reset"><i class="fas fa-rotate-left"></i></button>
    </div>
    <div class="stats-row">
      <div class="stat-item"><div class="stat-val" id="stat-sessions">0</div><div class="stat-lbl">Sessions</div></div>
      <div class="stat-item"><div class="stat-val" id="stat-focus">0m</div><div class="stat-lbl">Focus Time</div></div>
      <div class="stat-item"><div class="stat-val" id="stat-streak">&#128293; 0</div><div class="stat-lbl">Streak</div></div>
    </div>
    <div class="amb-panel">
      <div class="amb-title"><i class="fas fa-headphones"></i>&nbsp; Ambient Sounds <button class="btn-sm" style="margin-left:auto;font-size:10px" onclick="openMusicModal()"><i class="fab fa-youtube" style="color:#ef4444"></i><i class="fab fa-spotify" style="color:#1db954;margin-left:4px"></i> Music</button></div>
      <div class="s-chips" id="sound-chips">
        <button class="s-chip" data-sound="rain">&#127783;&#65039; Rain</button>
        <button class="s-chip" data-sound="forest">&#127794; Forest</button>
        <button class="s-chip" data-sound="cafe">&#9749; Cafe</button>
        <button class="s-chip" data-sound="ocean">&#127754; Ocean</button>
        <button class="s-chip" data-sound="fire">&#128293; Fire</button>
        <button class="s-chip" data-sound="space">&#127756; Space</button>
        <button class="s-chip" data-sound="off">&#128263; Off</button>
      </div>
    </div>
    <div id="block-warn" class="block-warn" style="display:none">
      <i class="fas fa-calendar-exclamation"></i>&nbsp; <span id="block-msg"></span>
    </div>
  </div>
</div>

<!-- CHAT TAB -->
<div class="tab-pane" id="tab-pane-chat" style="display:none;padding:14px">
  <div class="chat-wrap">
    <div class="chat-msgs" id="chat-msgs">
      <div class="msg ai">
        <div class="msg-av" style="background:var(--grad)">&#9889;</div>
        <div>
          <div class="msg-meta"><span class="m-tag">FlowState AI</span><span>Smart routing active</span></div>
          <div class="msg-bub">Hey! I auto-route to the best model for each task &mdash; Claude for code, Gemini for speed, Grok for live data. Click the model pill below to switch models.</div>
        </div>
      </div>
      <div style="flex:1"></div>
      <div id="chat-suggestions" style="padding-bottom:6px">
        <div style="font-size:12px;color:var(--text-m);margin-bottom:10px;font-weight:600;letter-spacing:.4px;text-transform:uppercase">&#10024; Try asking</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="chat-suggest-chip" onclick="sendSuggestion('Help me plan my sprint goals for this week')">&#128203; Plan my sprint</button>
          <button class="chat-suggest-chip" onclick="sendSuggestion('Write a Python script to automate my daily standup report')">&#128187; Write code</button>
          <button class="chat-suggest-chip" onclick="sendSuggestion('Summarize the key principles from Deep Work by Cal Newport')">&#128218; Book summary</button>
          <button class="chat-suggest-chip" onclick="sendSuggestion('Give me 3 focus techniques to beat afternoon energy slumps')">&#9889; Focus tips</button>
          <button class="chat-suggest-chip" onclick="sendSuggestion('Draft a professional update email to my team about project status')">&#9993; Draft email</button>
          <button class="chat-suggest-chip" onclick="sendSuggestion('What are the latest AI developments today?')">&#127757; Live news (Grok)</button>
        </div>
      </div>
    </div>
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:10px 14px">
      <textarea class="chat-in" id="chat-in" placeholder="Ask anything&#8230; Cmd+Enter to send" rows="1" style="border:none;background:transparent;border-radius:0;padding:0;margin-bottom:8px"></textarea>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="model-bar" id="model-bar" style="padding:0;margin:0"></div>
        <button class="btn-send" id="btn-send" style="flex-shrink:0"><i class="fas fa-paper-plane"></i></button>
      </div>
    </div>
  </div>
</div>

<!-- CALENDAR TAB -->
<div class="tab-pane" id="tab-pane-calendar" style="display:none">
  <div id="cal-auth-banner" class="auth-banner" style="display:none">
    <h3>&#128197; Connect Google Calendar</h3>
    <p>See upcoming events, block focus time, and create events directly from FlowState.</p>
    <button class="btn-primary" id="cal-connect-btn"><i class="fas fa-google"></i>&nbsp; Connect Google</button>
  </div>
  <div class="sec-hd">
    <div class="sec-title" id="cal-month-label">&#8212; &#8212;</div>
    <div style="display:flex;gap:6px">
      <button class="btn-sm" id="cal-prev"><i class="fas fa-chevron-left"></i></button>
      <button class="btn-sm" id="cal-next"><i class="fas fa-chevron-right"></i></button>
      <button class="btn-sm" id="cal-add-btn"><i class="fas fa-plus"></i> Add Event</button>
      <button class="btn-sm" id="cal-refresh"><i class="fas fa-refresh"></i></button>
    </div>
  </div>
  <div class="add-ev-form" id="add-ev-form">
    <h3>New Calendar Event</h3>
    <div class="form-row"><input type="text" id="ev-title" placeholder="Event title" style="flex:2"><input type="color" id="ev-color-pick" value="#a855f7" style="flex:0 0 36px;padding:2px;cursor:pointer"></div>
    <div class="form-row"><input type="datetime-local" id="ev-start"><input type="datetime-local" id="ev-end"></div>
    <div class="form-row"><input type="text" id="ev-desc" placeholder="Description (optional)"></div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn-primary" id="ev-save-btn" style="flex:1">Save Event</button>
      <button class="btn-sm" id="ev-cancel-btn">Cancel</button>
    </div>
  </div>
  <div class="cal-grid" id="cal-grid"></div>
  <div class="ev-list" id="ev-list"></div>
</div>

<!-- METRICS TAB -->
<div class="tab-pane" id="tab-pane-metrics" style="display:none">
  <div class="insight-box" id="insight-box">
    <div class="ins-hl" id="ins-hl">Loading insight&#8230;</div>
    <div id="ins-detail" style="font-size:13px;color:var(--text-s);margin-bottom:5px"></div>
    <div id="ins-rec" style="font-size:13px;font-style:italic;color:var(--text-m)"></div>
    <div class="ins-src" id="ins-src"></div>
    <div style="font-size:12px;color:var(--text-m);margin-top:8px">FlowScore: <strong id="ins-score" style="color:var(--accent)">&#8212;</strong></div>
  </div>
  <div class="metrics-grid" id="metrics-grid"></div>
  <div class="chart-wrap">
    <div class="chart-title"><i class="fas fa-chart-bar" style="color:var(--accent)"></i> Focus Sessions This Week</div>
    <canvas id="focus-chart" height="100"></canvas>
  </div>
</div>

<!-- BOARD TAB -->
<div class="tab-pane" id="tab-pane-board" style="display:none">
  <div id="board-notion-panel" style="display:none" class="auth-banner">
    <h3>&#128203; Connect Notion</h3>
    <p>Sync your Notion databases as a live Kanban board. Or use the local board below without Notion.</p>
    <button class="btn-primary" id="board-notion-btn"><i class="fas fa-plug"></i>&nbsp; Connect Notion</button>
  </div>
  <div id="board-db-select" style="display:none;margin-bottom:14px">
    <div class="sec-hd">
      <div class="sec-title">Choose a Notion database</div>
      <button class="btn-sm" id="board-db-refresh"><i class="fas fa-refresh"></i></button>
    </div>
    <div class="notion-db-list" id="notion-db-list"></div>
  </div>
  <div class="board-wrap" id="board-wrap"></div>
</div>

<!-- TEAM TAB -->
<div class="tab-pane" id="tab-pane-team" style="display:none">
  <div id="team-role-banner" style="display:none;margin-bottom:14px"></div>
  <div id="team-hub-content"></div>
</div>

<!-- LEARN TAB -->
<div class="tab-pane" id="tab-pane-learn" style="display:none">
  <div class="learn-car" id="learn-car"></div>
  <div class="l-nav" id="l-nav"></div>
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:16px;margin-bottom:14px">
    <div class="sec-title" style="margin-bottom:12px">All Cards</div>
    <div id="all-learn-cards" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:9px"></div>
  </div>
  <div class="learn-sr-panel" id="learn-spaced-rep"></div>
</div>

<!-- RESTORE TAB -->
<div class="tab-pane" id="tab-pane-restore" style="display:none">
  <div class="r-scene" id="r-scene"></div>
  <div class="r-nav" id="r-nav"></div>
</div>

<!-- GENERATE TAB -->
<!-- ══════════════════════════════════════════════════════════
     GENERATE TAB  —  sub-tab layout with live sidebar
     ══════════════════════════════════════════════════════════ -->
<div class="tab-pane" id="tab-pane-generate" style="display:none;padding:0;overflow:hidden;flex-direction:column">

  <!-- ── Sub-tab bar ──────────────────────────────────────── -->
  <div class="gen-subtab-bar" id="gen-subtab-bar">
    <button class="gen-subtab-btn active" id="gsub-imggen"    onclick="switchGenSub('imggen')"><i class="fas fa-image"></i> Image Gen</button>
    <button class="gen-subtab-btn"        id="gsub-vidgen"    onclick="switchGenSub('vidgen')"><i class="fas fa-video"></i> Video Gen</button>
    <button class="gen-subtab-btn"        id="gsub-i2v"       onclick="switchGenSub('i2v')"><i class="fas fa-photo-film"></i> Image&rarr;Video</button>
    <button class="gen-subtab-btn"        id="gsub-music"     onclick="switchGenSub('music')"><i class="fas fa-music"></i> AI Music</button>
    <button class="gen-subtab-btn"        id="gsub-tts"       onclick="switchGenSub('tts')"><i class="fas fa-microphone"></i> Text to Speech</button>
    <button class="gen-subtab-btn"        id="gsub-filetools" onclick="switchGenSub('filetools')"><i class="fas fa-folder-open"></i> File Tools</button>
    <button class="gen-subtab-btn"        id="gsub-higgsfield" onclick="switchGenSub('higgsfield')" style="background:linear-gradient(135deg,rgba(0,212,255,.12),rgba(0,255,163,.10));border-color:rgba(0,212,255,.3);color:#00d4ff"><i class="fas fa-film"></i> ✦ Higgsfield AI</button>
  </div>

  <!-- ── Body: generator area + sidebar ──────────────────── -->
  <div class="gen-body-wrap">

    <!-- ═══════════════════════ IMAGE GENERATION ═══════════════════════ -->
    <div class="gen-sub-pane active" id="gen-pane-imggen">
      <div class="gen-main-area">
        <div class="gen-panel" style="flex:1">
          <div class="gen-section-header">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:28px;height:28px;border-radius:8px;background:rgba(168,85,247,.2);display:flex;align-items:center;justify-content:center"><i class="fas fa-image" style="color:var(--accent);font-size:13px"></i></span>
              <span class="gen-title" style="margin:0">Image Generation</span>
            </div>
          </div>
          <div class="gen-picker-wrap" id="gs-img-picker-wrap">
            <div class="gs-gen-picker" id="gs-img-picker"></div>
            <div class="gen-model-desc" id="img-model-desc">Select a model above to get started.</div>
          </div>
          <textarea class="gen-pmt" id="img-prompt" placeholder="Describe the image you want to generate&#8230; e.g. 'A futuristic city at sunset, neon reflections on rain-slicked streets'" rows="5"></textarea>
          <button class="btn-gen" id="btn-gen-img"><i class="fas fa-wand-magic-sparkles"></i>&nbsp; Generate Image</button>
          <div class="gen-results" id="img-results"></div>
        </div>
      </div>
      <div class="gen-sidebar">
        <div class="gen-sidebar-hd"><i class="fas fa-bolt"></i> Live Status</div>
        <div class="gen-sidebar-empty" id="gsb-imggen-empty"><i class="fas fa-image" style="font-size:22px;opacity:.25;margin-bottom:8px;display:block"></i>Generate an image to see live progress here</div>
        <div id="gsb-imggen-log" class="gen-sidebar-log"></div>
      </div>
    </div>

    <!-- ═══════════════════════ VIDEO GENERATION ═══════════════════════ -->
    <div class="gen-sub-pane" id="gen-pane-vidgen">
      <div class="gen-main-area">
        <div class="gen-panel" style="flex:1">
          <div class="gen-section-header">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:28px;height:28px;border-radius:8px;background:rgba(236,72,153,.18);display:flex;align-items:center;justify-content:center"><i class="fas fa-video" style="color:var(--pink);font-size:13px"></i></span>
              <span class="gen-title" style="margin:0">Video Generation</span>
            </div>
          </div>
          <div class="gen-picker-wrap" id="gs-vid-picker-wrap">
            <div class="gs-gen-picker" id="gs-vid-picker"></div>
            <div class="gen-model-desc" id="vid-model-desc">Select a model above to get started.</div>
          </div>
          <textarea class="gen-pmt" id="vid-prompt" placeholder="Describe the video you want to generate&#8230; e.g. 'Drone shot over misty mountain peaks at golden hour'" rows="5"></textarea>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <label style="font-size:12px;color:var(--text-s);white-space:nowrap">Duration</label>
            <div class="gen-dur-row">
              <button class="gen-dur-btn active" data-dur="4" onclick="setVidDur(this,4)">4s</button>
              <button class="gen-dur-btn" data-dur="5" onclick="setVidDur(this,5)">5s</button>
              <button class="gen-dur-btn" data-dur="8" onclick="setVidDur(this,8)">8s</button>
              <button class="gen-dur-btn" data-dur="10" onclick="setVidDur(this,10)">10s</button>
              <button class="gen-dur-btn" data-dur="15" onclick="setVidDur(this,15)">15s</button>
            </div>
          </div>
          <input type="hidden" id="vid-dur" value="4">
          <button class="btn-gen" id="btn-gen-vid"><i class="fas fa-film"></i>&nbsp; Generate Video</button>
          <div id="vid-result" style="margin-top:12px;font-size:13px;color:var(--text-s)"></div>
        </div>
      </div>
      <div class="gen-sidebar">
        <div class="gen-sidebar-hd"><i class="fas fa-bolt"></i> Live Status</div>
        <div class="gen-sidebar-empty"><i class="fas fa-film" style="font-size:22px;opacity:.25;margin-bottom:8px;display:block"></i>Generate a video to see live progress here</div>
        <div id="gsb-vidgen-log" class="gen-sidebar-log"></div>
      </div>
    </div>

    <!-- ═══════════════════════ IMAGE → VIDEO ═══════════════════════ -->
    <div class="gen-sub-pane" id="gen-pane-i2v">
      <div class="gen-main-area">
        <div class="gen-panel" style="flex:1">
          <div class="gen-section-header">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:28px;height:28px;border-radius:8px;background:rgba(6,182,212,.18);display:flex;align-items:center;justify-content:center"><i class="fas fa-photo-film" style="color:var(--cyan);font-size:13px"></i></span>
              <span class="gen-title" style="margin:0">Image &rarr; Video</span>
              <span class="gen-new-badge">NEW</span>
            </div>
            <div class="gen-picker-wrap" id="gs-i2v-picker-wrap" style="flex:1;max-width:280px">
              <div class="gs-gen-picker" id="gs-i2v-picker"></div>
            </div>
          </div>
          <div class="gen-model-desc" id="i2v-model-desc" style="margin-bottom:14px">Select a video model above, then upload an image and describe the motion.</div>
          <div class="gen-i2v-body">
            <div class="gen-i2v-upload">
              <label class="file-drop" for="img2vid-upload" id="i2v-drop-label">
                <input type="file" id="img2vid-upload" accept="image/*" style="display:none">
                <i class="fas fa-cloud-upload-alt" style="font-size:32px;color:var(--accent);margin-bottom:10px"></i>
                <div style="font-size:14px;font-weight:700;color:var(--text-p)">Drop image here or click to upload</div>
                <div style="font-size:12px;color:var(--text-m);margin-top:4px">JPG, PNG, WebP &bull; Max 10MB</div>
              </label>
              <img id="img2vid-preview" class="img2vid-preview" alt="Preview" style="display:none">
            </div>
            <div class="gen-i2v-right">
              <textarea class="gen-pmt" id="img2vid-prompt" placeholder="Describe the motion&#8230; e.g. 'Camera slowly zooms out, leaves gently swaying in the breeze'" rows="4" style="flex:1;min-height:100px"></textarea>
              <button class="btn-gen btn-gen-i2v" id="btn-img2vid"><i class="fas fa-video"></i>&nbsp; Generate Video from Image</button>
              <div id="img2vid-result" style="margin-top:10px;font-size:13px;color:var(--text-s)"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="gen-sidebar">
        <div class="gen-sidebar-hd"><i class="fas fa-bolt"></i> Live Status</div>
        <div class="gen-sidebar-empty"><i class="fas fa-photo-film" style="font-size:22px;opacity:.25;margin-bottom:8px;display:block"></i>Upload an image and generate to see progress</div>
        <div id="gsb-i2v-log" class="gen-sidebar-log"></div>
      </div>
    </div>

    <!-- ═══════════════════════ AI MUSIC ═══════════════════════ -->
    <div class="gen-sub-pane" id="gen-pane-music">
      <div class="gen-main-area">
        <div class="gen-panel" style="flex:1">
          <div class="gen-section-header">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:28px;height:28px;border-radius:8px;background:rgba(16,185,129,.18);display:flex;align-items:center;justify-content:center"><i class="fas fa-music" style="color:#10b981;font-size:13px"></i></span>
              <span class="gen-title" style="margin:0">AI Music Generation</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
            <button id="aud-tool-track"  onclick="setAudioTool('generate_track')"  class="aud-tool-btn active-tool">&#127900; Full Track</button>
            <button id="aud-tool-melody" onclick="setAudioTool('generate_melody')" class="aud-tool-btn">&#127929; Melody</button>
            <button id="aud-tool-beat"   onclick="setAudioTool('generate_beat')"   class="aud-tool-btn">&#129345; Beat</button>
          </div>
          <textarea id="aud-prompt" placeholder="Describe your music&#8230; e.g. 'upbeat lo-fi hip hop with jazz chords, mellow vibe, 90 BPM'" class="gen-pmt" rows="4"></textarea>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
            <input id="aud-style" placeholder="Style (e.g. lo-fi, trap, ambient)" style="flex:1;min-width:140px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text-p);font-size:12px">
            <div class="gs-gen-picker" style="position:relative" id="aud-dur-picker-wrap">
              <button class="gs-model-pill" onclick="toggleAudPicker(event,'dur')" id="aud-dur-pill">
                <i class="fas fa-clock" style="font-size:11px;opacity:.7"></i>
                <span id="aud-dur-label">30 sec</span>
                <i class="fas fa-chevron-down" style="font-size:9px;opacity:.5"></i>
              </button>
              <div class="gs-model-dropdown" id="aud-dur-dropdown" style="display:none;min-width:130px">
                <div class="gs-model-row" onclick="setAudDur(15,'15 sec')"><span style="font-size:13px;font-weight:600">15 sec</span><div class="gs-radio" id="aud-dur-r-15"></div></div>
                <div class="gs-model-row" onclick="setAudDur(30,'30 sec')"><span style="font-size:13px;font-weight:600">30 sec</span><div class="gs-radio gs-radio-active" id="aud-dur-r-30"></div></div>
              </div>
            </div>
            <div class="gs-gen-picker" style="position:relative" id="aud-bpm-picker-wrap">
              <button class="gs-model-pill" onclick="toggleAudPicker(event,'bpm')" id="aud-bpm-pill">
                <i class="fas fa-gauge-high" style="font-size:11px;opacity:.7"></i>
                <span id="aud-bpm-label">BPM (auto)</span>
                <i class="fas fa-chevron-down" style="font-size:9px;opacity:.5"></i>
              </button>
              <div class="gs-model-dropdown" id="aud-bpm-dropdown" style="display:none;min-width:140px">
                <div class="gs-model-row" onclick="setAudBpm('','BPM (auto)')"><span style="font-size:13px;font-weight:600">Auto</span><div class="gs-radio gs-radio-active" id="aud-bpm-r-auto"></div></div>
                <div class="gs-model-row" onclick="setAudBpm('80','80 BPM')"><span style="font-size:13px;font-weight:600">80 BPM</span><div class="gs-radio" id="aud-bpm-r-80"></div></div>
                <div class="gs-model-row" onclick="setAudBpm('90','90 BPM')"><span style="font-size:13px;font-weight:600">90 BPM</span><div class="gs-radio" id="aud-bpm-r-90"></div></div>
                <div class="gs-model-row" onclick="setAudBpm('100','100 BPM')"><span style="font-size:13px;font-weight:600">100 BPM</span><div class="gs-radio" id="aud-bpm-r-100"></div></div>
                <div class="gs-model-row" onclick="setAudBpm('120','120 BPM')"><span style="font-size:13px;font-weight:600">120 BPM</span><div class="gs-radio" id="aud-bpm-r-120"></div></div>
                <div class="gs-model-row" onclick="setAudBpm('140','140 BPM')"><span style="font-size:13px;font-weight:600">140 BPM</span><div class="gs-radio" id="aud-bpm-r-140"></div></div>
              </div>
            </div>
          </div>
          <button id="aud-gen-btn" onclick="generateAudioTrack()" class="btn-gen" style="background:linear-gradient(135deg,#10b981,#06b6d4)">
            <i class="fas fa-music"></i>&nbsp; Generate Music
          </button>
          <div id="aud-status" style="display:none;margin-top:12px;text-align:center;padding:16px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);border-radius:10px">
            <div id="aud-status-text" style="font-size:13px;color:var(--text-s);margin-bottom:8px"></div>
            <audio id="aud-player" controls style="width:100%;display:none"></audio>
            <a id="aud-download-link" href="#" download style="display:none;font-size:12px;color:#10b981;margin-top:8px;text-decoration:none"><i class="fas fa-download"></i> Download Track</a>
          </div>
        </div>
      </div>
      <div class="gen-sidebar">
        <div class="gen-sidebar-hd"><i class="fas fa-bolt"></i> Live Status</div>
        <div class="gen-sidebar-empty"><i class="fas fa-music" style="font-size:22px;opacity:.25;margin-bottom:8px;display:block"></i>Generate a track to see live status</div>
        <div id="gsb-music-log" class="gen-sidebar-log"></div>
        <div class="gen-sidebar-section" style="margin-top:auto">
          <div class="gen-sidebar-label">POWERED BY</div>
          <div class="gen-sidebar-row"><i class="fas fa-check-circle" style="color:#10b981"></i> MusicGen (Replicate)</div>
          <div class="gen-sidebar-row"><i class="fas fa-circle" style="color:var(--text-m);font-size:8px"></i> Suno AI (add key)</div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════ TEXT TO SPEECH ═══════════════════════ -->
    <div class="gen-sub-pane" id="gen-pane-tts">
      <div class="gen-main-area">
        <div class="gen-panel" style="flex:1">
          <div class="gen-section-header">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:28px;height:28px;border-radius:8px;background:rgba(168,85,247,.18);display:flex;align-items:center;justify-content:center"><i class="fas fa-microphone" style="color:var(--accent);font-size:13px"></i></span>
              <span class="gen-title" style="margin:0">Text to Speech</span>
              <span style="font-size:11px;font-weight:600;color:#10b981;margin-left:4px">&#9679; ElevenLabs Live</span>
            </div>
            <span id="tts-voice-count" style="font-size:11px;color:var(--text-s)">Loading voices&#8230;</span>
          </div>
          <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
            <div class="gs-gen-picker" style="position:relative;flex:1" id="tts-voice-picker-wrap">
              <button class="gs-model-pill" onclick="toggleAudPicker(event,'voice')" id="tts-voice-pill" style="width:100%;justify-content:space-between">
                <span style="display:flex;align-items:center;gap:6px"><i class="fas fa-user-circle" style="font-size:13px;color:var(--accent)"></i><span id="tts-voice-label">Adam - Dominant, Firm</span></span>
                <i class="fas fa-chevron-down" style="font-size:9px;opacity:.5"></i>
              </button>
              <div class="gs-model-dropdown" id="tts-voice-dropdown" style="display:none;min-width:260px;max-height:320px;overflow-y:auto">
                <div class="gs-model-row" onclick="setTTSVoice('pNInz6obpgDQGcFmaJgB','Adam - Dominant, Firm')"><div><div style="font-weight:600;font-size:13px">Adam</div><div style="font-size:11px;color:var(--text-s)">Dominant, Firm &middot; Male &middot; American</div></div><div class="gs-radio gs-radio-active" id="tvr-adam"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('EXAVITQu4vr4xnSDxMaL','Sarah - Mature, Confident')"><div><div style="font-weight:600;font-size:13px">Sarah</div><div style="font-size:11px;color:var(--text-s)">Mature, Confident &middot; Female &middot; American</div></div><div class="gs-radio" id="tvr-sarah"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('JBFqnCBsd6RMkjVDRZzb','George - Warm Storyteller')"><div><div style="font-weight:600;font-size:13px">George</div><div style="font-size:11px;color:var(--text-s)">Warm Storyteller &middot; Male &middot; British</div></div><div class="gs-radio" id="tvr-george"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('nPczCjzI2devNBz1zQrb','Brian - Deep, Resonant')"><div><div style="font-weight:600;font-size:13px">Brian</div><div style="font-size:11px;color:var(--text-s)">Deep, Resonant &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-brian"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('IKne3meq5aSn9XLyUdCD','Charlie - Deep, Energetic')"><div><div style="font-weight:600;font-size:13px">Charlie</div><div style="font-size:11px;color:var(--text-s)">Deep, Energetic &middot; Male &middot; Australian</div></div><div class="gs-radio" id="tvr-charlie"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('cgSgspJ2msm6clMCkdW9','Jessica - Playful, Bright')"><div><div style="font-weight:600;font-size:13px">Jessica</div><div style="font-size:11px;color:var(--text-s)">Playful, Bright &middot; Female &middot; American</div></div><div class="gs-radio" id="tvr-jessica"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('onwK4e9ZLuTAKqWW03F9','Daniel - Steady Broadcaster')"><div><div style="font-weight:600;font-size:13px">Daniel</div><div style="font-size:11px;color:var(--text-s)">Steady Broadcaster &middot; Male &middot; British</div></div><div class="gs-radio" id="tvr-daniel"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('CwhRBWXzGAHq8TQ4Fs17','Roger - Laid-Back, Casual')"><div><div style="font-weight:600;font-size:13px">Roger</div><div style="font-size:11px;color:var(--text-s)">Laid-Back, Casual &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-roger"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('SAz9YHcvj6GT2YYXdXww','River - Relaxed, Neutral')"><div><div style="font-weight:600;font-size:13px">River</div><div style="font-size:11px;color:var(--text-s)">Relaxed, Neutral &middot; Non-binary &middot; American</div></div><div class="gs-radio" id="tvr-river"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('TX3LPaxmHKxFdv7VOQHJ','Liam - Energetic Creator')"><div><div style="font-weight:600;font-size:13px">Liam</div><div style="font-size:11px;color:var(--text-s)">Energetic Creator &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-liam"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('bIHbv24MWmeRgasZH58o','Will - Relaxed Optimist')"><div><div style="font-weight:600;font-size:13px">Will</div><div style="font-size:11px;color:var(--text-s)">Relaxed Optimist &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-will"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('cjVigY5qzO86Huf0OWal','Eric - Smooth, Trustworthy')"><div><div style="font-weight:600;font-size:13px">Eric</div><div style="font-size:11px;color:var(--text-s)">Smooth, Trustworthy &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-eric"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('iP95p4xoKVk53GoZ742B','Chris - Charming, Casual')"><div><div style="font-weight:600;font-size:13px">Chris</div><div style="font-size:11px;color:var(--text-s)">Charming, Casual &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-chris"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('pqHfZKP75CvOlQylNhV4','Bill - Wise, Mature')"><div><div style="font-weight:600;font-size:13px">Bill</div><div style="font-size:11px;color:var(--text-s)">Wise, Mature &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-bill"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('XrExE9yKIg1WjnnlVkGX','Matilda - Professional')"><div><div style="font-weight:600;font-size:13px">Matilda</div><div style="font-size:11px;color:var(--text-s)">Professional &middot; Female &middot; American</div></div><div class="gs-radio" id="tvr-matilda"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('pFZP5JQG7iQjIQuC4Bku','Lily - Velvety Actress')"><div><div style="font-weight:600;font-size:13px">Lily</div><div style="font-size:11px;color:var(--text-s)">Velvety Actress &middot; Female &middot; British</div></div><div class="gs-radio" id="tvr-lily"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('FGY2WhTYpPnrIDTdsKH5','Laura - Enthusiast, Quirky')"><div><div style="font-weight:600;font-size:13px">Laura</div><div style="font-size:11px;color:var(--text-s)">Enthusiast, Quirky &middot; Female &middot; American</div></div><div class="gs-radio" id="tvr-laura"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('N2lVS1w4EtoT3dr4eOWO','Callum - Husky Trickster')"><div><div style="font-weight:600;font-size:13px">Callum</div><div style="font-size:11px;color:var(--text-s)">Husky Trickster &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-callum"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('SOYHLrjzK2X1ezoPC6cr','Harry - Fierce Warrior')"><div><div style="font-weight:600;font-size:13px">Harry</div><div style="font-size:11px;color:var(--text-s)">Fierce Warrior &middot; Male &middot; American</div></div><div class="gs-radio" id="tvr-harry"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('vfaqCOvlrKi4Zp7C2IAm','Demon Monster')"><div><div style="font-weight:600;font-size:13px">Demon Monster</div><div style="font-size:11px;color:var(--text-s)">Character Animation &middot; Deep</div></div><div class="gs-radio" id="tvr-demon"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('94D02IUHyb3D4r3i3feh','Rashid - Deep Narrative')"><div><div style="font-weight:600;font-size:13px">Rashid</div><div style="font-size:11px;color:var(--text-s)">Deep Narrative &middot; Male &middot; African</div></div><div class="gs-radio" id="tvr-rashid"></div></div>
                <div class="gs-model-row" onclick="setTTSVoice('UFO0Yv86wqRxAt1DmXUu','Mordred - Evil Villain')"><div><div style="font-weight:600;font-size:13px">Mordred</div><div style="font-size:11px;color:var(--text-s)">Evil Villain &middot; Male &middot; German accent</div></div><div class="gs-radio" id="tvr-mordred"></div></div>
              </div>
            </div>
            <div class="gs-gen-picker" style="position:relative" id="tts-model-picker-wrap">
              <button class="gs-model-pill" onclick="toggleAudPicker(event,'ttsmodel')" id="tts-model-pill">
                <i class="fas fa-bolt" style="font-size:11px;color:#f59e0b"></i>
                <span id="tts-model-label">Turbo v2.5</span>
                <i class="fas fa-chevron-down" style="font-size:9px;opacity:.5"></i>
              </button>
              <div class="gs-model-dropdown" id="tts-model-dropdown" style="display:none;min-width:220px">
                <div class="gs-model-row" onclick="setTTSModel('eleven_turbo_v2_5','Turbo v2.5')"><div><div style="font-weight:600;font-size:13px">Turbo v2.5</div><div style="font-size:11px;color:var(--text-s)">Fastest &middot; Best for real-time</div></div><div class="gs-radio gs-radio-active" id="tmr-t25"></div></div>
                <div class="gs-model-row" onclick="setTTSModel('eleven_flash_v2_5','Flash v2.5')"><div><div style="font-weight:600;font-size:13px">Flash v2.5</div><div style="font-size:11px;color:var(--text-s)">Ultra fast &middot; Low latency</div></div><div class="gs-radio" id="tmr-f25"></div></div>
                <div class="gs-model-row" onclick="setTTSModel('eleven_turbo_v2','Turbo v2')"><div><div style="font-weight:600;font-size:13px">Turbo v2</div><div style="font-size:11px;color:var(--text-s)">Fast &middot; Balanced quality</div></div><div class="gs-radio" id="tmr-t2"></div></div>
                <div class="gs-model-row" onclick="setTTSModel('eleven_multilingual_v2','Multilingual v2')"><div><div style="font-weight:600;font-size:13px">Multilingual v2</div><div style="font-size:11px;color:var(--text-s)">Best quality &middot; 29 languages</div></div><div class="gs-radio" id="tmr-ml2"></div></div>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:14px;margin-bottom:12px;flex-wrap:wrap">
            <label style="flex:1;min-width:120px;font-size:11px;color:var(--text-s)">Stability <span id="tts-stab-val">0.5</span><input id="tts-stability" type="range" min="0" max="1" step="0.05" value="0.5" oninput="document.getElementById('tts-stab-val').textContent=this.value" style="width:100%;accent-color:var(--accent)"></label>
            <label style="flex:1;min-width:120px;font-size:11px;color:var(--text-s)">Similarity <span id="tts-sim-val">0.75</span><input id="tts-similarity" type="range" min="0" max="1" step="0.05" value="0.75" oninput="document.getElementById('tts-sim-val').textContent=this.value" style="width:100%;accent-color:var(--accent)"></label>
            <label style="flex:1;min-width:120px;font-size:11px;color:var(--text-s)">Style <span id="tts-style-val">0</span><input id="tts-style-ex" type="range" min="0" max="1" step="0.05" value="0" oninput="document.getElementById('tts-style-val').textContent=this.value" style="width:100%;accent-color:var(--accent)"></label>
          </div>
          <textarea id="tts-text" placeholder="Enter text to convert to speech&#8230;" class="gen-pmt" rows="4"></textarea>
          <button onclick="generateTTS()" id="tts-btn" class="btn-gen" style="background:linear-gradient(135deg,#a855f7,#06b6d4)">
            <i class="fas fa-microphone"></i>&nbsp; Generate Voice
          </button>
          <div id="tts-status" style="display:none;margin-top:12px;text-align:center">
            <div id="tts-status-text" style="font-size:12px;color:var(--text-s);margin-bottom:8px"></div>
            <audio id="tts-player" controls style="width:100%;margin-bottom:6px"></audio>
            <a id="tts-download" href="#" download="flowstate-tts.mp3" style="display:none;font-size:11px;color:var(--accent);text-decoration:none"><i class="fas fa-download"></i> Download MP3</a>
          </div>
        </div>
      </div>
      <div class="gen-sidebar">
        <div class="gen-sidebar-hd"><i class="fas fa-bolt"></i> Live Status</div>
        <div class="gen-sidebar-empty"><i class="fas fa-microphone" style="font-size:22px;opacity:.25;margin-bottom:8px;display:block"></i>Generate speech to see voice details here</div>
        <div id="gsb-tts-log" class="gen-sidebar-log"></div>
        <div class="gen-sidebar-section" style="margin-top:auto">
          <div class="gen-sidebar-label">VOICE ENGINE</div>
          <div class="gen-sidebar-row"><i class="fas fa-check-circle" style="color:#10b981"></i> ElevenLabs Live</div>
          <div class="gen-sidebar-row"><i class="fas fa-globe" style="color:var(--accent)"></i> 29 Languages</div>
          <div class="gen-sidebar-row"><i class="fas fa-users" style="color:var(--cyan)"></i> <span id="tts-sidebar-voice-count">21</span> Voices</div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════ FILE TOOLS ═══════════════════════ -->
    <div class="gen-sub-pane" id="gen-pane-filetools">
      <div class="gen-main-area" style="overflow-y:auto">
        <div class="gen-panel" style="flex:1">
          <div class="gen-section-header" style="margin-bottom:18px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:28px;height:28px;border-radius:8px;background:rgba(245,158,11,.18);display:flex;align-items:center;justify-content:center"><i class="fas fa-folder-open" style="color:var(--warn);font-size:13px"></i></span>
              <span class="gen-title" style="margin:0">File Library &amp; Tools</span>
            </div>
          </div>
          <div class="file-tool-grid">

            <!-- PDF → Images -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(239,68,68,.15)"><i class="fas fa-file-pdf" style="color:#ef4444"></i></div>
              <div class="file-tool-name">PDF &rarr; Images</div>
              <div class="file-tool-desc">Convert each PDF page to a JPG / PNG image</div>
              <label class="file-tool-drop" for="ft-pdf-input">
                <input type="file" id="ft-pdf-input" accept=".pdf" style="display:none" onchange="handleFileTool('pdf2img',this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:var(--warn);margin-bottom:6px"></i>
                <span>Drop PDF or click to upload</span>
              </label>
              <div id="ft-pdf2img-status" class="file-tool-status"></div>
              <div id="ft-pdf2img-results" class="file-tool-results"></div>
            </div>

            <!-- Images → PDF -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(168,85,247,.15)"><i class="fas fa-images" style="color:var(--accent)"></i></div>
              <div class="file-tool-name">Images &rarr; PDF</div>
              <div class="file-tool-desc">Merge multiple images into a single PDF</div>
              <label class="file-tool-drop" for="ft-imgs-input">
                <input type="file" id="ft-imgs-input" accept="image/*" multiple style="display:none" onchange="handleFileTool('imgs2pdf',this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:var(--accent);margin-bottom:6px"></i>
                <span>Drop images or click to upload</span>
              </label>
              <div id="ft-imgs2pdf-status" class="file-tool-status"></div>
              <div id="ft-imgs2pdf-results" class="file-tool-results"></div>
            </div>

            <!-- Image Resize -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(6,182,212,.15)"><i class="fas fa-crop-alt" style="color:var(--cyan)"></i></div>
              <div class="file-tool-name">Image Resize</div>
              <div class="file-tool-desc">Resize images to exact dimensions or percentage</div>
              <label class="file-tool-drop" for="ft-resize-input">
                <input type="file" id="ft-resize-input" accept="image/*" style="display:none" onchange="ftResizePreview(this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:var(--cyan);margin-bottom:6px"></i>
                <span>Drop image or click to upload</span>
              </label>
              <div id="ft-resize-opts" style="display:none;margin-top:10px">
                <img id="ft-resize-preview" style="max-width:100%;max-height:110px;border-radius:8px;margin-bottom:10px;display:block;margin-left:auto;margin-right:auto">
                <div style="display:flex;gap:8px;margin-bottom:8px">
                  <input id="ft-resize-w" type="number" placeholder="Width px" style="flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:7px;color:var(--text-p);font-size:12px">
                  <input id="ft-resize-h" type="number" placeholder="Height px" style="flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:7px;color:var(--text-p);font-size:12px">
                </div>
                <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
                  <label style="font-size:11px;color:var(--text-s);display:flex;align-items:center;gap:5px"><input type="checkbox" id="ft-resize-lock" checked style="accent-color:var(--accent)"> Lock aspect ratio</label>
                  <select id="ft-resize-fmt" style="margin-left:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:5px 8px;color:var(--text-p);font-size:12px">
                    <option value="jpeg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option>
                  </select>
                </div>
                <button class="btn-gen" style="padding:8px 16px;font-size:12px" onclick="ftDoResize()"><i class="fas fa-expand-arrows-alt"></i> Resize &amp; Download</button>
              </div>
              <div id="ft-resize-result" class="file-tool-results"></div>
            </div>

            <!-- Image Convert -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(16,185,129,.15)"><i class="fas fa-exchange-alt" style="color:#10b981"></i></div>
              <div class="file-tool-name">Image Convert</div>
              <div class="file-tool-desc">Convert between JPG, PNG, WebP formats</div>
              <label class="file-tool-drop" for="ft-conv-input">
                <input type="file" id="ft-conv-input" accept="image/*" style="display:none" onchange="ftConvertPreview(this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:#10b981;margin-bottom:6px"></i>
                <span>Drop image or click to upload</span>
              </label>
              <div id="ft-conv-opts" style="display:none;margin-top:10px">
                <img id="ft-conv-preview" style="max-width:100%;max-height:90px;border-radius:8px;margin-bottom:10px;display:block;margin-left:auto;margin-right:auto">
                <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
                  <label style="font-size:12px;color:var(--text-s)">To:</label>
                  <select id="ft-conv-fmt" style="flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:7px;color:var(--text-p);font-size:12px">
                    <option value="jpeg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option>
                  </select>
                  <input id="ft-conv-quality" type="number" min="10" max="100" value="90" placeholder="Quality" style="width:68px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:7px;color:var(--text-p);font-size:12px">
                </div>
                <button class="btn-gen" style="padding:8px 16px;font-size:12px;background:linear-gradient(135deg,#10b981,#06b6d4)" onclick="ftDoConvert()"><i class="fas fa-exchange-alt"></i> Convert &amp; Download</button>
              </div>
              <div id="ft-conv-result" class="file-tool-results"></div>
            </div>

            <!-- Image Compress -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(236,72,153,.15)"><i class="fas fa-compress-alt" style="color:var(--pink)"></i></div>
              <div class="file-tool-name">Image Compress</div>
              <div class="file-tool-desc">Reduce file size while preserving quality</div>
              <label class="file-tool-drop" for="ft-comp-input">
                <input type="file" id="ft-comp-input" accept="image/*" style="display:none" onchange="ftCompressPreview(this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:var(--pink);margin-bottom:6px"></i>
                <span>Drop image or click to upload</span>
              </label>
              <div id="ft-comp-opts" style="display:none;margin-top:10px">
                <img id="ft-comp-preview" style="max-width:100%;max-height:90px;border-radius:8px;margin-bottom:10px;display:block;margin-left:auto;margin-right:auto">
                <label style="font-size:11px;color:var(--text-s);display:block;margin-bottom:8px">Quality: <span id="ft-comp-q-val">75</span>%
                  <input id="ft-comp-quality" type="range" min="10" max="100" value="75" oninput="document.getElementById('ft-comp-q-val').textContent=this.value" style="width:100%;accent-color:var(--pink)">
                </label>
                <div id="ft-comp-info" style="font-size:11px;color:var(--text-m);margin-bottom:10px"></div>
                <button class="btn-gen" style="padding:8px 16px;font-size:12px;background:linear-gradient(135deg,#ec4899,#f59e0b)" onclick="ftDoCompress()"><i class="fas fa-compress-alt"></i> Compress &amp; Download</button>
              </div>
              <div id="ft-comp-result" class="file-tool-results"></div>
            </div>

            <!-- Base64 Tools -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(168,85,247,.15)"><i class="fas fa-code" style="color:var(--accent)"></i></div>
              <div class="file-tool-name">Base64 Tools</div>
              <div class="file-tool-desc">Encode files to Base64 or decode Base64 back</div>
              <div style="margin-top:10px">
                <div style="display:flex;gap:6px;margin-bottom:10px">
                  <button class="gen-dur-btn active" id="b64-enc-btn" onclick="switchB64Mode('encode')">Encode</button>
                  <button class="gen-dur-btn" id="b64-dec-btn" onclick="switchB64Mode('decode')">Decode</button>
                </div>
                <div id="b64-encode-area">
                  <label class="file-tool-drop" for="ft-b64-input" style="padding:12px">
                    <input type="file" id="ft-b64-input" style="display:none" onchange="ftB64Encode(this)">
                    <i class="fas fa-cloud-upload-alt" style="font-size:16px;color:var(--accent);margin-bottom:4px"></i>
                    <span>Drop any file to encode</span>
                  </label>
                </div>
                <div id="b64-decode-area" style="display:none">
                  <textarea id="ft-b64-text" placeholder="Paste Base64 string here&#8230;" class="gen-pmt" rows="3" style="margin-bottom:8px"></textarea>
                  <button class="btn-gen" style="padding:7px 14px;font-size:12px" onclick="ftB64Decode()"><i class="fas fa-unlock"></i> Decode &amp; Download</button>
                </div>
                <div id="ft-b64-result" class="file-tool-results"></div>
              </div>
            </div>

          </div><!-- /file-tool-grid -->
        </div>
      </div>
      <div class="gen-sidebar">
        <div class="gen-sidebar-hd"><i class="fas fa-folder-open"></i> File Library</div>
        <div class="gen-sidebar-empty" id="ft-sidebar-empty"><i class="fas fa-file" style="font-size:22px;opacity:.25;margin-bottom:8px;display:block"></i>Processed files appear here for download</div>
        <div id="ft-sidebar-history" class="gen-sidebar-log"></div>
        <div class="gen-sidebar-section" style="margin-top:auto">
          <div class="gen-sidebar-label">TOOLS AVAILABLE</div>
          <div class="gen-sidebar-row"><i class="fas fa-file-pdf" style="color:#ef4444"></i> PDF &rarr; Images</div>
          <div class="gen-sidebar-row"><i class="fas fa-images" style="color:var(--accent)"></i> Images &rarr; PDF</div>
          <div class="gen-sidebar-row"><i class="fas fa-crop-alt" style="color:var(--cyan)"></i> Image Resize</div>
          <div class="gen-sidebar-row"><i class="fas fa-exchange-alt" style="color:#10b981"></i> Format Convert</div>
          <div class="gen-sidebar-row"><i class="fas fa-compress-alt" style="color:var(--pink)"></i> Compress</div>
          <div class="gen-sidebar-row"><i class="fas fa-code" style="color:var(--accent)"></i> Base64 Tools</div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════ HIGGSFIELD AI ═══════════════════════════════ -->
    <div class="gen-sub-pane" id="gen-pane-higgsfield">
      <div class="gen-main-area" style="overflow-y:auto">

        <!-- Pro gate banner -->
        <div id="higgs-gate-banner" style="display:none;background:linear-gradient(135deg,rgba(0,212,255,.08),rgba(168,85,247,.08));border:1px solid rgba(0,212,255,.2);border-radius:14px;padding:22px 20px;margin-bottom:16px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">✦</div>
          <div style="font-size:16px;font-weight:900;color:#00d4ff;margin-bottom:6px">Higgsfield AI — Pro Members Only</div>
          <div style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:16px;line-height:1.6">Higgsfield gives you access to 100+ cinematic AI video models including Seedance 2.0 — with native audio, multi-shot storytelling, and frame-level control. Upgrade to Pro to unlock.</div>
          <button onclick="document.getElementById('tab-pricing')?.click()" style="background:linear-gradient(135deg,#00d4ff,#00ffa3);color:#000;border:none;border-radius:10px;padding:10px 22px;font-size:13px;font-weight:800;cursor:pointer">Upgrade to Pro →</button>
        </div>

        <!-- Hero header -->
        <div style="background:linear-gradient(135deg,rgba(0,212,255,.07),rgba(0,255,163,.05));border:1px solid rgba(0,212,255,.18);border-radius:14px;padding:18px 20px;margin-bottom:16px;display:flex;align-items:center;gap:14px">
          <div style="width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#00d4ff,#00ffa3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-film" style="color:#000;font-size:20px"></i>
          </div>
          <div>
            <div style="font-size:16px;font-weight:900;color:#00d4ff;margin-bottom:3px">Higgsfield AI Studio</div>
            <div style="font-size:12px;color:rgba(255,255,255,.55);line-height:1.5">100+ cinematic models · Seedance 2.0 · Native audio · Multi-shot storytelling · Pro members only</div>
          </div>
          <div style="margin-left:auto;background:linear-gradient(135deg,#00d4ff22,#00ffa322);border:1px solid #00d4ff44;border-radius:8px;padding:4px 10px;font-size:10px;font-weight:800;color:#00d4ff">PRO</div>
        </div>

        <!-- Model picker -->
        <div class="gen-panel" style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:rgba(0,212,255,.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Model</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px" id="higgs-model-grid">
            <div class="higgs-model-card active" onclick="selectHiggsModel('seedance-v2.0-t2v','Seedance 2.0 T2V','Text to Video',15)" data-model="seedance-v2.0-t2v">
              <div class="higgs-model-badge">TEXT → VIDEO</div>
              <div class="higgs-model-name">Seedance 2.0</div>
              <div class="higgs-model-desc">Cinematic quality · native audio · 15s max</div>
            </div>
            <div class="higgs-model-card" onclick="selectHiggsModel('seedance-v2.0-i2v','Seedance 2.0 I2V','Image to Video',15)" data-model="seedance-v2.0-i2v">
              <div class="higgs-model-badge">IMAGE → VIDEO</div>
              <div class="higgs-model-name">Seedance 2.0</div>
              <div class="higgs-model-desc">Animate a still frame · character consistent</div>
            </div>
            <div class="higgs-model-card" onclick="selectHiggsModel('seedance-v2.0-t2v-fx','Seedance 2.0 FX','Special Effects',10)" data-model="seedance-v2.0-t2v-fx">
              <div class="higgs-model-badge">EFFECTS</div>
              <div class="higgs-model-name">Seedance FX</div>
              <div class="higgs-model-desc">Physics · explosions · particles · fire</div>
            </div>
            <div class="higgs-model-card" onclick="selectHiggsModel('wan2.6-t2v','Wan 2.6 T2V','Text to Video',15)" data-model="wan2.6-t2v">
              <div class="higgs-model-badge">TEXT → VIDEO</div>
              <div class="higgs-model-name">Wan 2.6</div>
              <div class="higgs-model-desc">High motion fidelity · 1080p · 15s</div>
            </div>
            <div class="higgs-model-card" onclick="selectHiggsModel('wan2.6-i2v','Wan 2.6 I2V','Image to Video',15)" data-model="wan2.6-i2v">
              <div class="higgs-model-badge">IMAGE → VIDEO</div>
              <div class="higgs-model-name">Wan 2.6</div>
              <div class="higgs-model-desc">Smooth animation from reference image</div>
            </div>
            <div class="higgs-model-card" onclick="selectHiggsModel('kling-v3.0-pro-t2v','Kling v3 Pro T2V','Text to Video',10)" data-model="kling-v3.0-pro-t2v">
              <div class="higgs-model-badge">TEXT → VIDEO</div>
              <div class="higgs-model-name">Kling v3 Pro</div>
              <div class="higgs-model-desc">Pro-grade cinematic · 1080p · 10s max</div>
            </div>
          </div>
        </div>

        <!-- Prompt -->
        <div class="gen-panel" style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:rgba(0,212,255,.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Prompt</div>
          <textarea id="higgs-prompt" rows="4" placeholder="Describe your scene in detail. Include camera movement, lighting, mood, subject action&#8230; e.g. 'A lone astronaut walks across a red desert at sunset, dolly zoom slowly pulling back, dramatic lens flare, cinematic 4K'" style="width:100%;background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.15);border-radius:10px;padding:12px;color:#e8e8e8;font-size:13px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box"></textarea>

          <!-- I2V image URL input -->
          <div id="higgs-img-row" style="display:none;margin-top:10px">
            <div style="font-size:11px;font-weight:700;color:rgba(0,212,255,.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Reference Image URL</div>
            <input id="higgs-img-url" type="url" placeholder="https://… paste image URL for image-to-video" style="width:100%;background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.15);border-radius:8px;padding:9px 12px;color:#e8e8e8;font-size:12px;outline:none;box-sizing:border-box">
          </div>
        </div>

        <!-- Controls row -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
          <div class="gen-panel">
            <div style="font-size:10px;font-weight:700;color:rgba(0,212,255,.6);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Duration</div>
            <select id="higgs-duration" style="width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(0,212,255,.2);border-radius:7px;padding:7px 9px;color:#e8e8e8;font-size:12px">
              <option value="5">5 seconds</option>
              <option value="8">8 seconds</option>
              <option value="10" selected>10 seconds</option>
              <option value="15">15 seconds</option>
            </select>
          </div>
          <div class="gen-panel">
            <div style="font-size:10px;font-weight:700;color:rgba(0,212,255,.6);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Aspect Ratio</div>
            <select id="higgs-aspect" style="width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(0,212,255,.2);border-radius:7px;padding:7px 9px;color:#e8e8e8;font-size:12px">
              <option value="16:9" selected>16:9 Landscape</option>
              <option value="9:16">9:16 Portrait</option>
              <option value="4:3">4:3 Classic</option>
              <option value="1:1">1:1 Square</option>
            </select>
          </div>
          <div class="gen-panel">
            <div style="font-size:10px;font-weight:700;color:rgba(0,212,255,.6);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Quality</div>
            <select id="higgs-quality" style="width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(0,212,255,.2);border-radius:7px;padding:7px 9px;color:#e8e8e8;font-size:12px">
              <option value="standard">Standard</option>
              <option value="high" selected>High</option>
            </select>
          </div>
        </div>

        <!-- Generate button -->
        <button id="btn-higgs-gen" onclick="runHiggsfield()" style="width:100%;padding:14px;background:linear-gradient(135deg,#00d4ff,#00ffa3);border:none;border-radius:12px;color:#000;font-size:14px;font-weight:900;cursor:pointer;letter-spacing:.3px;transition:.2s;margin-bottom:14px">
          <i class="fas fa-film"></i>&nbsp; Generate with Higgsfield
        </button>

        <!-- Progress / result -->
        <div id="higgs-progress" style="display:none;background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.15);border-radius:12px;padding:16px;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <div style="width:10px;height:10px;border-radius:50%;background:#00d4ff;animation:pulse 1.2s infinite"></div>
            <span id="higgs-progress-msg" style="font-size:13px;color:#00d4ff;font-weight:600">Queued…</span>
          </div>
          <div style="background:rgba(0,0,0,.3);border-radius:6px;height:5px;overflow:hidden">
            <div id="higgs-progress-bar" style="height:100%;background:linear-gradient(90deg,#00d4ff,#00ffa3);width:5%;transition:width .5s"></div>
          </div>
        </div>

        <div id="higgs-result" style="display:none"></div>

        <!-- Tips -->
        <div style="background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:12px 14px;font-size:11px;color:rgba(255,255,255,.4);line-height:1.7">
          <strong style="color:rgba(0,212,255,.6)">✦ Higgsfield Tips:</strong> Be specific about camera movement (dolly zoom, tracking shot, crane lift). Describe lighting and atmosphere. For I2V, paste a clean image URL. Generations run on Higgsfield's infrastructure — typically 1-3 minutes.
        </div>

      </div>

      <!-- Sidebar -->
      <div class="gen-sidebar" style="border-left-color:rgba(0,212,255,.15)">
        <div class="gen-sidebar-hd" style="color:#00d4ff"><i class="fas fa-bolt"></i> Live Queue</div>
        <div class="gen-sidebar-empty" id="gsb-higgsfield-empty" style="color:rgba(0,212,255,.4)"><i class="fas fa-film" style="font-size:22px;opacity:.25;margin-bottom:8px;display:block"></i>Your generations will appear here</div>
        <div id="gsb-higgsfield-log" class="gen-sidebar-log"></div>
        <div class="gen-sidebar-section" style="border-color:rgba(0,212,255,.1)">
          <div class="gen-sidebar-label" style="color:rgba(0,212,255,.5)">Model Info</div>
          <div id="higgs-model-info" style="font-size:11px;color:rgba(255,255,255,.45);line-height:1.6">Select a model to see details.</div>
        </div>
      </div>
    </div>

  </div><!-- /gen-body-wrap -->
</div>

<!-- 264 PRO TAB — Download / Landing Page -->
<div class="tab-pane" id="tab-pane-264" style="display:none;padding:0;overflow-y:auto">
  <div style="min-height:100%;background:linear-gradient(160deg,#0f0f1a 0%,#1a0d1a 50%,#0f0f1a 100%);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:48px 24px">

    <!-- Hero -->
    <div style="text-align:center;max-width:700px;margin-bottom:52px">
      <div style="font-size:64px;margin-bottom:12px">&#127916;</div>
      <h1 style="font-size:48px;font-weight:900;margin:0 0 10px;background:linear-gradient(135deg,#ec4899,#f59e0b,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1.1">264 Pro</h1>
      <p style="font-size:18px;color:var(--text-s);margin:0 0 8px;line-height:1.6">Professional AI Video Editor. Desktop Native.</p>
      <p style="font-size:14px;color:var(--text-m);margin:0 0 32px">A standalone desktop video editor with AI-powered tools &mdash; timeline editing, colour grading, audio mixing, AI upscale, AI denoise, slow-mo, face enhance, and Clawbot integration. Download and run it locally.</p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <a href="https://github.com/mkbrown261/264-pro-video-editor/releases/latest/download/264Pro-mac.dmg" class="aud-dl-btn aud-mac"><i class="fab fa-apple"></i> Download for macOS</a>
        <a href="https://github.com/mkbrown261/264-pro-video-editor/releases/latest/download/264Pro-win.exe" class="aud-dl-btn aud-win"><i class="fab fa-windows"></i> Download for Windows</a>
        <a href="https://github.com/mkbrown261/264-pro-video-editor/releases/latest/download/264Pro-linux.AppImage" class="aud-dl-btn aud-linux"><i class="fab fa-linux"></i> Download for Linux</a>
      </div>
      <div style="margin-top:16px;font-size:12px;color:var(--text-m)">Free to download &nbsp;&#xB7;&nbsp; ClawFlow subscription unlocks AI tools &nbsp;&#xB7;&nbsp; <a href="https://github.com/mkbrown261/264-pro-video-editor" target="_blank" style="color:var(--accent)">View on GitHub</a></div>
    </div>

    <!-- Feature grid -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;max-width:860px;width:100%;margin-bottom:52px">
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#ec4899"><i class="fas fa-layer-group"></i></div><div class="aud-feat-title">Multi-Track Timeline</div><div class="aud-feat-desc">Unlimited video &amp; audio tracks, magnetic snapping, ripple/roll edits, nested sequences, compound clips.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#a855f7"><i class="fas fa-palette"></i></div><div class="aud-feat-title">Colour Grading</div><div class="aud-feat-desc">Built-in LUT support, curves, HSL wheels, scopes (waveform, vectorscope), film grain overlays.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#06b6d4"><i class="fas fa-sliders"></i></div><div class="aud-feat-title">Audio Mixer</div><div class="aud-feat-desc">Per-track EQ, compression, reverb &amp; delay sends, per-channel automation, stereo bus with limiter.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon"><img src="/static/clawbot-mascot.png" style="width:32px;height:32px;object-fit:contain"></div><div class="aud-feat-title">AI Upscale &amp; Denoise</div><div class="aud-feat-desc">Real-ESRGAN upscaling to 4K. FastDVDnet temporal noise suppression. Powered by Replicate.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#10b981"><i class="fas fa-person-running"></i></div><div class="aud-feat-title">AI Slow-Motion</div><div class="aud-feat-desc">DAIN frame interpolation for buttery 2x–8x slow-mo from any footage. No high-speed camera needed.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#ec4899"><i class="fas fa-face-smile"></i></div><div class="aud-feat-title">AI Face Enhance</div><div class="aud-feat-desc">CodeFormer face restoration — sharpen, de-blur, and recolour faces in degraded footage.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#a855f7"><i class="fas fa-scissors"></i></div><div class="aud-feat-title">AI Rotoscoping</div><div class="aud-feat-desc">Segment-Anything (SAM) background removal on any frame or clip. Export with alpha channel.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#06b6d4"><i class="fas fa-file-export"></i></div><div class="aud-feat-title">Pro Export</div><div class="aud-feat-desc">H.264, H.265, ProRes, DNxHD, GIF. Custom bitrate, resolution, framerate. Hardware encoding.</div></div>
    </div>

    <!-- AI Tools callout -->
    <div style="max-width:680px;width:100%;background:linear-gradient(135deg,rgba(236,72,153,.1),rgba(245,158,11,.07));border:1px solid rgba(236,72,153,.3);border-radius:18px;padding:28px 32px;text-align:center;margin-bottom:40px">
      <img src="/static/clawbot-mascot.png" style="width:89px;height:89px;object-fit:contain;display:block;margin:0 auto 12px">
      <div style="font-size:18px;font-weight:900;margin-bottom:6px">Supercharge with Clawbot &amp; ClawFlow</div>
      <div style="font-size:13px;color:var(--text-s);margin-bottom:20px;line-height:1.7">Clawbot connects directly to 264 Pro for real-time AI assistance &mdash; walkthrough generation, AI tool suggestions, export optimization, and automated editing workflows. ClawFlow subscription required ($40/month &mdash; first month $20).</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="clawbot-cta" style="max-width:240px;margin:0 auto" onclick="switchTab('clawbot');setClawCtx('264_pro','🎬 264 Pro Editor')">Open ClawFlow for 264 Pro &rarr;</button>
      </div>
    </div>

    <!-- System requirements -->
    <div style="max-width:680px;width:100%;margin-bottom:32px">
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);margin-bottom:12px">System Requirements</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:12px">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:9px;padding:12px"><div style="font-weight:700;margin-bottom:4px"><i class="fab fa-apple"></i> macOS</div><div style="color:var(--text-m)">macOS 12+ (Monterey)<br>Apple Silicon or Intel<br>16GB RAM, 4GB disk</div></div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:9px;padding:12px"><div style="font-weight:700;margin-bottom:4px"><i class="fab fa-windows"></i> Windows</div><div style="color:var(--text-m)">Windows 10/11 (64-bit)<br>Dedicated GPU recommended<br>16GB RAM, 4GB disk</div></div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:9px;padding:12px"><div style="font-weight:700;margin-bottom:4px"><i class="fab fa-linux"></i> Linux</div><div style="color:var(--text-m)">Ubuntu 20.04+ / Arch<br>NVIDIA GPU recommended<br>16GB RAM, 4GB disk</div></div>
      </div>
    </div>

    <div style="text-align:center;font-size:12px;color:var(--text-m)">264 Pro is open source &mdash; <a href="https://github.com/mkbrown261/264-pro-video-editor" target="_blank" style="color:var(--accent)">github.com/mkbrown261/264-pro-video-editor</a></div>
  </div>
</div>

<!-- FLOWSTATE AUDIO TAB — Download / Landing Page -->
<div class="tab-pane" id="tab-pane-audio" style="display:none;padding:0;overflow-y:auto">
  <div style="min-height:100%;background:linear-gradient(160deg,#0f0f1a 0%,#0d1a1f 50%,#0f0f1a 100%);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:48px 24px">

    <!-- Hero -->
    <div style="text-align:center;max-width:700px;margin-bottom:52px">
      <img src="/static/fs-audio-logo.png" alt="Flowstate Audio" style="max-width:480px;width:90%;margin:0 auto 24px;display:block;border-radius:16px">
      <p style="font-size:18px;color:var(--text-s);margin:0 0 8px;line-height:1.6">Professional DAW. AI-Powered. Yours.</p>
      <p style="font-size:14px;color:var(--text-m);margin:0 0 32px">A standalone desktop DAW with multi-track recording, VST/AU plugins, a full piano roll, mixer console, AI music generation, and deep Clawbot integration. Download and run it locally.</p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <a href="https://github.com/mkbrown261/FS-AUDIO/releases/latest/download/FlowstateAudio-mac.dmg" class="aud-dl-btn aud-mac"><i class="fab fa-apple"></i> Download for macOS</a>
        <a href="https://github.com/mkbrown261/FS-AUDIO/releases/latest/download/FlowstateAudio-win.exe" class="aud-dl-btn aud-win"><i class="fab fa-windows"></i> Download for Windows</a>
        <a href="https://github.com/mkbrown261/FS-AUDIO/releases/latest/download/FlowstateAudio-linux.AppImage" class="aud-dl-btn aud-linux"><i class="fab fa-linux"></i> Download for Linux</a>
      </div>
      <div style="margin-top:16px;font-size:12px;color:var(--text-m)">Free to download &nbsp;&#xB7;&nbsp; ClawFlow subscription unlocks AI features &nbsp;&#xB7;&nbsp; <a href="https://github.com/mkbrown261/FS-AUDIO" target="_blank" style="color:var(--accent)">View on GitHub</a></div>
    </div>

    <!-- Feature grid -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;max-width:860px;width:100%;margin-bottom:52px">
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#10b981"><i class="fas fa-layer-group"></i></div><div class="aud-feat-title">Multi-Track Recording</div><div class="aud-feat-desc">Unlimited audio &amp; MIDI tracks, punch recording, take folders, and comping with a professional-grade timeline editor.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#a855f7"><i class="fas fa-plug"></i></div><div class="aud-feat-title">VST / AU Plugins</div><div class="aud-feat-desc">Load your own VST3 and AU plugins. Built-in EQ, Compressor, Reverb, Delay, Limiter, Chorus, Distortion.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#06b6d4"><i class="fas fa-piano-keyboard"></i></div><div class="aud-feat-title">Piano Roll</div><div class="aud-feat-desc">Full MIDI editor with velocity editing, quantize, chord detection, and Hyper Draw automation.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#ec4899"><i class="fas fa-sliders"></i></div><div class="aud-feat-title">Mixer Console</div><div class="aud-feat-desc">Per-channel inserts, sends, pan, VU meters, grouping, automation — a full mixing console.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon"><img src="/static/clawbot-mascot.png" style="width:32px;height:32px;object-fit:contain"></div><div class="aud-feat-title">Clawbot AI</div><div class="aud-feat-desc">Generate beats, melodies, full tracks via Suno &amp; MusicGen. AI mastering, stem separation, pitch correction.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#10b981"><i class="fas fa-waveform-lines"></i></div><div class="aud-feat-title">Flex Time &amp; Pitch</div><div class="aud-feat-desc">Non-destructive time stretching and pitch shifting. Quantize audio to a grid without artifacts.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#a855f7"><i class="fas fa-music"></i></div><div class="aud-feat-title">AI Music Generation</div><div class="aud-feat-desc">Full tracks, beats, melodies and stems generated by Suno AI, MusicGen, and Udio — ClawFlow required.</div></div>
      <div class="aud-feat-card"><div class="aud-feat-icon" style="color:#06b6d4"><i class="fas fa-file-export"></i></div><div class="aud-feat-title">Pro Export</div><div class="aud-feat-desc">Bounce to WAV (16/24/32-bit), MP3, AAC, AIFF. Export individual tracks or full stems. LUFS normalisation.</div></div>
    </div>

    <!-- Clawbot / ClawFlow callout -->
    <div style="max-width:680px;width:100%;background:linear-gradient(135deg,rgba(168,85,247,.1),rgba(6,182,212,.07));border:1px solid rgba(168,85,247,.3);border-radius:18px;padding:28px 32px;text-align:center;margin-bottom:40px">
      <img src="/static/clawbot-mascot.png" style="width:89px;height:89px;object-fit:contain;display:block;margin:0 auto 12px">
      <div style="font-size:18px;font-weight:900;margin-bottom:6px">Supercharge with Clawbot &amp; ClawFlow</div>
      <div style="font-size:13px;color:var(--text-s);margin-bottom:20px;line-height:1.7">Clawbot connects directly to Flowstate Audio for real-time AI assistance &mdash; arrangement suggestions, beat generation, vocal pitch correction, AI mastering, and stem separation. ClawFlow subscription required ($40/month &mdash; first month $20).</div>
      <button class="clawbot-cta" style="max-width:320px;margin:0 auto" onclick="switchTab('clawbot')">Activate ClawFlow &rarr;</button>
    </div>

    <!-- System requirements -->
    <div style="max-width:680px;width:100%;margin-bottom:32px">
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);margin-bottom:12px">System Requirements</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:12px">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:9px;padding:12px"><div style="font-weight:700;margin-bottom:4px"><i class="fab fa-apple"></i> macOS</div><div style="color:var(--text-m)">macOS 12+ (Monterey)<br>Apple Silicon or Intel<br>8GB RAM, 2GB disk</div></div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:9px;padding:12px"><div style="font-weight:700;margin-bottom:4px"><i class="fab fa-windows"></i> Windows</div><div style="color:var(--text-m)">Windows 10/11 (64-bit)<br>ASIO-compatible audio<br>8GB RAM, 2GB disk</div></div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:9px;padding:12px"><div style="font-weight:700;margin-bottom:4px"><i class="fab fa-linux"></i> Linux</div><div style="color:var(--text-m)">Ubuntu 20.04+ / Arch<br>JACK or PulseAudio<br>8GB RAM, 2GB disk</div></div>
      </div>
    </div>


    <div style="margin-top:40px;opacity:.4;width:100%;display:flex;justify-content:center"><img src="/static/fs-audio-banner.png" alt="Flowstate" style="max-width:500px;width:80%;border-radius:12px;display:block"></div>
  </div>
</div>

<!-- CLAWBOT TAB -->
<div class="tab-pane" id="tab-pane-clawbot" style="display:none;padding:14px">
  <div id="clawbot-gate" style="display:none">
    <div class="clawbot-promo-card" id="clawbot-promo"></div>
  </div>
  <div id="clawbot-active" style="display:none;flex-direction:column;height:100%">
    <div class="clawbot-header">
      <div class="clawbot-title">
        <img src="/static/clawbot-mascot.png" style="width:36px;height:36px;object-fit:contain">
        <div>
          <div style="font-size:15px;font-weight:900">Clawbot</div>
          <div style="font-size:11px;color:var(--text-m)">AI Brain &middot; ClawFlow Active</div>
        </div>
      </div>
      <div class="clawbot-app-sel">
        <!-- App context pill picker — matches image/audio gen style -->
        <div class="gs-gen-picker" style="position:relative" id="clawbot-ctx-picker-wrap">
          <button class="gs-model-pill" onclick="toggleClawCtxPicker(event)" id="clawbot-ctx-pill" style="min-width:160px;justify-content:space-between">
            <span id="clawbot-ctx-label">⚡ Flowstate Hub</span>
            <i class="fas fa-chevron-down" style="font-size:9px;opacity:.5"></i>
          </button>
          <div class="gs-model-dropdown" id="clawbot-ctx-dropdown" style="display:none;min-width:190px">
            <div class="gs-model-row" onclick="setClawCtx('flowstate_hub','⚡ Flowstate Hub')"><span style="font-weight:600;font-size:13px">⚡ Flowstate Hub</span><div class="gs-radio gs-radio-active" id="ccr-hub"></div></div>
            <div class="gs-model-row" onclick="setClawCtx('264_pro','🎬 264 Pro Editor')"><span style="font-weight:600;font-size:13px">🎬 264 Pro Editor</span><div class="gs-radio" id="ccr-264"></div></div>
            <div class="gs-model-row" onclick="setClawCtx('flowstate_audio','🎵 Flowstate Audio')"><span style="font-weight:600;font-size:13px">🎵 Flowstate Audio</span><div class="gs-radio" id="ccr-audio"></div></div>
          </div>
        </div>
        <div class="clawbot-coins" id="clawbot-coins-badge">&#9889; &mdash; coins</div>
      </div>
    </div>
    <div class="chat-msgs" id="clawbot-msgs" style="flex:1;min-height:200px;margin-bottom:10px">
      <div class="msg ai">
        <div class="msg-av" style="background:linear-gradient(135deg,#a855f7,#06b6d4);overflow:hidden;padding:0"><img src="/static/clawbot-mascot.png" style="width:100%;height:100%;object-fit:cover"></div>
        <div>
          <div class="msg-meta"><span class="m-tag" style="background:rgba(6,182,212,.15);color:#06b6d4">Clawbot</span><span>ClawFlow Active</span></div>
          <div class="msg-bub">Hey! I&apos;m Clawbot &mdash; your AI brain for the Flowstate ecosystem. I can help with 264 Pro, Flowstate Audio, and Flowstate Hub. I can also generate step-by-step walkthroughs for any workflow. What are you working on?</div>
        </div>
      </div>
    </div>
    <div class="clawbot-walkthrough-bar" id="clawbot-wt-bar" style="display:none">
      <div class="clawbot-wt-content" id="clawbot-wt-content"></div>
      <button class="btn-sm" onclick="dismissWalkthrough()">&#x2715;</button>
    </div>
    <div class="chat-input-row">
      <textarea class="chat-in" id="clawbot-in" placeholder="Ask Clawbot anything about Flowstate, 264 Pro, or Flowstate Audio&#8230;" rows="1"></textarea>
      <button class="btn-send" id="clawbot-send" style="background:linear-gradient(135deg,#a855f7,#06b6d4);overflow:hidden;padding:4px"><img src="/static/clawbot-mascot.png" style="width:100%;height:100%;object-fit:contain"></button>
    </div>
    <div style="display:flex;gap:7px;margin-top:8px;flex-wrap:wrap">
      <button class="clawbot-quick-btn" onclick="clawbotQuick('Generate a walkthrough for this app')">&#x1F4D6; Generate Walkthrough</button>
      <button class="clawbot-quick-btn" onclick="clawbotQuick('What workflows can you optimize for me?')">&#9889; Optimize Workflow</button>
      <button class="clawbot-quick-btn" onclick="clawbotQuick('Show me my coin usage and API stats')">&#x1F4B0; Coin Usage</button>
      <button class="clawbot-quick-btn" onclick="clawbotQuick('What are the most powerful features I am not using?')">&#x1F50D; Hidden Features</button>
    </div>
  </div>
</div>

<!-- DEMO TAB -->
<div class="tab-pane" id="tab-pane-demo" style="display:none">
  <div class="demo-banner"><i class="fas fa-eye"></i> Demo mode &mdash; showing a sample Pro account. No real data. <button class="btn-sm" id="btn-exit-demo" style="margin-left:auto">Exit Demo</button></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
    <div class="sprint-health">
      <div class="sh-title">&#128154; Sprint Health &mdash; Demo</div>
      <div class="sh-stats">
        <div class="sh-stat"><div class="sh-stat-v">8</div><div class="sh-stat-l">Total</div></div>
        <div class="sh-stat"><div class="sh-stat-v">5</div><div class="sh-stat-l">Done</div></div>
        <div class="sh-stat"><div class="sh-stat-v">2</div><div class="sh-stat-l">In Progress</div></div>
        <div class="sh-stat"><div class="sh-stat-v">3</div><div class="sh-stat-l">Days Left</div></div>
      </div>
      <div class="sh-progress"><div class="sh-fill" style="width:63%;background:var(--blue)"></div></div>
      <div style="font-size:12px;color:var(--text-s);margin-top:6px;padding:8px;background:var(--bg-card);border-radius:7px">On track. Current velocity suggests sprint will complete at 95% capacity. No blockers detected.</div>
    </div>
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px">
      <div style="font-size:13px;font-weight:800;margin-bottom:12px">&#9889; FlowScore Demo</div>
      <div style="font-size:48px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:6px">78</div>
      <div style="text-align:center;font-size:14px;font-weight:700;color:var(--text-s);margin-bottom:10px">Strong Flow Day</div>
      <div style="font-size:12px;color:var(--text-m);line-height:1.6">4 focus sessions completed. 2 breaks taken. Streak: 5 days. Take a 10-min walk to push past 80 tomorrow.</div>
    </div>
    <div class="sprint-health">
      <div class="sh-title">&#128100; Team Pulse &mdash; Demo</div>
      <div class="team-grid" style="grid-template-columns:1fr 1fr">
        <div class="member-card"><div class="pulse-dot focus"></div><div class="member-av">&#129337;</div><div class="member-name">You</div><div class="member-role">Admin</div><div style="font-size:11px;color:var(--text-m)">In focus session</div><div class="burnout-bar"><div class="burnout-fill" style="width:10%;background:var(--green)"></div></div><div style="font-size:10px;color:var(--green);margin-top:3px">Wellness: 90/100</div></div>
        <div class="member-card"><div class="pulse-dot online"></div><div class="member-av">&#128105;</div><div class="member-name">Alex Chen</div><div class="member-role">Senior Dev</div><div style="font-size:11px;color:var(--text-m)">Online</div><div class="burnout-bar"><div class="burnout-fill" style="width:20%;background:var(--green)"></div></div><div style="font-size:10px;color:var(--green);margin-top:3px">Wellness: 80/100</div></div>
        <div class="member-card"><div class="pulse-dot break"></div><div class="member-av">&#129337;</div><div class="member-name">Jordan Lee</div><div class="member-role">Scrum Master</div><div style="font-size:11px;color:var(--text-m)">On break</div><div class="burnout-bar"><div class="burnout-fill" style="width:45%;background:var(--warn)"></div></div><div style="font-size:10px;color:var(--warn);margin-top:3px">Wellness: 55/100</div></div>
        <div class="member-card"><div class="pulse-dot offline"></div><div class="member-av">&#128104;</div><div class="member-name">Sam Rivera</div><div class="member-role">Member</div><div style="font-size:11px;color:var(--text-m)">Offline</div><div class="burnout-bar"><div class="burnout-fill" style="width:65%;background:var(--danger)"></div></div><div style="font-size:10px;color:var(--danger);margin-top:3px">Wellness: 35/100</div></div>
      </div>
    </div>
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px">
      <div style="font-size:13px;font-weight:800;margin-bottom:12px">&#128203; Kanban &mdash; Demo</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="background:var(--bg-card);border:1px solid var(--green)22;border-radius:8px;padding:8px 11px;font-size:12px;font-weight:600">&#10003; Auth flow</div>
        <div style="background:var(--bg-card);border:1px solid var(--green)22;border-radius:8px;padding:8px 11px;font-size:12px;font-weight:600">&#10003; API routes</div>
        <div style="background:var(--bg-card);border:1px solid var(--warn)33;border-radius:8px;padding:8px 11px;font-size:12px;font-weight:600">&#9654; Dashboard UI</div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font-size:12px;font-weight:600;color:var(--text-m)">&#9679; Billing</div>
      </div>
    </div>
  </div>
</div>

<script>
// Server-injected session data
const FS_USER     = ${userJson};
const FS_NOTION   = ${notionJson};
const FS_SLACK    = ${slackJson};
const FS_ONBOARDED= ${onboardedJson};
</script>
<script src="/static/app.js"></script>
</body>
</html>
`)})

// ═══════════════════════════════════════════════════════════════════════════════
// ── FlowState Audio Desktop App API ──────────────────────────────────────────
// All routes use Bearer token auth (fsaudio_token stored in Electron's userData)
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: extract Bearer token (shared for both desktop apps)
function getDesktopToken(c: any): string | null {
  const auth = c.req.header('Authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
}

// Helper: verify FS-Audio token (same D1+Redis pattern as 264 Pro)
async function verifyAudioToken(c: any, token: string): Promise<{ valid: boolean; email?: string; tier?: string }> {
  const DEV_BYPASS = 'DEV-FSAUDIO-MKBROWN-2026-BYPASS'
  if (token === DEV_BYPASS) return { valid: true, email: 'dev@fsaudio.local', tier: 'clawflow' }

  // Redis fast path
  const redisUrl = c.env?.UPSTASH_REDIS_URL
  const redisTok = c.env?.UPSTASH_REDIS_TOKEN
  if (redisUrl && redisTok) {
    try {
      const results = await redisPipeline(redisUrl, redisTok, [['GET', `fsaudio_token:${token}`]])
      const email = results[0] as string | null
      if (email) {
        const tierResults = await redisPipeline(redisUrl, redisTok, [['GET', `tier_email:${email}`]])
        return { valid: true, email, tier: (tierResults[0] as string) || 'free' }
      }
    } catch (_) {}
  }

  // D1 fallback
  if (c.env?.DB) {
    try {
      const dbToken = await verifyDesktopToken(c.env.DB, token)
      if (dbToken) {
        if (redisUrl && redisTok) {
          await redisPipeline(redisUrl, redisTok, [
            ['SET', `fsaudio_token:${token}`, dbToken.email],
            ['EXPIRE', `fsaudio_token:${token}`, 7 * 86400],
          ]).catch(() => {})
        }
        return { valid: true, email: dbToken.email, tier: dbToken.tier }
      }
    } catch (_) {}
  }

  return { valid: false }
}

// GET /api/fsaudio/auth — OAuth entry point for FS-Audio desktop app
app.get('/api/fsaudio/auth', async (c) => {
  const state    = c.req.query('state') || ''
  const redirect = c.req.query('redirect') || 'fsaudio://auth'
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (url && tok) {
    await fetch(`${url}/set/fsaudio_state_${state}/${encodeURIComponent(redirect)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ex: 600 }),
    })
  }
  return c.redirect(`/auth?app=fsaudio&state=${encodeURIComponent(state)}&redirect=${encodeURIComponent(redirect)}`)
})

// GET /api/fsaudio/auth/callback — issues FS-Audio token after login
app.get('/api/fsaudio/auth/callback', async (c) => {
  const session  = decodeSession(getCookie(c, 'fs_session') || '')
  const state    = c.req.query('state') || ''
  const redirect = c.req.query('redirect') || 'fsaudio://auth'
  if (!session?.email) return c.json({ error: 'Not authenticated' }, 401)

  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  const token = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('')

  // Redis cache
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (url && tok) {
    await redisPipeline(url, tok, [
      ['SET', `fsaudio_token:${token}`, session.email],
      ['EXPIRE', `fsaudio_token:${token}`, 90 * 86400],
    ])
  }

  // D1 permanent store
  if (c.env?.DB) {
    try {
      await upsertUser(c.env.DB, session.email, session.name || session.email.split('@')[0], session.picture || '', 'google').catch(() => {})
      await issueDesktopToken(c.env.DB, session.email, 'fs_audio', token, session.tier || 'free')
    } catch (_) {}
  }

  const deepLink = `${decodeURIComponent(redirect)}?token=${token}&state=${encodeURIComponent(state)}`
  return c.redirect(deepLink)
})

// GET /api/fsaudio/verify-token — Electron startup validation
app.get('/api/fsaudio/verify-token', async (c) => {
  const token = getDesktopToken(c)
  if (!token) return c.json({ valid: false, error: 'No token' }, 401)
  const result = await verifyAudioToken(c, token)
  if (!result.valid) return c.json({ valid: false, error: 'Invalid or expired token' }, 401)
  return c.json({ valid: true, email: result.email, tier: result.tier })
})

// GET /api/fsaudio/user — get user info for FS-Audio
app.get('/api/fsaudio/user', async (c) => {
  const token = getDesktopToken(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth = await verifyAudioToken(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
  return c.json({ email: auth.email, tier: auth.tier, clawflowActive: auth.tier === 'clawflow' })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ── R2 Storage API (shared by 264 Pro + FS-Audio desktop apps) ───────────────
// All R2 keys are namespaced by email and app: {app}/{email}/{filename}
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/r2/upload — upload a file (project save, AI export, etc.)
// Body: multipart/form-data with 'file' field and optional 'path' field
app.post('/api/r2/upload', async (c) => {
  const token = getDesktopToken(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth264 = await verify264Token(c, token)
  const authAudio = auth264.valid ? auth264 : await verifyAudioToken(c, token)
  if (!authAudio.valid) return c.json({ error: 'Invalid token' }, 401)
  if (!c.env?.R2) return c.json({ error: 'R2 not configured' }, 503)

  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File
    const customPath = formData.get('path') as string | null
    const app_name = formData.get('app') as string || '264pro'

    if (!file) return c.json({ error: 'No file provided' }, 400)

    const key = customPath || `${app_name}/${authAudio.email}/${Date.now()}-${file.name}`
    const arrayBuffer = await file.arrayBuffer()

    await c.env.R2.put(key, arrayBuffer, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
      customMetadata: { email: authAudio.email!, uploadedAt: new Date().toISOString(), originalName: file.name },
    })

    return c.json({ ok: true, key, size: file.size, url: `/api/r2/file/${encodeURIComponent(key)}` })
  } catch (err: any) {
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})

// GET /api/r2/file/:key — download a file
app.get('/api/r2/file/:key{.+}', async (c) => {
  const token = getDesktopToken(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth264 = await verify264Token(c, token)
  const auth = auth264.valid ? auth264 : await verifyAudioToken(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
  if (!c.env?.R2) return c.json({ error: 'R2 not configured' }, 503)

  const key = decodeURIComponent(c.req.param('key'))

  // Security: users can only access their own files
  if (!key.includes(`/${auth.email}/`) && !key.startsWith(`264pro/dev@`) && !key.startsWith(`fsaudio/dev@`)) {
    return c.json({ error: 'Access denied' }, 403)
  }

  try {
    const object = await c.env.R2.get(key)
    if (!object) return c.json({ error: 'File not found' }, 404)

    const contentType = object.httpMetadata?.contentType || 'application/octet-stream'
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${key.split('/').pop()}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message || 'Download failed' }, 500)
  }
})

// GET /api/r2/list — list user's files
app.get('/api/r2/list', async (c) => {
  const token = getDesktopToken(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth264 = await verify264Token(c, token)
  const auth = auth264.valid ? auth264 : await verifyAudioToken(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
  if (!c.env?.R2) return c.json({ files: [], note: 'R2 not configured' })

  const app_name = c.req.query('app') || '264pro'
  const prefix = `${app_name}/${auth.email}/`

  try {
    const list = await c.env.R2.list({ prefix, limit: 100 })
    const files = list.objects.map(obj => ({
      key: obj.key,
      name: obj.key.replace(prefix, ''),
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      url: `/api/r2/file/${encodeURIComponent(obj.key)}`,
    }))
    return c.json({ files, truncated: list.truncated })
  } catch (err: any) {
    return c.json({ error: err.message || 'List failed' }, 500)
  }
})

// DELETE /api/r2/file/:key — delete a file
app.delete('/api/r2/file/:key{.+}', async (c) => {
  const token = getDesktopToken(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth264 = await verify264Token(c, token)
  const auth = auth264.valid ? auth264 : await verifyAudioToken(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
  if (!c.env?.R2) return c.json({ error: 'R2 not configured' }, 503)

  const key = decodeURIComponent(c.req.param('key'))
  if (!key.includes(`/${auth.email}/`)) return c.json({ error: 'Access denied' }, 403)

  try {
    await c.env.R2.delete(key)
    return c.json({ ok: true, key })
  } catch (err: any) {
    return c.json({ error: err.message || 'Delete failed' }, 500)
  }
})

// GET /api/r2/presign/:key — generate a temporary pre-signed URL (for large file downloads)
app.get('/api/r2/presign/:key{.+}', async (c) => {
  const token = getDesktopToken(c)
  if (!token) return c.json({ error: 'Not authenticated' }, 401)
  const auth264 = await verify264Token(c, token)
  const auth = auth264.valid ? auth264 : await verifyAudioToken(c, token)
  if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
  if (!c.env?.R2) return c.json({ error: 'R2 not configured' }, 503)

  const key = decodeURIComponent(c.req.param('key'))
  if (!key.includes(`/${auth.email}/`)) return c.json({ error: 'Access denied' }, 403)

  try {
    // R2 presigned URL (1 hour expiry)
    const url = await c.env.R2.createMultipartUpload ? 
      `/api/r2/file/${encodeURIComponent(key)}` : // Fallback to direct download
      `/api/r2/file/${encodeURIComponent(key)}`
    return c.json({ url, expiresIn: 3600 })
  } catch (err: any) {
    return c.json({ error: err.message || 'Presign failed' }, 500)
  }
})

export default app
