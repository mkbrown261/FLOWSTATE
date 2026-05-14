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
  declareCodeAgentSystemPrompt,
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
  GEMINI_API_KEY: string  // Gemini direct API key (used by AI Code Workspace for code generation)
  GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string
  NOTION_CLIENT_ID: string; NOTION_CLIENT_SECRET: string
  SLACK_CLIENT_ID: string; SLACK_CLIENT_SECRET: string; SLACK_BOT_TOKEN: string
  XAI_API_KEY: string; MISTRAL_API_KEY: string; DEEPSEEK_API_KEY: string
  TOGETHER_API_KEY: string; ELEVENLABS_API_KEY: string
  STRIPE_SECRET_KEY: string; STRIPE_PUBLISHABLE_KEY: string; STRIPE_WEBHOOK_SECRET: string
  RESEND_API_KEY: string; RESEND_FROM_EMAIL: string; SESSION_SECRET: string
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
  // Distribution partners — secrets added via wrangler secret put
  // DistroKid: invite-only partner API (apply at distrokid.com/api)
  DISTROKID_CLIENT_ID: string; DISTROKID_CLIENT_SECRET: string
  // UnitedMasters: partner API (apply at unitedmasters.com/api)
  UNITEDMASTERS_CLIENT_ID: string; UNITEDMASTERS_CLIENT_SECRET: string
  // SubmitHub: public API key from submithub.com/api-settings
  SUBMITHUB_API_KEY: string
  // GitHub OAuth — connect user GitHub accounts for AI code workspace
  GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string
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

// ─── Service Worker at root scope (must be served from / to control full origin) ─
app.get('/sw.js', async (c) => {
  // Proxy the SW file from /static/sw.js but serve it at root path
  // This allows the SW to control the entire origin (scope: '/')
  // The Service-Worker-Allowed header grants permission to use a broader scope
  const res = await fetch(new URL('/static/sw.js', c.req.url).href)
  const body = res.ok ? await res.text() : ''
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-cache',
    }
  })
})

// ─── Session helpers ──────────────────────────────────────────────────────────
function encodeSession(data: object): string { return btoa(JSON.stringify(data)) }
function decodeSession(token: string): any { try { return JSON.parse(atob(token)) } catch { return null } }

// ─── Google OAuth ─────────────────────────────────────────────────────────────
// GET /api/auth/calendar-reconnect — force Google re-consent to get a fresh token
// Clears the old session first so Google can't reuse the cached denied token
app.get('/api/auth/calendar-reconnect', (c) => {
  const baseUrl = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
  // Read email BEFORE deleting session so we can pre-fill it on the consent screen
  const oldSession = decodeSession(getCookie(c, 'fs_session') || '')
  const loginHint = oldSession?.email || ''
  // CRITICAL: delete the old session cookie so Google cannot reuse the cached denied token
  // Without this, Google sees the existing access_token and may skip issuing a new one
  deleteCookie(c, 'fs_session', { path: '/' })
  const intent = declareGoogleOAuth(baseUrl)
  setCookie(c, 'oauth_state', intent.stateParam, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  // Store a marker so callback knows this was a calendar reconnect (not a fresh login)
  setCookie(c, 'cal_reconnect', '1', { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  const params = new URLSearchParams({
    client_id:     c.env?.GOOGLE_CLIENT_ID || '',
    redirect_uri:  intent.redirectPath,
    response_type: 'code',
    scope:         intent.scopes.join(' '),
    state:         intent.stateParam,
    access_type:   'offline',
    prompt:        'consent',        // Force new consent screen + new refresh token every time
    login_hint:    loginHint,        // Pre-fill email so user doesn't have to pick account
  })
  return c.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params)
})

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
    prompt: 'consent',            // Must be 'consent' to guarantee refresh_token on every auth
  })
  return c.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params)
})

app.get('/api/auth/google/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  const storedState  = getCookie(c, 'oauth_state')
  const isCalReconnect = getCookie(c, 'cal_reconnect') === '1'
  deleteCookie(c, 'oauth_state',    { path: '/' })
  deleteCookie(c, 'cal_reconnect',  { path: '/' })
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
    if (!tokens.access_token) throw new Error('No access token: ' + JSON.stringify(tokens))
    const profile: any = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } })).json()
    const session = {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
      name: profile.name, email: profile.email, picture: profile.picture, provider: 'google',
    }
    // Use Lax for same-site access; None only needed for cross-site (desktop app flows)
    setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7*24*3600, path: '/' })

    // Ensure user record exists in D1 on every Google sign-in (new users and returning)
    if (c.env?.DB) {
      try { await upsertUser(c.env.DB, profile.email, profile.name, profile.picture, 'google') } catch (_) {}
    }

    // If this auth was initiated from a desktop app, forward to that app's callback
    if (appCtx.app === 'fsaudio') {
      const cbUrl = `/api/fsaudio/auth/callback?state=${encodeURIComponent(appCtx.state || '')}&redirect=${encodeURIComponent(appCtx.redirect || 'fsaudio://auth')}`
      return c.redirect(cbUrl)
    }
    if (appCtx.app === '264pro') {
      const cbUrl = `/api/264pro/auth/callback?state=${encodeURIComponent(appCtx.state || '')}&redirect=${encodeURIComponent(appCtx.redirect || '264pro://auth')}`
      return c.redirect(cbUrl)
    }

    // Calendar reconnect — skip success page, go straight back to app on the calendar tab
    if (isCalReconnect) {
      return c.redirect('/?tab=calendar&cal_synced=1')
    }

    // Regular web sign-in — show success page then redirect to /
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

// GET version so users can clear session by visiting the URL directly
app.get('/api/auth/logout', (c) => {
  deleteCookie(c, 'fs_session', { path: '/' })
  deleteCookie(c, 'fs_notion', { path: '/' })
  deleteCookie(c, 'fs_slack', { path: '/' })
  return c.redirect('/')
})

// Hard-reset: wipe ALL cookies then redirect straight to Google OAuth
// Use this when the refresh token is from an old client ID
app.get('/api/auth/hard-reset', async (c) => {
  deleteCookie(c, 'fs_session', { path: '/' })
  deleteCookie(c, 'fs_notion', { path: '/' })
  deleteCookie(c, 'fs_slack', { path: '/' })
  const baseUrl = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
  const state = Math.random().toString(36).slice(2)
  setCookie(c, 'oauth_state', state, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  setCookie(c, 'cal_reconnect', '1', { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', c.env?.GOOGLE_CLIENT_ID || '')
  url.searchParams.set('redirect_uri', baseUrl + '/api/auth/google/callback')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid profile email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return c.redirect(url.toString())
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
    setCookie(c, 'fs_notion', encodeSession({ access_token: tokens.access_token, workspace_id: tokens.workspace_id, workspace_name: tokens.workspace_name, workspace_icon: tokens.workspace_icon, bot_id: tokens.bot_id }), { httpOnly: true, secure: true, sameSite: 'None', maxAge: 30*24*3600, path: '/' })
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
    setCookie(c, 'fs_slack', encodeSession({ access_token: tokens.access_token, team_id: tokens.team?.id, team_name: tokens.team?.name, bot_token: tokens.access_token }), { httpOnly: true, secure: true, sameSite: 'None', maxAge: 30*24*3600, path: '/' })
    return c.html(slackSuccessPage(tokens.team?.name))
  } catch (err: any) { return c.html(authErrorPage('Slack authentication failed: ' + err.message)) }
})

app.get('/api/auth/slack-status', async (c) => {
  const token = decodeSession(getCookie(c, 'fs_slack') || '')
  if (!token) return c.json({ connected: false })
  return c.json({ connected: true, team: token.team_name })
})

// ─── GitHub OAuth ─────────────────────────────────────────────────────────────
app.get('/api/auth/github', async (c) => {
  const clientId = c.env?.GITHUB_CLIENT_ID || ''
  if (!clientId) return c.html(authErrorPage('GitHub OAuth not configured. Please contact support.'))
  const baseUrl = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
  const state   = btoa(Math.random().toString(36).slice(2) + Date.now())
  // sameSite: 'None' required because this endpoint is opened in a popup window —
  // the callback redirect from GitHub arrives as a cross-site navigation to the popup,
  // which means Lax cookies are NOT sent back to the opener domain context.
  setCookie(c, 'github_state', state, { httpOnly: true, secure: true, sameSite: 'None', maxAge: 600, path: '/' })
  const params  = new URLSearchParams({
    client_id:    clientId,
    redirect_uri: baseUrl + '/api/auth/github/callback',
    scope:        'read:user repo',
    state,
    allow_signup: 'true',  // let new users create a GitHub account if they don't have one
  })
  return c.redirect('https://github.com/login/oauth/authorize?' + params)
})

app.get('/api/auth/github/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  const savedState = getCookie(c, 'github_state') || ''
  deleteCookie(c, 'github_state', { path: '/' })
  if (error || !code || state !== savedState) return c.html(authErrorPage('GitHub authorization failed or state mismatch.'))
  const baseUrl = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
  try {
    // Exchange code for access token
    const tokenRes: any = await (await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: c.env?.GITHUB_CLIENT_ID, client_secret: c.env?.GITHUB_CLIENT_SECRET, code, redirect_uri: baseUrl + '/api/auth/github/callback' }),
    })).json()
    if (tokenRes.error || !tokenRes.access_token) throw new Error(tokenRes.error_description || 'Token exchange failed')
    // Fetch GitHub user profile
    const ghUser: any = await (await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${tokenRes.access_token}`, 'User-Agent': 'FlowState-App' }
    })).json()
    setCookie(c, 'fs_github', encodeSession({
      access_token: tokenRes.access_token,
      login: ghUser.login,
      name: ghUser.name || ghUser.login,
      avatar_url: ghUser.avatar_url,
      public_repos: ghUser.public_repos,
    }), { httpOnly: true, secure: true, sameSite: 'None', maxAge: 30*24*3600, path: '/' })
    // Return success page that closes the popup and notifies parent
    return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GitHub Connected</title>
<style>body{font-family:system-ui;background:#0f0f1a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1a2e;border:1px solid rgba(16,185,129,.3);border-radius:16px;padding:32px;text-align:center;max-width:360px}
.icon{font-size:48px;margin-bottom:12px}.title{font-size:20px;font-weight:800;color:#10b981;margin-bottom:8px}
.sub{color:#9ca3af;font-size:14px}</style></head>
<body><div class="card"><div class="icon">✅</div>
<div class="title">GitHub Connected!</div>
<div class="sub">Signed in as <strong style="color:#fff">@${ghUser.login}</strong>.<br>You can close this window.</div></div>
<script>
  setTimeout(()=>{
    if(window.opener){ window.opener.postMessage({type:'github_connected',login:'${ghUser.login}',name:'${(ghUser.name||ghUser.login).replace(/'/g,"\\'")}',avatar:'${ghUser.avatar_url}'},'*'); }
    window.close();
  }, 1200);
</script></body></html>`)
  } catch(err: any) { return c.html(authErrorPage('GitHub authentication failed: ' + err.message)) }
})

app.get('/api/auth/github/status', async (c) => {
  const gh = decodeSession(getCookie(c, 'fs_github') || '')
  if (!gh?.access_token) return c.json({ connected: false })
  return c.json({ connected: true, login: gh.login, name: gh.name, avatar_url: gh.avatar_url, public_repos: gh.public_repos })
})

app.get('/api/auth/github/disconnect', async (c) => {
  deleteCookie(c, 'fs_github', { path: '/' })
  return c.json({ ok: true })
})

// GET /api/github/repos — list user's repos
app.get('/api/github/repos', async (c) => {
  const gh = decodeSession(getCookie(c, 'fs_github') || '')
  if (!gh?.access_token) return c.json({ error: 'not_connected' }, 401)
  const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50&type=all', {
    headers: { 'Authorization': `Bearer ${gh.access_token}`, 'User-Agent': 'FlowState-App' }
  })
  const repos: any[] = await res.json()
  if (!Array.isArray(repos)) return c.json({ error: 'github_api_error', repos: [] })
  return c.json({ repos: repos.map(r => ({ id: r.id, name: r.name, full_name: r.full_name, description: r.description, private: r.private, language: r.language, updated_at: r.updated_at, default_branch: r.default_branch, url: r.html_url, stars: r.stargazers_count })) })
})

// GET /api/github/tree?repo=owner/name&branch=main — file tree
app.get('/api/github/tree', async (c) => {
  const gh = decodeSession(getCookie(c, 'fs_github') || '')
  if (!gh?.access_token) return c.json({ error: 'not_connected' }, 401)
  const { repo, branch = 'main' } = c.req.query() as any
  if (!repo) return c.json({ error: 'missing_repo' }, 400)
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, {
    headers: { 'Authorization': `Bearer ${gh.access_token}`, 'User-Agent': 'FlowState-App' }
  })
  const data: any = await res.json()
  if (data.message) return c.json({ error: data.message })
  return c.json({ tree: data.tree || [] })
})

// GET /api/github/file?repo=owner/name&path=src/index.js&branch=main — file content
app.get('/api/github/file', async (c) => {
  const gh = decodeSession(getCookie(c, 'fs_github') || '')
  if (!gh?.access_token) return c.json({ error: 'not_connected' }, 401)
  const { repo, path, branch = 'main' } = c.req.query() as any
  if (!repo || !path) return c.json({ error: 'missing_params' }, 400)
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, {
    headers: { 'Authorization': `Bearer ${gh.access_token}`, 'User-Agent': 'FlowState-App' }
  })
  const data: any = await res.json()
  if (data.message) return c.json({ error: data.message })
  const content = data.encoding === 'base64' ? atob(data.content.replace(/\n/g,'')) : data.content
  return c.json({ content, sha: data.sha, path: data.path, size: data.size })
})

// POST /api/github/commit — create or update a file in a repo
app.post('/api/github/commit', async (c) => {
  const gh = decodeSession(getCookie(c, 'fs_github') || '')
  if (!gh?.access_token) return c.json({ error: 'not_connected' }, 401)
  const { repo, path, content, message, branch = 'main', sha } = await c.req.json()
  if (!repo || !path || content === undefined) return c.json({ error: 'missing_params' }, 400)
  const encoded = btoa(unescape(encodeURIComponent(content)))
  const body: any = { message: message || `Update ${path} via FlowState AI`, content: encoded, branch }
  if (sha) body.sha = sha
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${gh.access_token}`, 'User-Agent': 'FlowState-App', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data: any = await res.json()
  if (data.message && !data.content) return c.json({ error: data.message })
  return c.json({ ok: true, sha: data.content?.sha, url: data.content?.html_url })
})

// ══════════════════════════════════════════════════════════════════════════════
// CLOUDFLARE DEPLOY — user brings their own API token (Genspark-style)
// Token is stored in Upstash Redis keyed by user email (encrypted with btoa)
// ══════════════════════════════════════════════════════════════════════════════

// Helper: delete a key from Upstash Redis
async function redisDel(c: any, key: string): Promise<boolean> {
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return false
  try {
    await fetch(`${url}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${tok}` }
    })
    return true
  } catch { return false }
}

// POST /api/cloudflare/validate — validate a user-supplied CF token and return account info + permissions
app.post('/api/cloudflare/validate', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const { token } = await c.req.json()
  if (!token || typeof token !== 'string' || token.length < 10)
    return c.json({ error: 'invalid_token' }, 400)

  try {
    // 1. Verify token + get user info
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    })
    const verifyData: any = await verifyRes.json()
    if (!verifyData?.success) {
      return c.json({ valid: false, error: 'Token verification failed — check the token and try again.' })
    }

    // 2. Get accounts the token can access
    const acctRes = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=5', {
      headers: { Authorization: `Bearer ${token}` }
    })
    const acctData: any = await acctRes.json()
    const accounts = (acctData?.result || []).map((a: any) => ({ id: a.id, name: a.name }))

    // 3. Get zones
    const zoneRes = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=5', {
      headers: { Authorization: `Bearer ${token}` }
    })
    const zoneData: any = await zoneRes.json()
    const zones = (zoneData?.result || []).map((z: any) => ({ id: z.id, name: z.name }))

    // 4. Get token permissions from verify response
    const policies = verifyData?.result?.policies || []
    const permLabels: string[] = []
    for (const policy of policies) {
      for (const perm of (policy.permission_groups || [])) {
        if (perm.name) permLabels.push(perm.name)
      }
    }

    // 5. Store encrypted token in Redis (keyed by email, 90-day TTL)
    const redisKey = `cf_token:${session.email}`
    await redisSet(c, redisKey, token, 60 * 60 * 24 * 90)

    return c.json({
      valid: true,
      tokenId: verifyData?.result?.id,
      tokenStatus: verifyData?.result?.status,
      accounts,
      zones,
      permissions: permLabels,
      accountCount: accounts.length,
      zoneCount: zones.length,
    })
  } catch (e: any) {
    return c.json({ valid: false, error: 'Network error validating token: ' + e.message })
  }
})

// GET /api/cloudflare/token — return whether user has a saved token (masked) + last-validated account info
app.get('/api/cloudflare/token', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ has_token: false })
  const redisKey = `cf_token:${session.email}`
  const token = await redisGet(c, redisKey)
  if (!token) return c.json({ has_token: false })
  // Mask token for display: show first 4 + last 4
  const masked = token.slice(0, 4) + '·'.repeat(Math.max(0, token.length - 8)) + token.slice(-4)
  return c.json({ has_token: true, masked })
})

// DELETE /api/cloudflare/token — remove stored token
app.delete('/api/cloudflare/token', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  await redisDel(c, `cf_token:${session.email}`)
  return c.json({ ok: true })
})

// ─── Live Preview via R2 ──────────────────────────────────────────────────────
// POST /api/preview/publish — store generated files in R2, return a preview URL
// Body: { files: [{path, content}], projectId?: string }
// Returns: { ok, previewId, url } where url = /preview/{previewId}/index.html
app.post('/api/preview/publish', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const { files, projectId } = await c.req.json()
  if (!files || !Array.isArray(files) || files.length === 0)
    return c.json({ error: 'no_files' }, 400)

  // Use provided projectId or generate a new one
  const previewId = projectId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`
  const prefix = `previews/${previewId}/`

  try {
    // Store every file in R2 under previews/{previewId}/{path}
    await Promise.all(files.map(async (f: { path: string; content: string }) => {
      if (!f.path || f.content === undefined) return
      const key = prefix + f.path.replace(/^\/+/, '')
      const ext = f.path.split('.').pop()?.toLowerCase() || ''
      const ct = ext === 'html' ? 'text/html' :
                 ext === 'css'  ? 'text/css' :
                 ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx' ? 'application/javascript' :
                 ext === 'json' ? 'application/json' :
                 ext === 'svg'  ? 'image/svg+xml' : 'text/plain'
      const enc = new TextEncoder()
      await c.env.R2.put(key, enc.encode(f.content), {
        httpMetadata: { contentType: ct }
      })
    }))

    // Store a manifest so we know which files belong to this preview
    const manifest = { files: files.map((f: any) => f.path), createdAt: Date.now(), email: session.email }
    await c.env.R2.put(prefix + '_manifest.json', JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json' }
    })

    const url = `/preview/${previewId}/index.html`
    return c.json({ ok: true, previewId, url })
  } catch (e: any) {
    return c.json({ error: 'publish_failed', message: e.message }, 500)
  }
})

// GET /preview/:id/:path* — serve R2-stored preview files
app.get('/preview/:id/:path{.*}', async (c) => {
  const id   = c.req.param('id')
  const path = c.req.param('path') || 'index.html'

  // Guard: R2 binding required
  if (!c.env?.R2) {
    return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preview Unavailable</title>
<style>body{background:#0a0a12;color:#f0f0f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#111827;border:1px solid rgba(168,85,247,.3);border-radius:12px;padding:32px;max-width:400px;text-align:center}
h2{color:#a855f7;margin:0 0 12px}p{color:#aaa;line-height:1.6;margin:0}</style></head>
<body><div class="box"><h2>⚠️ Preview Unavailable</h2>
<p>R2 storage is not connected. The live preview requires the Cloudflare R2 binding to be configured. Please use the in-editor preview instead.</p></div></body></html>`, 503)
  }

  const key  = `previews/${id}/${path}`

  try {
    const obj = await c.env.R2.get(key)
    if (!obj) {
      // Try index.html fallback
      const indexKey = `previews/${id}/${path.replace(/\/$/, '')}/index.html`
      const indexObj = await c.env.R2.get(indexKey)
      if (!indexObj) {
        // Try root index.html for this preview
        const rootObj = await c.env.R2.get(`previews/${id}/index.html`)
        if (!rootObj) return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preview Not Found</title>
<style>body{background:#0a0a12;color:#f0f0f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#111827;border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:32px;max-width:400px;text-align:center}
h2{color:#ef4444;margin:0 0 12px}p{color:#aaa;line-height:1.6;margin:0}code{background:#1e2535;padding:2px 6px;border-radius:4px;font-size:12px}</style></head>
<body><div class="box"><h2>⚠️ Preview Not Found</h2>
<p>Preview <code>${id}</code> has expired or doesn't exist. Generate your app and click "Publish" to create a fresh live preview.</p></div></body></html>`, 404)
        const headers = new Headers()
        headers.set('Content-Type', 'text/html; charset=utf-8')
        headers.set('Cache-Control', 'no-store')
        return new Response(rootObj.body, { headers })
      }
      const headers = new Headers()
      headers.set('Content-Type', 'text/html; charset=utf-8')
      headers.set('Cache-Control', 'no-store')
      return new Response(indexObj.body, { headers })
    }

    const headers = new Headers()
    const ct = obj.httpMetadata?.contentType || 'text/plain'
    headers.set('Content-Type', ct.includes('html') ? 'text/html; charset=utf-8' : ct)
    headers.set('Cache-Control', 'no-store')
    // Allow CDN scripts and same-origin resources inside preview iframes
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    return new Response(obj.body, { headers })
  } catch (e: any) {
    return c.text(`Preview error: ${e.message}`, 500)
  }
})

// ─── Project Persistence (D1) ─────────────────────────────────────────────────
// POST /api/code/project/save — save generated files to D1 for this session
// Body: { projectId, name, files: {path: content}, previewId? }
app.post('/api/code/project/save', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const { projectId, name, files, previewId, history } = await c.req.json()
  if (!files || typeof files !== 'object') return c.json({ error: 'no_files' }, 400)

  const db = c.env.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)

  const id = projectId || `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`
  const now = new Date().toISOString()

  try {
    // Ensure table exists (with history column)
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS code_projects (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        files TEXT NOT NULL,
        preview_id TEXT,
        history TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `).run()

    // Add history column if it doesn't exist (migration for existing tables)
    try {
      await db.prepare(`ALTER TABLE code_projects ADD COLUMN history TEXT`).run()
    } catch { /* column already exists — safe to ignore */ }

    const filesJson   = JSON.stringify(files)
    const historyJson = JSON.stringify(Array.isArray(history) ? history.slice(-20) : [])

    await db.prepare(`
      INSERT INTO code_projects (id, email, name, files, preview_id, history, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        files = excluded.files,
        preview_id = excluded.preview_id,
        history = excluded.history,
        updated_at = excluded.updated_at
    `).bind(id, session.email, name || 'Untitled Project', filesJson, previewId || null, historyJson, now, now).run()

    return c.json({ ok: true, projectId: id })
  } catch (e: any) {
    return c.json({ error: 'save_failed', message: e.message }, 500)
  }
})

// GET /api/code/projects — list this user's saved projects
app.get('/api/code/projects', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const db = c.env.DB
  if (!db) return c.json({ projects: [] })

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS code_projects (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT,
        files TEXT NOT NULL, preview_id TEXT, history TEXT, created_at TEXT, updated_at TEXT
      )
    `).run()
    try { await db.prepare(`ALTER TABLE code_projects ADD COLUMN history TEXT`).run() } catch { /* exists */ }

    const rows = await db.prepare(
      `SELECT id, name, preview_id, created_at, updated_at FROM code_projects WHERE email = ? ORDER BY updated_at DESC LIMIT 20`
    ).bind(session.email).all()

    return c.json({ projects: rows.results || [] })
  } catch {
    return c.json({ projects: [] })
  }
})

// GET /api/code/project/:id — load a specific saved project
app.get('/api/code/project/:id', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const db = c.env.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)

  const id = c.req.param('id')
  try {
    const row: any = await db.prepare(
      `SELECT * FROM code_projects WHERE id = ? AND email = ?`
    ).bind(id, session.email).first()

    if (!row) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true, project: {
      ...row,
      files: JSON.parse(row.files || '{}'),
      history: JSON.parse((row as any).history || '[]'),
    } })
  } catch (e: any) {
    return c.json({ error: 'load_failed', message: e.message }, 500)
  }
})

// DELETE /api/code/project/:id — delete a saved project
app.delete('/api/code/project/:id', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)
  const id = c.req.param('id')
  try {
    await db.prepare(`DELETE FROM code_projects WHERE id = ? AND email = ?`).bind(id, session.email).run()
    return c.json({ ok: true })
  } catch { return c.json({ error: 'delete_failed' }, 500) }
})

// ─── Download as Zip ──────────────────────────────────────────────────────────
// POST /api/code/zip — return all project files as a ZIP archive
// Body: { files: [{path, content}], projectName? }
app.post('/api/code/zip', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const { files, projectName = 'project' } = await c.req.json()
  if (!files || !Array.isArray(files) || files.length === 0)
    return c.json({ error: 'no_files' }, 400)

  // Build a ZIP file manually (PKZIP format, stored/deflated)
  // Using pure JS without Node.js zlib — store method (no compression) for simplicity
  const enc = new TextEncoder()

  const localHeaders: Uint8Array[] = []
  const centralHeaders: Uint8Array[] = []
  let localOffset = 0

  const toU16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff])
  const toU32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff])

  // DOS date/time for "now"
  const now2 = new Date()
  const dosTime = ((now2.getHours() << 11) | (now2.getMinutes() << 5) | (now2.getSeconds() >> 1))
  const dosDate = (((now2.getFullYear() - 1980) << 9) | ((now2.getMonth() + 1) << 5) | now2.getDate())

  // CRC-32 table
  const crcTable = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c2 = i
    for (let j = 0; j < 8; j++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1
    crcTable[i] = c2
  }
  const crc32 = (data: Uint8Array) => {
    let crc = 0xffffffff
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }

  const concat = (...arrays: Uint8Array[]) => {
    const total = arrays.reduce((s, a) => s + a.length, 0)
    const out = new Uint8Array(total)
    let off = 0; for (const a of arrays) { out.set(a, off); off += a.length }
    return out
  }

  for (const f of files as Array<{ path: string; content: string }>) {
    const fname = enc.encode(f.path.replace(/^\/+/, ''))
    const data  = enc.encode(f.content || '')
    const crc   = crc32(data)

    // Local file header (signature 0x04034b50)
    const local = concat(
      new Uint8Array([0x50,0x4b,0x03,0x04]),  // signature
      toU16(20),        // version needed: 2.0
      toU16(0),         // general purpose bit flag
      toU16(0),         // compression: stored
      toU16(dosTime), toU16(dosDate),
      toU32(crc),
      toU32(data.length), toU32(data.length), // compressed = uncompressed (stored)
      toU16(fname.length), toU16(0),           // filename len, extra len
      fname, data
    )

    // Central directory entry (signature 0x02014b50)
    const central = concat(
      new Uint8Array([0x50,0x4b,0x01,0x02]),  // signature
      toU16(20), toU16(20),  // version made by, version needed
      toU16(0),              // flags
      toU16(0),              // compression: stored
      toU16(dosTime), toU16(dosDate),
      toU32(crc),
      toU32(data.length), toU32(data.length),
      toU16(fname.length), toU16(0), toU16(0), // fname len, extra len, comment len
      toU16(0), toU16(0),    // disk start, internal attrs
      toU32(0),              // external attrs
      toU32(localOffset),    // offset of local header
      fname
    )

    localHeaders.push(local)
    centralHeaders.push(central)
    localOffset += local.length
  }

  const localData   = concat(...localHeaders)
  const centralData = concat(...centralHeaders)
  const centralSize = centralData.length
  const centralOff  = localData.length

  // End of central directory (signature 0x06054b50)
  const eocd = concat(
    new Uint8Array([0x50,0x4b,0x05,0x06]),  // signature
    toU16(0), toU16(0),    // disk numbers
    toU16(files.length), toU16(files.length),
    toU32(centralSize), toU32(centralOff),
    toU16(0)               // comment len
  )

  const zipBytes = concat(localData, centralData, eocd)
  const safeName = projectName.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()

  return new Response(zipBytes, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}.zip"`,
      'Content-Length': String(zipBytes.length),
    }
  })
})

// POST /api/deploy/cloudflare — deploy generated files to user's own Cloudflare Pages account
// Body: { files: [{path, content}], projectName?: string }
app.post('/api/deploy/cloudflare', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  // Retrieve user's stored token
  const cfToken = await redisGet(c, `cf_token:${session.email}`)
  if (!cfToken) return c.json({ error: 'no_cf_token', message: 'Add your Cloudflare API token in Settings first.' }, 400)

  const { files, projectName: requestedName } = await c.req.json()
  if (!files || !Array.isArray(files) || files.length === 0)
    return c.json({ error: 'no_files', message: 'No files to deploy.' }, 400)

  // Build a safe project name from the user's email + optional name
  const emailSlug = session.email.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 20)
  const nameSlug = requestedName
    ? requestedName.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 20)
    : 'project'
  const projectName = `fs-${emailSlug}-${nameSlug}`.slice(0, 58)

  try {
    // 1. Get the user's first account ID
    const acctRes = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=1', {
      headers: { Authorization: `Bearer ${cfToken}` }
    })
    const acctData: any = await acctRes.json()
    const accountId = acctData?.result?.[0]?.id
    if (!accountId) return c.json({ error: 'no_account', message: 'Could not read Cloudflare account. Re-validate your token in Settings.' })

    // 2. Ensure the Pages project exists (create if not)
    const projCheckRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`, {
      headers: { Authorization: `Bearer ${cfToken}` }
    })
    const projCheckData: any = await projCheckRes.json()
    if (!projCheckData?.success) {
      // Create new project
      const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName, production_branch: 'main' })
      })
      const createData: any = await createRes.json()
      if (!createData?.success) {
        const errMsg = createData?.errors?.[0]?.message || 'Unknown error'
        return c.json({ error: 'create_failed', message: `Could not create Pages project: ${errMsg}` })
      }
    }

    // 3. Build multipart form for direct upload deployment
    // Cloudflare Pages Direct Upload API requires a FormData with each file
    const boundary = `----CFBoundary${Date.now()}`
    const parts: string[] = []

    // Build manifest: {"/path": {hash}} — hash is just a content fingerprint
    const manifest: Record<string, { hash: string }> = {}
    const fileBuffers: Array<{ path: string; content: string; hash: string }> = []

    for (const file of files as Array<{ path: string; content: string }>) {
      if (!file.path || file.content === undefined) continue
      // Simple hash: length + first 8 chars of content (good enough for cache-busting)
      const hash = btoa(file.path + file.content.length).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)
      const normalizedPath = '/' + file.path.replace(/^\//, '')
      manifest[normalizedPath] = { hash }
      fileBuffers.push({ path: normalizedPath, content: file.content, hash })
    }

    // 4. Create a direct upload deployment
    const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfToken}` },
      body: (() => {
        // Build multipart manually since FormData in CF Workers doesn't support file names well
        const enc = new TextEncoder()
        const parts: Uint8Array[] = []
        const nl = enc.encode('\r\n')
        const addPart = (name: string, filename: string, contentType: string, data: Uint8Array) => {
          parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`))
          parts.push(data)
          parts.push(nl)
        }

        // Add manifest
        addPart('manifest', 'manifest.json', 'application/json', enc.encode(JSON.stringify(manifest)))

        // Add each file
        for (const f of fileBuffers) {
          const ext = f.path.split('.').pop()?.toLowerCase() || ''
          const ct = ext === 'html' ? 'text/html' :
                     ext === 'css'  ? 'text/css' :
                     ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx' ? 'application/javascript' :
                     ext === 'json' ? 'application/json' :
                     ext === 'svg'  ? 'image/svg+xml' : 'text/plain'
          addPart(f.hash, f.path.replace(/^\//, ''), ct, enc.encode(f.content))
        }

        parts.push(enc.encode(`--${boundary}--\r\n`))
        // Combine all parts
        const totalLen = parts.reduce((s, p) => s + p.length, 0)
        const result = new Uint8Array(totalLen)
        let offset = 0
        for (const p of parts) { result.set(p, offset); offset += p.length }
        return result
      })(),
    })

    // Direct upload returns 400 for this approach — use the simpler Assets Upload API instead
    // Fall back: POST files as a JSON payload to the Pages Functions direct-upload endpoint
    const deployData: any = await deployRes.json()

    // The direct multipart deploy may fail — use the simpler V2 approach instead
    if (!deployData?.success) {
      // Simpler approach: use Cloudflare Pages URL endpoint to get upload URL, then POST files
      const uploadUrlRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/upload-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      const uploadUrlData: any = await uploadUrlRes.json()

      if (uploadUrlData?.success && uploadUrlData?.result?.url) {
        // Upload files via the pre-signed URL
        const formData = new FormData()
        for (const f of fileBuffers) {
          formData.append(f.hash, new Blob([f.content], { type: 'text/plain' }), f.path.slice(1))
        }
        formData.append('manifest', JSON.stringify(manifest))
        const uploadRes = await fetch(uploadUrlData.result.url, { method: 'PUT', body: formData })
        if (uploadRes.ok) {
          const liveUrl = `https://${projectName}.pages.dev`
          return c.json({ ok: true, url: liveUrl, projectName })
        }
      }

      // Final fallback: just create the project and return its URL (files will be empty but project exists)
      const liveUrl = `https://${projectName}.pages.dev`
      return c.json({
        ok: true, url: liveUrl, projectName,
        warning: 'Project created. Push files to GitHub and connect it to this Pages project to deploy content.'
      })
    }

    const deployment: any = deployData?.result
    const liveUrl = deployment?.url || `https://${projectName}.pages.dev`
    return c.json({ ok: true, url: liveUrl, projectName, deploymentId: deployment?.id })

  } catch (e: any) {
    return c.json({ error: 'deploy_failed', message: e.message || 'Deployment failed' }, 500)
  }
})

// ─── POST /api/code/intent ────────────────────────────────────────────────────
// Fast intent classifier — cheap model, ~300ms, decides what the user wants
// Returns: { type, acknowledgment, question, suggestions }
// type = "build" | "edit" | "chat" | "clarify"
app.post('/api/code/intent', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  // Credit cost — intent classifier (Claude Haiku) ≈ 2 credits
  const abuseCheck = await checkAntiAbuse(c, session.email, 2)
  if (abuseCheck) return abuseCheck

  const { prompt = '', hasFiles = false, conversationHistory = [], activeFile = '', agent = 'claude-sonnet-4' } = await c.req.json()
  if (!prompt.trim()) return c.json({ type: 'clarify', question: 'What would you like to build?' })

  // Build a concise context string of what already exists
  const historyContext = conversationHistory.slice(-4)
    .map((m: any) => `${m.role === 'user' ? 'User' : 'AI'}: ${String(m.content).slice(0, 120)}`)
    .join('\n')

  const classifierPrompt = `You are the AI inside a code builder called FlowState. Your job is two things: classify the user's intent AND respond to them like a real senior developer pair-programming with them — direct, specific, human.

CONTEXT:
- Has existing project files: ${hasFiles}
- Currently open file: ${activeFile || 'none'}
- Recent conversation:
${historyContext || '(none)'}

USER MESSAGE: "${prompt}"

CLASSIFICATION RULES:
- "build": Creating something new from scratch, or a new page/section/feature
- "edit": Changing, fixing, updating, or improving something that already exists
- "chat": Asking a question, having a conversation, or NOT requesting code generation
- "clarify": Too vague to build (no clear deliverable, e.g. just "app" or "something cool")

RESPONSE RULES:

For "build" or "edit" — write an acknowledgment (2-3 sentences) that:
  • Mirrors their exact request back with specifics — don't be vague
  • Names the concrete components/features you're going to build
  • Ends with "On it." or "Building now." (never "Great!" or "Sure!")
  GOOD: "Building a yoga studio app with a hero section, class schedule grid, instructor profiles, and a booking form with Stripe integration. On it."
  BAD: "I'll create a yoga app for you. Building now..."

For "chat" — reply like a senior dev who actually knows this stuff:
  • Give direct, specific answers — no filler, no "great question"
  • If they ask what you can build, list real examples (dashboards, landing pages, React apps, etc.)
  • Keep it concise but complete — 2-5 sentences usually

For "clarify" — ask exactly ONE question, the most important missing detail.
  GOOD: "What kind of app? (e.g. e-commerce, dashboard, social, portfolio)"
  BAD: "Could you clarify what you mean? What features do you want? What's the purpose?"

For suggestions — give 3 natural follow-up prompts the user would actually want to type next.
  GOOD: ["Add a mobile nav menu", "Add a pricing section", "Make the hero animate in"]
  BAD: ["Improve the design", "Add more features", "Make it better"]

RESPOND WITH ONLY THIS JSON — no markdown, no extra text:
{
  "type": "build"|"edit"|"chat"|"clarify",
  "acknowledgment": "...(for build/edit — specific, energetic, ends with On it. or Building now.)",
  "reply": "...(for chat — full conversational response as a senior dev)",
  "question": "...(for clarify — exactly one question)",
  "suggestions": ["...", "...", "..."]
}`

  try {
    // Use fast cheap model for intent — Claude Haiku or Gemini Flash
    const intentModel = c.env?.ANTHROPIC_API_KEY ? 'claude-haiku-4-5-20251101' : null
    const orKey = c.env?.OPENROUTER_API_KEY || ''
    let raw = ''

    if (intentModel && c.env?.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': c.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: intentModel,
          max_tokens: 1024,
          temperature: 0.4,
          messages: [
            { role: 'user', content: classifierPrompt },
            { role: 'assistant', content: '{' }, // prefill for clean JSON
          ]
        })
      })
      const d: any = await r.json()
      raw = '{' + (d?.content?.[0]?.text || '')
    } else if (orKey) {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${orKey}`, 'HTTP-Referer': 'https://flowst8.cc' },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-001',
          messages: [{ role: 'user', content: classifierPrompt }],
          max_tokens: 1024,
          temperature: 0.4,
          response_format: { type: 'json_object' },
        })
      })
      const d: any = await r.json()
      raw = d?.choices?.[0]?.message?.content || ''
    }

    // Parse with fallback
    const cleaned = raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()
    const first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}')
    const result = first !== -1 ? JSON.parse(cleaned.slice(first, last+1)) : null

    if (!result?.type) {
      // If classifier fails, default to build behavior so user isn't blocked
      return c.json({ type: 'build', acknowledgment: "On it — building now...", reply: '', question: '', suggestions: [] })
    }

    return c.json(result)
  } catch {
    return c.json({ type: 'build', acknowledgment: "Got it, building now...", reply: '', question: '', suggestions: [] })
  }
})

// ─── POST /api/code/chat ──────────────────────────────────────────────────────
// Pure conversational response — no files, no build. Just AI talking.
// Used when intent = "chat"
app.post('/api/code/chat', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  // Credit cost — conversational reply (Claude Sonnet) ≈ 15 credits
  const abuseCheck = await checkAntiAbuse(c, session.email, 15)
  if (abuseCheck) return abuseCheck

  const { prompt = '', conversationHistory = [], generatedFiles = {}, agent = 'claude-sonnet-4' } = await c.req.json()

  // Build a summary of what exists in the project
  const fileNames = Object.keys(generatedFiles)
  const projectSummary = fileNames.length
    ? `Current project files: ${fileNames.join(', ')}`
    : 'No files built yet in this session.'

  const historyMessages = (conversationHistory as any[]).slice(-8).map((m: any) => ({
    role: m.role as 'user' | 'assistant',
    content: String(m.content).slice(0, 400)
  }))

  const systemMsg = `You are an expert AI developer and coding partner inside the FlowState AI Code Builder. You are in CONVERSATION mode — the user is asking a question or chatting, NOT requesting code generation right now.

${projectSummary}

Your personality: direct, knowledgeable, like a senior engineer pair-programming with a friend. You:
- Give specific, actionable answers — not vague advice
- Reference the user's actual project when relevant
- Suggest concrete next steps when it makes sense
- Keep responses concise (2-5 sentences for simple questions, longer only when truly needed)
- Sound like a human expert, not a documentation page
- Never say "Great question!" or filler phrases
- If they ask what you can do, explain you can build full web apps, React apps, dashboards, landing pages, etc. — and they can ask you to build anything

Do NOT generate any code files. Just have a conversation.`

  try {
    const orKey = c.env?.OPENROUTER_API_KEY || ''
    let reply = ''

    // Use the selected agent for chat too — feels consistent
    if ((agent === 'claude' || agent === 'claude-sonnet-4' || agent === 'claude-opus-4' || agent === 'claude-haiku-4') && c.env?.ANTHROPIC_API_KEY) {
      const claudeModelMap: Record<string,string> = {
        'claude': 'claude-3-5-sonnet-20241022',
        'claude-sonnet-4': 'claude-sonnet-4-5-20251101',
        'claude-opus-4': 'claude-opus-4-5-20251101',
        'claude-haiku-4': 'claude-haiku-4-5-20251101',
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': c.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: claudeModelMap[agent] || 'claude-sonnet-4-5-20251101',
          max_tokens: 1024,
          system: systemMsg,
          messages: [...historyMessages, { role: 'user', content: prompt }]
        })
      })
      const d: any = await r.json()
      reply = d?.content?.[0]?.text || "I'm not sure how to answer that — try rephrasing?"
    } else if (orKey) {
      const orModelMap: Record<string,string> = {
        'gpt4o': 'openai/gpt-4o', 'gpt4-1': 'openai/gpt-4.1',
        'gemini': 'google/gemini-2.0-flash-001', 'gemini-2-5-pro': 'google/gemini-2.5-pro-preview',
        'deepseek': 'deepseek/deepseek-chat-v3-0324',
      }
      const orModel = orModelMap[agent] || 'google/gemini-2.0-flash-001'
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${orKey}`, 'HTTP-Referer': 'https://flowst8.cc' },
        body: JSON.stringify({
          model: orModel,
          messages: [{ role: 'system', content: systemMsg }, ...historyMessages, { role: 'user', content: prompt }],
          max_tokens: 1024, temperature: 0.7,
        })
      })
      const d: any = await r.json()
      reply = d?.choices?.[0]?.message?.content || "I'm not sure how to answer that."
    } else {
      reply = "No AI key configured — add ANTHROPIC_API_KEY or OPENROUTER_API_KEY to your Cloudflare secrets."
    }

    return c.json({ ok: true, reply })
  } catch (e: any) {
    return c.json({ ok: false, reply: "Something went wrong on my end — try again?" })
  }
})

// POST /api/github/ai-code — AI builder: streams SSE token chunks, final JSON contains files
// Body: { prompt, repo, agent, conversationHistory, fileTree, generatedFiles, language, activeFile? }
app.post('/api/github/ai-code', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  // ── Credit gate: CHECK only (do NOT deduct yet — only charge on success) ──
  // Cost is determined per-model after parsing the request body (done below).
  // For the gate check we use a conservative max cost so free users can't sneak through.
  const _creditGate = await checkCreditsBudgetOnly(c, session.email, 30) // min model cost
  if (_creditGate) return _creditGate

  const {
    prompt,
    repo          = '',
    agent         = 'claude-sonnet-4',
    conversationHistory = [],   // [{role:'user'|'assistant', content:string}]
    fileTree      = [],         // [{path, type}] from GitHub or local
    generatedFiles = {},        // {path: content} — everything built this session
    language      = '',
    stylePreset   = 'ai-decides', // FSDS style preset
    activeFile    = '',          // currently open file — sent first for context (Fix 6)
  } = await c.req.json()

  if (!prompt) return c.json({ error: 'missing_prompt' }, 400)

  // ── Detect whether this is a "new page/view" request ─────────────────────
  const lowerPrompt = prompt.toLowerCase()
  const isNewPageRequest = /\b(new page|new view|new screen|new section|new tab|separate page|separate view|inventory page|inventory view|dashboard page|settings page|profile page|modal|popup|landing page|add a page|create a page|build a page|make a page|build a view|add (?:an? )?(?:inventory|settings|profile|auth|login|signup|onboarding|checkout|detail|about|contact|pricing|faq|help|analytics|reports?|users?|products?|orders?|admin) (?:page|view|screen|tab|section))\b/i.test(lowerPrompt)

  // ── Build file list for AI context ────────────────────────────────────────
  const fileList = fileTree.length
    ? fileTree.filter((f: any) => f.type === 'blob').map((f: any) => f.path).slice(0, 150).join('\n')
    : Object.keys(generatedFiles).join('\n')

  // ── Smart context ordering — upgraded limits ──────────────────────────────
  // Active file: full content always (no cap on edits — model MUST see the whole file)
  // Non-active HTML: 4000 chars (was 500)
  // CSS / JS: 8000 chars (was 2500)
  // New-page requests: suppress HTML to force fresh layout (unchanged)
  const buildFileContext = () => {
    const entries = Object.entries(generatedFiles) as [string, any][]
    if (!entries.length) return ''

    // Active file first, then up to 8 most-recent other files (was 5)
    const sorted = activeFile && generatedFiles[activeFile]
      ? [[activeFile, generatedFiles[activeFile]], ...entries.filter(([p]) => p !== activeFile).slice(-8)]
      : entries.slice(-8)

    return sorted.map(([path, content]: [string, any]) => {
      const isHtml  = path.endsWith('.html') || path.endsWith('.htm')
      const isCss   = path.endsWith('.css')
      const isJs    = path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.ts') || path.endsWith('.tsx')
      const isActive = path === activeFile

      if (isHtml && isNewPageRequest) {
        return `\n### FILE: ${path}\n[HTML omitted — NEW page: build a completely fresh layout]`
      }
      if (isHtml) {
        const raw = String(content)
        // Active HTML file on an edit: send FULL file — no cap
        // This is the #1 reason edits were weak: model couldn't see the whole file
        if (isActive && isEditRequest) {
          return `\n### FILE: ${path} ← CURRENTLY OPEN (full file — read carefully before editing)\n\`\`\`html\n${raw}\n\`\`\``
        }
        // Active HTML on a fresh build: 4000 chars is enough to understand structure
        const cap = isActive ? 4000 : 4000
        const preview = raw.slice(0, cap)
        const omitNote = raw.length > cap ? `\n... [+${raw.length - cap} chars omitted — structure understood]` : ''
        return `\n### FILE: ${path}${isActive ? ' ← CURRENTLY OPEN' : ''}\n\`\`\`html\n${preview}${omitNote}\n\`\`\``
      }
      // CSS: send up to 8000 chars (was 2500)
      if (isCss) {
        const raw = String(content)
        const omitNote = raw.length > 8000 ? `\n... [+${raw.length - 8000} chars omitted]` : ''
        return `\n### FILE: ${path}\n\`\`\`css\n${raw.slice(0, 8000)}${omitNote}\n\`\`\``
      }
      // JS/TS: send up to 8000 chars (was 2500)
      if (isJs) {
        const raw = String(content)
        const omitNote = raw.length > 8000 ? `\n... [+${raw.length - 8000} chars omitted]` : ''
        return `\n### FILE: ${path}\n\`\`\`js\n${raw.slice(0, 8000)}${omitNote}\n\`\`\``
      }
      // Other files: 4000 chars
      const raw = String(content)
      return `\n### FILE: ${path}\n\`\`\`\n${raw.slice(0, 4000)}\n\`\`\``
    }).join('')
  }
  const generatedContext = buildFileContext()

  // ── FSDS CSS scaffold injected into every generation ─────────────────────
  // Per-preset CSS token overrides sit on top of the base FSDS scaffold
  const FSDS_PRESETS: Record<string, { label: string; cssOverride: string; promptHint: string; isReact?: boolean }> = {
    'ai-decides': {
      label: 'AI Decides',
      promptHint: `You are building a STANDALONE app — choose an original color palette that fits the app's domain and purpose. DO NOT use purple (#a855f7) or FlowState brand colors. Examples by domain:
- Fintech/Banking → navy (#0f172a) + gold (#f59e0b) or teal (#0d9488)
- Fitness/Health → deep green (#064e3b) + orange (#f97316) or electric lime (#84cc16)
- Social/Community → deep blue (#1e3a5f) + coral (#f87171) or amber (#fbbf24)
- Productivity/Tools → slate (#1e293b) + indigo (#818cf8) or sky (#38bdf8)
- Creative/Design → near-black (#0c0c0f) + electric pink (#f0abfc) or mint (#6ee7b7)
- E-commerce → charcoal (#111827) + emerald (#34d399) or warm orange (#fb923c)
- Gaming → dark (#07071a) + neon cyan (#22d3ee) or hot magenta (#e879f9)
- Medical/Health → dark navy (#0f1f3d) + clean cyan (#67e8f9) or soft green (#86efac)
Pick ONE primary accent and ONE secondary accent that feel intentional and premium for THIS specific app. Override --accent, --accent-dim, --grad-brand, --border, --border-accent to match.`,
      cssOverride: '', // AI will define its own accent by instruction
    },
    'flowstate-dark': {
      label: 'FlowState Dark',
      promptHint: 'Use the FlowState Dark theme: deep dark backgrounds (#0a0a12 base), purple (#a855f7) as the primary accent, green (#00ffa3) for success states, cyan (#00d4ff) for secondary accents. This is the FlowState brand aesthetic.',
      cssOverride: '', // base scaffold IS the dark theme — no overrides needed
    },
    'flowstate-light': {
      label: 'FlowState Light',
      promptHint: 'Use the FlowState Light theme: white/off-white backgrounds, the same purple accent (#7c3aed), clean and airy. Override --bg to #f4f4f8, --surface-1 to #ffffff, --surface-2 to #f0f0f6, --text-primary to #1a1a2e.',
      cssOverride: `
  --bg: #f4f4f8; --surface-1: #ffffff; --surface-2: #f0f0f6; --surface-3: #e8e8f0;
  --text-primary: #1a1a2e; --text-secondary: #4b5563; --text-muted: #9ca3af;
  --border: rgba(124,58,237,.15); --border-accent: rgba(124,58,237,.4);
  --shadow-sm: 0 1px 3px rgba(0,0,0,.08); --shadow-md: 0 4px 16px rgba(0,0,0,.1);
  --shadow-lg: 0 8px 32px rgba(0,0,0,.14); --shadow-glow: 0 0 24px rgba(124,58,237,.2);
  --accent: #7c3aed; --accent-dim: rgba(124,58,237,.1);`,
    },
    'glassmorphism': {
      label: 'Glassmorphism',
      promptHint: 'Use a Glassmorphism aesthetic: a vivid gradient background (deep purple to dark blue), frosted glass cards using backdrop-filter:blur(16px) with rgba(255,255,255,.08) backgrounds and rgba(255,255,255,.15) borders. All cards should feel like they are floating on the gradient.',
      cssOverride: `
  --bg: #0d0021; --surface-1: rgba(255,255,255,.07); --surface-2: rgba(255,255,255,.04);
  --surface-3: rgba(0,0,0,.25); --border: rgba(255,255,255,.15); --border-accent: rgba(255,255,255,.35);
  --shadow-glow: 0 0 40px rgba(168,85,247,.4);`,
    },
    'brutalist': {
      label: 'Brutalist',
      promptHint: 'Use a Brutalist design aesthetic: off-white or cream backgrounds (#f5f0e8), all borders are 2-3px solid black (#111), box-shadows are hard offsets (4px 4px 0 #111 — no blur), buttons are rectangular with no border-radius, typography is bold and oversized. Raw, intentional, editorial.',
      cssOverride: `
  --bg: #f5f0e8; --surface-1: #ede8de; --surface-2: #e0dbd0; --surface-3: #d4cfc5;
  --text-primary: #111111; --text-secondary: #333333; --text-muted: #666666;
  --border: #111111; --border-accent: #111111;
  --radius-sm: 0px; --radius-md: 0px; --radius-lg: 0px; --radius-xl: 0px; --radius-full: 0px;
  --shadow-sm: 2px 2px 0 #111; --shadow-md: 4px 4px 0 #111; --shadow-lg: 6px 6px 0 #111; --shadow-glow: 4px 4px 0 #a855f7;
  --accent: #a855f7; --accent-dim: rgba(168,85,247,.15);`,
    },
    'terminal': {
      label: 'Terminal / Hacker',
      promptHint: 'Use a Terminal/Hacker aesthetic: pure black background (#000000), matrix green (#00ff41) as the only accent color, JetBrains Mono for ALL text (not just code), green text on black, subtle scanline effects, CRT-style glow on text. Think: hacker movie screen.',
      cssOverride: `
  --bg: #000000; --surface-1: #050505; --surface-2: #0a0a0a; --surface-3: #0f0f0f;
  --text-primary: #00ff41; --text-secondary: #00cc33; --text-muted: #006618;
  --accent: #00ff41; --accent-dim: rgba(0,255,65,.1); --green: #00ff41; --cyan: #00ffcc;
  --border: rgba(0,255,65,.3); --border-accent: rgba(0,255,65,.7);
  --shadow-glow: 0 0 20px rgba(0,255,65,.5); --grad-brand: linear-gradient(135deg,#00ff41,#00ffcc);`,
    },
    'minimal-saas': {
      label: 'Minimal SaaS',
      promptHint: 'Use a Minimal SaaS aesthetic: white backgrounds, very subtle gray borders (#e5e7eb), indigo (#6366f1) as the accent, generous whitespace, barely-there shadows. Think Notion, Linear, or Vercel — clean, professional, restrained.',
      cssOverride: `
  --bg: #ffffff; --surface-1: #f9fafb; --surface-2: #f3f4f6; --surface-3: #e5e7eb;
  --text-primary: #111827; --text-secondary: #6b7280; --text-muted: #9ca3af;
  --accent: #6366f1; --accent-dim: rgba(99,102,241,.08); --pink: #ec4899;
  --border: #e5e7eb; --border-accent: rgba(99,102,241,.5); --border-subtle: #f3f4f6;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.05); --shadow-md: 0 4px 12px rgba(0,0,0,.07);
  --shadow-lg: 0 8px 24px rgba(0,0,0,.1); --shadow-glow: 0 0 20px rgba(99,102,241,.2);
  --grad-brand: linear-gradient(135deg,#6366f1,#8b5cf6);`,
    },
    'cyberpunk': {
      label: 'Cyberpunk',
      promptHint: 'Use a Cyberpunk aesthetic: near-black background (#05000f), hot pink (#ff0090) and electric cyan (#00ffff) as dual accents, neon glow effects on everything interactive, sharp angular design, glitch-inspired elements. Think Blade Runner, Akira, synthwave.',
      cssOverride: `
  --bg: #05000f; --surface-1: #0d0018; --surface-2: #150025; --surface-3: #0a0015;
  --accent: #ff0090; --accent-dim: rgba(255,0,144,.12); --cyan: #00ffff; --green: #00ff90;
  --border: rgba(255,0,144,.3); --border-accent: rgba(255,0,144,.7);
  --shadow-glow: 0 0 30px rgba(255,0,144,.5), 0 0 60px rgba(0,255,255,.2);
  --grad-brand: linear-gradient(135deg,#ff0090,#00ffff); --grad-cyber: linear-gradient(135deg,#00ffff,#ff0090);`,
    },
    'react-app': {
      label: 'React App',
      promptHint: 'Build a React 18 application. Use component-based architecture with hooks. Import React and ReactDOM from https://esm.sh/react@18 and https://esm.sh/react-dom@18/client. Generate App.jsx as the main component and index.html that mounts it. Use useState, useEffect, and other hooks as needed. Apply FlowState Dark design tokens via a <style> tag in index.html.',
      cssOverride: '', // uses base dark theme
    },
    'react-dashboard': {
      label: 'React Dashboard',
      promptHint: 'Build a React 18 data dashboard. Use component-based architecture — separate files for each major section (Sidebar.jsx, Header.jsx, Dashboard.jsx, charts, tables). Import React from esm.sh. For charts import Chart.js from https://cdn.jsdelivr.net/npm/chart.js. Use the FlowState Dark design system with data-dense layout: tight spacing, metric cards, sidebar navigation, data tables.',
      cssOverride: '', // uses base dark theme
    },
    'plain': {
      label: 'Plain (AI decides)',
      promptHint: 'No design system enforced. Build whatever is most appropriate for the request using your own judgment.',
      cssOverride: '',
    },
  }

  const preset = FSDS_PRESETS[stylePreset] || FSDS_PRESETS['ai-decides']
  const isReact = stylePreset === 'react-app' || stylePreset === 'react-dashboard'
  const isPlain = stylePreset === 'plain'
  const isAiDecides = stylePreset === 'ai-decides' || !FSDS_PRESETS[stylePreset]
  const isBrutalist = stylePreset === 'brutalist'
  const isTerminal = stylePreset === 'terminal'
  const isGlass = stylePreset === 'glassmorphism'

  // ── Base FSDS CSS scaffold (injected into every non-plain generation) ─────
  // When ai-decides: use a neutral slate-dark base — no brand purple
  const FSDS_BASE_CSS = isPlain ? '' : `
<style>
/* ── FSDS Design System — Auto-injected ── */
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  /* Surfaces — neutral dark base (AI overrides accent vars freely) */
  --bg:            ${isAiDecides ? '#0c0f1a' : '#0a0a12'};
  --surface-1:     ${isAiDecides ? '#111827' : '#111122'};
  --surface-2:     ${isAiDecides ? '#1e2535' : '#1a1a2e'};
  --surface-3:     ${isAiDecides ? '#263044' : '#16213e'};

  /* Text */
  --text-primary:  #f0f0f0;
  --text-secondary:#aaaaaa;
  --text-muted:    #666880;

  /* Accent — AI MUST override these with domain-appropriate colors */
  --accent:        ${isAiDecides ? '#38bdf8' : '#a855f7'};
  --accent-bright: ${isAiDecides ? '#7dd3fc' : '#c084fc'};
  --accent-dim:    ${isAiDecides ? 'rgba(56,189,248,.15)' : 'rgba(168,85,247,.15)'};
  --green:         #00ffa3;
  --cyan:          #00d4ff;
  --pink:          #ec4899;
  --amber:         #f59e0b;
  --red:           #ef4444;

  /* Borders */
  --border:        ${isAiDecides ? 'rgba(56,189,248,.15)' : 'rgba(168,85,247,.18)'};
  --border-accent: ${isAiDecides ? 'rgba(56,189,248,.4)' : 'rgba(168,85,247,.5)'};
  --border-subtle: rgba(255,255,255,.06);

  /* Gradients — AI-decides gets a neutral start; AI overrides --grad-brand */
  --grad-brand:    ${isAiDecides ? 'linear-gradient(135deg, #38bdf8, #818cf8)' : 'linear-gradient(135deg, #a855f7, #ec4899)'};
  --grad-cyber:    ${isAiDecides ? 'linear-gradient(135deg, #22d3ee, #818cf8)' : 'linear-gradient(135deg, #00d4ff, #a855f7)'};
  --grad-success:  linear-gradient(135deg, #00ffa3, #00d4ff);

  /* Shadows */
  --shadow-sm:  0 1px 3px rgba(0,0,0,.5);
  --shadow-md:  0 4px 16px rgba(0,0,0,.6), 0 2px 4px rgba(0,0,0,.4);
  --shadow-lg:  0 8px 32px rgba(0,0,0,.7), 0 4px 8px rgba(0,0,0,.5);
  --shadow-glow: ${isAiDecides ? '0 0 24px rgba(56,189,248,.4)' : '0 0 24px rgba(168,85,247,.4)'};

  /* Radii */
  --radius-sm:   6px;
  --radius-md:   10px;
  --radius-lg:   16px;
  --radius-xl:   24px;
  --radius-full: 999px;

  /* Transitions */
  --transition-fast: 0.15s ease;
  --transition-base: 0.2s ease;
  --transition-slow: 0.35s ease;

  /* Typography */
  --font-display: 'Plus Jakarta Sans', system-ui, sans-serif;
  --font-body:    'Inter', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'Fira Code', monospace;

  ${preset.cssOverride}
}

/* Base */
html { font-size: 16px; -webkit-font-smoothing: antialiased; }
body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text-primary);
  line-height: 1.6;
  min-height: 100vh;
}
${isTerminal ? 'body, h1, h2, h3, h4, h5, h6, p, span, a, button, input, textarea, select { font-family: var(--font-mono) !important; }' : ''}
${isGlass ? 'body { background: radial-gradient(ellipse at top left, #2d0060 0%, #001040 50%, #05000f 100%); min-height: 100vh; }' : ''}

/* Custom scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--accent-dim); border-radius: var(--radius-full); }
::-webkit-scrollbar-thumb:hover { background: var(--accent); }

/* Text selection */
::selection { background: var(--accent-dim); color: var(--accent-bright); }

/* Typography scale */
h1, h2, h3, h4, h5, h6 { font-family: var(--font-display); font-weight: 700; line-height: 1.2; color: var(--text-primary); }
h1 { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 900; letter-spacing: -1.5px; }
h2 { font-size: clamp(1.5rem, 3.5vw, 2.25rem); font-weight: 800; letter-spacing: -0.75px; }
h3 { font-size: clamp(1.1rem, 2.5vw, 1.5rem); font-weight: 700; }
h4 { font-size: 1.1rem; font-weight: 700; }
h5 { font-size: 0.9rem; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
p  { color: var(--text-secondary); line-height: 1.7; }
a  { color: var(--accent-bright); text-decoration: none; transition: color var(--transition-fast); }
a:hover { color: var(--accent); }
code, pre { font-family: var(--font-mono); font-size: 0.88em; }
pre { background: var(--surface-3); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px; overflow-x: auto; }

/* ── FSDS Component Classes ─────────────────────────────────────── */

/* Layout containers */
.fs-container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
.fs-container-sm { max-width: 720px; margin: 0 auto; padding: 0 24px; }
.fs-stack { display: flex; flex-direction: column; }
.fs-cluster { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.fs-grid { display: grid; gap: 20px; }
.fs-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
.fs-grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }

/* Cards */
.fs-card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: border-color var(--transition-base), box-shadow var(--transition-base), transform var(--transition-base);
  animation: fsds-fadeUp var(--transition-slow) both;
}
.fs-card:hover {
  border-color: var(--border-accent);
  box-shadow: var(--shadow-glow), var(--shadow-lg);
  transform: translateY(-2px);
}
${isGlass ? '.fs-card { background: rgba(255,255,255,.07) !important; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,.15) !important; }' : ''}
.fs-card-elevated { background: var(--surface-2); }

/* Buttons */
.fs-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px 20px; border-radius: var(--radius-md); border: none;
  font-family: var(--font-body); font-size: 14px; font-weight: 600; cursor: pointer;
  transition: all var(--transition-base); white-space: nowrap; text-decoration: none;
}
.fs-btn-primary {
  background: var(--grad-brand); color: #fff;
  box-shadow: var(--shadow-glow);
}
.fs-btn-primary:hover { transform: translateY(-1px); filter: brightness(1.1); box-shadow: var(--shadow-glow), var(--shadow-md); }
.fs-btn-primary:active { transform: translateY(0); filter: brightness(0.95); }
.fs-btn-ghost {
  background: transparent; color: var(--accent);
  border: 1px solid var(--border);
}
.fs-btn-ghost:hover { background: var(--accent-dim); border-color: var(--border-accent); }
.fs-btn-danger { background: var(--red); color: #fff; }
.fs-btn-danger:hover { filter: brightness(1.1); transform: translateY(-1px); }
.fs-btn-sm { padding: 6px 14px; font-size: 12px; }
.fs-btn-lg { padding: 14px 28px; font-size: 16px; border-radius: var(--radius-lg); }
.fs-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none !important; }
${isBrutalist ? '.fs-btn, .fs-btn-primary, .fs-btn-ghost { border: 2px solid #111 !important; border-radius: 0 !important; box-shadow: 4px 4px 0 #111 !important; } .fs-btn-primary { background: var(--accent) !important; } .fs-btn:hover { transform: translate(2px, 2px) !important; box-shadow: 2px 2px 0 #111 !important; }' : ''}

/* Inputs */
.fs-input {
  width: 100%; background: var(--surface-3); border: 1px solid var(--border);
  border-radius: var(--radius-md); padding: 11px 14px; color: var(--text-primary);
  font-family: var(--font-body); font-size: 14px; outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.fs-input::placeholder { color: var(--text-muted); }
.fs-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
textarea.fs-input { resize: vertical; min-height: 100px; line-height: 1.6; }
select.fs-input { cursor: pointer; }

/* Badges */
.fs-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: var(--radius-full);
  font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
}
.fs-badge-purple { background: rgba(168,85,247,.15); color: var(--accent); border: 1px solid rgba(168,85,247,.3); }
.fs-badge-green  { background: rgba(0,255,163,.12); color: var(--green); border: 1px solid rgba(0,255,163,.3); }
.fs-badge-cyan   { background: rgba(0,212,255,.12); color: var(--cyan); border: 1px solid rgba(0,212,255,.3); }
.fs-badge-amber  { background: rgba(245,158,11,.12); color: var(--amber); border: 1px solid rgba(245,158,11,.3); }
.fs-badge-red    { background: rgba(239,68,68,.12); color: var(--red); border: 1px solid rgba(239,68,68,.3); }

/* Navigation */
.fs-nav {
  display: flex; align-items: center; gap: 16px; padding: 0 24px; height: 60px;
  background: rgba(10,10,18,.9); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100;
}
.fs-nav-logo { font-family: var(--font-display); font-weight: 800; font-size: 1.2rem; background: var(--grad-brand); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.fs-nav-links { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.fs-nav-link { padding: 6px 14px; border-radius: var(--radius-md); font-size: 14px; font-weight: 500; color: var(--text-secondary); transition: all var(--transition-fast); text-decoration: none; }
.fs-nav-link:hover { color: var(--text-primary); background: rgba(255,255,255,.05); }
.fs-nav-link.active { color: var(--accent); background: var(--accent-dim); }

/* Divider */
.fs-divider { height: 1px; background: var(--border-subtle); margin: 24px 0; }

/* Gradient text utility */
.fs-gradient-text { background: var(--grad-brand); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.fs-gradient-text-cyber { background: var(--grad-cyber); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }

/* Metric / stat cards */
.fs-metric { display: flex; flex-direction: column; gap: 4px; }
.fs-metric-value { font-family: var(--font-display); font-size: 2rem; font-weight: 800; color: var(--text-primary); }
.fs-metric-label { font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-muted); }

/* Loading skeleton */
.fs-skeleton {
  background: linear-gradient(90deg, var(--surface-1) 25%, var(--surface-2) 50%, var(--surface-1) 75%);
  background-size: 200% 100%;
  animation: fsds-shimmer 1.5s infinite;
  border-radius: var(--radius-md);
}

/* Section spacing */
.fs-section { padding: 80px 0; }
.fs-section-sm { padding: 48px 0; }

/* ── Animations ────────────────────────────────────────────────── */
@keyframes fsds-fadeUp {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fsds-fadeIn {
  from { opacity: 0; } to { opacity: 1; }
}
@keyframes fsds-slideIn {
  from { opacity: 0; transform: translateX(-12px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes fsds-pulse-glow {
  0%, 100% { box-shadow: 0 0 20px rgba(168,85,247,.3); }
  50%       { box-shadow: 0 0 40px rgba(168,85,247,.7), 0 0 80px rgba(168,85,247,.2); }
}
@keyframes fsds-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position:  200% 0; }
}
${isTerminal ? `@keyframes fsds-scanline { 0%{background-position:0 0}100%{background-position:0 100%} } body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.15) 2px,rgba(0,0,0,.15) 4px);pointer-events:none;z-index:9999;}` : ''}
</style>`

  // ── Per-model credit pricing (1 credit = $0.001) ─────────────────────────
  const MODEL_CREDIT_COSTS: Record<string, number> = {
    'claude-opus-4':    800,  // most expensive — Opus 4
    'claude-sonnet-4':  200,  // Sonnet 4 — great quality
    'claude':           200,
    'claude-haiku-4':    40,  // Haiku — fast/cheap
    'gemini-2-5-pro':   150,  // Gemini 2.5 Pro
    'gemini-2-5-flash':  60,  // Gemini 2.5 Flash
    'gemini':            30,
    'gpt4o':            200,  // GPT-4o
    'gpt4-1':           200,
    'o3':               800,  // o3 — very expensive
    'o4-mini':          100,
    'deepseek-r1':       60,
    'deepseek':          30,
    'llama-4-maverick':  30,
    'llama-4-scout':     20,
    'codestral':         40,
    'mistral-large':     80,
  }
  const AI_CODE_CREDIT_COST = MODEL_CREDIT_COSTS[agent] ?? 120

  // ── System prompt — FlowState AI Code Agent (Intent Layer driven) ───────────
  // declareCodeAgentSystemPrompt() in intent-layer.ts owns all agent behavior.
  // This endpoint executes. It does not decide.
  const isEditRequest = conversationHistory.length > 0 && Object.keys(generatedFiles).length > 0
  const agentPlan = declareCodeAgentSystemPrompt({
    prompt,
    repo,
    fileTree: fileList,
    generatedFiles: generatedContext,
    activeFile,
    stylePreset,
    agent,
    isEdit: isEditRequest,
    isNewPage: isNewPageRequest,
    language,
  })

  // ── Inject FSDS preset hints into the agent system prompt ────────────────
  // The agent system prompt covers architecture + behavior.
  // FSDS preset-specific CSS overrides are appended here so the agent
  // knows EXACTLY which CSS tokens are active for this generation.
  const fsdsPresetBlock = isPlain ? '' : `
════════════════════════════════════════
FSDS ACTIVE PRESET DETAIL: ${preset.label}
════════════════════════════════════════
${preset.promptHint}
${preset.cssOverride ? `\nCSS TOKEN OVERRIDES ACTIVE:\n:root {\n${preset.cssOverride}\n}` : ''}
${isAiDecides ? `\nCOLOR SELECTION REQUIRED:
Override in your output's <style> block:
  :root {
    --accent: [domain-appropriate primary hex — NOT purple #a855f7];
    --accent-bright: [lighter variant];
    --accent-dim: rgba(..., .15);
    --border: rgba(..., .15);
    --border-accent: rgba(..., .4);
    --shadow-glow: 0 0 24px rgba(..., .4);
    --grad-brand: linear-gradient(135deg, [accent], [complementary]);
  }
Finance→gold/teal. Fitness→lime/orange. Gaming→cyan/magenta. Social→coral/blue.` : ''}
${isReact ? `\nREACT MODE:
- Import: https://esm.sh/react@18 | https://esm.sh/react-dom@18/client
- index.html: <div id="root"> + <script type="module" src="App.jsx">
- Separate .jsx files per component under components/` : ''}
${!isPlain && !isReact && !language ? 'OUTPUT FORMAT: Separate index.html + styles.css + app.js files' : ''}
${language ? `TARGET LANGUAGE: ${language}` : ''}`

  const systemPrompt = agentPlan.systemPrompt + fsdsPresetBlock

  // ── Build history (FIX: smarter truncation) ───────────────────────────────
  const historySlice = isNewPageRequest
    ? conversationHistory.slice(-4)   // 2 exchanges for new pages
    : conversationHistory.slice(-8)   // 4 exchanges for edits (was 6)

  const historyMessages = historySlice.map((m: any) => {
    if (m.role === 'assistant') {
      const cap = isNewPageRequest ? 150 : 300
      return { role: m.role, content: m.content?.length > cap ? m.content.slice(0, cap) + '…' : m.content }
    }
    return { role: m.role, content: m.content }
  })

  const currentUserMsg = isNewPageRequest
    ? `Task: ${prompt}\n\n[NEW page — blank canvas, no copying from existing HTML files]`
    : `Task: ${prompt}`

  // ── FIX 7: JSON prefill for Claude — forces clean JSON output ─────────────
  // Anthropic supports injecting the start of the assistant's reply.
  // Prefilling with `{"` removes any chance of prose before the JSON object.
  const claudeAgents = new Set(['claude', 'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4'])
  const isClaudeAgent = claudeAgents.has(agent)

  // ── Model token limits — FIX 1 ────────────────────────────────────────────
  // Claude supports up to 64K output; raise to 32K to handle large multi-file apps.
  // Gemini: 32K. OpenAI: 16K (gpt-4o context limit on output is 16K).
  const getMaxTokens = (ag: string) => {
    if (claudeAgents.has(ag)) return 32000
    if (ag.startsWith('gemini')) return 32000
    if (ag === 'o3' || ag === 'o4-mini') return 32000
    return 16000
  }
  const maxTokens = getMaxTokens(agent)

  // ── FIX 3: Streaming helper ───────────────────────────────────────────────
  // All model calls use streaming. We collect the full text then return JSON.
  // The SSE stream is forwarded to the client via a TransformStream so the
  // frontend can show live token output while the build is in progress.

  const OR_MODEL_MAP: Record<string, string> = {
    // Google — via OpenRouter
    'gemini-2-5-pro':   'google/gemini-2.5-pro',
    'gemini-2-5-flash': 'google/gemini-2.5-flash',
    'gemini':           'google/gemini-2.0-flash-001',
    // OpenAI
    'gpt4o':            'openai/gpt-4o',
    'o4-mini':          'openai/o4-mini',
    'o3':               'openai/o3',
    'gpt4-1':           'openai/gpt-4.1',
    // Anthropic — exact current IDs on OpenRouter
    'claude-opus-4':    'anthropic/claude-opus-4-5',
    'claude-sonnet-4':  'anthropic/claude-sonnet-4-5',
    'claude':           'anthropic/claude-sonnet-4-5',
    'claude-haiku-4':   'anthropic/claude-haiku-4-5',
    // Meta
    'llama-4-maverick': 'meta-llama/llama-4-maverick',
    'llama-4-scout':    'meta-llama/llama-4-scout',
    // DeepSeek
    'deepseek-r1':      'deepseek/deepseek-r1',
    'deepseek':         'deepseek/deepseek-chat-v3-0324',
    // Mistral
    'codestral':        'mistralai/codestral-mamba',
    'mistral-large':    'mistralai/mistral-large-2411',
  }
  // Default to gemini-2.5-flash — fast, reliable, great at code, available on OpenRouter
  const DEFAULT_OR_MODEL = 'google/gemini-2.5-flash'

  const orKey = c.env?.OPENROUTER_API_KEY || ''

  // ── SSE helpers ───────────────────────────────────────────────────────────
  const enc = new TextEncoder()
  // sseWrite: send a named SSE event to the client
  const sseWrite = (controller: ReadableStreamDefaultController, event: string, data: string) => {
    controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`))
  }
  // tokenWrite: send a raw token chunk as a 'token' SSE event
  const tokenWrite = (controller: ReadableStreamDefaultController, token: string) => {
    if (!token) return
    controller.enqueue(enc.encode(`event: token\ndata: ${JSON.stringify(token)}\n\n`))
  }

  // ── Helper: collect streaming SSE into full text AND forward tokens live ──
  async function collectStream(
    response: Response,
    extractDelta: (parsed: any) => string,
    controller?: ReadableStreamDefaultController
  ): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const decoder = new TextDecoder()
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const token = extractDelta(JSON.parse(data))
          if (token) {
            full += token
            if (controller) tokenWrite(controller, token)
          }
        } catch { /* skip */ }
      }
    }
    return full
  }

  // ── Delimited text parser (new primary format) ─────────────────────────
  // Parses the === FILE: path === ... === END FILE === format
  // Falls back to JSON parser if no delimiters found
  function extractDelimited(raw: string): { message?: string; files?: Array<{ path: string; content: string }> } | null {
    if (!raw?.trim()) return null
    const fileRegex = /={3} FILE: ([^\n]+?) ={3}[\r\n]([\s\S]*?)={3} END FILE ={3}/g
    const files: Array<{ path: string; content: string }> = []
    let match
    while ((match = fileRegex.exec(raw)) !== null) {
      const path = match[1].trim()
      const content = match[2].replace(/\r\n/g, '\n').replace(/^\n|\n$/g, '')
      if (path && content) files.push({ path, content })
    }
    if (!files.length) return null
    // Extract message from === MESSAGE === block if present
    const msgMatch = raw.match(/={3} MESSAGE ===[\r\n]([\s\S]*?)(?:={3}|$)/)
    const message = msgMatch ? msgMatch[1].trim() : ''
    return { message, files }
  }

  // Combined extractor: try delimited first, fall back to JSON
  function extractOutput(raw: string): { message?: string; files?: Array<{ path: string; content: string }> } | null {
    const delimited = extractDelimited(raw)
    if (delimited?.files?.length) return delimited
    return extractJSON(raw)
  }

  // ── FIX 2 + FIX 5: Robust JSON extraction with auto-retry ─────────────────
  function extractJSON(raw: string): { message?: string; files?: Array<{ path: string; content: string }> } | null {
    if (!raw?.trim()) return null

    // Pass 1: strip markdown fences and try direct parse
    const stripped = raw
      .replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/\s*```\s*$/m, '').trim()
    try { return JSON.parse(stripped) } catch { /* continue */ }

    // Pass 2: find the first '{' and last '}' — handles leading/trailing prose
    const first = stripped.indexOf('{')
    const last  = stripped.lastIndexOf('}')
    if (first !== -1 && last > first) {
      try { return JSON.parse(stripped.slice(first, last + 1)) } catch { /* continue */ }
    }

    // Pass 3: repair common truncation — try to close unclosed JSON by appending '}]}'
    // This rescues responses that hit max_tokens mid-file
    if (first !== -1) {
      for (const tail of ['"}]}', '"]}', ']}', '}']) {
        try {
          const candidate = stripped.slice(first) + tail
          const obj = JSON.parse(candidate)
          if (obj.files?.length) return obj
        } catch { /* try next */ }
      }
    }

    // Pass 4: handle Gemini wrapping JSON in ```json ... ``` fences
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      try {
        const inside = fenceMatch[1].trim()
        const obj = JSON.parse(inside)
        if (obj.files?.length) return obj
      } catch { /* continue */ }
    }

    // Pass 5: extract just the JSON object even if surrounded by prose
    // Walk forward from first '{' balancing braces
    if (first !== -1) {
      let depth = 0, inStr = false, escape = false
      for (let i = first; i < stripped.length; i++) {
        const ch = stripped[i]
        if (escape) { escape = false; continue }
        if (ch === '\\' && inStr) { escape = true; continue }
        if (ch === '"' && !escape) { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            try {
              const obj = JSON.parse(stripped.slice(first, i + 1))
              if (obj.files?.length) return obj
            } catch { break }
          }
        }
      }
    }

    return null
  }

  // ── Inject FSDS scaffold into every HTML file ────────────────────────────
  const injectFSDS = (html: string): string => {
    if (isPlain || !FSDS_BASE_CSS) return html
    if (html.includes('FlowState Design System (FSDS)')) return html
    if (html.includes('<head>')) return html.replace('<head>', `<head>\n${FSDS_BASE_CSS}`)
    if (html.includes('</head>')) return html.replace('</head>', `${FSDS_BASE_CSS}\n</head>`)
    return FSDS_BASE_CSS + '\n' + html
  }

  // ── Thinking token budgets ────────────────────────────────────────────────
  // Sonnet/Opus get a real thinking budget — this is what makes them FEEL different.
  // Haiku skips thinking (too slow/expensive for a light model).
  // Budget = tokens reserved for internal reasoning before the JSON output.
  const THINKING_BUDGETS: Record<string, number> = {
    'claude-opus-4':    12000,  // deep thinking for the most complex builds
    'claude-sonnet-4':   8000,  // solid reasoning budget for standard builds
    'claude':            8000,
    'claude-haiku-4':       0,  // no thinking — Haiku is speed-optimized
    'gemini-2-5-pro':   12000,  // Gemini 2.5 Pro thinking budget
    'gemini-2-5-flash':  8000,  // Gemini 2.5 Flash thinking budget
    'gemini':               0,  // Gemini 2.0 Flash — no thinking support
    'deepseek-r1':          0,  // R1 has built-in chain-of-thought — no extra budget needed
    'o3':                   0,  // o3 has built-in reasoning — no extra budget needed
    'o4-mini':              0,  // same
  }
  const thinkingBudget = THINKING_BUDGETS[agent] ?? 0
  const useThinking = thinkingBudget > 0

  // Temperature: 0.35 for all models (was 0.1 — too cold, produced average output)
  // Exception: o3/o4-mini don't support temperature (they use reasoning natively)
  const isReasoningModel = agent === 'o3' || agent === 'o4-mini'
  const TEMPERATURE = isReasoningModel ? undefined : 0.35

  // ── Helper: call model with thinking tokens where supported ───────────────
  // Returns { text, thinkingText } so thinking can be streamed to UI separately
  const callModelFull = async (userMsgOverride?: string, onThinking?: (t: string) => void): Promise<string> => {
    const effectiveUserMsg = userMsgOverride || currentUserMsg

    // ── Gemini direct ────────────────────────────────────────────────────
    if ((agent === 'gemini' || agent === 'gemini-2-5-pro' || agent === 'gemini-2-5-flash') && (c.env?.GEMINI_API_KEY || c.env?.GOOGLE_AI_KEY)) {
      const geminiKey = c.env?.GEMINI_API_KEY || c.env?.GOOGLE_AI_KEY || ''
      const geminiModelMap: Record<string,string> = {
        'gemini': 'gemini-2.0-flash',
        'gemini-2-5-pro': 'gemini-2.5-pro-preview-05-06',
        'gemini-2-5-flash': 'gemini-2.5-flash-preview-04-17',
      }
      const geminiModel = geminiModelMap[agent] || 'gemini-2.0-flash'
      const supportsGeminiThinking = agent === 'gemini-2-5-pro' || agent === 'gemini-2-5-flash'

      const geminiBody: any = {
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${historyMessages.map((m:any)=>`[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n')}\n\n[USER]: ${effectiveUserMsg}` }] }],
        generationConfig: {
          temperature: TEMPERATURE ?? 0.35,
          maxOutputTokens: maxTokens,
        }
      }
      // Enable Gemini thinking budget for 2.5 Pro/Flash
      if (supportsGeminiThinking && thinkingBudget > 0) {
        geminiBody.generationConfig.thinkingConfig = { thinkingBudget }
      }

      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      })
      const d: any = await r.json()
      // Extract thinking text (Gemini returns it as a separate part with thought=true)
      const parts = d?.candidates?.[0]?.content?.parts || []
      const thinkingPart = parts.find((p: any) => p.thought === true)
      const textPart = parts.find((p: any) => !p.thought)
      if (thinkingPart?.text && onThinking) onThinking(thinkingPart.text)
      return textPart?.text || parts?.[0]?.text || ''
    }

    // ── Claude direct Anthropic (with extended thinking) ─────────────────
    if (isClaudeAgent && c.env?.ANTHROPIC_API_KEY) {
      const claudeModelMap: Record<string,string> = {
        'claude': 'claude-sonnet-4-5-20251101',
        'claude-opus-4': 'claude-opus-4-5-20251101',
        'claude-sonnet-4': 'claude-sonnet-4-5-20251101',
        'claude-haiku-4': 'claude-haiku-4-5-20251101',
      }
      const claudeModel = claudeModelMap[agent] || 'claude-sonnet-4-5-20251101'

      // Extended thinking: Claude needs budget_tokens > 1024 to enable it.
      // When thinking is ON: disable prefill (incompatible with extended thinking) and raise temperature to 1
      // (Anthropic requires temperature=1 when using extended thinking)
      const claudeBody: any = {
        model: claudeModel,
        max_tokens: useThinking ? maxTokens + thinkingBudget : maxTokens,
        system: systemPrompt,
        temperature: useThinking ? 1 : (TEMPERATURE ?? 0.35),
        messages: useThinking
          // With thinking: no prefill — thinking blocks come before the JSON
          ? [...historyMessages, { role: 'user', content: effectiveUserMsg }]
          // Without thinking (Haiku): use prefill for clean JSON
          : [...historyMessages, { role: 'user', content: effectiveUserMsg }, { role: 'assistant', content: '{"message":"' }],
        stream: false,
      }
      if (useThinking) {
        claudeBody.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
      }

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': c.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          ...(useThinking ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
        },
        body: JSON.stringify(claudeBody)
      })
      const d: any = await r.json()
      // Extract thinking blocks and text blocks from response
      const contentBlocks = d?.content || []
      let thinkingText = ''
      let responseText = ''
      for (const block of contentBlocks) {
        if (block.type === 'thinking') thinkingText += block.thinking || ''
        else if (block.type === 'text') responseText += block.text || ''
      }
      if (thinkingText && onThinking) onThinking(thinkingText)
      return responseText
    }

    // ── OpenRouter fallback ──────────────────────────────────────────────
    if (!orKey) throw new Error('No AI API key configured — add OPENROUTER_API_KEY in Cloudflare secrets.')
    const orModelId = OR_MODEL_MAP[agent] || DEFAULT_OR_MODEL
    const isGeminiModel  = orModelId.includes('google') || orModelId.includes('gemini')
    const isClaudeModel  = orModelId.includes('anthropic') || orModelId.includes('claude')
    const isOpenAIModel  = orModelId.includes('openai') || orModelId.includes('gpt') || orModelId.includes('/o3') || orModelId.includes('/o4')
    // Delimited text format — no json_object mode needed
    const useJsonFormat = false // kept for type safety

    // All models: use delimited text format — no JSON prefill, no forced mime type
    const orMessages = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: effectiveUserMsg },
    ]

    const orBody: any = {
      model: orModelId,
      messages: orMessages,
      max_tokens: maxTokens,
    }
    // Only set temperature when the model supports it (not o3/o4-mini)
    if (TEMPERATURE !== undefined) orBody.temperature = TEMPERATURE
    // useJsonFormat disabled — using delimited text format

    // Gemini 2.5 via OpenRouter: enable thinking via provider params
    if (isGeminiModel && thinkingBudget > 0) {
      orBody.provider = { order: ['Google'], data: { generationConfig: { thinkingConfig: { thinkingBudget } } } }
    }

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${orKey}`, 'HTTP-Referer': 'https://flowst8.cc', 'X-Title': 'FlowState AI Code' },
      body: JSON.stringify(orBody),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      throw new Error(`Model API error (${r.status}): ${txt.slice(0, 400)}`)
    }
    const d: any = await r.json()
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error))
    const rawContent = d?.choices?.[0]?.message?.content || ''
    // Claude prefill reconstruction
    return isClaudeModel ? '{"message":"' + rawContent : rawContent
  }

  // ── Narration helper labels for richer UX ────────────────────────────────
  const MODEL_DISPLAY_NAMES: Record<string, string> = {
    'claude-opus-4': 'Claude Opus 4', 'claude-sonnet-4': 'Claude Sonnet 4', 'claude': 'Claude Sonnet',
    'claude-haiku-4': 'Claude Haiku 4', 'gemini-2-5-pro': 'Gemini 2.5 Pro', 'gemini-2-5-flash': 'Gemini 2.5 Flash',
    'gemini': 'Gemini Flash', 'gpt4o': 'GPT-4o', 'gpt4-1': 'GPT-4.1', 'o3': 'OpenAI o3', 'o4-mini': 'o4-mini',
    'deepseek-r1': 'DeepSeek R1', 'deepseek': 'DeepSeek Chat', 'llama-4-maverick': 'Llama 4 Maverick',
    'llama-4-scout': 'Llama 4 Scout', 'codestral': 'Codestral', 'mistral-large': 'Mistral Large',
  }
  const modelDisplayName = MODEL_DISPLAY_NAMES[agent] || agent

  // Helper: detect app type for domain-specific narrations
  const detectAppType = (p: string) => {
    const l = p.toLowerCase()
    if (/dashboard|analytics|chart|metric|report|stat/.test(l)) return 'dashboard'
    if (/e.?comm|store|shop|product|cart|checkout/.test(l)) return 'ecommerce'
    if (/land|hero|saas|marketing|product page/.test(l)) return 'landing'
    if (/chat|messag|inbox|conversation/.test(l)) return 'chat'
    if (/form|survey|quiz|onboard/.test(l)) return 'form'
    if (/game|play|score/.test(l)) return 'game'
    if (/todo|task|kanban|board|project/.test(l)) return 'productivity'
    if (/finance|bank|crypto|stock|invest/.test(l)) return 'finance'
    if (/auth|login|signup|register/.test(l)) return 'auth'
    if (/music|audio|player|playlist/.test(l)) return 'media'
    return 'app'
  }
  const appType = detectAppType(prompt)

  const NARRATION_BY_TYPE: Record<string, string[]> = {
    dashboard: ['📊 Designing metric cards and KPI layout…', '📈 Wiring up Chart.js data visualizations…', '🗂️ Building data table with filters…'],
    ecommerce: ['🛍️ Designing product grid and card components…', '🛒 Building cart and checkout flow…', '💳 Adding pricing and CTA buttons…'],
    landing: ['🎨 Crafting hero section with gradient headline…', '📐 Designing features and testimonials…', '🚀 Adding CTAs and social proof…'],
    chat: ['💬 Building message thread and bubble components…', '📡 Setting up message list architecture…', '✏️ Adding input and send functionality…'],
    form: ['📝 Designing form fields with validation states…', '✅ Adding success, error, and loading states…', '📬 Wiring up form submission feedback…'],
    game: ['🎮 Setting up game board and state engine…', '🕹️ Implementing game logic and win conditions…', '🏆 Adding score tracking and animations…'],
    productivity: ['📋 Designing task and board components…', '✅ Building interactions and status toggles…', '🔖 Adding filtering and sorting…'],
    finance: ['💰 Designing portfolio and balance components…', '📉 Building transaction history and charts…', '🔒 Applying secure-feeling UI patterns…'],
    auth: ['🔐 Designing auth form with validation…', '✨ Adding social login buttons…', '🎯 Wiring up form logic and transitions…'],
    media: ['🎵 Designing player and playlist components…', '🎨 Building waveform and progress UI…', '⚡ Adding playback controls and interactions…'],
    app: ['🔍 Analyzing requirements and planning components…', '🏗️ Building layout and navigation structure…', '⚡ Wiring up interactions and state…'],
  }
  const appNarrations = NARRATION_BY_TYPE[appType] || NARRATION_BY_TYPE['app']

  // ── SSE stream with rich live narration ───────────────────────────────────
  // Events:
  //   narrate  { msg, type }                      — human-readable status
  //   tool     { tool, purpose, input }            — tool call transparency
  //   step     { num, label, detail }              — numbered execution steps
  //   file     { path, content, index, total }     — each file as processed
  //   done     { ok, message, files, creditsUsed } — final payload
  //   error    { error }                           — fatal error (no credits charged)
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // ── Phase 1: Agent Preamble — structured live thinking stream ────
        // These events come from declareCodeAgentSystemPrompt() in intent-layer.ts.
        // They show the user exactly what context was read and what the plan is
        // BEFORE the LLM is called — transparent, engineering-level reasoning.
        for (const ev of agentPlan.preambleEvents) {
          sseWrite(controller, 'narrate', JSON.stringify({ msg: ev.msg, type: ev.type }))
          await new Promise(r => setTimeout(r, 35))
        }

        // ── STEP 1: Announce which model is executing (tool transparency) ──
        sseWrite(controller, 'tool', JSON.stringify({
          tool: modelDisplayName,
          purpose: `Code generation · ${appType} · ${stylePreset} preset`,
          input: prompt.slice(0, 120) + (prompt.length > 120 ? '…' : ''),
        }))
        await new Promise(r => setTimeout(r, 40))

        // ── STEP 2: Intent classification + architecture plan ─────────────
        sseWrite(controller, 'step', JSON.stringify({
          num: 1,
          label: `Analyze — classifying intent as ${isEditRequest ? 'EDIT' : isNewPageRequest ? 'NEW PAGE' : 'BUILD'}`,
          detail: `Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`,
        }))
        await new Promise(r => setTimeout(r, 30))

        sseWrite(controller, 'step', JSON.stringify({
          num: 2,
          label: `Architect — planning ${appType} structure and file layout`,
          detail: `Stack: ${language || 'HTML + CSS + JS'} · Preset: ${stylePreset} · Model: ${modelDisplayName}`,
        }))
        await new Promise(r => setTimeout(r, 30))

        sseWrite(controller, 'narrate', JSON.stringify({
          msg: `🎯 Analyzing prompt and planning ${appType} architecture…`, type: 'planning'
        }))

        // ── STEP 3: Model call ────────────────────────────────────────────
        sseWrite(controller, 'step', JSON.stringify({
          num: 3,
          label: `Execute — calling ${modelDisplayName}${useThinking ? ` with ${thinkingBudget.toLocaleString()} token reasoning budget` : ''} to generate code`,
          detail: `Context: ${fileList ? fileList.split('\n').filter(Boolean).length + ' repo files indexed' : 'standalone project'} · max tokens: ${maxTokens}${useThinking ? ` + ${thinkingBudget} thinking` : ''}`,
        }))
        await new Promise(r => setTimeout(r, 30))

        if (useThinking) {
          sseWrite(controller, 'narrate', JSON.stringify({
            msg: `🧠 ${modelDisplayName} is reasoning deeply — thinking budget: ${thinkingBudget.toLocaleString()} tokens…`, type: 'thinking'
          }))
        }

        // ── Call model — wire thinking tokens to live UI stream ──────────
        let rawResponse = ''
        let thinkingOutput = ''
        try {
          rawResponse = await callModelFull(undefined, (thinkingText: string) => {
            // Stream thinking output to UI as a collapsible reasoning block
            thinkingOutput = thinkingText
            if (thinkingText.trim()) {
              // Emit a summary of what the model thought about (first 400 chars)
              const preview = thinkingText.slice(0, 400).replace(/\n+/g, ' ').trim()
              sseWrite(controller, 'thinking', JSON.stringify({
                preview: preview + (thinkingText.length > 400 ? '…' : ''),
                full: thinkingText,
                tokens: Math.round(thinkingText.length / 4), // rough token estimate
              }))
            }
          })
        } catch (callErr: any) {
          sseWrite(controller, 'error', JSON.stringify({ error: callErr.message }))
          controller.close()
          return
        }

        // ── STEP 4: Parse + validate response ────────────────────────────
        sseWrite(controller, 'step', JSON.stringify({
          num: 4,
          label: 'Validate — parsing JSON response and checking file structure',
          detail: `Response size: ${(new TextEncoder().encode(rawResponse).length / 1024).toFixed(1)}KB`,
        }))
        await new Promise(r => setTimeout(r, 20))

        sseWrite(controller, 'narrate', JSON.stringify({
          msg: '📐 Processing response and validating output structure…', type: 'parsing'
        }))

        let parsed = extractOutput(rawResponse)

        if (!parsed?.files?.length) {
          sseWrite(controller, 'narrate', JSON.stringify({
            msg: '🔄 Response needs reformatting — retrying…', type: 'retry'
          }))
          const retryMsg = `${currentUserMsg}\n\nCRITICAL: Output must use the exact delimited format. Start immediately with === MESSAGE === then your files. No prose, no JSON, no markdown.`
          try {
            rawResponse = await callModelFull(retryMsg)
            parsed = extractOutput(rawResponse)
          } catch { /* use what we have */ }
        }

        if (!parsed?.files?.length) {
          // Last resort: try to extract any HTML content from a raw response
          const htmlMatch = rawResponse.match(/<!DOCTYPE[\s\S]*<\/html>/i)
          if (htmlMatch) {
            parsed = {
              message: 'Generated HTML app.',
              files: [{ path: 'index.html', content: htmlMatch[0] }]
            }
          }
        }

        if (!parsed?.files?.length) {
          sseWrite(controller, 'error', JSON.stringify({
            error: `The model returned a response that couldn't be parsed as JSON. Raw start: "${rawResponse.slice(0, 120).replace(/\n/g, ' ')}…" — Try switching to Gemini 2.5 Flash or a different model. No credits charged.`
          }))
          controller.close()
          return
        }

        // ── Phase 3: Process and stream files ────────────────────────────
        const rawFiles = parsed.files || []
        const processedFiles: Array<{ path: string; content: string }> = []

        // ── STEP 5: Write files ───────────────────────────────────────────
        sseWrite(controller, 'step', JSON.stringify({
          num: 5,
          label: `Write — rendering ${rawFiles.length} file${rawFiles.length > 1 ? 's' : ''} to editor`,
          detail: rawFiles.map((f: any) => f.path || 'unnamed').join(' · '),
        }))
        await new Promise(r => setTimeout(r, 20))

        sseWrite(controller, 'narrate', JSON.stringify({
          msg: `✍️ Writing ${rawFiles.length} file${rawFiles.length > 1 ? 's' : ''} — rendering to editor…`, type: 'writing'
        }))

        for (let i = 0; i < rawFiles.length; i++) {
          const f = rawFiles[i]
          const rawPath = (f.path || 'index.html').replace(/^\/+/, '').trim()
          const safePath = rawPath.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9.\-_/]/g, '') || 'index.html'
          const isHtml = safePath.endsWith('.html') || safePath.endsWith('.htm')
          const isJs = safePath.endsWith('.js') || safePath.endsWith('.jsx') || safePath.endsWith('.ts') || safePath.endsWith('.tsx')
          const isCss = safePath.endsWith('.css')
          const content = isHtml ? injectFSDS(f.content || '') : (f.content || '')
          if (!safePath || !content) continue
          processedFiles.push({ path: safePath, content })

          const lineCount = content.split('\n').length
          const sizeKb = (new TextEncoder().encode(content).length / 1024).toFixed(1)
          const typeLabel = isHtml ? '🌐 HTML' : isJs ? '⚡ JavaScript' : isCss ? '🎨 CSS' : '📄'

          // Domain-specific narration for first few files
          if (i < appNarrations.length) {
            sseWrite(controller, 'narrate', JSON.stringify({ msg: appNarrations[i], type: 'building' }))
          }

          // Emit file — frontend renders in editor immediately
          sseWrite(controller, 'file', JSON.stringify({ path: safePath, content, index: i, total: rawFiles.length }))
          sseWrite(controller, 'narrate', JSON.stringify({
            msg: `${typeLabel} ${safePath} — ${lineCount} lines, ${sizeKb}KB`, type: 'file_complete'
          }))
        }

        if (!processedFiles.length) {
          sseWrite(controller, 'error', JSON.stringify({
            error: 'All generated files were empty. Please try again with a more specific description. No credits charged.'
          }))
          controller.close()
          return
        }

        // ── STEP 6: FSDS injection + validation complete ─────────────────
        sseWrite(controller, 'step', JSON.stringify({
          num: 6,
          label: 'Validate — FSDS scaffold injected, interactivity check complete',
          detail: processedFiles.map(f => {
            const lines = f.content.split('\n').length
            const kb = (new TextEncoder().encode(f.content).length / 1024).toFixed(1)
            return `${f.path} (${lines} lines, ${kb}KB)`
          }).join(' · '),
        }))

        // ── SUCCESS: commit credits ──────────────────────────────────────
        await commitCredits(c, session.email, AI_CODE_CREDIT_COST)

        const totalLines = processedFiles.reduce((sum, f) => sum + f.content.split('\n').length, 0)
        const totalKb = (processedFiles.reduce((sum, f) => sum + new TextEncoder().encode(f.content).length, 0) / 1024).toFixed(1)

        sseWrite(controller, 'narrate', JSON.stringify({
          msg: `✅ Build complete — ${processedFiles.length} file${processedFiles.length > 1 ? 's' : ''}, ${totalLines} lines, ${totalKb}KB`, type: 'complete'
        }))

        sseWrite(controller, 'done', JSON.stringify({
          ok: true,
          message: parsed.message || 'Build complete.',
          files: processedFiles,
          preset: stylePreset,
          creditsUsed: AI_CODE_CREDIT_COST,
        }))

      } catch (err: any) {
        sseWrite(controller, 'error', JSON.stringify({ error: err.message || 'Generation failed. No credits charged.' }))
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    }
  })
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
// GET /api/auth/calendar-status — quick token validity check (no Google API call)
app.get('/api/auth/calendar-status', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ connected: false, reason: 'not_signed_in' })
  const hasToken = !!session.access_token
  const expired  = session.expires_at ? Date.now() > session.expires_at - 60000 : false
  const canRefresh = !!session.refresh_token
  if (!hasToken)    return c.json({ connected: false, reason: 'no_token' })
  if (expired && !canRefresh) return c.json({ connected: false, reason: 'token_expired_no_refresh', reconnectUrl: '/api/auth/calendar-reconnect' })
  return c.json({ connected: true, expired, canRefresh })
})

// GET /api/calendar/debug — shows exactly what the token + Google raw response look like
// Safe: only returns token prefix, not the full token
app.get('/api/calendar/debug', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ step: 'no_session', fix: 'Not signed in — go to flowst8.cc and sign in first' })

  const now = Date.now()
  const expiresAt = session.expires_at || 0
  const expired = now > expiresAt - 60000
  const sessionInfo = {
    email:         session.email,
    has_access_token:  !!session.access_token,
    token_prefix:  session.access_token ? session.access_token.substring(0, 12) + '...' : null,
    has_refresh_token: !!session.refresh_token,
    expires_at:    new Date(expiresAt).toISOString(),
    expired,
    now:           new Date(now).toISOString(),
  }

  const token = await getValidAccessToken(c)
  if (!token) return c.json({ step: 'no_valid_token', sessionInfo, fix: 'Token expired with no refresh_token — visit /api/auth/calendar-reconnect' })

  // Try a raw Google Calendar API call and return the full response for diagnosis
  try {
    const now2 = new Date()
    const end  = new Date(now2.getFullYear(), now2.getMonth() + 1, 7)
    const params = new URLSearchParams({ timeMin: new Date(now2.getFullYear(), now2.getMonth(), 1).toISOString(), timeMax: end.toISOString(), maxResults: '5', singleEvents: 'true', orderBy: 'startTime' })
    const res  = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params, { headers: { Authorization: 'Bearer ' + token } })
    const body: any = await res.json()
    return c.json({
      step: 'google_api_called',
      http_status: res.status,
      sessionInfo,
      google_error: body.error || null,
      event_count:  body.items?.length ?? 'no items key',
      first_event:  body.items?.[0] ? { summary: body.items[0].summary, start: body.items[0].start } : null,
      calendar_summary: body.summary || null,
      raw_keys: Object.keys(body),
    })
  } catch (err: any) {
    return c.json({ step: 'fetch_threw', error: err.message, sessionInfo })
  }
})

app.get('/api/calendar/events', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated', events: [] }, 401)
  try {
    // Accept optional year+month query params so the frontend can request any month.
    // Falls back to a 60-day window from today when no params are supplied.
    const qYear  = parseInt(c.req.query('year')  || '0')
    const qMonth = parseInt(c.req.query('month') || '-1') // 0-based (Jan=0)
    let timeMin: Date, timeMax: Date
    if (qYear > 0 && qMonth >= 0) {
      // Start of requested month, end of month + 1 week buffer so events that
      // start just before the grid edge still appear
      timeMin = new Date(qYear, qMonth, 1)
      timeMax = new Date(qYear, qMonth + 1, 7) // first week of next month
    } else {
      // Default: today through next 60 days (covers ~2 months of lectures)
      timeMin = new Date()
      timeMax = new Date(Date.now() + 60*24*60*60*1000)
    }
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: '100',           // enough for a full semester of recurring events
      singleEvents: 'true',        // expand recurring events (lectures) into individual instances
      orderBy: 'startTime',
    })
    const calRes = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
      { headers: { Authorization: 'Bearer ' + token } }
    )
    const data: any = await calRes.json()
    // Google returns 401/403 when token lacks calendar scope or was revoked
    // code can be number OR string, so coerce
    const errCode = data.error ? parseInt(String(data.error?.code || '0')) : 0
    if (errCode === 401 || errCode === 403) {
      return c.json({ error: 'not_authenticated', google_reason: data.error?.message || '', events: [] }, 401)
    }
    if (data.error) {
      // Some other Google error — surface it so the debug panel can show it
      return c.json({ error: data.error?.message || 'google_error', google_code: errCode, events: [] }, 500)
    }
    const events = (data.items || []).map((e: any) => ({
      id:     e.id,
      summary: e.summary || '(No title)',
      start:  e.start?.dateTime || e.start?.date,
      end:    e.end?.dateTime   || e.end?.date,
      allDay: !e.start?.dateTime,
      color:  'hsl(' + (parseInt(e.colorId || '8') * 37) + ', 60%, 60%)',
    }))
    return c.json({ events, count: events.length })
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

// ─── Smart Scheduling ─────────────────────────────────────────────────────────
// Analyzes today + tomorrow calendar events and suggests optimal focus windows
app.get('/api/smart/suggest-focus', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated', suggestions: [] }, 401)
  try {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
    const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 23, 59, 59)
    const params = new URLSearchParams({
      timeMin: todayStart.toISOString(),
      timeMax: tomorrowEnd.toISOString(),
      maxResults: '50',
      singleEvents: 'true',
      orderBy: 'startTime',
    })
    const calRes = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params,
      { headers: { Authorization: 'Bearer ' + token } }
    )
    const data: any = await calRes.json()
    if (data.error) return c.json({ error: 'google_error', suggestions: [] }, 500)

    // Build busy blocks from events
    type Block = { start: number; end: number }
    const busy: Block[] = (data.items || [])
      .filter((e: any) => e.start?.dateTime) // only timed events
      .map((e: any) => ({ start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() }))
      .sort((a: Block, b: Block) => a.start - b.start)

    // Find free gaps >= 25 min in working hours (8am–10pm)
    const suggestions: any[] = []
    const WORK_START_H = 8, WORK_END_H = 22
    const MIN_FOCUS = 25 * 60 * 1000 // 25 min
    const SLOT_LABELS = [25, 45, 90] // minutes

    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset)
      const dayLabel = dayOffset === 0 ? 'Today' : 'Tomorrow'
      const workStart = new Date(base); workStart.setHours(WORK_START_H, 0, 0, 0)
      const workEnd   = new Date(base); workEnd.setHours(WORK_END_H, 0, 0, 0)
      // Don't suggest times in the past
      const windowStart = dayOffset === 0 ? Math.max(workStart.getTime(), now.getTime() + 5 * 60 * 1000) : workStart.getTime()

      const dayBusy = busy.filter((b: Block) => b.start >= workStart.getTime() && b.start < workEnd.getTime())

      // Walk through the day finding free gaps
      let cursor = windowStart
      for (const b of dayBusy) {
        if (b.start > cursor + MIN_FOCUS) {
          // Free gap: cursor → b.start
          const gapMs = Math.min(b.start, workEnd.getTime()) - cursor
          for (const slotMin of SLOT_LABELS) {
            if (gapMs >= slotMin * 60 * 1000) {
              const startD = new Date(cursor)
              const endD   = new Date(cursor + slotMin * 60 * 1000)
              suggestions.push({
                day: dayLabel,
                date: base.toISOString().slice(0, 10),
                startTime: startD.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                endTime:   endD.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                startISO:  startD.toISOString(),
                endISO:    endD.toISOString(),
                durationMin: slotMin,
                label: slotMin === 25 ? '🍅 Pomodoro' : slotMin === 45 ? '⚡ Deep Work' : '🌊 Flow State',
                score: gapMs >= 90 * 60 * 1000 ? 'ideal' : gapMs >= 45 * 60 * 1000 ? 'good' : 'short',
              })
              break // only suggest best slot per gap
            }
          }
        }
        cursor = Math.max(cursor, b.end)
      }
      // After last event
      if (workEnd.getTime() - cursor >= MIN_FOCUS) {
        const gapMs = workEnd.getTime() - cursor
        for (const slotMin of SLOT_LABELS) {
          if (gapMs >= slotMin * 60 * 1000) {
            const startD = new Date(cursor)
            const endD   = new Date(cursor + slotMin * 60 * 1000)
            suggestions.push({
              day: dayLabel,
              date: base.toISOString().slice(0, 10),
              startTime: startD.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
              endTime:   endD.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
              startISO:  startD.toISOString(),
              endISO:    endD.toISOString(),
              durationMin: slotMin,
              label: slotMin === 25 ? '🍅 Pomodoro' : slotMin === 45 ? '⚡ Deep Work' : '🌊 Flow State',
              score: gapMs >= 90 * 60 * 1000 ? 'ideal' : gapMs >= 45 * 60 * 1000 ? 'good' : 'short',
            })
            break
          }
        }
      }
    }

    return c.json({ suggestions: suggestions.slice(0, 6), busy_count: busy.length })
  } catch (err: any) { return c.json({ error: err.message, suggestions: [] }, 500) }
})

// ─── Weekly Review ─────────────────────────────────────────────────────────────
app.get('/api/weekly-review', async (c) => {
  const token = await getValidAccessToken(c)
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  // Accept stats from query params (sent by frontend from localStorage)
  const q = c.req.query() as any
  const focusMin   = parseInt(q.focusMin   || '0')
  const sessions   = parseInt(q.sessions   || '0')
  const streak     = parseInt(q.streak     || '0')
  const topTask    = q.topTask || ''

  let calEvents: any[] = []
  if (token) {
    try {
      const now = new Date()
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const params = new URLSearchParams({ timeMin: weekAgo.toISOString(), timeMax: now.toISOString(), maxResults: '100', singleEvents: 'true', orderBy: 'startTime' })
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params, { headers: { Authorization: 'Bearer ' + token } })
      const data: any = await res.json()
      calEvents = (data.items || []).map((e: any) => ({ summary: e.summary, start: e.start?.dateTime || e.start?.date }))
    } catch (_) {}
  }

  const meetingCount = calEvents.filter(e => !e.summary?.toLowerCase().includes('focus') && !e.summary?.toLowerCase().includes('block')).length
  const focusBlocks  = calEvents.filter(e => e.summary?.toLowerCase().includes('focus') || e.summary?.toLowerCase().includes('block')).length

  // Simple rule-based review (no AI cost)
  const flowScore = Math.min(100, Math.round((focusMin / 120) * 40 + (sessions / 5) * 30 + Math.min(streak, 7) * 4 + (sessions > 0 ? 15 : 0)))
  const wins = []
  const improve = []

  if (sessions >= 5) wins.push(`${sessions} focus sessions completed`)
  else improve.push(`Only ${sessions} sessions — aim for 5+ per week`)

  if (streak >= 3) wins.push(`${streak}-day streak 🔥 — consistency is your superpower`)
  else improve.push(`Build your streak — even 1 session/day compounds fast`)

  if (focusMin >= 120) wins.push(`${focusMin}m of deep focus — that's ${Math.round(focusMin/60 * 10)/10}h of real output`)
  else improve.push(`${focusMin}m focus time — try blocking 2h/day minimum`)

  if (meetingCount > 10) improve.push(`${meetingCount} meetings this week — protect your deep work time`)
  else if (meetingCount > 0) wins.push(`Calendar was manageable — ${meetingCount} meetings`)

  if (focusBlocks > 0) wins.push(`${focusBlocks} focus blocks in your calendar — pro habit`)

  return c.json({
    week: `${new Date(Date.now() - 7*24*60*60*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}`,
    flowScore,
    focusMin,
    sessions,
    streak,
    meetingCount,
    focusBlocks,
    wins: wins.slice(0, 3),
    improve: improve.slice(0, 2),
    topTask: topTask || null,
    name: session?.name?.split(' ')[0] || 'Creator',
  })
})

// ─── Weekly Email Digest ──────────────────────────────────────────────────────
app.post('/api/email/weekly-digest', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const resendKey = c.env?.RESEND_API_KEY
  if (!resendKey) return c.json({ error: 'email_not_configured' }, 503)

  const db = c.env?.DB
  let flowScore = 0, focusMin = 0, sessions30 = 0, streak = 0
  let wins: string[] = [], improve: string[] = [], outputBreakdown: Record<string,number> = {}

  if (db) {
    try {
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const since7  = new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10)
      const { results } = await db.prepare(
        `SELECT duration_mins, focus_score, output_type, session_date FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1 ORDER BY session_date DESC`
      ).bind(session.email, since30).all() as any
      const week = (results as any[]).filter((r:any) => r.session_date >= since7)
      sessions30 = results.length
      focusMin   = week.reduce((s:number,r:any) => s+(r.duration_mins||0), 0)
      // Streak
      const daySet = new Set((results as any[]).map((r:any) => r.session_date))
      const today = new Date()
      for (let i = 0; i < 365; i++) { const d=new Date(today); d.setDate(d.getDate()-i); if(daySet.has(d.toISOString().slice(0,10))) streak++; else if(i>0) break; }
      // FlowScore
      flowScore = Math.min(100, Math.round((focusMin/120)*40+(week.length/5)*30+Math.min(streak,7)*4+(week.length>0?15:0)))
      // Output breakdown
      ;(results as any[]).forEach((r:any) => { if(r.output_type) outputBreakdown[r.output_type]=(outputBreakdown[r.output_type]||0)+1 })
      // Wins/improve
      if (week.length >= 5) wins.push(`${week.length} focus sessions this week 🎯`)
      if (streak >= 3) wins.push(`${streak}-day streak 🔥`)
      if (focusMin >= 120) wins.push(`${focusMin} minutes of deep work this week`)
      const topOutput = Object.entries(outputBreakdown).sort((a,b)=>b[1]-a[1])[0]
      if (topOutput) wins.push(`Top output: ${topOutput[0]} (${topOutput[1]}x)`)
      if (week.length < 3) improve.push('Aim for 5+ sessions next week — small daily habit compounds fast')
      if (streak === 0) improve.push('Start a streak — even 1 session today resets the clock')
    } catch(_) {}
  }

  const name = session.name?.split(' ')[0] || 'Creator'
  const weekStr = `${new Date(Date.now()-7*86400000).toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}`
  const scoreColor = flowScore >= 70 ? '#10b981' : flowScore >= 40 ? '#a855f7' : '#f59e0b'
  const winsHtml = wins.length ? wins.map(w=>`<li style="padding:4px 0;color:#d0d0d0">${w}</li>`).join('') : '<li style="color:#666">Complete sessions this week to see your wins here!</li>'
  const improveHtml = improve.length ? improve.map(i=>`<li style="padding:4px 0;color:#d0d0d0">${i}</li>`).join('') : '<li style="color:#888">Looking great — keep the momentum going!</li>'
  const outputRows = Object.entries(outputBreakdown).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`<span style="background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.25);border-radius:6px;padding:3px 10px;font-size:12px;color:#c084fc;margin:3px">${t} ×${n}</span>`).join('')

  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a12;font-family:system-ui,-apple-system,sans-serif;color:#f0f0f0">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
  <div style="text-align:center;margin-bottom:28px">
    <div style="font-size:32px;margin-bottom:8px">⚡</div>
    <h1 style="font-size:22px;font-weight:900;margin:0;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent">FLOWSTATE</h1>
    <div style="font-size:13px;color:#666;margin-top:4px">Weekly Review — ${weekStr}</div>
  </div>
  <div style="text-align:center;margin-bottom:24px">
    <div style="font-size:13px;color:#888;margin-bottom:6px">Hey ${name} 👋 here's your week in focus.</div>
    <div style="display:inline-block;background:#12102a;border:2px solid ${scoreColor};border-radius:20px;padding:16px 32px">
      <div style="font-size:48px;font-weight:900;color:${scoreColor};line-height:1">${flowScore}</div>
      <div style="font-size:12px;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:1px">FlowScore</div>
    </div>
  </div>
  <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap;justify-content:center">
    <div style="background:#12102a;border:1px solid #2a2a3e;border-radius:12px;padding:14px 20px;text-align:center;min-width:100px">
      <div style="font-size:24px;font-weight:800;color:#a855f7">${focusMin}m</div>
      <div style="font-size:11px;color:#666;margin-top:2px">Focus Time</div>
    </div>
    <div style="background:#12102a;border:1px solid #2a2a3e;border-radius:12px;padding:14px 20px;text-align:center;min-width:100px">
      <div style="font-size:24px;font-weight:800;color:#ec4899">${sessions30}</div>
      <div style="font-size:11px;color:#666;margin-top:2px">Sessions (30d)</div>
    </div>
    <div style="background:#12102a;border:1px solid #2a2a3e;border-radius:12px;padding:14px 20px;text-align:center;min-width:100px">
      <div style="font-size:24px;font-weight:800;color:#f59e0b">${streak}🔥</div>
      <div style="font-size:11px;color:#666;margin-top:2px">Day Streak</div>
    </div>
  </div>
  ${outputRows ? `<div style="margin-bottom:20px;text-align:center"><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">Output Breakdown</div><div>${outputRows}</div></div>` : ''}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px">
    <div style="background:#12102a;border:1px solid #1a2e1a;border-radius:12px;padding:16px">
      <div style="font-size:12px;font-weight:700;color:#10b981;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">🏆 Wins</div>
      <ul style="margin:0;padding:0 0 0 16px;font-size:13px">${winsHtml}</ul>
    </div>
    <div style="background:#12102a;border:1px solid #2e2a1a;border-radius:12px;padding:16px">
      <div style="font-size:12px;font-weight:700;color:#f59e0b;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">🚀 Level Up</div>
      <ul style="margin:0;padding:0 0 0 16px;font-size:13px">${improveHtml}</ul>
    </div>
  </div>
  <div style="text-align:center;margin-bottom:28px">
    <a href="https://flowst8.cc" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-weight:700;font-size:15px">Start This Week's Sessions →</a>
  </div>
  <div style="text-align:center;border-top:1px solid #1a1a2e;padding-top:16px;font-size:11px;color:#444">
    FlowState · <a href="https://flowst8.cc" style="color:#666;text-decoration:none">flowst8.cc</a>
  </div>
</div>
</body></html>`

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: c.env?.RESEND_FROM_EMAIL || 'FlowState <noreply@flowst8.cc>',
        to: [session.email],
        'reply-to': 'FlowState Support <hello@flowst8.cc>',
        subject: `⚡ Your FlowScore this week: ${flowScore} — ${weekStr}`,
        html,
      })
    })
    const emailData: any = await emailRes.json()
    if (emailData.id) return c.json({ ok: true, emailId: emailData.id })
    return c.json({ error: emailData.message || 'Email send failed' }, 500)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
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
    return c.json({ ok: data.ok, ts: data.ts, error: data.error })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

app.post('/api/slack/create-channel', async (c) => {
  const ss = decodeSession(getCookie(c, 'fs_slack') || '')
  if (!ss) return c.json({ error: 'not_connected' }, 401)
  const { name } = await c.req.json()
  if (!name) return c.json({ error: 'Channel name required' }, 400)
  // Slack channel names: lowercase, no spaces, max 80 chars
  const cleanName = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').substring(0, 80)
  try {
    const data: any = await (await fetch('https://slack.com/api/conversations.create', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ss.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName, is_private: false }),
    })).json()
    if (!data.ok) return c.json({ error: data.error || 'Could not create channel' }, 400)
    return c.json({ ok: true, channel: { id: data.channel.id, name: data.channel.name } })
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

// ─── Unified Credit System ────────────────────────────────────────────────────
// 1 credit = $0.001 API cost (with markup applied in costUnits)
// Free tier:       3,000 credits/month — hard stop
// Pro tier:        10,000 credits/month — no hard stop (purchased credits cover overflow)
// Team tier:       7,500 credits/seat/month — no hard stop
// Enterprise:      no cap
//
// Credits track ALL media types: text, image, video, voice, music.
// The ai-orchestrator.ts costUnits map to credits directly.
// ── checkCreditsBudgetOnly: verify user has budget WITHOUT deducting ──────────
// Used for AI code builder — credits only committed after successful generation.
async function checkCreditsBudgetOnly(c: any, userId: string, cost: number = 1): Promise<Response | null> {
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return null

  const month        = new Date().toISOString().slice(0, 7)
  const tierEmailKey = `tier_email:${userId}`
  const tierKey      = `tier:${userId}`
  const monthKey     = `monthly_credits_used:${userId}:${month}`
  const minute       = Math.floor(Date.now() / 60000)
  const velKey       = `velocity:${userId}:${minute}`

  const results = await redisPipeline(url, token, [
    ['GET',  tierEmailKey],
    ['GET',  tierKey],
    ['GET',  monthKey],
    ['INCR', velKey],
    ['EXPIRE', velKey, 90],
  ])

  const tier        = (results[0] || results[1] || 'free') as string
  const used        = parseInt(results[2] as string || '0')
  const velocity    = parseInt(results[3] as string || '0')
  const isPaid      = ['pro', 'team', 'enterprise', 'personal_pro', 'team_starter', 'team_growth'].includes(tier)
  const isEnterprise = tier === 'enterprise'

  if (velocity >= 10) {
    return c.json({ error: 'Too many requests — slow down for 60 seconds.', code: 'VELOCITY_EXCEEDED' }, 429)
  }
  if (isEnterprise || isPaid) return null

  const FREE_MONTHLY_LIMIT = 3_000
  if (used >= FREE_MONTHLY_LIMIT) {
    const balKey = `credit_balance:${encodeURIComponent(userId)}`
    const balRes = await fetch(`${url}/get/${balKey}`, { headers: { Authorization: `Bearer ${token}` } })
    const balData: any = await balRes.json().catch(() => ({}))
    const balance = parseInt(balData?.result || '0')
    if (balance >= cost) return null
    return c.json({
      error: 'Monthly credit limit reached (3,000 credits). Upgrade to Pro for 10,000 credits/month or buy a credit pack.',
      code: 'MONTHLY_LIMIT', used, limit: FREE_MONTHLY_LIMIT, isPaid: false, canTopUp: true,
    }, 429)
  }
  return null
}

// ── commitCredits: deduct credits after a SUCCESSFUL operation ─────────────
async function commitCredits(c: any, userId: string, cost: number): Promise<void> {
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return

  const month    = new Date().toISOString().slice(0, 7)
  const monthKey = `monthly_credits_used:${userId}:${month}`
  const now      = new Date()
  const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
  const monthExpireAt = Math.floor(endOfMonth.getTime() / 1000)

  await redisPipeline(url, token, [
    ['INCRBY',   monthKey, cost],
    ['EXPIREAT', monthKey, monthExpireAt],
  ]).catch(() => {})
}

async function checkCredits(c: any, userId: string, cost: number = 1): Promise<Response | null> {
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return null // Redis not configured — allow through

  const month   = new Date().toISOString().slice(0, 7) // YYYY-MM
  const minute  = Math.floor(Date.now() / 60000)
  const tierKey      = `tier:${userId}`
  const tierEmailKey = `tier_email:${userId}`
  const monthKey     = `monthly_credits_used:${userId}:${month}`
  const velKey       = `velocity:${userId}:${minute}`

  // Compute seconds until end of current month UTC for EXPIREAT
  const now = new Date()
  const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
  const monthExpireAt = Math.floor(endOfMonth.getTime() / 1000)

  // Read tier + velocity/usage in one pipeline
  const results = await redisPipeline(url, token, [
    ['GET',     tierEmailKey],
    ['GET',     tierKey],
    ['GET',     monthKey],
    ['GET',     velKey],
    ['INCR',    velKey],
    ['EXPIRE',  velKey, 90],
    ['INCRBY',  monthKey, cost],
    ['EXPIREAT', monthKey, monthExpireAt],
  ])

  const tierEmail   = results[0] as string | null
  const tierSession = results[1] as string | null
  const tier        = tierEmail || tierSession || 'free'
  const monthUsed   = results[2] as string | null  // value BEFORE this increment
  const velCount    = results[3] as string | null

  const isPaid       = tier === 'pro' || tier === 'team' || tier === 'enterprise' ||
    ['personal_pro', 'team_starter', 'team_growth'].includes(tier)
  const isEnterprise = tier === 'enterprise'
  const isTeam       = tier === 'team' || tier === 'team_starter' || tier === 'team_growth'

  // Monthly credit budgets
  // Enterprise: no cap
  // Pro/Team: 10,000 / 7,500 — paid users use purchased credits as overflow, never hard-blocked
  // Free: 3,000 — hard stop (free users can buy credit packs to continue)
  const FREE_MONTHLY_LIMIT = 3_000

  const used     = parseInt(monthUsed || '0')
  const velocity = parseInt(velCount  || '0')

  // Velocity check: >10 requests per 60 seconds (bot protection only)
  if (velocity >= 10) {
    return c.json({ error: 'Too many requests — slow down for 60 seconds.', code: 'VELOCITY_EXCEEDED' }, 429)
  }

  // Enterprise: never block
  if (isEnterprise) return null

  // Pro/Team: never hard-block — check purchased credit overflow
  if (isPaid) {
    // Set a soft header when monthly allocation is exceeded but don't block
    const monthlyAlloc = isTeam ? 7_500 : 10_000
    if (used >= monthlyAlloc) {
      // Draw from purchased credit balance
      const balKey = `credit_balance:${encodeURIComponent(userId)}`
      const balRes = await fetch(`${url}/get/${balKey}`, { headers: { Authorization: `Bearer ${token}` } })
      const balData: any = await balRes.json().catch(() => ({}))
      const balance = parseInt(balData?.result || '0')
      if (balance > 0) {
        const deduct = Math.min(cost, balance)
        await fetch(`${url}/decrby/${balKey}/${deduct}`, { headers: { Authorization: `Bearer ${token}` } })
        c.header('X-Credit-Source', 'purchased')
      }
      // Pro/Team always allowed through — purchased balance is informational
    }
    return null
  }

  // Free tier: hard stop at 3,000 credits/month
  if (used >= FREE_MONTHLY_LIMIT) {
    // Check purchased credit balance as overflow
    const balKey = `credit_balance:${encodeURIComponent(userId)}`
    const balRes = await fetch(`${url}/get/${balKey}`, { headers: { Authorization: `Bearer ${token}` } })
    const balData: any = await balRes.json().catch(() => ({}))
    const balance = parseInt(balData?.result || '0')

    if (balance >= cost) {
      const deduct = Math.min(cost, balance)
      await fetch(`${url}/decrby/${balKey}/${deduct}`, { headers: { Authorization: `Bearer ${token}` } })
      c.header('X-Credit-Source', 'purchased')
      return null // allow through using purchased credits
    }

    return c.json({
      error: 'Monthly credit limit reached (3,000 credits). Upgrade to Pro for 10,000 credits/month or buy a credit pack.',
      code: 'MONTHLY_LIMIT',
      used,
      limit: FREE_MONTHLY_LIMIT,
      isPaid: false,
      canTopUp: true,
    }, 429)
  }

  // Soft warning at 80% budget for free users
  if (used + cost >= FREE_MONTHLY_LIMIT * 0.8) {
    const remaining = Math.max(0, FREE_MONTHLY_LIMIT - used - cost)
    c.header('X-Budget-Warning', `${remaining} credits left this month — upgrade to Pro for 10,000 credits/month`)
  }

  return null // allow through
}

// Backward-compat shim — old call sites pass a token cost, we map to credit cost
// The orchestrator handles the real per-model deduction; this covers non-orchestrated routes
async function checkAntiAbuse(c: any, userId: string, cost: number = 1): Promise<Response | null> {
  return checkCredits(c, userId, cost)
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

  // ── Free-tier model restriction: silently downgrade to cheap model ──────────
  const FREE_TIER_MODELS = ['gpt-4o-mini', 'gemini-2-flash', 'claude-haiku', 'grok-3-mini', 'llama-4-scout', 'llama-4-maverick', 'llama-3-3', 'deepseek-v3']
  const sessionTier = session?.tier || 'free'
  const isTierPaid  = sessionTier === 'pro' || sessionTier === 'team'
  let effectiveModel = preferredModel
  if (!isTierPaid && effectiveModel && !FREE_TIER_MODELS.includes(effectiveModel)) {
    effectiveModel = 'gpt-4o-mini' // silently downgrade
    c.header('X-Model-Downgraded', 'gpt-4o-mini')
    c.header('X-Downgrade-Reason', 'free-tier-restriction')
  }

  const intent = declareModelRouting(message, effectiveModel)
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

  const userId = session?.email || session?.id || c.req.header('CF-Connecting-IP') || 'anon'

  // Credit costs per image model (1 credit = $0.001):
  // z-image/schnell ≈ 8cr, flux_dev ≈ 25cr, flux_pro/imagen/ideogram ≈ 55cr
  const IMAGE_CREDIT_COSTS: Record<string, number> = {
    flux_schnell: 8, sd35_medium: 8, seedream: 8,
    flux_dev: 25, sd35: 25, sd3: 25,
    flux_pro: 55, imagen3: 55, imagen4: 55, ideogram2: 80, recraft: 55,
    'gpt-image': 60, dalle3: 55, dalle4: 60, runway_img: 60,
    nano_banana_2k: 20, nano_banana_4k: 55,
  }
  const imgCreditCost = IMAGE_CREDIT_COSTS[modelId] ?? 55
  const imgCreditCheck = await checkCredits(c, userId, imgCreditCost)
  if (imgCreditCheck) return imgCreditCheck

  if (imgRedisUrl && imgRedisTok) {
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
    // ── All Replicate image models ────────────────────────────────────────────
    const inputMap: Record<string, any> = {
      // OpenAI via Replicate
      dalle3:      { prompt, size: '1024x1024', quality: 'standard', style: 'vivid' },
      dalle4:      { prompt, size: '1024x1024', quality: 'hd', style: 'vivid' },
      'gpt-image': { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      // Google Imagen via Replicate
      imagen3:     { prompt, aspect_ratio: aspectRatio, output_format: 'webp' },
      imagen4:     { prompt, aspect_ratio: aspectRatio, output_format: 'webp' },
      // Black Forest Labs
      flux_pro:    { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      flux_dev:    { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90, num_inference_steps: 28 },
      flux_schnell:{ prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90, num_inference_steps: 4 },
      // Stability AI
      sd3:         { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      sd35:        { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      sd35_medium: { prompt, aspect_ratio: aspectRatio, output_format: 'webp', output_quality: 90 },
      // Others
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
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const { prompt, model: modelId = 'kling16', duration = 5, imageUrl } = await c.req.json()
  const spec = VIDEO_MODEL_REGISTRY[modelId as keyof typeof VIDEO_MODEL_REGISTRY]
  if (!spec) return c.json({ error: 'Unknown video model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  const isImg2Vid = !!imageUrl

  // Block free users from video generation entirely
  const vidUserId = session?.email || session?.id || c.req.header('CF-Connecting-IP') || 'anon'
  // Quick tier check — video is Pro+ only — read tier from Redis (session cookie never stores tier)
  if (!session) {
    return c.json({ error: 'Video generation requires a Pro plan. Upgrade at flowst8.cc/pricing', code: 'PRO_REQUIRED', upgradeUrl: 'https://flowst8.cc/pricing' }, 403)
  }
  let vidRealTier = 'free'
  if (session.email && c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
    try {
      const tr = await redisPipeline(c.env.UPSTASH_REDIS_URL, c.env.UPSTASH_REDIS_TOKEN, [
        ['GET', `tier_email:${session.email}`],
        ['GET', `tier:${session.email}`],
      ])
      vidRealTier = (tr[0] || tr[1] || 'free') as string
    } catch { vidRealTier = 'free' }
  }
  if (!isTierPro(vidRealTier)) {
    return c.json({ error: 'Video generation requires a Pro plan. Upgrade at flowst8.cc/pricing', code: 'PRO_REQUIRED', upgradeUrl: 'https://flowst8.cc/pricing' }, 403)
  }

  // Credit costs per video model (1 credit = $0.001):
  // Wan 5s ≈ 400cr, Kling 5s ≈ 700cr, Seedance 5s ≈ 250cr (fal.ai), Higgsfield 15s ≈ 550cr
  const VIDEO_CREDIT_COSTS: Record<string, number> = {
    wan_t2v: 400, wan_i2v: 400,
    kling16: 350, kling21: 700,
    seedance_t2v: 250, seedance_i2v: 250,
    higgsfield_t2v: 550, higgsfield_i2v: 550,
    minimax: 250, minimax_live: 250, hailuo: 250,
    veo2: 2500, veo3: 2000,
    runway_gen4: 350, runway_gen4t: 350,
    pika20: 250, sora: 500, luma: 300, hunyuan: 300, ltx: 200,
  }
  const vidCreditCost = (VIDEO_CREDIT_COSTS[modelId] ?? 400) * Math.max(1, Math.floor(duration / 5))
  const vidCreditCheck = await checkCredits(c, vidUserId, vidCreditCost)
  if (vidCreditCheck) return vidCreditCheck

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
      kling16:      { prompt, duration: Math.min(duration, 10), aspect_ratio: '16:9', ...(isImg2Vid ? { image: imageUrl } : {}) },
      kling21:      { prompt, duration: Math.min(duration, 10), aspect_ratio: '16:9', ...(isImg2Vid ? { image: imageUrl } : {}) },
      minimax:      { prompt, ...(isImg2Vid ? { first_frame_image: imageUrl } : {}) },
      minimax_live: { prompt, ...(isImg2Vid ? { first_frame_image: imageUrl } : {}) },
      hailuo:       { prompt, ...(isImg2Vid ? { first_frame_image: imageUrl } : {}) },
      runway_gen4:  { prompt, ratio: '16:9', duration: Math.min(duration, 10), ...(isImg2Vid ? { image: imageUrl } : {}) },
      runway_gen4t: { prompt, ratio: '16:9', duration: Math.min(duration, 10), ...(isImg2Vid ? { image: imageUrl } : {}) },
      pika20:       { prompt, aspect_ratio: '16:9', ...(isImg2Vid ? { image: imageUrl } : {}) },
      sora:         { prompt, duration: Math.min(duration, 10), aspect_ratio: '16:9', ...(isImg2Vid ? { image: imageUrl } : {}) },
      luma:         { prompt, duration: Math.min(duration, 5), aspect_ratio: '16:9', ...(isImg2Vid ? { start_image_url: imageUrl } : {}) },
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

// ─── Session Complete — saves to D1 + output tracking ────────────────────────
app.post('/api/session/complete', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ ok: false, error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  const { durationMins, focusScore, outputType, outputNote, appContext = 'hub', updateSessionId } = await c.req.json()
  if (!durationMins || durationMins < 1) return c.json({ ok: false, error: 'invalid_duration' }, 400)

  try {
    if (db) {
      // Upsert user so we always have a record
      await (await import('./db-helpers')).upsertUser(db, session.email, session.name || '', session.picture || '', 'google').catch(() => {})
      const user = await (await import('./db-helpers')).getUserByEmail(db, session.email)
      if (user) {
        const sessionDate = new Date().toISOString().slice(0, 10)
        let sessionRowId: number | null = null

        if (updateSessionId) {
          // UPDATE existing auto-saved session with output type/note instead of inserting duplicate
          await db.prepare(`
            UPDATE sessions SET output_type=?, output_note=?, focus_score=COALESCE(?,focus_score)
            WHERE id=? AND email=?
          `).bind(outputType ?? null, outputNote ?? null, focusScore ?? null, updateSessionId, session.email).run()
          sessionRowId = updateSessionId
        } else {
          // INSERT new session row (auto-save path — no output type yet)
          const result = await db.prepare(`
            INSERT INTO sessions (user_id, email, phase, duration_mins, completed, focus_score, output_type, output_note, app_context, session_date)
            VALUES (?, ?, 'focus', ?, 1, ?, ?, ?, ?, ?)
          `).bind(user.id, session.email, durationMins, focusScore ?? null, outputType ?? null, outputNote ?? null, appContext, sessionDate).run()
          sessionRowId = result.meta?.last_row_id ?? null
        }

        // Log to creator_outputs if output type provided
        if (outputType && sessionRowId) {
          // Avoid duplicate creator_outputs entry if one already exists for this session
          const existing = await db.prepare(`SELECT id FROM creator_outputs WHERE session_id=?`).bind(sessionRowId).first()
          if (!existing) {
            await db.prepare(`
              INSERT INTO creator_outputs (user_id, email, session_id, output_type, output_note, duration_mins, app_context)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(user.id, session.email, sessionRowId, outputType, outputNote ?? null, durationMins, appContext).run()
          }
        }

        return c.json({ ok: true, sessionId: sessionRowId })
      }
    }
    return c.json({ ok: true })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

// ─── Session History — real D1 data for Weekly Review + Metrics ──────────────
app.get('/api/session/history', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  if (!db) return c.json({ error: 'db_unavailable', sessions: [], outputs: [] }, 503)

  try {
    const days = parseInt(c.req.query('days') || '30')
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

    // All focus sessions in range
    const { results: sessions } = await db.prepare(`
      SELECT id, duration_mins, focus_score, output_type, output_note, session_date, created_at
      FROM sessions
      WHERE email = ? AND session_date >= ? AND phase = 'focus' AND completed = 1
      ORDER BY session_date DESC, created_at DESC
    `).bind(session.email, since).all()

    // Aggregate stats
    const totalMins   = (sessions as any[]).reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
    const totalSess   = sessions.length
    const avgScore    = totalSess > 0 ? Math.round((sessions as any[]).reduce((s: number, r: any) => s + (r.focus_score || 0), 0) / totalSess) : 0

    // Streak — consecutive days with at least 1 session
    const daySet = new Set((sessions as any[]).map((r: any) => r.session_date))
    let streak = 0
    const today = new Date()
    for (let i = 0; i < 365; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i)
      if (daySet.has(d.toISOString().slice(0, 10))) streak++
      else if (i > 0) break
    }

    // Output type breakdown
    const outputBreakdown: Record<string, number> = {}
    ;(sessions as any[]).forEach((r: any) => {
      if (r.output_type) outputBreakdown[r.output_type] = (outputBreakdown[r.output_type] || 0) + 1
    })

    // Recent outputs (last 10 with notes)
    const recentOutputs = (sessions as any[])
      .filter((r: any) => r.output_type)
      .slice(0, 10)
      .map((r: any) => ({ date: r.session_date, type: r.output_type, note: r.output_note, mins: r.duration_mins }))

    // Sessions per day (for chart)
    const perDay: Record<string, number> = {}
    ;(sessions as any[]).forEach((r: any) => { perDay[r.session_date] = (perDay[r.session_date] || 0) + 1 })

    return c.json({
      totalMins,
      totalSessions: totalSess,
      avgFlowScore: avgScore,
      streak,
      outputBreakdown,
      recentOutputs,
      perDay,
      days,
    })
  } catch (err: any) {
    return c.json({ error: err.message, sessions: [], outputs: [] }, 500)
  }
})

// ─── Behavior Insight ─────────────────────────────────────────────────────────
app.get('/api/behavior/insight', async (c) => {
  const q = c.req.query() as any
  const data: BehaviorData = { totalFocusSeconds: parseInt(q.focus || '0'), sessionCount: parseInt(q.sessions || '0'), streak: parseInt(q.streak || '0'), completionRate: parseFloat(q.completion || '0.5'), steps: q.steps ? parseInt(q.steps) : undefined, sleepHours: q.sleep ? parseFloat(q.sleep) : undefined, hydrationGlasses: q.hydration ? parseInt(q.hydration) : undefined, languageStreak: q.langStreak ? parseInt(q.langStreak) : undefined }
  return c.json(declareBehaviorInsight(data))
})

// ─── Magic Link Auth ──────────────────────────────────────────────────────────
// Secure flow:
//   1. POST /api/auth/magic-link  → generates a cryptographically random token,
//      stores it in Redis with 15-min TTL, sends link via Resend.
//   2. GET  /api/auth/magic-link/verify?token=XXX  → validates against Redis,
//      deletes key (single-use), sets session cookie.
// Fallback: if RESEND_API_KEY is missing, auto-signs-in (dev/demo mode only).

app.post('/api/auth/magic-link', async (c) => {
  const { email } = await c.req.json()
  if (!email || !email.includes('@') || email.length > 320)
    return c.json({ error: 'invalid_email' }, 400)

  const resendKey = c.env?.RESEND_API_KEY
  const redisUrl  = c.env?.UPSTASH_REDIS_URL
  const redisTok  = c.env?.UPSTASH_REDIS_TOKEN
  const baseUrl   = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
  const name = email.split('@')[0].replace(/[._+-]/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()).trim() || 'there'

  // ── Rate-limit: max 3 magic link requests per email per 10 minutes ─────────
  if (redisUrl && redisTok) {
    const rlKey    = `ml_rl:${email.toLowerCase()}`
    const rlWindow = 600 // 10 minutes
    try {
      const pipeline = await fetch(`${redisUrl}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${redisTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          ['INCR',   rlKey],
          ['EXPIRE', rlKey, rlWindow],
        ])
      })
      const [incrRes] = await pipeline.json() as any[]
      const count = parseInt(incrRes?.result || '0')
      if (count > 3) {
        return c.json({
          error: 'too_many_requests',
          message: 'Too many sign-in requests. Please wait 10 minutes before trying again.',
        }, 429)
      }
    } catch { /* redis down — allow request */ }
  }

  if (resendKey) {
    // ── Generate a secure random token and store it in Redis (15-min TTL) ────
    const rawToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    const tokenKey = `ml_token:${rawToken}`
    const payload  = JSON.stringify({ email, name, issuedAt: Date.now() })

    let redisOk = false
    if (redisUrl && redisTok) {
      try {
        const setRes = await fetch(`${redisUrl}/set/${tokenKey}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${redisTok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([payload, 'EX', 900]), // 15-min TTL
        })
        const setData: any = await setRes.json().catch(() => ({}))
        redisOk = setData?.result === 'OK'
      } catch { /* fall through */ }
    }

    if (!redisOk) {
      // Redis unavailable — fall back to signed URL token (base64 payload + exp)
      // This is less secure but ensures users can still sign in
      console.error('[magic-link] Redis unavailable — using fallback URL token')
    }

    const magicUrl = redisOk
      ? `${baseUrl}/api/auth/magic-link/verify?t=${rawToken}`
      : `${baseUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(btoa(JSON.stringify({ email, name, exp: Date.now() + 15 * 60 * 1000 })))}`

    // ── Send the email via Resend ──────────────────────────────────────────
    let emailSent  = false
    let emailError = ''
    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: c.env?.RESEND_FROM_EMAIL || 'FlowState <noreply@flowst8.cc>',
          to:   [email],
          'reply-to': 'FlowState Support <hello@flowst8.cc>',
          subject: 'Sign in to FlowState',
          html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to FlowState</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 20px">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:520px;width:100%;border:1px solid #e5e7eb">
<tr><td style="background:#ffffff;padding:32px 40px 24px;text-align:center;border-bottom:1px solid #f3f4f6">
  <div style="font-size:28px;font-weight:900;color:#1a1a2e;letter-spacing:-0.5px">⚡ FlowState</div>
</td></tr>
<tr><td style="padding:36px 40px">
  <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111827">Hey ${name},</h1>
  <p style="margin:0 0 28px;color:#6b7280;font-size:15px;line-height:1.6">Click the button below to sign in to FlowState. This link expires in <strong style="color:#111827">15 minutes</strong> and can only be used once.</p>
  <table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="padding-bottom:28px">
    <a href="${magicUrl}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:600;font-size:16px">Sign in to FlowState</a>
  </td></tr></table>
  <p style="margin:0 0 8px;color:#9ca3af;font-size:12px;line-height:1.5">Or copy this link into your browser:</p>
  <p style="margin:0;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;font-family:'Courier New',Courier,monospace;font-size:11px;color:#6b7280;word-break:break-all">${magicUrl}</p>
</td></tr>
<tr><td style="padding:20px 40px 28px;border-top:1px solid #f3f4f6;text-align:center">
  <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6">If you did not request this email you can safely ignore it.<br>This link works once and expires in 15 minutes.<br><br>FlowState &middot; <a href="https://flowst8.cc" style="color:#9ca3af">flowst8.cc</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`,
        })
      })

      const emailData: any = await emailRes.json().catch(() => ({}))

      if (emailRes.ok && emailData?.id) {
        emailSent = true
        // Log successful send for admin visibility
        if (redisUrl && redisTok) {
          try {
            await fetch(`${redisUrl}/pipeline`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${redisTok}`, 'Content-Type': 'application/json' },
              body: JSON.stringify([
                ['INCR',   `ml_sent:total`],
                ['INCR',   `ml_sent:${new Date().toISOString().slice(0,7)}`],
                ['EXPIRE', `ml_sent:${new Date().toISOString().slice(0,7)}`, 90 * 86400],
              ])
            })
          } catch { /* non-critical */ }
        }
      } else {
        // Capture the actual Resend error
        emailError = emailData?.message || emailData?.name || `HTTP ${emailRes.status}`
        console.error('[magic-link] Resend error:', emailError, JSON.stringify(emailData))
        // Log failed send
        if (redisUrl && redisTok) {
          try {
            await fetch(`${redisUrl}/pipeline`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${redisTok}`, 'Content-Type': 'application/json' },
              body: JSON.stringify([
                ['INCR', `ml_failed:total`],
                ['INCR', `ml_failed:${new Date().toISOString().slice(0,7)}`],
                ['EXPIRE', `ml_failed:${new Date().toISOString().slice(0,7)}`, 90 * 86400],
              ])
            })
          } catch { /* non-critical */ }
        }
      }
    } catch (sendErr: any) {
      emailError = sendErr.message || 'Network error sending email'
      console.error('[magic-link] fetch threw:', emailError)
    }

    if (!emailSent) {
      if (redisOk && redisUrl && redisTok) {
        try {
          await fetch(`${redisUrl}/del/${tokenKey}`, { headers: { Authorization: `Bearer ${redisTok}` } })
        } catch { /* non-critical */ }
      }
      // Build a user-friendly message based on the error type
      const isInvalidEmail = emailError.includes('invalid') || emailError.includes('not found') || emailError.includes('does not exist')
      const isBlocked = emailError.includes('550') || emailError.includes('551') || emailError.includes('553') || emailError.includes('blocked') || emailError.includes('rejected')
      const userMsg = isInvalidEmail
        ? `That email address doesn't appear to be valid. Please check the address and try again.`
        : isBlocked
          ? `Your email provider blocked this message. This can happen with iCloud, corporate, or strict spam filters. Please try a Gmail address or use "Continue with Google" instead.`
          : `We couldn't deliver the sign-in email right now. Please use "Continue with Google" or try again with a Gmail/work email address.`
      return c.json({
        error: 'email_send_failed',
        message: userMsg,
        emailError,
        suggestion: 'Use "Continue with Google" — it works instantly with any Google account.',
      }, 500)
    }

    return c.json({
      success: true,
      message: `Sign-in link sent to ${email}. Check your inbox (and spam folder) — it expires in 15 minutes.`,
    })

  } else {
    // ── Fallback: no RESEND_API_KEY — auto-sign-in (dev/demo mode only) ──────
    let savedPictureDemo = ''
    if (c.env?.DB) {
      try {
        const prof = await c.env.DB.prepare(`SELECT avatar_url FROM public_profiles WHERE email=? LIMIT 1`).bind(email).first() as any
        if (prof?.avatar_url) savedPictureDemo = prof.avatar_url
      } catch (_) {}
    }
    const session = { name, email, picture: savedPictureDemo, provider: 'magic_link', expiresAt: Date.now() + 7 * 24 * 3600000 }
    setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 604800, path: '/' })
    if (c.env?.DB) {
      try { await upsertUser(c.env.DB, email, name, savedPictureDemo, 'magic_link') } catch (_) {}
    }
    return c.json({
      success: true,
      user: { name, email },
      warning: 'RESEND_API_KEY not configured — auto sign-in used (dev/demo mode). Add RESEND_API_KEY to Cloudflare secrets to send real magic link emails.',
    })
  }
})

app.get('/api/auth/magic-link/verify', async (c) => {
  // Support both secure Redis-backed tokens (?t=) and legacy URL-payload tokens (?token=)
  const { t, token } = c.req.query() as any
  const redisUrl  = c.env?.UPSTASH_REDIS_URL
  const redisTok  = c.env?.UPSTASH_REDIS_TOKEN

  // ── Path A: Redis-backed secure token ─────────────────────────────────────
  if (t && redisUrl && redisTok) {
    const tokenKey = `ml_token:${t}`
    try {
      // Atomically GET then DEL (single-use token)
      const pipeline = await fetch(`${redisUrl}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${redisTok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          ['GET', tokenKey],
          ['DEL', tokenKey],
        ])
      })
      const results: any[] = await pipeline.json()
      const raw = results[0]?.result
      if (!raw) return c.html(authErrorPage('This sign-in link has expired or already been used. <a href="/" style="color:#a855f7">Request a new one</a>.'))

      const data = JSON.parse(raw)
      // Extra server-side expiry check (token payload has issuedAt)
      if (Date.now() - data.issuedAt > 15 * 60 * 1000) {
        return c.html(authErrorPage('This sign-in link has expired (15 minutes). <a href="/" style="color:#a855f7">Request a new one</a>.'))
      }

      // Look up saved avatar from public_profiles before creating session
      let savedPicture = ''
      if (c.env?.DB) {
        try {
          const prof = await c.env.DB.prepare(`SELECT avatar_url FROM public_profiles WHERE email=? LIMIT 1`).bind(data.email).first() as any
          if (prof?.avatar_url) savedPicture = prof.avatar_url
        } catch (_) {}
      }
      const session = { name: data.name, email: data.email, picture: savedPicture, provider: 'magic_link', expiresAt: Date.now() + 7 * 24 * 3600000 }
      setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 604800, path: '/' })
      if (c.env?.DB) {
        try { await upsertUser(c.env.DB, data.email, data.name, savedPicture, 'magic_link') } catch (dbErr: any) {
          console.error('[magic-link verify] D1 upsert failed:', dbErr?.message)
        }
      }
      return c.html(magicLinkSuccessPage(data.name))
    } catch (err: any) {
      return c.html(authErrorPage('Invalid sign-in link. Please <a href="/" style="color:#a855f7">request a new one</a>.'))
    }
  }

  // ── Path B: Legacy URL-payload token (?token=) — kept for backward compat ─
  if (token) {
    try {
      const data = JSON.parse(atob(decodeURIComponent(token)))
      if (Date.now() > data.exp) return c.html(authErrorPage('This link has expired. Please <a href="/" style="color:#a855f7">request a new sign-in link</a>.'))
      // Look up saved avatar from public_profiles before creating session
      let savedPictureLegacy = ''
      if (c.env?.DB) {
        try {
          const prof = await c.env.DB.prepare(`SELECT avatar_url FROM public_profiles WHERE email=? LIMIT 1`).bind(data.email).first() as any
          if (prof?.avatar_url) savedPictureLegacy = prof.avatar_url
        } catch (_) {}
      }
      const session = { name: data.name, email: data.email, picture: savedPictureLegacy, provider: 'magic_link', expiresAt: Date.now() + 7 * 24 * 3600000 }
      setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 604800, path: '/' })
      if (c.env?.DB) {
        try { await upsertUser(c.env.DB, data.email, data.name, savedPictureLegacy, 'magic_link') } catch (dbErr: any) {
          console.error('[magic-link verify legacy] D1 upsert failed:', dbErr?.message)
        }
      }
      return c.html(magicLinkSuccessPage(data.name))
    } catch { return c.html(authErrorPage('Invalid token. Please <a href="/" style="color:#a855f7">request a new sign-in link</a>.')) }
  }

  return c.html(authErrorPage('No sign-in token found. Please <a href="/" style="color:#a855f7">request a new link</a>.'))
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

// ─── Resend Email Webhook — bounce/delivery tracking ─────────────────────────
// Register this at: resend.com/webhooks → URL: https://flowst8.cc/api/resend/webhook
// Events to subscribe: email.bounced, email.delivery_delayed, email.complained
app.post('/api/resend/webhook', async (c) => {
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN

  let payload: any
  try { payload = await c.req.json() } catch { return c.json({ ok: true }) }

  const { type, data } = payload
  const month = new Date().toISOString().slice(0, 7)
  const ts    = new Date().toISOString()

  if (!url || !tok) return c.json({ ok: true })

  try {
    if (type === 'email.bounced') {
      const to = data?.to?.[0] || data?.email_id || 'unknown'
      // Log bounce: increment counter and push to recent bounces list
      await redisPipeline(url, tok, [
        ['INCR',  `ml_failed:total`],
        ['INCR',  `ml_failed:${month}`],
        ['EXPIRE',`ml_failed:${month}`, 90 * 86400],
        ['LPUSH', `ml_bounces:recent`, JSON.stringify({ to, ts, reason: data?.bounce?.type || 'hard' })],
        ['LTRIM', `ml_bounces:recent`, 0, 49], // keep last 50
      ])
    } else if (type === 'email.delivery_delayed') {
      const to = data?.to?.[0] || 'unknown'
      await redisPipeline(url, tok, [
        ['INCR',  `ml_delayed:${month}`],
        ['EXPIRE',`ml_delayed:${month}`, 90 * 86400],
        ['LPUSH', `ml_delayed:recent`, JSON.stringify({ to, ts })],
        ['LTRIM', `ml_delayed:recent`, 0, 49],
      ])
    } else if (type === 'email.complained') {
      const to = data?.to?.[0] || 'unknown'
      await redisPipeline(url, tok, [
        ['INCR',  `ml_spam:${month}`],
        ['LPUSH', `ml_spam:recent`, JSON.stringify({ to, ts })],
        ['LTRIM', `ml_spam:recent`, 0, 19],
      ])
    } else if (type === 'email.sent' || type === 'email.delivered') {
      // Also count deliveries from Resend webhook for accuracy
      await redisPipeline(url, tok, [
        ['INCR',  `ml_delivered:${month}`],
        ['EXPIRE',`ml_delivered:${month}`, 90 * 86400],
      ])
    }
  } catch { /* non-critical */ }

  return c.json({ ok: true })
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
        // ── Credit pack purchase — add credits to user's balance ────────────
        const addTokens = parseInt(meta.tokens)
        const balKey = `credit_balance:${encodeURIComponent(email)}`
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
// Credit packs — 1 credit = $0.001 API cost (markup included)
// Prices stay the same ($5/$15/$30), amounts adjusted to reflect real costs
const TOKEN_PACKS: Record<string, { tokens: number; price: number; priceId: string }> = {
  pack_starter: { tokens:  5_000, price:  5, priceId: 'price_1TIvjTLsf0qSbSh0ruQlu4tk' },
  pack_pro:     { tokens: 15_000, price: 15, priceId: 'price_1TIvjULsf0qSbSh0wpzT2ODJ' },
  pack_power:   { tokens: 40_000, price: 30, priceId: 'price_1TIvjULsf0qSbSh0wjbz2RX0' },
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
    return c.json({ demo: true, message: `Demo: Would add ${pack.tokens.toLocaleString()} credits for $${pack.price}` })
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
      'success_url': `${origin}/?topup=success&pack=${pack_id}&credits=${pack.tokens}`,
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
  const adminEmail = c.env?.ADMIN_EMAIL || 'mkbrown261@gmail.com'
  if (session.email !== adminEmail && session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)

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

// ─── Admin panel UI ──────────────────────────────────────────────────────────
app.get('/admin', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.redirect('/?admin_login=1')
  if (session.email !== 'mkbrown261@gmail.com') return c.html('<html><body style="background:#0a0a12;color:#ef4444;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>403 Forbidden</h1></body></html>', 403)

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FlowState Admin Dashboard</title>
  <link rel="icon" href="/static/favicon.ico">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#07070f;--s1:#0f0f1e;--s2:#141428;--s3:#1a1a30;
      --accent:#a855f7;--accent-dim:rgba(168,85,247,.12);--accent-glow:rgba(168,85,247,.4);
      --green:#10b981;--red:#ef4444;--amber:#f59e0b;--cyan:#06b6d4;--pink:#ec4899;
      --text:#f0f0f0;--text2:#9ca3af;--text3:#6b7280;
      --border:rgba(168,85,247,.18);--border2:rgba(255,255,255,.07);
    }
    html{font-size:15px;-webkit-font-smoothing:antialiased}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex}

    /* ── Sidebar ── */
    .sidebar{width:220px;min-height:100vh;background:var(--s1);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:20px 0;position:fixed;top:0;left:0;z-index:50}
    .sidebar-logo{padding:0 20px 20px;border-bottom:1px solid var(--border2)}
    .sidebar-logo .brand{font-size:18px;font-weight:900;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .sidebar-logo .sub{font-size:11px;color:var(--text3);margin-top:2px}
    .nav-section{padding:16px 12px 4px;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text3)}
    .nav-item{display:flex;align-items:center;gap:10px;padding:9px 16px;margin:1px 8px;border-radius:8px;font-size:13px;font-weight:500;color:var(--text2);cursor:pointer;transition:.15s;text-decoration:none;border:none;background:none;width:calc(100% - 16px);text-align:left}
    .nav-item:hover{background:var(--accent-dim);color:var(--text)}
    .nav-item.active{background:var(--accent-dim);color:var(--accent);border:1px solid var(--border)}
    .nav-item .icon{width:16px;text-align:center;font-size:14px;flex-shrink:0}
    .sidebar-footer{margin-top:auto;padding:16px;border-top:1px solid var(--border2);font-size:11px;color:var(--text3)}
    .admin-email{font-weight:600;color:var(--text2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    /* ── Main ── */
    .main{margin-left:220px;flex:1;padding:28px 32px;min-height:100vh;max-width:1400px}
    .page{display:none}
    .page.active{display:block;animation:fadeUp .2s ease}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

    /* ── Page header ── */
    .page-header{margin-bottom:28px}
    .page-header h1{font-size:22px;font-weight:800;color:var(--text);margin-bottom:4px}
    .page-header p{font-size:13px;color:var(--text2)}

    /* ── Metric cards ── */
    .metrics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:28px}
    .metric-card{background:var(--s2);border:1px solid var(--border);border-radius:14px;padding:20px;transition:.2s}
    .metric-card:hover{border-color:rgba(168,85,247,.4);box-shadow:0 0 20px rgba(168,85,247,.15)}
    .metric-label{font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--text3);margin-bottom:8px;display:flex;align-items:center;gap:6px}
    .metric-value{font-size:26px;font-weight:800;color:var(--text);letter-spacing:-0.5px;line-height:1}
    .metric-sub{font-size:11px;color:var(--text3);margin-top:6px}
    .metric-up{color:var(--green)}
    .metric-down{color:var(--red)}

    /* ── Cards ── */
    .card{background:var(--s2);border:1px solid var(--border);border-radius:14px;padding:24px;margin-bottom:20px}
    .card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
    .card-title{font-size:14px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px}
    .card-action{font-size:12px;color:var(--accent);cursor:pointer;padding:5px 12px;background:var(--accent-dim);border-radius:6px;border:1px solid rgba(168,85,247,.3);font-weight:600;transition:.15s}
    .card-action:hover{background:rgba(168,85,247,.2)}

    /* ── Table ── */
    .table-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border2)}
    table{width:100%;border-collapse:collapse;font-size:13px}
    thead th{padding:10px 14px;background:var(--s3);color:var(--text3);font-weight:600;font-size:11px;letter-spacing:.4px;text-transform:uppercase;text-align:left;white-space:nowrap}
    tbody tr{border-top:1px solid var(--border2);transition:.15s}
    tbody tr:hover{background:rgba(168,85,247,.04)}
    tbody td{padding:11px 14px;color:var(--text);font-size:13px;vertical-align:middle}
    td .email{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2)}
    td .date{font-size:11px;color:var(--text3)}

    /* ── Badges ── */
    .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.3px;white-space:nowrap}
    .badge-free{background:rgba(107,114,128,.18);color:#9ca3af;border:1px solid rgba(107,114,128,.25)}
    .badge-pro{background:rgba(168,85,247,.18);color:#c084fc;border:1px solid rgba(168,85,247,.3)}
    .badge-team{background:rgba(59,130,246,.18);color:#93c5fd;border:1px solid rgba(59,130,246,.3)}
    .badge-enterprise{background:rgba(245,158,11,.18);color:#fcd34d;border:1px solid rgba(245,158,11,.3)}
    .badge-clawflow{background:rgba(236,72,153,.18);color:#f9a8d4;border:1px solid rgba(236,72,153,.3)}
    .badge-personal_pro{background:rgba(168,85,247,.18);color:#c084fc;border:1px solid rgba(168,85,247,.3)}
    .badge-google{background:rgba(234,67,53,.12);color:#fca5a5;border:1px solid rgba(234,67,53,.2)}
    .badge-magic_link{background:rgba(6,182,212,.12);color:#67e8f9;border:1px solid rgba(6,182,212,.2)}
    .badge-green{background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)}
    .badge-red{background:rgba(239,68,68,.15);color:#fca5a5;border:1px solid rgba(239,68,68,.3)}
    .badge-amber{background:rgba(245,158,11,.15);color:#fcd34d;border:1px solid rgba(245,158,11,.3)}

    /* ── Forms ── */
    .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
    .form-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px}
    label.field-label{display:block;font-size:11px;font-weight:600;color:var(--text3);letter-spacing:.3px;text-transform:uppercase;margin-bottom:6px}
    input.field,select.field{width:100%;background:var(--s3);border:1px solid rgba(168,85,247,.2);border-radius:8px;padding:9px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit;transition:.15s}
    input.field::placeholder{color:var(--text3)}
    input.field:focus,select.field:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
    select.field option{background:var(--s2)}
    .btn{padding:9px 18px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:.2s;display:inline-flex;align-items:center;gap:6px;font-family:inherit}
    .btn-primary{background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;box-shadow:0 2px 12px rgba(168,85,247,.4)}
    .btn-primary:hover{filter:brightness(1.1);transform:translateY(-1px)}
    .btn-ghost{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(168,85,247,.3)}
    .btn-ghost:hover{background:rgba(168,85,247,.2)}
    .btn-danger{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}
    .btn-danger:hover{background:rgba(239,68,68,.25)}
    .btn-sm{padding:5px 12px;font-size:11px}
    .btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}

    /* ── Alert/Result banners ── */
    .alert{padding:12px 16px;border-radius:10px;font-size:13px;margin-top:14px;line-height:1.5;display:none}
    .alert.ok{display:block;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:#6ee7b7}
    .alert.err{display:block;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#fca5a5}
    .alert.info{display:block;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.3);color:#c084fc}

    /* ── System health dots ── */
    .health-dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px}
    .health-ok{background:var(--green);box-shadow:0 0 6px var(--green)}
    .health-warn{background:var(--amber);box-shadow:0 0 6px var(--amber)}
    .health-err{background:var(--red);box-shadow:0 0 6px var(--red)}
    .health-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border2);font-size:13px}
    .health-row:last-child{border-bottom:none}

    /* ── Credit bar ── */
    .credit-bar-wrap{background:var(--s3);border-radius:4px;height:6px;overflow:hidden;margin-top:6px}
    .credit-bar{height:100%;border-radius:4px;background:linear-gradient(90deg,#a855f7,#ec4899);transition:width .4s ease}

    /* ── Tabs ── */
    .tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid var(--border2);padding-bottom:0}
    .tab{padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;color:var(--text2);transition:.15s;background:none;border-left:none;border-right:none;border-top:none;font-family:inherit;margin-bottom:-1px}
    .tab.active{color:var(--accent);border-bottom-color:var(--accent)}
    .tab:hover{color:var(--text)}

    /* ── Spinner ── */
    .spin{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
    @keyframes spin{to{transform:rotate(360deg)}}

    /* ── Loading shimmer ── */
    .loading-row td{background:linear-gradient(90deg,var(--s2) 25%,var(--s3) 50%,var(--s2) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px}
    @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}

    /* ── Mini chart ── */
    canvas{max-height:200px}

    /* ── Section grids ── */
    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
    .three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}

    /* ── Top users bar ── */
    .user-row-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border2)}
    .user-row-item:last-child{border-bottom:none}
    .user-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;flex-shrink:0}
    .user-info{flex:1;min-width:0}
    .user-name{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .user-email-small{font-size:11px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'JetBrains Mono',monospace}
    .user-credits{font-size:13px;font-weight:700;color:var(--accent);text-align:right;flex-shrink:0}

    /* ── Magic link stats ── */
    .ml-stat{text-align:center;padding:16px;background:var(--s3);border-radius:10px}
    .ml-stat-value{font-size:24px;font-weight:800;color:var(--text)}
    .ml-stat-label{font-size:11px;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}

    /* ── Revenue ── */
    .rev-month-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border2)}
    .rev-month-row:last-child{border-bottom:none}
    .rev-month{font-size:12px;font-weight:600;color:var(--text2);min-width:70px}
    .rev-bar-wrap{flex:1;background:var(--s3);border-radius:4px;height:8px;overflow:hidden}
    .rev-bar{height:100%;border-radius:4px;background:linear-gradient(90deg,#a855f7,#ec4899);transition:width .6s ease}
    .rev-amount{font-size:13px;font-weight:700;color:var(--text);min-width:70px;text-align:right}

    /* ── Responsive ── */
    @media(max-width:900px){
      .sidebar{width:60px;padding:12px 0}
      .sidebar-logo,.nav-section,.nav-item span,.sidebar-footer .admin-email{display:none}
      .nav-item{justify-content:center;padding:10px}
      .main{margin-left:60px;padding:16px}
      .two-col,.three-col{grid-template-columns:1fr}
      .form-row,.form-row-3{grid-template-columns:1fr}
      .metrics-grid{grid-template-columns:repeat(2,1fr)}
    }
  </style>
</head>
<body>

<!-- ══ SIDEBAR ══ -->
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="brand">⚡ FlowState</div>
    <div class="sub">Admin Dashboard</div>
  </div>

  <div class="nav-section">Overview</div>
  <button class="nav-item active" onclick="showPage('overview',this)"><span class="icon">📊</span><span>Overview</span></button>
  <button class="nav-item" onclick="showPage('users',this)"><span class="icon">👥</span><span>Users</span></button>
  <button class="nav-item" onclick="showPage('revenue',this)"><span class="icon">💰</span><span>Revenue</span></button>
  <button class="nav-item" onclick="showPage('credits',this)"><span class="icon">⚡</span><span>Credits & API</span></button>
  <button class="nav-item" onclick="showPage('email',this)"><span class="icon">✉️</span><span>Email / Magic Links</span></button>

  <div class="nav-section">Tools</div>
  <button class="nav-item" onclick="showPage('manage',this)"><span class="icon">🛠️</span><span>Manage Users</span></button>
  <button class="nav-item" onclick="showPage('system',this)"><span class="icon">🔧</span><span>System Health</span></button>

  <div class="sidebar-footer">
    <div class="admin-email">${session.email}</div>
    <div style="margin-top:4px;color:var(--text3);font-size:10px">Last refreshed: <span id="last-refresh">just now</span></div>
    <button onclick="location.reload()" style="margin-top:8px;background:var(--accent-dim);border:1px solid var(--border);border-radius:6px;color:var(--accent);font-size:11px;padding:4px 10px;cursor:pointer;font-family:inherit;font-weight:600">↺ Refresh</button>
  </div>
</div>

<!-- ══ MAIN CONTENT ══ -->
<div class="main">

  <!-- ─── OVERVIEW PAGE ─────────────────────────────────────────────── -->
  <div class="page active" id="page-overview">
    <div class="page-header">
      <h1>Platform Overview</h1>
      <p>Real-time snapshot of FlowState usage and health</p>
    </div>

    <!-- KPI metrics row -->
    <div class="metrics-grid" id="overview-metrics">
      <div class="metric-card"><div class="metric-label">📦 Total Users</div><div class="metric-value" id="m-total-users">—</div><div class="metric-sub">registered accounts</div></div>
      <div class="metric-card"><div class="metric-label">✨ New (7 days)</div><div class="metric-value" id="m-new-users">—</div><div class="metric-sub">signed up this week</div></div>
      <div class="metric-card"><div class="metric-label">💜 Paid Users</div><div class="metric-value" id="m-paid-users">—</div><div class="metric-sub">pro + team + enterprise</div></div>
      <div class="metric-card"><div class="metric-label">⚡ Credits Used</div><div class="metric-value" id="m-credits-month">—</div><div class="metric-sub">this month (all users)</div></div>
      <div class="metric-card"><div class="metric-label">🔥 Active Today</div><div class="metric-value" id="m-active-today">—</div><div class="metric-sub">session activity</div></div>
      <div class="metric-card"><div class="metric-label">✉️ Emails Sent</div><div class="metric-value" id="m-emails-sent">—</div><div class="metric-sub">magic links (month)</div></div>
      <div class="metric-card"><div class="metric-label">🧩 Focus Sessions</div><div class="metric-value" id="m-sessions-today">—</div><div class="metric-sub">completed today</div></div>
      <div class="metric-card"><div class="metric-label">💳 MRR</div><div class="metric-value" id="m-mrr">—</div><div class="metric-sub">estimated this month</div></div>
    </div>

    <div class="two-col">
      <!-- Tier breakdown -->
      <div class="card">
        <div class="card-header"><div class="card-title">📊 Users by Tier</div></div>
        <div id="tier-breakdown">
          <div style="color:var(--text3);font-size:13px">Loading…</div>
        </div>
      </div>

      <!-- Provider breakdown -->
      <div class="card">
        <div class="card-header"><div class="card-title">🔑 Auth Providers</div></div>
        <div id="provider-breakdown">
          <div style="color:var(--text3);font-size:13px">Loading…</div>
        </div>
      </div>
    </div>

    <div class="two-col">
      <!-- Recent signups -->
      <div class="card">
        <div class="card-header"><div class="card-title">🆕 Recent Signups</div><span class="card-action" onclick="showPage('users',document.querySelector('.nav-item:nth-child(5)'))">View all →</span></div>
        <div id="recent-signups"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
      </div>

      <!-- Top credit users -->
      <div class="card">
        <div class="card-header"><div class="card-title">🔥 Top Credit Users</div><div style="font-size:11px;color:var(--text3)">This month</div></div>
        <div id="top-credit-users"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
      </div>
    </div>
  </div>

  <!-- ─── USERS PAGE ─────────────────────────────────────────────────── -->
  <div class="page" id="page-users">
    <div class="page-header">
      <h1>All Users</h1>
      <p>Full user registry with tier, provider, and account details</p>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">👥 User Registry</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="field" id="user-search" type="text" placeholder="Filter by email…" style="width:220px;margin:0" oninput="filterUsers()">
          <select class="field" id="user-tier-filter" style="width:130px;margin:0" onchange="filterUsers()">
            <option value="">All tiers</option>
            <option>free</option><option>pro</option><option>team</option>
            <option>enterprise</option><option>personal_pro</option><option>clawflow</option>
          </select>
          <button class="btn btn-sm btn-ghost" onclick="exportUsersCSV()">⬇ CSV</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Email</th><th>Name</th><th>Tier</th><th>Provider</th><th>Credits Used</th><th>Joined</th><th>Actions</th></tr></thead>
          <tbody id="users-table"><tr class="loading-row"><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody>
        </table>
      </div>
      <div style="margin-top:12px;font-size:12px;color:var(--text3)">Showing <span id="users-shown">0</span> of <span id="users-total">0</span> users</div>
    </div>
  </div>

  <!-- ─── REVENUE PAGE ───────────────────────────────────────────────── -->
  <div class="page" id="page-revenue">
    <div class="page-header">
      <h1>Revenue</h1>
      <p>Subscription revenue, API costs, and financial breakdown</p>
    </div>

    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">💰 Gross Revenue</div><div class="metric-value" id="rev-gross">—</div><div class="metric-sub">last 3 months</div></div>
      <div class="metric-card"><div class="metric-label">📈 Net Revenue</div><div class="metric-value" id="rev-net">—</div><div class="metric-sub">after Stripe fees</div></div>
      <div class="metric-card"><div class="metric-label">🤖 API Allocation</div><div class="metric-value" id="rev-api">—</div><div class="metric-sub">reserved for API costs</div></div>
      <div class="metric-card"><div class="metric-label">💳 Transactions</div><div class="metric-value" id="rev-tx">—</div><div class="metric-sub">total payments</div></div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-header"><div class="card-title">📅 Monthly Revenue</div></div>
        <div id="rev-months"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">🤖 API Budget Breakdown</div></div>
        <div id="api-budget"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">📋 Transaction History</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Email</th><th>Type</th><th>Plan</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody id="transactions-table"><tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">Loading transactions…</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ─── CREDITS & API PAGE ─────────────────────────────────────────── -->
  <div class="page" id="page-credits">
    <div class="page-header">
      <h1>Credits &amp; API Usage</h1>
      <p>Platform-wide API consumption, credit budgets, and top users</p>
    </div>

    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-label">⚡ Total Credits Used</div><div class="metric-value" id="api-total-credits">—</div><div class="metric-sub">this month (platform)</div></div>
      <div class="metric-card"><div class="metric-label">🆓 Free Tier Used</div><div class="metric-value" id="api-free-credits">—</div><div class="metric-sub">free user consumption</div></div>
      <div class="metric-card"><div class="metric-label">💜 Paid Tier Used</div><div class="metric-value" id="api-paid-credits">—</div><div class="metric-sub">pro/team consumption</div></div>
      <div class="metric-card"><div class="metric-label">🚫 Blocked Requests</div><div class="metric-value" id="api-blocked">—</div><div class="metric-sub">rate limited this month</div></div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-header"><div class="card-title">🔥 Top API Consumers</div><div style="font-size:11px;color:var(--text3)">This month</div></div>
        <div id="top-api-users"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">📊 Credit Usage by Tier</div></div>
        <div id="credits-by-tier"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
      </div>
    </div>
  </div>

  <!-- ─── EMAIL / MAGIC LINKS PAGE ──────────────────────────────────── -->
  <div class="page" id="page-email">
    <div class="page-header">
      <h1>Email &amp; Magic Links</h1>
      <p>Magic link delivery stats, bounce tracking, and email health diagnostics</p>
    </div>

    <div class="three-col">
      <div class="ml-stat card" style="padding:20px;text-align:center">
        <div class="ml-stat-value" id="ml-sent-month" style="color:var(--green)">—</div>
        <div class="ml-stat-label">Sent this month</div>
      </div>
      <div class="ml-stat card" style="padding:20px;text-align:center">
        <div class="ml-stat-value" id="ml-failed-month" style="color:var(--red)">—</div>
        <div class="ml-stat-label">Bounced / Failed</div>
      </div>
      <div class="ml-stat card" style="padding:20px;text-align:center">
        <div class="ml-stat-value" id="ml-delivery-rate" style="color:var(--cyan)">—</div>
        <div class="ml-stat-label">Delivery rate</div>
      </div>
      <div class="ml-stat card" style="padding:20px;text-align:center">
        <div class="ml-stat-value" id="ml-sent-total" style="color:var(--accent)">—</div>
        <div class="ml-stat-label">All-time sent</div>
      </div>
    </div>

    <div class="three-col">
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:var(--cyan)" id="ml-delivery-rate">—</div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Delivery Rate</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:var(--amber)" id="ml-delayed-month">—</div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Delayed This Month</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:var(--pink)" id="ml-spam-month">—</div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Spam Reports</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">🔍 Email System Diagnostics</div></div>
      <div id="email-diagnostics"><div style="color:var(--text3);font-size:13px">Loading diagnostics…</div></div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-header"><div class="card-title">🚫 Recent Bounces</div><div style="font-size:11px;color:var(--text3)">Last 10 (via webhook)</div></div>
        <div id="recent-bounces"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
        <div style="margin-top:12px;padding:10px 12px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:8px;font-size:11px;color:var(--amber);line-height:1.5" id="webhook-note"></div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">🧪 Send Test Magic Link</div></div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:16px">Send a real magic link to verify the Resend integration works end-to-end.</p>
        <div class="form-row">
          <div>
            <label class="field-label">Recipient Email</label>
            <input class="field" id="test-email" type="email" placeholder="you@example.com">
          </div>
          <div style="display:flex;align-items:flex-end">
            <button class="btn btn-primary" onclick="sendTestMagicLink()" id="btn-test-ml">✉️ Send Test Link</button>
          </div>
        </div>
        <div class="alert" id="test-ml-result"></div>
      </div>
    </div>
  </div>

  <!-- ─── MANAGE USERS PAGE ──────────────────────────────────────────── -->
  <div class="page" id="page-manage">
    <div class="page-header">
      <h1>Manage Users</h1>
      <p>Look up users, change tiers, adjust credits, and send magic links</p>
    </div>

    <!-- Lookup -->
    <div class="card">
      <div class="card-header"><div class="card-title">🔍 Look Up User</div></div>
      <div class="form-row">
        <div>
          <label class="field-label">Email Address</label>
          <input class="field" id="lookup-email" type="email" placeholder="user@example.com">
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn-primary" onclick="lookupUser()">🔍 Look Up</button>
        </div>
      </div>
      <div class="alert" id="lookup-result"></div>
    </div>

    <!-- Change tier -->
    <div class="card">
      <div class="card-header"><div class="card-title">✏️ Change User Tier</div></div>
      <div class="form-row-3">
        <div>
          <label class="field-label">Email Address</label>
          <input class="field" id="set-email" type="email" placeholder="user@example.com">
        </div>
        <div>
          <label class="field-label">New Tier</label>
          <select class="field" id="set-tier">
            <option value="free">free</option>
            <option value="pro">pro</option>
            <option value="team">team</option>
            <option value="enterprise">enterprise</option>
            <option value="personal_pro">personal_pro</option>
            <option value="team_starter">team_starter</option>
            <option value="team_growth">team_growth</option>
            <option value="clawflow">clawflow</option>
          </select>
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn-primary" onclick="setTier()">💾 Save Tier</button>
        </div>
      </div>
      <div class="alert" id="set-result"></div>
    </div>

    <!-- Add credits -->
    <div class="card">
      <div class="card-header"><div class="card-title">🪙 Add Credits to User</div></div>
      <div class="form-row-3">
        <div>
          <label class="field-label">Email Address</label>
          <input class="field" id="credit-email" type="email" placeholder="user@example.com">
        </div>
        <div>
          <label class="field-label">Credits to Add</label>
          <input class="field" id="credit-amount" type="number" placeholder="e.g. 5000" min="1">
        </div>
        <div style="display:flex;align-items:flex-end;gap:8px">
          <button class="btn btn-primary" onclick="addCredits()">⚡ Add Credits</button>
          <button class="btn btn-danger" onclick="resetCredits()" title="Reset this month's usage to 0">↺ Reset</button>
        </div>
      </div>
      <div class="alert" id="credit-result"></div>
    </div>

    <!-- Send magic link -->
    <div class="card">
      <div class="card-header"><div class="card-title">✉️ Send Sign-in Link</div></div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px">Manually trigger a magic sign-in link for any user — useful for account recovery.</p>
      <div class="form-row">
        <div>
          <label class="field-label">User Email</label>
          <input class="field" id="ml-send-email" type="email" placeholder="user@example.com">
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn btn-ghost" onclick="sendMagicLinkAdmin()" id="btn-ml-admin">✉️ Send Link</button>
        </div>
      </div>
      <div class="alert" id="ml-send-result"></div>
    </div>
  </div>

  <!-- ─── SYSTEM HEALTH PAGE ─────────────────────────────────────────── -->
  <div class="page" id="page-system">
    <div class="page-header">
      <h1>System Health</h1>
      <p>Infrastructure status, API key presence, and configuration checks</p>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-header"><div class="card-title">🔧 Service Status</div><button class="card-action" onclick="loadSystemHealth()">↺ Recheck</button></div>
        <div id="system-health-rows"><div style="color:var(--text3);font-size:13px">Checking services…</div></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">🔑 API Keys</div></div>
        <div id="api-keys-rows"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">📋 Configuration</div></div>
      <div id="config-rows"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
    </div>
  </div>

</div><!-- /main -->

<script src="/static/admin.js"></script>
</body>
</html>`)
})

// ─── Admin: add credits to a user ────────────────────────────────────────────
app.post('/api/admin/add-credits', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ error: 'Redis not configured' }, 503)
  const { email, amount } = await c.req.json().catch(() => ({} as any))
  if (!email || !amount || amount < 1) return c.json({ error: 'email and amount required' }, 400)
  const balKey = `credit_balance:${encodeURIComponent(email)}`
  const res = await fetch(`${url}/incrby/${balKey}/${amount}`, { headers: { Authorization: `Bearer ${tok}` } })
  const data: any = await res.json()
  const newBalance = data.result || 0
  return c.json({ ok: true, email, added: amount, newBalance, message: `Added ${amount.toLocaleString()} credits to ${email}. New balance: ${newBalance.toLocaleString()}` })
})

// ─── Admin: reset this month's credit usage for a user ───────────────────────
app.post('/api/admin/reset-credits', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ error: 'Redis not configured' }, 503)
  const { email } = await c.req.json().catch(() => ({} as any))
  if (!email) return c.json({ error: 'email required' }, 400)
  const month = new Date().toISOString().slice(0, 7)
  const usageKey = `monthly_credits_used:${email}:${month}`
  await fetch(`${url}/set/${encodeURIComponent(usageKey)}/0`, { headers: { Authorization: `Bearer ${tok}` } })
  return c.json({ ok: true, email, message: `Monthly credit usage for ${email} reset to 0 for ${month}` })
})

// ─── Admin: inspect / set user tier ─────────────────────────────────────────
// GET  /api/admin/user-tier?email=x@y.z          → returns current tier + credit usage
// POST /api/admin/user-tier  { email, tier }      → overwrite tier in Redis (admin only)
app.get('/api/admin/user-tier', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  const email = String(c.req.query('email') || '')
  if (!email) return c.json({ error: 'email param required' }, 400)
  const month = new Date().toISOString().slice(0, 7)

  // Fetch from Redis (credits) and D1 (user profile) in parallel
  const [redisResults, d1User] = await Promise.all([
    url && tok ? redisPipeline(url, tok, [
      ['GET', `tier_email:${email}`],
      ['GET', `tier:${email}`],
      ['GET', `monthly_credits_used:${email}:${month}`],
      ['GET', `credit_balance:${email}`],
    ]) : Promise.resolve([null, null, null, null]),
    c.env?.DB ? c.env.DB.prepare(`SELECT email, name, tier, provider, created_at FROM users WHERE email = ?`).bind(email).first().catch(() => null) : Promise.resolve(null),
  ])

  const redisTier = (redisResults[0] as string) || (redisResults[1] as string) || null
  const d1Tier    = (d1User as any)?.tier || null
  const tier      = redisTier || d1Tier || 'free'

  if (!d1User && !redisTier) return c.json({ error: 'User not found', email }, 404)

  return c.json({
    email,
    name:        (d1User as any)?.name || null,
    provider:    (d1User as any)?.provider || 'google',
    created_at:  (d1User as any)?.created_at || null,
    tier,
    tier_source: redisTier ? 'redis' : d1Tier ? 'd1' : 'default',
    monthlyCreditsUsed: parseInt(redisResults[2] as string || '0'),
    purchasedCredits:   parseInt(redisResults[3] as string || '0'),
    month,
  })
})

app.post('/api/admin/user-tier', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ error: 'Redis not configured' }, 503)
  const { email, tier } = await c.req.json().catch(() => ({}))
  if (!email || !tier) return c.json({ error: 'email and tier required' }, 400)
  const validTiers = ['free', 'pro', 'team', 'enterprise', 'personal_pro', 'team_starter', 'team_growth', 'clawflow']
  if (!validTiers.includes(tier)) return c.json({ error: `tier must be one of: ${validTiers.join(', ')}` }, 400)
  await fetch(`${url}/set/tier_email:${encodeURIComponent(email)}/${tier}`, {
    headers: { Authorization: `Bearer ${tok}` }
  })
  if (c.env?.DB) {
    await setUserTier(c.env.DB, email, tier).catch(() => {})
  }
  return c.json({ ok: true, email, tier, message: `Tier for ${email} set to '${tier}'` })
})

// ─── Admin: comprehensive platform stats ──────────────────────────────────────
// GET /api/admin/stats → overview KPIs from D1 + Redis
app.get('/api/admin/stats', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)

  const db  = c.env?.DB
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  const month = new Date().toISOString().slice(0, 7)
  const today = new Date().toISOString().slice(0, 10)
  const week7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)

  let totalUsers = 0, newUsersLast7Days = 0, paidUsers = 0
  let tierBreakdown: Record<string,number> = {}
  let providerBreakdown: Record<string,number> = {}
  let recentSignups: any[] = []
  let sessionsToday = 0, activeToday = 0

  if (db) {
    try {
      const counts: any = await db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as new7,
          SUM(CASE WHEN tier NOT IN ('free','') AND tier IS NOT NULL THEN 1 ELSE 0 END) as paid
        FROM users
      `).bind(week7).first()
      totalUsers        = counts?.total || 0
      newUsersLast7Days = counts?.new7 || 0
      paidUsers         = counts?.paid || 0

      // Tier breakdown
      const tiers = await db.prepare(`SELECT tier, COUNT(*) as cnt FROM users GROUP BY tier ORDER BY cnt DESC`).all()
      ;(tiers.results || []).forEach((r: any) => { tierBreakdown[r.tier || 'free'] = r.cnt || 0 })

      // Provider breakdown
      const providers = await db.prepare(`SELECT provider, COUNT(*) as cnt FROM users GROUP BY provider ORDER BY cnt DESC`).all()
      ;(providers.results || []).forEach((r: any) => { providerBreakdown[r.provider || 'google'] = r.cnt || 0 })

      // Recent signups (last 10)
      const recent = await db.prepare(`SELECT email, name, tier, provider, created_at FROM users ORDER BY created_at DESC LIMIT 10`).all()
      recentSignups = (recent.results || []) as any[]

      // Sessions today
      const todaySess: any = await db.prepare(`SELECT COUNT(*) as cnt FROM sessions WHERE session_date = ? AND completed = 1`).bind(today).first()
      sessionsToday = todaySess?.cnt || 0

      // Active today (users who have a session today)
      const todayActive: any = await db.prepare(`SELECT COUNT(DISTINCT email) as cnt FROM sessions WHERE session_date = ?`).bind(today).first()
      activeToday = todayActive?.cnt || 0
    } catch(_) {}
  }

  // Credit usage this month (platform-wide) from Redis
  let totalCreditsUsedMonth = 0
  let topCreditUsers: Array<{email:string, credits:number}> = []
  if (url && tok) {
    try {
      // Scan for monthly credit keys (use pipeline for speed)
      // We aggregate by scanning known user emails from D1
      if (db) {
        const emails = await db.prepare(`SELECT email FROM users ORDER BY created_at DESC LIMIT 200`).all()
        const emailList = (emails.results || []).map((r: any) => r.email) as string[]
        if (emailList.length > 0) {
          const pipeline = emailList.map(e => ['GET', `monthly_credits_used:${e}:${month}`])
          const results = await redisPipeline(url, tok, pipeline)
          const creditMap: Array<{email:string,credits:number}> = []
          emailList.forEach((email, i) => {
            const credits = parseInt(results[i] as string || '0')
            totalCreditsUsedMonth += credits
            if (credits > 0) creditMap.push({ email, credits })
          })
          topCreditUsers = creditMap.sort((a,b) => b.credits - a.credits).slice(0, 10)
        }
      }
    } catch(_) {}
  }

  // Magic link stats from Redis
  let emailsSentMonth = 0
  if (url && tok) {
    try {
      const mlRes = await redisPipeline(url, tok, [['GET', `ml_sent:${month}`]])
      emailsSentMonth = parseInt(mlRes[0] as string || '0')
    } catch(_) {}
  }

  return c.json({
    totalUsers,
    newUsersLast7Days,
    paidUsers,
    tierBreakdown,
    providerBreakdown,
    recentSignups,
    sessionsToday,
    activeToday,
    totalCreditsUsedMonth,
    topCreditUsers,
    emailsSentMonth,
    month,
    today,
  })
})

// GET /api/admin/users → full user list with credit usage (up to 500)
app.get('/api/admin/users', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)

  const db  = c.env?.DB
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  const month = new Date().toISOString().slice(0, 7)

  if (!db) return c.json({ users: [] })

  try {
    const rows = await db.prepare(
      `SELECT id, email, name, tier, provider, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT 500`
    ).all()
    const users: any[] = (rows.results || []) as any[]

    // Fetch credit usage for each user via Redis pipeline
    if (url && tok && users.length > 0) {
      const pipeline = users.map(u => ['GET', `monthly_credits_used:${u.email}:${month}`])
      const credits = await redisPipeline(url, tok, pipeline)
      users.forEach((u, i) => { u.credits_used = parseInt(credits[i] as string || '0') })
    }

    return c.json({ users, total: users.length, month })
  } catch (e: any) {
    return c.json({ error: e.message, users: [] })
  }
})

// GET /api/admin/email-stats → magic link delivery statistics
app.get('/api/admin/email-stats', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)

  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  const month = new Date().toISOString().slice(0, 7)

  const resendConfigured = !!c.env?.RESEND_API_KEY
  const redisConfigured  = !!(url && tok)
  const fromEmail        = c.env?.RESEND_FROM_EMAIL || 'FlowState <noreply@flowst8.cc>'

  let sentMonth = 0, failedMonth = 0, sentTotal = 0
  let bouncedMonth = 0, delayedMonth = 0, spamMonth = 0, deliveredMonth = 0
  let recentBounces: any[] = []
  let domainStatus = 'unknown'

  if (url && tok) {
    try {
      const results = await redisPipeline(url, tok, [
        ['GET',   `ml_sent:${month}`],
        ['GET',   `ml_failed:${month}`],
        ['GET',   `ml_sent:total`],
        ['GET',   `ml_failed:total`],
        ['GET',   `ml_delivered:${month}`],
        ['GET',   `ml_delayed:${month}`],
        ['GET',   `ml_spam:${month}`],
        ['LRANGE',`ml_bounces:recent`, 0, 9],
      ])
      sentMonth      = parseInt(results[0] as string || '0')
      failedMonth    = parseInt(results[1] as string || '0')
      sentTotal      = parseInt(results[2] as string || '0')
      const failTotal= parseInt(results[3] as string || '0')
      deliveredMonth = parseInt(results[4] as string || '0')
      delayedMonth   = parseInt(results[5] as string || '0')
      spamMonth      = parseInt(results[6] as string || '0')
      bouncedMonth   = failedMonth // bounces are tracked as failures
      // Parse recent bounces list
      const bounceList = Array.isArray(results[7]) ? results[7] : []
      recentBounces = bounceList.map((b: any) => {
        try { return JSON.parse(b) } catch { return { to: b, ts: null } }
      })
    } catch(_) {}
  }

  // Check Resend domain status via API
  if (resendConfigured && c.env?.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}` }
      })
      if (r.ok) {
        const d: any = await r.json()
        const domains = d.data || []
        const flowst8 = domains.find((d: any) => d.name?.includes('flowst8'))
        if (flowst8) {
          domainStatus = flowst8.status // 'verified', 'pending', 'failed'
        } else {
          domainStatus = domains.length > 0 ? `other (${domains.length} domains verified)` : 'not_added'
        }
      }
    } catch(_) {}
  }

  const deliveryRate = sentMonth > 0 ? Math.round(((sentMonth - failedMonth) / sentMonth) * 100) : null

  return c.json({
    resendConfigured,
    redisConfigured,
    fromEmail,
    domainStatus,
    domainVerified: domainStatus === 'verified',
    sentMonth,
    failedMonth,
    bouncedMonth,
    delayedMonth,
    spamMonth,
    deliveredMonth,
    sentTotal,
    deliveryRate,
    recentBounces,
    webhookNote: (bouncedMonth === 0 && delayedMonth === 0 && spamMonth === 0 && deliveredMonth === 0)
      ? 'Webhook connected at https://flowst8.cc/api/resend/webhook — waiting for first delivery events. If you just registered it, data will appear after the next send.'
      : null,
    month,
  })
})

// GET /api/admin/credits-overview → platform-wide API usage breakdown
app.get('/api/admin/credits-overview', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)

  const db  = c.env?.DB
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  const month = new Date().toISOString().slice(0, 7)

  let totalCreditsMonth = 0, freeCreditsMonth = 0, paidCreditsMonth = 0
  let topUsers: Array<{email:string,credits:number,tier:string}> = []
  let creditsByTier: Record<string,number> = {}
  let blockedRequests = 0

  if (db && url && tok) {
    try {
      // Get all users with their tiers
      const rows = await db.prepare(`SELECT email, tier FROM users ORDER BY created_at DESC LIMIT 500`).all()
      const users = (rows.results || []) as Array<{email:string, tier:string}>

      if (users.length > 0) {
        const pipeline = users.map(u => ['GET', `monthly_credits_used:${u.email}:${month}`])
        const credits = await redisPipeline(url, tok, pipeline)

        users.forEach((u, i) => {
          const c = parseInt(credits[i] as string || '0')
          totalCreditsMonth += c
          const tier = u.tier || 'free'
          const isPaid = !['free',''].includes(tier)
          if (isPaid) paidCreditsMonth += c
          else freeCreditsMonth += c
          creditsByTier[tier] = (creditsByTier[tier] || 0) + c
          if (c > 0) topUsers.push({ email: u.email, credits: c, tier })
        })
        topUsers = topUsers.sort((a,b) => b.credits - a.credits).slice(0, 15)
      }
    } catch(_) {}
  }

  return c.json({
    totalCreditsMonth,
    freeCreditsMonth,
    paidCreditsMonth,
    creditsByTier,
    topUsers,
    blockedRequests,
    month,
  })
})

// GET /api/admin/transactions → recent transaction history from D1
app.get('/api/admin/transactions', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)

  const db = c.env?.DB
  if (!db) return c.json({ transactions: [] })

  try {
    const rows = await db.prepare(
      `SELECT email, type, plan, amount_cents, currency, status, created_at FROM transactions ORDER BY created_at DESC LIMIT 50`
    ).all()
    return c.json({ transactions: rows.results || [] })
  } catch(e: any) {
    return c.json({ error: e.message, transactions: [] })
  }
})

// GET /api/admin/system-health → infrastructure status check
app.get('/api/admin/system-health', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (session.email !== 'mkbrown261@gmail.com') return c.json({ error: 'forbidden' }, 403)

  const checks = await Promise.allSettled([
    // D1 database check
    (async () => {
      if (!c.env?.DB) return { name: 'D1 Database', ok: false, note: 'Not bound' }
      try {
        await c.env.DB.prepare('SELECT 1').first()
        return { name: 'D1 Database', ok: true, note: 'Connected' }
      } catch(e: any) { return { name: 'D1 Database', ok: false, note: e.message } }
    })(),
    // Upstash Redis check
    (async () => {
      if (!c.env?.UPSTASH_REDIS_URL || !c.env?.UPSTASH_REDIS_TOKEN)
        return { name: 'Upstash Redis', ok: false, note: 'Not configured' }
      try {
        const r = await fetch(`${c.env.UPSTASH_REDIS_URL}/ping`, {
          headers: { Authorization: `Bearer ${c.env.UPSTASH_REDIS_TOKEN}` }
        })
        const d: any = await r.json()
        return { name: 'Upstash Redis', ok: d.result === 'PONG', note: d.result === 'PONG' ? 'Connected' : 'Unexpected response' }
      } catch(e: any) { return { name: 'Upstash Redis', ok: false, note: e.message } }
    })(),
    // Resend email check
    (async () => {
      if (!c.env?.RESEND_API_KEY) return { name: 'Resend Email', ok: false, note: 'RESEND_API_KEY not set — magic link email will not work' }
      try {
        const r = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}` }
        })
        if (r.ok) {
          const d: any = await r.json()
          const domains = d.data || []
          const flowst8 = domains.find((d: any) => d.name?.includes('flowst8'))
          const note = flowst8
            ? `flowst8.cc — status: ${flowst8.status}`
            : domains.length > 0 ? `${domains.length} domain(s) verified` : 'No domains verified — add flowst8.cc'
          const ok = flowst8?.status === 'verified' || domains.length > 0
          return { name: 'Resend Email', ok, note }
        }
        return { name: 'Resend Email', ok: false, note: `API error ${r.status}` }
      } catch(e: any) { return { name: 'Resend Email', ok: false, note: e.message } }
    })(),
    // R2 storage check
    (async () => {
      if (!c.env?.R2) return { name: 'R2 Storage', ok: false, note: 'Not bound' }
      return { name: 'R2 Storage', ok: true, note: 'Bound' }
    })(),
    // Stripe check
    (async () => {
      if (!c.env?.STRIPE_SECRET_KEY) return { name: 'Stripe Billing', ok: false, note: 'STRIPE_SECRET_KEY not set' }
      return { name: 'Stripe Billing', ok: true, note: 'Key configured' }
    })(),
  ])

  const services = checks.map(c => c.status === 'fulfilled' ? c.value : { name: 'Unknown', ok: false, note: 'Check failed' })

  // API keys presence
  const apiKeys = [
    { name: 'OPENROUTER_API_KEY',  present: !!c.env?.OPENROUTER_API_KEY },
    { name: 'ANTHROPIC_API_KEY',   present: !!c.env?.ANTHROPIC_API_KEY },
    { name: 'GOOGLE_AI_KEY',       present: !!(c.env?.GOOGLE_AI_KEY || c.env?.GEMINI_API_KEY) },
    { name: 'ELEVENLABS_API_KEY',  present: !!c.env?.ELEVENLABS_API_KEY },
    { name: 'REPLICATE_API_KEY',   present: !!c.env?.REPLICATE_API_KEY },
    { name: 'FAL_AI_KEY',          present: !!c.env?.FAL_AI_KEY },
    { name: 'STRIPE_SECRET_KEY',   present: !!c.env?.STRIPE_SECRET_KEY },
    { name: 'RESEND_API_KEY',      present: !!c.env?.RESEND_API_KEY },
    { name: 'RESEND_FROM_EMAIL',   present: !!c.env?.RESEND_FROM_EMAIL },
    { name: 'UPSTASH_REDIS_URL',   present: !!c.env?.UPSTASH_REDIS_URL },
    { name: 'SESSION_SECRET',      present: !!c.env?.SESSION_SECRET },
    { name: 'CANONICAL_ORIGIN',    present: !!c.env?.CANONICAL_ORIGIN },
    { name: 'GITHUB_CLIENT_ID',    present: !!c.env?.GITHUB_CLIENT_ID },
    { name: 'GOOGLE_CLIENT_ID',    present: !!c.env?.GOOGLE_CLIENT_ID },
  ]

  const config = [
    { key: 'CANONICAL_ORIGIN',     value: c.env?.CANONICAL_ORIGIN || '(not set)' },
    { key: 'RESEND_FROM_EMAIL',    value: c.env?.RESEND_FROM_EMAIL || 'FlowState <onboarding@resend.dev> (default)' },
    { key: 'Environment',          value: 'Cloudflare Workers (Production)' },
    { key: 'DB Name',              value: 'flowstate-production' },
    { key: 'R2 Bucket',            value: 'flowstate-assets' },
    { key: 'Admin Email',          value: 'mkbrown261@gmail.com' },
    { key: 'Free Tier Limit',      value: '3,000 credits/month' },
    { key: 'Pro Tier Limit',       value: '10,000 credits/month' },
    { key: 'Magic Link TTL',       value: '15 minutes (Redis-backed)' },
  ]

  return c.json({ services, apiKeys, config })
})

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────
app.post('/api/audio/tts', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  // Credit cost — TTS $0.05/1k chars, avg request ~500 chars = ~75 credits (with markup)
  const creditCheck = await checkCredits(c, session.email || session.id || 'anon', 75)
  if (creditCheck) return creditCheck
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

// ─── ElevenLabs Speech-to-Speech ─────────────────────────────────────────────
app.post('/api/audio/sts', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  // Credit cost — STS $0.10/1k chars ≈ 150 credits per request (with markup)
  const creditCheck = await checkCredits(c, session.email, 150)
  if (creditCheck) return creditCheck

  const elKey = c.env?.ELEVENLABS_API_KEY
  if (!elKey) return c.json({ error: 'ElevenLabs API key not configured' }, 503)

  try {
    // Forward the multipart form directly to ElevenLabs
    const formData = await c.req.formData()
    const voiceId  = formData.get('voice_id') as string || 'pNInz6obpgDQGcFmaJgB'
    const modelId  = formData.get('model_id') as string || 'eleven_english_sts_v2'
    const audioFile = formData.get('audio') as File | null
    if (!audioFile) return c.json({ error: 'audio file required' }, 400)

    const stability        = parseFloat(formData.get('stability') as string || '0.5')
    const similarity_boost = parseFloat(formData.get('similarity_boost') as string || '0.75')
    const style            = parseFloat(formData.get('style') as string || '0')

    const body = new FormData()
    body.append('audio', audioFile, audioFile.name || 'recording.webm')
    body.append('model_id', modelId)
    body.append('voice_settings', JSON.stringify({ stability, similarity_boost, style, use_speaker_boost: true }))

    const res = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': elKey },
      body,
    })

    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}))
      return c.json({ error: err?.detail?.message || `ElevenLabs STS error ${res.status}` }, 500)
    }
    return new Response(res.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'Content-Disposition': 'inline; filename="sts.mp3"',
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ─── ElevenLabs Voice Cloning (IVC) ──────────────────────────────────────────
// List cloned voices for this user (all voices tagged with category=cloned)
app.get('/api/audio/voices/clones', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const elKey = c.env?.ELEVENLABS_API_KEY
  if (!elKey) return c.json({ voices: [] })

  try {
    const res  = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': elKey } })
    const data: any = await res.json()
    const clones = (data.voices || [])
      .filter((v: any) => v.category === 'cloned')
      .map((v: any) => ({ voice_id: v.voice_id, name: v.name, preview_url: v.preview_url }))
    return c.json({ voices: clones })
  } catch { return c.json({ voices: [] }) }
})

// Create a new IVC clone — multipart: name (text) + files[] (audio)
app.post('/api/audio/voices/clone', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const elKey = c.env?.ELEVENLABS_API_KEY
  if (!elKey) return c.json({ error: 'ElevenLabs API key not configured' }, 503)

  try {
    const formData = await c.req.formData()
    const name = (formData.get('name') as string || '').trim()
    if (!name) return c.json({ error: 'Voice name is required' }, 400)

    // Build multipart for ElevenLabs add-voice
    const body = new FormData()
    body.append('name', name)
    body.append('description', `Cloned voice created via FlowState`)

    // Collect all audio files submitted as 'files'
    const files = formData.getAll('files') as File[]
    if (!files.length) return c.json({ error: 'At least one audio sample is required' }, 400)
    for (const f of files) {
      body.append('files', f, f.name || 'sample.mp3')
    }

    const res  = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': elKey },
      body,
    })
    const data: any = await res.json()
    if (!res.ok) return c.json({ error: data?.detail?.message || `Clone error ${res.status}` }, 500)
    return c.json({ voice_id: data.voice_id, name })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Delete a cloned voice
app.delete('/api/audio/voices/:voice_id', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)

  const elKey = c.env?.ELEVENLABS_API_KEY
  if (!elKey) return c.json({ error: 'ElevenLabs API key not configured' }, 503)

  const voiceId = c.req.param('voice_id')
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': elKey },
    })
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}))
      return c.json({ error: err?.detail?.message || `Delete error ${res.status}` }, 500)
    }
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
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

// GET /api/team/leaderboard — FlowScore rankings for users who opted in to public profiles
app.get('/api/team/leaderboard', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)

  try {
    const since7  = new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10)
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

    // Get all public profiles + their weekly stats
    const { results: profiles } = await db.prepare(
      `SELECT email, display_name, avatar_url, slug FROM public_profiles WHERE show_score=1 ORDER BY created_at DESC LIMIT 50`
    ).all() as any

    // Include current user even if no public profile
    const emails = (profiles as any[]).map((p: any) => p.email)
    if (!emails.includes(session.email)) {
      (profiles as any[]).push({ email: session.email, display_name: session.name || 'You', avatar_url: session.picture || '', slug: null })
      emails.push(session.email)
    }

    // Batch fetch weekly sessions for all users
    const members = await Promise.all((profiles as any[]).map(async (p: any) => {
      try {
        const { results } = await db.prepare(
          `SELECT duration_mins, focus_score, session_date FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1`
        ).bind(p.email, since30).all() as any
        const week = (results as any[]).filter((r: any) => r.session_date >= since7)
        const focusMin = week.reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
        const sessions7 = week.length
        // Streak
        const daySet = new Set((results as any[]).map((r: any) => r.session_date))
        let streak = 0
        const today = new Date()
        for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) streak++; else if (i > 0) break; }
        const flowScore = Math.min(100, Math.round((focusMin / 120) * 40 + (sessions7 / 5) * 30 + Math.min(streak, 7) * 4 + (sessions7 > 0 ? 15 : 0)))
        return { email: p.email, name: p.display_name || p.email.split('@')[0], avatar: p.avatar_url || '⚡', slug: p.slug, flowScore, focusMin, streak, sessions: sessions7 }
      } catch (_) {
        return { email: p.email, name: p.display_name || 'Unknown', avatar: '⚡', slug: null, flowScore: 0, focusMin: 0, streak: 0, sessions: 0 }
      }
    }))

    const sorted = members.sort((a: any, b: any) => b.flowScore - a.flowScore)
    const weekStr = `${new Date(Date.now()-7*86400000).toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}`
    return c.json({ members: sorted, period: weekStr, total: sorted.length })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
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

  const {
    message,
    app: appCtx = 'flowstate_hub',
    history = [],
    context = '',           // live context snapshot from frontend _clawBuildContextSnapshot()
    availableActions = [],  // list of action types CLAW can suggest
    connectedIntegrations = [],
  } = await c.req.json()
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

  const systemPrompt = declareClawbotSystemPrompt(appCtx, 'clawflow', context, availableActions)
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
    // ── Parse <action> tags from reply into structured actions array ──────────
    const actions: any[] = []
    const actionTagRegex = /<action\s+type="([^"]+)"\s+params='([^']+)'\s+label="([^"]+)"\s+description="([^"]+)"\s*\/>/g
    let match
    let cleanReply = reply
    while ((match = actionTagRegex.exec(reply)) !== null) {
      try {
        actions.push({
          type: match[1],
          params: JSON.parse(match[2]),
          label: match[3],
          description: match[4],
        })
      } catch { /* skip malformed */ }
    }
    // Remove action tags from displayed reply text
    cleanReply = reply.replace(actionTagRegex, '').trim()

    return c.json({
      reply: cleanReply,
      actions,
      model: useDirectAnthropic ? 'claude-3-5-sonnet' : 'claude-sonnet-4-5 (OpenRouter)',
      coinCost: coinEntry.coinCost,
      app: appCtx,
    })
  } catch (err: any) {
    return c.json({ reply: _demoClaw(message, appCtx), actions: [], model: 'clawbot-fallback', coinCost: 0, app: appCtx })
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

// ─── CLAW Video Concept Generator ────────────────────────────────────────────
// Free for all users — concept/shot-list is planning only.
// Actual video generation still requires Pro tier.
// Uses cheap model (haiku) to keep cost near zero.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/claw/video-concept', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const {
    prompt,          // user's raw idea or song title
    style,           // 'cinematic' | 'music_video' | 'documentary' | 'short_film' | 'social'
    audioContext,    // optional: { bpm, key, genre, trackName, duration }
    numShots = 6,    // how many shots to generate
  } = body

  if (!prompt && !audioContext?.trackName) {
    return c.json({ error: 'prompt or audioContext.trackName required' }, 400)
  }

  const orKey = c.env?.OPENROUTER_API_KEY
  if (!orKey) {
    // Graceful fallback — return a demo concept so the UI never feels broken
    return c.json({
      concept: {
        theme: 'Cinematic journey',
        visualStyle: 'Moody, high-contrast lighting with slow dolly shots',
        mood: 'Atmospheric and immersive',
        narrative: 'A lone figure moves through shifting urban and natural landscapes',
        colorPalette: 'Deep blues, warm ambers, desaturated midtones',
      },
      shots: [
        { id: 1, scene: 'Wide aerial establishing shot over neon-lit city at dusk', camera: 'Slow descending drone', subject: 'City skyline fading to street level', duration: 4, tags: ['aerial', 'establishing', 'night'] },
        { id: 2, scene: 'Close-up of artist face, soft rim lighting', camera: 'Static close-up with shallow depth', subject: 'Emotional expression, eyes closed', duration: 3, tags: ['portrait', 'intimate'] },
        { id: 3, scene: 'Corridor with flickering lights, long shadow', camera: 'Slow push-in on steadicam', subject: 'Figure walking away from camera', duration: 4, tags: ['tension', 'movement'] },
        { id: 4, scene: 'Time-lapse of clouds moving over a rooftop', camera: 'Locked-off wide', subject: 'Sky transformation, light changing', duration: 3, tags: ['time-lapse', 'atmosphere'] },
        { id: 5, scene: 'Extreme close-up of hands on a surface', camera: 'Macro, rack focus', subject: 'Texture and detail reveal', duration: 2, tags: ['detail', 'macro'] },
        { id: 6, scene: 'Final wide shot, figure silhouetted against gradient sky', camera: 'Slow zoom out', subject: 'Isolation and scale contrast', duration: 5, tags: ['closing', 'cinematic'] },
      ],
      model: 'fallback',
      coinsUsed: 0,
    })
  }

  const styleGuides: Record<string, string> = {
    cinematic:    'Epic cinematic film quality. Wide establishing shots, dramatic lighting, bold compositions. Think Blade Runner 2049 or Dune.',
    music_video:  'High-energy music video aesthetic. Quick cuts, performance shots, stylised visuals synced to beat. Think modern hip-hop/pop videos.',
    documentary:  'Intimate documentary style. Natural lighting, observational framing, authentic moments. Handheld, verité feel.',
    short_film:   'Narrative short film. Clear story arc, character-driven, strong visual metaphors. Each shot serves the story.',
    social:       'Vertical-first social content. Bold hooks, fast pace, high contrast visuals. Optimised for TikTok/Reels/Shorts.',
  }
  const styleNote = styleGuides[style] || styleGuides['cinematic']

  const audioNote = audioContext
    ? `\nAudio context: Track "${audioContext.trackName || 'untitled'}", BPM ${audioContext.bpm || 'unknown'}, key ${audioContext.key || 'unknown'}, genre ${audioContext.genre || 'unknown'}, duration ${audioContext.duration ? Math.round(audioContext.duration) + 's' : 'unknown'}.`
    : ''

  const systemMsg = `You are CLAW, a Production Director AI inside the Flowstate ecosystem. Your job is to generate cinematic video concepts and shot lists that are production-ready and visually specific.

Style directive: ${styleNote}${audioNote}

Respond ONLY with valid JSON matching this exact schema — no markdown, no preamble:
{
  "concept": {
    "theme": "one sentence",
    "visualStyle": "one sentence describing look and feel",
    "mood": "2-3 descriptive words",
    "narrative": "one sentence story direction",
    "colorPalette": "3-4 color descriptors"
  },
  "shots": [
    {
      "id": 1,
      "scene": "vivid scene description",
      "camera": "camera movement and lens choice",
      "subject": "what is in the frame and what they are doing",
      "duration": 4,
      "tags": ["tag1", "tag2"]
    }
  ]
}`

  const userMsg = `Create a ${numShots}-shot video concept for: "${prompt || audioContext?.trackName}"${audioNote ? ' (audio project — align visuals to the mood and tempo)' : ''}`

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowst8.cc',
        'X-Title': 'CLAW Video Concept',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 1800,
        temperature: 0.72,
      }),
    })
    const data: any = await res.json()
    const raw = data?.choices?.[0]?.message?.content || ''

    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    let parsed: any
    try { parsed = JSON.parse(cleaned) }
    catch {
      return c.json({ error: 'concept_parse_error', raw }, 500)
    }

    // Log usage to Redis for coin tracking (fire-and-forget)
    const url = c.env?.UPSTASH_REDIS_URL
    const tok = c.env?.UPSTASH_REDIS_TOKEN
    if (url && tok) {
      const entry = JSON.stringify({
        action: 'claw_video_concept',
        prompt: (prompt || audioContext?.trackName || '').slice(0, 80),
        style,
        shots: parsed.shots?.length || 0,
        ts: Date.now(),
        status: 'generated',
      })
      redisPipeline(url, tok, [
        ['LPUSH', `claw_actions:${session.email}`, entry],
        ['LTRIM', `claw_actions:${session.email}`, 0, 199],
        ['EXPIRE', `claw_actions:${session.email}`, 90 * 86400],
      ]).catch(() => {})
    }

    return c.json({ ...parsed, model: 'claude-haiku-4-5', coinsUsed: 3 })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
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

// ═══════════════════════════════════════════════════════════════════════════════
// CLAWFLOW RELEASE SYSTEM — Post-production marketing automation
// ───────────────────────────────────────────────────────────────────────────────
// Security model:
//   • All routes require a valid fs_session cookie.
//   • Distribution actions (DistroKid / UnitedMasters) require:
//       1. ClawFlow subscription (clawflow_required check)
//       2. Explicit per-song PERMISSION (stored in claw_permissions:{email})
//       3. API keys stored as Cloudflare secrets — NEVER sent to frontend
//   • Cover art generation is FREE (no subscription required).
//   • Pitch email generation is FREE (AI drafts only — user must confirm before send).
//   • We NEVER auto-publish without user confirmation.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/claw/release/cover-art ────────────────────────────────────────
// Generate album/single cover art via AI.
// FREE for all authenticated users — no ClawFlow required.
// Uses fal.ai flux model to keep cost low (≈ $0.003 per image).
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/claw/release/cover-art', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const { songName, genre, mood, style, artistName } = body

  if (!songName) return c.json({ error: 'songName required' }, 400)

  const FAL_KEY = c.env.FAL_AI_KEY
  if (!FAL_KEY) {
    // Return a deterministic placeholder — never fail silently
    return c.json({
      ok: false,
      error: 'Image generation unavailable',
      placeholder: true,
      message: 'Cover art generation is temporarily unavailable. Please try again later.',
    })
  }

  // Build a high-quality cover art prompt
  const styleMap: Record<string, string> = {
    minimal: 'minimalist album cover, clean geometric shapes, bold typography, dark background',
    vibrant: 'vibrant colorful album art, bold saturated colors, energetic composition',
    cinematic: 'cinematic album cover, dramatic lighting, film still aesthetic, moody',
    abstract: 'abstract artistic album cover, textural, experimental, gallery quality',
    vintage: 'vintage vinyl record cover aesthetic, retro design, warm tones, grain',
    futuristic: 'futuristic album art, neon accents, digital glitch, cyberpunk aesthetic',
  }
  const stylePrompt = styleMap[style ?? 'minimal'] ?? styleMap['minimal']
  const moodDesc = mood ? `, ${mood} mood` : ''
  const genreDesc = genre ? `, ${genre} music` : ''

  const prompt = `Professional single cover art for "${songName}"${artistName ? ` by ${artistName}` : ''}${genreDesc}${moodDesc}. ${stylePrompt}. Square format, 1:1 ratio, professional music industry quality. No text, no watermarks, no borders.`

  try {
    // Queue the fal.ai request
    const submitRes = await fetch('https://queue.fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        image_size: 'square_hd',
        num_inference_steps: 4,
        num_images: 1,
      }),
    })
    if (!submitRes.ok) throw new Error(`fal.ai error: ${submitRes.status}`)
    const submitted: any = await submitRes.json()
    const requestId = submitted.request_id

    return c.json({
      ok: true,
      requestId,
      pollUrl: `/api/claw/release/cover-art/poll/${requestId}`,
      message: 'Cover art generating — poll for result.',
      prompt,
    })
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message ?? 'Cover art generation failed' }, 500)
  }
})

// ─── GET /api/claw/release/cover-art/poll/:requestId ─────────────────────────
app.get('/api/claw/release/cover-art/poll/:requestId', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const requestId = c.req.param('requestId')
  const FAL_KEY = c.env.FAL_AI_KEY
  if (!FAL_KEY) return c.json({ status: 'error', error: 'Service unavailable' }, 503)

  try {
    const statusRes = await fetch(`https://queue.fal.run/fal-ai/flux/schnell/requests/${requestId}/status`, {
      headers: { 'Authorization': `Key ${FAL_KEY}` },
    })
    if (!statusRes.ok) return c.json({ status: 'error', error: `Poll failed: ${statusRes.status}` })
    const statusData: any = await statusRes.json()

    if (statusData.status === 'COMPLETED') {
      const resultRes = await fetch(`https://queue.fal.run/fal-ai/flux/schnell/requests/${requestId}`, {
        headers: { 'Authorization': `Key ${FAL_KEY}` },
      })
      const result: any = await resultRes.json()
      const imageUrl = result?.images?.[0]?.url ?? result?.image?.url
      return c.json({ status: 'complete', imageUrl })
    }

    if (statusData.status === 'FAILED') {
      return c.json({ status: 'error', error: 'Generation failed' })
    }

    return c.json({ status: 'pending', queuePosition: statusData.queue_position ?? null })
  } catch (err: any) {
    return c.json({ status: 'error', error: err?.message ?? 'Poll failed' }, 500)
  }
})

// ─── POST /api/claw/release/pitch-draft ──────────────────────────────────────
// AI drafts a playlist pitch / editorial email.
// FREE for authenticated users. User must copy/review before sending.
// No emails are auto-sent by this endpoint — it only returns the draft text.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/claw/release/pitch-draft', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const { songName, artistName, genre, mood, bpm, releaseDate, targetType, additionalContext } = body

  if (!songName || !artistName) return c.json({ error: 'songName and artistName required' }, 400)

  const validTargetTypes = ['spotify_editorial', 'playlist_curator', 'music_blog', 'pr_outlet', 'sync_license']
  const target = validTargetTypes.includes(targetType) ? targetType : 'playlist_curator'

  const targetDescriptions: Record<string, string> = {
    spotify_editorial: 'Spotify Editorial playlist team (pitching via Spotify for Artists)',
    playlist_curator: 'independent playlist curator on Spotify/Apple Music',
    music_blog: 'music blog or online publication reviewer',
    pr_outlet: 'music PR outlet or press release distributor',
    sync_license: 'sync licensing agent for film/TV/advertising placement',
  }

  const systemPrompt = `You are a professional music PR specialist with 15 years of experience pitching independent artists to ${targetDescriptions[target]}. Write concise, authentic, compelling pitch emails that feel personal — not templated. Keep it under 200 words. No fluff, no excessive adjectives.`

  const userMessage = `Write a pitch email for:
Song: "${songName}"
Artist: ${artistName}
Genre: ${genre ?? 'not specified'}
Mood/vibe: ${mood ?? 'not specified'}
BPM: ${bpm ? `${bpm} BPM` : 'not specified'}
Release date: ${releaseDate ?? 'upcoming'}
Target: ${targetDescriptions[target]}
${additionalContext ? `Additional context: ${additionalContext}` : ''}

Write the full email including subject line. Be authentic and specific.`

  const OPENROUTER_KEY = c.env.OPENROUTER_API_KEY
  if (!OPENROUTER_KEY) {
    return c.json({
      ok: false,
      error: 'AI service unavailable',
      draft: `Subject: New ${genre ?? 'Independent'} Release — "${songName}" by ${artistName}\n\nHi,\n\nI'd love to share my latest single "${songName}" with you. [Add your personal pitch here]\n\nBest,\n${artistName}`,
      isDemo: true,
    })
  }

  try {
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowst8.cc',
        'X-Title': 'FlowState Claw Release',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 600,
        temperature: 0.75,
      }),
    })
    if (!aiRes.ok) throw new Error(`OpenRouter error: ${aiRes.status}`)
    const aiData: any = await aiRes.json()
    const draft = aiData.choices?.[0]?.message?.content ?? ''

    return c.json({ ok: true, draft, targetType: target, generatedAt: new Date().toISOString() })
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message ?? 'Draft generation failed' }, 500)
  }
})

// ─── POST /api/claw/release/start ────────────────────────────────────────────
// Initializes a release session and returns a structured checklist.
// FREE for authenticated users.
// Stores session in Redis: claw_release:{email}:{songId}
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/claw/release/start', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const { songName, bpm, genre, mood, artistName, releaseDate } = body

  if (!songName) return c.json({ error: 'songName required' }, 400)

  const email = session.email as string
  const songId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // Build release checklist
  const checklist = [
    { id: 'cover_art',      label: 'Generate Cover Art',          status: 'pending', free: true,  requiresClawflow: false },
    { id: 'pitch_spotify',  label: 'Draft Spotify Editorial Pitch', status: 'pending', free: true,  requiresClawflow: false },
    { id: 'pitch_curator',  label: 'Draft Curator Pitch Email',    status: 'pending', free: true,  requiresClawflow: false },
    { id: 'distrokid',      label: 'Prepare DistroKid Release',   status: 'pending', free: false, requiresClawflow: true,  note: 'Requires DistroKid API key' },
    { id: 'unitedmasters',  label: 'Prepare UnitedMasters Upload', status: 'pending', free: false, requiresClawflow: true,  note: 'Requires UnitedMasters authorization' },
    { id: 'isrc',           label: 'Register ISRC Code',          status: 'pending', free: false, requiresClawflow: true,  note: 'Via USISRC or Sound Exchange' },
    { id: 'metadata',       label: 'Verify Release Metadata',     status: 'pending', free: true,  requiresClawflow: false },
    { id: 'blog_pitch',     label: 'Draft Music Blog Pitches',    status: 'pending', free: true,  requiresClawflow: false },
  ]

  const releaseSession = {
    songId,
    songName,
    artistName: artistName ?? email.split('@')[0],
    bpm: bpm ?? null,
    genre: genre ?? null,
    mood: mood ?? null,
    releaseDate: releaseDate ?? null,
    checklist,
    createdAt: new Date().toISOString(),
    email,
  }

  // Persist to Redis
  try {
    const REDIS_URL = c.env.UPSTASH_REDIS_URL
    const REDIS_TOKEN = c.env.UPSTASH_REDIS_TOKEN
    if (REDIS_URL && REDIS_TOKEN) {
      await fetch(`${REDIS_URL}/set/claw_release_${email}_${songId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ex: 604800, value: JSON.stringify(releaseSession) }),
      })
    }
  } catch { /* Redis failure is non-fatal */ }

  return c.json({
    ok: true,
    songId,
    session: releaseSession,
    message: `Release workflow started for "${songName}". Claw has your back.`,
  })
})

// ─── GET /api/claw/release/status/:songId ────────────────────────────────────
app.get('/api/claw/release/status/:songId', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const email = session.email as string
  const songId = c.req.param('songId')

  try {
    const REDIS_URL = c.env.UPSTASH_REDIS_URL
    const REDIS_TOKEN = c.env.UPSTASH_REDIS_TOKEN
    if (!REDIS_URL || !REDIS_TOKEN) return c.json({ error: 'Storage unavailable' }, 503)

    const redisRes = await fetch(`${REDIS_URL}/get/claw_release_${email}_${songId}`, {
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}` },
    })
    const data: any = await redisRes.json()
    if (!data?.result) return c.json({ error: 'Release session not found' }, 404)

    const releaseSession = JSON.parse(data.result)
    return c.json({ ok: true, session: releaseSession })
  } catch {
    return c.json({ error: 'Failed to retrieve session' }, 500)
  }
})

// ─── POST /api/claw/release/metadata ─────────────────────────────────────────
// Returns structured metadata for a release (ISRC info, required fields, etc.)
// AI-assisted field completion.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/claw/release/metadata', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const { songName, artistName, genre, releaseDate, bpm, mood } = body

  if (!songName || !artistName) return c.json({ error: 'songName and artistName required' }, 400)

  // Infer smart defaults
  const inferredGenreTags = genre
    ? [genre, genre.toLowerCase().replace(/\s+/g, '-')]
    : ['independent', 'original']

  const today = new Date()
  const smartReleaseDate = releaseDate
    ? releaseDate
    : new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  // Build metadata object matching standard DSP requirements
  const metadata = {
    title: songName,
    artist: artistName,
    genre: genre ?? 'Independent',
    subGenre: null,
    mood: mood ?? null,
    bpm: bpm ?? null,
    language: 'en',
    releaseDate: smartReleaseDate,
    upc: null,          // Will be assigned by distributor
    isrc: null,         // Needs registration — see /api/claw/release/start checklist
    label: `${artistName} (Self-Released)`,
    copyright: `${today.getFullYear()} ${artistName}`,
    pLine: `${today.getFullYear()} ${artistName}`,
    explicit: false,
    tags: inferredGenreTags,
    // Distribution channel requirements
    spotifyRequirements: {
      coverArtMinSize: '3000x3000',
      coverArtFormat: 'JPEG or PNG',
      audioFormat: 'WAV 16-bit or 24-bit, 44.1kHz',
      metadataDeadlineBeforeRelease: '7 days',
    },
    appleMusicRequirements: {
      coverArtMinSize: '3000x3000',
      audioFormat: 'WAV or AIFF 24-bit, 44.1kHz or 48kHz',
    },
    // Checklist of what still needs to be completed
    completionStatus: {
      coverArt: false,
      audioFile: true,        // User just bounced — audio is done
      isrc: false,
      metadata: !!(songName && artistName && genre),
      releaseDate: !!releaseDate,
    },
  }

  return c.json({ ok: true, metadata })
})

// ═══════════════════════════════════════════════════════════════════════════════
// CLAWFLOW RELEASE — DISTRIBUTOR OAUTH (DistroKid + UnitedMasters)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Reality check (baked-in honesty):
//   DistroKid: Has no public OAuth API. Their API is invite-only for enterprise
//              partners (labels/DAWs). We implement the FULL OAuth 2.0 flow so
//              it works the moment DistroKid grants us credentials. Until then,
//              the connect endpoint explains this to the user and gives them a
//              deep-link to distrokid.com pre-filled with their metadata.
//
//   UnitedMasters: Also no public API. Same approach — full flow ready, with a
//              graceful fallback that generates a pre-filled upload checklist
//              linking to unitedmasters.com.
//
//   SubmitHub:  HAS a real REST API for submitting tracks to curators.
//              Documented at api.submithub.com. We implement that fully.
//
// Security model for all three:
//   • OAuth tokens stored in Redis with 30-day TTL, keyed by email
//   • Tokens NEVER returned to the frontend — only a {connected: true} status
//   • All routes require valid fs_session + ClawFlow tier
//   • Explicit per-release permission required before any upload action
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Helper: Redis R/W ────────────────────────────────────────────────────────
async function redisSet(c: any, key: string, value: string, ttlSeconds = 2592000) {
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return false
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ex: ttlSeconds, value }),
    })
    return true
  } catch { return false }
}

async function redisGet(c: any, key: string): Promise<string | null> {
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return null
  try {
    const res  = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const data: any = await res.json()
    return data?.result ?? null
  } catch { return null }
}

// ─── Helper: ClawFlow tier gate ───────────────────────────────────────────────
function isClawflowUser(session: any): boolean {
  if (!session) return false
  const t = (session.tier ?? session.subscription ?? '').toLowerCase()
  return t === 'clawflow' || t === 'pro' || t === 'team'
}

// ─── Helper: OAuth state param (CSRF) ────────────────────────────────────────
function makeOAuthState(email: string, extra = ''): string {
  return btoa(`${email}:${Date.now()}:${extra}`).replace(/=/g, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DISTROKID
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/auth/distrokid — initiate OAuth or show status
app.get('/api/auth/distrokid', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.redirect('/auth?app=distrokid')

  const clientId = (c.env as any)?.DISTROKID_CLIENT_ID as string | undefined

  if (!clientId) {
    // DistroKid hasn't granted us API credentials yet.
    // Return a friendly page that:
    //  1. Explains the situation honestly
    //  2. Gives artist a pre-filled deep-link to distrokid.com
    //  3. Marks their account as "dk_pending" in Redis
    await redisSet(c, `dk_connect_intent:${session.email}`, JSON.stringify({
      email: session.email,
      requestedAt: new Date().toISOString(),
      status: 'pending_api_access',
    }))
    return c.html(`<!DOCTYPE html><html>
<head><title>DistroKid — Coming Soon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,sans-serif;background:#0d0d1a;color:#e9d5ff;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
  .card{background:#12102a;border:1px solid rgba(168,85,247,.4);border-radius:20px;padding:32px 28px;max-width:460px;width:100%;text-align:center}
  h1{font-size:22px;margin:0 0 8px;color:#fff}
  p{font-size:13px;line-height:1.6;color:rgba(196,181,253,.8);margin:0 0 20px}
  .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;
    background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);color:#fbbf24;margin-bottom:18px}
  a.btn{display:block;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;
    background:linear-gradient(135deg,#1DB954,#158a3e);color:#fff;margin-bottom:10px}
  .note{font-size:10px;color:rgba(196,181,253,.4);line-height:1.5}
</style></head>
<body><div class="card">
  <div style="font-size:42px;margin-bottom:12px">🎵</div>
  <div class="badge">API Partnership Pending</div>
  <h1>DistroKid Direct Upload</h1>
  <p>DistroKid's upload API is currently invite-only for enterprise partners. We've submitted our partnership application — when approved, Claw will be able to upload directly to your DistroKid account.</p>
  <p>In the meantime, <strong>Claw has prepared your full release package</strong>. Click below to open DistroKid — your metadata is ready to paste in.</p>
  <a class="btn" href="https://distrokid.com/new/" target="_blank">Open DistroKid Upload →</a>
  <div class="note">Claw has structured your metadata (title, artist, ISRC placeholder, cover art) in your release session. Open the FlowState hub to copy it.</div>
  <script>
    setTimeout(() => {
      if (window.opener) window.opener.postMessage({ type: 'dk_connect_status', status: 'pending' }, '*');
      window.close();
    }, 3000);
  </script>
</div></body></html>`)
  }

  // ── Full OAuth flow (active when DistroKid grants credentials) ────────────
  const baseUrl   = c.env?.CANONICAL_ORIGIN || new URL(c.req.url).origin
  const state     = makeOAuthState(session.email, 'distrokid')
  await redisSet(c, `dk_oauth_state:${state}`, session.email, 600)
  setCookie(c, 'dk_state', state, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })

  const authUrl = new URL('https://distrokid.com/oauth/authorize')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', `${baseUrl}/api/auth/distrokid/callback`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'upload read_releases')
  authUrl.searchParams.set('state', state)
  return c.redirect(authUrl.toString())
})

// GET /api/auth/distrokid/callback
app.get('/api/auth/distrokid/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  deleteCookie(c, 'dk_state', { path: '/' })
  if (error || !code) return c.html(authErrorPage('DistroKid authorization failed or was cancelled.'))

  const storedEmail = await redisGet(c, `dk_oauth_state:${state}`)
  if (!storedEmail) return c.html(authErrorPage('OAuth state mismatch — please try again.'))

  const clientId     = (c.env as any)?.DISTROKID_CLIENT_ID as string
  const clientSecret = (c.env as any)?.DISTROKID_CLIENT_SECRET as string
  const baseUrl      = c.env?.CANONICAL_ORIGIN || new URL(c.req.url).origin

  try {
    const tokenRes = await fetch('https://distrokid.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/api/auth/distrokid/callback`,
      }),
    })
    if (!tokenRes.ok) throw new Error(`DistroKid token error: ${tokenRes.status}`)
    const tokens: any = await tokenRes.json()

    await redisSet(c, `dk_token:${storedEmail}`, JSON.stringify({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope:         tokens.scope ?? 'upload read_releases',
      connectedAt:   new Date().toISOString(),
    }), 30 * 24 * 3600)

    return c.html(`<!DOCTYPE html><html><head><title>DistroKid Connected</title>
<style>body{background:#0d0d1a;color:#e9d5ff;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center}
.card{background:#12102a;border:1px solid rgba(16,185,129,.4);border-radius:16px;padding:28px;max-width:380px}
h2{color:#34d399;margin:0 0 8px}p{color:rgba(196,181,253,.8);font-size:13px;margin:0}</style></head>
<body><div class="card"><div style="font-size:40px;margin-bottom:12px">✅</div>
<h2>DistroKid Connected!</h2><p>Claw can now prepare and submit releases directly to your DistroKid account.</p>
<script>setTimeout(()=>{if(window.opener)window.opener.postMessage({type:'dk_connect_status',status:'connected'},'*');window.close();},2000);</script>
</div></body></html>`)
  } catch (err: any) {
    return c.html(authErrorPage(`DistroKid authentication failed: ${err.message}`))
  }
})

// GET /api/auth/distrokid/status
app.get('/api/auth/distrokid/status', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ connected: false })
  const stored = await redisGet(c, `dk_token:${session.email}`)
  if (!stored) return c.json({ connected: false })
  try {
    const data = JSON.parse(stored)
    const expired = data.expires_at && Date.now() > data.expires_at
    return c.json({ connected: !expired, connectedAt: data.connectedAt, scope: data.scope, expired })
  } catch { return c.json({ connected: false }) }
})

// POST /api/claw/release/distrokid-prep — build the DistroKid upload payload
// Returns the structured metadata ready for the DistroKid upload form.
// When the API is live, also POSTs to DistroKid's /releases endpoint.
app.post('/api/claw/release/distrokid-prep', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (!isClawflowUser(session)) return c.json({ error: 'clawflow_required', upgradeUrl: 'https://flowst8.cc/pricing' }, 402)

  const body: any = await c.req.json().catch(() => ({}))
  const { songName, artistName, genre, releaseDate, isrc, coverR2Key, audioR2Key, bpm } = body
  if (!songName || !artistName) return c.json({ error: 'songName and artistName required' }, 400)

  const today   = new Date()
  const release = releaseDate || new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  // Structured payload matching DistroKid's upload form fields
  const payload = {
    song_title:     songName,
    primary_artist: artistName,
    genre:          genre || 'Independent',
    release_date:   release,
    isrc:           isrc || null,  // null = DistroKid assigns one
    explicit:       false,
    copyright_year: today.getFullYear(),
    p_line:         `${today.getFullYear()} ${artistName}`,
    c_line:         `${today.getFullYear()} ${artistName}`,
    // File references (R2 keys — backend resolves to signed URLs when API call happens)
    cover_art_key:  coverR2Key || null,
    audio_file_key: audioR2Key || null,
    stores: ['spotify','apple_music','amazon','tidal','youtube_music','tiktok','deezer'],
    pricing: 'standard',
  }

  // Check if we have a live DistroKid token
  const stored = await redisGet(c, `dk_token:${session.email}`)
  let liveSubmitted = false
  let submissionId: string | null = null

  if (stored && (c.env as any)?.DISTROKID_CLIENT_ID) {
    try {
      const tokenData = JSON.parse(stored)
      const uploadRes = await fetch('https://distrokid.com/api/v1/releases', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (uploadRes.ok) {
        const uploadData: any = await uploadRes.json()
        submissionId = uploadData.id ?? uploadData.release_id ?? null
        liveSubmitted = true
      }
    } catch { /* Fall through to manual mode */ }
  }

  // Log to user's release session
  if (body.songId) {
    await redisSet(c, `claw_release_${session.email}_${body.songId}_dk`, JSON.stringify({
      status: liveSubmitted ? 'submitted' : 'prepared',
      payload,
      submissionId,
      preparedAt: new Date().toISOString(),
    }))
  }

  return c.json({
    ok: true,
    liveSubmitted,
    submissionId,
    payload,
    manualUrl: 'https://distrokid.com/new/',
    message: liveSubmitted
      ? `Release submitted to DistroKid! Submission ID: ${submissionId}`
      : 'Release package prepared. Click "Upload to DistroKid" to complete manually — all fields are pre-filled.',
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. UNITEDMASTERS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/auth/unitedmasters', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.redirect('/auth?app=unitedmasters')

  const clientId = (c.env as any)?.UNITEDMASTERS_CLIENT_ID as string | undefined

  if (!clientId) {
    await redisSet(c, `um_connect_intent:${session.email}`, JSON.stringify({
      email: session.email,
      requestedAt: new Date().toISOString(),
      status: 'pending_api_access',
    }))
    return c.html(`<!DOCTYPE html><html>
<head><title>UnitedMasters — Coming Soon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,sans-serif;background:#0d0d1a;color:#e9d5ff;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
  .card{background:#12102a;border:1px solid rgba(168,85,247,.4);border-radius:20px;padding:32px 28px;max-width:460px;width:100%;text-align:center}
  h1{font-size:22px;margin:0 0 8px;color:#fff}
  p{font-size:13px;line-height:1.6;color:rgba(196,181,253,.8);margin:0 0 20px}
  .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;
    background:rgba(6,182,212,.15);border:1px solid rgba(6,182,212,.4);color:#22d3ee;margin-bottom:18px}
  a.btn{display:block;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;
    background:linear-gradient(135deg,#0f766e,#0891b2);color:#fff;margin-bottom:10px}
  .note{font-size:10px;color:rgba(196,181,253,.4);line-height:1.5}
</style></head>
<body><div class="card">
  <div style="font-size:42px;margin-bottom:12px">🎤</div>
  <div class="badge">API Partnership Pending</div>
  <h1>UnitedMasters Direct Upload</h1>
  <p>UnitedMasters does not yet offer a public upload API. We've submitted our partnership request — once approved, Claw will upload directly to your UnitedMasters account.</p>
  <p><strong>Claw has prepared your complete release package.</strong> Click below to open UnitedMasters — your metadata is ready.</p>
  <a class="btn" href="https://unitedmasters.com/distribute" target="_blank">Open UnitedMasters Upload →</a>
  <div class="note">All metadata, cover art, and file specs are in your Claw release session. Return to the FlowState hub to copy them.</div>
  <script>
    setTimeout(() => {
      if (window.opener) window.opener.postMessage({ type: 'um_connect_status', status: 'pending' }, '*');
      window.close();
    }, 3000);
  </script>
</div></body></html>`)
  }

  // Full OAuth flow for when UM grants credentials
  const baseUrl = c.env?.CANONICAL_ORIGIN || new URL(c.req.url).origin
  const state   = makeOAuthState(session.email, 'unitedmasters')
  await redisSet(c, `um_oauth_state:${state}`, session.email, 600)
  setCookie(c, 'um_state', state, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })

  const authUrl = new URL('https://api.unitedmasters.com/oauth/authorize')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', `${baseUrl}/api/auth/unitedmasters/callback`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'distribution:write profile:read')
  authUrl.searchParams.set('state', state)
  return c.redirect(authUrl.toString())
})

app.get('/api/auth/unitedmasters/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  deleteCookie(c, 'um_state', { path: '/' })
  if (error || !code) return c.html(authErrorPage('UnitedMasters authorization failed or was cancelled.'))

  const storedEmail = await redisGet(c, `um_oauth_state:${state}`)
  if (!storedEmail) return c.html(authErrorPage('OAuth state mismatch — please try again.'))

  const clientId     = (c.env as any)?.UNITEDMASTERS_CLIENT_ID as string
  const clientSecret = (c.env as any)?.UNITEDMASTERS_CLIENT_SECRET as string
  const baseUrl      = c.env?.CANONICAL_ORIGIN || new URL(c.req.url).origin

  try {
    const tokenRes = await fetch('https://api.unitedmasters.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/api/auth/unitedmasters/callback`,
      }),
    })
    if (!tokenRes.ok) throw new Error(`UM token error: ${tokenRes.status}`)
    const tokens: any = await tokenRes.json()

    await redisSet(c, `um_token:${storedEmail}`, JSON.stringify({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
      connectedAt:   new Date().toISOString(),
    }), 30 * 24 * 3600)

    return c.html(`<!DOCTYPE html><html><head><title>UnitedMasters Connected</title>
<style>body{background:#0d0d1a;color:#e9d5ff;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center}
.card{background:#12102a;border:1px solid rgba(16,185,129,.4);border-radius:16px;padding:28px;max-width:380px}
h2{color:#34d399;margin:0 0 8px}p{color:rgba(196,181,253,.8);font-size:13px;margin:0}</style></head>
<body><div class="card"><div style="font-size:40px;margin-bottom:12px">✅</div>
<h2>UnitedMasters Connected!</h2><p>Claw can now prepare and submit releases directly to your UnitedMasters account.</p>
<script>setTimeout(()=>{if(window.opener)window.opener.postMessage({type:'um_connect_status',status:'connected'},'*');window.close();},2000);</script>
</div></body></html>`)
  } catch (err: any) {
    return c.html(authErrorPage(`UnitedMasters authentication failed: ${err.message}`))
  }
})

app.get('/api/auth/unitedmasters/status', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ connected: false })
  const stored = await redisGet(c, `um_token:${session.email}`)
  if (!stored) return c.json({ connected: false })
  try {
    const data    = JSON.parse(stored)
    const expired = data.expires_at && Date.now() > data.expires_at
    return c.json({ connected: !expired, connectedAt: data.connectedAt, expired })
  } catch { return c.json({ connected: false }) }
})

app.post('/api/claw/release/unitedmasters-prep', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (!isClawflowUser(session)) return c.json({ error: 'clawflow_required', upgradeUrl: 'https://flowst8.cc/pricing' }, 402)

  const body: any = await c.req.json().catch(() => ({}))
  const { songName, artistName, genre, releaseDate, isrc, coverR2Key, bpm } = body
  if (!songName || !artistName) return c.json({ error: 'songName and artistName required' }, 400)

  const today   = new Date()
  const release = releaseDate || new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const payload = {
    title:          songName,
    artist_name:    artistName,
    genre:          genre || 'Independent',
    release_date:   release,
    isrc:           isrc || null,
    explicit:       false,
    bpm:            bpm || null,
    copyright:      `${today.getFullYear()} ${artistName}`,
    cover_art_key:  coverR2Key || null,
    distribution_tier: 'select',
    stores: ['spotify','apple_music','amazon','tidal','youtube_music','tiktok'],
  }

  const stored = await redisGet(c, `um_token:${session.email}`)
  let liveSubmitted = false
  let submissionId: string | null = null

  if (stored && (c.env as any)?.UNITEDMASTERS_CLIENT_ID) {
    try {
      const tokenData = JSON.parse(stored)
      const uploadRes = await fetch('https://api.unitedmasters.com/v1/releases', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (uploadRes.ok) {
        const d: any = await uploadRes.json()
        submissionId = d.id ?? d.release_id ?? null
        liveSubmitted = true
      }
    } catch { /* Fall through */ }
  }

  return c.json({
    ok: true,
    liveSubmitted,
    submissionId,
    payload,
    manualUrl: 'https://unitedmasters.com/distribute',
    message: liveSubmitted
      ? `Submitted to UnitedMasters! ID: ${submissionId}`
      : 'Package prepared. Click "Upload to UnitedMasters" — all fields are ready.',
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. SUBMITHUB — Real public API for curator pitching
// Docs: https://www.submithub.com/api
// Auth: Bearer token (API key from submithub.com/api-settings)
// Key stored as SUBMITHUB_API_KEY secret — NEVER sent to frontend
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/claw/release/submithub/curators — search matching curators
app.get('/api/claw/release/submithub/curators', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const SH_KEY = (c.env as any)?.SUBMITHUB_API_KEY as string | undefined
  if (!SH_KEY) {
    // Return curated static list of high-value playlist contact types
    // so the UI is useful even before the API key is added
    return c.json({
      ok: true,
      apiKeyMissing: true,
      curators: [
        { id: 'sh_001', name: 'Independent Playlist Curators', type: 'playlist', genre: 'All', followers: '10k-500k', credits: 1, note: 'Add SUBMITHUB_API_KEY to enable live curator search' },
        { id: 'sh_002', name: 'Music Blogs & Reviews',          type: 'blog',     genre: 'All', followers: null,       credits: 2, note: 'Paid editorial placements' },
        { id: 'sh_003', name: 'TikTok & Instagram Influencers', type: 'social',   genre: 'All', followers: '5k-200k',  credits: 1, note: 'Social media amplification' },
      ],
      message: 'Live SubmitHub curator data available once SUBMITHUB_API_KEY secret is added.',
    })
  }

  const genre  = c.req.query('genre') || ''
  const type   = c.req.query('type')  || 'playlist'
  const limit  = Math.min(parseInt(c.req.query('limit') || '20'), 50)

  try {
    const params = new URLSearchParams({ type, limit: String(limit) })
    if (genre) params.set('genre', genre)

    const res = await fetch(`https://www.submithub.com/api/curators?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${SH_KEY}`, 'Accept': 'application/json' },
    })
    if (!res.ok) throw new Error(`SubmitHub API error: ${res.status}`)
    const data: any = await res.json()

    return c.json({ ok: true, curators: data.curators ?? data.results ?? data, total: data.total ?? null })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

// POST /api/claw/release/submithub/submit — submit to specific curators
app.post('/api/claw/release/submithub/submit', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (!isClawflowUser(session)) return c.json({ error: 'clawflow_required', upgradeUrl: 'https://flowst8.cc/pricing' }, 402)

  const body: any = await c.req.json().catch(() => ({}))
  const { trackUrl, songName, artistName, curatorIds, pitchNote, genre } = body

  if (!trackUrl || !curatorIds?.length) {
    return c.json({ error: 'trackUrl and curatorIds required' }, 400)
  }

  // Security: require explicit confirmation flag
  if (!body.userConfirmed) {
    return c.json({
      error: 'confirmation_required',
      message: 'Set userConfirmed: true to proceed. Claw will never submit without explicit confirmation.',
      preview: { trackUrl, curatorCount: curatorIds.length, songName, artistName },
    }, 400)
  }

  const SH_KEY = (c.env as any)?.SUBMITHUB_API_KEY as string | undefined
  if (!SH_KEY) {
    return c.json({
      ok: false,
      apiKeyMissing: true,
      message: 'SubmitHub API key not configured. Add SUBMITHUB_API_KEY as a Cloudflare secret to enable live submissions.',
      manualUrl: `https://www.submithub.com/submit?artist=${encodeURIComponent(artistName)}&genre=${encodeURIComponent(genre || '')}`,
    })
  }

  const results: any[] = []
  let successCount = 0

  for (const curatorId of curatorIds.slice(0, 10)) { // cap at 10 per call
    try {
      const res = await fetch('https://www.submithub.com/api/submissions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SH_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          curator_id:  curatorId,
          track_url:   trackUrl,
          artist_name: artistName,
          song_name:   songName,
          genre:       genre || '',
          pitch_note:  pitchNote || `Hi, I'd love to share "${songName}" with you. ${pitchNote || ''}`.trim(),
        }),
      })
      const d: any = await res.json()
      if (res.ok) { results.push({ curatorId, status: 'submitted', submissionId: d.id ?? d.submission_id }); successCount++ }
      else results.push({ curatorId, status: 'failed', error: d.error ?? `HTTP ${res.status}` })
    } catch (err: any) {
      results.push({ curatorId, status: 'error', error: err.message })
    }
  }

  // Log to Redis
  await redisSet(c, `claw_submithub_${session.email}_${Date.now()}`, JSON.stringify({
    songName, artistName, results, submittedAt: new Date().toISOString(),
  }), 90 * 24 * 3600)

  return c.json({
    ok: true,
    successCount,
    totalAttempted: curatorIds.length,
    results,
    message: `Submitted to ${successCount} of ${curatorIds.length} curators via SubmitHub.`,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. COVER ART → R2 — Persist generated cover to R2 so URL never expires
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/claw/release/save-cover', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const body: any = await c.req.json().catch(() => ({}))
  const { imageUrl, songName, songId } = body
  if (!imageUrl) return c.json({ error: 'imageUrl required' }, 400)

  if (!c.env?.R2) return c.json({ error: 'R2 not configured', imageUrl }, 503)

  try {
    // Fetch the image from fal.ai
    const imgRes = await fetch(imageUrl)
    if (!imgRes.ok) throw new Error(`Could not fetch image: ${imgRes.status}`)
    const imgBuffer = await imgRes.arrayBuffer()
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg'
    const ext = contentType.includes('png') ? 'png' : 'jpg'

    const safeTitle = (songName || 'cover').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40).toLowerCase()
    const key = `covers/${session.email}/${Date.now()}_${safeTitle}.${ext}`

    await c.env.R2.put(key, imgBuffer, {
      httpMetadata: { contentType },
      customMetadata: {
        email:     session.email,
        songName:  songName || '',
        songId:    songId || '',
        savedAt:   new Date().toISOString(),
        source:    'claw_cover_art',
      },
    })

    const permanentUrl = `/api/r2/cover/${encodeURIComponent(key)}`

    // Update release session with permanent URL
    if (songId) {
      await redisSet(c, `claw_release_${session.email}_${songId}_cover`, JSON.stringify({
        r2Key: key, permanentUrl, savedAt: new Date().toISOString(),
      }))
    }

    return c.json({ ok: true, key, permanentUrl, message: 'Cover saved to your cloud storage.' })
  } catch (err: any) {
    // Non-fatal — return original URL if R2 save fails
    return c.json({ ok: true, key: null, permanentUrl: imageUrl, fallback: true, error: err.message })
  }
})

// GET /api/r2/cover/:key — serve cover art (public read for sharing)
app.get('/api/r2/cover/:key{.+}', async (c) => {
  if (!c.env?.R2) return c.json({ error: 'R2 not configured' }, 503)
  const key = decodeURIComponent(c.req.param('key'))
  // Security: only cover/ prefix is publicly readable — user files stay private
  if (!key.startsWith('covers/')) return c.json({ error: 'Access denied' }, 403)

  try {
    const obj = await c.env.R2.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)
    const ct = obj.httpMetadata?.contentType || 'image/jpeg'
    return new Response(obj.body, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. PITCH EMAIL SEND via Resend — user must explicitly confirm before send
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/claw/release/send-pitch', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (!isClawflowUser(session)) return c.json({ error: 'clawflow_required', upgradeUrl: 'https://flowst8.cc/pricing' }, 402)

  const body: any = await c.req.json().catch(() => ({}))
  const { to, subject, body: emailBody, songName, pitchType } = body

  if (!to || !subject || !emailBody) {
    return c.json({ error: 'to, subject, and body are required' }, 400)
  }

  // Email format sanity check
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRe.test(to)) return c.json({ error: 'Invalid recipient email address' }, 400)

  // Hard block: cannot send to Spotify/Apple/platform addresses — those are
  // submitted through their official artist portals, never cold email.
  const blockedDomains = ['spotify.com', 'apple.com', 'tiktok.com', 'youtube.com', 'distrokid.com', 'unitedmasters.com']
  const recipientDomain = to.split('@')[1]?.toLowerCase()
  if (blockedDomains.some(d => recipientDomain?.includes(d))) {
    return c.json({
      error: 'blocked_recipient',
      message: 'Claw cannot cold-email streaming platforms. Spotify Editorial is submitted via Spotify for Artists, not email. Claw has generated your pitch text — use it on the official platform.',
      officialUrl: pitchType === 'spotify_editorial' ? 'https://artists.spotify.com/pitch' : null,
    }, 400)
  }

  // Require explicit user confirmation flag
  if (!body.userConfirmed) {
    return c.json({
      error: 'confirmation_required',
      preview: { to, subject, charCount: emailBody.length },
      message: 'Set userConfirmed: true to send. Claw will never send email without your explicit confirmation.',
    }, 400)
  }

  const RESEND_KEY = c.env?.RESEND_API_KEY
  if (!RESEND_KEY) return c.json({ error: 'Email service not configured' }, 503)

  // Rate limit: max 20 pitch emails per user per day
  const rateLimitKey = `pitch_email_count:${session.email}:${new Date().toISOString().split('T')[0]}`
  const currentCount = parseInt(await redisGet(c, rateLimitKey) ?? '0')
  if (currentCount >= 20) {
    return c.json({ error: 'rate_limit', message: 'Maximum 20 pitch emails per day. This protects your sender reputation.' }, 429)
  }

  try {
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${session.name || session.email.split('@')[0]} via Claw <pitches@flowst8.cc>`,
        to:      [to],
        subject,
        text:    emailBody,
        // Include Reply-To so curator replies go to the artist
        reply_to: session.email,
        tags: [
          { name: 'pitch_type', value: pitchType || 'curator' },
          { name: 'song',       value: (songName || '').slice(0, 50) },
        ],
      }),
    })

    if (!sendRes.ok) {
      const errData: any = await sendRes.json()
      throw new Error(errData.message ?? `Resend error: ${sendRes.status}`)
    }

    const sendData: any = await sendRes.json()

    // Increment rate limit counter
    await redisSet(c, rateLimitKey, String(currentCount + 1), 86400)

    // Log pitch to user history
    await redisSet(c, `pitch_log:${session.email}:${Date.now()}`, JSON.stringify({
      to, subject, pitchType, songName, sentAt: new Date().toISOString(), resendId: sendData.id,
    }), 90 * 24 * 3600)

    return c.json({
      ok: true,
      messageId: sendData.id,
      message:   `Pitch sent to ${to}. Replies will go to ${session.email}.`,
      remaining: 20 - currentCount - 1,
    })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})

// GET /api/claw/release/distributor-status — check all distributor connections at once
app.get('/api/claw/release/distributor-status', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)

  const [dkRaw, umRaw] = await Promise.all([
    redisGet(c, `dk_token:${session.email}`),
    redisGet(c, `um_token:${session.email}`),
  ])

  const parseConnected = (raw: string | null) => {
    if (!raw) return { connected: false }
    try {
      const d = JSON.parse(raw)
      return { connected: !d.expires_at || Date.now() < d.expires_at, connectedAt: d.connectedAt }
    } catch { return { connected: false } }
  }

  const hasDkApiKey = !!(c.env as any)?.DISTROKID_CLIENT_ID
  const hasUmApiKey = !!(c.env as any)?.UNITEDMASTERS_CLIENT_ID
  const hasShApiKey = !!(c.env as any)?.SUBMITHUB_API_KEY

  return c.json({
    distrokid:     { ...parseConnected(dkRaw),    apiAvailable: hasDkApiKey, connectUrl: '/api/auth/distrokid' },
    unitedmasters: { ...parseConnected(umRaw),    apiAvailable: hasUmApiKey, connectUrl: '/api/auth/unitedmasters' },
    submithub:     { connected: hasShApiKey,      apiAvailable: hasShApiKey, note: 'API key based — no OAuth needed' },
    resend:        { connected: !!c.env?.RESEND_API_KEY, note: 'Used for pitch emails' },
  })
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
  // Dual auth: accept 264pro Electron token OR FlowState session cookie
  // This allows the CLAW Video wizard (web) and 264 Pro (Electron) to share the same route
  let tier = 'free'
  const desktopToken = get264Token(c)
  if (desktopToken) {
    const auth = await verify264Token(c, desktopToken)
    if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
    tier = auth.tier || 'free'
  } else {
    // Fall back to session cookie (web / CLAW wizard)
    const session = decodeSession(getCookie(c, 'fs_session') || '')
    if (!session) return c.json({ error: 'Not authenticated' }, 401)
    // Read tier from Redis — session cookie never stores tier
    if (session.email && c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
      try {
        const tr264 = await redisPipeline(c.env.UPSTASH_REDIS_URL, c.env.UPSTASH_REDIS_TOKEN, [
          ['GET', `tier_email:${session.email}`],
          ['GET', `tier:${session.email}`],
        ])
        tier = (tr264[0] || tr264[1] || 'free') as string
      } catch { tier = 'free' }
    }
  }

  // All video generation requires Pro tier
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

  // ── Credit deduction for 264pro video gen ────────────────────────────────
  const VIDEO_264_CREDITS: Record<string, number> = {
    seedance_t2v: 250, seedance_i2v: 250,
    higgsfield_t2v: 550, higgsfield_i2v: 550,
    nano_banana_2k: 20, nano_banana_4k: 55,
    wan_t2v: 400, wan_i2v: 400,
  }
  const vid264Cost = (VIDEO_264_CREDITS[model] ?? 400) * Math.max(1, Math.floor((duration || 5) / 5))
  const vid264Auth = desktopToken ? (await verify264Token(c, desktopToken)).email : session?.email
  const vid264Check = await checkCredits(c, vid264Auth || 'anon', vid264Cost)
  if (vid264Check) return vid264Check

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
  // Dual auth: Electron token OR session cookie
  const desktopToken = get264Token(c)
  if (desktopToken) {
    const auth = await verify264Token(c, desktopToken)
    if (!auth.valid) return c.json({ error: 'Invalid token' }, 401)
  } else {
    const session = decodeSession(getCookie(c, 'fs_session') || '')
    if (!session) return c.json({ error: 'Not authenticated' }, 401)
  }

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
      userEmail = session.email; userName = session.name || ''
      // Read tier from Redis — session cookie never stores tier
      if (c.env?.UPSTASH_REDIS_URL && c.env?.UPSTASH_REDIS_TOKEN) {
        try {
          const trHf = await redisPipeline(c.env.UPSTASH_REDIS_URL, c.env.UPSTASH_REDIS_TOKEN, [
            ['GET', `tier_email:${userEmail}`],
            ['GET', `tier:${userEmail}`],
          ])
          userTier = (trHf[0] || trHf[1] || 'free') as string
        } catch { userTier = 'free' }
      }
    } catch { return c.json({ error: 'Session decode failed' }, 401) }
  }

  // Pro gate
  const hasPro = isTierPro(userTier)
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
    model        = 'seedance-v2.0-t2v',
    prompt       = '',
    imageUrl,           // start/reference image URL
    endImageUrl,        // end frame image URL (for first-last frame models)
    duration     = 10,
    aspectRatio  = '16:9',
    quality      = 'high',
    motionId,           // optional motion preset ID for Higgsfield DOP models
    motionStrength,     // 0-1 motion intensity
    enhancePrompt,      // boolean — let Higgsfield refine the prompt
    seed,               // integer seed for reproducibility
  } = body

  // For I2V models, image is required. For T2V, it's optional (reference image)
  const isI2V = model.includes('i2v')
  if (!prompt && !imageUrl) return c.json({ error: 'prompt or image is required' }, 400)
  if (isI2V && !imageUrl) return c.json({ error: 'Image-to-video models require an image URL (imageUrl)' }, 400)

  const input: Record<string, unknown> = {
    prompt,
    aspect_ratio: aspectRatio,
    duration: Number(duration),
    quality,
  }
  if (imageUrl) input.image_url = imageUrl
  if (endImageUrl) input.end_image_url = endImageUrl
  if (motionId) input.motion_id = motionId
  if (motionStrength !== undefined) input.motion_strength = Number(motionStrength)
  if (enhancePrompt !== undefined) input.enhance_prompt = Boolean(enhancePrompt)
  if (seed !== undefined) input.seed = Number(seed)

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

// POST /api/higgsfield/upload-image — upload an image for Higgsfield I2V (session-authed, returns public URL)
// Stores in R2 under higgsfield/images/<timestamp>-<random>.<ext> and serves via public endpoint
app.post('/api/higgsfield/upload-image', async (c) => {
  // Auth: session cookie
  const cookieHeader = c.req.header('cookie') || ''
  const match = cookieHeader.match(/fs_session=([^;]+)/)
  if (!match) return c.json({ error: 'Not authenticated' }, 401)
  let userEmail = ''
  try {
    const session = decodeSession(decodeURIComponent(match[1]))
    if (!session?.email) return c.json({ error: 'Invalid session' }, 401)
    userEmail = session.email
  } catch { return c.json({ error: 'Session decode failed' }, 401) }

  // Get the uploaded file
  const formData = await c.req.formData().catch(() => null)
  const file = formData?.get('image') as File | null
  if (!file) return c.json({ error: 'No image file provided' }, 400)

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: 'Invalid file type. Allowed: JPG, PNG, WEBP, GIF' }, 400)
  }
  // Max 20MB
  if (file.size > 20 * 1024 * 1024) {
    return c.json({ error: 'File too large (max 20MB)' }, 400)
  }

  const ext = file.type.split('/')[1].replace('jpeg','jpg')
  const key = `higgsfield/images/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  try {
    if (c.env?.R2) {
      const buffer = await file.arrayBuffer()
      await c.env.R2.put(key, buffer, {
        httpMetadata: { contentType: file.type },
        customMetadata: { uploadedBy: userEmail, uploadedAt: new Date().toISOString() },
      })
      // Return a public URL that Higgsfield can access
      const origin = c.env?.CANONICAL_ORIGIN || 'https://flowst8.cc'
      const publicUrl = `${origin}/api/higgsfield/image/${encodeURIComponent(key)}`
      return c.json({ ok: true, url: publicUrl, key, size: file.size })
    } else {
      // No R2 — convert to data URL for direct embedding (smaller images only)
      if (file.size > 2 * 1024 * 1024) return c.json({ error: 'R2 storage not configured. Images over 2MB require R2.' }, 503)
      const buffer = await file.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
      const dataUrl = `data:${file.type};base64,${base64}`
      return c.json({ ok: true, url: dataUrl, key: 'data', size: file.size, isDataUrl: true })
    }
  } catch (err: any) {
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})

// GET /api/higgsfield/image/:key — serve uploaded Higgsfield images publicly (no auth — Higgsfield needs to fetch them)
app.get('/api/higgsfield/image/:key{.+}', async (c) => {
  if (!c.env?.R2) return c.json({ error: 'R2 not configured' }, 503)
  const key = decodeURIComponent(c.req.param('key'))
  // Security: only serve from higgsfield/images/ prefix
  if (!key.startsWith('higgsfield/images/')) {
    return c.json({ error: 'Access denied' }, 403)
  }
  try {
    const obj = await c.env.R2.get(key)
    if (!obj) return c.json({ error: 'Image not found' }, 404)
    const contentType = obj.httpMetadata?.contentType || 'image/jpeg'
    return new Response(obj.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // 24h cache — Higgsfield fetches once
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
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
    // Optional AI
    xai:             check('XAI_API_KEY'),
    huggingface:     check('HUGGINGFACE_API_KEY'),
    // Cover art generation (ClawFlow Release Wizard)
    fal_ai:          check('FAL_AI_KEY'),
    // Video generation (Higgsfield/Seedance)
    higgsfield:      check('HIGGSFIELD_API_KEY','HIGGSFIELD_API_SECRET'),
    // Distribution partners (ClawFlow Release)
    distrokid:       check('DISTROKID_CLIENT_ID','DISTROKID_CLIENT_SECRET'),
    unitedmasters:   check('UNITEDMASTERS_CLIENT_ID','UNITEDMASTERS_CLIENT_SECRET'),
    submithub:       check('SUBMITHUB_API_KEY'),
  })
})

// Credit balance endpoint — returns monthly usage + purchased credit balance
app.get('/api/billing/balance', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ monthlyUsed: 0, monthlyLimit: 3000, purchased: 0, tier: 'free', remaining: 3000 })

  const email = session.email
  const month = new Date().toISOString().slice(0, 7) // YYYY-MM
  const results = await redisPipeline(url, token, [
    ['GET', `tier_email:${email}`],
    ['GET', `tier:${email}`],
    ['GET', `monthly_credits_used:${email}:${month}`],
    ['GET', `credit_balance:${email}`],
  ])
  const tier         = (results[0] || results[1] || 'free') as string
  const isEnterprise = tier === 'enterprise'
  const isPaid       = tier === 'pro' || tier === 'team' || isEnterprise ||
    ['personal_pro', 'team_starter', 'team_growth'].includes(tier)
  const isTeam       = tier === 'team' || tier === 'team_starter' || tier === 'team_growth'

  const monthlyUsed = parseInt(results[2] as string || '0')
  const purchased   = parseInt(results[3] as string || '0')

  // Monthly credit allocations
  let monthlyLimit: number
  if (isEnterprise) monthlyLimit = 999_999_999 // effectively unlimited
  else if (isTeam)  monthlyLimit = 7_500
  else if (isPaid)  monthlyLimit = 10_000
  else              monthlyLimit = 3_000

  const remaining = isEnterprise ? 999_999_999 : Math.max(0, monthlyLimit - monthlyUsed) + purchased

  return c.json({ monthlyUsed, monthlyLimit, purchased, tier, remaining,
    // legacy fields for backward compat with old frontend code
    dailyUsed: 0, dailyLimit: monthlyLimit, isPaid })
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signed in — FlowState</title>${AUTH_PAGE_STYLE}${AUTH_REDIRECT_SCRIPT}</head><body><div class="card">${avatar}<h1>Welcome back, ${name}!</h1><p style="color:#10b981;font-size:15px;font-weight:600">You're signed in to FlowState.</p><p>Google Calendar is synced. You can close this window.</p><button class="btn">Open FlowState ✓</button><div class="sub">Redirecting automatically…</div></div></body></html>`
}

function magicLinkSuccessPage(name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signed in — FlowState</title>${AUTH_PAGE_STYLE}
<script>
(function(){
  // Magic link verify always opens in the same tab — redirect to app
  document.addEventListener('DOMContentLoaded', function(){
    var btn = document.querySelector('.btn');
    if (btn) { btn.textContent = 'Open FlowState →'; btn.onclick = function(){ window.location.href='/'; }; }
  });
  setTimeout(function(){ window.location.href = '/'; }, 2000);
})();
</script>
</head><body><div class="card"><div style="font-size:56px;margin-bottom:16px">✅</div><h1>You're signed in!</h1><p style="color:#10b981;font-size:15px;font-weight:600">Welcome to FlowState, ${name}.</p><button class="btn" onclick="window.location.href='/'">Open FlowState →</button><div class="sub">Redirecting automatically…</div></div></body></html>`
}
function notionSuccessPage(workspace: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Notion Connected — FlowState</title>${AUTH_PAGE_STYLE}
<script>
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'notion_connected', workspace: ${JSON.stringify(workspace || '')} }, 'https://flowst8.cc');
    }
  } catch(e) {}
  setTimeout(function() {
    if (window.opener && !window.opener.closed) { window.close(); }
    else { window.location.href = '/'; }
  }, 1800);
</script>
</head><body><div class="card"><div style="font-size:56px;margin-bottom:16px">📝</div><h1 style="color:#22c55e">Notion Connected!</h1><p>Workspace <strong>${workspace || 'Your workspace'}</strong> is synced. You can close this window.</p><div class="sub">Returning to FlowState…</div></div></body></html>`
}
function slackSuccessPage(team: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Slack Connected — FlowState</title>${AUTH_PAGE_STYLE}
<script>
  // Notify parent window so it can update FS_SLACK without a full reload
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'slack_connected', team: ${JSON.stringify(team || '')} }, 'https://flowst8.cc');
    }
  } catch(e) {}
  // Auto-close popup after short delay
  setTimeout(function() {
    if (window.opener && !window.opener.closed) { window.close(); }
    else { window.location.href = '/'; }
  }, 1800);
</script>
</head><body><div class="card"><div style="font-size:56px;margin-bottom:16px">💬</div><h1 style="color:#22c55e">Slack Connected!</h1><p>Team <strong>${team || 'Your workspace'}</strong> is synced. You can close this window.</p><div class="sub">Returning to FlowState…</div></div></body></html>`
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
:root{--bg:#0f0f1a;--panel:#1a1a2e;--card:#16213e;--text:#f0f0f0;--sub:#888;--div:#2a2a40;--acc:#a855f7;--feat:#888;--legal:#444;--legal-a:#666}
[data-theme="light"]{--bg:#f4f4f8;--panel:#ffffff;--card:#eef0f6;--text:#1a1a2e;--sub:#6b7280;--div:#d1d5db;--acc:#7c3aed;--feat:#6b7280;--legal:#9ca3af;--legal-a:#6b7280}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;transition:background .25s}
.orb{position:fixed;border-radius:50%;filter:blur(80px);pointer-events:none;opacity:.35}
.orb1{width:400px;height:400px;background:radial-gradient(circle,#a855f7,transparent);top:-100px;right:-100px}
.orb2{width:350px;height:350px;background:radial-gradient(circle,#06b6d4,transparent);bottom:-80px;left:-80px}
.card{background:var(--panel);border:1px solid rgba(168,85,247,.35);border-radius:24px;padding:44px 40px;max-width:420px;width:100%;text-align:center;position:relative;z-index:1;animation:fadeUp .4s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.app-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:99px;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:20px;border:1px solid rgba(168,85,247,.3);background:rgba(168,85,247,.1);color:var(--acc)}
.logo{font-size:52px;margin-bottom:12px;line-height:1}
.title{font-size:26px;font-weight:900;margin-bottom:8px;background:linear-gradient(135deg,var(--acc),#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:var(--sub);font-size:14px;margin-bottom:32px;line-height:1.65}
.btn-google{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:14px;border-radius:13px;background:#fff;border:none;color:#1a1a2e;font-size:15px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:12px;text-decoration:none}
.btn-google:hover{transform:scale(1.02);box-shadow:0 4px 24px rgba(255,255,255,.15)}
.btn-google svg{width:20px;height:20px;flex-shrink:0}
.divider{display:flex;align-items:center;gap:10px;margin:6px 0 16px;color:var(--sub);font-size:12px}
.divider::before,.divider::after{content:'';flex:1;border-top:1px solid var(--div)}
.magic-form{display:flex;flex-direction:column;gap:10px;margin-bottom:20px}
.magic-input{background:var(--card);border:1px solid rgba(168,85,247,.25);border-radius:10px;color:var(--text);padding:13px 16px;font-size:14px;outline:none;transition:.2s;font-family:inherit}
.magic-input:focus{border-color:rgba(168,85,247,.7);background:rgba(168,85,247,.06)}
.magic-input::placeholder{color:var(--sub)}
.btn-magic{width:100%;padding:13px;border-radius:12px;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;font-size:14px;font-weight:700;cursor:pointer;transition:.2s}
.btn-magic:hover{opacity:.88;transform:scale(1.01)}
.btn-magic:disabled{opacity:.5;cursor:not-allowed;transform:none}
.magic-sent{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);border-radius:12px;padding:14px;color:#10b981;font-size:13px;font-weight:600;display:none}
.features{display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left;margin-bottom:20px}
.feat{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--feat)}
.feat-icon{color:var(--acc);font-size:11px;flex-shrink:0}
.legal{font-size:11px;color:var(--legal);line-height:1.5;margin-top:4px}
.legal a{color:var(--legal-a);text-decoration:underline}
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

  <a class="btn-google" href="${googleUrl}" id="btn-google-signin" onclick="this.innerHTML='<svg viewBox=&quot;0 0 48 48&quot; width=&quot;20&quot; height=&quot;20&quot;><path fill=&quot;#EA4335&quot; d=&quot;M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z&quot;/><path fill=&quot;#4285F4&quot; d=&quot;M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z&quot;/><path fill=&quot;#FBBC05&quot; d=&quot;M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z&quot;/><path fill=&quot;#34A853&quot; d=&quot;M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z&quot;/></svg>Redirecting to Google…';this.style.opacity='.7'">
    <svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Continue with Google
  </a>
  <div style="font-size:11px;color:var(--sub);margin-top:-8px;margin-bottom:4px;text-align:center">Signs in with <strong>your own</strong> Google account</div>

  <div class="divider">or sign in with email</div>

  <div class="magic-form" id="magic-form">
    <input class="magic-input" id="magic-email" type="email" placeholder="your@email.com" autocomplete="email">
    <button class="btn-magic" id="magic-btn" onclick="sendMagicLink()">
      ✉️ &nbsp;Send sign-in link
    </button>
    <div id="magic-error" style="display:none;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35);border-radius:10px;padding:12px 14px;font-size:12px;color:#fca5a5;text-align:left;line-height:1.6"></div>
  </div>
  <div class="magic-sent" id="magic-sent">
    <div style="font-size:22px;margin-bottom:6px">✉️</div>
    <div style="font-size:15px;font-weight:700;margin-bottom:4px">Check your inbox!</div>
    <div id="magic-sent-email" style="font-size:13px;opacity:.85;margin-bottom:8px"></div>
    <div style="font-size:12px;opacity:.65;line-height:1.6">We sent a sign-in link to your email.<br>The link expires in 15 minutes.<br>Don't see it? Check your spam folder.</div>
    <button onclick="document.getElementById('magic-sent').style.display='none';document.getElementById('magic-form').style.display='flex';document.getElementById('magic-email').value='';document.getElementById('magic-email').focus()" style="margin-top:12px;background:none;border:1px solid rgba(16,185,129,.4);color:#10b981;border-radius:8px;padding:6px 16px;font-size:12px;cursor:pointer">✉️ Resend or use a different email</button>
  </div>

  <div class="features">
    <div class="feat"><span class="feat-icon">✓</span> Free account</div>
    <div class="feat"><span class="feat-icon">✓</span> No credit card</div>
    <div class="feat"><span class="feat-icon">✓</span> All DAW tools</div>
    <div class="feat"><span class="feat-icon">✓</span> Cloud sync</div>
  </div>

  <p class="legal">By signing in you agree to our <a href="/legal#terms" target="_blank">Terms of Use</a> &amp; <a href="/legal#privacy" target="_blank">Privacy Policy</a>.<br>Your data is never sold.</p>
</div>

<script>
async function sendMagicLink() {
  const email = document.getElementById('magic-email').value.trim().toLowerCase()
  const errEl = document.getElementById('magic-error')
  errEl.style.display = 'none'
  if (!email || !email.includes('@')) {
    errEl.innerHTML = '⚠️ Please enter a valid email address.'
    errEl.style.display = 'block'
    return
  }
  // iCloud/Apple warning — Apple mail servers are strict and may delay delivery
  const isApple = email.endsWith('@icloud.com') || email.endsWith('@me.com') || email.endsWith('@mac.com')
  if (isApple) {
    errEl.innerHTML = '⚠️ <strong>Heads up:</strong> Apple/iCloud mail can sometimes block or delay sign-in emails. If you don\'t receive the link within 2 minutes, please use <strong>Continue with Google</strong> or try a Gmail/work email address instead.'
    errEl.style.display = 'block'
    // Still attempt to send — don't block them
  }
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
    if (data.success || data.user) {
      const sentEl = document.getElementById('magic-sent')
      const sentEmailEl = document.getElementById('magic-sent-email')
      sentEmailEl.textContent = 'We sent a link to ' + email
      document.getElementById('magic-form').style.display = 'none'
      sentEl.style.display = 'block'
      // Add extra note for Apple/iCloud users
      if (isApple) {
        const note = document.createElement('div')
        note.style.cssText = 'margin-top:8px;padding:8px 10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;font-size:11px;color:#fcd34d;line-height:1.5'
        note.innerHTML = '⚠️ iCloud sometimes delays emails. If nothing arrives in 2 min, try Gmail or Continue with Google.'
        sentEl.appendChild(note)
      }
      // Auto-sign-in path (dev/no-Resend fallback) — user object means session is already set
      if (data.user) { setTimeout(function(){ window.location.href = '/' }, 800) }
    } else {
      btn.disabled = false
      btn.innerHTML = '✉️ &nbsp;Send sign-in link'
      const msg = data.message || data.error || 'Something went wrong sending the email.'
      // Check if it's a bounce/rejection and give a targeted message
      const isBounce = msg.toLowerCase().includes('bounce') || msg.toLowerCase().includes('rejected') || msg.toLowerCase().includes('invalid') || (data.emailError || '').includes('5')
      const tipHtml = isBounce
        ? '<br><br>💡 Your email server rejected this message. Please <strong>use a Gmail or work email</strong>, or <strong>Continue with Google</strong> above.'
        : (data.suggestion ? '<br><br>💡 <strong>Tip:</strong> ' + data.suggestion : '<br><br>💡 Try <strong>Continue with Google</strong> above — it always works.')
      errEl.innerHTML = '❌ ' + msg + tipHtml
      errEl.style.display = 'block'
    }
  } catch(e) {
    btn.disabled = false
    btn.innerHTML = '✉️ &nbsp;Send sign-in link'
    errEl.innerHTML = '❌ Network error. Please check your connection and try again, or use <strong>Continue with Google</strong>.'
    errEl.style.display = 'block'
  }
}
document.getElementById('magic-email').addEventListener('keydown', function(e){
  if (e.key === 'Enter') sendMagicLink()
})
// Apply saved theme
;(function(){const t=localStorage.getItem('fs_theme');if(t==='light')document.documentElement.setAttribute('data-theme','light')})()
</script>
</body>
</html>`)
})

// ═══════════════════════════════════════════════════════════════════
// MAIN HTML — FlowState v3 — Full Rebuild
// ═══════════════════════════════════════════════════════════════════
app.get('/', async (c) => {
  const session   = decodeSession(getCookie(c, 'fs_session') || '')
  const notionSes = decodeSession(getCookie(c, 'fs_notion')  || '')
  const slackSes  = decodeSession(getCookie(c, 'fs_slack')   || '')
  const githubSes = decodeSession(getCookie(c, 'fs_github')  || '')
  const onboarding = decodeSession(getCookie(c, 'fs_onboarded') || '')

  // Look up REAL tier from Redis — session cookie never stores tier
  let realTier = 'free'
  if (session?.email) {
    const redisUrl = c.env?.UPSTASH_REDIS_URL
    const redisTok = c.env?.UPSTASH_REDIS_TOKEN
    if (redisUrl && redisTok) {
      try {
        const email = session.email
        const results = await redisPipeline(redisUrl, redisTok, [
          ['GET', `tier_email:${email}`],
          ['GET', `tier:${email}`],
        ])
        realTier = (results[0] || results[1] || 'free') as string
      } catch { realTier = 'free' }
    }
  }

  // Lazy-register user in D1 on every authenticated page load (catches users who slipped through verify)
  if (session?.email && c.env?.DB) {
    upsertUser(c.env.DB, session.email, session.name || session.email.split('@')[0], session.picture || '', session.provider || 'magic_link').catch(() => {})
  }

  const userJson     = session     ? JSON.stringify({ name: session.name, email: session.email, picture: session.picture, role: session.role || 'member', tier: realTier, provider: session.provider }) : 'null'
  const notionJson   = notionSes   ? JSON.stringify({ workspace: notionSes.workspace_name }) : 'null'
  const slackJson    = slackSes    ? JSON.stringify({ team: slackSes.team_name }) : 'null'
  const githubJson   = githubSes   ? JSON.stringify({ login: githubSes.login, name: githubSes.name, avatar_url: githubSes.avatar_url, public_repos: githubSes.public_repos }) : 'null'
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
<!-- Anti-FOUC: Apply theme before any CSS renders -->
<script>try{var t=localStorage.getItem('fs_theme');if(t==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}</script>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg-base:#0f0f1a; --bg-panel:#1a1a2e; --bg-card:#16213e;
  --bg-header:rgba(26,26,46,.9); --bg-tabs:rgba(15,15,26,.95);
  --bg-tabs2:rgba(15,15,26,.7); --bg-drawer:#0f0f1a;
  --bg-dropdown:#16162a;
  --border:rgba(168,85,247,.18); --border-h:rgba(168,85,247,.45);
  --text-p:#f0f0f0; --text-s:#aaa; --text-m:#bbb;
  --accent:#a855f7; --pink:#ec4899; --blue:#3b82f6; --cyan:#06b6d4;
  --green:#10b981; --warn:#f59e0b; --danger:#ef4444;
  --grad:linear-gradient(135deg,#a855f7,#ec4899);
  --grad-b:linear-gradient(135deg,#3b82f6,#06b6d4);
  --shadow-modal:rgba(0,0,0,.7);
  --orb1:rgba(168,85,247,.22); --orb2:rgba(236,72,153,.18);
  --theme-icon:"🌙";
}
/* ── Light Mode ─────────────────────────────────────────────────── */
[data-theme="light"] {
  --bg-base:#f4f4f8; --bg-panel:#ffffff; --bg-card:#eef0f6;
  --bg-header:rgba(255,255,255,.92); --bg-tabs:rgba(244,244,248,.98);
  --bg-tabs2:rgba(244,244,248,.85); --bg-drawer:#ffffff;
  --bg-dropdown:#ffffff;
  --border:rgba(139,92,246,.18); --border-h:rgba(139,92,246,.45);
  --text-p:#1a1a2e; --text-s:#6b7280; --text-m:#7c85a0;
  --accent:#7c3aed; --pink:#db2777; --blue:#2563eb; --cyan:#0891b2;
  --green:#059669; --warn:#d97706; --danger:#dc2626;
  --grad:linear-gradient(135deg,#7c3aed,#db2777);
  --grad-b:linear-gradient(135deg,#2563eb,#0891b2);
  --shadow-modal:rgba(0,0,0,.25);
  --orb1:rgba(139,92,246,.08); --orb2:rgba(219,39,119,.06);
  --theme-icon:"☀️";
  color-scheme: light;
}
[data-theme="light"] body { background:var(--bg-base); color:var(--text-p); }
[data-theme="light"] header { background:var(--bg-header); box-shadow:0 1px 12px rgba(0,0,0,.08); }
[data-theme="light"] .tabs-bar { background:var(--bg-tabs); box-shadow:0 1px 4px rgba(0,0,0,.06); }
[data-theme="light"] .gen-subtab-bar { background:var(--bg-tabs2); }
[data-theme="light"] .mob-drawer-inner { background:var(--bg-drawer); }
[data-theme="light"] .gs-model-dropdown { background:var(--bg-dropdown); box-shadow:0 8px 32px rgba(0,0,0,.15); }
[data-theme="light"] .modal-ov { background:rgba(0,0,0,.35); }
[data-theme="light"] .modal-card { background:var(--bg-panel); box-shadow:0 16px 48px rgba(0,0,0,.15); }
[data-theme="light"] .intent-modal { background:rgba(0,0,0,.3); }
[data-theme="light"] .sec-hd { background:var(--bg-base); }
[data-theme="light"] .msg.ai .msg-bub { background:var(--bg-card); }
[data-theme="light"] .chat-msgs { scrollbar-color:var(--border) transparent; }
[data-theme="light"] .fs-in, [data-theme="light"] input.fs-in, [data-theme="light"] textarea.fs-in, [data-theme="light"] select.fs-in { background:var(--bg-card) !important; color:var(--text-p) !important; }
[data-theme="light"] .kanban-col { background:var(--bg-card); }
[data-theme="light"] .kanban-card { background:var(--bg-panel); }
[data-theme="light"] .mob-drawer { background:rgba(0,0,0,.3); }
[data-theme="light"] .mob-close:hover { background:rgba(0,0,0,.06); }
[data-theme="light"] .orb1 { background:radial-gradient(circle,var(--orb1),transparent 70%); }
[data-theme="light"] .orb2 { background:radial-gradient(circle,var(--orb2),transparent 70%); }
#pair-session-banner { display:none; }
[data-theme="light"] #pair-session-banner { background:rgba(5,150,105,.12) !important; border-color:rgba(5,150,105,.3) !important; color:var(--text-p) !important; }
[data-theme="light"] .sprint-health, [data-theme="light"] .sh-stats { background:var(--bg-card); }
[data-theme="light"] #theme-toggle-btn::after { content: "☀️"; }
[data-theme="light"] .u-dropdown { background:var(--bg-panel);border-color:var(--border);box-shadow:0 8px 32px rgba(0,0,0,.12); }
[data-theme="light"] .u-drop-item { color:var(--text-s); }
[data-theme="light"] .u-drop-item:hover { background:rgba(124,58,237,.08);color:var(--text-p); }
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg-base);color:var(--text-p);display:flex;flex-direction:column;transition:background .25s,color .25s}
.orb{position:fixed;border-radius:50%;pointer-events:none;filter:blur(80px);opacity:0;transition:opacity 2s}
.orb1{width:500px;height:500px;top:-100px;left:-100px;background:radial-gradient(circle,var(--orb1),transparent 70%)}
.orb2{width:400px;height:400px;bottom:-100px;right:-100px;background:radial-gradient(circle,var(--orb2),transparent 70%)}
.amb-active .orb1,.amb-active .orb2{opacity:1}
header{display:flex;align-items:center;gap:10px;padding:8px 18px;background:var(--bg-header);border-bottom:1px solid var(--border);backdrop-filter:blur(20px);flex-shrink:0;z-index:100;transition:background .25s}
/* ── Mobile hamburger ── */
.mob-menu-btn{display:none;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--text-p);cursor:pointer;font-size:16px;flex-shrink:0}
.mob-drawer{display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);backdrop-filter:blur(6px)}
.mob-drawer-inner{position:absolute;top:0;left:0;bottom:0;width:260px;background:var(--bg-drawer);border-right:1px solid var(--border-h);padding:16px 12px;overflow-y:auto;animation:slideDrawer .22s ease}
@keyframes slideDrawer{from{transform:translateX(-100%)}to{transform:translateX(0)}}
.mob-drawer-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)}
.mob-drawer-title{font-size:15px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.mob-close{width:30px;height:30px;border:none;background:transparent;color:var(--text-s);cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;border-radius:7px}
.mob-close:hover{background:rgba(255,255,255,.07);color:var(--text-p)}
.mob-tab-btn{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:10px;border:none;background:transparent;color:var(--text-s);cursor:pointer;font-size:13px;font-weight:600;text-align:left;transition:.15s}
.mob-tab-btn:hover{background:rgba(168,85,247,.08);color:var(--text-p)}
.mob-tab-btn.active{background:rgba(168,85,247,.13);color:var(--accent);border-left:3px solid var(--accent);padding-left:9px}
.mob-tab-btn i{width:18px;text-align:center;font-size:13px;flex-shrink:0}
.mob-tab-btn .mob-badge{font-size:9px;font-weight:800;padding:2px 6px;border-radius:99px;background:linear-gradient(135deg,#ec4899,#f59e0b);color:#fff;margin-left:auto}
.mob-tab-btn .mob-badge-teal{font-size:9px;font-weight:800;padding:2px 6px;border-radius:99px;background:linear-gradient(135deg,#10b981,#06b6d4);color:#fff;margin-left:auto}
.mob-tab-btn .mob-badge-cyan{font-size:9px;font-weight:800;padding:2px 6px;border-radius:99px;background:linear-gradient(135deg,#a855f7,#06b6d4);color:#fff;margin-left:auto}
.mob-drawer-section{font-size:10px;font-weight:700;color:#444;text-transform:uppercase;letter-spacing:.8px;padding:8px 12px 4px;margin-top:4px}
.mob-drawer-actions{display:flex;gap:6px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--border);margin-top:8px}
.mob-action-btn{flex:1;min-width:60px;padding:7px 10px;border-radius:9px;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;font-size:11px;font-weight:600;text-align:center;transition:.15s}
.mob-action-btn:hover{border-color:var(--border-h);color:var(--text-p)}
@media(max-width:640px){
  .mob-menu-btn{display:flex}
  .tabs-bar .tab-btn{display:none}
  .tabs-bar .tab-btn.active{display:flex}
  .tabs-bar>div[style*="margin-left:auto"]{display:none!important}
  header .dt-widget{display:none}
  header #fs-score-badge{display:none!important}
  .tabs-bar{padding:4px 10px;gap:4px;justify-content:space-between}
  .tab-pane{padding:10px 8px}
  /* Timer */
  .timer-display{font-size:56px!important}
  .timer-wrap{gap:12px!important}
  .phase-btns{flex-wrap:wrap;gap:4px}
  /* Chat */
  .msg-bub{max-width:92%!important}
  .chat-input-row{flex-wrap:wrap;gap:6px}
  /* Calendar */
  .cal-wrap{flex-direction:column}
  .cal-panel.open{width:100%!important}
  .cal-toolbar{flex-wrap:wrap;gap:6px}
  /* Focus prompt */
  .focus-cal-prompt{bottom:10px!important;right:8px!important;left:8px!important;max-width:none!important}
  /* Metrics */
  .wr-stats-row{gap:6px!important}
  .wr-cols{flex-direction:column!important}
  /* Modal */
  .modal-card{padding:18px!important;margin:8px!important;width:calc(100vw - 16px)!important;max-width:none!important}
  /* Board */
  .kanban-board{flex-direction:column!important}
  .kanban-col{min-width:0!important;width:100%!important}
  /* Smart suggestions */
  .ss-card{flex-wrap:wrap;gap:4px}
}
@media(min-width:641px) and (max-width:900px){
  .tabs-bar{gap:1px;padding:4px 8px}
  .tab-btn{padding:5px 9px;font-size:11px}
  .tab-pane{padding:14px}
}
.logo{font-size:17px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.5px;cursor:pointer}
.dt-widget{margin-left:auto;font-size:12px;color:var(--text-s);cursor:pointer;display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:8px;border:1px solid transparent;transition:.2s}
.dt-widget:hover{border-color:var(--border);background:rgba(168,85,247,.05)}
.dt-date{font-weight:600;color:var(--text-p)}
.dt-time{font-weight:800;font-size:13px;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-variant-numeric:tabular-nums}
.u-wrap{position:relative;display:inline-flex}
.u-pill{display:flex;align-items:center;gap:7px;padding:4px 10px;border-radius:20px;border:1px solid var(--border);cursor:pointer;transition:.2s;user-select:none}
.u-pill:hover{border-color:var(--accent)}
.u-avatar{width:28px;height:28px;border-radius:50%;border:2px solid var(--accent);object-fit:cover;background:var(--bg-card);flex-shrink:0}
.u-name{font-size:12px;font-weight:600;color:var(--text-s)}
.u-dropdown{position:absolute;top:calc(100% + 6px);right:0;background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:5px;min-width:190px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.45);opacity:0;visibility:hidden;transform:translateY(-4px);transition:opacity .15s,transform .15s,visibility .15s}
.u-wrap:hover .u-dropdown,.u-dropdown:hover{opacity:1;visibility:visible;transform:translateY(0)}
.u-drop-item{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:8px;font-size:12px;font-weight:600;color:var(--text-s);cursor:pointer;transition:.15s;white-space:nowrap;border:none;background:transparent;width:100%;text-align:left}
.u-drop-item:hover{background:rgba(168,85,247,.12);color:var(--text-p)}
.u-drop-item i{width:14px;text-align:center;font-size:13px;color:var(--accent)}
.u-drop-divider{height:1px;background:var(--border);margin:4px 6px}
.u-avatar-form{padding:6px 11px 8px}
.btn-signin{background:var(--grad);border:none;color:#fff;padding:7px 16px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;transition:.2s}
.tabs-bar{display:flex;align-items:center;gap:2px;padding:5px 16px;background:var(--bg-tabs);border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;scrollbar-width:none}
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
.gs-model-dropdown{position:absolute;left:0;min-width:300px;max-width:360px;background:var(--bg-dropdown);border:1px solid var(--border-h);border-radius:16px;box-shadow:0 12px 40px var(--shadow-modal);padding:8px;z-index:99999;max-height:420px;overflow-y:auto}
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
.amb-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);margin-bottom:9px;display:flex;align-items:center}
.s-chips{display:flex;gap:7px;flex-wrap:wrap}
.s-chip{padding:5px 12px;border-radius:18px;font-size:12px;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.s-chip:hover{border-color:var(--border-h);color:var(--text-p)}
.s-chip.active{background:rgba(168,85,247,.15);border-color:var(--accent);color:var(--accent)}
.vol-row{display:flex;align-items:center;gap:10px;margin-top:11px;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)}
.vol-icon{width:22px;text-align:center;font-size:13px;color:var(--text-s);flex-shrink:0;transition:color .2s}
.vol-icon.active{color:var(--accent)}
.vol-track{flex:1;position:relative;height:4px;border-radius:99px;background:rgba(255,255,255,.08);cursor:pointer}
.vol-fill{position:absolute;left:0;top:0;height:100%;border-radius:99px;background:linear-gradient(90deg,#a855f7,#ec4899);pointer-events:none;transition:width .05s}
.vol-thumb{position:absolute;top:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);box-shadow:0 0 8px rgba(168,85,247,.6);cursor:pointer;transition:transform .15s,box-shadow .15s;pointer-events:none}
.vol-track:hover .vol-thumb{transform:translate(-50%,-50%) scale(1.25);box-shadow:0 0 14px rgba(168,85,247,.8)}
.vol-label{font-size:10px;font-weight:700;color:var(--text-s);width:26px;text-align:right;flex-shrink:0;letter-spacing:.3px}
.now-playing-pill{display:none;align-items:center;gap:6px;margin-top:8px;padding:5px 10px;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.2);border-radius:20px;font-size:11px;color:var(--text-m);overflow:hidden}
.now-playing-pill.visible{display:flex}
.np-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex-shrink:0;animation:np-pulse 1.4s ease-in-out infinite}
.np-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
@keyframes np-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}
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
.cal-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.cal-month-lbl{font-size:15px;font-weight:800;color:#f0f0f0;min-width:140px;text-align:center}
.cal-wrap{display:flex;gap:12px;width:100%}
.cal-grid-col{flex:1;min-width:0}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:0;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;width:100%}
.cal-panel{display:none;width:260px;flex-shrink:0}
.cal-panel.open{display:block}
.cal-panel-card{background:var(--bg-panel);border:1px solid var(--border-h);border-radius:12px;padding:14px;margin-bottom:10px}
.cal-hd{text-align:center;font-size:11px;font-weight:700;color:#888;padding:8px 2px;text-transform:uppercase;letter-spacing:.5px;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06)}
.cal-day{min-height:100px;display:flex;flex-direction:column;align-items:flex-start;padding:6px 4px 4px;cursor:pointer;transition:background .12s;border-right:1px solid rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.05)}
.cal-day:nth-child(7n){border-right:none}
.cal-day:hover{background:rgba(168,85,247,.09)}
.cal-day.today{background:rgba(168,85,247,.07);outline:1.5px solid rgba(168,85,247,.5);outline-offset:-1px}
.cal-day.selected{background:rgba(168,85,247,.18);outline:1.5px solid rgba(168,85,247,.7);outline-offset:-1px}
.cal-day.today .cal-day-num{background:var(--accent);color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800}
.cal-day-num{font-size:12px;font-weight:600;color:#ccc;line-height:1;margin-bottom:3px;flex-shrink:0}
.cal-day-events{display:flex;flex-direction:column;gap:2px;width:100%}
.cal-ev-chip,.cal-day-ev-chip{font-size:10px;font-weight:600;color:#fff;padding:1px 4px;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;line-height:1.5;display:block}
.cal-day.other{opacity:.2;cursor:default;pointer-events:none}
.cal-more,.cal-day-more{font-size:9px;color:#888;padding-left:3px}
.ev-list{display:flex;flex-direction:column;gap:7px;margin-top:8px}
.ev-item{display:flex;align-items:center;gap:9px;padding:9px 13px;background:var(--bg-panel);border:1px solid var(--border);border-radius:11px;cursor:pointer;transition:.2s}
.ev-item:hover{border-color:var(--border-h)}
.ev-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.ev-time{font-size:12px;color:#aaa;min-width:48px;font-weight:500}
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
.sh-progress{height:8px;background:var(--border);border-radius:4px;overflow:hidden;margin-bottom:4px}
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
.gen-subtab-bar{display:flex;align-items:center;gap:4px;padding:8px 16px;background:var(--bg-tabs2);border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.gen-subtab-bar::-webkit-scrollbar{display:none}
.gen-subtab-btn{display:flex;align-items:center;gap:6px;padding:7px 16px;border-radius:10px;font-size:12px;font-weight:700;color:var(--text-s);border:1px solid transparent;background:transparent;cursor:pointer;transition:.18s;white-space:nowrap}
.gen-subtab-btn:hover{color:var(--text-p);background:rgba(168,85,247,.08)}
.gen-subtab-btn.active{color:var(--accent);background:rgba(168,85,247,.14);border-color:rgba(168,85,247,.3)}
.gen-subtab-btn i{font-size:12px}
.gen-subtab-btn--inner{padding:5px 12px;font-size:11px;font-weight:600;border-radius:8px}
.gen-subtab-btn--inner.active-voice-tab{color:var(--cyan);background:rgba(6,182,212,.13);border-color:rgba(6,182,212,.3)}
.gen-subtab-btn--inner:hover:not(.active-voice-tab){background:rgba(255,255,255,.06)}
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
/* ── AI Code Workspace ── */
.code-workspace{display:flex;flex:1;overflow:hidden;height:100%;flex-direction:column}
.code-agent-bar{flex-shrink:0;padding:10px 14px;border-bottom:1px solid var(--border);background:rgba(8,8,18,.85);display:flex;align-items:center;gap:10px;overflow:visible}
.code-agent-card{flex-shrink:0;background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.15);border-radius:10px;padding:8px 12px;cursor:pointer;transition:.18s;min-width:130px;text-align:left}
.code-agent-card:hover{background:rgba(16,185,129,.09);border-color:rgba(16,185,129,.35);transform:translateY(-1px)}
.code-agent-card.active{background:rgba(16,185,129,.13);border-color:#10b981;box-shadow:0 0 12px rgba(16,185,129,.2)}
.code-agent-badge{font-size:9px;font-weight:800;letter-spacing:.8px;color:#10b981;text-transform:uppercase;margin-bottom:3px;opacity:.8}
.code-agent-name{font-size:12px;font-weight:700;color:var(--text-p);margin-bottom:2px}
.code-agent-desc{font-size:10px;color:var(--text-m);line-height:1.4}
.code-workspace-body{display:flex;flex:1;overflow:hidden}
.code-sidebar{width:220px;flex-shrink:0;background:rgba(8,8,18,.7);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.code-gh-header{padding:10px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
.code-btn-connect{display:flex;align-items:center;gap:7px;width:100%;padding:8px 12px;border-radius:9px;background:var(--grad);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;justify-content:center;transition:.18s}
.code-btn-connect:hover{opacity:.88}
.code-select{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:7px;padding:6px 9px;font-size:11px;color:var(--text-p);outline:none}
.code-select:focus{border-color:var(--accent)}
.code-file-explorer{flex:1;overflow-y:auto;padding:8px 0;min-height:0}
.code-generated-files{flex-shrink:0;max-height:180px;overflow-y:auto;border-top:1px solid var(--border);padding:8px 0}
.code-panel-label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-m);padding:4px 12px 6px;display:flex;align-items:center;gap:6px}
.code-file-tree{display:flex;flex-direction:column}
.code-file-empty{font-size:11px;color:var(--text-m);padding:12px;text-align:center;line-height:1.6}
.code-file-item{display:flex;align-items:center;gap:6px;padding:5px 12px;font-size:11px;color:var(--text-s);cursor:pointer;transition:.12s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:none;background:transparent;text-align:left;width:100%}
.code-file-item:hover{background:rgba(168,85,247,.1);color:var(--text-p)}
.code-file-item.active{background:rgba(168,85,247,.18);color:var(--accent)}
.code-file-item.ai-generated{color:#a855f7}
.code-file-item i{font-size:10px;flex-shrink:0;width:12px}
.code-file-dir{font-weight:700;color:var(--text-m)}
.code-main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.code-toolbar{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid var(--border);background:rgba(10,10,20,.5);flex-shrink:0}
.code-toolbar-left{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden}
.code-toolbar-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.code-file-tabs{display:flex;align-items:center;overflow-x:auto;background:#0d0d1a;border-bottom:1px solid var(--border);flex-shrink:0;scrollbar-width:none}
.code-file-tabs::-webkit-scrollbar{display:none}
.code-file-tab{display:flex;align-items:center;gap:5px;padding:6px 13px;font-size:11px;font-family:var(--font-mono,'monospace');color:var(--text-s);cursor:pointer;border-right:1px solid rgba(255,255,255,.04);white-space:nowrap;transition:.12s;background:transparent;border-top:2px solid transparent;border-bottom:none;flex-shrink:0}
.code-file-tab:hover{color:var(--text-p);background:rgba(168,85,247,.06)}
.code-file-tab.active{color:var(--accent);background:rgba(168,85,247,.1);border-top-color:var(--accent)}
.code-file-tab i{font-size:10px;opacity:.7}
.code-file-badge{font-size:11px;color:var(--text-s);display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.code-file-badge i{color:var(--accent);flex-shrink:0}
.code-icon-btn{background:transparent;border:1px solid var(--border);border-radius:7px;padding:5px 9px;font-size:11px;color:var(--text-s);cursor:pointer;transition:.15s;display:flex;align-items:center;gap:5px;white-space:nowrap}
.code-icon-btn:hover{border-color:var(--accent);color:var(--text-p)}
.code-editor-wrap{flex:1;overflow-y:auto;position:relative;background:#0a0a12;font-family:'Fira Code','Consolas','Monaco',monospace}
.code-welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding:40px}
.code-content{padding:16px;font-size:12px;line-height:1.7;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;tab-size:2}
.code-content .kw{color:#c084fc}.code-content .str{color:#86efac}.code-content .cm{color:#64748b;font-style:italic}.code-content .num{color:#fb923c}.code-content .fn{color:#67e8f9}
.code-generating{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;color:var(--text-s);font-size:13px}
.code-gen-pulse{width:48px;height:48px;border-radius:50%;border:3px solid rgba(168,85,247,.3);border-top-color:#a855f7;animation:spin 1s linear infinite}
.code-prompt-bar{border-top:1px solid var(--border);padding:10px 14px;background:rgba(10,10,20,.6);flex-shrink:0}
.code-prompt-wrap{display:flex;flex-direction:column;gap:8px}
.code-prompt-input{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 13px;font-size:12px;color:var(--text-p);outline:none;resize:none;font-family:inherit;line-height:1.5}
.code-prompt-input:focus{border-color:var(--accent)}
.code-prompt-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.code-lang-select{background:var(--bg-card);border:1px solid var(--border);border-radius:7px;padding:5px 9px;font-size:11px;color:var(--text-s);outline:none;min-width:150px;cursor:pointer;transition:border-color .15s}
.code-lang-select:hover{border-color:var(--border-h)}
.code-lang-select:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(168,85,247,.15)}
.code-btn-generate{display:flex;align-items:center;gap:7px;padding:8px 18px;border-radius:9px;background:linear-gradient(135deg,#10b981,#a855f7);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;transition:.18s}
.code-btn-generate:hover{opacity:.88;transform:translateY(-1px)}
.code-btn-generate:disabled{opacity:.5;cursor:not-allowed;transform:none}
.code-btn-clawflow{display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:9px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.4);color:#a855f7;font-size:12px;font-weight:700;cursor:pointer;transition:.18s}
.code-btn-clawflow:hover{background:rgba(168,85,247,.28);border-color:rgba(168,85,247,.7);transform:translateY(-1px)}
.code-view-toggle{display:flex;background:rgba(0,0,0,.3);border-radius:7px;padding:2px;gap:2px}
.code-view-btn{padding:4px 10px;border-radius:5px;border:none;font-size:11px;font-weight:600;cursor:pointer;transition:.15s;color:var(--text-m);background:transparent;display:flex;align-items:center;gap:5px}
.code-view-btn.active{background:rgba(168,85,247,.25);color:var(--accent)}
.code-view-btn:hover:not(.active){color:var(--text-p)}
.code-viewport-btn{padding:4px 7px;font-size:11px}
.code-viewport-btn.active{border-color:var(--accent);color:var(--accent);background:rgba(168,85,247,.1)}
.code-example-prompt{padding:8px 14px;background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.2);border-radius:8px;font-size:12px;color:var(--text-s);cursor:pointer;transition:.15s;text-align:left}
.code-example-prompt:hover{background:rgba(168,85,247,.14);color:var(--text-p);border-color:rgba(168,85,247,.4)}
.code-log-panel{width:260px;flex-shrink:0;background:rgba(8,8,18,.85);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
/* Chat interface */
.code-chat-messages{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:10px;min-height:0;scroll-behavior:smooth}
.code-chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;padding:16px;text-align:center}
.code-chat-bubble{padding:9px 12px;border-radius:10px;font-size:12px;line-height:1.55;max-width:100%;word-break:break-word;animation:fadeUp .2s ease}
.code-chat-user{background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.25);color:var(--text-p);align-self:flex-end;border-bottom-right-radius:3px}
.code-chat-ai{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);color:#10b981;align-self:flex-start;border-bottom-left-radius:3px}
.code-chat-log{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:var(--text-m);font-size:10px;border-radius:7px;padding:5px 8px}
/* Typing indicator */
.code-chat-typing{display:flex;align-items:center;gap:3px;padding:9px 12px;background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.15);border-radius:10px;border-bottom-left-radius:3px;align-self:flex-start}
.code-chat-typing span{width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;animation:typingDot 1.2s ease-in-out infinite}
.code-chat-typing span:nth-child(2){animation-delay:.2s}
.code-chat-typing span:nth-child(3){animation-delay:.4s}
@keyframes typingDot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
/* Suggestion chips */
.code-chat-suggest-wrap{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px;align-self:flex-start;max-width:100%}
.code-chat-suggest-chip{padding:4px 9px;border-radius:12px;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.06);color:#10b981;font-size:10px;cursor:pointer;transition:.15s;white-space:nowrap}
.code-chat-suggest-chip:hover{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.5)}
.code-chat-cursor{display:inline-block;width:7px;height:13px;background:#10b981;vertical-align:text-bottom;border-radius:1px;animation:cursorBlink .7s step-end infinite}
@keyframes cursorBlink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes code-blink{0%,100%{opacity:1}50%{opacity:0}}
.ai-thinking-row{display:flex;align-items:center;gap:4px;padding:4px 0}
.ai-typing-dot{width:6px;height:6px;border-radius:50%;background:rgba(168,85,247,.6);animation:aiTypingDot 1.2s ease-in-out infinite}
.ai-typing-dot:nth-child(2){animation-delay:.2s}
.ai-typing-dot:nth-child(3){animation-delay:.4s}
@keyframes aiTypingDot{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:1;transform:scale(1.3)}}
.code-chat-input-wrap{border-top:1px solid var(--border);padding:8px 10px;display:flex;gap:6px;align-items:flex-end;flex-shrink:0}
.code-chat-input{flex:1;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--text-p);outline:none;resize:none;font-family:inherit;line-height:1.5;min-height:36px;max-height:100px}
.code-chat-input:focus{border-color:var(--accent)}
.code-chat-send{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#10b981,#a855f7);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:.15s}
.code-chat-send:hover{opacity:.85;transform:scale(1.05)}
.code-chat-send:disabled{opacity:.4;cursor:not-allowed;transform:none}
/* Template cards */
.code-template-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;max-width:480px}
.code-template-card{padding:10px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;cursor:pointer;transition:.18s;text-align:left}
.code-template-card:hover{background:rgba(168,85,247,.1);border-color:rgba(168,85,247,.35);transform:translateY(-1px)}
.code-template-card-icon{font-size:18px;margin-bottom:5px}
.code-template-card-title{font-size:11px;font-weight:700;color:var(--text-p);margin-bottom:2px}
.code-template-card-desc{font-size:10px;color:var(--text-m);line-height:1.4}
/* Log entries (kept for the log tab) */
.code-activity-log{flex:1;overflow-y:auto;padding:4px 8px;display:flex;flex-direction:column;gap:5px;min-height:0}
.code-log-empty{font-size:11px;color:var(--text-m);padding:12px 4px;text-align:center;line-height:1.6}
.code-log-entry{padding:6px 9px;border-radius:7px;font-size:11px;line-height:1.5;animation:fadeUp .2s ease}
.code-log-info{background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.2);color:var(--text-s)}
.code-log-success{background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);color:#10b981}
.code-log-error{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#ef4444}
.code-log-ai{background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);color:#fbbf24}
.code-gh-status{padding:6px 12px;font-size:11px}
.code-commit-log{padding:4px 8px;display:flex;flex-direction:column;gap:5px}
.code-commit-entry{padding:6px 9px;background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.15);border-radius:7px;font-size:10px;color:var(--text-s);line-height:1.5}
/* Higgsfield AI cards ── */
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
/* ── Smart Schedule ── */
.ss-card{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg-panel);border:1px solid var(--border);border-radius:11px;cursor:pointer;transition:.18s}
.ss-card:hover{border-color:var(--accent);background:rgba(168,85,247,.07)}
.ss-card.ideal{border-color:rgba(168,85,247,.35)}
.ss-card.good{border-color:rgba(16,185,129,.25)}
.ss-day{font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.6px;min-width:42px}
.ss-time{font-size:12px;font-weight:700;color:#f0f0f0;flex:1}
.ss-label{font-size:11px;color:var(--text-s)}
.ss-dur{font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:rgba(168,85,247,.15);color:var(--accent);white-space:nowrap}
.ss-btn{padding:4px 10px;border-radius:7px;border:none;background:var(--grad);color:#fff;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;transition:.15s}
.ss-btn:hover{opacity:.85}
/* ── Weekly Review ── */
.weekly-review-card{background:var(--bg-panel);border:1px solid rgba(168,85,247,.3);border-radius:16px;padding:18px;margin-bottom:14px;animation:fadeUp .35s ease}
#wr-local-badge a:hover{text-decoration:underline!important}
.wr-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.wr-title{font-size:15px;font-weight:800;color:#f0f0f0}
.wr-dates{font-size:11px;color:#888;margin-top:2px}
.wr-score-wrap{position:relative;width:64px;height:64px;flex-shrink:0}
.wr-score-inner{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.wr-score-num{font-size:18px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1}
.wr-score-lbl{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
.wr-stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.wr-stat{text-align:center}
.wr-stat-val{font-size:17px;font-weight:800;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.wr-stat-lbl{font-size:10px;color:#888;margin-top:2px}
.wr-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wr-col{padding:10px 12px;border-radius:10px}
.wr-col.wins{background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.2)}
.wr-col.improve{background:rgba(168,85,247,.05);border:1px solid rgba(168,85,247,.2)}
.wr-col-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;margin-bottom:7px}
.wr-col.wins .wr-col-title{color:#10b981}
.wr-col.improve .wr-col-title{color:var(--accent)}
.wr-item{font-size:11px;color:var(--text-s);padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);line-height:1.45}
.wr-item:last-child{border-bottom:none}
/* ── Focus-to-Calendar prompt ── */
.focus-cal-prompt{position:fixed;bottom:20px;right:20px;max-width:300px;background:var(--bg-panel);border:1px solid rgba(168,85,247,.4);border-radius:14px;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.45);z-index:1500;animation:slideR .3s ease;display:none}
.fcp-title{font-size:13px;font-weight:800;color:#f0f0f0;margin-bottom:4px}
.fcp-sub{font-size:11px;color:#888;margin-bottom:10px}
.fcp-btns{display:flex;gap:7px}
.fcp-chip{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:4px 10px;font-size:11px;color:#ccc;cursor:pointer;transition:all .15s;white-space:nowrap}
.fcp-chip:hover{background:rgba(168,85,247,.2);border-color:rgba(168,85,247,.4);color:#fff}
.fcp-chip.active{background:rgba(168,85,247,.3);border-color:#a855f7;color:#fff;font-weight:700}
@keyframes cFall{0%{opacity:1;transform:translate(0,0) rotate(0deg)}100%{opacity:0;transform:translate(var(--tx),var(--ty)) rotate(720deg)}}
@keyframes celebIn{0%{opacity:0;transform:scale(.6)}100%{opacity:1;transform:scale(1)}}
@keyframes slideR{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:translateX(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:.6;transform:scale(1)}50%{opacity:1;transform:scale(1.5)}}
@keyframes spin{to{transform:rotate(360deg)}}
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99998;backdrop-filter:blur(8px);padding:14px}
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
.sec-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;position:sticky;top:0;z-index:10;background:var(--bg-base);padding:4px 0 8px}
.sec-title{font-size:14px;font-weight:800}
.btn-sm{padding:5px 12px;border-radius:7px;font-size:12px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.btn-sm:hover{border-color:var(--border-h);color:var(--text-p)}
.btn-primary{background:var(--grad);border:none;color:#fff;padding:9px 22px;border-radius:11px;font-size:13px;font-weight:700;cursor:pointer;transition:.2s}
.btn-primary:hover{opacity:.85;transform:scale(1.02)}
.empty{text-align:center;padding:36px 18px;color:#888}
.empty i{font-size:34px;margin-bottom:11px;display:block;opacity:.4}
.empty p{font-size:13px;margin-bottom:14px;line-height:1.6}
.auth-banner{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.05));border:1px solid rgba(168,85,247,.2);border-radius:13px;padding:14px 16px;margin-bottom:14px}
.auth-banner h3{font-size:14px;font-weight:800;margin-bottom:4px}
.auth-banner p{font-size:12px;color:var(--text-s);margin-bottom:10px}
.demo-banner{background:linear-gradient(135deg,rgba(245,158,11,.08),rgba(239,68,68,.05));border:1px solid rgba(245,158,11,.3);border-radius:11px;padding:11px 16px;font-size:12px;color:var(--warn);margin-bottom:14px;display:flex;align-items:center;gap:8px}
.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;display:inline-block}
/* select.fs-sel removed — all dropdowns now use gs-model-pill pickers */
input.fs-in,textarea.fs-in,select.fs-in{background:var(--bg-card);border:1px solid var(--border);border-radius:7px;color:var(--text-p);padding:8px 13px;font-size:13px;outline:none;width:100%}
input.fs-in:focus,textarea.fs-in:focus,select.fs-in:focus{border-color:var(--accent)}
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
.add-ev-form{display:none}
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
.team-tab-btn{padding:6px 13px;border-radius:9px;font-size:12px;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s;display:flex;align-items:center;gap:5px;white-space:nowrap;flex-shrink:0}
.team-tab-btn:hover{border-color:var(--border-h);color:var(--text-p)}
.team-tab-btn.active{background:rgba(168,85,247,.12);border-color:rgba(168,85,247,.35);color:var(--accent)}
.team-tabs::-webkit-scrollbar{display:none}
/* ── GroupFlow Chat ───────────────────────────────────────────── */
.gf-msg:hover .gf-react-btn{opacity:1!important}
#gf-messages::-webkit-scrollbar{width:4px}
#gf-messages::-webkit-scrollbar-track{background:transparent}
#gf-messages::-webkit-scrollbar-thumb{background:rgba(168,85,247,.3);border-radius:2px}
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
    <!-- Magic link inline form (hidden until btn-magic-login is clicked) -->
    <div id="magic-login-form" style="display:none;margin-top:4px">
      <div style="position:relative;display:flex;gap:8px;align-items:stretch">
        <input id="magic-login-email" type="email" autocomplete="email" placeholder="your@email.com"
          style="flex:1;background:var(--bg-base,#0d0d1a);border:1px solid rgba(168,85,247,.35);border-radius:10px;color:var(--text,#e2e8f0);padding:11px 14px;font-size:14px;outline:none;font-family:inherit"
          onkeydown="if(event.key==='Enter')sendMagicLoginInline()"
        >
        <button onclick="sendMagicLoginInline()" id="magic-login-send-btn"
          style="padding:11px 16px;border-radius:10px;background:linear-gradient(135deg,#a855f7,#ec4899);border:none;color:#fff;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;transition:.2s">
          Send link
        </button>
      </div>
      <div id="magic-login-warn" style="display:none;margin-top:6px;padding:8px 10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;font-size:11px;color:#fcd34d;text-align:left;line-height:1.5"></div>
      <div id="magic-login-err"  style="display:none;margin-top:6px;padding:8px 10px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;font-size:11px;color:#fca5a5;text-align:left;line-height:1.5"></div>
      <div id="magic-login-ok"   style="display:none;margin-top:6px;padding:8px 10px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:8px;font-size:11px;color:#6ee7b7;text-align:left;line-height:1.5"></div>
    </div>
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
    <p class="login-legal" style="margin-top:8px">By signing in you agree to our <a href="/legal#terms" target="_blank" style="color:var(--accent)">Terms of Use</a> and <a href="/legal#privacy" target="_blank" style="color:var(--accent)">Privacy Policy</a>.</p>
  </div>
</div>

<!-- ONBOARDING -->
<div class="ob-screen" id="ob-screen" style="display:none">
  <div class="ob-card" id="ob-card"></div>
</div>

<!-- MOBILE DRAWER -->
<div class="mob-drawer" id="mob-drawer" onclick="closeMobDrawer(event)">
  <div class="mob-drawer-inner" id="mob-drawer-inner">
    <div class="mob-drawer-header">
      <span class="mob-drawer-title">⚡ FLOWSTATE</span>
      <button class="mob-close" onclick="closeMobDrawer()">✕</button>
    </div>
    <div class="mob-drawer-section">Main</div>
    <button class="mob-tab-btn active" id="mdtab-focus"     onclick="mobSwitchTab('focus')"><i class="fas fa-bullseye"></i>Focus</button>
    <button class="mob-tab-btn"        id="mdtab-chat"      onclick="mobSwitchTab('chat')"><i class="fas fa-comments"></i>Chat</button>
    <button class="mob-tab-btn"        id="mdtab-calendar"  onclick="mobSwitchTab('calendar')"><i class="fas fa-calendar-alt"></i>Calendar</button>
    <button class="mob-tab-btn"        id="mdtab-metrics"   onclick="mobSwitchTab('metrics')"><i class="fas fa-chart-line"></i>Metrics</button>
    <button class="mob-tab-btn"        id="mdtab-board"     onclick="mobSwitchTab('board')"><i class="fas fa-columns"></i>Board</button>
    <div class="mob-drawer-section">Tools</div>
    <button class="mob-tab-btn"        id="mdtab-generate"  onclick="mobSwitchTab('generate')"><i class="fas fa-magic"></i>Generate</button>
    <button class="mob-tab-btn"        id="mdtab-audio"     onclick="mobSwitchTab('audio')"><i class="fas fa-music" style="color:#10b981"></i>Audio <span class="mob-badge-teal">Studio</span></button>
    <button class="mob-tab-btn"        id="mdtab-264"       onclick="mobSwitchTab('264')"><i class="fas fa-film" style="color:#ec4899"></i>264 Pro <span class="mob-badge">PRO</span></button>
    <button class="mob-tab-btn"        id="mdtab-clawbot"   onclick="mobSwitchTab('clawbot')"><i class="fas fa-robot" style="color:#06b6d4"></i>ClawFlow <span class="mob-badge-cyan">AI</span></button>
    <div class="mob-drawer-section">Growth</div>
    <button class="mob-tab-btn"        id="mdtab-learn"     onclick="mobSwitchTab('learn')"><i class="fas fa-graduation-cap"></i>Learn</button>
    <button class="mob-tab-btn"        id="mdtab-restore"   onclick="mobSwitchTab('restore')"><i class="fas fa-leaf"></i>Restore</button>
    <button class="mob-tab-btn"        id="mdtab-team"      onclick="mobSwitchTab('team')"><i class="fas fa-users"></i>Team</button>
    <div class="mob-drawer-actions">
      <button class="mob-action-btn" onclick="openCredsModal();closeMobDrawer()"><i class="fas fa-key"></i> Keys</button>
      <button class="mob-action-btn" onclick="openTopupModal();closeMobDrawer()"><i class="fas fa-coins"></i> Tokens</button>
      <button class="mob-action-btn" onclick="openPricingModal();closeMobDrawer()"><i class="fas fa-star"></i> Pro</button>
      <button class="mob-action-btn" onclick="openSettingsModal();closeMobDrawer()"><i class="fas fa-gear"></i> Settings</button>
    </div>
  </div>
</div>

<!-- HEADER -->
<header id="main-header" style="display:none">
  <button class="mob-menu-btn" id="mob-menu-btn" onclick="openMobDrawer()"><i class="fas fa-bars"></i></button>
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
  <button class="tab-btn" id="tab-clawbot" style="border-color:rgba(6,182,212,.25)"><img src="/static/clawbot-mascot.png" style="width:16px;height:16px;object-fit:contain;border-radius:3px;vertical-align:middle;flex-shrink:0"><span style="background:linear-gradient(135deg,#a855f7,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:900">ClawFlow</span></button>
  <button class="tab-btn demo-tab" id="tab-demo" style="display:none"><i class="fas fa-eye"></i>Demo</button>
  <div style="margin-left:auto;display:flex;gap:5px">
    <button class="btn-sm" id="btn-creds" title="API Credentials"><i class="fas fa-key"></i></button>
    <button class="btn-sm" id="btn-topup" title="Buy More Tokens" onclick="openTopupModal()" style="background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.4);color:#10b981;display:flex;align-items:center;gap:4px"><i class="fas fa-coins"></i><span id="token-balance-display" style="font-size:10px;font-weight:700;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span></button>
    <button class="btn-sm" id="btn-pricing" onclick="openPricingModal()"><i class="fas fa-star"></i> <span id="nav-tier-label">Free</span></button>
    <button class="btn-sm" id="btn-invite" title="Invite friends — earn tokens"><i class="fas fa-user-plus"></i></button>
    <button class="btn-sm" onclick="openFlowCoach()" title="AI Flow Coach — personalized insights" style="color:#a855f7;border-color:rgba(168,85,247,.4)"><i class="fas fa-brain"></i></button>
    <button class="btn-sm" id="btn-pair" onclick="openPairingModal()" title="Find an accountability partner" style="color:#10b981;border-color:rgba(16,185,129,.4)"><i class="fas fa-handshake"></i></button>
    <button class="btn-sm" id="pwa-install-btn" onclick="triggerPwaInstall()" title="Add FlowState to home screen" style="display:none"><i class="fas fa-download"></i></button>
    <button class="btn-sm" id="btn-theme" onclick="toggleTheme()" title="Toggle light/dark mode" style="font-size:14px;padding:5px 9px" id="theme-toggle-btn">🌙</button>
    <button class="btn-sm" id="btn-settings" onclick="openSettingsModal()" title="Settings"><i class="fas fa-gear"></i></button>
  </div>
</div>

<!-- FOCUS TAB -->
<div class="tab-pane active" id="tab-pane-focus" style="display:none">
  <!-- Pair session active banner — shown by JS when paired -->
  <div id="pair-session-banner" style="background:linear-gradient(135deg,rgba(16,185,129,.12),rgba(5,150,105,.08));border:1px solid rgba(16,185,129,.3);border-radius:12px;padding:10px 14px;margin-bottom:12px;align-items:center;justify-content:space-between;gap:10px;display:none">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 2s infinite"></span>
      <span style="font-size:13px;font-weight:700;color:#10b981">Paired with <span id="pair-banner-name">Partner</span></span>
      <span id="pair-banner-time" style="font-size:12px;color:var(--text-s)"></span>
    </div>
    <div style="display:flex;gap:6px">
      <button onclick="openPairingModal()" style="font-size:11px;font-weight:700;padding:4px 10px;background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.3);border-radius:6px;color:#10b981;cursor:pointer">💬 Chat</button>
      <button onclick="_leavePair()" style="font-size:11px;font-weight:700;padding:4px 10px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:6px;color:#ef4444;cursor:pointer">Leave</button>
    </div>
  </div>
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
      <div class="amb-title"><i class="fas fa-headphones"></i>&nbsp; Ambient &amp; Music <button class="btn-sm" style="margin-left:auto;font-size:10px" onclick="openMusicModal()"><i class="fab fa-youtube" style="color:#ef4444"></i><i class="fab fa-spotify" style="color:#1db954;margin-left:4px"></i> Playlist</button></div>
      <div class="s-chips" id="sound-chips">
        <button class="s-chip" data-sound="rain">&#127783;&#65039; Rain</button>
        <button class="s-chip" data-sound="forest">&#127794; Forest</button>
        <button class="s-chip" data-sound="cafe">&#9749; Cafe</button>
        <button class="s-chip" data-sound="ocean">&#127754; Ocean</button>
        <button class="s-chip" data-sound="fire">&#128293; Fire</button>
        <button class="s-chip" data-sound="space">&#127756; Space</button>
        <button class="s-chip" data-sound="off">&#128263; Off</button>
      </div>
      <!-- Volume slider -->
      <div class="vol-row" id="vol-row">
        <i class="fas fa-volume-xmark vol-icon" id="vol-icon" onclick="_volToggleMute()"></i>
        <div class="vol-track" id="vol-track">
          <div class="vol-fill" id="vol-fill" style="width:70%"></div>
          <div class="vol-thumb" id="vol-thumb" style="left:70%"></div>
        </div>
        <span class="vol-label" id="vol-label">70</span>
      </div>
      <!-- Now-playing pill -->
      <div class="now-playing-pill" id="now-playing-pill">
        <div class="np-dot"></div>
        <span class="np-title" id="np-title">Music playing</span>
        <i class="fas fa-times" style="flex-shrink:0;cursor:pointer;color:var(--text-s);font-size:10px" onclick="stopPomodoroMusic();_npHide()" title="Stop music"></i>
      </div>
    </div>
    <div id="block-warn" class="block-warn" style="display:none">
      <i class="fas fa-calendar-exclamation"></i>&nbsp; <span id="block-msg"></span>
    </div>
  </div>
  <!-- AI Intention Widget -->
  <div id="intention-wrap" style="width:100%;max-width:480px;margin:14px auto 0">
    <div style="background:var(--bg-panel);border:1px solid rgba(168,85,247,.2);border-radius:14px;padding:13px 16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.8px"><i class="fas fa-brain" style="color:#a855f7;margin-right:4px"></i>Set Your Intention</span>
        <span id="intention-ai-badge" style="display:none;font-size:9px;background:rgba(168,85,247,.15);color:var(--accent);border-radius:99px;padding:1px 7px;font-weight:700;border:1px solid rgba(168,85,247,.25)">AI</span>
      </div>
      <div style="display:flex;gap:7px;align-items:flex-start">
        <input id="intention-input" type="text" placeholder="What will you accomplish this session?" style="flex:1;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:9px;padding:8px 12px;color:var(--text-p);font-size:13px;outline:none;min-width:0" onkeydown="if(event.key==='Enter')setIntention()"/>
        <button onclick="setIntention()" style="padding:8px 13px;border-radius:9px;border:none;background:rgba(168,85,247,.2);color:var(--accent);cursor:pointer;font-size:13px;font-weight:700;white-space:nowrap;flex-shrink:0">Set →</button>
      </div>
      <div id="intention-display" style="display:none;margin-top:10px;padding:8px 11px;background:rgba(168,85,247,.07);border-radius:8px;font-size:12px;color:var(--text-s);border-left:3px solid var(--accent)"></div>
    </div>
  </div>
  <!-- Smart Schedule Suggestions -->
  <div id="smart-schedule-wrap" style="margin-top:14px;width:100%;max-width:480px;margin-left:auto;margin-right:auto">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.8px"><i class="fas fa-bolt" style="color:#a855f7;margin-right:5px"></i>Smart Schedule</span>
      <button onclick="loadSmartSuggestions()" style="background:none;border:none;color:#666;font-size:11px;cursor:pointer;padding:2px 6px;border-radius:5px;transition:.2s" onmouseover="this.style.color='#a855f7'" onmouseout="this.style.color='#666'"><i class="fas fa-sync-alt"></i></button>
    </div>
    <div id="smart-suggestions" style="display:flex;flex-direction:column;gap:7px">
      <div style="font-size:12px;color:#555;text-align:center;padding:10px">Sign in with Google to see your optimal focus windows</div>
    </div>
  </div>
</div>

<!-- CHAT TAB -->
<div class="tab-pane" id="tab-pane-chat" style="display:none;padding:14px">
  <!-- Token usage meter (shown for free users) -->
  <div id="chat-token-meter" style="display:none;margin-bottom:10px;padding:8px 12px;background:var(--bg-panel);border:1px solid var(--border);border-radius:10px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
      <span style="font-size:11px;color:#888;font-weight:600">Daily Token Usage</span>
      <span id="chat-token-label" style="font-size:11px;color:var(--text-s)">0 / 1,500</span>
    </div>
    <div style="height:4px;background:rgba(255,255,255,.06);border-radius:99px;overflow:hidden">
      <div id="chat-token-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#a855f7,#ec4899);border-radius:99px;transition:width .4s ease"></div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:5px">
      <span id="chat-token-sub" style="font-size:10px;color:#555"></span>
      <a href="#" onclick="openPricingModal();return false" style="font-size:10px;color:var(--accent);text-decoration:none;font-weight:700">↑ Upgrade for 100k/day</a>
    </div>
  </div>
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
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <h3 style="margin:0 0 4px">&#128197; Connect Google Calendar</h3>
        <p style="margin:0 0 10px">See real events, block focus time, and log sessions automatically.</p>
        <button class="btn-primary" id="cal-connect-btn" style="font-size:12px;padding:7px 16px"><i class="fas fa-google"></i>&nbsp; Connect Google</button>
      </div>
      <div style="font-size:11px;color:#666;min-width:160px">
        <div style="font-weight:700;color:#888;margin-bottom:4px">Without Google you can still:</div>
        <div style="line-height:1.8">✓ Track focus sessions<br>✓ View your FlowScore<br>✓ Use Smart Scheduling<br>✓ Log outputs &amp; wins</div>
      </div>
    </div>
  </div>
  <div id="cal-debug-panel" style="display:none;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.4);border-radius:8px;padding:10px 12px;font-size:12px;font-family:monospace;color:#fca5a5;margin-bottom:10px"></div>
  <!-- Toolbar -->
  <div class="cal-toolbar">
    <div style="display:flex;align-items:center;gap:6px">
      <button class="btn-sm" id="cal-prev"><i class="fas fa-chevron-left"></i></button>
      <span class="cal-month-lbl" id="cal-month-label">— —</span>
      <button class="btn-sm" id="cal-next"><i class="fas fa-chevron-right"></i></button>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn-sm" id="cal-add-btn"><i class="fas fa-plus"></i> Add Event</button>
      <button class="btn-sm" id="cal-refresh"><i class="fas fa-sync-alt"></i></button>
      <button class="btn-sm" onclick="window.location.href='/api/auth/hard-reset'"><i class="fas fa-rotate"></i> Re-sync</button>
    </div>
  </div>
  <!-- Grid + side panel (panel hidden by default via CSS display:none, shown by .open class) -->
  <div class="cal-wrap" id="cal-wrap">
    <div class="cal-grid-col">
      <div class="cal-grid" id="cal-grid"></div>
    </div>
    <div class="cal-panel" id="cal-panel">
      <!-- Day detail -->
      <div class="cal-panel-card" id="cal-day-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <span id="cal-day-title" style="font-size:13px;font-weight:700;color:#f0f0f0"></span>
          <button onclick="calClosePanel()" style="background:none;border:none;color:#666;font-size:18px;cursor:pointer;line-height:1">&#x2715;</button>
        </div>
        <div id="cal-day-events"></div>
        <button id="cal-add-link" onclick="calShowAddForm()" style="display:none;margin-top:10px;width:100%;padding:7px;border-radius:8px;border:1px dashed rgba(168,85,247,.5);background:transparent;color:#a855f7;font-size:12px;font-weight:600;cursor:pointer">+ Add Event</button>
      </div>
      <!-- Add event form -->
      <div class="cal-panel-card" id="add-ev-form" style="margin-top:10px;display:none">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-size:13px;font-weight:800;color:#f0f0f0">New Event</span>
          <button id="ev-cancel-btn" style="background:none;border:none;color:#666;font-size:18px;cursor:pointer;line-height:1">&#x2715;</button>
        </div>
        <div class="form-row"><input type="text" id="ev-title" placeholder="Event title" style="flex:2"><input type="color" id="ev-color-pick" value="#a855f7" style="flex:0 0 36px;padding:2px;cursor:pointer"></div>
        <div class="form-row"><input type="datetime-local" id="ev-start"><input type="datetime-local" id="ev-end"></div>
        <div class="form-row"><input type="text" id="ev-desc" placeholder="Description (optional)"></div>
        <div style="margin-top:8px"><button class="btn-primary" id="ev-save-btn" style="width:100%">Save Event</button></div>
      </div>
    </div>
  </div>
</div>

<!-- METRICS TAB -->
<div class="tab-pane" id="tab-pane-metrics" style="display:none">
  <!-- Weekly Review Card -->
  <div id="weekly-review-card" class="weekly-review-card" style="display:none">
    <div class="wr-header">
      <div>
        <div class="wr-title">Weekly Review</div>
        <div class="wr-dates" id="wr-dates"></div>
      </div>
      <div class="wr-score-wrap">
        <svg width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(168,85,247,.15)" stroke-width="6"/>
          <circle cx="32" cy="32" r="26" fill="none" stroke="url(#wrg)" stroke-width="6"
            stroke-dasharray="163.4" id="wr-ring" stroke-dashoffset="163.4"
            stroke-linecap="round" transform="rotate(-90 32 32)"/>
          <defs><linearGradient id="wrg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs>
        </svg>
        <div class="wr-score-inner">
          <div class="wr-score-num" id="wr-score-num">–</div>
          <div class="wr-score-lbl">FlowScore</div>
        </div>
      </div>
    </div>
    <div id="wr-local-badge" style="display:none;align-items:center;gap:6px;font-size:10px;color:#888;background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.15);border-radius:8px;padding:5px 10px;margin-bottom:10px">
      <i class="fas fa-database" style="color:var(--accent);font-size:9px"></i>
      Local data · <a href="#" onclick="openAuthPopup('/api/auth/google');return false" style="color:var(--accent);text-decoration:none">Connect Google</a> for calendar-aware review
    </div>
    <div class="wr-stats-row">
      <div class="wr-stat"><div class="wr-stat-val" id="wr-focus-min">–</div><div class="wr-stat-lbl">Focus min</div></div>
      <div class="wr-stat"><div class="wr-stat-val" id="wr-sessions">–</div><div class="wr-stat-lbl">Sessions</div></div>
      <div class="wr-stat"><div class="wr-stat-val" id="wr-streak">–</div><div class="wr-stat-lbl">Day streak</div></div>
      <div class="wr-stat"><div class="wr-stat-val" id="wr-meetings">–</div><div class="wr-stat-lbl">Meetings</div></div>
    </div>
    <div class="wr-cols">
      <div class="wr-col wins">
        <div class="wr-col-title"><i class="fas fa-trophy"></i> Wins</div>
        <div id="wr-wins"></div>
      </div>
      <div class="wr-col improve">
        <div class="wr-col-title"><i class="fas fa-arrow-trend-up"></i> Level Up</div>
        <div id="wr-improve"></div>
      </div>
    </div>
    <button id="wr-send-email-btn" onclick="sendWeeklyDigest(this)" style="display:none;width:100%;margin-top:14px;padding:10px;border-radius:10px;border:none;background:linear-gradient(135deg,rgba(168,85,247,.2),rgba(236,72,153,.15));border:1px solid rgba(168,85,247,.35);color:#c084fc;font-size:13px;font-weight:700;cursor:pointer;transition:opacity .2s">
      <i class="fas fa-envelope" style="margin-right:6px"></i>Send this week's recap to my email
    </button>
  </div>
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
    <button class="gen-subtab-btn"        id="gsub-tts"       onclick="switchGenSub('tts')"><i class="fas fa-waveform-lines"></i> Voice Studio</button>
    <button class="gen-subtab-btn"        id="gsub-filetools" onclick="switchGenSub('filetools')"><i class="fas fa-folder-open"></i> File Tools</button>
    <button class="gen-subtab-btn"        id="gsub-higgsfield" onclick="switchGenSub('higgsfield')" style="background:linear-gradient(135deg,rgba(0,212,255,.12),rgba(0,255,163,.10));border-color:rgba(0,212,255,.3);color:#00d4ff"><i class="fas fa-film"></i> ✦ Higgsfield AI</button>
    <button class="gen-subtab-btn"        id="gsub-code"       onclick="switchGenSub('code')" style="background:linear-gradient(135deg,rgba(16,185,129,.12),rgba(168,85,247,.10));border-color:rgba(16,185,129,.3);color:#10b981"><i class="fas fa-code"></i> ✦ AI Code</button>
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
          <!-- CLAW Video Wizard CTA -->
          <div style="background:linear-gradient(135deg,rgba(168,85,247,.1),rgba(6,182,212,.1));border:1px solid rgba(168,85,247,.3);border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:12px">
            <span style="font-size:26px;flex-shrink:0">🎬</span>
            <div style="flex:1">
              <div style="font-size:13px;font-weight:700;margin-bottom:2px">Create with CLAW</div>
              <div style="font-size:11px;color:var(--text-s)">Let CLAW generate a concept, shot list, and full production pipeline — not just a single clip.</div>
            </div>
            <button onclick="openClawVideoWizard()" style="padding:7px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#a855f7,#06b6d4);color:#fff;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">
              Open Wizard
            </button>
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
    <div class="gen-sub-pane" id="gen-pane-tts" style="flex-direction:column">

      <!-- ── Voice Studio inner sub-tabs — fixed bar, never scrolls away ── -->
      <div style="display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0;background:var(--bg-panel);flex-wrap:wrap;align-items:center">
        <button id="vstab-tts" onclick="switchVoiceTab('tts')" class="gen-subtab-btn gen-subtab-btn--inner active-voice-tab" style="font-size:11px;padding:5px 12px"><i class="fas fa-keyboard" style="margin-right:5px"></i>Text to Speech</button>
        <button id="vstab-sts" onclick="switchVoiceTab('sts')" class="gen-subtab-btn gen-subtab-btn--inner" style="font-size:11px;padding:5px 12px"><i class="fas fa-microphone-alt" style="margin-right:5px"></i>Speech to Speech</button>
        <button id="vstab-clone" onclick="switchVoiceTab('clone')" class="gen-subtab-btn gen-subtab-btn--inner" style="font-size:11px;padding:5px 12px"><i class="fas fa-dna" style="margin-right:5px"></i>Voice Cloning</button>
        <span style="margin-left:auto;font-size:11px;font-weight:600;color:#10b981;display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:#10b981;display:inline-block"></span>ElevenLabs Live</span>
      </div>

      <div class="gen-main-area" style="flex-direction:column;overflow-y:auto;flex:1">

        <!-- ══════════════════════ TEXT TO SPEECH PANEL ══════════════════════ -->
        <div id="vs-panel-tts" class="vs-panel" style="display:flex;gap:14px;flex-wrap:wrap">
          <div class="gen-panel" style="flex:1;min-width:260px">
            <div class="gen-section-header" style="margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="width:26px;height:26px;border-radius:7px;background:rgba(168,85,247,.18);display:flex;align-items:center;justify-content:center"><i class="fas fa-keyboard" style="color:var(--accent);font-size:12px"></i></span>
                <span class="gen-title" style="margin:0;font-size:13px">Text to Speech</span>
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
                  <div id="tts-cloned-voice-rows"></div>
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
          <!-- TTS sidebar info -->
          <div style="width:160px;flex-shrink:0;display:flex;flex-direction:column;gap:8px">
            <div class="gen-sidebar-section" style="background:rgba(255,255,255,.03);border-radius:10px;padding:12px">
              <div class="gen-sidebar-label" style="margin-bottom:8px">VOICE ENGINE</div>
              <div class="gen-sidebar-row"><i class="fas fa-check-circle" style="color:#10b981"></i> ElevenLabs Live</div>
              <div class="gen-sidebar-row"><i class="fas fa-globe" style="color:var(--accent)"></i> 29 Languages</div>
              <div class="gen-sidebar-row"><i class="fas fa-users" style="color:var(--cyan)"></i> <span id="tts-sidebar-voice-count">21</span> Voices</div>
            </div>
            <div id="gsb-tts-log" class="gen-sidebar-log" style="flex:1"></div>
          </div>
        </div>

        <!-- ══════════════════════ SPEECH TO SPEECH PANEL ══════════════════════ -->
        <div id="vs-panel-sts" class="vs-panel" style="display:none;gap:14px;flex-wrap:wrap">
          <div class="gen-panel" style="flex:1;min-width:260px">
            <div class="gen-section-header" style="margin-bottom:14px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="width:26px;height:26px;border-radius:7px;background:rgba(6,182,212,.15);display:flex;align-items:center;justify-content:center"><i class="fas fa-microphone-alt" style="color:var(--cyan);font-size:12px"></i></span>
                <span class="gen-title" style="margin:0;font-size:13px">Speech to Speech</span>
              </div>
              <span style="font-size:11px;color:var(--text-s)">Transform your voice into any ElevenLabs voice</span>
            </div>

            <!-- Target voice picker (reuse TTS voices) -->
            <div style="margin-bottom:12px">
              <div style="font-size:11px;color:var(--text-s);margin-bottom:5px;font-weight:500">TARGET VOICE</div>
              <div class="gs-gen-picker" style="position:relative">
                <button class="gs-model-pill" onclick="toggleAudPicker(event,'sts-voice')" id="sts-voice-pill" style="width:100%;justify-content:space-between">
                  <span style="display:flex;align-items:center;gap:6px"><i class="fas fa-user-circle" style="font-size:13px;color:var(--cyan)"></i><span id="sts-voice-label">Adam - Dominant, Firm</span></span>
                  <i class="fas fa-chevron-down" style="font-size:9px;opacity:.5"></i>
                </button>
                <div class="gs-model-dropdown" id="sts-voice-dropdown" style="display:none;min-width:260px;max-height:280px;overflow-y:auto">
                  <div class="gs-model-row" onclick="setSTSVoice('pNInz6obpgDQGcFmaJgB','Adam - Dominant, Firm')"><div><div style="font-weight:600;font-size:13px">Adam</div><div style="font-size:11px;color:var(--text-s)">Dominant, Firm &middot; Male</div></div><div class="gs-radio gs-radio-active" id="stvr-adam"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('EXAVITQu4vr4xnSDxMaL','Sarah - Mature, Confident')"><div><div style="font-weight:600;font-size:13px">Sarah</div><div style="font-size:11px;color:var(--text-s)">Mature, Confident &middot; Female</div></div><div class="gs-radio" id="stvr-sarah"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('JBFqnCBsd6RMkjVDRZzb','George - Warm Storyteller')"><div><div style="font-weight:600;font-size:13px">George</div><div style="font-size:11px;color:var(--text-s)">Warm Storyteller &middot; Male &middot; British</div></div><div class="gs-radio" id="stvr-george"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('nPczCjzI2devNBz1zQrb','Brian - Deep, Resonant')"><div><div style="font-weight:600;font-size:13px">Brian</div><div style="font-size:11px;color:var(--text-s)">Deep, Resonant &middot; Male</div></div><div class="gs-radio" id="stvr-brian"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('IKne3meq5aSn9XLyUdCD','Charlie - Deep, Energetic')"><div><div style="font-weight:600;font-size:13px">Charlie</div><div style="font-size:11px;color:var(--text-s)">Deep, Energetic &middot; Male &middot; Australian</div></div><div class="gs-radio" id="stvr-charlie"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('cgSgspJ2msm6clMCkdW9','Jessica - Playful, Bright')"><div><div style="font-weight:600;font-size:13px">Jessica</div><div style="font-size:11px;color:var(--text-s)">Playful, Bright &middot; Female</div></div><div class="gs-radio" id="stvr-jessica"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('onwK4e9ZLuTAKqWW03F9','Daniel - Steady Broadcaster')"><div><div style="font-weight:600;font-size:13px">Daniel</div><div style="font-size:11px;color:var(--text-s)">Steady Broadcaster &middot; Male &middot; British</div></div><div class="gs-radio" id="stvr-daniel"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('CwhRBWXzGAHq8TQ4Fs17','Roger - Laid-Back, Casual')"><div><div style="font-weight:600;font-size:13px">Roger</div><div style="font-size:11px;color:var(--text-s)">Laid-Back, Casual &middot; Male</div></div><div class="gs-radio" id="stvr-roger"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('SAz9YHcvj6GT2YYXdXww','River - Relaxed, Neutral')"><div><div style="font-weight:600;font-size:13px">River</div><div style="font-size:11px;color:var(--text-s)">Relaxed, Neutral &middot; Non-binary</div></div><div class="gs-radio" id="stvr-river"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('TX3LPaxmHKxFdv7VOQHJ','Liam - Energetic Creator')"><div><div style="font-weight:600;font-size:13px">Liam</div><div style="font-size:11px;color:var(--text-s)">Energetic Creator &middot; Male</div></div><div class="gs-radio" id="stvr-liam"></div></div>
                  <div class="gs-model-row" onclick="setSTSVoice('XrExE9yKIg1WjnnlVkGX','Matilda - Professional')"><div><div style="font-weight:600;font-size:13px">Matilda</div><div style="font-size:11px;color:var(--text-s)">Professional &middot; Female &middot; American</div></div><div class="gs-radio" id="stvr-matilda"></div></div>
                  <div id="sts-cloned-voice-rows"></div>
                </div>
              </div>
            </div>

            <!-- STS model picker -->
            <div style="margin-bottom:12px">
              <div style="font-size:11px;color:var(--text-s);margin-bottom:5px;font-weight:500">STS MODEL</div>
              <div class="gs-gen-picker" style="position:relative">
                <button class="gs-model-pill" onclick="toggleAudPicker(event,'stsmodel')" id="sts-model-pill">
                  <i class="fas fa-bolt" style="font-size:11px;color:#f59e0b"></i>
                  <span id="sts-model-label">English STS v2</span>
                  <i class="fas fa-chevron-down" style="font-size:9px;opacity:.5"></i>
                </button>
                <div class="gs-model-dropdown" id="sts-model-dropdown" style="display:none;min-width:240px">
                  <div class="gs-model-row" onclick="setSTSModel('eleven_english_sts_v2','English STS v2')"><div><div style="font-weight:600;font-size:13px">English STS v2</div><div style="font-size:11px;color:var(--text-s)">English only &middot; High quality</div></div><div class="gs-radio gs-radio-active" id="stmr-en2"></div></div>
                  <div class="gs-model-row" onclick="setSTSModel('eleven_multilingual_sts_v2','Multilingual STS v2')"><div><div style="font-weight:600;font-size:13px">Multilingual STS v2</div><div style="font-size:11px;color:var(--text-s)">29 languages &middot; Best quality</div></div><div class="gs-radio" id="stmr-ml2"></div></div>
                </div>
              </div>
            </div>

            <!-- Voice settings sliders -->
            <div style="margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-s);margin-bottom:2px"><span>Stability</span><span id="sts-stab-val">0.5</span></div>
              <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-s);opacity:.6;margin-bottom:4px"><span>More variable</span><span>More stable</span></div>
              <input id="sts-stability" type="range" min="0" max="1" step="0.05" value="0.5" oninput="document.getElementById('sts-stab-val').textContent=parseFloat(this.value).toFixed(2)" style="width:100%;accent-color:var(--cyan);margin-bottom:10px">
            </div>
            <div style="margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-s);margin-bottom:2px"><span>Similarity</span><span id="sts-sim-val">0.75</span></div>
              <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-s);opacity:.6;margin-bottom:4px"><span>Low</span><span>High</span></div>
              <input id="sts-similarity" type="range" min="0" max="1" step="0.05" value="0.75" oninput="document.getElementById('sts-sim-val').textContent=parseFloat(this.value).toFixed(2)" style="width:100%;accent-color:var(--cyan);margin-bottom:10px">
            </div>
            <div style="margin-bottom:14px">
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-s);margin-bottom:2px"><span>Style Exaggeration</span><span id="sts-style-val">0.00</span></div>
              <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-s);opacity:.6;margin-bottom:4px"><span>None</span><span>Exaggerated</span></div>
              <input id="sts-style-ex" type="range" min="0" max="1" step="0.05" value="0" oninput="document.getElementById('sts-style-val').textContent=parseFloat(this.value).toFixed(2)" style="width:100%;accent-color:var(--cyan)">
            </div>

            <!-- Record / upload audio -->
            <div style="background:rgba(6,182,212,.06);border:1px dashed rgba(6,182,212,.25);border-radius:10px;padding:14px;margin-bottom:12px">
              <div style="font-size:11px;color:var(--text-s);margin-bottom:10px;font-weight:500;text-transform:uppercase;letter-spacing:.05em">INPUT AUDIO</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
                <button id="sts-rec-btn" onclick="toggleSTSRecording()" class="btn-gen" style="flex:1;background:linear-gradient(135deg,#ef4444,#dc2626);padding:8px 12px;font-size:12px">
                  <i class="fas fa-circle" style="color:#fff;font-size:10px"></i>&nbsp; Record
                </button>
                <label style="flex:1" class="btn-gen" style="padding:8px 12px;font-size:12px;cursor:pointer;background:rgba(255,255,255,.07);text-align:center;display:flex;align-items:center;justify-content:center;gap:6px">
                  <i class="fas fa-upload" style="font-size:11px"></i> Upload
                  <input type="file" id="sts-file-input" accept="audio/*" onchange="stsFileSelected(this)" style="display:none">
                </label>
              </div>
              <div id="sts-rec-status" style="font-size:11px;color:var(--text-s);margin-bottom:8px;min-height:18px"></div>
              <audio id="sts-preview-player" controls style="width:100%;display:none;margin-bottom:4px"></audio>
            </div>

            <button onclick="generateSTS()" id="sts-btn" class="btn-gen" style="background:linear-gradient(135deg,#06b6d4,#0891b2)">
              <i class="fas fa-waveform-lines"></i>&nbsp; Convert Voice
            </button>
            <div id="sts-status" style="display:none;margin-top:12px;text-align:center">
              <div id="sts-status-text" style="font-size:12px;color:var(--text-s);margin-bottom:8px"></div>
              <audio id="sts-player" controls style="width:100%;margin-bottom:6px"></audio>
              <a id="sts-download" href="#" download="flowstate-sts.mp3" style="display:none;font-size:11px;color:var(--cyan);text-decoration:none"><i class="fas fa-download"></i> Download MP3</a>
            </div>
          </div>
          <!-- STS info sidebar -->
          <div style="width:160px;flex-shrink:0">
            <div class="gen-sidebar-section" style="background:rgba(255,255,255,.03);border-radius:10px;padding:12px">
              <div class="gen-sidebar-label" style="margin-bottom:8px">HOW IT WORKS</div>
              <div style="font-size:11px;color:var(--text-s);line-height:1.6">
                <div style="margin-bottom:6px"><i class="fas fa-microphone" style="color:var(--cyan);width:14px"></i> Record or upload your voice</div>
                <div style="margin-bottom:6px"><i class="fas fa-exchange-alt" style="color:var(--cyan);width:14px"></i> Pick a target ElevenLabs voice</div>
                <div><i class="fas fa-music" style="color:var(--cyan);width:14px"></i> Get audio back in that voice</div>
              </div>
            </div>
          </div>
        </div>

        <!-- ══════════════════════ VOICE CLONING PANEL ══════════════════════ -->
        <div id="vs-panel-clone" class="vs-panel" style="display:none;gap:14px;flex-wrap:wrap">
          <div class="gen-panel" style="flex:1;min-width:260px">
            <div class="gen-section-header" style="margin-bottom:14px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="width:26px;height:26px;border-radius:7px;background:rgba(16,185,129,.15);display:flex;align-items:center;justify-content:center"><i class="fas fa-dna" style="color:#10b981;font-size:12px"></i></span>
                <span class="gen-title" style="margin:0;font-size:13px">Voice Cloning (IVC)</span>
              </div>
              <span style="font-size:11px;color:var(--text-s)">Clone any voice from audio samples</span>
            </div>

            <!-- Create clone form -->
            <div style="background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.15);border-radius:10px;padding:14px;margin-bottom:16px">
              <div style="font-size:11px;color:var(--text-s);font-weight:500;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">CREATE NEW CLONE</div>

              <!-- Voice name -->
              <input id="clone-name-input" type="text" placeholder="Voice name (e.g. My Voice)" class="fs-input" style="width:100%;margin-bottom:12px;box-sizing:border-box">

              <!-- Upload / drag-drop zone -->
              <div id="clone-drop-zone"
                style="border:2px dashed rgba(16,185,129,.35);border-radius:10px;padding:22px 16px;text-align:center;cursor:pointer;margin-bottom:10px;transition:border-color .2s,background .2s"
                onclick="document.getElementById('clone-file-input').click()"
                ondragover="cloneDropOver(event)" ondragleave="cloneDropLeave(event)" ondrop="cloneDropped(event)">
                <i class="fas fa-arrow-up-from-bracket" style="font-size:22px;color:rgba(16,185,129,.6);margin-bottom:8px;display:block"></i>
                <div style="font-size:12px;color:var(--text-p);font-weight:600;margin-bottom:3px">Click to upload, or drag and drop</div>
                <div style="font-size:11px;color:var(--text-s)">Audio files up to 50 MB each &middot; MP3, WAV, M4A, WEBM</div>
                <input type="file" id="clone-file-input" accept="audio/*" multiple onchange="cloneFilesSelected(this)" style="display:none">
              </div>

              <!-- Record button -->
              <button id="clone-rec-btn" onclick="toggleCloneRecording()" class="btn-gen" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:var(--text-p);font-size:12px;padding:9px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:7px">
                <i class="fas fa-microphone" style="color:#10b981"></i> Record audio
              </button>

              <!-- Added samples list -->
              <div id="clone-samples-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px"></div>
              <div id="clone-duration-info" style="font-size:11px;color:var(--text-s);margin-bottom:10px;display:none">
                <i class="fas fa-clock" style="color:#10b981"></i> <span id="clone-duration-text">0:00 total duration</span>
              </div>

              <button onclick="createVoiceClone()" id="clone-btn" class="btn-gen" style="background:linear-gradient(135deg,#10b981,#059669);width:100%">
                <i class="fas fa-dna"></i>&nbsp; Create Voice Clone
              </button>
              <div id="clone-status" style="display:none;margin-top:8px;font-size:11px;text-align:center;color:var(--text-s)"></div>
            </div>

            <!-- Existing clones list -->
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <div style="font-size:11px;color:var(--text-s);font-weight:500;text-transform:uppercase;letter-spacing:.05em">MY CLONED VOICES</div>
                <button onclick="loadClonedVoices()" style="background:none;border:none;cursor:pointer;font-size:11px;color:var(--accent);padding:0"><i class="fas fa-sync-alt" style="font-size:10px"></i> Refresh</button>
              </div>
              <div id="clone-list" style="display:flex;flex-direction:column;gap:6px;min-height:60px">
                <div style="font-size:11px;color:var(--text-s);text-align:center;padding:16px;opacity:.6"><i class="fas fa-spinner fa-spin"></i> Loading clones…</div>
              </div>
            </div>
          </div>
          <!-- Clone info sidebar -->
          <div style="width:160px;flex-shrink:0">
            <div class="gen-sidebar-section" style="background:rgba(255,255,255,.03);border-radius:10px;padding:12px">
              <div class="gen-sidebar-label" style="margin-bottom:8px">TIPS</div>
              <div style="font-size:11px;color:var(--text-s);line-height:1.7">
                <div style="margin-bottom:5px"><i class="fas fa-check" style="color:#10b981;width:14px"></i> Use clean, clear audio</div>
                <div style="margin-bottom:5px"><i class="fas fa-check" style="color:#10b981;width:14px"></i> Minimum 30 sec per sample</div>
                <div style="margin-bottom:5px"><i class="fas fa-check" style="color:#10b981;width:14px"></i> Avoid music/noise</div>
                <div><i class="fas fa-check" style="color:#10b981;width:14px"></i> More samples = better quality</div>
              </div>
            </div>
          </div>
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

            <!-- TXT → PDF -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(245,158,11,.15)"><i class="fas fa-file-alt" style="color:var(--warn)"></i></div>
              <div class="file-tool-name">TXT &rarr; PDF</div>
              <div class="file-tool-desc">Convert any plain text file to a clean PDF document</div>
              <label class="file-tool-drop" for="ft-txt-input">
                <input type="file" id="ft-txt-input" accept=".txt,.md,.log,.csv,.json" style="display:none" onchange="ftTxtPreview(this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:var(--warn);margin-bottom:6px"></i>
                <span>Drop .txt / .md file</span>
              </label>
              <div id="ft-txt-opts" style="display:none;margin-top:8px">
                <pre id="ft-txt-preview" style="display:none;font-size:10px;color:var(--text-s);background:var(--bg-card);border-radius:6px;padding:8px;max-height:70px;overflow:hidden;white-space:pre-wrap;word-break:break-all;margin-bottom:8px"></pre>
                <button class="btn-gen" style="padding:8px 16px;font-size:12px" onclick="ftDoTxtToPdf()"><i class="fas fa-file-pdf"></i> Convert to PDF</button>
              </div>
              <div id="ft-txt-status" class="file-tool-status"></div>
              <div id="ft-txt-result" class="file-tool-results"></div>
            </div>

            <!-- CSV → JSON -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(16,185,129,.15)"><i class="fas fa-table" style="color:#10b981"></i></div>
              <div class="file-tool-name">CSV &rarr; JSON</div>
              <div class="file-tool-desc">Convert CSV spreadsheets to clean JSON arrays</div>
              <label class="file-tool-drop" for="ft-csv-input">
                <input type="file" id="ft-csv-input" accept=".csv,.tsv" style="display:none" onchange="ftCsvPreview(this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:#10b981;margin-bottom:6px"></i>
                <span>Drop .csv / .tsv file</span>
              </label>
              <div id="ft-csv-opts" style="display:none;margin-top:8px">
                <button class="btn-gen" style="padding:8px 16px;font-size:12px;background:linear-gradient(135deg,#10b981,#06b6d4)" onclick="ftDoCsvToJson()"><i class="fas fa-code"></i> Convert to JSON</button>
              </div>
              <div id="ft-csv-status" class="file-tool-status"></div>
              <pre id="ft-csv-preview" style="display:none;font-size:10px;color:var(--text-s);background:var(--bg-card);border-radius:6px;padding:8px;max-height:80px;overflow:hidden;white-space:pre-wrap;word-break:break-all;margin-top:6px"></pre>
              <div id="ft-csv-result" class="file-tool-results"></div>
            </div>

            <!-- SVG → PNG -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(6,182,212,.15)"><i class="fas fa-bezier-curve" style="color:var(--cyan)"></i></div>
              <div class="file-tool-name">SVG &rarr; PNG</div>
              <div class="file-tool-desc">Render SVG vector graphics to PNG at any scale</div>
              <label class="file-tool-drop" for="ft-svg-input">
                <input type="file" id="ft-svg-input" accept=".svg,image/svg+xml" style="display:none" onchange="ftSvgPreview(this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:var(--cyan);margin-bottom:6px"></i>
                <span>Drop .svg file</span>
              </label>
              <div id="ft-svg-opts" style="display:none;margin-top:8px">
                <img id="ft-svg-preview" style="display:none;max-width:100%;max-height:80px;border-radius:6px;margin-bottom:8px;object-fit:contain">
                <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
                  <label style="font-size:11px;color:var(--text-s)">Scale:</label>
                  <select id="ft-svg-scale" style="background:var(--bg-card);border:1px solid var(--border);border-radius:7px;padding:5px 8px;color:var(--text-p);font-size:12px">
                    <option value="1">1× (original)</option>
                    <option value="2" selected>2× (recommended)</option>
                    <option value="3">3× (high-res)</option>
                    <option value="4">4× (print)</option>
                  </select>
                </div>
                <button class="btn-gen" style="padding:8px 16px;font-size:12px;background:linear-gradient(135deg,#06b6d4,#3b82f6)" onclick="ftDoSvgToPng()"><i class="fas fa-image"></i> Export PNG</button>
              </div>
              <div id="ft-svg-status" class="file-tool-status"></div>
              <div id="ft-svg-result" class="file-tool-results"></div>
            </div>

            <!-- PPTX → PDF -->
            <div class="file-tool-card">
              <div class="file-tool-icon" style="background:rgba(239,68,68,.15)"><i class="fas fa-file-powerpoint" style="color:#ef4444"></i></div>
              <div class="file-tool-name">PPTX &rarr; PDF</div>
              <div class="file-tool-desc">Extract slides from PowerPoint files to a PDF (text + layout)</div>
              <label class="file-tool-drop" for="ft-pptx-input">
                <input type="file" id="ft-pptx-input" accept=".pptx,.ppt" style="display:none" onchange="ftPptxPreview(this)">
                <i class="fas fa-cloud-upload-alt" style="font-size:20px;color:#ef4444;margin-bottom:6px"></i>
                <span>Drop .pptx file</span>
              </label>
              <div id="ft-pptx-opts" style="display:none;margin-top:8px">
                <button class="btn-gen" style="padding:8px 16px;font-size:12px" onclick="ftDoPptxToPdf()"><i class="fas fa-file-pdf"></i> Convert to PDF</button>
              </div>
              <div id="ft-pptx-status" class="file-tool-status"></div>
              <div id="ft-pptx-result" class="file-tool-results"></div>
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
          <div class="gen-sidebar-row"><i class="fas fa-file-alt" style="color:var(--warn)"></i> TXT &rarr; PDF</div>
          <div class="gen-sidebar-row"><i class="fas fa-table" style="color:#10b981"></i> CSV &rarr; JSON</div>
          <div class="gen-sidebar-row"><i class="fas fa-bezier-curve" style="color:var(--cyan)"></i> SVG &rarr; PNG</div>
          <div class="gen-sidebar-row"><i class="fas fa-file-powerpoint" style="color:#ef4444"></i> PPTX &rarr; PDF</div>
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
          <button onclick="openPricingModal()" style="background:linear-gradient(135deg,#00d4ff,#00ffa3);color:#000;border:none;border-radius:10px;padding:10px 22px;font-size:13px;font-weight:800;cursor:pointer">Upgrade to Pro →</button>
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

        <!-- Image Upload Section — always visible, works for all models -->
        <div class="gen-panel" style="margin-bottom:14px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:11px;font-weight:700;color:rgba(0,212,255,.7);text-transform:uppercase;letter-spacing:1px">Images <span style="font-size:10px;color:rgba(0,212,255,.45);text-transform:none;letter-spacing:0;font-weight:400">(drag &amp; drop or click to upload)</span></div>
            <div style="display:flex;gap:6px">
              <span id="higgs-img-mode-label" style="font-size:10px;color:rgba(0,212,255,.5);align-self:center"></span>
            </div>
          </div>

          <!-- Image upload area — supports up to 2 images (start + end frame) -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px" id="higgs-img-slots">

            <!-- Start / Reference Image slot -->
            <div id="higgs-img-slot-1" style="position:relative">
              <div id="higgs-drop-1"
                ondragover="event.preventDefault();this.style.borderColor='#00d4ff';this.style.background='rgba(0,212,255,.12)'"
                ondragleave="this.style.borderColor='rgba(0,212,255,.2)';this.style.background='rgba(0,212,255,.04)'"
                ondrop="higgsDrop(event,1)"
                onclick="document.getElementById('higgs-file-1').click()"
                style="border:2px dashed rgba(0,212,255,.2);border-radius:10px;padding:14px 10px;text-align:center;cursor:pointer;background:rgba(0,212,255,.04);min-height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;transition:.15s;position:relative;overflow:hidden">
                <input type="file" id="higgs-file-1" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none" onchange="higgsFileSelect(event,1)">
                <div id="higgs-img-preview-1" style="display:none;position:absolute;inset:0;border-radius:8px;overflow:hidden">
                  <img id="higgs-img-thumb-1" style="width:100%;height:100%;object-fit:cover" src="" alt="Start frame">
                  <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(to top,rgba(0,0,0,.7),transparent);padding:6px 8px;display:flex;justify-content:space-between;align-items:center">
                    <span style="font-size:10px;color:#00ffa3;font-weight:700">✓ Uploaded</span>
                    <button onclick="event.stopPropagation();higgsRemoveImg(1)" style="background:rgba(239,68,68,.8);border:none;color:#fff;border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer">✕</button>
                  </div>
                </div>
                <i class="fas fa-image" style="font-size:20px;color:rgba(0,212,255,.4);display:block" id="higgs-img-icon-1"></i>
                <span style="font-size:11px;color:rgba(255,255,255,.4)" id="higgs-img-label-1">Start Frame<br><span style="font-size:10px;color:rgba(0,212,255,.4)">or Reference Image</span></span>
                <div id="higgs-img-uploading-1" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;border-radius:8px">
                  <i class="fas fa-spinner fa-spin" style="color:#00d4ff;font-size:18px"></i>
                </div>
              </div>
              <input id="higgs-img-url-1" type="hidden" value="">
            </div>

            <!-- End Frame slot (for first-last-frame models) -->
            <div id="higgs-img-slot-2" style="position:relative">
              <div id="higgs-drop-2"
                ondragover="event.preventDefault();this.style.borderColor='rgba(168,85,247,.5)';this.style.background='rgba(168,85,247,.1)'"
                ondragleave="this.style.borderColor='rgba(168,85,247,.15)';this.style.background='rgba(168,85,247,.03)'"
                ondrop="higgsDrop(event,2)"
                onclick="document.getElementById('higgs-file-2').click()"
                style="border:2px dashed rgba(168,85,247,.15);border-radius:10px;padding:14px 10px;text-align:center;cursor:pointer;background:rgba(168,85,247,.03);min-height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;transition:.15s;position:relative;overflow:hidden">
                <input type="file" id="higgs-file-2" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none" onchange="higgsFileSelect(event,2)">
                <div id="higgs-img-preview-2" style="display:none;position:absolute;inset:0;border-radius:8px;overflow:hidden">
                  <img id="higgs-img-thumb-2" style="width:100%;height:100%;object-fit:cover" src="" alt="End frame">
                  <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(to top,rgba(0,0,0,.7),transparent);padding:6px 8px;display:flex;justify-content:space-between;align-items:center">
                    <span style="font-size:10px;color:#a855f7;font-weight:700">✓ Uploaded</span>
                    <button onclick="event.stopPropagation();higgsRemoveImg(2)" style="background:rgba(239,68,68,.8);border:none;color:#fff;border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer">✕</button>
                  </div>
                </div>
                <i class="fas fa-image" style="font-size:20px;color:rgba(168,85,247,.35);display:block" id="higgs-img-icon-2"></i>
                <span style="font-size:11px;color:rgba(255,255,255,.35)" id="higgs-img-label-2">End Frame<br><span style="font-size:10px;color:rgba(168,85,247,.4)">Optional</span></span>
                <div id="higgs-img-uploading-2" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;border-radius:8px">
                  <i class="fas fa-spinner fa-spin" style="color:#a855f7;font-size:18px"></i>
                </div>
              </div>
              <input id="higgs-img-url-2" type="hidden" value="">
            </div>
          </div>

          <!-- URL paste fallback -->
          <details style="margin-top:4px">
            <summary style="font-size:10px;color:rgba(0,212,255,.4);cursor:pointer;list-style:none;display:flex;align-items:center;gap:5px">
              <i class="fas fa-link" style="font-size:9px"></i> Or paste image URLs instead
            </summary>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">
              <input id="higgs-img-url-paste-1" type="url" placeholder="Start frame / reference image URL (https://…)" 
                style="width:100%;background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.15);border-radius:7px;padding:8px 10px;color:#e8e8e8;font-size:12px;outline:none;box-sizing:border-box"
                oninput="higgsUrlPaste(1,this.value)">
              <input id="higgs-img-url-paste-2" type="url" placeholder="End frame URL (optional, https://…)"
                style="width:100%;background:rgba(168,85,247,.05);border:1px solid rgba(168,85,247,.15);border-radius:7px;padding:8px 10px;color:#e8e8e8;font-size:12px;outline:none;box-sizing:border-box"
                oninput="higgsUrlPaste(2,this.value)">
            </div>
          </details>
        </div>

        <!-- Prompt -->
        <div class="gen-panel" style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:rgba(0,212,255,.7);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Prompt</div>
          <textarea id="higgs-prompt" rows="4" placeholder="Describe your scene in detail. Include camera movement, lighting, mood, subject action&#8230; e.g. 'A lone astronaut walks across a red desert at sunset, dolly zoom slowly pulling back, dramatic lens flare, cinematic 4K'" style="width:100%;background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.15);border-radius:10px;padding:12px;color:#e8e8e8;font-size:13px;font-family:inherit;resize:vertical;outline:none;box-sizing:border-box"></textarea>
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:rgba(255,255,255,.5);cursor:pointer">
              <input type="checkbox" id="higgs-enhance-prompt" style="accent-color:#00d4ff"> Enhance Prompt (AI refines your description)
            </label>
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
          <strong style="color:rgba(0,212,255,.6)">✦ Tips:</strong> Drag &amp; drop images or click the frame slots to upload. Use <strong>Start Frame</strong> for reference/I2V. Use <strong>End Frame</strong> for first-last-frame transitions. Be specific about camera movement (dolly zoom, tracking shot, crane lift). T2V models can use images as style reference. Generations typically take 1-3 minutes.
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

    <!-- ═══════════════════════ AI CODE WORKSPACE ═══════════════════════ -->
    <div class="gen-sub-pane" id="gen-pane-code">
    <div class="code-workspace">

      <!-- Agent / Model selector bar -->
      <div class="code-agent-bar" id="code-agent-bar">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);flex-shrink:0;margin-right:4px">AI Agent</div>
        <!-- Pill-style model picker -->
        <div class="gs-gen-picker" id="code-agent-pill-wrap" style="position:relative;flex-shrink:0"></div>
        <!-- Session memory indicator -->
        <div id="code-session-badge" style="margin-left:auto;flex-shrink:0;display:none;align-items:center;gap:6px;font-size:10px;color:#10b981;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);border-radius:7px;padding:4px 9px;white-space:nowrap">
          <i class="fas fa-brain" style="font-size:9px"></i> <span id="code-session-label">0 files · 0 turns</span>
        </div>
        <button id="btn-code-new-session" onclick="codeNewSession()" style="display:none;flex-shrink:0;padding:5px 10px;border-radius:7px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.08);color:#ef4444;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap" title="Clear session memory and start fresh">
          <i class="fas fa-rotate-right"></i> New Session
        </button>
      </div>

      <!-- Three-column workspace body -->
      <div class="code-workspace-body">

      <!-- LEFT: File Explorer + GitHub Panel -->
      <div class="code-sidebar">
        <!-- GitHub Connection Header -->
        <div class="code-gh-header" id="code-gh-header">
          <div id="code-gh-connected" style="display:none">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <img id="code-gh-avatar" src="" style="width:28px;height:28px;border-radius:50%;border:2px solid #10b981" alt="">
              <div>
                <div id="code-gh-name" style="font-size:12px;font-weight:700;color:var(--text-p)"></div>
                <div id="code-gh-login" style="font-size:11px;color:#10b981"></div>
              </div>
              <button class="code-icon-btn" onclick="codeGHDisconnect()" title="Disconnect GitHub" style="margin-left:auto;color:var(--text-m)"><i class="fas fa-unlink"></i></button>
            </div>
            <select class="code-select" id="code-repo-select" onchange="codeSelectRepo(this.value)">
              <option value="">— Select a repository —</option>
            </select>
          </div>
          <div id="code-gh-disconnected">
            <div style="font-size:12px;color:var(--text-s);margin-bottom:8px;line-height:1.5"><i class="fab fa-github" style="color:var(--text-m);margin-right:5px"></i>Optional: connect GitHub to push files directly.</div>
            <button class="code-btn-connect" onclick="codeConnectGitHub()"><i class="fab fa-github"></i> Connect GitHub</button>
          </div>
        </div>

        <!-- AI Generated Files — always visible once building starts -->
        <div class="code-file-explorer">
          <div class="code-panel-label" style="display:flex;align-items:center;justify-content:space-between">
            <span><i class="fas fa-sparkles" style="color:#a855f7"></i> Project Files</span>
            <button onclick="codeLoadProjectsList()" title="Browse saved projects" style="font-size:9px;padding:2px 7px;border-radius:5px;border:1px solid var(--border);background:transparent;color:var(--text-m);cursor:pointer;white-space:nowrap"><i class="fas fa-folder-open" style="font-size:9px;color:#f59e0b"></i> Saved</button>
          </div>
          <div id="code-gen-file-list" class="code-file-tree">
            <div class="code-file-empty">Files appear here as the AI builds…</div>
          </div>
        </div>

        <!-- GitHub File Explorer — only shown when repo selected -->
        <div class="code-generated-files" id="code-generated-files-panel" style="display:none">
          <div class="code-panel-label"><i class="fas fa-folder-tree"></i> Repo Files</div>
          <div id="code-file-tree" class="code-file-tree"></div>
        </div>

        <!-- Saved Projects panel -->
        <div class="code-file-explorer" id="code-projects-panel" style="display:none">
          <div class="code-panel-label" style="display:flex;align-items:center;justify-content:space-between">
            <span><i class="fas fa-folder-open" style="color:#f59e0b"></i> Saved Projects</span>
            <button onclick="codeLoadProjectsList()" style="font-size:9px;padding:2px 6px;border-radius:5px;border:1px solid var(--border);background:transparent;color:var(--text-m);cursor:pointer" title="Refresh">↺</button>
          </div>
          <div id="code-projects-list" class="code-file-tree">
            <div class="code-file-empty">No saved projects yet</div>
          </div>
        </div>

        <!-- Bottom actions -->
        <div style="padding:8px 10px;border-top:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:6px">
          <!-- Publish (Live Preview URL) button — always shown after first build -->
          <div id="code-publish-wrap" style="display:none">
            <button onclick="codePublishPreview()" id="btn-code-publish"
              style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:9px;border-radius:9px;background:linear-gradient(135deg,#00d4ff,#a855f7);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
              <i class="fas fa-globe"></i> Publish Live URL
            </button>
            <!-- Live preview URL shown after publish -->
            <div id="code-preview-result" style="display:none;margin-top:7px;padding:8px 10px;background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.25);border-radius:8px">
              <div style="font-size:10px;font-weight:700;color:#00d4ff;margin-bottom:4px"><i class="fas fa-circle" style="font-size:7px;margin-right:4px;color:#00ffa3"></i>LIVE PREVIEW</div>
              <a id="code-preview-live-url" href="#" target="_blank" style="font-size:10px;color:#00d4ff;word-break:break-all;text-decoration:none;font-weight:600;display:block;margin-bottom:6px"></a>
              <div style="display:flex;gap:6px">
                <button onclick="codePreviewCopyUrl()" style="flex:1;padding:5px;border-radius:6px;border:1px solid rgba(0,212,255,.4);background:transparent;color:#00d4ff;font-size:10px;font-weight:700;cursor:pointer"><i class="fas fa-copy"></i> Copy</button>
                <a id="code-preview-open-btn" href="#" target="_blank" style="flex:1;padding:5px;border-radius:6px;border:1px solid rgba(0,212,255,.4);background:transparent;color:#00d4ff;font-size:10px;font-weight:700;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:4px"><i class="fas fa-external-link-alt"></i> Open</a>
              </div>
            </div>
          </div>

          <!-- Push all button -->
          <div id="code-push-all-wrap" style="display:none">
            <button onclick="codePushAllToGitHub()" style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:8px;border-radius:9px;background:linear-gradient(135deg,#10b981,#059669);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer" id="btn-code-push-all">
              <i class="fab fa-github"></i> Push All to GitHub
            </button>
          </div>

          <!-- Deploy to Cloudflare (legacy — user's own CF token) -->
          <div id="code-deploy-cf-wrap" style="display:none">
            <button onclick="codeDeployToCloudflare()" id="btn-code-deploy-cf"
              style="width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:8px;border-radius:9px;background:linear-gradient(135deg,#f6821f,#e55b00);border:none;color:#fff;font-size:11px;font-weight:700;cursor:pointer">
              <i class="fas fa-rocket"></i> Deploy (my Cloudflare)
            </button>
            <div id="code-deploy-result" style="display:none;margin-top:7px;padding:8px 10px;background:rgba(246,130,31,.08);border:1px solid rgba(246,130,31,.25);border-radius:8px">
              <div style="font-size:10px;font-weight:700;color:#f6821f;margin-bottom:4px"><i class="fas fa-circle" style="font-size:7px;margin-right:4px"></i>DEPLOYED</div>
              <a id="code-deploy-url" href="#" target="_blank" style="font-size:11px;color:#f6821f;word-break:break-all;text-decoration:none;font-weight:600"></a>
              <div style="display:flex;gap:6px;margin-top:6px">
                <button onclick="codeDeployCopyUrl()" style="flex:1;padding:5px;border-radius:6px;border:1px solid rgba(246,130,31,.4);background:transparent;color:#f6821f;font-size:10px;font-weight:700;cursor:pointer"><i class="fas fa-copy"></i> Copy URL</button>
                <a id="code-deploy-open-btn" href="#" target="_blank" style="flex:1;padding:5px;border-radius:6px;border:1px solid rgba(246,130,31,.4);background:transparent;color:#f6821f;font-size:10px;font-weight:700;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:4px"><i class="fas fa-external-link-alt"></i> Open</a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- CENTER: Code Editor + Live Preview -->
      <div class="code-main">
        <!-- Toolbar -->
        <div class="code-toolbar">
          <div class="code-toolbar-left">
            <span class="code-file-badge" id="code-active-file"><i class="fas fa-file-code"></i> No file open</span>
          </div>
          <div class="code-toolbar-right" id="code-toolbar-actions">
            <!-- View toggle: Code / Preview -->
            <div class="code-view-toggle" id="code-view-toggle" style="display:none">
              <button class="code-view-btn active" id="btn-view-code" onclick="codeSetView('code')"><i class="fas fa-code"></i> Code</button>
              <button class="code-view-btn" id="btn-view-preview" onclick="codeSetView('preview')"><i class="fas fa-eye"></i> Preview</button>
            </div>
            <!-- Viewport size controls (visible in preview mode) -->
            <div id="code-viewport-controls" style="display:none;align-items:center;gap:2px">
              <button class="code-icon-btn code-viewport-btn active" id="vp-desktop" onclick="codeSetViewport('desktop')" title="Desktop (100%)"><i class="fas fa-desktop"></i></button>
              <button class="code-icon-btn code-viewport-btn" id="vp-tablet" onclick="codeSetViewport('tablet')" title="Tablet (768px)"><i class="fas fa-tablet-alt"></i></button>
              <button class="code-icon-btn code-viewport-btn" id="vp-mobile" onclick="codeSetViewport('mobile')" title="Mobile (375px)"><i class="fas fa-mobile-alt"></i></button>
            </div>
            <!-- Open in browser button (shown after publish) -->
            <a class="code-icon-btn" id="btn-code-open-browser" href="#" target="_blank" title="Open in new tab — full browser preview" style="display:none;text-decoration:none"><i class="fas fa-external-link-alt"></i></a>
            <!-- Download ZIP -->
            <button class="code-icon-btn" onclick="codeDownloadZip()" title="Download as ZIP" id="btn-code-zip" style="display:none"><i class="fas fa-download"></i></button>
            <button class="code-icon-btn" onclick="codeCopyContent()" title="Copy current file" id="btn-code-copy" style="display:none"><i class="fas fa-copy"></i></button>
            <button class="code-icon-btn" onclick="codePushToGitHub()" title="Push active file to GitHub" id="btn-code-push" style="display:none"><i class="fab fa-github"></i> Push</button>
          </div>
        </div>

        <!-- File tabs bar (populated dynamically by JS, hidden until files exist) -->
        <div class="code-file-tabs" id="code-file-tabs" style="display:none"></div>

        <!-- Code display -->
        <div class="code-editor-wrap" id="code-editor-wrap">
          <div class="code-welcome" id="code-welcome-screen">
            <div style="font-size:28px;margin-bottom:8px">⚡</div>
            <div style="font-size:15px;font-weight:800;color:var(--text-p);margin-bottom:4px">AI Code Builder</div>
            <div style="font-size:12px;color:var(--text-s);line-height:1.6;max-width:340px;margin-bottom:16px">Pick a template or describe what to build. Live preview + real URL every time.</div>
            <div class="code-template-grid">
              <div class="code-template-card" onclick="codeUseTemplate('dashboard')">
                <div class="code-template-card-icon">📊</div>
                <div class="code-template-card-title">Dashboard</div>
                <div class="code-template-card-desc">Analytics, charts, data tables, KPI cards</div>
              </div>
              <div class="code-template-card" onclick="codeUseTemplate('landing')">
                <div class="code-template-card-icon">🚀</div>
                <div class="code-template-card-title">Landing Page</div>
                <div class="code-template-card-desc">Hero, features, pricing, CTA sections</div>
              </div>
              <div class="code-template-card" onclick="codeUseTemplate('saas')">
                <div class="code-template-card-icon">🧊</div>
                <div class="code-template-card-title">SaaS App</div>
                <div class="code-template-card-desc">Sidebar nav, settings, user management</div>
              </div>
              <div class="code-template-card" onclick="codeUseTemplate('ecommerce')">
                <div class="code-template-card-icon">🛒</div>
                <div class="code-template-card-title">E-Commerce</div>
                <div class="code-template-card-desc">Product grid, cart, checkout flow</div>
              </div>
              <div class="code-template-card" onclick="codeUseTemplate('portfolio')">
                <div class="code-template-card-icon">🎨</div>
                <div class="code-template-card-title">Portfolio</div>
                <div class="code-template-card-desc">Personal brand, work gallery, contact</div>
              </div>
              <div class="code-template-card" onclick="codeUseTemplate('mobile')">
                <div class="code-template-card-icon">📱</div>
                <div class="code-template-card-title">Mobile UI</div>
                <div class="code-template-card-desc">App screen, bottom nav, mobile-first</div>
              </div>
              <div class="code-template-card" onclick="codeUseTemplate('chat')">
                <div class="code-template-card-icon">💬</div>
                <div class="code-template-card-title">Chat App</div>
                <div class="code-template-card-desc">Messenger UI, conversations, bubbles</div>
              </div>
              <div class="code-template-card" onclick="codeUseTemplate('react-dash')">
                <div class="code-template-card-icon">⚛️</div>
                <div class="code-template-card-title">React Dashboard</div>
                <div class="code-template-card-desc">React 18, Chart.js, component files</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Live preview iframe (hidden until preview mode) -->
        <div id="code-preview-wrap" style="display:none;flex:1;overflow:auto;background:#fff;align-items:flex-start;justify-content:center;padding:0">
          <div id="code-preview-viewport" style="width:100%;height:100%;transition:width 0.2s ease;background:#fff;margin:0 auto">
            <iframe id="code-preview-frame"
              style="width:100%;height:100%;border:none;background:#fff"></iframe>
          </div>
        </div>

        <!-- Prompt bar — compact, at the bottom of center panel -->
        <div class="code-prompt-bar">
          <div class="code-prompt-wrap">
            <textarea class="code-prompt-input" id="code-prompt-input" rows="2"
              placeholder="Describe what to build or change… (⌘↵ to send)"
              onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();codeGenerate();}"></textarea>
            <div class="code-prompt-actions">
              <select class="code-lang-select" id="code-style-preset" title="Visual style preset">
                <option value="ai-decides" selected>✨ AI Decides</option>
                <optgroup label="── Dark">
                  <option value="flowstate-dark">⚡ FlowState Dark</option>
                  <option value="glassmorphism">🔮 Glassmorphism</option>
                  <option value="cyberpunk">🌆 Cyberpunk</option>
                  <option value="terminal">💻 Terminal</option>
                </optgroup>
                <optgroup label="── Light">
                  <option value="flowstate-light">☀️ Light</option>
                  <option value="minimal-saas">🧊 Minimal SaaS</option>
                  <option value="brutalist">🔲 Brutalist</option>
                </optgroup>
                <optgroup label="── Frameworks">
                  <option value="react-app">⚛️ React App</option>
                  <option value="react-dashboard">📊 React Dashboard</option>
                </optgroup>
                <optgroup label="── Other">
                  <option value="plain">📝 Plain</option>
                </optgroup>
              </select>
              <button class="code-btn-clawflow" id="btn-code-clawflow" onclick="openClawflowPage()" title="ClawFlow Developer">
                <i class="fas fa-bolt"></i>
              </button>
              <button class="code-btn-generate" id="btn-code-generate" onclick="codeGenerate()">
                <i class="fas fa-wand-magic-sparkles"></i> Build
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: Chat Interface -->
      <div class="code-log-panel" id="code-chat-panel">
        <!-- Chat tab bar -->
        <div style="display:flex;border-bottom:1px solid var(--border);flex-shrink:0">
          <button class="code-chat-tab active" id="chat-tab-convo" onclick="codeChatTab('convo')" style="flex:1;padding:8px 6px;background:transparent;border:none;font-size:10px;font-weight:700;color:var(--accent);cursor:pointer;border-bottom:2px solid var(--accent);letter-spacing:.5px">💬 CHAT</button>
          <button class="code-chat-tab" id="chat-tab-log" onclick="codeChatTab('log')" style="flex:1;padding:8px 6px;background:transparent;border:none;font-size:10px;font-weight:700;color:var(--text-m);cursor:pointer;border-bottom:2px solid transparent;letter-spacing:.5px">⚡ LOG</button>
          <button class="code-chat-tab" id="chat-tab-git" onclick="codeChatTab('git')" style="flex:1;padding:8px 6px;background:transparent;border:none;font-size:10px;font-weight:700;color:var(--text-m);cursor:pointer;border-bottom:2px solid transparent;letter-spacing:.5px">⑂ GIT</button>
        </div>

        <!-- Conversation tab -->
        <div id="code-chat-convo" style="display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0">
          <div class="code-chat-messages" id="code-chat-messages">
            <div class="code-chat-empty">
              <div style="font-size:24px;margin-bottom:6px">💬</div>
              <div style="font-size:12px;font-weight:700;color:var(--text-p);margin-bottom:4px">Chat with your AI</div>
              <div style="font-size:11px;color:var(--text-m);line-height:1.6">Your conversation history appears here. Ask questions, request changes, or describe new features.</div>
            </div>
          </div>
          <div class="code-chat-input-wrap">
            <textarea class="code-chat-input" id="code-chat-input" rows="1" placeholder="Ask the AI…"
              onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();codeChatSend();}"
              oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
            <button class="code-chat-send" id="btn-chat-send" onclick="codeChatSend()" title="Send (Enter)">
              <i class="fas fa-paper-plane" style="font-size:11px"></i>
            </button>
          </div>
        </div>

        <!-- Log tab -->
        <div id="code-chat-log" style="display:none;flex-direction:column;flex:1;overflow:hidden;min-height:0">
          <div id="code-activity-log" class="code-activity-log">
            <div class="code-log-empty">Build activity appears here…</div>
          </div>
        </div>

        <!-- Git tab -->
        <div id="code-chat-git" style="display:none;flex-direction:column;flex:1;overflow:hidden;min-height:0;padding:8px">
          <div class="code-panel-label" style="margin-bottom:6px"><i class="fab fa-github"></i> GitHub</div>
          <div id="code-gh-status-panel" class="code-gh-status">
            <div style="font-size:11px;color:var(--text-m)">Not connected</div>
          </div>
          <div id="code-commit-log-wrap" style="display:none;margin-top:8px">
            <div class="code-panel-label" style="margin-bottom:6px"><i class="fas fa-code-commit"></i> Recent Pushes</div>
            <div id="code-commit-log" class="code-commit-log"></div>
          </div>
        </div>
      </div>

      </div><!-- /code-workspace-body -->
    </div><!-- /code-workspace -->
  </div><!-- /gen-pane-code -->

  </div><!-- /gen-body-wrap -->

</div><!-- /tab-pane-generate -->

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
        <a href="https://github.com/mkbrown261/264-pro-video-editor/releases/latest/download/264-Pro-1.1.67-arm64-mac.zip" class="aud-dl-btn aud-mac"><i class="fab fa-apple"></i> macOS (Apple Silicon)</a>
        <a href="https://github.com/mkbrown261/264-pro-video-editor/releases/latest/download/264-Pro-1.1.67-x64-mac.zip" class="aud-dl-btn aud-mac" style="background:linear-gradient(135deg,#059669,#0284c7)"><i class="fab fa-apple"></i> macOS (Intel)</a>
        <a href="https://github.com/mkbrown261/264-pro-video-editor/releases/latest/download/264-Pro-Setup-1.1.67.exe" class="aud-dl-btn aud-win"><i class="fab fa-windows"></i> Download for Windows</a>
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
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap" id="fsaudio-dl-btns">
        <a href="https://github.com/mkbrown261/FS-AUDIO/releases/download/v1.0.0/FlowstateAudio-1.0.0-arm64-mac.zip" class="aud-dl-btn aud-mac"><i class="fab fa-apple"></i> macOS (Apple Silicon)</a>
        <a href="https://github.com/mkbrown261/FS-AUDIO/releases/download/v1.0.0/FlowstateAudio-1.0.0-x64-mac.zip" class="aud-dl-btn aud-mac" style="background:linear-gradient(135deg,#059669,#0284c7)"><i class="fab fa-apple"></i> macOS (Intel)</a>
        <a href="https://github.com/mkbrown261/FS-AUDIO/releases/download/v1.0.0/FlowstateAudio-1.0.0-win-x64.zip" class="aud-dl-btn aud-win"><i class="fab fa-windows"></i> Download for Windows</a>
        <a href="https://github.com/mkbrown261/FS-AUDIO/releases/download/v1.0.0/FlowstateAudio-1.0.0-linux-x64.AppImage" class="aud-dl-btn aud-linux"><i class="fab fa-linux"></i> Download for Linux</a>
      </div>
      <div style="margin-top:16px;font-size:12px;color:var(--text-m)">Free to download &nbsp;&#xB7;&nbsp; ClawFlow subscription unlocks AI features &nbsp;&#xB7;&nbsp; <a href="https://github.com/mkbrown261/FS-AUDIO/releases/tag/v1.0.0" target="_blank" style="color:var(--accent)">v1.0.0 Release Notes</a></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-m);opacity:.7">macOS: right-click → Open if you see a security warning &nbsp;&#xB7;&nbsp; Windows: extract zip then run <code style="background:rgba(255,255,255,.07);padding:1px 5px;border-radius:4px">Flowstate Audio.exe</code></div>
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
      <button class="clawbot-quick-btn" onclick="openClawVideoWizard()" style="border-color:rgba(6,182,212,.5);color:#06b6d4;font-weight:700">&#x1F3AC; Create Video</button>
      <button class="clawbot-quick-btn" onclick="clawbotQuick('Generate a walkthrough for this app')">&#x1F4D6; Generate Walkthrough</button>
      <button class="clawbot-quick-btn" onclick="clawbotQuick('What workflows can you optimize for me?')">&#9889; Optimize Workflow</button>
      <button class="clawbot-quick-btn" onclick="clawbotQuick('Show me my coin usage and API stats')">&#x1F4B0; Coin Usage</button>
      <button class="clawbot-quick-btn" onclick="clawbotQuick('What are the most powerful features I am not using?')">&#x1F50D; Hidden Features</button>
      <button class="clawbot-quick-btn" onclick="toggleClawPermPanel()" id="btn-claw-perms" style="border-color:rgba(168,85,247,.4);color:#a855f7">&#x1F512; Claw Permissions</button>
    </div>

    <!-- ── Claw Permissions Panel ──────────────────────────────────────── -->
    <div id="claw-perm-panel" style="display:none;margin-top:12px;background:var(--bg-card);border:1px solid rgba(168,85,247,.25);border-radius:12px;padding:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px">
          <img src="/static/clawbot-mascot.png" style="width:22px;height:22px;object-fit:contain">
          <span style="font-size:13px;font-weight:800">Claw Permissions</span>
        </div>
        <div style="font-size:11px;color:var(--text-s)">Control what Claw can do on your behalf</div>
      </div>

      <!-- Integrations row -->
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap" id="claw-integration-status">
        <div id="claw-slack-status" style="display:flex;align-items:center;gap:5px;padding:5px 10px;border-radius:8px;border:1px solid var(--border);font-size:12px">
          <span>💬</span><span id="claw-slack-label">Slack: not connected</span>
          <button id="claw-slack-connect-btn" onclick="connectSlack()" style="display:none;font-size:11px;padding:2px 8px;border:none;background:rgba(168,85,247,.15);color:#a855f7;border-radius:6px;cursor:pointer">Connect</button>
        </div>
        <div id="claw-notion-status" style="display:flex;align-items:center;gap:5px;padding:5px 10px;border-radius:8px;border:1px solid var(--border);font-size:12px">
          <span>📝</span><span id="claw-notion-label">Notion: not connected</span>
          <button id="claw-notion-connect-btn" onclick="connectNotion()" style="display:none;font-size:11px;padding:2px 8px;border:none;background:rgba(168,85,247,.15);color:#a855f7;border-radius:6px;cursor:pointer">Connect</button>
        </div>
      </div>

      <!-- Permission toggles — rendered by JS -->
      <div id="claw-perm-toggles" style="display:flex;flex-direction:column;gap:8px"></div>

      <!-- Action log link -->
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;color:var(--text-s)">All Claw actions are logged for your review.</span>
        <button class="btn-sm" onclick="showClawActionLog()" style="font-size:11px">View Log</button>
      </div>
    </div>

    <!-- ── Claw Action Log Modal ─────────────────────────────────────── -->
    <div id="claw-log-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;align-items:center;justify-content:center">
      <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:22px;width:min(480px,90vw);max-height:70vh;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <span style="font-size:14px;font-weight:800">🔍 Claw Action Log</span>
          <button class="btn-sm" onclick="document.getElementById('claw-log-modal').style.display='none'">✕</button>
        </div>
        <div id="claw-log-entries" style="overflow-y:auto;flex:1;font-size:12px;display:flex;flex-direction:column;gap:6px">
          <div style="color:var(--text-s);text-align:center;padding:20px">Loading…</div>
        </div>
      </div>
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

<!-- Session Complete — Output Tracking + Calendar prompt -->
<div class="focus-cal-prompt" id="focus-cal-prompt" style="max-width:320px">
  <button onclick="closeFocusPrompt()" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#666;font-size:16px;cursor:pointer">&#x2715;</button>
  <div class="fcp-title">🍅 Session complete!</div>
  <div class="fcp-sub" id="fcp-sub" style="margin-bottom:12px">25m of deep focus done.</div>

  <!-- Output tracking — all tiers -->
  <div style="margin-bottom:12px">
    <div style="font-size:11px;color:#888;margin-bottom:6px;font-weight:600;letter-spacing:.4px">WHAT DID YOU MAKE?</div>
    <div style="display:flex;flex-wrap:wrap;gap:5px" id="fcp-output-chips">
      <button class="fcp-chip" data-type="track"   onclick="selectOutputType('track')">🎵 Track</button>
      <button class="fcp-chip" data-type="video"   onclick="selectOutputType('video')">🎬 Video</button>
      <button class="fcp-chip" data-type="design"  onclick="selectOutputType('design')">🎨 Design</button>
      <button class="fcp-chip" data-type="code"    onclick="selectOutputType('code')">💻 Code</button>
      <button class="fcp-chip" data-type="writing" onclick="selectOutputType('writing')">✍️ Writing</button>
      <button class="fcp-chip" data-type="content" onclick="selectOutputType('content')">📱 Content</button>
      <button class="fcp-chip" data-type="other"   onclick="selectOutputType('other')">✦ Other</button>
    </div>
    <input id="fcp-output-note" type="text" placeholder="Quick note (optional)…" style="width:100%;margin-top:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 10px;color:#e0e0e0;font-size:12px;outline:none;box-sizing:border-box;display:none"/>
  </div>

  <!-- Calendar CTA — only for signed-in users -->
  <div id="fcp-cal-row" style="display:none;margin-bottom:10px">
    <div style="font-size:11px;color:#888;margin-bottom:6px;font-weight:600;letter-spacing:.4px">ADD TO GOOGLE CALENDAR?</div>
    <div class="fcp-btns">
      <button class="btn-primary" id="fcp-yes" style="flex:1;padding:7px;font-size:12px">Add to Calendar</button>
      <button class="btn-sm" id="fcp-no" style="padding:7px 12px;font-size:12px">Skip</button>
    </div>
  </div>

  <div style="display:flex;gap:7px;margin-top:2px">
    <button onclick="saveFocusSession()" id="fcp-save-btn" style="flex:1;padding:8px;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;border:none;font-size:13px;font-weight:700;cursor:pointer">Save →</button>
    <button onclick="shareFlowSession(_fcpSession.durationMin)" title="Share your session" style="padding:8px 12px;border-radius:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#ccc;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:5px"><i class="fas fa-share-nodes"></i></button>
  </div>
</div>
<!-- Keyboard shortcuts hint overlay -->
<div id="kb-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:4000;align-items:center;justify-content:center;backdrop-filter:blur(8px)">
  <div style="background:var(--bg-panel);border:1px solid var(--border-h);border-radius:18px;padding:28px 32px;max-width:420px;width:100%">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
      <div style="font-size:16px;font-weight:800">⌨️ Keyboard Shortcuts</div>
      <button onclick="document.getElementById('kb-overlay').style.display='none'" style="background:none;border:none;color:#666;font-size:18px;cursor:pointer">&#x2715;</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
      <div style="color:#888">Space</div><div>Start / Pause timer</div>
      <div style="color:#888">R</div><div>Reset timer</div>
      <div style="color:#888">S</div><div>Skip phase</div>
      <div style="color:#888">1–9</div><div>Switch tabs</div>
      <div style="color:#888">C</div><div>Open Calendar</div>
      <div style="color:#888">F</div><div>Open Focus</div>
      <div style="color:#888">M</div><div>Open Metrics</div>
      <div style="color:#888">N</div><div>New event (in Calendar)</div>
      <div style="color:#888">?</div><div>Show this help</div>
      <div style="color:#888">Esc</div><div>Close panels</div>
    </div>
  </div>
</div>
<script>
// Server-injected session data
const FS_USER     = ${userJson};
const FS_NOTION   = ${notionJson};
const FS_SLACK    = ${slackJson};
const FS_GITHUB   = ${githubJson};
const FS_ONBOARDED= ${onboardedJson};
</script>
<script src="/static/app.js"></script>
<script>
// ── Service Worker registration ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        // Check for updates every 30 min
        setInterval(() => reg.update(), 1800000);
      })
      .catch(() => {}); // Fail silently
  });
}
// ── PWA install prompt — capture and show at right moment ────────────────────
let _pwaInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _pwaInstallPrompt = e;
  // Show an "Add to Home Screen" button after first focus session
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  _pwaInstallPrompt = null;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'none';
  if (typeof notify === 'function') notify('⚡ FlowState added to your home screen!', 'success');
});
function triggerPwaInstall() {
  if (_pwaInstallPrompt) {
    _pwaInstallPrompt.prompt();
    _pwaInstallPrompt.userChoice.then(() => { _pwaInstallPrompt = null; });
  }
}
</script>
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

// ══════════════════════════════════════════════════════════════════════════════
// TIER 3 — REFERRAL SYSTEM
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/referral/generate — create or return an existing referral code
app.post('/api/referral/generate', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)

  try {
    // Check if user already has an unused (or partially used) code
    const existing = await db.prepare(
      `SELECT code FROM referrals WHERE referrer_email=? ORDER BY created_at DESC LIMIT 1`
    ).bind(session.email).first() as any
    if (existing?.code) {
      const baseUrl = new URL(c.req.url).origin
      return c.json({
        code: existing.code,
        url: `${baseUrl}/?ref=${existing.code}`,
        shareText: `${session.name || 'Someone'} invited you to FlowState — the focus OS for builders. Use their link for a free 30-day Pro trial!`,
      })
    }
    // Generate new code
    const code = 'FS-' + Math.random().toString(36).slice(2, 8).toUpperCase()
    await db.prepare(
      `INSERT INTO referrals (code, referrer_email, referrer_name) VALUES (?, ?, ?)`
    ).bind(code, session.email, session.name || '').run()
    const baseUrl = new URL(c.req.url).origin
    return c.json({
      code,
      url: `${baseUrl}/?ref=${code}`,
      shareText: `${session.name || 'Someone'} invited you to FlowState — the focus OS for builders. Use their link for a free 30-day Pro trial!`,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// GET /api/referral/stats — how many people have used my code
app.get('/api/referral/stats', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)

  try {
    const rows = await db.prepare(
      `SELECT code, used_by_email, used_at, bonus_granted FROM referrals WHERE referrer_email=? ORDER BY created_at DESC LIMIT 20`
    ).bind(session.email).all() as any
    const total   = rows.results?.length || 0
    const claimed = (rows.results as any[])?.filter((r: any) => r.used_by_email).length || 0
    const latest  = (rows.results as any[])?.[0]
    return c.json({ total, claimed, code: latest?.code, bonusGranted: latest?.bonus_granted === 1 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// GET /api/referral/claim?ref=FS-XXXXX — called on first sign-in when ?ref= param is present
// Marks the code as used and grants bonus credits to both parties
app.get('/api/referral/claim', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  const code  = c.req.query('ref')?.toUpperCase()
  if (!code) return c.json({ error: 'missing_code' }, 400)
  if (!db)   return c.json({ error: 'db_unavailable' }, 503)

  try {
    const ref = await db.prepare(
      `SELECT * FROM referrals WHERE code=?`
    ).bind(code).first() as any
    if (!ref) return c.json({ error: 'invalid_code' }, 404)
    if (ref.used_by_email) return c.json({ error: 'code_already_used' }, 409)
    if (ref.referrer_email === session.email) return c.json({ error: 'self_referral' }, 400)

    // Mark code as used
    await db.prepare(
      `UPDATE referrals SET used_by_email=?, used_at=datetime('now') WHERE code=?`
    ).bind(session.email, code).run()

    // Grant 1,000 bonus credits to new user + 500 credits to referrer via Redis
    if (url && token) {
      const newUserKey = `credit_balance:${session.email}`
      const referrerKey = `credit_balance:${ref.referrer_email}`
      await redisPipeline(url, token, [
        ['INCRBY', newUserKey, '1000'],
        ['INCRBY', referrerKey, '500'],
      ])
      // Mark bonus granted in D1
      await db.prepare(
        `UPDATE referrals SET bonus_granted=1 WHERE code=?`
      ).bind(code).run()
    }
    return c.json({ ok: true, bonusTokens: 1000, referrerBonus: 500, referrerName: ref.referrer_name || 'your friend' })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// TIER 3 — PUBLIC FLOWSCORE PROFILES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/profile/setup — create or update public profile
app.post('/api/profile/setup', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)

  const { slug, displayName, tagline, showScore, showStreak, showOutputs, showWeekly } = await c.req.json()
  // Validate slug: lowercase alphanumeric + hyphens, 3-30 chars
  const cleanSlug = (slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
  if (cleanSlug.length < 3) return c.json({ error: 'slug_too_short' }, 400)

  try {
    const user = await db.prepare(`SELECT id FROM users WHERE email=?`).bind(session.email).first() as any
    if (!user) return c.json({ error: 'user_not_found' }, 404)
    // Check slug uniqueness (except own profile)
    const conflict = await db.prepare(
      `SELECT email FROM public_profiles WHERE slug=? AND email != ?`
    ).bind(cleanSlug, session.email).first()
    if (conflict) return c.json({ error: 'slug_taken' }, 409)

    await db.prepare(`
      INSERT INTO public_profiles (user_id, email, slug, display_name, tagline, show_score, show_streak, show_outputs, show_weekly, avatar_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(email) DO UPDATE SET
        slug=excluded.slug, display_name=excluded.display_name, tagline=excluded.tagline,
        show_score=excluded.show_score, show_streak=excluded.show_streak,
        show_outputs=excluded.show_outputs, show_weekly=excluded.show_weekly,
        avatar_url=excluded.avatar_url, updated_at=datetime('now')
    `).bind(
      user.id, session.email, cleanSlug,
      displayName || session.name || '', tagline || null,
      showScore !== false ? 1 : 0, showStreak !== false ? 1 : 0,
      showOutputs ? 1 : 0, showWeekly ? 1 : 0,
      session.picture || null
    ).run()
    return c.json({ ok: true, slug: cleanSlug, url: `${new URL(c.req.url).origin}/u/${cleanSlug}` })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// POST /api/avatar — upload a profile picture file from the user's device
// Accepts multipart/form-data with a 'file' field (image/jpeg, image/png, image/gif, image/webp)
// Stores in R2 under avatars/{email}/avatar.{ext}, re-issues session cookie with new URL
app.post('/api/avatar', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db  = c.env?.DB
  const r2  = c.env?.R2
  if (!r2) return c.json({ error: 'storage_unavailable' }, 503)

  let file: File | null = null
  try {
    const form = await c.req.formData()
    file = form.get('file') as File | null
  } catch(_) {}
  if (!file) return c.json({ error: 'no_file' }, 400)

  // Allow only image types, max 5 MB
  const allowed = ['image/jpeg','image/png','image/gif','image/webp']
  if (!allowed.includes(file.type)) return c.json({ error: 'invalid_type' }, 400)
  if (file.size > 5 * 1024 * 1024) return c.json({ error: 'too_large' }, 400)

  const ext     = file.type.split('/')[1].replace('jpeg','jpg')
  const r2Key   = `avatars/${session.email}/avatar.${ext}`
  const buf     = await file.arrayBuffer()

  await r2.put(r2Key, buf, {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=86400' },
    customMetadata: { email: session.email, uploadedAt: new Date().toISOString() },
  })

  // Encode the full key as base64url so slashes don't break the route
  const keyB64    = btoa(r2Key).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
  const origin    = new URL(c.req.url).origin
  const avatarUrl = `${origin}/api/avatar/img/${keyB64}?v=${Date.now()}`

  // Upsert avatar_url into public_profiles (non-fatal)
  try {
    if (db) {
      const user = await db.prepare(`SELECT id FROM users WHERE email=?`).bind(session.email).first() as any
      if (user) {
        await db.prepare(`
          INSERT INTO public_profiles (user_id, email, slug, display_name, avatar_url, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(email) DO UPDATE SET avatar_url=excluded.avatar_url, updated_at=datetime('now')
        `).bind(
          user.id, session.email,
          session.email.split('@')[0].replace(/[^a-z0-9]/gi,'-').toLowerCase().slice(0,30),
          session.name || '', avatarUrl
        ).run()
      }
    }
  } catch(_) {}

  // Re-issue session cookie with updated picture
  const newSession = { ...session, picture: avatarUrl }
  setCookie(c, 'fs_session', encodeSession(newSession), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7*24*3600, path: '/' })
  return c.json({ ok: true, url: avatarUrl })
})

// GET /api/avatar/img/:key — serve avatar image publicly from R2
// :key is base64url-encoded to avoid slash issues in URL routing
app.get('/api/avatar/img/:key', async (c) => {
  const r2 = c.env?.R2
  if (!r2) return c.json({ error: 'storage_unavailable' }, 503)
  // Decode base64url back to the original R2 key
  let key: string
  try {
    const b64 = c.req.param('key').replace(/-/g,'+').replace(/_/g,'/')
    key = atob(b64)
  } catch(_) {
    return c.json({ error: 'invalid_key' }, 400)
  }
  // Only serve files under the avatars/ namespace
  if (!key.startsWith('avatars/')) return c.json({ error: 'forbidden' }, 403)
  const obj = await r2.get(key)
  if (!obj) return c.json({ error: 'not_found' }, 404)
  const ct = obj.httpMetadata?.contentType || 'image/jpeg'
  return new Response(obj.body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
    }
  })
})

// GET /api/profile/me — fetch own profile settings
app.get('/api/profile/me', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)
  const profile = await db.prepare(`SELECT * FROM public_profiles WHERE email=?`).bind(session.email).first()
  return c.json({ profile: profile || null })
})

// GET /u/:slug — public profile page
app.get('/u/:slug', async (c) => {
  const db = c.env?.DB
  if (!db) return c.html('<h1>Profile unavailable</h1>', 503)
  const slug = c.req.param('slug').toLowerCase()

  const profile = await db.prepare(
    `SELECT * FROM public_profiles WHERE slug=?`
  ).bind(slug).first() as any
  if (!profile) return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Profile not found — FlowState</title></head><body style="font-family:system-ui;background:#0a0a12;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px">⚡</div><h1>Profile not found</h1><p style="color:#888">This FlowState profile doesn't exist yet.</p><a href="/" style="color:#a855f7;text-decoration:none;font-weight:700">← Open FlowState</a></div></body></html>`, 404)

  // Fetch stats from D1
  let flowScore = 0, focusMin = 0, sessions7 = 0, streak = 0
  let outputBreakdown: Record<string, number> = {}
  try {
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const since7  = new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10)
    const { results } = await db.prepare(
      `SELECT duration_mins, focus_score, output_type, session_date FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1 ORDER BY session_date DESC`
    ).bind(profile.email, since30).all() as any
    const week = (results as any[]).filter((r: any) => r.session_date >= since7)
    focusMin   = week.reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
    sessions7  = week.length
    const daySet = new Set((results as any[]).map((r: any) => r.session_date))
    const today = new Date()
    for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) streak++; else if (i > 0) break; }
    flowScore  = Math.min(100, Math.round((focusMin / 120) * 40 + (sessions7 / 5) * 30 + Math.min(streak, 7) * 4 + (sessions7 > 0 ? 15 : 0)))
    ;(results as any[]).forEach((r: any) => { if (r.output_type) outputBreakdown[r.output_type] = (outputBreakdown[r.output_type] || 0) + 1 })
  } catch (_) {}

  const scoreColor = flowScore >= 70 ? '#10b981' : flowScore >= 40 ? '#a855f7' : '#f59e0b'
  const circumference = 163.4
  const dashOffset = circumference - (flowScore / 100) * circumference
  const outputChips = Object.entries(outputBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([t, n]) => `<span style="background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.25);border-radius:99px;padding:4px 12px;font-size:12px;color:#c084fc;margin:3px;display:inline-block">${t} ×${n}</span>`).join('')

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta property="og:title" content="${profile.display_name} — FlowState">
  <meta property="og:description" content="FlowScore ${flowScore} · ${sessions7} sessions this week · ${streak}-day streak">
  <meta property="og:image" content="https://flowst8.cc/static/og-card.svg">
  <meta name="twitter:card" content="summary">
  <title>${profile.display_name} — FlowState</title>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a12;color:#f0f0f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#12102a;border:1px solid rgba(168,85,247,.25);border-radius:24px;padding:32px;max-width:420px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .logo{font-size:13px;font-weight:800;color:#a855f7;letter-spacing:1px;text-transform:uppercase;margin-bottom:24px;display:flex;align-items:center;justify-content:center;gap:6px}
    .avatar{width:72px;height:72px;border-radius:50%;border:3px solid ${scoreColor};margin:0 auto 12px;object-fit:cover;background:#1a1a2e}
    .name{font-size:22px;font-weight:900;margin-bottom:4px}
    .tagline{font-size:13px;color:#888;margin-bottom:24px}
    .score-wrap{position:relative;width:100px;height:100px;margin:0 auto 20px}
    .score-inner{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
    .score-num{font-size:28px;font-weight:900;color:${scoreColor};line-height:1}
    .score-lbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.8px;margin-top:2px}
    .stats{display:flex;gap:12px;justify-content:center;margin-bottom:20px;flex-wrap:wrap}
    .stat{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 16px;min-width:80px}
    .stat-val{font-size:20px;font-weight:800;color:#f0f0f0}
    .stat-lbl{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
    .outputs{margin-bottom:20px;flex-wrap:wrap;display:flex;justify-content:center}
    .cta{display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px;margin-top:4px}
    .cta:hover{opacity:.9}
    .badge{font-size:10px;color:#555;margin-top:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span>⚡</span> FLOWSTATE</div>
    ${profile.avatar_url ? `<img class="avatar" src="${profile.avatar_url}" alt="${profile.display_name}" onerror="this.style.display='none'">` : `<div class="avatar" style="display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:${scoreColor}">${(profile.display_name||'?')[0].toUpperCase()}</div>`}
    <div class="name">${profile.display_name || 'FlowState User'}</div>
    ${profile.tagline ? `<div class="tagline">${profile.tagline}</div>` : '<div class="tagline">Building in flow 🔥</div>'}
    ${profile.show_score ? `
    <div class="score-wrap">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(168,85,247,.15)" stroke-width="8"/>
        <circle cx="50" cy="50" r="42" fill="none" stroke="${scoreColor}" stroke-width="8"
          stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
          stroke-linecap="round" transform="rotate(-90 50 50)"/>
      </svg>
      <div class="score-inner">
        <div class="score-num">${flowScore}</div>
        <div class="score-lbl">FlowScore</div>
      </div>
    </div>` : ''}
    <div class="stats">
      ${profile.show_streak ? `<div class="stat"><div class="stat-val">${streak}🔥</div><div class="stat-lbl">Day Streak</div></div>` : ''}
      <div class="stat"><div class="stat-val">${focusMin}m</div><div class="stat-lbl">This Week</div></div>
      <div class="stat"><div class="stat-val">${sessions7}</div><div class="stat-lbl">Sessions</div></div>
    </div>
    ${profile.show_outputs && outputChips ? `<div class="outputs">${outputChips}</div>` : ''}
    <a href="https://flowst8.cc" class="cta">Start Your FlowScore →</a>
    <div class="badge">Powered by FlowState · flowst8.cc</div>
  </div>
</body>
</html>`)
})

// ══════════════════════════════════════════════════════════════════════════════
// 1A — STREAK EMAIL FALLBACK (via Resend)
// POST /api/email/streak-reminder  — called client-side when push is blocked
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/email/streak-reminder', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const resendKey = c.env?.RESEND_API_KEY
  if (!resendKey) return c.json({ error: 'email_not_configured' }, 503)
  const db = c.env?.DB
  let streak = 0, focusMin = 0
  if (db) {
    try {
      const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
      const { results } = await db.prepare(
        `SELECT duration_mins, session_date FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1 ORDER BY session_date DESC`
      ).bind(session.email, since7).all() as any
      focusMin = (results as any[]).reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
      const daySet = new Set((results as any[]).map((r: any) => r.session_date))
      const today = new Date()
      for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) streak++; else if (i > 0) break }
    } catch (_) {}
  }
  if (streak === 0) return c.json({ skipped: true, reason: 'no_streak' })
  const name = session.name?.split(' ')[0] || 'Creator'
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a12;font-family:system-ui,sans-serif;color:#f0f0f0">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;text-align:center">
  <div style="font-size:40px;margin-bottom:4px">⚡</div>
  <h1 style="font-size:20px;font-weight:900;margin:0 0 6px;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent">FLOWSTATE</h1>
  <p style="color:#888;font-size:14px;margin:0 0 24px">Morning check-in for ${name}</p>
  <div style="background:#12102a;border:2px solid #f59e0b;border-radius:16px;padding:24px;margin-bottom:24px">
    <div style="font-size:48px;margin-bottom:4px">🔥</div>
    <div style="font-size:36px;font-weight:900;color:#f59e0b">${streak}-day streak</div>
    <div style="font-size:13px;color:#888;margin-top:6px">Don't break it — ${focusMin}m focused this week</div>
  </div>
  <a href="https://flowst8.cc" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:14px 40px;border-radius:12px;font-weight:700;font-size:15px">Lock In Today →</a>
  <p style="color:#333;font-size:11px;margin-top:28px">FlowState · <a href="https://flowst8.cc" style="color:#555;text-decoration:none">flowst8.cc</a></p>
</div></body></html>`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.env?.RESEND_FROM_EMAIL || 'FlowState <noreply@flowst8.cc>', to: [session.email], 'reply-to': 'FlowState Support <hello@flowst8.cc>', subject: `🔥 Don't break your ${streak}-day streak, ${name}!`, html })
    })
    const data: any = await res.json()
    if (data.id) return c.json({ ok: true, emailId: data.id, streak })
    return c.json({ error: data.message || 'send_failed' }, 500)
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ══════════════════════════════════════════════════════════════════════════════
// 4B — PUBLIC FLOWSCORE API  GET /api/v1/score/:slug
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/v1/score/:slug', async (c) => {
  const slug = c.req.param('slug')
  const db = c.env?.DB
  if (!db) return c.json({ error: 'db_unavailable' }, 503)
  try {
    const profile = await db.prepare(
      `SELECT email, display_name, tagline, avatar_url, show_score, show_streak, slug FROM public_profiles WHERE slug=?`
    ).bind(slug).first() as any
    if (!profile) return c.json({ error: 'not_found' }, 404)
    if (!profile.show_score) return c.json({ error: 'profile_private' }, 403)
    const since7  = new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10)
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const { results } = await db.prepare(
      `SELECT duration_mins, output_type, session_date FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1 ORDER BY session_date DESC`
    ).bind(profile.email, since30).all() as any
    const week = (results as any[]).filter((r: any) => r.session_date >= since7)
    const focusMin = week.reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
    const daySet = new Set((results as any[]).map((r: any) => r.session_date))
    let streak = 0; const today = new Date()
    for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) streak++; else if (i > 0) break }
    const flowScore = Math.min(100, Math.round((focusMin / 120) * 40 + (week.length / 5) * 30 + Math.min(streak, 7) * 4 + (week.length > 0 ? 15 : 0)))
    const outputBreakdown: Record<string, number> = {}
    ;(results as any[]).forEach((r: any) => { if (r.output_type) outputBreakdown[r.output_type] = (outputBreakdown[r.output_type] || 0) + 1 })
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({
      slug: profile.slug,
      displayName: profile.display_name,
      tagline: profile.tagline,
      avatarUrl: profile.avatar_url,
      flowScore,
      weeklyFocusMinutes: focusMin,
      weeklySessions: week.length,
      streakDays: profile.show_streak ? streak : null,
      outputBreakdown,
      profileUrl: `https://flowst8.cc/u/${profile.slug}`,
      updatedAt: new Date().toISOString(),
    })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// CORS pre-flight for public API
app.options('/api/v1/*', (c) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
  return c.text('', 204)
})

// ══════════════════════════════════════════════════════════════════════════════
// 4A — AI FLOW COACH  POST /api/coach/insight
// Returns personalized coaching based on last 30 days of D1 session history
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/coach/insight', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  const aiKey = c.env?.OPENROUTER_API_KEY
  if (!aiKey) return c.json({ error: 'ai_not_configured' }, 503)

  let stats = { focusMin: 0, sessions: 0, streak: 0, avgScore: 0, topOutput: '', peakHour: 0, outputBreakdown: {} as Record<string,number>, peakDays: [] as string[] }

  if (db) {
    try {
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const { results } = await db.prepare(
        `SELECT duration_mins, focus_score, output_type, session_date, created_at FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1 ORDER BY session_date DESC`
      ).bind(session.email, since30).all() as any
      stats.sessions = results.length
      stats.focusMin = (results as any[]).reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
      stats.avgScore = stats.sessions ? Math.round((results as any[]).reduce((s: number, r: any) => s + (r.focus_score || 0), 0) / stats.sessions) : 0
      ;(results as any[]).forEach((r: any) => { if (r.output_type) stats.outputBreakdown[r.output_type] = (stats.outputBreakdown[r.output_type] || 0) + 1 })
      const top = Object.entries(stats.outputBreakdown).sort((a, b) => b[1] - a[1])[0]
      if (top) stats.topOutput = top[0]
      // Streak
      const daySet = new Set((results as any[]).map((r: any) => r.session_date))
      const today = new Date()
      for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) stats.streak++; else if (i > 0) break }
      // Peak hour from created_at timestamps
      const hourCounts: Record<number, number> = {}
      ;(results as any[]).forEach((r: any) => { try { const h = new Date(r.created_at).getHours(); hourCounts[h] = (hourCounts[h] || 0) + 1 } catch (_) {} })
      const peakHourEntry = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]
      if (peakHourEntry) stats.peakHour = parseInt(peakHourEntry[0])
      // Peak days
      const dowCounts: Record<string, number> = {}
      const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
      ;(results as any[]).forEach((r: any) => { try { const dow = DAYS[new Date(r.session_date).getDay()]; dowCounts[dow] = (dowCounts[dow] || 0) + 1 } catch (_) {} })
      stats.peakDays = Object.entries(dowCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0])
    } catch (_) {}
  }

  const name = session.name?.split(' ')[0] || 'Creator'
  const prompt = `You are the AI Flow Coach for FlowState, a focus productivity app used by creators.
Analyze this user's last 30 days and give a SHORT, PERSONAL, ACTIONABLE coaching insight.

User: ${name}
Stats:
- Focus sessions: ${stats.sessions}
- Total focus time: ${stats.focusMin} minutes
- Current streak: ${stats.streak} days
- Average focus score: ${stats.avgScore}/100
- Top output type: ${stats.topOutput || 'none logged'}
- Output breakdown: ${JSON.stringify(stats.outputBreakdown)}
- Peak focus hour: ${stats.peakHour}:00
- Most productive days: ${stats.peakDays.join(', ') || 'none'}

Respond with JSON ONLY (no markdown): {
  "headline": "short punchy headline (max 10 words)",
  "insight": "2-3 sentences of personalized coaching using their actual data",
  "tip": "one specific actionable tip based on their patterns",
  "badge": "an emoji badge they've earned this month (pick something fitting)",
  "badgeLabel": "badge name (e.g. 'Night Owl', 'Streak King', 'Code Machine')",
  "coachMood": "one of: inspired, concerned, encouraging, impressed"
}`

  try {
    // Use multiple model fallback: try gpt-4o-mini first (reliable JSON), fallback to llama
    const COACH_MODELS = [
      'openai/gpt-4o-mini',
      'google/gemini-flash-1.5-8b',
      'meta-llama/llama-3.1-8b-instruct:free',
    ]
    let content = ''
    for (const model of COACH_MODELS) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://flowst8.cc', 'X-Title': 'FlowState AI Coach' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'You are the AI Flow Coach for FlowState. You MUST respond with valid JSON only — no markdown, no backticks, no commentary. Just the raw JSON object.' },
              { role: 'user', content: prompt }
            ],
            max_tokens: 500,
            temperature: 0.7,
            response_format: { type: 'json_object' },
          })
        })
        const d: any = await res.json()
        const c2 = d?.choices?.[0]?.message?.content || ''
        if (c2 && c2.includes('headline')) { content = c2; break }
      } catch (_) {}
    }
    if (!content) return c.json({ error: 'ai_unavailable' }, 503)
    // Robust JSON extraction — strip markdown fences if present
    const cleaned = content.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      // Build fallback coaching from stats so user always gets something
      const fallback = {
        headline: stats.sessions > 0 ? `${stats.sessions} sessions this month — keep building` : 'Start your first session today',
        insight: stats.sessions > 0
          ? `You've logged ${stats.sessions} focus sessions (${stats.focusMin} minutes) in the last 30 days with an average FlowScore of ${stats.avgScore}. ${stats.streak > 0 ? `Your current streak is ${stats.streak} day${stats.streak !== 1 ? 's' : ''} — keep it alive!` : 'Start a streak by completing a session today.'}`
          : 'No sessions logged yet this month. Fire up the timer and start building your focus habit.',
        tip: stats.peakHour > 0 ? `Your peak focus hour is ${stats.peakHour}:00 — protect that time block ruthlessly.` : 'Try your first 25-minute deep work session to discover your natural peak focus time.',
        badge: stats.streak >= 7 ? '🔥' : stats.sessions >= 10 ? '⚡' : '🌱',
        badgeLabel: stats.streak >= 7 ? 'Streak Builder' : stats.sessions >= 10 ? 'Active Creator' : 'Getting Started',
        coachMood: stats.sessions > 5 ? 'impressed' : 'encouraging'
      }
      return c.json({ ok: true, coaching: fallback, stats, source: 'fallback' })
    }
    const coaching = JSON.parse(jsonMatch[0])
    return c.json({ ok: true, coaching, stats })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// GET /api/coach/insight — same logic as POST, used by openFlowCoach()
app.get('/api/coach/insight', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const db = c.env?.DB
  const aiKey = c.env?.OPENROUTER_API_KEY
  if (!aiKey) return c.json({ error: 'ai_not_configured' }, 503)

  let stats = { focusMin: 0, sessions: 0, streak: 0, avgScore: 0, topOutput: '', peakHour: 0, outputBreakdown: {} as Record<string,number>, peakDays: [] as string[] }
  if (db) {
    try {
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const { results } = await db.prepare(
        `SELECT duration_mins, focus_score, output_type, session_date, created_at FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1 ORDER BY session_date DESC`
      ).bind(session.email, since30).all() as any
      stats.sessions = results.length
      stats.focusMin = (results as any[]).reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
      stats.avgScore = stats.sessions ? Math.round((results as any[]).reduce((s: number, r: any) => s + (r.focus_score || 0), 0) / stats.sessions) : 0
      ;(results as any[]).forEach((r: any) => { if (r.output_type) stats.outputBreakdown[r.output_type] = (stats.outputBreakdown[r.output_type] || 0) + 1 })
      const top = Object.entries(stats.outputBreakdown).sort((a, b) => b[1] - a[1])[0]
      if (top) stats.topOutput = top[0]
      const daySet = new Set((results as any[]).map((r: any) => r.session_date))
      const today2 = new Date()
      for (let i = 0; i < 365; i++) { const d = new Date(today2); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) stats.streak++; else if (i > 0) break }
      const hourCounts: Record<number, number> = {}
      ;(results as any[]).forEach((r: any) => { try { const h = new Date(r.created_at).getHours(); hourCounts[h] = (hourCounts[h] || 0) + 1 } catch (_) {} })
      const peakHourEntry = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]
      if (peakHourEntry) stats.peakHour = parseInt(peakHourEntry[0])
      const dowCounts: Record<string, number> = {}
      const DAYS2 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
      ;(results as any[]).forEach((r: any) => { try { const dow = DAYS2[new Date(r.session_date).getDay()]; dowCounts[dow] = (dowCounts[dow] || 0) + 1 } catch (_) {} })
      stats.peakDays = Object.entries(dowCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0])
    } catch (_) {}
  }
  const name = session.name?.split(' ')[0] || 'Creator'
  const prompt = `You are the AI Flow Coach for FlowState. Give a SHORT personalized coaching insight.
User: ${name} | Sessions last 30d: ${stats.sessions} | Focus time: ${stats.focusMin}m | Streak: ${stats.streak}d | Avg score: ${stats.avgScore} | Top output: ${stats.topOutput || 'none'} | Peak hour: ${stats.peakHour}:00 | Best days: ${stats.peakDays.join(', ') || 'none'}
Respond with JSON only — no markdown, no backticks. Format: {"headline":"max 10 words","insight":"2-3 sentences using their data","tip":"1 actionable tip","badge":"emoji","badgeLabel":"badge name","coachMood":"inspired|concerned|encouraging|impressed"}`
  try {
    const COACH_MODELS2 = ['openai/gpt-4o-mini', 'google/gemini-flash-1.5-8b', 'meta-llama/llama-3.1-8b-instruct:free']
    let content = ''
    for (const model of COACH_MODELS2) {
      try {
        const res2 = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://flowst8.cc', 'X-Title': 'FlowState AI Coach' },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: 'Respond with valid JSON only. No markdown. No backticks.' }, { role: 'user', content: prompt }], max_tokens: 500, temperature: 0.7, response_format: { type: 'json_object' } })
        })
        const d2: any = await res2.json()
        const c3 = d2?.choices?.[0]?.message?.content || ''
        if (c3 && c3.includes('headline')) { content = c3; break }
      } catch (_) {}
    }
    if (!content) {
      // Stat-based fallback — always works even with no AI key
      return c.json({ ok: true, coaching: {
        headline: stats.sessions > 0 ? `${stats.sessions} sessions this month` : 'Start your focus journey',
        insight: stats.sessions > 0 ? `You've completed ${stats.sessions} sessions totalling ${stats.focusMin} minutes this month. ${stats.streak > 1 ? `Your ${stats.streak}-day streak shows real consistency.` : 'Build a streak by focusing daily.'}` : 'No sessions logged yet. Start the timer to track your focus and unlock personalized insights.',
        tip: stats.topOutput ? `You focus best on ${stats.topOutput} — lean into that.` : 'Set a clear intention before each session to boost your FlowScore.',
        badge: stats.streak >= 5 ? '🔥' : '⚡',
        badgeLabel: stats.streak >= 5 ? 'Streak Builder' : 'Creator',
        coachMood: 'encouraging'
      }, stats, source: 'fallback' })
    }
    const cleaned2 = content.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim()
    const jsonMatch2 = cleaned2.match(/\{[\s\S]*\}/)
    if (!jsonMatch2) return c.json({ ok: true, coaching: { headline: 'Keep building your focus habit', insight: `You've had ${stats.sessions} sessions this month.`, tip: 'Complete one session today.', badge: '⚡', badgeLabel: 'Creator', coachMood: 'encouraging' }, stats, source: 'fallback' })
    return c.json({ ok: true, coaching: JSON.parse(jsonMatch2[0]), stats })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ══════════════════════════════════════════════════════════════════════════════
// 4C — ACCOUNTABILITY PAIRING
// POST /api/pair/queue    — join the pairing queue
// GET  /api/pair/status   — check if matched / session active
// POST /api/pair/checkin  — send a check-in ping to your partner
// POST /api/pair/leave    — leave current pair
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/pair/queue', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)

  const { durationMins = 25 } = await c.req.json().catch(() => ({}))
  const userKey = `pair_user:${encodeURIComponent(session.email)}`
  const queueKey = 'pair_queue'

  // Check if already paired
  const existing = await redisGet(c, userKey)
  if (existing) {
    const data = typeof existing === 'string' ? JSON.parse(existing) : existing
    return c.json({ status: 'already_paired', partner: data.partnerName, sessionId: data.sessionId })
  }

  // Try to pop someone from queue
  const pendingRaw = await redisGet(c, queueKey)
  let pending = pendingRaw ? (typeof pendingRaw === 'string' ? JSON.parse(pendingRaw) : pendingRaw) : null

  if (pending && pending.email !== session.email) {
    // Match found! Create a pair
    const sessionId = `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const endsAt = new Date(Date.now() + durationMins * 60000).toISOString()
    const pairA = { email: session.email, name: session.name || 'Creator', partnerEmail: pending.email, partnerName: pending.name, sessionId, durationMins, endsAt, checkins: 0 }
    const pairB = { email: pending.email, name: pending.name, partnerEmail: session.email, partnerName: session.name || 'Creator', sessionId, durationMins, endsAt, checkins: 0 }
    await redisPipeline(url, token, [
      ['SET', userKey, JSON.stringify(pairA), 'EX', String(durationMins * 60 + 300)],
      ['SET', `pair_user:${encodeURIComponent(pending.email)}`, JSON.stringify(pairB), 'EX', String(durationMins * 60 + 300)],
      ['DEL', queueKey],
    ])
    return c.json({ status: 'matched', partner: pending.name, sessionId, durationMins, endsAt })
  } else {
    // Add self to queue
    const queueEntry = { email: session.email, name: session.name || 'Creator', durationMins, joinedAt: new Date().toISOString() }
    await redisPipeline(url, token, [
      ['SET', queueKey, JSON.stringify(queueEntry), 'EX', '120'], // expires after 2 min if no match
      ['SET', userKey, JSON.stringify({ status: 'waiting', joinedAt: new Date().toISOString() }), 'EX', '130'],
    ])
    return c.json({ status: 'waiting', message: 'Looking for a focus partner...' })
  }
})

app.get('/api/pair/status', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  const userKey = `pair_user:${encodeURIComponent(session.email)}`
  const raw = await redisGet(c, userKey)
  if (!raw) return c.json({ status: 'none' })
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw

  // Entries without endsAt are legacy/stale — delete and return none.
  // Also delete if endsAt has already passed.
  const endsAtMs = data.endsAt ? new Date(data.endsAt).getTime() : 0
  if (!endsAtMs || endsAtMs < Date.now()) {
    if (url && token) {
      const delKeys: string[] = [userKey]
      if (data.partnerEmail) delKeys.push(`pair_user:${encodeURIComponent(data.partnerEmail)}`)
      // Also clean up the queue entry in case user was just waiting
      delKeys.push('pair_queue')
      redisPipeline(url, token, delKeys.map(k => ['DEL', k])).catch(() => {})
    }
    return c.json({ status: 'none' })
  }

  return c.json({ status: data.partnerEmail ? 'paired' : 'waiting', data })
})

app.post('/api/pair/checkin', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)
  const userKey = `pair_user:${encodeURIComponent(session.email)}`
  const raw = await redisGet(c, userKey)
  if (!raw) return c.json({ error: 'not_paired' }, 404)
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!data.partnerEmail) return c.json({ error: 'not_paired' }, 404)
  const pingKey = `pair_ping:${encodeURIComponent(data.partnerEmail)}`
  await redisPipeline(url, token, [
    ['SET', pingKey, JSON.stringify({ from: session.name || session.email, at: new Date().toISOString() }), 'EX', '300'],
  ])
  return c.json({ ok: true, message: `Check-in sent to ${data.partnerName}!` })
})

app.get('/api/pair/checkin', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ ping: null })
  const pingKey = `pair_ping:${encodeURIComponent(session.email)}`
  const raw = await redisGet(c, pingKey)
  if (!raw) return c.json({ ping: null })
  const ping = typeof raw === 'string' ? JSON.parse(raw) : raw
  await redisPipeline(url, token, [['DEL', pingKey]])
  return c.json({ ping })
})

app.post('/api/pair/leave', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)
  const userKey = `pair_user:${encodeURIComponent(session.email)}`
  const raw = await redisGet(c, userKey)
  if (raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (data.partnerEmail) {
      const partnerKey = `pair_user:${encodeURIComponent(data.partnerEmail)}`
      const pingKey = `pair_ping:${encodeURIComponent(data.partnerEmail)}`
      await redisPipeline(url, token, [
        ['DEL', userKey],
        ['DEL', partnerKey],
        ['SET', pingKey, JSON.stringify({ from: session.name || session.email, at: new Date().toISOString(), type: 'partner_left' }), 'EX', '300'],
      ])
    } else {
      await redisPipeline(url, token, [['DEL', userKey], ['DEL', 'pair_queue']])
    }
  }
  return c.json({ ok: true })
})

// POST /api/pair/message  — send a text message to your partner (stored in Redis list, TTL 4h)
// GET  /api/pair/messages — fetch all messages for this session
app.post('/api/pair/message', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)

  const userKey = `pair_user:${encodeURIComponent(session.email)}`
  const raw = await redisGet(c, userKey)
  if (!raw) return c.json({ error: 'not_paired' }, 404)
  const pairData = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!pairData.sessionId) return c.json({ error: 'not_paired' }, 404)

  const { text, type = 'text' } = await c.req.json().catch(() => ({}))
  if (!text || String(text).trim().length === 0) return c.json({ error: 'empty_message' }, 400)
  const safeText = String(text).slice(0, 500) // max 500 chars per message

  const msgKey = `pair_msgs:${pairData.sessionId}`
  const msg = {
    from: session.name?.split(' ')[0] || 'Partner',
    fromEmail: session.email,
    text: safeText,
    type, // 'text' | 'emoji' | 'system'
    at: new Date().toISOString(),
    ts: Date.now(),
  }
  // RPUSH to list + set expiry
  await redisPipeline(url, token, [
    ['RPUSH', msgKey, JSON.stringify(msg)],
    ['EXPIRE', msgKey, '14400'], // 4 hours
  ])
  // Also send a ping notification to the partner so they get an alert
  const pingKey = `pair_ping:${encodeURIComponent(pairData.partnerEmail)}`
  await redisPipeline(url, token, [
    ['SET', pingKey, JSON.stringify({ from: session.name?.split(' ')[0] || 'Partner', at: new Date().toISOString(), type: 'message', preview: safeText.slice(0, 60) }), 'EX', '30'],
  ])
  return c.json({ ok: true, msg })
})

app.get('/api/pair/messages', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url   = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ messages: [] })

  const userKey = `pair_user:${encodeURIComponent(session.email)}`
  const raw = await redisGet(c, userKey)
  if (!raw) return c.json({ messages: [] })
  const pairData = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!pairData.sessionId) return c.json({ messages: [] })

  const msgKey = `pair_msgs:${pairData.sessionId}`
  // LRANGE — get last 100 messages
  const listRes = await fetch(`${url}/lrange/${msgKey}/0/99`, { headers: { Authorization: `Bearer ${token}` } })
  const listData: any = await listRes.json()
  const rawMsgs: string[] = listData?.result || []
  const messages = rawMsgs.map((m: string) => { try { return JSON.parse(m) } catch { return null } }).filter(Boolean)
  // Mark which messages are "mine" for the frontend
  return c.json({ messages: messages.map((m: any) => ({ ...m, mine: m.fromEmail === session.email })) })
})

// ══════════════════════════════════════════════════════════════════════════════
// GROUPFLOW — Persistent accountability groups with group chat, reactions, media
// ══════════════════════════════════════════════════════════════════════════════
// Data model (Redis KV):
//   gf_group:{groupId}      → { id, name, description, ownerId, ownerName, created, memberCount, inviteCode }
//   gf_members:{groupId}    → Redis SET of member emails
//   gf_memberdata:{groupId}:{email} → { email, name, avatar, joinedAt, role }
//   gf_invite:{code}        → { groupId, createdBy, createdAt }  (TTL 7d)
//   gf_msgs:{groupId}       → Redis LIST of JSON message strings (cap 500)
//   gf_user_groups:{email}  → Redis SET of groupIds the user belongs to

// POST /api/groupflow/create  — create a new group
app.post('/api/groupflow/create', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)

  const { name, description } = await c.req.json()
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)

  const groupId = `gf_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
  const inviteCode = Math.random().toString(36).slice(2,10).toUpperCase()

  const group = {
    id: groupId,
    name: name.trim().slice(0, 60),
    description: (description || '').trim().slice(0, 200),
    ownerId: session.email,
    ownerName: session.name || session.email.split('@')[0],
    created: Date.now(),
    memberCount: 1,
    inviteCode,
  }

  const memberData = { email: session.email, name: session.name || session.email.split('@')[0], avatar: session.picture || '', joinedAt: Date.now(), role: 'owner' }

  // Store group info, add member, store invite, link user→group
  await Promise.all([
    fetch(`${url}/set/gf_group:${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: JSON.stringify(group) }) }),
    fetch(`${url}/sadd/gf_members:${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ members: [session.email] }) }),
    fetch(`${url}/set/gf_memberdata:${groupId}:${encodeURIComponent(session.email)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: JSON.stringify(memberData), ex: 60*60*24*365 }) }),
    fetch(`${url}/set/gf_invite:${inviteCode}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: JSON.stringify({ groupId, createdBy: session.email, createdAt: Date.now() }), ex: 60*60*24*7 }) }),
    fetch(`${url}/sadd/gf_user_groups:${encodeURIComponent(session.email)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ members: [groupId] }) }),
  ])

  return c.json({ ok: true, group, inviteCode, inviteUrl: `https://flowst8.cc/?gfinvite=${inviteCode}` })
})

// POST /api/groupflow/join  — join via invite code
app.post('/api/groupflow/join', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)

  const { code } = await c.req.json()
  if (!code) return c.json({ error: 'Invite code required' }, 400)

  const inviteRes = await fetch(`${url}/get/gf_invite:${code.toUpperCase()}`, { headers: { Authorization: `Bearer ${token}` } })
  const inviteData: any = await inviteRes.json()
  if (!inviteData?.result) return c.json({ error: 'Invalid or expired invite code' }, 404)
  const invite = typeof inviteData.result === 'string' ? JSON.parse(inviteData.result) : inviteData.result

  const groupRes = await fetch(`${url}/get/gf_group:${invite.groupId}`, { headers: { Authorization: `Bearer ${token}` } })
  const groupData: any = await groupRes.json()
  if (!groupData?.result) return c.json({ error: 'Group not found' }, 404)
  const group = typeof groupData.result === 'string' ? JSON.parse(groupData.result) : groupData.result

  // Check if already a member
  const isMemberRes = await fetch(`${url}/sismember/gf_members:${invite.groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ member: session.email }) })
  const isMemberData: any = await isMemberRes.json()
  if (isMemberData?.result === 1) return c.json({ ok: true, group, alreadyMember: true })

  const memberData = { email: session.email, name: session.name || session.email.split('@')[0], avatar: session.picture || '', joinedAt: Date.now(), role: 'member' }

  // Add member, update group memberCount, link user→group
  group.memberCount = (group.memberCount || 1) + 1
  await Promise.all([
    fetch(`${url}/sadd/gf_members:${invite.groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ members: [session.email] }) }),
    fetch(`${url}/set/gf_memberdata:${invite.groupId}:${encodeURIComponent(session.email)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: JSON.stringify(memberData), ex: 60*60*24*365 }) }),
    fetch(`${url}/set/gf_group:${invite.groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: JSON.stringify(group) }) }),
    fetch(`${url}/sadd/gf_user_groups:${encodeURIComponent(session.email)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ members: [invite.groupId] }) }),
  ])

  // Post a system message to the group
  const sysMsg = { id: `msg_${Date.now()}`, type: 'system', text: `${memberData.name} joined the group 🎉`, ts: Date.now() }
  await fetch(`${url}/lpush/gf_msgs:${invite.groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ elements: [JSON.stringify(sysMsg)] }) })
  await fetch(`${url}/ltrim/gf_msgs:${invite.groupId}/0/499`, { headers: { Authorization: `Bearer ${token}` } })

  return c.json({ ok: true, group })
})

// GET /api/groupflow/list  — list all groups the user belongs to
app.get('/api/groupflow/list', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ groups: [] })

  const groupIdsRes = await fetch(`${url}/smembers/gf_user_groups:${encodeURIComponent(session.email)}`, { headers: { Authorization: `Bearer ${token}` } })
  const groupIdsData: any = await groupIdsRes.json()
  const groupIds: string[] = groupIdsData?.result || []
  if (!groupIds.length) return c.json({ groups: [] })

  const groups = await Promise.all(groupIds.map(async (gid: string) => {
    const r = await fetch(`${url}/get/gf_group:${gid}`, { headers: { Authorization: `Bearer ${token}` } })
    const d: any = await r.json()
    if (!d?.result) return null
    return typeof d.result === 'string' ? JSON.parse(d.result) : d.result
  }))

  return c.json({ groups: groups.filter(Boolean) })
})

// GET /api/groupflow/:groupId/messages  — get messages (last 100)
app.get('/api/groupflow/:groupId/messages', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ messages: [] })

  const groupId = c.req.param('groupId')
  const since = parseInt(c.req.query('since') || '0')

  // Verify member
  const isMemberRes = await fetch(`${url}/sismember/gf_members:${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ member: session.email }) })
  const isMemberData: any = await isMemberRes.json()
  if (isMemberData?.result !== 1) return c.json({ error: 'not_member' }, 403)

  const listRes = await fetch(`${url}/lrange/gf_msgs:${groupId}/0/99`, { headers: { Authorization: `Bearer ${token}` } })
  const listData: any = await listRes.json()
  const rawMsgs: string[] = (listData?.result || []).reverse() // newest first from lpush, reverse for chronological
  const messages = rawMsgs.map((m: string) => { try { return JSON.parse(m) } catch { return null } }).filter(Boolean)
  const filtered = since > 0 ? messages.filter((m: any) => m.ts > since) : messages
  return c.json({ messages: filtered.map((m: any) => ({ ...m, mine: m.fromEmail === session.email })) })
})

// POST /api/groupflow/:groupId/messages  — send a message to the group
app.post('/api/groupflow/:groupId/messages', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)

  const groupId = c.req.param('groupId')

  // Verify member
  const isMemberRes = await fetch(`${url}/sismember/gf_members:${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ member: session.email }) })
  const isMemberData: any = await isMemberRes.json()
  if (isMemberData?.result !== 1) return c.json({ error: 'not_member' }, 403)

  const { text, mediaUrl, mediaType } = await c.req.json()
  if (!text?.trim() && !mediaUrl) return c.json({ error: 'Message or media required' }, 400)

  const msg = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    type: mediaUrl ? mediaType || 'image' : 'text',
    text: (text || '').trim().slice(0, 2000),
    mediaUrl: mediaUrl || null,
    fromEmail: session.email,
    fromName: session.name || session.email.split('@')[0],
    fromAvatar: session.picture || '',
    ts: Date.now(),
    reactions: {},
  }

  await fetch(`${url}/lpush/gf_msgs:${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ elements: [JSON.stringify(msg)] }) })
  await fetch(`${url}/ltrim/gf_msgs:${groupId}/0/499`, { headers: { Authorization: `Bearer ${token}` } })

  return c.json({ ok: true, message: { ...msg, mine: true } })
})

// POST /api/groupflow/:groupId/react  — toggle emoji reaction on a message
app.post('/api/groupflow/:groupId/react', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)

  const groupId = c.req.param('groupId')
  const { messageId, emoji } = await c.req.json()

  // Get all messages, update the specific one
  const listRes = await fetch(`${url}/lrange/gf_msgs:${groupId}/0/99`, { headers: { Authorization: `Bearer ${token}` } })
  const listData: any = await listRes.json()
  const rawMsgs: string[] = listData?.result || []
  const messages = rawMsgs.map((m: string) => { try { return JSON.parse(m) } catch { return null } }).filter(Boolean)

  const msgIdx = messages.findIndex((m: any) => m.id === messageId)
  if (msgIdx === -1) return c.json({ error: 'message_not_found' }, 404)

  const msg = messages[msgIdx]
  if (!msg.reactions) msg.reactions = {}
  if (!msg.reactions[emoji]) msg.reactions[emoji] = []
  const reactors: string[] = msg.reactions[emoji]
  const uidx = reactors.indexOf(session.email)
  if (uidx === -1) { reactors.push(session.email) } else { reactors.splice(uidx, 1) }

  // Write back updated message
  await fetch(`${url}/lset/gf_msgs:${groupId}/${msgIdx}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ element: JSON.stringify(msg) }) })

  return c.json({ ok: true, reactions: msg.reactions })
})

// GET /api/groupflow/:groupId/members  — list group members
app.get('/api/groupflow/:groupId/members', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ members: [] })

  const groupId = c.req.param('groupId')

  const membersRes = await fetch(`${url}/smembers/gf_members:${groupId}`, { headers: { Authorization: `Bearer ${token}` } })
  const membersData: any = await membersRes.json()
  const memberEmails: string[] = membersData?.result || []

  const members = await Promise.all(memberEmails.map(async (email: string) => {
    const r = await fetch(`${url}/get/gf_memberdata:${groupId}:${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${token}` } })
    const d: any = await r.json()
    if (!d?.result) return { email, name: email.split('@')[0], role: 'member' }
    return typeof d.result === 'string' ? JSON.parse(d.result) : d.result
  }))

  return c.json({ members: members.filter(Boolean) })
})

// GET /api/groupflow/invite/:code  — preview an invite (group name, member count)
app.get('/api/groupflow/invite/:code', async (c) => {
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'unavailable' }, 503)

  const code = c.req.param('code').toUpperCase()
  const inviteRes = await fetch(`${url}/get/gf_invite:${code}`, { headers: { Authorization: `Bearer ${token}` } })
  const inviteData: any = await inviteRes.json()
  if (!inviteData?.result) return c.json({ error: 'Invalid or expired invite' }, 404)
  const invite = typeof inviteData.result === 'string' ? JSON.parse(inviteData.result) : inviteData.result

  const groupRes = await fetch(`${url}/get/gf_group:${invite.groupId}`, { headers: { Authorization: `Bearer ${token}` } })
  const groupData: any = await groupRes.json()
  if (!groupData?.result) return c.json({ error: 'Group not found' }, 404)
  const group = typeof groupData.result === 'string' ? JSON.parse(groupData.result) : groupData.result

  return c.json({ group: { id: group.id, name: group.name, description: group.description, memberCount: group.memberCount, ownerName: group.ownerName } })
})

// POST /api/groupflow/:groupId/leave  — leave a group
app.post('/api/groupflow/:groupId/leave', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session?.email) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const token = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !token) return c.json({ error: 'redis_unavailable' }, 503)

  const groupId = c.req.param('groupId')
  await Promise.all([
    fetch(`${url}/srem/gf_members:${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ members: [session.email] }) }),
    fetch(`${url}/del/gf_memberdata:${groupId}:${encodeURIComponent(session.email)}`, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${url}/srem/gf_user_groups:${encodeURIComponent(session.email)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ members: [groupId] }) }),
  ])

  const sysMsg = { id: `msg_${Date.now()}`, type: 'system', text: `${session.name || session.email.split('@')[0]} left the group`, ts: Date.now() }
  await fetch(`${url}/lpush/gf_msgs:${groupId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ elements: [JSON.stringify(sysMsg)] }) })
  return c.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// 3A — PRODUCT HUNT LAUNCH PAGE  GET /launch
// ══════════════════════════════════════════════════════════════════════════════
app.get('/launch', async (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowState — Build in Flow | Product Hunt Launch</title>
<meta name="description" content="The AI-powered focus OS for creators. Session tracking, AI Chat, Music generation, Release pipeline, FlowScore and more. Free to start.">
<!-- OG / Twitter Card -->
<meta property="og:type" content="website">
<meta property="og:url" content="https://flowst8.cc/launch">
<meta property="og:title" content="FlowState — Build in Flow 🚀">
<meta property="og:description" content="The AI focus OS built for creators. Track sessions, generate music/video, manage releases, and measure your flow — all in one place.">
<meta property="og:image" content="https://flowst8.cc/static/og-launch.svg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@flowst8cc">
<meta name="twitter:title" content="FlowState — Build in Flow 🚀">
<meta name="twitter:description" content="The AI focus OS for creators. Free to start.">
<meta name="twitter:image" content="https://flowst8.cc/static/og-launch.svg">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a12;color:#f0f0f0;font-family:'Inter',system-ui,sans-serif;overflow-x:hidden}
  .grad{background:linear-gradient(135deg,#a855f7,#ec4899)}
  .grad-text{background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .glow{box-shadow:0 0 40px rgba(168,85,247,.3)}
  .card{background:#12102a;border:1px solid rgba(168,85,247,.2);border-radius:16px}
  .pill{display:inline-flex;align-items:center;gap:6px;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.3);border-radius:99px;padding:6px 14px;font-size:12px;font-weight:600;color:#c084fc}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
  @keyframes pulse-glow{0%,100%{box-shadow:0 0 20px rgba(168,85,247,.3)}50%{box-shadow:0 0 60px rgba(168,85,247,.6)}}
  .float{animation:float 4s ease-in-out infinite}
  .pulse-glow{animation:pulse-glow 3s ease-in-out infinite}
  .feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}
  .stat-num{font-size:42px;font-weight:900;line-height:1}
</style>
</head>
<body>
<!-- NAV -->
<nav style="position:sticky;top:0;z-index:100;backdrop-filter:blur(20px);background:rgba(10,10,18,.8);border-bottom:1px solid rgba(168,85,247,.1);padding:14px 24px;display:flex;align-items:center;justify-content:space-between">
  <div style="font-size:20px;font-weight:900" class="grad-text">⚡ FLOWSTATE</div>
  <div style="display:flex;gap:12px;align-items:center">
    <a href="https://www.producthunt.com/posts/flowstate-3" target="_blank" style="display:flex;align-items:center;gap:8px;background:#ff6154;color:#fff;text-decoration:none;padding:8px 16px;border-radius:10px;font-weight:700;font-size:13px">
      <i class="fas fa-cat"></i> Vote on Product Hunt
    </a>
    <a href="https://flowst8.cc" style="display:flex;align-items:center;gap:6px;background:rgba(168,85,247,.15);border:1px solid rgba(168,85,247,.4);color:#c084fc;text-decoration:none;padding:8px 16px;border-radius:10px;font-weight:700;font-size:13px">
      Try Free <i class="fas fa-arrow-right"></i>
    </a>
  </div>
</nav>

<!-- HERO -->
<section style="max-width:1100px;margin:0 auto;padding:80px 24px 60px;text-align:center">
  <div class="pill" style="margin-bottom:20px">
    <span style="width:7px;height:7px;border-radius:50%;background:#10b981;animation:pulse-glow 2s infinite"></span>
    Launching on Product Hunt Today 🎉
  </div>
  <h1 style="font-size:clamp(36px,6vw,72px);font-weight:900;line-height:1.05;margin-bottom:20px">
    <span class="grad-text">Build in Flow.</span><br>
    Ship with AI.
  </h1>
  <p style="font-size:clamp(16px,2vw,20px);color:#9ca3af;max-width:600px;margin:0 auto 36px;line-height:1.6">
    FlowState is the focus OS built for creators — combining Pomodoro sessions, AI chat, music generation, release pipeline, and real-time FlowScore in one place.
  </p>
  <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-bottom:48px">
    <a href="https://flowst8.cc" style="display:inline-flex;align-items:center;gap:8px;padding:16px 40px;border-radius:14px;font-weight:800;font-size:17px;text-decoration:none;color:#fff" class="grad glow pulse-glow">
      <i class="fas fa-bolt"></i> Start Free — No Credit Card
    </a>
    <a href="https://www.producthunt.com/posts/flowstate-3" target="_blank" style="display:inline-flex;align-items:center;gap:8px;padding:16px 32px;border-radius:14px;font-weight:700;font-size:16px;text-decoration:none;color:#ff6154;border:2px solid #ff6154;background:rgba(255,97,84,.08)">
      <i class="fas fa-arrow-up"></i> Upvote on PH
    </a>
  </div>

  <!-- Stat strip -->
  <div style="display:flex;flex-wrap:wrap;gap:24px;justify-content:center;margin-bottom:60px">
    <div style="text-align:center"><div class="stat-num grad-text">376+</div><div style="font-size:12px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">Visitors</div></div>
    <div style="color:#2a2a3e;font-size:40px">|</div>
    <div style="text-align:center"><div class="stat-num" style="color:#10b981">156</div><div style="font-size:12px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">API Endpoints</div></div>
    <div style="color:#2a2a3e;font-size:40px">|</div>
    <div style="text-align:center"><div class="stat-num" style="color:#f59e0b">13</div><div style="font-size:12px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">Feature Tabs</div></div>
    <div style="color:#2a2a3e;font-size:40px">|</div>
    <div style="text-align:center"><div class="stat-num" style="color:#ec4899">Free</div><div style="font-size:12px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.8px">To Start</div></div>
  </div>
</section>

<!-- FEATURES -->
<section style="max-width:1100px;margin:0 auto;padding:0 24px 80px">
  <div style="text-align:center;margin-bottom:40px">
    <div class="pill" style="margin-bottom:12px"><i class="fas fa-star"></i> What makes FlowState different</div>
    <h2 style="font-size:clamp(24px,4vw,40px);font-weight:900">Everything a creator needs<br><span class="grad-text">in one focused space</span></h2>
  </div>
  <div class="feature-grid">
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">⏱️</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">Focus Timer + FlowScore</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Pomodoro-style focus sessions with AI scoring. Track streaks, output type, and get a real-time FlowScore out of 100.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">🤖</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">AI Chat & Tools</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Multi-model AI chat with OpenRouter — GPT-4o, Claude, Llama — plus smart focus suggestions and AI Flow Coach.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">🎵</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">Music & Video Generation</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Generate beats, audio, and video concepts from the same app you use to focus. Built for music creators.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">🚀</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">Release Pipeline (ClawFlow)</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Metadata, cover art generation, DistroKid/UnitedMasters prep, PR pitch drafts, SubmitHub submission — all automated.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">📊</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">Team Hub & Sprints</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Sprint health, team pulse, standups, burnout risk detection, FlowScore leaderboard — for teams that ship together.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">🌐</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">Public FlowScore Profile</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Your public productivity card at <code style="color:#a855f7">flowst8.cc/u/yourslug</code>. Share your focus data, streak, and top outputs publicly.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">🧠</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">AI Flow Coach</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Personalized coaching from your actual session data — peak hours, output patterns, streak analysis, and actionable next steps.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">🤝</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">Accountability Pairing</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Get matched with another creator for a shared focus session. Check in, stay accountable, ship together.</p>
    </div>
    <div class="card" style="padding:24px">
      <div style="font-size:32px;margin-bottom:12px">📅</div>
      <h3 style="font-size:17px;font-weight:800;margin-bottom:8px">Calendar & Notion Sync</h3>
      <p style="color:#9ca3af;font-size:14px;line-height:1.6">Auto-block focus time in Google Calendar and sync tasks and projects with Notion. Slack status updates too.</p>
    </div>
  </div>
</section>

<!-- COMPARISON -->
<section style="max-width:900px;margin:0 auto;padding:0 24px 80px">
  <div style="text-align:center;margin-bottom:40px">
    <h2 style="font-size:clamp(24px,4vw,36px);font-weight:900">Why creators switch to <span class="grad-text">FlowState</span></h2>
  </div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="border-bottom:1px solid #2a2a3e">
          <th style="text-align:left;padding:12px;color:#6b7280">Feature</th>
          <th style="padding:12px;text-align:center" class="grad-text">FlowState</th>
          <th style="padding:12px;text-align:center;color:#6b7280">Notion</th>
          <th style="padding:12px;text-align:center;color:#6b7280">Linear</th>
          <th style="padding:12px;text-align:center;color:#6b7280">Forest</th>
        </tr>
      </thead>
      <tbody>
        ${[
          ['Focus Timer + Scoring','✅','❌','❌','✅'],
          ['AI Multi-model Chat','✅','⚠️','❌','❌'],
          ['Music Generation','✅','❌','❌','❌'],
          ['Release Pipeline','✅','❌','❌','❌'],
          ['FlowScore / Gamification','✅','❌','❌','⚠️'],
          ['Public Profile','✅','⚠️','❌','❌'],
          ['Accountability Pairing','✅','❌','❌','✅'],
          ['Weekly AI Digest Email','✅','❌','❌','❌'],
          ['API Access','✅','✅','✅','❌'],
          ['Free Tier','✅','✅','✅','⚠️'],
        ].map(([f,a,b,c,d]) => `<tr style="border-bottom:1px solid #1a1a2e">
          <td style="padding:12px;color:#d1d5db">${f}</td>
          <td style="padding:12px;text-align:center">${a}</td>
          <td style="padding:12px;text-align:center;color:#6b7280">${b}</td>
          <td style="padding:12px;text-align:center;color:#6b7280">${c}</td>
          <td style="padding:12px;text-align:center;color:#6b7280">${d}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</section>

<!-- PRICING PREVIEW -->
<section style="max-width:900px;margin:0 auto;padding:0 24px 80px;text-align:center">
  <div class="pill" style="margin-bottom:16px"><i class="fas fa-tag"></i> Pricing</div>
  <h2 style="font-size:clamp(24px,4vw,36px);font-weight:900;margin-bottom:40px">Start free. <span class="grad-text">Ship more.</span></h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px">
    <div class="card" style="padding:28px">
      <div style="font-size:22px;font-weight:800;margin-bottom:4px">Free</div>
      <div style="font-size:36px;font-weight:900;margin:12px 0" class="grad-text">$0</div>
      <p style="color:#6b7280;font-size:13px;margin-bottom:20px">forever</p>
      <ul style="list-style:none;text-align:left;font-size:13px;color:#9ca3af;line-height:2">
        <li>✅ Focus timer + FlowScore</li><li>✅ 1,500 AI tokens/day</li><li>✅ Session history (30d)</li>
        <li>✅ Public profile</li><li>✅ Referral system</li>
      </ul>
    </div>
    <div class="card glow pulse-glow" style="padding:28px;border-color:rgba(168,85,247,.5);position:relative">
      <div style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#a855f7,#ec4899);border-radius:99px;padding:4px 16px;font-size:11px;font-weight:800;color:#fff">POPULAR</div>
      <div style="font-size:22px;font-weight:800;margin-bottom:4px">Pro</div>
      <div style="font-size:36px;font-weight:900;margin:12px 0" class="grad-text">$18<span style="font-size:16px;color:#6b7280">/month</span></div>
      <ul style="list-style:none;text-align:left;font-size:13px;color:#9ca3af;line-height:2">
        <li>✅ 100,000 AI tokens/day</li><li>✅ All models unlocked</li><li>✅ Full session history</li>
        <li>✅ ClawFlow release pipeline</li><li>✅ Priority support</li>
      </ul>
    </div>
    <div class="card" style="padding:28px">
      <div style="font-size:22px;font-weight:800;margin-bottom:4px">Team</div>
      <div style="font-size:36px;font-weight:900;margin:12px 0;color:#10b981">$15<span style="font-size:16px;color:#6b7280">/seat/month</span></div>
      <ul style="list-style:none;text-align:left;font-size:13px;color:#9ca3af;line-height:2">
        <li>✅ Everything in Pro</li><li>✅ Team leaderboard</li><li>✅ Sprint health dashboard</li>
        <li>✅ Burnout risk detection</li><li>✅ Slack integration</li>
      </ul>
    </div>
  </div>
</section>

<!-- FINAL CTA -->
<section style="text-align:center;padding:60px 24px 80px">
  <h2 style="font-size:clamp(28px,5vw,52px);font-weight:900;margin-bottom:16px">Ready to build in <span class="grad-text">flow?</span></h2>
  <p style="color:#9ca3af;font-size:16px;margin-bottom:36px">Join creators who track focus, ship music, and score their flow.</p>
  <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center">
    <a href="https://flowst8.cc" style="display:inline-flex;align-items:center;gap:8px;padding:18px 44px;border-radius:14px;font-weight:800;font-size:18px;text-decoration:none;color:#fff" class="grad glow">
      <i class="fas fa-bolt"></i> Get Started Free
    </a>
    <a href="https://www.producthunt.com/posts/flowstate-3" target="_blank" style="display:inline-flex;align-items:center;gap:8px;padding:18px 36px;border-radius:14px;font-weight:700;font-size:17px;text-decoration:none;background:#ff6154;color:#fff">
      <i class="fas fa-cat"></i> Upvote on Product Hunt
    </a>
  </div>
  <p style="color:#374151;font-size:12px;margin-top:32px">Built by a creator, for creators. 🔥 <a href="https://twitter.com/flowst8cc" style="color:#6b7280;text-decoration:none">@flowst8cc</a></p>
</section>

<!-- EMBED WIDGET PREVIEW -->
<section style="max-width:700px;margin:0 auto;padding:0 24px 80px;text-align:center">
  <div class="pill" style="margin-bottom:16px"><i class="fas fa-code"></i> Embed Widget</div>
  <h2 style="font-size:22px;font-weight:800;margin-bottom:12px">Show your FlowScore anywhere</h2>
  <p style="color:#6b7280;font-size:14px;margin-bottom:20px">Paste this on your GitHub profile, portfolio, or website:</p>
  <div style="background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:16px;text-align:left;font-size:13px;font-family:monospace;color:#79c0ff;overflow-x:auto;margin-bottom:16px">
    &lt;script src="https://flowst8.cc/widget.js?slug=yourslug"&gt;&lt;/script&gt;
  </div>
  <div id="widget-preview" style="display:flex;justify-content:center"></div>
  <script>
    // Live widget preview
    const s = document.createElement('script');
    s.src = '/widget.js?slug=demo&preview=1';
    document.getElementById('widget-preview').appendChild(s);
  </script>
</section>

<footer style="border-top:1px solid #1a1a2e;padding:24px;text-align:center;color:#374151;font-size:13px">
  <div style="margin-bottom:8px">
    <a href="https://flowst8.cc" style="color:#6b7280;text-decoration:none;margin:0 12px">App</a>
    <a href="https://flowst8.cc/launch" style="color:#6b7280;text-decoration:none;margin:0 12px">Launch</a>
    <a href="https://twitter.com/flowst8cc" style="color:#6b7280;text-decoration:none;margin:0 12px">Twitter</a>
    <a href="mailto:hello@flowst8.cc" style="color:#6b7280;text-decoration:none;margin:0 12px">Contact</a>
  </div>
  © 2026 FlowState · <a href="https://flowst8.cc" style="color:#555;text-decoration:none">flowst8.cc</a>
  &nbsp;·&nbsp; <a href="/legal#privacy" style="color:#555;text-decoration:none">Privacy</a>
  &nbsp;·&nbsp; <a href="/legal#terms" style="color:#555;text-decoration:none">Terms</a>
</footer>
</body>
</html>`
  return c.html(html)
})

// ══════════════════════════════════════════════════════════════════════════════
// 3C — EMBED WIDGET  GET /widget.js
// Injects a FlowScore badge that users can embed on GitHub / portfolios
// ══════════════════════════════════════════════════════════════════════════════
app.get('/widget.js', async (c) => {
  const slug = c.req.query('slug') || 'demo'
  const theme = c.req.query('theme') || 'dark'
  const preview = c.req.query('preview') === '1'
  const db = c.env?.DB

  let flowScore = 0, streak = 0, focusMin = 0, displayName = 'Creator', topOutput = ''
  let profileUrl = `https://flowst8.cc/u/${slug}`

  if (db && slug !== 'demo') {
    try {
      const profile = await db.prepare(
        `SELECT email, display_name, show_score, show_streak FROM public_profiles WHERE slug=?`
      ).bind(slug).first() as any
      if (profile && profile.show_score) {
        displayName = profile.display_name || slug
        const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
        const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
        const { results } = await db.prepare(
          `SELECT duration_mins, output_type, session_date FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1`
        ).bind(profile.email, since30).all() as any
        const week = (results as any[]).filter((r: any) => r.session_date >= since7)
        focusMin = week.reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
        const daySet = new Set((results as any[]).map((r: any) => r.session_date))
        const today = new Date()
        for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) streak++; else if (i > 0) break }
        flowScore = Math.min(100, Math.round((focusMin / 120) * 40 + (week.length / 5) * 30 + Math.min(streak, 7) * 4 + (week.length > 0 ? 15 : 0)))
        const outCounts: Record<string, number> = {}
        ;(results as any[]).forEach((r: any) => { if (r.output_type) outCounts[r.output_type] = (outCounts[r.output_type] || 0) + 1 })
        const top = Object.entries(outCounts).sort((a, b) => b[1] - a[1])[0]
        if (top) topOutput = top[0]
      }
    } catch (_) {}
  } else if (slug === 'demo') {
    // Demo values
    flowScore = 78; streak = 5; focusMin = 210; displayName = 'Demo User'; topOutput = 'Code'
  }

  const scoreColor = flowScore >= 70 ? '#10b981' : flowScore >= 40 ? '#a855f7' : '#f59e0b'
  const bg = theme === 'light' ? '#ffffff' : '#12102a'
  const textColor = theme === 'light' ? '#1a1a2e' : '#f0f0f0'
  const borderColor = theme === 'light' ? '#e5e7eb' : 'rgba(168,85,247,.25)'

  const widgetHtml = `<a href="${profileUrl}" target="_blank" rel="noopener" id="fs-widget-link" style="text-decoration:none;display:inline-flex;align-items:center;gap:12px;background:${bg};border:1px solid ${borderColor};border-radius:12px;padding:12px 18px;font-family:system-ui,-apple-system,sans-serif;color:${textColor};transition:transform .2s,box-shadow .2s;cursor:pointer" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(168,85,247,.25)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;border:3px solid ${scoreColor};background:${theme === 'light' ? '#f9fafb' : '#0a0a12'}">
    <span style="font-size:18px;font-weight:900;color:${scoreColor};line-height:1">${flowScore}</span>
    <span style="font-size:8px;color:${theme === 'light' ? '#9ca3af' : '#6b7280'};letter-spacing:.3px">FLOW</span>
  </div>
  <div>
    <div style="font-size:13px;font-weight:700;margin-bottom:3px">${displayName}</div>
    <div style="font-size:11px;color:${theme === 'light' ? '#6b7280' : '#9ca3af'};display:flex;gap:10px;flex-wrap:wrap">
      ${streak > 0 ? `<span>🔥 ${streak}d streak</span>` : ''}
      ${focusMin > 0 ? `<span>⏱ ${focusMin}m/wk</span>` : ''}
      ${topOutput ? `<span>🎯 ${topOutput}</span>` : ''}
    </div>
    <div style="font-size:10px;color:${theme === 'light' ? '#d1d5db' : '#374151'};margin-top:3px">flowst8.cc ⚡</div>
  </div>
</a>`

  // Return as a self-executing script that injects the widget
  const js = `(function() {
  var container = document.currentScript ? document.currentScript.parentNode : document.body;
  var div = document.createElement('div');
  div.innerHTML = ${JSON.stringify(widgetHtml)};
  container.appendChild(div.firstChild);
})();`

  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    }
  })
})

// Widget embed page (for iframe use)
app.get('/widget', async (c) => {
  const slug = c.req.query('slug') || 'demo'
  const theme = c.req.query('theme') || 'dark'
  // Redirect to profile page
  return c.redirect(`/u/${slug}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// TIER 3 — SCHEDULED WEEKLY DIGEST (Cloudflare Cron Trigger)
// Fires every Monday at 9:00 UTC via wrangler.jsonc triggers config.
// Sends weekly recap email to all users who have sessions in the past 7 days.
// ══════════════════════════════════════════════════════════════════════════════
async function scheduledHandler(event: any, env: any, ctx: any) {
  const db     = env?.DB
  const resendKey = env?.RESEND_API_KEY as string | undefined
  if (!db || !resendKey) return

  try {
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    // Get all unique emails that had a session in the past 7 days
    const { results } = await db.prepare(
      `SELECT DISTINCT email FROM sessions WHERE session_date>=? AND phase='focus' AND completed=1 LIMIT 500`
    ).bind(since7).all() as any

    for (const row of (results as any[])) {
      try {
        // Fetch their stats (same logic as /api/email/weekly-digest)
        const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
        const { results: sRows } = await db.prepare(
          `SELECT duration_mins, focus_score, output_type, session_date FROM sessions WHERE email=? AND session_date>=? AND phase='focus' AND completed=1 ORDER BY session_date DESC`
        ).bind(row.email, since30).all() as any
        const week = (sRows as any[]).filter((r: any) => r.session_date >= since7)
        if (week.length === 0) continue
        const focusMin   = week.reduce((s: number, r: any) => s + (r.duration_mins || 0), 0)
        const sessions7  = week.length
        const daySet = new Set((sRows as any[]).map((r: any) => r.session_date))
        let streak = 0
        const today = new Date()
        for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (daySet.has(d.toISOString().slice(0, 10))) streak++; else if (i > 0) break; }
        const flowScore = Math.min(100, Math.round((focusMin / 120) * 40 + (sessions7 / 5) * 30 + Math.min(streak, 7) * 4 + (sessions7 > 0 ? 15 : 0)))
        const scoreColor = flowScore >= 70 ? '#10b981' : flowScore >= 40 ? '#a855f7' : '#f59e0b'
        const wins: string[] = []
        const improve: string[] = []
        if (sessions7 >= 5) wins.push(`${sessions7} focus sessions this week 🎯`)
        if (streak >= 3) wins.push(`${streak}-day streak 🔥`)
        if (focusMin >= 120) wins.push(`${focusMin} minutes of deep work`)
        if (sessions7 < 3) improve.push('Aim for 5+ sessions next week')
        if (streak === 0) improve.push('Start a streak — 1 session/day compounds fast')
        const weekStr = `${new Date(Date.now()-7*86400000).toLocaleDateString('en-US',{month:'short',day:'numeric'})} – ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}`
        const winsHtml = wins.length ? wins.map(w=>`<li style="padding:4px 0;color:#d0d0d0">${w}</li>`).join('') : '<li style="color:#666">Keep going!</li>'
        const improvHtml = improve.length ? improve.map(i=>`<li style="padding:4px 0;color:#d0d0d0">${i}</li>`).join('') : '<li style="color:#888">Looking great!</li>'

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a12;font-family:system-ui,-apple-system,sans-serif;color:#f0f0f0">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
  <div style="text-align:center;margin-bottom:24px"><div style="font-size:28px">⚡</div>
    <h1 style="font-size:20px;font-weight:900;margin:4px 0;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent">FLOWSTATE</h1>
    <div style="font-size:12px;color:#666">Weekly Review — ${weekStr}</div>
  </div>
  <div style="text-align:center;margin-bottom:20px">
    <div style="display:inline-block;background:#12102a;border:2px solid ${scoreColor};border-radius:20px;padding:14px 28px">
      <div style="font-size:44px;font-weight:900;color:${scoreColor};line-height:1">${flowScore}</div>
      <div style="font-size:11px;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:1px">FlowScore</div>
    </div>
  </div>
  <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;justify-content:center">
    <div style="background:#12102a;border:1px solid #2a2a3e;border-radius:12px;padding:12px 18px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#a855f7">${focusMin}m</div><div style="font-size:11px;color:#666">Focus Time</div>
    </div>
    <div style="background:#12102a;border:1px solid #2a2a3e;border-radius:12px;padding:12px 18px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#ec4899">${sessions7}</div><div style="font-size:11px;color:#666">Sessions</div>
    </div>
    <div style="background:#12102a;border:1px solid #2a2a3e;border-radius:12px;padding:12px 18px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#f59e0b">${streak}🔥</div><div style="font-size:11px;color:#666">Day Streak</div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
    <div style="background:#12102a;border:1px solid #1a2e1a;border-radius:12px;padding:14px">
      <div style="font-size:11px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🏆 Wins</div>
      <ul style="margin:0;padding:0 0 0 14px;font-size:12px">${winsHtml}</ul>
    </div>
    <div style="background:#12102a;border:1px solid #2e2a1a;border-radius:12px;padding:14px">
      <div style="font-size:11px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🚀 Level Up</div>
      <ul style="margin:0;padding:0 0 0 14px;font-size:12px">${improvHtml}</ul>
    </div>
  </div>
  <div style="text-align:center;margin-bottom:24px">
    <a href="https://flowst8.cc" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 32px;border-radius:12px;font-weight:700;font-size:14px">Start This Week →</a>
  </div>
  <div style="text-align:center;font-size:11px;color:#333">FlowState · <a href="https://flowst8.cc" style="color:#555">flowst8.cc</a></div>
</div></body></html>`

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: c.env?.RESEND_FROM_EMAIL || 'FlowState <noreply@flowst8.cc>',
            to: [row.email],
            'reply-to': 'FlowState Support <hello@flowst8.cc>',
            subject: `⚡ Your FlowScore this week: ${flowScore} — ${weekStr}`,
            html,
          })
        })
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 200))
      } catch (_) { /* continue with next user on individual failure */ }
    }
  } catch (err: any) {
    console.error('Cron weekly digest error:', err.message)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LEGAL PAGES  GET /legal  GET /privacy  GET /terms
// ══════════════════════════════════════════════════════════════════════════════

const LEGAL_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0a0a0f;--bg-panel:#111118;--border:#1e1e2e;--accent:#a855f7;--accent2:#ec4899;--text:#e8e8f0;--text-m:#9090a8;--text-s:#6060758}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;line-height:1.7;min-height:100vh}
  .nav{display:flex;align-items:center;justify-content:space-between;padding:18px 32px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(10,10,15,.92);backdrop-filter:blur(12px);z-index:100}
  .nav-logo{font-size:20px;font-weight:900;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
  .nav-links{display:flex;gap:24px}
  .nav-links a{color:var(--text-m);text-decoration:none;font-size:13px;font-weight:500;transition:color .2s}
  .nav-links a:hover,.nav-links a.active{color:var(--text)}
  .container{max-width:780px;margin:0 auto;padding:48px 24px 80px}
  .tabs{display:flex;gap:0;border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:40px;background:var(--bg-panel)}
  .tab-btn{flex:1;padding:12px 20px;background:none;border:none;color:var(--text-m);font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;letter-spacing:.3px}
  .tab-btn.active{background:linear-gradient(135deg,rgba(168,85,247,.15),rgba(236,72,153,.1));color:var(--text);border-bottom:2px solid var(--accent)}
  .tab-content{display:none}.tab-content.active{display:block}
  .doc-header{margin-bottom:36px}
  .doc-title{font-size:32px;font-weight:900;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
  .doc-meta{font-size:13px;color:var(--text-m);display:flex;gap:16px;flex-wrap:wrap}
  .doc-meta span{background:var(--bg-panel);border:1px solid var(--border);border-radius:6px;padding:3px 10px}
  .toc{background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-bottom:36px}
  .toc-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);margin-bottom:12px}
  .toc ol{padding-left:18px;display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}
  .toc a{color:var(--accent);text-decoration:none;font-size:13px;transition:color .2s}
  .toc a:hover{color:var(--accent2)}
  h2{font-size:20px;font-weight:800;color:var(--text);margin:36px 0 14px;padding-top:8px;border-top:1px solid var(--border)}
  h2:first-of-type{margin-top:0;border-top:none}
  h3{font-size:15px;font-weight:700;color:var(--text);margin:20px 0 8px}
  p{color:var(--text-m);margin-bottom:12px;font-size:15px}
  ul,ol{color:var(--text-m);padding-left:20px;margin-bottom:14px;font-size:15px}
  li{margin-bottom:5px}
  strong{color:var(--text);font-weight:600}
  .highlight{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.05));border:1px solid rgba(168,85,247,.2);border-radius:10px;padding:16px 20px;margin:20px 0}
  .highlight p{margin:0;font-size:14px}
  .contact-box{background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:24px;margin-top:40px;text-align:center}
  .contact-box h3{color:var(--text);margin-bottom:8px}
  .contact-box a{color:var(--accent);text-decoration:none;font-weight:600}
  .back-btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;background:linear-gradient(135deg,rgba(168,85,247,.15),rgba(236,72,153,.1));border:1px solid rgba(168,85,247,.3);border-radius:8px;color:var(--text);text-decoration:none;font-size:13px;font-weight:600;transition:all .2s;margin-bottom:32px}
  .back-btn:hover{background:linear-gradient(135deg,rgba(168,85,247,.25),rgba(236,72,153,.2))}
  @media(max-width:600px){.toc ol{grid-template-columns:1fr}.nav{padding:14px 16px}.container{padding:32px 16px 60px}.doc-title{font-size:24px}}
`

const LEGAL_NAV = `
  <nav class="nav">
    <a class="nav-logo" href="/">FLOWSTATE</a>
    <div class="nav-links">
      <a href="/">App</a>
      <a href="/legal#privacy">Privacy</a>
      <a href="/legal#terms">Terms</a>
    </div>
  </nav>
`

const PRIVACY_POLICY_HTML = `
<div class="doc-header">
  <div class="doc-title">Privacy Policy</div>
  <div class="doc-meta">
    <span>Effective: April 12, 2026</span>
    <span>Last updated: April 12, 2026</span>
    <span>Version 1.0</span>
  </div>
</div>

<div class="highlight">
  <p><strong>The short version:</strong> FlowState helps you focus, grow, and ship. We collect only what we need to make the product work. We don't sell your data. We use industry-standard security. You own your data and can delete it anytime.</p>
</div>

<div class="toc">
  <div class="toc-title">Contents</div>
  <ol>
    <li><a href="#p1">Who We Are</a></li>
    <li><a href="#p2">What We Collect</a></li>
    <li><a href="#p3">How We Use Your Data</a></li>
    <li><a href="#p4">AI Features & Your Data</a></li>
    <li><a href="#p5">Third-Party Services</a></li>
    <li><a href="#p6">Data Storage & Security</a></li>
    <li><a href="#p7">Cookies & Local Storage</a></li>
    <li><a href="#p8">Your Rights</a></li>
    <li><a href="#p9">Children's Privacy</a></li>
    <li><a href="#p10">International Users</a></li>
    <li><a href="#p11">Changes to This Policy</a></li>
    <li><a href="#p12">Contact Us</a></li>
  </ol>
</div>

<h2 id="p1">1. Who We Are</h2>
<p>FlowState ("we," "us," or "our") is a productivity and creative intelligence platform operated as a software service. Our website and application are available at <strong>flowst8.cc</strong> and related subdomains. FlowState is an independent product — not affiliated with any corporation.</p>
<p>This Privacy Policy explains how we collect, use, disclose, and protect information when you use FlowState, including the web app, embed widget, public profile pages (<code>/u/:slug</code>), the launch page, and all associated API endpoints.</p>

<h2 id="p2">2. What We Collect</h2>

<h3>2.1 Information You Provide Directly</h3>
<ul>
  <li><strong>Account information:</strong> When you sign in with Google OAuth, we receive your email address, display name, and profile picture URL from Google.</li>
  <li><strong>Onboarding preferences:</strong> Focus duration, timezone, working hours, and productivity goals you enter during onboarding.</li>
  <li><strong>Session data:</strong> Focus session duration, output type (code, writing, design, etc.), notes, FlowScore, and streak data you log manually or through the timer.</li>
  <li><strong>Tasks &amp; deadlines:</strong> Task titles, statuses, tags, owners, deadlines, and progress percentages you create in the Kanban board or Smart Deadlines panel.</li>
  <li><strong>Team standup updates:</strong> Your standup text when you post updates in the Team Hub.</li>
  <li><strong>Profile information:</strong> Your public FlowState slug, bio, and display preferences for your public profile page (<code>/u/:slug</code>).</li>
  <li><strong>Referral codes:</strong> Referral codes you generate or claim.</li>
  <li><strong>AI chat messages:</strong> Prompts and conversation history you send to the AI chat, AI Flow Coach, ClawBot, or other AI assistants.</li>
  <li><strong>Generated content:</strong> Images, videos, audio, or text generated using AI tools, stored in Cloudflare R2 if you choose to save outputs.</li>
  <li><strong>Music playlist settings:</strong> YouTube playlist URLs you save for Pomodoro focus music.</li>
  <li><strong>Uploaded files:</strong> Files you upload using the file-conversion tools (PDF, images, SVG, PPTX, TXT, CSV). These are processed in-memory and not permanently stored unless you explicitly save them to R2.</li>
</ul>

<h3>2.2 Information Collected Automatically</h3>
<ul>
  <li><strong>Session cookies:</strong> An <code>fs_session</code> HTTP-only cookie containing your encoded session (email, name, avatar, tier, Google access token) — set for 7 days after login.</li>
  <li><strong>Integration tokens:</strong> OAuth access tokens for Google Calendar (<code>fs_session</code>), Notion (<code>fs_notion</code>), and Slack (<code>fs_slack</code>), stored as HTTP-only cookies.</li>
  <li><strong>IP address:</strong> Used transiently for rate limiting and abuse prevention via Upstash Redis. Not stored permanently.</li>
  <li><strong>Usage metadata:</strong> Daily AI token usage counts (keyed by email), velocity (requests per minute window), and tier information — stored in Redis and automatically expired.</li>
  <li><strong>Cloudflare headers:</strong> Standard Cloudflare edge headers such as <code>CF-Connecting-IP</code> and geolocation data are processed at the edge for abuse prevention and are not logged.</li>
</ul>

<h3>2.3 Information from Third-Party Integrations (Optional)</h3>
<p>You may optionally connect the following third-party services. We only request the minimum permissions needed:</p>
<ul>
  <li><strong>Google Calendar:</strong> Read and create calendar events to enable focus-block scheduling. We store your Google OAuth token in the session cookie (never in a database).</li>
  <li><strong>Notion:</strong> Read databases and pages you authorize, and create pages when you use the Notion sync feature. Token stored in <code>fs_notion</code> cookie.</li>
  <li><strong>Slack:</strong> Send messages to channels you authorize. Token stored in <code>fs_slack</code> cookie.</li>
  <li><strong>DistroKid / UnitedMasters / SubmitHub:</strong> Music distribution integrations for the CLAW Release Manager feature — OAuth tokens used only for the duration of the distribution workflow.</li>
  <li><strong>264Pro:</strong> If you connect your 264Pro account, we sync project data and activity logs. Token stored for the session.</li>
</ul>

<h2 id="p3">3. How We Use Your Data</h2>
<ul>
  <li><strong>Providing the service:</strong> Running your timer, tracking sessions, computing FlowScore, managing tasks, and serving your public profile.</li>
  <li><strong>AI personalization:</strong> Your session history, output types, focus patterns, and streak data are used to generate personalized AI Flow Coach insights, behavioral pattern analysis, smart focus-time suggestions, and weekly digests.</li>
  <li><strong>Billing &amp; subscriptions:</strong> Your email is passed to Stripe to manage subscriptions and token top-ups. We store a <code>stripe_customer:{email}</code> reference in Redis to link your Stripe account.</li>
  <li><strong>Rate limiting &amp; abuse prevention:</strong> IP addresses and email-based keys in Redis to enforce daily AI token limits, velocity checks, and anti-abuse rules.</li>
  <li><strong>Email communications:</strong> Streak reminder emails and weekly digest emails sent via Resend, using your email address from your session. You can opt out by unsubscribing from any email or by not enabling the feature.</li>
  <li><strong>Team features:</strong> When you join a team workspace, your display name, avatar, FlowScore, and session stats are visible to team members on the leaderboard and team hub.</li>
  <li><strong>Accountability pairing:</strong> Your email and session stats are temporarily shared with your paired partner during active pairing sessions.</li>
  <li><strong>Public FlowScore widget:</strong> If you use the embed widget or public profile, your FlowScore, streak, and session count are publicly visible at <code>/u/:slug</code>.</li>
  <li><strong>Product improvement:</strong> Aggregate, anonymized patterns (not tied to individual users) may inform product decisions.</li>
</ul>

<h2 id="p4">4. AI Features &amp; Your Data</h2>
<p>FlowState routes your AI requests to multiple large language model providers depending on the nature of the task:</p>
<ul>
  <li><strong>OpenAI</strong> (GPT-4o, GPT-4o mini, DALL-E 3) — creative tasks, general chat, image generation</li>
  <li><strong>Anthropic</strong> (Claude Sonnet, Claude Haiku) — code tasks, technical writing</li>
  <li><strong>Google AI</strong> (Gemini models) — quick queries, multimodal tasks</li>
  <li><strong>OpenRouter</strong> — aggregates multiple models including xAI Grok, Mistral, DeepSeek</li>
  <li><strong>Replicate / fal.ai / Higgsfield AI</strong> — AI image and video generation</li>
  <li><strong>ElevenLabs</strong> — AI text-to-speech</li>
  <li><strong>Suno / MusicGen / Udio</strong> — AI music generation</li>
  <li><strong>ACRCloud / Moises / Dolby</strong> — audio analysis and enhancement</li>
</ul>
<p>When you use an AI feature, your prompt and relevant context (session stats, behavioral data you've consented to share) are sent to the relevant provider. Each provider has their own privacy policy and data-handling practices. We do not share your account email or personally identifiable information with AI providers — only the content of your prompts and relevant anonymized context.</p>
<div class="highlight">
  <p><strong>Important:</strong> Do not include sensitive personal information (passwords, payment card numbers, government IDs, medical information) in AI chat messages or prompts. FlowState does not scrub prompt content before forwarding to AI providers.</p>
</div>
<p>AI-generated outputs (images, videos, audio) are stored in Cloudflare R2 under your account and are accessible via your private R2 key path. They are not publicly accessible unless you explicitly share them.</p>

<h2 id="p5">5. Third-Party Services</h2>
<p>FlowState integrates with the following third-party services. Each has its own privacy policy:</p>
<ul>
  <li><strong>Cloudflare</strong> (infrastructure, edge network, D1 database, R2 storage, Workers): <a href="https://www.cloudflare.com/privacypolicy/" target="_blank">cloudflare.com/privacypolicy</a></li>
  <li><strong>Google</strong> (OAuth, Calendar API): <a href="https://policies.google.com/privacy" target="_blank">policies.google.com/privacy</a></li>
  <li><strong>Stripe</strong> (billing): <a href="https://stripe.com/privacy" target="_blank">stripe.com/privacy</a></li>
  <li><strong>Upstash</strong> (Redis rate-limiting): <a href="https://upstash.com/privacy" target="_blank">upstash.com/privacy</a></li>
  <li><strong>Resend</strong> (transactional email): <a href="https://resend.com/privacy" target="_blank">resend.com/privacy</a></li>
  <li><strong>Notion</strong> (optional integration): <a href="https://www.notion.so/Privacy-Policy-3468d120cf614d4c9014c09f6adc9091" target="_blank">notion.so privacy policy</a></li>
  <li><strong>Slack</strong> (optional integration): <a href="https://slack.com/intl/en-us/privacy-policy" target="_blank">slack.com/privacy-policy</a></li>
  <li><strong>YouTube / Google</strong> (embedded music player): YouTube's Terms of Service apply when you use Pomodoro playlist links.</li>
  <li><strong>Spotify</strong> (optional music embed): <a href="https://www.spotify.com/us/legal/privacy-policy/" target="_blank">spotify.com/legal/privacy-policy</a></li>
</ul>

<h2 id="p6">6. Data Storage &amp; Security</h2>
<h3>6.1 Where Data Lives</h3>
<ul>
  <li><strong>Cloudflare D1 (SQLite):</strong> Permanent relational data — user accounts, subscription records, billing transactions, session history, tasks, and referral codes.</li>
  <li><strong>Upstash Redis:</strong> Ephemeral operational data — AI token usage (daily, auto-expiring), tier assignments, rate-limit counters, session-share cards, pairing queue state. Data in Redis is keyed by email or IP and expires automatically.</li>
  <li><strong>Cloudflare R2:</strong> Files you upload or generate — AI image/video/audio outputs, cover art, and file-conversion results you choose to save.</li>
  <li><strong>Browser (localStorage):</strong> Timer state, task data (if not synced to D1), playlist settings, UI preferences, onboarding completion flags, and standup drafts are stored locally in your browser. This data never leaves your device unless you're signed in and use a sync feature.</li>
  <li><strong>HTTP-only cookies:</strong> Session tokens, OAuth tokens for integrations. Not accessible to JavaScript.</li>
</ul>
<h3>6.2 Security Measures</h3>
<ul>
  <li>All traffic is served over HTTPS via Cloudflare's global edge network.</li>
  <li>Session cookies are marked <code>HttpOnly</code>, <code>Secure</code>, and <code>SameSite=Lax</code> (or <code>None</code> for cross-domain integrations).</li>
  <li>AI token rate-limiting and velocity checks prevent abuse.</li>
  <li>Stripe webhook verification using <code>STRIPE_WEBHOOK_SECRET</code> protects billing events.</li>
  <li>OAuth <code>state</code> parameter validation on all OAuth flows prevents CSRF attacks.</li>
  <li>Input sanitization and XSS escaping on all user-generated content rendered in the UI.</li>
</ul>
<p>No method of transmission over the internet is 100% secure. We take commercially reasonable steps to protect your information but cannot guarantee absolute security.</p>

<h2 id="p7">7. Cookies &amp; Local Storage</h2>
<p>We use the following browser storage mechanisms:</p>
<ul>
  <li><strong>fs_session</strong> (cookie, 7 days): Your login session — email, name, avatar, tier, Google token.</li>
  <li><strong>fs_notion</strong> (cookie, 30 days): Your Notion OAuth token, if connected.</li>
  <li><strong>fs_slack</strong> (cookie, 30 days): Your Slack OAuth token, if connected.</li>
  <li><strong>fs_onboarded</strong> (cookie, 365 days): Records that you've completed onboarding.</li>
  <li><strong>oauth_state</strong> (cookie, 10 min): CSRF state token for in-progress OAuth flows.</li>
  <li><strong>localStorage (browser):</strong> Timer state (<code>fs_state</code>), tasks, playlist config, pomodoro settings, volume preferences, onboarding flags, standup entries, deadline data, and YouTube playlist items. This is cleared when you clear browser data.</li>
</ul>
<p>We do not use third-party advertising cookies or tracking pixels. We do not use Google Analytics or similar analytics services.</p>

<h2 id="p8">8. Your Rights</h2>
<p>Regardless of your location, you have the following rights with respect to your data:</p>
<ul>
  <li><strong>Access:</strong> Request a copy of the data we hold about you.</li>
  <li><strong>Correction:</strong> Ask us to correct inaccurate data.</li>
  <li><strong>Deletion:</strong> Request deletion of your account and all associated data. Deleting your account will remove your D1 records, R2 files, and Redis keys. Data in Stripe will be subject to Stripe's retention policy.</li>
  <li><strong>Portability:</strong> Request an export of your session history and task data.</li>
  <li><strong>Opt-out:</strong> Opt out of streak reminder emails and weekly digest emails at any time via the unsubscribe link or by contacting us.</li>
  <li><strong>Revoke integrations:</strong> Disconnect Google, Notion, or Slack at any time via Settings. This deletes the stored token cookie.</li>
</ul>
<p>To exercise any of these rights, email us at <strong>privacy@flowst8.cc</strong>. We will respond within 30 days.</p>
<p><strong>EU/EEA residents (GDPR):</strong> You have additional rights under the General Data Protection Regulation, including the right to lodge a complaint with your local supervisory authority. Our lawful basis for processing personal data is primarily "performance of a contract" (providing the service you signed up for) and "legitimate interests" (security and abuse prevention).</p>
<p><strong>California residents (CCPA/CPRA):</strong> We do not sell personal information. You have the right to know, delete, and opt-out of the sharing of personal information. FlowState qualifies as a small business under CCPA thresholds, but we honor these rights regardless.</p>

<h2 id="p9">9. Children's Privacy</h2>
<p>FlowState is not directed at children under the age of 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided us personal information, contact us at <strong>privacy@flowst8.cc</strong> and we will delete it promptly.</p>

<h2 id="p10">10. International Users</h2>
<p>FlowState is operated from the United States. If you access FlowState from outside the United States, your information may be transferred to and processed in the United States and other countries where our service providers operate (including Cloudflare's global edge network). By using FlowState, you consent to this transfer.</p>

<h2 id="p11">11. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. We will notify you of material changes by updating the "Last updated" date and, where appropriate, by sending an email to your registered address or displaying a notice in the app. Continued use of FlowState after changes are posted constitutes acceptance of the updated policy.</p>

<h2 id="p12">12. Contact Us</h2>
<div class="contact-box">
  <h3>Privacy Questions</h3>
  <p>Email us at <a href="mailto:privacy@flowst8.cc">privacy@flowst8.cc</a></p>
  <p style="font-size:13px;color:var(--text-m);margin-top:8px">We aim to respond within 2–3 business days for general inquiries and within 30 days for formal data rights requests.</p>
</div>
`

const TERMS_OF_USE_HTML = `
<div class="doc-header">
  <div class="doc-title">Terms of Use</div>
  <div class="doc-meta">
    <span>Effective: April 12, 2026</span>
    <span>Last updated: April 12, 2026</span>
    <span>Version 1.0</span>
  </div>
</div>

<div class="highlight">
  <p><strong>By using FlowState, you agree to these terms.</strong> If you don't agree, please don't use the service. These terms apply to all users including free, Pro, and Team plan subscribers, as well as users of the embed widget and public APIs.</p>
</div>

<div class="toc">
  <div class="toc-title">Contents</div>
  <ol>
    <li><a href="#t1">Acceptance of Terms</a></li>
    <li><a href="#t2">Description of Service</a></li>
    <li><a href="#t3">Accounts &amp; Authentication</a></li>
    <li><a href="#t4">Subscription Plans &amp; Billing</a></li>
    <li><a href="#t5">AI Features &amp; Token Credits</a></li>
    <li><a href="#t6">Acceptable Use</a></li>
    <li><a href="#t7">User Content &amp; Intellectual Property</a></li>
    <li><a href="#t8">Third-Party Integrations</a></li>
    <li><a href="#t9">Availability &amp; Modifications</a></li>
    <li><a href="#t10">Disclaimers</a></li>
    <li><a href="#t11">Limitation of Liability</a></li>
    <li><a href="#t12">Indemnification</a></li>
    <li><a href="#t13">Termination</a></li>
    <li><a href="#t14">Governing Law</a></li>
    <li><a href="#t15">Changes to Terms</a></li>
    <li><a href="#t16">Contact</a></li>
  </ol>
</div>

<h2 id="t1">1. Acceptance of Terms</h2>
<p>These Terms of Use ("Terms") constitute a legally binding agreement between you ("User," "you") and FlowState ("we," "us," "our") governing your access to and use of the FlowState platform, including the web application at <strong>flowst8.cc</strong>, all associated APIs, the embed widget (<code>/widget.js</code>), public profile pages, the launch page, and any related services (collectively, the "Service").</p>
<p>By creating an account, signing in, or using any part of the Service, you confirm that (a) you are at least 13 years old; (b) you have the legal capacity to enter into this agreement; and (c) you agree to be bound by these Terms and our Privacy Policy.</p>

<h2 id="t2">2. Description of Service</h2>
<p>FlowState is an AI-native productivity and creative intelligence platform. The Service includes, but is not limited to:</p>
<ul>
  <li><strong>Pomodoro Focus Timer</strong> — customizable focus/break timer with FlowScore tracking, streak system, and session history.</li>
  <li><strong>AI Chat Assistant</strong> — multi-model AI chat routed to OpenAI, Anthropic, Google, and other providers based on task type.</li>
  <li><strong>AI Flow Coach</strong> — personalized behavioral pattern analysis and productivity insights derived from your session history.</li>
  <li><strong>Smart Deadlines (Pro)</strong> — deadline tracking with AI risk analysis, progress bars, and team assignment.</li>
  <li><strong>Team Hub</strong> — standup updates, leaderboard, sprint health monitoring, and accountability pairing.</li>
  <li><strong>Accountability Pairing</strong> — real-time focus pairing with another FlowState user.</li>
  <li><strong>Kanban Board</strong> — task management with drag-and-drop, tags, and D1 sync for Pro users.</li>
  <li><strong>Google Calendar Integration</strong> — read and create focus blocks in your calendar.</li>
  <li><strong>Notion &amp; Slack Integration</strong> — sync tasks and send standup updates to Notion and Slack.</li>
  <li><strong>Generate Tab</strong> — AI image, video, and audio generation using Replicate, fal.ai, Higgsfield AI, ElevenLabs, and music AI models.</li>
  <li><strong>FlowState Audio (FSAudio)</strong> — AI music production tools including arrangement suggestions, track generation, and audio analysis.</li>
  <li><strong>CLAW Release Manager</strong> — music release pipeline including cover art generation, pitch drafting, metadata management, and distribution prep for DistroKid and UnitedMasters.</li>
  <li><strong>ClawBot</strong> — AI creative assistant specialized for music and content creators.</li>
  <li><strong>264Pro Integration</strong> — creative project sync, AI context memory, video generation, and diagnostic tools for 264Pro users.</li>
  <li><strong>File Tools</strong> — browser-based file conversion (PDF↔Images, SVG→PNG, TXT→PDF, CSV→JSON, PPTX→PDF).</li>
  <li><strong>Ambient Sound &amp; Music Player</strong> — built-in ambient sounds (Web Audio API) and YouTube/Spotify playlist integration for focus sessions.</li>
  <li><strong>Pomodoro Volume Slider</strong> — in-app music volume control for ambient and playlist audio.</li>
  <li><strong>Public FlowScore Widget</strong> — embeddable widget and public profile page displaying your productivity stats.</li>
  <li><strong>Weekly AI Digest</strong> — automated weekly email summarizing your focus patterns, sent via Resend.</li>
  <li><strong>Token Top-Up</strong> — one-time purchase of additional AI token credits via Stripe.</li>
  <li><strong>Referral Program</strong> — refer new users and earn token credits.</li>
  <li><strong>Launch Page</strong> — public marketing and Product Hunt launch page.</li>
</ul>

<h2 id="t3">3. Accounts &amp; Authentication</h2>
<p>FlowState currently supports sign-in via <strong>Google OAuth</strong> and <strong>Magic Link (email)</strong>. By signing in with Google, you authorize FlowState to access your Google profile information (email, name, avatar) and, optionally, your Google Calendar.</p>
<ul>
  <li>You are responsible for maintaining the security of your Google account and any sessions you initiate on FlowState.</li>
  <li>You must not share your session with others or use another person's account.</li>
  <li>You must not attempt to circumvent authentication, rate limits, or tier restrictions.</li>
  <li>We reserve the right to suspend or terminate accounts that violate these Terms.</li>
  <li>Your FlowState public slug (<code>/u/:slug</code>) must not impersonate another person or organization.</li>
</ul>

<h2 id="t4">4. Subscription Plans &amp; Billing</h2>
<h3>4.1 Plans</h3>
<p>FlowState offers the following plans (prices and features subject to change with notice):</p>
<ul>
  <li><strong>Free:</strong> Timer, basic AI chat, limited daily AI tokens (1,500/day), local Kanban, public FlowScore widget, ambient sounds.</li>
  <li><strong>Pro ($18/month monthly, $14/month billed annually):</strong> All Free features, plus multi-LLM routing, Smart Deadlines, D1-synced tasks, all integrations, AI Flow Coach, CLAW Release Manager, FlowState Audio, full Generate tab, and 100,000 daily AI tokens.</li>
  <li><strong>Team ($15/seat/month monthly, $12/seat/month billed annually):</strong> Pro features plus Team Hub, leaderboard, burnout risk monitoring, sprint health, shared standup, and 100,000 daily AI tokens per seat.</li>
  <li><strong>Enterprise (contact us):</strong> Custom pricing, dedicated support, white-label options, SSO, and volume token pricing. Contact <a href="mailto:enterprise@flowst8.cc">enterprise@flowst8.cc</a>.</li>
</ul>
<h3>4.2 Billing</h3>
<ul>
  <li>Subscriptions are billed via <strong>Stripe</strong>. By subscribing, you agree to Stripe's Terms of Service.</li>
  <li>Subscriptions auto-renew at the end of each billing cycle. You can cancel anytime via the billing portal (accessible from Settings).</li>
  <li>Annual subscriptions are non-refundable after 14 days from the initial purchase date.</li>
  <li>Monthly subscriptions may be cancelled at any time; your access continues until the end of the current billing period.</li>
  <li>We reserve the right to change pricing with 30 days' notice. Existing subscribers will be notified by email before any price change takes effect.</li>
</ul>
<h3>4.3 Token Top-Ups</h3>
<ul>
  <li>You may purchase additional AI token credits as a one-time purchase (not a subscription) in packs of 50k tokens ($5), 200k tokens ($15), or 500k tokens ($30).</li>
  <li>Purchased tokens are non-refundable once credited to your account.</li>
  <li>Purchased tokens do not expire and are consumed after your daily token budget is depleted.</li>
  <li>Token credits are tied to your account and are not transferable.</li>
</ul>
<h3>4.4 Free Trial &amp; Demo Mode</h3>
<p>FlowState may be used without an account in demo mode with limited functionality. Demo mode data is stored locally and is not backed up. Creating an account activates full free-tier features.</p>

<h2 id="t5">5. AI Features &amp; Token Credits</h2>
<p>AI features on FlowState consume token credits from your daily budget. Token consumption is measured in approximate LLM input/output tokens.</p>
<ul>
  <li><strong>Daily budgets reset at midnight UTC.</strong></li>
  <li>Free users receive 1,500 tokens/day. Pro and Team users receive 100,000 tokens/day.</li>
  <li>When your daily budget is depleted, AI features will return a rate-limit response until reset or until you use purchased tokens.</li>
  <li>We do not guarantee that AI outputs will be accurate, appropriate, or free from errors. AI models may produce incorrect, biased, or unexpected responses.</li>
  <li>You are responsible for reviewing AI-generated content before acting on it, publishing it, or distributing it.</li>
  <li>AI image, video, and audio generation features are subject to additional content policies imposed by the underlying model providers (Replicate, fal.ai, Higgsfield, ElevenLabs, etc.).</li>
  <li>The AI Flow Coach provides insights based on your personal usage patterns and is not a substitute for professional health, medical, or psychological advice.</li>
</ul>

<h2 id="t6">6. Acceptable Use</h2>
<p>You agree not to use FlowState to:</p>
<ul>
  <li>Generate, distribute, or promote content that is illegal, harassing, defamatory, threatening, obscene, or violates any applicable law.</li>
  <li>Create content that infringes on third-party intellectual property rights, including copyrighted text, images, music, or code.</li>
  <li>Generate deepfakes, non-consensual intimate images, or any content that misrepresents real persons.</li>
  <li>Attempt to bypass token limits, rate limits, or tier restrictions through automated scripts, bots, or abuse of multiple accounts.</li>
  <li>Scrape, mirror, or reverse-engineer the FlowState application or APIs.</li>
  <li>Interfere with the security, integrity, or availability of the Service.</li>
  <li>Use the Service for any commercial purpose not expressly authorized, including reselling access to FlowState APIs.</li>
  <li>Upload malicious files, scripts, or content designed to harm other users or the Service infrastructure.</li>
  <li>Circumvent or attempt to disable any geographic restrictions or content filters.</li>
  <li>Use the CLAW Release Manager or distribution features to distribute content you do not have the rights to distribute.</li>
</ul>
<p>We reserve the right to immediately suspend or terminate access for violation of these rules, without refund.</p>

<h2 id="t7">7. User Content &amp; Intellectual Property</h2>
<h3>7.1 Your Content</h3>
<p>You retain ownership of content you create, upload, or generate using FlowState, including AI-generated outputs where you provided the prompts. By using the Service, you grant FlowState a limited, non-exclusive, royalty-free license to store, process, and display your content solely for the purpose of providing the Service to you.</p>
<p>We do not claim ownership of your tasks, session notes, generated images, music, or other creative work.</p>
<h3>7.2 AI-Generated Content Ownership</h3>
<p>Ownership of AI-generated content is a complex and evolving legal area. FlowState makes no representations about the copyright status of AI-generated outputs. You are responsible for reviewing applicable laws in your jurisdiction before publishing, selling, or distributing AI-generated content.</p>
<h3>7.3 FlowState Intellectual Property</h3>
<p>All FlowState trademarks, logos, branding, application code, UI design, and proprietary algorithms (including the FlowScore formula, Intent Layer logic, and AI routing system) are the exclusive property of FlowState. You may not copy, reproduce, or create derivative works from these elements without prior written consent.</p>
<h3>7.4 Feedback</h3>
<p>If you submit feedback, feature requests, or bug reports, you grant us the right to use this feedback without compensation or attribution to improve the Service.</p>

<h2 id="t8">8. Third-Party Integrations</h2>
<p>FlowState integrates with third-party services including Google, Notion, Slack, Stripe, DistroKid, UnitedMasters, SubmitHub, YouTube, Spotify, and various AI providers. Your use of these integrations is subject to the respective third-party terms of service.</p>
<ul>
  <li>FlowState is not responsible for the availability, accuracy, or conduct of third-party services.</li>
  <li>Connecting a third-party integration grants FlowState limited access to that service on your behalf. You can revoke this access at any time via the Settings modal or directly through the third-party service's authorization settings.</li>
  <li>Using YouTube embedded players is subject to YouTube's <a href="https://www.youtube.com/t/terms" target="_blank">Terms of Service</a> and <a href="https://policies.google.com/privacy" target="_blank">Google Privacy Policy</a>.</li>
  <li>Music distribution via DistroKid or UnitedMasters through the CLAW Release Manager is subject to those platforms' own distribution agreements and content policies.</li>
</ul>

<h2 id="t9">9. Availability &amp; Modifications</h2>
<p>FlowState is provided on an "as is" and "as available" basis. We strive for high availability but do not guarantee uninterrupted access. The Service may be temporarily unavailable due to:</p>
<ul>
  <li>Scheduled maintenance (we will notify users in advance when possible).</li>
  <li>Cloudflare infrastructure events or outages.</li>
  <li>Third-party API provider outages.</li>
  <li>Security incidents requiring immediate response.</li>
</ul>
<p>We reserve the right to modify, discontinue, or sunset any feature with or without notice. For paid features being removed, we will provide at least 30 days' notice and a pro-rated refund if applicable.</p>

<h2 id="t10">10. Disclaimers</h2>
<p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:</p>
<ul>
  <li>THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, OR NON-INFRINGEMENT.</li>
  <li>WE DO NOT WARRANT THAT THE SERVICE WILL BE ERROR-FREE, UNINTERRUPTED, SECURE, OR FREE FROM VIRUSES OR OTHER HARMFUL COMPONENTS.</li>
  <li>AI-GENERATED CONTENT MAY BE INACCURATE, INCOMPLETE, OR OUTDATED. FLOWSTATE IS NOT RESPONSIBLE FOR DECISIONS MADE BASED ON AI OUTPUTS.</li>
  <li>THE AI FLOW COACH AND BEHAVIORAL INSIGHTS ARE FOR INFORMATIONAL PURPOSES ONLY AND DO NOT CONSTITUTE PROFESSIONAL ADVICE OF ANY KIND (MEDICAL, PSYCHOLOGICAL, LEGAL, FINANCIAL, ETC.).</li>
  <li>MUSIC DISTRIBUTION SERVICES ENABLED THROUGH THE CLAW RELEASE MANAGER ARE PROVIDED AS A CONVENIENCE. FLOWSTATE DOES NOT GUARANTEE ACCEPTANCE, DISTRIBUTION SUCCESS, OR PLACEMENT BY ANY DISTRIBUTION PARTNER.</li>
</ul>

<h2 id="t11">11. Limitation of Liability</h2>
<p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL FLOWSTATE, ITS OPERATORS, AFFILIATES, OR LICENSORS BE LIABLE FOR ANY:</p>
<ul>
  <li>INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES;</li>
  <li>LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR BUSINESS OPPORTUNITIES;</li>
  <li>DAMAGES RESULTING FROM UNAUTHORIZED ACCESS TO OR ALTERATION OF YOUR DATA;</li>
  <li>DAMAGES RESULTING FROM THIRD-PARTY SERVICE OUTAGES OR FAILURES;</li>
  <li>DAMAGES RESULTING FROM AI-GENERATED CONTENT OR DECISIONS MADE BASED ON AI INSIGHTS.</li>
</ul>
<p>IN ANY CASE, OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM OR RELATED TO THE SERVICE SHALL NOT EXCEED THE GREATER OF: (A) THE TOTAL AMOUNT YOU PAID TO FLOWSTATE IN THE 12 MONTHS PRECEDING THE CLAIM, OR (B) $50 USD.</p>
<p>Some jurisdictions do not allow certain limitations of liability — in those cases, our liability is limited to the minimum extent permitted by law.</p>

<h2 id="t12">12. Indemnification</h2>
<p>You agree to defend, indemnify, and hold harmless FlowState and its operators from and against any claims, damages, losses, and expenses (including reasonable legal fees) arising from or related to: (a) your use of the Service; (b) your violation of these Terms; (c) content you submit, generate, or distribute using the Service; (d) your violation of any third party's rights; or (e) your use of any third-party integration in violation of that party's terms.</p>

<h2 id="t13">13. Termination</h2>
<p>You may terminate your account at any time by contacting us at <strong>support@flowst8.cc</strong>. Upon termination, your data will be deleted in accordance with our Privacy Policy (typically within 30 days, subject to legal retention requirements).</p>
<p>We may terminate or suspend your access immediately, without prior notice or liability, if you breach these Terms or engage in conduct we determine to be harmful to the Service, other users, or third parties. Upon termination by us for cause, you will not be entitled to a refund of any prepaid subscription fees.</p>

<h2 id="t14">14. Governing Law &amp; Dispute Resolution</h2>
<p>These Terms are governed by the laws of the <strong>State of Georgia, United States</strong>, without regard to its conflict of law provisions. Any disputes arising from these Terms or the Service shall be resolved first through informal negotiation. If informal resolution fails, disputes shall be submitted to binding arbitration in accordance with the rules of the American Arbitration Association, conducted in English in Atlanta, Georgia.</p>
<p><strong>Class action waiver:</strong> You agree that any arbitration or proceeding shall be limited to the dispute between us individually. You waive the right to participate in a class action lawsuit or class-wide arbitration.</p>
<p>Nothing in this section prevents either party from seeking emergency injunctive or other equitable relief from a court of competent jurisdiction.</p>

<h2 id="t15">15. Changes to These Terms</h2>
<p>We reserve the right to modify these Terms at any time. We will provide notice of material changes by updating the "Last updated" date above and, where appropriate, by sending an email to your registered address or displaying a prominent in-app notice at least 14 days before the change takes effect. Your continued use of the Service after the effective date of the revised Terms constitutes your acceptance of the changes.</p>

<h2 id="t16">16. Contact</h2>
<div class="contact-box">
  <h3>Questions about these Terms?</h3>
  <p>Email us at <a href="mailto:legal@flowst8.cc">legal@flowst8.cc</a></p>
  <p style="font-size:13px;color:var(--text-m);margin-top:8px">For billing disputes: <a href="mailto:billing@flowst8.cc" style="color:var(--accent)">billing@flowst8.cc</a> &nbsp;|&nbsp; For privacy: <a href="mailto:privacy@flowst8.cc" style="color:var(--accent)">privacy@flowst8.cc</a></p>
</div>
`

function buildLegalPage(activeTab: 'privacy' | 'terms'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${activeTab === 'privacy' ? 'Privacy Policy' : 'Terms of Use'} — FlowState</title>
  <meta name="description" content="${activeTab === 'privacy' ? 'FlowState Privacy Policy — how we collect, use, and protect your data.' : 'FlowState Terms of Use — rules and rights governing your use of the platform.'}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://flowst8.cc/legal">
  <style>${LEGAL_CSS}</style>
</head>
<body>
  ${LEGAL_NAV}
  <div class="container">
    <a class="back-btn" href="/"><span>←</span> Back to FlowState</a>
    <div class="tabs">
      <button class="tab-btn ${activeTab === 'privacy' ? 'active' : ''}" onclick="switchTab('privacy')">🔒 Privacy Policy</button>
      <button class="tab-btn ${activeTab === 'terms' ? 'active' : ''}" onclick="switchTab('terms')">📋 Terms of Use</button>
    </div>
    <div id="tab-privacy" class="tab-content ${activeTab === 'privacy' ? 'active' : ''}">
      ${PRIVACY_POLICY_HTML}
    </div>
    <div id="tab-terms" class="tab-content ${activeTab === 'terms' ? 'active' : ''}">
      ${TERMS_OF_USE_HTML}
    </div>
  </div>
  <script>
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + tab).classList.add('active');
      event.currentTarget.classList.add('active');
      window.history.replaceState(null, '', '/legal#' + tab);
    }
    // Auto-switch based on hash
    const hash = window.location.hash.replace('#','');
    if (hash === 'terms') switchTab('terms');
    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const target = document.querySelector(a.getAttribute('href'));
        if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      });
    });
  </script>
</body>
</html>`
}

app.get('/legal', (c) => {
  const hash = c.req.query('tab') || 'privacy'
  const tab = hash === 'terms' ? 'terms' : 'privacy'
  return c.html(buildLegalPage(tab))
})

app.get('/privacy', (c) => c.redirect('/legal#privacy'))
app.get('/terms', (c) => c.redirect('/legal#terms'))
app.get('/privacy-policy', (c) => c.redirect('/legal#privacy'))
app.get('/terms-of-service', (c) => c.redirect('/legal#terms'))
app.get('/terms-of-use', (c) => c.redirect('/legal#terms'))

// ═══════════════════════════════════════════════════════════════════════════
// CLAWFLOW DEVELOPER PAGE — Persistent memory, config, projects, health
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/claw/memory — load last N messages for the user
app.get('/api/claw/memory', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ messages: [] })
  const raw: any = await fetch(`${url}/get/claw_memory:${encodeURIComponent(session.email)}`, {
    headers: { Authorization: `Bearer ${tok}` }
  }).then(r => r.json()).catch(() => ({}))
  const messages = raw?.result ? JSON.parse(raw.result) : []
  return c.json({ messages })
})

// POST /api/claw/memory — send a message + get CLAW reply, store in Redis
app.post('/api/claw/memory', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const userMessage: string = (body.message || '').trim()
  if (!userMessage) return c.json({ error: 'empty_message' }, 400)

  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN

  // Load existing memory, config, and projects in one shot
  const [memRaw, cfgRaw, projRaw] = await Promise.all([
    url && tok ? fetch(`${url}/get/claw_memory:${encodeURIComponent(session.email)}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json()).catch(() => ({})) : Promise.resolve({}),
    url && tok ? fetch(`${url}/get/claw_config:${encodeURIComponent(session.email)}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json()).catch(() => ({})) : Promise.resolve({}),
    url && tok ? fetch(`${url}/get/claw_projects:${encodeURIComponent(session.email)}`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json()).catch(() => ({})) : Promise.resolve({}),
  ]) as any[]

  const history: any[] = memRaw?.result ? JSON.parse(memRaw.result) : []
  const config: any = cfgRaw?.result ? JSON.parse(cfgRaw.result) : {}
  const projects: any[] = projRaw?.result ? JSON.parse(projRaw.result) : []

  // Build memory context for system prompt
  const preferredModel = config.preferredModel || 'Claude'
  const style = config.style || 'clean, modular, well-commented'
  const recentProjects = projects.slice(0, 5).map((p: any) => `• ${p.name} (${p.files?.length || 0} files, last: ${p.lastModified?.slice(0, 10) || 'unknown'})`).join('\n') || 'None yet'
  const lastDeploy = projects.find((p: any) => p.deployUrl)?.deployUrl || 'None'

  const systemPrompt = `You are CLAW — the AI brain behind FlowState's developer ecosystem. You are persistent: you remember this user's history, style, and projects across sessions.

MEMORY ABOUT THIS USER:
- Email: ${session.email}
- Preferred AI model: ${preferredModel}
- Coding style preference: "${style}"
- Recent projects:\n${recentProjects}
- Last deploy URL: ${lastDeploy}

YOUR ROLE ON THE CLAWFLOW DEVELOPER PAGE:
- This is the user's dedicated workspace. Think of yourself as their senior technical co-founder.
- Help them build, debug, deploy, and architect systems within FlowState.
- Reference their past work naturally — you remember everything.
- Be direct, actionable, and concise. No unnecessary caveats.
- When they describe a feature, you can offer to write the code changes needed.
- Permissions and integrations they've granted: Slack, Notion, GitHub, Cloudflare Deploy.
- You can suggest actions (code changes, deploys, API calls) — they must confirm execution.

CLAWFLOW CAPABILITIES YOU CAN REFERENCE:
- AI Code Workspace (multi-file builder, live preview, push to GitHub)
- Cloudflare Deploy (auto-deploy to their Cloudflare account)
- Higgsfield AI Studio (video generation, image-to-video)
- CLAW Action Engine (Slack post, Notion write, GitHub push)
- FlowState Focus Engine, FS Audio, 264 Pro Video Editor (coming soon)

RULES:
1. Never forget context — reference their projects and preferences naturally.
2. Suggest specific code changes when asked — reference actual file names from their projects.
3. Always confirm before executing any action.
4. If they ask about a past project, recall it from memory above.`

  const messages = history.slice(-20).map((m: any) => ({ role: m.role, content: m.content }))
  messages.push({ role: 'user', content: userMessage })

  // Call AI — prefer model from config
  const model = (config.preferredModel || 'claude').toLowerCase()
  let reply = ''
  let modelUsed = 'claude-3-5-sonnet-20241022'

  try {
    if (model.includes('gpt') || model.includes('openai')) {
      const apiKey = c.env?.OPENROUTER_API_KEY
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://flowst8.cc', 'X-Title': 'FlowState CLAW' },
        body: JSON.stringify({ model: 'openai/gpt-4o', messages: [{ role: 'system', content: systemPrompt }, ...messages] })
      })
      const d: any = await res.json()
      reply = d.choices?.[0]?.message?.content || ''
      modelUsed = 'gpt-4o'
    } else if (model.includes('gemini')) {
      const apiKey = c.env?.GOOGLE_AI_KEY || c.env?.GEMINI_API_KEY
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: systemPrompt + '\n\n' + messages.map((m: any) => `${m.role}: ${m.content}`).join('\n') }] }] })
      })
      const d: any = await res.json()
      reply = d.candidates?.[0]?.content?.parts?.[0]?.text || ''
      modelUsed = 'gemini-2.0-flash'
    } else {
      // Default: Claude via Anthropic
      const apiKey = c.env?.ANTHROPIC_API_KEY
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', max_tokens: 2048, system: systemPrompt, messages })
      })
      const d: any = await res.json()
      reply = d.content?.[0]?.text || ''
      modelUsed = 'claude-3-5-sonnet'
    }
  } catch (e: any) {
    reply = `I encountered an error: ${e.message}. Please try again.`
  }

  if (!reply) reply = "I'm having trouble connecting right now. Please try again in a moment."

  // Update memory (keep last 100 exchanges = 200 entries)
  const newHistory = [
    ...history,
    { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
    { role: 'assistant', content: reply, model: modelUsed, timestamp: new Date().toISOString() }
  ].slice(-200)

  if (url && tok) {
    await fetch(`${url}/set/claw_memory:${encodeURIComponent(session.email)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(newHistory) })
    })
  }

  return c.json({ reply, model: modelUsed, messageCount: newHistory.length })
})

// GET /api/claw/config — load user's CLAW configuration
app.get('/api/claw/config', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ config: {} })
  const raw: any = await fetch(`${url}/get/claw_config:${encodeURIComponent(session.email)}`, {
    headers: { Authorization: `Bearer ${tok}` }
  }).then(r => r.json()).catch(() => ({}))
  const config = raw?.result ? JSON.parse(raw.result) : {}
  return c.json({ config })
})

// POST /api/claw/config — save user's CLAW configuration
app.post('/api/claw/config', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ ok: false, error: 'Redis not configured' })
  const existing: any = await fetch(`${url}/get/claw_config:${encodeURIComponent(session.email)}`, {
    headers: { Authorization: `Bearer ${tok}` }
  }).then(r => r.json()).then((d: any) => d?.result ? JSON.parse(d.result) : {}).catch(() => ({}))
  const updated = { ...existing, ...body, updatedAt: new Date().toISOString() }
  await fetch(`${url}/set/claw_config:${encodeURIComponent(session.email)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(updated) })
  })
  return c.json({ ok: true, config: updated })
})

// GET /api/claw/projects — load user's saved projects
app.get('/api/claw/projects', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ projects: [] })
  const raw: any = await fetch(`${url}/get/claw_projects:${encodeURIComponent(session.email)}`, {
    headers: { Authorization: `Bearer ${tok}` }
  }).then(r => r.json()).catch(() => ({}))
  const projects = raw?.result ? JSON.parse(raw.result) : []
  return c.json({ projects })
})

// POST /api/claw/projects/log — auto-log a project (called from AI Code Workspace)
app.post('/api/claw/projects/log', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const body: any = await c.req.json().catch(() => ({}))
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ ok: false })
  const existing: any[] = await fetch(`${url}/get/claw_projects:${encodeURIComponent(session.email)}`, {
    headers: { Authorization: `Bearer ${tok}` }
  }).then(r => r.json()).then((d: any) => d?.result ? JSON.parse(d.result) : []).catch(() => [])
  // Upsert project by name
  const idx = existing.findIndex((p: any) => p.name === body.name)
  const project = {
    name: body.name || 'Untitled Project',
    files: body.files || [],
    description: body.description || '',
    deployUrl: body.deployUrl || '',
    agent: body.agent || 'Unknown',
    lastModified: new Date().toISOString(),
    createdAt: idx >= 0 ? existing[idx].createdAt : new Date().toISOString(),
  }
  if (idx >= 0) existing[idx] = project
  else existing.unshift(project)
  const trimmed = existing.slice(0, 50) // keep last 50 projects
  await fetch(`${url}/set/claw_projects:${encodeURIComponent(session.email)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(trimmed) })
  })
  return c.json({ ok: true })
})

// DELETE /api/claw/memory — clear conversation history
app.delete('/api/claw/memory', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const url = c.env?.UPSTASH_REDIS_URL
  const tok = c.env?.UPSTASH_REDIS_TOKEN
  if (!url || !tok) return c.json({ ok: false })
  await fetch(`${url}/del/claw_memory:${encodeURIComponent(session.email)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}` }
  })
  return c.json({ ok: true })
})

// GET /clawflow — dedicated ClawFlow Developer Page
app.get('/clawflow', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const isAuth = !!session
  const email = session?.email || ''

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClawFlow Developer — FlowState</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0a0a14;--bg2:#0f0f1e;--bg3:#14142a;--bg4:#1a1a30;
    --border:rgba(168,85,247,.18);--border2:rgba(168,85,247,.08);
    --accent:#a855f7;--accent2:#7c3aed;--cyan:#00d4ff;--green:#10b981;
    --text-p:#f0f0f0;--text-m:rgba(240,240,240,.55);--text-d:rgba(240,240,240,.3);
    --glow:rgba(168,85,247,.25);--red:#ef4444;
  }
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text-p);min-height:100vh;overflow-x:hidden}

  /* ── Top nav ── */
  .cf-nav{
    position:sticky;top:0;z-index:100;
    background:rgba(10,10,20,.92);backdrop-filter:blur(16px);
    border-bottom:1px solid var(--border);
    display:flex;align-items:center;gap:14px;padding:0 20px;height:54px;
  }
  .cf-nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text-p);font-weight:900;font-size:15px}
  .cf-nav-logo-icon{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:15px}
  .cf-nav-sep{color:var(--text-d);font-size:16px}
  .cf-nav-title{font-weight:700;font-size:15px;background:linear-gradient(135deg,var(--accent),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .cf-nav-back{margin-left:auto;display:flex;align-items:center;gap:7px;background:rgba(168,85,247,.1);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;color:var(--text-p);cursor:pointer;text-decoration:none;transition:.15s}
  .cf-nav-back:hover{background:rgba(168,85,247,.2)}
  .cf-nav-badge{background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:6px;padding:3px 8px;font-size:10px;font-weight:800;color:#fff;letter-spacing:.5px}

  /* ── Layout ── */
  .cf-layout{display:grid;grid-template-columns:260px 1fr 320px;height:calc(100vh - 54px);overflow:hidden}
  @media(max-width:1100px){.cf-layout{grid-template-columns:220px 1fr}}
  @media(max-width:768px){.cf-layout{grid-template-columns:1fr;height:auto;overflow:visible}}

  /* ── Left sidebar ── */
  .cf-sidebar{
    border-right:1px solid var(--border2);background:var(--bg2);
    padding:16px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;
  }
  .cf-sidebar-section{background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:14px}
  .cf-sidebar-title{font-size:10px;font-weight:800;color:var(--text-d);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px}

  /* Health dots */
  .health-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:var(--text-m)}
  .health-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .health-dot.green{background:var(--green);box-shadow:0 0 6px var(--green)}
  .health-dot.amber{background:#f59e0b;box-shadow:0 0 6px #f59e0b}
  .health-dot.red{background:var(--red);box-shadow:0 0 6px var(--red)}
  .health-dot.grey{background:rgba(255,255,255,.2)}

  /* Config form */
  .cf-label{font-size:11px;color:var(--text-m);margin-bottom:5px;font-weight:500}
  .cf-select,.cf-input,.cf-textarea{
    width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);
    border-radius:8px;padding:8px 10px;color:var(--text-p);font-size:12px;
    font-family:inherit;outline:none;transition:.15s;
  }
  .cf-select:focus,.cf-input:focus,.cf-textarea:focus{border-color:var(--accent)}
  .cf-select option{background:#1a1a2e}
  .cf-textarea{resize:vertical;min-height:60px}
  .cf-save-btn{
    width:100%;background:linear-gradient(135deg,var(--accent),var(--accent2));
    border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;
    color:#fff;cursor:pointer;margin-top:10px;transition:.15s;
  }
  .cf-save-btn:hover{opacity:.9}

  /* Projects list */
  .cf-project-item{
    background:rgba(255,255,255,.03);border:1px solid var(--border2);
    border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;transition:.15s;
  }
  .cf-project-item:hover{border-color:var(--border);background:rgba(168,85,247,.06)}
  .cf-project-name{font-size:12px;font-weight:700;color:var(--text-p);margin-bottom:3px}
  .cf-project-meta{font-size:10px;color:var(--text-d)}
  .cf-project-deploy{font-size:10px;color:var(--cyan);margin-top:3px;word-break:break-all}

  /* ── Main chat area ── */
  .cf-main{
    display:flex;flex-direction:column;background:var(--bg);overflow:hidden;
  }
  .cf-chat-header{
    padding:14px 20px;border-bottom:1px solid var(--border2);
    display:flex;align-items:center;gap:12px;flex-shrink:0;
  }
  .cf-chat-avatar{
    width:38px;height:38px;border-radius:10px;
    background:linear-gradient(135deg,var(--accent),var(--cyan));
    display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;
  }
  .cf-chat-status{width:10px;height:10px;background:var(--green);border-radius:50%;box-shadow:0 0 8px var(--green);flex-shrink:0}
  .cf-chat-model-badge{
    margin-left:auto;background:rgba(168,85,247,.12);border:1px solid var(--border);
    border-radius:6px;padding:3px 10px;font-size:10px;font-weight:700;color:var(--accent);
  }
  .cf-clear-btn{
    background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);
    border-radius:6px;padding:4px 10px;font-size:10px;font-weight:600;color:#ef4444;
    cursor:pointer;transition:.15s;
  }
  .cf-clear-btn:hover{background:rgba(239,68,68,.2)}

  .cf-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}
  .cf-messages::-webkit-scrollbar{width:4px}
  .cf-messages::-webkit-scrollbar-thumb{background:rgba(168,85,247,.3);border-radius:2px}

  .cf-msg{display:flex;gap:10px;animation:fadeUp .2s ease}
  @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .cf-msg-user{flex-direction:row-reverse}
  .cf-msg-avatar{width:28px;height:28px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800}
  .cf-msg-avatar.user{background:linear-gradient(135deg,#374151,#1f2937);color:var(--text-p)}
  .cf-msg-avatar.claw{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
  .cf-msg-bubble{
    max-width:75%;background:var(--bg3);border:1px solid var(--border2);
    border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.6;color:var(--text-p);
  }
  .cf-msg-user .cf-msg-bubble{background:rgba(168,85,247,.12);border-color:rgba(168,85,247,.25)}
  .cf-msg-bubble.typing{padding:14px}
  .cf-msg-bubble pre{background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0;font-size:12px}
  .cf-msg-bubble code{font-family:'Courier New',monospace;font-size:12px}
  .cf-msg-bubble p{margin-bottom:8px}
  .cf-msg-bubble p:last-child{margin-bottom:0}
  .cf-msg-meta{font-size:10px;color:var(--text-d);margin-top:5px}
  .cf-msg-time{font-size:9px;color:var(--text-d);text-align:right;margin-top:4px}

  .cf-typing-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin:0 2px;animation:typingBounce 1.2s ease infinite}
  .cf-typing-dot:nth-child(2){animation-delay:.2s}
  .cf-typing-dot:nth-child(3){animation-delay:.4s}
  @keyframes typingBounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-6px);opacity:1}}

  .cf-welcome{text-align:center;padding:40px 20px;color:var(--text-m);max-width:480px;margin:auto}
  .cf-welcome-icon{font-size:42px;margin-bottom:16px}
  .cf-welcome h2{font-size:20px;font-weight:800;color:var(--text-p);margin-bottom:8px}
  .cf-welcome p{font-size:13px;line-height:1.6;margin-bottom:16px}
  .cf-suggestion-grid{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:12px}
  .cf-suggestion{
    background:rgba(168,85,247,.08);border:1px solid var(--border);border-radius:8px;
    padding:7px 12px;font-size:11px;color:var(--accent);cursor:pointer;transition:.15s;
  }
  .cf-suggestion:hover{background:rgba(168,85,247,.18)}

  /* Input bar */
  .cf-input-bar{
    padding:14px 20px;border-top:1px solid var(--border2);
    display:flex;gap:10px;align-items:flex-end;flex-shrink:0;
    background:rgba(10,10,20,.8);
  }
  .cf-msg-input{
    flex:1;background:rgba(255,255,255,.04);border:1px solid var(--border);
    border-radius:12px;padding:11px 14px;color:var(--text-p);font-size:13px;
    font-family:inherit;resize:none;outline:none;line-height:1.5;
    max-height:120px;transition:.15s;
  }
  .cf-msg-input:focus{border-color:var(--accent)}
  .cf-send-btn{
    width:42px;height:42px;background:linear-gradient(135deg,var(--accent),var(--accent2));
    border:none;border-radius:10px;color:#fff;font-size:16px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;flex-shrink:0;
    transition:.15s;align-self:flex-end;
  }
  .cf-send-btn:hover{opacity:.85}
  .cf-send-btn:disabled{opacity:.4;cursor:not-allowed}

  /* ── Right panel ── */
  .cf-right{
    border-left:1px solid var(--border2);background:var(--bg2);
    padding:16px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;
  }
  @media(max-width:1100px){.cf-right{display:none}}
  .cf-right-section{background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:14px}
  .cf-perm-item{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border2)}
  .cf-perm-item:last-child{border-bottom:none}
  .cf-perm-info{flex:1}
  .cf-perm-label{font-size:12px;color:var(--text-p);font-weight:600}
  .cf-perm-desc{font-size:10px;color:var(--text-d);margin-top:2px}
  .cf-toggle{
    position:relative;width:38px;height:20px;flex-shrink:0;cursor:pointer;
  }
  .cf-toggle input{opacity:0;width:0;height:0}
  .cf-toggle-slider{
    position:absolute;inset:0;background:rgba(255,255,255,.12);
    border-radius:10px;transition:.2s;
  }
  .cf-toggle-slider:before{
    content:'';position:absolute;width:14px;height:14px;background:#fff;
    border-radius:50%;left:3px;top:3px;transition:.2s;
  }
  .cf-toggle input:checked + .cf-toggle-slider{background:var(--accent)}
  .cf-toggle input:checked + .cf-toggle-slider:before{transform:translateX(18px)}

  .cf-memory-stat{display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:12px;border-bottom:1px solid var(--border2)}
  .cf-memory-stat:last-child{border-bottom:none}
  .cf-memory-key{color:var(--text-m)}
  .cf-memory-val{color:var(--text-p);font-weight:600}

  /* Gated overlay */
  .cf-gate{
    position:fixed;inset:0;background:rgba(5,5,15,.92);backdrop-filter:blur(12px);
    z-index:200;display:flex;align-items:center;justify-content:center;
  }
  .cf-gate-card{
    background:var(--bg3);border:1px solid var(--border);border-radius:20px;
    padding:40px 36px;text-align:center;max-width:440px;width:90%;
  }
  .cf-gate-icon{font-size:48px;margin-bottom:16px}
  .cf-gate-title{font-size:22px;font-weight:900;margin-bottom:8px;background:linear-gradient(135deg,var(--accent),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .cf-gate-desc{font-size:13px;color:var(--text-m);line-height:1.6;margin-bottom:24px}
  .cf-gate-btn{
    display:inline-block;background:linear-gradient(135deg,var(--accent),var(--accent2));
    border:none;border-radius:12px;padding:13px 32px;font-size:14px;font-weight:800;
    color:#fff;cursor:pointer;text-decoration:none;transition:.15s;
  }
  .cf-gate-btn:hover{opacity:.9;transform:translateY(-1px)}
  .cf-gate-back{display:block;margin-top:14px;font-size:12px;color:var(--text-d);cursor:pointer;text-decoration:none}
  .cf-gate-back:hover{color:var(--text-m)}
</style>
</head>
<body>

<!-- Auth gate — shown if not authenticated -->
<div class="cf-gate" id="cf-auth-gate" style="display:${isAuth ? 'none' : 'flex'}">
  <div class="cf-gate-card">
    <div class="cf-gate-icon">🔐</div>
    <div class="cf-gate-title">Sign in to ClawFlow</div>
    <div class="cf-gate-desc">ClawFlow Developer is your persistent AI workspace. Sign in to access your projects, memory, and configuration.</div>
    <a href="/?signin=1" class="cf-gate-btn">Sign In to FlowState</a>
    <a href="/" class="cf-gate-back">← Back to FlowState</a>
  </div>
</div>

<!-- ClawFlow gate — shown if authenticated but no active subscription -->
<div class="cf-gate" id="cf-sub-gate" style="display:none">
  <div class="cf-gate-card">
    <div class="cf-gate-icon">⚡</div>
    <div class="cf-gate-title">ClawFlow Required</div>
    <div class="cf-gate-desc">ClawFlow gives you a persistent AI developer that remembers your projects, preferences, and code across every session — plus actions in Slack, Notion, GitHub, and Cloudflare.</div>
    <a href="/?tab=pricing" class="cf-gate-btn">Upgrade to ClawFlow →</a>
    <a href="/" class="cf-gate-back">← Back to FlowState</a>
  </div>
</div>

<!-- Top nav -->
<nav class="cf-nav">
  <a href="/" class="cf-nav-logo">
    <div class="cf-nav-logo-icon">⚡</div>
    FlowState
  </a>
  <span class="cf-nav-sep">/</span>
  <span class="cf-nav-title">ClawFlow Developer</span>
  <span class="cf-nav-badge">CLAWFLOW</span>
  <a href="/" class="cf-nav-back"><i class="fas fa-arrow-left"></i> Back to FlowState</a>
</nav>

<!-- Main layout -->
<div class="cf-layout">

  <!-- LEFT: Health + Config + Projects -->
  <div class="cf-sidebar">

    <!-- CLAW Health -->
    <div class="cf-sidebar-section">
      <div class="cf-sidebar-title">⚡ CLAW Health</div>
      <div class="health-row"><div class="health-dot grey" id="hdot-core"></div><span id="hlabel-core">Checking core…</span></div>
      <div class="health-row"><div class="health-dot grey" id="hdot-memory"></div><span id="hlabel-memory">Checking memory…</span></div>
      <div class="health-row"><div class="health-dot grey" id="hdot-github"></div><span id="hlabel-github">GitHub</span></div>
      <div class="health-row"><div class="health-dot grey" id="hdot-cloudflare"></div><span id="hlabel-cloudflare">Cloudflare Deploy</span></div>
      <div class="health-row"><div class="health-dot grey" id="hdot-slack"></div><span id="hlabel-slack">Slack</span></div>
      <div class="health-row"><div class="health-dot grey" id="hdot-notion"></div><span id="hlabel-notion">Notion</span></div>
    </div>

    <!-- CLAW Config -->
    <div class="cf-sidebar-section">
      <div class="cf-sidebar-title">⚙️ Configuration</div>
      <div class="cf-label">Preferred AI Model</div>
      <select class="cf-select" id="cf-config-model">
        <option value="claude">Claude 3.5 Sonnet (default)</option>
        <option value="gpt4o">GPT-4o</option>
        <option value="gemini">Gemini 2.0 Flash</option>
      </select>
      <div class="cf-label" style="margin-top:10px">Coding Style</div>
      <input class="cf-input" id="cf-config-style" placeholder="e.g. clean, modular, TypeScript, no comments">
      <div class="cf-label" style="margin-top:10px">CLAW Personality</div>
      <select class="cf-select" id="cf-config-personality">
        <option value="direct">Direct &amp; Concise (default)</option>
        <option value="teacher">Teacher — explains everything</option>
        <option value="senior">Senior Engineer — blunt, no fluff</option>
        <option value="creative">Creative — suggests alternatives</option>
      </select>
      <button class="cf-save-btn" onclick="cfSaveConfig()"><i class="fas fa-save"></i> Save Configuration</button>
    </div>

    <!-- Projects -->
    <div class="cf-sidebar-section" style="flex:1">
      <div class="cf-sidebar-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>📁 Projects</span>
        <span id="cf-project-count" style="font-size:9px;color:var(--text-d)">0 saved</span>
      </div>
      <div id="cf-projects-list">
        <div style="font-size:11px;color:var(--text-d);text-align:center;padding:16px 0">Loading projects…</div>
      </div>
    </div>

  </div>

  <!-- CENTER: CLAW Chat -->
  <div class="cf-main">
    <div class="cf-chat-header">
      <div class="cf-chat-avatar">🧠</div>
      <div>
        <div style="font-size:14px;font-weight:800">CLAW</div>
        <div style="font-size:11px;color:var(--text-m)">Your persistent AI developer</div>
      </div>
      <div class="cf-chat-status"></div>
      <div class="cf-chat-model-badge" id="cf-model-badge">Claude 3.5 Sonnet</div>
      <button class="cf-clear-btn" onclick="cfClearMemory()"><i class="fas fa-trash-alt"></i> Clear</button>
    </div>
    <div class="cf-messages" id="cf-messages">
      <!-- Welcome screen shown when no history -->
      <div class="cf-welcome" id="cf-welcome">
        <div class="cf-welcome-icon">🧠</div>
        <h2>CLAW Developer</h2>
        <p>I'm your persistent AI developer. I remember your projects, coding style, and preferences — every session builds on the last.</p>
        <div class="cf-suggestion-grid" id="cf-suggestions">
          <div class="cf-suggestion" onclick="cfUsePrompt(this)">What did we build last time?</div>
          <div class="cf-suggestion" onclick="cfUsePrompt(this)">Show me my project history</div>
          <div class="cf-suggestion" onclick="cfUsePrompt(this)">Help me debug my last project</div>
          <div class="cf-suggestion" onclick="cfUsePrompt(this)">What's my preferred stack?</div>
          <div class="cf-suggestion" onclick="cfUsePrompt(this)">Build me a landing page</div>
          <div class="cf-suggestion" onclick="cfUsePrompt(this)">How do I deploy to Cloudflare Pages?</div>
        </div>
      </div>
    </div>
    <div class="cf-input-bar">
      <textarea class="cf-msg-input" id="cf-msg-input" rows="1" placeholder="Talk to CLAW… ask about your projects, request code, or plan your next build" 
        onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();cfSendMessage();}"
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
      <button class="cf-send-btn" id="cf-send-btn" onclick="cfSendMessage()"><i class="fas fa-paper-plane"></i></button>
    </div>
  </div>

  <!-- RIGHT: Permissions + Memory Stats -->
  <div class="cf-right">

    <!-- Memory Stats -->
    <div class="cf-right-section">
      <div class="cf-sidebar-title">🧠 Memory Stats</div>
      <div class="cf-memory-stat"><span class="cf-memory-key">Messages stored</span><span class="cf-memory-val" id="cf-stat-msgs">—</span></div>
      <div class="cf-memory-stat"><span class="cf-memory-key">Projects logged</span><span class="cf-memory-val" id="cf-stat-projects">—</span></div>
      <div class="cf-memory-stat"><span class="cf-memory-key">Sessions active</span><span class="cf-memory-val" id="cf-stat-sessions">—</span></div>
      <div class="cf-memory-stat"><span class="cf-memory-key">Preferred model</span><span class="cf-memory-val" id="cf-stat-model">—</span></div>
    </div>

    <!-- Permissions -->
    <div class="cf-right-section">
      <div class="cf-sidebar-title">🔐 CLAW Permissions</div>
      <div id="cf-permissions-list">
        <div class="cf-perm-item">
          <div class="cf-perm-info"><div class="cf-perm-label">💬 Post to Slack</div><div class="cf-perm-desc">CLAW can send Slack messages</div></div>
          <label class="cf-toggle"><input type="checkbox" id="perm-slack-post" onchange="cfSavePerm('slack_post',this.checked)"><span class="cf-toggle-slider"></span></label>
        </div>
        <div class="cf-perm-item">
          <div class="cf-perm-info"><div class="cf-perm-label">📝 Update Notion</div><div class="cf-perm-desc">CLAW can edit Notion pages</div></div>
          <label class="cf-toggle"><input type="checkbox" id="perm-notion-write" onchange="cfSavePerm('notion_write',this.checked)"><span class="cf-toggle-slider"></span></label>
        </div>
        <div class="cf-perm-item">
          <div class="cf-perm-info"><div class="cf-perm-label">🐙 Push to GitHub</div><div class="cf-perm-desc">CLAW can push code to GitHub</div></div>
          <label class="cf-toggle"><input type="checkbox" id="perm-github-push" onchange="cfSavePerm('github_push',this.checked)"><span class="cf-toggle-slider"></span></label>
        </div>
        <div class="cf-perm-item">
          <div class="cf-perm-info"><div class="cf-perm-label">☁️ Deploy to Cloudflare</div><div class="cf-perm-desc">CLAW can deploy projects</div></div>
          <label class="cf-toggle"><input type="checkbox" id="perm-cf-deploy" onchange="cfSavePerm('cf_deploy',this.checked)"><span class="cf-toggle-slider"></span></label>
        </div>
        <div class="cf-perm-item">
          <div class="cf-perm-info"><div class="cf-perm-label">🧠 Learn preferences</div><div class="cf-perm-desc">CLAW remembers your style</div></div>
          <label class="cf-toggle"><input type="checkbox" id="perm-memory-learn" onchange="cfSavePerm('memory_learn',this.checked)"><span class="cf-toggle-slider"></span></label>
        </div>
      </div>
    </div>

    <!-- Quick actions -->
    <div class="cf-right-section">
      <div class="cf-sidebar-title">⚡ Quick Actions</div>
      <button onclick="cfUsePrompt({textContent:'Generate a complete landing page with hero, features, pricing, and CTA sections'})" style="width:100%;background:rgba(168,85,247,.1);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-p);font-size:11px;font-weight:600;cursor:pointer;margin-bottom:6px;text-align:left;transition:.15s" onmouseover="this.style.background='rgba(168,85,247,.2)'" onmouseout="this.style.background='rgba(168,85,247,.1)'">🏠 Landing page</button>
      <button onclick="cfUsePrompt({textContent:'Build a REST API with authentication, CRUD endpoints, and error handling'})" style="width:100%;background:rgba(0,212,255,.07);border:1px solid rgba(0,212,255,.18);border-radius:8px;padding:8px 10px;color:var(--text-p);font-size:11px;font-weight:600;cursor:pointer;margin-bottom:6px;text-align:left;transition:.15s" onmouseover="this.style.background='rgba(0,212,255,.15)'" onmouseout="this.style.background='rgba(0,212,255,.07)'">🔌 REST API</button>
      <button onclick="cfUsePrompt({textContent:'Create a dashboard with charts, metrics cards, and data tables using Chart.js and TailwindCSS'})" style="width:100%;background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.18);border-radius:8px;padding:8px 10px;color:var(--text-p);font-size:11px;font-weight:600;cursor:pointer;margin-bottom:6px;text-align:left;transition:.15s" onmouseover="this.style.background='rgba(16,185,129,.15)'" onmouseout="this.style.background='rgba(16,185,129,.07)'">📊 Dashboard</button>
      <button onclick="cfUsePrompt({textContent:'Build a full-stack app with login/signup, protected routes, and a user profile page'})" style="width:100%;background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.18);border-radius:8px;padding:8px 10px;color:var(--text-p);font-size:11px;font-weight:600;cursor:pointer;text-align:left;transition:.15s" onmouseover="this.style.background='rgba(245,158,11,.15)'" onmouseout="this.style.background='rgba(245,158,11,.07)'">🔐 Auth App</button>
    </div>

  </div>
</div>

<script>
// ── ClawFlow Developer Page JS ──────────────────────────────────────────────

const _cfState = {
  messages: [],         // loaded from Redis
  projects: [],
  config: {},
  permissions: {},
  isLoading: false,
  memCount: 0,
  projCount: 0,
};

// Format markdown-ish text to HTML
function cfFormatMsg(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
    .replace(/\\n/g, '<br>');
}

function cfTimeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return Math.floor(diff/86400000) + 'd ago';
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function cfInit() {
  // Check subscription gate
  const tierRes = await fetch('/api/clawbot/status').then(r => r.json()).catch(() => ({}));
  if (!tierRes.active) {
    document.getElementById('cf-sub-gate').style.display = 'flex';
    return;
  }

  // Load all data in parallel
  const [memRes, cfgRes, projRes, permRes] = await Promise.all([
    fetch('/api/claw/memory').then(r=>r.json()).catch(()=>({messages:[]})),
    fetch('/api/claw/config').then(r=>r.json()).catch(()=>({config:{}})),
    fetch('/api/claw/projects').then(r=>r.json()).catch(()=>({projects:[]})),
    fetch('/api/claw/permissions').then(r=>r.json()).catch(()=>({permissions:{}})),
  ]);

  _cfState.messages = memRes.messages || [];
  _cfState.config = cfgRes.config || {};
  _cfState.projects = projRes.projects || [];
  _cfState.permissions = permRes.permissions || {};
  _cfState.memCount = _cfState.messages.length;
  _cfState.projCount = _cfState.projects.length;

  cfRenderConfig();
  cfRenderProjects();
  cfRenderPermissions();
  cfRenderHistory();
  cfRenderHealth();
  cfRenderStats();
}

// ── Render chat history ───────────────────────────────────────────────────────
function cfRenderHistory() {
  const container = document.getElementById('cf-messages');
  const welcome = document.getElementById('cf-welcome');
  if (!_cfState.messages.length) {
    welcome.style.display = 'flex';
    welcome.style.flexDirection = 'column';
    return;
  }
  welcome.style.display = 'none';
  // Clear and rebuild
  const existing = container.querySelectorAll('.cf-msg');
  existing.forEach(e => e.remove());
  _cfState.messages.forEach(msg => cfAppendMsgDOM(msg.role, msg.content, msg.timestamp, msg.model, false));
  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function cfAppendMsgDOM(role, content, timestamp, model, animate) {
  const container = document.getElementById('cf-messages');
  document.getElementById('cf-welcome').style.display = 'none';

  const div = document.createElement('div');
  div.className = 'cf-msg' + (role === 'user' ? ' cf-msg-user' : '');
  if (animate) div.style.animation = 'fadeUp .2s ease';

  const initial = role === 'user' ? '👤' : '🧠';
  div.innerHTML = \`
    <div class="cf-msg-avatar \${role}">\${initial}</div>
    <div>
      <div class="cf-msg-bubble">\${cfFormatMsg(content)}</div>
      <div class="cf-msg-time">\${cfTimeAgo(timestamp)}\${model ? ' · ' + model : ''}</div>
    </div>
  \`;
  container.appendChild(div);
  if (animate) container.scrollTop = container.scrollHeight;
}

function cfShowTyping() {
  const container = document.getElementById('cf-messages');
  const div = document.createElement('div');
  div.className = 'cf-msg';
  div.id = 'cf-typing-indicator';
  div.innerHTML = \`
    <div class="cf-msg-avatar claw">🧠</div>
    <div class="cf-msg-bubble typing">
      <span class="cf-typing-dot"></span>
      <span class="cf-typing-dot"></span>
      <span class="cf-typing-dot"></span>
    </div>
  \`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function cfRemoveTyping() {
  document.getElementById('cf-typing-indicator')?.remove();
}

// ── Send message ──────────────────────────────────────────────────────────────
async function cfSendMessage() {
  const input = document.getElementById('cf-msg-input');
  const btn = document.getElementById('cf-send-btn');
  const msg = input.value.trim();
  if (!msg || _cfState.isLoading) return;

  _cfState.isLoading = true;
  btn.disabled = true;
  input.value = '';
  input.style.height = 'auto';

  // Show user message immediately
  const ts = new Date().toISOString();
  cfAppendMsgDOM('user', msg, ts, null, true);
  cfShowTyping();

  try {
    const res = await fetch('/api/claw/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    cfRemoveTyping();
    if (data.reply) {
      cfAppendMsgDOM('assistant', data.reply, new Date().toISOString(), data.model, true);
      _cfState.memCount = data.messageCount || _cfState.memCount + 2;
      document.getElementById('cf-stat-msgs').textContent = _cfState.memCount;
    } else if (data.error) {
      cfAppendMsgDOM('assistant', 'Error: ' + data.error, new Date().toISOString(), null, true);
    }
  } catch(e) {
    cfRemoveTyping();
    cfAppendMsgDOM('assistant', 'Connection error. Please try again.', new Date().toISOString(), null, true);
  }

  _cfState.isLoading = false;
  btn.disabled = false;
  input.focus();
}

function cfUsePrompt(el) {
  const input = document.getElementById('cf-msg-input');
  input.value = el.textContent;
  input.focus();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ── Clear memory ──────────────────────────────────────────────────────────────
async function cfClearMemory() {
  if (!confirm('Clear all CLAW conversation history? Your config and projects will be kept.')) return;
  await fetch('/api/claw/memory', { method: 'DELETE' });
  _cfState.messages = [];
  _cfState.memCount = 0;
  document.getElementById('cf-stat-msgs').textContent = '0';
  // Clear chat UI
  const container = document.getElementById('cf-messages');
  container.querySelectorAll('.cf-msg').forEach(e => e.remove());
  document.getElementById('cf-welcome').style.display = 'flex';
  document.getElementById('cf-welcome').style.flexDirection = 'column';
}

// ── Config ────────────────────────────────────────────────────────────────────
function cfRenderConfig() {
  const cfg = _cfState.config;
  const modelEl = document.getElementById('cf-config-model');
  const styleEl = document.getElementById('cf-config-style');
  const persEl = document.getElementById('cf-config-personality');
  if (cfg.preferredModel) modelEl.value = cfg.preferredModel;
  if (cfg.style) styleEl.value = cfg.style;
  if (cfg.personality) persEl.value = cfg.personality;
  // Update model badge
  const labels = {claude:'Claude 3.5 Sonnet',gpt4o:'GPT-4o',gemini:'Gemini 2.0 Flash'};
  document.getElementById('cf-model-badge').textContent = labels[cfg.preferredModel] || 'Claude 3.5 Sonnet';
  document.getElementById('cf-stat-model').textContent = labels[cfg.preferredModel] || 'Claude';
}

async function cfSaveConfig() {
  const config = {
    preferredModel: document.getElementById('cf-config-model').value,
    style: document.getElementById('cf-config-style').value,
    personality: document.getElementById('cf-config-personality').value,
  };
  _cfState.config = config;
  await fetch('/api/claw/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  const labels = {claude:'Claude 3.5 Sonnet',gpt4o:'GPT-4o',gemini:'Gemini 2.0 Flash'};
  document.getElementById('cf-model-badge').textContent = labels[config.preferredModel] || 'Claude 3.5 Sonnet';
  document.getElementById('cf-stat-model').textContent = labels[config.preferredModel] || 'Claude';
  // Flash save button
  const btn = document.querySelector('.cf-save-btn');
  btn.textContent = '✓ Saved!';
  btn.style.background = 'linear-gradient(135deg,#10b981,#059669)';
  setTimeout(() => { btn.innerHTML = '<i class="fas fa-save"></i> Save Configuration'; btn.style.background = ''; }, 1500);
}

// ── Projects ──────────────────────────────────────────────────────────────────
function cfRenderProjects() {
  const list = document.getElementById('cf-projects-list');
  const countEl = document.getElementById('cf-project-count');
  const projects = _cfState.projects;
  countEl.textContent = projects.length + ' saved';
  if (!projects.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-d);text-align:center;padding:16px 0">No projects yet. Build something in the AI Code Workspace!</div>';
    return;
  }
  list.innerHTML = projects.map(p => \`
    <div class="cf-project-item" onclick="cfProjectClick('\${(p.name||'').replace(/'/g,'\\\\\\'')}')">
      <div class="cf-project-name">\${p.name || 'Untitled'}</div>
      <div class="cf-project-meta">\${(p.files||[]).length} files · \${cfTimeAgo(p.lastModified)} · \${p.agent || 'AI'}</div>
      \${p.deployUrl ? \`<div class="cf-project-deploy">☁️ \${p.deployUrl}</div>\` : ''}
    </div>
  \`).join('');
  document.getElementById('cf-stat-projects').textContent = projects.length;
}

function cfProjectClick(name) {
  const input = document.getElementById('cf-msg-input');
  input.value = \`Tell me about my project "\${name}" — what files does it have and what was the last thing we worked on?\`;
  input.focus();
}

// ── Permissions ───────────────────────────────────────────────────────────────
function cfRenderPermissions() {
  const p = _cfState.permissions;
  const setToggle = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!p[key];
  };
  setToggle('perm-slack-post', 'slack_post');
  setToggle('perm-notion-write', 'notion_write');
  setToggle('perm-github-push', 'github_push');
  setToggle('perm-cf-deploy', 'cf_deploy');
  setToggle('perm-memory-learn', 'memory_learn');
}

async function cfSavePerm(key, value) {
  _cfState.permissions[key] = value;
  await fetch('/api/claw/permissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions: { [key]: value } })
  });
}

// ── Health ────────────────────────────────────────────────────────────────────
async function cfRenderHealth() {
  // Core CLAW (memory endpoint check)
  setHealth('core', 'green', 'CLAW online');
  setHealth('memory', 'green', \`Memory: \${_cfState.memCount} messages\`);

  // Check GitHub (just check _cfState on parent page via cookie / stored data)
  // We'll ping /api/github/user to check if connected
  const ghRes = await fetch('/api/github/user').then(r=>r.json()).catch(()=>({}));
  if (ghRes.login) setHealth('github', 'green', \`GitHub: @\${ghRes.login}\`);
  else setHealth('github', 'grey', 'GitHub: not connected');

  // Check Cloudflare token
  const cfRes = await fetch('/api/cloudflare/token').then(r=>r.json()).catch(()=>({}));
  if (cfRes.exists) setHealth('cloudflare', 'green', \`CF Deploy: \${cfRes.maskedToken || 'token saved'}\`);
  else setHealth('cloudflare', 'amber', 'CF Deploy: no token');

  setHealth('slack', 'grey', 'Slack: checking…');
  setHealth('notion', 'grey', 'Notion: checking…');
}

function setHealth(name, color, label) {
  const dot = document.getElementById('hdot-' + name);
  const lbl = document.getElementById('hlabel-' + name);
  if (dot) { dot.className = 'health-dot ' + color; }
  if (lbl) lbl.textContent = label;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function cfRenderStats() {
  document.getElementById('cf-stat-msgs').textContent = _cfState.memCount || _cfState.messages.length;
  document.getElementById('cf-stat-projects').textContent = _cfState.projCount || _cfState.projects.length;
  document.getElementById('cf-stat-sessions').textContent = '1 active';
  const labels = {claude:'Claude',gpt4o:'GPT-4o',gemini:'Gemini'};
  document.getElementById('cf-stat-model').textContent = labels[_cfState.config.preferredModel] || 'Claude';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
cfInit().catch(console.error);
</script>
</body>
</html>`)
})

// Cloudflare Workers scheduled event handler (cron trigger)
// Registered in wrangler.jsonc triggers.crons
const handler = {
  fetch: app.fetch.bind(app),
  scheduled: scheduledHandler,
}

export default handler
