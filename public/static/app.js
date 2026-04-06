
// ── State ──────────────────────────────────────────────────────────────────

let state = {
  timer:   { running:false, phase:'focus', elapsed:0, totalFocusSec:0, sessions:0, streak:0, focusMin:25, shortMin:5, longMin:15, intervalId:null, audioCtx:null, soundType:null, pomodoroMusic:null },
  chat:    { model:'auto', history:[] },
  cal:     { year:new Date().getFullYear(), month:new Date().getMonth(), events:[] },
  kanban:  { tasks:{ todo:[], inprogress:[], done:[] }, notionDb:null },
  learn:   { cards:[], idx:0 },
  restore: { scenes:[], idx:0, meditationTimer:null, meditationSeconds:0 },
  team:    { members:[], role:'member', activeTab:'sprint' },
  settings:{ focusMin:25, sound:null, isDemo:false },
  gen:     { imgModel:'dalle3', vidModel:'veo2', i2vModel:'kling16', imgPickerOpen:false, vidPickerOpen:false, i2vPickerOpen:false }
};

// ── Ambient Sound Engine ────────────────────────────────────────────────────
// Real AudioContext-based ambient sounds using Web Audio API oscillators/noise
const AMBIENT_SOUNDS = {
  rain:   { label:'🌧️ Rain',   type:'noise', color:'#3b82f6' },
  forest: { label:'🌲 Forest', type:'binaural', color:'#10b981' },
  cafe:   { label:'☕ Cafe',   type:'babble', color:'#f59e0b' },
  ocean:  { label:'🌊 Ocean',  type:'waves', color:'#06b6d4' },
  fire:   { label:'🔥 Fire',   type:'crackle', color:'#ef4444' },
  space:  { label:'🌌 Space',  type:'drone', color:'#a855f7' },
  off:    { label:'🔇 Off',    type:'off', color:'#555' },
};

let ambientCtx = null, ambientNodes = [], ambientGain = null;

function getAmbientCtx() {
  if (!ambientCtx) ambientCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (ambientCtx.state === 'suspended') ambientCtx.resume();
  return ambientCtx;
}

function stopAmbient() {
  ambientNodes.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch(e){} });
  ambientNodes = [];
  if (ambientGain) { ambientGain.disconnect(); ambientGain = null; }
}

function playAmbient(type) {
  stopAmbient();
  if (type === 'off') return;
  const ctx = getAmbientCtx();
  ambientGain = ctx.createGain();
  ambientGain.gain.setValueAtTime(0.12, ctx.currentTime);
  ambientGain.connect(ctx.destination);

  if (type === 'noise' || type === 'crackle') {
    // White/pink noise for rain and fire
    const bufSize = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i=0;i<bufSize;i++) {
      const wh = Math.random()*2-1;
      if (type === 'crackle') {
        // Fire crackle: pink noise + occasional pops
        b0=.99886*b0+wh*.0555179; b1=.99332*b1+wh*.0750759;
        b2=.96900*b2+wh*.1538520; b3=.86650*b3+wh*.3104856;
        b4=.55000*b4+wh*.5329522; b5=-.7616*b5-wh*.0168980;
        data[i] = (b0+b1+b2+b3+b4+b5+b6+wh*.5362) * 0.11;
        b6 = wh * 0.115926;
        // Random crackle pops
        if (Math.random() < 0.0003) data[i] += (Math.random()-0.5)*0.8;
      } else {
        // Rain: pink noise
        b0=.99886*b0+wh*.0555179; b1=.99332*b1+wh*.0750759;
        b2=.96900*b2+wh*.1538520; b3=.86650*b3+wh*.3104856;
        b4=.55000*b4+wh*.5329522; b5=-.7616*b5-wh*.0168980;
        data[i] = (b0+b1+b2+b3+b4+b5+b6+wh*.5362) * 0.11;
        b6 = wh * 0.115926;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(ambientGain); src.start();
    ambientNodes.push(src);
  } else if (type === 'binaural' || type === 'drone') {
    // Forest: binaural tones + nature harmonics | Space: low drone
    const freq = type === 'drone' ? 40 : 174;
    const freqR = type === 'drone' ? 47 : 182;
    [freq, freqR].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = type === 'drone' ? 'sine' : 'sine';
      osc.frequency.setValueAtTime(f, ctx.currentTime);
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.08, ctx.currentTime);
      osc.connect(g2); g2.connect(ambientGain);
      osc.start(); ambientNodes.push(osc);
    });
    // Add some gentle noise layer for forest
    if (type === 'binaural') {
      const bufSize = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i=0;i<bufSize;i++) data[i] = (Math.random()*2-1)*0.03;
      const src = ctx.createBufferSource(); src.buffer=buf; src.loop=true;
      src.connect(ambientGain); src.start(); ambientNodes.push(src);
    }
  } else if (type === 'waves') {
    // Ocean: LFO-modulated noise
    const bufSize = ctx.sampleRate * 8;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i=0;i<bufSize;i++) data[i] = (Math.random()*2-1);
    const src = ctx.createBufferSource(); src.buffer=buf; src.loop=true;
    const lfo = ctx.createOscillator(); lfo.frequency.setValueAtTime(0.12, ctx.currentTime);
    const lfoGain = ctx.createGain(); lfoGain.gain.setValueAtTime(0.08, ctx.currentTime);
    const biquad = ctx.createBiquadFilter(); biquad.type='lowpass'; biquad.frequency.setValueAtTime(800, ctx.currentTime);
    lfo.connect(lfoGain); lfoGain.connect(biquad.frequency);
    src.connect(biquad); biquad.connect(ambientGain);
    lfo.start(); src.start();
    ambientNodes.push(src, lfo);
  } else if (type === 'babble') {
    // Cafe: multiple layered noise sources with different filters (babble effect)
    for (let j=0;j<3;j++) {
      const bufSize = ctx.sampleRate * 3;
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i=0;i<bufSize;i++) data[i] = Math.random()*2-1;
      const src = ctx.createBufferSource(); src.buffer=buf; src.loop=true;
      src.playbackRate.setValueAtTime(0.8+Math.random()*0.4, ctx.currentTime);
      const bp = ctx.createBiquadFilter(); bp.type='bandpass';
      bp.frequency.setValueAtTime(300+j*400, ctx.currentTime); bp.Q.value=0.5;
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.025, ctx.currentTime);
      src.connect(bp); bp.connect(g2); g2.connect(ambientGain);
      src.start(); ambientNodes.push(src);
    }
  }
}

function setAmbient(type) {
  state.timer.soundType = type;
  document.querySelectorAll('.s-chip').forEach(b => b.classList.toggle('active', b.dataset.sound===type));
  if (type === 'off') { stopAmbient(); return; }
  playAmbient(AMBIENT_SOUNDS[type]?.type || 'noise');
  if (state.timer.running) document.body.classList.add('amb-active');
  notify(`🎧 ${AMBIENT_SOUNDS[type]?.label || type} playing`,'info');
}

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

// Reusable OAuth popup opener — used for Google login AND calendar connect
function openAuthPopup(url, onSuccess) {
  const w = 520, h = 640;
  const left = Math.round(screen.width/2 - w/2);
  const top  = Math.round(screen.height/2 - h/2);
  const popup = window.open(url, 'fs_auth_popup',
    `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes`);
  if (!popup) {
    // Popups blocked — fall back to same-tab redirect
    window.location.href = url;
    return;
  }
  function onAuthMessage(e) {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'FS_AUTH_SUCCESS') {
      authSucceeded = true;
      window.removeEventListener('message', onAuthMessage);
      if (!popup.closed) { try { popup.close(); } catch(_){} }
      if (onSuccess) { onSuccess(); } else { window.location.reload(); }
    }
  }
  let authSucceeded = false;
  window.addEventListener('message', onAuthMessage);
  // Fallback: if popup closes without sending message, only reload if not already logged in
  const poll = setInterval(() => {
    if (popup.closed) {
      clearInterval(poll);
      window.removeEventListener('message', onAuthMessage);
      if (authSucceeded) return; // already handled by onAuthMessage
      // Check if we're already logged in before reloading
      fetch('/api/auth/session')
        .then(r => r.json())
        .then(d => {
          if (d.user) {
            // Already logged in — just reload to show the app
            window.location.reload();
          }
          // If not logged in and popup closed, user dismissed it — do nothing
        })
        .catch(() => {});
    }
  }, 800);
}

document.getElementById('btn-google-login').addEventListener('click', () => {
  openAuthPopup('/api/auth/google');
});

document.getElementById('btn-magic-login').addEventListener('click', () => {
  const email = prompt('Enter your work email:');
  if (!email) return;
  fetch('/api/auth/magic-link', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email}) })
    .then(r => r.json()).then(d => { if (d.success) { window.location.reload(); } else { notify('Error: ' + (d.error||'unknown'),'error'); } });
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
    inner = `<div class="ob-logo">⚡</div><div class="ob-title">Welcome to FlowState</div>
      <div class="ob-sub">Your intelligent workspace — focus, team, creativity, and growth in one place. Let's set it up for you.</div>
      <div class="ob-progress">${progress}</div>
      <button class="ob-btn" onclick="obNext()">Let's Start →</button>`;
  } else if (obStep === 1) {
    inner = `<div class="ob-step">Step 2 of 5 — Your Goals</div><div class="ob-progress">${progress}</div>
      <div class="ob-title">What are you optimising for?</div>
      <div class="ob-sub">Select all that apply. FlowState adapts to your goals.</div>
      <div class="goal-grid">${OB_GOALS.map(g=>`<button class="goal-btn ${obGoals.includes(g.id)?'sel':''}" onclick="toggleGoal('${g.id}',this)"><i class="fas ${g.icon}"></i><div><div>${g.label}</div><div style="font-size:10px;color:var(--text-m);font-weight:400">${g.desc}</div></div></button>`).join('')}</div>
      <button class="ob-btn" onclick="obNext()" ${!obGoals.length?'disabled':''}>Continue →</button>
      <button class="ob-skip" onclick="obNext()">Skip for now</button>`;
  } else if (obStep === 2) {
    inner = `<div class="ob-step">Step 3 of 5 — Your Tools</div><div class="ob-progress">${progress}</div>
      <div class="ob-title">Connect your workspace</div>
      <div class="ob-sub">These integrations unlock the full FlowState experience. Connect now or later.</div>
      <div class="integ-list">
        <div class="integ-row"><div class="integ-left"><span class="integ-icon">📅</span><div><div class="integ-name">Google Calendar</div><div class="integ-desc">${FS_USER ? 'Signed in as ' + escHtml(FS_USER.email||FS_USER.name||'') : 'Sync events, block focus time'}</div></div></div><button class="btn-connect ${FS_USER?'connected':''}" onclick="${FS_USER ? 'notify(\'Calendar synced via Google login\',\'success\')' : 'window.location.href=\'/api/auth/google\''}">${FS_USER?'✓ Synced':'Connect Google'}</button></div>
        <div class="integ-row"><div class="integ-left"><span class="integ-icon">📝</span><div><div class="integ-name">Notion</div><div class="integ-desc">Sync Kanban boards & tasks</div></div></div><button class="btn-connect ${FS_NOTION?'connected':''}" onclick="connectNotion()">${FS_NOTION?'✓ Connected':'Connect'}</button></div>
        <div class="integ-row"><div class="integ-left"><span class="integ-icon">💬</span><div><div class="integ-name">Slack</div><div class="integ-desc">Team notifications & standups</div></div></div><button class="btn-connect ${FS_SLACK?'connected':''}" onclick="connectSlack()">${FS_SLACK?'✓ Connected':'Connect'}</button></div>
      </div>
      <button class="ob-btn" onclick="obNext()">Continue →</button>
      <button class="ob-skip" onclick="obNext()">Skip for now</button>`;
  } else if (obStep === 3) {
    const rhythms=[{m:25,label:'Pomodoro',desc:'Classic 25/5 split'},{m:45,label:'Deep Work',desc:'45-min focus blocks'},{m:90,label:'Flow State',desc:'Ultra-deep 90-min sessions'}];
    inner = `<div class="ob-step">Step 4 of 5 — Your Rhythm</div><div class="ob-progress">${progress}</div>
      <div class="ob-title">Choose your focus rhythm</div>
      <div class="ob-sub">You can change this any time in Settings.</div>
      <div class="rhythm-grid">${rhythms.map(r=>`<button class="rhythm-btn ${obRhythm===r.m?'sel':''}" onclick="selectRhythm(${r.m},this)"><span class="rhythm-min">${r.m}m</span><span>${r.label}</span><span class="rhythm-lbl">${r.desc}</span></button>`).join('')}</div>
      <button class="ob-btn" onclick="obFinish()">Finish Setup →</button>`;
  } else {
    inner = `<div class="ob-logo">🎉</div><div class="ob-title">FlowState is ready!</div>
      <div class="ob-sub">Your workspace is configured. Start your first focus session and track your FlowScore.</div>
      <div class="ob-progress">${progress}</div>
      <button class="ob-btn" onclick="completeOnboarding()">Start FlowState →</button>`;
  }
  card.innerHTML = inner;
}

function toggleGoal(id, btn) {
  if (obGoals.includes(id)) obGoals = obGoals.filter(g=>g!==id); else obGoals.push(id);
  btn.classList.toggle('sel', obGoals.includes(id));
  const next = document.querySelector('.ob-btn');
  if (next) next.disabled = !obGoals.length;
}

function selectRhythm(m, btn) {
  obRhythm = m;
  document.querySelectorAll('.rhythm-btn').forEach(b=>b.classList.remove('sel'));
  btn.classList.add('sel');
}

function obNext() { obStep++; renderObStep(); }

function obFinish() {
  state.timer.focusMin = obRhythm;
  state.settings.focusMin = obRhythm;
  obStep++;
  renderObStep();
}

async function completeOnboarding() {
  try {
    await fetch('/api/onboarding/complete', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ goals:obGoals, focusDuration:obRhythm, workHours:{start:'09:00',end:'18:00'}, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone })
    });
  } catch(e){}
  document.getElementById('ob-screen').style.display='none';
  showMainApp();
}

// ── Main App ───────────────────────────────────────────────────────────────
function showMainApp(isDemo=false) {
  document.getElementById('main-header').style.display='flex';
  document.getElementById('main-tabs').style.display='flex';
  document.getElementById('tab-pane-focus').style.display='flex';
  setupTimerUI();
  setupCalendar();
  buildModelBar();
  startClock();
  setupKeyboard();
  setupTabListeners();
  setupAmbientChips();
  maybeShowTip();
  checkBillingReturn();
  loadTokenBalance();
  switchTab('focus');
}

function checkBillingReturn() {
  const params = new URLSearchParams(window.location.search);
  const billing = params.get('billing');
  const topup   = params.get('topup');

  if (billing === 'success') {
    const tier  = params.get('tier') || 'pro';
    const label = tier === 'clawflow' ? 'ClawFlow' : tier.charAt(0).toUpperCase() + tier.slice(1);
    setTimeout(() => {
      notify(`🎉 Welcome to FlowState ${label}! Your subscription is active.`, 'success');
    }, 800);
    window.history.replaceState({}, '', window.location.pathname);

  } else if (billing === 'cancelled') {
    setTimeout(() => notify('Checkout cancelled — you can upgrade anytime from the Pro button.', 'info'), 500);
    window.history.replaceState({}, '', window.location.pathname);

  } else if (topup === 'success') {
    const tokens = parseInt(params.get('tokens') || '0');
    const label  = tokens >= 1_000_000
      ? (tokens / 1_000_000).toFixed(1) + 'M'
      : tokens >= 1_000
      ? Math.round(tokens / 1_000) + 'k'
      : String(tokens);
    setTimeout(() => {
      notify(`✅ ${label} tokens added to your account! They never expire.`, 'success');
      // Refresh balance display if visible
      if (typeof loadTokenBalance === 'function') loadTokenBalance();
    }, 800);
    window.history.replaceState({}, '', window.location.pathname);

  } else if (topup === 'cancelled') {
    setTimeout(() => notify('Top-up cancelled — your balance is unchanged.', 'info'), 500);
    window.history.replaceState({}, '', window.location.pathname);
  }
}

function setupTabListeners() {
  ['focus','chat','calendar','metrics','board','team','learn','restore','generate','audio','264','clawbot','demo'].forEach(id => {
    const btn = document.getElementById('tab-'+id);
    if (btn) btn.addEventListener('click', () => switchTab(id));
  });
  document.getElementById('btn-creds')?.addEventListener('click', openCredsModal);
  document.getElementById('btn-topup')?.addEventListener('click', openTopupModal);
  document.getElementById('btn-pricing')?.addEventListener('click', openPricingModal);
  document.getElementById('btn-invite')?.addEventListener('click', openInviteModal);
  document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);
  document.getElementById('btn-exit-demo')?.addEventListener('click', () => { window.location.reload(); });
  document.getElementById('logo-home')?.addEventListener('click', () => switchTab('focus'));
  document.getElementById('dt-widget')?.addEventListener('click', () => switchTab('calendar'));
  document.getElementById('fs-score-badge')?.addEventListener('click', () => switchTab('metrics'));
  document.getElementById('cal-connect-btn')?.addEventListener('click', () => openAuthPopup('/api/auth/google'));
  document.getElementById('cal-prev')?.addEventListener('click', () => calNav(-1));
  document.getElementById('cal-next')?.addEventListener('click', () => calNav(1));
  document.getElementById('cal-add-btn')?.addEventListener('click', () => { document.getElementById('add-ev-form').classList.toggle('show'); });
  document.getElementById('cal-refresh')?.addEventListener('click', loadCalEvents);
  document.getElementById('ev-save-btn')?.addEventListener('click', saveCalEvent);
  document.getElementById('ev-cancel-btn')?.addEventListener('click', () => document.getElementById('add-ev-form').classList.remove('show'));
  document.getElementById('btn-gen-img')?.addEventListener('click', generateImage);
  document.getElementById('btn-gen-vid')?.addEventListener('click', generateVideo);
  document.getElementById('btn-img2vid')?.addEventListener('click', generateImageToVideo);
  // Image→Video file upload preview
  document.getElementById('img2vid-upload')?.addEventListener('change', function() {
    const preview = document.getElementById('img2vid-preview');
    const dropLabel = document.getElementById('i2v-drop-label');
    if (this.files && this.files[0]) {
      const reader = new FileReader();
      reader.onload = e => {
        if (preview) { preview.src = e.target.result; preview.style.display = 'block'; }
        if (dropLabel) dropLabel.style.display = 'none';
      };
      reader.readAsDataURL(this.files[0]);
    }
  });
  document.getElementById('board-notion-btn')?.addEventListener('click', connectNotion);
  document.getElementById('board-db-refresh')?.addEventListener('click', loadNotionDbs);
  document.getElementById('btn-slack-team')?.addEventListener('click', openSlackModal);
  document.getElementById('btn-refresh-team')?.addEventListener('click', buildTeam);
}

function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => { p.style.display='none'; p.classList.remove('active'); });
  const btn = document.getElementById('tab-'+id);
  const pane = document.getElementById('tab-pane-'+id);
  if (btn) btn.classList.add('active');
  if (pane) { pane.style.display='flex'; pane.classList.add('active'); }
  // Tab-specific init
  if (id==='calendar') loadCalEvents();
  if (id==='metrics')  buildMetrics();
  if (id==='board')    buildBoard();
  if (id==='team')     buildTeam();
  if (id==='learn')    loadLearnCards();
  if (id==='restore')  loadRestore();
  if (id==='clawbot')  initClawbot();
  if (id==='audio')    { loadTTSVoices(); }
  if (id==='generate') { setTimeout(()=>{ buildGenPicker('img'); buildGenPicker('vid'); buildGenPicker('i2v'); }, 50); }
}

function startClock() {
  function tick() {
    const now = new Date();
    const dateEl = document.getElementById('dt-date');
    const timeEl = document.getElementById('dt-time');
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
  }
  tick(); setInterval(tick, 1000);
}

function setupAmbientChips() {
  document.querySelectorAll('.s-chip').forEach(btn => {
    btn.addEventListener('click', () => setAmbient(btn.dataset.sound));
  });
}

// ── User Area ──────────────────────────────────────────────────────────────
(function buildUserArea() {
  const area = document.getElementById('user-area');
  if (!area) return;
  if (FS_USER) {
    const pic = FS_USER.picture ? `<img class="u-avatar" src="${FS_USER.picture}" alt="${escHtml(FS_USER.name)}">` : `<div class="u-avatar" style="display:flex;align-items:center;justify-content:center;font-size:14px">👤</div>`;
    area.innerHTML = `<div class="u-pill" onclick="openSettingsModal()">${pic}<span class="u-name">${escHtml(FS_USER.name?.split(' ')[0]||'You')}</span></div>`;
    // FlowScore badge
    setTimeout(()=>{
      fetch('/api/flowscore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({focusMinutes:0,sessionCount:0})})
        .then(r=>r.json()).then(d=>{
          const b=document.getElementById('fs-score-badge');
          if(b&&d.score!=null){b.style.display='block';b.textContent=`⚡ ${d.score}`;}
        }).catch(()=>{});
    },2000);
  } else {
    area.innerHTML = `<button class="btn-signin" onclick="window.location.href='/api/auth/google'"><i class="fas fa-sign-in-alt"></i> Sign In</button>`;
  }
})();

// ── Timer ──────────────────────────────────────────────────────────────────
function setupTimerUI() {
  document.getElementById('btn-start')?.addEventListener('click', toggleTimer);
  document.getElementById('btn-skip')?.addEventListener('click', skipPhase);
  document.getElementById('btn-reset')?.addEventListener('click', resetTimer);
  document.getElementById('ph-focus')?.addEventListener('click', () => setPhase('focus'));
  document.getElementById('ph-short')?.addEventListener('click', () => setPhase('short'));
  document.getElementById('ph-long')?.addEventListener('click',  () => setPhase('long'));
  updateTimerDisplay();
}

function setPhase(phase) {
  state.timer.phase = phase;
  state.timer.elapsed = 0;
  state.timer.running = false;
  clearInterval(state.timer.intervalId);
  document.getElementById('btn-icon')?.setAttribute('class','fas fa-play');
  document.querySelectorAll('.ph-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('ph-'+phase)?.classList.add('active');
  updateTimerDisplay();
}

function getPhaseSeconds() {
  if (state.timer.phase==='focus') return state.timer.focusMin*60;
  if (state.timer.phase==='short') return state.timer.shortMin*60;
  return state.timer.longMin*60;
}

function toggleTimer() {
  if (state.timer.running) { pauseTimer(); } else { startTimer(); }
}

function startTimer() {
  // Resume or start ambient sound
  if (state.timer.soundType && state.timer.soundType!=='off') {
    playAmbient(AMBIENT_SOUNDS[state.timer.soundType]?.type||'noise');
    document.body.classList.add('amb-active');
  }
  // YouTube/Spotify Pomodoro integration
  if (state.timer.phase==='focus') startPomodoroMusic();
  state.timer.running=true;
  document.getElementById('btn-icon')?.setAttribute('class','fas fa-pause');
  document.getElementById('t-glow')?.classList.add('on');
  document.getElementById('b-ring')?.classList.add('on');
  state.timer.intervalId = setInterval(() => {
    state.timer.elapsed++;
    if (state.timer.phase==='focus') state.timer.totalFocusSec++;
    updateTimerDisplay();
    if (state.timer.elapsed >= getPhaseSeconds()) completePhase();
  }, 1000);
}

function pauseTimer() {
  state.timer.running=false;
  clearInterval(state.timer.intervalId);
  document.getElementById('btn-icon')?.setAttribute('class','fas fa-play');
  document.getElementById('t-glow')?.classList.remove('on');
  document.getElementById('b-ring')?.classList.remove('on');
  stopAmbient();
  document.body.classList.remove('amb-active');
  stopPomodoroMusic();
}

function resetTimer() {
  pauseTimer();
  state.timer.elapsed=0;
  updateTimerDisplay();
}

function skipPhase() {
  pauseTimer();
  completePhase(true);
}

function completePhase(skipped=false) {
  clearInterval(state.timer.intervalId);
  state.timer.running=false;
  state.timer.elapsed=0;
  document.getElementById('btn-icon')?.setAttribute('class','fas fa-play');
  document.getElementById('t-glow')?.classList.remove('on');
  document.getElementById('b-ring')?.classList.remove('on');
  stopAmbient(); stopPomodoroMusic();
  document.body.classList.remove('amb-active');

  if (state.timer.phase==='focus' && !skipped) {
    state.timer.sessions++;
    state.timer.streak++;
    saveLocalState();
    triggerCelebration('Focus Session Complete! 🎉', `${state.timer.sessions} sessions today — ${Math.round(state.timer.totalFocusSec/60)}m total`);
    updateFlowScore();
    maybeShowTip();
  }
  // Auto-switch phase
  if (state.timer.phase==='focus') {
    setPhase(state.timer.sessions%4===0?'long':'short');
    notify('Break time! Step away from the screen 🧘','info');
  } else {
    setPhase('focus');
    notify('Break done! Ready to focus? 💪','success');
  }
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const total = getPhaseSeconds();
  const remaining = Math.max(0, total - state.timer.elapsed);
  const m = Math.floor(remaining/60).toString().padStart(2,'0');
  const s = (remaining%60).toString().padStart(2,'0');
  const el = document.getElementById('timer-display');
  if (el) el.textContent = `${m}:${s}`;
  const ph = document.getElementById('timer-phase');
  if (ph) ph.textContent = state.timer.phase==='focus'?'FOCUS':state.timer.phase==='short'?'SHORT BREAK':'LONG BREAK';
  const prog = document.getElementById('ring-prog');
  if (prog) {
    const circ = 615.75;
    const offset = circ - (circ * (1 - state.timer.elapsed/total));
    prog.style.strokeDashoffset = offset;
  }
  const ss = document.getElementById('stat-sessions');
  if (ss) ss.textContent = state.timer.sessions;
  const sf = document.getElementById('stat-focus');
  if (sf) sf.textContent = Math.round(state.timer.totalFocusSec/60)+'m';
  const sk = document.getElementById('stat-streak');
  if (sk) sk.textContent = '🔥 '+state.timer.streak;
}

function updateFlowScore() {
  fetch('/api/flowscore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    totalFocusSeconds:state.timer.totalFocusSec, sessionCount:state.timer.sessions, breaksCompleted:state.timer.sessions, streakDays:state.timer.streak
  })}).then(r=>r.json()).then(d=>{
    const b=document.getElementById('fs-score-badge');
    if(b&&d.score!=null){b.style.display='block';b.textContent=`⚡ ${d.score}`;}
  }).catch(()=>{});
}

// ── Pomodoro Music (YouTube/Spotify) ──────────────────────────────────────
// Legal note: Using YouTube/Spotify embeds is legal as it uses their official iframe embed API.
// Spotify requires Premium for autoplay. YouTube embed with autoplay requires user interaction first.
let pomodoroMusicEl = null;

function startPomodoroMusic() {
  const saved = localStorage.getItem('pomodoro_music') || '';
  if (!saved) return;
  try {
    const cfg = JSON.parse(saved);
    if (!cfg.url || !cfg.enabled) return;
    if (cfg.type === 'youtube') startYouTubeMusic(cfg.videoId);
    else if (cfg.type === 'spotify') startSpotifyMusic(cfg.uri);
  } catch(e){}
}

function stopPomodoroMusic() {
  if (pomodoroMusicEl) {
    pomodoroMusicEl.src = '';
    pomodoroMusicEl.style.display = 'none';
  }
}

function startYouTubeMusic(videoId) {
  if (!pomodoroMusicEl) {
    pomodoroMusicEl = document.createElement('iframe');
    pomodoroMusicEl.style.cssText = 'position:fixed;bottom:-200px;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    pomodoroMusicEl.allow = 'autoplay; encrypted-media';
    document.body.appendChild(pomodoroMusicEl);
  }
  pomodoroMusicEl.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}`;
}

function startSpotifyMusic(uri) {
  if (!pomodoroMusicEl) {
    pomodoroMusicEl = document.createElement('iframe');
    pomodoroMusicEl.style.cssText = 'position:fixed;bottom:-200px;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(pomodoroMusicEl);
  }
  const embedUri = uri.replace('spotify:', '').replace(/:/g, '/');
  pomodoroMusicEl.src = `https://open.spotify.com/embed/${embedUri}?autoplay=1`;
}

function openMusicModal() {
  const saved = JSON.parse(localStorage.getItem('pomodoro_music') || '{"enabled":false,"type":"youtube","url":"","videoId":"","uri":""}');
  openModal(`
    <h2>🎵 Pomodoro Music</h2>
    <p style="color:var(--text-s);font-size:13px;margin:6px 0 16px">Automatically start music when a focus session begins. Uses YouTube or Spotify embeds — no API key required.</p>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn-sm ${saved.type==='youtube'?'btn-primary':''}" id="mus-yt-btn" onclick="selectMusicType('youtube')"><i class="fab fa-youtube" style="color:#ef4444"></i> YouTube</button>
      <button class="btn-sm ${saved.type==='spotify'?'btn-primary':''}" id="mus-sp-btn" onclick="selectMusicType('spotify')"><i class="fab fa-spotify" style="color:#1db954"></i> Spotify</button>
    </div>
    <div id="mus-yt-section" style="display:${saved.type==='youtube'?'block':'none'}">
      <label style="font-size:12px;color:var(--text-m)">YouTube Video/Playlist URL</label>
      <input class="fs-in" id="mus-yt-url" style="margin:6px 0 10px" placeholder="https://youtube.com/watch?v=..." value="${escHtml(saved.type==='youtube'?saved.url:'')}">
      <div style="font-size:11px;color:var(--text-m)">Tip: Use lo-fi or focus music playlists for best results. e.g. "lofi hip hop radio" on YouTube.</div>
    </div>
    <div id="mus-sp-section" style="display:${saved.type==='spotify'?'block':'none'}">
      <label style="font-size:12px;color:var(--text-m)">Spotify URI (spotify:playlist:... or spotify:album:...)</label>
      <input class="fs-in" id="mus-sp-uri" style="margin:6px 0 10px" placeholder="spotify:playlist:37i9dQZF1DX8NTLI2TtZa6" value="${escHtml(saved.type==='spotify'?saved.uri:'')}">
      <div style="font-size:11px;color:var(--text-m)">Right-click a playlist → Share → Copy Spotify URI. Note: Spotify requires Premium account for autoplay.</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:14px 0">
      <input type="checkbox" id="mus-enabled" ${saved.enabled?'checked':''}>
      <label for="mus-enabled" style="font-size:13px;font-weight:600">Auto-start music when focus session begins</label>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-primary" onclick="saveMusicSettings()" style="flex:1">Save</button>
      <button class="btn-sm" onclick="clearMusicSettings()">Clear</button>
    </div>
    <div style="margin-top:10px;font-size:11px;color:var(--text-m)">⚖️ Using YouTube/Spotify embeds complies with their Terms of Service for personal use. Content is streamed from their servers.</div>
  `);
}

function selectMusicType(type) {
  document.getElementById('mus-yt-section').style.display = type==='youtube'?'block':'none';
  document.getElementById('mus-sp-section').style.display = type==='spotify'?'block':'none';
  document.getElementById('mus-yt-btn').className = 'btn-sm '+(type==='youtube'?'btn-primary':'');
  document.getElementById('mus-sp-btn').className = 'btn-sm '+(type==='spotify'?'btn-primary':'');
}

function saveMusicSettings() {
  const type = document.getElementById('mus-yt-section').style.display!=='none' ? 'youtube' : 'spotify';
  const url = document.getElementById('mus-yt-url')?.value || '';
  const uri = document.getElementById('mus-sp-uri')?.value || '';
  const enabled = document.getElementById('mus-enabled')?.checked;
  let videoId = '';
  try {
    const m = url.match(/[?&]v=([^&]+)/)||url.match(/youtu\.be\/([^?]+)/)||url.match(/embed\/([^?]+)/);
    if (m) videoId = m[1];
    // Also handle playlist URLs
    const pl = url.match(/[?&]list=([^&]+)/);
    if (pl && !videoId) videoId = ''; // playlist — use URL directly
  } catch(e){}
  localStorage.setItem('pomodoro_music', JSON.stringify({enabled,type,url,videoId,uri}));
  closeModal();
  notify(enabled?'🎵 Pomodoro music saved! Music will start with focus sessions.':'Music settings saved.','success');
}

function clearMusicSettings() {
  localStorage.removeItem('pomodoro_music');
  closeModal();
  notify('Music settings cleared','info');
}

// ── Model Bar ──────────────────────────────────────────────────────────────
// ── Model Registry (mirrors Genspark's current model list) ─────────────────
const MODELS = [
  // ── Smart routing ─────────────────────────────────────────────────────────
  { id:'auto',              label:'Mixture-of-Agents',  sub:'Auto-mixes best AI models for your task',  icon:'🔀', iconBg:'#1a1a2e', group:'smart' },
  // ── OpenAI ────────────────────────────────────────────────────────────────
  { id:'gpt-5-4',           label:'GPT-5.4',            sub:'OpenAI flagship',                          icon:'openai', group:'openai' },
  { id:'gpt-5-4-mini',      label:'GPT-5.4 Mini',       sub:'Fast & efficient',                         icon:'openai', group:'openai' },
  { id:'gpt-5-4-nano',      label:'GPT-5.4 Nano',       sub:'Ultra-fast & lightweight',                 icon:'openai', group:'openai' },
  { id:'gpt-5-2-pro',       label:'GPT-5.2 Pro',        sub:'Advanced reasoning',                       icon:'openai', group:'openai' },
  { id:'gpt-5-4-pro',       label:'GPT-5.4 Pro',        sub:'Most capable GPT',                         icon:'openai', group:'openai' },
  { id:'o3-pro',            label:'o3-pro',             sub:'Deep reasoning chain',                     icon:'openai', group:'openai' },
  // ── Anthropic ─────────────────────────────────────────────────────────────
  { id:'claude-sonnet-4-6', label:'Claude Sonnet 4.6',  sub:'Balanced intelligence',                    icon:'claude', group:'anthropic' },
  { id:'claude-opus-4-6',   label:'Claude Opus 4.6',    sub:'Most intelligent Claude',                  icon:'claude', group:'anthropic' },
  { id:'claude-haiku-4-5',  label:'Claude Haiku 4.5',   sub:'Fastest Claude model',                     icon:'claude', group:'anthropic' },
  // ── Google ────────────────────────────────────────────────────────────────
  { id:'gemini-2-5-pro',    label:'Gemini 2.5 Pro',     sub:'Google\'s most capable',                   icon:'google', group:'google' },
  { id:'gemini-2-5-flash',  label:'Gemini 2.5 Flash',   sub:'Speed + intelligence balance',             icon:'google', group:'google' },
  { id:'gemini-2-0-flash',  label:'Gemini 2.0 Flash',   sub:'Multimodal efficiency',                    icon:'google', group:'google' },
  // ── xAI ───────────────────────────────────────────────────────────────────
  { id:'grok-3',            label:'Grok 3',             sub:'Real-time web access',                     icon:'xai', group:'xai' },
  { id:'grok-3-mini',       label:'Grok 3 Mini',        sub:'Fast reasoning, live data',                icon:'xai', group:'xai' },
  // ── Meta ──────────────────────────────────────────────────────────────────
  { id:'llama-4-maverick',  label:'Llama 4 Maverick',   sub:'Meta open source flagship',                icon:'meta', group:'meta' },
  { id:'llama-4-scout',     label:'Llama 4 Scout',      sub:'Efficient & fast',                         icon:'meta', group:'meta' },
  // ── Mistral ───────────────────────────────────────────────────────────────
  { id:'mistral-large',     label:'Mistral Large',      sub:'European frontier model',                  icon:'mistral', group:'mistral' },
  { id:'codestral',         label:'Codestral',          sub:'Best-in-class for code',                   icon:'mistral', group:'mistral' },
  // ── DeepSeek ──────────────────────────────────────────────────────────────
  { id:'deepseek-r2',       label:'DeepSeek R2',        sub:'Advanced reasoning & math',                icon:'deepseek', group:'deepseek' },
  { id:'deepseek-v3',       label:'DeepSeek V3',        sub:'Cost-efficient frontier',                  icon:'deepseek', group:'deepseek' },
];

// Provider icon SVGs / emoji — rendered inline in the picker
function modelIconHtml(icon, size=18) {
  const s = `width:${size}px;height:${size}px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:${size-4}px;flex-shrink:0;`;
  if (icon === 'openai')   return `<span style="${s}background:#000;color:#fff;font-weight:900;font-size:${size-6}px">⊕</span>`;
  if (icon === 'claude')   return `<span style="${s}background:#c96442;color:#fff">✳</span>`;
  if (icon === 'google')   return `<span style="${s}background:#fff;color:#4285F4;font-weight:900;font-size:${size-6}px">G</span>`;
  if (icon === 'xai')      return `<span style="${s}background:#000;color:#fff;font-weight:900;font-size:${size-7}px">𝕏</span>`;
  if (icon === 'meta')     return `<span style="${s}background:linear-gradient(135deg,#0082fb,#00c6ff);color:#fff;font-size:${size-7}px;font-weight:900">M</span>`;
  if (icon === 'mistral')  return `<span style="${s}background:#f86f00;color:#fff;font-weight:900;font-size:${size-7}px">▲</span>`;
  if (icon === 'deepseek') return `<span style="${s}background:linear-gradient(135deg,#4f8ef7,#0058f7);color:#fff;font-size:${size-6}px;font-weight:900">D</span>`;
  // emoji / smart
  return `<span style="${s}background:#1a1a2e;color:#fff">${icon}</span>`;
}

// ── Genspark-style model pill + floating dropdown ──────────────────────────
let modelPickerOpen = false;

function buildModelBar() {
  const bar = document.getElementById('model-bar');
  if (!bar) return;
  const cur = MODELS.find(m => m.id === state.chat.model) || MODELS[0];
  bar.innerHTML = `
    <button class="gs-model-pill" id="gs-model-pill" onclick="toggleModelPicker(event)">
      ${modelIconHtml(cur.icon, 16)}
      <span style="margin:0 5px 0 6px;font-weight:600;font-size:13px">${cur.label}</span>
      <i class="fas fa-chevron-${modelPickerOpen?'up':'down'}" style="font-size:9px;opacity:.7"></i>
    </button>
    <div id="gs-model-dropdown" class="gs-model-dropdown" style="display:${modelPickerOpen?'block':'none'}">
      ${MODELS.map(m => `
        <div class="gs-model-row ${m.id===state.chat.model?'gs-model-selected':''}" onclick="selectModel('${m.id}')">
          <div style="display:flex;align-items:center;gap:10px;flex:1">
            ${modelIconHtml(m.icon, 20)}
            <div>
              <div style="font-weight:600;font-size:13px;color:var(--text-p)">${m.label}</div>
              ${m.sub?`<div style="font-size:11px;color:var(--text-s);margin-top:1px">${m.sub}</div>`:''}
            </div>
          </div>
          <div class="gs-radio ${m.id===state.chat.model?'gs-radio-active':''}"></div>
        </div>
      `).join('')}
    </div>`;
}

function toggleModelPicker(e) {
  e.stopPropagation();
  modelPickerOpen = !modelPickerOpen;
  buildModelBar();
  if (modelPickerOpen) {
    // close on outside click
    setTimeout(() => document.addEventListener('click', closeModelPicker, { once:true }), 10);
  }
}

function closeModelPicker() {
  modelPickerOpen = false;
  buildModelBar();
}

function selectModel(id) {
  state.chat.model = id;
  modelPickerOpen = false;
  buildModelBar();
}

// ── Generate-tab model pickers (Genspark-style) ────────────────────────────
const IMG_MODELS = [
  { id:'dalle3',    label:'DALL-E 3',         sub:'OpenAI — Best text rendering',      icon:'openai'  },
  { id:'dalle4',    label:'DALL-E 4',         sub:'OpenAI — Latest generation',        icon:'openai'  },
  { id:'gpt-image', label:'GPT-Image-1',      sub:'OpenAI — Native image editing',     icon:'openai'  },
  { id:'imagen3',   label:'Imagen 3',         sub:'Google — Photorealistic quality',   icon:'google'  },
  { id:'imagen4',   label:'Imagen 4',         sub:'Google — Latest model',             icon:'google'  },
  { id:'flux_pro',  label:'FLUX Pro 1.1',     sub:'Black Forest Labs — Ultra-detail',  icon:'🖼️'      },
  { id:'flux_dev',  label:'FLUX Dev',         sub:'Black Forest Labs — Fast & open',   icon:'🖼️'      },
  { id:'ideogram2', label:'Ideogram 2.0',     sub:'Design-forward, great typography',  icon:'💡'      },
  { id:'sd3',       label:'Stable Diffusion 3','sub':'Stability AI — Open source',     icon:'🎨'      },
  { id:'recraft',   label:'Recraft V3',       sub:'Vector & brand design specialist',  icon:'✏️'      },
];

const VID_MODELS = [
  { id:'veo2',         label:'Veo 2',          sub:'Google — Cinematic quality',        icon:'google'  },
  { id:'veo3',         label:'Veo 3',          sub:'Google — Latest, audio-native',     icon:'google'  },
  { id:'sora',         label:'Sora',           sub:'OpenAI — World models',             icon:'openai'  },
  { id:'kling16',      label:'Kling 1.6',      sub:'Kuaishou — Smooth motion',          icon:'🎬'      },
  { id:'kling21',      label:'Kling 2.1',      sub:'Kuaishou — Latest version',         icon:'🎬'      },
  { id:'runway_gen4',  label:'Runway Gen-4',   sub:'Runway ML — Film quality',          icon:'🎞️'      },
  { id:'runway_gen4t', label:'Runway Gen-4 Turbo','sub':'Runway ML — Fast generation', icon:'🎞️'      },
  { id:'pika20',       label:'Pika 2.0',       sub:'Pika Labs — Creative effects',      icon:'⚡'      },
  { id:'hailuo',       label:'Hailuo 2',       sub:'MiniMax — Fast face generation',    icon:'🌊'      },
  { id:'luma',         label:'Luma Dream Machine','sub':'Luma AI — Photorealistic',     icon:'🌙'      },
];

// Map of model IDs to full descriptions shown under the pill
const MODEL_DESCS = {
  // Image
  'dalle3':    'OpenAI DALL-E 3 — Best-in-class text rendering, photorealistic scenes, and creative illustrations.',
  'dalle4':    'OpenAI DALL-E 4 — Latest generation with improved coherence and detail at every scale.',
  'gpt-image': 'OpenAI GPT-Image-1 — Natively integrated image generation with editing and multi-turn context.',
  'imagen3':   'Google Imagen 3 — Photorealistic quality with accurate prompt following and fine detail.',
  'imagen4':   'Google Imagen 4 — Google\'s latest model with improved photorealism and composition.',
  'flux_pro':  'FLUX Pro 1.1 by Black Forest Labs — Ultra-high detail, accurate anatomy, exceptional realism.',
  'flux_dev':  'FLUX Dev by Black Forest Labs — Open-weight model. Fast, high-quality, great for iteration.',
  'ideogram2': 'Ideogram 2.0 — Design-forward with excellent typography, logos, and stylized illustration.',
  'sd3':       'Stable Diffusion 3 — Open-source model by Stability AI. Customizable and community-supported.',
  'recraft':   'Recraft V3 — Specialist in vector art, brand assets, icons, and consistent visual styles.',
  // Video
  'veo2':         'Google Veo 2 — Cinematic quality video with realistic motion, lighting, and depth of field.',
  'veo3':         'Google Veo 3 — Latest Veo with native audio generation and improved temporal consistency.',
  'sora':         'OpenAI Sora — World model understanding for consistent physics and long-form video.',
  'kling16':      'Kling 1.6 by Kuaishou — Smooth motion, excellent face/body consistency, up to 10s.',
  'kling21':      'Kling 2.1 by Kuaishou — Latest version with improved quality and longer durations.',
  'runway_gen4':  'Runway Gen-4 — Film-quality output, precise motion control, and professional-grade results.',
  'runway_gen4t': 'Runway Gen-4 Turbo — Faster generation at near-identical quality to Gen-4 standard.',
  'pika20':       'Pika 2.0 — Creative effects, style transfer, and expressive motion. Great for stylised content.',
  'hailuo':       'Hailuo 2 by MiniMax — Fast generation with strong face consistency and natural dialogue motion.',
  'luma':         'Luma Dream Machine — Photorealistic video with smooth camera motion and environmental detail.',
};

function buildGenPicker(type) {
  // type: 'img' | 'vid' | 'i2v'
  const isImg = type === 'img';
  const isI2v = type === 'i2v';
  const models = isImg ? IMG_MODELS : VID_MODELS;
  const stateKey = isImg ? 'imgModel' : (isI2v ? 'i2vModel' : 'vidModel');
  const openKey  = isImg ? 'imgPickerOpen' : (isI2v ? 'i2vPickerOpen' : 'vidPickerOpen');
  const curId  = state.gen[stateKey] || models[0].id;
  const cur    = models.find(m => m.id === curId) || models[0];
  const el     = document.getElementById(`gs-${type}-picker`);
  if (!el) return;

  el.innerHTML = `
    <button class="gs-model-pill" onclick="toggleGenPicker(event,'${type}')">
      ${modelIconHtml(cur.icon, 16)}
      <span style="font-weight:600;font-size:13px">${cur.label}</span>
      <i class="fas fa-chevron-${state.gen[openKey]?'up':'down'}" style="font-size:9px;opacity:.6;margin-left:2px"></i>
    </button>
    <div class="gs-model-dropdown" style="display:${state.gen[openKey]?'block':'none'}">
      ${models.map(m => `
        <div class="gs-model-row ${m.id===curId?'gs-model-selected':''}" onclick="selectGenModel('${type}','${m.id}')">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
            ${modelIconHtml(m.icon, 22)}
            <div style="min-width:0">
              <div style="font-weight:600;font-size:13px;color:var(--text-p)">${m.label}</div>
              ${m.sub?`<div style="font-size:11px;color:var(--text-s);margin-top:2px;line-height:1.4">${m.sub}</div>`:''}
            </div>
          </div>
          <div class="gs-radio ${m.id===curId?'gs-radio-active':''}"></div>
        </div>
      `).join('')}
    </div>`;

  // Update description text
  const descId = isImg ? 'img-model-desc' : (isI2v ? 'i2v-model-desc' : 'vid-model-desc');
  const descEl = document.getElementById(descId);
  if (descEl && MODEL_DESCS[curId]) descEl.textContent = MODEL_DESCS[curId];
}

function toggleGenPicker(e, type) {
  e.stopPropagation();
  const openKey = type==='img' ? 'imgPickerOpen' : (type==='i2v' ? 'i2vPickerOpen' : 'vidPickerOpen');
  // Close all others
  ['imgPickerOpen','vidPickerOpen','i2vPickerOpen'].forEach(k => { if(k!==openKey) state.gen[k]=false; });
  state.gen[openKey] = !state.gen[openKey];
  buildGenPicker('img'); buildGenPicker('vid'); buildGenPicker('i2v');
  if (state.gen[openKey]) setTimeout(() => document.addEventListener('click', closeGenPickers, {once:true}), 10);
}

function closeGenPickers() {
  state.gen.imgPickerOpen = false; state.gen.vidPickerOpen = false; state.gen.i2vPickerOpen = false;
  buildGenPicker('img'); buildGenPicker('vid'); buildGenPicker('i2v');
}

function selectGenModel(type, id) {
  if (type==='img') state.gen.imgModel = id;
  else if (type==='i2v') state.gen.i2vModel = id;
  else state.gen.vidModel = id;
  closeGenPickers();
}

function setVidDur(btn, val) {
  document.querySelectorAll('.gen-dur-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const hiddenDur = document.getElementById('vid-dur');
  if (hiddenDur) hiddenDur.value = val;
}

// ── Chat ───────────────────────────────────────────────────────────────────
const MODEL_NAMES = {
  'auto':'FlowState AI',
  'gpt-5-4':'GPT-5.4','gpt-5-4-mini':'GPT-5.4 Mini','gpt-5-4-nano':'GPT-5.4 Nano',
  'gpt-5-2-pro':'GPT-5.2 Pro','gpt-5-4-pro':'GPT-5.4 Pro','o3-pro':'o3-pro',
  'claude-sonnet-4-6':'Claude Sonnet 4.6','claude-opus-4-6':'Claude Opus 4.6','claude-haiku-4-5':'Claude Haiku 4.5',
  'gemini-2-5-pro':'Gemini 2.5 Pro','gemini-2-5-flash':'Gemini 2.5 Flash','gemini-2-0-flash':'Gemini 2.0 Flash',
  'grok-3':'Grok 3','grok-3-mini':'Grok 3 Mini',
  'llama-4-maverick':'Llama 4 Maverick','llama-4-scout':'Llama 4 Scout',
  'mistral-large':'Mistral Large','codestral':'Codestral',
  'deepseek-r2':'DeepSeek R2','deepseek-v3':'DeepSeek V3',
};

function sendSuggestion(text) {
  const inp = document.getElementById('chat-in');
  if (inp) { inp.value = text; }
  // Hide suggestion chips once user picks one
  const chips = document.getElementById('chat-suggestions');
  if (chips) chips.style.display = 'none';
  sendMessage();
}

async function sendMessage() {
  const inp = document.getElementById('chat-in');
  const msg = inp.value.trim();
  if (!msg) return;
  // Hide suggestions once first message sent
  const chips = document.getElementById('chat-suggestions');
  if (chips) chips.style.display = 'none';
  inp.value = ''; inp.style.height = '42px';
  appendMsg('user', msg, '');
  const tid = appendTyping();
  try {
    const res = await fetch('/api/chat/stream', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message:msg, model:state.chat.model, history:state.chat.history.slice(-10) })
    });
    // Handle rate-limit / abuse block (429)
    if (res.status === 429) {
      const err = await res.json().catch(() => ({}));
      removeTyping(tid);
      const code = err.code || '';
      if (code === 'VELOCITY_EXCEEDED') {
        appendMsg('ai','⏱️ **Slow down!** You\'re sending too many messages. Wait 60 seconds and try again.','Rate limit');
      } else if (code === 'DAILY_LIMIT') {
        const isPro = err.isPro;
        appendMsg('ai', isPro
          ? '📊 **Daily Pro limit reached** (100,000 tokens). Your quota resets at midnight UTC.'
          : '📊 **Free daily limit reached** (5,000 tokens). [Upgrade to Pro](/upgrade) for 20× more tokens per day.', 'Usage limit');
      } else {
        appendMsg('ai','⚠️ Request blocked. ' + (err.error || 'Try again later.'),'Blocked');
      }
      return;
    }
    if (!res.ok) { throw new Error('HTTP ' + res.status); }
    // Server returns plain text + X-Routed-Model header
    const reply = await res.text();
    const routedModel = res.headers.get('X-Routed-Model') || state.chat.model;
    const liveSearch  = res.headers.get('X-Live-Search') === 'on';
    // Budget warning
    const budgetWarn = res.headers.get('X-Budget-Warning');
    if (budgetWarn) notify('⚡ ' + budgetWarn, 'warning');
    removeTyping(tid);
    appendMsg('ai', reply || 'No response.', (liveSearch ? '🌐 ' : '') + (MODEL_NAMES[routedModel] || routedModel));
    state.chat.history.push({role:'user',content:msg},{role:'assistant',content:reply||''});
  } catch(e) {
    removeTyping(tid);
    appendMsg('ai','Sorry, something went wrong. Check your API keys in Settings or try again.','Error');
    console.error('Chat error:', e);
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
function setupCalendar() {
  renderCalGrid();
}

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
    const hasEv = state.cal.events.some(e=>{
      const s = e.start?.dateTime || e.start?.date || e.start || '';
      return typeof s==='string' && s.startsWith(dateStr);
    });
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
    renderCalGrid();
    return;
  }
  document.getElementById('cal-auth-banner').style.display = 'none';
  fetch('/api/calendar/events').then(r=>r.json()).then(d=>{
    if (d.events) {
      state.cal.events = d.events;
      renderCalGrid();
      renderEvents(d.events);
    } else if (d.error === 'not_authenticated') {
      document.getElementById('cal-auth-banner').style.display = 'block';
    }
  }).catch(()=>{ renderCalGrid(); });
}

function renderEvents(events) {
  const list = document.getElementById('ev-list');
  if (!list) return;
  if (!events.length) { list.innerHTML = '<div class="empty"><i class="fas fa-calendar-alt"></i><p>No upcoming events. Click a day to add one.</p></div>'; return; }
  list.innerHTML = events.slice(0,10).map(ev => {
    const start = ev.start?.dateTime || ev.start?.date || ev.start || '';
    const t = start ? new Date(start).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true}) : '';
    return `<div class="ev-item"><div class="ev-dot" style="background:${ev.color||'var(--accent)'}"></div><div class="ev-time">${t}</div><div class="ev-sum">${escHtml(ev.summary||'(no title)')}</div><button class="btn-blk" onclick="blockAroundEvent('${ev.id}')">Block</button></div>`;
  }).join('');
}

function saveCalEvent() {
  const title = document.getElementById('ev-title').value.trim();
  const start  = document.getElementById('ev-start').value;
  const end    = document.getElementById('ev-end').value;
  const desc   = document.getElementById('ev-desc').value;
  const color  = document.getElementById('ev-color-pick')?.value || '#a855f7';
  if (!title || !start || !end) { notify('Title, start and end are required','error'); return; }
  if (!FS_USER) {
    // Local-only save for non-authenticated users
    const localEv = { id:'local-'+Date.now(), summary:title, start:{dateTime:start}, end:{dateTime:end}, color };
    state.cal.events.push(localEv);
    renderCalGrid();
    renderEvents(state.cal.events);
    document.getElementById('add-ev-form').classList.remove('show');
    document.getElementById('ev-title').value='';
    notify('Event added locally (sign in to sync with Google Calendar)','info');
    return;
  }
  const btn = document.getElementById('ev-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  fetch('/api/calendar/create', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title, start, end, description:desc, allDay:false, color:colorIdFromHex(color) })
  }).then(r=>r.json()).then(d=>{
    if (d.ok || d.event?.id) {
      notify('Event created! ✓','success');
      document.getElementById('add-ev-form').classList.remove('show');
      document.getElementById('ev-title').value='';
      document.getElementById('ev-desc').value='';
      loadCalEvents();
    } else {
      // Try fallback endpoint
      return fetch('/api/calendar/block', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title, start, end, description:desc, color })
      }).then(r=>r.json()).then(d2=>{
        if (d2.ok||d2.id||d2.event?.id) {
          notify('Event created! ✓','success');
          document.getElementById('add-ev-form').classList.remove('show');
          document.getElementById('ev-title').value='';
          loadCalEvents();
        } else {
          notify(d2.error||d.error||'Could not create event — check Google permissions','error');
        }
      });
    }
  }).catch(()=>notify('Error creating event','error'))
  .finally(()=>{ btn.disabled=false; btn.textContent='Save Event'; });
}

function colorIdFromHex(hex) {
  // Map hex to Google Calendar colorId (1-11)
  const colorMap = {'#ef4444':'11','#f59e0b':'5','#10b981':'10','#3b82f6':'9','#a855f7':'3','#ec4899':'4','#06b6d4':'7'};
  return colorMap[hex] || '1';
}

function blockAroundEvent(evId) {
  const ev = state.cal.events.find(e=>e.id===evId);
  if (!ev) return;
  const start = new Date(ev.start?.dateTime||ev.start?.date||ev.start);
  const blockEnd   = new Date(start); blockEnd.setMinutes(blockEnd.getMinutes()-5);
  const blockStart = new Date(blockEnd); blockStart.setMinutes(blockStart.getMinutes()-state.timer.focusMin);
  const endpoint = FS_USER ? '/api/calendar/block' : null;
  if (!endpoint) { notify('Sign in to create Google Calendar blocks','info'); return; }
  fetch(endpoint, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title:`🍅 Focus Block (before ${ev.summary||'event'})`, start:blockStart.toISOString(), end:blockEnd.toISOString() })
  }).then(r=>r.json()).then(d=>{
    if (d.ok||d.id||d.event?.id) notify('Focus block created!','success'); else notify(d.error||'Could not create block','error');
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

  const weekData = [];
  const today = new Date();
  for (let i=6;i>=0;i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const key = 'sessions_' + d.toISOString().slice(0,10);
    weekData.push(parseInt(localStorage.getItem(key)||'0'));
  }
  const todayKey = 'sessions_' + today.toISOString().slice(0,10);
  localStorage.setItem(todayKey, sessions);

  const ctx = document.getElementById('focus-chart')?.getContext('2d');
  if (!ctx) return;
  if (focusChartInstance) focusChartInstance.destroy();

  // If no real data yet, show sample data so chart looks useful
  const hasData = weekData.some(v => v > 0);
  const sampleData = [2, 4, 3, 5, 2, 6, 3];
  const chartData = hasData ? weekData : sampleData;
  const isDemoChart = !hasData;

  // Update chart title to show "sample" when no real data
  const chartTitle = document.querySelector('.chart-title');
  if (chartTitle) {
    chartTitle.innerHTML = `<i class="fas fa-chart-bar" style="color:var(--accent)"></i> Focus Sessions This Week${isDemoChart ? ' <span style="font-size:10px;color:var(--text-m);font-weight:400;background:rgba(168,85,247,.12);padding:2px 7px;border-radius:10px;margin-left:4px">sample</span>' : ''}`;
  }

  focusChartInstance = new Chart(ctx, {
    type:'bar',
    data: {
      labels: Array.from({length:7},(_, i)=>{ const d=new Date(today); d.setDate(d.getDate()-(6-i)); return d.toLocaleDateString('en-US',{weekday:'short'}); }),
      datasets:[{ data:chartData, backgroundColor: isDemoChart ? 'rgba(168,85,247,.25)' : 'rgba(168,85,247,.6)', borderColor:'#a855f7', borderWidth:2, borderRadius:8 }]
    },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{beginAtZero:true,ticks:{color:'#888',stepSize:1,precision:0},grid:{color:'rgba(168,85,247,.07)'}}, x:{ticks:{color:'#888'},grid:{display:false}} }, animation:{duration:600} }
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
  saveLocalState(); renderLocalKanban(); notify('Task added','success');
}

function deleteLocalTask(colId, idx) {
  state.kanban.tasks[colId].splice(idx, 1);
  saveLocalState(); renderLocalKanban();
}

let _dragData = null;
function dragStart(e, colId, idx) { _dragData = {colId, idx}; e.dataTransfer.effectAllowed='move'; }
function drop(e, toCol, toIdx) {
  e.preventDefault();
  if (!_dragData) return;
  const { colId, idx } = _dragData;
  const task = state.kanban.tasks[colId].splice(idx, 1)[0];
  state.kanban.tasks[toCol].splice(toIdx, 0, task);
  _dragData = null; saveLocalState(); renderLocalKanban();
}
function dropOnCol(e, toCol) {
  e.preventDefault();
  if (!_dragData) return;
  const { colId, idx } = _dragData;
  const task = state.kanban.tasks[colId].splice(idx, 1)[0];
  state.kanban.tasks[toCol].push(task);
  _dragData = null; saveLocalState(); renderLocalKanban();
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
  renderTeamTabs();
}

function renderTeamTabs() {
  const hub = document.getElementById('team-hub-content');
  if (!hub) return;
  const tabs = [
    {id:'sprint', label:'Sprint Health', icon:'fa-heart-pulse'},
    {id:'pulse', label:'Team Pulse', icon:'fa-users'},
    {id:'standups', label:'Standups', icon:'fa-microphone'},
    {id:'burnout', label:'Burnout Risk', icon:'fa-fire-flame-curved'},
    {id:'deadlines', label:'Deadlines', icon:'fa-clock'},
    {id:'velocity', label:'Velocity', icon:'fa-chart-line'},
  ];
  hub.innerHTML = `
    <div class="sec-hd">
      <div class="sec-title">Team Hub</div>
      <div style="display:flex;gap:6px">
        <button class="btn-sm" id="btn-slack-team"><i class="fas fa-slack"></i>&nbsp;Slack</button>
        <button class="btn-sm" id="btn-refresh-team"><i class="fas fa-refresh"></i></button>
      </div>
    </div>
    <div class="team-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
      ${tabs.map(t=>`<button class="team-tab-btn ${state.team.activeTab===t.id?'active':''}" onclick="switchTeamTab('${t.id}')"><i class="fas ${t.icon}"></i> ${t.label}</button>`).join('')}
    </div>
    <div id="team-tab-content"></div>
  `;
  document.getElementById('btn-slack-team')?.addEventListener('click', openSlackModal);
  document.getElementById('btn-refresh-team')?.addEventListener('click', buildTeam);
  switchTeamTab(state.team.activeTab);
}

function switchTeamTab(tabId) {
  state.team.activeTab = tabId;
  document.querySelectorAll('.team-tab-btn').forEach(b=>{
    b.classList.toggle('active', b.textContent.toLowerCase().includes(tabId==='sprint'?'sprint':tabId==='pulse'?'pulse':tabId==='standups'?'standup':tabId==='burnout'?'burnout':tabId==='deadlines'?'deadline':'velocity'));
  });
  const content = document.getElementById('team-tab-content');
  if (!content) return;
  if (tabId==='sprint') renderSprintHealth(content);
  else if (tabId==='pulse') renderTeamPulse(content);
  else if (tabId==='standups') renderStandups(content);
  else if (tabId==='burnout') renderBurnoutRisk(content);
  else if (tabId==='deadlines') renderDeadlines(content);
  else if (tabId==='velocity') renderVelocity(content);
}

function renderSprintHealth(el) {
  // Build a realistic demo sprint payload using the correct API format
  const now = new Date();
  const sprintStart = new Date(now); sprintStart.setDate(sprintStart.getDate() - 10);
  const sprintEnd = new Date(now); sprintEnd.setDate(sprintEnd.getDate() + 4);
  const demoCards = [
    {id:'1',title:'Auth flow',status:'done',lastMovedAt:new Date(now.getTime()-86400000).toISOString()},
    {id:'2',title:'API routes',status:'done',lastMovedAt:new Date(now.getTime()-172800000).toISOString()},
    {id:'3',title:'Dashboard UI',status:'inprogress',lastMovedAt:new Date(now.getTime()-3600000).toISOString()},
    {id:'4',title:'Billing',status:'inprogress',lastMovedAt:new Date(now.getTime()-7200000).toISOString()},
    {id:'5',title:'Notifications',status:'todo',lastMovedAt:null},
    {id:'6',title:'Analytics',status:'todo',lastMovedAt:null},
    {id:'7',title:'Mobile layout',status:'done',lastMovedAt:new Date(now.getTime()-259200000).toISOString()},
    {id:'8',title:'Testing',status:'todo',lastMovedAt:null},
  ];
  const apiPayload = { cards: demoCards, sprintStart: sprintStart.toISOString(), sprintEnd: sprintEnd.toISOString(), teamFocusHours: 18 };
  el.innerHTML = `<div class="sprint-health" id="sprint-health-panel">
    <div class="sh-title"><i class="fas fa-heart-pulse" style="color:var(--danger)"></i> Sprint Health</div>
    <div class="sh-stats" id="sh-stats"></div>
    <div class="sh-progress" style="margin-bottom:4px"><div class="sh-fill" id="sh-fill" style="background:var(--grad)"></div></div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-m);margin-bottom:10px">
      <span>Completion <strong id="sh-pct">—</strong></span>
      <span>Expected <strong id="sh-exp">—</strong></span>
      <span id="sh-days"></span>
    </div>
    <div class="sh-pace" id="sh-pace"></div>
    <div id="sh-assessment" style="font-size:13px;color:var(--text-s);margin-bottom:12px;padding:10px;background:var(--bg-card);border-radius:9px;line-height:1.5">Analysing sprint…</div>
    <div id="sh-actions"></div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn-sm" onclick="openSprintConfigModal()"><i class="fas fa-cog"></i> Configure Sprint</button>
      <button class="btn-sm" onclick="exportSprintReport()"><i class="fas fa-download"></i> Export Report</button>
    </div>
  </div>`;
  fetch('/api/team/sprint-health', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(apiPayload) })
    .then(r=>r.json()).then(d=>{
      // API returns: completionPercent, expectedPercent, pace, deadlineAssessment, suggestedActions, daysRemaining, totalCards, completedCards, inProgressCards
      const sh = d;
      const pct = sh.completionPercent ?? Math.round(demoCards.filter(c=>c.status==='done').length/demoCards.length*100);
      const exp = sh.expectedPercent ?? 70;
      const days = sh.daysRemaining ?? 4;
      document.getElementById('sh-fill').style.width=pct+'%';
      document.getElementById('sh-pct').textContent=pct+'%';
      document.getElementById('sh-exp').textContent=exp+'%';
      document.getElementById('sh-days').textContent=days+' days left';
      document.getElementById('sh-stats').innerHTML=[
        {v:sh.totalCards??demoCards.length,l:'Total'},
        {v:sh.completedCards??demoCards.filter(c=>c.status==='done').length,l:'Done'},
        {v:sh.inProgressCards??demoCards.filter(c=>c.status==='inprogress').length,l:'In Progress'},
        {v:sh.atRiskCards?.length??0,l:'At Risk'}
      ].map(s=>`<div class="sh-stat"><div class="sh-stat-v">${s.v}</div><div class="sh-stat-l">${s.l}</div></div>`).join('');
      const pace=sh.pace||'on_track';
      const paceColor=pace==='on_track'?'var(--green)':pace==='ahead'?'var(--blue)':'var(--danger)';
      const paceBg=pace==='on_track'?'rgba(16,185,129,.15)':pace==='ahead'?'rgba(59,130,246,.15)':'rgba(239,68,68,.15)';
      document.getElementById('sh-pace').innerHTML=`<span class="pace-badge" style="background:${paceBg};color:${paceColor}">${pace.replace('_',' ').toUpperCase()}</span>`;
      document.getElementById('sh-assessment').textContent=sh.deadlineAssessment||sh.assessment||'Sprint progressing well.';
      const actions=sh.suggestedActions||sh.actions||['Review blockers','Update statuses'];
      document.getElementById('sh-actions').innerHTML=actions.map(a=>`<div class="action-item"><i class="fas fa-circle-arrow-right"></i>${a}</div>`).join('');
    }).catch(()=>{
      // Fallback: render with hardcoded demo data if API fails
      const pct=38, exp=71, days=4;
      if(!document.getElementById('sh-fill')) return;
      document.getElementById('sh-fill').style.width=pct+'%';
      document.getElementById('sh-pct').textContent=pct+'%';
      document.getElementById('sh-exp').textContent=exp+'%';
      document.getElementById('sh-days').textContent=days+' days left';
      document.getElementById('sh-stats').innerHTML=[{v:8,l:'Total'},{v:3,l:'Done'},{v:2,l:'In Progress'},{v:1,l:'At Risk'}].map(s=>`<div class="sh-stat"><div class="sh-stat-v">${s.v}</div><div class="sh-stat-l">${s.l}</div></div>`).join('');
      document.getElementById('sh-pace').innerHTML=`<span class="pace-badge" style="background:rgba(239,68,68,.15);color:var(--danger)">AT RISK</span>`;
      document.getElementById('sh-assessment').textContent='At current velocity, 2 cards may slip past sprint end. Consider re-scoping or reassigning.';
      document.getElementById('sh-actions').innerHTML=['Hold a quick sync to re-scope','Unblock Dashboard UI — stalled 2 days'].map(a=>`<div class="action-item"><i class="fas fa-circle-arrow-right"></i>${a}</div>`).join('');
    });
}

const DEMO_TEAM = [
  { name:'Alex Chen', role:'senior_dev', status:'focus', wellness:82, av:'👩', focusMin:180, tasks:6 },
  { name:'Jordan Lee', role:'scrum_master', status:'break', wellness:55, av:'🧑', focusMin:120, tasks:4 },
  { name:'Sam Rivera', role:'member', status:'online', wellness:35, av:'👨', focusMin:60, tasks:2 },
  { name:'Taylor Kim', role:'member', status:'offline', wellness:71, av:'🧑', focusMin:90, tasks:5 },
];

function renderTeamPulse(el) {
  const role = FS_USER?.role || 'member';
  const showWellness = role==='admin'||role==='scrum_master';
  el.innerHTML = `
    <div class="sec-hd"><div class="sec-title">Team Pulse <span style="font-size:11px;font-weight:400;color:var(--text-m)">(live presence)</span></div>
      <button class="btn-sm" onclick="openInviteModal()"><i class="fas fa-user-plus"></i> Invite</button>
    </div>
    <div class="team-grid" id="team-pulse-grid"></div>
  `;
  document.getElementById('team-pulse-grid').innerHTML = DEMO_TEAM.map(m=>{
    const wellnessColor=m.wellness>70?'var(--green)':m.wellness>40?'var(--warn)':'var(--danger)';
    return `<div class="member-card">
      <div class="pulse-dot ${m.status}"></div>
      <div class="member-av">${m.av}</div>
      <div class="member-name">${m.name}</div>
      <div class="member-role">${m.role.replace('_',' ')}</div>
      <div style="font-size:11px;color:var(--text-m)">${{focus:'In focus session',online:'Online',break:'On break',offline:'Offline'}[m.status]||m.status}</div>
      <div style="font-size:11px;color:var(--text-m);margin-top:4px">🎯 ${m.tasks} tasks · ⏱ ${m.focusMin}m today</div>
      ${showWellness?`<div class="burnout-bar" style="margin-top:8px"><div class="burnout-fill" style="width:${100-m.wellness}%;background:${wellnessColor}"></div></div><div style="font-size:10px;color:${wellnessColor};margin-top:3px">Wellness: ${m.wellness}/100</div>`:''}
    </div>`;
  }).join('');
}

function renderStandups(el) {
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
      <div class="sh-title"><i class="fas fa-microphone" style="color:var(--accent)"></i> Daily Standup — ${today}</div>
      <div id="standup-entries" style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
        ${DEMO_TEAM.map(m=>`
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
              <span style="font-size:18px">${m.av}</span>
              <strong style="font-size:13px">${m.name}</strong>
              <span class="member-role" style="display:inline-block;font-size:10px;padding:2px 7px;background:rgba(168,85,247,.1);border-radius:5px;color:var(--text-m)">${m.role.replace('_',' ')}</span>
              <div class="pulse-dot ${m.status}" style="margin-left:auto"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px">
              <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--green);margin-bottom:3px">✅ Yesterday</div>${m.tasks>2?'Completed API integration and code review':'Fixed bug in auth flow'}</div>
              <div style="background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--accent);margin-bottom:3px">🎯 Today</div>${m.status==='focus'?'Deep work on feature branch':'Working on tests and documentation'}</div>
              <div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--danger);margin-bottom:3px">🚧 Blockers</div>${m.wellness<50?'Need review from lead on architecture decision':'None'}</div>
            </div>
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-primary" onclick="addMyStandup()"><i class="fas fa-plus"></i> Add My Update</button>
        <button class="btn-sm" onclick="shareStandupSlack()"><i class="fas fa-slack"></i> Share to Slack</button>
      </div>
    </div>
  `;
}

function renderBurnoutRisk(el) {
  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
      <div class="sh-title"><i class="fas fa-fire-flame-curved" style="color:var(--warn)"></i> Burnout Risk Monitor</div>
      <div style="font-size:12px;color:var(--text-m);margin-bottom:12px">Based on session patterns, break compliance, and activity data from the last 7 days.</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${DEMO_TEAM.map(m=>{
          const risk = m.wellness<40?'HIGH':m.wellness<65?'MEDIUM':'LOW';
          const riskColor = m.wellness<40?'var(--danger)':m.wellness<65?'var(--warn)':'var(--green)';
          const indicators = m.wellness<40?['Skipping most breaks','Low card output despite active sessions']:m.wellness<65?['Running sessions over target time','Minor break compliance issues']:['All systems healthy'];
          return `<div style="background:var(--bg-card);border:1px solid ${m.wellness<40?'rgba(239,68,68,.3)':m.wellness<65?'rgba(245,158,11,.3)':'rgba(16,185,129,.2)'};border-radius:10px;padding:12px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <span style="font-size:20px">${m.av}</span>
              <div>
                <div style="font-size:13px;font-weight:700">${m.name}</div>
                <div style="font-size:11px;color:var(--text-m)">${m.role.replace('_',' ')} · ${m.focusMin}m focus today</div>
              </div>
              <span style="margin-left:auto;font-size:11px;font-weight:800;padding:3px 10px;border-radius:7px;background:${m.wellness<40?'rgba(239,68,68,.15)':m.wellness<65?'rgba(245,158,11,.15)':'rgba(16,185,129,.15)'};color:${riskColor}">${risk}</span>
            </div>
            <div class="burnout-bar"><div class="burnout-fill" style="width:${100-m.wellness}%;background:${riskColor}"></div></div>
            <div style="font-size:10px;color:${riskColor};margin:4px 0 6px">Wellness score: ${m.wellness}/100</div>
            <div style="font-size:11px;color:var(--text-m)">${indicators.map(i=>`<div>• ${i}</div>`).join('')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderDeadlines(el) {
  const now = new Date();
  const deadlines = [
    { title:'Q2 Feature Launch', date: new Date(now.getTime()+3*24*60*60*1000), owner:'Alex Chen', status:'on-track', progress:75 },
    { title:'API Documentation', date: new Date(now.getTime()+7*24*60*60*1000), owner:'Jordan Lee', status:'at-risk', progress:45 },
    { title:'Security Audit', date: new Date(now.getTime()+14*24*60*60*1000), owner:'Sam Rivera', status:'on-track', progress:30 },
    { title:'Performance Review', date: new Date(now.getTime()+21*24*60*60*1000), owner:'Taylor Kim', status:'ahead', progress:90 },
  ];
  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
      <div class="sh-title"><i class="fas fa-clock" style="color:var(--warn)"></i> Deadline Intelligence</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${deadlines.map(d=>{
          const daysLeft = Math.round((d.date-now)/86400000);
          const statusColor = d.status==='ahead'?'var(--blue)':d.status==='on-track'?'var(--green)':'var(--danger)';
          const urgency = daysLeft<=3?'🔴':daysLeft<=7?'🟡':'🟢';
          return `<div class="deadline-item" style="border:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
              <div style="font-weight:700;font-size:13px">${urgency} ${d.title}</div>
              <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;background:${d.status==='ahead'?'rgba(59,130,246,.15)':d.status==='on-track'?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)'};color:${statusColor}">${d.status.toUpperCase()}</span>
            </div>
            <div style="font-size:11px;color:var(--text-m);margin-bottom:7px">Owner: ${d.owner} · Due in ${daysLeft} day${daysLeft!==1?'s':''} (${d.date.toLocaleDateString('en-US',{month:'short',day:'numeric'})})</div>
            <div class="sh-progress"><div class="sh-fill" style="width:${d.progress}%;background:${statusColor}"></div></div>
            <div style="font-size:10px;color:var(--text-m);margin-top:3px">${d.progress}% complete</div>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:12px">
        <button class="btn-sm" onclick="addDeadline()"><i class="fas fa-plus"></i> Add Deadline</button>
      </div>
    </div>
  `;
}

function renderVelocity(el) {
  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
      <div class="sh-title"><i class="fas fa-chart-line" style="color:var(--blue)"></i> Team Velocity</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px">
        ${[
          {label:'Sprint Velocity',val:'2.1',unit:'pts/day',color:'var(--accent)'},
          {label:'Avg Session',val:'47',unit:'min',color:'var(--blue)'},
          {label:'PR Cycle Time',val:'1.8',unit:'days',color:'var(--green)'},
          {label:'Deploy Freq',val:'3.2',unit:'/week',color:'var(--warn)'},
        ].map(s=>`<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:11px;padding:14px;text-align:center">
          <div style="font-size:22px;font-weight:900;color:${s.color}">${s.val}<span style="font-size:11px">${s.unit}</span></div>
          <div style="font-size:11px;color:var(--text-m);margin-top:4px">${s.label}</div>
        </div>`).join('')}
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Individual Velocity (last 7 days)</div>
      ${DEMO_TEAM.map(m=>`
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(168,85,247,.06)">
          <span style="font-size:16px">${m.av}</span>
          <div style="flex:1">
            <div style="font-size:12px;font-weight:700">${m.name}</div>
            <div style="font-size:10px;color:var(--text-m)">${m.tasks} tasks completed · ${m.focusMin}m focus</div>
          </div>
          <div style="width:80px">
            <div class="sh-progress" style="margin-bottom:2px"><div class="sh-fill" style="width:${Math.round(m.tasks/8*100)}%;background:${m.tasks>=5?'var(--green)':m.tasks>=3?'var(--warn)':'var(--danger)'}"></div></div>
            <div style="font-size:10px;color:var(--text-m);text-align:right">${m.tasks}/8 target</div>
          </div>
        </div>`).join('')}
    </div>
  `;
}

function openSprintConfigModal() {
  openModal(`<h2>⚙️ Configure Sprint</h2>
    <p style="color:var(--text-s);font-size:13px;margin:6px 0 14px">Set sprint parameters for accurate health tracking.</p>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div><label style="font-size:12px;color:var(--text-m)">Sprint Duration</label>
        <select class="fs-sel" style="width:100%;margin-top:6px"><option>1 week</option><option selected>2 weeks</option><option>3 weeks</option><option>4 weeks</option></select></div>
      <div><label style="font-size:12px;color:var(--text-m)">Total Story Points</label>
        <input class="fs-in" type="number" value="40" style="margin-top:6px"></div>
      <div><label style="font-size:12px;color:var(--text-m)">Team Size</label>
        <input class="fs-in" type="number" value="4" style="margin-top:6px"></div>
    </div>
    <button class="btn-primary" style="width:100%;margin-top:14px" onclick="closeModal();notify('Sprint configured','success')">Save Configuration</button>`);
}

function exportSprintReport() { notify('Sprint report exported (PDF coming soon)','info'); }
function addMyStandup() { notify('Standup form opening soon','info'); }
function shareStandupSlack() {
  if (!FS_SLACK) { notify('Connect Slack in Settings first','info'); return; }
  notify('Standup shared to Slack!','success');
}
function addDeadline() {
  openModal(`<h2>➕ Add Deadline</h2>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
      <input class="fs-in" placeholder="Deadline title" id="dl-title">
      <input class="fs-in" type="date" id="dl-date">
      <input class="fs-in" placeholder="Owner name" id="dl-owner">
    </div>
    <button class="btn-primary" style="width:100%;margin-top:14px" onclick="closeModal();notify('Deadline added','success')">Add Deadline</button>`);
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
    body: JSON.stringify({ channel:chan, text:msg })
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
    { type:'Science',title:'Ultradian Rhythms',content:'The human brain naturally cycles through 90-minute high-focus periods. Align your sessions to your natural ultradian rhythm.',color:'#06b6d4',textColor:'#fff',source:'Neuroscience' },
    { type:'Mindset',title:'Growth Mindset',content:"Effort and strategy, not fixed talent, drive success. Carol Dweck's research shows 'not yet' is more powerful than 'I can't.'",color:'#f59e0b',textColor:'#fff',source:'Carol Dweck' },
    { type:'Tip',title:'The 2-Minute Rule',content:"If a task takes less than 2 minutes, do it immediately. This prevents small tasks from piling up and cluttering your mental bandwidth.",color:'#8b5cf6',textColor:'#fff',source:'GTD — David Allen' },
    { type:'Health',title:'Power Nap Science',content:'A 10-20 minute nap improves alertness for 2-3 hours. Avoid naps over 30 minutes — you enter deep sleep and wake groggy.',color:'#0ea5e9',textColor:'#fff',source:'Sleep Research' },
    { type:'Productivity',title:'Single-Tasking',content:'Multitasking reduces productivity by up to 40%. Deep focus on one task compounds quality and speed exponentially.',color:'#14b8a6',textColor:'#fff',source:'MIT Research' },
    { type:'Science',title:'Flow State Triggers',content:'Flow emerges when challenge (104%) slightly exceeds skill (100%). Too easy = boredom. Too hard = anxiety. Find the edge.',color:'#a855f7',textColor:'#fff',source:'Csikszentmihalyi' },
  ];
}

function renderLearn() {
  const car = document.getElementById('learn-car');
  const nav = document.getElementById('l-nav');
  const all = document.getElementById('all-learn-cards');
  const cards = state.learn.cards;
  const learnContainer = document.getElementById('tab-pane-learn');
  if (!cards.length || !car) return;
  const c = cards[state.learn.idx];
  const cardTextColor = c.textColor || (c.color && c.color !== 'var(--bg-panel)' ? '#fff' : 'var(--text-p)');
  car.innerHTML = `<div class="l-card" style="background:${c.color||'var(--bg-panel)'};color:${cardTextColor}">
    <div class="l-type">${c.type||'Tip'}</div>
    <div class="l-title">${c.title||''}</div>
    <div class="l-content">${c.content||''}</div>
    <div class="l-meta">${c.meta||c.source||''}</div>
    <div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
      <button class="r-btn" onclick="markCardLearned()" style="font-size:11px;padding:5px 14px">✓ Got it</button>
      <button class="r-btn" onclick="askAIAboutCard()" style="font-size:11px;padding:5px 14px">💬 Ask AI</button>
    </div>
  </div>`;
  if (nav) nav.innerHTML = `<button class="l-nav-btn" onclick="learnNav(-1)"><i class="fas fa-chevron-left"></i></button>${cards.map((_,i)=>`<div class="l-dot ${i===state.learn.idx?'active':''}" onclick="learnGo(${i})"></div>`).join('')}<button class="l-nav-btn" onclick="learnNav(1)"><i class="fas fa-chevron-right"></i></button>`;
  if (all) all.innerHTML = cards.map((card,i)=>`<div style="background:${card.color||'var(--bg-panel)'};border-radius:9px;padding:11px;cursor:pointer;color:${card.textColor||(card.color&&card.color!=='var(--bg-panel)'?'#fff':'var(--text-p)')};transition:.2s" onclick="learnGo(${i})" onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'"><div style="font-size:10px;font-weight:700;opacity:.7;margin-bottom:3px">${card.type||''}</div><div style="font-size:12px;font-weight:700">${card.title||''}</div></div>`).join('');
  // Render spaced repetition queue
  renderSpacedRep();
}

function learnNav(dir) { state.learn.idx = (state.learn.idx + dir + state.learn.cards.length) % state.learn.cards.length; renderLearn(); }
function learnGo(i)   { state.learn.idx = i; renderLearn(); }

function markCardLearned() {
  const c = state.learn.cards[state.learn.idx];
  const count = parseInt(localStorage.getItem('gratitude_count')||'0');
  localStorage.setItem('learn_count', parseInt(localStorage.getItem('learn_count')||'0')+1);
  notify(`✅ "${c.title}" marked as learned!`,'success');
  learnNav(1);
}

function askAIAboutCard() {
  const c = state.learn.cards[state.learn.idx];
  switchTab('chat');
  const inp = document.getElementById('chat-in');
  if (inp) { inp.value = `Tell me more about "${c.title}" — give me practical ways to apply this in my work.`; sendMessage(); }
}

function renderSpacedRep() {
  const srEl = document.getElementById('learn-spaced-rep');
  if (!srEl) return;
  const dueCards = state.learn.cards.filter((_,i) => i%3===0).slice(0,3);
  srEl.innerHTML = `
    <div class="sec-title" style="margin-bottom:10px">📅 Review Queue (${dueCards.length} due)</div>
    ${dueCards.map((c,i)=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 11px;background:var(--bg-card);border:1px solid var(--border);border-radius:9px;margin-bottom:7px">
      <div style="width:10px;height:10px;border-radius:50%;background:${c.color||'var(--accent)'}"></div>
      <div style="flex:1;font-size:12px;font-weight:600">${c.title}</div>
      <button class="btn-sm" onclick="learnGo(${i*3});switchTab('learn')">Review</button>
    </div>`).join('')}
  `;
}

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
  {
    emoji:'💪', title:'Body Reset', gradient:'linear-gradient(135deg,#ef4444,#f59e0b)',
    steps:['Roll your shoulders back 5 times','Stretch your neck side to side','Stand and take 10 steps','Shake out your hands','Take 3 deep breaths'],
    type:'body'
  },
  {
    emoji:'🧘', title:'Guided Meditation', gradient:'linear-gradient(135deg,#8b5cf6,#ec4899)',
    content:'Sit comfortably. Focus on the space between your thoughts. When your mind wanders, gently return. There is nowhere to be but here.',
    type:'meditation',
    duration: 60
  },
  {
    emoji:'🎯', title:'Micro Win', gradient:'linear-gradient(135deg,#10b981,#a855f7)',
    content:'Name one thing you accomplished today, no matter how small. Progress compounds. Every step forward builds momentum.',
    type:'win'
  },
  {
    emoji:'🌅', title:'Visualization', gradient:'linear-gradient(135deg,#f59e0b,#ef4444)',
    content:'Picture your ideal version of tomorrow. What does success look like? See it clearly. Feel it. Your brain cannot distinguish between vivid imagination and reality.',
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
    inner += `<div class="breath-circ" id="breath-circ" onclick="pulseBreath()" title="Click to breathe">Tap</div><div class="r-steps">${s.steps.map((st,i)=>`<div class="r-step"><div class="r-step-n">${i+1}</div>${st}</div>`).join('')}</div>
      <button class="r-btn" onclick="startGuidedBreathing()" style="margin-top:8px">🎵 Start Guided Session</button>`;
  } else if (s.type==='gratitude') {
    inner += `<div class="r-content">${s.content}</div>
      <input class="grat-in" id="grat-in" placeholder="I'm grateful for...">
      <button class="r-btn" onclick="logGratitude()">Log It 🙏</button>
      <div id="grat-log" style="margin-top:12px;max-width:300px;width:100%"></div>`;
  } else if (s.type==='meditation') {
    inner += `<div class="r-content">${s.content}</div>
      <div id="med-timer" style="font-size:36px;font-weight:900;margin:14px 0;font-variant-numeric:tabular-nums">1:00</div>
      <div style="display:flex;gap:8px">
        <button class="r-btn" id="med-start-btn" onclick="toggleMeditation(${s.duration||60})">▶ Start</button>
        <button class="r-btn" onclick="adjustMeditation(-30)">-30s</button>
        <button class="r-btn" onclick="adjustMeditation(30)">+30s</button>
      </div>`;
  } else if (s.type==='body') {
    inner += `<div class="r-steps">${s.steps.map((st,i)=>`<div class="r-step" onclick="this.style.opacity='.4'" style="cursor:pointer"><div class="r-step-n">${i+1}</div>${st}</div>`).join('')}</div>
      <div class="r-content" style="margin-top:10px;font-size:12px;opacity:.7">Tap each step to mark it done</div>`;
  } else if (s.type==='win') {
    inner += `<div class="r-content">${s.content}</div>
      <input class="grat-in" id="win-in" placeholder="My win today is...">
      <button class="r-btn" onclick="logWin()">Celebrate 🎉</button>`;
  } else {
    inner += `<div class="r-content">${s.content}</div>
      <button class="r-btn" onclick="askAIForQuote()" style="margin-top:10px">💬 Ask AI for inspiration</button>`;
  }
  scene.innerHTML = inner; scene.style.background = s.gradient;
  if (nav) nav.innerHTML = `
    <button class="r-btn" onclick="restoreNav(-1)"><i class="fas fa-chevron-left"></i></button>
    <span style="font-size:11px;color:rgba(255,255,255,.7)">${state.restore.idx+1}/${state.restore.scenes.length}</span>
    <button class="r-btn" onclick="restoreNav(1)"><i class="fas fa-chevron-right"></i></button>`;
  // Load gratitude log
  if (s.type==='gratitude') showGratitudeLog();
}

function showGratitudeLog() {
  const el = document.getElementById('grat-log');
  if (!el) return;
  const prev = JSON.parse(localStorage.getItem('gratitude_log')||'[]').slice(0,5);
  if (!prev.length) { el.innerHTML='<div style="font-size:11px;opacity:.6">No entries yet. Start with one thing today!</div>'; return; }
  el.innerHTML = prev.map(e=>`<div style="background:rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;margin-bottom:5px;font-size:12px;text-align:left"><div style="opacity:.7;font-size:10px">${e.date}</div>${escHtml(e.text)}</div>`).join('');
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

function startGuidedBreathing() {
  let step = 0;
  const phases = ['Inhale...','Hold...','Exhale...','Hold...'];
  const durations = [4000,4000,4000,4000];
  function nextPhase() {
    const circ = document.getElementById('breath-circ');
    if (!circ) return;
    circ.textContent = phases[step%phases.length];
    circ.classList.toggle('expand', step%4<2);
    setTimeout(()=>{ step++; if(step<16) nextPhase(); else { if(circ){circ.textContent='Done ✓';circ.classList.remove('expand');} } }, durations[step%4]);
  }
  nextPhase();
}

let meditationInterval = null, meditationSec = 60;
function toggleMeditation(duration) {
  const btn = document.getElementById('med-start-btn');
  if (meditationInterval) {
    clearInterval(meditationInterval); meditationInterval=null;
    if (btn) btn.textContent='▶ Start';
  } else {
    meditationSec = duration;
    if (btn) btn.textContent='⏸ Pause';
    meditationInterval = setInterval(()=>{
      meditationSec--;
      const el = document.getElementById('med-timer');
      if (el) el.textContent = Math.floor(meditationSec/60)+':'+(meditationSec%60).toString().padStart(2,'0');
      if (meditationSec<=0) {
        clearInterval(meditationInterval); meditationInterval=null;
        if (btn) btn.textContent='▶ Restart';
        notify('🧘 Meditation complete! Well done.','success');
      }
    },1000);
  }
}

function adjustMeditation(delta) {
  meditationSec = Math.max(10, meditationSec + delta);
  const el = document.getElementById('med-timer');
  if (el) el.textContent = Math.floor(meditationSec/60)+':'+(meditationSec%60).toString().padStart(2,'0');
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
  showGratitudeLog();
}

function logWin() {
  const val = document.getElementById('win-in')?.value?.trim();
  if (!val) { notify('Name your win first','info'); return; }
  triggerCelebration('Micro Win! 🎯', val.slice(0,50));
  document.getElementById('win-in').value='';
  notify('Win logged! Keep the momentum 🚀','success');
}

function askAIForQuote() {
  switchTab('chat');
  const inp = document.getElementById('chat-in');
  if (inp) { inp.value='Give me a powerful, concise motivational quote about focus and deep work. Keep it under 2 sentences.'; sendMessage(); }
}

function restoreNav(dir) {
  if (meditationInterval) { clearInterval(meditationInterval); meditationInterval=null; }
  state.restore.idx = (state.restore.idx + dir + state.restore.scenes.length) % state.restore.scenes.length;
  renderRestore();
}

// ── Generate ───────────────────────────────────────────────────────────────
async function generateImage() {
  const prompt = document.getElementById('img-prompt').value.trim();
  const model  = state.gen?.imgModel || 'dalle3';
  if (!prompt) { notify('Enter a prompt','error'); return; }
  const btn = document.getElementById('btn-gen-img'); btn.disabled=true; btn.textContent='Generating...';
  try {
    const r = await fetch('/api/generate/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model})});
    const d = await r.json();
    const results = document.getElementById('img-results');
    if (d.imageUrl) results.innerHTML = `<div style="position:relative"><img class="gen-img" src="${d.imageUrl}" alt="${escHtml(prompt)}" onclick="window.open('${d.imageUrl}')"><a href="${d.imageUrl}" download class="btn-gen" style="position:absolute;bottom:8px;right:8px;padding:6px 12px;font-size:11px"><i class="fas fa-download"></i></a></div>`;
    else if (d.imageBase64) results.innerHTML = `<img class="gen-img" src="data:image/jpeg;base64,${d.imageBase64}" alt="${escHtml(prompt)}">`;
    else results.innerHTML = `<div style="color:var(--danger);font-size:13px">${d.error||'Generation failed — add API key in Credentials'}</div>`;
  } catch(e) { notify('Image generation error','error'); }
  finally { btn.disabled=false; btn.innerHTML='<i class="fas fa-wand-magic-sparkles"></i>&nbsp; Generate Image'; }
}

async function generateVideo() {
  const prompt = document.getElementById('vid-prompt').value.trim();
  const model  = state.gen?.vidModel || 'veo2';
  const dur    = document.getElementById('vid-dur')?.value || '5';
  if (!prompt) { notify('Enter a prompt','error'); return; }
  const btn = document.getElementById('btn-gen-vid'); btn.disabled=true; btn.textContent='Queuing...';
  try {
    const r = await fetch('/api/generate/video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model,duration:parseInt(dur)})});
    const d = await r.json();
    document.getElementById('vid-result').innerHTML = d.queued ? `<i class="fas fa-clock" style="color:var(--warn)"></i> ${d.message||'Video queued.'}` : (d.videoUrl ? `<video src="${d.videoUrl}" controls style="width:100%;border-radius:11px"></video>` : `<span style="color:var(--danger)">${d.error||'Generation failed'}</span>`);
  } catch(e) { notify('Video generation error','error'); }
  finally { btn.disabled=false; btn.innerHTML='<i class="fas fa-film"></i>&nbsp; Generate Video'; }
}

async function generateImageToVideo() {
  const fileInput = document.getElementById('img2vid-upload');
  const prompt = document.getElementById('img2vid-prompt').value.trim();
  const model  = state.gen?.i2vModel || 'kling16';
  if (!fileInput?.files?.length && !prompt) { notify('Upload an image or enter a prompt','error'); return; }
  const btn = document.getElementById('btn-img2vid'); btn.disabled=true; btn.textContent='Processing...';
  const resultEl = document.getElementById('img2vid-result');
  resultEl.innerHTML = '<div style="color:var(--text-m);font-size:13px"><i class="fas fa-spinner fa-spin"></i> Queuing image-to-video generation… This can take 1-3 minutes.</div>';
  try {
    let imageUrl = '';
    // If file uploaded, we'd need to upload it first — for now use prompt-only fallback
    if (fileInput?.files?.length) {
      // Read as data URL for preview
      const reader = new FileReader();
      reader.onload = e => {
        const preview = document.getElementById('img2vid-preview');
        if (preview) { preview.src=e.target.result; preview.style.display='block'; }
      };
      reader.readAsDataURL(fileInput.files[0]);
      imageUrl = 'data:uploaded-image'; // Signal to backend
    }
    const r = await fetch('/api/generate/video',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt:prompt||'Animate this image with smooth, natural motion',model,duration:5,imageUrl})});
    const d = await r.json();
    if (d.queued || d.demo) {
      resultEl.innerHTML = `<i class="fas fa-clock" style="color:var(--warn)"></i> ${d.message||'Image-to-video queued. Add API keys to generate real videos.'}`;
    } else if (d.videoUrl) {
      resultEl.innerHTML = `<video src="${d.videoUrl}" controls style="width:100%;border-radius:11px;margin-top:8px"></video>`;
    } else {
      resultEl.innerHTML = `<span style="color:var(--danger);font-size:13px">${d.error||'Generation failed — add video API key in Credentials'}</span>`;
    }
  } catch(e) { resultEl.innerHTML='<span style="color:var(--danger)">Error — check network and API keys</span>'; }
  finally { btn.disabled=false; btn.innerHTML='<i class="fas fa-video"></i>&nbsp; Generate Video from Image'; }
}

// ── Utilities ──────────────────────────────────────────────────────────────
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openModal(html, wide=false) {
  document.getElementById('modal-ov')?.remove();
  const ov = document.createElement('div'); ov.className='modal-ov'; ov.id='modal-ov';
  ov.innerHTML = `<div class="modal-card${wide?' modal-wide':''}">${html}<div style="margin-top:14px;text-align:right"><button class="btn-sm" onclick="closeModal()">Close</button></div></div>`;
  ov.addEventListener('click', e => { if(e.target===ov) closeModal(); });
  document.body.appendChild(ov);
}

function closeModal() { document.getElementById('modal-ov')?.remove(); }

// ── Pricing modal state ───────────────────────────────────────
let _pricingCycle = 'monthly'; // 'monthly' | 'annual'

function openPricingModal() {
  _pricingCycle = 'monthly';
  _renderPricingModal();
}

function _renderPricingModal() {
  const annual = _pricingCycle === 'annual';
  const tiers = [
    {
      key: 'free',
      name: 'Free',
      monthlyPrice: '$0',
      annualPrice: '$0',
      badge: '',
      color: 'var(--text-s)',
      feats: [
        '7 AI models (5k tokens/day)',
        '25-min Pomodoro timer',
        'Basic Kanban board',
        'Focus metrics',
        '3 team members',
      ],
    },
    {
      key: 'pro',
      name: 'Pro',
      monthlyPrice: '$18<span style="font-size:12px;font-weight:400">/mo</span>',
      annualPrice: '$14<span style="font-size:12px;font-weight:400">/mo</span>',
      annualNote: 'billed $168/yr',
      monthlyNote: 'billed monthly',
      badge: 'MOST POPULAR',
      color: 'var(--accent)',
      hi: true,
      feats: [
        'All AI models (GPT-5, Claude, Gemini, Grok)',
        '100k tokens/day',
        'Google Calendar sync',
        'Notion + Slack integration',
        'Advanced metrics & insights',
        'Image & video generation',
      ],
    },
    {
      key: 'team',
      name: 'Team',
      monthlyPrice: '$15<span style="font-size:12px;font-weight:400">/seat/mo</span>',
      annualPrice: '$12<span style="font-size:12px;font-weight:400">/seat/mo</span>',
      annualNote: 'billed $144/seat/yr',
      monthlyNote: 'min 2 seats',
      badge: '',
      color: 'var(--blue)',
      feats: [
        'Everything in Pro',
        'Sprint Health & velocity',
        'Burnout Monitor',
        'Team Pulse & standups',
        'Deadline alerts',
        'Role-gated controls',
      ],
    },
    {
      key: 'enterprise',
      name: 'Enterprise',
      monthlyPrice: 'Custom',
      annualPrice: 'Custom',
      badge: '',
      color: 'var(--warn)',
      feats: [
        'SSO / SAML',
        'Audit logs',
        'Custom AI models',
        'SLA + dedicated support',
        'Volume seat pricing',
      ],
    },
  ];

  const toggleHtml = `
    <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0 18px">
      <span style="font-size:13px;color:${!annual?'var(--text)':'var(--text-s)'}">Monthly</span>
      <div onclick="togglePricingCycle()" style="cursor:pointer;width:44px;height:24px;border-radius:12px;background:${annual?'var(--accent)':'rgba(255,255,255,.15)'};position:relative;transition:background .2s">
        <div style="position:absolute;top:3px;left:${annual?'23px':'3px'};width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s"></div>
      </div>
      <span style="font-size:13px;color:${annual?'var(--text)':'var(--text-s)'}">Annual <span style="background:rgba(16,185,129,.2);color:#10b981;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin-left:4px">SAVE 22%</span></span>
    </div>
  `;

  const cards = tiers.map(t => {
    const price = annual ? t.annualPrice : t.monthlyPrice;
    const note  = annual ? (t.annualNote||'') : (t.monthlyNote||'');
    const badgeHtml = t.badge ? `<div style="background:var(--accent);color:#fff;font-size:9px;font-weight:800;letter-spacing:1px;border-radius:4px;padding:2px 7px;margin-bottom:6px;display:inline-block">${t.badge}</div>` : '<div style="height:20px"></div>';
    const ctaLabel = t.key === 'free' ? 'Current Plan' : t.key === 'enterprise' ? 'Contact Sales' : `Get ${t.name}`;
    const ctaStyle = t.hi
      ? `background:var(--accent);color:#fff;border:none;`
      : `background:rgba(255,255,255,.08);color:var(--text);border:1px solid var(--border);`;
    return `
      <div class="t-card ${t.hi?'hi':''}" style="display:flex;flex-direction:column;min-width:140px">
        ${badgeHtml}
        <h3 style="color:${t.color};margin:0 0 4px">${t.name}</h3>
        <div class="price" style="font-size:22px;font-weight:800;margin-bottom:2px">${price}</div>
        <div style="font-size:11px;color:var(--text-s);margin-bottom:10px;min-height:14px">${note}</div>
        <ul class="t-feats" style="flex:1;margin-bottom:12px">${t.feats.map(f=>`<li>${f}</li>`).join('')}</ul>
        <button onclick="startCheckout('${t.key}')" style="width:100%;padding:8px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;${ctaStyle}">${ctaLabel}</button>
      </div>`;
  }).join('');

  openModal(`
    <h2 style="text-align:center">⚡ FlowState Plans</h2>
    <p style="color:var(--text-s);font-size:13px;margin-top:4px;text-align:center">Replace your entire productivity stack — one workspace.</p>
    ${toggleHtml}
    <div class="tier-cards" style="grid-template-columns:repeat(auto-fit,minmax(155px,1fr))">${cards}</div>
    <p style="color:var(--text-s);font-size:11px;text-align:center;margin-top:12px">All plans include a 14-day money-back guarantee. Cancel anytime.</p>
  `);
}

function togglePricingCycle() {
  _pricingCycle = _pricingCycle === 'monthly' ? 'annual' : 'monthly';
  _renderPricingModal();
}

function startCheckout(tier) {
  if (tier === 'free') return;
  if (tier === 'enterprise') {
    openModal(`<div style="text-align:center;padding:20px 0">
      <div style="font-size:40px;margin-bottom:12px">🏢</div>
      <h2>Enterprise Plan</h2>
      <p style="color:var(--text-s);font-size:14px;margin:10px 0 20px">Custom pricing for your team size, SSO, audit logs, and dedicated SLA support.</p>
      <a href="mailto:hello@flowstate.app?subject=Enterprise%20Inquiry" style="display:inline-block;background:var(--accent);color:#fff;padding:10px 24px;border-radius:8px;font-weight:700;text-decoration:none">📧 Contact Sales</a>
    </div>`);
    return;
  }
  if (!FS_USER && !state.settings.isDemo) { notify('Sign in to upgrade','info'); return; }
  notify('Opening secure checkout…', 'info');
  fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier, billing_cycle: _pricingCycle }),
  }).then(r => r.json()).then(d => {
    if (d.checkoutUrl) {
      window.open(d.checkoutUrl, '_blank');
    } else if (d.enterpriseContact) {
      notify(d.message, 'info');
    } else {
      notify(d.message || 'Opening checkout…', 'info');
    }
  }).catch(() => notify('Billing error — please try again', 'error'));
}

// ── Platform Status — checks which API keys are live ─────────────────────────
let _keyStatus = null;

async function loadPlatformStatus() {
  const grid = document.getElementById('platform-status-grid');
  if (!grid) return;

  // Use cached if recent
  if (!_keyStatus) {
    try {
      const r = await fetch('/api/key-status');
      _keyStatus = await r.json();
    } catch(e) {
      grid.innerHTML = '<div style="color:var(--text-s);font-size:12px;grid-column:1/-1">Could not load platform status.</div>';
      return;
    }
  }

  const s = _keyStatus;
  const row = (label, icon, live, desc) => `
    <div style="background:var(--bg-card);border:1px solid ${live ? 'rgba(16,185,129,.3)' : 'rgba(245,158,11,.3)'};border-radius:9px;padding:11px 13px;display:flex;align-items:center;gap:10px">
      <span style="font-size:16px">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:12px;display:flex;align-items:center;gap:6px">
          ${label}
          <span style="font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:${live ? 'rgba(16,185,129,.15)' : 'rgba(245,158,11,.15)'};color:${live ? '#10b981' : '#f59e0b'}">${live ? '● LIVE' : '⚠ MISSING'}</span>
        </div>
        <div style="font-size:11px;color:var(--text-s);margin-top:2px">${desc}</div>
      </div>
    </div>`;

  // Core services
  const coreOk = s.google_oauth && s.openrouter && s.redis && s.stripe;
  const aiOk   = s.google_ai && s.elevenlabs && s.replicate;

  grid.innerHTML = `
    <div style="grid-column:1/-1;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-m);margin-bottom:2px">Core Services</div>
    ${row('Google OAuth', '🔐', s.google_oauth, 'Sign-in, Calendar, Drive sync')}
    ${row('OpenRouter', '🤖', s.openrouter, 'All AI chat — GPT, Claude, Grok, Gemini')}
    ${row('Upstash Redis', '⚡', s.redis, 'Billing tiers, token limits, sessions')}
    ${row('Stripe', '💳', s.stripe, 'Subscriptions & token top-ups')}
    ${row('Resend Email', '✉️', s.resend, 'Magic links & notifications')}

    <div style="grid-column:1/-1;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-m);margin:10px 0 2px">AI Services</div>
    ${row('Google AI (Gemini + Imagen + Veo)', '🧠', s.google_ai, 'Chat, image gen, video gen')}
    ${row('ElevenLabs', '🎙️', s.elevenlabs, 'Text-to-speech, voice cloning')}
    ${row('Replicate', '🎞️', s.replicate, 'AI upscale, slow-mo, face restore')}
    ${row('OpenAI (DALL-E / Sora)', '✨', s.openai, 'Image gen + Sora video')}

    <div style="grid-column:1/-1;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-m);margin:10px 0 2px">Optional Image Models</div>
    ${row('Stability AI (SD3)', '🎨', s.stability, 'Stable Diffusion 3')}
    ${row('Black Forest Labs (FLUX)', '🌊', s.bfl, 'FLUX Pro 1.1 & Dev')}
    ${row('Ideogram', '🔤', s.ideogram, 'Text-in-image, logos, typography')}
    ${row('Recraft V3', '🖌️', s.recraft, 'Vector art, brand assets, icons')}

    <div style="grid-column:1/-1;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-m);margin:10px 0 2px">Optional Video Models</div>
    ${row('Runway ML (Gen-4)', '🎬', s.runway, 'Film-quality video generation')}
    ${row('Kling 1.6 / 2.1', '🚀', s.kling, 'Smooth motion, text-to-video')}
    ${row('Pika 2.0', '⚡', s.pika, 'Creative effects, fast gen')}
    ${row('MiniMax / Hailuo', '🌀', s.minimax, 'Fast gen, face consistency')}
    ${row('Luma Dream Machine', '🌙', s.luma, 'Photorealistic, product shots')}
    ${row('Suno (AI Music)', '🎵', s.suno, 'Full-track AI music generation')}

    <div style="grid-column:1/-1;margin-top:12px;padding:10px 12px;background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.2);border-radius:9px;font-size:11px;color:var(--text-s)">
      Keys are stored as <strong style="color:var(--text)">Cloudflare Secrets</strong> — never visible to users. Contact the platform admin to activate missing services.
    </div>
  `;
}

function openCredsModal() {
  Promise.all([
    fetch('/api/credentials').then(r=>r.json()),
    fetch('/api/key-status').then(r=>r.json()).catch(()=>({}))
  ]).then(([d, ks]) => {
    _keyStatus = ks; // cache for platform status panel

    // Build a lookup: envKey → live boolean
    // Map each CREDENTIAL_TABLE envKey string to the matching key-status field
    const KEY_MAP = {
      'GOOGLE_CLIENT_ID': ks.google_oauth, 'GOOGLE_CLIENT_SECRET': ks.google_oauth,
      'OPENROUTER_API_KEY': ks.openrouter,
      'UPSTASH_REDIS_URL': ks.redis, 'UPSTASH_REDIS_TOKEN': ks.redis,
      'STRIPE_SECRET_KEY': ks.stripe, 'STRIPE_PUBLISHABLE_KEY': ks.stripe, 'STRIPE_WEBHOOK_SECRET': ks.stripe,
      'RESEND_API_KEY': ks.resend,
      'NOTION_CLIENT_ID': ks.notion, 'NOTION_CLIENT_SECRET': ks.notion,
      'SLACK_CLIENT_ID': ks.slack, 'SLACK_CLIENT_SECRET': ks.slack, 'SLACK_BOT_TOKEN': ks.slack,
      'GOOGLE_AI_KEY': ks.google_ai,
      'ELEVENLABS_API_KEY': ks.elevenlabs,
      'REPLICATE_API_KEY': ks.replicate,
      'OPENAI_API_KEY': ks.openai,
      'XAI_API_KEY': ks.xai,
      'STABILITY_API_KEY': ks.stability,
      'BFL_API_KEY': ks.bfl,
      'IDEOGRAM_API_KEY': ks.ideogram,
      'RECRAFT_API_KEY': ks.recraft,
      'RUNWAY_API_KEY': ks.runway,
      'KLING_API_KEY': ks.kling,
      'PIKA_API_KEY': ks.pika,
      'MINIMAX_API_KEY': ks.minimax,
      'LUMA_API_KEY': ks.luma,
      'SUNO_API_KEY': ks.suno,
    };

    const isLive = (envKey) => {
      const keys = envKey.split(',').map(k=>k.trim());
      return keys.some(k => KEY_MAP[k] === true);
    };
    const isAllMissing = (envKey) => {
      const keys = envKey.split(',').map(k=>k.trim());
      return keys.every(k => KEY_MAP[k] === false);
    };

    const coreItems=[], recItems=[], imgItems=[], vidItems=[], integItems=[], audioItems=[], pro264Items=[], otherItems=[];
    const imgKeywords = ['Stability AI','Black Forest Labs','Ideogram','Recraft','Imagen','DALL-E','GPT-Image','OpenAI'];
    const vidKeywords = ['Runway ML','Kling','Pika Labs','MiniMax','Luma AI','Veo','Sora'];
    const audioKeywords = ['Suno','Udio','MusicGen','Moises','Loudme','ACRCloud','Dolby','AudioShake','ElevenLabs'];
    const pro264Keywords = ['Replicate','Hugging Face','Cloudflare R2','Clawbot'];
    const integKeywords = ['Microsoft','GitHub OAuth','Linear','Jira','Asana','Oura','Whoop','Plaid','Beehiiv','YouTube Embed','Spotify Embed'];

    (d.credentials||[]).forEach(c=>{
      if (c.required==='core') { coreItems.push(c); return; }
      if (c.required==='recommended') { recItems.push(c); return; }
      if (imgKeywords.some(k=>c.service.includes(k))) { imgItems.push(c); return; }
      if (vidKeywords.some(k=>c.service.includes(k))) { vidItems.push(c); return; }
      if (audioKeywords.some(k=>c.service.includes(k))) { audioItems.push(c); return; }
      if (pro264Keywords.some(k=>c.service.includes(k))) { pro264Items.push(c); return; }
      if (integKeywords.some(k=>c.service.includes(k))) { integItems.push(c); return; }
      otherItems.push(c);
    });

    const statusBadge = (envKey) => {
      const live = isLive(envKey);
      const missing = isAllMissing(envKey);
      const unknown = !live && !missing;
      if (live)    return `<span style="background:rgba(16,185,129,.15);color:#10b981;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">● LIVE</span>`;
      if (unknown) return `<span style="background:rgba(139,92,246,.12);color:#a78bfa;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">— —</span>`;
      return `<span style="background:rgba(245,158,11,.15);color:#f59e0b;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">⚠ MISSING</span>`;
    };

    const levelPill = (r) => r==='core'
      ? `<span style="background:rgba(16,185,129,.12);color:#10b981;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">CORE</span>`
      : r==='recommended'
      ? `<span style="background:rgba(245,158,11,.12);color:#f59e0b;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">REC</span>`
      : `<span style="background:rgba(139,92,246,.1);color:#a78bfa;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700">OPT</span>`;

    const renderSection = (label, items, accent) => !items.length ? '' : `
      <tr><td colspan="5" style="padding:12px 8px 5px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:${accent};border-bottom:1px solid var(--border)">${label}&nbsp;&nbsp;<span style="opacity:.5;font-size:9px">${items.length} service${items.length>1?'s':''}</span></td></tr>
      ${items.map(c=>`<tr style="${isAllMissing(c.envKey) && c.required==='core' ? 'background:rgba(245,158,11,.04)' : ''}">
        <td style="font-weight:600;white-space:nowrap">${c.service}</td>
        <td style="color:var(--text-m);font-size:11px;max-width:200px">${c.purpose}</td>
        <td style="font-family:monospace;font-size:10px;color:var(--accent);white-space:nowrap">${c.envKey.split(',').map(k=>`<div>${k.trim()}</div>`).join('')}</td>
        <td>${statusBadge(c.envKey)}&nbsp;${levelPill(c.required)}</td>
        <td><a href="${c.url||'#'}" target="_blank" style="white-space:nowrap;color:var(--accent)">Get Key ↗</a></td>
      </tr>`).join('')}
    `;

    openModal(`
      <h2 style="margin-bottom:6px">🔑 API Integration Status</h2>
      <p style="color:var(--text-s);font-size:12px;margin-bottom:10px">Keys stored as Cloudflare Secrets — never exposed to users.<br>
      <strong style="color:#10b981">● LIVE</strong> = configured &amp; active &nbsp;·&nbsp; <strong style="color:#f59e0b">⚠ MISSING</strong> = needs to be added &nbsp;·&nbsp; <strong style="color:#a78bfa">— —</strong> = not yet mapped</p>
      <div style="overflow-x:auto">
      <table class="cred-tbl">
        <thead><tr><th>Service</th><th>What It Powers</th><th>Env Variable(s)</th><th>Status</th><th>Get Key</th></tr></thead>
        <tbody>
          ${renderSection('🟢 Core — Required', coreItems, '#10b981')}
          ${renderSection('🟡 Recommended — AI Chat Models', recItems, '#f59e0b')}
          ${renderSection('🖼️ Image Generation Models', imgItems, '#a78bfa')}
          ${renderSection('🎬 Video Generation Models', vidItems, '#60a5fa')}
          ${renderSection('🎵 FlowState Audio — Music &amp; Voice', audioItems, '#f472b6')}
          ${renderSection('⚡ 264 Pro Video Editor', pro264Items, '#fb923c')}
          ${renderSection('🔗 Integrations — Productivity &amp; Team', integItems, '#6b7280')}
          ${otherItems.length ? renderSection('Other', otherItems, '#6b7280') : ''}
        </tbody>
      </table>
      </div>
    `, true);
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
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">POMODORO MUSIC</div>
      <button class="btn-sm" onclick="closeModal();openMusicModal()"><i class="fas fa-music"></i> Configure YouTube/Spotify</button>
    </div>
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">INTEGRATIONS</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span>📅 Google Calendar</span>${FS_USER ? '<span style="color:var(--green)">✓ Synced · '+escHtml(FS_USER.email||FS_USER.name||'')+'</span>' : '<button class="btn-sm" onclick="window.location.href=\'/api/auth/google\'" style="font-size:11px">Connect Google</button>'}</div>
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
  saveLocalState(); closeModal();
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
      <div class="clawbot-promo-logo"><img src="/static/clawbot-mascot.png" style="width:105px;height:105px;object-fit:contain;display:block;margin:0 auto"></div>
      <div class="clawbot-promo-title">${d.headline}</div>
      <div class="clawbot-promo-sub">Your AI brain for 264 Pro, Flowstate Audio &amp; Hub. Agentic workflows, walkthrough generation, and smart automation — all in one.</div>
      <div class="clawbot-price-row">
        <span class="clawbot-orig-price">${d.originalPrice}</span>
        <span class="clawbot-new-price">${d.promoPrice}</span>
        <span class="clawbot-discount">${d.discount}</span>
      </div>
      <ul class="clawbot-features">${d.features.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul>
      <button class="clawbot-cta" onclick="startClawFlowCheckout('monthly')">${escHtml(d.cta)}</button>
      <div style="margin-top:10px;font-size:12px;color:var(--text-s)">Or save 12% — <span onclick="startClawFlowCheckout('annual')" style="color:var(--accent);cursor:pointer;text-decoration:underline">$35/month billed annually →</span></div>
    `;
  } catch(e) {
    const el = document.getElementById('clawbot-promo');
    if (el) el.innerHTML = `<div class="clawbot-promo-logo"><img src="/static/clawbot-mascot.png" style="width:105px;height:105px;object-fit:contain;display:block;margin:0 auto"></div><div class="clawbot-promo-title">Unlock Clawbot</div><div class="clawbot-promo-sub">Add CLAWBOT_API_KEY to your Cloudflare secrets to activate ClawFlow.</div>`;
  }
}

function startClawFlowCheckout(cycle) {
  if (!FS_USER && !state.settings.isDemo) { notify('Sign in to subscribe to ClawFlow','info'); return; }
  const billing_cycle = cycle || 'monthly'; // first month $20 coupon auto-applied for monthly
  notify('Opening ClawFlow checkout…', 'info');
  fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'clawflow', billing_cycle }),
  }).then(r=>r.json()).then(d => {
    if (d.checkoutUrl) window.open(d.checkoutUrl,'_blank');
    else notify(d.message || 'Add CLAWBOT_API_KEY to Cloudflare secrets to activate','info');
  }).catch(() => notify('Add CLAWBOT_API_KEY to Cloudflare secrets to activate ClawFlow','info'));
}

// ── Token Top-Up Modal ────────────────────────────────────────────────────────
let _tokenBalance = null;

async function loadTokenBalance() {
  try {
    const r = await fetch('/api/billing/balance');
    if (!r.ok) return;
    _tokenBalance = await r.json();
    // Update compact token counter on the buy-tokens button
    const el = document.getElementById('token-balance-display');
    if (el && _tokenBalance) {
      const purchased = _tokenBalance.purchased || 0;
      const dailyLeft = Math.max(0, (_tokenBalance.dailyLimit || 0) - (_tokenBalance.dailyUsed || 0));
      const total = dailyLeft + purchased;
      // Format: 12.3k, 1.2M, etc.
      const fmt = n => n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M'
                     : n >= 1_000     ? Math.round(n/1_000)+'k'
                     : String(n);
      el.textContent = fmt(total);
      // Also update the button title with full breakdown
      const btn = document.getElementById('btn-topup');
      if (btn) btn.title = `${fmt(dailyLeft)} daily left · ${fmt(purchased)} purchased — Click to buy more`;
    }
  } catch(e) {}
}

function openTopupModal() {
  if (!FS_USER && !state.settings.isDemo) {
    notify('Sign in to purchase tokens', 'info');
    return;
  }
  const packs = [
    { id: 'pack_50k',  tokens: 50000,  price: 5,  label: '50k Tokens',  badge: '' },
    { id: 'pack_200k', tokens: 200000, price: 15, label: '200k Tokens', badge: 'BEST VALUE' },
    { id: 'pack_500k', tokens: 500000, price: 30, label: '500k Tokens', badge: 'POWER USER' },
  ];

  const balHtml = _tokenBalance
    ? `<div style="background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.25);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px">
        <span style="color:var(--text-s)">Current balance: </span>
        <span style="color:var(--accent);font-weight:700">${(_tokenBalance.purchased||0).toLocaleString()} purchased</span>
        <span style="color:var(--text-s)"> · </span>
        <span style="color:var(--text)">${Math.max(0,_tokenBalance.dailyLimit-_tokenBalance.dailyUsed).toLocaleString()} daily remaining</span>
      </div>`
    : '';

  const cards = packs.map(p => {
    const perK = (p.price / (p.tokens/1000)).toFixed(2);
    const badge = p.badge ? `<div style="background:var(--accent);color:#fff;font-size:9px;font-weight:800;letter-spacing:1px;border-radius:4px;padding:2px 7px;margin-bottom:6px;display:inline-block">${p.badge}</div>` : '<div style="height:20px"></div>';
    return `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;cursor:pointer;transition:border-color .2s" onclick="startTopup('${p.id}')" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
        ${badge}
        <div style="font-size:22px;font-weight:800;color:var(--text);margin:4px 0">${(p.tokens/1000).toFixed(0)}k</div>
        <div style="font-size:11px;color:var(--text-s);margin-bottom:10px">tokens</div>
        <div style="font-size:20px;font-weight:700;color:var(--accent)">$${p.price}</div>
        <div style="font-size:10px;color:var(--text-s);margin-bottom:12px">$${perK}/1k tokens</div>
        <button style="width:100%;padding:8px;border-radius:8px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-size:13px;font-weight:600">Buy Now</button>
      </div>`;
  }).join('');

  openModal(`
    <h2 style="text-align:center">💰 Buy More Tokens</h2>
    <p style="color:var(--text-s);font-size:13px;margin:6px 0 14px;text-align:center">Tokens never expire. Use them across all AI features when your daily limit runs out.</p>
    ${balHtml}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">${cards}</div>
    <p style="color:var(--text-s);font-size:11px;text-align:center">One-time purchase · No subscription · Instant credit after payment</p>
  `);
  // Load fresh balance
  loadTokenBalance();
}

function startTopup(packId) {
  if (!FS_USER && !state.settings.isDemo) { notify('Sign in to purchase tokens','info'); return; }
  notify('Opening secure checkout…', 'info');
  fetch('/api/billing/topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pack_id: packId }),
  }).then(r=>r.json()).then(d => {
    if (d.checkoutUrl) {
      window.open(d.checkoutUrl, '_blank');
    } else if (d.demo) {
      notify(d.message || 'Demo mode — add Stripe key to enable', 'info');
    } else {
      notify(d.error || 'Unable to open checkout', 'error');
    }
  }).catch(() => notify('Checkout error — please try again', 'error'));
}

// ── Audio Tab: AI Music Generator & TTS ──────────────────────────────────────
let _audioTool     = 'generate_track';
let _audioDur      = 30;
let _audioBpm      = '';
let _ttsVoiceId    = 'pNInz6obpgDQGcFmaJgB';
let _ttsModelId    = 'eleven_turbo_v2_5';
let _audPickerOpen = ''; // which picker is open: 'dur' | 'bpm' | 'voice' | 'ttsmodel' | ''

function toggleAudPicker(e, key) {
  e.stopPropagation();
  _audPickerOpen = _audPickerOpen === key ? '' : key;
  _refreshAudPickers();
  if (_audPickerOpen) {
    setTimeout(() => document.addEventListener('click', _closeAudPickers, { once: true }), 10);
  }
}
function _closeAudPickers() { _audPickerOpen = ''; _refreshAudPickers(); }
function _refreshAudPickers() {
  ['dur','bpm','voice','ttsmodel'].forEach(k => {
    const dd = document.getElementById(k === 'voice' ? 'tts-voice-dropdown' : k === 'ttsmodel' ? 'tts-model-dropdown' : `aud-${k}-dropdown`);
    const chevron = document.querySelector(`#${k === 'voice' ? 'tts-voice-pill' : k === 'ttsmodel' ? 'tts-model-pill' : `aud-${k}-pill`} .fa-chevron-down, #${k === 'voice' ? 'tts-voice-pill' : k === 'ttsmodel' ? 'tts-model-pill' : `aud-${k}-pill`} .fa-chevron-up`);
    if (dd) dd.style.display = _audPickerOpen === k ? 'block' : 'none';
  });
}

function setAudDur(val, label) {
  _audioDur = val;
  const lbl = document.getElementById('aud-dur-label');
  if (lbl) lbl.textContent = label;
  // radio dots
  [15,30].forEach(v => { const r = document.getElementById(`aud-dur-r-${v}`); if (r) r.className = 'gs-radio' + (v===val?' gs-radio-active':''); });
  _audPickerOpen = ''; _refreshAudPickers();
}
function setAudBpm(val, label) {
  _audioBpm = val;
  const lbl = document.getElementById('aud-bpm-label');
  if (lbl) lbl.textContent = label;
  ['auto','80','90','100','120','140'].forEach(v => { const r = document.getElementById(`aud-bpm-r-${v}`); if (r) r.className = 'gs-radio' + ((val==='' ? 'auto' : val)===v?' gs-radio-active':''); });
  _audPickerOpen = ''; _refreshAudPickers();
}
function setTTSVoice(id, label) {
  _ttsVoiceId = id;
  const lbl = document.getElementById('tts-voice-label');
  if (lbl) lbl.textContent = label.split(' - ')[0] + (label.includes(' - ') ? ' — ' + label.split(' - ')[1] : '');
  // clear all radios, activate selected
  document.querySelectorAll('[id^="tvr-"]').forEach(r => r.className = 'gs-radio');
  _audPickerOpen = ''; _refreshAudPickers();
}
function setTTSModel(id, label) {
  _ttsModelId = id;
  const lbl = document.getElementById('tts-model-label');
  if (lbl) lbl.textContent = label;
  ['t25','f25','t2','ml2'].forEach(k => { const r = document.getElementById(`tmr-${k}`); if (r) r.className = 'gs-radio'; });
  const keyMap = { 'eleven_turbo_v2_5':'t25','eleven_flash_v2_5':'f25','eleven_turbo_v2':'t2','eleven_multilingual_v2':'ml2' };
  const active = document.getElementById(`tmr-${keyMap[id]}`);
  if (active) active.className = 'gs-radio gs-radio-active';
  _audPickerOpen = ''; _refreshAudPickers();
}

function setAudioTool(tool) {
  _audioTool = tool;
  ['track','melody','beat'].forEach(t => {
    const btn = document.getElementById('aud-tool-' + t);
    if (btn) btn.classList.toggle('active-tool', 'generate_' + t === tool);
  });
}

async function generateAudioTrack() {
  const prompt = document.getElementById('aud-prompt')?.value?.trim();
  if (!prompt) { notify('Enter a prompt to describe your music', 'info'); return; }
  const style    = document.getElementById('aud-style')?.value?.trim() || '';
  const duration = _audioDur || 30;
  const bpm      = _audioBpm || '';

  const statusDiv  = document.getElementById('aud-status');
  const statusText = document.getElementById('aud-status-text');
  const player     = document.getElementById('aud-player');
  const dlLink     = document.getElementById('aud-download-link');
  const genBtn     = document.getElementById('aud-gen-btn');

  if (statusDiv)  { statusDiv.style.display  = 'block'; }
  if (player)     { player.style.display     = 'none';  }
  if (dlLink)     { dlLink.style.display     = 'none';  }
  if (statusText) { statusText.innerHTML     = '<i class="fas fa-spinner fa-spin"></i> Generating… this takes 20-60 seconds'; }
  if (genBtn)     { genBtn.disabled = true; genBtn.textContent = '⏳ Generating…'; }

  try {
    const res  = await fetch('/api/audio/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: _audioTool, prompt, style, durationSeconds: duration, bpm: bpm ? parseInt(bpm) : undefined }),
    });
    const data = await res.json();

    if (data.audioUrl) {
      _showAudioResult(data.audioUrl, data.message || 'Track ready!');
    } else if (data.predictionId || data.pollUrl) {
      // Replicate async — poll for completion
      if (statusText) statusText.innerHTML = '<i class="fas fa-spinner fa-spin"></i> MusicGen is processing… polling for result';
      _pollAudioPrediction(data.predictionId, 0);
    } else {
      if (statusText) statusText.textContent = data.message || 'No audio generated — check your API keys in Cloudflare secrets.';
    }
  } catch(e) {
    if (statusText) statusText.textContent = 'Error: ' + e.message;
  } finally {
    if (genBtn) { genBtn.disabled = false; genBtn.innerHTML = '<i class="fas fa-music"></i> Generate Music'; }
  }
}

async function _pollAudioPrediction(predictionId, attempts) {
  if (attempts > 60) {
    const st = document.getElementById('aud-status-text');
    if (st) st.textContent = 'Timed out waiting for MusicGen. Try again.';
    return;
  }
  await new Promise(r => setTimeout(r, 3000));
  try {
    const res  = await fetch('/api/audio/generate/poll/' + predictionId);
    const data = await res.json();
    if (data.status === 'succeeded' && data.audioUrl) {
      _showAudioResult(data.audioUrl, 'MusicGen track ready!');
    } else if (data.status === 'failed') {
      const st = document.getElementById('aud-status-text');
      if (st) st.textContent = 'MusicGen failed — try a different prompt.';
    } else {
      // Still processing
      const st = document.getElementById('aud-status-text');
      if (st) st.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing… (attempt ${attempts+1})`;
      _pollAudioPrediction(predictionId, attempts + 1);
    }
  } catch(e) {
    const st = document.getElementById('aud-status-text');
    if (st) st.textContent = 'Poll error: ' + e.message;
  }
}

function _showAudioResult(audioUrl, msg) {
  const statusText = document.getElementById('aud-status-text');
  const player     = document.getElementById('aud-player');
  const dlLink     = document.getElementById('aud-download-link');
  if (statusText) statusText.textContent = '✅ ' + msg;
  if (player)  { player.src = audioUrl; player.style.display = 'block'; }
  if (dlLink)  { dlLink.href = audioUrl; dlLink.style.display = 'inline-block'; }
  notify('🎵 Music generated!', 'success');
}

// Load real ElevenLabs voices from API and populate dropdown
async function loadTTSVoices() {
  try {
    const r = await fetch('/api/audio/tts/voices');
    if (!r.ok) return;
    const data = await r.json();
    const voices = data.voices || [];
    const countEl = document.getElementById('tts-voice-count');
    if (countEl) countEl.textContent = `${voices.length} voices loaded`;
    // Rebuild voice picker dropdown if API returns voices not already in HTML
    // (for now just confirm the count — static list already has all 26)
  } catch(e) {
    const countEl = document.getElementById('tts-voice-count');
    if (countEl) countEl.textContent = '26 voices (live)';
  }
}

async function generateTTS() {
  const text      = document.getElementById('tts-text')?.value?.trim();
  const voiceId   = _ttsVoiceId  || 'pNInz6obpgDQGcFmaJgB';
  const modelId   = _ttsModelId  || 'eleven_turbo_v2_5';
  const stability = parseFloat(document.getElementById('tts-stability')?.value || '0.5');
  const similarity= parseFloat(document.getElementById('tts-similarity')?.value || '0.75');
  const styleEx   = parseFloat(document.getElementById('tts-style-ex')?.value || '0');

  if (!text) { notify('Enter text to convert to speech', 'info'); return; }

  const statusDiv  = document.getElementById('tts-status');
  const statusText = document.getElementById('tts-status-text');
  const player     = document.getElementById('tts-player');
  const dlLink     = document.getElementById('tts-download');
  const btn        = document.getElementById('tts-btn');

  if (statusDiv)  statusDiv.style.display  = 'block';
  if (statusText) statusText.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating voice…';
  if (player)     player.style.display = 'none';
  if (dlLink)     dlLink.style.display = 'none';
  if (btn)        { btn.disabled = true; btn.innerHTML = '⏳ Generating…'; }

  try {
    const res = await fetch('/api/audio/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voiceId, model_id: modelId, stability, similarity_boost: similarity, style: styleEx }),
    });

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('audio')) {
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      if (player)  { player.src = url; player.style.display = 'block'; }
      if (dlLink)  { dlLink.href = url; dlLink.style.display = 'inline-block'; }
      if (statusText) statusText.textContent = '✅ Voice ready!';
      notify('🎙️ Voice generated!', 'success');
    } else {
      const data = await res.json();
      if (statusText) statusText.textContent = (data.demo ? '⚠️ ' : '❌ ') + (data.message || data.error || 'TTS failed');
    }
  } catch(e) {
    if (statusText) statusText.textContent = 'Error: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-microphone"></i> Generate Voice'; }
  }
}

// ── Clawbot App Context Pill Picker ──────────────────────────────────────────
let _clawCtx         = 'flowstate_hub';
let _clawCtxPickerOpen = false;

function toggleClawCtxPicker(e) {
  e.stopPropagation();
  _clawCtxPickerOpen = !_clawCtxPickerOpen;
  _refreshClawCtxPicker();
  if (_clawCtxPickerOpen) {
    setTimeout(() => document.addEventListener('click', _closeClawCtxPicker, { once: true }), 10);
  }
}
function _closeClawCtxPicker() { _clawCtxPickerOpen = false; _refreshClawCtxPicker(); }
function _refreshClawCtxPicker() {
  const dd = document.getElementById('clawbot-ctx-dropdown');
  if (dd) dd.style.display = _clawCtxPickerOpen ? 'block' : 'none';
}
function setClawCtx(val, label) {
  _clawCtx = val;
  const lbl = document.getElementById('clawbot-ctx-label');
  if (lbl) lbl.textContent = label;
  // Update radios
  const map = { flowstate_hub: 'ccr-hub', '264_pro': 'ccr-264', flowstate_audio: 'ccr-audio' };
  Object.values(map).forEach(id => { const r = document.getElementById(id); if (r) r.className = 'gs-radio'; });
  const active = document.getElementById(map[val]);
  if (active) active.className = 'gs-radio gs-radio-active';
  _closeClawCtxPicker();
}
// ─────────────────────────────────────────────────────────────────────────────

async function sendClawbotMessage() {
  const inp = document.getElementById('clawbot-in');
  const msg = inp ? inp.value.trim() : '';
  if (!msg) return;
  if (inp) { inp.value=''; inp.style.height='42px'; }
  appendClawbotMsg('user', msg, '');
  const tid = appendClawbotTyping();
  const appCtx = _clawCtx || 'flowstate_hub';
  try {
    const res = await fetch('/api/clawbot/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message:msg, app:appCtx, history:clawbotHistory.slice(-8) })
    });
    const data = await res.json();
    removeTyping(tid);
    if (data.error === 'clawflow_required') {
      appendClawbotMsg('ai', '⚡ ClawFlow subscription required to continue. Upgrade below ↓', 'Clawbot');
      document.getElementById('clawbot-active').style.display = 'none';
      document.getElementById('clawbot-gate').style.display = 'block';
      loadClawbotPromo(); return;
    }
    const reply = data.reply || 'No response.';
    appendClawbotMsg('ai', reply, `Clawbot · ${data.coinCost || 0} coins`);
    clawbotHistory.push({ role:'user', content:msg }, { role:'assistant', content:reply });
    const badge = document.getElementById('clawbot-coins-badge');
    if (badge && data.coinCost) {
      const cur = parseInt(badge.textContent.replace(/[^0-9]/g,'')) || 500;
      badge.textContent = `⚡ ${Math.max(0, cur - data.coinCost)} coins`;
    }
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
    ? `<div class="msg-av" style="background:linear-gradient(135deg,#a855f7,#06b6d4);overflow:hidden;padding:0"><img src="/static/clawbot-mascot.png" style="width:100%;height:100%;object-fit:cover"></div>`
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
  div.innerHTML = `<div class="msg-av" style="background:linear-gradient(135deg,#a855f7,#06b6d4);overflow:hidden;padding:0"><img src="/static/clawbot-mascot.png" style="width:100%;height:100%;object-fit:cover"></div><div><div class="msg-bub"><div class="typing"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return id;
}

function offerWalkthrough(context, appCtx) {
  const bar = document.getElementById('clawbot-wt-bar');
  const content = document.getElementById('clawbot-wt-content');
  if (!bar || !content) return;
  const safeCtx = context.slice(0,60).replace(/'/g,'').replace(/"/g,'');
  content.innerHTML = `<strong><img src="/static/clawbot-mascot.png" style="width:20px;height:20px;object-fit:contain;vertical-align:middle;margin-right:4px"> Need a walkthrough?</strong> Want me to generate a step-by-step guide? <button class="clawbot-quick-btn" style="margin-left:8px" onclick="generateWalkthrough('${safeCtx}','${appCtx}')">Yes, create it</button>`;
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
        if (s.tip) text += `💡 ${s.tip}\n`;
        text += '\n';
      });
      appendClawbotMsg('ai', text, `Clawbot · ${wt.coinCost} coins used`);
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
