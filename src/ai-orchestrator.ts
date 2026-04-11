/**
 * ai-orchestrator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Global AI Cost Orchestration Layer
 * Sits beneath ALL AI-powered features: FlowState hub, FS Audio, 264 Pro.
 *
 * Principles:
 *  - Pro users  → quality NEVER degrades. Speed may slow at extreme volume.
 *  - Free users → quality degrades gracefully. Flow never breaks.
 *  - NEVER expose limits. NEVER say "downgraded". ALWAYS maintain experience.
 *  - One Redis pipeline call per request. No extra round-trips.
 */

// ─── Tool config ──────────────────────────────────────────────────────────────

export type TaskType   = 'text' | 'image' | 'video' | 'audio'
export type Priority   = 'realtime' | 'queued'
export type UsageLevel = 'low' | 'medium' | 'high'

export interface AIToolConfig {
  sensitive: boolean          // true = NEVER downgrade regardless of usage
  taskType: TaskType
  costUnits: number           // compute units consumed per request
  fallbackChain?: string[]    // ordered list of fallback model IDs (non-sensitive only)
  qualityLevels?: {           // optional quality reduction steps (non-sensitive only)
    full:    Record<string, any>
    medium?: Record<string, any>
    draft?:  Record<string, any>
  }
}

/**
 * Central tool registry — add any new tool here, orchestration is automatic.
 *
 * costUnits scale:
 *   text chat          ≈  1   unit
 *   image gen (fast)   ≈  10  units
 *   image gen (pro)    ≈  25  units
 *   video gen (short)  ≈  50  units
 *   video gen (long)   ≈  150 units
 *   audio gen          ≈  5   units
 */
export const AI_TOOL_CONFIG: Record<string, AIToolConfig> = {
  // ── Text / Chat ────────────────────────────────────────────────────────────
  chat: {
    sensitive: true,   // model is user-selected or intent-routed — never swap
    taskType: 'text',
    costUnits: 1,
  },

  // ── Image generation ───────────────────────────────────────────────────────
  // Sensitive models (user explicitly chose them)
  flux_pro:    { sensitive: true,  taskType: 'image', costUnits: 25 },
  imagen3:     { sensitive: true,  taskType: 'image', costUnits: 25 },
  imagen4:     { sensitive: true,  taskType: 'image', costUnits: 30 },
  ideogram2:   { sensitive: true,  taskType: 'image', costUnits: 25 },
  recraft:     { sensitive: true,  taskType: 'image', costUnits: 25 },
  runway_img:  { sensitive: true,  taskType: 'image', costUnits: 30 },

  // Non-sensitive — can fall back (flux_dev → flux_schnell → sd35_medium)
  flux_dev:    {
    sensitive: false,
    taskType: 'image',
    costUnits: 15,
    fallbackChain: ['flux_schnell', 'sd35_medium'],
    qualityLevels: {
      full:   { num_inference_steps: 28, output_quality: 90 },
      medium: { num_inference_steps: 20, output_quality: 80 },
      draft:  { num_inference_steps: 12, output_quality: 70 },
    },
  },
  flux_schnell: {
    sensitive: false,
    taskType: 'image',
    costUnits: 5,
    fallbackChain: ['sd35_medium'],
    qualityLevels: {
      full:   { num_inference_steps: 4, output_quality: 90 },
      medium: { num_inference_steps: 4, output_quality: 80 },
      draft:  { num_inference_steps: 4, output_quality: 65 },
    },
  },
  sd35:        { sensitive: false, taskType: 'image', costUnits: 15, fallbackChain: ['sd35_medium', 'flux_schnell'] },
  sd35_medium: { sensitive: false, taskType: 'image', costUnits: 8,  fallbackChain: ['flux_schnell'] },
  seedream:    { sensitive: false, taskType: 'image', costUnits: 10, fallbackChain: ['flux_schnell'] },

  // NanoBanana — the primary reference case
  nano_banana_2k: {
    sensitive: false,
    taskType: 'image',
    costUnits: 20,
    fallbackChain: ['flux_schnell', 'sd35_medium'],   // invisible to user
    qualityLevels: {
      full:   { image_size: '1024x1024', num_inference_steps: 28 },
      medium: { image_size: '1024x1024', num_inference_steps: 20 },
      draft:  { image_size: '768x768',   num_inference_steps: 14 },
    },
  },
  nano_banana_4k: {
    sensitive: true,   // user explicitly requested 4K — never downscale
    taskType: 'image',
    costUnits: 50,
  },

  // ── Video generation — ALL sensitive (user selects resolution/model) ────────
  seedance_t2v:   { sensitive: true, taskType: 'video', costUnits: 80 },
  seedance_i2v:   { sensitive: true, taskType: 'video', costUnits: 80 },
  higgsfield_t2v: { sensitive: true, taskType: 'video', costUnits: 100 },
  higgsfield_i2v: { sensitive: true, taskType: 'video', costUnits: 100 },
  wan_t2v:        { sensitive: true, taskType: 'video', costUnits: 60 },
  wan_i2v:        { sensitive: true, taskType: 'video', costUnits: 60 },
  veo2:           { sensitive: true, taskType: 'video', costUnits: 120 },
  veo3:           { sensitive: true, taskType: 'video', costUnits: 150 },
  kling26:        { sensitive: true, taskType: 'video', costUnits: 90 },
  kling16:        { sensitive: true, taskType: 'video', costUnits: 70 },
  minimax:        { sensitive: true, taskType: 'video', costUnits: 60 },
  minimax_live:   { sensitive: true, taskType: 'video', costUnits: 60 },
  hunyuan:        { sensitive: true, taskType: 'video', costUnits: 80 },
  ltx:            { sensitive: true, taskType: 'video', costUnits: 50 },

  // ── Audio generation ───────────────────────────────────────────────────────
  generate_track:  { sensitive: false, taskType: 'audio', costUnits: 5, fallbackChain: ['generate_melody'] },
  generate_melody: { sensitive: false, taskType: 'audio', costUnits: 4 },
  generate_beat:   { sensitive: false, taskType: 'audio', costUnits: 3 },
  separate_stems:  { sensitive: true,  taskType: 'audio', costUnits: 10 },
  tts:             { sensitive: true,  taskType: 'audio', costUnits: 2 },
  ai_master:       { sensitive: false, taskType: 'audio', costUnits: 8 },
  denoise:         { sensitive: false, taskType: 'audio', costUnits: 6 },
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

// Free tier: compute units per day before degradation kicks in
const FREE_FULL_QUALITY_THRESHOLD  = 100   // below → full quality
const FREE_MEDIUM_QUALITY_THRESHOLD = 200  // below → medium quality, above → draft + fallback

// Free tier: velocity (requests per minute) before queuing
const FREE_VELOCITY_LIMIT  = 6
// Pro tier: velocity before queuing (quality preserved, speed slows)
const PRO_VELOCITY_LIMIT   = 20

// Pro daily compute budget (extremely high — effectively unlimited for real usage)
// This only kicks in for genuine bad actors (bots), not real creative sessions
const PRO_DAILY_COMPUTE_HARD_STOP = 50_000

// ─── Execution plan ───────────────────────────────────────────────────────────

export interface ExecutionPlan {
  // What to actually run
  resolvedModel: string          // may differ from requested if fallback applied
  qualityParams: Record<string, any>  // override params to inject into the API call

  // How to run it
  priority: Priority             // realtime | queued
  shouldQueue: boolean           // convenience boolean

  // Cost tracking
  costUnits: number              // units this request will consume

  // Internal signals (never expose to user)
  degraded: boolean              // true if fallback or quality reduction applied
  degradeReason: 'none' | 'usage_high' | 'velocity' | 'free_limit'

  // Gate: hard block (bot/abuse only)
  blocked: boolean
  blockResponse?: { error: string; code: string; status: number }
}

// ─── Redis helpers (re-exported for use in index.tsx) ─────────────────────────

export async function orchestratorRedisPipeline(
  url: string, token: string, commands: any[][]
): Promise<any[]> {
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

// ─── Core function ────────────────────────────────────────────────────────────

export interface OrchestratorInput {
  userId: string
  tool: string           // key from AI_TOOL_CONFIG
  requestedModel: string // what the user/system asked for
  isPro: boolean         // resolved from tier_email Redis key
  redisUrl: string
  redisToken: string
}

export async function resolveAIExecution(input: OrchestratorInput): Promise<ExecutionPlan> {
  const { userId, tool, requestedModel, isPro, redisUrl, redisToken } = input

  const config = AI_TOOL_CONFIG[tool] ?? AI_TOOL_CONFIG[requestedModel] ?? {
    sensitive: true, taskType: 'text' as TaskType, costUnits: 1,
  }

  const date   = new Date().toISOString().slice(0, 10)
  const minute = Math.floor(Date.now() / 60000)
  const computeKey  = `compute_units:${userId}:${date}`
  const velKey      = `ai_velocity:${userId}:${minute}`
  const tierEmailKey = `tier_email:${userId}`
  const tierKey      = `tier:${userId}`

  // ── Single Redis pipeline — read state + increment atomically ──────────────
  const results = await orchestratorRedisPipeline(redisUrl, redisToken, [
    ['GET',    tierEmailKey],
    ['GET',    tierKey],
    ['GET',    computeKey],
    ['GET',    velKey],
    ['INCR',   velKey],
    ['EXPIRE', velKey, 90],
    ['INCRBY', computeKey, config.costUnits],
    ['EXPIRE', computeKey, 86400],
  ])

  const tierEmail   = results[0] as string | null
  const tierSession = results[1] as string | null
  const tier        = tierEmail || tierSession || 'free'
  const resolvedPro = isPro || tier === 'pro' || tier === 'team' ||
    ['personal_pro', 'team_starter', 'team_growth', 'enterprise'].includes(tier)

  const computeUsed = parseInt(results[2] as string || '0')
  const velocity    = parseInt(results[3] as string || '0')

  // ── Determine usage level ──────────────────────────────────────────────────
  let usageLevel: UsageLevel = 'low'
  if (!resolvedPro) {
    if (computeUsed >= FREE_MEDIUM_QUALITY_THRESHOLD) usageLevel = 'high'
    else if (computeUsed >= FREE_FULL_QUALITY_THRESHOLD) usageLevel = 'medium'
  }

  // ── Velocity check — affects priority (speed), never quality for Pro ───────
  const velocityExceeded = velocity >= (resolvedPro ? PRO_VELOCITY_LIMIT : FREE_VELOCITY_LIMIT)

  // ── Hard abuse block — bots only (Pro: extreme compute, Free: velocity spam) ─
  if (!resolvedPro && velocity >= FREE_VELOCITY_LIMIT * 3) {
    return {
      resolvedModel: requestedModel,
      qualityParams: {},
      priority: 'queued',
      shouldQueue: true,
      costUnits: config.costUnits,
      degraded: false,
      degradeReason: 'velocity',
      blocked: true,
      blockResponse: {
        error: 'Too many requests — please slow down.',
        code: 'VELOCITY_EXCEEDED',
        status: 429,
      },
    }
  }

  if (resolvedPro && computeUsed > PRO_DAILY_COMPUTE_HARD_STOP) {
    return {
      resolvedModel: requestedModel,
      qualityParams: {},
      priority: 'queued',
      shouldQueue: true,
      costUnits: config.costUnits,
      degraded: false,
      degradeReason: 'usage_high',
      blocked: true,
      blockResponse: {
        error: 'Daily generation limit reached. Resets at midnight UTC.',
        code: 'DAILY_LIMIT',
        status: 429,
      },
    }
  }

  // ── Pro path: full quality always, only speed may vary ────────────────────
  if (resolvedPro || config.sensitive) {
    return {
      resolvedModel: requestedModel,
      qualityParams: config.qualityLevels?.full ?? {},
      priority: velocityExceeded ? 'queued' : 'realtime',
      shouldQueue: velocityExceeded,
      costUnits: config.costUnits,
      degraded: false,
      degradeReason: 'none',
      blocked: false,
    }
  }

  // ── Free path: degrade quality + model by usage level ────────────────────
  let resolvedModel  = requestedModel
  let qualityParams  = config.qualityLevels?.full ?? {}
  let degraded       = false
  let degradeReason: ExecutionPlan['degradeReason'] = 'none'

  if (usageLevel === 'medium') {
    qualityParams = config.qualityLevels?.medium ?? qualityParams
    degraded = true
    degradeReason = 'usage_high'
  }

  if (usageLevel === 'high') {
    // Step 1: fallback model
    if (config.fallbackChain && config.fallbackChain.length > 0) {
      resolvedModel = config.fallbackChain[0]
    }
    // Step 2: draft quality
    qualityParams = config.qualityLevels?.draft ?? config.qualityLevels?.medium ?? qualityParams
    degraded = true
    degradeReason = 'free_limit'
  }

  return {
    resolvedModel,
    qualityParams,
    priority: (velocityExceeded || usageLevel === 'high') ? 'queued' : 'realtime',
    shouldQueue: velocityExceeded || usageLevel === 'high',
    costUnits: config.costUnits,
    degraded,
    degradeReason,
    blocked: false,
  }
}

// ─── Tier resolution helper ───────────────────────────────────────────────────
// Quick sync check from auth object — used when tier is already resolved
export function isTierPro(tier: string | null | undefined): boolean {
  if (!tier) return false
  return ['pro', 'team', 'personal_pro', 'team_starter', 'team_growth', 'enterprise'].includes(tier)
}

// ─── Response header helpers (internal signals, never user-visible) ───────────
export function applyOrchestrationHeaders(
  c: any,
  plan: ExecutionPlan,
): void {
  c.header('X-AI-Model',    plan.resolvedModel)
  c.header('X-AI-Priority', plan.priority)
  c.header('X-AI-Quality',  plan.degraded ? 'optimized' : 'premium')
  // Intentionally vague — no "degraded" or "fallback" language in headers
}
