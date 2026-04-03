/**
 * FLOWSTATE — INTENT LAYER
 * ========================
 * The single source of truth for all logic, routing decisions,
 * behavioral intelligence, and integration orchestration.
 *
 * ARCHITECTURE LAW: All new behavior is declared here.
 * The Action Layer executes. It does not decide.
 */

export type SessionPhase = 'focus' | 'short_break' | 'long_break' | 'idle';
export type ModelCapability = 'code' | 'creative' | 'analysis' | 'quick' | 'vision' | 'long_form';
export type TipCategory = 'posture' | 'hydration' | 'focus' | 'celebration' | 'break' | 'encouragement' | 'debugging';

// ── Intent Declarations ─────────────────────────────────────────────────────

export interface SessionIntent {
  phase: SessionPhase;
  duration: number; // seconds
  sessionNumber: number;
  totalFocusMinutes: number;
  idleSeconds: number;
  startedAt: number;
}

export interface TipIntent {
  category: TipCategory;
  trigger: string;
  urgency: 'low' | 'medium' | 'high';
  aiPromptContext: string;
}

export interface ModelRoutingIntent {
  userMessage: string;
  sessionContext: SessionIntent;
  detectedCapability: ModelCapability;
  selectedModel: string;
  rationale: string;
  systemPrompt: string;
}

export interface CelebrationIntent {
  type: 'focus_complete' | 'streak' | 'milestone' | 'break_complete';
  message: string;
  visualIntensity: 'subtle' | 'medium' | 'full';
  durationMs: number;
  particle: 'confetti' | 'glow' | 'sparks' | 'stars';
}

export interface BehaviorAggregateIntent {
  dataPoints: Record<string, number | string>;
  insight: string;
  surfaceAt: SessionPhase;
  priority: number;
}

// ── Model Routing Logic ─────────────────────────────────────────────────────

const MODEL_REGISTRY: Record<ModelCapability, { model: string; rationale: string }> = {
  code: {
    model: 'claude-3-5-sonnet',
    rationale: 'Code debugging and analysis — Claude excels at reasoning through complex code trees'
  },
  creative: {
    model: 'gpt-4o',
    rationale: 'Creative generation — GPT-4o balances imagination with coherence'
  },
  analysis: {
    model: 'gemini-1.5-pro',
    rationale: 'Long-form analysis — Gemini handles large context windows natively'
  },
  quick: {
    model: 'gpt-4o-mini',
    rationale: 'Quick Q&A — fastest model for simple queries'
  },
  vision: {
    model: 'gpt-4o',
    rationale: 'Vision tasks — GPT-4o vision is the most reliable'
  },
  long_form: {
    model: 'claude-3-5-sonnet',
    rationale: 'Long-form writing — Claude produces the most structured, nuanced prose'
  }
};

export function declareModelRouting(userMessage: string, session: SessionIntent): ModelRoutingIntent {
  const msg = userMessage.toLowerCase();

  let capability: ModelCapability = 'quick';

  // Intent detection — pure logic, declared here only
  if (/error|bug|debug|fix|crash|exception|stack trace|undefined|null|syntax|compile|runtime/.test(msg)) {
    capability = 'code';
  } else if (/write|story|poem|creative|imagine|describe|narrative|essay|blog|copy/.test(msg)) {
    capability = 'creative';
  } else if (/analyze|summarize|research|explain|compare|evaluate|report|insights/.test(msg)) {
    capability = 'analysis';
  } else if (/image|picture|generate|draw|design|visual|logo/.test(msg)) {
    capability = 'vision';
  } else if (msg.length > 300) {
    capability = 'long_form';
  }

  const { model, rationale } = MODEL_REGISTRY[capability];

  const sessionHours = session.totalFocusMinutes / 60;
  const isDeepSession = session.totalFocusMinutes > 90;
  const isCodeDebugging = capability === 'code';

  let systemPrompt = `You are FlowState's embedded AI — warm, precise, and deeply human. `;

  if (isDeepSession && isCodeDebugging) {
    systemPrompt += `The user has been working for ${Math.round(session.totalFocusMinutes)} minutes. Acknowledge the effort first. Then deliver the most precise, actionable answer possible. Be their second brain, not their search engine.`;
  } else if (isDeepSession) {
    systemPrompt += `The user is in a deep work session (${Math.round(session.totalFocusMinutes)}min). Keep your answer focused and scannable. Lead with the most important point.`;
  } else {
    systemPrompt += `Fresh session energy. Be direct, warm, and clear. The user is in their prime focus window. Match their momentum.`;
  }

  if (sessionHours > 3) {
    systemPrompt += ` Note: This person has been at it for over ${Math.round(sessionHours)} hours. Keep it human.`;
  }

  return {
    userMessage,
    sessionContext: session,
    detectedCapability: capability,
    selectedModel: model,
    rationale,
    systemPrompt
  };
}

// ── Tip Bubble Logic ────────────────────────────────────────────────────────

export function declareTipIntent(session: SessionIntent): TipIntent | null {
  const { idleSeconds, totalFocusMinutes, phase, sessionNumber } = session;

  // No tips during break phases — respect the rest
  if (phase === 'short_break' || phase === 'long_break') return null;

  // Posture reminder — 45+ minutes continuous
  if (totalFocusMinutes >= 45 && totalFocusMinutes % 45 < 1) {
    return {
      category: 'posture',
      trigger: `${totalFocusMinutes} minutes of continuous focus`,
      urgency: 'medium',
      aiPromptContext: `The user has been working for ${totalFocusMinutes} minutes straight. Write a warm, brief posture/movement reminder. Reference their specific session length. Tone: like a good friend who notices.`
    };
  }

  // Hydration — every 60 minutes
  if (totalFocusMinutes > 0 && totalFocusMinutes % 60 < 1) {
    return {
      category: 'hydration',
      trigger: `${totalFocusMinutes} minutes — hydration checkpoint`,
      urgency: 'low',
      aiPromptContext: `The user has been working for ${totalFocusMinutes} minutes. Write a brief, warm hydration reminder. Don't be preachy. Be human.`
    };
  }

  // Deep debugging encouragement — long session on code
  if (totalFocusMinutes >= 47 && sessionNumber >= 2) {
    return {
      category: 'debugging',
      trigger: 'Extended debug session detected',
      urgency: 'medium',
      aiPromptContext: `The user is deep in session ${sessionNumber}, ${totalFocusMinutes} minutes in. They might be debugging something hard. Write an encouraging message that acknowledges the difficulty and keeps them motivated. Don't be generic.`
    };
  }

  // Idle warning — 2+ minutes idle during focus
  if (idleSeconds > 120 && phase === 'focus') {
    return {
      category: 'focus',
      trigger: 'Idle detected during focus session',
      urgency: 'low',
      aiPromptContext: `The user went idle for ${Math.round(idleSeconds / 60)} minutes during their focus session. Gently pull them back. Not judgmental — just a gentle nudge. They might be thinking, stuck, or distracted.`
    };
  }

  // Streak celebration — 3+ sessions
  if (sessionNumber === 3 || sessionNumber === 5 || sessionNumber % 10 === 0) {
    return {
      category: 'celebration',
      trigger: `Session ${sessionNumber} completed`,
      urgency: 'low',
      aiPromptContext: `The user just completed session ${sessionNumber} today. Celebrate this meaningfully. Reference the specific number. Make them feel the weight of what they accomplished.`
    };
  }

  return null;
}

// ── Celebration Logic ───────────────────────────────────────────────────────

export function declareCelebration(session: SessionIntent): CelebrationIntent {
  const { phase, sessionNumber, totalFocusMinutes } = session;

  if (phase === 'focus' && session.duration >= 1500) {
    // 25+ min focus session complete
    const isMilestone = sessionNumber % 4 === 0;
    return {
      type: 'focus_complete',
      message: isMilestone
        ? `Four sessions. That's a full cycle of deep work. You've earned every minute of this long break.`
        : `${Math.round(session.duration / 60)} minutes of pure focus. That's not nothing — that's real. Rest now, fully.`,
      visualIntensity: isMilestone ? 'full' : 'medium',
      durationMs: isMilestone ? 4000 : 2500,
      particle: isMilestone ? 'confetti' : 'sparks'
    };
  }

  if (phase === 'short_break' || phase === 'long_break') {
    return {
      type: 'break_complete',
      message: `Welcome back. You rested. Now let's build something worth resting for.`,
      visualIntensity: 'subtle',
      durationMs: 1500,
      particle: 'glow'
    };
  }

  if (totalFocusMinutes >= 120) {
    return {
      type: 'milestone',
      message: `Two hours of focus. Most people never get here. You're not most people.`,
      visualIntensity: 'full',
      durationMs: 5000,
      particle: 'stars'
    };
  }

  return {
    type: 'focus_complete',
    message: `Session complete. That focus was real.`,
    visualIntensity: 'subtle',
    durationMs: 2000,
    particle: 'glow'
  };
}

// ── Behavior Aggregate Logic ────────────────────────────────────────────────

export function declareBehaviorInsight(data: {
  focusMinutes: number;
  sessionsToday: number;
  breaksTaken: number;
  tipsAcknowledged: number;
  idleEvents: number;
  hour: number;
}): BehaviorAggregateIntent | null {
  const { focusMinutes, sessionsToday, breaksTaken, idleEvents, hour } = data;

  // Morning peak detection
  if (hour >= 9 && hour <= 11 && sessionsToday === 0) {
    return {
      dataPoints: { hour, sessionsToday },
      insight: `Peak hours. 9-11am is typically your sharpest window. Start your hardest task now.`,
      surfaceAt: 'idle',
      priority: 8
    };
  }

  // Skipping breaks pattern
  if (sessionsToday >= 3 && breaksTaken < sessionsToday - 2) {
    return {
      dataPoints: { sessionsToday, breaksTaken },
      insight: `You've done ${sessionsToday} sessions with only ${breaksTaken} real breaks. Your cognition needs the gap. Take the next break fully.`,
      surfaceAt: 'short_break',
      priority: 9
    };
  }

  // High idle rate
  if (idleEvents > 3 && sessionsToday > 0) {
    return {
      dataPoints: { idleEvents },
      insight: `You've drifted ${idleEvents} times today. Consider switching tasks — sometimes the mind is telling you something about prioritization.`,
      surfaceAt: 'focus',
      priority: 7
    };
  }

  // Great day
  if (focusMinutes >= 180) {
    return {
      dataPoints: { focusMinutes },
      insight: `${Math.round(focusMinutes / 60)} hours of focused work today. That's exceptional output. Protect your energy for tomorrow.`,
      surfaceAt: 'long_break',
      priority: 6
    };
  }

  return null;
}

// ── Integration OAuth Intents ───────────────────────────────────────────────

export interface IntegrationStatus {
  id: string;
  name: string;
  connected: boolean;
  scopes: string[];
  oauthUrl?: string;
}

export function declareIntegrations(): IntegrationStatus[] {
  return [
    {
      id: 'google_calendar',
      name: 'Google Calendar',
      connected: false,
      scopes: ['calendar.readonly', 'calendar.events'],
      oauthUrl: '/api/auth/google'
    },
    {
      id: 'notion',
      name: 'Notion',
      connected: false,
      scopes: ['read_content', 'update_content', 'insert_content'],
      oauthUrl: '/api/auth/notion'
    },
    {
      id: 'notebooklm',
      name: 'NotebookLM',
      connected: false,
      scopes: ['notes.read'],
      oauthUrl: '/api/auth/google'
    }
  ];
}

// ── Premium Tier Logic ──────────────────────────────────────────────────────

export type PremiumTier = 'free' | 'pro' | 'behavior';

export interface TierIntent {
  tier: PremiumTier;
  features: string[];
  behaviorSystemActive: boolean;
  modelRoutingActive: boolean;
  integrationsUnlocked: string[];
  aiTipBubblesActive: boolean;
  celebrationFullActive: boolean;
}

export function declareTierCapabilities(tier: PremiumTier): TierIntent {
  switch (tier) {
    case 'free':
      return {
        tier,
        features: ['Pomodoro timer', 'Basic chat (GPT-4o-mini)', 'Manual Kanban board', 'Local metrics'],
        behaviorSystemActive: false,
        modelRoutingActive: false,
        integrationsUnlocked: [],
        aiTipBubblesActive: false,
        celebrationFullActive: false
      };
    case 'pro':
      return {
        tier,
        features: ['Everything in Free', 'Multi-LLM routing', 'Google Calendar sync', 'Notion sync', 'AI Tip Bubbles', 'Full celebrations'],
        behaviorSystemActive: false,
        modelRoutingActive: true,
        integrationsUnlocked: ['google_calendar', 'notion'],
        aiTipBubblesActive: true,
        celebrationFullActive: true
      };
    case 'behavior':
      return {
        tier,
        features: ['Everything in Pro', 'Behavior Intelligence System', 'Cross-source aggregation', 'Predictive insights', 'Health sync', 'Financial dashboard', 'Language learning AI', 'NotebookLM context'],
        behaviorSystemActive: true,
        modelRoutingActive: true,
        integrationsUnlocked: ['google_calendar', 'notion', 'notebooklm', 'health', 'finance', 'language'],
        aiTipBubblesActive: true,
        celebrationFullActive: true
      };
  }
}
