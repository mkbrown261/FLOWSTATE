import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
  declareModelRouting, declareTipIntent, declareCelebration,
  declareBehaviorInsight, declareTierCapabilities, declareGoogleOAuth,
  declareNotionOAuth, declareLearnCards, declareRestoreIntent,
  declareSessionBlocking, declareSessionBlocking as _sblock,
  MODEL_REGISTRY, IMAGE_MODEL_REGISTRY, VIDEO_MODEL_REGISTRY,
  CREDENTIAL_TABLE,
  type SessionIntent, type BehaviorData,
} from './intent-layer'

type Bindings = {
  OPENAI_API_KEY: string
  ANTHROPIC_API_KEY: string
  GOOGLE_AI_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  NOTION_CLIENT_ID: string
  NOTION_CLIENT_SECRET: string
  XAI_API_KEY: string
  MISTRAL_API_KEY: string
  DEEPSEEK_API_KEY: string
  TOGETHER_API_KEY: string
  ELEVENLABS_API_KEY: string
  STABILITY_API_KEY: string
  BFL_API_KEY: string
  RUNWAY_API_KEY: string
  IDEOGRAM_API_KEY: string
  SESSION_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] }))
app.use('/static/*', serveStatic({ root: './' }))

// ═══════════════════════════════════════════════════════════════════
// SESSION HELPERS
// ═══════════════════════════════════════════════════════════════════

function encodeSession(data: object, secret?: string): string {
  return btoa(JSON.stringify(data))
}
function decodeSession(token: string): any {
  try { return JSON.parse(atob(token)) } catch { return null }
}

// ═══════════════════════════════════════════════════════════════════
// GOOGLE OAUTH 2.0 — Full PKCE + auto-refresh flow
// ═══════════════════════════════════════════════════════════════════

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
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

app.get('/api/auth/google/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  const storedState = getCookie(c, 'oauth_state')
  deleteCookie(c, 'oauth_state', { path: '/' })
  if (error || state !== storedState || !code) {
    return c.html(getAuthErrorPage('Google sign-in was cancelled or failed. Please try again.'))
  }
  try {
    const baseUrl = new URL(c.req.url).origin
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: c.env?.GOOGLE_CLIENT_ID || '',
        client_secret: c.env?.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: `${baseUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })
    const tokens: any = await tokenRes.json()
    if (!tokens.access_token) throw new Error('No access token')
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } })
    const profile: any = await profileRes.json()
    const sessionData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      name: profile.name, email: profile.email, picture: profile.picture,
      provider: 'google',
    }
    setCookie(c, 'fs_session', encodeSession(sessionData), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7 * 24 * 3600, path: '/' })
    return c.html(getAuthSuccessPage(profile.name, profile.picture))
  } catch (err: any) {
    return c.html(getAuthErrorPage('Authentication failed: ' + err.message))
  }
})

async function refreshGoogleToken(refreshToken: string, clientId: string, clientSecret: string): Promise<{ access_token: string; expires_in: number } | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    })
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
      session.expires_at = Date.now() + (refreshed.expires_in * 1000)
      setCookie(c, 'fs_session', encodeSession(session), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7 * 24 * 3600, path: '/' })
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

app.get('/api/auth/notion-status', async (c) => {
  const token = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!token) return c.json({ connected: false })
  return c.json({ connected: true, workspace: token.workspace_name, workspaceIcon: token.workspace_icon })
})

app.post('/api/auth/logout', async (c) => {
  deleteCookie(c, 'fs_session', { path: '/' })
  return c.json({ ok: true })
})

// ═══════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR API
// ═══════════════════════════════════════════════════════════════════

app.get('/api/calendar/events', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated', events: [] }, 401)
  try {
    const now = new Date()
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const params = new URLSearchParams({
      timeMin: now.toISOString(), timeMax: end.toISOString(),
      maxResults: '20', singleEvents: 'true', orderBy: 'startTime',
    })
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    const data: any = await res.json()
    const events = (data.items || []).map((e: any) => ({
      id: e.id, summary: e.summary || '(No title)',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime,
      color: e.colorId ? `hsl(${parseInt(e.colorId) * 37}, 60%, 60%)` : 'var(--accent-primary)',
    }))
    return c.json({ events })
  } catch (err: any) {
    return c.json({ error: err.message, events: [] }, 500)
  }
})

app.post('/api/calendar/block', async (c) => {
  const token = await getValidAccessToken(c)
  if (!token) return c.json({ error: 'not_authenticated' }, 401)
  const { title, start, end } = await c.req.json()
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: title || '🍅 Focus Block — FlowState', start: { dateTime: start }, end: { dateTime: end }, description: 'Blocked by FlowState for deep work.', colorId: '11' }),
    })
    const data = await res.json()
    return c.json({ ok: true, event: data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════════
// NOTION OAUTH 2.0
// ═══════════════════════════════════════════════════════════════════

app.get('/api/auth/notion', async (c) => {
  const clientId = c.env?.NOTION_CLIENT_ID || ''
  if (!clientId) return c.html(getAuthErrorPage('Notion OAuth is not configured. Please add NOTION_CLIENT_ID to your environment.'))
  const baseUrl = new URL(c.req.url).origin
  const intent = declareNotionOAuth(baseUrl, clientId)
  setCookie(c, 'notion_state', intent.stateParam, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/' })
  return c.redirect(intent.authorizeUrl + `&state=${intent.stateParam}`)
})

app.get('/api/auth/notion/callback', async (c) => {
  const { code, state, error } = c.req.query() as any
  const storedState = getCookie(c, 'notion_state')
  deleteCookie(c, 'notion_state', { path: '/' })
  if (error || !code) return c.html(getAuthErrorPage('Notion authorization failed. Please try again.'))
  try {
    const baseUrl = new URL(c.req.url).origin
    const credentials = btoa(`${c.env?.NOTION_CLIENT_ID || ''}:${c.env?.NOTION_CLIENT_SECRET || ''}`)
    const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: `${baseUrl}/api/auth/notion/callback` }),
    })
    const tokens: any = await tokenRes.json()
    if (!tokens.access_token) throw new Error(tokens.error || 'No access token')
    const notionSession = { access_token: tokens.access_token, workspace_id: tokens.workspace_id, workspace_name: tokens.workspace_name, workspace_icon: tokens.workspace_icon, bot_id: tokens.bot_id }
    setCookie(c, 'fs_notion', encodeSession(notionSession), { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 30 * 24 * 3600, path: '/' })
    return c.html(getNotionSuccessPage(tokens.workspace_name))
  } catch (err: any) {
    return c.html(getAuthErrorPage('Notion authentication failed: ' + err.message))
  }
})

app.get('/api/notion/databases', async (c) => {
  const notionSession = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!notionSession) return c.json({ error: 'not_connected', databases: [] }, 401)
  try {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${notionSession.access_token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { value: 'database', property: 'object' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } }),
    })
    const data: any = await res.json()
    const databases = (data.results || []).map((db: any) => ({
      id: db.id,
      title: db.title?.[0]?.plain_text || 'Untitled',
      icon: db.icon?.emoji || '📋',
      url: db.url,
    }))
    return c.json({ databases })
  } catch (err: any) {
    return c.json({ error: err.message, databases: [] }, 500)
  }
})

app.get('/api/notion/pages/:dbId', async (c) => {
  const notionSession = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!notionSession) return c.json({ error: 'not_connected', pages: [] }, 401)
  const dbId = c.req.param('dbId')
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${notionSession.access_token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ page_size: 50, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }),
    })
    const data: any = await res.json()
    const pages = (data.results || []).map((page: any) => {
      const titleProp = Object.values(page.properties || {}).find((p: any) => p.type === 'title') as any
      const statusProp = Object.values(page.properties || {}).find((p: any) => p.type === 'status' || p.id === 'status') as any
      const selectProp = Object.values(page.properties || {}).find((p: any) => p.type === 'select' && (p.name?.toLowerCase().includes('status') || p.name?.toLowerCase().includes('state'))) as any
      const status = statusProp?.status?.name || selectProp?.select?.name || 'todo'
      return {
        id: page.id, url: page.url,
        title: titleProp?.title?.[0]?.plain_text || 'Untitled',
        status: normalizeStatus(status),
        icon: page.icon?.emoji || '📄',
        lastEdited: page.last_edited_time,
      }
    })
    return c.json({ pages })
  } catch (err: any) {
    return c.json({ error: err.message, pages: [] }, 500)
  }
})

app.patch('/api/notion/pages/:pageId', async (c) => {
  const notionSession = decodeSession(getCookie(c, 'fs_notion') || '')
  if (!notionSession) return c.json({ error: 'not_connected' }, 401)
  const pageId = c.req.param('pageId')
  const { status, propertyName, propertyType } = await c.req.json()
  try {
    const properties: any = {}
    if (propertyType === 'status') {
      properties[propertyName] = { status: { name: status } }
    } else {
      properties[propertyName] = { select: { name: status } }
    }
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${notionSession.access_token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ properties }),
    })
    return c.json({ ok: res.ok })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

function normalizeStatus(s: string): 'todo' | 'inprogress' | 'done' {
  const lower = s.toLowerCase()
  if (lower.includes('progress') || lower.includes('doing') || lower.includes('active') || lower.includes('in')) return 'inprogress'
  if (lower.includes('done') || lower.includes('complete') || lower.includes('finish') || lower.includes('closed')) return 'done'
  return 'todo'
}

// ═══════════════════════════════════════════════════════════════════
// AI CHAT — Streaming, multi-model, multi-turn
// ═══════════════════════════════════════════════════════════════════

app.post('/api/chat/stream', async (c) => {
  const { message, model: preferredModel, messages: history = [], systemOverride } = await c.req.json()
  const intent = declareModelRouting(message, preferredModel)
  const spec = MODEL_REGISTRY[intent.routedModel]
  if (!spec) return c.json({ error: 'Unknown model' }, 400)

  const apiKey = (c.env as any)?.[spec.envKey]

  // Demo mode fallback
  if (!apiKey) {
    const demo = getDemoResponse(message, spec.name)
    return c.text(demo, 200, { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Routing-Reason': intent.reasoning })
  }

  const systemMsg = systemOverride || intent.systemPrompt
  const msgs = [
    { role: 'user', content: message },
  ]
  const allMessages = [
    ...history.slice(-10),
    { role: 'user', content: message },
  ]

  try {
    if (spec.provider === 'anthropic') {
      const res = await fetch(spec.apiEndpoint, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: spec.apiModel, max_tokens: 2048, system: systemMsg, messages: allMessages, stream: true }),
      })
      return new Response(await extractAnthropicStream(res), { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Routing-Reason': intent.reasoning } })
    }

    if (spec.provider === 'google') {
      const url = `${spec.apiEndpoint}?key=${apiKey}&alt=sse`
      const contents = allMessages.map((m: any) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction: { parts: [{ text: systemMsg }] }, contents, generationConfig: { maxOutputTokens: 2048 } }),
      })
      return new Response(await extractGeminiStream(res), { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel } })
    }

    // OpenAI-compatible (openai, xai, mistral, deepseek, together)
    const res = await fetch(spec.apiEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: spec.apiModel, messages: [{ role: 'system', content: systemMsg }, ...allMessages], stream: true, max_tokens: 2048 }),
    })
    return new Response(await extractOpenAIStream(res), { headers: { 'Content-Type': 'text/plain', 'X-Routed-Model': intent.routedModel, 'X-Routing-Reason': intent.reasoning } })
  } catch (err: any) {
    // Fallback to demo
    return c.text('[API Error: ' + err.message + '] ' + getDemoResponse(message, spec.name), 200, { 'Content-Type': 'text/plain' })
  }
})

async function extractOpenAIStream(res: Response): Promise<string> {
  const text = await res.text()
  let result = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ') && !line.includes('[DONE]')) {
      try {
        const d = JSON.parse(line.slice(6))
        result += d.choices?.[0]?.delta?.content || ''
      } catch {}
    }
  }
  return result || 'No response generated.'
}

async function extractAnthropicStream(res: Response): Promise<string> {
  const text = await res.text()
  let result = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        const d = JSON.parse(line.slice(6))
        if (d.type === 'content_block_delta') result += d.delta?.text || ''
      } catch {}
    }
  }
  return result || 'No response generated.'
}

async function extractGeminiStream(res: Response): Promise<string> {
  const text = await res.text()
  let result = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        const d = JSON.parse(line.slice(6))
        result += d.candidates?.[0]?.content?.parts?.[0]?.text || ''
      } catch {}
    }
  }
  return result || 'No response generated.'
}

function getDemoResponse(message: string, modelName: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('hello') || lower.includes('hi')) {
    return `Hey! I'm FlowState AI (${modelName} — demo mode). Add your API key to unlock real AI responses. For now, I'll give you smart demo responses. What are you working on today?`
  }
  if (lower.includes('pomodoro') || lower.includes('focus') || lower.includes('timer')) {
    return `The Pomodoro Technique works because it makes time visible and creates natural commitment points. 25 minutes is short enough to start but long enough to reach deep focus. The breaks aren't interruptions — they're part of the system. Ready to start a session?`
  }
  if (lower.includes('code') || lower.includes('debug') || lower.includes('function')) {
    return `I'd route this to Claude 3.7 Sonnet for code tasks — it has the best reasoning for debugging. In demo mode, I can tell you: break the problem into the smallest possible failing unit, add a console.log at each step, and work backwards from the error. What language/framework are you using?`
  }
  if (lower.includes('notion') || lower.includes('kanban') || lower.includes('task')) {
    return `Your Board tab is connected to Notion. Drag cards between columns to sync status. You can also add a note at the start of each Pomodoro about which card you're working on — this creates automatic accountability and gives you a beautiful work log at the end of the week.`
  }
  return `This is ${modelName} in demo mode. FlowState routes your message to the most appropriate AI model based on intent. Add your API keys via Settings (⚙️) to unlock real responses. Your message was: "${message.slice(0, 80)}${message.length > 80 ? '...' : ''}"`
}

// ═══════════════════════════════════════════════════════════════════
// IMAGE GENERATION
// ═══════════════════════════════════════════════════════════════════

app.post('/api/generate/image', async (c) => {
  const { prompt, model: modelId = 'dalle3', style, size = '1024x1024' } = await c.req.json()
  const spec = IMAGE_MODEL_REGISTRY[modelId as keyof typeof IMAGE_MODEL_REGISTRY]
  if (!spec) return c.json({ error: 'Unknown image model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  if (!apiKey) return c.json({ error: `${spec.name} API key not configured. Add ${spec.envKey} to your Cloudflare secrets.`, demo: true, imageUrl: getDemoImageUrl(prompt) })
  try {
    if (modelId === 'dalle3') {
      const res = await fetch(spec.apiEndpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size, style: style || 'vivid', response_format: 'url' }),
      })
      const data: any = await res.json()
      if (data.error) throw new Error(data.error.message)
      return c.json({ imageUrl: data.data?.[0]?.url, model: spec.name, prompt })
    }
    if (modelId === 'imagen3') {
      const res = await fetch(`${spec.apiEndpoint}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1 } }),
      })
      const data: any = await res.json()
      const b64 = data.predictions?.[0]?.bytesBase64Encoded
      return c.json({ imageUrl: `data:image/png;base64,${b64}`, model: spec.name, prompt })
    }
    if (modelId === 'sd3') {
      const fd = new FormData()
      fd.append('prompt', prompt); fd.append('output_format', 'jpeg')
      const res = await fetch(spec.apiEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' }, body: fd })
      const data: any = await res.json()
      return c.json({ imageUrl: `data:image/jpeg;base64,${data.image}`, model: spec.name, prompt })
    }
    if (modelId === 'flux_pro') {
      const res = await fetch(spec.apiEndpoint, {
        method: 'POST',
        headers: { 'x-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, width: 1024, height: 1024 }),
      })
      const data: any = await res.json()
      // Flux returns a polling ID
      return c.json({ taskId: data.id, model: spec.name, prompt, polling: true })
    }
    if (modelId === 'ideogram2') {
      const res = await fetch(spec.apiEndpoint, {
        method: 'POST',
        headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_request: { prompt, resolution: 'RESOLUTION_1024_1024', response_format: 'url', model: 'V_2' } }),
      })
      const data: any = await res.json()
      return c.json({ imageUrl: data.data?.[0]?.url, model: spec.name, prompt })
    }
    return c.json({ error: 'Model handler not implemented' }, 501)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

function getDemoImageUrl(prompt: string): string {
  const encoded = encodeURIComponent(prompt.slice(0, 50))
  return `https://placehold.co/1024x1024/1a1a2e/a855f7?text=${encoded}`
}

// ═══════════════════════════════════════════════════════════════════
// VIDEO GENERATION
// ═══════════════════════════════════════════════════════════════════

app.post('/api/generate/video', async (c) => {
  const { prompt, model: modelId = 'veo2', duration = 5 } = await c.req.json()
  const spec = VIDEO_MODEL_REGISTRY[modelId as keyof typeof VIDEO_MODEL_REGISTRY]
  if (!spec) return c.json({ error: 'Unknown video model' }, 400)
  const apiKey = (c.env as any)?.[spec.envKey]
  if (!apiKey) {
    return c.json({ error: `${spec.name} API key not configured. Add ${spec.envKey} to your environment.`, demo: true, message: `Demo: Would generate ${duration}s video with ${spec.name}: "${prompt.slice(0, 60)}"` })
  }
  return c.json({ queued: true, model: spec.name, prompt, message: 'Video generation queued. This typically takes 1-3 minutes.' })
})

// ═══════════════════════════════════════════════════════════════════
// BEHAVIOR + METRICS API
// ═══════════════════════════════════════════════════════════════════

app.get('/api/behavior/insight', async (c) => {
  const { focus, sessions, streak, completion, steps, sleep, hydration, langStreak } = c.req.query() as any
  const data: BehaviorData = {
    totalFocusSeconds: parseInt(focus || '0'),
    sessionCount: parseInt(sessions || '0'),
    streak: parseInt(streak || '0'),
    completionRate: parseFloat(completion || '0.5'),
    steps: steps ? parseInt(steps) : undefined,
    sleepHours: sleep ? parseFloat(sleep) : undefined,
    hydrationGlasses: hydration ? parseInt(hydration) : undefined,
    languageStreak: langStreak ? parseInt(langStreak) : undefined,
  }
  const insight = declareBehaviorInsight(data)
  return c.json(insight)
})

app.get('/api/tier/capabilities', async (c) => {
  const tier = (c.req.query('tier') as any) || 'free'
  return c.json(declareTierCapabilities(tier))
})

app.get('/api/credentials', async (c) => {
  return c.json({ credentials: CREDENTIAL_TABLE })
})

app.get('/api/health', (c) => c.json({ status: 'alive', version: '2.0.0', name: 'FlowState', phase: 'Phase 2 — Multi-model AI + Full OAuth' }))

app.get('/api/learn/cards', (c) => c.json({ cards: declareLearnCards() }))

app.get('/api/restore/intent', (c) => c.json(declareRestoreIntent()))

// ═══════════════════════════════════════════════════════════════════
// AUTH PAGES (rendered by the server on redirect)
// ═══════════════════════════════════════════════════════════════════

function getAuthSuccessPage(name: string, picture: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected — FlowState</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(168,85,247,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}.avatar{width:72px;height:72px;border-radius:50%;border:3px solid #a855f7;margin-bottom:16px}.check{font-size:48px;margin-bottom:16px;display:block}h1{font-size:22px;font-weight:800;margin-bottom:8px}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card">${picture ? `<img class="avatar" src="${picture}" alt="${name}">` : '<span class="check">✅</span>'}<h1>Connected, ${name}! 🎉</h1><p>Google Calendar and Drive are now synced with FlowState.</p><a class="btn" href="/" onclick="window.close()">Return to FlowState</a></div></body></html>`
}

function getNotionSuccessPage(workspace: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Notion Connected — FlowState</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(168,85,247,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}h1{font-size:22px;font-weight:800;margin-bottom:8px}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">📝</div><h1>Notion Connected! 🎉</h1><p>Workspace: <strong>${workspace || 'Your workspace'}</strong> is now synced. Choose a database in the Board tab to start Kanban sync.</p><a class="btn" href="/" onclick="window.close()">Open Board Tab</a></div></body></html>`
}

function getAuthErrorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Auth Error — FlowState</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f0f1a;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a2e;border:1px solid rgba(239,68,68,.3);border-radius:20px;padding:40px;text-align:center;max-width:380px}h1{font-size:22px;font-weight:800;margin-bottom:8px;color:#ef4444}p{color:#888;font-size:14px;margin-bottom:24px}.btn{display:inline-block;background:#1a1a2e;border:1px solid #ef4444;color:#ef4444;text-decoration:none;padding:12px 28px;border-radius:12px;font-weight:700;font-size:14px}</style></head><body><div class="card"><div style="font-size:48px;margin-bottom:16px">⚠️</div><h1>Authentication Error</h1><p>${message}</p><a class="btn" href="/">Back to FlowState</a></div></body></html>`
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HTML — Full FlowState Application
// ═══════════════════════════════════════════════════════════════════

app.get('/', (c) => {
  const session = decodeSession(getCookie(c, 'fs_session') || '')
  const notionSession = decodeSession(getCookie(c, 'fs_notion') || '')
  const userJson = session ? JSON.stringify({ name: session.name, email: session.email, picture: session.picture }) : 'null'
  const notionJson = notionSession ? JSON.stringify({ workspace: notionSession.workspace_name }) : 'null'

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlowState — Intelligent Workspace</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg-base:#0f0f1a; --bg-panel:#1a1a2e; --bg-card:#16213e;
  --border:rgba(168,85,247,.18); --border-hover:rgba(168,85,247,.4);
  --text-primary:#f0f0f0; --text-secondary:#888; --text-muted:#555;
  --accent-primary:#a855f7; --accent-secondary:#ec4899;
  --accent-blue:#3b82f6; --accent-cyan:#06b6d4; --accent-green:#10b981;
  --success:#10b981; --warning:#f59e0b; --danger:#ef4444;
  --grad:linear-gradient(135deg,#a855f7,#ec4899);
  --grad-blue:linear-gradient(135deg,#3b82f6,#06b6d4);
  --timer-ring-size:220px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg-base);color:var(--text-primary);display:flex;flex-direction:column}

/* ─── Ambient bg ─── */
.ambient-orb{position:fixed;border-radius:50%;pointer-events:none;filter:blur(80px);opacity:0;transition:opacity 2s ease,transform 8s ease}
.orb1{width:500px;height:500px;top:-100px;left:-100px;background:radial-gradient(circle,rgba(168,85,247,.25),transparent 70%)}
.orb2{width:400px;height:400px;bottom:-100px;right:-100px;background:radial-gradient(circle,rgba(236,72,153,.2),transparent 70%)}
.ambient-active .orb1,.ambient-active .orb2{opacity:1}

/* ─── Header ─── */
header{display:flex;align-items:center;gap:12px;padding:10px 20px;background:rgba(26,26,46,.8);border-bottom:1px solid var(--border);backdrop-filter:blur(20px);flex-shrink:0;z-index:100}
.logo{font-size:18px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.5px;cursor:pointer}
.datetime-widget{margin-left:auto;font-size:12px;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:8px;transition:.2s;border:1px solid transparent}
.datetime-widget:hover{border-color:var(--border);background:rgba(168,85,247,.05)}
.datetime-date{font-weight:600;color:var(--text-primary)}
.datetime-time{font-weight:800;font-size:13px;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-variant-numeric:tabular-nums}
.user-avatar{width:30px;height:30px;border-radius:50%;border:2px solid var(--accent-primary);cursor:pointer;object-fit:cover}
.user-pill{display:flex;align-items:center;gap:8px;padding:4px 10px;border-radius:20px;border:1px solid var(--border);cursor:pointer;transition:.2s}
.user-pill:hover{border-color:var(--accent-primary)}
.user-name{font-size:12px;font-weight:600;color:var(--text-secondary)}
#btn-google-signin{background:var(--grad);border:none;color:#fff;padding:7px 16px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;transition:.2s;white-space:nowrap}
#btn-google-signin:hover{opacity:.85;transform:scale(1.02)}

/* ─── Tabs ─── */
.tabs-bar{display:flex;align-items:center;gap:2px;padding:6px 20px;background:rgba(15,15,26,.9);border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto}
.tab-btn{display:flex;align-items:center;gap:6px;padding:7px 16px;border-radius:10px;font-size:13px;font-weight:600;color:var(--text-secondary);border:none;background:transparent;cursor:pointer;transition:.2s;white-space:nowrap}
.tab-btn:hover{color:var(--text-primary);background:rgba(168,85,247,.08)}
.tab-btn.active{color:var(--accent-primary);background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.25)}
.tab-btn i{font-size:13px}
.tab-content{display:none;flex:1;overflow-y:auto;padding:20px}
.tab-content.active{display:flex;flex-direction:column}

/* ─── Model picker ─── */
.model-picker{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 16px;background:var(--bg-panel);border-radius:12px;border:1px solid var(--border);margin-bottom:12px}
.model-chip{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;transition:.2s;white-space:nowrap}
.model-chip:hover{border-color:var(--border-hover);color:var(--text-primary)}
.model-chip.active{background:var(--grad);border-color:transparent;color:#fff}
.model-chip .badge{font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(255,255,255,.15);color:#fff}
.routing-badge{font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:4px;margin-left:auto}
.routing-badge .dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite}

/* ─── Timer ─── */
.timer-container{display:flex;flex-direction:column;align-items:center;gap:20px;max-width:480px;margin:0 auto;width:100%}
.timer-ring-wrap{position:relative;width:var(--timer-ring-size);height:var(--timer-ring-size)}
.timer-ring-wrap svg{transform:rotate(-90deg)}
.ring-bg{fill:none;stroke:rgba(168,85,247,.12);stroke-width:12}
.ring-progress{fill:none;stroke:url(#ringGrad);stroke-width:12;stroke-linecap:round;transition:stroke-dashoffset .5s ease}
.timer-inner{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
#timer-display{font-size:48px;font-weight:900;letter-spacing:-2px;font-variant-numeric:tabular-nums}
.timer-phase{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--text-muted);margin-top:2px}
.timer-glow{position:absolute;inset:0;border-radius:50%;pointer-events:none;transition:opacity .5s;opacity:0}
.timer-glow.active{opacity:1;box-shadow:0 0 60px rgba(168,85,247,.35),0 0 120px rgba(168,85,247,.15)}
.breathing-ring{position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(168,85,247,.3);animation:breathe 4s ease-in-out infinite;pointer-events:none;opacity:0}
.breathing-ring.active{opacity:1}
@keyframes breathe{0%,100%{transform:scale(1);opacity:.3}50%{transform:scale(1.04);opacity:.6}}

.phase-btns{display:flex;gap:8px}
.phase-btn{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;transition:.2s}
.phase-btn:hover,.phase-btn.active{border-color:var(--accent-primary);color:var(--accent-primary);background:rgba(168,85,247,.08)}
.timer-controls{display:flex;gap:12px;align-items:center}
.btn-timer{width:64px;height:64px;border-radius:50%;border:none;cursor:pointer;font-size:20px;transition:.2s;display:flex;align-items:center;justify-content:center}
.btn-start{background:var(--grad);color:#fff;box-shadow:0 0 30px rgba(168,85,247,.4)}
.btn-start:hover{transform:scale(1.06);box-shadow:0 0 40px rgba(168,85,247,.6)}
.btn-reset{background:rgba(168,85,247,.1);border:1px solid var(--border);color:var(--text-secondary);width:44px;height:44px;font-size:15px}
.btn-reset:hover{border-color:var(--border-hover);color:var(--text-primary)}
.stats-row{display:flex;gap:16px;justify-content:center}
.stat-item{text-align:center}
.stat-val{font-size:20px;font-weight:800;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-lbl{font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px}

/* ─── Ambient sounds ─── */
.ambient-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:16px;width:100%;max-width:480px;margin:0 auto}
.ambient-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:10px}
.sound-chips{display:flex;gap:8px;flex-wrap:wrap}
.sound-chip{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;transition:.2s}
.sound-chip:hover{border-color:var(--border-hover);color:var(--text-primary)}
.sound-chip.active{background:rgba(168,85,247,.15);border-color:var(--accent-primary);color:var(--accent-primary)}

/* ─── Chat ─── */
.chat-wrap{display:flex;flex-direction:column;height:100%;gap:0}
.chat-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:0 0 12px 0;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.msg{display:flex;gap:10px;align-items:flex-start;animation:messageIn .25s ease}
.msg.user{flex-direction:row-reverse}
.msg-bubble{max-width:78%;padding:12px 16px;border-radius:16px;font-size:14px;line-height:1.65;word-break:break-word}
.msg.user .msg-bubble{background:var(--grad);color:#fff;border-radius:16px 16px 4px 16px}
.msg.ai .msg-bubble{background:var(--bg-panel);border:1px solid var(--border);color:var(--text-primary);border-radius:16px 16px 16px 4px}
.msg-avatar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;border:1px solid var(--border)}
.msg-meta{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted)}
.model-tag{padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(168,85,247,.15);color:var(--accent-primary)}
.typing-dot{width:7px;height:7px;border-radius:50%;background:var(--text-muted);animation:typingBounce 1.2s infinite}
.typing-dot:nth-child(2){animation-delay:.2s}
.typing-dot:nth-child(3){animation-delay:.4s}
@keyframes typingBounce{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-5px);opacity:1}}
.chat-input-area{display:flex;gap:10px;align-items:flex-end;padding-top:12px;border-top:1px solid var(--border)}
.chat-input{flex:1;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:12px 16px;color:var(--text-primary);font-size:14px;font-family:inherit;resize:none;min-height:44px;max-height:140px;overflow-y:auto;transition:.2s;outline:none}
.chat-input:focus{border-color:var(--accent-primary);box-shadow:0 0 0 2px rgba(168,85,247,.12)}
.btn-send{width:44px;height:44px;border-radius:12px;background:var(--grad);border:none;color:#fff;cursor:pointer;font-size:16px;flex-shrink:0;transition:.2s}
.btn-send:hover{transform:scale(1.05);opacity:.9}
.btn-send:disabled{opacity:.4;cursor:not-allowed;transform:none}

/* ─── Calendar ─── */
.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cal-header{font-size:10px;font-weight:700;text-align:center;color:var(--text-muted);text-transform:uppercase;padding:4px}
.cal-day{aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;position:relative;gap:2px}
.cal-day:hover{background:rgba(168,85,247,.1)}
.cal-day.today{background:rgba(168,85,247,.2);color:var(--accent-primary)}
.cal-day.has-event::after{content:'';width:4px;height:4px;border-radius:50%;background:var(--accent-primary);position:absolute;bottom:4px}
.cal-day.other-month{color:var(--text-muted);opacity:.4}
.event-list{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.event-item{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;transition:.2s}
.event-item:hover{border-color:var(--border-hover)}
.event-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.event-time{font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.event-summary{font-size:13px;font-weight:600;flex:1}
.btn-block{padding:5px 12px;border-radius:8px;font-size:11px;font-weight:700;background:rgba(168,85,247,.1);border:1px solid var(--border);color:var(--text-secondary);cursor:pointer;transition:.2s}
.btn-block:hover{border-color:var(--accent-primary);color:var(--accent-primary)}

/* ─── Kanban / Board ─── */
.board-wrap{display:flex;gap:16px;overflow-x:auto;height:100%;align-items:flex-start;padding-bottom:20px}
.kanban-col{min-width:260px;background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:14px;flex-shrink:0}
.kanban-col-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.kanban-col-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-secondary)}
.kanban-count{background:rgba(168,85,247,.15);color:var(--accent-primary);padding:2px 8px;border-radius:8px;font-size:11px;font-weight:700}
.kanban-cards{display:flex;flex-direction:column;gap:8px;min-height:40px}
.kanban-card{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px;cursor:grab;transition:.2s}
.kanban-card:hover{border-color:var(--border-hover);transform:translateY(-1px);box-shadow:0 4px 20px rgba(0,0,0,.3)}
.kanban-card.dragging{opacity:.5;cursor:grabbing}
.card-title{font-size:13px;font-weight:600;margin-bottom:6px}
.card-tag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(168,85,247,.15);color:var(--accent-primary)}
.card-meta{font-size:11px;color:var(--text-muted);margin-top:6px;display:flex;align-items:center;gap:6px}

/* ─── Metrics ─── */
.metrics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:20px}
.metric-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:18px;transition:.2s;position:relative;overflow:hidden}
.metric-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--grad)}
.metric-card:hover{border-color:var(--border-hover)}
.metric-icon{font-size:22px;margin-bottom:10px}
.metric-value{font-size:26px;font-weight:900;line-height:1}
.metric-label{font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.metric-trend{font-size:11px;color:var(--success);margin-top:4px}
.metric-trend.down{color:var(--danger)}
.flowscore-ring{position:relative;width:80px;height:80px;margin:0 auto 12px}
.flowscore-value{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.chart-wrap{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:16px}
.chart-title{font-size:13px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.behavior-insight{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.05));border:1px solid rgba(168,85,247,.2);border-radius:14px;padding:18px;margin-bottom:16px}
.insight-headline{font-size:15px;font-weight:800;margin-bottom:6px}
.insight-sources{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.source-badge{padding:3px 9px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(168,85,247,.15);color:var(--accent-primary)}
.flowscore-val{font-size:13px;color:var(--text-secondary);margin-top:6px}

/* ─── Learn ─── */
.learn-carousel{position:relative;overflow:hidden;border-radius:20px;min-height:260px;margin-bottom:16px}
.learn-card{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:28px;border-radius:20px;transition:opacity .5s ease,transform .5s ease;opacity:0;transform:translateX(30px)}
.learn-card.active{opacity:1;transform:translateX(0)}
.learn-card.prev{opacity:0;transform:translateX(-30px)}
.learn-card-type{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:2px;opacity:.7;margin-bottom:8px}
.learn-card-title{font-size:22px;font-weight:900;margin-bottom:8px}
.learn-card-content{font-size:15px;line-height:1.6;opacity:.9;margin-bottom:12px}
.learn-card-meta{font-size:12px;opacity:.65}
.learn-nav{display:flex;align-items:center;gap:12px;justify-content:center;margin-bottom:16px}
.learn-dot{width:8px;height:8px;border-radius:50%;background:var(--border);cursor:pointer;transition:.2s}
.learn-dot.active{background:var(--accent-primary);width:20px;border-radius:4px}
.learn-nav-btn{width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;transition:.2s;display:flex;align-items:center;justify-content:center}
.learn-nav-btn:hover{border-color:var(--accent-primary);color:var(--accent-primary)}
.ai-cards-section{background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:18px}
.ai-card-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}

/* ─── Restore ─── */
.restore-scene{border-radius:20px;overflow:hidden;position:relative;min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center;margin-bottom:16px;transition:.6s}
.restore-emoji{font-size:56px;margin-bottom:16px;line-height:1}
.restore-title{font-size:22px;font-weight:900;margin-bottom:10px}
.restore-content{font-size:15px;line-height:1.7;opacity:.85;max-width:400px;margin-bottom:20px}
.breath-circle{width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;margin:16px auto;transition:transform 4s ease,background .5s ease}
.breath-circle.expand{transform:scale(1.5);background:rgba(255,255,255,.25)}
.restore-steps{text-align:left;display:flex;flex-direction:column;gap:8px;margin:16px 0}
.restore-step{display:flex;align-items:center;gap:10px;font-size:14px;padding:8px 16px;background:rgba(255,255,255,.1);border-radius:8px}
.restore-step-num{width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.restore-nav{display:flex;gap:10px;justify-content:center}
.restore-btn{padding:10px 24px;border-radius:12px;font-size:13px;font-weight:700;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;transition:.2s}
.restore-btn:hover{background:rgba(255,255,255,.2)}
.gratitude-input{width:100%;max-width:360px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.3);border-radius:12px;padding:14px 18px;font-size:15px;color:#fff;font-family:inherit;outline:none;margin-bottom:12px;text-align:center}
.gratitude-input::placeholder{color:rgba(255,255,255,.5)}

/* ─── Image Generation ─── */
.gen-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:18px;margin-bottom:14px}
.gen-title{font-size:13px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.gen-prompt{width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-primary);font-size:14px;font-family:inherit;resize:vertical;min-height:80px;outline:none;margin-bottom:12px}
.gen-prompt:focus{border-color:var(--accent-primary)}
.gen-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn-generate{padding:10px 24px;border-radius:12px;background:var(--grad);border:none;color:#fff;font-size:13px;font-weight:700;cursor:pointer;transition:.2s}
.btn-generate:hover{opacity:.85;transform:scale(1.02)}
.btn-generate:disabled{opacity:.4;cursor:not-allowed;transform:none}
.gen-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:14px}
.gen-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;border:1px solid var(--border);cursor:pointer;transition:.2s}
.gen-img:hover{border-color:var(--accent-primary);transform:scale(1.02)}

/* ─── Tip bubbles ─── */
.tip-bubble{position:fixed;bottom:80px;right:20px;max-width:300px;background:var(--bg-panel);border:1px solid var(--border-hover);border-radius:16px;padding:16px;box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:1000;animation:slideInRight .3s ease}
.tip-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.tip-emoji{font-size:20px}
.tip-category{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted)}
.tip-message{font-size:13px;line-height:1.5;color:var(--text-primary)}
.tip-close{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;line-height:1}
.tip-close:hover{color:var(--text-primary)}

/* ─── Celebrations ─── */
.celebration-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2000;pointer-events:none}
.celebration-card{background:var(--bg-panel);border:1px solid rgba(168,85,247,.4);border-radius:24px;padding:36px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);pointer-events:all;animation:celebIn .5s cubic-bezier(.34,1.56,.64,1)}
.celeb-emoji{font-size:56px;margin-bottom:12px;display:block}
.celeb-title{font-size:24px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
.celeb-sub{font-size:14px;color:var(--text-secondary)}
.confetti-piece{position:fixed;width:8px;height:8px;border-radius:2px;pointer-events:none;animation:confettiFall linear forwards}
@keyframes confettiFall{0%{opacity:1;transform:translate(0,0) rotate(0deg)}100%{opacity:0;transform:translate(var(--tx),var(--ty)) rotate(720deg)}}
@keyframes celebIn{0%{opacity:0;transform:scale(.6)}100%{opacity:1;transform:scale(1)}}
@keyframes slideInRight{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
@keyframes messageIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:.6;transform:scale(1)}50%{opacity:1;transform:scale(1.5)}}
@keyframes spin{to{transform:rotate(360deg)}}

/* ─── Premium modal ─── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:3000;backdrop-filter:blur(8px);padding:16px}
.modal-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:20px;padding:32px;max-width:560px;width:100%;max-height:90vh;overflow-y:auto}
.modal-card h2{font-size:20px;font-weight:800;margin-bottom:6px}
.tier-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.tier-card{padding:16px;border-radius:14px;border:1px solid var(--border);text-align:center;cursor:pointer;transition:.2s}
.tier-card:hover{border-color:var(--border-hover)}
.tier-card.highlighted{border:2px solid var(--accent-primary);background:rgba(168,85,247,.05)}
.tier-card h3{font-size:15px;font-weight:800;margin-bottom:4px}
.tier-card .price{font-size:22px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.tier-features{font-size:12px;color:var(--text-secondary);line-height:1.8;text-align:left;margin-top:10px}
.tier-features li{list-style:none;padding-left:0}
.tier-features li::before{content:'✓ ';color:var(--success)}
.credential-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:16px}
.credential-table th{text-align:left;padding:8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);border-bottom:1px solid var(--border)}
.credential-table td{padding:8px;border-bottom:1px solid rgba(168,85,247,.06);vertical-align:middle}
.credential-table a{color:var(--accent-primary);text-decoration:none;font-weight:600}
.cred-required{padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700}
.cred-core{background:rgba(16,185,129,.15);color:var(--success)}
.cred-recommended{background:rgba(245,158,11,.15);color:var(--warning)}
.cred-optional{background:rgba(168,85,247,.1);color:var(--accent-primary)}

/* ─── NotebookLM ─── */
.notebook-panel{background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:14px}
.notebook-status{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.status-dot{width:10px;height:10px;border-radius:50%}
.status-dot.live{background:var(--success);box-shadow:0 0 6px var(--success);animation:pulse 2s infinite}
.status-dot.coming-soon{background:var(--warning)}
.notebook-iframe{width:100%;height:400px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card)}

/* ─── Misc ─── */
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.section-title{font-size:14px;font-weight:800}
.btn-sm{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text-secondary);cursor:pointer;transition:.2s}
.btn-sm:hover{border-color:var(--border-hover);color:var(--text-primary)}
.btn-primary{background:var(--grad);border:none;color:#fff;padding:10px 24px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;transition:.2s}
.btn-primary:hover{opacity:.85;transform:scale(1.02)}
.empty-state{text-align:center;padding:40px 20px;color:var(--text-muted)}
.empty-state i{font-size:36px;margin-bottom:12px;display:block;opacity:.4}
.empty-state p{font-size:13px;margin-bottom:16px;line-height:1.6}
.auth-banner{background:linear-gradient(135deg,rgba(168,85,247,.08),rgba(236,72,153,.05));border:1px solid rgba(168,85,247,.2);border-radius:14px;padding:20px;text-align:center;margin-bottom:16px}
.auth-banner h3{font-size:16px;font-weight:800;margin-bottom:6px}
.auth-banner p{font-size:13px;color:var(--text-secondary);margin-bottom:14px}
.notion-db-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.notion-db-item{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:.2s}
.notion-db-item:hover{border-color:var(--accent-primary)}
.notion-db-item.selected{border-color:var(--accent-primary);background:rgba(168,85,247,.08)}

/* Loading spinner */
.spinner{width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent-primary);border-radius:50%;animation:spin 1s linear infinite;display:inline-block}
select.form-select{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);padding:6px 12px;font-size:12px;cursor:pointer;outline:none}
select.form-select:focus{border-color:var(--accent-primary)}
input.form-input{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);padding:8px 14px;font-size:13px;outline:none;width:100%}
input.form-input:focus{border-color:var(--accent-primary)}
code{background:rgba(168,85,247,.1);padding:2px 6px;border-radius:4px;font-size:12px;color:var(--accent-primary)}
pre{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;margin:8px 0;line-height:1.5}
strong{color:var(--text-primary);font-weight:700}
em{color:var(--accent-primary);font-style:italic}
hr.divider{border:none;border-top:1px solid var(--border);margin:12px 0}
</style>
</head>
<body>

<div class="ambient-orb orb1" id="orb1"></div>
<div class="ambient-orb orb2" id="orb2"></div>

<!-- ═══ HEADER ═══ -->
<header>
  <div class="logo" onclick="switchTab('focus')">⚡ FLOWSTATE</div>
  <div class="datetime-widget" id="datetime-widget" onclick="openCalendarPopover()">
    <i class="fas fa-calendar" style="font-size:11px;color:var(--text-muted)"></i>
    <span class="datetime-date" id="dt-date">—</span>
    <span style="color:var(--text-muted);font-size:10px">·</span>
    <span class="datetime-time" id="dt-time">—</span>
  </div>
  <div id="user-area"></div>
</header>

<!-- ═══ TABS ═══ -->
<div class="tabs-bar">
  <button class="tab-btn active" id="tab-focus" onclick="switchTab('focus')"><i class="fas fa-bullseye"></i>Focus</button>
  <button class="tab-btn" id="tab-chat" onclick="switchTab('chat')"><i class="fas fa-comments"></i>Chat</button>
  <button class="tab-btn" id="tab-calendar" onclick="switchTab('calendar')"><i class="fas fa-calendar-alt"></i>Calendar</button>
  <button class="tab-btn" id="tab-metrics" onclick="switchTab('metrics')"><i class="fas fa-chart-line"></i>Metrics</button>
  <button class="tab-btn" id="tab-board" onclick="switchTab('board')"><i class="fas fa-columns"></i>Board</button>
  <button class="tab-btn" id="tab-learn" onclick="switchTab('learn')"><i class="fas fa-graduation-cap"></i>Learn</button>
  <button class="tab-btn" id="tab-restore" onclick="switchTab('restore')"><i class="fas fa-leaf"></i>Restore</button>
  <button class="tab-btn" id="tab-generate" onclick="switchTab('generate')"><i class="fas fa-magic"></i>Generate</button>
  <div style="margin-left:auto;display:flex;gap:6px">
    <button class="btn-sm" onclick="openCredentialsModal()" title="API Credentials"><i class="fas fa-key"></i></button>
    <button class="btn-sm" onclick="openPremiumModal()" title="Upgrade"><i class="fas fa-star"></i> Pro</button>
    <button class="btn-sm" onclick="openSettingsModal()"><i class="fas fa-gear"></i></button>
  </div>
</div>

<!-- ════════════════════════════════════════
     FOCUS TAB
     ════════════════════════════════════════ -->
<div class="tab-content active" id="tab-content-focus">
  <div class="timer-container">
    <div class="phase-btns">
      <button class="phase-btn active" id="phase-focus" onclick="setPhase('focus')">Focus</button>
      <button class="phase-btn" id="phase-short" onclick="setPhase('short_break')">Short Break</button>
      <button class="phase-btn" id="phase-long" onclick="setPhase('long_break')">Long Break</button>
    </div>
    <div class="timer-ring-wrap">
      <div class="breathing-ring" id="breathing-ring"></div>
      <div class="timer-glow" id="timer-glow"></div>
      <svg width="220" height="220" viewBox="0 0 220 220">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#a855f7"/>
            <stop offset="100%" stop-color="#ec4899"/>
          </linearGradient>
        </defs>
        <circle class="ring-bg" cx="110" cy="110" r="98"/>
        <circle class="ring-progress" id="ring-progress" cx="110" cy="110" r="98" stroke-dasharray="615.75" stroke-dashoffset="0"/>
      </svg>
      <div class="timer-inner">
        <div id="timer-display">25:00</div>
        <div class="timer-phase" id="timer-phase">FOCUS</div>
      </div>
    </div>
    <div class="timer-controls">
      <button class="btn-timer btn-reset" id="btn-skip" onclick="skipPhase()" title="Skip"><i class="fas fa-forward-step"></i></button>
      <button class="btn-timer btn-start" id="btn-start" onclick="toggleTimer()"><i class="fas fa-play" id="btn-icon"></i></button>
      <button class="btn-timer btn-reset" onclick="resetTimer()" title="Reset"><i class="fas fa-rotate-left"></i></button>
    </div>
    <div class="stats-row">
      <div class="stat-item"><div class="stat-val" id="stat-sessions">0</div><div class="stat-lbl">Sessions</div></div>
      <div class="stat-item"><div class="stat-val" id="stat-focus-time">0m</div><div class="stat-lbl">Focus Time</div></div>
      <div class="stat-item"><div class="stat-val" id="stat-streak">🔥 0</div><div class="stat-lbl">Streak</div></div>
    </div>
    <div class="ambient-panel">
      <div class="ambient-title"><i class="fas fa-headphones"></i>&nbsp; Ambient Sounds</div>
      <div class="sound-chips">
        <button class="sound-chip" onclick="toggleSound('rain')">🌧️ Rain</button>
        <button class="sound-chip" onclick="toggleSound('forest')">🌲 Forest</button>
        <button class="sound-chip" onclick="toggleSound('cafe')">☕ Café</button>
        <button class="sound-chip" onclick="toggleSound('ocean')">🌊 Ocean</button>
        <button class="sound-chip" onclick="toggleSound('fire')">🔥 Fire</button>
        <button class="sound-chip" onclick="toggleSound('space')">🌌 Space</button>
        <button class="sound-chip" onclick="toggleSound('silence')">🔇 Off</button>
      </div>
    </div>
    <div id="session-block-warning" style="display:none;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:12px;padding:12px 16px;width:100%;max-width:480px;font-size:13px;color:var(--warning)">
      <i class="fas fa-calendar-exclamation"></i>&nbsp; <span id="session-block-msg"></span>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════
     CHAT TAB
     ════════════════════════════════════════ -->
<div class="tab-content" id="tab-content-chat" style="padding:16px">
  <div class="chat-wrap">
    <div class="model-picker" id="model-picker">
      <!-- populated by JS -->
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="msg ai">
        <div class="msg-avatar" style="background:var(--grad)">⚡</div>
        <div>
          <div class="msg-meta"><span class="model-tag">FlowState AI</span><span>Smart routing active</span></div>
          <div class="msg-bubble">Hey! FlowState AI here &mdash; auto-routing to the best model for each task. Claude for analysis, Gemini for speed, Grok for live data, DeepSeek for math. Just type naturally, or pick a model chip above.</div>
        </div>
      </div>
    </div>
    <div class="chat-input-area">
      <textarea class="chat-input" id="chat-input" placeholder="Ask anything… Cmd/Ctrl+Enter to send" rows="1"></textarea>
      <button class="btn-send" id="btn-send" onclick="sendMessage()"><i class="fas fa-paper-plane"></i></button>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════
     CALENDAR TAB
     ════════════════════════════════════════ -->
<div class="tab-content" id="tab-content-calendar">
  <div id="calendar-auth-banner" style="display:none" class="auth-banner">
    <h3>📅 Connect Google Calendar</h3>
    <p>See your upcoming events, auto-block focus time, and get session conflict warnings.</p>
    <button class="btn-primary" onclick="connectGoogle()"><i class="fab fa-google"></i>&nbsp; Connect Google Calendar</button>
  </div>
  <div id="calendar-main" style="display:none">
    <div class="section-header">
      <div>
        <div class="section-title" id="cal-month-label">—</div>
        <div style="font-size:12px;color:var(--text-muted)">Google Calendar connected ✓</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-sm" onclick="prevMonth()"><i class="fas fa-chevron-left"></i></button>
        <button class="btn-sm" onclick="nextMonth()"><i class="fas fa-chevron-right"></i></button>
        <button class="btn-sm" onclick="blockFocusTime()"><i class="fas fa-lock"></i>&nbsp; Block Focus</button>
      </div>
    </div>
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:16px">
      <div class="calendar-grid" id="cal-grid"></div>
    </div>
    <div class="section-header"><div class="section-title">Upcoming Events</div></div>
    <div class="event-list" id="event-list"><div class="empty-state"><div class="spinner"></div><p style="margin-top:10px">Loading events…</p></div></div>
  </div>
</div>

<!-- ════════════════════════════════════════
     METRICS TAB
     ════════════════════════════════════════ -->
<div class="tab-content" id="tab-content-metrics">
  <div class="behavior-insight" id="behavior-insight">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px">Behavior Intelligence</div>
        <div class="insight-headline" id="insight-headline">Loading insights…</div>
        <div style="font-size:13px;color:var(--text-secondary);margin-top:4px" id="insight-detail">Aggregating your data sources…</div>
        <div style="font-size:13px;color:var(--accent-primary);margin-top:8px;font-style:italic" id="insight-rec"></div>
      </div>
      <div style="text-align:center;flex-shrink:0">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px">FlowScore</div>
        <div style="font-size:36px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent" id="flowscore-display">—</div>
      </div>
    </div>
    <div class="insight-sources" id="insight-sources"></div>
  </div>
  <div class="metrics-grid" id="metrics-grid">
    <div class="metric-card"><div class="metric-icon">🍅</div><div class="metric-value" id="m-sessions">0</div><div class="metric-label">Sessions Today</div><div class="metric-trend">↑ Tracking</div></div>
    <div class="metric-card"><div class="metric-icon">⏱️</div><div class="metric-value" id="m-focus">0h</div><div class="metric-label">Focus Time</div><div class="metric-trend">↑ Growing</div></div>
    <div class="metric-card"><div class="metric-icon">🔥</div><div class="metric-value" id="m-streak">0</div><div class="metric-label">Day Streak</div><div class="metric-trend">Keep going!</div></div>
    <div class="metric-card"><div class="metric-icon">✅</div><div class="metric-value" id="m-completion">—%</div><div class="metric-label">Completion Rate</div><div class="metric-trend">↑ Strong</div></div>
    <div class="metric-card" id="m-health-card"><div class="metric-icon">👟</div><div class="metric-value" id="m-steps">—</div><div class="metric-label">Steps</div><div class="metric-trend" style="color:var(--text-muted)">Connect health</div></div>
    <div class="metric-card" id="m-sleep-card"><div class="metric-icon">😴</div><div class="metric-value" id="m-sleep">—h</div><div class="metric-label">Sleep</div><div class="metric-trend" style="color:var(--text-muted)">Connect health</div></div>
    <div class="metric-card" id="m-hydration-card"><div class="metric-icon">💧</div><div class="metric-value" id="m-hydration">0</div><div class="metric-label">Hydration (glasses)</div><div class="metric-trend"><button onclick="logHydration()" class="btn-sm" style="font-size:10px;padding:3px 8px">+ Log</button></div></div>
    <div class="metric-card" id="m-lang-card"><div class="metric-icon">🌍</div><div class="metric-value" id="m-lang">0</div><div class="metric-label">Language Streak</div><div class="metric-trend"><button onclick="logLanguage()" class="btn-sm" style="font-size:10px;padding:3px 8px">+ Log</button></div></div>
  </div>
  <div class="chart-wrap">
    <div class="chart-title"><i class="fas fa-chart-bar" style="color:var(--accent-primary)"></i> Weekly Focus Sessions</div>
    <canvas id="focus-chart" height="100"></canvas>
  </div>
</div>

<!-- ════════════════════════════════════════
     BOARD TAB (Notion Kanban)
     ════════════════════════════════════════ -->
<div class="tab-content" id="tab-content-board" style="padding:16px">
  <div id="board-auth-banner" class="auth-banner" style="display:none">
    <h3>📝 Connect Notion</h3>
    <p>Sync your Notion databases to the Kanban board. Drag cards to update status — syncs back to Notion instantly.</p>
    <button class="btn-primary" onclick="connectNotion()"><i class="fas fa-n"></i>&nbsp; Connect Notion</button>
  </div>
  <div id="notion-db-selector" style="display:none;margin-bottom:16px">
    <div class="section-header">
      <div class="section-title">Choose Notion Database</div>
      <button class="btn-sm" onclick="loadNotionDatabases()"><i class="fas fa-sync"></i> Refresh</button>
    </div>
    <div class="notion-db-list" id="notion-db-list"></div>
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
    <div>
      <div class="section-title" id="board-title">Kanban Board</div>
      <div style="font-size:12px;color:var(--text-muted)" id="board-subtitle">Local board — connect Notion to sync</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-sm" onclick="addCard()"><i class="fas fa-plus"></i> Add Card</button>
      <button class="btn-sm" id="btn-notion-sync" style="display:none" onclick="syncNotion()"><i class="fas fa-sync"></i> Sync</button>
    </div>
  </div>
  <div class="board-wrap" id="board-wrap"></div>
</div>

<!-- ════════════════════════════════════════
     LEARN TAB
     ════════════════════════════════════════ -->
<div class="tab-content" id="tab-content-learn">
  <div class="learn-carousel" id="learn-carousel"></div>
  <div class="learn-nav" id="learn-nav"></div>
  <div class="ai-cards-section">
    <div class="section-header">
      <div class="section-title"><i class="fas fa-robot" style="color:var(--accent-primary)"></i>&nbsp; AI-Generated Insights</div>
      <button class="btn-sm" onclick="refreshAIInsights()"><i class="fas fa-sync"></i> Refresh</button>
    </div>
    <div class="ai-card-row" id="ai-insights-row">
      <div class="metric-card"><div class="metric-icon">🧠</div><div class="metric-value" style="font-size:14px;font-weight:700">Spaced Repetition</div><div class="metric-label" style="text-transform:none;font-size:12px;color:var(--text-secondary);margin-top:4px">Review at 1d, 3d, 1w, 1m for optimal retention</div></div>
      <div class="metric-card"><div class="metric-icon">🌊</div><div class="metric-value" style="font-size:14px;font-weight:700">Flow Threshold</div><div class="metric-label" style="text-transform:none;font-size:12px;color:var(--text-secondary);margin-top:4px">Challenge must exceed skill by ~4% to trigger flow</div></div>
      <div class="metric-card"><div class="metric-icon">⚡</div><div class="metric-value" style="font-size:14px;font-weight:700">Power of Defaults</div><div class="metric-label" style="text-transform:none;font-size:12px;color:var(--text-secondary);margin-top:4px">What you do without thinking defines your life trajectory</div></div>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════
     RESTORE TAB
     ════════════════════════════════════════ -->
<div class="tab-content" id="tab-content-restore">
  <div class="restore-scene" id="restore-scene"></div>
  <div class="restore-nav" id="restore-nav">
    <button class="restore-btn" id="btn-prev-restore" onclick="prevRestore()" style="background:var(--bg-panel);color:var(--text-secondary);border-color:var(--border)"><i class="fas fa-chevron-left"></i></button>
    <button class="restore-btn" onclick="nextRestore()">Next Restore →</button>
    <button class="restore-btn" id="btn-prev-restore2" onclick="returnToFocus()" style="background:rgba(168,85,247,.1);color:var(--accent-primary);border-color:rgba(168,85,247,.3)"><i class="fas fa-bullseye"></i> Back to Focus</button>
  </div>
  <div id="notebook-panel-area" style="margin-top:16px">
    <div class="notebook-panel">
      <div class="notebook-status">
        <div class="status-dot coming-soon"></div>
        <div>
          <div style="font-size:13px;font-weight:700">NotebookLM Bridge</div>
          <div style="font-size:11px;color:var(--text-muted)">Powered by Google Drive access (via Google OAuth)</div>
        </div>
        <div style="margin-left:auto">
          <span style="font-size:10px;font-weight:700;padding:3px 10px;border-radius:6px;background:rgba(245,158,11,.15);color:var(--warning)">API COMING SOON</span>
        </div>
      </div>
      <div id="notebooklm-content">
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Google announced the NotebookLM API for 2025. Once live, FlowState will auto-sync your notebooks. Until then, paste a NotebookLM URL to embed it:</p>
        <input type="url" class="form-input" id="notebook-url-input" placeholder="https://notebooklm.google.com/notebook/…" style="margin-bottom:10px">
        <button class="btn-sm" onclick="loadNotebookIframe()">Load Notebook</button>
        <div id="notebook-iframe-container" style="margin-top:12px;display:none">
          <iframe id="notebook-iframe" class="notebook-iframe" sandbox="allow-scripts allow-same-origin allow-forms" allowfullscreen></iframe>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════
     GENERATE TAB (Image + Video)
     ════════════════════════════════════════ -->
<div class="tab-content" id="tab-content-generate">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;height:100%">
    <!-- Image Gen -->
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="gen-panel" style="flex:1">
        <div class="gen-title"><i class="fas fa-image" style="color:var(--accent-primary)"></i> Image Generation</div>
        <div class="model-picker" id="image-model-picker" style="margin-bottom:12px"></div>
        <textarea class="gen-prompt" id="image-prompt" placeholder="Describe your image… e.g. 'A focused developer in a neon-lit workspace, cyberpunk aesthetic, ultra-detailed'"></textarea>
        <div class="gen-controls">
          <select class="form-select" id="image-style">
            <option value="vivid">Vivid</option>
            <option value="natural">Natural</option>
          </select>
          <select class="form-select" id="image-size">
            <option value="1024x1024">1024×1024</option>
            <option value="1792x1024">1792×1024</option>
            <option value="1024x1792">1024×1792</option>
          </select>
          <button class="btn-generate" id="btn-gen-img" onclick="generateImage()"><i class="fas fa-wand-magic-sparkles"></i> Generate</button>
        </div>
        <div class="gen-results" id="image-results"></div>
      </div>
    </div>
    <!-- Video Gen -->
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="gen-panel" style="flex:1">
        <div class="gen-title"><i class="fas fa-film" style="color:var(--accent-secondary)"></i> Video Generation</div>
        <div class="model-picker" id="video-model-picker" style="margin-bottom:12px"></div>
        <textarea class="gen-prompt" id="video-prompt" placeholder="Describe your video… e.g. 'Time-lapse of a productive workspace, golden hour, cinematic'"></textarea>
        <div class="gen-controls">
          <select class="form-select" id="video-duration">
            <option value="5">5s</option>
            <option value="8">8s</option>
            <option value="10">10s</option>
          </select>
          <button class="btn-generate" id="btn-gen-vid" onclick="generateVideo()"><i class="fas fa-clapperboard"></i> Generate</button>
        </div>
        <div id="video-results" style="margin-top:14px"></div>
      </div>
    </div>
  </div>
</div>

<script>
// ════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════
const FS_USER = ${userJson};
const FS_NOTION = ${notionJson};

const state = {
  timer: { running: false, remaining: 25*60, total: 25*60, phase: 'focus', sessionNumber: 0, totalFocusSeconds: 0, interval: null },
  user: { streak: parseInt(localStorage.getItem('fs_streak')||'0'), tier: localStorage.getItem('fs_tier')||'free' },
  kanban: { columns: { todo: [], inprogress: [], done: [] }, notionDbId: localStorage.getItem('fs_notion_db')||null, notionPageStatus: {} },
  chat: { history: [], activeModel: null, routing: true },
  learn: { cards: [], currentIdx: 0, autoTimer: null },
  restore: { currentIdx: 0, breathPhase: 'idle', breathTimer: null },
  metrics: { hydration: parseInt(localStorage.getItem('fs_hydration')||'0'), langStreak: parseInt(localStorage.getItem('fs_lang_streak')||'0'), completedToday: 0 },
  tips: { lastShownAt: 0, minutesElapsed: 0 },
  gen: { imageModel: 'dalle3', videoModel: 'veo2' },
};

// ── Model data (mirrored from intent layer) ─────────────────────
const MODELS = {
  'gpt-4o': { name:'GPT-4o', provider:'OpenAI', color:'#10b981', badge:null },
  'claude-3-7-sonnet': { name:'Claude 3.7', provider:'Anthropic', color:'#f59e0b', badge:null },
  'gemini-2-flash': { name:'Gemini 2.0', provider:'Google', color:'#3b82f6', badge:null },
  'grok-3': { name:'Grok 3', provider:'xAI', color:'#8b5cf6', badge:null },
  'mistral-large': { name:'Mistral', provider:'Mistral', color:'#06b6d4', badge:null },
  'deepseek-r1': { name:'DeepSeek R1', provider:'DeepSeek', color:'#a855f7', badge:null },
  'llama-3-3': { name:'Llama 3.3', provider:'Meta', color:'#3b82f6', badge:null },
  'gpt-4o-mini': { name:'GPT-4o mini', provider:'OpenAI', color:'#10b981', badge:'Free' },
};
const IMAGE_MODELS = {
  'dalle3': { name:'DALL·E 3', provider:'OpenAI' },
  'imagen3': { name:'Imagen 3', provider:'Google' },
  'sd3': { name:'SD 3', provider:'Stability AI' },
  'flux_pro': { name:'FLUX Pro', provider:'BFL' },
  'ideogram2': { name:'Ideogram 2', provider:'Ideogram' },
};
const VIDEO_MODELS = {
  'veo2': { name:'Veo 2', provider:'Google' },
  'kling16': { name:'Kling 1.6', provider:'Kuaishou' },
  'runway_gen4': { name:'Runway Gen-4', provider:'Runway ML' },
  'pika20': { name:'Pika 2.0', provider:'Pika' },
  'hailuo': { name:'Hailuo', provider:'MiniMax' },
  'sora': { name:'Sora', provider:'OpenAI' },
};

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════
async function init() {
  // Restore timer state
  const savedFocusMin = parseInt(localStorage.getItem('fs_focus_min')||'25');
  const savedFocus = parseInt(localStorage.getItem('fs_total_focus')||'0');
  const savedSessions = parseInt(localStorage.getItem('fs_sessions')||'0');
  state.timer.total = savedFocusMin * 60;
  state.timer.remaining = savedFocusMin * 60;
  state.timer.totalFocusSeconds = savedFocus;
  state.timer.sessionNumber = savedSessions;
  state.metrics.completedToday = parseInt(localStorage.getItem('fs_today_sessions')||'0');

  renderUserArea();
  updateTimerDisplay();
  updateRing();
  updateStatsDisplay();
  renderModelPicker();
  renderImageModelPicker();
  renderVideoModelPicker();

  // Date/time
  updateDateTime();
  setInterval(updateDateTime, 1000);

  // Calendar
  renderCalendar();
  if (FS_USER) {
    document.getElementById('calendar-main').style.display = 'block';
    loadCalendarEvents();
  } else {
    document.getElementById('calendar-auth-banner').style.display = 'block';
  }

  // Board
  if (FS_NOTION && state.kanban.notionDbId) {
    loadNotionCards();
  } else if (FS_NOTION) {
    document.getElementById('board-auth-banner').style.display = 'none';
    document.getElementById('notion-db-selector').style.display = 'block';
    loadNotionDatabases();
  } else {
    document.getElementById('board-auth-banner').style.display = 'block';
  }
  renderKanban();

  // Learn cards
  await loadLearnCards();

  // Restore
  renderRestoreScene();

  // Metrics + insight
  updateMetricsDisplay();
  setTimeout(updateBehaviorInsight, 2000);

  // Init chart
  initFocusChart();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); toggleTimer(); }
    if (e.code === 'Escape') closeModal();
    if ((e.metaKey||e.ctrlKey) && e.code === 'KeyM') { e.preventDefault(); switchTab('chat'); }
    if ((e.metaKey||e.ctrlKey) && e.code === 'Enter') {
      const ci = document.getElementById('chat-input');
      if (document.activeElement === ci) { e.preventDefault(); sendMessage(); }
    }
  });

  // Chat enter to send
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  });

  // Tip timer
  setInterval(checkTips, 60000);

  // Session blocking check
  setInterval(checkSessionBlocking, 30000);
}

// ════════════════════════════════════════════════════════════════
// USER AREA
// ════════════════════════════════════════════════════════════════
function renderUserArea() {
  const el = document.getElementById('user-area');
  if (FS_USER) {
    el.innerHTML = '<div class="user-pill" onclick="openUserMenu()"><img class="user-avatar" src="'+FS_USER.picture+'" onerror="this.src=\\'\\'" alt=""><span class="user-name">'+FS_USER.name.split(' ')[0]+'</span><i class="fas fa-chevron-down" style="font-size:9px;color:var(--text-muted)"></i></div>';
  } else {
    el.innerHTML = '<button id="btn-google-signin" onclick="connectGoogle()"><i class="fab fa-google"></i>&nbsp; Sign in with Google</button>';
  }
}

function connectGoogle() {
  window.open('/api/auth/google', '_blank', 'width=500,height=700');
  const checkInterval = setInterval(() => {
    fetch('/api/auth/me').then(r=>r.json()).then(d => {
      if (d.authenticated) { clearInterval(checkInterval); window.location.reload(); }
    });
  }, 2000);
}

function connectNotion() {
  window.open('/api/auth/notion', '_blank', 'width=500,height=700');
  const checkInterval = setInterval(() => {
    fetch('/api/auth/notion-status').then(r=>r.json()).then(d => {
      if (d.connected) { clearInterval(checkInterval); window.location.reload(); }
    });
  }, 2000);
}

function openUserMenu() {
  openModal('Account', '<div style="display:flex;flex-direction:column;gap:10px">' +
    (FS_USER ? '<div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-card);border-radius:10px"><img src="'+FS_USER.picture+'" style="width:44px;height:44px;border-radius:50%"><div><div style="font-weight:700">'+FS_USER.name+'</div><div style="font-size:12px;color:var(--text-muted)">'+FS_USER.email+'</div></div></div>' : '') +
    '<button class="btn-sm" onclick="closeModal();openPremiumModal()" style="text-align:left"><i class="fas fa-star"></i>&nbsp; Upgrade to Pro</button>' +
    '<button class="btn-sm" onclick="signOut()" style="text-align:left;color:var(--danger)"><i class="fas fa-sign-out-alt"></i>&nbsp; Sign out of Google</button>' +
    '</div>');
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.reload();
}

// ════════════════════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════════════════════
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-'+name)?.classList.add('active');
  document.getElementById('tab-content-'+name)?.classList.add('active');

  if (name === 'metrics') { updateMetricsDisplay(); updateBehaviorInsight(); }
  if (name === 'board' && FS_NOTION && state.kanban.notionDbId) syncNotion();
  if (name === 'learn') renderLearnCarousel();
  if (name === 'restore') renderRestoreScene();
  if (name === 'chat') setTimeout(() => document.getElementById('chat-messages').scrollTo(0,99999), 50);
}

// ════════════════════════════════════════════════════════════════
// DATETIME WIDGET
// ════════════════════════════════════════════════════════════════
function updateDateTime() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
  document.getElementById('dt-date').textContent = dateStr;
  document.getElementById('dt-time').textContent = timeStr;
}

function openCalendarPopover() { switchTab('calendar'); }

// ════════════════════════════════════════════════════════════════
// TIMER
// ════════════════════════════════════════════════════════════════
const PHASES = { focus: { label:'FOCUS', min:25 }, short_break: { label:'SHORT BREAK', min:5 }, long_break: { label:'LONG BREAK', min:15 } };
const CIRCUMFERENCE = 2 * Math.PI * 98; // 615.75

function updateTimerDisplay() {
  const m = Math.floor(state.timer.remaining / 60).toString().padStart(2,'0');
  const s = (state.timer.remaining % 60).toString().padStart(2,'0');
  document.getElementById('timer-display').textContent = m + ':' + s;
  const phaseData = PHASES[state.timer.phase];
  document.getElementById('timer-phase').textContent = phaseData.label;
  document.title = (state.timer.running ? '▶ ' : '') + m + ':' + s + ' — FlowState';
}

function updateRing() {
  const pct = state.timer.remaining / state.timer.total;
  const offset = CIRCUMFERENCE * (1 - pct);
  document.getElementById('ring-progress').style.strokeDashoffset = offset;
}

function setPhase(phase) {
  if (state.timer.running) { clearInterval(state.timer.interval); state.timer.running = false; }
  document.getElementById('btn-icon').className = 'fas fa-play';
  document.querySelectorAll('.phase-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('phase-'+phase.replace('_break','')+((phase==='short_break'?'-short':phase==='long_break'?'-long':'')))?.classList.add('active');

  const phaseMap = { focus: 'focus', short_break: 'short', long_break: 'long' };
  document.getElementById('phase-'+phaseMap[phase])?.classList.add('active');

  const mins = phase === 'focus' ? parseInt(localStorage.getItem('fs_focus_min')||'25') : phase === 'short_break' ? parseInt(localStorage.getItem('fs_short_min')||'5') : 15;
  state.timer.phase = phase;
  state.timer.total = mins * 60;
  state.timer.remaining = mins * 60;
  document.getElementById('timer-glow').classList.remove('active');
  document.getElementById('breathing-ring').classList.remove('active');
  document.getElementById('btn-icon').className = 'fas fa-play';
  updateTimerDisplay(); updateRing();
}

function toggleTimer() {
  if (state.timer.running) {
    clearInterval(state.timer.interval);
    state.timer.running = false;
    document.getElementById('btn-icon').className = 'fas fa-play';
    document.getElementById('timer-glow').classList.remove('active');
    document.getElementById('breathing-ring').classList.remove('active');
    document.body.classList.remove('ambient-active');
  } else {
    state.timer.running = true;
    document.getElementById('btn-icon').className = 'fas fa-pause';
    document.getElementById('timer-glow').classList.add('active');
    document.getElementById('breathing-ring').classList.add('active');
    document.body.classList.add('ambient-active');
    state.timer.interval = setInterval(tick, 1000);
  }
}

function tick() {
  if (state.timer.remaining <= 0) { timerComplete(); return; }
  state.timer.remaining--;
  if (state.timer.phase === 'focus') {
    state.timer.totalFocusSeconds++;
    state.tips.minutesElapsed = Math.floor((state.timer.total - state.timer.remaining) / 60);
  }
  updateTimerDisplay(); updateRing();
}

function timerComplete() {
  clearInterval(state.timer.interval);
  state.timer.running = false;
  document.getElementById('btn-icon').className = 'fas fa-play';
  document.getElementById('timer-glow').classList.remove('active');
  document.getElementById('breathing-ring').classList.remove('active');
  document.body.classList.remove('ambient-active');

  if (state.timer.phase === 'focus') {
    state.timer.sessionNumber++;
    state.metrics.completedToday++;
    localStorage.setItem('fs_total_focus', state.timer.totalFocusSeconds);
    localStorage.setItem('fs_sessions', state.timer.sessionNumber);
    localStorage.setItem('fs_today_sessions', state.metrics.completedToday);
    updateStatsDisplay();
    triggerCelebration(state.timer.sessionNumber);
    // Auto-switch to restore
    setTimeout(() => { setPhase('short_break'); if (document.getElementById('tab-content-restore').classList.contains('active')) renderRestoreScene(); }, 1500);
  } else {
    setPhase('focus');
  }

  // Chime
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 528;
    gain.gain.setValueAtTime(.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + 1.5);
    osc.start(); osc.stop(ctx.currentTime + 1.5);
  } catch {}
}

function resetTimer() {
  clearInterval(state.timer.interval);
  state.timer.running = false;
  document.getElementById('btn-icon').className = 'fas fa-play';
  document.getElementById('timer-glow').classList.remove('active');
  document.getElementById('breathing-ring').classList.remove('active');
  document.body.classList.remove('ambient-active');
  const mins = parseInt(localStorage.getItem('fs_focus_min')||'25');
  state.timer.remaining = (state.timer.phase === 'focus' ? mins : state.timer.phase === 'short_break' ? 5 : 15) * 60;
  state.timer.total = state.timer.remaining;
  updateTimerDisplay(); updateRing();
}

function skipPhase() {
  clearInterval(state.timer.interval);
  state.timer.remaining = 0;
  timerComplete();
}

function returnToFocus() { switchTab('focus'); setPhase('focus'); }

function updateStatsDisplay() {
  document.getElementById('stat-sessions').textContent = state.timer.sessionNumber;
  document.getElementById('stat-focus-time').textContent = Math.round(state.timer.totalFocusSeconds / 60) + 'm';
  document.getElementById('stat-streak').textContent = '🔥 ' + state.user.streak;
}

// ════════════════════════════════════════════════════════════════
// AMBIENT SOUND (Web Audio API oscillator simulation)
// ════════════════════════════════════════════════════════════════
let audioCtx = null, soundNode = null;
function toggleSound(type) {
  document.querySelectorAll('.sound-chip').forEach(c => c.classList.remove('active'));
  if (type === 'silence' || (soundNode && soundNode._type === type)) {
    soundNode?.stop?.(); soundNode = null; return;
  }
  event.target.closest('.sound-chip').classList.add('active');
  if (!audioCtx) audioCtx = new AudioContext();
  soundNode?.stop?.();
  // Simple noise approximation (real implementation would use audio files)
  const bufferSize = audioCtx.sampleRate * 2;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.05;
  const source = audioCtx.createBufferSource();
  source.buffer = buffer; source.loop = true;
  const filter = audioCtx.createBiquadFilter();
  const freqMap = { rain: 800, forest: 400, cafe: 1200, ocean: 300, fire: 600, space: 200 };
  filter.frequency.value = freqMap[type] || 500;
  filter.type = 'lowpass';
  source.connect(filter); filter.connect(audioCtx.destination);
  source._type = type; source.start();
  soundNode = source;
}

// ════════════════════════════════════════════════════════════════
// MODEL PICKER (Chat)
// ════════════════════════════════════════════════════════════════
function renderModelPicker() {
  const el = document.getElementById('model-picker');
  let html = '';
  Object.entries(MODELS).forEach(([id, m]) => {
    const isActive = state.chat.activeModel === id;
    const isAuto = !state.chat.activeModel && id === 'gpt-4o';
    html += '<button class="model-chip '+(isActive?'active':'')+'" onclick="selectModel(\\''+id+'\\')" style="--mc:'+(m.color)+'">'+
      (isActive ? '<i class="fas fa-check" style="font-size:9px"></i>' : '') +
      m.name + (m.badge ? ' <span class="badge">'+m.badge+'</span>' : '') +
      '</button>';
  });
  html += '<button class="model-chip '+(state.chat.routing?'active':'')+'" onclick="toggleAutoRoute()" style="margin-left:4px">'+
    '<i class="fas fa-route" style="font-size:10px"></i> Auto</button>';
  html += '<div class="routing-badge"><div class="dot"></div>' +
    (state.chat.activeModel ? 'Using ' + MODELS[state.chat.activeModel]?.name : 'Smart routing active') + '</div>';
  el.innerHTML = html;
}

function selectModel(id) {
  state.chat.activeModel = state.chat.activeModel === id ? null : id;
  state.chat.routing = !state.chat.activeModel;
  renderModelPicker();
}

function toggleAutoRoute() {
  state.chat.activeModel = null;
  state.chat.routing = true;
  renderModelPicker();
}

function renderImageModelPicker() {
  const el = document.getElementById('image-model-picker');
  if (!el) return;
  let html = '<span style="font-size:11px;font-weight:700;color:var(--text-muted);white-space:nowrap">Model:</span>';
  Object.entries(IMAGE_MODELS).forEach(([id, m]) => {
    html += '<button class="model-chip '+(state.gen.imageModel===id?'active':'')+'" onclick="state.gen.imageModel=\\''+id+'\\';renderImageModelPicker()">'+m.name+'</button>';
  });
  el.innerHTML = html;
}

function renderVideoModelPicker() {
  const el = document.getElementById('video-model-picker');
  if (!el) return;
  let html = '<span style="font-size:11px;font-weight:700;color:var(--text-muted);white-space:nowrap">Model:</span>';
  Object.entries(VIDEO_MODELS).forEach(([id, m]) => {
    html += '<button class="model-chip '+(state.gen.videoModel===id?'active':'')+'" onclick="state.gen.videoModel=\\''+id+'\\';renderVideoModelPicker()">'+m.name+'</button>';
  });
  el.innerHTML = html;
}

// ════════════════════════════════════════════════════════════════
// CHAT
// ════════════════════════════════════════════════════════════════
function addMessage(role, content, model) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const modelLabel = model ? MODELS[model]?.name || model : 'FlowState';
  const avatarContent = role === 'user' ? (FS_USER?.picture ? '<img src="'+FS_USER.picture+'" style="width:100%;height:100%;border-radius:50%;object-fit:cover">' : '👤') : '⚡';
  const avatarStyle = role === 'ai' ? 'background:var(--grad)' : 'background:var(--bg-card)';
  el.innerHTML = '<div class="msg-avatar" style="'+avatarStyle+'">'+avatarContent+'</div>' +
    '<div>' +
    (role === 'ai' ? '<div class="msg-meta"><span class="model-tag">'+modelLabel+'</span></div>' : '') +
    '<div class="msg-bubble">'+formatMessage(content)+'</div></div>';
  document.getElementById('chat-messages').appendChild(el);
  document.getElementById('chat-messages').scrollTo(0, 99999);
}

let typingId = null;
function addTypingIndicator() {
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg ai'; div.id = 'typing-indicator';
  div.innerHTML = '<div class="msg-avatar" style="background:var(--grad)">⚡</div>' +
    '<div><div class="msg-bubble" style="display:flex;gap:4px;padding:14px 16px"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
  msgs.appendChild(div);
  msgs.scrollTo(0, 99999);
}

function removeTypingIndicator() { document.getElementById('typing-indicator')?.remove(); }

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = ''; input.style.height = 'auto';
  document.getElementById('btn-send').disabled = true;

  addMessage('user', message);
  state.chat.history.push({ role: 'user', content: message });
  addTypingIndicator();

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        model: state.chat.activeModel || null,
        messages: state.chat.history.slice(-10),
      }),
    });
    const routedModel = res.headers.get('X-Routed-Model') || 'gpt-4o';
    const routingReason = res.headers.get('X-Routing-Reason') || '';
    const text = await res.text();
    removeTypingIndicator();
    addMessage('ai', text, routedModel);
    state.chat.history.push({ role: 'assistant', content: text });

    // Update routing badge
    if (routedModel && !state.chat.activeModel) {
      renderModelPicker();
    }
  } catch (err) {
    removeTypingIndicator();
    addMessage('ai', 'Connection error. Please check your internet and try again.', 'gpt-4o-mini');
  }

  document.getElementById('btn-send').disabled = false;
  input.focus();
}

function formatMessage(text) {
  if (!text) return '';
  var t = text;
  t = t.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
  t = t.split(String.fromCharCode(10)).join('<br>');
  var boldRx = new RegExp('[*]{2}([^*]+)[*]{2}', 'g');
  t = t.replace(boldRx, '<strong>$1</strong>');
  var italicRx = new RegExp('[*]([^*]+)[*]', 'g');
  t = t.replace(italicRx, '<em>$1</em>');
  return t;
}

// ════════════════════════════════════════════════════════════════
// CALENDAR
// ════════════════════════════════════════════════════════════════
let calYear, calMonth, calEvents = [];

function renderCalendar() {
  const now = new Date();
  calYear = calYear || now.getFullYear();
  calMonth = calMonth || now.getMonth();

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const monthName = new Date(calYear, calMonth).toLocaleDateString('en-US', { month:'long', year:'numeric' });
  document.getElementById('cal-month-label')?.setAttribute && (document.getElementById('cal-month-label') ? document.getElementById('cal-month-label').textContent = monthName : null);

  const eventDays = new Set(calEvents.map(e => new Date(e.start).getDate()));
  const grid = document.getElementById('cal-grid');
  if (!grid) return;

  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => '<div class="cal-header">'+d+'</div>').join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day other-month">'+(daysInMonth - firstDay + i + 1)+'</div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = d === now.getDate() && calMonth === now.getMonth() && calYear === now.getFullYear();
    const hasEvent = eventDays.has(d);
    html += '<div class="cal-day'+(isToday?' today':'')+(hasEvent?' has-event':'')+'" onclick="selectDay('+d+')">'+d+'</div>';
  }
  grid.innerHTML = html;
}

function prevMonth() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); }
function nextMonth() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); }

function selectDay(day) {
  const dayEvents = calEvents.filter(e => new Date(e.start).getDate() === day && new Date(e.start).getMonth() === calMonth);
  if (dayEvents.length === 0) { showNotification('No events on this day', 'info'); return; }
  const content = dayEvents.map(e => '<div class="event-item"><div class="event-dot" style="background:'+e.color+'"></div><div><div class="event-summary">'+e.summary+'</div><div class="event-time">'+formatEventTime(e.start)+' – '+formatEventTime(e.end)+'</div></div></div>').join('');
  openModal('Events on ' + new Date(calYear, calMonth, day).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }), content);
}

async function loadCalendarEvents() {
  try {
    const res = await fetch('/api/calendar/events');
    if (!res.ok) { renderCalendarEmpty(); return; }
    const data = await res.json();
    calEvents = data.events || [];
    renderCalendar();
    renderEventList();
    checkSessionBlocking();
  } catch { renderCalendarEmpty(); }
}

function renderCalendarEmpty() {
  const el = document.getElementById('event-list');
  if (el) el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-xmark"></i><p>Could not load events.<br>Check your Google Calendar permissions.</p></div>';
}

function renderEventList() {
  const el = document.getElementById('event-list');
  if (!el) return;
  const upcoming = calEvents.slice(0, 8);
  if (upcoming.length === 0) { el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-check"></i><p>No upcoming events. Free to flow!</p></div>'; return; }
  el.innerHTML = upcoming.map(e => '<div class="event-item"><div class="event-dot" style="background:'+e.color+'"></div><div style="flex:1"><div class="event-summary">'+e.summary+'</div><div class="event-time">'+formatEventTime(e.start)+(e.allDay?' · All day':'')+'</div></div><button class="btn-block" onclick="blockFocusTime()"><i class="fas fa-lock"></i></button></div>').join('');
}

function formatEventTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }); }
  catch { return iso.slice(0, 10); }
}

async function blockFocusTime() {
  if (!FS_USER) { connectGoogle(); return; }
  const now = new Date();
  const end = new Date(now.getTime() + 25 * 60000);
  try {
    await fetch('/api/calendar/block', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title:'🍅 Focus Block — FlowState', start: now.toISOString(), end: end.toISOString() }) });
    showNotification('Focus block added to Google Calendar ✓', 'success');
    loadCalendarEvents();
  } catch { showNotification('Could not create focus block', 'error'); }
}

async function blockAroundEvent(eventId) {
  showNotification('Focus block protection coming soon', 'info');
}

async function checkSessionBlocking() {
  if (!calEvents.length) return;
  const now = new Date();
  const upcoming = calEvents.filter(e => {
    const start = new Date(e.start);
    return start > now && start < new Date(now.getTime() + 30 * 60000);
  });
  const warning = document.getElementById('session-block-warning');
  if (upcoming.length > 0) {
    const ev = upcoming[0];
    const mins = Math.round((new Date(ev.start) - now) / 60000);
    document.getElementById('session-block-msg').textContent = '"'+ev.summary+'" starts in '+mins+' min — consider a shorter session';
    warning.style.display = 'block';
  } else { warning.style.display = 'none'; }
}

// ════════════════════════════════════════════════════════════════
// KANBAN / BOARD
// ════════════════════════════════════════════════════════════════
let dragCard = null, dragFromCol = null;

function renderKanban() {
  const wrap = document.getElementById('board-wrap');
  if (!wrap) return;
  const cols = { todo: 'To Do', inprogress: 'In Progress', done: 'Done' };
  const colors = { todo: 'var(--text-muted)', inprogress: 'var(--accent-primary)', done: 'var(--success)' };
  let html = '';
  Object.entries(cols).forEach(([key, label]) => {
    const cards = state.kanban.columns[key] || [];
    html += '<div class="kanban-col" id="col-'+key+'" ondragover="dragOver(event)" ondrop="drop(event,\\''+key+'\\')">'+
      '<div class="kanban-col-header"><span class="kanban-col-title" style="color:'+colors[key]+'">'+label+'</span><span class="kanban-count">'+cards.length+'</span></div>'+
      '<div class="kanban-cards" id="cards-'+key+'">'+
      cards.map(card => '<div class="kanban-card" draggable="true" id="card-'+card.id+'" ondragstart="dragStart(event,\\''+card.id+'\\',\\''+key+'\\')" ondragend="dragEnd(event)">'+
        '<div class="card-title">'+card.icon+' '+card.title+'</div>'+
        (card.tag ? '<span class="card-tag">'+card.tag+'</span>' : '')+
        (card.lastEdited ? '<div class="card-meta"><i class="fas fa-clock"></i> '+formatRelativeTime(card.lastEdited)+'</div>' : '')+
        '</div>').join('')+
      '</div></div>';
  });
  wrap.innerHTML = html;
}

function dragStart(e, id, col) { dragCard = id; dragFromCol = col; e.currentTarget.classList.add('dragging'); }
function dragEnd(e) { e.currentTarget.classList.remove('dragging'); }
function dragOver(e) { e.preventDefault(); }
async function drop(e, toCol) {
  e.preventDefault();
  if (!dragCard || dragFromCol === toCol) return;
  const card = state.kanban.columns[dragFromCol]?.find(c => c.id === dragCard);
  if (!card) return;
  state.kanban.columns[dragFromCol] = state.kanban.columns[dragFromCol].filter(c => c.id !== dragCard);
  const statusMap = { todo: 'Not started', inprogress: 'In progress', done: 'Done' };
  card.status = toCol;
  state.kanban.columns[toCol] = state.kanban.columns[toCol] || [];
  state.kanban.columns[toCol].push(card);
  renderKanban();
  // Sync to Notion if connected
  if (FS_NOTION && state.kanban.notionDbId && card.notionPageId) {
    try {
      await fetch('/api/notion/pages/'+card.notionPageId, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ status: statusMap[toCol], propertyName: card.notionStatusProp || 'Status', propertyType: card.notionStatusType || 'select' }),
      });
      showNotification('Synced to Notion ✓', 'success');
    } catch { showNotification('Notion sync failed', 'error'); }
  }
}

async function loadNotionDatabases() {
  const listEl = document.getElementById('notion-db-list');
  if (listEl) listEl.innerHTML = '<div class="empty-state"><div class="spinner"></div><p style="margin-top:8px">Loading databases…</p></div>';
  try {
    const res = await fetch('/api/notion/databases');
    const data = await res.json();
    if (!data.databases?.length) { if (listEl) listEl.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">No databases found. Make sure you shared databases with the FlowState integration.</p>'; return; }
    if (listEl) listEl.innerHTML = data.databases.map(db =>
      '<div class="notion-db-item '+(state.kanban.notionDbId===db.id?'selected':'')+'" onclick="selectNotionDb(\\''+db.id+'\\',\\''+db.title+'\\')">'+
      '<span style="font-size:20px">'+db.icon+'</span><div><div style="font-size:13px;font-weight:600">'+db.title+'</div><div style="font-size:11px;color:var(--text-muted)">'+db.id.slice(0,8)+'…</div></div>'+
      (state.kanban.notionDbId===db.id?'<i class="fas fa-check-circle" style="color:var(--success);margin-left:auto"></i>':'')+
      '</div>'
    ).join('');
  } catch { if (listEl) listEl.innerHTML = '<p style="font-size:13px;color:var(--danger)">Could not load databases.</p>'; }
}

function selectNotionDb(id, title) {
  state.kanban.notionDbId = id;
  localStorage.setItem('fs_notion_db', id);
  document.getElementById('board-title').textContent = title;
  document.getElementById('board-subtitle').textContent = 'Synced with Notion · ' + title;
  document.getElementById('notion-db-selector').style.display = 'none';
  document.getElementById('btn-notion-sync').style.display = 'inline-flex';
  loadNotionCards();
}

async function loadNotionCards() {
  if (!state.kanban.notionDbId) return;
  try {
    const res = await fetch('/api/notion/pages/'+state.kanban.notionDbId);
    const data = await res.json();
    if (data.error) return;
    state.kanban.columns = { todo: [], inprogress: [], done: [] };
    data.pages.forEach(p => {
      const col = p.status || 'todo';
      if (!state.kanban.columns[col]) state.kanban.columns[col] = [];
      state.kanban.columns[col].push({ id:p.id, title:p.title, icon:p.icon, notionPageId:p.id, lastEdited:p.lastEdited, tag:'notion' });
    });
    renderKanban();
    document.getElementById('board-subtitle').textContent = 'Live sync · Notion · ' + (data.pages.length) + ' cards';
  } catch {}
}

async function syncNotion() {
  showNotification('Syncing with Notion…', 'info');
  await loadNotionCards();
  showNotification('Board synced ✓', 'success');
}

function addCard() {
  openModal('Add Card', '<div style="display:flex;flex-direction:column;gap:10px">'+
    '<input class="form-input" id="new-card-title" placeholder="Card title" autofocus>'+
    '<select class="form-select" id="new-card-col" style="width:100%"><option value="todo">To Do</option><option value="inprogress">In Progress</option><option value="done">Done</option></select>'+
    '<button class="btn-primary" onclick="submitNewCard()">Add Card</button></div>');
  setTimeout(() => document.getElementById('new-card-title')?.focus(), 100);
}

function submitNewCard() {
  const title = document.getElementById('new-card-title')?.value?.trim();
  const col = document.getElementById('new-card-col')?.value || 'todo';
  if (!title) return;
  const card = { id: Date.now().toString(), title, icon:'📝', tag:'local' };
  state.kanban.columns[col] = state.kanban.columns[col] || [];
  state.kanban.columns[col].push(card);
  renderKanban(); closeModal();
}

function formatRelativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.floor(mins/60) + 'h ago';
  return Math.floor(mins/1440) + 'd ago';
}

// ════════════════════════════════════════════════════════════════
// METRICS
// ════════════════════════════════════════════════════════════════
function updateMetricsDisplay() {
  document.getElementById('m-sessions').textContent = state.metrics.completedToday;
  const h = Math.floor(state.timer.totalFocusSeconds / 3600);
  const m = Math.floor((state.timer.totalFocusSeconds % 3600) / 60);
  document.getElementById('m-focus').textContent = h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  document.getElementById('m-streak').textContent = state.user.streak;
  const rate = state.timer.sessionNumber > 0 ? Math.round((state.metrics.completedToday / Math.max(1, state.timer.sessionNumber)) * 100) : 0;
  document.getElementById('m-completion').textContent = rate + '%';
  document.getElementById('m-hydration').textContent = state.metrics.hydration;
  document.getElementById('m-lang').textContent = state.metrics.langStreak + ' days';
}

async function updateBehaviorInsight() {
  const params = new URLSearchParams({
    focus: state.timer.totalFocusSeconds,
    sessions: state.timer.sessionNumber,
    streak: state.user.streak,
    completion: state.metrics.completedToday / Math.max(1, state.timer.sessionNumber),
    hydration: state.metrics.hydration,
    langStreak: state.metrics.langStreak,
  });
  try {
    const res = await fetch('/api/behavior/insight?' + params);
    const data = await res.json();
    document.getElementById('insight-headline').textContent = data.headline || 'Building momentum';
    document.getElementById('insight-detail').textContent = data.detail || '';
    document.getElementById('insight-rec').textContent = data.recommendation || '';
    document.getElementById('flowscore-display').textContent = data.flowScore || '—';
    const sourcesEl = document.getElementById('insight-sources');
    sourcesEl.innerHTML = (data.sources || []).map(s => '<span class="source-badge">'+s+'</span>').join('');
  } catch {}
}

function logHydration() { state.metrics.hydration++; localStorage.setItem('fs_hydration', state.metrics.hydration); updateMetricsDisplay(); showNotification('💧 Hydration logged! Keep it up!', 'success'); }
function logLanguage() { state.metrics.langStreak++; localStorage.setItem('fs_lang_streak', state.metrics.langStreak); updateMetricsDisplay(); showNotification('🌍 Language practice logged! 🔥', 'success'); }

let focusChart = null;
function initFocusChart() {
  const ctx = document.getElementById('focus-chart');
  if (!ctx || focusChart) return;
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const data = days.map((_, i) => {
    const saved = parseInt(localStorage.getItem('fs_day_' + i) || '0');
    return saved || Math.floor(Math.random() * 6);
  });
  focusChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: days, datasets: [{ label: 'Sessions', data, backgroundColor: 'rgba(168,85,247,.4)', borderColor: '#a855f7', borderRadius: 8, borderWidth: 2 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color:'#888', stepSize: 1 }, grid: { color:'rgba(168,85,247,.06)' } }, x: { ticks: { color:'#888' }, grid: { display:false } } } },
  });
}

// ════════════════════════════════════════════════════════════════
// LEARN TAB
// ════════════════════════════════════════════════════════════════
async function loadLearnCards() {
  try {
    const res = await fetch('/api/learn/cards');
    const data = await res.json();
    state.learn.cards = data.cards || [];
  } catch {
    // Fallback cards
    state.learn.cards = [
      { type:'mental_model', title:'First Principles', content:'Break problems to fundamental truths. Reason back up. Musk uses this for rockets.', emoji:'🔭', color:'#74b9ff' },
      { type:'book_rec', title:'Deep Work', content:'"The ability to focus without distraction is a superpower." — Cal Newport', emoji:'📖', color:'#6c5ce7', meta:'Cal Newport · ★★★★★' },
      { type:'did_you_know', title:'Flow State Science', content:'Csikszentmihalyi found flow increases productivity by up to 500%. FlowState is built around this.', emoji:'🌊', color:'#74b9ff' },
    ];
  }
  renderLearnCarousel();
  startLearnAutoAdvance();
}

function renderLearnCarousel() {
  const container = document.getElementById('learn-carousel');
  const nav = document.getElementById('learn-nav');
  if (!container || !state.learn.cards.length) return;

  const cards = state.learn.cards.slice(0, 12);
  container.innerHTML = cards.map((card, i) => {
    const isActive = i === state.learn.currentIdx;
    return '<div class="learn-card'+(isActive?' active':'')+'" style="background:'+getCardBg(card.color)+'">'+
      '<div style="font-size:40px;margin-bottom:12px">'+card.emoji+'</div>'+
      '<div class="learn-card-type">'+card.type.replace('_',' ')+'</div>'+
      '<div class="learn-card-title">'+card.title+'</div>'+
      '<div class="learn-card-content">'+card.content+'</div>'+
      (card.meta ? '<div class="learn-card-meta">'+card.meta+'</div>' : '')+
      (card.actionLabel ? '<button class="restore-btn" style="margin-top:8px">'+card.actionLabel+' →</button>' : '')+
      '</div>';
  }).join('');

  nav.innerHTML = '<button class="learn-nav-btn" onclick="prevLearnCard()"><i class="fas fa-chevron-left"></i></button>'+
    cards.map((_,i) => '<div class="learn-dot'+(i===state.learn.currentIdx?' active':'')+'" onclick="goLearnCard('+i+')"></div>').join('')+
    '<button class="learn-nav-btn" onclick="nextLearnCard()"><i class="fas fa-chevron-right"></i></button>';
}

function getCardBg(color) {
  // Convert hex color to gradient
  return 'linear-gradient(135deg, '+color+'22 0%, '+color+'11 100%), var(--bg-panel)';
}

function nextLearnCard() { state.learn.currentIdx = (state.learn.currentIdx + 1) % Math.min(12, state.learn.cards.length); renderLearnCarousel(); }
function prevLearnCard() { state.learn.currentIdx = (state.learn.currentIdx - 1 + Math.min(12, state.learn.cards.length)) % Math.min(12, state.learn.cards.length); renderLearnCarousel(); }
function goLearnCard(i) { state.learn.currentIdx = i; renderLearnCarousel(); }

function startLearnAutoAdvance() {
  if (state.learn.autoTimer) clearInterval(state.learn.autoTimer);
  state.learn.autoTimer = setInterval(nextLearnCard, 30000);
}

async function refreshAIInsights() {
  const el = document.getElementById('ai-insights-row');
  el.innerHTML = '<div class="metric-card" style="grid-column:1/-1;text-align:center;padding:20px"><div class="spinner"></div></div>';
  await new Promise(r => setTimeout(r, 800));
  el.innerHTML = [
    { icon:'🧠', title:'Cognitive Peak', body:'Your best focus window is typically 90 min after waking. Schedule your hardest task there.' },
    { icon:'🔁', title:'Interleaving', body:'Switching between topics mid-session boosts long-term retention by 43% vs. blocked practice.' },
    { icon:'🌊', title:'Flow Triggers', body:'Deep work requires: clear goal, immediate feedback, challenge-skill balance. Check all 3 today.' },
    { icon:'⚡', title:'Energy > Time', body:'1 hour at 80% energy beats 3 hours at 30%. Prioritize your energy, not just your schedule.' },
  ].map(c => '<div class="metric-card"><div class="metric-icon">'+c.icon+'</div><div class="metric-value" style="font-size:14px;font-weight:700">'+c.title+'</div><div class="metric-label" style="text-transform:none;font-size:12px;color:var(--text-secondary);margin-top:4px">'+c.body+'</div></div>').join('');
}

// ════════════════════════════════════════════════════════════════
// RESTORE TAB
// ════════════════════════════════════════════════════════════════
const RESTORES = [
  { mode:'breathing', title:'4-7-8 Breathing', emoji:'🫁', steps:['Inhale through nose 4 counts','Hold your breath 7 counts','Exhale through mouth 8 counts'], bg:'linear-gradient(135deg,#1a1a2e 0%,#0f3460 100%)' },
  { mode:'quote', title:'Words for the Moment', emoji:'💬', quote:'The present moment is the only time we have dominion. — Thich Nhat Hanh', bg:'linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%)' },
  { mode:'body_reset', title:'Body Reset', emoji:'🧘', steps:['Roll shoulders back 3x slowly','Tilt head side to side','Stretch arms above your head','Take 3 deep belly breaths','Set intention for next session'], bg:'linear-gradient(135deg,#134e5e 0%,#71b280 100%)' },
  { mode:'gratitude', title:'Gratitude Pulse', emoji:'💙', prompt:'What are you grateful for right now?', bg:'linear-gradient(135deg,#1a1a2e 0%,#4a0072 100%)' },
  { mode:'micro_win', title:'Celebrate Your Win', emoji:'🏆', content:'You just finished a focus session. 25 minutes of undivided attention — a rare achievement.', bg:'linear-gradient(135deg,#f7971e 0%,#ffd200 100%)' },
  { mode:'breathing', title:'Box Breathing', emoji:'📦', steps:['Inhale 4 counts','Hold 4 counts','Exhale 4 counts','Hold 4 counts'], bg:'linear-gradient(135deg,#0f2027 0%,#2c5364 100%)' },
];

function renderRestoreScene() {
  const scene = document.getElementById('restore-scene');
  if (!scene) return;
  const r = RESTORES[state.restore.currentIdx % RESTORES.length];
  scene.style.background = r.bg;
  let inner = '<div class="restore-emoji">'+r.emoji+'</div><div class="restore-title">'+r.title+'</div>';

  if (r.mode === 'breathing') {
    inner += '<div class="restore-content">Activate your parasympathetic nervous system.</div>'+
      '<div class="breath-circle" id="breath-circle" onclick="startBreathing()">Start →</div>'+
      '<div class="restore-steps">'+r.steps.map((s,i) => '<div class="restore-step"><div class="restore-step-num">'+(i+1)+'</div>'+s+'</div>').join('')+'</div>';
  } else if (r.mode === 'quote') {
    inner += '<div class="restore-content" style="font-size:17px;font-style:italic;max-width:460px">'+r.quote+'</div>';
  } else if (r.mode === 'body_reset') {
    inner += '<div class="restore-steps">'+r.steps.map((s,i) => '<div class="restore-step"><div class="restore-step-num">'+(i+1)+'</div>'+s+'</div>').join('')+'</div>';
  } else if (r.mode === 'gratitude') {
    inner += '<div class="restore-content">Name one thing genuinely worth being grateful for right now.</div>'+
      '<input class="gratitude-input" placeholder="Grateful for..." id="gratitude-input">'+
      '<button class="restore-btn" onclick="logGratitude()">💙 Log Gratitude</button>';
  } else if (r.mode === 'micro_win') {
    inner += '<div class="restore-content">'+r.content+'</div>'+
      '<button class="restore-btn" onclick="triggerCelebration(state.timer.sessionNumber)" style="background:rgba(0,0,0,.2)">🎉 Celebrate!</button>';
  }

  scene.innerHTML = inner;
}

function prevRestore() { state.restore.currentIdx = Math.max(0, state.restore.currentIdx - 1); renderRestoreScene(); }
function nextRestore() { state.restore.currentIdx = (state.restore.currentIdx + 1) % RESTORES.length; renderRestoreScene(); }

let breathAnimating = false;
function startBreathing() {
  if (breathAnimating) { breathAnimating = false; document.getElementById('breath-circle').textContent = 'Start →'; return; }
  breathAnimating = true;
  const circle = document.getElementById('breath-circle');
  const phases = [
    { text:'Inhale…', class:'expand', ms:4000 },
    { text:'Hold…', class:'', ms:7000 },
    { text:'Exhale…', class:'', ms:8000 },
  ];
  let idx = 0;
  function next() {
    if (!breathAnimating) return;
    const p = phases[idx % phases.length];
    circle.textContent = p.text;
    circle.className = 'breath-circle' + (p.class ? ' ' + p.class : '');
    idx++;
    setTimeout(next, p.ms);
  }
  next();
}

function logGratitude() {
  const val = document.getElementById('gratitude-input')?.value?.trim();
  if (!val) return;
  const log = JSON.parse(localStorage.getItem('fs_gratitude_log') || '[]');
  log.push({ text: val, ts: Date.now() });
  localStorage.setItem('fs_gratitude_log', JSON.stringify(log.slice(-50)));
  showNotification('💙 Gratitude logged. Beautiful.', 'success');
  triggerMicroCelebration();
}

function loadNotebookIframe() {
  const url = document.getElementById('notebook-url-input')?.value?.trim();
  if (!url) return;
  const container = document.getElementById('notebook-iframe-container');
  document.getElementById('notebook-iframe').src = url;
  container.style.display = 'block';
  showNotification('Notebook loading…', 'info');
}

// ════════════════════════════════════════════════════════════════
// IMAGE / VIDEO GENERATION
// ════════════════════════════════════════════════════════════════
async function generateImage() {
  const prompt = document.getElementById('image-prompt')?.value?.trim();
  if (!prompt) return;
  const btn = document.getElementById('btn-gen-img');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block"></div>';
  const results = document.getElementById('image-results');
  results.innerHTML = '<div style="text-align:center;padding:20px;grid-column:1/-1"><div class="spinner" style="margin:0 auto"></div><p style="font-size:12px;color:var(--text-muted);margin-top:8px">Generating with '+IMAGE_MODELS[state.gen.imageModel]?.name+'…</p></div>';

  try {
    const res = await fetch('/api/generate/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model: state.gen.imageModel, style: document.getElementById('image-style')?.value, size: document.getElementById('image-size')?.value }),
    });
    const data = await res.json();
    if (data.error && !data.demo) throw new Error(data.error);
    if (data.imageUrl) {
      results.innerHTML = '<div style="grid-column:1/-1">'+
        '<img class="gen-img" src="'+data.imageUrl+'" alt="'+prompt+'" onclick="openImageModal(this.src,\\''+prompt+'\\')">'+
        '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">'+data.model+' · Click to expand</div></div>';
    } else if (data.demo) {
      results.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;background:var(--bg-card);border-radius:12px;border:1px solid var(--border)">'+
        '<div style="font-size:13px;color:var(--text-muted);margin-bottom:10px">'+data.error+'</div>'+
        '<img class="gen-img" src="'+data.imageUrl+'" style="max-width:300px;margin:0 auto;display:block"></div>';
    }
    showNotification('Image generated ✓', 'success');
  } catch (err) {
    results.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px"><i class="fas fa-exclamation-triangle" style="color:var(--danger)"></i><p style="font-size:13px;color:var(--text-muted);margin-top:8px">'+err.message+'</p></div>';
  }

  btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate';
}

async function generateVideo() {
  const prompt = document.getElementById('video-prompt')?.value?.trim();
  if (!prompt) return;
  const btn = document.getElementById('btn-gen-vid');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block"></div>';
  const results = document.getElementById('video-results');
  const duration = document.getElementById('video-duration')?.value || '5';

  try {
    const res = await fetch('/api/generate/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model: state.gen.videoModel, duration: parseInt(duration) }),
    });
    const data = await res.json();
    results.innerHTML = '<div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:16px">'+
      '<div style="font-size:13px;font-weight:700;margin-bottom:6px">'+VIDEO_MODELS[state.gen.videoModel]?.name+' · '+duration+'s</div>'+
      '<div style="font-size:13px;color:var(--text-muted)">'+( data.error || data.message || 'Request queued')+'</div>'+
      (data.demo ? '<div style="font-size:11px;color:var(--warning);margin-top:8px">Demo mode: Add API key to generate real videos</div>' : '')+
      '</div>';
    if (!data.error || data.demo) showNotification('Video request sent ✓', 'success');
  } catch (err) {
    results.innerHTML = '<div style="font-size:13px;color:var(--danger)">'+err.message+'</div>';
  }

  btn.disabled = false; btn.innerHTML = '<i class="fas fa-clapperboard"></i> Generate';
}

function openImageModal(src, prompt) {
  openModal('Generated Image', '<img src="'+src+'" style="width:100%;border-radius:12px;margin-bottom:12px">'+
    '<div style="font-size:12px;color:var(--text-muted)">'+prompt+'</div>'+
    '<div style="display:flex;gap:8px;margin-top:12px">'+
    '<a href="'+src+'" download="flowstate-gen.jpg" class="btn-sm" style="text-decoration:none"><i class="fas fa-download"></i> Save</a>'+
    (FS_NOTION ? '<button class="btn-sm" onclick="closeModal()"><i class="fas fa-n"></i> Push to Notion</button>' : '')+
    '</div>');
}

// ════════════════════════════════════════════════════════════════
// TIP BUBBLES
// ════════════════════════════════════════════════════════════════
function checkTips() {
  if (!state.timer.running || state.timer.phase !== 'focus') return;
  const cooldown = Date.now() - state.tips.lastShownAt > 5 * 60 * 1000;
  if (!cooldown) return;
  const tips = [
    { emoji:'🧘', msg:'Shoulders back, chin level. Roll them twice.' },
    { emoji:'💧', msg:'Water check! A glass every 45 minutes keeps the brain sharp.' },
    { emoji:'👁️', msg:'Look 20 feet away for 20 seconds. Your eyes need it.' },
    { emoji:'⚡', msg:'Every session is a vote for the person you are becoming.' },
    { emoji:'🎯', msg:'One tab, one task. Close everything else.' },
  ];
  const tip = tips[Math.floor(Math.random() * tips.length)];
  showTipBubble(tip.emoji, 'FlowState Tip', tip.msg);
}

function showTipBubble(emoji, category, message) {
  document.querySelector('.tip-bubble')?.remove();
  state.tips.lastShownAt = Date.now();
  const el = document.createElement('div');
  el.className = 'tip-bubble';
  el.innerHTML = '<button class="tip-close" onclick="this.parentElement.remove()">✕</button>'+
    '<div class="tip-header"><span class="tip-emoji">'+emoji+'</span><span class="tip-category">'+category+'</span></div>'+
    '<div class="tip-message">'+message+'</div>';
  document.body.appendChild(el);
  setTimeout(() => el?.remove(), 12000);
}

// ════════════════════════════════════════════════════════════════
// CELEBRATIONS
// ════════════════════════════════════════════════════════════════
const CELEB_MESSAGES = [
  ['Session Complete!','One step closer to your goals.'],
  ['Flow Achieved! ⚡','You were in the zone. Rare.'],
  ['Deep Work Done! 🧠','Your future self is grateful.'],
  ['On Fire! 🔥','Four sessions = championship-level focus.'],
  ['Flow Master! 👑','You make it look effortless.'],
];

function triggerCelebration(sessionNum) {
  const idx = Math.min((sessionNum||1) - 1, CELEB_MESSAGES.length - 1);
  const [title, sub] = CELEB_MESSAGES[Math.max(0, idx)];
  const intensity = Math.min(1, 0.4 + (sessionNum||1) * 0.15);
  const overlay = document.createElement('div');
  overlay.className = 'celebration-overlay';
  overlay.innerHTML = '<div class="celebration-card"><span class="celeb-emoji">' +
    (sessionNum >= 4 ? '👑' : sessionNum >= 2 ? '⚡' : '🎉') +
    '</span><div class="celeb-title">'+title+'</div><div class="celeb-sub">'+sub+'</div></div>';
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
  launchConfetti(Math.floor(30 + (sessionNum||1) * 20), intensity);
  setTimeout(() => overlay.remove(), 4000 + (sessionNum||1) * 200);
}

function triggerMicroCelebration() {
  launchConfetti(15, 0.5);
}

function launchConfetti(count, intensity) {
  const colors = ['#a855f7','#ec4899','#3b82f6','#10b981','#f59e0b','#06b6d4','#ffd200'];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    const x = (Math.random() - 0.5) * 600 * intensity;
    const y = -(200 + Math.random() * 400 * intensity);
    el.style.cssText = 'left:50%;top:40%;background:'+colors[Math.floor(Math.random()*colors.length)]+';--tx:'+x+'px;--ty:'+y+'px;animation-duration:'+(1 + Math.random()*1.5)+'s;animation-delay:'+(Math.random()*0.5)+'s';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
}

// ════════════════════════════════════════════════════════════════
// SETTINGS + MODALS
// ════════════════════════════════════════════════════════════════
function openSettingsModal() {
  const focusMin = localStorage.getItem('fs_focus_min') || '25';
  const shortMin = localStorage.getItem('fs_short_min') || '5';
  const lang = localStorage.getItem('fs_language') || 'Japanese N5';
  openModal('Settings ⚙️', '<div style="display:flex;flex-direction:column;gap:14px">'+
    '<div><label style="font-size:12px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:6px">Focus Duration (minutes)</label><input class="form-input" id="s-focus" type="number" value="'+focusMin+'" min="1" max="120"></div>'+
    '<div><label style="font-size:12px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:6px">Short Break Duration</label><input class="form-input" id="s-short" type="number" value="'+shortMin+'" min="1" max="30"></div>'+
    '<div><label style="font-size:12px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:6px">Language Learning</label><select class="form-select" id="s-lang" style="width:100%"><option '+(lang==='Japanese N5'?'selected':'')+'>Japanese N5</option><option '+(lang==='Spanish B1'?'selected':'')+'>Spanish B1</option><option '+(lang==='Mandarin HSK3'?'selected':'')+'>Mandarin HSK3</option><option '+(lang==='French A2'?'selected':'')+'>French A2</option></select></div>'+
    '<div><label style="font-size:12px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:6px">Connections</label>'+
    (FS_USER ? '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-card);border-radius:8px;font-size:13px"><img src="'+FS_USER.picture+'" style="width:24px;height:24px;border-radius:50%"><span>'+FS_USER.name+'</span><span style="margin-left:auto;color:var(--success);font-size:11px;font-weight:700">✓ Google</span></div>' : '<button class="btn-sm" onclick="closeModal();connectGoogle()" style="width:100%;justify-content:center"><i class="fab fa-google"></i>&nbsp; Connect Google</button>')+
    (FS_NOTION ? '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-card);border-radius:8px;font-size:13px;margin-top:6px"><span>📝 '+FS_NOTION.workspace+'</span><span style="margin-left:auto;color:var(--success);font-size:11px;font-weight:700">✓ Notion</span></div>' : '<button class="btn-sm" onclick="closeModal();connectNotion()" style="width:100%;justify-content:center;margin-top:6px"><span style="font-size:14px">📝</span>&nbsp; Connect Notion</button>')+
    '</div>'+
    '<button class="btn-primary" onclick="saveSettings()" style="width:100%">Save Settings</button>'+
    '</div>');
}

function saveSettings() {
  const focusMin = document.getElementById('s-focus')?.value || '25';
  const shortMin = document.getElementById('s-short')?.value || '5';
  localStorage.setItem('fs_focus_min', focusMin);
  localStorage.setItem('fs_short_min', shortMin);
  const lang = document.getElementById('s-lang')?.value;
  if (lang) localStorage.setItem('fs_language', lang);
  resetTimer(); closeModal();
  showNotification('Settings saved ✓', 'success');
}

function openPremiumModal() {
  openModal('⭐ FlowState Premium', '<div>'+
    '<p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">Unlock the full power of AI-native productivity.</p>'+
    '<div class="tier-cards">'+
    '<div class="tier-card"><h3>Free</h3><div class="price">$0</div><ul class="tier-features"><li>Pomodoro timer</li><li>GPT-4o-mini chat</li><li>Manual Kanban</li><li>Basic metrics</li><li>Learn + Restore</li></ul></div>'+
    '<div class="tier-card highlighted"><div style="font-size:10px;font-weight:800;color:var(--accent-primary);margin-bottom:4px">MOST POPULAR</div><h3>Pro</h3><div class="price">$12<span style="font-size:14px;font-weight:400">/mo</span></div><ul class="tier-features"><li>All 7 AI models</li><li>Smart routing</li><li>Google Calendar sync</li><li>Notion Kanban</li><li>Image generation</li><li>AI Tip Bubbles</li><li>Full celebrations</li></ul><button class="btn-primary" style="width:100%;margin-top:12px">Start 14-day trial</button></div>'+
    '<div class="tier-card"><h3>Behavior</h3><div class="price">$29<span style="font-size:14px;font-weight:400">/mo</span></div><ul class="tier-features"><li>Everything in Pro</li><li>Behavior Intelligence</li><li>Health metric sync</li><li>Video generation</li><li>FlowScore AI coach</li><li>Weekly digest email</li><li>Smart session block</li></ul><button class="btn-primary" style="width:100%;margin-top:12px">Get Behavior</button></div>'+
    '</div></div>');
}

async function openCredentialsModal() {
  try {
    const res = await fetch('/api/credentials');
    const data = await res.json();
    const rows = (data.credentials || []).map(c =>
      '<tr><td style="font-weight:600">'+c.service+'</td>'+
      '<td>'+c.purpose+'</td>'+
      '<td><code>'+c.envKey.split('+')[0].trim()+'</code></td>'+
      '<td><a href="'+c.url+'" target="_blank">Get key →</a></td>'+
      '<td><span class="cred-required cred-'+c.required+'">'+c.required+'</span></td></tr>'
    ).join('');
    openModal('🔑 API Credentials Reference', '<p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Add these as Cloudflare Pages secrets: <code>wrangler pages secret put KEY_NAME --project-name flowstate-67g</code></p><div style="overflow-x:auto"><table class="credential-table"><thead><tr><th>Service</th><th>Purpose</th><th>Env Key</th><th>Get It</th><th>Priority</th></tr></thead><tbody>'+rows+'</tbody></table></div>');
  } catch {
    openModal('Credentials', '<p>Could not load credentials table.</p>');
  }
}

function openModal(title, content) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay'; overlay.id = 'modal-overlay';
  overlay.onclick = e => { if (e.target === overlay) closeModal(); };
  overlay.innerHTML = '<div class="modal-card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px"><div style="font-size:16px;font-weight:800">'+title+'</div><button onclick="closeModal()" style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer">✕</button></div>'+content+'</div>';
  document.body.appendChild(overlay);
}
function closeModal() { document.getElementById('modal-overlay')?.remove(); }

function showNotification(msg, type) {
  const colors = { success:'var(--success)', error:'var(--danger)', info:'var(--accent-primary)', warning:'var(--warning)' };
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid '+( colors[type]||'var(--border)')+';color:'+( colors[type]||'var(--text-primary)')+';padding:10px 20px;border-radius:12px;font-size:13px;font-weight:600;z-index:9999;animation:messageIn .3s ease;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.4)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ════════════════════════════════════════════════════════════════
// DEFAULT KANBAN DATA
// ════════════════════════════════════════════════════════════════
if (!FS_NOTION) {
  state.kanban.columns = {
    todo: [
      { id:'1', title:'Design system tokens', icon:'🎨', tag:'design' },
      { id:'2', title:'Write API documentation', icon:'📝', tag:'dev' },
      { id:'3', title:'User research synthesis', icon:'🔬', tag:'research' },
    ],
    inprogress: [
      { id:'4', title:'FlowState AI routing', icon:'⚡', tag:'dev' },
      { id:'5', title:'Calendar integration', icon:'📅', tag:'dev' },
    ],
    done: [
      { id:'6', title:'Project scaffolding', icon:'🏗️', tag:'dev' },
      { id:'7', title:'Color system setup', icon:'🎨', tag:'design' },
    ]
  };
}

// ════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════
init();
</script>
</body>
</html>`)
})

export default app
