
// ── State ──────────────────────────────────────────────────────────────────

let state = {
  timer:   { running:false, phase:'focus', elapsed:0, totalFocusSec:0, sessions:0, streak:0, focusMin:25, shortMin:5, longMin:15, intervalId:null, audioCtx:null, soundType:null },
  chat:    { model:'auto', history:[] },
  cal:     { year:new Date().getFullYear(), month:new Date().getMonth(), events:[] },
  kanban:  { tasks:{ todo:[], inprogress:[], done:[] }, notionDb:null },
  learn:   { cards:[], idx:0 },
  restore: { scenes:[], idx:0 },
  team:    { members:[], role:'member' },
  settings:{ focusMin:25, sound:null, isDemo:false }
};

// ── Boot ───────────────────────────────────────────────────────────────────
function boot() {
  loadLocalState();
  if (FS_USER) {
    state.team.role = FS_USER.role || 'member';
    if (FS_ONBOARDED) { showMainApp(); }
    else              { showOnboarding(); }
  } else {
    showLogin();
  }
}

function loadLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem('fs_state') || '{}');
    if (saved.timer) {
      state.timer.sessions     = saved.timer.sessions     || 0;
      state.timer.totalFocusSec= saved.timer.totalFocusSec|| 0;
      state.timer.streak       = saved.timer.streak       || 0;
      state.timer.focusMin     = saved.timer.focusMin     || 25;
      state.settings.focusMin  = state.timer.focusMin;
    }
    if (saved.kanban) state.kanban = saved.kanban;
  } catch(e) {}
}

function saveLocalState() {
  try {
    localStorage.setItem('fs_state', JSON.stringify({
      timer: { sessions:state.timer.sessions, totalFocusSec:state.timer.totalFocusSec, streak:state.timer.streak, focusMin:state.timer.focusMin },
      kanban: state.kanban
    }));
  } catch(e) {}
}

// ── Login ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
}

document.getElementById('btn-google-login').addEventListener('click', () => {
  window.location.href = '/api/auth/google';
});

document.getElementById('btn-magic-login').addEventListener('click', () => {
  const email = prompt('Enter your work email:');
  if (!email) return;
  fetch('/api/auth/magic-link', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email}) })
    .then(r => r.json()).then(d => { if (d.ok) { notify('Magic link sent! Check your email.','success'); } else { notify('Error: ' + (d.error||'unknown'),'error'); } });
});

document.getElementById('btn-demo-login').addEventListener('click', () => {
  enterDemoMode();
});

function enterDemoMode() {
  state.settings.isDemo = true;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('tab-demo').style.display = 'flex';
  showMainApp(true);
  switchTab('demo');
  notify('Demo mode active — explore all features with sample data!','info');
}

// ── Onboarding ─────────────────────────────────────────────────────────────
let obStep = 0, obGoals = [], obRhythm = 25;
const OB_GOALS = [
  { id:'deep_focus', icon:'fa-brain', label:'Deep Focus', desc:'Long uninterrupted sessions' },
  { id:'team_collab', icon:'fa-users', label:'Team Collab', desc:'Sprint boards & standups' },
  { id:'health_energy', icon:'fa-heart', label:'Health & Energy', desc:'Breaks, breathing, sleep' },
  { id:'creative', icon:'fa-palette', label:'Creative Flow', desc:'Generate & design' },
  { id:'learning', icon:'fa-graduation-cap', label:'Learning', desc:'Flashcards & spaced rep' },
  { id:'financial', icon:'fa-chart-line', label:'Financial', desc:'Goals & milestones' },
];
const OB_STEPS = ['Welcome','Goals','Tools','Rhythm','Done'];

function showOnboarding() {
  document.getElementById('ob-screen').style.display = 'flex';
  obStep = 0; renderObStep();
}

function renderObStep() {
  const card = document.getElementById('ob-card');
  const progress = OB_STEPS.map((s,i) => `<div class="ob-dot ${i===obStep?'active':i<obStep?'done':''}"></div>`).join('');
  let inner = '';
  if (obStep === 0) {
    inner = `<div class="ob-logo">⚡</div><h2 class="ob-title">Welcome to FlowState</h2><p class="ob-sub">The intelligent workspace for makers, developers & teams. Let's set up your perfect focus environment.</p><div class="ob-progress">${progress}</div><button class="ob-btn" onclick="obNext()">Get Started <i class="fas fa-arrow-right"></i></button>`;
  } else if (obStep === 1) {
    const btns = OB_GOALS.map(g => `<button class="goal-btn ${obGoals.includes(g.id)?'sel':''}" onclick="toggleGoal('${g.id}',this)"><i class="fas ${g.icon}"></i><div><div>${g.label}</div><div style="font-size:11px;color:var(--text-m)">${g.desc}</div></div></button>`).join('');
    inner = `<div class="ob-step">STEP 2 OF 5</div><div class="ob-progress">${progress}</div><h2 class="ob-title">What are your goals?</h2><p class="ob-sub">Pick all that apply</p><div class="goal-grid">${btns}</div><button class="ob-btn" onclick="obNext()">Continue</button><button class="ob-skip" onclick="obNext()">Skip</button>`;
  } else if (obStep === 2) {
    const tools = [
      { icon:'📅', name:'Google Calendar', desc:'See & block events', key:'google' },
      { icon:'📝', name:'Notion', desc:'Kanban sync', key:'notion' },
      { icon:'💬', name:'Slack', desc:'Team updates', key:'slack' },
    ];
    const rows = tools.map(t => {
      const connected = (t.key==='google'&&FS_USER)||(t.key==='notion'&&FS_NOTION)||(t.key==='slack'&&FS_SLACK);
      return `<div class="integ-row"><div class="integ-left"><span class="integ-icon">${t.icon}</span><div><div class="integ-name">${t.name}</div><div class="integ-desc">${t.desc}</div></div></div><button class="btn-connect ${connected?'connected':''}" onclick="obConnect('${t.key}')">${connected?'Connected ✓':'Connect'}</button></div>`;
    }).join('');
    inner = `<div class="ob-step">STEP 3 OF 5</div><div class="ob-progress">${progress}</div><h2 class="ob-title">Connect your tools</h2><p class="ob-sub">Optional — you can connect later</p><div class="integ-list">${rows}</div><button class="ob-btn" onclick="obNext()">Continue</button><button class="ob-skip" onclick="obNext()">Skip</button>`;
  } else if (obStep === 3) {
    const rhythms = [{min:25,label:'Pomodoro',desc:'Classic focus'},{min:45,label:'Deep Work',desc:'Extended flow'},{min:90,label:'Ultradian',desc:'Peak rhythm'}];
    const btns = rhythms.map(r => `<button class="rhythm-btn ${obRhythm===r.min?'sel':''}" onclick="selectRhythm(${r.min},this)"><span class="rhythm-min">${r.min}</span><span class="rhythm-lbl">${r.label}<br><span style="font-size:10px">${r.desc}</span></span></button>`).join('');
    inner = `<div class="ob-step">STEP 4 OF 5</div><div class="ob-progress">${progress}</div><h2 class="ob-title">Your focus rhythm</h2><p class="ob-sub">How long are your typical focus sessions?</p><div class="rhythm-grid">${btns}</div><button class="ob-btn" onclick="obNext()">Continue</button>`;
  } else {
    inner = `<div class="ob-logo">🎉</div><div class="ob-progress">${progress}</div><h2 class="ob-title">You're all set!</h2><p class="ob-sub">FlowState is personalised for your goals. Let's start your first session.</p><button class="ob-btn" onclick="completeOnboarding()">Start Flowing ⚡</button>`;
  }
  card.innerHTML = inner;
}

function obNext() { obStep = Math.min(obStep+1, OB_STEPS.length-1); renderObStep(); }
function toggleGoal(id, btn) { const idx=obGoals.indexOf(id); if(idx===-1){obGoals.push(id);btn.classList.add('sel');}else{obGoals.splice(idx,1);btn.classList.remove('sel');} }
function selectRhythm(min, btn) { obRhythm=min; document.querySelectorAll('.rhythm-btn').forEach(b=>b.classList.remove('sel')); btn.classList.add('sel'); }
function obConnect(key) { if(key==='google') window.open('/api/auth/google','_blank','width=480,height=600'); if(key==='notion') window.open('/api/auth/notion','_blank','width=480,height=600'); if(key==='slack') window.open('/api/auth/slack','_blank','width=480,height=600'); }

function completeOnboarding() {
  state.timer.focusMin = obRhythm;
  state.settings.focusMin = obRhythm;
  fetch('/api/onboarding/complete', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ goals:obGoals, focusDuration:obRhythm, workHours:'9-18', timezone:Intl.DateTimeFormat().resolvedOptions().timeZone })
  }).catch(()=>{});
  document.getElementById('ob-screen').style.display = 'none';
  showMainApp();
}

// ── Main App ───────────────────────────────────────────────────────────────
function showMainApp(isDemo=false) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('ob-screen').style.display = 'none';
  document.getElementById('main-header').style.display = 'flex';
  document.getElementById('main-tabs').style.display = 'flex';
  document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
  switchTab('focus');
  renderUserArea();
  initTimer();
  startClock();
  buildModelBar();
  setupKeyboard();
  setupTabHandlers();
  renderCalGrid();
  maybeShowTip();
}

function renderUserArea() {
  const area = document.getElementById('user-area');
  if (state.settings.isDemo) {
    area.innerHTML = `<div class="u-pill" onclick="exitDemo()"><div class="u-avatar" style="background:var(--warn);display:flex;align-items:center;justify-content:center;font-size:13px">👁</div><span class="u-name" style="color:var(--warn)">Demo</span></div>`;
  } else if (FS_USER) {
    const u = FS_USER;
    area.innerHTML = `<div class="u-pill" onclick="openSettingsModal()"><img class="u-avatar" src="${u.picture||''}" onerror="this.style.display='none'" alt="${u.name}"><span class="u-name">${u.name}</span></div>`;
    const rb = document.getElementById('role-selector');
    if (rb && (u.role==='admin'||u.role==='scrum_master')) {
      rb.style.display = 'block';
      rb.innerHTML = `<span class="role-badge ${u.role}">${u.role==='admin'?'👑 Admin':'🎯 Scrum Master'}</span>`;
    }
    if (u.role==='admin'||u.role==='scrum_master') {
      const banner = document.getElementById('team-role-banner');
      banner.style.display = 'block';
      banner.innerHTML = `<div class="role-badge ${u.role}" style="font-size:13px;padding:7px 14px">${u.role==='admin'?'👑 Admin — full team visibility':'🎯 Scrum Master — sprint controls unlocked'}</div>`;
    }
  } else {
    area.innerHTML = `<button class="btn-signin" onclick="showLogin()">Sign In</button>`;
  }
}

function exitDemo() {
  state.settings.isDemo = false;
  document.getElementById('tab-demo').style.display = 'none';
  window.location.href = '/';
}

function setupTabHandlers() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.id.replace('tab-','');
      switchTab(id);
    });
  });
  document.getElementById('btn-creds').addEventListener('click', openCredsModal);
  document.getElementById('btn-pricing').addEventListener('click', openPricingModal);
  document.getElementById('btn-invite').addEventListener('click', openInviteModal);
  document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
  document.getElementById('btn-exit-demo').addEventListener('click', exitDemo);
  document.getElementById('logo-home').addEventListener('click', () => switchTab('focus'));
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => { p.classList.remove('active'); p.style.display='none'; });
  const btn = document.getElementById('tab-'+tab);
  const pane = document.getElementById('tab-pane-'+tab);
  if (btn) btn.classList.add('active');
  if (pane) { pane.classList.add('active'); pane.style.display='flex'; }
  if (tab==='metrics') buildMetrics();
  if (tab==='board')   buildBoard();
  if (tab==='team')    buildTeam();
  if (tab==='learn')   loadLearnCards();
  if (tab==='restore') loadRestore();
  if (tab==='calendar') { renderCalGrid(); loadCalEvents(); }
  if (tab==='clawbot') initClawbot();
}

// ── Clock ──────────────────────────────────────────────────────────────────
function startClock() {
  const tick = () => {
    const now = new Date();
    const dateEl = document.getElementById('dt-date');
    const timeEl = document.getElementById('dt-time');
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
  };
  tick();
  setInterval(tick, 1000);
}

// ── Timer ──────────────────────────────────────────────────────────────────
const PHASES = { focus:'focus', short_break:'short_break', long_break:'long_break' };
const PHASE_LABELS = { focus:'FOCUS', short_break:'SHORT BREAK', long_break:'LONG BREAK' };
const PHASE_MIN = () => ({ focus:state.timer.focusMin, short_break:state.timer.shortMin, long_break:state.timer.longMin });

function initTimer() {
  updateTimerDisplay();
  updateStats();
  document.getElementById('btn-start').addEventListener('click', toggleTimer);
  document.getElementById('btn-skip').addEventListener('click', skipPhase);
  document.getElementById('btn-reset').addEventListener('click', resetTimer);
  document.getElementById('ph-focus').addEventListener('click', () => setPhase('focus'));
  document.getElementById('ph-short').addEventListener('click', () => setPhase('short_break'));
  document.getElementById('ph-long').addEventListener('click', () => setPhase('long_break'));
  document.getElementById('cal-add-btn').addEventListener('click', () => {
    const f = document.getElementById('add-ev-form');
    f.classList.toggle('show');
  });
  document.getElementById('ev-save-btn').addEventListener('click', saveCalEvent);
  document.getElementById('ev-cancel-btn').addEventListener('click', () => document.getElementById('add-ev-form').classList.remove('show'));
  document.getElementById('cal-prev').addEventListener('click', () => calNav(-1));
  document.getElementById('cal-next').addEventListener('click', () => calNav(1));
  document.getElementById('cal-refresh').addEventListener('click', loadCalEvents);
  document.getElementById('cal-connect-btn').addEventListener('click', () => window.open('/api/auth/google','_blank','width=480,height=600'));
  document.getElementById('board-notion-btn').addEventListener('click', connectNotion);
  document.getElementById('board-db-refresh').addEventListener('click', loadNotionDbs);
  document.getElementById('btn-slack-team').addEventListener('click', openSlackModal);
  document.getElementById('btn-refresh-team').addEventListener('click', buildTeam);
  document.getElementById('btn-gen-img').addEventListener('click', generateImage);
  document.getElementById('btn-gen-vid').addEventListener('click', generateVideo);
  document.querySelectorAll('.s-chip').forEach(c => c.addEventListener('click', () => toggleSound(c.dataset.sound)));
}

function toggleTimer() {
  if (state.timer.running) pauseTimer(); else startTimer();
}

function startTimer() {
  if (state.timer.phase === 'focus') {
    maybeShowIntentPrompt();
    return;
  }
  _doStartTimer();
}

function _doStartTimer() {
  state.timer.running = true;
  document.getElementById('btn-icon').className = 'fas fa-pause';
  document.getElementById('t-glow').classList.add('on');
  document.getElementById('b-ring').classList.add('on');
  if (state.timer.soundType && state.timer.soundType !== 'off') startAmbientSound(state.timer.soundType);
  state.timer.intervalId = setInterval(tickTimer, 1000);
}

function pauseTimer() {
  state.timer.running = false;
  clearInterval(state.timer.intervalId);
  document.getElementById('btn-icon').className = 'fas fa-play';
  document.getElementById('t-glow').classList.remove('on');
  document.getElementById('b-ring').classList.remove('on');
  stopAmbientSound();
}

function resetTimer() {
  pauseTimer();
  state.timer.elapsed = 0;
  updateTimerDisplay();
}

function skipPhase() {
  pauseTimer();
  state.timer.elapsed = 0;
  const phases = ['focus','short_break','long_break'];
  const next = phases[(phases.indexOf(state.timer.phase)+1) % phases.length];
  setPhase(next);
}

function setPhase(phase) {
  state.timer.phase = phase;
  state.timer.elapsed = 0;
  document.querySelectorAll('.ph-btn').forEach(b => b.classList.remove('active'));
  const map = { focus:'ph-focus', short_break:'ph-short', long_break:'ph-long' };
  const el = document.getElementById(map[phase]);
  if (el) el.classList.add('active');
  updateTimerDisplay();
}

function tickTimer() {
  state.timer.elapsed++;
  const totalSec = PHASE_MIN()[state.timer.phase] * 60;
  if (state.timer.phase === 'focus') state.timer.totalFocusSec++;
  if (state.timer.elapsed >= totalSec) {
    pauseTimer();
    if (state.timer.phase === 'focus') {
      state.timer.sessions++;
      if (state.timer.sessions % 4 === 0) {
        setPhase('long_break');
        triggerCelebration('Long Break Earned! 🎉', 'You completed 4 focus sessions!');
      } else {
        setPhase('short_break');
        triggerCelebration('Session Complete! ⚡', 'Take a 5-minute break.');
      }
      updateStats();
      saveLocalState();
    } else {
      setPhase('focus');
      notify('Break over — ready to focus?', 'info');
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('FlowState', { body: state.timer.phase==='focus'?'Focus session complete!':'Break time over!' });
    }
    return;
  }
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const totalSec = PHASE_MIN()[state.timer.phase] * 60;
  const remaining = totalSec - state.timer.elapsed;
  const m = Math.floor(remaining/60).toString().padStart(2,'0');
  const s = (remaining%60).toString().padStart(2,'0');
  const el = document.getElementById('timer-display');
  const phase = document.getElementById('timer-phase');
  const ring = document.getElementById('ring-prog');
  if (el) el.textContent = `${m}:${s}`;
  if (phase) phase.textContent = PHASE_LABELS[state.timer.phase] || 'FOCUS';
  if (ring) {
    const circumference = 615.75;
    const progress = state.timer.elapsed / totalSec;
    ring.style.strokeDashoffset = circumference * (1 - progress);
  }
}

function updateStats() {
  const sess = document.getElementById('stat-sessions');
  const foc  = document.getElementById('stat-focus');
  const str  = document.getElementById('stat-streak');
  if (sess) sess.textContent = state.timer.sessions;
  if (foc)  foc.textContent  = Math.round(state.timer.totalFocusSec/60) + 'm';
  if (str)  str.textContent  = '🔥 ' + (state.timer.streak||0);
  refreshFlowScore();
}

function refreshFlowScore() {
  fetch('/api/flowscore', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      focusSeconds: state.timer.totalFocusSec,
      targetFocusMinutes: state.timer.focusMin * 4,
      breaks: state.timer.sessions,
      breathing: 0, gratitude: parseInt(localStorage.getItem('gratitude_count')||'0'),
      streak: state.timer.streak, sleep: 7, steps: 0, hydration: 0
    })
  }).then(r=>r.json()).then(d=>{
    if (d.score !== undefined) {
      const badge = document.getElementById('fs-score-badge');
      if (badge) { badge.textContent = `⚡ ${d.score}`; badge.style.display='block'; }
      const insScore = document.getElementById('ins-score');
      if (insScore) insScore.textContent = d.score;
    }
  }).catch(()=>{});
}

// ── Intent Prompt ──────────────────────────────────────────────────────────
function maybeShowIntentPrompt() {
  const overlay = document.createElement('div');
  overlay.className = 'intent-modal';
  overlay.innerHTML = `<div class="intent-card">
    <h2>🎯 What's your focus for this session?</h2>
    <p>Set your intention to activate AI coaching</p>
    <input class="intent-input" id="intent-in" placeholder="e.g. Build the auth flow, review PRs..." autofocus>
    <div class="intent-suggestions">
      ${['Deep work on feature','Review & refactor','Planning session','Learning / research','Writing & docs'].map(s=>`<button class="intent-sug" onclick="document.getElementById('intent-in').value='${s}'">${s}</button>`).join('')}
    </div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button class="btn-primary" onclick="submitIntent()">Start Session ⚡</button>
      <button class="btn-sm" onclick="this.closest('.intent-modal').remove();_doStartTimer()">Skip</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  Notification.requestPermission().catch(()=>{});
}

function submitIntent() {
  const val = document.getElementById('intent-in')?.value || '';
  document.querySelector('.intent-modal')?.remove();
  if (val) {
    fetch('/api/session/intent', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ intent:val, model:state.chat.model })
    }).then(r=>r.json()).then(d=>{
      if (d.suggestedModel) state.chat.model = d.suggestedModel;
    }).catch(()=>{});
  }
  _doStartTimer();
}

// ── Ambient Sounds (Web Audio API) ─────────────────────────────────────────
function toggleSound(type) {
  document.querySelectorAll('.s-chip').forEach(c => c.classList.remove('active'));
  if (type === 'off' || type === state.timer.soundType) {
    stopAmbientSound();
    state.timer.soundType = null;
    state.settings.sound = null;
    notify('Sound off','info');
  } else {
    stopAmbientSound();
    state.timer.soundType = type;
    state.settings.sound = type;
    const chip = document.querySelector(`.s-chip[data-sound="${type}"]`);
    if (chip) chip.classList.add('active');
    if (state.timer.running) startAmbientSound(type);
    notify(`Playing: ${type}`,'info');
    document.body.classList.add('amb-active');
  }
  if (!state.timer.soundType) document.body.classList.remove('amb-active');
}

function startAmbientSound(type) {
  try {
    if (!state.timer.audioCtx) state.timer.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.timer.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    stopAmbientSound();
    const cfg = {
      rain:    { color:'pink', freq:0, gain:.18 },
      forest:  { color:'brown', freq:0, gain:.1 },
      cafe:    { color:'pink', freq:200, gain:.08 },
      ocean:   { color:'brown', freq:.1, gain:.15 },
      fire:    { color:'pink', freq:0, gain:.12 },
      space:   { color:'white', freq:0, gain:.04 },
    }[type] || { color:'white', freq:0, gain:.07 };
    const buf = ctx.createBuffer(2, ctx.sampleRate*2, ctx.sampleRate);
    for (let ch=0;ch<2;ch++) {
      const data = buf.getChannelData(ch);
      let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
      for (let i=0;i<data.length;i++) {
        const white = Math.random()*2-1;
        if (cfg.color==='pink') {
          b0=.99886*b0+white*.0555179; b1=.99332*b1+white*.0750759;
          b2=.96900*b2+white*.1538520; b3=.86650*b3+white*.3104856;
          b4=.55000*b4+white*.5329522; b5=-.7616*b5-white*.0168980;
          data[i]=(b0+b1+b2+b3+b4+b5+b6+white*.5362)*0.11; b6=white*.115926;
        } else if (cfg.color==='brown') {
          b0=(b0+(.02*white))/(1+.02); data[i]=b0*3.5;
        } else { data[i]=white; }
      }
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const gain = ctx.createGain(); gain.gain.setValueAtTime(cfg.gain, ctx.currentTime);
    if (cfg.freq) {
      const filt = ctx.createBiquadFilter(); filt.type='bandpass'; filt.frequency.value=cfg.freq;
      src.connect(filt); filt.connect(gain);
    } else { src.connect(gain); }
    gain.connect(ctx.destination);
    src.start();
    ctx._currentSource = src; ctx._currentGain = gain;
  } catch(e) { console.warn('Web Audio error', e); }
}

function stopAmbientSound() {
  try {
    const ctx = state.timer.audioCtx;
    if (ctx && ctx._currentSource) { ctx._currentSource.stop(); ctx._currentSource = null; }
  } catch(e) {}
}

// ── Model Bar ──────────────────────────────────────────────────────────────
const MODELS = [
  {id:'auto',label:'Auto Route',badge:'smart',color:'var(--grad)'},
  {id:'gpt-4o',label:'GPT-4o',badge:'OpenAI'},
  {id:'claude-3-7-sonnet',label:'Claude',badge:'Anthropic'},
  {id:'gemini-2-flash',label:'Gemini',badge:'Google'},
  {id:'grok-3',label:'Grok',badge:'xAI'},
  {id:'mistral-large',label:'Mistral',badge:'Mistral'},
  {id:'deepseek-r1',label:'DeepSeek',badge:'DeepSeek'},
];

function buildModelBar() {
  const bar = document.getElementById('model-bar');
  if (!bar) return;
  bar.innerHTML = MODELS.map(m => `<button class="m-chip ${state.chat.model===m.id?'active':''}" onclick="selectModel('${m.id}')"><span>${m.label}</span><span class="badge">${m.badge}</span></button>`).join('') +
    `<div class="route-badge"><div class="r-dot"></div> AI routing active</div>`;
}

function selectModel(id) {
  state.chat.model = id;
  buildModelBar();
}

// ── Chat ───────────────────────────────────────────────────────────────────
const MODEL_NAMES = {
  'auto':'FlowState AI','gpt-4o':'GPT-4o','claude-3-7-sonnet':'Claude 3.7',
  'gemini-2-flash':'Gemini Flash','grok-3':'Grok 3','mistral-large':'Mistral Large',
  'deepseek-r1':'DeepSeek R1','llama-3-3':'Llama 3.3'
};

async function sendMessage() {
  const inp = document.getElementById('chat-in');
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = ''; inp.style.height = '42px';
  appendMsg('user', msg, '');
  const tid = appendTyping();
  try {
    const res = await fetch('/api/chat/stream', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message:msg, model:state.chat.model, history:state.chat.history.slice(-10) })
    });
    const data = await res.json();
    removeTyping(tid);
    const model = data.model || state.chat.model;
    appendMsg('ai', data.reply || 'No response.', MODEL_NAMES[model] || model);
    state.chat.history.push({role:'user',content:msg},{role:'assistant',content:data.reply||''});
  } catch(e) {
    removeTyping(tid);
    appendMsg('ai','Connection error — check your network.','Error');
  }
}

function appendMsg(role, text, label) {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const av = role==='ai' ? `<div class="msg-av" style="background:var(--grad)">⚡</div>` : `<div class="msg-av" style="background:var(--bg-card)">👤</div>`;
  const meta = role==='ai' ? `<div class="msg-meta"><span class="m-tag">${label||'AI'}</span></div>` : '';
  div.innerHTML = `${av}<div>${meta}<div class="msg-bub">${formatMsg(text)}</div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendTyping() {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  const id = 'typing-' + Date.now();
  div.id = id; div.className = 'msg ai';
  div.innerHTML = `<div class="msg-av" style="background:var(--grad)">⚡</div><div><div class="msg-bub"><div class="typing"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

function removeTyping(id) { document.getElementById(id)?.remove(); }

function formatMsg(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.*?)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\n/g,'<br>');
}

document.getElementById('btn-send').addEventListener('click', sendMessage);

// ── Calendar ───────────────────────────────────────────────────────────────
function calNav(dir) {
  state.cal.month += dir;
  if (state.cal.month > 11) { state.cal.month=0; state.cal.year++; }
  if (state.cal.month < 0)  { state.cal.month=11; state.cal.year--; }
  renderCalGrid();
}

function renderCalGrid() {
  const grid = document.getElementById('cal-grid');
  const label= document.getElementById('cal-month-label');
  if (!grid) return;
  const { year, month } = state.cal;
  const now = new Date();
  label.textContent = new Date(year,month).toLocaleDateString('en-US',{month:'long',year:'numeric'});
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const first = new Date(year,month,1).getDay();
  const total = new Date(year,month+1,0).getDate();
  const prevTotal = new Date(year,month,0).getDate();
  let html = days.map(d=>`<div class="cal-hd">${d}</div>`).join('');
  for (let i=0;i<first;i++) html += `<div class="cal-day other">${prevTotal-first+i+1}</div>`;
  for (let d=1;d<=total;d++) {
    const isToday = year===now.getFullYear()&&month===now.getMonth()&&d===now.getDate();
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hasEv = state.cal.events.some(e=>e.start?.dateTime?.startsWith(dateStr)||e.start?.date===dateStr);
    html += `<div class="cal-day ${isToday?'today':''} ${hasEv?'has-ev':''}" onclick="clickCalDay('${dateStr}')">${d}</div>`;
  }
  const remaining = 42 - first - total;
  for (let d=1;d<=remaining;d++) html += `<div class="cal-day other">${d}</div>`;
  grid.innerHTML = html;
}

function clickCalDay(dateStr) {
  const form = document.getElementById('add-ev-form');
  const startEl = document.getElementById('ev-start');
  const endEl = document.getElementById('ev-end');
  form.classList.add('show');
  startEl.value = dateStr + 'T09:00';
  endEl.value   = dateStr + 'T10:00';
  document.getElementById('ev-title').focus();
}

function loadCalEvents() {
  if (!FS_USER) {
    document.getElementById('cal-auth-banner').style.display = 'block';
    return;
  }
  document.getElementById('cal-auth-banner').style.display = 'none';
  fetch('/api/calendar/events').then(r=>r.json()).then(d=>{
    if (d.events) {
      state.cal.events = d.events;
      renderCalGrid();
      renderEvents(d.events);
    } else if (d.needsAuth) {
      document.getElementById('cal-auth-banner').style.display = 'block';
    }
  }).catch(()=>{});
}

function renderEvents(events) {
  const list = document.getElementById('ev-list');
  if (!list) return;
  if (!events.length) { list.innerHTML = '<div class="empty"><i class="fas fa-calendar-alt"></i><p>No upcoming events</p></div>'; return; }
  list.innerHTML = events.slice(0,10).map(ev => {
    const start = ev.start?.dateTime || ev.start?.date || '';
    const t = start ? new Date(start).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true}) : '';
    const color = ev.colorId ? '#'+['teal','sage','grape','flamingo','banana','tangerine','peacock','graphite','blueberry','lavender','tomato','basil'][parseInt(ev.colorId)-1]||'a855f7' : '#a855f7';
    return `<div class="ev-item"><div class="ev-dot" style="background:${color}"></div><div class="ev-time">${t}</div><div class="ev-sum">${ev.summary||'(no title)'}</div><button class="btn-blk" onclick="blockAroundEvent('${ev.id}')">Block</button></div>`;
  }).join('');
}

function saveCalEvent() {
  const title = document.getElementById('ev-title').value.trim();
  const start  = document.getElementById('ev-start').value;
  const end    = document.getElementById('ev-end').value;
  const desc   = document.getElementById('ev-desc').value;
  const color  = document.getElementById('ev-color-pick').value;
  if (!title || !start || !end) { notify('Title, start and end are required','error'); return; }
  const btn = document.getElementById('ev-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  fetch('/api/calendar/block', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title, start, end, description:desc, color })
  }).then(r=>r.json()).then(d=>{
    if (d.id||d.ok) {
      notify('Event created! ✓','success');
      document.getElementById('add-ev-form').classList.remove('show');
      loadCalEvents();
    } else { notify(d.error||'Could not create event','error'); }
  }).catch(()=>notify('Error creating event','error'))
  .finally(()=>{ btn.disabled=false; btn.textContent='Save Event'; });
}

function blockAroundEvent(evId) {
  const ev = state.cal.events.find(e=>e.id===evId);
  if (!ev) return;
  const start = new Date(ev.start?.dateTime||ev.start?.date);
  const blockEnd   = new Date(start); blockEnd.setMinutes(blockEnd.getMinutes()-5);
  const blockStart = new Date(blockEnd); blockStart.setMinutes(blockStart.getMinutes()-state.timer.focusMin);
  fetch('/api/calendar/block', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title:`Focus Block (before ${ev.summary})`, start:blockStart.toISOString(), end:blockEnd.toISOString(), description:'Auto-blocked by FlowState', color:'#a855f7' })
  }).then(r=>r.json()).then(d=>{
    if (d.id||d.ok) notify('Focus block created!','success'); else notify(d.error||'Could not create block','error');
  }).catch(()=>notify('Error creating block','error'));
}

// ── Metrics ────────────────────────────────────────────────────────────────
let focusChartInstance = null;
function buildMetrics() {
  const sessions = state.timer.sessions;
  const focusMin = Math.round(state.timer.totalFocusSec/60);
  const streak   = state.timer.streak || 0;
  const rate     = sessions ? Math.round((sessions/Math.max(sessions,4))*100) : 0;
  const gratitude= parseInt(localStorage.getItem('gratitude_count')||'0');
  const learnCards= state.learn.cards.length || 0;

  const cards = [
    { icon:'🎯', val:sessions, lbl:'Sessions Today', trend:'+2 vs yesterday' },
    { icon:'⏱', val:focusMin+'m', lbl:'Focus Minutes', trend:`${Math.round(focusMin/60*10)/10}h total` },
    { icon:'🔥', val:streak, lbl:'Day Streak', trend:'Keep it up!' },
    { icon:'✅', val:rate+'%', lbl:'Completion Rate', trend:'4-session goal' },
    { icon:'🙏', val:gratitude, lbl:'Gratitude Entries', trend:'Daily practice' },
    { icon:'📚', val:learnCards, lbl:'Cards Learned', trend:'Spaced repetition' },
  ];

  document.getElementById('metrics-grid').innerHTML = cards.map(c=>`<div class="m-card"><div class="m-icon">${c.icon}</div><div class="m-val">${c.val}</div><div class="m-lbl">${c.lbl}</div><div class="m-trend">${c.trend}</div></div>`).join('');

  // Real weekly data from localStorage
  const weekData = [];
  const today = new Date();
  for (let i=6;i>=0;i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const key = 'sessions_' + d.toISOString().slice(0,10);
    weekData.push(parseInt(localStorage.getItem(key)||'0'));
  }
  // Add today's sessions to localStorage
  const todayKey = 'sessions_' + today.toISOString().slice(0,10);
  localStorage.setItem(todayKey, sessions);

  const ctx = document.getElementById('focus-chart')?.getContext('2d');
  if (!ctx) return;
  if (focusChartInstance) focusChartInstance.destroy();
  focusChartInstance = new Chart(ctx, {
    type:'bar',
    data: {
      labels: Array.from({length:7},(_, i)=>{ const d=new Date(today); d.setDate(d.getDate()-(6-i)); return d.toLocaleDateString('en-US',{weekday:'short'}); }),
      datasets:[{ data:weekData, backgroundColor:'rgba(168,85,247,.6)', borderColor:'#a855f7', borderWidth:2, borderRadius:8 }]
    },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{beginAtZero:true,ticks:{color:'#555'},grid:{color:'rgba(168,85,247,.07)'}}, x:{ticks:{color:'#555'},grid:{display:false}} }, animation:{duration:600} }
  });
  loadBehaviorInsight();
}

function loadBehaviorInsight() {
  const params = new URLSearchParams({
    focusMin: Math.round(state.timer.totalFocusSec/60),
    sessions: state.timer.sessions,
    streak: state.timer.streak || 0,
    breaks: state.timer.sessions,
    gratitude: localStorage.getItem('gratitude_count')||'0'
  });
  fetch('/api/behavior/insight?' + params).then(r=>r.json()).then(d=>{
    document.getElementById('ins-hl').textContent = d.headline || 'Keep building momentum!';
    document.getElementById('ins-detail').textContent = d.detail || '';
    document.getElementById('ins-rec').textContent = d.recommendation || '';
    const src = document.getElementById('ins-src');
    if (src) src.innerHTML = (d.sources||[]).map(s=>`<span class="src-badge">${s}</span>`).join('');
    if (d.flowScore) document.getElementById('ins-score').textContent = d.flowScore;
  }).catch(()=>{ document.getElementById('ins-hl').textContent='Session data captured. Keep focusing!'; });
}

// ── Board / Kanban ─────────────────────────────────────────────────────────
function buildBoard() {
  if (FS_NOTION) {
    document.getElementById('board-notion-panel').style.display = 'none';
    document.getElementById('board-db-select').style.display = 'block';
    loadNotionDbs();
  } else {
    document.getElementById('board-notion-panel').style.display = 'block';
    document.getElementById('board-db-select').style.display = 'none';
    renderLocalKanban();
  }
}

function renderLocalKanban() {
  const cols = [
    { id:'todo', label:'To Do', color:'var(--text-m)' },
    { id:'inprogress', label:'In Progress', color:'var(--warn)' },
    { id:'done', label:'Done', color:'var(--green)' },
  ];
  const board = document.getElementById('board-wrap');
  board.innerHTML = cols.map(col => {
    const tasks = state.kanban.tasks[col.id] || [];
    const cards = tasks.map((t,i) => `
      <div class="k-card" draggable="true" ondragstart="dragStart(event,'${col.id}',${i})" ondragover="event.preventDefault()" ondrop="drop(event,'${col.id}',${i})">
        <button class="k-del" onclick="deleteLocalTask('${col.id}',${i})"><i class="fas fa-times"></i></button>
        <div class="k-card-title">${escHtml(t.title)}</div>
        <div class="k-card-meta">${t.tags?.map(tag=>`<span class="k-tag">${tag}</span>`).join('')||''}</div>
      </div>`).join('');
    return `<div class="k-col" ondragover="event.preventDefault()" ondrop="dropOnCol(event,'${col.id}')">
      <div class="k-col-hd"><span class="k-col-title" style="color:${col.color}">${col.label}</span><span class="k-count">${tasks.length}</span></div>
      <div class="k-cards" id="kcol-${col.id}">${cards}</div>
      <button class="k-add-btn" onclick="addLocalTask('${col.id}')"><i class="fas fa-plus"></i> Add Task</button>
    </div>`;
  }).join('');
}

function addLocalTask(colId) {
  const title = prompt('Task title:');
  if (!title?.trim()) return;
  state.kanban.tasks[colId].push({ title:title.trim(), tags:[], id:Date.now() });
  saveLocalState();
  renderLocalKanban();
  notify('Task added','success');
}

function deleteLocalTask(colId, idx) {
  state.kanban.tasks[colId].splice(idx, 1);
  saveLocalState();
  renderLocalKanban();
}

let _dragData = null;
function dragStart(e, colId, idx) { _dragData = {colId, idx}; e.dataTransfer.effectAllowed='move'; }
function drop(e, toCol, toIdx) {
  e.preventDefault();
  if (!_dragData) return;
  const { colId, idx } = _dragData;
  const task = state.kanban.tasks[colId].splice(idx, 1)[0];
  state.kanban.tasks[toCol].splice(toIdx, 0, task);
  _dragData = null;
  saveLocalState();
  renderLocalKanban();
}
function dropOnCol(e, toCol) {
  e.preventDefault();
  if (!_dragData) return;
  const { colId, idx } = _dragData;
  const task = state.kanban.tasks[colId].splice(idx, 1)[0];
  state.kanban.tasks[toCol].push(task);
  _dragData = null;
  saveLocalState();
  renderLocalKanban();
}

// ── Notion Kanban ──────────────────────────────────────────────────────────
function connectNotion() { window.open('/api/auth/notion','_blank','width=480,height=600'); }

function loadNotionDbs() {
  fetch('/api/notion/databases').then(r=>r.json()).then(d=>{
    const list = document.getElementById('notion-db-list');
    if (!list) return;
    if (!d.databases?.length) { list.innerHTML='<div class="empty"><p>No databases found</p></div>'; return; }
    list.innerHTML = d.databases.map(db=>`<div class="notion-db" onclick="selectNotionDb('${db.id}','${escHtml(db.title)}')">${db.icon||'📋'} ${db.title}</div>`).join('');
  }).catch(()=>{});
}

function selectNotionDb(dbId, title) {
  state.kanban.notionDb = dbId;
  document.querySelectorAll('.notion-db').forEach(d=>d.classList.remove('sel'));
  document.querySelector(`.notion-db[onclick*="${dbId}"]`)?.classList.add('sel');
  loadNotionPages(dbId);
}

function loadNotionPages(dbId) {
  fetch('/api/notion/pages/'+dbId).then(r=>r.json()).then(d=>{
    if (d.pages) renderKanban(d.pages);
  }).catch(()=>{});
}

function renderKanban(pages) {
  const groups = { todo:[], inprogress:[], done:[] };
  pages.forEach(p=>{
    const s = (p.status||'').toLowerCase().replace(/[\s-_]/g,'');
    if (s.includes('progress')||s.includes('doing')) groups.inprogress.push(p);
    else if (s.includes('done')||s.includes('complete')) groups.done.push(p);
    else groups.todo.push(p);
  });
  const cols = [
    { id:'todo', label:'To Do', color:'var(--text-m)', items:groups.todo },
    { id:'inprogress', label:'In Progress', color:'var(--warn)', items:groups.inprogress },
    { id:'done', label:'Done', color:'var(--green)', items:groups.done },
  ];
  document.getElementById('board-wrap').innerHTML = cols.map(col=>`
    <div class="k-col" ondragover="event.preventDefault()" ondrop="dropNotionCard(event,'${col.id}')">
      <div class="k-col-hd"><span class="k-col-title" style="color:${col.color}">${col.label}</span><span class="k-count">${col.items.length}</span></div>
      <div class="k-cards" id="kcol-${col.id}">
        ${col.items.map(p=>`<div class="k-card" draggable="true" data-id="${p.id}" ondragstart="dragNotionCard(event,'${p.id}','${col.id}')">
          <div class="k-card-title">${escHtml(p.title||'Untitled')}</div>
          <div class="k-card-meta"><span class="k-tag">${p.status||'—'}</span></div>
        </div>`).join('')}
      </div>
    </div>`).join('');
}

let _nDrag = null;
function dragNotionCard(e, id, fromCol) { _nDrag={id,fromCol}; e.dataTransfer.effectAllowed='move'; }
function dropNotionCard(e, toCol) {
  e.preventDefault();
  if (!_nDrag) return;
  const statusMap = { todo:'To Do', inprogress:'In Progress', done:'Done' };
  fetch('/api/notion/pages/'+_nDrag.id, {
    method:'PATCH', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ status:statusMap[toCol] })
  }).then(()=>{ loadNotionPages(state.kanban.notionDb); notify('Task moved','success'); }).catch(()=>notify('Error moving task','error'));
  _nDrag = null;
}

// ── Team ───────────────────────────────────────────────────────────────────
function buildTeam() {
  buildSprintHealth();
  buildTeamPulse();
}

function buildSprintHealth() {
  const payload = {
    totalTasks: 12, completedTasks: 7, inProgressTasks: 3,
    sprintDaysTotal: 14, sprintDaysRemaining: 4, velocity: 2.1, blockers: 1
  };
  fetch('/api/team/sprint-health', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  }).then(r=>r.json()).then(d=>{
    const sh = d.sprintHealth || {};
    const pct = sh.completionPct || Math.round(payload.completedTasks/payload.totalTasks*100);
    const exp = sh.expectedPct   || Math.round((1-payload.sprintDaysRemaining/payload.sprintDaysTotal)*100);
    document.getElementById('sh-fill').style.width = pct+'%';
    document.getElementById('sh-pct').textContent = pct+'%';
    document.getElementById('sh-exp').textContent = exp+'%';
    document.getElementById('sh-days').textContent = payload.sprintDaysRemaining + ' days left';
    document.getElementById('sh-stats').innerHTML = [
      {v:payload.totalTasks,l:'Total'},{v:payload.completedTasks,l:'Done'},
      {v:payload.inProgressTasks,l:'In Progress'},{v:payload.sprintDaysRemaining,l:'Days Left'}
    ].map(s=>`<div class="sh-stat"><div class="sh-stat-v">${s.v}</div><div class="sh-stat-l">${s.l}</div></div>`).join('');
    const pace = sh.pace||'on-track';
    document.getElementById('sh-pace').innerHTML = `<span class="pace-badge" style="background:${pace==='on-track'?'rgba(16,185,129,.15)':pace==='ahead'?'rgba(59,130,246,.15)':'rgba(239,68,68,.15)'};color:${pace==='on-track'?'var(--green)':pace==='ahead'?'var(--blue)':'var(--danger)'}">${pace.toUpperCase()}</span>`;
    document.getElementById('sh-assessment').textContent = sh.assessment || 'Sprint is progressing well. Continue current velocity.';
    const actions = sh.actions || ['Review blockers','Update task statuses'];
    document.getElementById('sh-actions').innerHTML = actions.map(a=>`<div class="action-item"><i class="fas fa-circle-arrow-right"></i>${a}</div>`).join('');
  }).catch(()=>{
    document.getElementById('sh-assessment').textContent = 'Sprint data loading...';
  });
}

const DEMO_TEAM = [
  { name:'Alex Chen', role:'senior_dev', status:'focus', wellness:82, av:'👩' },
  { name:'Jordan Lee', role:'scrum_master', status:'break', wellness:55, av:'🧑' },
  { name:'Sam Rivera', role:'member', status:'online', wellness:35, av:'👨' },
  { name:'Taylor Kim', role:'member', status:'offline', wellness:71, av:'🧑' },
];

function buildTeamPulse() {
  const grid = document.getElementById('team-pulse-grid');
  const role = FS_USER?.role || 'member';
  const showWellness = role==='admin'||role==='scrum_master';
  grid.innerHTML = DEMO_TEAM.map(m=>{
    const wellnessColor = m.wellness>70?'var(--green)':m.wellness>40?'var(--warn)':'var(--danger)';
    return `<div class="member-card">
      <div class="pulse-dot ${m.status}"></div>
      <div class="member-av">${m.av}</div>
      <div class="member-name">${m.name}</div>
      <div class="member-role">${m.role}</div>
      <div style="font-size:11px;color:var(--text-m)">${{focus:'In focus session',online:'Online',break:'On break',offline:'Offline'}[m.status]||m.status}</div>
      ${showWellness ? `<div class="burnout-bar"><div class="burnout-fill" style="width:${100-m.wellness}%;background:${wellnessColor}"></div></div><div style="font-size:10px;color:${wellnessColor};margin-top:3px">Wellness: ${m.wellness}/100</div>` : ''}
    </div>`;
  }).join('');
}

// ── Slack Modal ─────────────────────────────────────────────────────────────
function openSlackModal() {
  if (!FS_SLACK) { notify('Connect Slack first (Settings → Integrations)','info'); return; }
  fetch('/api/slack/channels').then(r=>r.json()).then(d=>{
    const channels = d.channels || [];
    openModal(`<h2>💬 Send Slack Message</h2>
      <div style="margin-top:14px">
        <label style="font-size:12px;color:var(--text-m)">Channel</label>
        <select class="fs-sel" id="sl-chan" style="width:100%;margin:6px 0 12px">${channels.map(c=>`<option value="${c.id}">#${c.name}</option>`).join('')}</select>
        <label style="font-size:12px;color:var(--text-m)">Message</label>
        <textarea class="chat-in" id="sl-msg" style="width:100%;height:80px;margin-top:6px" placeholder="Type your message..."></textarea>
        <div style="margin-top:10px;display:flex;gap:8px">
          <button class="btn-primary" onclick="sendTestSlack()" style="flex:1">Send</button>
          <button class="btn-sm" onclick="closeModal()">Cancel</button>
        </div>
      </div>`);
  }).catch(()=>notify('Could not load channels','error'));
}

function sendTestSlack() {
  const chan = document.getElementById('sl-chan')?.value;
  const msg  = document.getElementById('sl-msg')?.value;
  if (!msg?.trim()) { notify('Enter a message','error'); return; }
  fetch('/api/slack/message', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ channel:chan, message:msg })
  }).then(r=>r.json()).then(d=>{ if(d.ok) { closeModal(); notify('Message sent!','success'); } else notify(d.error||'Send failed','error'); }).catch(()=>notify('Error sending','error'));
}

// ── Learn ──────────────────────────────────────────────────────────────────
function loadLearnCards() {
  fetch('/api/learn/cards').then(r=>r.json()).then(d=>{
    state.learn.cards = d.cards || d || [];
    renderLearn();
  }).catch(()=>{ state.learn.cards = getFallbackCards(); renderLearn(); });
}

function getFallbackCards() {
  return [
    { type:'Tip',title:'Pomodoro Principle',content:'Work in 25-minute focused sprints. Your brain consolidates memory during the micro-break between sessions.',color:'#a855f7',textColor:'#fff',source:'Flow Science' },
    { type:'Mindset',title:'Implementation Intentions',content:"Research shows 'I will do X at Y time in Z location' increases follow-through by 91%.",color:'#3b82f6',textColor:'#fff',source:'Psychology' },
    { type:'Health',title:'The 20-20-20 Rule',content:'Every 20 minutes, look at something 20 feet away for 20 seconds to prevent eye strain.',color:'#10b981',textColor:'#fff',source:'Optometry' },
    { type:'Productivity',title:'Eat the Frog',content:"Do your most important/hardest task first. Mark Twain: 'If you eat a frog first thing in the morning, the rest of the day will be wonderful.'",color:'#ec4899',textColor:'#fff',source:'Time Management' },
  ];
}

function renderLearn() {
  const car = document.getElementById('learn-car');
  const nav = document.getElementById('l-nav');
  const all = document.getElementById('all-learn-cards');
  const cards = state.learn.cards;
  if (!cards.length || !car) return;
  const c = cards[state.learn.idx];
  car.innerHTML = `<div class="l-card" style="background:${c.color||'var(--bg-panel)'};color:${c.textColor||'var(--text-p)'}"><div class="l-type">${c.type||'Tip'}</div><div class="l-title">${c.title||''}</div><div class="l-content">${c.content||''}</div><div class="l-meta">${c.source||''}</div></div>`;
  if (nav) nav.innerHTML = `<button class="l-nav-btn" onclick="learnNav(-1)"><i class="fas fa-chevron-left"></i></button>${cards.map((_,i)=>`<div class="l-dot ${i===state.learn.idx?'active':''}" onclick="learnGo(${i})"></div>`).join('')}<button class="l-nav-btn" onclick="learnNav(1)"><i class="fas fa-chevron-right"></i></button>`;
  if (all) all.innerHTML = cards.map((card,i)=>`<div style="background:${card.color||'var(--bg-panel)'};border-radius:9px;padding:11px;cursor:pointer;color:${card.textColor||'var(--text-p)'}" onclick="learnGo(${i})"><div style="font-size:10px;font-weight:700;opacity:.7;margin-bottom:3px">${card.type||''}</div><div style="font-size:12px;font-weight:700">${card.title||''}</div></div>`).join('');
}

function learnNav(dir) { state.learn.idx = (state.learn.idx + dir + state.learn.cards.length) % state.learn.cards.length; renderLearn(); }
function learnGo(i)   { state.learn.idx = i; renderLearn(); }

// ── Restore ─────────────────────────────────────────────────────────────────
const RESTORE_SCENES = [
  {
    emoji:'🌬️', title:'Box Breathing', gradient:'linear-gradient(135deg,#3b82f6,#06b6d4)',
    steps:['Inhale for 4 seconds','Hold for 4 seconds','Exhale for 4 seconds','Hold for 4 seconds'],
    type:'breathing'
  },
  {
    emoji:'🙏', title:'Gratitude Moment', gradient:'linear-gradient(135deg,#a855f7,#ec4899)',
    content:'Take a moment to appreciate what went well today. Gratitude rewires the brain for positivity and resilience.',
    type:'gratitude'
  },
  {
    emoji:'🌊', title:'Mindful Reset', gradient:'linear-gradient(135deg,#10b981,#06b6d4)',
    content:'Close your eyes. Take 3 deep breaths. Let thoughts pass like clouds. You are present, focused, and capable.',
    type:'mindful'
  },
];

function loadRestore() {
  state.restore.scenes = RESTORE_SCENES;
  renderRestore();
}

function renderRestore() {
  const s = state.restore.scenes[state.restore.idx];
  const scene = document.getElementById('r-scene');
  const nav   = document.getElementById('r-nav');
  if (!scene || !s) return;
  let inner = `<div class="r-emoji">${s.emoji}</div><div class="r-title">${s.title}</div>`;
  if (s.type==='breathing') {
    inner += `<div class="breath-circ" id="breath-circ" onclick="pulseBreath()" title="Click to breathe">Tap</div><div class="r-steps">${s.steps.map((st,i)=>`<div class="r-step"><div class="r-step-n">${i+1}</div>${st}</div>`).join('')}</div>`;
  } else if (s.type==='gratitude') {
    inner += `<div class="r-content">${s.content}</div><input class="grat-in" id="grat-in" placeholder="I'm grateful for..."><button class="r-btn" onclick="logGratitude()">Log It 🙏</button>`;
  } else {
    inner += `<div class="r-content">${s.content}</div>`;
  }
  scene.innerHTML = inner; scene.style.background = s.gradient;
  if (nav) nav.innerHTML = `<button class="r-btn" onclick="restoreNav(-1)"><i class="fas fa-chevron-left"></i></button><button class="r-btn" onclick="restoreNav(1)"><i class="fas fa-chevron-right"></i></button>`;
}

let breathPhase = 0;
function pulseBreath() {
  const circ = document.getElementById('breath-circ');
  if (!circ) return;
  const phases = [{label:'Inhale',expand:true,dur:4000},{label:'Hold',expand:true,dur:4000},{label:'Exhale',expand:false,dur:4000},{label:'Hold',expand:false,dur:4000}];
  const ph = phases[breathPhase % phases.length];
  circ.textContent = ph.label;
  circ.classList.toggle('expand', ph.expand);
  breathPhase++;
  setTimeout(()=>{ if(circ) circ.textContent='Tap'; circ?.classList.remove('expand'); }, ph.dur);
}

function logGratitude() {
  const val = document.getElementById('grat-in')?.value?.trim();
  if (!val) { notify('Write something first','info'); return; }
  const count = parseInt(localStorage.getItem('gratitude_count')||'0') + 1;
  localStorage.setItem('gratitude_count', count);
  const prev = JSON.parse(localStorage.getItem('gratitude_log')||'[]');
  prev.unshift({ text:val, date:new Date().toLocaleDateString() });
  localStorage.setItem('gratitude_log', JSON.stringify(prev.slice(0,30)));
  notify('Gratitude logged 🙏','success');
  document.getElementById('grat-in').value = '';
}

function restoreNav(dir) {
  state.restore.idx = (state.restore.idx + dir + state.restore.scenes.length) % state.restore.scenes.length;
  renderRestore();
}

// ── Generate ───────────────────────────────────────────────────────────────
async function generateImage() {
  const prompt = document.getElementById('img-prompt').value.trim();
  const model  = document.getElementById('img-model-sel').value;
  if (!prompt) { notify('Enter a prompt','error'); return; }
  const btn = document.getElementById('btn-gen-img'); btn.disabled=true; btn.textContent='Generating...';
  try {
    const r = await fetch('/api/generate/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model})});
    const d = await r.json();
    const results = document.getElementById('img-results');
    if (d.imageUrl) results.innerHTML = `<img class="gen-img" src="${d.imageUrl}" alt="${escHtml(prompt)}" onclick="window.open('${d.imageUrl}')">`;
    else if (d.imageBase64) results.innerHTML = `<img class="gen-img" src="data:image/jpeg;base64,${d.imageBase64}" alt="${escHtml(prompt)}">`;
    else results.innerHTML = `<div style="color:var(--danger);font-size:13px">${d.error||'Generation failed'}</div>`;
  } catch(e) { notify('Image generation error','error'); }
  finally { btn.disabled=false; btn.innerHTML='<i class="fas fa-wand-magic-sparkles"></i>&nbsp; Generate Image'; }
}

async function generateVideo() {
  const prompt = document.getElementById('vid-prompt').value.trim();
  const model  = document.getElementById('vid-model-sel').value;
  const dur    = document.getElementById('vid-dur').value;
  if (!prompt) { notify('Enter a prompt','error'); return; }
  const btn = document.getElementById('btn-gen-vid'); btn.disabled=true; btn.textContent='Queuing...';
  try {
    const r = await fetch('/api/generate/video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model,duration:parseInt(dur)})});
    const d = await r.json();
    document.getElementById('vid-result').innerHTML = d.queued ? `<i class="fas fa-clock" style="color:var(--warn)"></i> ${d.message||'Video queued for generation.'}` : (d.videoUrl ? `<video src="${d.videoUrl}" controls style="width:100%;border-radius:11px"></video>` : `<span style="color:var(--danger)">${d.error||'Generation failed'}</span>`);
  } catch(e) { notify('Video generation error','error'); }
  finally { btn.disabled=false; btn.innerHTML='<i class="fas fa-film"></i>&nbsp; Generate Video'; }
}

// ── Utilities ──────────────────────────────────────────────────────────────
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openModal(html) {
  const ov = document.createElement('div'); ov.className='modal-ov'; ov.id='modal-ov';
  ov.innerHTML = `<div class="modal-card">${html}<div style="margin-top:14px;text-align:right"><button class="btn-sm" onclick="closeModal()">Close</button></div></div>`;
  ov.addEventListener('click', e => { if(e.target===ov) closeModal(); });
  document.body.appendChild(ov);
}

function closeModal() { document.getElementById('modal-ov')?.remove(); }

function openPricingModal() {
  const tiers = [
    { name:'Free', price:'$0', color:'var(--text-s)', feats:['7 AI models','25-min Pomodoro','Basic Kanban','3 team members'] },
    { name:'Pro', price:'$12/mo', color:'var(--accent)', feats:['All models + DALL-E','Unlimited sessions','Calendar sync','Advanced metrics'], hi:true },
    { name:'Team', price:'$49/mo', color:'var(--blue)', feats:['Unlimited members','Sprint intelligence','Slack/Notion sync','Role-gated controls'] },
    { name:'Enterprise', price:'Custom', color:'var(--warn)', feats:['SSO/SAML','Audit logs','Custom models','SLA support'] },
  ];
  openModal(`<h2>⚡ FlowState Pro</h2><p style="color:var(--text-s);font-size:13px;margin-top:4px">Upgrade to unlock the full workspace</p>
    <div class="tier-cards">${tiers.map(t=>`<div class="t-card ${t.hi?'hi':''}" onclick="startCheckout('${t.name}')"><h3 style="color:${t.color}">${t.name}</h3><div class="price">${t.price}</div><ul class="t-feats">${t.feats.map(f=>`<li>${f}</li>`).join('')}</ul></div>`).join('')}</div>`);
}

function startCheckout(tier) {
  if (!FS_USER && !state.settings.isDemo) { notify('Sign in to upgrade','info'); return; }
  fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tier})}).then(r=>r.json()).then(d=>{
    if(d.checkoutUrl) window.open(d.checkoutUrl,'_blank'); else notify(d.message||'Opening checkout...','info');
  }).catch(()=>notify('Billing error','error'));
}

function openCredsModal() {
  fetch('/api/credentials').then(r=>r.json()).then(d=>{
    const rows = (d.credentials||[]).map(c=>`<tr><td>${c.service}</td><td style="color:var(--text-m)">${c.purpose}</td><td style="font-family:monospace;font-size:11px">${c.envKey}</td><td><span class="badge-${c.required==='core'?'core':c.required==='recommended'?'rec':'opt'}">${c.required}</span></td><td><a href="${c.url||c.docs||'#'}" target="_blank">Docs</a></td></tr>`).join('');
    openModal(`<h2>🔑 API Credentials</h2><p style="color:var(--text-s);font-size:13px;margin-top:4px">All keys stored as Cloudflare Secrets — never in client code</p><table class="cred-tbl"><thead><tr><th>Service</th><th>Purpose</th><th>Env Key</th><th>Required</th><th>Docs</th></tr></thead><tbody>${rows}</tbody></table>`);
  }).catch(()=>notify('Could not load credentials','error'));
}

function openInviteModal() {
  if (!FS_USER && !state.settings.isDemo) { notify('Sign in to invite teammates','info'); return; }
  fetch('/api/invite/generate',{method:'POST'}).then(r=>r.json()).then(d=>{
    const code = d.inviteCode||d.intent?.inviteCode||'FLOW-DEMO';
    const url  = d.inviteUrl ||d.intent?.inviteUrl ||window.location.origin+'?invite='+code;
    openModal(`<div class="invite-box"><h2>🎉 Invite Your Team</h2><p style="color:var(--text-s);font-size:13px;margin-top:6px">Share this link to invite teammates to FlowState</p><div class="invite-code">${code}</div><input class="fs-in" value="${url}" readonly style="text-align:center;margin-bottom:11px" id="invite-url"><button class="btn-primary" onclick="navigator.clipboard.writeText(document.getElementById('invite-url').value).then(()=>notify('Link copied!','success'))"><i class="fas fa-copy"></i> Copy Link</button><div style="margin-top:12px;font-size:12px;color:var(--text-m)">You and your invitee each get 7 days of Pro free.</div></div>`);
  }).catch(()=>notify('Error generating invite','error'));
}

function openSettingsModal() {
  const isSigned = !!FS_USER;
  openModal(`<h2>⚙️ Settings</h2>
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">FOCUS DURATION</div>
      <div style="display:flex;gap:8px">${[25,45,90].map(m=>`<button class="btn-sm ${state.timer.focusMin===m?'btn-primary':''}" onclick="updateFocusDur(${m})">${m}m</button>`).join('')}</div>
    </div>
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">INTEGRATIONS</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span>📅 Google Calendar</span><span style="color:${FS_USER?'var(--green)':'var(--text-m)'}">${FS_USER?'Connected ✓':'Connect via Login'}</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span>📝 Notion</span><button class="btn-sm" onclick="connectNotion()">${FS_NOTION?'Reconnect':'Connect'}</button></div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span>💬 Slack</span><button class="btn-sm" onclick="connectSlack()">${FS_SLACK?'Reconnect':'Connect'}</button></div>
      </div>
    </div>
    ${isSigned ? '<button class="btn-sm" style="color:var(--danger);border-color:var(--danger);width:100%;margin-top:8px" onclick="signOut()">Sign Out</button>' : ''}`);
}

function updateFocusDur(m) {
  state.timer.focusMin = m;
  state.settings.focusMin = m;
  if (!state.timer.running) { state.timer.elapsed=0; updateTimerDisplay(); }
  saveLocalState();
  closeModal();
  notify(`Focus duration: ${m} min`,'success');
}

function connectSlack() { window.open('/api/auth/slack','_blank','width=480,height=600'); }

function signOut() {
  fetch('/api/auth/logout',{method:'POST'}).then(()=>window.location.href='/').catch(()=>window.location.href='/');
}

// ── Tips ───────────────────────────────────────────────────────────────────
const TIPS = [
  { emoji:'💧', cat:'Hydration', msg:'Drink a glass of water now. Dehydration reduces cognitive performance by up to 20%.' },
  { emoji:'👀', cat:'Eye Health', msg:'20-20-20 rule: Look at something 20 feet away for 20 seconds.' },
  { emoji:'🚶', cat:'Movement', msg:'Stand up and take 10 steps. Brief movement resets focus and boosts blood flow.' },
  { emoji:'🌬️', cat:'Breathing', msg:'Box breathe: 4 in, 4 hold, 4 out, 4 hold. Resets your nervous system.' },
  { emoji:'🙏', cat:'Gratitude', msg:'Name one thing that went well today. Gratitude builds resilience.' },
];
let tipShown = false;
function maybeShowTip() {
  setTimeout(()=>{
    if (tipShown) return;
    const tip = TIPS[Math.floor(Math.random()*TIPS.length)];
    const el = document.createElement('div'); el.className='tip-bub'; el.id='tip-bub';
    el.innerHTML = `<button class="tip-x" onclick="document.getElementById('tip-bub').remove()">✕</button><div class="tip-hd"><span class="tip-emoji">${tip.emoji}</span><span class="tip-cat">${tip.cat}</span></div><div class="tip-msg">${tip.msg}</div>`;
    document.body.appendChild(el);
    tipShown = true;
    setTimeout(()=>document.getElementById('tip-bub')?.remove(), 9000);
  }, 90000);
}

// ── Celebration ────────────────────────────────────────────────────────────
function triggerCelebration(title, sub) {
  const ov = document.createElement('div'); ov.className='celeb-ov';
  ov.innerHTML = `<div class="celeb-card"><span class="celeb-emoji">🎉</span><div class="celeb-title">${title}</div><div class="celeb-sub">${sub}</div></div>`;
  document.body.appendChild(ov);
  spawnConfetti(60);
  setTimeout(()=>ov.remove(), 4000);
}

function spawnConfetti(count) {
  const colors = ['#a855f7','#ec4899','#3b82f6','#10b981','#f59e0b','#ef4444'];
  for (let i=0;i<count;i++) {
    const el = document.createElement('div'); el.className='confetti-p';
    el.style.cssText = `left:${Math.random()*100}vw;top:-10px;background:${colors[i%colors.length]};--tx:${(Math.random()-0.5)*200}px;--ty:${80+Math.random()*120}vh;animation-duration:${1.5+Math.random()*2}s;animation-delay:${Math.random()*.5}s`;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), 4000);
  }
}

// ── Notify ─────────────────────────────────────────────────────────────────
function notify(msg, type='info') {
  const colors = { success:'var(--green)', error:'var(--danger)', info:'var(--blue)', warning:'var(--warn)' };
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid ${colors[type]||colors.info};color:${colors[type]||colors.info};padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.4);animation:fadeUp .2s ease;white-space:nowrap`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 3000);
}

// ── Keyboard Shortcuts ─────────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key==='Enter') { e.preventDefault(); sendMessage(); }
    if (e.key===' ' && e.target.tagName!=='INPUT' && e.target.tagName!=='TEXTAREA') { e.preventDefault(); toggleTimer(); }
    if (e.key==='Escape') closeModal();
    if (mod && e.key==='m') { e.preventDefault(); switchTab('chat'); }
  });
  const inp = document.getElementById('chat-in');
  if (inp) inp.addEventListener('input', () => { inp.style.height='42px'; inp.style.height=Math.min(inp.scrollHeight,130)+'px'; });
}

// ── Clawbot ────────────────────────────────────────────────────────────────
let clawbotHistory = [];
let clawbotSubscriptionActive = false;
let clawbotInited = false;

async function initClawbot() {
  if (clawbotInited) return;
  clawbotInited = true;
  try {
    const r = await fetch('/api/clawbot/status');
    const d = await r.json();
    clawbotSubscriptionActive = d.subscriptionActive;
    if (d.subscriptionActive) {
      document.getElementById('clawbot-gate').style.display = 'none';
      document.getElementById('clawbot-active').style.display = 'flex';
      const badge = document.getElementById('clawbot-coins-badge');
      if (badge) badge.textContent = `⚡ ${d.coinsRemaining} coins`;
    } else {
      document.getElementById('clawbot-gate').style.display = 'block';
      document.getElementById('clawbot-active').style.display = 'none';
      loadClawbotPromo();
    }
  } catch(e) {
    document.getElementById('clawbot-gate').style.display = 'block';
    document.getElementById('clawbot-active').style.display = 'none';
    loadClawbotPromo();
  }
  // Wire up send button
  const sendBtn = document.getElementById('clawbot-send');
  if (sendBtn) sendBtn.addEventListener('click', sendClawbotMessage);
  const inp = document.getElementById('clawbot-in');
  if (inp) {
    inp.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendClawbotMessage(); }
    });
    inp.addEventListener('input', () => { inp.style.height='42px'; inp.style.height=Math.min(inp.scrollHeight,130)+'px'; });
  }
}

async function loadClawbotPromo() {
  try {
    const r = await fetch('/api/clawbot/promo');
    const d = await r.json();
    const el = document.getElementById('clawbot-promo');
    if (!el) return;
    el.innerHTML = `
      <div class="clawbot-promo-logo">🦾</div>
      <div class="clawbot-promo-title">${d.headline}</div>
      <div class="clawbot-promo-sub">Your AI brain for 264 Pro, Flowstate Audio &amp; Hub. Agentic workflows, walkthrough generation, and smart automation — all in one.</div>
      <div class="clawbot-price-row">
        <span class="clawbot-orig-price">${d.originalPrice}</span>
        <span class="clawbot-new-price">${d.promoPrice}</span>
        <span class="clawbot-discount">${d.discount}</span>
      </div>
      <ul class="clawbot-features">${d.features.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul>
      <button class="clawbot-cta" onclick="startClawFlowCheckout()">${escHtml(d.cta)}</button>
    `;
  } catch(e) {
    const el = document.getElementById('clawbot-promo');
    if (el) el.innerHTML = `<div class="clawbot-promo-logo">🦾</div><div class="clawbot-promo-title">Unlock Clawbot</div><div class="clawbot-promo-sub">Add CLAWBOT_API_KEY to your Cloudflare secrets to activate ClawFlow.</div>`;
  }
}

function startClawFlowCheckout() {
  if (!FS_USER && !state.settings.isDemo) { notify('Sign in to subscribe to ClawFlow','info'); return; }
  fetch('/api/billing/checkout', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tier:'clawflow' }) })
    .then(r=>r.json()).then(d => {
      if (d.checkoutUrl) window.open(d.checkoutUrl,'_blank');
      else notify(d.message || 'Add CLAWBOT_API_KEY to Cloudflare secrets to activate','info');
    }).catch(() => notify('Add CLAWBOT_API_KEY to Cloudflare secrets to activate ClawFlow','info'));
}

async function sendClawbotMessage() {
  const inp = document.getElementById('clawbot-in');
  const msg = inp ? inp.value.trim() : '';
  if (!msg) return;
  if (inp) { inp.value=''; inp.style.height='42px'; }

  appendClawbotMsg('user', msg, '');
  const tid = appendClawbotTyping();
  const appCtx = document.getElementById('clawbot-app-ctx')?.value || 'flowstate_hub';

  try {
    const res = await fetch('/api/clawbot/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message:msg, app:appCtx, history:clawbotHistory.slice(-8) })
    });
    const data = await res.json();
    removeTyping(tid);

    if (data.error === 'clawflow_required') {
      appendClawbotMsg('ai', '🦾 ClawFlow subscription required to continue. Upgrade below ↓', 'Clawbot');
      document.getElementById('clawbot-active').style.display = 'none';
      document.getElementById('clawbot-gate').style.display = 'block';
      loadClawbotPromo();
      return;
    }

    const reply = data.reply || 'No response.';
    appendClawbotMsg('ai', reply, `Clawbot · ${data.coinCost || 0} coins`);
    clawbotHistory.push({ role:'user', content:msg }, { role:'assistant', content:reply });

    // Update coin badge
    const badge = document.getElementById('clawbot-coins-badge');
    if (badge && data.coinCost) {
      const cur = parseInt(badge.textContent.replace(/[^0-9]/g,'')) || 500;
      badge.textContent = `⚡ ${Math.max(0, cur - data.coinCost)} coins`;
    }

    // Proactively offer walkthrough if user seems stuck
    if (/how|stuck|help|tutorial|walkthrough|can't|doesn't work|not working/i.test(msg) && Math.random() > 0.4) {
      setTimeout(() => offerWalkthrough(msg, appCtx), 1200);
    }
  } catch(e) {
    removeTyping(tid);
    appendClawbotMsg('ai','Connection error — check your network.','Error');
  }
}

function appendClawbotMsg(role, text, label) {
  const msgs = document.getElementById('clawbot-msgs');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const av = role==='ai'
    ? `<div class="msg-av" style="background:linear-gradient(135deg,#a855f7,#06b6d4)">🦾</div>`
    : `<div class="msg-av" style="background:var(--bg-card)">👤</div>`;
  const meta = role==='ai'
    ? `<div class="msg-meta"><span class="m-tag" style="background:rgba(6,182,212,.15);color:#06b6d4">Clawbot</span><span style="font-size:11px;color:var(--text-m)">${label}</span></div>`
    : '';
  div.innerHTML = `${av}<div>${meta}<div class="msg-bub">${formatMsg(text)}</div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendClawbotTyping() {
  const msgs = document.getElementById('clawbot-msgs');
  if (!msgs) return 'no-clawbot-msgs';
  const div = document.createElement('div');
  const id = 'clawbot-typing-' + Date.now();
  div.id = id; div.className = 'msg ai';
  div.innerHTML = `<div class="msg-av" style="background:linear-gradient(135deg,#a855f7,#06b6d4)">🦾</div><div><div class="msg-bub"><div class="typing"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

function offerWalkthrough(context, appCtx) {
  const bar     = document.getElementById('clawbot-wt-bar');
  const content = document.getElementById('clawbot-wt-content');
  if (!bar || !content) return;
  const safeCtx = context.slice(0,60).replace(/'/g,'').replace(/"/g,'');
  content.innerHTML = `<strong>🦾 Need a walkthrough?</strong> I noticed you might need help with this. Want me to generate a step-by-step guide? <button class="clawbot-quick-btn" style="margin-left:8px" onclick="generateWalkthrough('${safeCtx}','${appCtx}')">Yes, create it</button>`;
  bar.style.display = 'flex';
}

function dismissWalkthrough() {
  const bar = document.getElementById('clawbot-wt-bar');
  if (bar) bar.style.display = 'none';
}

async function generateWalkthrough(topic, appCtx) {
  dismissWalkthrough();
  const tid = appendClawbotTyping();
  try {
    const res = await fetch('/api/clawbot/walkthrough', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ topic: topic || 'General Workflow', app: appCtx, complexity:'standard', userConsent:true })
    });
    const data = await res.json();
    removeTyping(tid);
    if (data.error === 'clawflow_required') { loadClawbotPromo(); return; }
    if (data.walkthrough) {
      const wt = data.walkthrough;
      let text = `**📖 ${wt.title}**\n\nEstimated time: ${wt.estimatedMinutes} min · Cost: ${wt.coinCost} coins\n\n${wt.summary}\n\n`;
      wt.sections.forEach(s => {
        text += `**Step ${s.step}: ${s.title}**\n${s.content}\n`;
        if (s.uiHighlight) text += `*UI: ${s.uiHighlight}*\n`;
        if (s.tip)         text += `💡 ${s.tip}\n`;
        text += '\n';
      });
      appendClawbotMsg('ai', text, `Clawbot · ${wt.coinCost} coins used`);
      // Deduct coins from badge
      const badge = document.getElementById('clawbot-coins-badge');
      if (badge && wt.coinCost) {
        const cur = parseInt(badge.textContent.replace(/[^0-9]/g,'')) || 500;
        badge.textContent = `⚡ ${Math.max(0, cur - wt.coinCost)} coins`;
      }
    }
  } catch(e) {
    removeTyping(tid);
    appendClawbotMsg('ai','Could not generate walkthrough — please try again.','Error');
  }
}

function clawbotQuick(msg) {
  const inp = document.getElementById('clawbot-in');
  if (inp) { inp.value = msg; sendClawbotMessage(); }
}

// ── Start ──────────────────────────────────────────────────────────────────
boot();
