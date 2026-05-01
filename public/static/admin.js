// FlowState Admin Dashboard — Client JS
// ═══════════════════════════════════════════════════════

let allUsers = []

// ── Navigation ──────────────────────────────────────────
function showPage(id, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
  document.getElementById('page-' + id)?.classList.add('active')
  btn?.classList.add('active')
  // Lazy-load data per page
  if (id === 'overview')  loadOverview()
  if (id === 'users')     loadUsers()
  if (id === 'revenue')   loadRevenue()
  if (id === 'credits')   loadCredits()
  if (id === 'email')     loadEmailStats()
  if (id === 'system')    loadSystemHealth()
  if (id === 'manage')    {}  // forms, no auto-load
}

// ── Helpers ──────────────────────────────────────────────
const fmt = (n) => typeof n === 'number' ? n.toLocaleString() : (n || '—')
const fmtUSD = (n) => typeof n === 'number' ? '\$' + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'
const fmtDate = (s) => { if(!s) return '—'; const d=new Date(s); return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) }
const fmtAgo = (s) => { if(!s) return '—'; const ms=Date.now()-new Date(s).getTime(); const m=Math.floor(ms/60000); if(m<60) return m+'m ago'; const h=Math.floor(m/60); if(h<24) return h+'h ago'; return Math.floor(h/24)+'d ago' }

function tierBadge(tier) {
  const t = (tier||'free').toLowerCase().replace(/ /g,'_')
  const label = t === 'personal_pro' ? 'Pro' : t === 'team_starter' ? 'Team' : t === 'team_growth' ? 'Team+' : t.charAt(0).toUpperCase()+t.slice(1)
  return `<span class="badge badge-${t}">${label}</span>`
}
function providerBadge(p) {
  const icons = { google:'G', magic_link:'✉️', email:'✉️' }
  return `<span class="badge badge-${p||'google'}">${icons[p]||'?'} ${p||'google'}</span>`
}

function showAlert(el, type, msg) {
  if (typeof el === 'string') el = document.getElementById(el)
  if (!el) return
  el.className = 'alert ' + type
  el.innerHTML = msg
}

// ── OVERVIEW ────────────────────────────────────────────
async function loadOverview() {
  try {
    const [statsRes, revenueRes, mlRes] = await Promise.all([
      fetch('/api/admin/stats', {credentials:'include'}).then(r=>r.json()).catch(()=>({})),
      fetch('/api/billing/revenue?months=3', {credentials:'include'}).then(r=>r.json()).catch(()=>({})),
      fetch('/api/admin/email-stats', {credentials:'include'}).then(r=>r.json()).catch(()=>({})),
    ])

    const s = (statsRes?.error ? {} : statsRes) || {}
    document.getElementById('m-total-users').textContent  = fmt(s.totalUsers)
    document.getElementById('m-new-users').textContent    = fmt(s.newUsersLast7Days)
    document.getElementById('m-paid-users').textContent   = fmt(s.paidUsers)
    document.getElementById('m-credits-month').textContent = fmtK(s.totalCreditsUsedMonth)
    document.getElementById('m-active-today').textContent = fmt(s.activeToday)
    document.getElementById('m-sessions-today').textContent = fmt(s.sessionsToday)
    document.getElementById('m-emails-sent').textContent  = fmt(mlRes.sentMonth || 0)

    // MRR estimate from revenue
    const rev = revenueRes?.months || []
    const latest = rev[0]
    document.getElementById('m-mrr').textContent = latest?.gross ? fmtUSD(latest.gross) : '—'

    // Tier breakdown
    renderTierBreakdown(s.tierBreakdown || {}, s.totalUsers || 1)

    // Provider breakdown
    renderProviderBreakdown(s.providerBreakdown || {})

    // Recent signups
    renderRecentSignups(s.recentSignups || [])

    // Top credit users
    renderTopCreditUsers(s.topCreditUsers || [])

  } catch(e) {
    console.error('Overview load error:', e)
    // Show error state in cards instead of leaving 'Loading...'
    const errMsg = '<div style="color:var(--red);font-size:12px;padding:8px 0">⚠ Failed to load — ' + (e.message||'network error') + '</div>'
    ;['tier-breakdown','provider-breakdown','recent-signups','top-credit-users'].forEach(id => {
      const el = document.getElementById(id)
      if (el && el.innerHTML.includes('Loading')) el.innerHTML = errMsg
    })
    ;['m-total-users','m-new-users','m-paid-users','m-credits-month','m-active-today','m-sessions-today','m-emails-sent','m-mrr'].forEach(id => {
      const el = document.getElementById(id)
      if (el && el.textContent === '—') el.textContent = 'err'
    })
  }
}

function fmtK(n) { if (!n && n!==0) return '—'; if (n>=1000000) return (n/1000000).toFixed(1)+'M'; if (n>=1000) return (n/1000).toFixed(1)+'K'; return String(n) }

function renderTierBreakdown(tiers, total) {
  const el = document.getElementById('tier-breakdown')
  const colors = { free:'#9ca3af', pro:'#a855f7', team:'#3b82f6', enterprise:'#f59e0b', personal_pro:'#a855f7', clawflow:'#ec4899', team_starter:'#3b82f6', team_growth:'#60a5fa' }
  el.innerHTML = Object.entries(tiers).sort((a,b)=>b[1]-a[1]).map(([tier,count])=>{
    const pct = Math.round((count/total)*100)
    const color = colors[tier] || '#6b7280'
    return `<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px">
        <span>${tierBadge(tier)}</span>
        <span style="color:var(--text2);font-weight:600">${fmt(count)} (${pct}%)</span>
      </div>
      <div class="credit-bar-wrap"><div class="credit-bar" style="width:${pct}%;background:${color}40;border-right:2px solid ${color}"></div></div>
    </div>`
  }).join('') || '<div style="color:var(--text3)">No data</div>'
}

function renderProviderBreakdown(providers) {
  const el = document.getElementById('provider-breakdown')
  const icons = { google:'🔵', magic_link:'✉️', email:'✉️' }
  const total = Object.values(providers).reduce((a,b)=>a+(b||0),0) || 1
  el.innerHTML = Object.entries(providers).sort((a,b)=>b[1]-a[1]).map(([prov,count])=>{
    const pct = Math.round(((count||0)/total)*100)
    return `<div class="health-row">
      <span style="font-size:13px">${icons[prov]||'?'} ${prov||'unknown'}</span>
      <span style="font-weight:700;color:var(--text)">${fmt(count)} <span style="color:var(--text3);font-weight:400;font-size:11px">(${pct}%)</span></span>
    </div>`
  }).join('') || '<div style="color:var(--text3)">No data</div>'
}

function renderRecentSignups(users) {
  const el = document.getElementById('recent-signups')
  if (!users.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px">No recent signups</div>'; return }
  el.innerHTML = users.slice(0,6).map(u => `
    <div class="user-row-item">
      <div class="user-avatar">${(u.name||u.email||'?')[0].toUpperCase()}</div>
      <div class="user-info">
        <div class="user-name">${u.name || '(no name)'}</div>
        <div class="user-email-small">${u.email}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        ${tierBadge(u.tier)}
        <div class="date" style="margin-top:3px">${fmtAgo(u.created_at)}</div>
      </div>
    </div>
  `).join('')
}

function renderTopCreditUsers(users) {
  const el = document.getElementById('top-credit-users')
  if (!users.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px">No credit usage data</div>'; return }
  const max = users[0]?.credits || 1
  el.innerHTML = users.slice(0,6).map((u,i) => `
    <div class="user-row-item">
      <div class="user-avatar" style="background:linear-gradient(135deg,${i===0?'#f59e0b,#ef4444':i===1?'#9ca3af,#6b7280':'#374151,#1f2937'})">${i+1}</div>
      <div class="user-info">
        <div class="user-email-small" style="font-size:12px">${u.email}</div>
        <div class="credit-bar-wrap" style="margin-top:5px"><div class="credit-bar" style="width:${Math.round((u.credits/max)*100)}%"></div></div>
      </div>
      <div class="user-credits">${fmtK(u.credits)}</div>
    </div>
  `).join('')
}

// ── USERS ────────────────────────────────────────────────
async function loadUsers() {
  try {
    const d = await fetch('/api/admin/users', {credentials:'include'}).then(r=>r.json())
    allUsers = d.users || []
    renderUsersTable(allUsers)
  } catch(e) {
    document.getElementById('users-table').innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--red);padding:20px">Failed to load users</td></tr>'
  }
}

function filterUsers() {
  const q = document.getElementById('user-search').value.toLowerCase()
  const t = document.getElementById('user-tier-filter').value
  const filtered = allUsers.filter(u =>
    (!q || u.email?.toLowerCase().includes(q) || u.name?.toLowerCase().includes(q)) &&
    (!t || (u.tier||'free') === t)
  )
  renderUsersTable(filtered)
}

function renderUsersTable(users) {
  document.getElementById('users-shown').textContent = users.length
  document.getElementById('users-total').textContent = allUsers.length
  const tb = document.getElementById('users-table')
  if (!users.length) { tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:20px">No users match</td></tr>'; return }
  tb.innerHTML = users.map((u,i) => `
    <tr>
      <td style="color:var(--text3);font-weight:500">${i+1}</td>
      <td><div class="email">${u.email}</div></td>
      <td style="color:var(--text2)">${u.name||'—'}</td>
      <td>${tierBadge(u.tier||'free')}</td>
      <td>${providerBadge(u.provider)}</td>
      <td><span style="font-family:monospace;font-size:12px;color:var(--accent)">${fmtK(u.credits_used||0)}</span></td>
      <td class="date">${fmtDate(u.created_at)}</td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="quickLookup('${u.email}')">Details</button>
      </td>
    </tr>
  `).join('')
}

function quickLookup(email) {
  document.getElementById('lookup-email').value = email
  showPage('manage', document.querySelectorAll('.nav-item')[5])
  setTimeout(() => lookupUser(), 100)
}

function exportUsersCSV() {
  if (!allUsers.length) { alert('Load users first'); return }
  const header = 'Email,Name,Tier,Provider,Credits Used,Joined'
  const rows = allUsers.map(u => [
    u.email, (u.name||'').replace(/,/g,''), u.tier||'free', u.provider||'google',
    u.credits_used||0, u.created_at ? new Date(u.created_at).toISOString().slice(0,10) : ''
  ].join(','))
  const csv = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'flowstate-users-' + new Date().toISOString().slice(0,10) + '.csv'
  a.click()
}

// ── REVENUE ──────────────────────────────────────────────
async function loadRevenue() {
  try {
    const [rev, txData] = await Promise.all([
      fetch('/api/billing/revenue?months=6', {credentials:'include'}).then(r=>r.json().catch(()=>({}))),
      fetch('/api/admin/transactions', {credentials:'include'}).then(r=>r.json().catch(()=>({}))),
    ])

    const s = rev.summary || {}
    document.getElementById('rev-gross').textContent = fmtUSD(s.totalGross)
    document.getElementById('rev-net').textContent   = fmtUSD(s.totalNet)
    document.getElementById('rev-api').textContent   = fmtUSD(s.totalApiAlloc)
    document.getElementById('rev-tx').textContent    = fmt(s.totalTx)

    // Monthly bars
    const months = rev.months || []
    const maxGross = Math.max(...months.map(m=>m.gross||0), 0.01)
    document.getElementById('rev-months').innerHTML = months.map(m => `
      <div class="rev-month-row">
        <span class="rev-month">${m.month}</span>
        <div class="rev-bar-wrap"><div class="rev-bar" style="width:${Math.round((m.gross/maxGross)*100)}%"></div></div>
        <span class="rev-amount">${fmtUSD(m.gross)}</span>
      </div>
    `).join('') || '<div style="color:var(--text3);font-size:13px">No revenue data</div>'

    // API budget (latest month)
    const latest = months[0]
    if (latest?.apiTopupRecommendation) {
      const r = latest.apiTopupRecommendation
      document.getElementById('api-budget').innerHTML = `
        <div style="margin-bottom:16px;font-size:12px;color:var(--text3)">Recommended monthly top-ups based on ${latest.month} revenue:</div>
        ${[['OpenRouter (Chat AI)','openrouter','#a855f7'],['Replicate (Video/Image)','replicate','#ec4899'],['ElevenLabs (TTS)','elevenlabs','#06b6d4']].map(([label,key,color])=>`
          <div class="health-row">
            <span style="font-size:13px">${label}</span>
            <span style="font-weight:700;font-size:14px;color:${color}">${fmtUSD(r[key]||0)}</span>
          </div>
        `).join('')}
        <div style="margin-top:12px;font-size:11px;color:var(--text3)">${rev.note||''}</div>
      `
    }

    // Transactions
    const txs = txData.transactions || []
    document.getElementById('transactions-table').innerHTML = txs.length
      ? txs.slice(0,20).map(t => `<tr>
          <td class="date">${fmtDate(t.created_at)}</td>
          <td><div class="email">${t.email}</div></td>
          <td style="color:var(--text2);font-size:12px">${t.type||'—'}</td>
          <td>${t.plan ? tierBadge(t.plan) : '—'}</td>
          <td style="font-weight:700;color:var(--green)">${fmtUSD((t.amount_cents||0)/100)}</td>
          <td><span class="badge ${t.status==='succeeded'?'badge-green':'badge-red'}">${t.status||'—'}</span></td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No transactions found</td></tr>'
  } catch(e) {
    console.error('Revenue load error:', e)
    const el = document.getElementById('rev-months')
    if (el) el.innerHTML = '<div style="color:var(--red);font-size:12px">⚠ Failed to load revenue — ' + (e.message||'network error') + '</div>'
  }
}

// ── CREDITS & API ────────────────────────────────────────
async function loadCredits() {
  try {
    const d = await fetch('/api/admin/credits-overview', {credentials:'include'}).then(r=>r.json())
    document.getElementById('api-total-credits').textContent = fmtK(d.totalCreditsMonth||0)
    document.getElementById('api-free-credits').textContent  = fmtK(d.freeCreditsMonth||0)
    document.getElementById('api-paid-credits').textContent  = fmtK(d.paidCreditsMonth||0)
    document.getElementById('api-blocked').textContent       = fmt(d.blockedRequests||0)

    const topEl = document.getElementById('top-api-users')
    const top = d.topUsers || []
    const maxC = top[0]?.credits || 1
    topEl.innerHTML = top.length ? top.map((u,i) => `
      <div class="user-row-item">
        <div class="user-avatar" style="width:28px;height:28px;font-size:11px">${i+1}</div>
        <div class="user-info">
          <div class="user-email-small">${u.email}</div>
          <div class="credit-bar-wrap" style="margin-top:4px"><div class="credit-bar" style="width:${Math.round((u.credits/maxC)*100)}%"></div></div>
        </div>
        <div class="user-credits">${fmtK(u.credits)}</div>
      </div>
    `).join('') : '<div style="color:var(--text3)">No data</div>'

    const tierEl = document.getElementById('credits-by-tier')
    const byTier = d.creditsByTier || {}
    const totalC = Object.values(byTier).reduce((a,b)=>a+(b||0),0)||1
    tierEl.innerHTML = Object.entries(byTier).sort((a,b)=>b[1]-a[1]).map(([tier,credits])=>{
      const pct = Math.round(((credits||0)/totalC)*100)
      return `<div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px">
          ${tierBadge(tier)}
          <span style="color:var(--text2);font-weight:600">${fmtK(credits)} credits (${pct}%)</span>
        </div>
        <div class="credit-bar-wrap"><div class="credit-bar" style="width:${pct}%"></div></div>
      </div>`
    }).join('') || '<div style="color:var(--text3)">No data</div>'
  } catch(e) { console.error('Credits load error:', e) }
}

// ── EMAIL STATS ──────────────────────────────────────────
async function loadEmailStats() {
  try {
    const d = await fetch('/api/admin/email-stats', {credentials:'include'}).then(r=>r.json())
    document.getElementById('ml-sent-month').textContent   = fmt(d.sentMonth||0)
    document.getElementById('ml-failed-month').textContent = fmt(d.failedMonth||0)
    document.getElementById('ml-sent-total').textContent   = fmt(d.sentTotal||0)
    document.getElementById('ml-delivery-rate').textContent = d.deliveryRate != null ? d.deliveryRate + '%' : '—'
    document.getElementById('ml-delayed-month').textContent = fmt(d.delayedMonth||0)
    document.getElementById('ml-spam-month').textContent    = fmt(d.spamMonth||0)

    const rateEl = document.getElementById('ml-delivery-rate')
    if (d.deliveryRate != null) {
      rateEl.style.color = d.deliveryRate >= 95 ? 'var(--green)' : d.deliveryRate >= 80 ? 'var(--amber)' : 'var(--red)'
    }

    const domainOk   = d.domainStatus === 'verified'
    const domainWarn = !d.domainStatus || d.domainStatus === 'unknown' || d.domainStatus === 'pending'
    const domainBad  = d.domainStatus === 'failed' || d.domainStatus === 'not_added'

    const diagEl = document.getElementById('email-diagnostics')
    const diags = [
      { label: 'RESEND_API_KEY configured',    ok: d.resendConfigured,  warn: false,       note: d.resendConfigured ? 'Resend configured ✓' : '⚠️ Add RESEND_API_KEY to Cloudflare secrets — email auth wont work without it' },
      { label: 'Sending address',               ok: true,               warn: false,       note: d.fromEmail || 'FlowState <noreply@flowst8.cc> (default)' },
      { label: 'flowst8.cc domain status',      ok: domainOk,           warn: domainWarn,  note: domainOk ? '✓ Verified — SPF/DKIM/DMARC active' : domainBad ? '❌ NOT verified — iCloud/Apple WILL reject emails! Verify at resend.com/domains' : '⏳ Status: ' + (d.domainStatus||'unknown') + ' — verify to fix iCloud/Apple bounces' },
      { label: 'Redis token storage',           ok: d.redisConfigured,  warn: false,       note: d.redisConfigured ? '✓ Single-use tokens in Upstash Redis (15-min TTL)' : '⚠️ Add UPSTASH_REDIS_URL + UPSTASH_REDIS_TOKEN' },
      { label: 'Delivery health (this month)',  ok: (d.failedMonth||0)===0||(d.deliveryRate||100)>=90, warn: (d.deliveryRate||100)<90&&(d.deliveryRate||100)>=70, note: d.failedMonth > 0 ? '⚠️ ' + d.failedMonth + ' bounce(s) this month — common causes: unverified domain, iCloud/Apple rejections' : '✓ No failures this month' },
    ]
    diagEl.innerHTML = diags.map(function(diag) {
      return '<div class="health-row">' +
        '<div style="display:flex;align-items:center">' +
          '<span class="health-dot ' + (diag.ok?'health-ok':diag.warn?'health-warn':'health-err') + '"></span>' +
          '<span style="font-size:13px">' + diag.label + '</span>' +
        '</div>' +
        '<span style="font-size:12px;color:' + (diag.ok?'var(--text2)':diag.warn?'var(--amber)':'var(--red)') + ';' + (diag.ok?'':'font-weight:600') + '">' + diag.note + '</span>' +
      '</div>'
    }).join('')

    if (!domainOk && d.resendConfigured) {
      diagEl.innerHTML += '<div style="margin-top:16px;padding:12px 14px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;font-size:12px;color:#fca5a5;line-height:1.7">' +
        '<strong>🔧 Fix iCloud/Apple Bounces:</strong><br>' +
        '1. Go to <a href="https://resend.com/domains" target="_blank" style="color:#c084fc">resend.com/domains</a> → Add domain <strong>flowst8.cc</strong><br>' +
        '2. Add SPF, DKIM &amp; DMARC DNS records at your registrar (Namecheap/Cloudflare/GoDaddy)<br>' +
        '3. Click Verify — takes 5–30 min<br>' +
        '4. Set Cloudflare secret: <code style="background:rgba(0,0,0,.3);padding:1px 5px;border-radius:3px">RESEND_FROM_EMAIL</code> = <code style="background:rgba(0,0,0,.3);padding:1px 5px;border-radius:3px">FlowState &lt;noreply@flowst8.cc&gt;</code><br>' +
        '<em>Until then: emails send via onboarding@resend.dev (works, but shows "via resend.dev" in Gmail)</em>' +
      '</div>'
    }

    const bouncesEl = document.getElementById('recent-bounces')
    const bounces = d.recentBounces || []
    if (bounces.length === 0) {
      bouncesEl.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:8px 0">✅ Webhook connected — no bounces recorded yet.</div>'
    } else {
      bouncesEl.innerHTML = bounces.map(function(b) {
        const ts = b.ts ? new Date(b.ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'
        return '<div class="health-row">' +
          '<span style="font-family:monospace;font-size:11px;color:var(--text2)">' + (b.to||'?') + '</span>' +
          '<span style="display:flex;align-items:center;gap:6px">' +
            '<span class="badge badge-red">' + (b.reason||'bounce') + '</span>' +
            '<span style="font-size:11px;color:var(--text3)">' + ts + '</span>' +
          '</span>' +
        '</div>'
      }).join('')
    }

    const wn = document.getElementById('webhook-note')
    if (wn) {
      if (d.webhookNote) {
        wn.textContent = d.webhookNote
        wn.style.display = 'block'
      } else {
        // Webhook is active - show connected status
        wn.innerHTML = '&#9989; Resend webhook connected at <code>https://flowst8.cc/api/resend/webhook</code> &mdash; bounce, delay, and spam events are being tracked in real time.'
        wn.style.background = 'rgba(16,185,129,.08)'
        wn.style.borderColor = 'rgba(16,185,129,.25)'
        wn.style.color = 'var(--green)'
        wn.style.display = 'block'
      }
    }

  } catch(e) { console.error('Email stats error:', e) }
}

async function sendTestMagicLink() {
  const email = document.getElementById('test-email').value.trim()
  const btn = document.getElementById('btn-test-ml')
  const el  = document.getElementById('test-ml-result')
  if (!email) { showAlert(el, 'err', 'Enter an email address'); return }
  btn.disabled = true; btn.textContent = 'Sending…'
  try {
    const r = await fetch('/api/auth/magic-link', {credentials:'include', method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email}) })
    const d = await r.json()
    if (d.success) showAlert(el, 'ok', '✅ Magic link sent to ' + email + '. Check inbox (and spam folder).')
    else showAlert(el, 'err', '❌ ' + (d.message || d.error || 'Send failed'))
  } catch(e) { showAlert(el, 'err', '❌ Request failed: ' + e.message) }
  finally { btn.disabled=false; btn.textContent='✉️ Send Test Link' }
}

// ── SYSTEM HEALTH ────────────────────────────────────────
async function loadSystemHealth() {
  try {
    const d = await fetch('/api/admin/system-health', {credentials:'include'}).then(r=>r.json())
    const services = d.services || []
    document.getElementById('system-health-rows').innerHTML = services.length
      ? services.map(s => `
        <div class="health-row">
          <div style="display:flex;align-items:center"><span class="health-dot ${s.ok?'health-ok':'health-err'}"></span><span style="font-size:13px">${s.name}</span></div>
          <span style="font-size:12px;color:${s.ok?'var(--text2)':'var(--red)'}">${s.note||''}</span>
        </div>
      `).join('')
      : '<div style="color:var(--text3)">Could not load health data</div>'

    const keys = d.apiKeys || []
    document.getElementById('api-keys-rows').innerHTML = keys.length
      ? keys.map(k => `
        <div class="health-row">
          <div style="display:flex;align-items:center"><span class="health-dot ${k.present?'health-ok':'health-warn'}"></span><span style="font-size:13px">${k.name}</span></div>
          <span style="font-size:12px;color:${k.present?'var(--text2)':'var(--amber)'}">${k.present?'Configured':'Missing'}</span>
        </div>
      `).join('')
      : '<div style="color:var(--text3)">No key data</div>'

    const cfg = d.config || []
    document.getElementById('config-rows').innerHTML = cfg.length
      ? cfg.map(c => `<div class="health-row"><span style="font-size:13px;color:var(--text2)">${c.key}</span><span style="font-family:monospace;font-size:12px;color:var(--text)">${c.value}</span></div>`).join('')
      : '<div style="color:var(--text3)">No config</div>'

  } catch(e) { document.getElementById('system-health-rows').innerHTML = '<div style="color:var(--red)">Health check failed</div>' }
}

// ── MANAGE USER ACTIONS ──────────────────────────────────
async function lookupUser() {
  const email = document.getElementById('lookup-email').value.trim()
  const el    = document.getElementById('lookup-result')
  if (!email) { showAlert(el,'err','Enter an email'); return }
  try {
    const r = await fetch('/api/admin/user-tier?email=' + encodeURIComponent(email), {credentials:'include'})
    const d = await r.json()
    if (!r.ok) { showAlert(el,'err','❌ ' + (d.error||'Not found')); return }
    showAlert(el,'info',`
      <strong>${d.email}</strong> ${tierBadge(d.tier||'free')} ${providerBadge(d.provider||'google')}<br>
      <span style="font-size:12px;color:var(--text3)">Joined: ${fmtDate(d.created_at)}</span><br><br>
      Credits used this month: <strong>${fmtK(d.monthlyCreditsUsed)}</strong><br>
      Purchased credit balance: <strong>${fmtK(d.purchasedCredits)}</strong>
    `)
  } catch(e) { showAlert(el,'err','❌ Request failed') }
}

async function setTier() {
  const email = document.getElementById('set-email').value.trim()
  const tier  = document.getElementById('set-tier').value
  const el    = document.getElementById('set-result')
  if (!email) { showAlert(el,'err','Enter an email'); return }
  try {
    const r = await fetch('/api/admin/user-tier', {credentials:'include', method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,tier}) })
    const d = await r.json()
    if (!r.ok) { showAlert(el,'err','❌ ' + d.error); return }
    showAlert(el,'ok','✅ ' + d.message)
    allUsers = [] // force refresh
  } catch(e) { showAlert(el,'err','❌ Request failed') }
}

async function addCredits() {
  const email  = document.getElementById('credit-email').value.trim()
  const amount = parseInt(document.getElementById('credit-amount').value)
  const el     = document.getElementById('credit-result')
  if (!email) { showAlert(el,'err','Enter an email'); return }
  if (!amount||amount<1) { showAlert(el,'err','Enter a valid credit amount'); return }
  try {
    const r = await fetch('/api/admin/add-credits', {credentials:'include', method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,amount}) })
    const d = await r.json()
    if (!r.ok) { showAlert(el,'err','❌ ' + d.error); return }
    showAlert(el,'ok','✅ ' + d.message)
  } catch(e) { showAlert(el,'err','❌ Request failed') }
}

async function resetCredits() {
  const email = document.getElementById('credit-email').value.trim()
  const el    = document.getElementById('credit-result')
  if (!email) { showAlert(el,'err','Enter an email to reset credits for'); return }
  if (!confirm("Reset this month's credit usage for " + email + " to zero?")) return
  try {
    const r = await fetch('/api/admin/reset-credits', {credentials:'include', method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email}) })
    const d = await r.json()
    if (!r.ok) { showAlert(el,'err','❌ ' + (d.error||'Failed')); return }
    showAlert(el,'ok','✅ ' + (d.message||'Credits reset'))
  } catch(e) { showAlert(el,'err','❌ Request failed') }
}

async function sendMagicLinkAdmin() {
  const email = document.getElementById('ml-send-email').value.trim()
  const btn   = document.getElementById('btn-ml-admin')
  const el    = document.getElementById('ml-send-result')
  if (!email) { showAlert(el,'err','Enter an email'); return }
  btn.disabled=true; btn.textContent='Sending…'
  try {
    const r = await fetch('/api/auth/magic-link', {credentials:'include', method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email}) })
    const d = await r.json()
    if (d.success) showAlert(el,'ok','✅ Sign-in link sent to ' + email)
    else showAlert(el,'err','❌ ' + (d.message||d.error||'Failed'))
  } catch(e) { showAlert(el,'err','❌ ' + e.message) }
  finally { btn.disabled=false; btn.textContent='✉️ Send Link' }
}

// ── BOOT: load overview ──────────────────────────────────
loadOverview()
const startTime = Date.now()
// Update last-refresh timer every 30s
setInterval(()=>{ const el=document.getElementById('last-refresh'); if(el){ const m=Math.round((Date.now()-startTime)/60000); el.textContent=m<1?'just now':m+' min ago' } },30000)
// Auto-refresh overview data every 2 minutes
setInterval(()=>{ const activePage=document.querySelector('.page.active'); if(activePage?.id==='page-overview') loadOverview() },120000)
// Keyboard shortcut: press R to refresh current page
document.addEventListener('keydown', e => {
  if (e.key==='r' && !e.metaKey && !e.ctrlKey && !['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName||'')) {
    const activePage = document.querySelector('.page.active')?.id?.replace('page-','')
    if (activePage) { const btn = document.querySelector('.nav-item.active'); showPage(activePage, btn) }
  }
})
