/**
 * FLOWSTATE — D1 Database Helpers
 * ================================
 * All direct D1 interactions live here.
 * index.tsx calls these functions — it never writes SQL directly.
 *
 * ARCHITECTURE LAW: D1 is the source of truth.
 * Redis is the fast cache. Never trust Redis alone for billing data.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbUser {
  id: number
  email: string
  name: string
  picture: string
  provider: string
  tier: string
  stripe_customer_id: string | null
  coin_balance: number
  coin_reset_at: string | null
  onboarding_completed: number
  onboarding_data: string | null
  created_at: string
  updated_at: string
}

export interface DbSubscription {
  id: number
  user_id: number
  email: string
  stripe_subscription_id: string | null
  plan: string
  billing_interval: string | null
  status: string
  current_period_end: string | null
  cancel_at_period_end: number
}

export interface DbDesktopToken {
  id: number
  token_hash: string
  email: string
  app: string
  tier: string
  expires_at: string
  revoked: number
  last_used: string | null
}

// ─── User Helpers ─────────────────────────────────────────────────────────────

/**
 * Upsert a user on Google OAuth login.
 * Creates the row if it doesn't exist; updates name/picture if it does.
 * Returns the full user row.
 */
export async function upsertUser(
  db: D1Database,
  email: string,
  name: string,
  picture: string,
  provider: string = 'google',
): Promise<DbUser> {
  await db.prepare(`
    INSERT INTO users (email, name, picture, provider)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name       = excluded.name,
      picture    = excluded.picture,
      updated_at = datetime('now')
  `).bind(email, name, picture, provider).run()

  return db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<DbUser>() as Promise<DbUser>
}

/**
 * Get a user by email. Returns null if not found.
 */
export async function getUserByEmail(db: D1Database, email: string): Promise<DbUser | null> {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<DbUser>()
}

/**
 * Update the user's tier — called from Stripe webhook handler.
 */
export async function setUserTier(db: D1Database, email: string, tier: string): Promise<void> {
  await db.prepare(`
    UPDATE users SET tier = ?, updated_at = datetime('now') WHERE email = ?
  `).bind(tier, email).run()
}

/**
 * Set Stripe customer ID on first checkout.
 */
export async function setStripeCustomerId(
  db: D1Database,
  email: string,
  stripeCustomerId: string,
): Promise<void> {
  await db.prepare(`
    UPDATE users SET stripe_customer_id = ?, updated_at = datetime('now') WHERE email = ?
  `).bind(stripeCustomerId, email).run()
}

/**
 * Deduct coins and log to coin_ledger atomically.
 * Returns false if insufficient balance.
 */
export async function spendCoins(
  db: D1Database,
  email: string,
  action: string,
  cost: number,
  appContext: string,
): Promise<{ ok: boolean; balance: number }> {
  const user = await getUserByEmail(db, email)
  if (!user) return { ok: false, balance: 0 }
  if (user.coin_balance < cost) return { ok: false, balance: user.coin_balance }

  const newBalance = user.coin_balance - cost

  await db.batch([
    db.prepare(`UPDATE users SET coin_balance = ?, updated_at = datetime('now') WHERE email = ?`)
      .bind(newBalance, email),
    db.prepare(`
      INSERT INTO coin_ledger (user_id, email, action, cost, app_context, balance_after)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(user.id, email, action, cost, appContext, newBalance),
  ])

  return { ok: true, balance: newBalance }
}

/**
 * Refill coin balance on subscription renewal (500 coins/month for ClawFlow).
 */
export async function refillCoins(
  db: D1Database,
  email: string,
  amount: number,
  resetAt: string,
): Promise<void> {
  await db.prepare(`
    UPDATE users
    SET coin_balance = ?, coin_reset_at = ?, updated_at = datetime('now')
    WHERE email = ?
  `).bind(amount, resetAt, email).run()
}

// ─── Subscription Helpers ─────────────────────────────────────────────────────

/**
 * Upsert subscription record from Stripe webhook data.
 */
export async function upsertSubscription(
  db: D1Database,
  email: string,
  data: {
    stripeSubscriptionId: string
    stripePriceId: string
    plan: string
    billingInterval: string
    status: string
    currentPeriodStart: string
    currentPeriodEnd: string
    cancelAtPeriodEnd: boolean
  },
): Promise<void> {
  const user = await getUserByEmail(db, email)
  const userId = user?.id ?? null

  await db.prepare(`
    INSERT INTO subscriptions
      (user_id, email, stripe_subscription_id, stripe_price_id, plan, billing_interval,
       status, current_period_start, current_period_end, cancel_at_period_end, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET
      plan                  = excluded.plan,
      billing_interval      = excluded.billing_interval,
      status                = excluded.status,
      current_period_start  = excluded.current_period_start,
      current_period_end    = excluded.current_period_end,
      cancel_at_period_end  = excluded.cancel_at_period_end,
      updated_at            = datetime('now')
  `).bind(
    userId, email,
    data.stripeSubscriptionId, data.stripePriceId,
    data.plan, data.billingInterval,
    data.status,
    data.currentPeriodStart, data.currentPeriodEnd,
    data.cancelAtPeriodEnd ? 1 : 0,
  ).run()
}

/**
 * Record an immutable billing transaction.
 * stripeEventId is the idempotency key — duplicate events are silently ignored.
 */
export async function recordTransaction(
  db: D1Database,
  data: {
    email: string
    stripeEventId: string
    stripeInvoiceId?: string
    amountCents: number
    currency: string
    type: string
    plan?: string
    tokenPackSize?: number
    status: string
  },
): Promise<void> {
  const user = await getUserByEmail(db, data.email)

  await db.prepare(`
    INSERT OR IGNORE INTO transactions
      (user_id, email, stripe_event_id, stripe_invoice_id, amount_cents, currency,
       type, plan, token_pack_size, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user?.id ?? null, data.email,
    data.stripeEventId, data.stripeInvoiceId ?? null,
    data.amountCents, data.currency,
    data.type, data.plan ?? null, data.tokenPackSize ?? null,
    data.status,
  ).run()
}

// ─── Desktop Token Helpers ────────────────────────────────────────────────────

/**
 * Issue a new desktop token.
 * token is the RAW random token string — we hash it before storing.
 */
export async function issueDesktopToken(
  db: D1Database,
  email: string,
  app: '264pro' | 'fs_audio',
  rawToken: string,
  tier: string,
): Promise<void> {
  const tokenHash = await sha256(rawToken)
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()

  await db.prepare(`
    INSERT INTO desktop_tokens (token_hash, email, app, tier, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token_hash) DO NOTHING
  `).bind(tokenHash, email, app, tier, expiresAt).run()
}

/**
 * Verify a desktop token. Returns user info or null if invalid/expired/revoked.
 */
export async function verifyDesktopToken(
  db: D1Database,
  rawToken: string,
): Promise<{ email: string; tier: string; app: string } | null> {
  const tokenHash = await sha256(rawToken)

  const row = await db.prepare(`
    SELECT dt.email, dt.app, dt.revoked, dt.expires_at, u.tier
    FROM desktop_tokens dt
    LEFT JOIN users u ON u.email = dt.email
    WHERE dt.token_hash = ?
  `).bind(tokenHash).first<{ email: string; app: string; revoked: number; expires_at: string; tier: string }>()

  if (!row) return null
  if (row.revoked) return null
  if (new Date(row.expires_at) < new Date()) return null

  // Update last_used timestamp (fire and forget)
  db.prepare(`UPDATE desktop_tokens SET last_used = datetime('now') WHERE token_hash = ?`)
    .bind(tokenHash).run().catch(() => {})

  return { email: row.email, tier: row.tier ?? 'free', app: row.app }
}

/**
 * Revoke all desktop tokens for a user+app combo.
 * Called when subscription is cancelled.
 */
export async function revokeDesktopTokens(
  db: D1Database,
  email: string,
  app?: string,
): Promise<void> {
  if (app) {
    await db.prepare(`UPDATE desktop_tokens SET revoked = 1 WHERE email = ? AND app = ?`)
      .bind(email, app).run()
  } else {
    await db.prepare(`UPDATE desktop_tokens SET revoked = 1 WHERE email = ?`)
      .bind(email).run()
  }
}

// ─── 264 Pro Project Helpers ──────────────────────────────────────────────────

export async function upsert264Project(
  db: D1Database,
  email: string,
  data: {
    r2Key: string
    name: string
    durationSecs?: number
    resolution?: string
    fps?: number
    sizeBytes?: number
    thumbnailR2Key?: string
    version?: string
  },
): Promise<void> {
  const user = await getUserByEmail(db, email)
  if (!user) return

  await db.prepare(`
    INSERT INTO projects_264pro
      (user_id, email, name, r2_key, duration_secs, resolution, fps, size_bytes, thumbnail_r2_key, version, last_opened)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(r2_key) DO UPDATE SET
      name             = excluded.name,
      duration_secs    = excluded.duration_secs,
      resolution       = excluded.resolution,
      fps              = excluded.fps,
      size_bytes       = excluded.size_bytes,
      thumbnail_r2_key = excluded.thumbnail_r2_key,
      version          = excluded.version,
      last_opened      = datetime('now'),
      updated_at       = datetime('now')
  `).bind(
    user.id, email, data.name, data.r2Key,
    data.durationSecs ?? null, data.resolution ?? null,
    data.fps ?? null, data.sizeBytes ?? null,
    data.thumbnailR2Key ?? null, data.version ?? null,
  ).run()
}

export async function list264Projects(
  db: D1Database,
  email: string,
): Promise<any[]> {
  const result = await db.prepare(`
    SELECT id, name, r2_key, duration_secs, resolution, fps, size_bytes,
           thumbnail_r2_key, last_opened, version, created_at, updated_at
    FROM projects_264pro
    WHERE email = ?
    ORDER BY last_opened DESC
    LIMIT 50
  `).bind(email).all()
  return result.results ?? []
}

export async function delete264Project(
  db: D1Database,
  email: string,
  r2Key: string,
): Promise<void> {
  await db.prepare(`DELETE FROM projects_264pro WHERE email = ? AND r2_key = ?`)
    .bind(email, r2Key).run()
}

// ─── FlowState Audio Project Helpers ─────────────────────────────────────────

export async function upsertAudioProject(
  db: D1Database,
  email: string,
  data: {
    r2Key: string
    name: string
    bpm?: number
    key?: string
    trackCount?: number
    durationSecs?: number
    sizeBytes?: number
    version?: string
  },
): Promise<void> {
  const user = await getUserByEmail(db, email)
  if (!user) return

  await db.prepare(`
    INSERT INTO projects_audio
      (user_id, email, name, r2_key, bpm, key, track_count, duration_secs, size_bytes, version, last_opened)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(r2_key) DO UPDATE SET
      name          = excluded.name,
      bpm           = excluded.bpm,
      key           = excluded.key,
      track_count   = excluded.track_count,
      duration_secs = excluded.duration_secs,
      size_bytes    = excluded.size_bytes,
      version       = excluded.version,
      last_opened   = datetime('now'),
      updated_at    = datetime('now')
  `).bind(
    user.id, email, data.name, data.r2Key,
    data.bpm ?? null, data.key ?? null,
    data.trackCount ?? null, data.durationSecs ?? null,
    data.sizeBytes ?? null, data.version ?? null,
  ).run()
}

export async function listAudioProjects(
  db: D1Database,
  email: string,
): Promise<any[]> {
  const result = await db.prepare(`
    SELECT id, name, r2_key, bpm, key, track_count, duration_secs,
           size_bytes, last_opened, version, created_at, updated_at
    FROM projects_audio
    WHERE email = ?
    ORDER BY last_opened DESC
    LIMIT 50
  `).bind(email).all()
  return result.results ?? []
}

export async function deleteAudioProject(
  db: D1Database,
  email: string,
  r2Key: string,
): Promise<void> {
  await db.prepare(`DELETE FROM projects_audio WHERE email = ? AND r2_key = ?`)
    .bind(email, r2Key).run()
}

// ─── AI Output Helpers (shared pattern for both apps) ────────────────────────

export async function recordAiOutput264(
  db: D1Database,
  email: string,
  data: {
    projectR2Key?: string
    tool: string
    r2Key: string
    sourceUrl?: string
    sizeBytes?: number
    durationSecs?: number
    params?: object
    coinsSpent: number
  },
): Promise<void> {
  const user = await getUserByEmail(db, email)
  if (!user) return

  let projectId: number | null = null
  if (data.projectR2Key) {
    const proj = await db.prepare(`SELECT id FROM projects_264pro WHERE r2_key = ? AND email = ?`)
      .bind(data.projectR2Key, email).first<{ id: number }>()
    projectId = proj?.id ?? null
  }

  await db.prepare(`
    INSERT INTO ai_outputs_264pro
      (user_id, email, project_id, tool, r2_key, source_url, size_bytes, duration_secs, params, coins_spent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id, email, projectId,
    data.tool, data.r2Key, data.sourceUrl ?? null,
    data.sizeBytes ?? null, data.durationSecs ?? null,
    data.params ? JSON.stringify(data.params) : null,
    data.coinsSpent,
  ).run()
}

export async function recordAiOutputAudio(
  db: D1Database,
  email: string,
  data: {
    projectR2Key?: string
    tool: string
    r2Key: string
    fileName?: string
    sourceUrl?: string
    sizeBytes?: number
    durationSecs?: number
    params?: object
    coinsSpent: number
  },
): Promise<void> {
  const user = await getUserByEmail(db, email)
  if (!user) return

  let projectId: number | null = null
  if (data.projectR2Key) {
    const proj = await db.prepare(`SELECT id FROM projects_audio WHERE r2_key = ? AND email = ?`)
      .bind(data.projectR2Key, email).first<{ id: number }>()
    projectId = proj?.id ?? null
  }

  await db.prepare(`
    INSERT INTO ai_outputs_audio
      (user_id, email, project_id, tool, r2_key, source_url, file_name, size_bytes, duration_secs, params, coins_spent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id, email, projectId,
    data.tool, data.r2Key, data.sourceUrl ?? null, data.fileName ?? null,
    data.sizeBytes ?? null, data.durationSecs ?? null,
    data.params ? JSON.stringify(data.params) : null,
    data.coinsSpent,
  ).run()
}

export async function recordAudioExport(
  db: D1Database,
  email: string,
  data: {
    projectR2Key?: string
    format: string
    bitDepth?: number
    sampleRate?: number
    isStems: boolean
    r2Key: string
    sizeBytes?: number
    durationSecs?: number
    lufs?: number
  },
): Promise<void> {
  const user = await getUserByEmail(db, email)
  if (!user) return

  let projectId: number | null = null
  if (data.projectR2Key) {
    const proj = await db.prepare(`SELECT id FROM projects_audio WHERE r2_key = ? AND email = ?`)
      .bind(data.projectR2Key, email).first<{ id: number }>()
    projectId = proj?.id ?? null
  }

  await db.prepare(`
    INSERT INTO exports_audio
      (user_id, email, project_id, format, bit_depth, sample_rate, is_stems, r2_key, size_bytes, duration_secs, lufs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id, email, projectId,
    data.format, data.bitDepth ?? null, data.sampleRate ?? null,
    data.isStems ? 1 : 0, data.r2Key,
    data.sizeBytes ?? null, data.durationSecs ?? null, data.lufs ?? null,
  ).run()
}

// ─── Tasks Helpers ────────────────────────────────────────────────────────────

export async function getUserTasks(db: D1Database, email: string): Promise<any[]> {
  const result = await db.prepare(`
    SELECT id, title, status, priority, tags, position, created_at, updated_at
    FROM tasks WHERE email = ? ORDER BY status, position ASC
  `).bind(email).all()
  return result.results ?? []
}

export async function upsertTask(
  db: D1Database,
  email: string,
  taskId: number | null,
  data: { title: string; status: string; priority?: string; tags?: string[]; position?: number },
): Promise<number> {
  const user = await getUserByEmail(db, email)
  if (!user) throw new Error('User not found')

  if (taskId) {
    await db.prepare(`
      UPDATE tasks SET title=?, status=?, priority=?, tags=?, position=?, updated_at=datetime('now')
      WHERE id=? AND email=?
    `).bind(
      data.title, data.status, data.priority ?? null,
      data.tags ? JSON.stringify(data.tags) : null,
      data.position ?? 0, taskId, email,
    ).run()
    return taskId
  } else {
    const result = await db.prepare(`
      INSERT INTO tasks (user_id, email, title, status, priority, tags, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user.id, email, data.title, data.status,
      data.priority ?? null,
      data.tags ? JSON.stringify(data.tags) : null,
      data.position ?? 0,
    ).run()
    return result.meta.last_row_id as number
  }
}

export async function deleteTask(db: D1Database, email: string, taskId: number): Promise<void> {
  await db.prepare(`DELETE FROM tasks WHERE id = ? AND email = ?`).bind(taskId, email).run()
}

// ─── Session History Helpers ──────────────────────────────────────────────────

export async function recordSession(
  db: D1Database,
  email: string,
  data: {
    phase: string
    durationMins: number
    completed: boolean
    context?: string
    focusScore?: number
  },
): Promise<void> {
  const user = await getUserByEmail(db, email)
  if (!user) return

  const sessionDate = new Date().toISOString().slice(0, 10)
  await db.prepare(`
    INSERT INTO sessions (user_id, email, phase, duration_mins, completed, context, focus_score, session_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    user.id, email, data.phase, data.durationMins,
    data.completed ? 1 : 0, data.context ?? null,
    data.focusScore ?? null, sessionDate,
  ).run()
}

export async function getSessionStats(
  db: D1Database,
  email: string,
  days: number = 30,
): Promise<any> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const [totals, streak] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        SUM(duration_mins) as total_focus_mins,
        AVG(focus_score) as avg_focus_score,
        SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) as completed_sessions
      FROM sessions WHERE email = ? AND session_date >= ?
    `).bind(email, since).first(),
    db.prepare(`
      SELECT COUNT(DISTINCT session_date) as streak_days
      FROM sessions
      WHERE email = ? AND session_date >= ? AND completed = 1
    `).bind(email, since).first(),
  ])

  return { ...totals, ...(streak as any) }
}

// ─── R2 Helpers ──────────────────────────────────────────────────────────────

/**
 * Generate a signed R2 download URL for a given key.
 * Since R2 doesn't natively support presigned URLs in Workers yet,
 * we return a proxied URL through our own /api/r2/download endpoint
 * authenticated by the user's session token.
 */
export function makeR2DownloadUrl(baseUrl: string, r2Key: string): string {
  return `${baseUrl}/api/r2/download?key=${encodeURIComponent(r2Key)}`
}

/**
 * Build R2 object keys with consistent namespacing.
 */
export const R2Keys = {
  project264: (email: string, uuid: string) =>
    `264pro/${encodeEmail(email)}/projects/${uuid}.264proj`,

  thumbnail264: (email: string, uuid: string) =>
    `264pro/${encodeEmail(email)}/thumbnails/${uuid}.webp`,

  aiOutput264: (email: string, tool: string, uuid: string, ext = 'mp4') =>
    `264pro/${encodeEmail(email)}/ai-outputs/${tool}/${uuid}.${ext}`,

  projectAudio: (email: string, uuid: string) =>
    `audio/${encodeEmail(email)}/projects/${uuid}.fsa`,

  aiOutputAudio: (email: string, tool: string, uuid: string, ext = 'wav') =>
    `audio/${encodeEmail(email)}/ai-outputs/${tool}/${uuid}.${ext}`,

  exportAudio: (email: string, uuid: string, format = 'wav') =>
    `audio/${encodeEmail(email)}/exports/${uuid}.${format}`,
}

function encodeEmail(email: string): string {
  // Safe directory segment from email — replace @ and . to avoid path issues
  return email.replace('@', '_at_').replace(/\./g, '_')
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateToken(bytes = 32): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}
