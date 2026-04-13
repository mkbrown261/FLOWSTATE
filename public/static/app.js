
// ══════════════════════════════════════════════════════════════════
// THEME — Light / Dark mode
// ══════════════════════════════════════════════════════════════════
(function _initTheme() {
  const saved = localStorage.getItem('fs_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  if (next === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('fs_theme', next);
  _updateThemeBtn();
}

function _updateThemeBtn() {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  btn.textContent = isLight ? '☀️' : '🌙';
  btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
}

// ── State ──────────────────────────────────────────────────────────────────

// ── D1 session history cache (populated on boot for signed-in users) ──────────
let _d1History = null; // null = not loaded yet, {} = loaded

let state = {
  timer:   { running:false, phase:'focus', elapsed:0, totalFocusSec:0, sessions:0, streak:0, focusMin:25, shortMin:5, longMin:15, intervalId:null, audioCtx:null, soundType:null, pomodoroMusic:null, _todaySessions:0, _lastSessionDate:null },
  chat:    { model:'auto', history:[] },
  cal:     { year:new Date().getFullYear(), month:new Date().getMonth(), events:[] },
  kanban:  { tasks:{ todo:[], inprogress:[], done:[] }, notionDb:null },
  learn:   { cards:[], idx:0 },
  restore: { scenes:[], idx:0, meditationTimer:null, meditationSeconds:0 },
  team:    { members:[], role:'member', activeTab:'leaderboard' },
  settings:{ focusMin:25, sound:null, isDemo:false },
  gen:     { imgModel:'flux_pro', vidModel:'kling16', i2vModel:'kling16', imgPickerOpen:false, vidPickerOpen:false, i2vPickerOpen:false }
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
  // Apply current volume to newly-started ambient audio
  _applyAmbientVolume(_volCurrent / 100);
  if (state.timer.running) document.body.classList.add('amb-active');
  notify(`🎧 ${AMBIENT_SOUNDS[type]?.label || type} playing`,'info');
}

// ── Volume Control ─────────────────────────────────────────────────────────
let _volCurrent = parseInt(localStorage.getItem('fs_vol') || '70');
let _volBeforeMute = _volCurrent;
let _volMuted = false;
let _volDragging = false;

function _volInit() {
  const track = document.getElementById('vol-track');
  if (!track) return;
  _volSetUI(_volCurrent, false);

  // Mouse drag
  track.addEventListener('mousedown', _volStartDrag);
  document.addEventListener('mousemove', _volOnDrag);
  document.addEventListener('mouseup', _volEndDrag);
  // Touch drag
  track.addEventListener('touchstart', _volStartDrag, { passive: true });
  document.addEventListener('touchmove', _volOnDrag, { passive: false });
  document.addEventListener('touchend', _volEndDrag);
  // Click on track
  track.addEventListener('click', _volOnClick);
}

function _volStartDrag(e) {
  _volDragging = true;
  _volOnDrag(e);
}
function _volEndDrag() { _volDragging = false; }
function _volOnDrag(e) {
  if (!_volDragging) return;
  if (e.cancelable) e.preventDefault();
  _volFromEvent(e);
}
function _volOnClick(e) { _volFromEvent(e); }

function _volFromEvent(e) {
  const track = document.getElementById('vol-track');
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const vol = Math.round(pct * 100);
  _volMuted = false;
  _volSetUI(vol, true);
}

function _volSetUI(vol, save) {
  _volCurrent = Math.max(0, Math.min(100, vol));
  if (save) { localStorage.setItem('fs_vol', String(_volCurrent)); _volBeforeMute = _volCurrent; }
  const pct = _volCurrent + '%';
  const fill  = document.getElementById('vol-fill');
  const thumb = document.getElementById('vol-thumb');
  const label = document.getElementById('vol-label');
  const icon  = document.getElementById('vol-icon');
  if (fill)  fill.style.width  = pct;
  if (thumb) thumb.style.left  = pct;
  if (label) label.textContent = _volCurrent;
  if (icon) {
    // Swap icon glyph and tint based on level
    if (_volCurrent === 0 || _volMuted) {
      icon.className = 'fas fa-volume-xmark vol-icon';
      icon.style.color = 'rgba(255,255,255,.25)';
    } else if (_volCurrent < 35) {
      icon.className = 'fas fa-volume-off vol-icon active';
      icon.style.color = '';
    } else if (_volCurrent < 70) {
      icon.className = 'fas fa-volume-low vol-icon active';
      icon.style.color = '';
    } else {
      icon.className = 'fas fa-volume-high vol-icon active';
      icon.style.color = '';
    }
    // Accent color when a sound is active
    const anyActive = state.timer.soundType && state.timer.soundType !== 'off';
    const musicActive = pomodoroMusicEl && pomodoroMusicEl.src && pomodoroMusicEl.src !== '';
    if ((anyActive || musicActive) && _volCurrent > 0) icon.style.color = 'var(--accent)';
  }
  // Apply to audio engines
  _applyAmbientVolume(_volCurrent / 100);
  _applyMusicVolume(_volCurrent);
}

function _applyAmbientVolume(frac) {
  if (ambientGain) {
    // Scale within a comfortable range: 0 → 0, 1 → 0.22 (max comfortable level)
    ambientGain.gain.setTargetAtTime(frac * 0.22, ambientCtx?.currentTime || 0, 0.05);
  }
}

function _applyMusicVolume(vol) {
  if (!pomodoroMusicEl || !pomodoroMusicEl.contentWindow) return;
  // YouTube IFrame API postMessage: setVolume (0–100)
  try {
    pomodoroMusicEl.contentWindow.postMessage(
      JSON.stringify({ event: 'command', func: 'setVolume', args: [vol] }), '*'
    );
  } catch(e) {}
  // Spotify embed: uses its own postMessage protocol
  try {
    pomodoroMusicEl.contentWindow.postMessage(
      JSON.stringify({ type: 'set_volume', value: vol / 100 }), '*'
    );
  } catch(e) {}
}

function _volToggleMute() {
  if (_volMuted || _volCurrent === 0) {
    _volMuted = false;
    _volSetUI(_volBeforeMute || 70, true);
  } else {
    _volBeforeMute = _volCurrent;
    _volMuted = true;
    _volCurrent = 0;
    _volSetUI(0, false);
    _applyAmbientVolume(0);
    _applyMusicVolume(0);
    const icon = document.getElementById('vol-icon');
    if (icon) { icon.className = 'fas fa-volume-xmark vol-icon'; icon.style.color = 'rgba(255,255,255,.25)'; }
    const fill  = document.getElementById('vol-fill');
    const thumb = document.getElementById('vol-thumb');
    const label = document.getElementById('vol-label');
    if (fill)  fill.style.width  = '0%';
    if (thumb) thumb.style.left  = '0%';
    if (label) label.textContent = '0';
  }
}

// Now-playing pill helpers
function _npShow(title) {
  const pill = document.getElementById('now-playing-pill');
  const titleEl = document.getElementById('np-title');
  if (pill)  pill.classList.add('visible');
  if (titleEl) titleEl.textContent = title || 'Music playing';
}
function _npHide() {
  const pill = document.getElementById('now-playing-pill');
  if (pill) pill.classList.remove('visible');
}

// ── Boot ───────────────────────────────────────────────────────────────────
function boot() {
  loadLocalState();
  _updateThemeBtn();
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
      const todayStr = new Date().toISOString().slice(0, 10);
      // Reset today's session count if it's a new day
      const savedDate = saved.timer._lastSessionDate || '';
      state.timer.sessions      = savedDate === todayStr ? (saved.timer.sessions || 0) : 0;
      state.timer.totalFocusSec = savedDate === todayStr ? (saved.timer.totalFocusSec || 0) : 0;
      state.timer.streak        = saved.timer.streak       || 0;
      state.timer.focusMin      = saved.timer.focusMin     || 25;
      state.settings.focusMin   = state.timer.focusMin;
      state.timer._lastSessionDate = savedDate;
      // Reset streak if last session was >48h ago (missed a day)
      if (savedDate && savedDate !== todayStr) {
        const daysSince = Math.floor((Date.now() - new Date(savedDate).getTime()) / 86400000);
        if (daysSince > 1) state.timer.streak = 0; // streak broken
      }
    }
    if (saved.kanban) state.kanban = saved.kanban;
  } catch(e) {}
}

function saveLocalState() {
  try {
    localStorage.setItem('fs_state', JSON.stringify({
      timer: {
        sessions: state.timer.sessions,
        totalFocusSec: state.timer.totalFocusSec,
        streak: state.timer.streak,
        focusMin: state.timer.focusMin,
        _lastSessionDate: state.timer._lastSessionDate,
      },
      kanban: state.kanban
    }));
  } catch(e) {}
}

// ── Login ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
}

// Reusable OAuth popup opener — used for Google login AND calendar connect
function isSafari() {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}

function openAuthPopup(url, onSuccess) {
  // Safari blocks cookies set in OAuth popups due to ITP — use full page redirect instead
  if (isSafari()) {
    window.location.href = url;
    return;
  }
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
const OB_STEPS = ['Welcome','Goals','Tools','Rhythm','Claw','Done'];

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
        <div class="integ-row"><div class="integ-left"><span class="integ-icon">📅</span><div><div class="integ-name">Google Calendar</div><div class="integ-desc">${FS_USER ? 'Signed in as ' + escHtml(FS_USER.email||FS_USER.name||'') + ' · Click to re-sync if events are missing' : 'Sync events, block focus time'}</div></div></div><button class="btn-connect ${FS_USER?'connected':''}" onclick="window.location.href='${FS_USER ? '/api/auth/calendar-reconnect' : '/api/auth/google'}'">${FS_USER?'↻ Re-sync':'Connect Google'}</button></div>
        <div class="integ-row"><div class="integ-left"><span class="integ-icon">📝</span><div><div class="integ-name">Notion</div><div class="integ-desc">Sync Kanban boards & tasks</div></div></div><button class="btn-connect ${FS_NOTION?'connected':''}" onclick="connectNotion()">${FS_NOTION?'✓ Connected':'Connect'}</button></div>
        <div class="integ-row"><div class="integ-left"><span class="integ-icon">💬</span><div><div class="integ-name">Slack</div><div class="integ-desc">Team notifications &amp; standups · <em style="color:var(--text-m)">Requires an existing Slack workspace</em></div></div></div><button class="btn-connect ${FS_SLACK?'connected':''}" onclick="connectSlack()">${FS_SLACK?'✓ Connected':'Connect'}</button></div>
      </div>
      <button class="ob-btn" onclick="obNext()">Continue →</button>
      <button class="ob-skip" onclick="obNext()">Skip for now</button>`;
  } else if (obStep === 3) {
    const rhythms=[{m:25,label:'Pomodoro',desc:'Classic 25/5 split'},{m:45,label:'Deep Work',desc:'45-min focus blocks'},{m:90,label:'Flow State',desc:'Ultra-deep 90-min sessions'}];
    inner = `<div class="ob-step">Step 4 of 6 — Your Rhythm</div><div class="ob-progress">${progress}</div>
      <div class="ob-title">Choose your focus rhythm</div>
      <div class="ob-sub">You can change this any time in Settings.</div>
      <div class="rhythm-grid">${rhythms.map(r=>`<button class="rhythm-btn ${obRhythm===r.m?'sel':''}" onclick="selectRhythm(${r.m},this)"><span class="rhythm-min">${r.m}m</span><span>${r.label}</span><span class="rhythm-lbl">${r.desc}</span></button>`).join('')}</div>
      <button class="ob-btn" onclick="obNext()">Continue →</button>`;
  } else if (obStep === 4) {
    inner = `<div class="ob-step">Step 5 of 6 — Meet Claw</div><div class="ob-progress">${progress}</div>
      ${renderClawOnboardingStep()}
      <button class="ob-btn" onclick="obFinish()">Almost Done →</button>
      <button class="ob-skip" onclick="obFinish()">Skip for now</button>`;
  } else {
    inner = `
      <div class="ob-logo">🎉</div>
      <div class="ob-title">You're all set!</div>
      <div class="ob-sub">Your workspace is configured. Your FlowScore starts at <strong style="color:var(--accent)">0</strong> — complete your first session to earn points.</div>
      <div class="ob-progress">${progress}</div>
      <div style="background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.2);border-radius:14px;padding:16px;margin:14px 0;text-align:left">
        <div style="font-size:12px;font-weight:700;color:var(--accent);margin-bottom:10px">⚡ What happens when you complete a session:</div>
        <div style="font-size:12px;color:var(--text-s);line-height:2">🎯 Your FlowScore updates in real-time<br>🔥 Your streak starts building<br>📊 Metrics tab shows your progress<br>💡 AI gives you a post-session debrief</div>
      </div>
      <button class="ob-btn" onclick="completeOnboarding()" style="background:linear-gradient(135deg,#a855f7,#ec4899);box-shadow:0 4px 20px rgba(168,85,247,.4)">Start My First Session →</button>`;
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
  if (obStep === 4) saveClawOnboardingPerms();
  obStep = 5;
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
  // Pulse the start button so users know exactly what to click first
  setTimeout(() => {
    const startBtn = document.getElementById('btn-start');
    if (startBtn) {
      startBtn.style.boxShadow = '0 0 0 0 rgba(168,85,247,.7)';
      startBtn.style.animation = 'ob-pulse 1.5s ease-out 3';
      // Add keyframe via style tag if not present
      if (!document.getElementById('ob-pulse-style')) {
        const s = document.createElement('style');
        s.id = 'ob-pulse-style';
        s.textContent = '@keyframes ob-pulse{0%{box-shadow:0 0 0 0 rgba(168,85,247,.7)}70%{box-shadow:0 0 0 12px rgba(168,85,247,0)}100%{box-shadow:0 0 0 0 rgba(168,85,247,0)}}';
        document.head.appendChild(s);
      }
      setTimeout(() => { startBtn.style.animation = ''; startBtn.style.boxShadow = ''; }, 5000);
    }
    // Show a one-time tooltip nudge
    notify('⚡ Tap the play button to start your first session!', 'info');
  }, 600);
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
  _volInit();
  maybeShowTip();
  loadTokenBalance();
  initKeyboardShortcuts();
  requestNotificationPermission();
  const _startTab = checkBillingReturn();
  switchTab(_startTab || 'focus');
  setTimeout(loadSmartSuggestions, 1200);
  // Seed real D1 history for signed-in users
  if (FS_USER) loadD1History();
  // Check for referral claim (?ref=FS-XXXXX in URL)
  if (FS_USER) setTimeout(checkReferralClaim, 800);
  // Restore active pair session on reload
  if (FS_USER) setTimeout(_restorePairSession, 1500);
}

async function _restorePairSession() {
  // Silently clear any stale pair state from Redis on every page load.
  // The banner is hidden via CSS by default (display:none in stylesheet)
  // so it never flashes — it only becomes visible when _updatePairBanner()
  // is explicitly called after an active pairing in the current tab.
  fetch('/api/pair/leave', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).catch(() => {});
}

// ── Load real session history from D1, seed state + update UI ─────────────
async function loadD1History() {
  try {
    const r = await fetch('/api/session/history?days=30', { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    if (d.error) return;
    _d1History = d;

    // Seed state from D1 — real persistent numbers
    const todayStr = new Date().toISOString().slice(0, 10);
    const todaySessions = d.perDay?.[todayStr] || 0;

    // Only update totals if D1 has MORE data than what we have locally
    // (local data from current browser session is valid for today)
    if (d.totalMins > 0) {
      // Set streak from D1 (authoritative)
      state.timer.streak = Math.max(state.timer.streak, d.streak || 0);
    }

    // Today's session count: max of D1 + local (handles offline sessions)
    state.timer.sessions = Math.max(state.timer.sessions, todaySessions);
    state.timer._todaySessions = todaySessions;

    // Update FlowScore badge with real score
    if (d.avgFlowScore) {
      const b = document.getElementById('fs-score-badge');
      if (b) { b.style.display = 'block'; b.textContent = `⚡ ${d.avgFlowScore}`; }
    }

    // Refresh display
    updateTimerDisplay();
    saveLocalState();
  } catch(e) {}
}

function checkBillingReturn() {
  const params = new URLSearchParams(window.location.search);

  // Handle ?tab=<name> — used by PWA shortcuts, billing returns, etc.
  const tabParam = params.get('tab');
  if (tabParam) {
    window.history.replaceState({}, '', window.location.pathname);
    if (tabParam === 'calendar' && params.get('cal_synced') === '1') {
      setTimeout(() => notify('✅ Google Calendar reconnected! Loading your events…', 'success'), 600);
    }
    const validTabs = ['focus','chat','calendar','metrics','board','team','learn','restore','generate','audio','clawbot'];
    if (validTabs.includes(tabParam)) return tabParam;
  }

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
  document.getElementById('cal-add-btn')?.addEventListener('click', () => calShowAddForm());
  document.getElementById('cal-refresh')?.addEventListener('click', loadCalEvents);
  document.getElementById('ev-save-btn')?.addEventListener('click', saveCalEvent);
  document.getElementById('ev-cancel-btn')?.addEventListener('click', () => {
    const form = document.getElementById('add-ev-form');
    if (form) { form.style.display = 'none'; form.classList.remove('show'); }
    const detail = document.getElementById('cal-day-card');
    if (detail) detail.style.display = 'block';
  });
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
  // Sync mobile drawer active state
  document.querySelectorAll('.mob-tab-btn').forEach(b => b.classList.remove('active'));
  const mBtn = document.getElementById('mdtab-'+id);
  if (mBtn) mBtn.classList.add('active');
  // Tab-specific init
  if (id==='calendar') loadCalEvents();
  if (id==='focus')    setTimeout(loadSmartSuggestions, 400); // slight delay so DOM is ready
  if (id==='metrics')  { buildMetrics(); loadWeeklyReview(); }
  if (id==='chat')     setTimeout(loadTokenBalance, 200); // refresh meter on every chat tab visit
  if (id==='board')    buildBoard();
  if (id==='team')     buildTeam();
  if (id==='learn')    loadLearnCards();
  if (id==='restore')  loadRestore();
  if (id==='clawbot')  initClawbot();
  if (id==='audio')    { loadTTSVoices(); }
  if (id==='generate') {
    setTimeout(()=>{
      buildGenPicker('img');
      buildGenPicker('vid');
      buildGenPicker('i2v');
      // Ensure active sub-pane is showing
      if (!document.querySelector('.gen-sub-pane.active')) switchGenSub('imggen');
    }, 50);
  }
}

// ── Mobile drawer ─────────────────────────────────────────────────────────────
function openMobDrawer() {
  const d = document.getElementById('mob-drawer');
  if (d) d.style.display = 'block';
  document.body.style.overflow = 'hidden';
}
function closeMobDrawer(e) {
  if (e && e.target !== document.getElementById('mob-drawer')) return; // only close on backdrop click
  const d = document.getElementById('mob-drawer');
  if (d) d.style.display = 'none';
  document.body.style.overflow = '';
}
function mobSwitchTab(id) {
  // Close drawer first, then switch
  const d = document.getElementById('mob-drawer');
  if (d) d.style.display = 'none';
  document.body.style.overflow = '';
  switchTab(id);
  // Scroll active tab button into view on the tab bar (for tablet width)
  const btn = document.getElementById('tab-'+id);
  if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

// ── Generate sub-tab switching ────────────────────────────────────────────────
function switchGenSub(sub) {
  document.querySelectorAll('.gen-subtab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.gen-sub-pane').forEach(p => p.classList.remove('active'));
  const btn  = document.getElementById('gsub-'+sub);
  const pane = document.getElementById('gen-pane-'+sub);
  if (btn)  btn.classList.add('active');
  if (pane) pane.classList.add('active');
  // Init pickers when switching to their pane
  if (sub==='imggen')    { setTimeout(()=>buildGenPicker('img'), 30); }
  if (sub==='vidgen')    { setTimeout(()=>buildGenPicker('vid'), 30); }
  if (sub==='i2v')       { setTimeout(()=>buildGenPicker('i2v'), 30); }
  if (sub==='tts')       { loadTTSVoices(); }
  if (sub==='higgsfield'){ initHiggsfield(); }
  if (sub==='code')      { initCodeWorkspace(); }
}

// ── Gen sidebar log helper ────────────────────────────────────────────────────
function genSidebarLog(sub, msg, type) {
  const log   = document.getElementById('gsb-'+sub+'-log');
  const empty = document.querySelector('#gen-pane-'+sub+' .gen-sidebar-empty');
  if (!log) return;
  if (empty) empty.style.display = 'none';
  const el = document.createElement('div');
  el.className = 'gen-sidebar-entry' + (type ? ' '+type : '');
  el.innerHTML = `<span style="opacity:.6;font-size:10px">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span><br>${msg}`;
  log.prepend(el);
  // Keep at most 20 entries
  while (log.children.length > 20) log.removeChild(log.lastChild);
}

// ── File Tools ────────────────────────────────────────────────────────────────

function ftAddHistory(name, url, mimeHint) {
  const hist = document.getElementById('ft-sidebar-history');
  const empty = document.getElementById('ft-sidebar-empty');
  if (empty) empty.style.display = 'none';
  if (!hist) return;
  const el = document.createElement('a');
  el.className = 'file-tool-dl';
  el.href = url;
  el.download = name;
  el.innerHTML = `<i class="fas fa-download"></i> ${name}`;
  hist.prepend(el);
}

/* PDF → Images  (client-side via Canvas — shows a friendly info message since
   PDF rendering in a pure browser env requires PDF.js which we load from CDN) */
async function handleFileTool(tool, input) {
  if (tool === 'pdf2img') {
    const statusEl  = document.getElementById('ft-pdf2img-status');
    const resultsEl = document.getElementById('ft-pdf2img-results');
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    statusEl.textContent = 'Loading PDF…';
    resultsEl.innerHTML  = '';
    try {
      // Load PDF.js if not already present
      if (!window.pdfjsLib) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      }
      const arrayBuf = await file.arrayBuffer();
      const pdf      = await window.pdfjsLib.getDocument({data: arrayBuf}).promise;
      statusEl.textContent = `Converting ${pdf.numPages} page(s)…`;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page    = await pdf.getPage(i);
        const vp      = page.getViewport({scale: 2});
        const canvas  = document.createElement('canvas');
        canvas.width  = vp.width;
        canvas.height = vp.height;
        await page.render({canvasContext: canvas.getContext('2d'), viewport: vp}).promise;
        const dataUrl  = canvas.toDataURL('image/jpeg', 0.92);
        const fileName = file.name.replace('.pdf','') + `_page${i}.jpg`;
        // Display thumbnail + download
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const img = document.createElement('img');
        img.src = dataUrl; img.style.cssText = 'width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid var(--border)';
        const link = document.createElement('a');
        link.className = 'file-tool-dl'; link.href = dataUrl; link.download = fileName;
        link.innerHTML = `<i class="fas fa-download"></i> Page ${i} JPG`;
        wrap.appendChild(img); wrap.appendChild(link);
        resultsEl.appendChild(wrap);
        ftAddHistory(fileName, dataUrl, 'image/jpeg');
      }
      statusEl.textContent = `✅ ${pdf.numPages} image(s) ready`;
      genSidebarLog('filetools', `PDF → ${pdf.numPages} images`, 'success');
    } catch (err) {
      statusEl.textContent = '❌ ' + err.message;
      genSidebarLog('filetools', 'PDF convert failed: ' + err.message, 'error');
    }
  }

  if (tool === 'imgs2pdf') {
    const statusEl  = document.getElementById('ft-imgs2pdf-status');
    const resultsEl = document.getElementById('ft-imgs2pdf-results');
    if (!input.files || !input.files.length) return;
    statusEl.textContent = 'Building PDF…';
    resultsEl.innerHTML  = '';
    try {
      // Load jsPDF if needed
      if (!window.jspdf) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const { jsPDF } = window.jspdf;
      const files = Array.from(input.files);
      const doc   = new jsPDF({orientation:'portrait', unit:'px'});
      let firstPage = true;
      for (const file of files) {
        const dataUrl = await new Promise(res => {
          const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(file);
        });
        const img = await new Promise((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl;
        });
        const pw = doc.internal.pageSize.getWidth();
        const ph = doc.internal.pageSize.getHeight();
        const ratio = Math.min(pw / img.width, ph / img.height);
        const w = img.width  * ratio;
        const h = img.height * ratio;
        const x = (pw - w) / 2;
        const y = (ph - h) / 2;
        if (!firstPage) doc.addPage();
        firstPage = false;
        doc.addImage(dataUrl, 'JPEG', x, y, w, h);
      }
      const pdfBlob = doc.output('blob');
      const url     = URL.createObjectURL(pdfBlob);
      const fileName = 'flowstate_images.pdf';
      const link = document.createElement('a');
      link.className = 'file-tool-dl'; link.href = url; link.download = fileName;
      link.innerHTML = `<i class="fas fa-file-pdf"></i> Download PDF (${files.length} pages)`;
      resultsEl.appendChild(link);
      statusEl.textContent = `✅ PDF ready (${files.length} pages)`;
      ftAddHistory(fileName, url, 'application/pdf');
      genSidebarLog('filetools', `${files.length} images → PDF`, 'success');
    } catch (err) {
      statusEl.textContent = '❌ ' + err.message;
      genSidebarLog('filetools', 'PDF build failed: ' + err.message, 'error');
    }
  }
}

/* Image Resize */
let _ftResizeFile = null, _ftResizeNatW = 1, _ftResizeNatH = 1;
function ftResizePreview(input) {
  if (!input.files || !input.files[0]) return;
  _ftResizeFile = input.files[0];
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('ft-resize-preview');
    img.onload = () => {
      _ftResizeNatW = img.naturalWidth;
      _ftResizeNatH = img.naturalHeight;
      document.getElementById('ft-resize-w').value = _ftResizeNatW;
      document.getElementById('ft-resize-h').value = _ftResizeNatH;
      document.getElementById('ft-resize-opts').style.display = 'block';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(_ftResizeFile);
}
function ftDoResize() {
  if (!_ftResizeFile) return;
  const w   = parseInt(document.getElementById('ft-resize-w').value) || _ftResizeNatW;
  const h   = parseInt(document.getElementById('ft-resize-h').value) || _ftResizeNatH;
  const fmt = document.getElementById('ft-resize-fmt').value;
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl  = canvas.toDataURL('image/'+fmt, 0.93);
      const fileName = _ftResizeFile.name.replace(/\.[^.]+$/,'') + `_${w}x${h}.${ext}`;
      const resultEl = document.getElementById('ft-resize-result');
      resultEl.innerHTML = '';
      const link = document.createElement('a');
      link.className = 'file-tool-dl'; link.href = dataUrl; link.download = fileName;
      link.innerHTML = `<i class="fas fa-download"></i> ${fileName}`;
      resultEl.appendChild(link);
      ftAddHistory(fileName, dataUrl, 'image/'+fmt);
      genSidebarLog('filetools', `Resized to ${w}×${h}`, 'success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(_ftResizeFile);
}
// Lock aspect ratio
document.addEventListener('DOMContentLoaded', () => {
  const wIn = document.getElementById('ft-resize-w');
  const hIn = document.getElementById('ft-resize-h');
  if (wIn) wIn.addEventListener('input', () => {
    if (document.getElementById('ft-resize-lock')?.checked) {
      hIn.value = Math.round(parseInt(wIn.value) * _ftResizeNatH / _ftResizeNatW) || '';
    }
  });
  if (hIn) hIn.addEventListener('input', () => {
    if (document.getElementById('ft-resize-lock')?.checked) {
      wIn.value = Math.round(parseInt(hIn.value) * _ftResizeNatW / _ftResizeNatH) || '';
    }
  });
});

/* Image Convert */
let _ftConvFile = null;
function ftConvertPreview(input) {
  if (!input.files || !input.files[0]) return;
  _ftConvFile = input.files[0];
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('ft-conv-preview');
    img.src = e.target.result;
    document.getElementById('ft-conv-opts').style.display = 'block';
  };
  reader.readAsDataURL(_ftConvFile);
}
function ftDoConvert() {
  if (!_ftConvFile) return;
  const fmt     = document.getElementById('ft-conv-fmt').value;
  const quality = parseInt(document.getElementById('ft-conv-quality').value) / 100;
  const ext     = fmt === 'jpeg' ? 'jpg' : fmt;
  const reader  = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const dataUrl  = canvas.toDataURL('image/'+fmt, quality);
      const fileName = _ftConvFile.name.replace(/\.[^.]+$/,'') + '.' + ext;
      const resultEl = document.getElementById('ft-conv-result');
      resultEl.innerHTML = '';
      const link = document.createElement('a');
      link.className = 'file-tool-dl'; link.href = dataUrl; link.download = fileName;
      link.innerHTML = `<i class="fas fa-download"></i> ${fileName}`;
      resultEl.appendChild(link);
      ftAddHistory(fileName, dataUrl, 'image/'+fmt);
      genSidebarLog('filetools', `Converted to ${fmt.toUpperCase()}`, 'success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(_ftConvFile);
}

/* Image Compress */
let _ftCompFile = null;
function ftCompressPreview(input) {
  if (!input.files || !input.files[0]) return;
  _ftCompFile = input.files[0];
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('ft-comp-preview');
    img.src = e.target.result;
    const kb = (_ftCompFile.size / 1024).toFixed(1);
    document.getElementById('ft-comp-info').textContent = `Original: ${kb} KB`;
    document.getElementById('ft-comp-opts').style.display = 'block';
  };
  reader.readAsDataURL(_ftCompFile);
}
function ftDoCompress() {
  if (!_ftCompFile) return;
  const quality = parseInt(document.getElementById('ft-comp-quality').value) / 100;
  const reader  = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const dataUrl  = canvas.toDataURL('image/jpeg', quality);
      const bytes    = Math.round(dataUrl.length * 0.75);
      const kb       = (bytes / 1024).toFixed(1);
      const origKb   = (_ftCompFile.size / 1024).toFixed(1);
      const savings  = Math.max(0, Math.round((1 - bytes / _ftCompFile.size) * 100));
      const fileName = _ftCompFile.name.replace(/\.[^.]+$/,'') + '_compressed.jpg';
      const resultEl = document.getElementById('ft-comp-result');
      resultEl.innerHTML = `<div style="font-size:11px;color:var(--text-m);margin-bottom:4px">${origKb} KB → ~${kb} KB (${savings}% smaller)</div>`;
      const link = document.createElement('a');
      link.className = 'file-tool-dl'; link.href = dataUrl; link.download = fileName;
      link.innerHTML = `<i class="fas fa-download"></i> ${fileName}`;
      resultEl.appendChild(link);
      ftAddHistory(fileName, dataUrl, 'image/jpeg');
      genSidebarLog('filetools', `Compressed ${savings}% smaller`, 'success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(_ftCompFile);
}

/* Base64 Tools */
function switchB64Mode(mode) {
  document.getElementById('b64-enc-btn')?.classList.toggle('active', mode==='encode');
  document.getElementById('b64-dec-btn')?.classList.toggle('active', mode==='decode');
  document.getElementById('b64-encode-area').style.display = mode==='encode' ? 'block' : 'none';
  document.getElementById('b64-decode-area').style.display = mode==='decode' ? 'block' : 'none';
}
function ftB64Encode(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = e => {
    const b64 = e.target.result.split(',')[1];
    const el  = document.getElementById('ft-b64-result');
    el.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'gen-pmt'; ta.rows = 4; ta.readOnly = true;
    ta.value = b64; ta.style.cssText = 'font-size:10px;word-break:break-all;margin-top:8px';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-gen'; copyBtn.style.cssText = 'padding:6px 14px;font-size:11px;margin-top:6px';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copy Base64';
    copyBtn.onclick = () => { navigator.clipboard.writeText(b64).then(()=>notify('Base64 copied!','success')); };
    el.appendChild(ta); el.appendChild(copyBtn);
    genSidebarLog('filetools', `${file.name} encoded (${Math.round(b64.length/1024)}KB)`, 'success');
  };
  reader.readAsDataURL(file);
}
function ftB64Decode() {
  const raw = (document.getElementById('ft-b64-text')?.value || '').trim();
  if (!raw) { notify('Paste a Base64 string first.', 'warn'); return; }
  try {
    const clean = raw.startsWith('data:') ? raw.split(',')[1] : raw;
    const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
    const blob  = new Blob([bytes]);
    const url   = URL.createObjectURL(blob);
    const el    = document.getElementById('ft-b64-result');
    el.innerHTML = '';
    const link = document.createElement('a');
    link.className = 'file-tool-dl'; link.href = url; link.download = 'decoded_file';
    link.innerHTML = `<i class="fas fa-download"></i> Download Decoded File`;
    el.appendChild(link);
    ftAddHistory('decoded_file', url, 'application/octet-stream');
    genSidebarLog('filetools', 'Base64 decoded successfully', 'success');
  } catch (err) {
    notify('Invalid Base64 string.', 'error');
    genSidebarLog('filetools', 'Decode failed: ' + err.message, 'error');
  }
}

/* ── T7: Additional File Conversion Tools ────────────────────────────────── */

/* TXT → PDF */
let _ftTxtFile = null;
function ftTxtPreview(input) {
  if (!input.files || !input.files[0]) return;
  _ftTxtFile = input.files[0];
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('ft-txt-preview');
    if (preview) { preview.textContent = e.target.result.slice(0, 300) + (e.target.result.length > 300 ? '…' : ''); preview.style.display = 'block'; }
    document.getElementById('ft-txt-opts').style.display = 'block';
  };
  reader.readAsText(_ftTxtFile);
}
async function ftDoTxtToPdf() {
  if (!_ftTxtFile) return;
  const statusEl = document.getElementById('ft-txt-status');
  const resultEl = document.getElementById('ft-txt-result');
  statusEl.textContent = 'Building PDF…';
  resultEl.innerHTML = '';
  try {
    if (!window.jspdf) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const text = await _ftTxtFile.text();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const marginX = 40, marginY = 50, lineH = 16, maxW = doc.internal.pageSize.getWidth() - marginX * 2;
    const lines = doc.splitTextToSize(text, maxW);
    let y = marginY;
    for (const line of lines) {
      if (y + lineH > doc.internal.pageSize.getHeight() - marginY) { doc.addPage(); y = marginY; }
      doc.setFontSize(11);
      doc.setTextColor(30, 30, 30);
      doc.text(line, marginX, y);
      y += lineH;
    }
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    const fileName = _ftTxtFile.name.replace(/\.[^.]+$/, '') + '.pdf';
    const link = document.createElement('a');
    link.className = 'file-tool-dl'; link.href = url; link.download = fileName;
    link.innerHTML = `<i class="fas fa-file-pdf"></i> ${fileName}`;
    resultEl.appendChild(link);
    statusEl.textContent = `✅ PDF ready (${lines.length} lines)`;
    ftAddHistory(fileName, url, 'application/pdf');
    genSidebarLog('filetools', `TXT → PDF (${lines.length} lines)`, 'success');
  } catch (err) {
    statusEl.textContent = '❌ ' + err.message;
    genSidebarLog('filetools', 'TXT→PDF failed: ' + err.message, 'error');
  }
}

/* CSV → JSON */
let _ftCsvFile = null;
function ftCsvPreview(input) {
  if (!input.files || !input.files[0]) return;
  _ftCsvFile = input.files[0];
  document.getElementById('ft-csv-opts').style.display = 'block';
  document.getElementById('ft-csv-status').textContent = `File: ${_ftCsvFile.name} (${(_ftCsvFile.size/1024).toFixed(1)} KB)`;
}
async function ftDoCsvToJson() {
  if (!_ftCsvFile) return;
  const statusEl = document.getElementById('ft-csv-status');
  const resultEl = document.getElementById('ft-csv-result');
  statusEl.textContent = 'Converting…';
  resultEl.innerHTML = '';
  try {
    const text = await _ftCsvFile.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) { statusEl.textContent = '❌ Need at least a header row and one data row'; return; }
    const delimiter = text.includes('\t') ? '\t' : ',';
    const parseRow = row => {
      const result = []; let cur = '', inQ = false;
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === '"') { inQ = !inQ; } else if (ch === delimiter && !inQ) { result.push(cur.trim()); cur = ''; } else { cur += ch; }
      }
      result.push(cur.trim());
      return result;
    };
    const headers = parseRow(lines[0]);
    const jsonData = lines.slice(1).filter(l => l.trim()).map(line => {
      const vals = parseRow(line);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ''; });
      return obj;
    });
    const jsonStr = JSON.stringify(jsonData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const fileName = _ftCsvFile.name.replace(/\.[^.]+$/, '') + '.json';
    const link = document.createElement('a');
    link.className = 'file-tool-dl'; link.href = url; link.download = fileName;
    link.innerHTML = `<i class="fas fa-file-code"></i> ${fileName} (${jsonData.length} rows)`;
    resultEl.appendChild(link);
    // Preview first 3 rows
    const preview = document.getElementById('ft-csv-preview');
    if (preview) {
      preview.textContent = JSON.stringify(jsonData.slice(0, 3), null, 2) + (jsonData.length > 3 ? '\n…' : '');
      preview.style.display = 'block';
    }
    statusEl.textContent = `✅ ${jsonData.length} rows converted`;
    ftAddHistory(fileName, url, 'application/json');
    genSidebarLog('filetools', `CSV → JSON (${jsonData.length} rows)`, 'success');
  } catch (err) {
    statusEl.textContent = '❌ ' + err.message;
    genSidebarLog('filetools', 'CSV→JSON failed: ' + err.message, 'error');
  }
}

/* SVG → PNG */
let _ftSvgFile = null;
function ftSvgPreview(input) {
  if (!input.files || !input.files[0]) return;
  _ftSvgFile = input.files[0];
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('ft-svg-preview');
    if (img) { img.src = e.target.result; img.style.display = 'block'; }
    document.getElementById('ft-svg-opts').style.display = 'block';
  };
  reader.readAsDataURL(_ftSvgFile);
}
function ftDoSvgToPng() {
  if (!_ftSvgFile) return;
  const statusEl = document.getElementById('ft-svg-status');
  const resultEl = document.getElementById('ft-svg-result');
  const scale = parseInt(document.getElementById('ft-svg-scale')?.value || '2') || 2;
  statusEl.textContent = 'Rendering…';
  resultEl.innerHTML = '';
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const w = (img.naturalWidth || 400) * scale;
      const h = (img.naturalHeight || 400) * scale;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/png');
      const fileName = _ftSvgFile.name.replace(/\.svg$/i, '') + `@${scale}x.png`;
      const link = document.createElement('a');
      link.className = 'file-tool-dl'; link.href = dataUrl; link.download = fileName;
      link.innerHTML = `<i class="fas fa-download"></i> ${fileName}`;
      resultEl.appendChild(link);
      statusEl.textContent = `✅ PNG ready (${w}×${h}px)`;
      ftAddHistory(fileName, dataUrl, 'image/png');
      genSidebarLog('filetools', `SVG → PNG ${w}×${h}`, 'success');
    };
    img.onerror = () => { statusEl.textContent = '❌ Could not render SVG — check file is valid'; };
    img.src = e.target.result;
  };
  reader.readAsDataURL(_ftSvgFile);
}

/* PPTX → PDF (client-side via PptxGenJS for text extraction, then jsPDF) */
let _ftPptxFile = null;
function ftPptxPreview(input) {
  if (!input.files || !input.files[0]) return;
  _ftPptxFile = input.files[0];
  document.getElementById('ft-pptx-opts').style.display = 'block';
  document.getElementById('ft-pptx-status').textContent = `File: ${_ftPptxFile.name} (${(_ftPptxFile.size/1024).toFixed(1)} KB)`;
}
async function ftDoPptxToPdf() {
  if (!_ftPptxFile) return;
  const statusEl = document.getElementById('ft-pptx-status');
  const resultEl = document.getElementById('ft-pptx-result');
  statusEl.textContent = 'Extracting slides…';
  resultEl.innerHTML = '';
  try {
    // Load JSZip + pptx parsing libraries
    if (!window.JSZip) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    if (!window.jspdf) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const arrayBuf = await _ftPptxFile.arrayBuffer();
    const zip = await window.JSZip.loadAsync(arrayBuf);
    // Get slide XML files
    const slideFiles = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
    if (!slideFiles.length) { statusEl.textContent = '❌ No slides found — ensure this is a valid .pptx file'; return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [792, 612] });
    const W = 792, H = 612, mx = 40, my = 50;
    let firstPage = true;
    for (let si = 0; si < slideFiles.length; si++) {
      const xmlText = await zip.files[slideFiles[si]].async('string');
      // Extract all text nodes <a:t>...</a:t>
      const textMatches = [...xmlText.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")).filter(t => t.trim());
      if (!firstPage) doc.addPage();
      firstPage = false;
      // Slide number header
      doc.setFillColor(20, 20, 35);
      doc.rect(0, 0, W, H, 'F');
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 120);
      doc.text(`Slide ${si + 1} of ${slideFiles.length}`, W - mx, my - 20, { align: 'right' });
      // Render text chunks
      let y = my;
      let isFirst = true;
      for (const chunk of textMatches) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        const fontSize = isFirst ? 22 : 13;
        const color = isFirst ? [240, 230, 255] : [200, 200, 220];
        doc.setFontSize(fontSize);
        doc.setTextColor(...color);
        const wrapped = doc.splitTextToSize(trimmed, W - mx * 2);
        for (const line of wrapped) {
          if (y > H - my) break;
          doc.text(line, mx, y);
          y += fontSize * 1.4;
        }
        y += isFirst ? 14 : 6;
        isFirst = false;
      }
      if (!textMatches.length) {
        doc.setFontSize(13);
        doc.setTextColor(100, 100, 120);
        doc.text('[Slide contains images or shapes only]', mx, H / 2);
      }
      statusEl.textContent = `Processing slide ${si + 1}/${slideFiles.length}…`;
    }
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    const fileName = _ftPptxFile.name.replace(/\.pptx?$/i, '') + '.pdf';
    const link = document.createElement('a');
    link.className = 'file-tool-dl'; link.href = url; link.download = fileName;
    link.innerHTML = `<i class="fas fa-file-pdf"></i> ${fileName} (${slideFiles.length} slides)`;
    resultEl.appendChild(link);
    statusEl.textContent = `✅ PDF ready — ${slideFiles.length} slides extracted`;
    ftAddHistory(fileName, url, 'application/pdf');
    genSidebarLog('filetools', `PPTX → PDF (${slideFiles.length} slides)`, 'success');
  } catch (err) {
    statusEl.textContent = '❌ ' + err.message;
    genSidebarLog('filetools', 'PPTX→PDF failed: ' + err.message, 'error');
  }
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
    const pic = FS_USER.picture
      ? `<img class="u-avatar" id="u-avatar-img" src="${FS_USER.picture}" alt="${escHtml(FS_USER.name)}" onerror="this.style.display='none';document.getElementById('u-avatar-fallback').style.display='flex'">`
      : '';
    const fallbackDisplay = FS_USER.picture ? 'none' : 'flex';
    const fallbackLetter = (FS_USER.name||'?')[0].toUpperCase();

    area.innerHTML = `
<div class="u-wrap" id="u-wrap">
  <div class="u-pill">
    ${pic}
    <div class="u-avatar" id="u-avatar-fallback" style="display:${fallbackDisplay};align-items:center;justify-content:center;font-size:13px;font-weight:800;color:var(--accent)">${fallbackLetter}</div>
    <span class="u-name">${escHtml(FS_USER.name?.split(' ')[0]||'You')}</span>
    <i class="fas fa-chevron-down" style="font-size:9px;color:var(--text-m);margin-left:1px"></i>
  </div>
  <div class="u-dropdown" id="u-dropdown">
    <button class="u-drop-item" id="u-drop-avatar-btn">
      <i class="fas fa-camera"></i> Change Profile Picture
    </button>
    <input type="file" id="u-avatar-file-input" accept="image/*" style="display:none">
    <div id="u-avatar-upload-progress" style="display:none">
      <div class="u-avatar-form" style="padding-top:4px">
        <div style="font-size:11px;color:var(--text-s);text-align:center;padding:4px 0" id="u-avatar-progress-text">Uploading…</div>
        <div style="height:3px;background:var(--border);border-radius:2px;overflow:hidden">
          <div id="u-avatar-progress-bar" style="height:100%;width:0%;background:var(--grad);transition:width .3s"></div>
        </div>
      </div>
    </div>
    <div class="u-drop-divider"></div>
    <button class="u-drop-item" onclick="switchToFocusAndStart()">
      <i class="fas fa-play-circle"></i> Start Timer
    </button>
    <div class="u-drop-divider"></div>
    <button class="u-drop-item" onclick="openSettingsModal()">
      <i class="fas fa-gear"></i> Settings
    </button>
  </div>
</div>`;

    // Open file picker — use a dedicated click handler that stops propagation
    // so the "click outside" listener doesn't immediately close the dropdown
    document.getElementById('u-drop-avatar-btn')?.addEventListener('click', function(e) {
      e.stopPropagation();
      document.getElementById('u-avatar-file-input')?.click();
    });

    // File input change — auto-upload when user picks a file
    document.getElementById('u-avatar-file-input')?.addEventListener('change', function(e) {
      const file = e.target.files?.[0];
      if (file) uploadAvatarFile(file);
    });

    // Close dropdown when clicking outside — but NOT when interacting with file picker
    document.addEventListener('click', function(e) {
      const wrap = document.getElementById('u-wrap');
      const fileInput = document.getElementById('u-avatar-file-input');
      // Ignore clicks that are part of the file-picker flow
      if (fileInput && (e.target === fileInput)) return;
      if (wrap && !wrap.contains(e.target)) {
        const dd = document.getElementById('u-dropdown');
        if (dd) { dd.style.opacity='0'; dd.style.visibility='hidden'; dd.style.transform='translateY(-4px)'; }
      }
    }, { capture: true });

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

// Upload avatar file — multipart POST to /api/avatar, updates the visible img + session cookie
async function uploadAvatarFile(file) {
  // Basic client-side checks
  if (!file.type.startsWith('image/')) { notify('Please choose an image file.', 'warning'); return; }
  if (file.size > 5 * 1024 * 1024)    { notify('Image must be under 5 MB.', 'warning'); return; }

  // ── Step 1: show preview INSTANTLY from local file using FileReader ──────
  const reader = new FileReader();
  reader.onload = function(ev) {
    const localUrl = ev.target.result;
    _applyAvatarToUI(localUrl);
  };
  reader.readAsDataURL(file);

  // ── Step 2: show progress bar ─────────────────────────────────────────────
  const progress = document.getElementById('u-avatar-upload-progress');
  const progText = document.getElementById('u-avatar-progress-text');
  const progBar  = document.getElementById('u-avatar-progress-bar');
  if (progress) progress.style.display = 'block';
  if (progText)  progText.textContent  = 'Saving…';
  if (progBar)   progBar.style.width   = '40%';

  // ── Step 3: upload to server ──────────────────────────────────────────────
  try {
    const formData = new FormData();
    formData.append('file', file);

    if (progBar) progBar.style.width = '70%';
    const res  = await fetch('/api/avatar', { method: 'POST', credentials: 'include', body: formData });
    if (progBar) progBar.style.width = '95%';
    const data = await res.json();

    if (data.ok) {
      // Replace the temporary local blob URL with the permanent server URL
      _applyAvatarToUI(data.url);
      if (window.FS_USER) window.FS_USER.picture = data.url;

      if (progBar)  progBar.style.width   = '100%';
      if (progText) progText.textContent  = 'Done!';
      notify('Profile picture updated!', 'success');

      setTimeout(() => {
        if (progress) progress.style.display = 'none';
        if (progBar)  progBar.style.width    = '0%';
        const fi = document.getElementById('u-avatar-file-input');
        if (fi) fi.value = '';
      }, 1000);
    } else {
      if (progress) progress.style.display = 'none';
      const msgs = {
        no_file:             'No file received — please try again.',
        invalid_type:        'Only image files are allowed.',
        too_large:           'Image must be under 5 MB.',
        storage_unavailable: 'Storage unavailable — try again shortly.',
      };
      notify(msgs[data.error] || 'Upload failed — please try again.', 'warning');
    }
  } catch(e) {
    if (progress) progress.style.display = 'none';
    notify('Network error — please try again.', 'warning');
  }
}

// Apply a URL (local blob or remote) to the avatar img element in the header
function _applyAvatarToUI(url) {
  let imgEl    = document.getElementById('u-avatar-img');
  const fallback = document.getElementById('u-avatar-fallback');
  if (!imgEl) {
    // First time — no img exists yet, insert one before the fallback div
    const pill = document.querySelector('.u-pill');
    if (pill) {
      const newImg = document.createElement('img');
      newImg.className = 'u-avatar';
      newImg.id        = 'u-avatar-img';
      newImg.alt       = 'avatar';
      pill.insertBefore(newImg, pill.firstChild);
      imgEl = newImg;
    }
  }
  if (imgEl) {
    imgEl.src           = url;
    imgEl.style.display = 'block';
  }
  if (fallback) fallback.style.display = 'none';
}

// Switch to Focus tab and start the timer
function switchToFocusAndStart() {
  const focusTab = document.getElementById('tab-focus');
  if (focusTab) focusTab.click();
  setTimeout(() => {
    const startBtn = document.getElementById('btn-start');
    if (startBtn && !state.timer.running) startBtn.click();
  }, 150);
}

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

// ── AI Intention + Debrief ────────────────────────────────────────────────
let _currentIntention = null;

function setIntention() {
  const inp = document.getElementById('intention-input');
  const val = inp?.value?.trim();
  if (!val) return;
  _currentIntention = val;
  inp.value = '';
  const display = document.getElementById('intention-display');
  if (display) {
    display.style.display = 'block';
    display.innerHTML = `<strong>🎯 Intention set:</strong> ${escHtml(val)}`;
  }
  // Ask AI for a quick framing tip (non-blocking)
  _getIntentionTip(val);
}

async function _getIntentionTip(intention) {
  try {
    const badge = document.getElementById('intention-ai-badge');
    if (badge) badge.style.display = 'inline';
    const display = document.getElementById('intention-display');
    const r = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `I'm about to start a focus session. My intention: "${intention}". Give me ONE powerful sentence (max 20 words) to frame my mindset. Be direct, no fluff.`,
        model: 'gpt-4o-mini',
        systemOverride: 'You are a focus coach. Reply with exactly one sentence under 20 words. No greetings, no lists, just the sentence.',
      })
    });
    if (!r.ok) return;
    const tip = (await r.text()).trim().replace(/^["']|["']$/g, '');
    if (display && tip) {
      display.innerHTML = `<strong>🎯 ${escHtml(intention)}</strong><br><em style="color:var(--accent);font-size:11px;margin-top:4px;display:block">"${escHtml(tip)}"</em>`;
    }
  } catch(e) {}
}

async function _getSessionDebrief(durationMin, intention) {
  if (!intention) return null;
  try {
    const r = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `I just completed a ${durationMin}-minute focus session. My intention was: "${intention}". Give me ONE insightful sentence (max 20 words) as a post-session reflection. Be specific to the intention.`,
        model: 'gpt-4o-mini',
        systemOverride: 'You are a focus coach. Reply with exactly one sentence under 20 words. No greetings.',
      })
    });
    if (!r.ok) return null;
    return (await r.text()).trim().replace(/^["']|["']$/g, '');
  } catch(e) { return null; }
}

function startTimer() {
  // Record session start time for calendar logging
  if (state.timer.phase === 'focus' && !state.timer._sessionStartISO) {
    state.timer._sessionStartISO = new Date().toISOString();
  }
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
    const sessionStartISO = state.timer._sessionStartISO || new Date(Date.now() - state.timer.focusMin * 60 * 1000).toISOString();
    state.timer.sessions++;
    // Streak: only increment once per calendar day
    const todayStr = new Date().toISOString().slice(0, 10);
    if (state.timer._lastSessionDate !== todayStr) {
      state.timer.streak++;
      state.timer._lastSessionDate = todayStr;
    }
    saveLocalState();
    triggerCelebration('Focus Session Complete! 🎉', `${state.timer.sessions} sessions today — ${Math.round(state.timer.totalFocusSec/60)}m total`);
    updateFlowScore();
    maybeShowTip();
    // Clear intention display for next session
    const intentionDisplay = document.getElementById('intention-display');
    if (intentionDisplay) intentionDisplay.style.display = 'none';
    // PILLAR 2: prompt to log to calendar + AI debrief
    const intentionForDebrief = _currentIntention;
    _currentIntention = null;
    setTimeout(async () => {
      let debrief = null;
      if (intentionForDebrief) debrief = await _getSessionDebrief(state.timer.focusMin, intentionForDebrief);
      showFocusCalPrompt(state.timer.focusMin, sessionStartISO, debrief);
    }, 1200);
    // PILLAR 3b: browser notification
    sendNotification('🍅 Focus Session Complete!', `${state.timer.focusMin}m done — take a well-earned break.`);
    state.timer._sessionStartISO = null;
  }
  // Auto-switch phase
  if (state.timer.phase==='focus') {
    setPhase(state.timer.sessions%4===0?'long':'short');
    notify('Break time! Step away from the screen 🧘','info');
    sendNotification('☕ Break time!', 'Step away from the screen for a few minutes.');
  } else {
    setPhase('focus');
    notify('Break done! Ready to focus? 💪','success');
    sendNotification('⚡ Break done!', 'Ready to focus? Your next session awaits.');
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
    if (!cfg.enabled) return;
    if (cfg.type === 'youtube') {
      // Use playlist if available, otherwise fall back to saved single URL
      const playlist = JSON.parse(localStorage.getItem('yt_playlist') || '[]');
      if (playlist.length > 0) {
        const shuffle = localStorage.getItem('yt_shuffle') === '1';
        const startIdx = shuffle ? Math.floor(Math.random() * playlist.length) : 0;
        _ytPlaylistIdx = startIdx;
        const item = playlist[startIdx];
        const label = item.title && item.title !== 'YouTube Video' && item.title !== 'Loading…' ? item.title : '▶ YouTube';
        if (item.listId) startYouTubePlaylist(item.listId, item.videoId, label);
        else if (item.videoId) startYouTubeMusic(item.videoId, label);
        else if (item.url) startYouTubeMusic('', label);
      } else if (cfg.videoId) {
        startYouTubeMusic(cfg.videoId, '▶ YouTube');
      }
    } else if (cfg.type === 'spotify') {
      startSpotifyMusic(cfg.uri);
    }
  } catch(e){}
}

function stopPomodoroMusic() {
  if (pomodoroMusicEl) {
    pomodoroMusicEl.src = '';
    pomodoroMusicEl.style.display = 'none';
  }
  _npHide();
  // Reset vol icon when no music is active and ambient is also off
  if (!state.timer.soundType || state.timer.soundType === 'off') {
    const icon = document.getElementById('vol-icon');
    if (icon && _volCurrent > 0) { icon.className = 'fas fa-volume-high vol-icon'; icon.style.color = ''; }
  }
}

function _pomodoroMusicReady(label) {
  // Called after iframe src is set — apply saved volume after a short delay
  // (YouTube iframe needs ~1s before it accepts postMessage commands)
  setTimeout(() => _applyMusicVolume(_volMuted ? 0 : _volCurrent), 1200);
  _npShow(label || 'Music playing');
  // Update vol icon to active
  _volSetUI(_volMuted ? 0 : _volCurrent, false);
}

function startYouTubeMusic(videoId, label) {
  if (!pomodoroMusicEl) {
    pomodoroMusicEl = document.createElement('iframe');
    pomodoroMusicEl.style.cssText = 'position:fixed;bottom:-200px;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    pomodoroMusicEl.allow = 'autoplay; encrypted-media';
    document.body.appendChild(pomodoroMusicEl);
  }
  // enablejsapi=1 is required for postMessage volume control
  pomodoroMusicEl.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&controls=0&loop=1&playlist=${videoId}&enablejsapi=1`;
  _pomodoroMusicReady(label || '▶ YouTube');
}

function startSpotifyMusic(uri) {
  if (!pomodoroMusicEl) {
    pomodoroMusicEl = document.createElement('iframe');
    pomodoroMusicEl.style.cssText = 'position:fixed;bottom:-200px;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(pomodoroMusicEl);
  }
  const embedUri = uri.replace('spotify:', '').replace(/:/g, '/');
  pomodoroMusicEl.src = `https://open.spotify.com/embed/${embedUri}?autoplay=1`;
  _pomodoroMusicReady('▶ Spotify');
}

// ── T3: YouTube Playlist Manager ─────────────────────────────────────────────
let _ytPlaylist = JSON.parse(localStorage.getItem('yt_playlist') || '[]');
let _ytPlaylistIdx = 0;
let _ytShuffleMode = localStorage.getItem('yt_shuffle') === '1';
let _ytDragSrcIdx = null;

function openMusicModal() {
  const saved = JSON.parse(localStorage.getItem('pomodoro_music') || '{"enabled":false,"type":"youtube","url":"","videoId":"","uri":""}');
  _ytPlaylist = JSON.parse(localStorage.getItem('yt_playlist') || '[]');
  _ytShuffleMode = localStorage.getItem('yt_shuffle') === '1';
  openModal(`
    <h2>🎵 Pomodoro Music</h2>
    <p style="color:var(--text-s);font-size:13px;margin:6px 0 14px">Auto-start music when a focus session begins.</p>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="btn-sm ${saved.type!=='spotify'?'btn-primary':''}" id="mus-yt-btn" onclick="selectMusicType('youtube')"><i class="fab fa-youtube" style="color:#ef4444"></i> YouTube Playlist</button>
      <button class="btn-sm ${saved.type==='spotify'?'btn-primary':''}" id="mus-sp-btn" onclick="selectMusicType('spotify')"><i class="fab fa-spotify" style="color:#1db954"></i> Spotify</button>
    </div>
    <div id="mus-yt-section" style="display:${saved.type!=='spotify'?'block':'none'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <label style="font-size:12px;font-weight:700;color:var(--text-m)">YouTube Links (${_ytPlaylist.length})</label>
        <button class="btn-sm ${_ytShuffleMode?'btn-primary':''}" id="yt-shuffle-btn" onclick="_ytToggleShuffle()" style="font-size:11px;padding:4px 9px"><i class="fas fa-random"></i> Shuffle</button>
      </div>
      <div id="yt-playlist-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;max-height:190px;overflow-y:auto">
        ${_renderYtPlaylistItems()}
      </div>
      <div style="display:flex;gap:6px">
        <input class="fs-in" id="mus-yt-add-url" placeholder="Paste YouTube URL and press Add" style="flex:1;font-size:12px" onkeydown="if(event.key==='Enter')_ytAddUrl()">
        <button class="btn-primary" style="padding:7px 12px;font-size:12px;white-space:nowrap" onclick="_ytAddUrl()"><i class="fas fa-plus"></i> Add</button>
      </div>
      <div style="font-size:10px;color:var(--text-s);margin-top:6px">Supports video links, playlist links, youtu.be short links. Drag to reorder. Plays sequentially or in shuffle order.</div>
    </div>
    <div id="mus-sp-section" style="display:${saved.type==='spotify'?'block':'none'}">
      <label style="font-size:12px;color:var(--text-m)">Spotify URI (spotify:playlist:... or spotify:album:...)</label>
      <input class="fs-in" id="mus-sp-uri" style="margin:6px 0 10px" placeholder="spotify:playlist:37i9dQZF1DX8NTLI2TtZa6" value="${escHtml(saved.type==='spotify'?saved.uri:'')}">
      <div style="font-size:11px;color:var(--text-m)">Right-click playlist → Share → Copy Spotify URI. Requires Premium.</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:14px 0">
      <input type="checkbox" id="mus-enabled" ${saved.enabled?'checked':''}>
      <label for="mus-enabled" style="font-size:13px;font-weight:600">Auto-start when focus session begins</label>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-primary" onclick="saveMusicSettings()" style="flex:1">Save</button>
      <button class="btn-sm" onclick="clearMusicSettings()">Clear All</button>
    </div>
    <div style="margin-top:10px;font-size:10px;color:var(--text-s)">⚖️ YouTube/Spotify embeds comply with their ToS for personal use.</div>
  `, true);
}

function _renderYtPlaylistItems() {
  if (!_ytPlaylist.length) return '<div style="text-align:center;padding:14px;color:var(--text-s);font-size:12px">No links yet — add your first YouTube link above</div>';
  return _ytPlaylist.map((item, i) => `
    <div draggable="true" ondragstart="_ytDragStart(${i})" ondragover="event.preventDefault()" ondrop="_ytDrop(${i})"
      style="display:flex;align-items:center;gap:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 10px;cursor:grab">
      <i class="fas fa-grip-vertical" style="color:var(--text-s);font-size:11px"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--text-p);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(item.title||'YouTube Video')}</div>
        <div style="font-size:10px;color:var(--text-s);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(item.url)}</div>
      </div>
      <button onclick="_ytPlayNow(${i})" style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:6px;padding:4px 8px;color:#ef4444;cursor:pointer;font-size:11px" title="Play now"><i class="fas fa-play"></i></button>
      <button onclick="_ytRemove(${i})" style="background:none;border:none;color:var(--text-s);cursor:pointer;font-size:12px;padding:2px 5px" title="Remove"><i class="fas fa-times"></i></button>
    </div>`).join('');
}

function _ytAddUrl() {
  const input = document.getElementById('mus-yt-add-url');
  const url = input?.value?.trim();
  if (!url) return;
  const mV = url.match(/[?&]v=([^&]+)/)||url.match(/youtu\.be\/([^?]+)/)||url.match(/embed\/([^?]+)/);
  const mL = url.match(/[?&]list=([^&]+)/);
  const videoId = mV ? mV[1] : '';
  const entry = { url, videoId, title: 'Loading…', listId: mL?mL[1]:'' };
  _ytPlaylist.push(entry);
  localStorage.setItem('yt_playlist', JSON.stringify(_ytPlaylist));
  if (input) input.value = '';
  _refreshYtList();
  fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
    .then(r=>r.json()).then(d=>{
      const idx = _ytPlaylist.findIndex(x=>x.url===url);
      if (idx>=0) { _ytPlaylist[idx].title = d.title||'YouTube Video'; localStorage.setItem('yt_playlist',JSON.stringify(_ytPlaylist)); _refreshYtList(); }
    }).catch(()=>{ const idx=_ytPlaylist.findIndex(x=>x.url===url); if(idx>=0){_ytPlaylist[idx].title='YouTube Video'; localStorage.setItem('yt_playlist',JSON.stringify(_ytPlaylist)); _refreshYtList();} });
}

function _refreshYtList() {
  const list = document.getElementById('yt-playlist-list');
  if (list) list.innerHTML = _renderYtPlaylistItems();
  const countLabel = document.querySelector('#mus-yt-section label');
  if (countLabel) countLabel.textContent = `YouTube Links (${_ytPlaylist.length})`;
}

function _ytRemove(idx) {
  _ytPlaylist.splice(idx, 1);
  localStorage.setItem('yt_playlist', JSON.stringify(_ytPlaylist));
  _refreshYtList();
}

function _ytPlayNow(idx) {
  const item = _ytPlaylist[idx];
  if (!item) return;
  _ytPlaylistIdx = idx;
  const label = item.title && item.title !== 'YouTube Video' && item.title !== 'Loading…' ? item.title : '▶ YouTube';
  if (item.listId) startYouTubePlaylist(item.listId, item.videoId, label);
  else if (item.videoId) startYouTubeMusic(item.videoId, label);
  notify(`▶ Playing: ${item.title||'YouTube'}`, 'success');
}

function _ytToggleShuffle() {
  _ytShuffleMode = !_ytShuffleMode;
  localStorage.setItem('yt_shuffle', _ytShuffleMode?'1':'0');
  const btn = document.getElementById('yt-shuffle-btn');
  if (btn) btn.className = 'btn-sm ' + (_ytShuffleMode?'btn-primary':'');
  notify(_ytShuffleMode?'🔀 Shuffle on':'▶ Sequential play', 'info');
}

function _ytDragStart(idx) { _ytDragSrcIdx = idx; }
function _ytDrop(targetIdx) {
  if (_ytDragSrcIdx === null || _ytDragSrcIdx === targetIdx) return;
  const moved = _ytPlaylist.splice(_ytDragSrcIdx, 1)[0];
  _ytPlaylist.splice(targetIdx, 0, moved);
  _ytDragSrcIdx = null;
  localStorage.setItem('yt_playlist', JSON.stringify(_ytPlaylist));
  _refreshYtList();
}

function startYouTubePlaylist(listId, firstVideoId, label) {
  if (!pomodoroMusicEl) {
    pomodoroMusicEl = document.createElement('iframe');
    pomodoroMusicEl.style.cssText = 'position:fixed;bottom:-200px;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    pomodoroMusicEl.allow = 'autoplay; encrypted-media';
    document.body.appendChild(pomodoroMusicEl);
  }
  const vid = firstVideoId ? `&video=${firstVideoId}` : '';
  pomodoroMusicEl.src = `https://www.youtube.com/embed/?listType=playlist&list=${listId}&autoplay=1${vid}&loop=1&enablejsapi=1`;
  _pomodoroMusicReady(label || '▶ YouTube Playlist');
}

function _getNextYtTrack() {
  if (!_ytPlaylist.length) return null;
  if (_ytShuffleMode) return _ytPlaylist[Math.floor(Math.random() * _ytPlaylist.length)];
  _ytPlaylistIdx = (_ytPlaylistIdx + 1) % _ytPlaylist.length;
  return _ytPlaylist[_ytPlaylistIdx];
}

function selectMusicType(type) {
  document.getElementById('mus-yt-section').style.display = type==='youtube'?'block':'none';
  document.getElementById('mus-sp-section').style.display = type==='spotify'?'block':'none';
  document.getElementById('mus-yt-btn').className = 'btn-sm '+(type==='youtube'?'btn-primary':'');
  document.getElementById('mus-sp-btn').className = 'btn-sm '+(type==='spotify'?'btn-primary':'');
}

function saveMusicSettings() {
  const type = document.getElementById('mus-yt-section')?.style.display!=='none' ? 'youtube' : 'spotify';
  const uri = document.getElementById('mus-sp-uri')?.value || '';
  const enabled = document.getElementById('mus-enabled')?.checked || false;
  // For youtube type, use first playlist item as the primary URL (backward compat)
  const firstItem = _ytPlaylist[0];
  const url = firstItem?.url || '';
  const videoId = firstItem?.videoId || '';
  localStorage.setItem('pomodoro_music', JSON.stringify({enabled, type, url, videoId, uri}));
  closeModal();
  notify(enabled?'🎵 Music saved! Playlist starts with each focus session.':'Music settings saved.','success');
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
  return `<span style="${s}background:var(--bg-panel);color:var(--text-p)">${icon}</span>`;
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
        appendMsg('ai','⏱️ You\'re sending too many messages. Wait 60 seconds and try again.','Rate limit');
      } else if (code === 'DAILY_LIMIT') {
        removeTyping(tid);
        showTokenWall(err.isPro);
        return;
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
    // Budget warning — show inline token bar when running low
    const budgetWarn = res.headers.get('X-Budget-Warning');
    const modelDowngraded = res.headers.get('X-Model-Downgraded');
    if (budgetWarn) showTokenWarningBar(budgetWarn);
    if (modelDowngraded && state.chat.model && !['gpt-4o-mini','gemini-2-flash','claude-haiku','grok-3-mini','llama-4-scout','llama-4-maverick','llama-3-3','deepseek-v3','auto'].includes(state.chat.model)) {
      showModelDowngradeBadge();
    }
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
  // Re-fetch events for the newly visible month
  if (FS_USER) loadCalEvents();
}

function renderCalGrid() {
  const grid = document.getElementById('cal-grid');
  const label = document.getElementById('cal-month-label');
  if (!grid) return;
  const { year, month } = state.cal;
  const now = new Date();
  if (label) label.textContent = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Debug: log all events we have
  console.log('[CAL] renderCalGrid: total events in state =', state.cal.events.length, '| sample:', state.cal.events.slice(0,2).map(e => e.start + ' ' + e.summary));

  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const prevTotal = new Date(year, month, 0).getDate();
  let html = days.map(d => `<div class="cal-hd">${d}</div>`).join('');

  for (let i = 0; i < first; i++) {
    html += `<div class="cal-day other"><span class="cal-day-num">${prevTotal - first + i + 1}</span></div>`;
  }
  for (let d = 1; d <= total; d++) {
    const isToday = year === now.getFullYear() && month === now.getMonth() && d === now.getDate();
    const dateStr = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    const dayEvs = state.cal.events.filter(e => {
      const s = String(e.start || '');
      // Handle both "2026-04-12" and "2026-04-12T09:00:00+00:00"
      return s.startsWith(dateStr);
    });

    const chipsHtml = dayEvs.slice(0, 3).map(e => {
      const col = (e.color && !e.color.includes('var(')) ? e.color : '#a855f7';
      const t = (!e.allDay && e.start && e.start.length > 10)
        ? new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' '
        : '';
      return `<div class="cal-day-ev-chip" style="background:${col}">${escHtml(t + (e.summary || ''))}</div>`;
    }).join('');
    const moreHtml = dayEvs.length > 3 ? `<div class="cal-day-more">+${dayEvs.length - 3} more</div>` : '';

    html += `<div class="cal-day${isToday ? ' today' : ''}" onclick="clickCalDay('${dateStr}')">
      <span class="cal-day-num">${d}</span>
      <div class="cal-day-events">${chipsHtml}${moreHtml}</div>
    </div>`;
  }
  const remaining = 42 - first - total;
  for (let d = 1; d <= remaining; d++) html += `<div class="cal-day other"><span class="cal-day-num">${d}</span></div>`;
  grid.innerHTML = html;
}

function calOpenPanel() {
  const panel = document.getElementById('cal-panel');
  if (panel) panel.classList.add('open');
}

function calClosePanel() {
  const panel = document.getElementById('cal-panel');
  if (panel) panel.classList.remove('open');
  document.getElementById('add-ev-form')?.classList.remove('show');
  document.querySelectorAll('.cal-day.selected').forEach(el => el.classList.remove('selected'));
}

function calShowAddForm(dateStr) {
  calOpenPanel();
  // Hide day detail, show add form
  const detail = document.getElementById('cal-day-card');
  const form = document.getElementById('add-ev-form');
  if (detail) detail.style.display = 'none';
  if (form) { form.style.display = 'block'; form.classList.add('show'); }
  if (dateStr) {
    document.getElementById('ev-start').value = dateStr + 'T09:00';
    document.getElementById('ev-end').value   = dateStr + 'T10:00';
  }
  setTimeout(() => document.getElementById('ev-title')?.focus(), 100);
}

function clickCalDay(dateStr) {
  const title = document.getElementById('cal-day-title');
  const evContainer = document.getElementById('cal-day-events');
  const detail = document.getElementById('cal-day-card');
  const addLink = document.getElementById('cal-add-link');
  if (!evContainer) return;

  // Highlight selected day
  document.querySelectorAll('.cal-day.selected').forEach(el => el.classList.remove('selected'));
  const clickedEl = document.querySelector(`.cal-day[onclick="clickCalDay('${dateStr}')"]`);
  if (clickedEl) clickedEl.classList.add('selected');

  // Open panel, show detail, hide add form
  calOpenPanel();
  if (detail) detail.style.display = 'block';
  const addEvForm = document.getElementById('add-ev-form');
  if (addEvForm) { addEvForm.style.display = 'none'; addEvForm.classList.remove('show'); }

  // Set title
  const d = new Date(dateStr + 'T12:00:00');
  if (title) title.textContent = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  // Filter events for this day
  const dayEvs = state.cal.events.filter(e => String(e.start || '').slice(0, 10) === dateStr)
    .sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));

  const safeCol = c => (c && (c.startsWith('hsl') || c.startsWith('#') || c.startsWith('rgb'))) ? c : '#a855f7';

  if (!dayEvs.length) {
    evContainer.innerHTML = `<div style="color:#888;font-size:12px;padding:8px 0;text-align:center">No events</div>`;
  } else {
    evContainer.innerHTML = dayEvs.map(ev => {
      const col = safeCol(ev.color);
      const start = ev.start || '';
      const timeLabel = (!ev.allDay && start.length > 10)
        ? new Date(start).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true })
        : 'All day';
      const endLabel = (!ev.allDay && ev.end && ev.end.length > 10)
        ? ' – ' + new Date(ev.end).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true })
        : '';
      return `<div class="ev-item" style="border-left:3px solid ${col};margin-bottom:6px;padding:8px 10px">
        <div style="flex:1;min-width:0">
          <div class="ev-sum" style="font-size:12px">${escHtml(ev.summary || '(no title)')}</div>
          <div class="ev-time" style="font-size:11px">${timeLabel}${endLabel}</div>
        </div>
      </div>`;
    }).join('');
  }
  if (addLink) addLink.style.display = 'block';
}

function clickCalDayAdd(dateStr) {
  calShowAddForm(dateStr);
}

function _calDebug(msg, data, isError) {
  const dbg = document.getElementById('cal-debug-panel');
  const text = '[CAL] ' + msg + (data ? ' | ' + JSON.stringify(data) : '');
  console.log(text);
  if (!dbg) return;
  if (isError) {
    dbg.textContent = text;
    dbg.style.display = 'block';
  }
}

function loadCalEvents() {
  if (!FS_USER) {
    document.getElementById('cal-auth-banner').style.display = 'block';
    renderCalGrid();
    return;
  }
  document.getElementById('cal-auth-banner').style.display = 'none';
  const dbgPanel = document.getElementById('cal-debug-panel');
  if (dbgPanel) { dbgPanel.textContent = 'Loading events...'; dbgPanel.style.display = 'block'; dbgPanel.style.color = '#888'; dbgPanel.style.borderColor = '#333'; }
  const { year, month } = state.cal;
  fetch(`/api/calendar/events?year=${year}&month=${month}`, { credentials: 'include' })
    .then(r => r.json())
    .then(d => {
      console.log('[CAL] response:', d);
      // Auth errors
      if (d.error === 'not_authenticated' || d.error === 'not_authenticated') {
        if (dbgPanel) { dbgPanel.textContent = 'Auth error — click Re-sync to reconnect Google.'; dbgPanel.style.color = '#f59e0b'; dbgPanel.style.borderColor = '#f59e0b'; }
        _showCalReconnectBanner();
        renderCalGrid();
        return;
      }
      if (d.error) {
        const msg = 'Error: ' + d.error + (d.google_reason ? ' — ' + d.google_reason : '') + (d.google_code ? ' ('+d.google_code+')' : '');
        if (dbgPanel) { dbgPanel.textContent = msg + '\nVisit flowst8.cc/api/auth/hard-reset to fix.'; dbgPanel.style.color = '#ef4444'; dbgPanel.style.borderColor = '#ef4444'; dbgPanel.style.display = 'block'; }
        renderCalGrid();
        return;
      }
      // Success
      if (dbgPanel) dbgPanel.style.display = 'none';
      const rb = document.getElementById('cal-reconnect-banner');
      if (rb) rb.style.display = 'none';
      if (Array.isArray(d.events)) {
        state.cal.events = d.events;
        console.log('[CAL] Loaded', d.events.length, 'events. First:', d.events[0]);
        renderCalGrid();
      }
    })
    .catch(err => {
      if (dbgPanel) { dbgPanel.textContent = 'Network error: ' + err.message; dbgPanel.style.color = '#ef4444'; dbgPanel.style.display = 'block'; }
      renderCalGrid();
    });
}

function _showCalReconnectBanner() {
  // Create once, reuse
  let banner = document.getElementById('cal-reconnect-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'cal-reconnect-banner';
    banner.style.cssText = 'margin:10px 0;padding:10px 14px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);border-radius:9px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px';
    banner.innerHTML = `
      <div>
        <strong style="color:#f59e0b">📅 Calendar needs reconnecting</strong>
        <div style="color:rgba(255,255,255,.55);font-size:11px;margin-top:2px">
          Your Google session expired. Re-connect to reload your events — takes 10 seconds.
        </div>
      </div>
      <button onclick="window.location.href='/api/auth/calendar-reconnect'"
        style="padding:6px 14px;border-radius:7px;border:none;background:#f59e0b;color:#000;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">
        Reconnect →
      </button>
    `;
    // Insert before cal-grid inside calendar tab
    const calGrid = document.getElementById('cal-grid');
    if (calGrid) calGrid.parentNode.insertBefore(banner, calGrid);
    else document.getElementById('tab-pane-calendar')?.prepend(banner);
  }
  banner.style.display = 'flex';
}

function renderEvents(events) {
  const list = document.getElementById('ev-list');
  if (!list) return;
  if (!events || !events.length) {
    list.innerHTML = '<div class="empty"><i class="fas fa-calendar-alt"></i><p>No events this month. Click a day to add one.</p></div>';
    return;
  }
  // Sort by start time ascending
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.start || 0).getTime();
    const tb = new Date(b.start || 0).getTime();
    return ta - tb;
  });
  list.innerHTML = sorted.map(ev => {
    const start = ev.start || '';
    const d = start ? new Date(start) : null;
    const dateLabel = d ? d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }) : '';
    const timeLabel = (d && !ev.allDay) ? d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true }) : 'All day';
    return `<div class="ev-item">
      <div class="ev-dot" style="background:${(ev.color&&ev.color.startsWith('hsl'))?ev.color:'#a855f7'}"></div>
      <div style="flex:1;min-width:0">
        <div class="ev-sum">${escHtml(ev.summary||'(no title)')}</div>
        <div class="ev-time" style="font-size:10px;opacity:.6">${dateLabel} · ${timeLabel}</div>
      </div>
      <button class="btn-blk" onclick="blockAroundEvent('${ev.id}')">Block</button>
    </div>`;
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
    const f0 = document.getElementById('add-ev-form'); if(f0){f0.style.display='none';f0.classList.remove('show');}
    const dc0 = document.getElementById('cal-day-card'); if(dc0) dc0.style.display='block';
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
      const f1 = document.getElementById('add-ev-form'); if(f1){f1.style.display='none';f1.classList.remove('show');}
      const dc1 = document.getElementById('cal-day-card'); if(dc1) dc1.style.display='block';
      document.getElementById('ev-title').value='';
      document.getElementById('ev-desc').value='';
      loadCalEvents();
    } else {
      // Try fallback endpoint
      return fetch('/api/calendar/block', {
        method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
        body: JSON.stringify({ title, start, end, description:desc, color })
      }).then(r=>r.json()).then(d2=>{
        if (d2.ok||d2.id||d2.event?.id) {
          notify('Event created! ✓','success');
          const f2 = document.getElementById('add-ev-form'); if(f2){f2.style.display='none';f2.classList.remove('show');}
          const dc2 = document.getElementById('cal-day-card'); if(dc2) dc2.style.display='block';
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

// ══════════════════════════════════════════════════════════════════
// PILLAR 1 — Smart Scheduling
// ══════════════════════════════════════════════════════════════════
// ── Local smart scheduling — works for ALL users, no Google needed ─────────────
function getLocalSmartSuggestions() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const todayStr = now.toLocaleDateString('en-US', { weekday: 'short' });
  const tomorrowStr = new Date(now.getTime() + 86400000).toLocaleDateString('en-US', { weekday: 'short' });

  // Time-of-day focus windows with productivity science backing
  const WINDOWS = [
    { startH: 5,  startM: 30, label: '🌅 Early Bird Deep Work',  dur: 90,  score: 'ideal',  note: 'Peak cognitive clarity before distractions' },
    { startH: 8,  startM: 0,  label: '⚡ Morning Power Block',    dur: 90,  score: 'ideal',  note: 'Peak executive function window' },
    { startH: 9,  startM: 30, label: '🍅 Morning Pomodoro',       dur: 25,  score: 'ideal',  note: 'High alertness, low interruptions' },
    { startH: 10, startM: 0,  label: '⚡ Deep Work Sprint',       dur: 45,  score: 'ideal',  note: 'Optimal for complex problem-solving' },
    { startH: 11, startM: 0,  label: '🌊 Pre-Lunch Flow',         dur: 25,  score: 'good',   note: 'Last push before midday break' },
    { startH: 13, startM: 30, label: '🍅 Post-Lunch Pomodoro',    dur: 25,  score: 'good',   note: 'Energy recovery window' },
    { startH: 14, startM: 30, label: '⚡ Afternoon Focus',        dur: 45,  score: 'good',   note: 'Second wind — good for execution tasks' },
    { startH: 16, startM: 0,  label: '🌊 Late Afternoon Flow',    dur: 45,  score: 'good',   note: 'Wrap-up and creative synthesis' },
    { startH: 19, startM: 0,  label: '🌙 Evening Deep Work',      dur: 90,  score: 'good',   note: 'Quiet time, high focus potential' },
    { startH: 20, startM: 30, label: '🍅 Night Pomodoro',         dur: 25,  score: 'short',  note: 'Quick focused sprint before wind-down' },
  ];

  const suggestions = [];
  // Today: find next 3 windows that haven't started yet (or started within last 15 min)
  const nowMins = hour * 60 + minute;
  for (const w of WINDOWS) {
    if (suggestions.filter(s => s.day === todayStr).length >= 3) break;
    const wMins = w.startH * 60 + w.startM;
    if (wMins + 15 < nowMins) continue; // already passed
    const start = new Date(now); start.setHours(w.startH, w.startM, 0, 0);
    const end   = new Date(start.getTime() + w.dur * 60000);
    suggestions.push({
      day: todayStr, date: now.toLocaleDateString('en-US',{month:'short',day:'numeric'}),
      startTime: start.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}),
      endTime:   end.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}),
      startISO: start.toISOString(), endISO: end.toISOString(),
      durationMin: w.dur, label: w.label, score: w.score, note: w.note, local: true,
    });
  }
  // Tomorrow: first 3 morning windows
  const tomorrow = new Date(now.getTime() + 86400000);
  for (const w of WINDOWS) {
    if (suggestions.filter(s => s.day === tomorrowStr).length >= 3) break;
    if (w.startH < 7) continue; // skip very early tomorrow
    const start = new Date(tomorrow); start.setHours(w.startH, w.startM, 0, 0);
    const end   = new Date(start.getTime() + w.dur * 60000);
    suggestions.push({
      day: tomorrowStr, date: tomorrow.toLocaleDateString('en-US',{month:'short',day:'numeric'}),
      startTime: start.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}),
      endTime:   end.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}),
      startISO: start.toISOString(), endISO: end.toISOString(),
      durationMin: w.dur, label: w.label, score: w.score, note: w.note, local: true,
    });
  }
  return suggestions.slice(0, 6);
}

function renderSmartSuggestions(suggestions, isLocal) {
  const wrap = document.getElementById('smart-suggestions');
  if (!wrap) return;
  const localBadge = isLocal
    ? '<div style="font-size:10px;color:#888;margin-bottom:8px;padding:5px 10px;background:rgba(168,85,247,.07);border-radius:8px;border:1px solid rgba(168,85,247,.15)">📍 Smart windows based on time-of-day patterns · <a href="#" onclick="openAuthPopup(\'/api/auth/google\');return false" style="color:var(--accent);text-decoration:none">Connect Google Calendar</a> for calendar-aware suggestions</div>'
    : '';
  wrap.innerHTML = localBadge + suggestions.map(s => `
    <div class="ss-card ${s.score}" onclick="startFocusFromSuggestion('${s.startISO}','${s.endISO}',${s.durationMin})">
      <div class="ss-day">${s.day}</div>
      <div style="flex:1;min-width:0">
        <div class="ss-time">${s.startTime} → ${s.endTime}</div>
        <div class="ss-label">${s.label}${s.note ? '<span style="display:block;font-size:10px;color:#666;font-weight:400;margin-top:1px">'+s.note+'</span>' : ''}</div>
      </div>
      <div class="ss-dur">${s.durationMin}m</div>
      ${!s.local ? `<button class="ss-btn" onclick="event.stopPropagation();blockSuggestion('${s.startISO}','${s.endISO}',${s.durationMin})">Block</button>` : `<button class="ss-btn" onclick="event.stopPropagation();startFocusFromSuggestion('${s.startISO}','${s.endISO}',${s.durationMin})">Start</button>`}
    </div>
  `).join('');
}

function loadSmartSuggestions() {
  const wrap = document.getElementById('smart-suggestions');
  if (!wrap) return;

  // Non-Google users: show local time-of-day suggestions immediately
  if (!FS_USER) {
    const local = getLocalSmartSuggestions();
    renderSmartSuggestions(local, true);
    return;
  }

  wrap.innerHTML = '<div style="font-size:12px;color:#666;text-align:center;padding:10px"><i class="fas fa-spinner fa-spin"></i> Analyzing your calendar...</div>';
  fetch('/api/smart/suggest-focus', { credentials: 'include' })
    .then(r => r.json())
    .then(d => {
      if (d.error || !d.suggestions?.length) {
        // Google user but no calendar events — fall back to local suggestions
        const local = getLocalSmartSuggestions();
        renderSmartSuggestions(local, false);
        return;
      }
      renderSmartSuggestions(d.suggestions, false);
    })
    .catch(() => {
      // Network error — fall back to local
      const local = getLocalSmartSuggestions();
      renderSmartSuggestions(local, true);
    });
}

function startFocusFromSuggestion(startISO, endISO, durationMin) {
  // Set the timer duration and switch to focus tab
  state.timer.focusMin = durationMin;
  state.timer.elapsed = 0;
  setPhase('focus');
  updateTimerDisplay();
  switchTab('focus');
  // Store suggestion context for cal logging
  state.timer._suggestedStart = startISO;
  state.timer._suggestedEnd   = endISO;
  notify(`⚡ Timer set to ${durationMin}m — hit play to start your focus block!`, 'success');
}

function blockSuggestion(startISO, endISO, durationMin) {
  if (!FS_USER) { notify('Sign in to block time on Google Calendar', 'info'); return; }
  fetch('/api/calendar/block', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ title: `⚡ Focus Block — FlowState`, start: startISO, end: endISO })
  }).then(r => r.json()).then(d => {
    if (d.ok || d.event?.id) {
      notify(`✅ ${durationMin}m focus block added to your calendar!`, 'success');
      loadSmartSuggestions(); // refresh
      loadCalEvents();
    } else {
      notify('Could not block time — reconnect Google Calendar', 'error');
    }
  }).catch(() => notify('Network error', 'error'));
}

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// PILLAR 2 — Focus → Calendar + Output Tracking
// ══════════════════════════════════════════════════════════════════

// State for current session prompt
let _fcpSession = { durationMin: 25, startISO: null, outputType: null };

function showFocusCalPrompt(durationMin, startISO, debrief) {
  const prompt = document.getElementById('focus-cal-prompt');
  if (!prompt) return;

  // Reset state
  _fcpSession = { durationMin, startISO, outputType: null };

  // Update sub text + optional AI debrief
  const sub = document.getElementById('fcp-sub');
  if (sub) {
    sub.innerHTML = `${durationMin}m of deep focus done.${debrief ? `<br><em style="color:var(--accent);font-size:10px;margin-top:3px;display:block;line-height:1.5">"${escHtml(debrief)}"</em>` : ''}`;
  }

  // Reset chip selections
  document.querySelectorAll('.fcp-chip').forEach(c => c.classList.remove('active'));
  const noteInput = document.getElementById('fcp-output-note');
  if (noteInput) { noteInput.style.display = 'none'; noteInput.value = ''; }

  // Show calendar row only for signed-in users with Google
  const calRow = document.getElementById('fcp-cal-row');
  if (calRow) calRow.style.display = FS_USER ? 'block' : 'none';

  // Wire calendar buttons fresh each time
  const yesBtn = document.getElementById('fcp-yes');
  const noBtn  = document.getElementById('fcp-no');
  if (yesBtn) {
    const yes = yesBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(yes, yesBtn);
    yes.addEventListener('click', () => _addSessionToCalendar(durationMin, startISO));
  }
  if (noBtn) {
    const no = noBtn.cloneNode(true);
    noBtn.parentNode.replaceChild(no, noBtn);
    no.addEventListener('click', () => { document.getElementById('fcp-cal-row').style.display = 'none'; });
  }

  prompt.style.display = 'block';
  // Auto-dismiss after 20s if untouched
  setTimeout(() => {
    if (prompt.style.display !== 'none' && !_fcpSession.outputType) prompt.style.display = 'none';
  }, 20000);
}

function selectOutputType(type) {
  _fcpSession.outputType = type;
  document.querySelectorAll('.fcp-chip').forEach(c => c.classList.toggle('active', c.dataset.type === type));
  const noteInput = document.getElementById('fcp-output-note');
  if (noteInput) { noteInput.style.display = 'block'; noteInput.focus(); }
}

function closeFocusPrompt() {
  const prompt = document.getElementById('focus-cal-prompt');
  if (prompt) prompt.style.display = 'none';
}

function saveFocusSession() {
  const btn = document.getElementById('fcp-save-btn');
  const note = document.getElementById('fcp-output-note')?.value?.trim() || null;
  const { durationMin, outputType } = _fcpSession;

  // Save to D1 if signed in
  if (FS_USER) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    fetch('/api/session/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        durationMins: durationMin,
        focusScore: state.timer._lastFlowScore || null,
        outputType: outputType || null,
        outputNote: note,
      })
    }).then(r => r.json()).then(d => {
      if (d.ok) {
        markSessionToday(); // P1A: mark for streak reminder
        if (outputType) notify(`✅ ${durationMin}m session saved${outputType ? ' · ' + outputType : ''}`, 'success');
        else notify(`✅ ${durationMin}m session saved`, 'success');
        // P1B: show share prompt after a moment
        setTimeout(() => _showPostSessionShareNudge(durationMin, outputType), 800);
      }
    }).catch(() => {}).finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'Save →'; }
      closeFocusPrompt();
    });
  } else {
    // Guest — save to localStorage
    const history = JSON.parse(localStorage.getItem('fs_session_history') || '[]');
    history.unshift({ date: new Date().toISOString().slice(0,10), durationMins: durationMin, outputType, outputNote: note });
    localStorage.setItem('fs_session_history', JSON.stringify(history.slice(0, 100)));
    markSessionToday(); // P1A: mark for streak reminder
    if (outputType) notify(`✅ ${durationMin}m logged locally · ${outputType}`, 'info');
    // P1B: share nudge for guests too
    setTimeout(() => _showPostSessionShareNudge(durationMin, outputType), 800);
    closeFocusPrompt();
  }
}

// P1B: Show a small non-intrusive share nudge after saving
function _showPostSessionShareNudge(durationMin, outputType) {
  // Only show occasionally — not every single session
  const key = 'fs_last_share_nudge';
  const last = parseInt(localStorage.getItem(key) || '0');
  const now = Date.now();
  if (now - last < 3 * 24 * 3600 * 1000) return; // Max once every 3 days
  localStorage.setItem(key, String(now));

  // Show as a subtle toast-style notification, not a modal
  const existing = document.getElementById('share-nudge-bar');
  if (existing) existing.remove();
  const bar = document.createElement('div');
  bar.id = 'share-nudge-bar';
  bar.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a0533;border:1px solid rgba(168,85,247,.4);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:10px;z-index:2000;box-shadow:0 8px 30px rgba(0,0,0,.5);animation:slideR .3s ease;max-width:320px;width:90%';
  bar.innerHTML = `
    <span style="font-size:20px">🚀</span>
    <div style="flex:1;font-size:12px">
      <strong>Nice work!</strong> Share your ${durationMin}m session?
    </div>
    <button onclick="shareFlowSession(${durationMin})" style="background:var(--grad);border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">Share</button>
    <button onclick="document.getElementById('share-nudge-bar').remove()" style="background:none;border:none;color:#555;font-size:16px;cursor:pointer;padding:0 4px">✕</button>`;
  document.body.appendChild(bar);
  setTimeout(() => bar?.remove(), 10000); // Auto-dismiss after 10s
}

function _addSessionToCalendar(durationMin, startISO) {
  const endISO = new Date().toISOString();
  const calRow = document.getElementById('fcp-cal-row');
  fetch('/api/calendar/block', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      title: `🍅 Focus Session — FlowState`,
      start: startISO || new Date(Date.now() - durationMin * 60 * 1000).toISOString(),
      end:   endISO,
    })
  }).then(r => r.json()).then(d => {
    if (d.ok || d.event?.id) {
      notify('📅 Added to Google Calendar!', 'success');
      if (calRow) calRow.style.display = 'none';
      loadCalEvents();
    } else {
      notify('Could not add to calendar — reconnect Google', 'error');
    }
  }).catch(() => notify('Network error', 'error'));
}

// ══════════════════════════════════════════════════════════════════
// PILLAR 3a — Weekly Review (hybrid: D1 for signed-in, localStorage for guests)
// ══════════════════════════════════════════════════════════════════

function _computeLocalWeeklyReview() {
  // Pull sessions from localStorage
  const history = JSON.parse(localStorage.getItem('fs_session_history') || '[]');
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const weekStart = weekAgo.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const weekEnd   = now.toLocaleDateString('en-US',{month:'short',day:'numeric'});

  // Include current-session data from state too
  const liveFocusMin = Math.round((state.timer?.totalFocusSec || 0) / 60);
  const liveSessions = state.timer?.sessions || 0;
  const liveStreak   = state.timer?.streak   || 0;

  // Filter to this week
  const thisWeek = history.filter(s => {
    try { return new Date(s.date || s.created_at) >= weekAgo; } catch { return false; }
  });

  const storedFocusMin = thisWeek.reduce((t, s) => t + (s.durationMins || 0), 0);
  const focusMin  = storedFocusMin + liveFocusMin;
  const sessions  = thisWeek.length + liveSessions;
  const streak    = liveStreak || (thisWeek.length > 0 ? Math.min(thisWeek.length, 7) : 0);

  // FlowScore formula matching backend
  const sessionScore = Math.min(sessions * 8, 40);
  const timeScore    = Math.min(focusMin / 3, 30);
  const streakScore  = Math.min(streak * 5, 20);
  const flowScore    = Math.min(100, Math.round(sessionScore + timeScore + streakScore + 10));

  // Output breakdown
  const outputCounts = {};
  thisWeek.forEach(s => { if (s.outputType) outputCounts[s.outputType] = (outputCounts[s.outputType] || 0) + 1; });
  const topOutput = Object.entries(outputCounts).sort((a,b) => b[1]-a[1])[0]?.[0];

  // Generate wins and improvements
  const wins = [];
  const improve = [];
  if (sessions >= 5) wins.push(`${sessions} focus sessions completed this week`);
  else if (sessions > 0) wins.push(`${sessions} focus session${sessions > 1 ? 's' : ''} completed — building momentum`);
  if (focusMin >= 120) wins.push(`${focusMin}m of deep work — strong output`);
  if (streak >= 3) wins.push(`${streak}-day streak — consistency is building`);
  if (topOutput) wins.push(`Most productive output: ${topOutput}`);
  if (sessions === 0) improve.push('Start your first focus session to begin tracking your FlowScore');
  else if (sessions < 5) improve.push(`Aim for ${5 - sessions} more sessions to hit your weekly goal`);
  if (focusMin < 90) improve.push('Try to hit 90 minutes of deep work this week');
  if (streak < 3) improve.push('Build a 3-day streak for a consistency boost');
  if (!topOutput && sessions > 0) improve.push('Log what you produce after each session for better insights');

  return {
    week: `${weekStart} – ${weekEnd}`,
    flowScore: flowScore || 10,
    focusMin,
    sessions,
    streak,
    meetingCount: 0,
    wins: wins.length ? wins : ['Keep going — your wins are coming!'],
    improve: improve.length ? improve : ['You\'re doing great — keep the momentum!'],
    isLocal: true,
  };
}

function _renderWeeklyReview(d) {
  const card = document.getElementById('weekly-review-card');
  if (!card) return;
  card.style.display = 'block';
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('wr-dates', d.week);
  setEl('wr-score-num', d.flowScore);
  setEl('wr-focus-min', d.focusMin + 'm');
  setEl('wr-sessions', d.sessions);
  setEl('wr-streak', d.streak + '🔥');
  setEl('wr-meetings', d.meetingCount !== undefined ? d.meetingCount : '—');
  const ring = document.getElementById('wr-ring');
  if (ring) { const c = 163.4; ring.style.strokeDashoffset = c - (d.flowScore / 100) * c; }
  const winsEl = document.getElementById('wr-wins');
  if (winsEl) winsEl.innerHTML = (d.wins || []).map(w => `<div class="wr-item">✓ ${escHtml(String(w))}</div>`).join('') || '<div class="wr-item" style="color:#555">Keep going — your wins are coming!</div>';
  const impEl = document.getElementById('wr-improve');
  if (impEl) impEl.innerHTML = (d.improve || []).map(i => `<div class="wr-item">→ ${escHtml(String(i))}</div>`).join('') || '<div class="wr-item" style="color:#555">Looking great this week!</div>';
  // Local badge
  if (d.isLocal) {
    const badge = document.getElementById('wr-local-badge');
    if (badge) badge.style.display = 'flex';
  }
  // Show "Send recap" button only for signed-in users who have sessions
  const sendBtn = document.getElementById('wr-send-email-btn');
  if (sendBtn) {
    sendBtn.style.display = FS_USER && (d.sessions > 0 || d.focusMin > 0) ? 'block' : 'none';
  }
}

function loadWeeklyReview() {
  const card = document.getElementById('weekly-review-card');
  if (!card) return;

  // Non-Google users: compute locally from localStorage + live state
  if (!FS_USER) {
    _renderWeeklyReview(_computeLocalWeeklyReview());
    return;
  }

  const params = new URLSearchParams({
    focusMin: Math.round((state.timer?.totalFocusSec || 0) / 60),
    sessions: state.timer?.sessions || 0,
    streak:   state.timer?.streak   || 0,
  });
  fetch(`/api/weekly-review?${params}`, { credentials: 'include' })
    .then(r => r.json())
    .then(d => {
      if (d.error) { _renderWeeklyReview(_computeLocalWeeklyReview()); return; }
      _renderWeeklyReview(d);
    })
    .catch(() => _renderWeeklyReview(_computeLocalWeeklyReview()));
}

// ══════════════════════════════════════════════════════════════════
// PILLAR 3b — Browser Notifications
// ══════════════════════════════════════════════════════════════════
// ── Weekly email digest ───────────────────────────────────────────────────
async function sendWeeklyDigest(btn) {
  if (!FS_USER) { openAuthPopup('/api/auth/google'); return; }
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Sending…';
  try {
    const r = await fetch('/api/email/weekly-digest', { method:'POST', credentials:'include' });
    const d = await r.json();
    if (d.error === 'not_authenticated') { openAuthPopup('/api/auth/google'); btn.disabled=false; btn.innerHTML=orig; return; }
    if (d.error === 'email_not_configured') {
      notify('Email not configured — contact support', 'error');
    } else if (d.ok) {
      btn.innerHTML = '<i class="fas fa-check" style="margin-right:6px"></i>Sent! Check your inbox';
      btn.style.background = 'linear-gradient(135deg,rgba(16,185,129,.2),rgba(16,185,129,.1))';
      btn.style.borderColor = 'rgba(16,185,129,.4)';
      btn.style.color = '#10b981';
      setTimeout(() => { btn.disabled=false; btn.innerHTML=orig; btn.style.cssText=''; }, 5000);
      return;
    } else {
      notify('Could not send email — try again later', 'error');
    }
  } catch(e) { notify('Network error — try again', 'error'); }
  btn.disabled = false;
  btn.innerHTML = orig;
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') scheduleStreakReminder();
    });
  } else if ('Notification' in window && Notification.permission === 'granted') {
    scheduleStreakReminder();
  }
}

function sendNotification(title, body, icon) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: icon || '/static/favicon.svg' });
  }
}

// ── P1A: Daily Streak Reminder ────────────────────────────────────────────────
// Schedules a local notification for 9am tomorrow if user has a streak
function scheduleStreakReminder() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const streak = state.timer.streak || 0;
  if (streak === 0) return; // Only remind if they have an active streak

  // Calculate ms until 9am tomorrow
  const now = new Date();
  const tomorrow9am = new Date(now);
  tomorrow9am.setDate(tomorrow9am.getDate() + 1);
  tomorrow9am.setHours(9, 0, 0, 0);
  const msUntil = tomorrow9am - now;

  // Clear any existing reminder timer
  if (window._streakReminderTimer) clearTimeout(window._streakReminderTimer);

  window._streakReminderTimer = setTimeout(() => {
    const currentStreak = state.timer.streak || 0;
    const todayKey = `fs_session_today_${new Date().toISOString().slice(0,10)}`;
    const hasSessionToday = localStorage.getItem(todayKey);
    if (!hasSessionToday && currentStreak > 0) {
      sendNotification(
        `⚡ Keep your ${currentStreak}-day streak alive!`,
        `You haven't focused yet today. Open FlowState and lock in. 🔥`,
        '/static/icon-192.png'
      );
    }
    // Reschedule for next day
    scheduleStreakReminder();
  }, msUntil);

  // Persist the reminder intent so SW can fire it if tab is closed
  localStorage.setItem('fs_streak_reminder', JSON.stringify({
    streak,
    scheduledFor: tomorrow9am.toISOString(),
  }));
}

// Mark today as having a session (called after saveFocusSession)
function markSessionToday() {
  const todayKey = `fs_session_today_${new Date().toISOString().slice(0,10)}`;
  localStorage.setItem(todayKey, '1');
}

// ── P1B: Session Share Card ───────────────────────────────────────────────────
function shareFlowSession(durationMin, flowScore, outputType) {
  const score = flowScore || state.timer._lastFlowScore || 0;
  const output = outputType || _fcpSession?.outputType || '';
  const streak = state.timer.streak || 0;
  const name   = FS_USER?.name?.split(' ')[0] || 'Someone';
  const scoreColor = score >= 70 ? '#10b981' : score >= 40 ? '#a855f7' : '#f59e0b';

  const tweetText = `Just locked in a ${durationMin}m deep work session on @flowst8cc 🔥\n\nFlowScore: ${score}/100${output ? '\nOutput: ' + output : ''}${streak >= 3 ? '\n' + streak + '-day streak 🔥' : ''}\n\nBuild in flow 👇\nhttps://flowst8.cc`;

  const shareOptions = [
    { icon:'fa-twitter', label:'Share on X', color:'#1DA1F2',
      fn: () => window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`, '_blank') },
    { icon:'fa-linkedin', label:'LinkedIn', color:'#0077B5',
      fn: () => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://flowst8.cc')}&summary=${encodeURIComponent(tweetText)}`, '_blank') },
    { icon:'fa-copy', label:'Copy Text', color:'var(--accent)',
      fn: () => navigator.clipboard.writeText(tweetText).then(() => notify('📋 Copied to clipboard!', 'success')) },
  ];

  // If user has a public profile, add profile link option
  const profileSlug = localStorage.getItem('fs_profile_slug');
  if (profileSlug) {
    shareOptions.unshift({
      icon: 'fa-globe', label: 'My Profile', color: '#10b981',
      fn: () => window.open(`/u/${profileSlug}`, '_blank'),
    });
  }

  openModal(`
    <div style="text-align:center;padding:4px 0">
      <!-- FlowScore card preview -->
      <div style="background:linear-gradient(135deg,#12102a,#1a0533);border:1px solid rgba(168,85,247,.3);border-radius:16px;padding:20px;margin-bottom:16px">
        <div style="font-size:11px;font-weight:800;color:#a855f7;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px">⚡ FLOWSTATE</div>
        <div style="display:flex;justify-content:center;gap:16px;margin-bottom:14px">
          <div style="text-align:center">
            <div style="font-size:36px;font-weight:900;color:${scoreColor};line-height:1">${score}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-top:2px">FlowScore</div>
          </div>
          <div style="width:1px;background:rgba(255,255,255,.08)"></div>
          <div style="text-align:center">
            <div style="font-size:36px;font-weight:900;color:#ec4899;line-height:1">${durationMin}m</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-top:2px">Focus Time</div>
          </div>
          ${streak >= 2 ? `<div style="width:1px;background:rgba(255,255,255,.08)"></div>
          <div style="text-align:center">
            <div style="font-size:36px;font-weight:900;color:#f59e0b;line-height:1">${streak}🔥</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.8px;margin-top:2px">Day Streak</div>
          </div>` : ''}
        </div>
        ${output ? `<div style="font-size:12px;color:#888;border-top:1px solid rgba(255,255,255,.06);padding-top:10px">Shipped: <strong style="color:#c084fc">${output}</strong></div>` : ''}
        <div style="font-size:10px;color:#444;margin-top:8px">flowst8.cc</div>
      </div>
      <h3 style="margin:0 0 6px;font-size:16px">Share your session 🚀</h3>
      <p style="color:var(--text-s);font-size:12px;margin-bottom:14px">Let people know you're building in flow</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${shareOptions.map(o => `<button class="btn-sm" onclick="(${o.fn.toString()})()" style="justify-content:center;gap:8px;color:${o.color};border-color:${o.color}20;background:${o.color}10;padding:10px"><i class="fab ${o.icon}"></i> ${o.label}</button>`).join('')}
      </div>
    </div>`);
}

// ── P2A: 80% Token Upgrade Modal ──────────────────────────────────────────────
let _upgradeModal80Shown = false;
function checkTokenUpgradeTrigger(used, limit) {
  if (_upgradeModal80Shown) return;
  const pct = used / limit;
  if (pct >= 0.8 && pct < 1.0) {
    _upgradeModal80Shown = true;
    const left = limit - used;
    // Show after a 2s delay so it doesn't interrupt what they're doing
    setTimeout(() => {
      openModal(`
        <div style="text-align:center;padding:8px 0">
          <div style="font-size:42px;margin-bottom:10px">🔥</div>
          <h2 style="margin:0 0 6px;font-size:18px">You're on a roll!</h2>
          <p style="color:var(--text-s);font-size:13px;margin-bottom:16px">
            You've used <strong style="color:#f59e0b">${used.toLocaleString()} / ${limit.toLocaleString()} tokens</strong> today.<br>
            Only <strong style="color:#ef4444">${left.toLocaleString()} left</strong> — don't let momentum stop.
          </p>
          <div style="background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.2);border-radius:12px;padding:14px;margin-bottom:16px;text-align:left">
            <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">PRO unlocks</div>
            <div style="display:flex;flex-direction:column;gap:7px;font-size:13px">
              <div>⚡ <strong>100,000 tokens/day</strong> — 66× more</div>
              <div>🤖 <strong>All AI models</strong> — GPT-4o, Claude, Gemini</div>
              <div>📊 <strong>Full FlowScore history</strong> — unlimited sessions</div>
              <div>🎵 <strong>AI Music + Video generation</strong> — unlimited</div>
              <div>🎁 <strong>Priority support</strong> + early features</div>
            </div>
          </div>
          <button class="btn-primary" onclick="closeModal();openPricingModal()" style="width:100%;padding:13px;font-size:15px;margin-bottom:8px">
            🚀 Upgrade to Pro — $18/mo
          </button>
          <button class="btn-sm" onclick="closeModal()" style="width:100%;justify-content:center;color:#666">
            Continue on free tier
          </button>
          <div style="font-size:10px;color:#444;margin-top:10px">Cancel anytime · Instant access · 7-day free trial</div>
        </div>`);
    }, 2000);
  }
}

// ── P2B: Team FlowScore Leaderboard ──────────────────────────────────────────
async function loadTeamLeaderboard(el) {
  if (!FS_USER) {
    el.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-s)">
      <div style="font-size:32px;margin-bottom:10px">🏆</div>
      <div style="font-weight:700;margin-bottom:6px">Team FlowScore Leaderboard</div>
      <div style="font-size:12px;margin-bottom:14px">Sign in to see your team's focus rankings</div>
      <button class="btn-primary" onclick="openAuthPopup('/api/auth/google')"><i class="fab fa-google"></i> Sign in</button>
    </div>`;
    return;
  }
  el.innerHTML = `<div style="text-align:center;padding:20px"><i class="fas fa-spinner fa-spin" style="color:var(--accent);font-size:20px"></i></div>`;
  try {
    const r = await fetch('/api/team/leaderboard', { credentials: 'include' });
    const d = await r.json();
    if (d.error || !d.members?.length) {
      renderTeamLeaderboardEmpty(el);
      return;
    }
    renderTeamLeaderboardFull(el, d.members, d.period);
  } catch(_) {
    renderTeamLeaderboardEmpty(el);
  }
}

function renderTeamLeaderboardEmpty(el) {
  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid rgba(168,85,247,.2);border-radius:14px;padding:20px;margin-bottom:14px">
      <div style="text-align:center;padding:12px 0">
        <div style="font-size:36px;margin-bottom:10px">🏆</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:6px">Team FlowScore Board</div>
        <div style="font-size:12px;color:var(--text-s);margin-bottom:16px">Invite your team to compete on focus streaks and FlowScore rankings</div>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="btn-primary" onclick="closeModal();openInviteModal()" style="gap:6px"><i class="fas fa-user-plus"></i> Invite Team</button>
          <button class="btn-sm" onclick="openProfileModal()" style="gap:6px"><i class="fas fa-globe"></i> My Profile</button>
        </div>
      </div>
      <!-- Preview leaderboard with demo data -->
      <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
        <div style="font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Preview</div>
        ${[
          {rank:1, av:'👑', name:'You (invite to track)', score:87, streak:9, mins:240, medal:'🥇'},
          {rank:2, av:'🔥', name:'Teammate A', score:74, streak:5, mins:180, medal:'🥈'},
          {rank:3, av:'⚡', name:'Teammate B', score:61, streak:3, mins:120, medal:'🥉'},
        ].map(m => renderLeaderboardRow(m, true)).join('')}
      </div>
    </div>`;
}

function renderTeamLeaderboardFull(el, members, period) {
  const sorted = [...members].sort((a,b) => b.flowScore - a.flowScore);
  const medals = ['🥇','🥈','🥉'];
  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid rgba(168,85,247,.2);border-radius:14px;overflow:hidden;margin-bottom:14px">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:14px;font-weight:800">🏆 FlowScore Board</div>
        <div style="font-size:11px;color:#666">${period || 'This week'}</div>
      </div>
      <div style="padding:10px 0">
        ${sorted.map((m,i) => renderLeaderboardRow({
          rank: i+1,
          av: m.avatar || String(m.name||'?')[0].toUpperCase(),
          name: m.name, score: m.flowScore, streak: m.streak,
          mins: m.focusMin, medal: medals[i] || `#${i+1}`,
          isMe: m.email === FS_USER?.email,
        }, false)).join('')}
      </div>
      <div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;gap:8px">
        <button class="btn-sm" onclick="openInviteModal()" style="gap:6px;flex:1;justify-content:center"><i class="fas fa-user-plus"></i> Invite more</button>
        <button class="btn-sm" onclick="shareTeamLeaderboard()" style="gap:6px;flex:1;justify-content:center"><i class="fas fa-share"></i> Share board</button>
      </div>
    </div>`;
}

function renderLeaderboardRow(m, isPreview) {
  const scoreColor = m.score >= 70 ? '#10b981' : m.score >= 40 ? '#a855f7' : '#f59e0b';
  // av can be a photo URL, an emoji, or a single initial letter — render accordingly
  const isUrl = typeof m.av === 'string' && (m.av.startsWith('http') || m.av.startsWith('/'));
  const avatarInner = isUrl
    ? `<img src="${m.av}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;display:block" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <span style="display:none;width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;position:absolute;top:0;left:0">${String(m.name||'?')[0].toUpperCase()}</span>`
    : m.av;
  const avatarWrap = isUrl
    ? `position:relative;width:32px;height:32px;border-radius:50%;overflow:hidden;flex-shrink:0`
    : `width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0`;
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;${m.isMe ? 'background:rgba(168,85,247,.06);border-left:3px solid var(--accent)' : ''}${isPreview ? 'opacity:.6' : ''}">
      <div style="font-size:16px;width:24px;text-align:center;flex-shrink:0">${m.medal}</div>
      <div style="${avatarWrap}">${avatarInner}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.name}${m.isMe ? ' <span style="font-size:10px;color:var(--accent)">(you)</span>' : ''}</div>
        <div style="font-size:11px;color:#666">${m.mins || 0}m focus · ${m.streak || 0}🔥 streak</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:18px;font-weight:900;color:${scoreColor}">${m.score}</div>
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.5px">FlowScore</div>
      </div>
    </div>`;
}

async function shareTeamLeaderboard() {
  const text = `Our team's FlowScore board on FlowState 🏆\nWho's locking in the most focus time?\nhttps://flowst8.cc`;
  if (navigator.share) {
    await navigator.share({ title: 'FlowState Team Board', text, url: 'https://flowst8.cc' }).catch(()=>{});
  } else {
    navigator.clipboard.writeText(text).then(() => notify('📋 Copied!', 'success'));
  }
}

// ══════════════════════════════════════════════════════════════════
// PILLAR 3c — Keyboard Shortcuts
// ══════════════════════════════════════════════════════════════════
const TAB_SHORTCUTS = { '1':'focus','2':'chat','3':'calendar','4':'metrics','5':'board','6':'team','7':'learn','8':'restore','9':'generate','c':'calendar','f':'focus','m':'metrics' };

function initKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    // Don't fire when typing in inputs/textareas
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    const key = e.key.toLowerCase();

    // Show shortcuts help
    if (key === '?') {
      const ov = document.getElementById('kb-overlay');
      if (ov) ov.style.display = ov.style.display === 'flex' ? 'none' : 'flex';
      return;
    }
    // Close overlays
    if (e.key === 'Escape') {
      document.getElementById('kb-overlay')?.style && (document.getElementById('kb-overlay').style.display = 'none');
      document.getElementById('focus-cal-prompt')?.style && (document.getElementById('focus-cal-prompt').style.display = 'none');
      calClosePanel();
      return;
    }
    // Timer controls (focus tab only)
    if (key === ' ' && document.getElementById('tab-pane-focus')?.style.display !== 'none') {
      e.preventDefault();
      toggleTimer();
      return;
    }
    if (key === 'r' && document.getElementById('tab-pane-focus')?.style.display !== 'none') { resetTimer(); return; }
    if (key === 's' && document.getElementById('tab-pane-focus')?.style.display !== 'none') { skipPhase(); return; }
    // New calendar event (calendar tab)
    if (key === 'n' && document.getElementById('tab-pane-calendar')?.style.display !== 'none') {
      calShowAddForm();
      return;
    }
    // Tab switching
    if (TAB_SHORTCUTS[key]) { switchTab(TAB_SHORTCUTS[key]); return; }
  });
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
  // Prefer D1 history for signed-in users, fall back to local state
  const d1 = _d1History;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const todaySessionsLocal = state.timer.sessions;
  const todayMinsLocal     = Math.round(state.timer.totalFocusSec / 60);

  // If D1 loaded, use its richer data; supplement with today's live data
  const totalSessions = d1 ? Math.max(d1.totalSessions, todaySessionsLocal) : todaySessionsLocal;
  const streak        = d1 ? Math.max(d1.streak, state.timer.streak) : (state.timer.streak || 0);
  const avgScore      = d1?.avgFlowScore || 0;
  const gratitude     = parseInt(localStorage.getItem('gratitude_count') || '0');
  const learnCards    = state.learn.cards.length || 0;

  // Today's focus mins: max of D1 today entry and live state
  const d1TodayMins = d1?.perDay ? Object.entries(d1.perDay).filter(([k]) => k === todayStr).reduce((s, [, v]) => s + v * 25, 0) : 0;
  const focusMin = Math.max(todayMinsLocal, d1TodayMins);

  const completionRate = totalSessions ? Math.min(100, Math.round((totalSessions / Math.max(totalSessions, 4)) * 100)) : 0;

  const cards = [
    { icon:'🎯', val: todaySessionsLocal || (d1?.perDay?.[todayStr] || 0), lbl:'Sessions Today', trend: d1 ? `${totalSessions} total (30d)` : 'today only' },
    { icon:'⏱', val: focusMin+'m', lbl:'Focus Today', trend: d1 ? `${d1.totalMins}m all time (30d)` : `${Math.round(focusMin/60*10)/10}h` },
    { icon:'🔥', val: streak, lbl:'Day Streak', trend: streak >= 7 ? '🏆 7-day streak!' : streak >= 3 ? '💪 building momentum' : 'Keep it up!' },
    { icon:'⚡', val: avgScore || '—', lbl:'Avg FlowScore', trend: d1 ? 'last 30 days' : 'complete sessions to track' },
    { icon:'🙏', val: gratitude, lbl:'Gratitude Entries', trend:'Daily practice' },
    { icon:'📚', val: learnCards, lbl:'Cards Learned', trend:'Spaced repetition' },
  ];

  document.getElementById('metrics-grid').innerHTML = cards.map(c=>`<div class="m-card"><div class="m-icon">${c.icon}</div><div class="m-val">${escHtml(String(c.val))}</div><div class="m-lbl">${c.lbl}</div><div class="m-trend">${c.trend}</div></div>`).join('');

  // Build chart — use D1 perDay if available, else localStorage
  const weekData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const d1Val = d1?.perDay?.[key] || 0;
    const lsVal = parseInt(localStorage.getItem('sessions_' + key) || '0');
    weekData.push(Math.max(d1Val, lsVal));
  }
  // Save today's count for chart continuity
  localStorage.setItem('sessions_' + todayStr, String(todaySessionsLocal));

  const ctx = document.getElementById('focus-chart')?.getContext('2d');
  if (!ctx) return;
  if (focusChartInstance) focusChartInstance.destroy();

  const hasData = weekData.some(v => v > 0);
  const sampleData = [2, 4, 3, 5, 2, 6, 3];
  const chartData = hasData ? weekData : sampleData;
  const isDemoChart = !hasData;

  const chartTitle = document.querySelector('.chart-title');
  if (chartTitle) {
    chartTitle.innerHTML = `<i class="fas fa-chart-bar" style="color:var(--accent)"></i> Focus Sessions This Week${isDemoChart ? ' <span style="font-size:10px;color:var(--text-m);font-weight:400;background:rgba(168,85,247,.12);padding:2px 7px;border-radius:10px;margin-left:4px">sample data</span>' : (d1 ? ' <span style="font-size:10px;color:#10b981;font-weight:400;background:rgba(16,185,129,.1);padding:2px 7px;border-radius:10px;margin-left:4px">live from D1</span>' : '')}`;
  }

  focusChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Array.from({length:7}, (_, i) => { const d = new Date(today); d.setDate(d.getDate()-(6-i)); return d.toLocaleDateString('en-US',{weekday:'short'}); }),
      datasets: [{ data: chartData, backgroundColor: isDemoChart ? 'rgba(168,85,247,.25)' : 'rgba(168,85,247,.65)', borderColor:'#a855f7', borderWidth:2, borderRadius:8 }]
    },
    options: { plugins:{legend:{display:false}}, scales:{ y:{beginAtZero:true,ticks:{color:'#888',stepSize:1,precision:0},grid:{color:'rgba(168,85,247,.07)'}}, x:{ticks:{color:'#888'},grid:{display:false}} }, animation:{duration:600} }
  });

  // Output breakdown (D1 only)
  _renderOutputBreakdown();
  // Session journal (D1 only)
  _renderSessionJournal();
  loadBehaviorInsight();
}

function _renderOutputBreakdown() {
  const d1 = _d1History;
  let el = document.getElementById('output-breakdown-wrap');
  if (!el) {
    // Inject after chart if not present
    const chartWrap = document.querySelector('.chart-wrap');
    if (!chartWrap) return;
    el = document.createElement('div');
    el.id = 'output-breakdown-wrap';
    chartWrap.after(el);
  }
  if (!d1?.outputBreakdown || !Object.keys(d1.outputBreakdown).length) {
    el.innerHTML = '';
    return;
  }
  const items = Object.entries(d1.outputBreakdown).sort((a,b)=>b[1]-a[1]);
  const ICONS = { Writing:'✍️', Code:'💻', Design:'🎨', Reading:'📚', Planning:'📋', Meeting:'💬', Other:'🔘' };
  el.innerHTML = `
    <div style="margin-top:16px">
      <div class="chart-title" style="margin-bottom:10px"><i class="fas fa-trophy" style="color:var(--accent)"></i> Output Breakdown <span style="font-size:10px;color:#10b981;font-weight:400;background:rgba(16,185,129,.1);padding:2px 7px;border-radius:10px;margin-left:4px">30 days</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${items.map(([type, count]) => `<div style="display:flex;align-items:center;gap:6px;background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;padding:7px 12px;font-size:12px">
          <span>${ICONS[type]||'🔘'}</span>
          <span style="color:var(--text-p);font-weight:600">${type}</span>
          <span style="color:var(--accent);font-weight:800">${count}</span>
        </div>`).join('')}
      </div>
      ${d1.recentOutputs?.length ? `<div style="margin-top:12px;font-size:11px;color:#666">
        ${d1.recentOutputs.slice(0,3).map(o=>`<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)">
          <span style="color:#888">${o.date}</span> · <span style="color:var(--text-s)">${ICONS[o.type]||''} ${o.type}</span>${o.note ? ` · <em style="color:#666">${escHtml(o.note)}</em>` : ''} <span style="color:#555">(${o.mins}m)</span>
        </div>`).join('')}
      </div>` : ''}
    </div>`;
}

// ── Session Journal (Phase 4) — renders the last 30 sessions as a log ──────
function _renderSessionJournal() {
  const d1 = _d1History;
  // Find or create the journal container
  let el = document.getElementById('session-journal-wrap');
  if (!el) {
    const breakdown = document.getElementById('output-breakdown-wrap');
    const chartWrap = document.querySelector('.chart-wrap');
    const anchor = breakdown || chartWrap;
    if (!anchor) return;
    el = document.createElement('div');
    el.id = 'session-journal-wrap';
    anchor.after(el);
  }

  if (!d1 || !d1.sessions || d1.sessions.length === 0) {
    el.innerHTML = `
      <div style="margin-top:20px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:20px;text-align:center">
        <div style="font-size:28px;margin-bottom:6px">📓</div>
        <div style="font-size:13px;font-weight:700;color:var(--text-p);margin-bottom:4px">Focus Journal</div>
        <div style="font-size:12px;color:var(--text-s)">Complete a focus session to see your journal. Each session logs your FlowScore, duration, and output type.</div>
      </div>`;
    return;
  }

  const sessions = d1.sessions.slice(0, 30); // cap at 30
  const MOOD_ICONS = { Writing:'✍️', Code:'💻', Design:'🎨', Reading:'📚', Planning:'📋', Meeting:'💬', Other:'🔘', Music:'🎵', Research:'🔬' };
  const scoreColor = s => s >= 80 ? '#10b981' : s >= 55 ? '#f59e0b' : '#ef4444';
  const scoreLabel = s => s >= 80 ? 'Deep' : s >= 55 ? 'Solid' : 'Light';

  // Group by date
  const byDate = {};
  sessions.forEach(s => {
    const d = s.session_date || s.date || '—';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(s);
  });

  const todayStr = new Date().toISOString().slice(0,10);
  const yesterdayStr = new Date(Date.now()-86400000).toISOString().slice(0,10);
  const fmtDate = d => d === todayStr ? 'Today' : d === yesterdayStr ? 'Yesterday' : new Date(d+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});

  let journalHTML = `
    <div style="margin-top:20px">
      <div class="chart-title" style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
        <span><i class="fas fa-book-open" style="color:var(--accent)"></i> Focus Journal
          <span style="font-size:10px;color:#10b981;font-weight:400;background:rgba(16,185,129,.1);padding:2px 7px;border-radius:10px;margin-left:6px">last 30 sessions</span>
        </span>
        <button onclick="_exportSessionJournal()" style="font-size:10px;font-weight:700;padding:3px 9px;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.2);border-radius:6px;color:var(--accent);cursor:pointer">↓ Export</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">`;

  Object.entries(byDate).forEach(([date, daySessions]) => {
    const dayMins = daySessions.reduce((s,r) => s+(r.duration_mins||0), 0);
    journalHTML += `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-m)">${fmtDate(date)}</div>
          <div style="font-size:11px;color:var(--text-s)">${dayMins}m · ${daySessions.length} session${daySessions.length!==1?'s':''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">`;
    daySessions.forEach(sess => {
      const score = sess.focus_score || 0;
      const type  = sess.output_type || 'Other';
      const note  = sess.output_note || '';
      const mins  = sess.duration_mins || 0;
      const time  = sess.created_at ? new Date(sess.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '';
      journalHTML += `
        <div style="display:flex;align-items:center;gap:10px;background:var(--bg-panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
          <div style="flex-shrink:0;width:36px;height:36px;border-radius:8px;background:${score>=80?'rgba(16,185,129,.15)':score>=55?'rgba(245,158,11,.12)':'rgba(239,68,68,.1)'};border:1px solid ${scoreColor(score)}33;display:flex;align-items:center;justify-content:center;font-size:14px">${MOOD_ICONS[type]||'🔘'}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
              <span style="font-size:12px;font-weight:700;color:var(--text-p)">${type}</span>
              <span style="font-size:10px;padding:1px 6px;border-radius:4px;background:${score>=80?'rgba(16,185,129,.15)':score>=55?'rgba(245,158,11,.12)':'rgba(239,68,68,.1)'};color:${scoreColor(score)};font-weight:700">${scoreLabel(score)} ${score}</span>
              <span style="font-size:11px;color:var(--text-s)">${mins}m</span>
              ${time ? `<span style="font-size:10px;color:var(--text-s);margin-left:auto">${time}</span>` : ''}
            </div>
            ${note ? `<div style="font-size:11px;color:var(--text-s);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(note)}">💬 ${escHtml(note)}</div>` : ''}
          </div>
        </div>`;
    });
    journalHTML += `</div></div>`;
  });

  journalHTML += `</div></div>`;
  el.innerHTML = journalHTML;
}

function _exportSessionJournal() {
  const d1 = _d1History;
  if (!d1?.sessions?.length) { notify('No sessions to export', 'warning'); return; }
  const headers = ['Date','Time','Duration (mins)','FlowScore','Output Type','Note'];
  const rows = d1.sessions.map(s => [
    s.session_date || '',
    s.created_at ? new Date(s.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '',
    s.duration_mins || 0,
    s.focus_score || 0,
    s.output_type || '',
    (s.output_note || '').replace(/,/g,'；') // escape commas
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='flowstate-journal.csv'; a.click();
  URL.revokeObjectURL(url);
  notify('✅ Journal exported as CSV', 'success');
}

// ── Token wall, upgrade moment, model downgrade badge ─────────────────────
function showTokenWall(isPro) {
  const used = _tokenBalance?.dailyUsed || 0;
  const limit = _tokenBalance?.dailyLimit || (isPro ? 100000 : 1500);
  const tier = _tokenBalance?.tier || 'free';

  if (isPro) {
    openModal(`
      <div style="text-align:center;padding:8px 0">
        <div style="font-size:40px;margin-bottom:12px">📊</div>
        <h2 style="margin:0 0 8px">Daily Pro Limit Reached</h2>
        <p style="color:var(--text-s);font-size:13px;margin-bottom:20px">You've used your 100,000 daily tokens. Your quota resets at midnight UTC.</p>
        <div style="background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.2);border-radius:12px;padding:14px;margin-bottom:16px;font-size:13px">
          <div style="color:#888;margin-bottom:4px">Used today</div>
          <div style="font-size:22px;font-weight:800;color:var(--accent)">${used.toLocaleString()} <span style="font-size:13px;color:#888">/ ${limit.toLocaleString()}</span></div>
        </div>
        <button class="btn-primary" onclick="openTopupModal();closeModal()" style="width:100%;margin-bottom:8px">💰 Buy Token Pack — Never Expire</button>
        <button onclick="closeModal()" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;font-size:13px">Wait until midnight reset</button>
      </div>
    `);
    return;
  }

  // Free user — show the real upgrade comparison
  openModal(`
    <div style="text-align:center;padding:8px 0">
      <div style="font-size:40px;margin-bottom:12px">⚡</div>
      <h2 style="margin:0 0 6px">You've hit the free limit</h2>
      <p style="color:var(--text-s);font-size:13px;margin-bottom:18px">You used all <strong style="color:var(--accent)">1,500 free tokens</strong> today. Here's what you're missing:</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;text-align:left">
        <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:12px;padding:14px">
          <div style="font-size:11px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Free</div>
          <div style="font-size:12px;color:var(--text-s);line-height:2">1,500 tokens/day<br>GPT-4o mini only<br>No calendar sync<br>No image gen<br>Basic metrics</div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(168,85,247,.12),rgba(236,72,153,.08));border:1px solid rgba(168,85,247,.35);border-radius:12px;padding:14px;position:relative">
          <div style="position:absolute;top:-8px;right:10px;background:var(--grad);color:#fff;font-size:9px;font-weight:800;padding:2px 8px;border-radius:99px;letter-spacing:.5px">PRO</div>
          <div style="font-size:11px;color:var(--accent);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Pro — $18/mo</div>
          <div style="font-size:12px;color:var(--text-p);line-height:2"><strong>100,000</strong> tokens/day<br>GPT-5, Claude, Gemini, Grok<br>Google Calendar sync<br>Image + video gen<br>Advanced insights</div>
        </div>
      </div>
      <button class="btn-primary" onclick="closeModal();openPricingModal()" style="width:100%;margin-bottom:8px;padding:12px;font-size:14px">🚀 Upgrade to Pro — $18/mo</button>
      <button onclick="openTopupModal();closeModal()" style="width:100%;padding:9px;border-radius:8px;border:1px solid rgba(16,185,129,.4);background:rgba(16,185,129,.08);color:#10b981;cursor:pointer;font-size:13px;font-weight:600;margin-bottom:8px">💰 Buy Tokens (no subscription)</button>
      <button onclick="closeModal()" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-s);cursor:pointer;font-size:12px">Wait until tomorrow (resets midnight UTC)</button>
    </div>
  `);
}

function showTokenWarningBar(msg) {
  // Show a persistent (dismissable) bar above the chat input when near the limit
  let bar = document.getElementById('token-warn-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'token-warn-bar';
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:10px;font-size:12px;color:#f59e0b;margin-bottom:8px;cursor:pointer';
    bar.onclick = () => { bar.style.display='none'; };
    const chatPane = document.getElementById('tab-pane-chat');
    if (chatPane) chatPane.insertBefore(bar, chatPane.firstChild);
  }
  const left = msg.match(/(\d[\d,]+) tokens/)?.[1] || '?';
  bar.innerHTML = `<span>⚡ <strong>${left} tokens left today</strong> — ${msg} · <a href="#" onclick="event.stopPropagation();openPricingModal();return false" style="color:var(--accent);text-decoration:none;font-weight:700">Upgrade to Pro</a> for 100k/day</span><span style="opacity:.5;font-size:14px">✕</span>`;
  bar.style.display = 'flex';
}

function showModelDowngradeBadge() {
  const msgs = document.getElementById('chat-msgs');
  if (!msgs) return;
  const last = msgs.lastElementChild;
  if (!last) return;
  // Add a subtle "Free tier: running on GPT-4o mini" note to last AI message
  const tag = last.querySelector('.m-tag');
  if (tag && !tag.dataset.downgraded) {
    tag.dataset.downgraded = '1';
    tag.insertAdjacentHTML('afterend',
      '<span style="font-size:10px;color:#f59e0b;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:4px;padding:1px 6px;margin-left:4px;cursor:pointer" onclick="openPricingModal()" title="Upgrade to use your selected model">⬇ free tier · <u>upgrade</u></span>'
    );
  }
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
function connectNotion() {
  // If already connected, show status rather than re-authenticating
  if (window.FS_NOTION) { notify('Notion is already connected — ' + (window.FS_NOTION.workspace || 'workspace'), 'success'); return; }
  const popup = window.open('/api/auth/notion', '_blank', 'width=480,height=600,noopener=no');
  const timer = setInterval(function() {
    if (popup && popup.closed) {
      clearInterval(timer);
      setTimeout(_verifyNotionStatus, 800);
    }
  }, 1000);
}

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
    {id:'leaderboard', label:'🏆 Leaderboard', icon:'fa-trophy'},
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
    <div class="team-tabs" style="display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;margin-bottom:14px;padding-bottom:4px;scrollbar-width:none;-ms-overflow-style:none">
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
    b.classList.toggle('active', b.textContent.toLowerCase().includes(tabId==='leaderboard'?'leaderboard':tabId==='sprint'?'sprint':tabId==='pulse'?'pulse':tabId==='standups'?'standup':tabId==='burnout'?'burnout':tabId==='deadlines'?'deadline':'velocity'));
  });
  const content = document.getElementById('team-tab-content');
  if (!content) return;
  if (tabId==='leaderboard') loadTeamLeaderboard(content);
  else if (tabId==='sprint') renderSprintHealth(content);
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

// ── T1: Real Standup Form ────────────────────────────────────────────────────
let _standupEntries = JSON.parse(localStorage.getItem('fs_standups') || '[]');

function addMyStandup() {
  const today = new Date().toISOString().slice(0,10);
  const myEntry = _standupEntries.find(e => e.date === today && e.email === (FS_USER?.email || 'guest'));
  openModal(`
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <div style="font-size:32px">📋</div>
        <div>
          <h2 style="margin:0;font-size:18px">My Standup</h2>
          <div style="font-size:12px;color:var(--text-s)">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:11px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:5px">✅ What I completed yesterday</label>
          <textarea id="sd-yesterday" class="fs-in" rows="2" placeholder="e.g. Finished the auth flow, reviewed 3 PRs…" style="resize:vertical">${myEntry?.yesterday||''}</textarea>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:#a855f7;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:5px">🎯 What I'm working on today</label>
          <textarea id="sd-today" class="fs-in" rows="2" placeholder="e.g. Building the dashboard component, fixing API bug…" style="resize:vertical">${myEntry?.today||''}</textarea>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:5px">🚧 Blockers (leave blank if none)</label>
          <textarea id="sd-blockers" class="fs-in" rows="2" placeholder="e.g. Waiting on design review, need access to staging…" style="resize:vertical">${myEntry?.blockers||''}</textarea>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:5px">😊 Mood / Energy (optional)</label>
          <div style="display:flex;gap:8px" id="sd-mood-btns">
            ${['🔥 Fired up','😊 Good','😐 Okay','😓 Tired','🤔 Blocked'].map(m=>`<button class="btn-sm sd-mood ${myEntry?.mood===m?'btn-primary':''}" onclick="_sdSelectMood(this,'${m}')" style="font-size:11px;padding:5px 8px">${m}</button>`).join('')}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn-primary" style="flex:1" onclick="_saveStandup()"><i class="fas fa-check"></i> Post Update</button>
        <button class="btn-sm" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `);
}

let _sdMoodSelected = '';
function _sdSelectMood(btn, mood) {
  document.querySelectorAll('.sd-mood').forEach(b => b.classList.remove('btn-primary'));
  btn.classList.add('btn-primary');
  _sdMoodSelected = mood;
}

function _saveStandup() {
  const yesterday = document.getElementById('sd-yesterday')?.value?.trim();
  const today = document.getElementById('sd-today')?.value?.trim();
  const blockers = document.getElementById('sd-blockers')?.value?.trim();
  const mood = _sdMoodSelected;
  if (!yesterday && !today) { notify('Fill in at least one field', 'warning'); return; }
  const dateKey = new Date().toISOString().slice(0,10);
  const entry = {
    date: dateKey,
    email: FS_USER?.email || 'guest',
    name: FS_USER?.name?.split(' ')[0] || 'You',
    avatar: FS_USER?.picture || null,
    yesterday: yesterday || '',
    today: today || '',
    blockers: blockers || '',
    mood: mood || '',
    ts: Date.now()
  };
  // Replace today's entry for this user if exists
  _standupEntries = _standupEntries.filter(e => !(e.date === dateKey && e.email === entry.email));
  _standupEntries.unshift(entry);
  // Keep last 90 days only
  const cutoff = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
  _standupEntries = _standupEntries.filter(e => e.date >= cutoff);
  localStorage.setItem('fs_standups', JSON.stringify(_standupEntries));
  closeModal();
  notify('✅ Standup posted!', 'success');
  // Refresh standup display if visible
  const teamContent = document.getElementById('team-tab-content');
  if (teamContent && state.team.activeTab === 'standups') renderStandups(teamContent);
  // Share to Slack if connected
  if (FS_SLACK && yesterday && today) {
    const msg = `*${entry.name}'s Standup — ${dateKey}*\n✅ Yesterday: ${yesterday}\n🎯 Today: ${today}${blockers?`\n🚧 Blockers: ${blockers}`:''}${mood?`\n${mood}`:''}`;
    fetch('/api/slack/post', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: msg }) }).catch(()=>{});
  }
}

// Override renderStandups to show real entries + demo
function renderStandups(el) {
  const today = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const todayKey = new Date().toISOString().slice(0,10);
  const todayEntries = _standupEntries.filter(e => e.date === todayKey);
  const myEntry = todayEntries.find(e => e.email === (FS_USER?.email || 'guest'));

  const realRows = todayEntries.map(e => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        ${e.avatar ? `<img src="${escHtml(e.avatar)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover">` : `<span style="font-size:18px">👤</span>`}
        <strong style="font-size:13px">${escHtml(e.name)}</strong>
        ${e.mood ? `<span style="font-size:11px;padding:2px 8px;background:rgba(168,85,247,.1);border-radius:20px;color:var(--accent)">${escHtml(e.mood)}</span>` : ''}
        <span style="margin-left:auto;font-size:10px;color:var(--text-s)">${new Date(e.ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px">
        <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--green);margin-bottom:3px">✅ Yesterday</div>${escHtml(e.yesterday||'—')}</div>
        <div style="background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--accent);margin-bottom:3px">🎯 Today</div>${escHtml(e.today||'—')}</div>
        <div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--danger);margin-bottom:3px">🚧 Blockers</div>${escHtml(e.blockers||'None')}</div>
      </div>
    </div>`).join('');

  // Demo rows when no real entries
  const demoRows = todayEntries.length === 0 ? DEMO_TEAM.slice(0,2).map(m=>`
    <div style="background:var(--bg-card);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:12px;opacity:.5">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <span style="font-size:18px">${m.av}</span>
        <strong style="font-size:13px">${m.name}</strong>
        <span style="font-size:10px;padding:2px 8px;background:rgba(255,255,255,.05);border-radius:20px;color:var(--text-s)">demo</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px">
        <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--green);margin-bottom:3px">✅ Yesterday</div>${m.tasks>2?'Finished API integration':'Fixed auth bug'}</div>
        <div style="background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--accent);margin-bottom:3px">🎯 Today</div>${m.status==='focus'?'Deep work sprint':'Writing tests'}</div>
        <div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:7px;padding:7px"><div style="font-weight:700;color:var(--danger);margin-bottom:3px">🚧 Blockers</div>${m.wellness<50?'Needs architecture review':'None'}</div>
      </div>
    </div>`).join('') : '';

  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="sh-title" style="margin:0"><i class="fas fa-microphone" style="color:var(--accent)"></i> Daily Standup — ${today}</div>
        <span style="font-size:11px;color:var(--text-s)">${todayEntries.length} update${todayEntries.length!==1?'s':''} today</span>
      </div>
      <div id="standup-entries" style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
        ${realRows || demoRows || '<div style="text-align:center;padding:20px;color:var(--text-s)">No standups yet today — be the first to post!</div>'}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-primary" onclick="addMyStandup()">
          <i class="fas ${myEntry ? 'fa-edit' : 'fa-plus'}"></i> ${myEntry ? 'Update My Standup' : 'Add My Update'}
        </button>
        <button class="btn-sm" onclick="shareStandupSlack()"><i class="fab fa-slack"></i> Share to Slack</button>
      </div>
    </div>
  `;
}

function shareStandupSlack() {
  if (!FS_SLACK) { openSlackModal(); return; }
  const todayKey = new Date().toISOString().slice(0,10);
  const myEntry = _standupEntries.find(e => e.date === todayKey && e.email === (FS_USER?.email || 'guest'));
  if (!myEntry) { notify('Post your standup first', 'warning'); return; }
  const msg = `*${myEntry.name}'s Standup — ${todayKey}*\n✅ Yesterday: ${myEntry.yesterday}\n🎯 Today: ${myEntry.today}${myEntry.blockers?`\n🚧 Blockers: ${myEntry.blockers}`:''}${myEntry.mood?`\n${myEntry.mood}`:''}`;
  fetch('/api/slack/post', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: msg }) })
    .then(r=>r.json()).then(d => d.ok ? notify('📣 Standup shared to Slack!','success') : notify(d.error||'Slack error','error'))
    .catch(()=>notify('Could not reach Slack','error'));
}

// ── T2: Smart Deadlines (Pro) ────────────────────────────────────────────────
let _deadlines = JSON.parse(localStorage.getItem('fs_deadlines') || '[]');

function renderDeadlines(el) {
  const now = new Date();
  const isPro = _tokenBalance?.tier === 'pro' || _tokenBalance?.tier === 'team' || FS_USER?.tier === 'pro' || FS_USER?.tier === 'team';
  const isLoggedIn = !!FS_USER;

  // All users can add basic deadlines; Pro gets AI risk analysis
  const showDemo = _deadlines.length === 0;
  const allDeadlines = showDemo ? [
    { id:'d1', title:'Q2 Feature Launch', date: new Date(now.getTime()+3*86400000).toISOString().slice(0,10), owner:'Alex Chen', status:'on-track', progress:75, priority:'high' },
    { id:'d2', title:'API Documentation', date: new Date(now.getTime()+7*86400000).toISOString().slice(0,10), owner:'Jordan Lee', status:'at-risk', progress:45, priority:'medium' },
    { id:'d3', title:'Security Audit', date: new Date(now.getTime()+14*86400000).toISOString().slice(0,10), owner:'Sam Rivera', status:'on-track', progress:30, priority:'medium' },
    { id:'d4', title:'Performance Review', date: new Date(now.getTime()+21*86400000).toISOString().slice(0,10), owner:'Taylor Kim', status:'ahead', progress:90, priority:'low' },
  ] : _deadlines;

  const sorted = [...allDeadlines].sort((a,b) => new Date(a.date) - new Date(b.date));

  const rows = sorted.map(d => {
    const daysLeft = Math.round((new Date(d.date) - now) / 86400000);
    const isOverdue = daysLeft < 0;
    const statusColor = d.status==='ahead'?'var(--blue)':d.status==='on-track'?'var(--green)':isOverdue?'#ff4444':'var(--danger)';
    const urgency = isOverdue?'🔴':daysLeft<=3?'🔴':daysLeft<=7?'🟡':'🟢';
    // AI risk analysis is Pro-only
    const aiRisk = isPro && d.status==='at-risk' ? `<div style="font-size:11px;color:#f59e0b;margin-top:6px;padding:6px 8px;background:rgba(245,158,11,.08);border-radius:6px;border-left:2px solid #f59e0b">⚡ AI Risk: ${daysLeft<=3?'Critical — escalate now':'Progress at '+d.progress+'% with '+daysLeft+'d left — needs daily check-ins'}</div>` : '';
    const canEdit = !showDemo; // any logged-in user can edit their own deadlines
    return `<div class="deadline-item" style="border:1px solid var(--border);position:relative${showDemo?';opacity:.6':''}">
      ${canEdit ? `<div style="position:absolute;top:8px;right:8px;display:flex;gap:6px">
        <button onclick="_editDeadline('${d.id}')" style="background:none;border:none;cursor:pointer;color:var(--text-s);font-size:12px;padding:2px 5px" title="Edit"><i class="fas fa-pencil"></i></button>
        <button onclick="_deleteDeadline('${d.id}')" style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:12px;padding:2px 5px" title="Delete"><i class="fas fa-trash"></i></button>
      </div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;padding-right:${canEdit?'48px':'0'}">
        <div style="font-weight:700;font-size:13px">${urgency} ${escHtml(d.title)}</div>
        <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;background:${d.status==='ahead'?'rgba(59,130,246,.15)':d.status==='on-track'?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)'};color:${statusColor}">${isOverdue?'OVERDUE':d.status.toUpperCase()}</span>
      </div>
      <div style="font-size:11px;color:var(--text-m);margin-bottom:7px">Owner: ${escHtml(d.owner)} · ${isOverdue?`<span style="color:#ef4444">${Math.abs(daysLeft)}d overdue</span>`:`Due in ${daysLeft} day${daysLeft!==1?'s':''}`} (${new Date(d.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})})</div>
      <div class="sh-progress"><div class="sh-fill" style="width:${d.progress}%;background:${statusColor}"></div></div>
      <div style="font-size:10px;color:var(--text-m);margin-top:3px">${d.progress}% complete</div>
      ${aiRisk}
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="sh-title" style="margin:0"><i class="fas fa-clock" style="color:var(--warn)"></i> Team Deadlines${isPro?' <span style="font-size:10px;padding:1px 6px;background:rgba(168,85,247,.15);color:var(--accent);border-radius:4px;font-weight:700">✦ AI RISK</span>':''}</div>
        ${isLoggedIn ? `<button class="btn-primary" style="padding:5px 12px;font-size:12px" onclick="addDeadline()"><i class="fas fa-plus"></i> Add</button>` : `<button class="btn-sm" onclick="openAuthPopup('/api/auth/google')"><i class="fab fa-google"></i> Sign in to add</button>`}
      </div>
      ${showDemo ? `<div style="background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.2);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:var(--text-m)"><i class="fas fa-circle-info" style="margin-right:6px;color:var(--accent)"></i>Showing sample data. Sign in and add your first deadline to get started.</div>` : ''}
      ${!isPro && isLoggedIn ? `<div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:8px 12px;margin-bottom:12px;font-size:11px;color:#f59e0b;display:flex;align-items:center;justify-content:space-between"><span><i class="fas fa-wand-magic-sparkles" style="margin-right:5px"></i>Upgrade to Pro for AI risk analysis on at-risk deadlines</span><button onclick="openPricingModal()" style="background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);border-radius:6px;color:#f59e0b;cursor:pointer;font-size:10px;padding:2px 8px;font-weight:700">Upgrade</button></div>` : ''}
      <div style="display:flex;flex-direction:column;gap:10px">${rows}</div>
    </div>
  `;
}

function addDeadline() {
  const isPro = _tokenBalance?.tier === 'pro' || _tokenBalance?.tier === 'team' || FS_USER?.tier === 'pro' || FS_USER?.tier === 'team';
  openModal(`
    <div>
      <h2 style="margin-bottom:4px">➕ Add ${isPro ? 'Smart ' : ''}Deadline</h2>
      <p style="font-size:12px;color:var(--text-s);margin-bottom:16px">${isPro ? 'AI will flag at-risk deadlines and suggest escalation' : 'Track your team deadlines. Upgrade to Pro for AI risk analysis.'}</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:11px;color:var(--text-m);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Title</label>
          <input class="fs-in" placeholder="e.g. Q3 feature launch" id="dl-title" style="margin-top:5px">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:11px;color:var(--text-m);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Due Date</label>
            <input class="fs-in" type="date" id="dl-date" style="margin-top:5px" min="${new Date().toISOString().slice(0,10)}">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-m);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Owner</label>
            <input class="fs-in" placeholder="Your name" id="dl-owner" style="margin-top:5px" value="${FS_USER?.name?.split(' ')[0]||''}">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-m);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Progress %</label>
          <div style="display:flex;align-items:center;gap:10px;margin-top:5px">
            <input id="dl-progress" type="range" min="0" max="100" value="0" oninput="document.getElementById('dl-prog-val').textContent=this.value+'%'" style="flex:1;accent-color:var(--accent)">
            <span id="dl-prog-val" style="font-size:12px;color:var(--accent);font-weight:700;width:32px">0%</span>
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-m);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Status</label>
          <select id="dl-status" class="fs-in" style="margin-top:5px">
            <option value="on-track">On Track</option>
            <option value="at-risk">At Risk</option>
            <option value="ahead">Ahead of Schedule</option>
          </select>
        </div>
      </div>
      <button class="btn-primary" style="width:100%;margin-top:16px" onclick="_saveDeadline()"><i class="fas fa-check"></i> Add Deadline</button>
    </div>
  `);
}

function _saveDeadline() {
  const title = document.getElementById('dl-title')?.value?.trim();
  const date = document.getElementById('dl-date')?.value;
  const owner = document.getElementById('dl-owner')?.value?.trim() || 'Me';
  const progress = parseInt(document.getElementById('dl-progress')?.value||'0');
  const status = document.getElementById('dl-status')?.value || 'on-track';
  if (!title || !date) { notify('Title and date are required','warning'); return; }
  const entry = { id: 'dl_'+Date.now(), title, date, owner, progress, status, created: Date.now() };
  _deadlines.push(entry);
  localStorage.setItem('fs_deadlines', JSON.stringify(_deadlines));
  closeModal();
  notify('📅 Deadline added!','success');
  const teamContent = document.getElementById('team-tab-content');
  if (teamContent && state.team.activeTab === 'deadlines') renderDeadlines(teamContent);
}

function _editDeadline(id) {
  const d = _deadlines.find(x => x.id === id);
  if (!d) return;
  openModal(`
    <div>
      <h2 style="margin-bottom:16px">✏️ Edit Deadline</h2>
      <div style="display:flex;flex-direction:column;gap:10px">
        <input class="fs-in" id="edl-title" value="${escHtml(d.title)}">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <input class="fs-in" type="date" id="edl-date" value="${d.date}">
          <input class="fs-in" id="edl-owner" value="${escHtml(d.owner)}">
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <input id="edl-progress" type="range" min="0" max="100" value="${d.progress}" oninput="document.getElementById('edl-prog-val').textContent=this.value+'%'" style="flex:1;accent-color:var(--accent)">
          <span id="edl-prog-val" style="font-size:12px;color:var(--accent);font-weight:700;width:32px">${d.progress}%</span>
        </div>
        <select id="edl-status" class="fs-in">
          <option value="on-track" ${d.status==='on-track'?'selected':''}>On Track</option>
          <option value="at-risk" ${d.status==='at-risk'?'selected':''}>At Risk</option>
          <option value="ahead" ${d.status==='ahead'?'selected':''}>Ahead of Schedule</option>
        </select>
      </div>
      <button class="btn-primary" style="width:100%;margin-top:14px" onclick="_updateDeadline('${id}')"><i class="fas fa-check"></i> Save Changes</button>
    </div>
  `);
}

function _updateDeadline(id) {
  const idx = _deadlines.findIndex(x => x.id === id);
  if (idx === -1) return;
  _deadlines[idx] = { ..._deadlines[idx],
    title: document.getElementById('edl-title')?.value?.trim() || _deadlines[idx].title,
    date: document.getElementById('edl-date')?.value || _deadlines[idx].date,
    owner: document.getElementById('edl-owner')?.value?.trim() || _deadlines[idx].owner,
    progress: parseInt(document.getElementById('edl-progress')?.value||'0'),
    status: document.getElementById('edl-status')?.value || _deadlines[idx].status,
  };
  localStorage.setItem('fs_deadlines', JSON.stringify(_deadlines));
  closeModal(); notify('Deadline updated','success');
  const teamContent = document.getElementById('team-tab-content');
  if (teamContent && state.team.activeTab === 'deadlines') renderDeadlines(teamContent);
}

function _deleteDeadline(id) {
  if (!confirm('Delete this deadline?')) return;
  _deadlines = _deadlines.filter(x => x.id !== id);
  localStorage.setItem('fs_deadlines', JSON.stringify(_deadlines));
  notify('Deadline removed','info');
  const teamContent = document.getElementById('team-tab-content');
  if (teamContent && state.team.activeTab === 'deadlines') renderDeadlines(teamContent);
}

// ── Slack Modal ─────────────────────────────────────────────────────────────
function openSlackModal() {
  // Show loading state immediately
  openModal(`<h2>💬 Send Slack Message</h2><div style="padding:20px;text-align:center;color:var(--text-m)">Loading channels…</div>`);

  fetch('/api/slack/channels').then(r=>r.json()).then(d=>{
    if (d.error === 'not_connected') {
      // Not connected — show connect prompt, and after connect auto-open the send modal
      openModal(`<h2>💬 Slack</h2>
        <div style="text-align:center;padding:20px 10px">
          <div style="font-size:40px;margin-bottom:12px">💬</div>
          <p style="color:var(--text-m);font-size:14px;margin-bottom:18px">Connect Slack to post messages and standups directly from FlowState.</p>
          <button class="btn-primary" style="width:100%" onclick="closeModal();_connectSlackThenOpen()">Connect Slack</button>
        </div>`);
      return;
    }
    const channels = d.channels || [];
    if (!channels.length) {
      openModal(`<h2>💬 Slack</h2>
        <div style="padding:20px;text-align:center">
          <div style="font-size:36px;margin-bottom:12px">📭</div>
          <p style="color:var(--text-m);font-size:13px;margin-bottom:16px">No channels found in your workspace.<br>Create one to get started.</p>
          <input class="fs-in" id="sl-new-chan" placeholder="channel-name" style="width:100%;margin-bottom:10px">
          <button class="btn-primary" style="width:100%" onclick="createSlackChannel()">Create Channel</button>
        </div>`);
      return;
    }
    _renderSlackSendModal(channels);
  }).catch(()=>{
    openModal(`<h2>💬 Slack</h2><div style="padding:20px;text-align:center;color:#ef4444">Could not reach Slack — check your connection and try again.</div>`);
  });
}

// Connect Slack and automatically open the send modal when done
function _connectSlackThenOpen() {
  const popup = window.open('/api/auth/slack', '_blank', 'width=480,height=600,noopener=no');
  const timer = setInterval(function() {
    if (popup && popup.closed) {
      clearInterval(timer);
      setTimeout(function() {
        _verifySlackStatus().then(function() {
          if (window.FS_SLACK) openSlackModal(); // auto-open send modal
        });
      }, 800);
    }
  }, 1000);
}

function _renderSlackSendModal(channels) {
  const chanOptions = channels.map(ch =>
    `<option value="${ch.id}">#${ch.name}${ch.memberCount ? ' ('+ch.memberCount+' members)' : ''}</option>`
  ).join('');
  openModal(`
    <h2 style="margin-bottom:4px">💬 Slack</h2>
    <p style="font-size:12px;color:var(--text-m);margin:0 0 16px">Post a message to a channel in your Slack workspace.</p>

    <div style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <label style="font-size:12px;color:var(--text-m);font-weight:600">Channel</label>
        <button onclick="_showCreateChannelForm()" style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0">+ New channel</button>
      </div>
      <select class="fs-sel" id="sl-chan" style="width:100%">
        ${chanOptions}
      </select>
      <div id="sl-create-form" style="display:none;margin-top:8px;display:none">
        <input class="fs-in" id="sl-new-chan" placeholder="channel-name (no spaces)" style="width:100%;margin-bottom:6px">
        <div style="display:flex;gap:8px">
          <button class="btn-primary" onclick="createSlackChannel()" style="flex:1;font-size:12px">Create</button>
          <button class="btn-sm" onclick="document.getElementById('sl-create-form').style.display='none'" style="font-size:12px">Cancel</button>
        </div>
      </div>
    </div>

    <div style="margin-bottom:14px">
      <label style="font-size:12px;color:var(--text-m);font-weight:600;display:block;margin-bottom:6px">Message</label>
      <textarea class="chat-in" id="sl-msg" style="width:100%;height:80px" placeholder="Type your message…"></textarea>
    </div>

    <div style="display:flex;gap:8px">
      <button class="btn-primary" onclick="sendSlackMessage()" style="flex:1">Send to Slack</button>
      <button class="btn-sm" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

function _showCreateChannelForm() {
  const form = document.getElementById('sl-create-form');
  if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

function createSlackChannel() {
  const name = document.getElementById('sl-new-chan')?.value?.trim();
  if (!name) { notify('Enter a channel name', 'error'); return; }
  const btn = document.querySelector('#sl-create-form .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  fetch('/api/slack/create-channel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => r.json()).then(d => {
    if (d.ok && d.channel) {
      // Add new channel to dropdown and select it
      const sel = document.getElementById('sl-chan');
      if (sel) {
        const opt = document.createElement('option');
        opt.value = d.channel.id;
        opt.textContent = '#' + d.channel.name;
        opt.selected = true;
        sel.appendChild(opt);
      }
      document.getElementById('sl-create-form').style.display = 'none';
      notify('#' + d.channel.name + ' created!', 'success');
    } else {
      notify(d.error || 'Could not create channel', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
    }
  }).catch(() => { notify('Error creating channel', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Create'; } });
}

function sendSlackMessage() {
  const chan = document.getElementById('sl-chan')?.value;
  const msg  = document.getElementById('sl-msg')?.value?.trim();
  if (!msg) { notify('Enter a message', 'error'); return; }
  const btn = document.querySelector('#sl-send-btn') || document.querySelector('.btn-primary[onclick="sendSlackMessage()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  fetch('/api/slack/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: chan, text: msg }),
  }).then(r => r.json()).then(d => {
    if (d.ok) { closeModal(); notify('Message sent to Slack! ✓', 'success'); }
    else {
      notify(d.error || 'Send failed', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Send to Slack'; }
    }
  }).catch(() => { notify('Error sending', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Send to Slack'; } });
}

// Keep old name working for any other callers
function sendTestSlack() { sendSlackMessage(); }

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
  const model  = state.gen?.imgModel || 'flux_pro';
  if (!prompt) { notify('Enter a prompt','error'); return; }
  const btn = document.getElementById('btn-gen-img'); btn.disabled=true; btn.textContent='Generating...';
  genSidebarLog('imggen', `Sending: "${prompt.slice(0,50)}${prompt.length>50?'…':''}"`);
  try {
    const r = await fetch('/api/generate/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model})});
    const d = await r.json();
    const results = document.getElementById('img-results');
    if (d.imageUrl) {
      results.innerHTML = `<div style="position:relative"><img class="gen-img" src="${d.imageUrl}" alt="${escHtml(prompt)}" onclick="window.open('${d.imageUrl}')"><a href="${d.imageUrl}" download class="btn-gen" style="position:absolute;bottom:8px;right:8px;padding:6px 12px;font-size:11px"><i class="fas fa-download"></i></a></div>`;
      genSidebarLog('imggen', '✅ Image generated', 'success');
    } else if (d.imageBase64) {
      results.innerHTML = `<img class="gen-img" src="data:image/jpeg;base64,${d.imageBase64}" alt="${escHtml(prompt)}">`;
      genSidebarLog('imggen', '✅ Image generated', 'success');
    } else {
      results.innerHTML = `<div style="color:var(--danger);font-size:13px">${d.error||'Generation failed — add API key in Credentials'}</div>`;
      genSidebarLog('imggen', '❌ ' + (d.error||'Failed'), 'error');
    }
  } catch(e) { notify('Image generation error','error'); genSidebarLog('imggen','❌ Network error','error'); }
  finally { btn.disabled=false; btn.innerHTML='<i class="fas fa-wand-magic-sparkles"></i>&nbsp; Generate Image'; }
}

async function generateVideo() {
  const prompt = document.getElementById('vid-prompt').value.trim();
  const model  = state.gen?.vidModel || 'veo2';
  const dur    = document.getElementById('vid-dur')?.value || '5';
  if (!prompt) { notify('Enter a prompt','error'); return; }
  const btn = document.getElementById('btn-gen-vid'); btn.disabled=true; btn.textContent='Queuing...';
  genSidebarLog('vidgen', `Queuing ${dur}s video: "${prompt.slice(0,45)}${prompt.length>45?'…':''}"`);
  try {
    const r = await fetch('/api/generate/video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,model,duration:parseInt(dur)})});
    const d = await r.json();
    const resultEl = document.getElementById('vid-result');
    if (d.queued) {
      resultEl.innerHTML = `<i class="fas fa-clock" style="color:var(--warn)"></i> ${d.message||'Video queued.'}`;
      genSidebarLog('vidgen', '⏳ Video queued — check back soon');
    } else if (d.videoUrl) {
      resultEl.innerHTML = `<video src="${d.videoUrl}" controls style="width:100%;border-radius:11px"></video>`;
      genSidebarLog('vidgen', '✅ Video ready', 'success');
    } else {
      resultEl.innerHTML = `<span style="color:var(--danger)">${d.error||'Generation failed'}</span>`;
      genSidebarLog('vidgen', '❌ ' + (d.error||'Failed'), 'error');
    }
  } catch(e) { notify('Video generation error','error'); genSidebarLog('vidgen','❌ Network error','error'); }
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
        '7 AI models (1,500 tokens/day)',
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
        'Unlimited tokens (smart routing)',
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
        'Everything in Pro (unlimited tokens)',
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
        'Unlimited tokens (custom limits)',
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
    ${row('Higgsfield (Seedance 2.0 / Wan 2.6)', '🎞️', s.higgsfield, 'Claw Video wizard — cinematic music videos')}
    ${row('Suno (AI Music)', '🎵', s.suno, 'Full-track AI music generation')}

    <div style="grid-column:1/-1;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-m);margin:10px 0 2px">🚀 Claw Release Wizard</div>
    ${row('fal.ai (Cover Art)', '🎨', s.fal_ai, 'AI album cover generation — free for all users')}
    ${row('DistroKid API', '🎵', s.distrokid, 'Direct distribution upload — invite-only partner API')}
    ${row('UnitedMasters API', '🎤', s.unitedmasters, 'Direct upload + brand partnerships')}
    ${row('SubmitHub API', '📋', s.submithub, 'Curator & blog pitching — free tier: 3 blogs/day')}

    <div style="grid-column:1/-1;margin-top:12px;padding:10px 12px;background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.2);border-radius:9px;font-size:11px;color:var(--text-s)">
      Keys are stored as <strong style="color:var(--text)">Cloudflare Secrets</strong> — never visible to users.
      Add with: <code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px">wrangler pages secret put KEY_NAME --project-name flowstate</code>
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
      // Core
      'GOOGLE_CLIENT_ID': ks.google_oauth, 'GOOGLE_CLIENT_SECRET': ks.google_oauth,
      'OPENROUTER_API_KEY': ks.openrouter,
      'UPSTASH_REDIS_URL': ks.redis, 'UPSTASH_REDIS_TOKEN': ks.redis,
      'STRIPE_SECRET_KEY': ks.stripe, 'STRIPE_PUBLISHABLE_KEY': ks.stripe, 'STRIPE_WEBHOOK_SECRET': ks.stripe,
      'RESEND_API_KEY': ks.resend,
      'NOTION_CLIENT_ID': ks.notion, 'NOTION_CLIENT_SECRET': ks.notion,
      'SLACK_CLIENT_ID': ks.slack, 'SLACK_CLIENT_SECRET': ks.slack, 'SLACK_BOT_TOKEN': ks.slack,
      // AI
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
      'HUGGINGFACE_API_KEY': ks.huggingface,
      // Claw Release Wizard
      'FAL_AI_KEY': ks.fal_ai,
      'HIGGSFIELD_API_KEY': ks.higgsfield, 'HIGGSFIELD_API_SECRET': ks.higgsfield,
      'DISTROKID_CLIENT_ID': ks.distrokid, 'DISTROKID_CLIENT_SECRET': ks.distrokid,
      'UNITEDMASTERS_CLIENT_ID': ks.unitedmasters, 'UNITEDMASTERS_CLIENT_SECRET': ks.unitedmasters,
      'SUBMITHUB_API_KEY': ks.submithub,
    };

    const isLive = (envKey) => {
      const keys = envKey.split(',').map(k=>k.trim());
      return keys.some(k => KEY_MAP[k] === true);
    };
    const isAllMissing = (envKey) => {
      const keys = envKey.split(',').map(k=>k.trim());
      return keys.every(k => KEY_MAP[k] === false);
    };

    const coreItems=[], recItems=[], imgItems=[], vidItems=[], integItems=[], audioItems=[], pro264Items=[], releaseItems=[], otherItems=[];
    const imgKeywords     = ['Stability AI','Black Forest Labs','Ideogram','Recraft','Imagen','DALL-E','GPT-Image','OpenAI'];
    const vidKeywords     = ['Runway ML','Kling','Pika Labs','MiniMax','Luma AI','Veo','Sora','Higgsfield'];
    const audioKeywords   = ['Suno','Udio','MusicGen','Moises','Loudme','ACRCloud','Dolby','AudioShake','ElevenLabs'];
    const pro264Keywords  = ['Replicate','Hugging Face','Cloudflare R2','Clawbot'];
    const releaseKeywords = ['fal.ai','DistroKid','UnitedMasters','SubmitHub'];
    const integKeywords   = ['Microsoft','GitHub OAuth','Linear','Jira','Asana','Oura','Whoop','Plaid','Beehiiv','YouTube Embed','Spotify Embed'];

    (d.credentials||[]).forEach(c=>{
      if (c.required==='core') { coreItems.push(c); return; }
      if (releaseKeywords.some(k=>c.service.includes(k))) { releaseItems.push(c); return; }
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

    // Summary counts for header
    const totalServices = (d.credentials||[]).length;
    const liveCount = (d.credentials||[]).filter(c => isLive(c.envKey)).length;
    const missingCore = coreItems.filter(c => isAllMissing(c.envKey)).length;

    openModal(`
      <h2 style="margin-bottom:4px">🔑 API Integration Status</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span style="background:rgba(16,185,129,.12);color:#10b981;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:700">● ${liveCount} live</span>
        ${missingCore > 0 ? `<span style="background:rgba(239,68,68,.12);color:#f87171;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:700">⚠ ${missingCore} core missing</span>` : ''}
        <span style="background:rgba(255,255,255,.05);color:rgba(255,255,255,.4);border-radius:6px;padding:3px 9px;font-size:11px">${totalServices} total services</span>
      </div>
      <p style="color:var(--text-s);font-size:11px;margin-bottom:12px;line-height:1.5">
        Keys stored as <strong>Cloudflare Secrets</strong> — never exposed to users or frontend code.<br>
        Add keys via: <code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px;font-size:10px">wrangler pages secret put KEY_NAME --project-name flowstate</code><br>
        <strong style="color:#10b981">● LIVE</strong> = active &nbsp;·&nbsp; <strong style="color:#f59e0b">⚠ MISSING</strong> = needs key &nbsp;·&nbsp; <strong style="color:#a78bfa">— —</strong> = key check not mapped
      </p>
      <div style="overflow-x:auto">
      <table class="cred-tbl">
        <thead><tr><th>Service</th><th>What It Powers</th><th>Env Variable(s)</th><th>Status</th><th>Get Key</th></tr></thead>
        <tbody>
          ${renderSection('🟢 Core — Required for basic functionality', coreItems, '#10b981')}
          ${renderSection('🟡 Recommended — AI Chat Models', recItems, '#f59e0b')}
          ${renderSection('🚀 Claw Release Wizard — Post-Release Automation', releaseItems, '#a855f7')}
          ${renderSection('🖼️ Image Generation Models', imgItems, '#a78bfa')}
          ${renderSection('🎬 Video Generation Models', vidItems, '#60a5fa')}
          ${renderSection('🎵 FlowState Audio — Music &amp; Voice AI', audioItems, '#f472b6')}
          ${renderSection('⚡ 264 Pro Video Editor', pro264Items, '#fb923c')}
          ${renderSection('🔗 Integrations — Productivity &amp; Team', integItems, '#6b7280')}
          ${otherItems.length ? renderSection('Other', otherItems, '#6b7280') : ''}
        </tbody>
      </table>
      </div>
    `, true);
  }).catch(()=>notify('Could not load credentials','error'));
}

// ── Referral system ───────────────────────────────────────────────────────────
async function openInviteModal() {
  if (!FS_USER && !state.settings.isDemo) {
    openModal(`
      <div style="text-align:center;padding:8px 0">
        <div style="font-size:40px;margin-bottom:12px">🎁</div>
        <h2 style="margin:0 0 8px">Invite Friends, Earn Tokens</h2>
        <p style="color:var(--text-s);font-size:13px;margin-bottom:18px">Sign in to generate your unique referral link.<br>You earn <strong style="color:#10b981">5,000 tokens</strong> per friend who joins — they get <strong style="color:#a855f7">10,000 bonus tokens</strong>.</p>
        <button class="btn-primary" onclick="closeModal();openAuthPopup('/api/auth/google')" style="width:100%"><i class="fab fa-google"></i> Sign in to get your link</button>
      </div>`);
    return;
  }

  // Show loading state
  openModal(`<div style="text-align:center;padding:24px 0"><i class="fas fa-spinner fa-spin" style="font-size:24px;color:var(--accent)"></i><div style="margin-top:12px;color:#888;font-size:13px">Generating your link…</div></div>`);

  try {
    const [genRes, statsRes] = await Promise.all([
      fetch('/api/referral/generate', { method: 'POST', credentials: 'include' }),
      fetch('/api/referral/stats', { credentials: 'include' }),
    ]);
    const gen   = await genRes.json();
    const stats = await statsRes.json();
    if (gen.error) { notify('Error generating referral link', 'error'); return; }

    const refUrl  = gen.url;
    const code    = gen.code;
    const claimed = stats.claimed || 0;
    const earned  = claimed * 5000;

    const shareActions = [
      { icon: 'fa-copy',     label: 'Copy Link',    fn: `navigator.clipboard.writeText('${refUrl}').then(()=>notify('🔗 Copied!','success'))` },
      { icon: 'fa-twitter',  label: 'Share on X',   fn: `window.open('https://twitter.com/intent/tweet?text=${encodeURIComponent(gen.shareText + ' ' + refUrl)}','_blank')` },
      { icon: 'fa-whatsapp', label: 'WhatsApp',      fn: `window.open('https://wa.me/?text=${encodeURIComponent(gen.shareText + ' ' + refUrl)}','_blank')` },
    ].map(a => `<button class="btn-sm" onclick="${a.fn}" style="flex:1;gap:5px;justify-content:center"><i class="fab ${a.icon}"></i>${a.label}</button>`).join('');

    openModal(`
      <div style="padding:4px 0">
        <div style="text-align:center;margin-bottom:18px">
          <div style="font-size:36px;margin-bottom:8px">🎁</div>
          <h2 style="margin:0 0 6px">Invite Friends</h2>
          <p style="color:var(--text-s);font-size:12px">You earn <strong style="color:#10b981">5,000 tokens</strong> per friend · They get <strong style="color:#a855f7">10,000 bonus tokens</strong></p>
        </div>
        ${claimed > 0 ? `
        <div style="background:linear-gradient(135deg,rgba(16,185,129,.1),rgba(16,185,129,.05));border:1px solid rgba(16,185,129,.25);border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;color:var(--text-s)">🏆 ${claimed} friend${claimed!==1?'s':''} joined</span>
          <span style="font-size:14px;font-weight:800;color:#10b981">+${earned.toLocaleString()} tokens earned</span>
        </div>` : ''}
        <div style="background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.2);border-radius:10px;padding:10px 12px;margin-bottom:12px">
          <div style="font-size:10px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Your Referral Code</div>
          <div style="font-family:monospace;font-size:18px;font-weight:900;color:var(--accent);letter-spacing:2px;text-align:center">${code}</div>
        </div>
        <input id="ref-url-input" value="${refUrl}" readonly style="width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-s);font-size:11px;margin-bottom:10px;outline:none" onclick="this.select()">
        <div style="display:flex;gap:7px;margin-bottom:12px">${shareActions}</div>
        <div style="font-size:11px;color:#555;text-align:center">Link never expires · Share anywhere</div>
        ${FS_USER ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <button class="btn-sm" style="width:100%;gap:6px;justify-content:center" onclick="closeModal();openProfileModal()"><i class="fas fa-globe"></i> Set up your public FlowScore profile</button>
        </div>` : ''}
      </div>`);
  } catch(e) {
    notify('Error loading referral data', 'error');
  }
}

// ── Public profile setup ──────────────────────────────────────────────────────
async function openProfileModal() {
  if (!FS_USER) { notify('Sign in to create a profile', 'info'); return; }
  openModal(`<div style="text-align:center;padding:20px 0"><i class="fas fa-spinner fa-spin" style="font-size:20px;color:var(--accent)"></i></div>`);
  try {
    const r = await fetch('/api/profile/me', { credentials: 'include' });
    const d = await r.json();
    const p = d.profile;
    const defaultSlug = (FS_USER.name||FS_USER.email||'').toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').slice(0,20);

    openModal(`
      <div style="padding:4px 0">
        <h2 style="margin:0 0 6px;text-align:center">🌍 Public FlowScore Profile</h2>
        <p style="color:var(--text-s);font-size:12px;text-align:center;margin-bottom:16px">Create a shareable profile at <strong style="color:var(--accent)">flowst8.cc/u/your-slug</strong></p>
        <div style="margin-bottom:10px">
          <label style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Profile Slug (URL)</label>
          <div style="display:flex;align-items:center;gap:5px">
            <span style="font-size:12px;color:#555">flowst8.cc/u/</span>
            <input id="prof-slug" value="${p?.slug||defaultSlug}" placeholder="your-slug" maxlength="30" style="flex:1;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text-p);font-size:13px;outline:none">
          </div>
        </div>
        <div style="margin-bottom:10px">
          <label style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Display Name</label>
          <input id="prof-name" value="${p?.display_name||FS_USER.name||''}" maxlength="50" style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text-p);font-size:13px;outline:none">
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Tagline (optional)</label>
          <input id="prof-tagline" value="${p?.tagline||''}" maxlength="80" placeholder="Builder. 90min deep work blocks." style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:8px;padding:7px 10px;color:var(--text-p);font-size:13px;outline:none">
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:8px">Show on profile</label>
          <div style="display:flex;flex-wrap:wrap;gap:7px">
            ${[
              {id:'show-score',  label:'FlowScore ring',   checked: p?.show_score !== 0},
              {id:'show-streak', label:'Day streak',       checked: p?.show_streak !== 0},
              {id:'show-outputs',label:'Output types',     checked: p?.show_outputs === 1},
              {id:'show-weekly', label:'Weekly stats',     checked: p?.show_weekly === 1},
            ].map(c=>`<label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-s);cursor:pointer"><input type="checkbox" id="${c.id}" ${c.checked?'checked':''}> ${c.label}</label>`).join('')}
          </div>
        </div>
        <button class="btn-primary" style="width:100%;margin-bottom:8px" onclick="saveProfile()">Save Profile</button>
        ${p?.slug ? `<a href="/u/${p.slug}" target="_blank" style="display:block;text-align:center;font-size:12px;color:var(--accent);text-decoration:none">👁 View my profile →</a>` : ''}
      </div>`);
  } catch(e) {
    notify('Error loading profile', 'error');
  }
}

async function saveProfile() {
  const slug        = document.getElementById('prof-slug')?.value?.trim();
  const displayName = document.getElementById('prof-name')?.value?.trim();
  const tagline     = document.getElementById('prof-tagline')?.value?.trim();
  const showScore   = document.getElementById('show-score')?.checked;
  const showStreak  = document.getElementById('show-streak')?.checked;
  const showOutputs = document.getElementById('show-outputs')?.checked;
  const showWeekly  = document.getElementById('show-weekly')?.checked;
  if (!slug || slug.length < 3) { notify('Slug must be at least 3 characters', 'error'); return; }

  try {
    const r = await fetch('/api/profile/setup', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, displayName, tagline, showScore, showStreak, showOutputs, showWeekly }),
    });
    const d = await r.json();
    if (d.error === 'slug_taken') { notify('That slug is taken — try another', 'error'); return; }
    if (d.error === 'slug_too_short') { notify('Slug must be at least 3 characters', 'error'); return; }
    if (d.ok) {
      notify(`✅ Profile live at flowst8.cc/u/${d.slug}`, 'success');
      closeModal();
      setTimeout(() => window.open(`/u/${d.slug}`, '_blank'), 500);
    } else {
      notify(d.error || 'Error saving profile', 'error');
    }
  } catch(e) {
    notify('Network error — try again', 'error');
  }
}

// ── Referral claim on first load (if ?ref= in URL) ───────────────────────────
async function checkReferralClaim() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  if (!ref || !FS_USER) return;
  // Clean the URL
  window.history.replaceState({}, '', window.location.pathname);
  try {
    const r = await fetch(`/api/referral/claim?ref=${encodeURIComponent(ref)}`, { credentials: 'include' });
    const d = await r.json();
    if (d.ok) {
      notify(`🎁 Welcome! ${d.referrerName} referred you — +${(d.bonusTokens||0).toLocaleString()} bonus tokens added to your account!`, 'success');
    }
    // Silently ignore code_already_used, self_referral, invalid_code etc.
  } catch(_) {}
}

function openSettingsModal() {
  const isSigned = !!FS_USER;
  const cur = state.timer.focusMin || 25;
  const presets = [25, 45, 90];
  const isCustom = !presets.includes(cur);
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  openModal(`<h2>⚙️ Settings</h2>
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">APPEARANCE</div>
      <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 14px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:18px">${isLight ? '☀️' : '🌙'}</span>
          <div>
            <div style="font-size:13px;font-weight:700">${isLight ? 'Light Mode' : 'Dark Mode'}</div>
            <div style="font-size:11px;color:var(--text-s)">${isLight ? 'Switch to the dark side' : 'Switch to the light side 😇'}</div>
          </div>
        </div>
        <button onclick="toggleTheme();closeModal();setTimeout(openSettingsModal,50)" class="btn-sm" style="gap:6px;min-width:80px">
          ${isLight ? '🌙 Dark' : '☀️ Light'}
        </button>
      </div>
    </div>
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">FOCUS DURATION</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${presets.map(m=>`<button class="btn-sm ${cur===m&&!isCustom?'btn-primary':''}" onclick="updateFocusDur(${m})">${m}m</button>`).join('')}
        <div style="display:flex;align-items:center;gap:5px">
          <input id="custom-dur-in" type="number" min="1" max="480" value="${isCustom?cur:''}" placeholder="Custom" 
            style="width:72px;background:var(--bg-card);border:1px solid ${isCustom?'var(--accent)':'var(--border)'};border-radius:8px;padding:6px 8px;color:var(--text-p);font-size:13px;font-weight:700"
            onkeydown="if(event.key==='Enter'){const v=parseInt(this.value);if(v>=1&&v<=480)updateFocusDur(v);}">
          <button class="btn-sm ${isCustom?'btn-primary':''}" onclick="const v=parseInt(document.getElementById('custom-dur-in').value);if(v>=1&&v<=480)updateFocusDur(v);else notify('Enter 1–480 minutes','warning')">Set</button>
        </div>
      </div>
      <div style="font-size:10px;color:var(--text-s);margin-top:6px">Current: <strong style="color:var(--accent)">${cur} min</strong> · Custom range: 1–480 min</div>
    </div>
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">POMODORO MUSIC</div>
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn-sm" onclick="closeModal();openMusicModal()"><i class="fas fa-music"></i> Configure YouTube/Spotify</button>
        ${_ytPlaylist.length>0?`<span style="font-size:11px;color:var(--accent)">${_ytPlaylist.length} track${_ytPlaylist.length!==1?'s':''} in playlist</span>`:''}
      </div>
    </div>
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">INTEGRATIONS</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span>📅 Google Calendar</span>${FS_USER ? '<span style="color:var(--green)">✓ Synced · '+escHtml(FS_USER.email||FS_USER.name||'')+'</span>' : '<button class="btn-sm" onclick="window.location.href=\'/api/auth/google\'" style="font-size:11px">Connect Google</button>'}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span>📝 Notion</span><button class="btn-sm ${FS_NOTION?'connected':''}" onclick="connectNotion()" style="${FS_NOTION?'color:var(--green);border-color:var(--green)':''}"> ${FS_NOTION?'✓ Connected':'Connect'}</button></div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px"><span>💬 Slack</span><button class="btn-sm ${FS_SLACK?'connected':''}" onclick="connectSlack()" style="${FS_SLACK?'color:var(--green);border-color:var(--green)'  :''}"> ${FS_SLACK?'✓ Connected':'Connect'}</button></div>
      </div>
    </div>
    ${isSigned ? `
    <div style="margin:14px 0">
      <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">PROFILE & REFERRAL</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        <button class="btn-sm" style="justify-content:flex-start;gap:7px" onclick="closeModal();openInviteModal()"><i class="fas fa-user-plus"></i> Invite friends — earn tokens</button>
        <button class="btn-sm" style="justify-content:flex-start;gap:7px" onclick="closeModal();openProfileModal()"><i class="fas fa-globe"></i> Public FlowScore profile</button>
      </div>
    </div>
    <button class="btn-sm" style="color:var(--danger);border-color:var(--danger);width:100%;margin-top:8px" onclick="signOut()">Sign Out</button>` : ''}
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:center;gap:16px">
      <a href="/legal#privacy" target="_blank" style="font-size:11px;color:var(--text-s);text-decoration:none;transition:color .2s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-s)'">🔒 Privacy Policy</a>
      <span style="color:var(--border)">·</span>
      <a href="/legal#terms" target="_blank" style="font-size:11px;color:var(--text-s);text-decoration:none;transition:color .2s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-s)'">📋 Terms of Use</a>
      <span style="color:var(--border)">·</span>
      <a href="mailto:support@flowst8.cc" style="font-size:11px;color:var(--text-s);text-decoration:none;transition:color .2s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-s)'">✉️ Contact</a>
    </div>`);
}

function updateFocusDur(m) {
  state.timer.focusMin = m;
  state.settings.focusMin = m;
  if (!state.timer.running) { state.timer.elapsed=0; updateTimerDisplay(); }
  saveLocalState(); closeModal();
  notify(`Focus duration: ${m} min`,'success');
}

function connectSlack() {
  // If already connected, open the send modal instead of re-authenticating
  if (window.FS_SLACK) { openSlackModal(); return; }
  const popup = window.open('/api/auth/slack', '_blank', 'width=480,height=600,noopener=no');
  const timer = setInterval(function() {
    if (popup && popup.closed) {
      clearInterval(timer);
      setTimeout(_verifySlackStatus, 800);
    }
  }, 1000);
}

async function _verifySlackStatus() {
  try {
    const r = await fetch('/api/auth/slack-status');
    const d = await r.json();
    if (d.connected && !window.FS_SLACK) {
      // Only notify if this is a fresh connect, not a redundant check
      window.FS_SLACK = { team: d.team, connected: true };
      notify('✓ Slack connected — ' + (d.team || 'workspace synced'), 'success');
      _refreshSlackUI();
    } else if (d.connected) {
      window.FS_SLACK = { team: d.team, connected: true };
    }
  } catch(e) {}
}

async function _verifyNotionStatus() {
  try {
    const r = await fetch('/api/auth/notion-status');
    const d = await r.json();
    if (d.connected) {
      window.FS_NOTION = { workspace: d.workspace, connected: true };
      notify('✓ Notion connected — ' + (d.workspace || 'workspace synced'), 'success');
      _refreshNotionUI();
    }
  } catch(e) {}
}

// Listen for postMessage from OAuth popup on success (faster path than polling)
window.addEventListener('message', function(e) {
  if (e.origin !== 'https://flowst8.cc') return;
  if (e.data && e.data.type === 'slack_connected') {
    window.FS_SLACK = { team: e.data.team, connected: true };
    notify('✓ Slack connected — ' + (e.data.team || 'workspace synced'), 'success');
    _refreshSlackUI();
  }
  if (e.data && e.data.type === 'notion_connected') {
    window.FS_NOTION = { workspace: e.data.workspace, connected: true };
    notify('✓ Notion connected — ' + (e.data.workspace || 'workspace synced'), 'success');
    _refreshNotionUI();
  }
});

function _refreshSlackUI() {
  // Update any "Connect Slack" buttons to "✓ Connected"
  document.querySelectorAll('[onclick="connectSlack()"]').forEach(btn => {
    btn.textContent = '✓ Connected';
    btn.classList.add('connected');
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';
  });
  // Update settings modal if open
  const settingsSlackBtn = document.querySelector('.integ-row .btn-connect[onclick="connectSlack()"]');
  if (settingsSlackBtn) { settingsSlackBtn.textContent = '✓ Connected'; settingsSlackBtn.className = 'btn-connect connected'; }
  // Update Claw permissions panel if open
  const slackLbl = document.getElementById('claw-slack-label');
  if (slackLbl) slackLbl.textContent = 'Slack: ' + (window.FS_SLACK?.team || 'connected');
  const slackStatus = document.getElementById('claw-slack-status');
  if (slackStatus) slackStatus.style.borderColor = 'rgba(34,197,94,.4)';
  const slackConnBtn = document.getElementById('claw-slack-connect-btn');
  if (slackConnBtn) slackConnBtn.style.display = 'none';
  // Reload claw permission toggles to unlock Slack section
  if (_clawPermPanelOpen) loadClawPermissions();
}

function _refreshNotionUI() {
  document.querySelectorAll('[onclick="connectNotion()"]').forEach(btn => {
    btn.textContent = '✓ Connected';
    btn.classList.add('connected');
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';
  });
  const notionLbl = document.getElementById('claw-notion-label');
  if (notionLbl) notionLbl.textContent = 'Notion: ' + (window.FS_NOTION?.workspace || 'connected');
  const notionStatus = document.getElementById('claw-notion-status');
  if (notionStatus) notionStatus.style.borderColor = 'rgba(34,197,94,.4)';
  const notionConnBtn = document.getElementById('claw-notion-connect-btn');
  if (notionConnBtn) notionConnBtn.style.display = 'none';
  if (_clawPermPanelOpen) loadClawPermissions();
}

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
  // T5: Show guest fallback immediately so button never shows blank
  const elInitial = document.getElementById('token-balance-display');
  if (elInitial && !elInitial.textContent) {
    elInitial.textContent = FS_USER ? '…' : '1.5k';
  }
  if (!FS_USER) {
    // Guest: show 1,500 daily limit as a hint
    _tokenBalance = { dailyUsed: 0, dailyLimit: 1500, purchased: 0, tier: 'free', remaining: 1500 };
    const el = document.getElementById('token-balance-display');
    if (el) el.textContent = '1.5k';
    const btn = document.getElementById('btn-topup');
    if (btn) btn.title = '1,500 free tokens/day — Sign in to track usage';
    return;
  }
  try {
    const r = await fetch('/api/billing/balance', { credentials: 'include' });
    if (!r.ok) return;
    const data = await r.json();
    if (data.error) return;
    _tokenBalance = data;
    const fmt = n => n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M'
                   : n >= 1_000     ? Math.round(n/1_000)+'k'
                   : String(n);
    const el = document.getElementById('token-balance-display');
    if (el) {
      const purchased = _tokenBalance.purchased || 0;
      const dailyLeft = Math.max(0, (_tokenBalance.dailyLimit || 1500) - (_tokenBalance.dailyUsed || 0));
      const isPro = _tokenBalance.tier === 'pro' || _tokenBalance.tier === 'team';
      // Show: daily remaining (not combined with purchased to avoid confusion)
      el.textContent = fmt(dailyLeft);
      const btn = document.getElementById('btn-topup');
      if (btn) {
        const purchasedNote = purchased > 0 ? ` · ${purchased.toLocaleString()} purchased tokens` : '';
        const tierNote = isPro ? ' · Pro plan' : ' · Free plan (1,500/day)';
        btn.title = `${dailyLeft.toLocaleString()} daily tokens remaining${purchasedNote}${tierNote} — click to buy more`;
        // Show coin icon different color when purchased tokens exist
        const icon = btn.querySelector('i');
        if (icon) icon.style.color = purchased > 0 ? '#f59e0b' : '#10b981';
      }
    }
    const isPro = _tokenBalance?.tier === 'pro' || _tokenBalance?.tier === 'team';
    const meter = document.getElementById('chat-token-meter');
    if (meter && !isPro) {
      const used  = _tokenBalance.dailyUsed  || 0;
      const limit = _tokenBalance.dailyLimit || 1500;
      const pct   = Math.min(100, Math.round((used / limit) * 100));
      const left  = Math.max(0, limit - used);
      meter.style.display = 'block';
      const label = document.getElementById('chat-token-label');
      const bar   = document.getElementById('chat-token-bar');
      const sub   = document.getElementById('chat-token-sub');
      if (label) label.textContent = `${used.toLocaleString()} / ${limit.toLocaleString()} tokens used today`;
      if (bar)   { bar.style.width = pct + '%'; bar.style.background = pct > 80 ? 'linear-gradient(90deg,#f59e0b,#ef4444)' : 'linear-gradient(90deg,#a855f7,#ec4899)'; }
      if (sub)   sub.textContent = left > 0 ? `${left.toLocaleString()} tokens left today` : '⚠️ Daily limit reached — buy more or wait until midnight';
      if (!isPro) checkTokenUpgradeTrigger(used, limit);
    } else if (meter && isPro) {
      meter.style.display = 'none';
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

// ═══════════════════════════════════════════════════════════════════════════
// ── Higgsfield AI Studio ── Pro-only cinematic video generation ────────────
// ═══════════════════════════════════════════════════════════════════════════

let _higgsModel    = 'seedance-v2.0-t2v';
let _higgsModelName = 'Seedance 2.0';
let _higgsType     = 't2v';  // 't2v' or 'i2v'
let _higgsMaxDur   = 15;
let _higgsPollTimer = null;

function initHiggsfield() {
  // Check if user is Pro — show gate if not
  const tier = FS_USER?.tier || 'free';
  const isPro = ['personal_pro','team_starter','team_growth','enterprise','clawflow'].includes(tier);
  const gate = document.getElementById('higgs-gate-banner');
  if (gate) gate.style.display = isPro ? 'none' : 'block';
  // Set default model
  selectHiggsModel('seedance-v2.0-t2v', 'Seedance 2.0', 't2v', 15);
}

function selectHiggsModel(modelId, name, type, maxDur) {
  _higgsModel     = modelId;
  _higgsModelName = name;
  _higgsType      = type;
  _higgsMaxDur    = maxDur;

  // Update card selection
  document.querySelectorAll('.higgs-model-card').forEach(c => {
    c.classList.toggle('active', c.dataset.model === modelId);
  });

  // Show/hide image URL row
  const imgRow = document.getElementById('higgs-img-row');
  if (imgRow) imgRow.style.display = type === 'i2v' ? 'block' : 'none';

  // Cap duration select to model max
  const durSel = document.getElementById('higgs-duration');
  if (durSel) {
    Array.from(durSel.options).forEach(opt => {
      opt.disabled = parseInt(opt.value) > maxDur;
    });
    if (parseInt(durSel.value) > maxDur) durSel.value = String(maxDur);
  }

  // Update model info sidebar
  const info = document.getElementById('higgs-model-info');
  const descriptions = {
    'seedance-v2.0-t2v':    'ByteDance Seedance 2.0 — flagship cinematic model. Native audio sync, multi-shot storytelling, frame-level control. Up to 15s.',
    'seedance-v2.0-i2v':    'Seedance 2.0 Image-to-Video. Animates your reference image with consistent characters and smooth motion. Up to 15s.',
    'seedance-v2.0-t2v-fx': 'Seedance FX — specialized for particle effects, fire, explosions, and physics-driven motion. Up to 10s.',
    'wan2.6-t2v':           'Wan 2.6 by Alibaba — high motion fidelity, 1080p capable. Excellent for realistic human motion and dynamic scenes. Up to 15s.',
    'wan2.6-i2v':           'Wan 2.6 Image-to-Video — smooth animated transitions from a reference image. Great for product shots and portraits.',
    'kling-v3.0-pro-t2v':   'Kling v3 Pro — professional cinema quality, 1080p output. Best for high-end commercial and narrative content. Up to 10s.',
  };
  if (info) info.textContent = descriptions[modelId] || 'Select a model to see details.';
}

async function runHiggsfield() {
  const tier  = FS_USER?.tier || 'free';
  const isPro = ['personal_pro','team_starter','team_growth','enterprise','clawflow'].includes(tier);
  if (!isPro) {
    alert('Higgsfield AI requires a Pro subscription. Upgrade at flowst8.cc to unlock.');
    return;
  }

  const prompt   = (document.getElementById('higgs-prompt')?.value || '').trim();
  const imageUrl = (document.getElementById('higgs-img-url')?.value || '').trim();
  const duration = parseInt(document.getElementById('higgs-duration')?.value || '10');
  const aspect   = document.getElementById('higgs-aspect')?.value  || '16:9';
  const quality  = document.getElementById('higgs-quality')?.value || 'high';

  if (!prompt && !imageUrl) { alert('Please enter a prompt to generate.'); return; }
  if (_higgsType === 'i2v' && !imageUrl) { alert('This model requires an image URL for Image-to-Video.'); return; }

  // Update UI
  const btn = document.getElementById('btn-higgs-gen');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&nbsp; Generating…'; }
  const prog = document.getElementById('higgs-progress');
  const progMsg = document.getElementById('higgs-progress-msg');
  const progBar = document.getElementById('higgs-progress-bar');
  const result  = document.getElementById('higgs-result');
  if (prog)   { prog.style.display = 'block'; }
  if (result) { result.style.display = 'none'; result.innerHTML = ''; }
  if (progMsg) progMsg.textContent = 'Sending to Higgsfield…';
  if (progBar) progBar.style.width = '8%';

  genSidebarLog('higgsfield', `▶ ${_higgsModelName} — "${prompt.slice(0,50)}${prompt.length>50?'…':''}"`, '');

  try {
    const res = await fetch('/api/higgsfield/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ model: _higgsModel, prompt, imageUrl: imageUrl || undefined, duration, aspectRatio: aspect, quality }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      const msg = data.message || data.error || 'Generation failed';
      showHiggsError(msg);
      if (data.upgradeUrl) {
        genSidebarLog('higgsfield', '⚠ Pro required — <a href="/#pricing" style="color:#00d4ff">Upgrade</a>', 'error');
      }
      return;
    }

    if (data.status === 'complete' && data.videoUrl) {
      showHiggsResult(data.videoUrl, prompt);
      return;
    }

    if (data.status === 'queued' && data.requestId) {
      if (progMsg) progMsg.textContent = data.message || 'Queued — generating your video…';
      if (progBar) progBar.style.width = '15%';
      genSidebarLog('higgsfield', `⏳ Queued: ${data.requestId.slice(0,12)}…`, '');
      pollHiggsfield(data.requestId, prompt, 0);
      return;
    }

    showHiggsError('Unexpected response from Higgsfield.');
  } catch (e) {
    showHiggsError('Network error — please try again.');
  }
}

function pollHiggsfield(requestId, prompt, attempt) {
  if (attempt > 90) {
    showHiggsError('Generation timed out (3 min). Try a shorter duration or simpler prompt.');
    return;
  }
  const progBar = document.getElementById('higgs-progress-bar');
  const progMsg = document.getElementById('higgs-progress-msg');

  _higgsPollTimer = setTimeout(async () => {
    try {
      const res  = await fetch(`/api/higgsfield/poll/${requestId}`, { credentials: 'include' });
      const data = await res.json();

      if (data.status === 'complete' && data.videoUrl) {
        showHiggsResult(data.videoUrl, prompt);
        genSidebarLog('higgsfield', `✓ Done! <a href="${data.videoUrl}" target="_blank" style="color:#00ffa3">Download</a>`, 'success');
        return;
      }
      if (data.status === 'error') {
        showHiggsError(data.error || 'Generation failed');
        genSidebarLog('higgsfield', `✗ Error: ${data.error}`, 'error');
        return;
      }
      // Still processing
      const pct = data.percent || Math.min(15 + attempt * 2, 88);
      if (progBar) progBar.style.width = pct + '%';
      if (progMsg) progMsg.textContent = `Generating… ${pct}%`;
      pollHiggsfield(requestId, prompt, attempt + 1);
    } catch {
      pollHiggsfield(requestId, prompt, attempt + 1);
    }
  }, attempt < 5 ? 4000 : 6000);
}

function showHiggsResult(videoUrl, prompt) {
  const btn    = document.getElementById('btn-higgs-gen');
  const prog   = document.getElementById('higgs-progress');
  const result = document.getElementById('higgs-result');
  if (btn)  { btn.disabled = false; btn.innerHTML = '<i class="fas fa-film"></i>&nbsp; Generate with Higgsfield'; }
  if (prog) { prog.style.display = 'none'; }
  if (!result) return;
  result.style.display = 'block';
  result.innerHTML = `
    <div style="background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.2);border-radius:14px;padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:18px">✦</span>
        <span style="font-size:13px;font-weight:800;color:#00d4ff">Generation Complete</span>
        <span style="margin-left:auto;font-size:10px;color:rgba(0,212,255,.5)">${_higgsModelName}</span>
      </div>
      <video src="${videoUrl}" controls style="width:100%;border-radius:10px;background:#000;max-height:300px" preload="metadata"></video>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <a href="${videoUrl}" download target="_blank" style="background:linear-gradient(135deg,#00d4ff,#00ffa3);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:800;text-decoration:none;display:inline-flex;align-items:center;gap:6px">
          <i class="fas fa-download"></i> Download MP4
        </a>
        <button onclick="this.closest('div').previousElementSibling && navigator.clipboard.writeText('${videoUrl}')" style="background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.25);color:#00d4ff;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer">
          <i class="fas fa-copy"></i> Copy URL
        </button>
        <button onclick="document.getElementById('higgs-result').style.display='none';document.getElementById('btn-higgs-gen').disabled=false;document.getElementById('btn-higgs-gen').innerHTML='<i class=\\'fas fa-film\\'></i>&nbsp; Generate with Higgsfield'" style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.5);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer">
          ↺ New Generation
        </button>
      </div>
      <div style="margin-top:8px;font-size:11px;color:rgba(255,255,255,.35);line-height:1.5">"${prompt.slice(0,120)}${prompt.length>120?'…':''}"</div>
    </div>`;
}

function showHiggsError(msg) {
  const btn  = document.getElementById('btn-higgs-gen');
  const prog = document.getElementById('higgs-progress');
  const res  = document.getElementById('higgs-result');
  if (btn)  { btn.disabled = false; btn.innerHTML = '<i class="fas fa-film"></i>&nbsp; Generate with Higgsfield'; }
  if (prog) { prog.style.display = 'none'; }
  if (!res) return;
  res.style.display = 'block';
  res.innerHTML = `<div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:12px;padding:14px 16px;color:#ef4444;font-size:13px">
    <strong>✗ Error:</strong> ${msg}
  </div>`;
  genSidebarLog('higgsfield', `✗ ${msg}`, 'error');
}

// ═══════════════════════════════════════════════════════════════════════════
// CLAW PERMISSIONS SYSTEM — client-side
// Mirrors the backend permission model:
//   Layer 1 (read/observe): always on
//   Layer 2 (suggest):      always on
//   Layer 3 (act):          user must toggle on
// ═══════════════════════════════════════════════════════════════════════════

let _clawPermsLoaded = false;
let _clawPerms = {}; // { slack_post: true, notion_write: false, … }
let _clawPermLabels = {}; // populated from server
let _clawPermPanelOpen = false;

// Toggle the permissions panel open/closed
function toggleClawPermPanel() {
  const panel = document.getElementById('claw-perm-panel');
  if (!panel) return;
  _clawPermPanelOpen = !_clawPermPanelOpen;
  panel.style.display = _clawPermPanelOpen ? 'block' : 'none';
  if (_clawPermPanelOpen && !_clawPermsLoaded) loadClawPermissions();
}

// Load permissions from server + render
async function loadClawPermissions() {
  // Update integration status rows
  const slackLbl = document.getElementById('claw-slack-label');
  const notionLbl = document.getElementById('claw-notion-label');
  const slackConnBtn = document.getElementById('claw-slack-connect-btn');
  const notionConnBtn = document.getElementById('claw-notion-connect-btn');
  const slackStatus = document.getElementById('claw-slack-status');
  const notionStatus = document.getElementById('claw-notion-status');

  if (slackLbl) {
    if (FS_SLACK) {
      slackLbl.textContent = `Slack: ${FS_SLACK.team || 'connected'}`;
      if (slackStatus) slackStatus.style.borderColor = 'rgba(34,197,94,.4)';
    } else {
      slackLbl.textContent = 'Slack: not connected';
      if (slackConnBtn) slackConnBtn.style.display = 'inline-block';
    }
  }
  if (notionLbl) {
    if (FS_NOTION) {
      notionLbl.textContent = `Notion: ${FS_NOTION.workspace || 'connected'}`;
      if (notionStatus) notionStatus.style.borderColor = 'rgba(34,197,94,.4)';
    } else {
      notionLbl.textContent = 'Notion: not connected';
      if (notionConnBtn) notionConnBtn.style.display = 'inline-block';
    }
  }

  // Fetch current grants from server
  try {
    const r = await fetch('/api/claw/permissions');
    if (!r.ok) { renderPermToggles({}); return; }
    const data = await r.json();
    _clawPerms = data.permissions || {};
    _clawPermLabels = data.labels || {};
    _clawPermsLoaded = true;
    renderPermToggles(_clawPerms);
  } catch {
    renderPermToggles({});
  }
}

// Render toggles grid
function renderPermToggles(perms) {
  const container = document.getElementById('claw-perm-toggles');
  if (!container) return;

  // Permission groups for clean presentation
  const groups = [
    { heading: '🧠 Learning', keys: ['memory_learn'] },
    { heading: '💬 Slack', keys: ['slack_read', 'slack_post', 'slack_standup'], requires: 'slack' },
    { heading: '📝 Notion', keys: ['notion_read', 'notion_write', 'notion_tasks'], requires: 'notion' },
    { heading: '⚡ Advanced', keys: ['autopilot'] },
  ];

  let html = '';
  for (const group of groups) {
    const isConnected = !group.requires
      || (group.requires === 'slack' && FS_SLACK)
      || (group.requires === 'notion' && FS_NOTION);
    const lockHtml = !isConnected
      ? `<span style="font-size:10px;color:var(--text-s);margin-left:6px">Connect ${group.requires} first</span>`
      : '';
    html += `<div style="margin-bottom:4px"><div style="font-size:11px;font-weight:700;color:var(--text-m);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">${group.heading}${lockHtml}</div>`;
    for (const key of group.keys) {
      const meta = _clawPermLabels[key] || { label: key, desc: '', icon: '•', risk: 'low' };
      const enabled = !!perms[key];
      const disabled = !isConnected;
      const riskColor = meta.risk === 'high' ? '#ef4444' : meta.risk === 'medium' ? '#f59e0b' : '#22c55e';
      html += `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:8px 10px;background:var(--bg-panel);border-radius:8px;border:1px solid var(--border);${disabled ? 'opacity:.45;' : ''}">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;margin-bottom:2px">${meta.icon} ${meta.label}
              <span style="font-size:9px;padding:1px 5px;border-radius:4px;margin-left:4px;background:${riskColor}22;color:${riskColor};font-weight:700;text-transform:uppercase">${meta.risk}</span>
            </div>
            <div style="font-size:11px;color:var(--text-s);line-height:1.4">${meta.desc}</div>
          </div>
          <label class="claw-toggle" style="margin-left:10px;flex-shrink:0">
            <input type="checkbox" ${enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="saveClawPermission('${key}', this.checked)">
            <span class="claw-toggle-track"></span>
          </label>
        </div>`;
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

// Save a single permission change to server
async function saveClawPermission(key, value) {
  _clawPerms[key] = value;
  try {
    await fetch('/api/claw/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
    notify(`Claw permission updated: ${value ? 'enabled' : 'disabled'}`, 'info');
  } catch {
    notify('Could not save permission — check your connection', 'error');
  }
}

// Get list of connected integrations (used when sending messages)
function getConnectedIntegrations() {
  const connected = [];
  if (FS_SLACK) connected.push('slack');
  if (FS_NOTION) connected.push('notion');
  return connected;
}

// ── Action Execution Engine ───────────────────────────────────────────────

// Execute a Claw-suggested action after user confirmation
async function executeClawAction(action, params) {
  const reqPerm = {
    slack_post: 'slack_post', slack_standup: 'slack_standup',
    notion_create_task: 'notion_tasks', notion_update_page: 'notion_write',
  }[action];

  // Check if permission is granted (client-side fast path)
  if (reqPerm && !_clawPerms[reqPerm] && _clawPermsLoaded) {
    // Open permissions panel and prompt
    if (!_clawPermPanelOpen) toggleClawPermPanel();
    appendClawbotMsg('ai',
      `I need the **${_clawPermLabels[reqPerm]?.label || reqPerm}** permission to do that. Toggle it on in the Claw Permissions panel below.`,
      'Clawbot'
    );
    return;
  }

  // Check if integration is connected
  if ((action.startsWith('slack') && !FS_SLACK) || (action.startsWith('notion') && !FS_NOTION)) {
    const which = action.startsWith('slack') ? 'Slack' : 'Notion';
    appendClawbotMsg('ai',
      `I need ${which} connected to do that. [Connect ${which}](${which === 'Slack' ? '/api/auth/slack' : '/api/auth/notion'}) and I'll be ready.`,
      'Clawbot'
    );
    return;
  }

  try {
    const r = await fetch('/api/claw/execute-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    });
    const data = await r.json();

    if (data.needsPermission) {
      // Shouldn't happen after client check but handle gracefully
      if (!_clawPermPanelOpen) toggleClawPermPanel();
      appendClawbotMsg('ai', `I need permission to do that — check Claw Permissions below.`, 'Clawbot');
      return;
    }
    if (data.needsIntegration) {
      const which = data.integration;
      appendClawbotMsg('ai',
        `I need ${which} connected first. Open **Settings → Integrations** to connect.`,
        'Clawbot'
      );
      return;
    }
    if (data.ok) {
      const successMsg = data.message || `✓ Done: ${action}`;
      appendClawbotMsg('ai', successMsg, 'Clawbot');
    } else {
      appendClawbotMsg('ai', `✗ Couldn't complete that action: ${data.error || 'unknown error'}`, 'Clawbot');
    }
  } catch {
    appendClawbotMsg('ai', '✗ Network error executing action — please try again.', 'Clawbot');
  }
}

// Render an inline action confirmation card inside a message bubble
function renderActionCards(actions) {
  if (!actions || !actions.length) return '';
  const connected = getConnectedIntegrations();

  return actions.map(a => {
    const isExternal = a.action === 'slack_post' || a.action === 'slack_standup'
      || a.action === 'notion_create_task' || a.action === 'notion_update_page';
    const needsConnect = isExternal && (
      (a.action.startsWith('slack') && !connected.includes('slack'))
      || (a.action.startsWith('notion') && !connected.includes('notion'))
    );

    let label = '', icon = '';
    if (a.action === 'slack_post' || a.action === 'slack_standup') {
      icon = '💬'; label = `Post to ${a.channel || 'Slack'}`;
    } else if (a.action === 'notion_create_task') {
      icon = '✅'; label = `Create task: "${(a.title || 'Task').slice(0, 40)}"`;
    } else if (a.action === 'notion_update_page') {
      icon = '📝'; label = `Update Notion page`;
    } else if (a.action === 'tool') {
      icon = '⚙️'; label = `Run AI tool: ${a.tool}`;
    } else if (a.action === 'generate_video') {
      icon = '🎬'; label = `Generate video (${a.model || ''})`;
    } else {
      icon = '⚡'; label = a.action;
    }

    const safeParams = JSON.stringify(a).replace(/'/g, '&#39;').replace(/"/g, '&quot;');

    if (needsConnect) {
      const which = a.action.startsWith('slack') ? 'Slack' : 'Notion';
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;margin-top:6px;background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.2);border-radius:8px;font-size:12px">
        <span>${icon} ${label}</span>
        <button onclick="connectSlack()" style="font-size:11px;padding:3px 9px;border:none;background:rgba(168,85,247,.2);color:#a855f7;border-radius:6px;cursor:pointer;font-weight:600">Connect ${which}</button>
      </div>`;
    }

    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;margin-top:6px;background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.2);border-radius:8px;font-size:12px">
      <span style="color:var(--text)">${icon} ${label}</span>
      <div style="display:flex;gap:5px">
        <button onclick="executeClawAction('${a.action}', JSON.parse(this.closest('[data-params]').dataset.params))" data-action="${a.action}" style="font-size:11px;padding:3px 9px;border:none;background:rgba(6,182,212,.2);color:#06b6d4;border-radius:6px;cursor:pointer;font-weight:600">Run</button>
      </div>
    </div><span data-params="${safeParams}" style="display:none"></span>`;
  }).join('');
}

// ── Updated sendClawbotMessage — injects integrations + parses action cards ──
// We override the previous version
async function sendClawbotMessage() {
  const inp = document.getElementById('clawbot-in');
  const msg = inp ? inp.value.trim() : '';
  if (!msg) return;
  if (inp) { inp.value = ''; inp.style.height = '42px'; }
  appendClawbotMsg('user', msg, '');
  const tid = appendClawbotTyping();
  const appCtx = _clawCtx || 'flowstate_hub';
  const connectedIntegrations = getConnectedIntegrations();

  try {
    const res = await fetch('/api/clawbot/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msg,
        app: appCtx,
        history: clawbotHistory.slice(-8),
        connectedIntegrations,
      }),
    });
    const data = await res.json();
    removeTyping(tid);

    if (data.error === 'clawflow_required') {
      appendClawbotMsg('ai', '⚡ ClawFlow subscription required to continue. Upgrade below ↓', 'Clawbot');
      document.getElementById('clawbot-active').style.display = 'none';
      document.getElementById('clawbot-gate').style.display = 'block';
      loadClawbotPromo();
      return;
    }

    const reply = data.reply || 'No response.';
    // Append message with optional action cards
    appendClawbotMsgWithActions('ai', reply, `Clawbot · ${data.coinCost || 0} coins`, data.actions || []);
    clawbotHistory.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });

    const badge = document.getElementById('clawbot-coins-badge');
    if (badge && data.coinCost) {
      const cur = parseInt(badge.textContent.replace(/[^0-9]/g, '')) || 500;
      badge.textContent = `⚡ ${Math.max(0, cur - data.coinCost)} coins`;
    }
    if (/how|stuck|help|tutorial|walkthrough|can't|doesn't work|not working/i.test(msg) && Math.random() > 0.4) {
      setTimeout(() => offerWalkthrough(msg, appCtx), 1200);
    }
  } catch (e) {
    removeTyping(tid);
    appendClawbotMsg('ai', 'Connection error — check your network.', 'Error');
  }
}

// Append a message with optional action confirmation cards below the bubble
function appendClawbotMsgWithActions(role, text, label, actions) {
  const msgs = document.getElementById('clawbot-msgs');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const av = role === 'ai'
    ? `<div class="msg-av" style="background:linear-gradient(135deg,#a855f7,#06b6d4);overflow:hidden;padding:0"><img src="/static/clawbot-mascot.png" style="width:100%;height:100%;object-fit:cover"></div>`
    : `<div class="msg-av" style="background:var(--bg-card)">👤</div>`;
  const meta = role === 'ai'
    ? `<div class="msg-meta"><span class="m-tag" style="background:rgba(6,182,212,.15);color:#06b6d4">Clawbot</span><span style="font-size:11px;color:var(--text-m)">${label}</span></div>`
    : '';
  const actionCards = actions && actions.length ? renderActionCards(actions) : '';
  div.innerHTML = `${av}<div style="flex:1">${meta}<div class="msg-bub">${formatMsg(text)}</div>${actionCards}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ── Show Claw Action Log Modal ────────────────────────────────────────────
async function showClawActionLog() {
  const modal = document.getElementById('claw-log-modal');
  const entries = document.getElementById('claw-log-entries');
  if (!modal || !entries) return;
  modal.style.display = 'flex';
  entries.innerHTML = '<div style="color:var(--text-s);text-align:center;padding:20px">Loading…</div>';

  try {
    const r = await fetch('/api/claw/action-log');
    const data = await r.json();
    const actions = data.actions || [];
    if (!actions.length) {
      entries.innerHTML = '<div style="color:var(--text-s);text-align:center;padding:20px">No actions logged yet.<br>Actions Claw executes on your behalf will appear here.</div>';
      return;
    }
    entries.innerHTML = actions.map(a => {
      const ts = a.timestamp ? new Date(a.timestamp).toLocaleString() : '';
      const statusColor = a.status === 'success' ? '#22c55e' : a.status === 'denied' ? '#ef4444' : '#f59e0b';
      return `<div style="padding:8px 10px;background:var(--bg-panel);border-radius:8px;border:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:12px;font-weight:600">${a.action || 'action'}</span>
          <span style="font-size:11px;color:${statusColor};font-weight:700">${a.status || 'ok'}</span>
        </div>
        <div style="font-size:11px;color:var(--text-s);margin-top:2px">${ts}</div>
        ${a.details ? `<div style="font-size:11px;color:var(--text-m);margin-top:3px">${a.details}</div>` : ''}
      </div>`;
    }).join('');
  } catch {
    entries.innerHTML = '<div style="color:#ef4444;text-align:center;padding:20px">Could not load action log.</div>';
  }
}

// ── Claw Onboarding Step ──────────────────────────────────────────────────
// Called from renderObStep when step === 4
function renderClawOnboardingStep() {
  return `
    <div style="text-align:center;margin-bottom:18px;display:flex;flex-direction:column;align-items:center">
      <img src="/static/clawbot-mascot.png" style="width:100px;height:100px;object-fit:contain;display:block;margin:0 auto 12px">
      <h2 style="font-size:18px;font-weight:900;margin:0 0 6px">Meet Claw</h2>
      <p style="font-size:13px;color:var(--text-m);margin:0 0 16px;line-height:1.6">Claw is your AI brain for the Flowstate ecosystem.<br>Choose what Claw is allowed to do on your behalf.</p>
    </div>
    <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:18px">
      ${[
        { icon: '🧠', label: 'Learn my preferences', desc: 'Claw improves over time by remembering your style', key: 'memory_learn', default: true },
        { icon: '💬', label: 'Post to Slack', desc: 'With your confirmation — Claw suggests, you approve', key: 'slack_post', default: false, req: 'slack' },
        { icon: '📝', label: 'Create Notion tasks', desc: 'Log milestones and tasks from your workflow', key: 'notion_tasks', default: false, req: 'notion' },
        { icon: '⚡', label: 'Autopilot', desc: 'Claw acts on pre-approved actions without asking each time', key: 'autopilot', default: false },
      ].map(p => `
        <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer">
          <input type="checkbox" id="ob-claw-${p.key}" ${p.default ? 'checked' : ''} style="accent-color:#a855f7;width:16px;height:16px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:700">${p.icon} ${p.label}</div>
            <div style="font-size:11px;color:var(--text-s)">${p.desc}${p.req ? ` · <em>Requires ${p.req} connected</em>` : ''}</div>
          </div>
        </label>`).join('')}
    </div>
    <p style="font-size:11px;color:var(--text-s);text-align:center">You can change these any time in <strong>Claw Permissions</strong> inside the Clawbot tab.</p>`;
}

// Save claw onboarding permissions and continue
async function saveClawOnboardingPerms() {
  const keys = ['memory_learn', 'slack_post', 'notion_tasks', 'autopilot'];
  const grants = {};
  keys.forEach(k => {
    const el = document.getElementById(`ob-claw-${k}`);
    if (el) grants[k] = el.checked;
  });
  try {
    await fetch('/api/claw/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(grants),
    });
    _clawPerms = { ..._clawPerms, ...grants };
    _clawPermsLoaded = true;
  } catch { /* non-blocking */ }
}

// Add CSS for permission toggles (injected once)
(function injectClawStyles() {
  if (document.getElementById('claw-perm-css')) return;
  const s = document.createElement('style');
  s.id = 'claw-perm-css';
  s.textContent = `
    .claw-toggle { position:relative; display:inline-block; width:38px; height:20px; }
    .claw-toggle input { opacity:0; width:0; height:0; }
    .claw-toggle-track {
      position:absolute; inset:0; border-radius:20px;
      background:var(--border); cursor:pointer; transition:.2s;
    }
    .claw-toggle-track::before {
      content:''; position:absolute; width:14px; height:14px;
      border-radius:50%; background:#fff; top:3px; left:3px; transition:.2s;
    }
    .claw-toggle input:checked + .claw-toggle-track { background:linear-gradient(135deg,#a855f7,#06b6d4); }
    .claw-toggle input:checked + .claw-toggle-track::before { transform:translateX(18px); }
    .claw-toggle input:disabled + .claw-toggle-track { opacity:.5; cursor:not-allowed; }
  `;
  document.head.appendChild(s);
})();

// ═══════════════════════════════════════════════════════════════════════════
// ── CLAW VIDEO PRODUCTION WIZARD ──────────────────────────────────────────
// Entry points: openClawVideoWizard() from anywhere in the ecosystem.
// Supports: audio context (from FS Audio export), manual prompt, 264 Pro hand-off.
// ═══════════════════════════════════════════════════════════════════════════

// Wizard state
let _cvw = {
  step: 0,           // 0=intent, 1=concept, 2=shotlist, 3=upload, 4=generate, 5=done
  style: 'cinematic',
  prompt: '',
  audioContext: null, // { trackName, bpm, key, genre, duration }
  concept: null,
  shots: [],
  imageUrls: [],     // user-uploaded reference URLs
  selectedModel: 'seedance_t2v',
  jobId: null,
  provider: null,
  pollTimer: null,
  fromAudio: false,
};

const CVW_STYLES = [
  { id: 'cinematic',    icon: '🎬', label: 'Cinematic',    desc: 'Epic wide shots, dramatic lighting' },
  { id: 'music_video',  icon: '🎵', label: 'Music Video',  desc: 'High energy, beat-synced cuts' },
  { id: 'documentary',  icon: '📽', label: 'Documentary',  desc: 'Authentic, natural moments' },
  { id: 'short_film',   icon: '🎞', label: 'Short Film',   desc: 'Narrative arc, story-driven' },
  { id: 'social',       icon: '📱', label: 'Social / Reels', desc: 'Vertical, fast, scroll-stopping' },
];

const CVW_MODELS = [
  { id: 'seedance_t2v',   label: 'Seedance 2.0',  badge: 'Best',   desc: 'ByteDance flagship — multi-shot, 15s, audio sync' },
  { id: 'wan_t2v',        label: 'Wan 2.6',        badge: 'Fast',   desc: 'Alibaba — 1080p, great motion fidelity' },
  { id: 'higgsfield_t2v', label: 'Higgsfield',     badge: 'Cinematic', desc: 'Cinematic film quality, dramatic composition' },
];

/**
 * Main entry point — call from anywhere.
 * @param {object} opts  Optional { prompt, audioContext, fromAudio }
 */
function openClawVideoWizard(opts) {
  opts = opts || {};
  // Reset state
  _cvw = {
    step: 0,
    style: 'cinematic',
    prompt: opts.prompt || '',
    audioContext: opts.audioContext || null,
    concept: null,
    shots: [],
    imageUrls: [],
    selectedModel: 'seedance_t2v',
    jobId: null,
    provider: null,
    pollTimer: null,
    fromAudio: !!opts.audioContext,
  };
  if (_cvw.pollTimer) clearInterval(_cvw.pollTimer);
  _cvwRender();
}

function _cvwRender() {
  // Build the modal content for the current step
  let content = '';
  const steps = ['Idea', 'Concept', 'Shot List', 'References', 'Generate', 'Done'];
  const stepDots = steps.map((s, i) => {
    const active = i === _cvw.step;
    const done   = i < _cvw.step;
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">
      <div style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;
        background:${done ? 'linear-gradient(135deg,#a855f7,#06b6d4)' : active ? 'rgba(168,85,247,.25)' : 'var(--border)'};
        border:2px solid ${active ? '#a855f7' : done ? 'transparent' : 'var(--border)'};
        color:${active||done ? '#fff' : 'var(--text-s)'}">
        ${done ? '✓' : i + 1}
      </div>
      <span style="font-size:9px;color:${active ? '#a855f7' : 'var(--text-s)'};font-weight:${active?700:400}">${s}</span>
    </div>`;
  }).join('<div style="height:2px;background:var(--border);flex:1;margin-top:13px;align-self:flex-start"></div>');

  const header = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
      <span style="font-size:22px">🎬</span>
      <div>
        <div style="font-size:16px;font-weight:800;background:linear-gradient(135deg,#a855f7,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">CLAW Video</div>
        <div style="font-size:11px;color:var(--text-s)">Production Director AI</div>
      </div>
    </div>
    <div style="display:flex;align-items:flex-start;gap:0;margin-bottom:22px">${stepDots}</div>`;

  if (_cvw.step === 0) content = _cvwStepIntent(header);
  else if (_cvw.step === 1) content = _cvwStepGenerating(header);
  else if (_cvw.step === 2) content = _cvwStepShotList(header);
  else if (_cvw.step === 3) content = _cvwStepUpload(header);
  else if (_cvw.step === 4) content = _cvwStepGenerate(header);
  else if (_cvw.step === 5) content = _cvwStepDone(header);

  openModal(content, true);
}

// ── Step 0: Intent capture ─────────────────────────────────────────────────
function _cvwStepIntent(header) {
  const audioHint = _cvw.audioContext
    ? `<div style="background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.3);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#c084fc">
        🎵 Audio project detected: <strong>${_cvw.audioContext.trackName || 'Untitled'}</strong>${_cvw.audioContext.bpm ? ` · ${_cvw.audioContext.bpm} BPM` : ''}${_cvw.audioContext.genre ? ` · ${_cvw.audioContext.genre}` : ''}
        <br><span style="color:var(--text-s);font-size:11px;margin-top:3px;display:block">CLAW will align visuals to your track's mood and tempo</span>
      </div>`
    : '';

  const styleChips = CVW_STYLES.map(s =>
    `<button onclick="_cvwSelectStyle('${s.id}')" style="
      display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 8px;
      border-radius:10px;border:2px solid ${_cvw.style===s.id ? '#a855f7' : 'var(--border)'};
      background:${_cvw.style===s.id ? 'rgba(168,85,247,.12)' : 'var(--surface)'};
      cursor:pointer;flex:1;min-width:0;transition:.15s">
      <span style="font-size:18px">${s.icon}</span>
      <span style="font-size:11px;font-weight:700;color:${_cvw.style===s.id ? '#a855f7' : 'var(--text)'}">${s.label}</span>
      <span style="font-size:9px;color:var(--text-s);text-align:center;line-height:1.3">${s.desc}</span>
    </button>`
  ).join('');

  return `${header}
    ${audioHint}
    <div style="margin-bottom:14px">
      <label style="font-size:12px;font-weight:700;color:var(--text-m);display:block;margin-bottom:6px">What's your video about?</label>
      <textarea id="cvw-prompt" class="chat-in" style="width:100%;height:70px;resize:none;font-size:13px"
        placeholder="Describe your vision — or leave blank and CLAW will create one from your audio context…"
        oninput="_cvw.prompt=this.value">${_cvw.prompt}</textarea>
    </div>
    <div style="margin-bottom:18px">
      <label style="font-size:12px;font-weight:700;color:var(--text-m);display:block;margin-bottom:8px">Visual Style</label>
      <div style="display:flex;gap:6px">${styleChips}</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-primary" style="flex:1;background:linear-gradient(135deg,#a855f7,#06b6d4)" onclick="_cvwGenerateConcept()">
        ✨ Generate Concept
      </button>
      <button class="btn-sm" onclick="closeModal()">Cancel</button>
    </div>
    <div style="margin-top:10px;font-size:11px;color:var(--text-s);text-align:center">Free · No generation credits used until Step 5</div>`;
}

function _cvwSelectStyle(styleId) {
  _cvw.style = styleId;
  _cvwRender();
}

// ── Step 1: Generating concept (loading state) ─────────────────────────────
function _cvwStepGenerating(header) {
  return `${header}
    <div style="text-align:center;padding:30px 0">
      <div style="font-size:36px;margin-bottom:12px">🧠</div>
      <div style="font-size:15px;font-weight:700;margin-bottom:6px">CLAW is building your concept…</div>
      <div style="font-size:12px;color:var(--text-s);margin-bottom:20px">Generating theme, visual style, and ${_cvw.audioContext ? 'audio-synced ' : ''}shot list</div>
      <div style="width:100%;height:4px;background:var(--border);border-radius:4px;overflow:hidden">
        <div id="cvw-gen-bar" style="height:100%;width:15%;background:linear-gradient(90deg,#a855f7,#06b6d4);border-radius:4px;transition:width 0.4s"></div>
      </div>
    </div>`;
}

// ── Step 2: Shot list review ───────────────────────────────────────────────
function _cvwStepShotList(header) {
  const c = _cvw.concept;
  const conceptBlock = c ? `
    <div style="background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.25);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:#06b6d4;margin-bottom:8px">✦ CLAW Concept</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:12px">
        <div><span style="color:var(--text-s)">Theme</span><br><strong>${c.theme || '—'}</strong></div>
        <div><span style="color:var(--text-s)">Mood</span><br><strong>${c.mood || '—'}</strong></div>
        <div style="grid-column:span 2"><span style="color:var(--text-s)">Visual Style</span><br><strong>${c.visualStyle || '—'}</strong></div>
        <div style="grid-column:span 2"><span style="color:var(--text-s)">Color Palette</span><br><strong>${c.colorPalette || '—'}</strong></div>
      </div>
    </div>` : '';

  const shotItems = _cvw.shots.map((shot, i) =>
    `<div id="cvw-shot-${i}" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px">
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">
        <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#06b6d4);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0">${shot.id || i+1}</div>
        <div style="flex:1">
          <div style="font-size:12px;font-weight:700;margin-bottom:3px">${shot.scene || 'Scene description'}</div>
          <div style="font-size:11px;color:var(--text-s)">${shot.camera || ''} · ${shot.duration || 4}s</div>
        </div>
        <span style="font-size:10px;color:var(--text-s);white-space:nowrap">${(shot.tags||[]).slice(0,2).join(', ')}</span>
      </div>
      <div style="font-size:11px;color:var(--text-m)">${shot.subject || ''}</div>
    </div>`
  ).join('');

  return `${header}
    ${conceptBlock}
    <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">📋 Shot List (${_cvw.shots.length} shots)</div>
    <div style="max-height:280px;overflow-y:auto;padding-right:4px">${shotItems || '<div style="color:var(--text-s);font-size:12px;padding:20px;text-align:center">No shots generated</div>'}</div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn-primary" style="flex:1;background:linear-gradient(135deg,#a855f7,#06b6d4)" onclick="_cvwStep(3)">
        Looks good →
      </button>
      <button class="btn-sm" onclick="_cvwStep(0)">← Redo</button>
    </div>`;
}

// ── Step 3: Reference image upload ────────────────────────────────────────
function _cvwStepUpload(header) {
  const uploadedPreviews = _cvw.imageUrls.length
    ? _cvw.imageUrls.map((u, i) =>
        `<div style="position:relative;display:inline-block">
          <img src="${u}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;border:2px solid rgba(168,85,247,.4)">
          <button onclick="_cvwRemoveImage(${i})" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:#ef4444;border:none;color:#fff;font-size:10px;cursor:pointer;line-height:1">✕</button>
        </div>`
      ).join('')
    : '';

  return `${header}
    <div style="text-align:center;margin-bottom:18px">
      <div style="font-size:13px;font-weight:700;margin-bottom:4px">Add Reference Images <span style="color:var(--text-s);font-weight:400">(optional)</span></div>
      <div style="font-size:12px;color:var(--text-s)">Upload photos of yourself, locations, or visual references — CLAW will incorporate them into the generation</div>
    </div>
    <div id="cvw-dropzone" style="border:2px dashed rgba(168,85,247,.4);border-radius:12px;padding:28px;text-align:center;cursor:pointer;margin-bottom:14px;transition:.2s"
      onclick="document.getElementById('cvw-file-in').click()"
      ondragover="event.preventDefault();this.style.borderColor='#a855f7'"
      ondragleave="this.style.borderColor='rgba(168,85,247,.4)'"
      ondrop="_cvwHandleDrop(event)">
      <div style="font-size:28px;margin-bottom:6px">📸</div>
      <div style="font-size:13px;font-weight:600;color:var(--text-m)">Drop images here or click to browse</div>
      <div style="font-size:11px;color:var(--text-s);margin-top:4px">JPG, PNG, WebP · Max 5MB each</div>
    </div>
    <input type="file" id="cvw-file-in" accept="image/*" multiple style="display:none" onchange="_cvwHandleFiles(this.files)">
    ${_cvw.imageUrls.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${uploadedPreviews}</div>` : ''}
    <div style="display:flex;gap:8px">
      <button class="btn-primary" style="flex:1;background:linear-gradient(135deg,#a855f7,#06b6d4)" onclick="_cvwStep(4)">
        ${_cvw.imageUrls.length ? `Use ${_cvw.imageUrls.length} image${_cvw.imageUrls.length>1?'s':''} →` : 'Skip — text only →'}
      </button>
      <button class="btn-sm" onclick="_cvwStep(2)">← Back</button>
    </div>`;
}

function _cvwRemoveImage(i) {
  _cvw.imageUrls.splice(i, 1);
  _cvwRender();
}

function _cvwHandleDrop(e) {
  e.preventDefault();
  document.getElementById('cvw-dropzone').style.borderColor = 'rgba(168,85,247,.4)';
  _cvwHandleFiles(e.dataTransfer.files);
}

function _cvwHandleFiles(files) {
  if (!files || !files.length) return;
  Array.from(files).forEach(file => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 5 * 1024 * 1024) { notify('Image too large (max 5MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      _cvw.imageUrls.push(e.target.result);
      _cvwRender();
    };
    reader.readAsDataURL(file);
  });
}

// ── Step 4: Model select + generate ───────────────────────────────────────
function _cvwStepGenerate(header) {
  const isPro = ['personal_pro','team_starter','team_growth','enterprise','clawflow'].includes(FS_USER?.tier || 'free');

  const modelCards = CVW_MODELS.map(m =>
    `<div onclick="${isPro ? `_cvwSelectModel('${m.id}')` : 'openPricingModal()'}" style="
      padding:10px 12px;border-radius:10px;cursor:pointer;
      border:2px solid ${_cvw.selectedModel===m.id ? '#a855f7' : 'var(--border)'};
      background:${_cvw.selectedModel===m.id ? 'rgba(168,85,247,.1)' : 'var(--surface)'};
      transition:.15s;opacity:${isPro?1:0.6}">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;font-weight:700;color:${_cvw.selectedModel===m.id?'#a855f7':'var(--text)'}">${m.label}</span>
        <span style="font-size:9px;padding:2px 7px;border-radius:20px;background:rgba(168,85,247,.15);color:#a855f7;font-weight:700">${m.badge}</span>
        ${!isPro ? '<span style="font-size:9px;padding:2px 7px;border-radius:20px;background:rgba(245,158,11,.15);color:#f59e0b;font-weight:700">Pro</span>' : ''}
      </div>
      <div style="font-size:11px;color:var(--text-s);margin-top:3px">${m.desc}</div>
    </div>`
  ).join('');

  const summaryShots = _cvw.shots.slice(0, 3).map((s, i) =>
    `<div style="font-size:11px;color:var(--text-s);padding:4px 0;border-bottom:1px solid var(--border)">
      <strong style="color:var(--text)">Shot ${i+1}:</strong> ${(s.scene||'').slice(0,65)}${(s.scene||'').length>65?'…':''}
    </div>`
  ).join('');

  return `${header}
    <div style="display:flex;gap:14px;margin-bottom:16px">
      <div style="flex:1">
        <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">AI Model</div>
        <div style="display:flex;flex-direction:column;gap:6px">${modelCards}</div>
        ${!isPro ? `<div style="margin-top:10px;font-size:11px;color:#f59e0b;text-align:center">
          <a onclick="openPricingModal();return false" href="#" style="color:#f59e0b">Upgrade to Pro</a> to generate videos
        </div>` : ''}
      </div>
      <div style="flex:1">
        <div style="font-size:12px;font-weight:700;color:var(--text-m);margin-bottom:8px">Summary</div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px">
          <div style="font-size:11px;color:var(--text-s);margin-bottom:6px">Style: <strong style="color:var(--text)">${_cvw.style}</strong></div>
          <div style="font-size:11px;color:var(--text-s);margin-bottom:8px">Shots: <strong style="color:var(--text)">${_cvw.shots.length}</strong>${_cvw.imageUrls.length ? ` · <strong style="color:var(--text)">${_cvw.imageUrls.length} ref image${_cvw.imageUrls.length>1?'s':''}</strong>` : ''}</div>
          ${summaryShots}
          ${_cvw.shots.length > 3 ? `<div style="font-size:10px;color:var(--text-s);margin-top:4px">+${_cvw.shots.length-3} more shots</div>` : ''}
        </div>
      </div>
    </div>
    <div id="cvw-gen-status" style="display:none;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.2);border-radius:10px;padding:12px;margin-bottom:12px;text-align:center">
      <div id="cvw-gen-msg" style="font-size:13px;color:#c084fc;margin-bottom:8px">Sending to ${_cvw.selectedModel}…</div>
      <div style="width:100%;height:4px;background:var(--border);border-radius:4px;overflow:hidden">
        <div id="cvw-gen-prog" style="height:100%;width:8%;background:linear-gradient(90deg,#a855f7,#06b6d4);border-radius:4px;transition:width 1s"></div>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button id="cvw-gen-btn" class="btn-primary" style="flex:1;background:${isPro?'linear-gradient(135deg,#a855f7,#06b6d4)':'var(--surface)'};${!isPro?'color:var(--text-s);cursor:not-allowed':''}" onclick="${isPro ? '_cvwStartGeneration()' : 'openPricingModal()'}">
        ${isPro ? '🎬 Generate Video' : '🔒 Pro Required'}
      </button>
      <button class="btn-sm" onclick="_cvwStep(3)">← Back</button>
    </div>`;
}

function _cvwSelectModel(id) {
  _cvw.selectedModel = id;
  _cvwRender();
}

// ── Step 5: Done / result ──────────────────────────────────────────────────
function _cvwStepDone(header) {
  const videoUrl = _cvw.videoUrl;
  return `${header}
    <div style="text-align:center;padding:10px 0 20px">
      ${videoUrl
        ? `<video src="${videoUrl}" controls style="width:100%;border-radius:12px;margin-bottom:14px;max-height:260px"></video>
           <div style="font-size:14px;font-weight:700;color:var(--green);margin-bottom:8px">✅ Your video is ready!</div>
           <div style="display:flex;gap:8px;justify-content:center">
             <a href="${videoUrl}" download="claw-video.mp4" class="btn-primary" style="background:linear-gradient(135deg,#a855f7,#06b6d4);text-decoration:none;padding:8px 20px;border-radius:8px;font-size:13px;color:#fff;font-weight:700">⬇ Download</a>
             <button class="btn-sm" onclick="openClawVideoWizard()">+ New Video</button>
           </div>`
        : `<div style="font-size:36px;margin-bottom:12px">⏳</div>
           <div style="font-size:14px;font-weight:700;margin-bottom:6px">Video is rendering</div>
           <div style="font-size:12px;color:var(--text-s);margin-bottom:16px">This usually takes 1–4 minutes. You'll see the result here when it's ready.</div>
           <div id="cvw-done-status" style="font-size:12px;color:#a855f7;margin-bottom:14px">Checking status…</div>
           <div style="width:100%;height:4px;background:var(--border);border-radius:4px;overflow:hidden;margin-bottom:16px">
             <div id="cvw-done-prog" style="height:100%;width:20%;background:linear-gradient(90deg,#a855f7,#06b6d4);border-radius:4px;transition:width 2s"></div>
           </div>
           <button class="btn-sm" onclick="closeModal();notify('Video is rendering in background — check Clawbot tab for updates','info')">Dismiss & continue</button>`
      }
    </div>`;
}

// ── Core flow functions ────────────────────────────────────────────────────

function _cvwStep(n) {
  _cvw.step = n;
  _cvwRender();
}

async function _cvwGenerateConcept() {
  // Capture latest prompt value
  const el = document.getElementById('cvw-prompt');
  if (el) _cvw.prompt = el.value.trim();

  _cvw.step = 1;
  _cvwRender();

  // Animate progress bar while waiting
  let pct = 15;
  const barTimer = setInterval(() => {
    pct = Math.min(pct + 7, 88);
    const bar = document.getElementById('cvw-gen-bar');
    if (bar) bar.style.width = pct + '%';
  }, 400);

  try {
    const r = await fetch('/api/claw/video-concept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: _cvw.prompt || (_cvw.audioContext?.trackName || ''),
        style: _cvw.style,
        audioContext: _cvw.audioContext,
        numShots: 6,
      }),
    });
    const d = await r.json();
    clearInterval(barTimer);

    if (d.error) {
      notify('CLAW concept error: ' + d.error, 'error');
      _cvw.step = 0;
      _cvwRender();
      return;
    }

    _cvw.concept = d.concept || {};
    _cvw.shots   = Array.isArray(d.shots) ? d.shots : [];
    _cvw.step    = 2;
    _cvwRender();
  } catch(e) {
    clearInterval(barTimer);
    notify('Network error generating concept — please try again', 'error');
    _cvw.step = 0;
    _cvwRender();
  }
}

async function _cvwStartGeneration() {
  const btn    = document.getElementById('cvw-gen-btn');
  const status = document.getElementById('cvw-gen-status');
  const msg    = document.getElementById('cvw-gen-msg');
  const prog   = document.getElementById('cvw-gen-prog');
  if (btn)    { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&nbsp; Sending…'; }
  if (status) status.style.display = 'block';

  // Build a unified prompt from all shots
  const shotPrompts = _cvw.shots.map((s, i) =>
    `Shot ${i+1}: ${s.scene}. ${s.camera}. ${s.subject}. Tags: ${(s.tags||[]).join(', ')}.`
  ).join('\n');
  const fullPrompt = _cvw.concept
    ? `${_cvw.concept.theme}. Visual style: ${_cvw.concept.visualStyle}. Mood: ${_cvw.concept.mood}.\n\n${shotPrompts}`
    : shotPrompts || _cvw.prompt;

  const isI2V = _cvw.imageUrls.length > 0;
  const model = isI2V
    ? _cvw.selectedModel.replace('_t2v', '_i2v')  // switch to image-to-video variant
    : _cvw.selectedModel;

  const body = {
    model,
    prompt: fullPrompt,
    duration: 10,
    resolution: '720p',
    aspectRatio: '16:9',
    quality: 'high',
    ...(isI2V ? { imageUrl: _cvw.imageUrls[0] } : {}),
  };

  if (msg) msg.textContent = `Sending to ${model}…`;
  if (prog) prog.style.width = '12%';

  try {
    const r = await fetch('/api/264pro/video-gen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();

    if (d.error) {
      // May need Pro upgrade
      if (d.upgradeUrl || d.error?.includes('Pro')) {
        if (status) status.style.display = 'none';
        if (btn)    { btn.disabled = false; btn.innerHTML = '🎬 Generate Video'; }
        openPricingModal();
        return;
      }
      notify('Generation error: ' + d.error, 'error');
      if (status) status.style.display = 'none';
      if (btn) { btn.disabled = false; btn.innerHTML = '🎬 Generate Video'; }
      return;
    }

    // Queued — start polling
    _cvw.jobId    = d.requestId || d.jobId;
    _cvw.provider = d.provider || 'fal';
    _cvw.step     = 5;
    _cvwRender();

    if (_cvw.jobId) {
      _cvwPollStatus();
    }
  } catch(e) {
    notify('Network error — please try again', 'error');
    if (status) status.style.display = 'none';
    if (btn) { btn.disabled = false; btn.innerHTML = '🎬 Generate Video'; }
  }
}

function _cvwPollStatus() {
  if (_cvw.pollTimer) clearInterval(_cvw.pollTimer);
  let attempts = 0;
  let progPct  = 20;

  _cvw.pollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 90) { // 90 × 4s = 6 min timeout
      clearInterval(_cvw.pollTimer);
      const statusEl = document.getElementById('cvw-done-status');
      if (statusEl) statusEl.textContent = 'Generation timed out — check back later or try again.';
      return;
    }

    try {
      const r = await fetch(`/api/264pro/video-gen/poll/${_cvw.jobId}?provider=${_cvw.provider}`);
      const d = await r.json();

      progPct = Math.min(progPct + 3, 92);
      const progEl = document.getElementById('cvw-done-prog');
      if (progEl) progEl.style.width = progPct + '%';

      const statusEl = document.getElementById('cvw-done-status');

      if (d.status === 'complete' && d.videoUrl) {
        clearInterval(_cvw.pollTimer);
        _cvw.videoUrl = d.videoUrl;
        if (progEl) progEl.style.width = '100%';
        _cvwRender(); // re-render step 5 with video player
        notify('🎬 Your CLAW video is ready!', 'success');
      } else if (d.status === 'error') {
        clearInterval(_cvw.pollTimer);
        if (statusEl) statusEl.textContent = '❌ Generation failed: ' + (d.error || 'Unknown error');
      } else {
        if (statusEl) statusEl.textContent = d.message || 'Rendering… ' + progPct + '% complete';
      }
    } catch { /* network hiccup — keep polling */ }
  }, 4000);
}

// ── Public helper: trigger from FS Audio export ────────────────────────────
/**
 * Called by FS Audio's ExportModal when export completes.
 * Shows a dismissible banner suggesting video creation.
 * @param {object} audioCtx  { trackName, bpm, key, genre, duration }
 */
function clawVideoPostExportBanner(audioCtx) {
  // Don't show if user already dismissed this session
  if (sessionStorage.getItem('cvw_export_dismissed')) return;
  // Remove any existing banner
  document.getElementById('cvw-export-banner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'cvw-export-banner';
  banner.style.cssText = `
    position:fixed; bottom:80px; right:20px; z-index:9000;
    background:linear-gradient(135deg,rgba(168,85,247,.15),rgba(6,182,212,.15));
    border:1px solid rgba(168,85,247,.4); border-radius:14px;
    padding:14px 16px; max-width:300px; box-shadow:0 8px 32px rgba(0,0,0,.4);
    animation:slideInRight .3s ease;
  `;
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px">
      <span style="font-size:22px;flex-shrink:0">🎬</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:700;margin-bottom:3px">Turn this into a video?</div>
        <div style="font-size:11px;color:var(--text-s);margin-bottom:10px">
          CLAW can generate a music video for <strong>${(audioCtx && audioCtx.trackName) || 'your track'}</strong>${audioCtx && audioCtx.bpm ? ` · ${audioCtx.bpm} BPM` : ''} right now.
        </div>
        <div style="display:flex;gap:6px">
          <button onclick="document.getElementById('cvw-export-banner').remove();openClawVideoWizard({audioContext:${JSON.stringify(audioCtx||{})}});return false"
            style="padding:6px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#a855f7,#06b6d4);color:#fff;font-size:12px;font-weight:700;cursor:pointer">
            Yes, create video
          </button>
          <button onclick="sessionStorage.setItem('cvw_export_dismissed','1');document.getElementById('cvw-export-banner').remove()"
            style="padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-s);font-size:12px;cursor:pointer">
            Not now
          </button>
        </div>
      </div>
      <button onclick="sessionStorage.setItem('cvw_export_dismissed','1');document.getElementById('cvw-export-banner').remove()"
        style="background:none;border:none;color:var(--text-s);cursor:pointer;font-size:14px;padding:0;flex-shrink:0">✕</button>
    </div>
  `;
  document.body.appendChild(banner);

  // Add animation keyframe if not already present
  if (!document.getElementById('cvw-banner-css')) {
    const style = document.createElement('style');
    style.id = 'cvw-banner-css';
    style.textContent = `@keyframes slideInRight { from { transform:translateX(120%); opacity:0; } to { transform:translateX(0); opacity:1; } }`;
    document.head.appendChild(style);
  }

  // Auto-dismiss after 12s
  setTimeout(() => {
    const el = document.getElementById('cvw-export-banner');
    if (el) { el.style.animation = 'none'; el.style.opacity='0'; el.style.transition='opacity .4s'; setTimeout(()=>el.remove(),400); }
  }, 12000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLAWFLOW RELEASE WIZARD — Post-export marketing & distribution wizard
// Triggered by: FS Audio ExportModal "Let Claw Handle It" button
//               URL param ?claw=release
//               Manual call: openClawReleaseWizard({ songName, bpm })
// ═══════════════════════════════════════════════════════════════════════════════

let _crw = {
  open: false,
  step: 0,   // 0=intro 1=metadata 2=cover 3=pitches 4=distribute 5=done
  songId: null,
  songName: '',
  bpm: null,
  genre: '',
  mood: '',
  artistName: '',
  releaseDate: '',
  coverUrl: null,
  coverPollId: null,
  coverPollTimer: null,
  pitchDrafts: {},  // { spotify_editorial, playlist_curator, music_blog }
  metadata: null,
  loadingCover: false,
  loadingPitch: null,
};

const _CRW_STEPS = ['Intro', 'Details', 'Cover Art', 'Pitch Emails', 'Distribute', 'Done'];

/**
 * Entry point — call from anywhere.
 * opts: { songName?, bpm?, genre?, mood?, artistName? }
 */
function openClawReleaseWizard(opts) {
  if (!FS_USER) {
    notify('Sign in to use the Claw Release Wizard', 'info');
    return;
  }
  opts = opts || {};
  _crw.open    = true;
  _crw.step    = 0;
  _crw.songId  = null;
  _crw.songName = opts.songName || '';
  _crw.bpm     = opts.bpm || null;
  _crw.genre   = opts.genre || '';
  _crw.mood    = opts.mood || '';
  _crw.artistName = opts.artistName || (FS_USER && (FS_USER.name || FS_USER.email?.split('@')[0])) || '';
  _crw.releaseDate = '';
  _crw.coverUrl = null;
  _crw.coverPollId = null;
  _crw.coverR2Key = null;
  _crw.trackUrl = opts.trackUrl || null;
  if (_crw.coverPollTimer) clearInterval(_crw.coverPollTimer);
  _crw.pitchDrafts = {};
  _crw.metadata = null;
  _crw.sendingPitch = null;
  _crw.loadingCover = false;
  _crw.loadingPitch = null;
  // Reset per-session state
  window._crwPitchSent = {};
  window._crwPitchRecipient = {};
  window._crwSubmitHub = null;
  window._crwDistStatus = null;
  window._crwDkPrep = null;
  window._crwUmPrep = null;
  window._crwDkLoading = false;
  window._crwUmLoading = false;
  window._crwDistLoading = false;
  _crwRender();
}

function _crwClose() {
  _crw.open = false;
  if (_crw.coverPollTimer) clearInterval(_crw.coverPollTimer);
  document.getElementById('crw-overlay')?.remove();
}

function _crwRender() {
  document.getElementById('crw-overlay')?.remove();
  if (!_crw.open) return;

  const overlay = document.createElement('div');
  overlay.id = 'crw-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:9500;
    background:rgba(0,0,0,0.82); backdrop-filter:blur(12px);
    display:flex; align-items:center; justify-content:center; padding:16px;
    animation:fadeIn .22s ease;
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) _crwClose(); });

  // Step progress bar
  const stepsHtml = _CRW_STEPS.map((s, i) => `
    <div style="display:flex;align-items:center;gap:4px;font-size:10px;font-weight:${i===_crw.step?700:400};
      color:${i<_crw.step?'var(--green)':i===_crw.step?'#c4b5fd':'rgba(255,255,255,0.3)'};
      cursor:${i<_crw.step?'pointer':'default'}"
      ${i < _crw.step ? `onclick="_crw.step=${i};_crwRender()"` : ''}>
      <span style="width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;
        background:${i<_crw.step?'rgba(16,185,129,.3)':i===_crw.step?'rgba(168,85,247,.35)':'rgba(255,255,255,.06)'};
        border:1px solid ${i<_crw.step?'rgba(16,185,129,.5)':i===_crw.step?'rgba(168,85,247,.6)':'rgba(255,255,255,.1)'}">
        ${i < _crw.step ? '✓' : i+1}
      </span>
      <span style="display:${_crw.step===i?'inline':'none'}">${s}</span>
    </div>
    ${i < _CRW_STEPS.length-1 ? '<div style="width:14px;height:1px;background:rgba(255,255,255,.1);flex-shrink:0"></div>' : ''}
  `).join('');

  const header = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px">
        <img src="/static/clawbot-mascot.png" onerror="this.style.display='none'" width="36" height="36" style="border-radius:50%;filter:drop-shadow(0 0 8px rgba(168,85,247,.5))">
        <div>
          <div style="font-size:14px;font-weight:800;color:#e9d5ff">Claw Release Wizard</div>
          <div style="font-size:10px;color:rgba(196,181,253,0.6)">${_crw.songName ? `"${_crw.songName}"` : 'New Release'}</div>
        </div>
      </div>
      <button onclick="_crwClose()" style="background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;font-size:16px;padding:4px">✕</button>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:20px;padding:10px;background:rgba(255,255,255,.03);border-radius:10px;overflow-x:auto">
      ${stepsHtml}
    </div>
  `;

  let content = '';
  if (_crw.step === 0) content = _crwStep0(header);
  else if (_crw.step === 1) content = _crwStep1(header);
  else if (_crw.step === 2) content = _crwStep2(header);
  else if (_crw.step === 3) content = _crwStep3(header);
  else if (_crw.step === 4) content = _crwStep4(header);
  else content = _crwStep5(header);

  overlay.innerHTML = `
    <div style="background:linear-gradient(160deg,#12102a,#1a1040 50%,#0d0d1a);
      border:1px solid rgba(168,85,247,.4);border-radius:20px;
      max-width:520px;width:100%;padding:28px 24px 22px;
      box-shadow:0 0 80px rgba(168,85,247,.2),0 24px 60px rgba(0,0,0,.6);
      max-height:90vh;overflow-y:auto">
      ${content}
    </div>
  `;
  document.body.appendChild(overlay);

  // Inject CSS once
  if (!document.getElementById('crw-css')) {
    const s = document.createElement('style');
    s.id = 'crw-css';
    s.textContent = `
      @keyframes fadeIn { from{opacity:0} to{opacity:1} }
      @keyframes crwSlideIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
      .crw-btn-primary { padding:11px 20px;border-radius:10px;border:none;
        background:linear-gradient(135deg,#9333ea,#7c3aed 60%,#06b6d4);
        color:#fff;font-size:13px;font-weight:700;cursor:pointer;width:100%;
        box-shadow:0 4px 20px rgba(147,51,234,.35);transition:transform .15s,box-shadow .15s; }
      .crw-btn-primary:hover { transform:translateY(-1px);box-shadow:0 6px 28px rgba(147,51,234,.5); }
      .crw-btn-secondary { padding:9px 20px;border-radius:10px;
        border:1px solid rgba(255,255,255,.1);background:transparent;
        color:rgba(255,255,255,.5);font-size:12px;cursor:pointer;width:100%;
        transition:color .15s,border-color .15s; }
      .crw-btn-secondary:hover { color:rgba(255,255,255,.8);border-color:rgba(255,255,255,.25); }
      .crw-input { width:100%;padding:9px 12px;border-radius:8px;
        border:1px solid rgba(168,85,247,.25);background:rgba(255,255,255,.04);
        color:#e9d5ff;font-size:12px;outline:none;box-sizing:border-box; }
      .crw-input:focus { border-color:rgba(168,85,247,.6); }
      .crw-label { font-size:10px;font-weight:700;color:rgba(196,181,253,.7);
        text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;display:block; }
      .crw-field { margin-bottom:14px; }
      .crw-pill { display:inline-block;padding:5px 10px;border-radius:20px;
        font-size:11px;font-weight:600;cursor:pointer;border:1px solid rgba(168,85,247,.3);
        background:rgba(168,85,247,.08);color:#c4b5fd;transition:background .15s,border-color .15s; }
      .crw-pill.active { background:rgba(168,85,247,.3);border-color:rgba(168,85,247,.7);color:#fff; }
      .crw-pill-row { display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px; }
    `;
    document.head.appendChild(s);
  }
}

// ── Step 0: Intro / pitch ─────────────────────────────────────────────────────
function _crwStep0(header) {
  const features = [
    { e:'🎨', t:'Cover Art',      d:'AI-generated, free' },
    { e:'📧', t:'Pitch Emails',   d:'Spotify Editorial & curators' },
    { e:'📝', t:'Release Metadata', d:'ISRC, PRO, DSP requirements' },
    { e:'🚀', t:'Distribution',   d:'UnitedMasters & DistroKid' },
    { e:'📣', t:'Media Outreach', d:'Blogs, press, sync licensing' },
  ];
  const featureHtml = features.map(f => `
    <div style="display:flex;align-items:center;gap:8px;padding:9px 10px;
      background:rgba(168,85,247,.07);border:1px solid rgba(168,85,247,.18);border-radius:9px">
      <span style="font-size:18px">${f.e}</span>
      <div>
        <div style="font-size:11px;font-weight:700;color:#e9d5ff">${f.t}</div>
        <div style="font-size:10px;color:rgba(196,181,253,.6)">${f.d}</div>
      </div>
    </div>
  `).join('');

  return `${header}
    <div style="text-align:center;margin-bottom:18px">
      <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:8px">
        🎉 Your song is finished.
      </div>
      <div style="font-size:13px;color:rgba(196,181,253,.85);line-height:1.55;max-width:380px;margin:0 auto">
        <strong style="color:#e9d5ff">Claw can take
          <span style="background:linear-gradient(90deg,#a855f7,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent">
            ${_crw.songName ? `"${escHtml(_crw.songName)}"` : 'this record'}
          </span>
          to the next level</strong> — handling the entire post-production workflow so you can focus on what matters.
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:20px">
      ${featureHtml}
    </div>
    <div style="font-size:10px;color:rgba(255,255,255,.2);text-align:center;margin-bottom:14px;line-height:1.4">
      Cover art &amp; pitch drafts are free. Distribution requires ClawFlow.<br>
      Claw will always ask before sending anything.
    </div>
    <button class="crw-btn-primary" onclick="_crw.step=1;_crwRender()">
      ⚡ Let's Do This — Start Release Workflow
    </button>
    <button class="crw-btn-secondary" style="margin-top:8px" onclick="_crwClose()">
      Not yet — I'll handle it myself
    </button>
  `;
}

// ── Step 1: Song Details ──────────────────────────────────────────────────────
const _CRW_GENRES = ['Hip-Hop','R&B','Pop','Electronic','Indie','Rock','Country','Jazz','Classical','Lo-Fi','Drill','Afrobeats','Latin'];
const _CRW_MOODS  = ['Uplifting','Dark','Chill','Energetic','Melancholic','Romantic','Aggressive','Spiritual'];

function _crwStep1(header) {
  return `${header}
    <div style="margin-bottom:16px">
      <div style="font-size:13px;font-weight:700;color:#e9d5ff;margin-bottom:4px">Tell Claw about the track</div>
      <div style="font-size:11px;color:rgba(196,181,253,.6)">This helps generate accurate pitches and metadata.</div>
    </div>
    <div class="crw-field">
      <label class="crw-label">Song Title *</label>
      <input class="crw-input" id="crw-title" value="${escHtml(_crw.songName)}" placeholder="Song name" oninput="_crw.songName=this.value">
    </div>
    <div class="crw-field">
      <label class="crw-label">Artist Name *</label>
      <input class="crw-input" id="crw-artist" value="${escHtml(_crw.artistName)}" placeholder="Your artist name" oninput="_crw.artistName=this.value">
    </div>
    <div class="crw-field" style="display:flex;gap:10px">
      <div style="flex:1">
        <label class="crw-label">BPM</label>
        <input class="crw-input" type="number" id="crw-bpm" value="${_crw.bpm||''}" placeholder="e.g. 93" oninput="_crw.bpm=parseInt(this.value)||null">
      </div>
      <div style="flex:1">
        <label class="crw-label">Release Date</label>
        <input class="crw-input" type="date" id="crw-date" value="${_crw.releaseDate}" oninput="_crw.releaseDate=this.value">
      </div>
    </div>
    <div class="crw-field">
      <label class="crw-label">Genre</label>
      <div class="crw-pill-row">
        ${_CRW_GENRES.map(g => `<span class="crw-pill ${_crw.genre===g?'active':''}" onclick="_crw.genre='${g}';_crwRender()">${g}</span>`).join('')}
      </div>
    </div>
    <div class="crw-field">
      <label class="crw-label">Mood / Vibe</label>
      <div class="crw-pill-row">
        ${_CRW_MOODS.map(m => `<span class="crw-pill ${_crw.mood===m?'active':''}" onclick="_crw.mood='${m}';_crwRender()">${m}</span>`).join('')}
      </div>
    </div>
    <button class="crw-btn-primary" onclick="_crwStep1Submit()">
      Continue → Cover Art
    </button>
    <button class="crw-btn-secondary" style="margin-top:8px" onclick="_crw.step=0;_crwRender()">← Back</button>
  `;
}

async function _crwStep1Submit() {
  if (!_crw.songName.trim()) { notify('Enter a song title to continue', 'error'); return; }
  if (!_crw.artistName.trim()) { notify('Enter your artist name to continue', 'error'); return; }

  // Start release session on backend
  try {
    const res = await fetch('/api/claw/release/start', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        songName:_crw.songName, artistName:_crw.artistName,
        bpm:_crw.bpm, genre:_crw.genre, mood:_crw.mood,
        releaseDate:_crw.releaseDate || null,
      }),
    });
    const d = await res.json();
    if (d.ok) _crw.songId = d.songId;
  } catch {}

  _crw.step = 2;
  _crwRender();
  // Auto-start cover art generation
  setTimeout(_crwGenerateCoverArt, 400);
}

// ── Step 2: Cover Art ─────────────────────────────────────────────────────────
function _crwStep2(header) {
  let coverContent = '';
  if (_crw.loadingCover && !_crw.coverUrl) {
    coverContent = `
      <div style="text-align:center;padding:30px 0">
        <div style="font-size:28px;margin-bottom:10px;animation:spin 1.5s linear infinite;display:inline-block">🎨</div>
        <div style="font-size:12px;color:rgba(196,181,253,.7)">Generating your cover art…</div>
        <div style="font-size:10px;color:rgba(196,181,253,.4);margin-top:4px">Usually takes 10–20 seconds</div>
      </div>
    `;
  } else if (_crw.coverUrl) {
    coverContent = `
      <div style="text-align:center;margin-bottom:14px">
        <img src="${escHtml(_crw.coverUrl)}" style="width:200px;height:200px;border-radius:12px;object-fit:cover;border:1px solid rgba(168,85,247,.3);box-shadow:0 8px 32px rgba(0,0,0,.5)" alt="Cover Art">
        <div style="font-size:11px;color:rgba(196,181,253,.6);margin-top:8px">
          ✓ Cover generated · <a href="${escHtml(_crw.coverUrl)}" target="_blank" style="color:#a855f7;text-decoration:none">Download</a>
        </div>
      </div>
    `;
  } else {
    coverContent = `
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:36px;margin-bottom:8px">🎨</div>
        <div style="font-size:12px;color:rgba(196,181,253,.7);margin-bottom:12px">Generate AI cover art for free</div>
        <button class="crw-btn-primary" onclick="_crwGenerateCoverArt()">Generate Cover Art</button>
      </div>
    `;
  }

  const coverStyles = ['minimal','vibrant','cinematic','abstract','vintage','futuristic'];

  return `${header}
    <div style="margin-bottom:16px">
      <div style="font-size:13px;font-weight:700;color:#e9d5ff;margin-bottom:3px">🎨 Cover Art</div>
      <div style="font-size:11px;color:rgba(196,181,253,.5)">AI-generated in seconds. Free for all users.</div>
    </div>
    ${coverContent}
    ${!_crw.loadingCover && !_crw.coverUrl ? '' : `
      <div class="crw-field" style="margin-top:8px">
        <label class="crw-label">Art Style</label>
        <div class="crw-pill-row">
          ${coverStyles.map(s => `<span class="crw-pill ${(window._crwCoverStyle||'minimal')===s?'active':''}"
            onclick="window._crwCoverStyle='${s}';_crw.coverUrl=null;_crw.loadingCover=false;_crwRender()">${s}</span>`).join('')}
        </div>
        <button class="crw-btn-secondary" onclick="_crw.coverUrl=null;_crwGenerateCoverArt()">🔄 Regenerate</button>
      </div>
    `}
    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="crw-btn-secondary" onclick="_crw.step=1;_crwRender()">← Back</button>
      <button class="crw-btn-primary" onclick="_crw.step=3;_crwRender()">
        ${_crw.coverUrl ? 'Use this cover →' : 'Skip for now →'}
      </button>
    </div>
  `;
}

async function _crwGenerateCoverArt() {
  _crw.loadingCover = true;
  _crwRender();

  const style = window._crwCoverStyle || 'minimal';
  try {
    const res = await fetch('/api/claw/release/cover-art', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ songName:_crw.songName, artistName:_crw.artistName, genre:_crw.genre, mood:_crw.mood, style }),
    });
    const d = await res.json();
    if (!d.ok) { _crw.loadingCover = false; _crwRender(); notify(d.error||'Cover art failed','error'); return; }

    // Poll for result
    _crw.coverPollId = d.requestId;
    _crwPollCoverArt(d.requestId);
  } catch (e) {
    _crw.loadingCover = false;
    _crwRender();
    notify('Cover art generation failed. Please try again.', 'error');
  }
}

async function _crwPollCoverArt(requestId) {
  let attempts = 0;
  const poll = async () => {
    if (attempts++ > 20) { _crw.loadingCover = false; _crwRender(); return; }
    try {
      const res = await fetch(`/api/claw/release/cover-art/poll/${requestId}`, { credentials:'include' });
      const d = await res.json();
      if (d.status === 'complete' && d.imageUrl) {
        _crw.coverUrl = d.imageUrl;
        _crw.loadingCover = false;
        _crwRender();
        // ── Task 4: save to R2 immediately so URL never expires ──────────────
        try {
          const saveRes = await fetch('/api/claw/release/save-cover', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl: d.imageUrl, songName: _crw.songName, songId: _crw.songId }),
          });
          const saved = await saveRes.json();
          if (saved.ok && saved.permanentUrl && !saved.fallback) {
            _crw.coverUrl = saved.permanentUrl;  // swap to permanent R2 URL
            _crw.coverR2Key = saved.key;
            _crwRender();  // re-render with permanent URL
          }
        } catch { /* non-fatal — keep fal.ai URL if R2 save fails */ }
      } else if (d.status === 'error') {
        _crw.loadingCover = false;
        _crwRender();
        notify('Cover art generation failed', 'error');
      } else {
        setTimeout(poll, 3000);
      }
    } catch { setTimeout(poll, 4000); }
  };
  poll();
}

// ── Step 3: Pitch Emails + SubmitHub curator pitching ─────────────────────────
// Pitch send state per-type
if (!window._crwPitchSent) window._crwPitchSent = {};
if (!window._crwPitchRecipient) window._crwPitchRecipient = {};

function _crwStep3(header) {
  const pitchTypes = [
    { id:'spotify_editorial', label:'Spotify Editorial', icon:'🎵',
      desc:'Submit via Spotify for Artists (Claw drafts your pitch)',
      officialUrl:'https://artists.spotify.com/pitch', noDirectEmail:true },
    { id:'playlist_curator',  label:'Playlist Curators', icon:'📋',
      desc:'Independent Spotify/Apple Music curators' },
    { id:'music_blog',        label:'Music Blog / Press', icon:'📰',
      desc:'Blog reviewers and online music publications' },
  ];

  const pitchCards = pitchTypes.map(p => {
    const draft    = _crw.pitchDrafts[p.id];
    const sent     = window._crwPitchSent[p.id];
    const sending  = _crw.sendingPitch === p.id;
    const recip    = window._crwPitchRecipient[p.id] || '';
    return `
      <div style="border:1px solid rgba(168,85,247,${sent?'.5':draft?'.3':'.15'});border-radius:10px;padding:12px;margin-bottom:8px;
        background:rgba(${sent?'16,185,129':'168,85,247'},${sent?'.04':draft?'.07':'.03'})">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <div style="font-size:12px;font-weight:700;color:${sent?'#34d399':'#e9d5ff'}">${p.icon} ${p.label}${sent?' ✓':''}</div>
          ${draft
            ? `<button onclick="_crw.pitchDrafts['${p.id}']=null;_crwRender()"
                style="font-size:10px;color:rgba(255,255,255,.3);background:none;border:none;cursor:pointer">↺ Redo</button>`
            : `<button onclick="_crwGeneratePitch('${p.id}')"
                style="font-size:10px;padding:4px 10px;border-radius:6px;border:none;
                background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;cursor:pointer;font-weight:600">
                ${_crw.loadingPitch===p.id?'Drafting…':'Draft ✨'}</button>`
          }
        </div>
        <div style="font-size:10px;color:rgba(196,181,253,.5);margin-bottom:7px">${p.desc}</div>
        ${draft ? `
          <textarea id="crw-pitch-text-${p.id}"
            style="width:100%;min-height:110px;padding:8px;border-radius:6px;
            border:1px solid rgba(168,85,247,.25);background:rgba(255,255,255,.03);
            color:#e9d5ff;font-size:10px;line-height:1.5;resize:vertical;box-sizing:border-box"
            onchange="_crw.pitchDrafts['${p.id}']=this.value">${escHtml(draft)}</textarea>
          ${p.noDirectEmail ? `
            <a href="${p.officialUrl}" target="_blank"
              style="display:block;margin-top:7px;text-align:center;padding:7px;border-radius:8px;
              background:linear-gradient(135deg,#1DB954,#158a3e);color:#fff;font-size:11px;font-weight:700;text-decoration:none">
              🎵 Open Spotify for Artists — Paste Pitch →
            </a>
            <div style="font-size:9px;color:rgba(196,181,253,.35);text-align:center;margin-top:4px">
              Spotify editorial doesn't accept cold emails — official portal only.
            </div>
          ` : `
            <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
              <input id="crw-pitch-to-${p.id}" placeholder="curator@example.com" value="${escHtml(recip)}"
                oninput="window._crwPitchRecipient['${p.id}']=this.value"
                style="flex:1;padding:7px 10px;border-radius:7px;border:1px solid rgba(168,85,247,.25);
                background:rgba(255,255,255,.04);color:#e9d5ff;font-size:11px;outline:none">
              <button onclick="_crwSendPitch('${p.id}')"
                style="padding:7px 13px;border-radius:7px;border:none;font-size:11px;font-weight:700;cursor:pointer;
                background:${sent?'rgba(16,185,129,.2)':'linear-gradient(135deg,#7c3aed,#06b6d4)'};
                color:${sent?'#34d399':'#fff'};white-space:nowrap;min-width:70px">
                ${sending?'Sending…':sent?'Sent ✓':'Send 📤'}
              </button>
            </div>
            <div style="font-size:9px;color:rgba(196,181,253,.3);margin-top:4px">
              Replies go directly to your inbox. Claw will always ask before sending.
            </div>
          `}
        ` : ''}
      </div>
    `;
  }).join('');

  // SubmitHub block
  const sh = window._crwSubmitHub || {};
  const shLoading = sh.loading;
  const shResults = sh.results || [];
  const shSubmitted = sh.submitted || {};
  const shCurators = sh.curators || [];

  const submitHubHtml = `
    <div style="border:1px solid rgba(6,182,212,.25);border-radius:10px;padding:12px;margin-bottom:8px;
      background:rgba(6,182,212,.03)">
      <div style="font-size:12px;font-weight:700;color:#67e8f9;margin-bottom:4px">🎯 SubmitHub Curator Pitching</div>
      <div style="font-size:10px;color:rgba(103,232,249,.6);margin-bottom:10px">
        Find and pitch real playlist curators who accept submissions.
      </div>
      ${shCurators.length === 0 ? `
        <button onclick="_crwFindCurators()"
          style="padding:8px 16px;border-radius:8px;border:none;
          background:linear-gradient(135deg,#0891b2,#0e7490);color:#fff;font-size:11px;font-weight:700;cursor:pointer;width:100%">
          ${shLoading?'Searching curators…':'🔍 Find Curators for "'+escHtml(_crw.genre||_crw.songName)+'"'}
        </button>
      ` : `
        <div style="font-size:10px;color:rgba(103,232,249,.5);margin-bottom:8px">
          ${shCurators.length} curators found matching your genre
        </div>
        <div style="max-height:180px;overflow-y:auto;margin-bottom:8px">
          ${shCurators.slice(0,8).map((cur,i) => `
            <div style="display:flex;justify-content:space-between;align-items:center;
              padding:7px 8px;border-radius:6px;margin-bottom:4px;
              background:rgba(${shSubmitted[cur.id]?'16,185,129':'255,255,255'},.04);
              border:1px solid rgba(${shSubmitted[cur.id]?'16,185,129':'255,255,255'},.07)">
              <div>
                <div style="font-size:11px;font-weight:600;color:#e9d5ff">${escHtml(cur.name||cur.blog_name||'Curator')}</div>
                <div style="font-size:9px;color:rgba(196,181,253,.4)">${escHtml(cur.genres||cur.genre||'')} · ${cur.followers?cur.followers+' followers':''}</div>
              </div>
              <button onclick="_crwSubmitToCurator('${cur.id}',${i})"
                style="padding:4px 10px;border-radius:6px;border:none;font-size:10px;font-weight:700;cursor:pointer;
                background:${shSubmitted[cur.id]?'rgba(16,185,129,.2)':'linear-gradient(135deg,#0891b2,#0e7490)'};
                color:${shSubmitted[cur.id]?'#34d399':'#fff'}">
                ${shSubmitted[cur.id]?'Sent ✓':'Submit'}
              </button>
            </div>
          `).join('')}
        </div>
        <div style="font-size:9px;color:rgba(103,232,249,.3)">
          Submissions use your SubmitHub API key. Free tier: 3 blogs/day.
        </div>
      `}
      ${shResults.length > 0 ? `
        <div style="font-size:10px;color:rgba(16,185,129,.9);margin-top:6px;padding:6px;background:rgba(16,185,129,.06);border-radius:6px">
          ✅ Submitted to ${shResults.filter(r=>r.status==='submitted').length} of ${shResults.length} curators
        </div>
      ` : ''}
    </div>
  `;

  return `${header}
    <div style="margin-bottom:14px">
      <div style="font-size:13px;font-weight:700;color:#e9d5ff;margin-bottom:3px">📧 Pitch & Outreach</div>
      <div style="font-size:11px;color:rgba(196,181,253,.5)">Claw drafts everything. You review, edit, and approve each send.</div>
    </div>
    ${pitchCards}
    ${submitHubHtml}
    <div style="margin-top:14px;display:flex;gap:8px">
      <button class="crw-btn-secondary" onclick="_crw.step=2;_crwRender()">← Back</button>
      <button class="crw-btn-primary" onclick="_crw.step=4;_crwRender()">
        Continue → Distribution →
      </button>
    </div>
  `;
}

async function _crwGeneratePitch(pitchType) {
  _crw.loadingPitch = pitchType;
  _crwRender();
  try {
    const res = await fetch('/api/claw/release/pitch-draft', {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        songName:_crw.songName, artistName:_crw.artistName,
        genre:_crw.genre, mood:_crw.mood, bpm:_crw.bpm,
        releaseDate:_crw.releaseDate, targetType:pitchType,
      }),
    });
    const d = await res.json();
    _crw.pitchDrafts[pitchType] = d.draft || 'Draft unavailable — please try again.';
    if (d.isDemo) notify('Using demo draft — AI service unavailable', 'info');
  } catch {
    _crw.pitchDrafts[pitchType] = `Could not generate draft. Please try again.`;
    notify('Pitch draft failed', 'error');
  }
  _crw.loadingPitch = null;
  _crwRender();
}

// ── Task 5: Send pitch email via Resend (user must confirm) ───────────────────
async function _crwSendPitch(pitchType) {
  const to   = window._crwPitchRecipient[pitchType] || '';
  const body = _crw.pitchDrafts[pitchType] || '';

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    notify('Enter a valid recipient email address first', 'error'); return;
  }
  if (!body.trim()) { notify('Draft the pitch first before sending', 'error'); return; }

  // Show a one-click confirm dialog instead of window.confirm (works in all contexts)
  const confirmed = await _crwConfirmSend(to, pitchType);
  if (!confirmed) return;

  _crw.sendingPitch = pitchType;
  _crwRender();

  try {
    const res = await fetch('/api/claw/release/send-pitch', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        subject: `${_crw.artistName} — "${_crw.songName}" | Submission`,
        body,
        songName: _crw.songName,
        pitchType,
        userConfirmed: true,
      }),
    });
    const d = await res.json();
    if (d.ok) {
      window._crwPitchSent[pitchType] = true;
      notify(`Pitch sent to ${to}! Replies go to your inbox.`, 'success');
    } else if (d.error === 'blocked_recipient') {
      notify(d.message, 'info');
      window.open(d.officialUrl || 'https://artists.spotify.com/pitch', '_blank');
    } else {
      notify(d.message || d.error || 'Send failed — please try again', 'error');
    }
  } catch {
    notify('Send failed — check your connection and try again', 'error');
  }
  _crw.sendingPitch = null;
  _crwRender();
}

// Inline confirm widget (avoids blocked window.confirm in iframes / Electron)
function _crwConfirmSend(to, pitchType) {
  return new Promise(resolve => {
    const id = 'crw-confirm-' + Date.now();
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65)';
    el.innerHTML = `
      <div style="background:#1a1040;border:1px solid rgba(168,85,247,.5);border-radius:14px;padding:22px 24px;max-width:340px;text-align:center">
        <div style="font-size:28px;margin-bottom:8px">📤</div>
        <div style="font-size:13px;font-weight:700;color:#e9d5ff;margin-bottom:6px">Send this pitch?</div>
        <div style="font-size:11px;color:rgba(196,181,253,.7);line-height:1.5;margin-bottom:14px">
          Sending <strong>${escHtml(pitchType.replace(/_/g,' '))}</strong> pitch to<br>
          <strong style="color:#a855f7">${escHtml(to)}</strong>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="document.getElementById('${id}').remove();window._crwConfirmResolve_${id}(false)"
            style="flex:1;padding:9px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:transparent;color:rgba(255,255,255,.5);cursor:pointer;font-size:12px">
            Cancel
          </button>
          <button onclick="document.getElementById('${id}').remove();window._crwConfirmResolve_${id}(true)"
            style="flex:1;padding:9px;border-radius:8px;border:none;
            background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;cursor:pointer;font-size:12px;font-weight:700">
            Yes, Send It
          </button>
        </div>
      </div>
    `;
    window[`_crwConfirmResolve_${id}`] = resolve;
    document.body.appendChild(el);
  });
}

// ── Task 3: SubmitHub curator search + submit ─────────────────────────────────
async function _crwFindCurators() {
  if (!window._crwSubmitHub) window._crwSubmitHub = {};
  window._crwSubmitHub.loading = true;
  _crwRender();

  try {
    const params = new URLSearchParams({ genre: _crw.genre || '', songName: _crw.songName || '' });
    const res = await fetch(`/api/claw/release/submithub/curators?${params}`, { credentials:'include' });
    const d = await res.json();
    window._crwSubmitHub.curators = d.curators || [];
    window._crwSubmitHub.apiKeyMissing = d.apiKeyMissing;
    if (d.apiKeyMissing) notify('SubmitHub API key not configured — showing sample curators', 'info');
  } catch {
    window._crwSubmitHub.curators = [];
    notify('Could not load curators — please try again', 'error');
  }
  window._crwSubmitHub.loading = false;
  _crwRender();
}

async function _crwSubmitToCurator(curatorId, idx) {
  if (!window._crwSubmitHub) window._crwSubmitHub = {};
  if (!window._crwSubmitHub.submitted) window._crwSubmitHub.submitted = {};
  if (window._crwSubmitHub.submitted[curatorId]) return; // already submitted

  // Require a track URL — use cover R2 URL or ask for SoundCloud/YouTube
  const trackUrl = _crw.trackUrl || window.location.origin;

  window._crwSubmitHub.submitted[curatorId] = 'pending';
  _crwRender();

  try {
    const curator = (window._crwSubmitHub.curators || [])[idx] || { id: curatorId };
    const res = await fetch('/api/claw/release/submithub/submit', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        curatorIds:    [curatorId],
        trackUrl,
        songName:      _crw.songName,
        artistName:    _crw.artistName,
        genre:         _crw.genre,
        pitchNote:     _crw.pitchDrafts['playlist_curator'] || '',
        userConfirmed: true,
      }),
    });
    const d = await res.json();
    if (d.ok && d.successCount > 0) {
      window._crwSubmitHub.submitted[curatorId] = true;
      if (!window._crwSubmitHub.results) window._crwSubmitHub.results = [];
      window._crwSubmitHub.results.push(...(d.results || []));
      notify(`Submitted to ${escHtml(curator.name||'curator')} via SubmitHub!`, 'success');
    } else {
      window._crwSubmitHub.submitted[curatorId] = false;
      notify(d.results?.[0]?.error || 'Submission failed', 'error');
    }
  } catch {
    window._crwSubmitHub.submitted[curatorId] = false;
    notify('SubmitHub submission failed — please try again', 'error');
  }
  _crwRender();
}

// ── Step 4: Distribution ──────────────────────────────────────────────────────
// Distributor connection state (loaded once, then cached)
if (!window._crwDistStatus) window._crwDistStatus = null;
if (!window._crwDkPrep)     window._crwDkPrep     = null;
if (!window._crwUmPrep)     window._crwUmPrep     = null;

function _crwStep4(header) {
  const hasClawflow = FS_USER && (FS_USER.tier === 'clawflow' || FS_USER.subscription === 'clawflow');
  const st = window._crwDistStatus;

  // Load distributor status on first render of this step
  if (!st && !window._crwDistLoading) {
    window._crwDistLoading = true;
    fetch('/api/claw/release/distributor-status', { credentials:'include' })
      .then(r => r.json())
      .then(d => { window._crwDistStatus = d; window._crwDistLoading = false; _crwRender(); })
      .catch(() => { window._crwDistLoading = false; });
  }

  const dkSt = st?.distrokid;
  const umSt = st?.unitedmasters;

  const dkPrep  = window._crwDkPrep;
  const umPrep  = window._crwUmPrep;

  // DistroKid card
  const dkCard = `
    <div style="border:1px solid rgba(168,85,247,${dkPrep?'.5':'.2'});border-radius:10px;padding:12px;margin-bottom:8px;
      background:rgba(${dkPrep?'16,185,129':'168,85,247'}, ${dkPrep?'.04':'.03'})">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div>
          <div style="font-size:12px;font-weight:700;color:${dkPrep?'#34d399':'#e9d5ff'}">🎵 DistroKid ${dkPrep?'✓':''}</div>
          <div style="font-size:10px;color:rgba(196,181,253,.5);margin-top:1px">
            ${dkSt?.connected ? '✅ Connected' : dkSt?.apiAvailable ? '🔗 API available — connect to upload' : '📋 Partner API (invite-only) — metadata ready'}
          </div>
        </div>
        ${!dkPrep ? `
          <button onclick="_crwPrepDistroKid()"
            style="padding:6px 12px;border-radius:8px;border:none;
            background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">
            ${window._crwDkLoading?'Preparing…':'Prepare Upload'}
          </button>
        ` : `
          <button onclick="window.open('https://distrokid.com/new/','_blank')"
            style="padding:6px 12px;border-radius:8px;border:none;
            background:linear-gradient(135deg,#1DB954,#158a3e);color:#fff;font-size:11px;font-weight:700;cursor:pointer">
            Open DistroKid →
          </button>
        `}
      </div>
      ${dkPrep ? `
        <div style="font-size:10px;color:rgba(196,181,253,.8);line-height:1.6;padding:8px;
          background:rgba(16,185,129,.05);border-radius:6px;margin-top:6px">
          <strong style="color:#34d399">📋 Ready to paste:</strong><br>
          <span style="user-select:all">Title: ${escHtml(dkPrep.song_title||'')} · Artist: ${escHtml(dkPrep.primary_artist||'')} · Genre: ${escHtml(dkPrep.genre||'')} · Release: ${escHtml(dkPrep.release_date||'')}</span>
          ${dkPrep.liveSubmitted ? `<br><span style="color:#34d399">✅ Submitted live! ID: ${escHtml(dkPrep.submissionId||'')}</span>` : ''}
        </div>
      ` : ''}
    </div>
  `;

  // UnitedMasters card
  const umCard = `
    <div style="border:1px solid rgba(${umPrep?'16,185,129':'6,182,212'},.${umPrep?'5':'2'});border-radius:10px;padding:12px;
      background:rgba(${umPrep?'16,185,129':'6,182,212'},.${umPrep?'04':'03'})">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div>
          <div style="font-size:12px;font-weight:700;color:${umPrep?'#34d399':'#e9d5ff'}">🎤 UnitedMasters ${umPrep?'✓':''}</div>
          <div style="font-size:10px;color:rgba(196,181,253,.5);margin-top:1px">
            ${umSt?.connected ? '✅ Connected' : 'Direct distribution + brand partnerships'}
          </div>
        </div>
        ${!umPrep ? `
          <button onclick="_crwPrepUnitedMasters()"
            style="padding:6px 12px;border-radius:8px;border:none;
            background:linear-gradient(135deg,#0f766e,#0891b2);color:#fff;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">
            ${window._crwUmLoading?'Preparing…':'Prepare Upload'}
          </button>
        ` : `
          <button onclick="window.open('https://unitedmasters.com/distribute','_blank')"
            style="padding:6px 12px;border-radius:8px;border:none;
            background:linear-gradient(135deg,#0f766e,#0891b2);color:#fff;font-size:11px;font-weight:700;cursor:pointer">
            Open UM →
          </button>
        `}
      </div>
      ${umPrep ? `
        <div style="font-size:10px;color:rgba(196,181,253,.8);line-height:1.6;padding:8px;
          background:rgba(16,185,129,.05);border-radius:6px;margin-top:6px">
          <strong style="color:#34d399">📋 Ready to paste:</strong><br>
          <span style="user-select:all">Title: ${escHtml(umPrep.title||'')} · Artist: ${escHtml(umPrep.artist_name||'')} · Stores: ${(umPrep.stores||[]).join(', ')}</span>
          ${umPrep.liveSubmitted ? `<br><span style="color:#34d399">✅ Submitted live! ID: ${escHtml(umPrep.submissionId||'')}</span>` : ''}
        </div>
      ` : ''}
    </div>
  `;

  return `${header}
    <div style="margin-bottom:14px">
      <div style="font-size:13px;font-weight:700;color:#e9d5ff;margin-bottom:3px">🚀 Distribution</div>
      <div style="font-size:11px;color:rgba(196,181,253,.5)">
        ${hasClawflow ? 'Claw prepares your full upload package.' : 'Upgrade to ClawFlow for full automation. Metadata prep is available for everyone.'}
      </div>
    </div>

    ${!st ? `
      <div style="text-align:center;padding:16px;color:rgba(196,181,253,.5);font-size:11px">
        Loading distributor status…
      </div>
    ` : `
      <div style="margin-bottom:12px">
        ${dkCard}
        ${umCard}
      </div>
    `}

    <div style="padding:10px;background:rgba(255,255,255,.03);border-radius:8px;margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;color:rgba(196,181,253,.7);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">📋 Release Checklist</div>
      <div style="font-size:11px;color:rgba(196,181,253,.7);line-height:1.8">
        ${_crw.coverUrl ? '✅' : '⬜'} Cover Art<br>
        ${Object.keys(_crw.pitchDrafts).length > 0 ? '✅' : '⬜'} Pitch Emails Drafted<br>
        ${(window._crwDkPrep||window._crwUmPrep) ? '✅' : '⬜'} Distribution Prepared<br>
        ⬜ ISRC Registration (auto-assigned by distributor)<br>
        ⬜ Spotify for Artists — Submit for Editorial<br>
        ⬜ Social media announcement
      </div>
    </div>

    <div style="display:flex;gap:8px">
      <button class="crw-btn-secondary" onclick="_crw.step=3;_crwRender()">← Back</button>
      <button class="crw-btn-primary" onclick="_crw.step=5;_crwRender()">Finish →</button>
    </div>
  `;
}

// ── Task 1: Call /api/claw/release/distrokid-prep ────────────────────────────
async function _crwPrepDistroKid() {
  window._crwDkLoading = true;
  _crwRender();
  try {
    const res = await fetch('/api/claw/release/distrokid-prep', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songName:    _crw.songName,
        artistName:  _crw.artistName,
        genre:       _crw.genre,
        bpm:         _crw.bpm,
        releaseDate: _crw.releaseDate || null,
        coverR2Key:  _crw.coverR2Key  || null,
      }),
    });
    const d = await res.json();
    if (d.ok) {
      window._crwDkPrep = { ...d.payload, liveSubmitted: d.liveSubmitted, submissionId: d.submissionId };
      notify(d.message || 'DistroKid package ready!', 'success');
    } else if (d.error === 'clawflow_required') {
      notify('ClawFlow required for distribution automation. Upgrade at flowst8.cc/pricing', 'info');
      window.open('https://flowst8.cc/pricing', '_blank');
    } else {
      notify(d.error || 'Prep failed — please try again', 'error');
    }
  } catch {
    notify('DistroKid prep failed — check your connection', 'error');
  }
  window._crwDkLoading = false;
  _crwRender();
}

// ── Task 2: Call /api/claw/release/unitedmasters-prep ───────────────────────
async function _crwPrepUnitedMasters() {
  window._crwUmLoading = true;
  _crwRender();
  try {
    const res = await fetch('/api/claw/release/unitedmasters-prep', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songName:    _crw.songName,
        artistName:  _crw.artistName,
        genre:       _crw.genre,
        bpm:         _crw.bpm,
        releaseDate: _crw.releaseDate || null,
        coverR2Key:  _crw.coverR2Key  || null,
      }),
    });
    const d = await res.json();
    if (d.ok) {
      window._crwUmPrep = { ...d.payload, liveSubmitted: d.liveSubmitted, submissionId: d.submissionId };
      notify(d.message || 'UnitedMasters package ready!', 'success');
    } else if (d.error === 'clawflow_required') {
      notify('ClawFlow required for distribution automation. Upgrade at flowst8.cc/pricing', 'info');
      window.open('https://flowst8.cc/pricing', '_blank');
    } else {
      notify(d.error || 'Prep failed — please try again', 'error');
    }
  } catch {
    notify('UnitedMasters prep failed — check your connection', 'error');
  }
  window._crwUmLoading = false;
  _crwRender();
}

// ── Step 5: Done ──────────────────────────────────────────────────────────────
function _crwStep5(header) {
  const shResults  = (window._crwSubmitHub?.results || []).filter(r => r.status === 'submitted');
  const pitchSent  = Object.values(window._crwPitchSent || {}).filter(Boolean).length;
  const distPrepped = !!(window._crwDkPrep || window._crwUmPrep);

  const items = [
    _crw.coverUrl               && '✅ Cover art generated' + (_crw.coverR2Key ? ' & saved to cloud' : ''),
    ...Object.keys(_crw.pitchDrafts).map(k => `✅ ${k.replace(/_/g,' ')} pitch drafted`),
    pitchSent > 0               && `✅ ${pitchSent} pitch email${pitchSent>1?'s':''} sent`,
    shResults.length > 0        && `✅ ${shResults.length} SubmitHub submission${shResults.length>1?'s':''}`,
    distPrepped                 && '✅ Distribution package prepared',
    '✅ Release metadata structured',
  ].filter(Boolean);

  const itemCount = items.length;

  return `${header}
    <div style="text-align:center;padding:16px 0 20px">
      <div style="font-size:50px;margin-bottom:12px;filter:drop-shadow(0 0 16px rgba(168,85,247,.5))">⚡</div>
      <div style="font-size:18px;font-weight:800;color:#fff;margin-bottom:8px">You're ready to release!</div>
      <div style="font-size:12px;color:rgba(196,181,253,.8);line-height:1.6;max-width:340px;margin:0 auto 18px">
        Claw completed <strong style="color:#a855f7">${itemCount} task${itemCount!==1?'s':''}</strong>
        for <strong>"${escHtml(_crw.songName)}"</strong>.<br>
        The post-workflow is done — now go tell the world. 🌍
      </div>
      <div style="background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.2);border-radius:10px;
        padding:12px 16px;text-align:left;margin-bottom:16px;font-size:11px;color:rgba(196,181,253,.85);line-height:2">
        ${items.map(i => `${i}<br>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="crw-btn-secondary" onclick="_crw.step=4;_crwRender()">← Back</button>
        <button class="crw-btn-primary" onclick="_crwClose()">Done — Close Wizard</button>
      </div>
      <div style="font-size:10px;color:rgba(255,255,255,.2);line-height:1.4">
        Need help? Open the Clawbot tab and ask anything about your release.
      </div>
    </div>
  `;
}

// ── URL param handler — ?claw=release ─────────────────────────────────────────
(function _crwCheckUrlParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('claw') === 'release') {
    window.history.replaceState({}, '', window.location.pathname);
    setTimeout(() => openClawReleaseWizard({
      songName: params.get('track') || '',
      bpm: parseInt(params.get('bpm') || '0') || null,
    }), 1000);
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 1A — STREAK EMAIL FALLBACK
// If push notifications are blocked, send an email reminder instead
// ══════════════════════════════════════════════════════════════════════════════
async function sendStreakEmailFallback() {
  if (!FS_USER) return;
  // Only send if push is not granted
  if ('Notification' in window && Notification.permission === 'granted') return;
  // Throttle: only send once per day
  const today = new Date().toISOString().slice(0,10);
  const key = `fs_streak_email_sent_${today}`;
  if (localStorage.getItem(key)) return;
  try {
    const res = await fetch('/api/email/streak-reminder', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (data.ok) {
      localStorage.setItem(key, '1');
      console.log('[FlowState] Streak email sent:', data.streak + '-day streak');
    }
  } catch(e) {}
}

// Check at app load — if streak > 0 and push blocked, try email fallback
(function initStreakEmailFallback() {
  if (!FS_USER) return;
  const todayKey = `fs_session_today_${new Date().toISOString().slice(0,10)}`;
  const hasSession = localStorage.getItem(todayKey);
  if (hasSession) return; // Already focused today, no reminder needed
  // Wait 30s after load to not be intrusive
  setTimeout(() => {
    const streak = state?.timer?.streak || 0;
    if (streak > 0) sendStreakEmailFallback();
  }, 30000);
})();

// ══════════════════════════════════════════════════════════════════════════════
// 4A — AI FLOW COACH
// ══════════════════════════════════════════════════════════════════════════════
let _coachData = null;
let _coachLoading = false;

// ── T6: Feature onboarding helpers ──────────────────────────────────────────
function _showFeatureOnboarding(featureKey, steps, onComplete) {
  const seen = localStorage.getItem('fs_onboard_' + featureKey);
  if (seen) { onComplete(); return; }
  let currentStep = 0;
  function renderStep() {
    const step = steps[currentStep];
    const isLast = currentStep === steps.length - 1;
    openModal(`
      <div style="text-align:center;padding:8px 0">
        <div style="font-size:48px;margin-bottom:10px">${step.icon}</div>
        <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Step ${currentStep+1} of ${steps.length}</div>
        <h2 style="font-size:18px;font-weight:900;margin-bottom:8px;line-height:1.3">${step.title}</h2>
        <p style="color:var(--text-s);font-size:13px;line-height:1.6;max-width:320px;margin:0 auto 20px">${step.desc}</p>
        ${step.visual ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:20px;font-size:12px;color:var(--text-m);text-align:left">${step.visual}</div>` : ''}
        <!-- Step dots -->
        <div style="display:flex;justify-content:center;gap:6px;margin-bottom:20px">
          ${steps.map((_,i)=>`<div style="width:7px;height:7px;border-radius:50%;background:${i<=currentStep?'var(--accent)':'rgba(255,255,255,.15)'};transition:.2s"></div>`).join('')}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-sm" onclick="closeModal();localStorage.setItem('fs_onboard_${featureKey}','1')" style="flex:1;justify-content:center;color:var(--text-s)">Skip</button>
          <button class="btn-primary" style="flex:2;justify-content:center" id="onboard-next-btn"
            onclick="${isLast ? `closeModal();localStorage.setItem('fs_onboard_${featureKey}','1');_onboardComplete_${featureKey}()` : `_onboardNext_${featureKey}()`}">
            ${isLast ? 'Get Started <i class="fas fa-bolt"></i>' : 'Next <i class="fas fa-arrow-right"></i>'}
          </button>
        </div>
      </div>
    `);
  }
  window[`_onboardNext_${featureKey}`] = function() { currentStep++; renderStep(); };
  window[`_onboardComplete_${featureKey}`] = onComplete;
  renderStep();
}

async function openFlowCoach() {
  if (!FS_USER) { notify('Sign in to access your AI Flow Coach', 'info'); return; }

  openModal(`
    <div style="text-align:center;padding:8px 0 4px">
      <div style="font-size:36px;margin-bottom:6px">🧠</div>
      <h2 style="font-weight:900;margin-bottom:4px">AI Flow Coach</h2>
      <p style="color:var(--text-s);font-size:13px;margin-bottom:20px">Personalized insights from your session data</p>
      <div id="coach-content">
        <div style="padding:40px;color:var(--text-s)"><i class="fas fa-spinner fa-spin"></i> Analyzing your patterns...</div>
      </div>
    </div>
  `, true);

  if (_coachData && !_coachLoading) {
    _renderCoachUI(_coachData);
    return;
  }

  _coachLoading = true;
  try {
    const res = await fetch('/api/coach/insight', { credentials: 'include' });
    const data = await res.json();
    _coachLoading = false;
    if (!data.ok) {
      document.getElementById('coach-content').innerHTML = `<p style="color:var(--danger)">Could not load insights: ${data.error || 'unknown error'}</p>`;
      return;
    }
    _coachData = data;
    _renderCoachUI(data);
  } catch(e) {
    _coachLoading = false;
    document.getElementById('coach-content').innerHTML = `<p style="color:var(--danger)">Network error loading coach</p>`;
  }
}

function _renderCoachUI(data) {
  const el = document.getElementById('coach-content');
  if (!el) return;
  const c = data.coaching || {};
  const s = data.stats || {};
  const moodColor = { inspired:'#a855f7', impressed:'#10b981', encouraging:'#f59e0b', concerned:'#ef4444' };
  // Whitelist coachMood to prevent CSS injection
  const safeMood = ['inspired','impressed','encouraging','concerned'].includes(c.coachMood) ? c.coachMood : 'inspired';
  const mc = moodColor[safeMood];
  const peakTime = (s.peakHour != null && Number.isInteger(s.peakHour)) ? `${s.peakHour}:00` : 'N/A';
  // Escape all AI-returned strings and user data to prevent XSS
  const badge      = escHtml(c.badge       || '⚡');
  const badgeLabel = escHtml(c.badgeLabel  || 'Flow Builder');
  const headline   = escHtml(c.headline    || 'Keep building momentum');
  const insight    = escHtml(c.insight     || 'Loading...');
  const tip        = escHtml(c.tip         || 'Keep showing up daily — consistency beats intensity.');
  const topOutput  = escHtml(s.topOutput   || 'None logged');
  const peakDays   = escHtml((s.peakDays || []).join(', ') || 'N/A');

  el.innerHTML = `
    <!-- Badge + Headline -->
    <div style="background:linear-gradient(135deg,rgba(168,85,247,.1),rgba(236,72,153,.06));border:1px solid rgba(168,85,247,.25);border-radius:14px;padding:20px;margin-bottom:16px;text-align:center">
      <div style="font-size:44px;margin-bottom:6px">${badge}</div>
      <div style="font-size:13px;font-weight:800;color:${mc};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">${badgeLabel}</div>
      <div style="font-size:18px;font-weight:900;color:#f0f0f0;line-height:1.3;margin-bottom:10px">${headline}</div>
      <p style="color:#c084fc;font-size:13px;line-height:1.6;margin:0">${insight}</p>
    </div>

    <!-- Stats grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#a855f7">${parseInt(s.sessions)||0}</div>
        <div style="font-size:10px;color:var(--text-s);margin-top:2px">Sessions</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#10b981">${parseInt(s.focusMin)||0}m</div>
        <div style="font-size:10px;color:var(--text-s);margin-top:2px">Focus Time</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#f59e0b">${parseInt(s.streak)||0}🔥</div>
        <div style="font-size:10px;color:var(--text-s);margin-top:2px">Day Streak</div>
      </div>
    </div>

    <!-- Patterns -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;font-size:13px">
      <div style="font-weight:700;color:var(--text-m);margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.6px">📊 Your Patterns</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;color:var(--text-s)">
        <span>🕐 Peak hour: <strong style="color:var(--text)">${peakTime}</strong></span>
        <span>📅 Best days: <strong style="color:var(--text)">${peakDays}</strong></span>
        <span>🎯 Top output: <strong style="color:var(--text)">${topOutput}</strong></span>
        <span>📈 Avg score: <strong style="color:var(--text)">${parseInt(s.avgScore)||0}/100</strong></span>
      </div>
    </div>

    <!-- Actionable tip -->
    <div style="background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);border-radius:10px;padding:14px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:800;color:#a855f7;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">💡 Coach's Tip</div>
      <p style="font-size:13px;color:#d0d0d0;line-height:1.6;margin:0">${tip}</p>
    </div>

    <div style="display:flex;gap:8px">
      <button class="btn-sm" style="flex:1;justify-content:center" onclick="_coachData=null;openFlowCoach()"><i class="fas fa-sync-alt"></i> Refresh</button>
      <button class="btn-primary" style="flex:1;justify-content:center" onclick="closeModal();switchTab('focus')"><i class="fas fa-bolt"></i> Start Session</button>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 4C — ACCOUNTABILITY PAIRING
// ══════════════════════════════════════════════════════════════════════════════
let _pairState = { status: 'none', partner: null, sessionId: null, endsAt: null, pollTimer: null, pingTimer: null, msgTimer: null, countdownInterval: null };

async function openPairingModal() {
  if (!FS_USER) { notify('Sign in to use accountability pairing', 'info'); return; }

  // T6: First-use onboarding for pairing
  if (!localStorage.getItem('fs_onboard_pairing')) {
    _showFeatureOnboarding('pairing', [
      { icon: '🤝', title: 'Accountability Pairing', desc: 'Get matched with another creator for a shared focus session. When you pair up, you both commit to the same work block — keeping each other on track.', visual: '<div style="display:flex;gap:12px;align-items:center"><div style="flex:1;text-align:center"><div style="font-size:24px">👤</div><div style="margin-top:4px">You</div></div><div style="font-size:20px">🤝</div><div style="flex:1;text-align:center"><div style="font-size:24px">👤</div><div style="margin-top:4px">Your Partner</div></div></div>' },
      { icon: '⏱', title: 'Focus Together, Ship More', desc: 'Choose your session length (25, 45, or 90 mins). FlowState matches you with someone in the queue and starts a shared countdown. You can check in mid-session to stay accountable.', visual: '<div style="font-size:12px"><div style="margin-bottom:6px">🔍 <strong>Join Queue</strong> — enter the pool</div><div style="margin-bottom:6px">⚡ <strong>Get Matched</strong> — paired instantly</div><div style="margin-bottom:6px">✅ <strong>Check In</strong> — send a 👋 mid-session</div></div>' },
      { icon: '🏁', title: 'Ready to Pair Up?', desc: "Click 'Get Started' to join the queue. You'll be matched with the next creator who joins. The session auto-ends when the timer runs out — or leave early anytime.", visual: '' },
    ], () => { _openPairingModalCore(); });
    return;
  }

  _openPairingModalCore();
}

async function _openPairingModalCore() {
  // Check current pairing status first
  try {
    const res = await fetch('/api/pair/status', { credentials: 'include' });
    const data = await res.json();
    if (data.status === 'paired' && data.data?.partnerEmail) {
      const { pollTimer, pingTimer } = _pairState;
      _pairState = { ...data.data, status: 'paired', pollTimer, pingTimer };
      _renderPairedUI();
      return;
    }
    if (data.status === 'waiting') {
      _pairState.status = 'waiting';
      _renderWaitingUI();
      return;
    }
  } catch(e) {}

  _renderPairLobbyUI();
}

function _renderPairLobbyUI() {
  openModal(`
    <div style="text-align:center;padding:8px 0 4px">
      <div style="font-size:40px;margin-bottom:8px">🤝</div>
      <h2 style="font-weight:900;margin-bottom:4px">Accountability Partner</h2>
      <p style="color:var(--text-s);font-size:13px;margin-bottom:24px">Get matched with another creator for a shared focus session. Stay accountable, ship together.</p>
      <div style="display:flex;gap:8px;justify-content:center;margin-bottom:24px">
        ${[25,45,60,90].map(m => `<button class="btn-sm pair-dur-btn ${m===25?'btn-primary':''}" data-min="${m}" onclick="_setPairDuration(${m})">${m}m</button>`).join('')}
      </div>
      <div id="pair-lobby-status" style="margin-bottom:16px;font-size:13px;color:var(--text-s)">You'll be matched with someone ready to focus for the same duration.</div>
      <button class="btn-primary" style="width:100%;padding:14px;font-size:15px;gap:8px" onclick="_joinPairQueue()">
        <i class="fas fa-search"></i> Find a Focus Partner
      </button>
      <p style="color:var(--text-s);font-size:11px;margin-top:12px">Matched users see each other's first name only. Sessions are private.</p>
      <div style="border-top:1px solid var(--border);margin-top:18px;padding-top:16px">
        <button class="btn-sm" style="width:100%;gap:8px;padding:10px;font-size:13px;color:#a855f7;border-color:rgba(168,85,247,.4);background:rgba(168,85,247,.06)" onclick="openGroupFlowModal()">
          <i class="fas fa-users"></i> GroupFlow — Create or Join a Group
        </button>
        <p style="color:var(--text-s);font-size:11px;margin-top:8px">Persistent groups with chat, reactions &amp; shared focus sessions.</p>
      </div>
    </div>
  `);
  window._pairSelectedDuration = 25;
}

function _setPairDuration(m) {
  window._pairSelectedDuration = m;
  document.querySelectorAll('.pair-dur-btn').forEach(b => {
    b.classList.toggle('btn-primary', parseInt(b.dataset.min) === m);
    b.classList.toggle('btn-sm', true);
  });
}

async function _joinPairQueue() {
  const dur = window._pairSelectedDuration || 25;
  const statusEl = document.getElementById('pair-lobby-status');
  if (statusEl) statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching for a partner...';

  try {
    const res = await fetch('/api/pair/queue', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ durationMins: dur })
    });
    const data = await res.json();
    if (data.status === 'matched') {
      _pairState = { status: 'paired', partnerName: data.partner, sessionId: data.sessionId, durationMins: data.durationMins, endsAt: data.endsAt };
      _renderPairedUI();
    } else if (data.status === 'waiting') {
      _pairState.status = 'waiting';
      _renderWaitingUI();
      // Poll every 5s for match
      if (_pairState.pollTimer) clearInterval(_pairState.pollTimer);
      _pairState.pollTimer = setInterval(_pollPairStatus, 5000);
    } else if (data.status === 'already_paired') {
      const { pollTimer, pingTimer } = _pairState;
      _pairState = { status: 'paired', partnerName: data.partner, sessionId: data.sessionId, pollTimer, pingTimer };
      _renderPairedUI();
    }
  } catch(e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">Error connecting. Try again.</span>';
  }
}

async function _pollPairStatus() {
  try {
    const res = await fetch('/api/pair/status', { credentials: 'include' });
    const data = await res.json();
    if (data.status === 'paired' && data.data?.partnerEmail) {
      clearInterval(_pairState.pollTimer);
      const { pingTimer } = _pairState;
      _pairState = { ...data.data, status: 'paired', pollTimer: null, pingTimer };
      _renderPairedUI();
    } else if (data.status === 'none') {
      clearInterval(_pairState.pollTimer);
      _pairState.status = 'none';
      notify('Session expired — try again', 'warning');
    }
  } catch(e) {}
}

function _renderWaitingUI() {
  openModal(`
    <div style="text-align:center;padding:16px 0">
      <div style="font-size:48px;margin-bottom:12px">🔍</div>
      <h2 style="font-weight:900;margin-bottom:8px">Finding Your Partner...</h2>
      <p style="color:var(--text-s);font-size:13px;margin-bottom:24px">You're in the queue. We'll match you with the next creator who joins.</p>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:20px">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;color:var(--text-s)">
          <i class="fas fa-spinner fa-spin" style="color:#a855f7"></i>
          <span>Polling every 5 seconds...</span>
        </div>
      </div>
      <button class="btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="_leavePair()">Cancel</button>
    </div>
  `);
}

// ── Quick emoji reactions for the chat ────────────────────────────────────────
const PAIR_QUICK_EMOJIS = ['👋','🔥','💪','✅','🚀','😤','☕','🎯'];

function _renderPairedUI() {
  const p = _pairState;
  const endsAt = p.endsAt ? new Date(p.endsAt) : null;
  const minsLeft = endsAt ? Math.max(0, Math.round((endsAt - Date.now()) / 60000)) : p.durationMins || 25;
  const secsLeft = endsAt ? Math.max(0, Math.floor((endsAt - Date.now()) / 1000)) : (p.durationMins || 25) * 60;
  const pct = endsAt ? Math.min(100, Math.round((1 - (endsAt - Date.now()) / ((p.durationMins||25)*60000)) * 100)) : 0;

  openModal(`
    <div style="display:flex;flex-direction:column;gap:0;padding:0 0 4px">

      <!-- Header bar -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 0 12px;border-bottom:1px solid var(--border);margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-size:16px">🤝</div>
          <div>
            <div style="font-weight:800;font-size:15px;line-height:1.2">Paired with <span style="color:#10b981">${escHtml(p.partnerName || 'Creator')}</span></div>
            <div style="font-size:11px;color:var(--text-s)" id="pair-status-line">● Live session · ${p.durationMins||25}m block</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:22px;font-weight:900;color:#a855f7;line-height:1" id="pair-countdown">${_fmtCountdown(secsLeft)}</div>
          <div style="font-size:10px;color:var(--text-s)">remaining</div>
        </div>
      </div>

      <!-- Progress bar -->
      <div style="height:4px;background:rgba(255,255,255,.07);border-radius:2px;margin-bottom:16px;overflow:hidden">
        <div id="pair-progress-bar" style="height:100%;width:${pct}%;background:linear-gradient(90deg,#a855f7,#ec4899);border-radius:2px;transition:width 1s linear"></div>
      </div>

      <!-- Message feed -->
      <div id="pair-msg-feed" style="flex:1;min-height:160px;max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:4px 0;margin-bottom:12px">
        <div style="text-align:center;color:var(--text-s);font-size:12px;padding:16px 0" id="pair-feed-empty">
          <div style="font-size:24px;margin-bottom:4px">💬</div>
          Loading messages…
        </div>
      </div>

      <!-- Quick emoji row -->
      <div style="display:flex;gap:6px;margin-bottom:10px;overflow-x:auto;padding-bottom:2px">
        ${PAIR_QUICK_EMOJIS.map(e => `<button onclick="_sendPairEmoji('${e}')" style="flex-shrink:0;font-size:18px;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:8px;padding:5px 8px;cursor:pointer;transition:background .15s" onmouseover="this.style.background='rgba(168,85,247,.2)'" onmouseout="this.style.background='rgba(255,255,255,.06)'">${e}</button>`).join('')}
        <button onclick="_sendCheckin()" style="flex-shrink:0;font-size:11px;font-weight:700;color:#10b981;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);border-radius:8px;padding:5px 10px;cursor:pointer;white-space:nowrap">👋 Check In</button>
      </div>

      <!-- Text input -->
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input id="pair-msg-input" type="text" maxlength="200" placeholder="Message your partner…"
          style="flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text-p);font-size:13px;outline:none"
          onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();_sendPairMessage();}">
        <button class="btn-primary" onclick="_sendPairMessage()" style="padding:9px 14px;font-size:13px;flex-shrink:0">
          <i class="fas fa-paper-plane"></i>
        </button>
      </div>

      <!-- Action buttons -->
      <div style="display:flex;gap:8px">
        <button class="btn-sm" style="flex:1;justify-content:center;gap:6px" onclick="closeModal();switchTab('focus')">
          <i class="fas fa-bolt"></i> Focus Mode
        </button>
        <button class="btn-sm" style="flex:1;justify-content:center;color:var(--danger);border-color:var(--danger)" onclick="_leavePair()">
          <i class="fas fa-times"></i> End Session
        </button>
      </div>
    </div>
  `, true);

  // Show the focus-tab banner
  _updatePairBanner();

  // Load messages immediately
  _loadPairMessages();

  // Start polling: messages every 4s, pings every 6s
  if (_pairState.pingTimer) clearInterval(_pairState.pingTimer);
  if (_pairState.msgTimer) clearInterval(_pairState.msgTimer);
  _pairState.pingTimer = setInterval(_pollPartnerPing, 6000);
  _pairState.msgTimer  = setInterval(_loadPairMessages, 4000);

  // Precise second countdown
  if (_pairState.countdownInterval) clearInterval(_pairState.countdownInterval);
  _pairState.countdownInterval = setInterval(() => {
    if (!endsAt) return;
    const left = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
    const totalSecs = (p.durationMins||25)*60;
    const elapsed = totalSecs - left;
    const pctNow = Math.min(100, Math.round((elapsed/totalSecs)*100));
    const cdEl = document.getElementById('pair-countdown');
    const pbEl = document.getElementById('pair-progress-bar');
    if (cdEl) cdEl.textContent = _fmtCountdown(left);
    if (pbEl) pbEl.style.width = pctNow + '%';
    if (left === 0) {
      clearInterval(_pairState.countdownInterval);
      notify('⏰ Paired session complete! Great work, both of you! 🔥', 'success');
      _sendSystemMessage('Session complete! Great work 🎉');
      setTimeout(_leavePair, 3000);
    }
  }, 1000);
}

function _fmtCountdown(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `0:${String(s).padStart(2,'0')}`;
}

async function _loadPairMessages() {
  try {
    const res = await fetch('/api/pair/messages', { credentials: 'include' });
    const data = await res.json();
    const feed = document.getElementById('pair-msg-feed');
    if (!feed) return;
    const msgs = data.messages || [];
    if (msgs.length === 0) {
      feed.innerHTML = `<div style="text-align:center;color:var(--text-s);font-size:12px;padding:20px 0">
        <div style="font-size:22px;margin-bottom:4px">💬</div>
        Say hi to ${escHtml(_pairState.partnerName || 'your partner')}!
      </div>`;
      return;
    }
    // Only re-render if count changed (avoid scroll jumping)
    if (feed.dataset.count === String(msgs.length)) return;
    feed.dataset.count = msgs.length;
    const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    feed.innerHTML = msgs.map(m => _renderPairMsg(m)).join('');
    if (wasAtBottom || msgs.length <= 3) feed.scrollTop = feed.scrollHeight;
  } catch(e) {}
}

function _renderPairMsg(m) {
  const mine = m.mine;
  const isEmoji = m.type === 'emoji';
  const isSystem = m.type === 'system';
  if (isSystem) {
    return `<div style="text-align:center;font-size:11px;color:var(--text-s);padding:4px 0">${escHtml(m.text)}</div>`;
  }
  const time = m.at ? new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
  return `<div style="display:flex;flex-direction:column;align-items:${mine?'flex-end':'flex-start'};gap:2px">
    ${!mine ? `<div style="font-size:10px;color:var(--text-s);margin-left:8px">${escHtml(m.from)}</div>` : ''}
    <div style="max-width:78%;padding:${isEmoji?'4px 10px':'8px 12px'};border-radius:${mine?'14px 14px 4px 14px':'14px 14px 14px 4px'};background:${mine?'linear-gradient(135deg,rgba(168,85,247,.3),rgba(236,72,153,.2))':'rgba(255,255,255,.07)'};border:1px solid ${mine?'rgba(168,85,247,.3)':'var(--border)'};font-size:${isEmoji?'24px':'13px'};color:var(--text-p);word-break:break-word;line-height:1.4">
      ${escHtml(m.text)}
    </div>
    <div style="font-size:10px;color:var(--text-s);margin:0 8px">${time}</div>
  </div>`;
}

async function _sendPairMessage() {
  const inp = document.getElementById('pair-msg-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  inp.focus();
  try {
    await fetch('/api/pair/message', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text, type: 'text' })
    });
    await _loadPairMessages();
  } catch(e) { notify('Could not send message', 'error'); }
}

async function _sendPairEmoji(emoji) {
  try {
    await fetch('/api/pair/message', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text: emoji, type: 'emoji' })
    });
    await _loadPairMessages();
  } catch(e) {}
}

async function _sendSystemMessage(text) {
  try {
    await fetch('/api/pair/message', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text, type: 'system' })
    });
  } catch(e) {}
}

async function _sendCheckin() {
  try {
    const res = await fetch('/api/pair/checkin', { method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'}, body: '{}' });
    const data = await res.json();
    if (data.ok) {
      notify(`👋 Check-in sent to ${_pairState.partnerName}!`, 'success');
      // Also send as a message so it appears in the chat
      await fetch('/api/pair/message', {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ text: '👋 Checking in — how\'s it going?', type: 'text' })
      });
      await _loadPairMessages();
    } else { notify(data.error || 'Failed to send check-in', 'error'); }
  } catch(e) { notify('Network error', 'error'); }
}

async function _pollPartnerPing() {
  try {
    const res = await fetch('/api/pair/checkin', { credentials: 'include' });
    const data = await res.json();
    if (data.ping) {
      if (data.ping.type === 'partner_left') {
        notify(`${escHtml(data.ping.from)} ended the session`, 'info');
        clearInterval(_pairState.pollTimer);
        clearInterval(_pairState.pingTimer);
        clearInterval(_pairState.msgTimer);
        clearInterval(_pairState.countdownInterval);
        _pairState = { status: 'none', partner: null, sessionId: null, endsAt: null, pollTimer: null, pingTimer: null, msgTimer: null, countdownInterval: null };
        closeModal();
      } else if (data.ping.type === 'message') {
        // New message arrived — reload feed
        await _loadPairMessages();
        if (!document.getElementById('pair-msg-feed')) {
          // Modal is closed — show notification
          notify(`💬 ${escHtml(data.ping.from)}: ${escHtml((data.ping.preview||'').slice(0,40))}`, 'info');
        }
      } else {
        // Generic ping (check-in)
        const pingArea = document.getElementById('pair-ping-area');
        if (pingArea) {
          pingArea.innerHTML = `<div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:8px 12px;animation:fadeIn .3s ease;font-size:12px"><i class="fas fa-hand-pointer" style="color:#10b981"></i> <strong>${escHtml(data.ping.from)}</strong> just checked in! 👋</div>`;
          setTimeout(() => { const el = document.getElementById('pair-ping-area'); if(el) el.innerHTML=''; }, 6000);
        }
        notify(`👋 ${escHtml(data.ping.from)} checked in!`, 'success');
      }
    }
  } catch(e) {}
}

function _updatePairBanner() {
  const banner = document.getElementById('pair-session-banner');
  const nameEl = document.getElementById('pair-banner-name');
  const timeEl = document.getElementById('pair-banner-time');
  const pairBtn = document.getElementById('btn-pair');
  if (!banner) return;
  if (_pairState.status === 'paired' && _pairState.partnerName) {
    banner.style.display = 'flex';
    if (nameEl) nameEl.textContent = _pairState.partnerName;
    if (timeEl && _pairState.endsAt) {
      const left = Math.max(0, Math.round((new Date(_pairState.endsAt) - Date.now()) / 60000));
      timeEl.textContent = `· ${left}m left`;
    }
    if (pairBtn) { pairBtn.style.background = 'rgba(16,185,129,.2)'; pairBtn.style.borderColor = '#10b981'; pairBtn.title = `In session with ${_pairState.partnerName} — click to chat`; }
  } else {
    banner.style.display = 'none';
    if (pairBtn) { pairBtn.style.background = ''; pairBtn.style.borderColor = 'rgba(16,185,129,.4)'; pairBtn.title = 'Find an accountability partner'; }
  }
}

async function _leavePair() {
  clearInterval(_pairState.pollTimer);
  clearInterval(_pairState.pingTimer);
  clearInterval(_pairState.msgTimer);
  clearInterval(_pairState.countdownInterval);
  _pairState = { status: 'none', partner: null, sessionId: null, endsAt: null, pollTimer: null, pingTimer: null, msgTimer: null, countdownInterval: null };
  try { await fetch('/api/pair/leave', { method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'}, body: '{}' }); } catch(e) {}
  _updatePairBanner();
  closeModal();
  notify('Session ended', 'info');
}

// ══════════════════════════════════════════════════════════════════
// GROUPFLOW — Persistent accountability groups
// ══════════════════════════════════════════════════════════════════
let _gfState = { groups: [], activeGroup: null, messages: [], pollTimer: null, lastTs: 0 };

async function openGroupFlowModal() {
  if (!FS_USER) { notify('Sign in to use GroupFlow', 'info'); return; }
  closeModal();
  _renderGroupFlowLobby();
}

async function _renderGroupFlowLobby() {
  // Show loading state
  openModal(`<div style="text-align:center;padding:40px 20px"><i class="fas fa-spinner fa-spin" style="font-size:24px;color:var(--accent)"></i><div style="margin-top:12px;color:var(--text-s);font-size:13px">Loading your groups…</div></div>`);

  try {
    const r = await fetch('/api/groupflow/list', { credentials: 'include' });
    const d = await r.json();
    _gfState.groups = d.groups || [];
  } catch(e) { _gfState.groups = []; }

  const groups = _gfState.groups;
  const groupCards = groups.length ? groups.map(g => `
    <div onclick="_gfOpenGroup('${g.id}')" style="background:var(--bg-card);border:1px solid rgba(168,85,247,.2);border-radius:12px;padding:12px 14px;cursor:pointer;transition:.2s;display:flex;align-items:center;gap:12px;margin-bottom:8px" onmouseover="this.style.borderColor='rgba(168,85,247,.5)'" onmouseout="this.style.borderColor='rgba(168,85,247,.2)'">
      <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">👥</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
        <div style="font-size:11px;color:var(--text-m)">${g.memberCount || 1} member${g.memberCount!==1?'s':''} · by ${escHtml(g.ownerName)}</div>
      </div>
      <i class="fas fa-chevron-right" style="color:var(--text-s);font-size:12px;flex-shrink:0"></i>
    </div>`).join('') : `<div style="text-align:center;padding:24px 0;color:var(--text-s);font-size:13px"><div style="font-size:32px;margin-bottom:8px">👥</div>No groups yet — create one or join with an invite code.</div>`;

  openModal(`
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
        <div style="font-size:28px">👥</div>
        <div>
          <h2 style="font-weight:900;margin-bottom:2px">GroupFlow</h2>
          <p style="color:var(--text-s);font-size:12px">Accountability groups with shared focus &amp; group chat</p>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:18px">
        <button class="btn-primary" style="flex:1;gap:6px" onclick="_gfShowCreate()"><i class="fas fa-plus"></i> Create Group</button>
        <button class="btn-sm" style="flex:1;gap:6px" onclick="_gfShowJoin()"><i class="fas fa-link"></i> Join with Code</button>
      </div>
      <div id="gf-groups-list">${groupCards}</div>
    </div>
  `);
}

function _gfShowCreate() {
  openModal(`
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <button onclick="_renderGroupFlowLobby()" style="background:none;border:none;cursor:pointer;color:var(--text-s);font-size:14px;padding:4px"><i class="fas fa-arrow-left"></i></button>
        <h2 style="font-weight:900">Create a Group</h2>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-m)">Group Name</label>
          <input class="fs-in" id="gf-create-name" placeholder="e.g. Indie Hackers Cohort 3" style="margin-top:5px">
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-m)">Description (optional)</label>
          <input class="fs-in" id="gf-create-desc" placeholder="What does your group work on?" style="margin-top:5px">
        </div>
      </div>
      <button class="btn-primary" style="width:100%;margin-top:18px;gap:8px" onclick="_gfCreateGroup()"><i class="fas fa-users"></i> Create Group</button>
    </div>
  `);
}

function _gfShowJoin() {
  openModal(`
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <button onclick="_renderGroupFlowLobby()" style="background:none;border:none;cursor:pointer;color:var(--text-s);font-size:14px;padding:4px"><i class="fas fa-arrow-left"></i></button>
        <h2 style="font-weight:900">Join a Group</h2>
      </div>
      <p style="font-size:13px;color:var(--text-m);margin-bottom:16px">Enter the invite code shared by your group creator.</p>
      <input class="fs-in" id="gf-join-code" placeholder="e.g. A3BX92KP" style="font-size:18px;text-align:center;letter-spacing:3px;text-transform:uppercase">
      <button class="btn-primary" style="width:100%;margin-top:16px;gap:8px" onclick="_gfJoinGroup()"><i class="fas fa-door-open"></i> Join Group</button>
    </div>
  `);
}

async function _gfCreateGroup() {
  const name = document.getElementById('gf-create-name')?.value?.trim();
  const desc = document.getElementById('gf-create-desc')?.value?.trim();
  if (!name) { notify('Group name is required', 'warning'); return; }

  const btn = document.querySelector('#gf-create-name')?.closest('div')?.parentElement?.nextElementSibling;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…'; }

  try {
    const r = await fetch('/api/groupflow/create', { method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, description: desc }) });
    const d = await r.json();
    if (!d.ok) { notify(d.error || 'Failed to create group', 'error'); return; }
    _gfState.groups.push(d.group);
    notify(`✅ "${d.group.name}" created! Invite code: ${d.inviteCode}`, 'success');
    _gfOpenGroup(d.group.id, d.group, d.inviteCode);
  } catch(e) { notify('Network error', 'error'); }
}

async function _gfJoinGroup() {
  const code = document.getElementById('gf-join-code')?.value?.trim().toUpperCase();
  if (!code) { notify('Invite code is required', 'warning'); return; }

  const btn = document.getElementById('gf-join-code')?.nextElementSibling;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Joining…'; }

  try {
    const r = await fetch('/api/groupflow/join', { method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (!d.ok) { notify(d.error || 'Invalid invite code', 'error'); if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-door-open"></i> Join Group'; } return; }
    if (!_gfState.groups.find(g => g.id === d.group.id)) _gfState.groups.push(d.group);
    notify(d.alreadyMember ? 'Already a member!' : `✅ Joined "${d.group.name}"!`, 'success');
    _gfOpenGroup(d.group.id, d.group);
  } catch(e) { notify('Network error', 'error'); }
}

async function _gfOpenGroup(groupId, groupObj, showInviteCode) {
  // Get group info from cache or fetch
  const group = groupObj || _gfState.groups.find(g => g.id === groupId);
  if (!group) { notify('Group not found', 'error'); return; }

  _gfState.activeGroup = group;
  clearInterval(_gfState.pollTimer);
  _gfState.lastTs = 0;

  // Fetch messages
  let messages = [];
  try {
    const r = await fetch(`/api/groupflow/${groupId}/messages`, { credentials: 'include' });
    const d = await r.json();
    messages = d.messages || [];
    _gfState.messages = messages;
    _gfState.lastTs = messages.length ? Math.max(...messages.map(m => m.ts)) : 0;
  } catch(e) {}

  _renderGroupChat(group, messages, showInviteCode);

  // Poll for new messages every 4 seconds
  _gfState.pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/groupflow/${groupId}/messages?since=${_gfState.lastTs}`, { credentials: 'include' });
      const d = await r.json();
      const newMsgs = d.messages || [];
      if (newMsgs.length) {
        _gfState.messages = [..._gfState.messages, ...newMsgs];
        _gfState.lastTs = Math.max(..._gfState.messages.map(m => m.ts));
        _gfAppendMessages(newMsgs);
      }
    } catch(e) {}
  }, 4000);
}

function _renderGroupChat(group, messages, showInviteCode) {
  const inviteBanner = showInviteCode ? `
    <div style="background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.3);border-radius:10px;padding:10px 12px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--accent)">🎉 Group created! Share your invite code:</div>
        <div style="font-size:20px;font-weight:900;letter-spacing:4px;font-family:monospace;margin-top:2px">${showInviteCode}</div>
      </div>
      <button onclick="navigator.clipboard.writeText('${showInviteCode}').then(()=>notify('📋 Invite code copied!','success'))" class="btn-sm" style="gap:6px;color:var(--accent);border-color:rgba(168,85,247,.4)"><i class="fas fa-copy"></i> Copy</button>
    </div>` : '';

  const msgsHtml = messages.length ? messages.map(m => _gfRenderMsg(m)).join('') : `<div style="text-align:center;padding:32px 0;color:var(--text-s);font-size:13px">No messages yet. Say hi! 👋</div>`;

  openModal(`
    <div style="display:flex;flex-direction:column;height:580px;max-height:80vh">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)">
        <button onclick="clearInterval(_gfState.pollTimer);_renderGroupFlowLobby()" style="background:none;border:none;cursor:pointer;color:var(--text-s);font-size:14px;padding:4px 6px"><i class="fas fa-arrow-left"></i></button>
        <div style="width:34px;height:34px;border-radius:8px;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">👥</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(group.name)}</div>
          <div style="font-size:11px;color:var(--text-s)">${group.memberCount || '?'} members</div>
        </div>
        <button onclick="_gfShowGroupInfo('${group.id}')" style="background:none;border:none;cursor:pointer;color:var(--text-s);font-size:14px;padding:4px 6px" title="Group info &amp; invite"><i class="fas fa-ellipsis-v"></i></button>
      </div>
      ${inviteBanner}
      <!-- Messages -->
      <div id="gf-messages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px;scrollbar-width:thin">
        ${msgsHtml}
      </div>
      <!-- Input -->
      <div style="padding-top:10px;border-top:1px solid var(--border);margin-top:10px">
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div style="flex:1;position:relative">
            <textarea id="gf-msg-input" class="fs-in" placeholder="Message the group…" rows="1" style="resize:none;padding-right:36px;min-height:38px;max-height:100px;overflow-y:auto" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();_gfSendMessage()}" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button onclick="_gfShowEmojiPicker()" class="btn-sm" title="Emoji" style="padding:8px 10px"><i class="fas fa-face-smile"></i></button>
            <button onclick="_gfTriggerMediaUpload()" class="btn-sm" title="Share image or video link" style="padding:8px 10px"><i class="fas fa-image"></i></button>
            <button onclick="_gfSendMessage()" class="btn-primary" style="padding:8px 16px;gap:6px"><i class="fas fa-paper-plane"></i></button>
          </div>
        </div>
      </div>
    </div>
  `);

  // Scroll to bottom
  setTimeout(() => { const el = document.getElementById('gf-messages'); if(el) el.scrollTop = el.scrollHeight; }, 50);
}

function _gfRenderMsg(m) {
  if (m.type === 'system') {
    return `<div style="text-align:center;font-size:11px;color:var(--text-s);padding:4px 0">${escHtml(m.text)}</div>`;
  }
  const isMe = m.mine;
  const avatar = m.fromAvatar ? `<img src="${m.fromAvatar}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <div style="display:none;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${(m.fromName||'?')[0].toUpperCase()}</div>` :
    `<div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${(m.fromName||'?')[0].toUpperCase()}</div>`;

  const mediaHtml = m.mediaUrl ? _gfRenderMedia(m.mediaUrl, m.type) : '';

  const reactionsHtml = Object.keys(m.reactions||{}).length ? `
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px">
      ${Object.entries(m.reactions||{}).map(([emoji, users]) => users.length ? `
        <button onclick="_gfReact('${m.id}','${emoji}')" style="background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.25);border-radius:99px;padding:2px 7px;cursor:pointer;font-size:12px;color:var(--text-p);display:flex;align-items:center;gap:3px">
          ${emoji} <span style="font-size:10px;font-weight:700">${users.length}</span>
        </button>` : '').join('')}
    </div>` : '';

  const addReactionBtn = `<button onclick="_gfShowReactionPicker('${m.id}')" style="background:none;border:none;cursor:pointer;opacity:0;transition:.15s;font-size:13px;padding:2px 5px;color:var(--text-s)" class="gf-react-btn" title="React">😀</button>`;

  const timestamp = new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return `<div class="gf-msg" style="display:flex;gap:8px;align-items:flex-start;${isMe?'flex-direction:row-reverse':''}" onmouseover="this.querySelector('.gf-react-btn').style.opacity='1'" onmouseout="this.querySelector('.gf-react-btn').style.opacity='0'">
    ${!isMe ? `<div style="display:flex;flex-direction:column;align-items:center">${avatar}</div>` : ''}
    <div style="max-width:75%;min-width:0">
      ${!isMe ? `<div style="font-size:10px;font-weight:700;color:var(--accent);margin-bottom:3px">${escHtml(m.fromName)}</div>` : ''}
      <div style="background:${isMe?'rgba(168,85,247,.18)':'var(--bg-card)'};border:1px solid ${isMe?'rgba(168,85,247,.3)':'var(--border)'};border-radius:${isMe?'14px 4px 14px 14px':'4px 14px 14px 14px'};padding:8px 12px;word-break:break-word">
        ${m.text ? `<div style="font-size:13px;line-height:1.5">${escHtml(m.text)}</div>` : ''}
        ${mediaHtml}
      </div>
      ${reactionsHtml}
      <div style="display:flex;align-items:center;gap:4px;margin-top:3px;${isMe?'justify-content:flex-end':''}">
        <span style="font-size:9px;color:var(--text-s)">${timestamp}</span>
        ${addReactionBtn}
      </div>
    </div>
  </div>`;
}

function _gfRenderMedia(url, type) {
  // Detect YouTube
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
  if (ytMatch) {
    return `<div style="margin-top:6px;border-radius:8px;overflow:hidden;aspect-ratio:16/9;max-width:280px">
      <iframe src="https://www.youtube.com/embed/${ytMatch[1]}" style="width:100%;height:100%;border:none" allowfullscreen></iframe>
    </div>`;
  }
  // Detect Loom
  if (url.includes('loom.com/share/')) {
    const loomId = url.split('loom.com/share/')[1].split('?')[0];
    return `<div style="margin-top:6px;border-radius:8px;overflow:hidden;aspect-ratio:16/9;max-width:280px">
      <iframe src="https://www.loom.com/embed/${loomId}" style="width:100%;height:100%;border:none" allowfullscreen></iframe>
    </div>`;
  }
  // Image
  if (type === 'image' || /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) {
    return `<div style="margin-top:6px"><img src="${url}" style="max-width:240px;max-height:200px;border-radius:8px;display:block;cursor:pointer" onclick="window.open('${url}','_blank')" onerror="this.parentElement.innerHTML='<a href=${url} target=_blank style=color:var(--accent);font-size:12px>${escHtml(url)}</a>'"></div>`;
  }
  // Generic link
  return `<div style="margin-top:4px"><a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);font-size:12px;word-break:break-all">${escHtml(url)}</a></div>`;
}

function _gfAppendMessages(newMsgs) {
  const container = document.getElementById('gf-messages');
  if (!container) return;
  // Remove "no messages" placeholder if present
  const empty = container.querySelector('div[style*="text-align:center"]');
  if (empty && empty.textContent.includes('No messages yet')) empty.remove();

  newMsgs.forEach(m => {
    const div = document.createElement('div');
    div.innerHTML = _gfRenderMsg(m);
    container.appendChild(div.firstElementChild);
  });
  container.scrollTop = container.scrollHeight;
}

async function _gfSendMessage() {
  const input = document.getElementById('gf-msg-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!_gfState.activeGroup) return;

  input.value = '';
  input.style.height = 'auto';

  try {
    const r = await fetch(`/api/groupflow/${_gfState.activeGroup.id}/messages`, {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text })
    });
    const d = await r.json();
    if (d.ok && d.message) {
      _gfState.messages.push(d.message);
      _gfState.lastTs = d.message.ts;
      _gfAppendMessages([d.message]);
    }
  } catch(e) { notify('Failed to send message', 'error'); }
}

function _gfShowReactionPicker(messageId) {
  const emojis = ['👍','❤️','🔥','💯','🎉','😂','🚀','👏','💪','✅','🤝','⚡'];
  const picker = document.createElement('div');
  picker.id = 'gf-reaction-picker';
  picker.style.cssText = 'position:fixed;z-index:9999;background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:8px;display:flex;flex-wrap:wrap;gap:4px;max-width:200px;box-shadow:0 8px 32px rgba(0,0,0,.4)';
  picker.innerHTML = emojis.map(e => `<button onclick="_gfReact('${messageId}','${e}');document.getElementById('gf-reaction-picker')?.remove()" style="background:none;border:none;cursor:pointer;font-size:18px;padding:4px;border-radius:6px;transition:.15s" onmouseover="this.style.background='rgba(168,85,247,.2)'" onmouseout="this.style.background='none'">${e}</button>`).join('');
  // Position near cursor
  document.body.appendChild(picker);
  const rect = picker.getBoundingClientRect();
  picker.style.left = `${Math.min(window.event?.clientX || 200, window.innerWidth - rect.width - 10)}px`;
  picker.style.top = `${Math.min(window.event?.clientY || 200, window.innerHeight - rect.height - 10)}px`;
  setTimeout(() => document.addEventListener('click', function rem(e) { if(!picker.contains(e.target)){picker.remove();document.removeEventListener('click',rem);} }), 50);
}

async function _gfReact(messageId, emoji) {
  if (!_gfState.activeGroup) return;
  try {
    await fetch(`/api/groupflow/${_gfState.activeGroup.id}/react`, {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ messageId, emoji })
    });
    // Refresh messages to show updated reactions
    const r = await fetch(`/api/groupflow/${_gfState.activeGroup.id}/messages`, { credentials: 'include' });
    const d = await r.json();
    _gfState.messages = d.messages || [];
    // Re-render messages in container
    const container = document.getElementById('gf-messages');
    if (container) {
      const scroll = container.scrollTop;
      container.innerHTML = _gfState.messages.map(m => _gfRenderMsg(m)).join('');
      container.scrollTop = scroll;
    }
  } catch(e) {}
}

function _gfShowEmojiPicker() {
  const input = document.getElementById('gf-msg-input');
  if (!input) return;
  const emojis = ['😀','😂','🔥','💯','🎉','❤️','🚀','👏','💪','🤝','⚡','✅','🎯','💡','🎵','📝'];
  const picker = document.createElement('div');
  picker.style.cssText = 'position:fixed;z-index:9999;background:var(--bg-panel);border:1px solid var(--border);border-radius:12px;padding:8px;display:flex;flex-wrap:wrap;gap:4px;max-width:200px;box-shadow:0 8px 32px rgba(0,0,0,.4)';
  picker.innerHTML = emojis.map(e => `<button onclick="document.getElementById('gf-msg-input').value+=('${e}');this.parentElement.remove()" style="background:none;border:none;cursor:pointer;font-size:18px;padding:4px;border-radius:6px" onmouseover="this.style.background='rgba(168,85,247,.2)'" onmouseout="this.style.background='none'">${e}</button>`).join('');
  document.body.appendChild(picker);
  const inputRect = input.getBoundingClientRect();
  picker.style.left = `${inputRect.left}px`;
  picker.style.bottom = `${window.innerHeight - inputRect.top + 8}px`;
  setTimeout(() => document.addEventListener('click', function rem(e) { if(!picker.contains(e.target)){picker.remove();document.removeEventListener('click',rem);} }), 50);
}

function _gfTriggerMediaUpload() {
  openModal(`
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <button onclick="_renderGroupChat(_gfState.activeGroup,_gfState.messages)" style="background:none;border:none;cursor:pointer;color:var(--text-s);font-size:14px;padding:4px"><i class="fas fa-arrow-left"></i></button>
        <h2 style="font-weight:900">Share Media</h2>
      </div>
      <p style="font-size:13px;color:var(--text-m);margin-bottom:16px">Paste an image URL, YouTube video, or Loom link to share it with your group.</p>
      <input class="fs-in" id="gf-media-url" placeholder="https://youtube.com/watch?v=... or image URL" style="margin-bottom:12px">
      <div style="display:flex;gap:8px">
        <button class="btn-primary" style="flex:1;gap:6px" onclick="_gfSendMedia('image')"><i class="fas fa-image"></i> Share Image</button>
        <button class="btn-sm" style="flex:1;gap:6px" onclick="_gfSendMedia('video')"><i class="fas fa-video"></i> Share Video</button>
      </div>
      <div style="margin-top:12px;padding:10px;background:rgba(168,85,247,.06);border-radius:8px;font-size:11px;color:var(--text-m)">
        <div style="font-weight:700;margin-bottom:4px">Supported formats:</div>
        <div>📺 YouTube — auto-embeds the video player</div>
        <div>🎥 Loom — auto-embeds the Loom viewer</div>
        <div>🖼️ Direct image URLs (.png, .jpg, .gif, .webp)</div>
        <div>🔗 Any URL — shows as a clickable link</div>
      </div>
    </div>
  `);
}

async function _gfSendMedia(type) {
  const url = document.getElementById('gf-media-url')?.value?.trim();
  if (!url) { notify('Please enter a URL', 'warning'); return; }
  if (!_gfState.activeGroup) return;

  try {
    const r = await fetch(`/api/groupflow/${_gfState.activeGroup.id}/messages`, {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text: '', mediaUrl: url, mediaType: type })
    });
    const d = await r.json();
    if (d.ok && d.message) {
      _gfState.messages.push(d.message);
      _gfState.lastTs = d.message.ts;
      _renderGroupChat(_gfState.activeGroup, _gfState.messages);
    }
  } catch(e) { notify('Failed to share media', 'error'); }
}

async function _gfShowGroupInfo(groupId) {
  const group = _gfState.activeGroup;
  if (!group) return;

  let members = [];
  try {
    const r = await fetch(`/api/groupflow/${groupId}/members`, { credentials: 'include' });
    const d = await r.json();
    members = d.members || [];
  } catch(e) {}

  const inviteUrl = `https://flowst8.cc/?gfinvite=${group.inviteCode}`;

  openModal(`
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <button onclick="_renderGroupChat(_gfState.activeGroup,_gfState.messages)" style="background:none;border:none;cursor:pointer;color:var(--text-s);font-size:14px;padding:4px"><i class="fas fa-arrow-left"></i></button>
        <h2 style="font-weight:900">${escHtml(group.name)}</h2>
      </div>
      ${group.description ? `<p style="font-size:13px;color:var(--text-m);margin-bottom:14px">${escHtml(group.description)}</p>` : ''}
      <!-- Invite -->
      <div style="background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.25);border-radius:10px;padding:12px;margin-bottom:16px">
        <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px"><i class="fas fa-link"></i> Invite Code</div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:22px;font-weight:900;letter-spacing:4px;font-family:monospace;color:var(--text-p)">${group.inviteCode}</div>
          <button onclick="navigator.clipboard.writeText('${group.inviteCode}').then(()=>notify('📋 Copied!','success'))" class="btn-sm" style="gap:5px"><i class="fas fa-copy"></i></button>
          <button onclick="if(navigator.share){navigator.share({title:'Join ${escHtml(group.name)} on FlowState',text:'Join our GroupFlow accountability group!',url:'${inviteUrl}'}).catch(()=>{});}else{navigator.clipboard.writeText('${inviteUrl}').then(()=>notify('📋 Link copied!','success'));}" class="btn-sm" style="gap:5px"><i class="fas fa-share"></i></button>
        </div>
      </div>
      <!-- Members -->
      <div style="font-size:12px;font-weight:700;color:var(--text-m);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Members (${members.length})</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
        ${members.map(m => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-card);border-radius:8px">
            <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${(m.name||'?')[0].toUpperCase()}</div>
            <div style="flex:1">
              <div style="font-size:13px;font-weight:600">${escHtml(m.name)}</div>
            </div>
            ${m.role==='owner'?`<span style="font-size:10px;padding:1px 6px;background:rgba(168,85,247,.15);color:var(--accent);border-radius:4px;font-weight:700">Owner</span>`:''}
          </div>`).join('')}
      </div>
      <button onclick="_gfLeaveGroup('${groupId}')" class="btn-sm" style="width:100%;color:#ef4444;border-color:rgba(239,68,68,.3);gap:6px"><i class="fas fa-right-from-bracket"></i> Leave Group</button>
    </div>
  `);
}

async function _gfLeaveGroup(groupId) {
  if (!confirm('Leave this group? You can rejoin with an invite code.')) return;
  try {
    await fetch(`/api/groupflow/${groupId}/leave`, { method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'}, body: '{}' });
    _gfState.groups = _gfState.groups.filter(g => g.id !== groupId);
    clearInterval(_gfState.pollTimer);
    notify('Left group', 'info');
    _renderGroupFlowLobby();
  } catch(e) { notify('Failed to leave group', 'error'); }
}

// Handle invite code from URL on page load
(function _checkGroupFlowInviteUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('gfinvite');
  if (code && !sessionStorage.getItem('gf_invite_handled')) {
    sessionStorage.setItem('gf_invite_handled', '1');
    setTimeout(async () => {
      if (!FS_USER) { notify('Sign in to join the FlowState group!', 'info'); return; }
      // Preview group
      try {
        const r = await fetch(`/api/groupflow/invite/${code}`);
        const d = await r.json();
        if (d.group) {
          openModal(`
            <div style="text-align:center;padding:12px 0">
              <div style="font-size:40px;margin-bottom:8px">👥</div>
              <h2 style="font-weight:900;margin-bottom:4px">You're invited!</h2>
              <p style="color:var(--text-s);font-size:14px;margin-bottom:4px">Join <strong>${escHtml(d.group.name)}</strong></p>
              <p style="color:var(--text-s);font-size:12px;margin-bottom:20px">${d.group.memberCount} member${d.group.memberCount!==1?'s':''} · by ${escHtml(d.group.ownerName)}</p>
              <button class="btn-primary" style="width:100%;gap:8px;margin-bottom:8px" onclick="document.getElementById('gf-invite-code-hidden').value='${code}';_gfJoinFromUrl()"><i class="fas fa-door-open"></i> Join Group</button>
              <input id="gf-invite-code-hidden" type="hidden" value="${code}">
              <button onclick="closeModal()" class="btn-sm" style="width:100%">Maybe later</button>
            </div>
          `);
        }
      } catch(e) {}
    }, 2000);
  }
})();

async function _gfJoinFromUrl() {
  const code = document.getElementById('gf-invite-code-hidden')?.value;
  if (!code) return;
  try {
    const r = await fetch('/api/groupflow/join', { method: 'POST', credentials: 'include', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (d.ok) { notify(d.alreadyMember ? 'Already a member!' : `✅ Joined "${d.group.name}"!`, 'success'); _gfOpenGroup(d.group.id, d.group); }
    else notify(d.error || 'Could not join', 'error');
  } catch(e) { notify('Network error', 'error'); }
}

// ── Add Flow Coach + Pair buttons to settings modal (patch) ──────────────────
const _origOpenSettingsModal = openSettingsModal;
// Expose helpers globally
window.openFlowCoach = openFlowCoach;
window.openPairingModal = openPairingModal;
window.openGroupFlowModal = openGroupFlowModal;

// ══════════════════════════════════════════════════════════════════════════════
// AI CODE WORKSPACE — GitHub OAuth + AI Code Generation
// ══════════════════════════════════════════════════════════════════════════════
let _codeState = {
  ghConnected: false, ghUser: null,
  repos: [], selectedRepo: null, selectedBranch: 'main',
  fileTree: [], activeFile: null, activeFileSha: null, activeFileContent: '',
  generatedFiles: {},   // path → { content, sha }
  generating: false,
};

// ── Init ──────────────────────────────────────────────────────────────────────
function initCodeWorkspace() {
  // Use server-injected FS_GITHUB if available
  if (typeof FS_GITHUB !== 'undefined' && FS_GITHUB) {
    _codeState.ghConnected = true;
    _codeState.ghUser = FS_GITHUB;
    _codeRenderConnected();
    _codeLoadRepos();
  } else {
    _codeRenderDisconnected();
  }
  _codeUpdateGHStatus();
}

function _codeRenderConnected() {
  const conn = document.getElementById('code-gh-connected');
  const disc = document.getElementById('code-gh-disconnected');
  if (conn) conn.style.display = 'block';
  if (disc) disc.style.display = 'none';
  const u = _codeState.ghUser;
  if (!u) return;
  const av = document.getElementById('code-gh-avatar');
  const nm = document.getElementById('code-gh-name');
  const lg = document.getElementById('code-gh-login');
  if (av) av.src = u.avatar_url || '';
  if (nm) nm.textContent = u.name || u.login;
  if (lg) lg.textContent = '@' + u.login;
}

function _codeRenderDisconnected() {
  const conn = document.getElementById('code-gh-connected');
  const disc = document.getElementById('code-gh-disconnected');
  if (conn) conn.style.display = 'none';
  if (disc) disc.style.display = 'block';
}

// ── GitHub Connect ────────────────────────────────────────────────────────────
function codeConnectGitHub() {
  const w = window.open('/api/auth/github', 'github_oauth', 'width=600,height=700,scrollbars=yes');
  const handler = (e) => {
    if (e.data?.type === 'github_connected') {
      window.removeEventListener('message', handler);
      _codeState.ghConnected = true;
      _codeState.ghUser = { login: e.data.login, name: e.data.name, avatar_url: e.data.avatar };
      _codeRenderConnected();
      _codeLoadRepos();
      _codeUpdateGHStatus();
      codeLog('✅ GitHub connected as @' + e.data.login, 'success');
    }
  };
  window.addEventListener('message', handler);
  // Also poll for window close in case postMessage doesn't fire
  const poll = setInterval(() => {
    if (w?.closed) { clearInterval(poll); window.removeEventListener('message', handler); }
  }, 500);
}

async function codeGHDisconnect() {
  await fetch('/api/auth/github/disconnect', { credentials: 'include' });
  _codeState.ghConnected = false;
  _codeState.ghUser = null;
  _codeState.repos = [];
  _codeState.selectedRepo = null;
  _codeState.fileTree = [];
  _codeRenderDisconnected();
  _codeRenderFileTree([]);
  _codeUpdateGHStatus();
  codeLog('GitHub disconnected', 'info');
}

// ── Repos ─────────────────────────────────────────────────────────────────────
async function _codeLoadRepos() {
  codeLog('Loading repositories…', 'info');
  try {
    const res  = await fetch('/api/github/repos', { credentials: 'include' });
    const data = await res.json();
    if (data.error) { codeLog('Could not load repos: ' + data.error, 'error'); return; }
    _codeState.repos = data.repos || [];
    const sel = document.getElementById('code-repo-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select a repository —</option>' +
      _codeState.repos.map(r =>
        `<option value="${escHtml(r.full_name)}">${escHtml(r.full_name)}${r.private ? ' 🔒' : ''} ${r.language ? '· ' + r.language : ''}</option>`
      ).join('');
    codeLog(`Loaded ${_codeState.repos.length} repositories`, 'success');
    _codeUpdateGHStatus();
  } catch(e) { codeLog('Network error loading repos', 'error'); }
}

async function codeSelectRepo(fullName) {
  if (!fullName) { _codeState.selectedRepo = null; _codeRenderFileTree([]); return; }
  const repo = _codeState.repos.find(r => r.full_name === fullName);
  _codeState.selectedRepo = repo || { full_name: fullName, default_branch: 'main' };
  _codeState.selectedBranch = _codeState.selectedRepo.default_branch || 'main';
  codeLog(`Loading file tree for ${fullName}…`, 'info');
  _codeRenderFileTree(null); // show loading
  try {
    const res  = await fetch(`/api/github/tree?repo=${encodeURIComponent(fullName)}&branch=${_codeState.selectedBranch}`, { credentials: 'include' });
    const data = await res.json();
    if (data.error) { codeLog('Could not load file tree: ' + data.error, 'error'); _codeRenderFileTree([]); return; }
    _codeState.fileTree = data.tree || [];
    _codeRenderFileTree(_codeState.fileTree);
    codeLog(`Loaded ${_codeState.fileTree.length} files from ${fullName}`, 'success');
  } catch(e) { codeLog('Error loading file tree', 'error'); _codeRenderFileTree([]); }
}

// ── File Tree ─────────────────────────────────────────────────────────────────
function _codeRenderFileTree(tree) {
  const el = document.getElementById('code-file-tree');
  if (!el) return;
  if (tree === null) { el.innerHTML = '<div class="code-file-empty"><i class="fas fa-spinner fa-spin"></i> Loading…</div>'; return; }
  if (!tree.length)  { el.innerHTML = '<div class="code-file-empty">No files found</div>'; return; }
  // Only show blobs (files), group dirs
  const files = tree.filter(f => f.type === 'blob').slice(0, 200);
  el.innerHTML = files.map(f => {
    const icon = _codeFileIcon(f.path);
    const isAI = _codeState.generatedFiles[f.path];
    return `<button class="code-file-item${isAI ? ' ai-generated' : ''}" onclick="codeOpenFile('${escHtml(f.path).replace(/'/g,"\\'")}')">
      <i class="${icon}"></i><span style="overflow:hidden;text-overflow:ellipsis">${escHtml(f.path)}</span>
    </button>`;
  }).join('');
}

function _codeFileIcon(path) {
  const ext = path.split('.').pop().toLowerCase();
  const map = { js:'fab fa-js-square', ts:'fab fa-js-square', jsx:'fab fa-react', tsx:'fab fa-react',
    html:'fab fa-html5', css:'fab fa-css3-alt', scss:'fab fa-css3-alt', less:'fab fa-css3-alt',
    py:'fab fa-python', rb:'fas fa-gem', php:'fab fa-php', go:'fas fa-code',
    md:'fas fa-file-alt', json:'fas fa-brackets-curly', yaml:'fas fa-file-code', yml:'fas fa-file-code',
    sql:'fas fa-database', sh:'fas fa-terminal', env:'fas fa-key', gitignore:'fab fa-git-alt',
    png:'fas fa-image', jpg:'fas fa-image', svg:'fas fa-image', gif:'fas fa-image',
    txt:'fas fa-file-lines', pdf:'fas fa-file-pdf', zip:'fas fa-file-zipper',
  };
  return map[ext] || 'fas fa-file-code';
}

// ── Open file from GitHub ─────────────────────────────────────────────────────
async function codeOpenFile(path) {
  if (!_codeState.selectedRepo) return;
  // Check if we already have it in generated files
  if (_codeState.generatedFiles[path]) {
    _codeState.activeFile = path;
    _codeState.activeFileContent = _codeState.generatedFiles[path].content;
    _codeState.activeFileSha = _codeState.generatedFiles[path].sha || null;
    _codeRenderCode(_codeState.activeFileContent, path);
    return;
  }
  codeLog(`Opening ${path}…`, 'info');
  _codeSetActiveBadge(path);
  const editor = document.getElementById('code-editor-wrap');
  if (editor) editor.innerHTML = '<div class="code-generating"><div class="code-gen-pulse"></div><span>Loading file…</span></div>';
  try {
    const res  = await fetch(`/api/github/file?repo=${encodeURIComponent(_codeState.selectedRepo.full_name)}&path=${encodeURIComponent(path)}&branch=${_codeState.selectedBranch}`, { credentials: 'include' });
    const data = await res.json();
    if (data.error) { codeLog('Could not load file: ' + data.error, 'error'); return; }
    _codeState.activeFile = path;
    _codeState.activeFileContent = data.content;
    _codeState.activeFileSha = data.sha;
    _codeRenderCode(data.content, path);
    codeLog(`Opened ${path}`, 'success');
  } catch(e) { codeLog('Error loading file', 'error'); }
}

function _codeRenderCode(content, path) {
  const editor = document.getElementById('code-editor-wrap');
  const actions = document.getElementById('code-toolbar-actions');
  if (actions) actions.style.display = 'flex';
  if (!editor) return;
  // Simple syntax highlight by escaping HTML then colorizing keywords
  const escaped = content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  editor.innerHTML = `<div class="code-content">${escaped}</div>`;
  _codeSetActiveBadge(path);
  // Highlight active file in tree
  document.querySelectorAll('.code-file-item').forEach(el => {
    el.classList.toggle('active', el.textContent.trim().includes(path.split('/').pop()));
  });
}

function _codeSetActiveBadge(path) {
  const badge = document.getElementById('code-active-file');
  if (badge) badge.innerHTML = `<i class="${_codeFileIcon(path)}"></i> ${escHtml(path)}`;
}

// ── AI Code Generation ────────────────────────────────────────────────────────
async function codeGenerate() {
  if (_codeState.generating) return;
  if (!FS_USER) { notify('Sign in to use AI Code Workspace', 'info'); return; }
  const prompt = document.getElementById('code-prompt-input')?.value?.trim();
  if (!prompt) { notify('Describe what you want to build', 'warning'); return; }
  const lang = document.getElementById('code-lang-select')?.value || '';

  _codeState.generating = true;
  const btn = document.getElementById('btn-code-generate');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating…'; }

  const editor = document.getElementById('code-editor-wrap');
  if (editor) editor.innerHTML = `<div class="code-generating"><div class="code-gen-pulse"></div><span>AI is writing your code…</span></div>`;

  codeLog('🤖 AI generating: ' + prompt.slice(0,60) + (prompt.length>60?'…':''), 'ai');
  if (_codeState.selectedRepo) codeLog('Repo: ' + _codeState.selectedRepo.full_name, 'info');

  try {
    const res = await fetch('/api/github/ai-code', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        repo: _codeState.selectedRepo?.full_name || '',
        file: _codeState.activeFile || '',
        language: lang,
        existingCode: _codeState.activeFile ? _codeState.activeFileContent : '',
      })
    });
    const data = await res.json();
    if (data.error) { codeLog('AI error: ' + data.error, 'error'); return; }

    // Determine file path for generated code
    const filePath = _codeState.activeFile || _codeGuessFileName(prompt, lang);
    _codeState.activeFile = filePath;
    _codeState.activeFileContent = data.code;
    _codeState.generatedFiles[filePath] = { content: data.code, sha: _codeState.activeFileSha };

    _codeRenderCode(data.code, filePath);
    _codeAddGeneratedFileToPanel(filePath);
    codeLog('✅ Code generated — ' + data.code.split('\n').length + ' lines', 'success');

    // Prompt clear
    const inp = document.getElementById('code-prompt-input');
    if (inp) inp.value = '';
  } catch(e) {
    codeLog('Network error during generation', 'error');
    if (editor) editor.innerHTML = '<div class="code-welcome"><div style="font-size:32px">⚠️</div><div style="color:var(--text-s);font-size:13px;margin-top:12px">Generation failed. Try again.</div></div>';
  } finally {
    _codeState.generating = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate'; }
  }
}

function _codeGuessFileName(prompt, lang) {
  const p = prompt.toLowerCase();
  const extMap = { javascript:'js', typescript:'ts', python:'py', html:'html', css:'css', rust:'rs', go:'go', sql:'sql' };
  const ext = extMap[lang] || 'js';
  if (p.includes('api') || p.includes('endpoint') || p.includes('route')) return `src/api/${Date.now()}.${ext}`;
  if (p.includes('component') || p.includes('button') || p.includes('navbar')) return `src/components/${Date.now()}.${ext}`;
  if (p.includes('auth') || p.includes('login')) return `src/auth.${ext}`;
  if (p.includes('style') || p.includes('css')) return `src/styles.css`;
  if (p.includes('test')) return `src/__tests__/${Date.now()}.test.${ext}`;
  return `src/generated-${Date.now()}.${ext}`;
}

function _codeAddGeneratedFileToPanel(path) {
  const panel = document.getElementById('code-generated-files-panel');
  const list  = document.getElementById('code-gen-file-list');
  if (!panel || !list) return;
  panel.style.display = 'block';
  // Remove existing entry for same path
  list.querySelectorAll('.code-file-item').forEach(el => { if (el.dataset.path === path) el.remove(); });
  const btn = document.createElement('button');
  btn.className = 'code-file-item ai-generated';
  btn.dataset.path = path;
  btn.innerHTML = `<i class="${_codeFileIcon(path)}"></i><span style="overflow:hidden;text-overflow:ellipsis">${escHtml(path)}</span>`;
  btn.onclick = () => codeOpenFile(path);
  list.insertBefore(btn, list.firstChild);
}

// ── Push to GitHub ────────────────────────────────────────────────────────────
async function codePushToGitHub() {
  if (!_codeState.ghConnected) { notify('Connect GitHub first', 'warning'); return; }
  if (!_codeState.selectedRepo) { notify('Select a repository first', 'warning'); return; }
  if (!_codeState.activeFile || !_codeState.activeFileContent) { notify('No file to push', 'warning'); return; }
  const btn = document.getElementById('btn-code-push');
  if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pushing…'; btn.disabled = true; }
  codeLog(`Pushing ${_codeState.activeFile} to ${_codeState.selectedRepo.full_name}…`, 'info');
  try {
    const res = await fetch('/api/github/commit', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: _codeState.selectedRepo.full_name,
        path: _codeState.activeFile,
        content: _codeState.activeFileContent,
        message: `AI: Update ${_codeState.activeFile} via FlowState`,
        branch: _codeState.selectedBranch,
        sha: _codeState.activeFileSha || undefined,
      })
    });
    const data = await res.json();
    if (data.ok) {
      _codeState.activeFileSha = data.sha;
      if (_codeState.generatedFiles[_codeState.activeFile]) {
        _codeState.generatedFiles[_codeState.activeFile].sha = data.sha;
      }
      codeLog(`✅ Pushed to GitHub: ${_codeState.activeFile}`, 'success');
      notify('Pushed to GitHub!', 'success');
      _codeAddCommitEntry(_codeState.activeFile, data.url);
    } else {
      codeLog('Push failed: ' + (data.error || 'Unknown error'), 'error');
      notify('Push failed: ' + (data.error || 'Check console'), 'warning');
    }
  } catch(e) {
    codeLog('Network error during push', 'error');
  } finally {
    if (btn) { btn.innerHTML = '<i class="fab fa-github"></i> Push'; btn.disabled = false; }
  }
}

function _codeAddCommitEntry(path, url) {
  const wrap = document.getElementById('code-commit-log-wrap');
  const log  = document.getElementById('code-commit-log');
  if (!wrap || !log) return;
  wrap.style.display = 'block';
  const el = document.createElement('div');
  el.className = 'code-commit-entry';
  el.innerHTML = `<i class="fas fa-check" style="color:#10b981;margin-right:5px"></i>${escHtml(path)}<br>
    <span style="color:var(--text-m)">${new Date().toLocaleTimeString()}</span>
    ${url ? ` · <a href="${url}" target="_blank" style="color:#10b981;text-decoration:none">View</a>` : ''}`;
  log.insertBefore(el, log.firstChild);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function codeLog(msg, type='info') {
  const log = document.getElementById('code-activity-log');
  if (!log) return;
  const empty = log.querySelector('.code-log-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = `code-log-entry code-log-${type}`;
  el.textContent = msg;
  log.insertBefore(el, log.firstChild);
  // Keep last 40 entries
  while (log.children.length > 40) log.removeChild(log.lastChild);
}

function codeCopyContent() {
  if (!_codeState.activeFileContent) return;
  navigator.clipboard.writeText(_codeState.activeFileContent).then(() => notify('Code copied!', 'success'));
}

function _codeUpdateGHStatus() {
  const panel = document.getElementById('code-gh-status-panel');
  if (!panel) return;
  if (_codeState.ghConnected && _codeState.ghUser) {
    const repoCount = _codeState.repos.length;
    panel.innerHTML = `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#10b981"><i class="fas fa-circle" style="font-size:7px"></i> Connected as @${escHtml(_codeState.ghUser.login)}</div>
    ${repoCount ? `<div style="font-size:10px;color:var(--text-m);margin-top:3px">${repoCount} repos loaded</div>` : ''}
    ${_codeState.selectedRepo ? `<div style="font-size:10px;color:var(--accent);margin-top:3px"><i class="fas fa-code-branch"></i> ${escHtml(_codeState.selectedRepo.full_name)}</div>` : ''}`;
  } else {
    panel.innerHTML = `<div style="font-size:11px;color:var(--text-m)"><i class="fas fa-circle" style="font-size:7px;color:#ef4444;margin-right:5px"></i>Not connected</div>`;
  }
}

