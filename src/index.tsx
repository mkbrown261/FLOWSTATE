import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
  declareModelRouting, declareTipIntent, declareCelebration,
  declareBehaviorInsight, declareTierCapabilities, declareGoogleOAuth,
  declareNotionOAuth, declareLearnCards, declareRestoreIntent,
  declareSessionBlocking, declareSlackOAuth, declareInviteIntent,
  declareMindfulMinimum, declareOnboardingIntent, declareSprintHealth,
  declareDeadlineAlert, declareBurnoutRisk, declareFlowScore,
  declareSessionContext, declareTeamRoleCapabilities,
  MODEL_REGISTRY, IMAGE_MODEL_REGISTRY, VIDEO_MODEL_REGISTRY, CREDENTIAL_TABLE,
  type SessionIntent, type BehaviorData,
} from './intent-layer'

type Bindings = {
  OPENAI_API_KEY: string; ANTHROPIC_API_KEY: string; GOOGLE_AI_KEY: string
  GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string
  NOTION_CLIENT_ID: string; NOTION_CLIENT_SECRET: string
  SLACK_CLIENT_ID: string; SLACK_CLIENT_SECRET: string; SLACK_BOT_TOKEN: string
  XAI_API_KEY: string; MISTRAL_API_KEY: string; DEEPSEEK_API_KEY: string
  TOGETHER_API_KEY: string; ELEVENLABS_API_KEY: string; STABILITY_API_KEY: string
  BFL_API_KEY: string; RUNWAY_API_KEY: string; IDEOGRAM_API_KEY: string
  STRIPE_SECRET_KEY: string; STRIPE_PUBLISHABLE_KEY: string; STRIPE_WEBHOOK_SECRET: string
  RESEND_API_KEY: string; SESSION_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }))
app.use('/static/*', serveStatic({ root: './' }))

// ─── Session helpers ──────────────────────────────────────────────────────────
function encodeSession(data: object): string { return btoa(JSON.stringify(data)) }
function decodeSession(token: string): any { try { return JSON.parse(atob(token)) } catch { return null } }

// ─── Google OAuth ─────────────────────────────────────────────────────────────
app.get('/api/auth/google', async (c) => {
  const baseUrl = new URL(c.req.url).origin
  const intent = declareGoogleOAuth(baseUrl)
  setCookie(c, 'oauth_state', intent.stateParam, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  const params = new URLSearchParams({
    client_id: c.env?.GOOGLE_CLIENT_ID || '',
    redirect_uri: intent.redirectPath,
    response_type: 'code',
    scope: intent.scopes.join(' '),
    state: intent.stateParam,
    access_type: 'offline',
    prompt: 'consent',
  })
  return c.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params)
})

app.get('/api/auth/google/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  const storedState = getCookie(c, 'oauth_state')
  deleteCookie(c, 'oauth_state', { path: '/' })
  if (error || state !== storedState || !code) return c.html(authErrorPage('Google sign-in was cancelled or failed.'))
  try {
    const baseUrl = new URL(c.req.url).origin
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: c.env?.GOOGLE_CLIENT_ID || '', client_secret: c.env?.GOOGLE_CLIENT_SECRET || '', redirect_uri: baseUrl + '/api/auth/google/callback', grant_type: 'authorization_code' }),
    })
    const tokens: any = await tokenRes.json()
    if (!tokens.access_token) throw new Error('No access token')
    const profile: any = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } })).json()
    const session = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000, name: profile.name, email: profile.email, picture: profile.picture, provider: 'google' }
    setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7*24*3600, path: '/' })
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
  deleteCookie(c, 'fs_onboarded', { path: '/' })
  return c.json({ ok: true })
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
  setCookie(c, 'fs_onboarded', encodeSession({ completed: true, goals, focusDuration, workHoursStart: workHours.start, workHoursEnd: workHours.end, timezone, seedIntegrations: intent.seedIntegrations }), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 365*24*3600, path: '/' })
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

// ─── AI Chat — multi-model streaming ─────────────────────────────────────────
app.post('/api/chat/stream', async (c) => {
  const { message, model: preferredModel, messages: history = [], systemOverride } = await c.req.json()
  const intent = declareModelRouting(message, preferredModel)
  const spec = MODEL_REGISTRY[intent.routedModel]
  if (!spec) return c.json({ error: 'Unknown model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  if (!apiKey) return c.text(getDemoResponse(message, spec.name), 200, { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Routing-Reason': intent.reasoning })
  const systemMsg = systemOverride || intent.systemPrompt
  const allMessages = [...history.slice(-10), { role: 'user', content: message }]
  try {
    if (spec.provider === 'anthropic') {
      const res = await fetch(spec.apiEndpoint, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: spec.apiModel, max_tokens: 2048, system: systemMsg, messages: allMessages, stream: true }) })
      return new Response(await extractAnthropicStream(res), { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel } })
    }
    if (spec.provider === 'google') {
      const res = await fetch(spec.apiEndpoint + '?key=' + apiKey + '&alt=sse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_instruction: { parts: [{ text: systemMsg }] }, contents: allMessages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: 2048 } }) })
      return new Response(await extractGeminiStream(res), { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel } })
    }
    const res = await fetch(spec.apiEndpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: spec.apiModel, messages: [{ role: 'system', content: systemMsg }, ...allMessages], stream: true, max_tokens: 2048 }) })
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

// ─── Image Generation ─────────────────────────────────────────────────────────
app.post('/api/generate/image', async (c) => {
  const { prompt, model: modelId = 'dalle3', size = '1024x1024' } = await c.req.json()
  const spec = IMAGE_MODEL_REGISTRY[modelId as keyof typeof IMAGE_MODEL_REGISTRY]
  if (!spec) return c.json({ error: 'Unknown image model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  if (!apiKey) return c.json({ error: spec.name + ' API key not configured (' + spec.envKey + ')', demo: true, imageUrl: 'https://placehold.co/512x512/1a1a2e/a855f7?text=' + encodeURIComponent(prompt.slice(0,30)) })
  try {
    if (modelId === 'dalle3') {
      const data: any = await (await fetch(spec.apiEndpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size, response_format: 'url' }) })).json()
      return c.json({ imageUrl: data.data?.[0]?.url, revisedPrompt: data.data?.[0]?.revised_prompt })
    }
    if (modelId === 'sd3') {
      const form = new FormData(); form.append('prompt', prompt); form.append('output_format', 'jpeg')
      const data: any = await (await fetch(spec.apiEndpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }, body: form })).json()
      return c.json({ imageUrl: 'data:image/jpeg;base64,' + data.image })
    }
    return c.json({ error: 'Model ' + modelId + ' endpoint not fully implemented yet.', demo: true })
  } catch (err: any) { return c.json({ error: err.message }, 500) }
})

// ─── Video Generation ─────────────────────────────────────────────────────────
app.post('/api/generate/video', async (c) => {
  const { prompt, model: modelId = 'veo2', duration = 5 } = await c.req.json()
  const spec = VIDEO_MODEL_REGISTRY[modelId as keyof typeof VIDEO_MODEL_REGISTRY]
  if (!spec) return c.json({ error: 'Unknown video model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  if (!apiKey) return c.json({ error: spec.name + ' API key not configured (' + spec.envKey + ')', demo: true, message: 'Demo: Would generate ' + duration + 's video with ' + spec.name + ': "' + prompt.slice(0, 60) + '"' })
  return c.json({ queued: true, model: spec.name, prompt, message: 'Video generation queued. This typically takes 1-3 minutes.' })
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
  // In production: generate token, store in KV, send via Resend/SendGrid
  // For now: auto-sign-in with email as identifier (demo mode)
  const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())
  const session = { name, email, picture: '', provider: 'magic_link', expiresAt: Date.now() + 7 * 24 * 3600000 }
  setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 604800, path: '/' })
  return c.json({ success: true, user: { name, email } })
})

// ─── Stripe Billing Stubs ─────────────────────────────────────────────────────
app.post('/api/billing/checkout', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  const { tier } = await c.req.json()
  const priceMap: Record<string, string> = {
    personal_pro: 'price_personal_pro_monthly',
    team_starter: 'price_team_starter_monthly',
    team_growth: 'price_team_growth_monthly',
    enterprise: 'price_enterprise_custom',
  }
  const priceId = priceMap[tier]
  if (!priceId) return c.json({ error: 'invalid_tier' }, 400)
  if (!c.env?.STRIPE_SECRET_KEY) {
    return c.json({ demo: true, message: 'Stripe not configured — add STRIPE_SECRET_KEY to activate billing', tier, redirectUrl: '/' })
  }
  // Real Stripe checkout session creation
  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'payment_method_types[]': 'card',
      'mode': 'subscription',
      'customer_email': session.email,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': `${new URL(c.req.url).origin}/?billing=success&tier=${tier}`,
      'cancel_url': `${new URL(c.req.url).origin}/?billing=cancelled`,
    })
  })
  const stripeData: any = await stripeRes.json()
  if (stripeData.error) return c.json({ error: stripeData.error.message }, 500)
  return c.json({ checkoutUrl: stripeData.url })
})

app.post('/api/billing/portal', async (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  if (!session) return c.json({ error: 'not_authenticated' }, 401)
  if (!c.env?.STRIPE_SECRET_KEY) return c.json({ demo: true, message: 'Stripe not configured' })
  return c.json({ portalUrl: `https://billing.stripe.com/p/login/test_demo` })
})

app.post('/api/billing/webhook', async (c) => {
  // Stripe webhook handler — verify signature and update user tier
  const body = await c.req.text()
  const sig = c.req.header('stripe-signature') || ''
  if (!c.env?.STRIPE_WEBHOOK_SECRET) return c.json({ received: true })
  // In production: verify Stripe webhook signature, update KV/D1 with new tier
  return c.json({ received: true })
})

// ─── Mindful Minimum ──────────────────────────────────────────────────────────
app.get('/api/mindful/policy', (c) => {
  const tier = (c.req.query('tier') as any) || 'free'
  return c.json(declareMindfulMinimum(tier))
})

// ─── Misc APIs ────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ status: 'alive', version: '3.0.0', name: 'FlowState', phase: 'Phase 3 — Full Architecture' }))
app.get('/api/learn/cards', (c) => c.json({ cards: declareLearnCards() }))
app.get('/api/restore/intent', (c) => c.json(declareRestoreIntent()))
app.get('/api/tier/capabilities', (c) => c.json(declareTierCapabilities((c.req.query('tier') as any) || 'free')))
app.get('/api/credentials', (c) => c.json({ credentials: CREDENTIAL_TABLE }))
app.get('/api/models', (c) => c.json({ models: MODEL_REGISTRY, imageModels: IMAGE_MODEL_REGISTRY, videoModels: VIDEO_MODEL_REGISTRY }))

// ─── Auth pages ───────────────────────────────────────────────────────────────
function authSuccessPage(name: string, picture: string): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Connected</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(168,85,247,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}.av{width:72px;height:72px;border-radius:50%;border:3px solid #a855f7;margin-bottom:16px}h1{font-size:22px;font-weight:800;margin-bottom:8px}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card">' + (picture ? '<img class="av" src="' + picture + '" alt="' + name + '">' : '<div style="font-size:48px;margin-bottom:16px">✅</div>') + '<h1>Connected, ' + name + '!</h1><p>Google Calendar and Drive are now synced with FlowState.</p><a class="btn" href="/" onclick="window.opener&&window.opener.location.reload();window.close()">Return to FlowState</a></div></body></html>'
}
function notionSuccessPage(workspace: string): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Notion Connected</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(168,85,247,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}h1{font-size:22px;font-weight:800;margin-bottom:8px}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">📝</div><h1>Notion Connected!</h1><p>Workspace <strong>' + (workspace || 'Your workspace') + '</strong> is synced. Choose a database in the Board tab.</p><a class="btn" href="/" onclick="window.opener&&window.opener.location.reload();window.close()">Open Board Tab</a></div></body></html>'
}
function slackSuccessPage(team: string): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Slack Connected</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(168,85,247,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}h1{font-size:22px;font-weight:800;margin-bottom:8px}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">💬</div><h1>Slack Connected!</h1><p>Team <strong>' + (team || 'Your workspace') + '</strong> is now synced with FlowState.</p><a class="btn" href="/" onclick="window.opener&&window.opener.location.reload();window.close()">Return to FlowState</a></div></body></html>'
}
function authErrorPage(message: string): string {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth Error</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(239,68,68,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}h1{font-size:22px;font-weight:800;margin-bottom:8px;color:#ef4444}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:#1a1a2e;border:1px solid #ef4444;color:#ef4444;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">⚠️</div><h1>Auth Error</h1><p>' + message + '</p><a class="btn" href="/">Back to FlowState</a></div></body></html>'
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HTML — Full FlowState v3
// ═══════════════════════════════════════════════════════════════════
app.get('/', (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const notionSession = decodeSession(getCookie(c, 'fs_notion') || '')
  const slackSession = decodeSession(getCookie(c, 'fs_slack') || '')
  const onboarding = decodeSession(getCookie(c, 'fs_onboarded') || '')

  const userJson = session ? JSON.stringify({ name: session.name, email: session.email, picture: session.picture }) : 'null'
  const notionJson = notionSession ? JSON.stringify({ workspace: notionSession.workspace_name }) : 'null'
  const slackJson = slackSession ? JSON.stringify({ team: slackSession.team_name }) : 'null'
  const onboardedJson = (onboarding?.completed) ? 'true' : 'false'

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowState — Intelligent Workspace</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
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

/* Ambient */
.orb{position:fixed;border-radius:50%;pointer-events:none;filter:blur(80px);opacity:0;transition:opacity 2s,transform 8s}
.orb1{width:500px;height:500px;top:-100px;left:-100px;background:radial-gradient(circle,rgba(168,85,247,.22),transparent 70%)}
.orb2{width:400px;height:400px;bottom:-100px;right:-100px;background:radial-gradient(circle,rgba(236,72,153,.18),transparent 70%)}
.amb-active .orb1,.amb-active .orb2{opacity:1}

/* Header */
header{display:flex;align-items:center;gap:10px;padding:8px 18px;background:rgba(26,26,46,.9);border-bottom:1px solid var(--border);backdrop-filter:blur(20px);flex-shrink:0;z-index:100}
.logo{font-size:17px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.5px;cursor:pointer}
.dt-widget{margin-left:auto;font-size:12px;color:var(--text-s);cursor:pointer;display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:8px;border:1px solid transparent;transition:.2s}
.dt-widget:hover{border-color:var(--border);background:rgba(168,85,247,.05)}
.dt-date{font-weight:600;color:var(--text-p)}
.dt-time{font-weight:800;font-size:13px;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-variant-numeric:tabular-nums}
.u-pill{display:flex;align-items:center;gap:7px;padding:4px 10px;border-radius:20px;border:1px solid var(--border);cursor:pointer;transition:.2s}
.u-pill:hover{border-color:var(--accent)}
.u-avatar{width:28px;height:28px;border-radius:50%;border:2px solid var(--accent);object-fit:cover}
.u-name{font-size:12px;font-weight:600;color:var(--text-s)}
.btn-signin{background:var(--grad);border:none;color:#fff;padding:7px 16px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;transition:.2s}
.btn-signin:hover{opacity:.85;transform:scale(1.02)}

/* Tabs */
.tabs-bar{display:flex;align-items:center;gap:2px;padding:5px 16px;background:rgba(15,15,26,.95);border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.tabs-bar::-webkit-scrollbar{display:none}
.tab-btn{display:flex;align-items:center;gap:5px;padding:6px 14px;border-radius:9px;font-size:12px;font-weight:600;color:var(--text-s);border:none;background:transparent;cursor:pointer;transition:.2s;white-space:nowrap}
.tab-btn:hover{color:var(--text-p);background:rgba(168,85,247,.08)}
.tab-btn.active{color:var(--accent);background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.25)}
.tab-btn i{font-size:12px}
.tab-pane{display:none;flex:1;overflow-y:auto;padding:18px}
.tab-pane.active{display:flex;flex-direction:column}

/* Model picker */
.model-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 14px;background:var(--bg-panel);border-radius:12px;border:1px solid var(--border);margin-bottom:10px}
.m-chip{display:flex;align-items:center;gap:4px;padding:5px 11px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s;white-space:nowrap}
.m-chip:hover{border-color:var(--border-h);color:var(--text-p)}
.m-chip.active{background:var(--grad);border-color:transparent;color:#fff}
.m-chip .badge{font-size:9px;padding:1px 4px;border-radius:5px;background:rgba(255,255,255,.15)}
.route-badge{font-size:11px;color:var(--text-m);display:flex;align-items:center;gap:4px;margin-left:auto}
.r-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}

/* Timer */
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

/* Ambient panel */
.amb-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:14px;width:100%;max-width:460px;margin:0 auto}
.amb-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);margin-bottom:9px}
.s-chips{display:flex;gap:7px;flex-wrap:wrap}
.s-chip{padding:5px 12px;border-radius:18px;font-size:12px;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.s-chip:hover{border-color:var(--border-h);color:var(--text-p)}
.s-chip.active{background:rgba(168,85,247,.15);border-color:var(--accent);color:var(--accent)}

/* Intent modal */
.intent-modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:5000;backdrop-filter:blur(10px)}
.intent-card{background:var(--bg-panel);border:1px solid var(--border-h);border-radius:22px;padding:36px 32px;max-width:440px;width:90%;text-align:center}
.intent-card h2{font-size:18px;font-weight:800;margin-bottom:6px}
.intent-card p{color:var(--text-s);font-size:14px;margin-bottom:18px}
.intent-input{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-p);font-size:15px;font-family:inherit;outline:none;margin-bottom:14px}
.intent-input:focus{border-color:var(--accent)}
.intent-suggestions{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;margin-bottom:18px}
.intent-sug{padding:5px 12px;border-radius:16px;font-size:12px;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s}
.intent-sug:hover{border-color:var(--accent);color:var(--accent)}

/* Chat */
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
@keyframes bounce{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-5px);opacity:1}}
.chat-input-row{display:flex;gap:9px;align-items:flex-end;padding-top:11px;border-top:1px solid var(--border)}
.chat-in{flex:1;background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:11px 15px;color:var(--text-p);font-size:14px;font-family:inherit;resize:none;min-height:44px;max-height:130px;overflow-y:auto;transition:.2s;outline:none}
.chat-in:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(168,85,247,.1)}
.btn-send{width:42px;height:42px;border-radius:11px;background:var(--grad);border:none;color:#fff;cursor:pointer;font-size:15px;flex-shrink:0;transition:.2s}
.btn-send:hover{transform:scale(1.05)}
.btn-send:disabled{opacity:.4;cursor:not-allowed;transform:none}

/* Calendar */
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cal-hd{font-size:10px;font-weight:700;text-align:center;color:var(--text-m);text-transform:uppercase;padding:4px}
.cal-day{aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;position:relative}
.cal-day:hover{background:rgba(168,85,247,.1)}
.cal-day.today{background:rgba(168,85,247,.2);color:var(--accent)}
.cal-day.has-ev::after{content:'';width:4px;height:4px;border-radius:50%;background:var(--accent);position:absolute;bottom:3px}
.cal-day.other{color:var(--text-m);opacity:.4}
.ev-list{display:flex;flex-direction:column;gap:7px;margin-top:14px}
.ev-item{display:flex;align-items:center;gap:11px;padding:11px 15px;background:var(--bg-panel);border:1px solid var(--border);border-radius:11px;transition:.2s}
.ev-item:hover{border-color:var(--border-h)}
.ev-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.ev-time{font-size:11px;color:var(--text-m);white-space:nowrap}
.ev-sum{font-size:13px;font-weight:600;flex:1}
.btn-blk{padding:4px 10px;border-radius:7px;font-size:11px;font-weight:700;background:rgba(168,85,247,.1);border:1px solid var(--border);color:var(--text-s);cursor:pointer;transition:.2s}
.btn-blk:hover{border-color:var(--accent);color:var(--accent)}

/* Board / Kanban */
.board-wrap{display:flex;gap:14px;height:100%;align-items:flex-start;padding-bottom:16px;overflow-x:auto}
.k-col{min-width:250px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:13px;flex-shrink:0}
.k-col-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px}
.k-col-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-s)}
.k-count{background:rgba(168,85,247,.15);color:var(--accent);padding:2px 7px;border-radius:7px;font-size:11px;font-weight:700}
.k-cards{display:flex;flex-direction:column;gap:7px;min-height:40px}
.k-card{background:var(--bg-card);border:1px solid var(--border);border-radius:9px;padding:11px;cursor:grab;transition:.2s}
.k-card:hover{border-color:var(--border-h);transform:translateY(-1px);box-shadow:0 4px 18px rgba(0,0,0,.3)}
.k-card.dragging{opacity:.5;cursor:grabbing}
.k-card-title{font-size:13px;font-weight:600;margin-bottom:5px}
.k-tag{display:inline-block;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;background:rgba(168,85,247,.15);color:var(--accent)}
.k-meta{font-size:11px;color:var(--text-m);margin-top:5px;display:flex;align-items:center;gap:5px}

/* Metrics */
.metrics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:13px;margin-bottom:18px}
.m-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:16px;transition:.2s;position:relative;overflow:hidden}
.m-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--grad)}
.m-card:hover{border-color:var(--border-h)}
.m-icon{font-size:20px;margin-bottom:9px}
.m-val{font-size:24px;font-weight:900;line-height:1}
.m-lbl{font-size:11px;font-weight:600;color:var(--text-m);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.m-trend{font-size:11px;color:var(--green);margin-top:3px}
.m-trend.down{color:var(--danger)}
.chart-wrap{background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:16px;margin-bottom:14px}
.chart-title{font-size:13px;font-weight:700;margin-bottom:13px;display:flex;align-items:center;gap:7px}
.insight-box{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.05));border:1px solid rgba(168,85,247,.2);border-radius:13px;padding:16px;margin-bottom:14px}
.ins-hl{font-size:15px;font-weight:800;margin-bottom:5px}
.ins-src{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}
.src-badge{padding:3px 8px;border-radius:5px;font-size:10px;font-weight:700;background:rgba(168,85,247,.15);color:var(--accent)}
.fs-ring{position:relative;width:80px;height:80px;margin:0 auto 11px}
.fs-val{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}

/* Team Hub */
.team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.member-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:14px;transition:.2s;position:relative}
.member-card:hover{border-color:var(--border-h)}
.member-av{width:40px;height:40px;border-radius:50%;background:var(--grad);display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:9px}
.member-name{font-size:14px;font-weight:700}
.member-role{font-size:11px;color:var(--text-m);margin-bottom:9px}
.pulse-dot{width:9px;height:9px;border-radius:50%;position:absolute;top:12px;right:12px}
.pulse-dot.online{background:var(--green);box-shadow:0 0 5px var(--green)}
.pulse-dot.focus{background:var(--accent);box-shadow:0 0 5px var(--accent);animation:pulse 2s infinite}
.pulse-dot.break{background:var(--warn)}
.pulse-dot.offline{background:var(--text-m)}
.burnout-bar{height:4px;border-radius:2px;margin-top:8px;background:var(--border)}
.burnout-fill{height:100%;border-radius:2px;transition:.6s}
.sprint-health{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:14px}
.sh-title{font-size:14px;font-weight:800;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.sh-progress{height:8px;background:rgba(168,85,247,.1);border-radius:4px;margin-bottom:6px;overflow:hidden}
.sh-fill{height:100%;border-radius:4px;transition:.8s}
.sh-pace{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;margin-bottom:12px}
.pace-badge{padding:3px 10px;border-radius:6px;font-size:11px;font-weight:800}
.risk-card{background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.25);border-radius:9px;padding:10px 13px;font-size:12px;margin-bottom:7px;color:var(--warn)}
.action-item{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-card);border-radius:8px;font-size:12px;margin-bottom:5px}
.action-item i{color:var(--accent);width:14px;flex-shrink:0}
.sh-stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.sh-stat{text-align:center;padding:10px 14px;background:var(--bg-card);border-radius:9px}
.sh-stat-v{font-size:20px;font-weight:800;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sh-stat-l{font-size:10px;color:var(--text-m);text-transform:uppercase;letter-spacing:.5px}

/* Learn */
.learn-car{position:relative;overflow:hidden;border-radius:18px;min-height:240px;margin-bottom:14px}
.l-card{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:26px;border-radius:18px;transition:opacity .5s,transform .5s;opacity:0;transform:translateX(30px)}
.l-card.active{opacity:1;transform:translateX(0)}
.l-card.prev{opacity:0;transform:translateX(-30px)}
.l-type{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:2px;opacity:.7;margin-bottom:7px}
.l-title{font-size:20px;font-weight:900;margin-bottom:7px}
.l-content{font-size:14px;line-height:1.6;opacity:.9;margin-bottom:10px}
.l-meta{font-size:11px;opacity:.6}
.l-nav{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:14px}
.l-dot{width:8px;height:8px;border-radius:50%;background:var(--border);cursor:pointer;transition:.2s}
.l-dot.active{background:var(--accent);width:20px;border-radius:4px}
.l-nav-btn{width:34px;height:34px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;transition:.2s;display:flex;align-items:center;justify-content:center}
.l-nav-btn:hover{border-color:var(--accent);color:var(--accent)}

/* Restore */
.r-scene{border-radius:18px;overflow:hidden;position:relative;min-height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px;text-align:center;margin-bottom:14px;transition:.6s}
.r-emoji{font-size:52px;margin-bottom:14px;line-height:1}
.r-title{font-size:20px;font-weight:900;margin-bottom:9px}
.r-content{font-size:14px;line-height:1.7;opacity:.85;max-width:380px;margin-bottom:18px}
.breath-circ{width:110px;height:110px;border-radius:50%;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;margin:14px auto;transition:transform 4s,background .5s}
.breath-circ.expand{transform:scale(1.5);background:rgba(255,255,255,.25)}
.r-steps{text-align:left;display:flex;flex-direction:column;gap:7px;margin:14px 0}
.r-step{display:flex;align-items:center;gap:9px;font-size:13px;padding:7px 13px;background:rgba(255,255,255,.1);border-radius:7px}
.r-step-n{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.r-nav{display:flex;gap:9px;justify-content:center}
.r-btn{padding:9px 22px;border-radius:11px;font-size:13px;font-weight:700;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;transition:.2s}
.r-btn:hover{background:rgba(255,255,255,.2)}
.grat-in{width:100%;max-width:340px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.3);border-radius:11px;padding:13px 16px;font-size:14px;color:#fff;font-family:inherit;outline:none;margin-bottom:11px;text-align:center}
.grat-in::placeholder{color:rgba(255,255,255,.5)}

/* Generate */
.gen-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px}
.gen-title{font-size:13px;font-weight:700;margin-bottom:11px;display:flex;align-items:center;gap:7px}
.gen-pmt{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:11px;padding:11px 15px;color:var(--text-p);font-size:14px;font-family:inherit;resize:vertical;min-height:76px;outline:none;margin-bottom:11px}
.gen-pmt:focus{border-color:var(--accent)}
.btn-gen{padding:9px 22px;border-radius:11px;background:var(--grad);border:none;color:#fff;font-size:13px;font-weight:700;cursor:pointer;transition:.2s}
.btn-gen:hover{opacity:.85;transform:scale(1.02)}
.btn-gen:disabled{opacity:.4;cursor:not-allowed;transform:none}
.gen-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:11px;margin-top:13px}
.gen-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:11px;border:1px solid var(--border);cursor:pointer;transition:.2s}
.gen-img:hover{border-color:var(--accent);transform:scale(1.02)}

/* Tip bubble */
.tip-bub{position:fixed;bottom:76px;right:18px;max-width:290px;background:var(--bg-panel);border:1px solid var(--border-h);border-radius:14px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:1000;animation:slideR .3s ease}
.tip-hd{display:flex;align-items:center;gap:7px;margin-bottom:7px}
.tip-emoji{font-size:18px}
.tip-cat{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m)}
.tip-msg{font-size:13px;line-height:1.5;color:var(--text-p)}
.tip-x{position:absolute;top:9px;right:11px;background:none;border:none;color:var(--text-m);cursor:pointer;font-size:15px}
.tip-x:hover{color:var(--text-p)}

/* Celebrations */
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

/* Modal */
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:3000;backdrop-filter:blur(8px);padding:14px}
.modal-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:18px;padding:28px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto}
.modal-card h2{font-size:18px;font-weight:800;margin-bottom:5px}
.tier-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:11px;margin:14px 0}
.t-card{padding:15px;border-radius:13px;border:1px solid var(--border);text-align:center;cursor:pointer;transition:.2s}
.t-card:hover{border-color:var(--border-h)}
.t-card.hi{border:2px solid var(--accent);background:rgba(168,85,247,.05)}
.t-card h3{font-size:14px;font-weight:800;margin-bottom:3px}
.t-card .price{font-size:20px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.t-feats{font-size:11px;color:var(--text-s);line-height:1.8;text-align:left;margin-top:9px;list-style:none}
.t-feats li::before{content:"✓ ";color:var(--green)}
.cred-tbl{width:100%;border-collapse:collapse;font-size:12px;margin-top:14px}
.cred-tbl th{text-align:left;padding:7px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-m);border-bottom:1px solid var(--border)}
.cred-tbl td{padding:7px;border-bottom:1px solid rgba(168,85,247,.06);vertical-align:middle}
.cred-tbl a{color:var(--accent);text-decoration:none;font-weight:600}
.badge-core{background:rgba(16,185,129,.15);color:var(--green);padding:2px 5px;border-radius:4px;font-size:10px;font-weight:700}
.badge-rec{background:rgba(245,158,11,.15);color:var(--warn);padding:2px 5px;border-radius:4px;font-size:10px;font-weight:700}
.badge-opt{background:rgba(168,85,247,.1);color:var(--accent);padding:2px 5px;border-radius:4px;font-size:10px;font-weight:700}

/* Onboarding */
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
.goal-btn{padding:14px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--text-p);cursor:pointer;transition:.2s;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600}
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
.rhythm-btn{padding:14px 10px;border-radius:11px;border:1px solid var(--border);background:transparent;color:var(--text-p);cursor:pointer;transition:.2s;text-align:center}
.rhythm-btn:hover{border-color:var(--border-h)}
.rhythm-btn.sel{border-color:var(--accent);background:rgba(168,85,247,.1);color:var(--accent)}
.rhythm-min{font-size:22px;font-weight:900;display:block;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.rhythm-lbl{font-size:11px;color:var(--text-m)}
.ob-btn{width:100%;padding:14px;border-radius:13px;background:var(--grad);border:none;color:#fff;font-size:15px;font-weight:800;cursor:pointer;transition:.2s}
.ob-btn:hover{opacity:.88;transform:scale(1.01)}
.ob-skip{background:none;border:none;color:var(--text-m);font-size:12px;cursor:pointer;margin-top:12px;text-decoration:underline}
.ob-skip:hover{color:var(--text-s)}

/* Login screen */
.login-screen{position:fixed;inset:0;background:var(--bg-base);display:flex;align-items:center;justify-content:center;z-index:8000;padding:20px}
.login-card{background:var(--bg-panel);border:1px solid var(--border-h);border-radius:24px;padding:44px 40px;max-width:420px;width:100%;text-align:center}
.login-logo{font-size:52px;margin-bottom:12px}
.login-title{font-size:26px;font-weight:900;margin-bottom:8px}
.login-sub{color:var(--text-s);font-size:14px;margin-bottom:32px;line-height:1.65}
.btn-google{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:14px;border-radius:13px;background:#fff;border:none;color:#1a1a2e;font-size:15px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:12px}
.btn-google:hover{transform:scale(1.02);box-shadow:0 4px 20px rgba(255,255,255,.1)}
.btn-google img{width:20px;height:20px}
.btn-magic{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px;border-radius:13px;background:transparent;border:1px solid var(--border);color:var(--text-p);font-size:15px;font-weight:700;cursor:pointer;transition:.2s;margin-bottom:24px}
.btn-magic:hover{border-color:var(--border-h);background:rgba(168,85,247,.06)}
.login-features{display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left}
.login-feat{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-s)}
.login-feat i{color:var(--accent);width:14px}
.login-legal{font-size:11px;color:var(--text-m);margin-top:22px;line-height:1.5}

/* Misc */
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
.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;display:inline-block}
select.fs-sel{background:var(--bg-card);border:1px solid var(--border);border-radius:7px;color:var(--text-p);padding:6px 11px;font-size:12px;cursor:pointer;outline:none}
select.fs-sel:focus{border-color:var(--accent)}
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
</style>
</head>
<body>
<div class="orb orb1" id="orb1"></div>
<div class="orb orb2" id="orb2"></div>

<!-- LOGIN SCREEN -->
<div class="login-screen" id="login-screen" style="display:none">
  <div class="login-card">
    <div class="login-logo">⚡</div>
    <h1 class="login-title">Welcome to FlowState</h1>
    <p class="login-sub">The intelligent workspace that respects your focus, powers your team, and compounds your growth — every single day.</p>
    <button class="btn-google" onclick="signInGoogle()">
      <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Continue with Google
    </button>
    <button class="btn-magic" onclick="signInMagicLink()">
      <i class="fas fa-envelope"></i> Continue with work email
    </button>
    <div class="login-features">
      <div class="login-feat"><i class="fas fa-check"></i> 7 AI models</div>
      <div class="login-feat"><i class="fas fa-check"></i> Calendar sync</div>
      <div class="login-feat"><i class="fas fa-check"></i> Team Kanban</div>
      <div class="login-feat"><i class="fas fa-check"></i> FlowScore daily</div>
      <div class="login-feat"><i class="fas fa-check"></i> Sprint Health</div>
      <div class="login-feat"><i class="fas fa-check"></i> Break reminders</div>
    </div>
    <p class="login-legal">By continuing you agree to our Terms of Service and Privacy Policy. Your data is never sold. API keys are stored server-side and never exposed.</p>
  </div>
</div>

<!-- ONBOARDING -->
<div class="ob-screen" id="ob-screen" style="display:none">
  <div class="ob-card" id="ob-card">
    <!-- populated by JS -->
  </div>
</div>

<!-- HEADER -->
<header id="main-header" style="display:none">
  <div class="logo" onclick="switchTab('focus')">⚡ FLOWSTATE</div>
  <div class="dt-widget" id="dt-widget" onclick="switchTab('calendar')">
    <i class="fas fa-calendar" style="font-size:10px;color:var(--text-m)"></i>
    <span class="dt-date" id="dt-date">—</span>
    <span style="color:var(--text-m);font-size:10px">·</span>
    <span class="dt-time" id="dt-time">—</span>
  </div>
  <div id="fs-score-badge" onclick="switchTab('metrics')" style="font-size:11px;font-weight:700;color:var(--accent);cursor:pointer;padding:4px 10px;border:1px solid rgba(168,85,247,.25);border-radius:8px;background:rgba(168,85,247,.08);display:none">⚡ —</div>
  <div id="user-area"></div>
</header>

<!-- TABS BAR -->
<div class="tabs-bar" id="main-tabs" style="display:none">
  <button class="tab-btn active" id="tab-focus" onclick="switchTab('focus')"><i class="fas fa-bullseye"></i>Focus</button>
  <button class="tab-btn" id="tab-chat" onclick="switchTab('chat')"><i class="fas fa-comments"></i>Chat</button>
  <button class="tab-btn" id="tab-calendar" onclick="switchTab('calendar')"><i class="fas fa-calendar-alt"></i>Calendar</button>
  <button class="tab-btn" id="tab-metrics" onclick="switchTab('metrics')"><i class="fas fa-chart-line"></i>Metrics</button>
  <button class="tab-btn" id="tab-board" onclick="switchTab('board')"><i class="fas fa-columns"></i>Board</button>
  <button class="tab-btn" id="tab-team" onclick="switchTab('team')"><i class="fas fa-users"></i>Team</button>
  <button class="tab-btn" id="tab-learn" onclick="switchTab('learn')"><i class="fas fa-graduation-cap"></i>Learn</button>
  <button class="tab-btn" id="tab-restore" onclick="switchTab('restore')"><i class="fas fa-leaf"></i>Restore</button>
  <button class="tab-btn" id="tab-generate" onclick="switchTab('generate')"><i class="fas fa-magic"></i>Generate</button>
  <div style="margin-left:auto;display:flex;gap:5px">
    <button class="btn-sm" onclick="openCredsModal()" title="API Credentials"><i class="fas fa-key"></i></button>
    <button class="btn-sm" onclick="openPricingModal()"><i class="fas fa-star"></i> Pro</button>
    <button class="btn-sm" onclick="openInviteModal()"><i class="fas fa-user-plus"></i></button>
    <button class="btn-sm" onclick="openSettingsModal()"><i class="fas fa-gear"></i></button>
  </div>
</div>

<!-- ═══ FOCUS TAB ═══ -->
<div class="tab-pane active" id="tab-pane-focus" style="display:none">
  <div class="timer-wrap">
    <div class="phase-btns">
      <button class="ph-btn active" id="ph-focus" onclick="setPhase('focus')">Focus</button>
      <button class="ph-btn" id="ph-short" onclick="setPhase('short_break')">Short Break</button>
      <button class="ph-btn" id="ph-long" onclick="setPhase('long_break')">Long Break</button>
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
      <button class="btn-t btn-sm-t" onclick="skipPhase()" title="Skip"><i class="fas fa-forward-step"></i></button>
      <button class="btn-t btn-start" id="btn-start" onclick="toggleTimer()"><i class="fas fa-play" id="btn-icon"></i></button>
      <button class="btn-t btn-sm-t" onclick="resetTimer()" title="Reset"><i class="fas fa-rotate-left"></i></button>
    </div>
    <div class="stats-row">
      <div class="stat-item"><div class="stat-val" id="stat-sessions">0</div><div class="stat-lbl">Sessions</div></div>
      <div class="stat-item"><div class="stat-val" id="stat-focus">0m</div><div class="stat-lbl">Focus Time</div></div>
      <div class="stat-item"><div class="stat-val" id="stat-streak">🔥 0</div><div class="stat-lbl">Streak</div></div>
    </div>
    <div class="amb-panel">
      <div class="amb-title"><i class="fas fa-headphones"></i>&nbsp; Ambient</div>
      <div class="s-chips">
        <button class="s-chip" onclick="toggleSound('rain')">🌧️ Rain</button>
        <button class="s-chip" onclick="toggleSound('forest')">🌲 Forest</button>
        <button class="s-chip" onclick="toggleSound('cafe')">☕ Cafe</button>
        <button class="s-chip" onclick="toggleSound('ocean')">🌊 Ocean</button>
        <button class="s-chip" onclick="toggleSound('fire')">🔥 Fire</button>
        <button class="s-chip" onclick="toggleSound('space')">🌌 Space</button>
        <button class="s-chip" onclick="toggleSound('off')">🔇 Off</button>
      </div>
    </div>
    <div id="block-warn" class="block-warn" style="display:none">
      <i class="fas fa-calendar-exclamation"></i>&nbsp; <span id="block-msg"></span>
    </div>
  </div>
</div>

<!-- ═══ CHAT TAB ═══ -->
<div class="tab-pane" id="tab-pane-chat" style="display:none;padding:14px">
  <div class="chat-wrap">
    <div class="model-bar" id="model-bar"></div>
    <div class="chat-msgs" id="chat-msgs">
      <div class="msg ai">
        <div class="msg-av" style="background:var(--grad)">⚡</div>
        <div>
          <div class="msg-meta"><span class="m-tag">FlowState AI</span><span>Smart routing active</span></div>
          <div class="msg-bub">Hey! I auto-route to the best model for each task &mdash; Claude for code and analysis, Gemini for speed, Grok for live data, DeepSeek for math. Pick a chip above or just type naturally.</div>
        </div>
      </div>
    </div>
    <div class="chat-input-row">
      <textarea class="chat-in" id="chat-in" placeholder="Ask anything… Cmd+Enter to send" rows="1"></textarea>
      <button class="btn-send" id="btn-send" onclick="sendMessage()"><i class="fas fa-paper-plane"></i></button>
    </div>
  </div>
</div>

<!-- ═══ CALENDAR TAB ═══ -->
<div class="tab-pane" id="tab-pane-calendar" style="display:none">
  <div id="cal-auth-banner" class="auth-banner" style="display:none">
    <h3>📅 Connect Google Calendar</h3>
    <p>See upcoming events, block focus time, and let FlowState smart-schedule your sessions.</p>
    <button class="btn-primary" onclick="signInGoogle()"><i class="fas fa-google"></i>&nbsp; Connect Google</button>
  </div>
  <div class="sec-hd">
    <div class="sec-title" id="cal-month-label">— —</div>
    <div style="display:flex;gap:6px">
      <button class="btn-sm" onclick="calNav(-1)"><i class="fas fa-chevron-left"></i></button>
      <button class="btn-sm" onclick="calNav(1)"><i class="fas fa-chevron-right"></i></button>
      <button class="btn-sm" onclick="loadCalEvents()"><i class="fas fa-refresh"></i></button>
    </div>
  </div>
  <div class="cal-grid" id="cal-grid"></div>
  <div class="ev-list" id="ev-list"></div>
</div>

<!-- ═══ METRICS TAB ═══ -->
<div class="tab-pane" id="tab-pane-metrics" style="display:none">
  <div class="insight-box" id="insight-box">
    <div class="ins-hl" id="ins-hl">Loading insight...</div>
    <div id="ins-detail" style="font-size:13px;color:var(--text-s);margin-bottom:5px"></div>
    <div id="ins-rec" style="font-size:13px;font-style:italic;color:var(--text-m)"></div>
    <div class="ins-src" id="ins-src"></div>
    <div style="font-size:12px;color:var(--text-m);margin-top:8px">FlowScore: <strong id="ins-score" style="color:var(--accent)">—</strong></div>
  </div>
  <div class="metrics-grid" id="metrics-grid"></div>
  <div class="chart-wrap">
    <div class="chart-title"><i class="fas fa-chart-bar" style="color:var(--accent)"></i> Focus Sessions This Week</div>
    <canvas id="focus-chart" height="100"></canvas>
  </div>
</div>

<!-- ═══ BOARD TAB ═══ -->
<div class="tab-pane" id="tab-pane-board" style="display:none">
  <div id="board-notion-panel" style="display:none" class="auth-banner">
    <h3>📋 Connect Notion</h3>
    <p>Sync your Notion databases as a live Kanban board. Drag cards between columns to update status in real time.</p>
    <button class="btn-primary" onclick="connectNotion()"><i class="fas fa-plug"></i>&nbsp; Connect Notion</button>
  </div>
  <div id="board-db-select" style="display:none;margin-bottom:14px">
    <div class="sec-hd">
      <div class="sec-title">Choose a Notion database</div>
      <button class="btn-sm" onclick="loadNotionDbs()"><i class="fas fa-refresh"></i></button>
    </div>
    <div class="notion-db-list" id="notion-db-list"></div>
  </div>
  <div class="board-wrap" id="board-wrap"></div>
</div>

<!-- ═══ TEAM TAB ═══ -->
<div class="tab-pane" id="tab-pane-team" style="display:none">
  <div id="team-hub-content">
    <div class="sec-hd">
      <div class="sec-title">Team Hub</div>
      <div style="display:flex;gap:6px">
        <button class="btn-sm" onclick="openSlackModal()"><i class="fas fa-slack"></i>&nbsp; Slack</button>
        <button class="btn-sm" onclick="refreshTeamPulse()"><i class="fas fa-refresh"></i></button>
      </div>
    </div>

    <!-- Sprint Health -->
    <div class="sprint-health" id="sprint-health-panel">
      <div class="sh-title"><i class="fas fa-heart-pulse" style="color:var(--danger)"></i> Sprint Health</div>
      <div class="sh-stats" id="sh-stats"></div>
      <div class="sh-progress" style="margin-bottom:4px"><div class="sh-fill" id="sh-fill" style="background:var(--grad)"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-m);margin-bottom:10px">
        <span>Completion <strong id="sh-pct">—</strong></span>
        <span>Expected <strong id="sh-exp">—</strong></span>
        <span id="sh-days"></span>
      </div>
      <div class="sh-pace" id="sh-pace"></div>
      <div id="sh-assessment" style="font-size:13px;color:var(--text-s);margin-bottom:12px;padding:10px;background:var(--bg-card);border-radius:9px;line-height:1.5"></div>
      <div id="sh-actions"></div>
    </div>

    <!-- Team Pulse -->
    <div class="sec-hd"><div class="sec-title">Team Pulse <span style="font-size:11px;font-weight:400;color:var(--text-m)">(non-surveillance — presence only)</span></div></div>
    <div class="team-grid" id="team-pulse-grid"></div>

    <!-- Deadline Intelligence -->
    <div id="deadline-intel" class="sprint-health" style="display:none">
      <div class="sh-title"><i class="fas fa-clock" style="color:var(--warn)"></i> Deadline Intelligence</div>
      <div id="deadline-content"></div>
    </div>
  </div>
</div>

<!-- ═══ LEARN TAB ═══ -->
<div class="tab-pane" id="tab-pane-learn" style="display:none">
  <div class="learn-car" id="learn-car"></div>
  <div class="l-nav" id="l-nav"></div>
  <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:13px;padding:16px">
    <div class="sec-title" style="margin-bottom:12px">All Cards</div>
    <div id="all-learn-cards" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:9px"></div>
  </div>
</div>

<!-- ═══ RESTORE TAB ═══ -->
<div class="tab-pane" id="tab-pane-restore" style="display:none">
  <div class="r-scene" id="r-scene"></div>
  <div class="r-nav" id="r-nav"></div>
</div>

<!-- ═══ GENERATE TAB ═══ -->
<div class="tab-pane" id="tab-pane-generate" style="display:none">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <!-- Image -->
    <div class="gen-panel">
      <div class="gen-title"><i class="fas fa-image" style="color:var(--accent)"></i> Image Generation</div>
      <select class="fs-sel" id="img-model-sel" style="width:100%;margin-bottom:10px">
        <option value="dalle3">DALL-E 3 (OpenAI)</option>
        <option value="imagen3">Imagen 3 (Google)</option>
        <option value="sd3">Stable Diffusion 3</option>
        <option value="flux_pro">FLUX Pro (Black Forest Labs)</option>
        <option value="ideogram2">Ideogram 2</option>
      </select>
      <textarea class="gen-pmt" id="img-prompt" placeholder="Describe the image you want to generate..."></textarea>
      <button class="btn-gen" onclick="generateImage()"><i class="fas fa-wand-magic-sparkles"></i>&nbsp; Generate Image</button>
      <div class="gen-results" id="img-results"></div>
    </div>
    <!-- Video -->
    <div class="gen-panel">
      <div class="gen-title"><i class="fas fa-video" style="color:var(--pink)"></i> Video Generation</div>
      <select class="fs-sel" id="vid-model-sel" style="width:100%;margin-bottom:10px">
        <option value="veo2">Veo 2 (Google)</option>
        <option value="kling16">Kling 1.6 (Kuaishou)</option>
        <option value="runway_gen4">Runway Gen-4</option>
        <option value="pika20">Pika 2.0</option>
        <option value="hailuo">Hailuo (MiniMax)</option>
        <option value="sora">Sora (OpenAI)</option>
      </select>
      <textarea class="gen-pmt" id="vid-prompt" placeholder="Describe the video you want to generate..."></textarea>
      <select class="fs-sel" id="vid-dur" style="margin-bottom:10px">
        <option value="5">5 seconds</option>
        <option value="8">8 seconds</option>
        <option value="10">10 seconds</option>
      </select>
      <button class="btn-gen" onclick="generateVideo()"><i class="fas fa-film"></i>&nbsp; Generate Video</button>
      <div id="vid-result" style="margin-top:12px;font-size:13px;color:var(--text-s)"></div>
    </div>
  </div>
</div>

<script>
const FS_USER = ${userJson};
const FS_NOTION = ${notionJson};
const FS_SLACK = ${slackJson};
const FS_ONBOARDED = ${onboardedJson};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  timer: { running: false, remaining: 25*60, total: 25*60, phase: 'focus', sessions: 0, totalFocusSec: 0, interval: null, lastTipAt: 0 },
  chat: { messages: [], model: null, history: [] },
  calendar: { events: [], month: new Date().getMonth(), year: new Date().getFullYear() },
  kanban: { columns: { todo: [], inprogress: [], done: [] }, notionDbId: null, notionDbPropName: null, notionDbPropType: null },
  learn: { cards: [], idx: 0, interval: null },
  restore: { current: null },
  team: { members: [], sprintCards: [], sprintStart: null, sprintEnd: null },
  settings: { focusMin: 25, shortMin: 5, longMin: 15, sound: null },
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  if (!FS_USER) { showLogin(); return; }
  if (!FS_ONBOARDED) { showOnboarding(); return; }
  showApp();
}

// ─── Login ────────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
}
function signInGoogle() { window.location.href = '/api/auth/google'; }
function signInMagicLink() {
  const email = prompt('Enter your work email:');
  if (!email || !email.includes('@')) { notify('Enter a valid email address', 'warning'); return; }
  fetch('/api/auth/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
    .then(r => r.json()).then(data => {
      if (data.success) { notify('Signed in as ' + data.user.name, 'success'); setTimeout(() => window.location.reload(), 1200); }
      else notify('Could not sign in — check email format', 'error');
    }).catch(() => notify('Network error — please try again', 'error'));
}

// ─── Onboarding ───────────────────────────────────────────────────────────────
const OB = { step: 1, goals: [], focusDuration: 25, workHours: { start: '09:00', end: '18:00' }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };

function showOnboarding() {
  document.getElementById('ob-screen').style.display = 'flex';
  renderObStep(1);
}

function renderObStep(step) {
  OB.step = step;
  const card = document.getElementById('ob-card');
  const progress = '<div class="ob-progress">' + [1,2,3].map(i => '<div class="ob-dot ' + (i < step ? 'done' : i === step ? 'active' : '') + '"></div>').join('') + '</div>';

  if (step === 1) {
    card.innerHTML = progress + '<div class="ob-logo">⚡</div><h2 class="ob-title">What are you here to improve?</h2><p class="ob-sub">Pick up to 3 goals. We\'ll personalize your workspace around them.</p><div class="ob-step">Step 1 of 3</div>' +
      '<div class="goal-grid">' +
      goalBtn('deep_focus','fas fa-bullseye','Deep Focus','Ship more, distract less') +
      goalBtn('team_collab','fas fa-users','Team Collab','Sync without overhead') +
      goalBtn('health_energy','fas fa-heart-pulse','Health & Energy','Move, sleep, recover') +
      goalBtn('creative','fas fa-palette','Creative Output','Unlock your best ideas') +
      goalBtn('learning','fas fa-graduation-cap','Learning','Compound your knowledge') +
      goalBtn('financial','fas fa-chart-line','Financial Clarity','Track wealth growth') +
      '</div><button class="ob-btn" onclick="obNext(1)">Continue <i class="fas fa-arrow-right"></i></button>';
  } else if (step === 2) {
    card.innerHTML = progress + '<div class="ob-logo">🔗</div><h2 class="ob-title">Connect your tools</h2><p class="ob-sub">Link the tools you already use. Skip anything — you can connect later.</p><div class="ob-step">Step 2 of 3</div>' +
      '<div class="integ-list">' +
      integRow('google_calendar','📅','Google Calendar','Smart session blocking','signInGoogle()', !!FS_USER) +
      integRow('notion','📝','Notion','Kanban sync + project boards','connectNotion()', !!FS_NOTION) +
      integRow('slack','💬','Slack','Team comms + sprint updates','connectSlack()', !!FS_SLACK) +
      integRow('github','🐙','GitHub','Commit activity + PR status','#','false') +
      integRow('linear','📐','Linear','Sprint board sync','#','false') +
      integRow('jira','🔵','Jira','Issue tracking sync','#','false') +
      '</div><button class="ob-btn" onclick="obNext(2)">Continue <i class="fas fa-arrow-right"></i></button><br><button class="ob-skip" onclick="obNext(2)">Skip for now</button>';
  } else if (step === 3) {
    card.innerHTML = progress + '<div class="ob-logo">⏱️</div><h2 class="ob-title">Set your work rhythm</h2><p class="ob-sub">How long are your ideal focus sessions? You can change this anytime.</p><div class="ob-step">Step 3 of 3</div>' +
      '<div class="rhythm-grid">' +
      rhythmBtn(25,'25 min','Classic Pomodoro') +
      rhythmBtn(45,'45 min','Deep Work') +
      rhythmBtn(90,'90 min','Ultradian Sprint') +
      '</div>' +
      '<div style="display:flex;gap:10px;margin-bottom:18px">' +
      '<div style="flex:1;text-align:left"><div style="font-size:11px;color:var(--text-m);margin-bottom:5px;font-weight:700">Work starts</div><input type="time" class="fs-in" id="ob-start" value="09:00"></div>' +
      '<div style="flex:1;text-align:left"><div style="font-size:11px;color:var(--text-m);margin-bottom:5px;font-weight:700">Work ends</div><input type="time" class="fs-in" id="ob-end" value="18:00"></div>' +
      '</div>' +
      '<button class="ob-btn" onclick="obFinish()">Launch FlowState 🚀</button>';
  }
}

function goalBtn(id, icon, name, desc) {
  return '<button class="goal-btn ' + (OB.goals.includes(id) ? 'sel' : '') + '" onclick="toggleGoal(\'' + id + '\',this)"><i class="' + icon + '"></i><div><div style="font-size:13px;font-weight:700">' + name + '</div><div style="font-size:11px;color:var(--text-m)">' + desc + '</div></div></button>';
}
function integRow(id, icon, name, desc, action, connected) {
  return '<div class="integ-row"><div class="integ-left"><div class="integ-icon">' + icon + '</div><div><div class="integ-name">' + name + '</div><div class="integ-desc">' + desc + '</div></div></div><button class="btn-connect ' + (connected ? 'connected' : '') + '" onclick="' + action + '">' + (connected ? '✓ Connected' : 'Connect') + '</button></div>';
}
function rhythmBtn(min, label, desc) {
  return '<button class="rhythm-btn ' + (OB.focusDuration === min ? 'sel' : '') + '" onclick="selectRhythm(' + min + ',this)"><span class="rhythm-min">' + label + '</span><div class="rhythm-lbl">' + desc + '</div></button>';
}
function toggleGoal(id, el) {
  if (OB.goals.includes(id)) OB.goals = OB.goals.filter(g => g !== id);
  else if (OB.goals.length < 3) OB.goals.push(id);
  el.classList.toggle('sel', OB.goals.includes(id));
}
function selectRhythm(min, el) {
  OB.focusDuration = min;
  document.querySelectorAll('.rhythm-btn').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
  state.settings.focusMin = min;
}
function obNext(current) { renderObStep(current + 1); }
async function obFinish() {
  OB.workHours.start = document.getElementById('ob-start')?.value || '09:00';
  OB.workHours.end = document.getElementById('ob-end')?.value || '18:00';
  await fetch('/api/onboarding/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goals: OB.goals, focusDuration: OB.focusDuration, workHours: OB.workHours, timezone: OB.timezone }) });
  document.getElementById('ob-screen').style.display = 'none';
  showApp();
}

// ─── App Shell ────────────────────────────────────────────────────────────────
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('ob-screen').style.display = 'none';
  document.getElementById('main-header').style.display = 'flex';
  document.getElementById('main-tabs').style.display = 'flex';
  document.getElementById('tab-pane-focus').style.display = 'flex';
  document.getElementById('tab-pane-focus').classList.add('active');
  document.body.classList.add('amb-active');
  renderUserArea();
  startClock();
  initTimer();
  buildModelBar();
  loadCalendar();
  buildMetrics();
  buildBoard();
  buildTeam();
  loadLearnCards();
  loadRestore();
  loadBehaviorInsight();
  setupKeyboard();
  setTimeout(maybeShowIntentPrompt, 1500);
  setTimeout(maybeShowTip, 8000);
}

// ─── User area ────────────────────────────────────────────────────────────────
function renderUserArea() {
  const ua = document.getElementById('user-area');
  if (FS_USER) {
    ua.innerHTML = '<div class="u-pill" onclick="openUserMenu()"><img class="u-avatar" src="' + (FS_USER.picture || '') + '" alt="' + FS_USER.name + '"><span class="u-name">' + (FS_USER.name?.split(' ')[0] || '') + '</span></div>';
  } else {
    ua.innerHTML = '<button class="btn-signin" onclick="signInGoogle()"><i class="fas fa-google"></i>&nbsp; Sign in</button>';
  }
}
function openUserMenu() {
  openModal('Account', '<div style="text-align:center;padding:10px 0"><img src="' + (FS_USER?.picture || '') + '" style="width:64px;height:64px;border-radius:50%;border:2px solid var(--accent);margin-bottom:12px"><div style="font-size:16px;font-weight:800">' + (FS_USER?.name || '') + '</div><div style="font-size:13px;color:var(--text-s);margin-bottom:20px">' + (FS_USER?.email || '') + '</div><button class="btn-primary" onclick="signOut()" style="background:rgba(239,68,68,.15);border:1px solid var(--danger);color:var(--danger)">Sign Out</button></div>');
}
async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}
function connectNotion() { window.open('/api/auth/notion', '_blank', 'width=600,height=700'); }
function connectSlack() { window.open('/api/auth/slack', '_blank', 'width=600,height=700'); }

// ─── Clock ────────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    document.getElementById('dt-date').textContent = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();
    document.getElementById('dt-time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  tick();
  setInterval(tick, 1000);
}

// ─── Timer ────────────────────────────────────────────────────────────────────
const PHASES = { focus: 25, short_break: 5, long_break: 15 };
const PHASE_LABELS = { focus: 'FOCUS', short_break: 'SHORT BREAK', long_break: 'LONG BREAK' };

function initTimer() {
  const saved = JSON.parse(localStorage.getItem('fs_timer_state') || '{}');
  state.timer.sessions = saved.sessions || 0;
  state.timer.totalFocusSec = saved.totalFocusSec || 0;
  state.settings.focusMin = saved.focusMin || OB.focusDuration || 25;
  PHASES.focus = state.settings.focusMin;
  PHASES.short_break = state.settings.shortMin || 5;
  PHASES.long_break = state.settings.longMin || 15;
  state.timer.remaining = PHASES.focus * 60;
  state.timer.total = PHASES.focus * 60;
  updateTimerDisplay();
  updateStats();
}

function toggleTimer() {
  if (state.timer.running) pauseTimer();
  else startTimer();
}

function startTimer() {
  if (state.timer.phase === 'focus') maybeShowIntentPrompt(true);
  state.timer.running = true;
  document.getElementById('btn-icon').className = 'fas fa-pause';
  document.getElementById('t-glow').classList.add('on');
  document.getElementById('b-ring').classList.add('on');
  document.body.classList.add('amb-active');
  state.timer.interval = setInterval(tickTimer, 1000);
}

function pauseTimer() {
  state.timer.running = false;
  clearInterval(state.timer.interval);
  document.getElementById('btn-icon').className = 'fas fa-play';
  document.getElementById('t-glow').classList.remove('on');
  document.getElementById('b-ring').classList.remove('on');
}

function resetTimer() {
  pauseTimer();
  state.timer.remaining = state.timer.total;
  updateTimerDisplay();
}

function skipPhase() {
  pauseTimer();
  const phases = ['focus', 'short_break', 'long_break'];
  const idx = phases.indexOf(state.timer.phase);
  setPhase(phases[(idx + 1) % phases.length]);
}

function setPhase(phase) {
  pauseTimer();
  state.timer.phase = phase;
  state.timer.remaining = PHASES[phase] * 60;
  state.timer.total = PHASES[phase] * 60;
  document.querySelectorAll('.ph-btn').forEach(b => b.classList.remove('active'));
  const phMap = { focus: 'ph-focus', short_break: 'ph-short', long_break: 'ph-long' };
  document.getElementById(phMap[phase])?.classList.add('active');
  document.getElementById('timer-phase').textContent = PHASE_LABELS[phase];
  updateTimerDisplay();
}

function tickTimer() {
  state.timer.remaining--;
  if (state.timer.phase === 'focus') state.timer.totalFocusSec++;

  const elapsed = (state.timer.total - state.timer.remaining) / 60;
  maybeShowTip(elapsed);
  checkSessionBlocking();

  if (state.timer.remaining <= 0) {
    pauseTimer();
    if (state.timer.phase === 'focus') {
      state.timer.sessions++;
      saveTimerState();
      updateStats();
      triggerCelebration(state.timer.sessions);
      // Mindful Minimum: enforce break before next session
      const nextPhase = state.timer.sessions % 4 === 0 ? 'long_break' : 'short_break';
      notify('Session complete! Mindful Minimum: take your ' + (nextPhase === 'long_break' ? '15-min' : '5-min') + ' break.', 'success');
      setPhase(nextPhase);
      state.timer.mindfulBreakRequired = true;
      // Auto-start break timer (Mindful Minimum policy)
      setTimeout(() => { if (!state.timer.running) startTimer(); }, 1500);
    } else {
      state.timer.mindfulBreakRequired = false;
      notify('Break over. Ready to focus?', 'info');
      setPhase('focus');
      // Show pre-session intent prompt after break
      setTimeout(() => maybeShowIntentPrompt(true), 500);
    }
  }
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const m = Math.floor(state.timer.remaining / 60).toString().padStart(2, '0');
  const s = (state.timer.remaining % 60).toString().padStart(2, '0');
  document.getElementById('timer-display').textContent = m + ':' + s;
  document.title = m + ':' + s + ' — FlowState';
  const circ = 615.75;
  const offset = circ * (1 - (state.timer.remaining / state.timer.total));
  document.getElementById('ring-prog').style.strokeDashoffset = circ - offset;
}

function updateStats() {
  document.getElementById('stat-sessions').textContent = state.timer.sessions;
  const totalMin = Math.floor(state.timer.totalFocusSec / 60);
  document.getElementById('stat-focus').textContent = totalMin >= 60 ? Math.floor(totalMin/60) + 'h ' + (totalMin%60) + 'm' : totalMin + 'm';
  const streak = parseInt(localStorage.getItem('fs_streak') || '0');
  document.getElementById('stat-streak').textContent = '🔥 ' + streak;
  // Update FlowScore in header/metrics
  refreshFlowScore();
}

async function refreshFlowScore() {
  try {
    const streak = parseInt(localStorage.getItem('fs_streak') || '0');
    const data = await fetch('/api/flowscore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totalFocusSeconds: state.timer.totalFocusSec, sessionCount: state.timer.sessions, breaksCompleted: state.timer.sessions, breathingExercises: parseInt(localStorage.getItem('fs_breathing') || '0'), gratitudeEntries: parseInt(localStorage.getItem('fs_gratitude_count') || '0'), streak, sleepHours: 7, steps: 5000, hydrationGlasses: 6 }) }).then(r => r.json());
    const scoreEl = document.getElementById('fs-score-badge');
    if (scoreEl) { scoreEl.textContent = '⚡ ' + data.score + ' — ' + data.label; scoreEl.title = data.explanation + ' | ' + data.tomorrowTip; scoreEl.style.display = 'block'; }
    const insScore = document.getElementById('ins-score');
    if (insScore) insScore.textContent = data.score + ' / 100 — ' + data.label;
  } catch {}
}

function saveTimerState() {
  localStorage.setItem('fs_timer_state', JSON.stringify({ sessions: state.timer.sessions, totalFocusSec: state.timer.totalFocusSec, focusMin: state.settings.focusMin }));
}

// ─── Pre-session intent prompt ────────────────────────────────────────────────
let intentShown = false;
function maybeShowIntentPrompt(force) {
  if (!force && intentShown) return;
  if (state.timer.running && !force) return;
  intentShown = true;
  const overlay = document.createElement('div');
  overlay.className = 'intent-modal';
  overlay.id = 'intent-modal';
  overlay.innerHTML = '<div class="intent-card"><h2>What are you working on?</h2><p>FlowState will set your ambient, AI model, and tips based on your task.</p><input class="intent-input" id="intent-in" placeholder="e.g. debugging the auth flow, writing blog post, designing landing page..." autofocus><div class="intent-suggestions">' +
    ['Coding / debugging','Writing / content','Design / Figma','Research / reading','Planning / admin','Team standup prep'].map(s => '<button class="intent-sug" onclick="setIntentSug(\'' + s + '\')">' + s + '</button>').join('') +
    '</div><div style="display:flex;gap:8px"><button class="ob-btn" style="flex:1" onclick="submitIntent()">Set Intent</button><button class="ob-btn" style="flex:0 0 auto;background:var(--bg-card);color:var(--text-s);border:1px solid var(--border)" onclick="dismissIntent()">Skip</button></div></div>';
  document.body.appendChild(overlay);
  document.getElementById('intent-in').focus();
}
function setIntentSug(s) { document.getElementById('intent-in').value = s; }
async function submitIntent() {
  const desc = document.getElementById('intent-in')?.value || '';
  if (desc) {
    const ctx = await fetch('/api/session/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: desc }) }).then(r => r.json()).catch(() => null);
    if (ctx) {
      state.chat.model = ctx.suggestedModel;
      buildModelBar();
      notify('Intent set — routing to ' + ctx.suggestedModel + ' for ' + ctx.context + ' work', 'info');
    }
  }
  dismissIntent();
  if (!state.timer.running) startTimer();
}
function dismissIntent() { document.getElementById('intent-modal')?.remove(); }

// ─── Model bar ────────────────────────────────────────────────────────────────
const MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o', color: '#10b981' },
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7', color: '#f59e0b' },
  { id: 'gemini-2-flash', name: 'Gemini 2.0', color: '#3b82f6' },
  { id: 'grok-3', name: 'Grok 3', color: '#8b5cf6' },
  { id: 'mistral-large', name: 'Mistral', color: '#06b6d4' },
  { id: 'deepseek-r1', name: 'DeepSeek R1', color: '#a855f7' },
  { id: 'llama-3-3', name: 'Llama 3.3', color: '#3b82f6' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', color: '#10b981', badge: 'Free' },
];
function buildModelBar() {
  const bar = document.getElementById('model-bar');
  if (!bar) return;
  bar.innerHTML = MODELS.map(m => '<button class="m-chip ' + (state.chat.model === m.id ? 'active' : '') + '" onclick="selectModel(\'' + m.id + '\')" style="border-color:' + m.color + '20">' +
    '<span style="width:6px;height:6px;border-radius:50%;background:' + m.color + ';flex-shrink:0;display:inline-block"></span>' +
    m.name + (m.badge ? ' <span class="badge">' + m.badge + '</span>' : '') + '</button>').join('') +
    '<div class="route-badge"><div class="r-dot"></div>Auto-routing</div>';
}
function selectModel(id) {
  state.chat.model = id === state.chat.model ? null : id;
  buildModelBar();
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('chat-in');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = ''; input.style.height = '';
  appendMsg('user', msg, '');
  state.chat.history.push({ role: 'user', content: msg });
  const typingId = appendTyping();
  try {
    const res = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, model: state.chat.model, messages: state.chat.history.slice(-10) }) });
    const routedModel = res.headers.get('X-Routed-Model') || state.chat.model || 'gpt-4o';
    const text = await res.text();
    removeTyping(typingId);
    appendMsg('ai', text, routedModel);
    state.chat.history.push({ role: 'assistant', content: text });
  } catch (err) {
    removeTyping(typingId);
    appendMsg('ai', 'Sorry, something went wrong. Check your connection and API keys.', 'error');
  }
}

function appendMsg(role, text, model) {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const modelNames = { 'gpt-4o':'GPT-4o','claude-3-7-sonnet':'Claude 3.7','gemini-2-flash':'Gemini 2.0','grok-3':'Grok 3','mistral-large':'Mistral','deepseek-r1':'DeepSeek R1','llama-3-3':'Llama 3.3','gpt-4o-mini':'GPT-4o mini' };
  const modelLabel = modelNames[model] || model || 'FlowState AI';
  const av = role === 'user' ? (FS_USER?.picture ? '<img src="' + FS_USER.picture + '" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--border)">' : '<div class="msg-av" style="background:var(--grad)">👤</div>') : '<div class="msg-av" style="background:var(--grad)">⚡</div>';
  div.innerHTML = av + '<div>' + (role === 'ai' ? '<div class="msg-meta"><span class="m-tag">' + modelLabel + '</span></div>' : '') + '<div class="msg-bub">' + formatMsg(text) + '</div></div>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendTyping() {
  const msgs = document.getElementById('chat-msgs');
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg ai'; div.id = id;
  div.innerHTML = '<div class="msg-av" style="background:var(--grad)">⚡</div><div><div class="typing"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div>';
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
  return id;
}
function removeTyping(id) { document.getElementById(id)?.remove(); }

function formatMsg(text) {
  if (!text) return '';
  let t = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/\n/g, '<br>');
  return t;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
async function loadCalendar() {
  const banner = document.getElementById('cal-auth-banner');
  if (!FS_USER) { if (banner) banner.style.display = 'block'; return; }
  if (banner) banner.style.display = 'none';
  renderCalGrid();
  await loadCalEvents();
}

function calNav(dir) {
  state.calendar.month += dir;
  if (state.calendar.month > 11) { state.calendar.month = 0; state.calendar.year++; }
  if (state.calendar.month < 0) { state.calendar.month = 11; state.calendar.year--; }
  renderCalGrid();
}

function renderCalGrid() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('cal-month-label').textContent = months[state.calendar.month] + ' ' + state.calendar.year;
  const grid = document.getElementById('cal-grid');
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const now = new Date();
  const first = new Date(state.calendar.year, state.calendar.month, 1).getDay();
  const total = new Date(state.calendar.year, state.calendar.month + 1, 0).getDate();
  const evDays = new Set(state.calendar.events.map(e => { const d = new Date(e.start); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }));

  let html = days.map(d => '<div class="cal-hd">' + d + '</div>').join('');
  for (let i = 0; i < first; i++) html += '<div class="cal-day other"></div>';
  for (let d = 1; d <= total; d++) {
    const isToday = d === now.getDate() && state.calendar.month === now.getMonth() && state.calendar.year === now.getFullYear();
    const key = state.calendar.year + '-' + state.calendar.month + '-' + d;
    html += '<div class="cal-day ' + (isToday ? 'today' : '') + (evDays.has(key) ? ' has-ev' : '') + '">' + d + '</div>';
  }
  grid.innerHTML = html;
}

async function loadCalEvents() {
  if (!FS_USER) return;
  try {
    const data = await fetch('/api/calendar/events').then(r => r.json());
    state.calendar.events = data.events || [];
    renderCalGrid();
    renderEvents();
    checkSessionBlocking();
  } catch {}
}

function renderEvents() {
  const list = document.getElementById('ev-list');
  if (!list) return;
  if (!state.calendar.events.length) {
    list.innerHTML = '<div class="empty"><i class="fas fa-calendar-check"></i><p>No upcoming events. Free to flow.</p></div>';
    return;
  }
  list.innerHTML = state.calendar.events.slice(0, 8).map(e => {
    const t = e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return '<div class="ev-item"><div class="ev-dot" style="background:' + e.color + '"></div><div class="ev-time">' + t + '</div><div class="ev-sum">' + e.summary + '</div><button class="btn-blk" onclick="blockAroundEvent(\'' + e.id + '\')"><i class="fas fa-lock"></i></button></div>';
  }).join('');
}

async function blockAroundEvent(eventId) {
  const ev = state.calendar.events.find(e => e.id === eventId);
  if (!ev) return;
  const before = new Date(new Date(ev.start).getTime() - 30*60000);
  await fetch('/api/calendar/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '🍅 Focus Block', start: before.toISOString(), end: ev.start }) });
  notify('Focus block added before "' + ev.summary + '"', 'success');
}

function checkSessionBlocking() {
  if (!state.calendar.events.length) return;
  const dur = state.settings.focusMin || 25;
  const nowTime = new Date().toISOString();
  const conflicts = state.calendar.events.filter(e => !e.allDay);
  let blocked = null;
  for (const e of conflicts) {
    const eStart = new Date(e.start);
    const eEnd = new Date(e.end);
    const sessionEnd = new Date(Date.now() + dur * 60000);
    if ((new Date() >= eStart && new Date() <= eEnd) || (sessionEnd >= eStart && new Date() <= eStart)) {
      const mins = Math.max(0, Math.round((eStart.getTime() - Date.now()) / 60000));
      blocked = mins === 0 ? '"' + e.summary + '" is happening now' : '"' + e.summary + '" starts in ' + mins + ' min';
      break;
    }
  }
  const warn = document.getElementById('block-warn');
  if (warn) {
    if (blocked) { warn.style.display = 'block'; document.getElementById('block-msg').textContent = blocked; }
    else warn.style.display = 'none';
  }
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
function buildMetrics() {
  const totalFocusMin = Math.floor(state.timer.totalFocusSec / 60);
  const streak = parseInt(localStorage.getItem('fs_streak') || '0');
  const grid = document.getElementById('metrics-grid');
  if (!grid) return;
  const items = [
    { icon: '🎯', val: state.timer.sessions, lbl: 'Sessions Today', trend: '+' + state.timer.sessions + ' today' },
    { icon: '⏱️', val: totalFocusMin + 'm', lbl: 'Focus Minutes', trend: 'Goal: ' + (state.settings.focusMin * 4) + 'm' },
    { icon: '🔥', val: streak, lbl: 'Day Streak', trend: streak > 0 ? 'Keep it going' : 'Start today' },
    { icon: '📊', val: Math.round(state.timer.sessions > 0 ? 85 : 0) + '%', lbl: 'Completion Rate', trend: 'Last 7 days' },
    { icon: '💙', val: parseInt(localStorage.getItem('fs_gratitude_count') || '0'), lbl: 'Gratitude Entries', trend: 'Logged this week' },
    { icon: '🧠', val: parseInt(localStorage.getItem('fs_learn_cards_seen') || '0'), lbl: 'Cards Learned', trend: 'Carousel views' },
  ];
  grid.innerHTML = items.map(i => '<div class="m-card"><div class="m-icon">' + i.icon + '</div><div class="m-val">' + i.val + '</div><div class="m-lbl">' + i.lbl + '</div><div class="m-trend">' + i.trend + '</div></div>').join('');

  // Focus chart
  const ctx = document.getElementById('focus-chart');
  if (ctx && window.Chart) {
    const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const data = [3,5,4,6,2,state.timer.sessions,0];
    new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label: 'Sessions', data, backgroundColor: 'rgba(168,85,247,.4)', borderColor: '#a855f7', borderWidth: 2, borderRadius: 6 }] }, options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: 'rgba(168,85,247,.08)' }, ticks: { color: '#888' } }, y: { grid: { color: 'rgba(168,85,247,.08)' }, ticks: { color: '#888', stepSize: 1 } } } } });
  }
}

async function loadBehaviorInsight() {
  const box = document.getElementById('insight-box');
  if (!box) return;
  try {
    const params = new URLSearchParams({ focus: state.timer.totalFocusSec, sessions: state.timer.sessions, streak: localStorage.getItem('fs_streak') || '0', completion: '0.8' });
    const data = await fetch('/api/behavior/insight?' + params).then(r => r.json());
    document.getElementById('ins-hl').textContent = data.headline;
    document.getElementById('ins-detail').textContent = data.detail;
    document.getElementById('ins-rec').textContent = data.recommendation;
    document.getElementById('ins-score').textContent = data.flowScore + ' / 100';
    document.getElementById('ins-src').innerHTML = (data.sources || []).map(s => '<span class="src-badge">' + s + '</span>').join('');
  } catch {}
}

// ─── Board / Kanban ───────────────────────────────────────────────────────────
function buildBoard() {
  const notionPanel = document.getElementById('board-notion-panel');
  const dbSelect = document.getElementById('board-db-select');
  if (!FS_NOTION) {
    if (notionPanel) notionPanel.style.display = 'block';
    if (dbSelect) dbSelect.style.display = 'none';
    renderKanban();
    return;
  }
  if (notionPanel) notionPanel.style.display = 'none';
  if (dbSelect) dbSelect.style.display = 'block';
  loadNotionDbs();
}

async function loadNotionDbs() {
  const list = document.getElementById('notion-db-list');
  if (!list) return;
  list.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await fetch('/api/notion/databases').then(r => r.json());
    if (!data.databases?.length) { list.innerHTML = '<div class="empty"><p>No databases found in your Notion workspace.</p></div>'; return; }
    list.innerHTML = data.databases.map(db => '<div class="notion-db ' + (state.kanban.notionDbId === db.id ? 'sel' : '') + '" onclick="selectNotionDb(\'' + db.id + '\',\'' + db.title.replace(/'/g,"\\'") + '\')">' + db.icon + ' <strong>' + db.title + '</strong></div>').join('');
  } catch { list.innerHTML = '<div class="empty"><p>Could not load Notion databases.</p></div>'; }
}

async function selectNotionDb(id, title) {
  state.kanban.notionDbId = id;
  document.querySelectorAll('.notion-db').forEach(el => el.classList.toggle('sel', el.textContent.includes(title)));
  notify('Loading ' + title + ' board...', 'info');
  await loadNotionPages(id);
}

async function loadNotionPages(dbId) {
  try {
    const data = await fetch('/api/notion/pages/' + dbId).then(r => r.json());
    state.kanban.columns = { todo: [], inprogress: [], done: [] };
    (data.pages || []).forEach(p => {
      const col = state.kanban.columns[p.status] || state.kanban.columns.todo;
      col.push({ id: p.id, title: p.title, icon: p.icon, url: p.url, notionId: p.id });
    });
    renderKanban();
  } catch { notify('Could not load Notion pages', 'error'); }
}

function renderKanban() {
  const wrap = document.getElementById('board-wrap');
  if (!wrap) return;
  const cols = { todo: { label: 'To Do', color: '#888' }, inprogress: { label: 'In Progress', color: '#f59e0b' }, done: { label: 'Done', color: '#10b981' } };
  wrap.innerHTML = Object.entries(cols).map(([key, meta]) => {
    const cards = state.kanban.columns[key] || [];
    return '<div class="k-col" id="col-' + key + '" ondragover="event.preventDefault()" ondrop="drop(event,\'' + key + '\')">' +
      '<div class="k-col-hd"><div class="k-col-title" style="color:' + meta.color + '">' + meta.label + '</div><div class="k-count">' + cards.length + '</div></div>' +
      '<div class="k-cards" id="cards-' + key + '">' +
      cards.map(card => '<div class="k-card" draggable="true" id="card-' + card.id + '" ondragstart="dragStart(event,\'' + card.id + '\',\'' + key + '\')">' +
        '<div class="k-card-title">' + (card.icon || '📄') + ' ' + card.title + '</div>' +
        (card.tag ? '<span class="k-tag">' + card.tag + '</span>' : '') +
        '</div>').join('') +
      '</div></div>';
  }).join('');
}

let dragId = null, dragFrom = null;
function dragStart(e, id, col) { dragId = id; dragFrom = col; e.currentTarget.classList.add('dragging'); }
async function drop(e, col) {
  e.preventDefault();
  if (!dragId || dragFrom === col) { dragId = null; return; }
  const card = state.kanban.columns[dragFrom]?.find(c => c.id === dragId);
  if (!card) return;
  state.kanban.columns[dragFrom] = state.kanban.columns[dragFrom].filter(c => c.id !== dragId);
  state.kanban.columns[col] = state.kanban.columns[col] || [];
  state.kanban.columns[col].push(card);
  renderKanban();
  if (card.notionId && state.kanban.notionDbId) {
    const statusMap = { todo: 'Not started', inprogress: 'In progress', done: 'Done' };
    await fetch('/api/notion/pages/' + card.notionId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: statusMap[col], propertyName: 'Status', propertyType: 'status' }) }).catch(() => {});
    notify('Synced to Notion: ' + card.title + ' → ' + statusMap[col], 'success');
  }
  dragId = null; dragFrom = null;
}

// ─── Team Hub ─────────────────────────────────────────────────────────────────
function buildTeam() {
  buildSprintHealth();
  buildTeamPulse();
}

function buildSprintHealth() {
  const now = new Date();
  const sprintEnd = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
  const sprintStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const mockCards = [
    { id:'1', title:'Auth flow', status:'done', lastMovedAt: new Date(Date.now()-24*3600000).toISOString() },
    { id:'2', title:'API routes', status:'done', lastMovedAt: new Date(Date.now()-12*3600000).toISOString() },
    { id:'3', title:'Dashboard UI', status:'inprogress', lastMovedAt: new Date(Date.now()-50*3600000).toISOString() },
    { id:'4', title:'Team tab', status:'inprogress', lastMovedAt: new Date(Date.now()-4*3600000).toISOString() },
    { id:'5', title:'Sprint health', status:'todo', lastMovedAt: new Date(Date.now()-100*3600000).toISOString() },
    { id:'6', title:'Invite loop', status:'todo' },
    { id:'7', title:'Billing', status:'todo' },
    { id:'8', title:'Deploy', status:'todo' },
  ];

  fetch('/api/team/sprint-health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: mockCards, sprintStart: sprintStart.toISOString(), sprintEnd: sprintEnd.toISOString(), teamFocusHours: state.timer.totalFocusSec / 3600 }) })
    .then(r => r.json()).then(health => {
      document.getElementById('sh-pct').textContent = health.completionPercent + '%';
      document.getElementById('sh-exp').textContent = health.expectedPercent + '%';
      document.getElementById('sh-days').textContent = health.daysRemaining + ' days left';
      const fill = document.getElementById('sh-fill');
      if (fill) { fill.style.width = health.completionPercent + '%'; fill.style.background = { ahead: 'var(--green)', on_track: '#3b82f6', at_risk: 'var(--warn)', critical: 'var(--danger)' }[health.pace]; }
      const paceColors = { ahead: 'var(--green)', on_track: '#3b82f6', at_risk: 'var(--warn)', critical: 'var(--danger)' };
      const paceEmoji = { ahead: '🟢', on_track: '🔵', at_risk: '🟡', critical: '🔴' };
      document.getElementById('sh-pace').innerHTML = '<span class="pace-badge" style="background:' + paceColors[health.pace] + '20;color:' + paceColors[health.pace] + '">' + paceEmoji[health.pace] + ' ' + health.pace.replace('_',' ').toUpperCase() + '</span>';
      document.getElementById('sh-assessment').textContent = health.deadlineAssessment;
      document.getElementById('sh-stats').innerHTML = [
        { v: health.totalCards, l: 'Total Cards' }, { v: health.completedCards, l: 'Done' },
        { v: health.inProgressCards, l: 'In Progress' }, { v: health.daysRemaining, l: 'Days Left' }
      ].map(s => '<div class="sh-stat"><div class="sh-stat-v">' + s.v + '</div><div class="sh-stat-l">' + s.l + '</div></div>').join('');
      const actions = document.getElementById('sh-actions');
      if (actions) actions.innerHTML = (health.suggestedActions || []).map(a => '<div class="action-item"><i class="fas fa-arrow-right"></i>' + a + '</div>').join('');
    }).catch(() => {});
}

function buildTeamPulse() {
  const pulse = document.getElementById('team-pulse-grid');
  if (!pulse) return;
  const mockTeam = [
    { name: FS_USER?.name || 'You', role: 'Admin', status: 'focus', emoji: '🧑', sessions: state.timer.sessions, burnout: 10 },
    { name: 'Alex Chen', role: 'Senior Dev', status: 'online', emoji: '👩', sessions: 3, burnout: 20 },
    { name: 'Jordan Lee', role: 'Scrum Master', status: 'break', emoji: '🧑', sessions: 5, burnout: 45 },
    { name: 'Sam Rivera', role: 'Member', status: 'offline', emoji: '👨', sessions: 1, burnout: 65 },
  ];
  const statusLabel = { focus: 'In focus session', online: 'Online', break: 'On break', offline: 'Offline' };
  pulse.innerHTML = mockTeam.map(m => {
    const burnoutColor = m.burnout >= 50 ? 'var(--danger)' : m.burnout >= 25 ? 'var(--warn)' : 'var(--green)';
    return '<div class="member-card"><div class="pulse-dot ' + m.status + '"></div><div class="member-av">' + m.emoji + '</div><div class="member-name">' + m.name + '</div><div class="member-role">' + m.role + '</div><div style="font-size:11px;color:var(--text-m)">' + statusLabel[m.status] + '</div><div style="font-size:11px;color:var(--text-m);margin-top:4px">' + m.sessions + ' sessions today</div><div class="burnout-bar"><div class="burnout-fill" style="width:' + m.burnout + '%;background:' + burnoutColor + '"></div></div><div style="font-size:10px;color:' + burnoutColor + ';margin-top:3px">Wellness: ' + (100 - m.burnout) + '/100</div></div>';
  }).join('');
}

function refreshTeamPulse() { buildTeam(); notify('Team pulse refreshed', 'info'); }

function openSlackModal() {
  if (!FS_SLACK) {
    openModal('Connect Slack', '<div class="auth-banner"><h3>Connect your Slack workspace</h3><p>Enable team sprint updates, async standups, and celebration messages.</p><button class="btn-primary" onclick="connectSlack()"><i class="fab fa-slack"></i>&nbsp; Connect Slack</button></div>');
  } else {
    openModal('Slack', '<div><p style="margin-bottom:14px">Connected to <strong>' + FS_SLACK.team + '</strong></p><button class="btn-primary" onclick="sendTestSlack()">Send test message</button></div>');
  }
}
async function sendTestSlack() {
  const data = await fetch('/api/slack/channels').then(r => r.json()).catch(() => ({ channels: [] }));
  if (data.channels?.length) {
    await fetch('/api/slack/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: data.channels[0].id, text: '🍅 FlowState connected! Your team will now receive sprint updates here.' }) });
    notify('Test message sent to #' + data.channels[0].name, 'success');
  } else {
    notify('No channels found — check Slack permissions', 'warning');
  }
  closeModal();
}

// ─── Learn ────────────────────────────────────────────────────────────────────
async function loadLearnCards() {
  const data = await fetch('/api/learn/cards').then(r => r.json()).catch(() => ({ cards: [] }));
  state.learn.cards = data.cards || [];
  renderLearn();
  if (state.learn.interval) clearInterval(state.learn.interval);
  state.learn.interval = setInterval(() => {
    state.learn.idx = (state.learn.idx + 1) % state.learn.cards.length;
    renderLearn();
  }, 30000);
}

function renderLearn() {
  const car = document.getElementById('learn-car');
  const nav = document.getElementById('l-nav');
  const all = document.getElementById('all-learn-cards');
  if (!car || !state.learn.cards.length) return;

  const card = state.learn.cards[state.learn.idx];
  car.style.background = 'linear-gradient(135deg,' + (card.color || '#1a1a2e') + '33,#1a1a2e)';
  car.innerHTML = '<div class="l-card active"><div class="l-type">' + (card.emoji || '') + ' ' + (card.type || '').replace('_',' ') + '</div><div class="l-title">' + card.title + '</div><div class="l-content">' + card.content + '</div>' + (card.meta ? '<div class="l-meta">' + card.meta + '</div>' : '') + '</div>';

  if (nav) nav.innerHTML = '<button class="l-nav-btn" onclick="learnNav(-1)"><i class="fas fa-chevron-left"></i></button>' +
    state.learn.cards.map((_, i) => '<div class="l-dot ' + (i === state.learn.idx ? 'active' : '') + '" onclick="learnGo(' + i + ')"></div>').slice(0, 12).join('') +
    '<button class="l-nav-btn" onclick="learnNav(1)"><i class="fas fa-chevron-right"></i></button>';

  if (all) all.innerHTML = state.learn.cards.map((c, i) => '<div style="background:' + (c.color || '#1a1a2e') + '18;border:1px solid ' + (c.color || 'var(--border)') + '33;border-radius:11px;padding:12px;cursor:pointer" onclick="learnGo(' + i + ')"><div style="font-size:18px;margin-bottom:5px">' + (c.emoji || '') + '</div><div style="font-size:12px;font-weight:700;margin-bottom:3px">' + c.title + '</div><div style="font-size:11px;color:var(--text-m)">' + (c.type || '').replace('_',' ') + '</div></div>').join('');

  localStorage.setItem('fs_learn_cards_seen', state.learn.cards.length);
}

function learnNav(dir) { state.learn.idx = (state.learn.idx + dir + state.learn.cards.length) % state.learn.cards.length; renderLearn(); }
function learnGo(i) { state.learn.idx = i; renderLearn(); }

// ─── Restore ──────────────────────────────────────────────────────────────────
async function loadRestore() {
  const data = await fetch('/api/restore/intent').then(r => r.json()).catch(() => null);
  if (!data) return;
  state.restore.current = data;
  renderRestore(data);
}

function renderRestore(r) {
  const scene = document.getElementById('r-scene');
  const nav = document.getElementById('r-nav');
  if (!scene) return;
  scene.style.background = 'linear-gradient(' + (r.bgGradient || '135deg,#1a1a2e,#0f0f1a') + ')';
  scene.style.color = '#fff';
  let inner = '<div class="r-emoji">' + (r.emoji || '') + '</div><div class="r-title">' + r.title + '</div><div class="r-content">' + r.content + '</div>';
  if (r.steps?.length) {
    inner += '<div class="r-steps">' + r.steps.map((s, i) => '<div class="r-step"><div class="r-step-n">' + (i+1) + '</div>' + s + '</div>').join('') + '</div>';
  }
  if (r.mode === 'gratitude') {
    inner += '<input class="grat-in" id="grat-in" placeholder="I am grateful for..."><button class="r-btn" onclick="logGratitude()"><i class="fas fa-heart"></i>&nbsp; Log it</button>';
  }
  if (r.mode === 'breathing') {
    inner += '<div class="breath-circ" id="breath-circ" onclick="toggleBreath(this)">Tap to start</div>';
  }
  scene.innerHTML = inner;
  if (nav) nav.innerHTML = '<button class="r-btn" onclick="loadRestore()"><i class="fas fa-refresh"></i>&nbsp; Next</button><button class="r-btn" onclick="switchTab(\'focus\')">Back to Focus</button>';
}

let breathInterval = null;
function toggleBreath(el) {
  if (breathInterval) { clearInterval(breathInterval); breathInterval = null; el.textContent = 'Tap to start'; el.classList.remove('expand'); return; }
  const seq = [{ label:'Inhale', dur:4000 }, { label:'Hold', dur:7000 }, { label:'Exhale', dur:8000 }];
  let i = 0;
  const run = () => { el.textContent = seq[i].label; if (seq[i].label === 'Inhale') el.classList.add('expand'); else el.classList.remove('expand'); i = (i+1) % seq.length; };
  run();
  breathInterval = setInterval(run, 4000);
}

function logGratitude() {
  const val = document.getElementById('grat-in')?.value;
  if (!val) return;
  const entries = JSON.parse(localStorage.getItem('fs_gratitude') || '[]');
  entries.push({ text: val, ts: Date.now() });
  localStorage.setItem('fs_gratitude', JSON.stringify(entries));
  localStorage.setItem('fs_gratitude_count', entries.length);
  notify('Gratitude logged. That matters.', 'success');
  loadRestore();
}

// ─── Generate ─────────────────────────────────────────────────────────────────
async function generateImage() {
  const prompt = document.getElementById('img-prompt')?.value;
  const model = document.getElementById('img-model-sel')?.value;
  if (!prompt) { notify('Enter a prompt first', 'warning'); return; }
  const btn = document.querySelector('[onclick="generateImage()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  const data = await fetch('/api/generate/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, model }) }).then(r => r.json()).catch(e => ({ error: e.message }));
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i>&nbsp; Generate Image'; }
  if (data.error && !data.imageUrl) { notify(data.error, 'error'); return; }
  const results = document.getElementById('img-results');
  if (results && data.imageUrl) results.innerHTML = '<img class="gen-img" src="' + data.imageUrl + '" alt="Generated" onclick="window.open(this.src)">';
  if (data.demo) notify('Demo mode: ' + data.error, 'info');
}

async function generateVideo() {
  const prompt = document.getElementById('vid-prompt')?.value;
  const model = document.getElementById('vid-model-sel')?.value;
  const duration = document.getElementById('vid-dur')?.value;
  if (!prompt) { notify('Enter a prompt first', 'warning'); return; }
  const btn = document.querySelector('[onclick="generateVideo()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>'; }
  const data = await fetch('/api/generate/video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, model, duration: parseInt(duration) }) }).then(r => r.json()).catch(e => ({ error: e.message }));
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-film"></i>&nbsp; Generate Video'; }
  const result = document.getElementById('vid-result');
  if (result) result.textContent = data.message || data.error || 'Done';
}

// ─── Tip bubbles ──────────────────────────────────────────────────────────────
async function maybeShowTip(elapsed) {
  if (!state.timer.running) return;
  const now = Date.now();
  if (now - state.timer.lastTipAt < 5 * 60 * 1000) return;
  const tips = [
    { emoji: '💧', cat: 'Hydration', msg: 'Water check. One glass every 45 minutes keeps the brain sharp.' },
    { emoji: '🧘', cat: 'Posture', msg: 'Shoulders back, chin level. Roll them twice.' },
    { emoji: '👁️', cat: 'Eye Care', msg: 'Look 20 feet away for 20 seconds. Your eyes will thank you.' },
    { emoji: '🏃', cat: 'Movement', msg: 'Stand up. Shake it out. Movement resets cortisol.' },
    { emoji: '⚡', cat: 'Encouragement', msg: 'Every session is a vote for the person you are becoming.' },
    { emoji: '🎯', cat: 'Focus', msg: 'One tab, one task. Close everything else.' },
  ];
  const tip = tips[Math.floor(Math.random() * tips.length)];
  state.timer.lastTipAt = now;
  const el = document.createElement('div');
  el.className = 'tip-bub';
  el.innerHTML = '<button class="tip-x" onclick="this.parentElement.remove()">✕</button><div class="tip-hd"><span class="tip-emoji">' + tip.emoji + '</span><span class="tip-cat">' + tip.cat + '</span></div><div class="tip-msg">' + tip.msg + '</div>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

// ─── Celebrations ─────────────────────────────────────────────────────────────
function triggerCelebration(sessionNum) {
  const msgs = [
    ['Session Complete', 'One step closer to your goals.', '🎯'],
    ['Flow Achieved', 'You were in the zone. That is rare.', '⚡'],
    ['Deep Work Done', 'Your future self is grateful.', '🧠'],
    ['On Fire', 'Four sessions. Championship-level focus.', '🔥'],
    ['Flow Master', 'You make it look effortless.', '🏆'],
  ];
  const idx = Math.min(sessionNum - 1, msgs.length - 1);
  const [title, sub, emoji] = msgs[Math.max(0, idx)];
  const ov = document.createElement('div');
  ov.className = 'celeb-ov';
  ov.innerHTML = '<div class="celeb-card"><span class="celeb-emoji">' + emoji + '</span><div class="celeb-title">' + title + '</div><div class="celeb-sub">' + sub + '</div><button class="btn-sm" style="margin-top:14px" onclick="this.closest(\'.celeb-ov\').remove()">Keep going</button></div>';
  document.body.appendChild(ov);
  if (sessionNum >= 2) spawnConfetti(Math.floor(30 + sessionNum * 20));
  setTimeout(() => ov.remove(), 5000);
}

function spawnConfetti(count) {
  const colors = ['#a855f7','#ec4899','#3b82f6','#10b981','#f59e0b','#ef4444'];
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'confetti-p';
      el.style.cssText = 'left:' + (20 + Math.random() * 60) + 'vw;top:' + Math.random() * 30 + 'vh;background:' + colors[Math.floor(Math.random()*colors.length)] + ';--tx:' + (Math.random()*200-100) + 'px;--ty:' + (100+Math.random()*300) + 'px;animation-duration:' + (1.5+Math.random()*2) + 's;transform:rotate(' + Math.random()*360 + 'deg)';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    }, i * 30);
  }
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(title, content) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-ov'; ov.id = 'modal-ov';
  ov.onclick = e => { if (e.target === ov) closeModal(); };
  ov.innerHTML = '<div class="modal-card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><div style="font-size:16px;font-weight:800">' + title + '</div><button onclick="closeModal()" style="background:none;border:none;color:var(--text-m);font-size:18px;cursor:pointer">✕</button></div>' + content + '</div>';
  document.body.appendChild(ov);
}
function closeModal() { document.getElementById('modal-ov')?.remove(); }

function openPricingModal() {
  const tiers = [
    { id:'free', name:'Free', price:'$0', per:'forever', color:'#888', features:['Pomodoro timer','GPT-4o-mini chat','Manual Kanban','Basic metrics'] },
    { id:'personal_pro', name:'Personal Pro', price:'$12', per:'/mo', color:'#a855f7', features:['All 7 AI models','Google Calendar + Notion','Image generation','FlowScore'], hi:true },
    { id:'team_starter', name:'Team Starter', price:'$49', per:'/mo', color:'#3b82f6', features:['Up to 5 seats','Team Hub + Pulse','Slack sync','Team AI Chat'] },
    { id:'team_growth', name:'Team Growth', price:'$149', per:'/mo', color:'#ec4899', features:['Up to 20 seats','Sprint Health','Burnout detection','Video generation'] },
    { id:'enterprise', name:'Enterprise', price:'Custom', per:'', color:'#f59e0b', features:['Unlimited seats','SSO / SAML','Custom integrations','Dedicated support'] },
  ];
  const html = '<p style="color:var(--text-s);font-size:13px;margin-bottom:14px">All keys managed server-side. Your data is never sold.</p><div class="tier-cards">' +
    tiers.map(t => '<div class="t-card ' + (t.hi ? 'hi' : '') + '"><h3>' + t.name + '</h3><div class="price">' + t.price + '</div><div style="font-size:11px;color:var(--text-m);margin-bottom:8px">' + t.per + '</div><ul class="t-feats">' + t.features.map(f => '<li>' + f + '</li>').join('') + '</ul>' + (t.id === 'free' ? '<button class="btn-primary" style="width:100%;margin-top:12px;font-size:12px;padding:8px;opacity:.5" disabled>Current Plan</button>' : t.id === 'enterprise' ? '<button class="btn-primary" style="width:100%;margin-top:12px;font-size:12px;padding:8px" onclick="notify(\'Contact team@flowstate.ai for enterprise pricing\',\'info\')">Contact Sales</button>' : '<button class="btn-primary" style="width:100%;margin-top:12px;font-size:12px;padding:8px" onclick="startCheckout(\'' + t.id + '\')">Get Started</button>') + '</div>').join('') +
    '</div>';
  openModal('Upgrade FlowState', html);
}

async function startCheckout(tier) {
  if (!FS_USER) { notify('Sign in first to upgrade', 'warning'); return; }
  notify('Preparing checkout...', 'info');
  const res = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }) }).then(r => r.json()).catch(() => null);
  if (!res) { notify('Checkout error — try again', 'error'); return; }
  if (res.demo) { notify('Stripe coming soon — add STRIPE_SECRET_KEY to activate', 'info'); return; }
  if (res.checkoutUrl) window.open(res.checkoutUrl, '_blank');
  else notify('Checkout error: ' + (res.error || 'unknown'), 'error');
}

async function openCredsModal() {
  try {
    const data = await fetch('/api/credentials').then(r => r.json());
    const creds = data.credentials || [];
    const html = '<p style="color:var(--text-s);font-size:13px;margin-bottom:12px">All keys are managed by Mason and stored as Cloudflare Secrets — never exposed to users.</p>' +
      '<table class="cred-tbl"><thead><tr><th>Service</th><th>Purpose</th><th>Env Key</th><th>Required</th><th>Docs</th></tr></thead><tbody>' +
      creds.map(c => '<tr><td><strong>' + c.service + '</strong></td><td style="color:var(--text-s)">' + c.purpose + '</td><td><code style="font-size:10px">' + c.envKey + '</code></td><td><span class="badge-' + c.required + '">' + c.required + '</span></td><td><a href="' + c.url + '" target="_blank">Docs ↗</a></td></tr>').join('') +
      '</tbody></table>';
    openModal('API Credentials', html);
  } catch { openModal('Credentials', '<p>Could not load credentials.</p>'); }
}

function openInviteModal() {
  if (!FS_USER) { notify('Sign in to get your invite link', 'info'); return; }
  fetch('/api/invite/generate', { method: 'POST' }).then(r => r.json()).then(invite => {
    const html = '<div class="invite-box"><div style="font-size:14px;color:var(--text-s);margin-bottom:8px">Your invite link</div><div class="invite-code">' + invite.inviteCode + '</div><div style="font-size:13px;color:var(--text-s);margin-bottom:14px">' + invite.inviteeReward + '</div><div style="font-size:12px;color:var(--text-m);margin-bottom:14px">You get: ' + invite.inviterReward + '</div><button class="btn-primary" onclick="navigator.clipboard.writeText(\'' + invite.shareUrl + '\').then(()=>notify(\'Link copied!\',\'success\'))"><i class="fas fa-copy"></i>&nbsp; Copy Link</button></div>';
    openModal('Invite a Colleague', html);
  }).catch(() => notify('Could not generate invite link', 'error'));
}

function openSettingsModal() {
  const html = '<div style="display:flex;flex-direction:column;gap:14px">' +
    '<div><div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:7px;text-transform:uppercase;letter-spacing:1px">Focus Duration</div><div style="display:flex;gap:8px">' + [25,45,90].map(m => '<button class="ph-btn ' + (state.settings.focusMin === m ? 'active' : '') + '" onclick="updateFocusDur(' + m + ')">' + m + ' min</button>').join('') + '</div></div>' +
    (FS_USER ? '<div><div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:7px;text-transform:uppercase;letter-spacing:1px">Account</div><button class="btn-sm" onclick="signOut()"><i class="fas fa-sign-out"></i>&nbsp; Sign Out</button></div>' : '') +
    '<div><div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:7px;text-transform:uppercase;letter-spacing:1px">Integrations</div>' +
    '<div style="display:flex;flex-direction:column;gap:7px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--bg-card);border-radius:9px"><span>Google Calendar</span>' + (FS_USER ? '<span style="color:var(--green);font-size:12px;font-weight:700">✓ Connected</span>' : '<button class="btn-sm" onclick="signInGoogle()">Connect</button>') + '</div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--bg-card);border-radius:9px"><span>Notion</span>' + (FS_NOTION ? '<span style="color:var(--green);font-size:12px;font-weight:700">✓ ' + FS_NOTION.workspace + '</span>' : '<button class="btn-sm" onclick="connectNotion()">Connect</button>') + '</div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--bg-card);border-radius:9px"><span>Slack</span>' + (FS_SLACK ? '<span style="color:var(--green);font-size:12px;font-weight:700">✓ ' + FS_SLACK.team + '</span>' : '<button class="btn-sm" onclick="connectSlack()">Connect</button>') + '</div>' +
    '</div></div></div>';
  openModal('Settings', html);
}

function updateFocusDur(m) {
  state.settings.focusMin = m;
  PHASES.focus = m;
  if (!state.timer.running) { state.timer.remaining = m * 60; state.timer.total = m * 60; updateTimerDisplay(); }
  saveTimerState();
  notify('Focus duration set to ' + m + ' minutes', 'success');
  closeModal();
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
  document.getElementById('tab-' + tab)?.classList.add('active');
  const pane = document.getElementById('tab-pane-' + tab);
  if (pane) { pane.style.display = 'flex'; pane.classList.add('active'); }
  if (tab === 'metrics') { buildMetrics(); loadBehaviorInsight(); }
  if (tab === 'board') buildBoard();
  if (tab === 'team') buildTeam();
}

// ─── Notifications ────────────────────────────────────────────────────────────
function notify(msg, type) {
  const colors = { success: 'var(--green)', error: 'var(--danger)', info: 'var(--accent)', warning: 'var(--warn)' };
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid ' + (colors[type] || 'var(--border)') + ';color:' + (colors[type] || 'var(--text-p)') + ';padding:9px 18px;border-radius:11px;font-size:13px;font-weight:600;z-index:9999;animation:fadeUp .3s ease;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.4)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Sound ────────────────────────────────────────────────────────────────────
function toggleSound(type) {
  document.querySelectorAll('.s-chip').forEach(c => c.classList.remove('active'));
  if (type === 'off' || type === state.settings.sound) { state.settings.sound = null; return; }
  state.settings.sound = type;
  event?.target?.classList.add('active');
  notify('Ambient: ' + type, 'info');
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); toggleTimer(); }
    if (e.key === 'Escape') { closeModal(); dismissIntent(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'm') { e.preventDefault(); switchTab('chat'); }
  });
  const chatIn = document.getElementById('chat-in');
  if (chatIn) {
    chatIn.addEventListener('input', () => { chatIn.style.height = ''; chatIn.style.height = Math.min(chatIn.scrollHeight, 130) + 'px'; });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
boot();
</script>
</body>
</html>`)
})

export default app
