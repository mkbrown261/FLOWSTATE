/**
 * FLOWSTATE — INTENT LAYER v3
 * ============================
 * Single source of truth for ALL logic, routing, behavioral intelligence,
 * and integration orchestration. The Action Layer executes. It does not decide.
 *
 * Architecture Law: Every new behavior starts here.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionPhase = 'focus' | 'short_break' | 'long_break' | 'idle';
export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'mistral' | 'deepseek' | 'meta' | 'together';
export type TaskCapability = 'code' | 'creative' | 'analysis' | 'quick' | 'vision' | 'reasoning' | 'realtime' | 'long_form' | 'math';
export type ImageProvider = 'dalle3' | 'imagen3' | 'sd3' | 'flux_pro' | 'ideogram2';
export type VideoProvider = 'veo2' | 'kling16' | 'runway_gen4' | 'pika20' | 'hailuo' | 'sora';
export type TipCategory = 'posture' | 'hydration' | 'focus' | 'celebration' | 'break' | 'encouragement' | 'debugging';
export type PremiumTier = 'free' | 'pro' | 'behavior';
export type LearnCardType = 'language' | 'skill_tip' | 'did_you_know' | 'book_rec' | 'mental_model';
export type RestoreMode = 'breathing' | 'quote' | 'body_reset' | 'gratitude' | 'micro_win';

// ── Model Registry ─────────────────────────────────────────────────────────────

export interface ModelSpec {
  id: string;
  name: string;
  provider: ModelProvider;
  providerLabel: string;
  description: string;
  capabilities: TaskCapability[];
  apiEndpoint: string;
  apiModel: string;
  contextWindow: number;
  streaming: boolean;
  envKey: string;
  badge?: string;
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'gpt-4o': {
    id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', providerLabel: 'OpenAI',
    description: 'Best for: fast Q&A, writing, vision',
    capabilities: ['quick', 'creative', 'vision', 'code'],
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiModel: 'gpt-4o', contextWindow: 128000, streaming: true, envKey: 'OPENAI_API_KEY',
  },
  'claude-3-7-sonnet': {
    id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'anthropic', providerLabel: 'Anthropic',
    description: 'Best for: analysis, reasoning, long documents',
    capabilities: ['analysis', 'reasoning', 'long_form', 'code'],
    apiEndpoint: 'https://api.anthropic.com/v1/messages',
    apiModel: 'claude-3-5-sonnet-20241022', contextWindow: 200000, streaming: true, envKey: 'ANTHROPIC_API_KEY',
  },
  'gemini-2-flash': {
    id: 'gemini-2-flash', name: 'Gemini 2.0 Flash', provider: 'google', providerLabel: 'Google',
    description: 'Best for: speed, multimodal, real-time',
    capabilities: ['quick', 'realtime', 'vision', 'creative'],
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent',
    apiModel: 'gemini-2.0-flash', contextWindow: 1000000, streaming: true, envKey: 'GOOGLE_AI_KEY',
  },
  'grok-3': {
    id: 'grok-3', name: 'Grok 3', provider: 'xai', providerLabel: 'xAI',
    description: 'Best for: real-time web, humor, fearless takes',
    capabilities: ['realtime', 'creative', 'quick', 'reasoning'],
    apiEndpoint: 'https://api.x.ai/v1/chat/completions',
    apiModel: 'grok-3', contextWindow: 131072, streaming: true, envKey: 'XAI_API_KEY',
  },
  'mistral-large': {
    id: 'mistral-large', name: 'Mistral Large', provider: 'mistral', providerLabel: 'Mistral',
    description: 'Best for: European data privacy, multilingual',
    capabilities: ['code', 'analysis', 'reasoning', 'creative'],
    apiEndpoint: 'https://api.mistral.ai/v1/chat/completions',
    apiModel: 'mistral-large-latest', contextWindow: 128000, streaming: true, envKey: 'MISTRAL_API_KEY',
  },
  'deepseek-r1': {
    id: 'deepseek-r1', name: 'DeepSeek R1', provider: 'deepseek', providerLabel: 'DeepSeek',
    description: 'Best for: math, deep reasoning, code',
    capabilities: ['math', 'reasoning', 'code', 'analysis'],
    apiEndpoint: 'https://api.deepseek.com/v1/chat/completions',
    apiModel: 'deepseek-reasoner', contextWindow: 64000, streaming: true, envKey: 'DEEPSEEK_API_KEY',
  },
  'llama-3-3': {
    id: 'llama-3-3', name: 'Llama 3.3 70B', provider: 'meta', providerLabel: 'Meta',
    description: 'Best for: open-source, privacy-sensitive tasks',
    capabilities: ['code', 'creative', 'analysis', 'quick'],
    apiEndpoint: 'https://api.together.xyz/v1/chat/completions',
    apiModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', contextWindow: 131072, streaming: true, envKey: 'TOGETHER_API_KEY',
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai', providerLabel: 'OpenAI',
    description: 'Best for: fast, cheap, simple tasks',
    capabilities: ['quick', 'creative'],
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiModel: 'gpt-4o-mini', contextWindow: 128000, streaming: true, envKey: 'OPENAI_API_KEY',
    badge: 'Free',
  },
};

// ── Image Model Registry ───────────────────────────────────────────────────────

export interface ImageModelSpec {
  id: ImageProvider;
  name: string;
  provider: string;
  description: string;
  apiEndpoint: string;
  envKey: string;
  maxWidth: number;
  maxHeight: number;
  styles?: string[];
}

export const IMAGE_MODEL_REGISTRY: Record<ImageProvider, ImageModelSpec> = {
  dalle3: {
    id: 'dalle3', name: 'DALL·E 3', provider: 'OpenAI',
    description: 'Best quality, great text rendering',
    apiEndpoint: 'https://api.openai.com/v1/images/generations',
    envKey: 'OPENAI_API_KEY', maxWidth: 1024, maxHeight: 1024,
    styles: ['vivid', 'natural'],
  },
  imagen3: {
    id: 'imagen3', name: 'Imagen 3', provider: 'Google',
    description: 'Photorealistic, detail-rich images',
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict',
    envKey: 'GOOGLE_AI_KEY', maxWidth: 1024, maxHeight: 1024,
  },
  sd3: {
    id: 'sd3', name: 'Stable Diffusion 3', provider: 'Stability AI',
    description: 'Open-source powerhouse, custom styles',
    apiEndpoint: 'https://api.stability.ai/v2beta/stable-image/generate/sd3',
    envKey: 'STABILITY_API_KEY', maxWidth: 1024, maxHeight: 1024,
  },
  flux_pro: {
    id: 'flux_pro', name: 'FLUX Pro', provider: 'Black Forest Labs',
    description: 'Ultra-fast, photorealistic generation',
    apiEndpoint: 'https://api.bfl.ml/v1/flux-pro',
    envKey: 'BFL_API_KEY', maxWidth: 1440, maxHeight: 1440,
  },
  ideogram2: {
    id: 'ideogram2', name: 'Ideogram 2', provider: 'Ideogram',
    description: 'Excellent text-in-image, design-forward',
    apiEndpoint: 'https://api.ideogram.ai/generate',
    envKey: 'IDEOGRAM_API_KEY', maxWidth: 1024, maxHeight: 1024,
  },
};

// ── Video Model Registry ───────────────────────────────────────────────────────

export interface VideoModelSpec {
  id: VideoProvider;
  name: string;
  provider: string;
  description: string;
  apiEndpoint: string;
  envKey: string;
  maxDuration: number;
  resolution: string;
}

export const VIDEO_MODEL_REGISTRY: Record<VideoProvider, VideoModelSpec> = {
  veo2: {
    id: 'veo2', name: 'Veo 2', provider: 'Google DeepMind',
    description: 'Cinematic quality, physics-aware',
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning',
    envKey: 'GOOGLE_AI_KEY', maxDuration: 8, resolution: '720p',
  },
  kling16: {
    id: 'kling16', name: 'Kling 1.6', provider: 'Kuaishou',
    description: 'Smooth motion, character consistency',
    apiEndpoint: 'https://api.klingai.com/v1/videos/text2video',
    envKey: 'KLING_API_KEY', maxDuration: 10, resolution: '1080p',
  },
  runway_gen4: {
    id: 'runway_gen4', name: 'Runway Gen-4', provider: 'Runway ML',
    description: 'Creative, film-quality generation',
    apiEndpoint: 'https://api.runwayml.com/v1/image_to_video',
    envKey: 'RUNWAY_API_KEY', maxDuration: 10, resolution: '1080p',
  },
  pika20: {
    id: 'pika20', name: 'Pika 2.0', provider: 'Pika Labs',
    description: 'Creative effects, fun motion',
    apiEndpoint: 'https://api.pika.art/v2/generate',
    envKey: 'PIKA_API_KEY', maxDuration: 10, resolution: '1080p',
  },
  hailuo: {
    id: 'hailuo', name: 'Hailuo', provider: 'MiniMax',
    description: 'Fast generation, good faces',
    apiEndpoint: 'https://api.minimax.chat/v1/video/generation',
    envKey: 'MINIMAX_API_KEY', maxDuration: 6, resolution: '720p',
  },
  sora: {
    id: 'sora', name: 'Sora', provider: 'OpenAI',
    description: 'Long-form, world models, simulation',
    apiEndpoint: 'https://api.openai.com/v1/video/generations',
    envKey: 'OPENAI_API_KEY', maxDuration: 60, resolution: '1080p',
  },
};

// ── Session Intent ─────────────────────────────────────────────────────────────

export interface SessionIntent {
  message: string;
  timestamp: number;
  taskType: TaskCapability;
  routedModel: string;
  confidence: number;
  reasoning: string;
  fallbackModel: string;
  systemPrompt: string;
}

// ── Tip Intent ─────────────────────────────────────────────────────────────────

export interface TipIntent {
  category: TipCategory;
  message: string;
  emoji: string;
  action?: string;
  actionLabel?: string;
  autoDismissMs: number;
  priority: number;
}

// ── Celebration Intent ─────────────────────────────────────────────────────────

export interface CelebrationIntent {
  type: 'confetti' | 'spark' | 'star' | 'pulse' | 'aurora';
  intensity: number;
  message: string;
  subMessage: string;
  duration: number;
  particleCount: number;
}

// ── Learn Card ────────────────────────────────────────────────────────────────

export interface LearnCardIntent {
  type: LearnCardType;
  title: string;
  content: string;
  meta?: string;
  action?: string;
  actionLabel?: string;
  emoji: string;
  color: string;
}

// ── Restore Intent ────────────────────────────────────────────────────────────

export interface RestoreIntent {
  mode: RestoreMode;
  title: string;
  content: string;
  duration?: number;
  steps?: string[];
  prompt?: string;
  emoji: string;
  bgColor: string;
}

// ── Behavior Data ─────────────────────────────────────────────────────────────

export interface BehaviorData {
  totalFocusSeconds: number;
  sessionCount: number;
  streak: number;
  completionRate: number;
  peakHour?: number;
  calendarEvents?: number;
  notionCards?: number;
  steps?: number;
  heartRate?: number;
  sleepHours?: number;
  hydrationGlasses?: number;
  languageStreak?: number;
  netWorthSnapshot?: number;
  activeModel?: string;
  imageGenerations?: number;
  flowScore?: number;
}

// ── Google OAuth Intent ────────────────────────────────────────────────────────

export interface GoogleOAuthIntent {
  redirectPath: string;
  scopes: string[];
  stateParam: string;
  accessType: 'offline';
  prompt: 'consent';
}

export function declareGoogleOAuth(baseUrl: string): GoogleOAuthIntent {
  return {
    redirectPath: `${baseUrl}/api/auth/google/callback`,
    scopes: [
      'openid',
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    stateParam: crypto.randomUUID(),
    accessType: 'offline',
    prompt: 'consent',
  };
}

// ── Notion OAuth Intent ────────────────────────────────────────────────────────

export interface NotionOAuthIntent {
  authorizeUrl: string;
  redirectUri: string;
  stateParam: string;
  responseType: 'code';
}

export function declareNotionOAuth(baseUrl: string, clientId: string): NotionOAuthIntent {
  return {
    authorizeUrl: `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(`${baseUrl}/api/auth/notion/callback`)}`,
    redirectUri: `${baseUrl}/api/auth/notion/callback`,
    stateParam: crypto.randomUUID(),
    responseType: 'code',
  };
}

// ── Model Routing ─────────────────────────────────────────────────────────────

const ROUTING_RULES: Array<{
  pattern: RegExp;
  capability: TaskCapability;
  preferredModel: string;
  reason: string;
}> = [
  { pattern: /\b(code|function|bug|error|debug|script|algorithm|implement|fix|refactor)\b/i, capability: 'code', preferredModel: 'claude-3-7-sonnet', reason: 'Claude excels at complex code reasoning' },
  { pattern: /\b(math|equation|calcul|integral|derivative|proof|statistic|formula|probability)\b/i, capability: 'math', preferredModel: 'deepseek-r1', reason: 'DeepSeek R1 leads on math benchmarks' },
  { pattern: /\b(analyze|research|compare|evaluate|deep.?dive|thorough|comprehensive|explain why)\b/i, capability: 'analysis', preferredModel: 'claude-3-7-sonnet', reason: 'Claude\'s 200K context handles deep analysis' },
  { pattern: /\b(write|story|poem|creative|blog|marketing|copy|brainstorm|character|narrative)\b/i, capability: 'creative', preferredModel: 'gpt-4o', reason: 'GPT-4o is the creative writing leader' },
  { pattern: /\b(latest|news|today|current|recent|2024|2025|real.?time|trending)\b/i, capability: 'realtime', preferredModel: 'grok-3', reason: 'Grok has real-time web access' },
  { pattern: /\b(image|picture|photo|diagram|chart|visual|see|look at)\b/i, capability: 'vision', preferredModel: 'gemini-2-flash', reason: 'Gemini 2.0 Flash has best multimodal performance' },
  { pattern: /\b(long|document|pdf|book|article|essay|report|summarize)\b/i, capability: 'long_form', preferredModel: 'gemini-2-flash', reason: 'Gemini has 1M token context window' },
  { pattern: /\b(reason|think|step.?by.?step|logic|infer|deduce|complex problem)\b/i, capability: 'reasoning', preferredModel: 'deepseek-r1', reason: 'DeepSeek R1 chain-of-thought reasoning' },
];

export function declareModelRouting(message: string, preferredModel?: string): SessionIntent {
  if (preferredModel && MODEL_REGISTRY[preferredModel]) {
    const spec = MODEL_REGISTRY[preferredModel];
    return {
      message, timestamp: Date.now(),
      taskType: spec.capabilities[0] as TaskCapability,
      routedModel: preferredModel,
      confidence: 1.0,
      reasoning: 'User-selected model',
      fallbackModel: 'gpt-4o-mini',
      systemPrompt: buildSystemPrompt(spec.capabilities[0] as TaskCapability),
    };
  }

  for (const rule of ROUTING_RULES) {
    if (rule.pattern.test(message)) {
      return {
        message, timestamp: Date.now(),
        taskType: rule.capability,
        routedModel: rule.preferredModel,
        confidence: 0.85,
        reasoning: rule.reason,
        fallbackModel: 'gpt-4o-mini',
        systemPrompt: buildSystemPrompt(rule.capability),
      };
    }
  }

  return {
    message, timestamp: Date.now(),
    taskType: 'quick',
    routedModel: 'gpt-4o',
    confidence: 0.7,
    reasoning: 'Default: GPT-4o for general tasks',
    fallbackModel: 'gpt-4o-mini',
    systemPrompt: buildSystemPrompt('quick'),
  };
}

function buildSystemPrompt(capability: TaskCapability): string {
  const base = 'You are FlowState AI, an intelligent assistant embedded in a personal productivity OS. You help users stay in flow, accomplish meaningful work, and grow continuously. Be concise, warm, and actionable.';
  const suffixes: Partial<Record<TaskCapability, string>> = {
    code: ' When writing code, explain briefly what it does. Always use markdown code blocks.',
    math: ' Show your reasoning step by step. Use LaTeX notation when helpful.',
    analysis: ' Structure your analysis clearly. Use headers and bullet points for long responses.',
    creative: ' Be imaginative and original. Match the user\'s tone and energy.',
    realtime: ' Note when your information might be outdated. Focus on verified facts.',
    reasoning: ' Think step by step. Show your chain of reasoning explicitly.',
  };
  return base + (suffixes[capability] || '');
}

// ── Tip Bubbles ────────────────────────────────────────────────────────────────

const TIP_LIBRARY: TipIntent[] = [
  { category: 'posture', message: 'Shoulders back, chin level. Roll them twice.', emoji: '🧘', autoDismissMs: 12000, priority: 1 },
  { category: 'hydration', message: 'Water check! Aim for a glass every 45 minutes.', emoji: '💧', autoDismissMs: 10000, priority: 2 },
  { category: 'focus', message: 'One tab, one task. Close everything else.', emoji: '🎯', autoDismissMs: 12000, priority: 3 },
  { category: 'break', message: 'Look 20 feet away for 20 seconds. Eye care matters.', emoji: '👁️', autoDismissMs: 15000, priority: 2 },
  { category: 'encouragement', message: 'Every session is a vote for the person you\'re becoming.', emoji: '⚡', autoDismissMs: 10000, priority: 4 },
  { category: 'debugging', message: 'Stuck? Explain it to a rubber duck. Seriously.', emoji: '🦆', autoDismissMs: 12000, priority: 3 },
  { category: 'focus', message: 'The Pomodoro technique trains your brain like intervals train muscles.', emoji: '🍅', autoDismissMs: 12000, priority: 3 },
  { category: 'hydration', message: 'Dehydration reduces cognitive performance by 10-15%. Drink up!', emoji: '🫗', autoDismissMs: 10000, priority: 2 },
  { category: 'posture', message: 'Wrists neutral, elbows at 90°. Your future self thanks you.', emoji: '🖐️', autoDismissMs: 12000, priority: 1 },
  { category: 'break', message: 'Stand up, shake it out. Movement resets cortisol levels.', emoji: '🏃', autoDismissMs: 10000, priority: 2 },
  { category: 'encouragement', message: 'Deep work is a superpower. You\'re building it right now.', emoji: '🦅', autoDismissMs: 10000, priority: 4 },
  { category: 'focus', message: 'Multitasking is a myth. Serial focus is the real skill.', emoji: '🔮', autoDismissMs: 12000, priority: 3 },
];

export function declareTipIntent(context: { minutesElapsed: number; phase: SessionPhase; lastTipAt: number }): TipIntent | null {
  const { minutesElapsed, phase, lastTipAt } = context;
  const cooldownMet = Date.now() - lastTipAt > 5 * 60 * 1000;
  if (!cooldownMet || phase !== 'focus') return null;

  if (minutesElapsed >= 45) return TIP_LIBRARY.find(t => t.category === 'posture') || null;
  if (minutesElapsed >= 60) return TIP_LIBRARY.find(t => t.category === 'hydration') || null;

  const pool = TIP_LIBRARY.filter(t => t.priority <= 3);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Celebrations ──────────────────────────────────────────────────────────────

const CELEBRATION_MESSAGES = [
  ['Session Complete! 🎉', 'One step closer to your goals.'],
  ['Flow Achieved! ⚡', 'You were in the zone. That\'s rare.'],
  ['Deep Work Done! 🧠', 'Your future self is grateful.'],
  ['On Fire! 🔥', 'Four sessions = championship-level focus.'],
  ['Flow Master! 👑', 'You make it look effortless.'],
  ['Unstoppable! 🚀', 'The streak continues. Keep going.'],
];

export function declareCelebration(sessionNumber: number): CelebrationIntent {
  const idx = Math.min(sessionNumber - 1, CELEBRATION_MESSAGES.length - 1);
  const [message, subMessage] = CELEBRATION_MESSAGES[Math.max(0, idx)];
  const intensity = Math.min(1, 0.4 + sessionNumber * 0.15);
  return {
    type: sessionNumber >= 4 ? 'confetti' : sessionNumber >= 2 ? 'spark' : 'pulse',
    intensity,
    message,
    subMessage,
    duration: 3500 + sessionNumber * 300,
    particleCount: Math.floor(30 + sessionNumber * 20),
  };
}

// ── Behavior Insight ──────────────────────────────────────────────────────────

export interface BehaviorInsight {
  headline: string;
  detail: string;
  recommendation: string;
  sources: string[];
  flowScore: number;
  dataPoints: number;
  isPremium: boolean;
}

export function declareBehaviorInsight(data: BehaviorData): BehaviorInsight {
  const sources: string[] = [];
  if (data.totalFocusSeconds) sources.push('Focus sessions');
  if (data.calendarEvents !== undefined) sources.push('Google Calendar');
  if (data.notionCards !== undefined) sources.push('Notion Board');
  if (data.steps !== undefined) sources.push('Step count');
  if (data.sleepHours !== undefined) sources.push('Sleep data');
  if (data.languageStreak !== undefined) sources.push('Language streak');
  if (data.heartRate !== undefined) sources.push('Heart rate');
  if (data.netWorthSnapshot !== undefined) sources.push('Finance');

  const focusHours = Math.round(data.totalFocusSeconds / 3600 * 10) / 10;
  const flowScore = calculateFlowScore(data);

  let headline = 'Building momentum';
  let detail = 'Keep going — consistency is the foundation.';
  let recommendation = 'Complete your next Pomodoro session to strengthen your habit.';

  if (data.sessionCount >= 4 && data.completionRate > 0.8) {
    headline = 'Elite focus pattern detected';
    detail = `${focusHours}h of deep work logged. Completion rate: ${Math.round(data.completionRate * 100)}%.`;
    recommendation = 'Your peak appears to be in the morning. Schedule your hardest work then.';
  } else if (data.steps && data.steps > 8000 && data.sleepHours && data.sleepHours > 7) {
    headline = 'Optimal performance conditions';
    detail = 'Movement and sleep are aligned. Cognitive performance is likely elevated.';
    recommendation = 'This is a great day for creative or analytical deep work.';
  } else if (data.languageStreak && data.languageStreak > 7) {
    headline = 'Consistency hero';
    detail = `${data.languageStreak}-day language streak shows exceptional habit formation.`;
    recommendation = 'Apply this consistency pattern to your top professional goal.';
  }

  return {
    headline, detail, recommendation, sources,
    flowScore, dataPoints: sources.length, isPremium: sources.length >= 3,
  };
}

function calculateFlowScore(data: BehaviorData): number {
  let score = 50;
  if (data.totalFocusSeconds > 7200) score += 15;
  if (data.completionRate > 0.8) score += 10;
  if (data.streak > 3) score += 10;
  if (data.sleepHours && data.sleepHours >= 7) score += 10;
  if (data.steps && data.steps >= 8000) score += 5;
  return Math.min(100, score);
}

// ── Learn Cards ────────────────────────────────────────────────────────────────

const LANGUAGE_CARDS: LearnCardIntent[] = [
  { type: 'language', title: 'Japanese N5', content: '集中 (しゅうちゅう)', meta: 'shuuchuu — concentration, focus', emoji: '🇯🇵', color: '#ff6b6b', action: 'Practice', actionLabel: 'Open Anki' },
  { type: 'language', title: 'Spanish B1', content: 'La concentración', meta: 'la concentración — focus, concentration', emoji: '🇪🇸', color: '#ffd93d', action: 'Practice', actionLabel: 'Duolingo' },
  { type: 'language', title: 'Mandarin HSK3', content: '专注 (zhuān zhù)', meta: 'zhuān zhù — to concentrate, focus', emoji: '🇨🇳', color: '#ee4b2b', action: 'Practice', actionLabel: 'HelloChinese' },
  { type: 'language', title: 'French A2', content: 'La productivité', meta: 'la productivité — productivity', emoji: '🇫🇷', color: '#4ecdc4', action: 'Practice', actionLabel: 'Babbel' },
];

const SKILL_TIPS: LearnCardIntent[] = [
  { type: 'skill_tip', title: 'The 2-Minute Rule', content: 'If it takes less than 2 minutes, do it now. David Allen\'s most powerful productivity principle.', emoji: '⏱️', color: '#a8e6cf', action: 'Apply', actionLabel: 'Check Inbox' },
  { type: 'skill_tip', title: 'Spaced Repetition', content: 'Review material at increasing intervals: 1 day, 3 days, 1 week, 1 month. Beats cramming by 200%.', emoji: '🧠', color: '#ffd93d', action: 'Learn', actionLabel: 'Try Anki' },
  { type: 'skill_tip', title: 'The Feynman Technique', content: 'Explain it to a child. If you can\'t, you don\'t understand it yet. The gap is your study list.', emoji: '🔬', color: '#dda0dd', action: 'Practice', actionLabel: 'Write It Out' },
  { type: 'skill_tip', title: 'Eat the Frog', content: 'Do your most dreaded task first. Everything after feels easy, and your willpower is highest in the morning.', emoji: '🐸', color: '#98d8c8', action: 'Apply Now', actionLabel: 'Open Board' },
];

const DID_YOU_KNOW: LearnCardIntent[] = [
  { type: 'did_you_know', title: 'Flow State Science', content: 'Mihaly Csikszentmihalyi found that flow states increase productivity by up to 500%. FlowState is built around this.', emoji: '🌊', color: '#74b9ff' },
  { type: 'did_you_know', title: 'The Pomodoro Origin', content: 'Francesco Cirillo invented the Pomodoro Technique in the 1980s using a tomato-shaped kitchen timer. Pomodoro means tomato in Italian.', emoji: '🍅', color: '#ff7675' },
  { type: 'did_you_know', title: 'Sleep & Memory', content: 'During sleep, the hippocampus replays the day\'s learning, transferring it to long-term memory. 8 hours can boost recall by 40%.', emoji: '😴', color: '#a29bfe' },
  { type: 'did_you_know', title: 'Cold Start Problem', content: 'The hardest moment is starting. Commit to just 2 minutes. The brain\'s reward system kicks in at start, not completion.', emoji: '🚀', color: '#fdcb6e' },
];

const BOOK_RECS: LearnCardIntent[] = [
  { type: 'book_rec', title: 'Deep Work', content: '"The ability to perform deep work is becoming increasingly rare at exactly the same time it is becoming increasingly valuable." — Cal Newport', emoji: '📖', color: '#6c5ce7', meta: 'Cal Newport · Productivity · ★★★★★' },
  { type: 'book_rec', title: 'Flow', content: '"The best moments usually occur when a person\'s body or mind is stretched to its limits." — Mihaly Csikszentmihalyi', emoji: '📚', color: '#00cec9', meta: 'Mihaly Csikszentmihalyi · Psychology · ★★★★★' },
  { type: 'book_rec', title: 'Atomic Habits', content: '"You do not rise to the level of your goals. You fall to the level of your systems." — James Clear', emoji: '⚛️', color: '#e17055', meta: 'James Clear · Habits · ★★★★★' },
  { type: 'book_rec', title: 'The Phoenix Project', content: 'A novel about DevOps, but really about flow, constraints, and systems thinking in any knowledge work.', emoji: '🔥', color: '#ff9f43', meta: 'Gene Kim · Tech/Business · ★★★★☆' },
];

const MENTAL_MODELS: LearnCardIntent[] = [
  { type: 'mental_model', title: 'First Principles', content: 'Break down problems to their fundamental truths, then reason back up. Musk uses this for rockets. You can use it for code.', emoji: '🔭', color: '#74b9ff' },
  { type: 'mental_model', title: 'Inversion', content: 'Instead of asking "how do I succeed?", ask "what would guarantee failure?" Then avoid those things.', emoji: '🔄', color: '#a29bfe' },
  { type: 'mental_model', title: 'Second-Order Thinking', content: 'Consider the consequences of consequences. The immediate result is first order; what happens next is second.', emoji: '♟️', color: '#55efc4' },
  { type: 'mental_model', title: 'Opportunity Cost', content: 'Every choice eliminates alternatives. The true cost of any decision includes what you give up by not choosing something else.', emoji: '⚖️', color: '#fdcb6e' },
];

const ALL_LEARN_CARDS: LearnCardIntent[] = [
  ...LANGUAGE_CARDS, ...SKILL_TIPS, ...DID_YOU_KNOW, ...BOOK_RECS, ...MENTAL_MODELS,
];

export function declareLearnCards(): LearnCardIntent[] {
  return [...ALL_LEARN_CARDS].sort(() => Math.random() - 0.5);
}

// ── Restore Intents ────────────────────────────────────────────────────────────

const RESTORE_LIBRARY: RestoreIntent[] = [
  {
    mode: 'breathing', title: '4-7-8 Breathing', emoji: '🫁',
    content: 'Activate the parasympathetic nervous system. Inhale 4s, hold 7s, exhale 8s.',
    steps: ['Inhale through nose...', 'Hold your breath...', 'Exhale through mouth...'],
    duration: 19, bgColor: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
  },
  {
    mode: 'quote', title: 'Words for the Moment', emoji: '💬',
    content: '"The present moment is the only time over which we have dominion." — Thich Nhat Hanh',
    bgColor: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
  },
  {
    mode: 'body_reset', title: 'Body Reset Protocol', emoji: '🧘',
    content: 'Micro-movement sequence to release tension and restore posture.',
    steps: ['Roll shoulders back 3× slowly', 'Tilt head side to side', 'Stretch arms above head', 'Take 3 deep belly breaths', 'Set intention for next session'],
    bgColor: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
  },
  {
    mode: 'gratitude', title: 'Gratitude Pulse', emoji: '💙',
    content: 'Name one thing you\'re genuinely grateful for right now. This moment.',
    prompt: 'Type your gratitude moment...',
    bgColor: 'linear-gradient(135deg, #1a1a2e 0%, #4a0072 100%)',
  },
  {
    mode: 'micro_win', title: 'Celebrate Your Win', emoji: '🏆',
    content: 'You completed a focus session. That\'s 25 minutes of undivided attention — something most people never achieve.',
    bgColor: 'linear-gradient(135deg, #f7971e 0%, #ffd200 100%)',
  },
  {
    mode: 'quote', title: 'Stillness is Power', emoji: '🌙',
    content: '"In the middle of difficulty lies opportunity." — Albert Einstein\n\nYour break is not wasted time. It\'s consolidation.',
    bgColor: 'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
  },
  {
    mode: 'breathing', title: 'Box Breathing', emoji: '📦',
    content: 'Navy SEALs use this to maintain calm under pressure. In 4, hold 4, out 4, hold 4.',
    steps: ['Inhale 4 counts...', 'Hold 4 counts...', 'Exhale 4 counts...', 'Hold 4 counts...'],
    duration: 16, bgColor: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  },
  {
    mode: 'body_reset', title: 'Eye Care Reset', emoji: '👁️',
    content: 'The 20-20-20 rule: every 20 minutes, look at something 20 feet away for 20 seconds.',
    steps: ['Find a point 20 feet away', 'Focus softly on that point', 'Blink slowly several times', 'Close eyes for 10 seconds', 'Return to work refreshed'],
    bgColor: 'linear-gradient(135deg, #1d4350 0%, #a43931 100%)',
  },
];

export function declareRestoreIntent(): RestoreIntent {
  const idx = Math.floor(Date.now() / 30000) % RESTORE_LIBRARY.length;
  return RESTORE_LIBRARY[idx];
}

// ── Session Blocking ──────────────────────────────────────────────────────────

export interface SessionBlockingIntent {
  shouldBlock: boolean;
  reason?: string;
  conflictingEvent?: string;
  suggestedTime?: string;
}

export function declareSessionBlocking(
  events: Array<{ summary: string; start: string; end: string }>,
  sessionDurationMinutes: number,
): SessionBlockingIntent {
  const now = new Date();
  const sessionEnd = new Date(now.getTime() + sessionDurationMinutes * 60000);

  for (const event of events) {
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    if (
      (now >= eventStart && now <= eventEnd) ||
      (sessionEnd >= eventStart && now <= eventStart)
    ) {
      const minutesUntil = Math.max(0, Math.round((eventStart.getTime() - now.getTime()) / 60000));
      return {
        shouldBlock: true,
        reason: minutesUntil === 0 ? `"${event.summary}" is happening now` : `"${event.summary}" starts in ${minutesUntil} min`,
        conflictingEvent: event.summary,
        suggestedTime: eventEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    }
  }

  return { shouldBlock: false };
}

// ── Tier Capabilities ─────────────────────────────────────────────────────────

export interface TierIntent {
  tier: PremiumTier;
  features: string[];
  behaviorSystemActive: boolean;
  modelRoutingActive: boolean;
  availableModels: string[];
  integrationsUnlocked: string[];
  aiTipBubblesActive: boolean;
  celebrationFullActive: boolean;
  weeklyDigestActive: boolean;
  flowScoreActive: boolean;
  imageGenActive: boolean;
  videoGenActive: boolean;
  restoreTabActive: boolean;
}

export function declareTierCapabilities(tier: PremiumTier): TierIntent {
  switch (tier) {
    case 'free':
      return {
        tier, features: ['Pomodoro timer', 'GPT-4o-mini chat', 'Manual Kanban', 'Basic metrics', 'Learn tab', 'Restore tab'],
        behaviorSystemActive: false, modelRoutingActive: false,
        availableModels: ['gpt-4o-mini'],
        integrationsUnlocked: [], aiTipBubblesActive: false,
        celebrationFullActive: false, weeklyDigestActive: false,
        flowScoreActive: false, imageGenActive: false,
        videoGenActive: false, restoreTabActive: true,
      };
    case 'pro':
      return {
        tier, features: ['Everything in Free', 'All 7 AI models', 'Smart routing', 'Google Calendar', 'Notion sync', 'AI Tip Bubbles', 'FlowScore', 'Image generation (5 models)', 'Full celebrations', 'NotebookLM bridge'],
        behaviorSystemActive: false, modelRoutingActive: true,
        availableModels: Object.keys(MODEL_REGISTRY),
        integrationsUnlocked: ['google_calendar', 'notion', 'notebooklm'],
        aiTipBubblesActive: true, celebrationFullActive: true,
        weeklyDigestActive: false, flowScoreActive: true,
        imageGenActive: true, videoGenActive: false, restoreTabActive: true,
      };
    case 'behavior':
      return {
        tier, features: ['Everything in Pro', 'Behavior Intelligence System', 'Health & life metrics sync', 'Video generation (6 models)', 'Weekly digest email', 'Smart session blocking', 'FlowScore AI coaching', 'ElevenLabs voice restore'],
        behaviorSystemActive: true, modelRoutingActive: true,
        availableModels: Object.keys(MODEL_REGISTRY),
        integrationsUnlocked: ['google_calendar', 'notion', 'notebooklm', 'health', 'elevenlabs', 'finance'],
        aiTipBubblesActive: true, celebrationFullActive: true,
        weeklyDigestActive: true, flowScoreActive: true,
        imageGenActive: true, videoGenActive: true, restoreTabActive: true,
      };
  }
}

// ── Credential Table (for user-facing display) ─────────────────────────────────

export interface CredentialEntry {
  service: string;
  purpose: string;
  envKey: string;
  howToGet: string;
  url: string;
  required: 'core' | 'recommended' | 'optional';
  tier: PremiumTier;
}

export const CREDENTIAL_TABLE: CredentialEntry[] = [
  { service: 'Google OAuth', purpose: 'Calendar read/write, Drive access, user identity', envKey: 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET', howToGet: 'Google Cloud Console → APIs & Services → Credentials → OAuth 2.0', url: 'https://console.cloud.google.com', required: 'core', tier: 'pro' },
  { service: 'Notion OAuth', purpose: 'Read/write databases, Kanban sync', envKey: 'NOTION_CLIENT_ID + NOTION_CLIENT_SECRET', howToGet: 'Notion → My integrations → New integration (OAuth public)', url: 'https://www.notion.so/profile/integrations', required: 'core', tier: 'pro' },
  { service: 'OpenAI', purpose: 'GPT-4o, GPT-4o-mini, DALL·E 3, Sora video', envKey: 'OPENAI_API_KEY', howToGet: 'platform.openai.com → API keys', url: 'https://platform.openai.com/api-keys', required: 'core', tier: 'free' },
  { service: 'Anthropic', purpose: 'Claude 3.7 Sonnet — code, analysis, long docs', envKey: 'ANTHROPIC_API_KEY', howToGet: 'console.anthropic.com → API keys', url: 'https://console.anthropic.com', required: 'recommended', tier: 'pro' },
  { service: 'Google AI (Gemini)', purpose: 'Gemini 2.0 Flash, Imagen 3, Veo 2 video', envKey: 'GOOGLE_AI_KEY', howToGet: 'aistudio.google.com → Get API key', url: 'https://aistudio.google.com/app/apikey', required: 'recommended', tier: 'pro' },
  { service: 'xAI', purpose: 'Grok 3 — real-time web, live data', envKey: 'XAI_API_KEY', howToGet: 'console.x.ai → API keys', url: 'https://console.x.ai', required: 'optional', tier: 'pro' },
  { service: 'Mistral AI', purpose: 'Mistral Large — multilingual, EU data privacy', envKey: 'MISTRAL_API_KEY', howToGet: 'console.mistral.ai → API keys', url: 'https://console.mistral.ai', required: 'optional', tier: 'pro' },
  { service: 'DeepSeek', purpose: 'DeepSeek R1 — math, deep reasoning', envKey: 'DEEPSEEK_API_KEY', howToGet: 'platform.deepseek.com → API keys', url: 'https://platform.deepseek.com', required: 'optional', tier: 'pro' },
  { service: 'Together AI', purpose: 'Llama 3.3 70B — open-source model hosting', envKey: 'TOGETHER_API_KEY', howToGet: 'api.together.xyz → API keys', url: 'https://api.together.xyz', required: 'optional', tier: 'pro' },
  { service: 'Runway ML', purpose: 'Runway Gen-4 video generation', envKey: 'RUNWAY_API_KEY', howToGet: 'app.runwayml.com → My Account → API', url: 'https://app.runwayml.com', required: 'optional', tier: 'behavior' },
  { service: 'Kling AI', purpose: 'Kling 1.6 video generation', envKey: 'KLING_API_KEY', howToGet: 'klingai.com → Developer → API keys', url: 'https://klingai.com', required: 'optional', tier: 'behavior' },
  { service: 'Pika Labs', purpose: 'Pika 2.0 video generation', envKey: 'PIKA_API_KEY', howToGet: 'pika.art → Settings → Developer', url: 'https://pika.art', required: 'optional', tier: 'behavior' },
  { service: 'ElevenLabs', purpose: 'Voice-guided breathing in Restore tab', envKey: 'ELEVENLABS_API_KEY', howToGet: 'elevenlabs.io → Profile → API key', url: 'https://elevenlabs.io', required: 'optional', tier: 'behavior' },
  { service: 'Stability AI', purpose: 'Stable Diffusion 3 image generation', envKey: 'STABILITY_API_KEY', howToGet: 'platform.stability.ai → API keys', url: 'https://platform.stability.ai', required: 'optional', tier: 'pro' },
  { service: 'Black Forest Labs', purpose: 'FLUX Pro image generation', envKey: 'BFL_API_KEY', howToGet: 'api.bfl.ml → Account → API keys', url: 'https://api.bfl.ml', required: 'optional', tier: 'pro' },
  { service: 'Ideogram', purpose: 'Ideogram 2 — text-in-image, design assets', envKey: 'IDEOGRAM_API_KEY', howToGet: 'ideogram.ai → API → Generate key', url: 'https://ideogram.ai', required: 'optional', tier: 'pro' },
];
