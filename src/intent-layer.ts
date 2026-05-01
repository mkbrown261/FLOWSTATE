/**
 * FLOWSTATE ENTERPRISE — INTENT LAYER v4
 * ========================================
 * Single source of truth for ALL logic, routing, team intelligence,
 * sprint health, FlowScore, onboarding, billing, and behavioral decisions.
 *
 * ARCHITECTURE LAW: The Action Layer executes. It NEVER decides.
 * Every condition, every routing rule, every team insight lives here.
 */

// ─── Core Types ───────────────────────────────────────────────────────────────

export type SessionPhase = 'focus' | 'short_break' | 'long_break' | 'idle';
export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'mistral' | 'deepseek' | 'meta';
export type TaskCapability = 'code' | 'creative' | 'analysis' | 'quick' | 'vision' | 'reasoning' | 'realtime' | 'long_form' | 'math';
export type ImageProvider = 'dalle3' | 'dalle4' | 'gpt-image' | 'imagen3' | 'imagen4' | 'sd3' | 'flux_pro' | 'flux_dev' | 'flux_schnell' | 'ideogram2' | 'recraft' | 'seedream';
export type VideoProvider = 'veo2' | 'veo3' | 'kling16' | 'kling21' | 'runway_gen4' | 'runway_gen4t' | 'pika20' | 'hailuo' | 'sora' | 'minimax' | 'minimax_live' | 'luma' | 'hunyuan' | 'ltx';
export type PremiumTier = 'free' | 'pro' | 'team' | 'clawflow' | 'enterprise' | 'personal_pro' | 'team_starter' | 'team_growth';
export type TeamRole = 'member' | 'senior_dev' | 'scrum_master' | 'admin';
export type LearnCardType = 'language' | 'skill_tip' | 'did_you_know' | 'book_rec' | 'mental_model';
export type RestoreMode = 'breathing' | 'quote' | 'body_reset' | 'gratitude' | 'micro_win';
export type BurnoutLevel = 'green' | 'yellow' | 'red';
export type OnboardingGoal = 'deep_focus' | 'team_collab' | 'health_energy' | 'creative' | 'learning' | 'financial';
export type SessionContext = 'code' | 'writing' | 'design' | 'admin' | 'meeting' | 'learning' | 'general';
export type IntegrationId = 'google_calendar' | 'notion' | 'slack' | 'github' | 'linear' | 'jira' | 'asana' | 'microsoft_teams' | 'oura' | 'whoop' | 'plaid' | 'notebooklm';

// ─── Model Registry ───────────────────────────────────────────────────────────

export interface ModelSpec {
  id: string; name: string; provider: ModelProvider; providerLabel: string;
  description: string; capabilities: TaskCapability[]; apiEndpoint: string;
  apiModel: string; contextWindow: number; streaming: boolean; envKey: string;
  badge?: string; color?: string;
}

// ─── OpenRouter endpoint — one URL, one key, all models ──────────────────────
const OR = 'https://openrouter.ai/api/v1/chat/completions'

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  // ── OpenAI models via OpenRouter ───────────────────────────────────────────
  'gpt-4o': {
    id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', providerLabel: 'OpenAI',
    description: 'Fast Q&A, writing, vision', capabilities: ['quick', 'creative', 'vision', 'code'],
    apiEndpoint: OR, apiModel: 'openai/gpt-4o',
    contextWindow: 128000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#10b981',
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai', providerLabel: 'OpenAI',
    description: 'Fast, cost-efficient', capabilities: ['quick', 'creative'],
    apiEndpoint: OR, apiModel: 'openai/gpt-4o-mini',
    contextWindow: 128000, streaming: true, envKey: 'OPENROUTER_API_KEY', badge: 'Fast', color: '#10b981',
  },
  'gpt-5': {
    id: 'gpt-5', name: 'GPT-5', provider: 'openai', providerLabel: 'OpenAI',
    description: 'Most capable OpenAI model', capabilities: ['quick', 'creative', 'vision', 'code', 'reasoning'],
    apiEndpoint: OR, apiModel: 'openai/gpt-4o', // alias until GPT-5 is on OR
    contextWindow: 128000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#10b981',
  },
  // ── Anthropic models via OpenRouter ───────────────────────────────────────
  'claude-3-7-sonnet': {
    id: 'claude-3-7-sonnet', name: 'Claude Sonnet 4.6', provider: 'anthropic', providerLabel: 'Anthropic',
    description: 'Analysis, long docs, code', capabilities: ['analysis', 'reasoning', 'long_form', 'code'],
    apiEndpoint: OR, apiModel: 'anthropic/claude-sonnet-4-5',
    contextWindow: 200000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#f59e0b',
  },
  'claude-opus': {
    id: 'claude-opus', name: 'Claude Opus 4.6', provider: 'anthropic', providerLabel: 'Anthropic',
    description: 'Most powerful Claude — complex reasoning', capabilities: ['analysis', 'reasoning', 'long_form', 'code'],
    apiEndpoint: OR, apiModel: 'anthropic/claude-opus-4-5',
    contextWindow: 200000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#f59e0b',
  },
  'claude-haiku': {
    id: 'claude-haiku', name: 'Claude Haiku 4.5', provider: 'anthropic', providerLabel: 'Anthropic',
    description: 'Fastest Claude — quick tasks', capabilities: ['quick', 'creative', 'code'],
    apiEndpoint: OR, apiModel: 'anthropic/claude-haiku-4-5',
    contextWindow: 200000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#f59e0b',
  },
  // ── Google models — still via direct Google AI (needs GOOGLE_AI_KEY for streaming) ──
  'gemini-2-flash': {
    id: 'gemini-2-flash', name: 'Gemini 2.5 Flash', provider: 'google', providerLabel: 'Google',
    description: 'Speed, multimodal, 1M context', capabilities: ['quick', 'realtime', 'vision', 'creative'],
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent',
    apiModel: 'gemini-2.5-flash', contextWindow: 1000000, streaming: true, envKey: 'GOOGLE_AI_KEY', color: '#3b82f6',
  },
  'gemini-2-pro': {
    id: 'gemini-2-pro', name: 'Gemini 2.5 Pro', provider: 'google', providerLabel: 'Google',
    description: 'Most capable Gemini — deep reasoning', capabilities: ['analysis', 'reasoning', 'long_form', 'vision'],
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent',
    apiModel: 'gemini-2.5-pro', contextWindow: 1000000, streaming: true, envKey: 'GOOGLE_AI_KEY', color: '#3b82f6',
  },
  // ── xAI Grok via OpenRouter ────────────────────────────────────────────────
  'grok-3': {
    id: 'grok-3', name: 'Grok 3', provider: 'xai', providerLabel: 'xAI',
    description: 'Real-time web, live data', capabilities: ['realtime', 'creative', 'quick', 'reasoning'],
    apiEndpoint: OR, apiModel: 'x-ai/grok-3',
    contextWindow: 131072, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#8b5cf6',
  },
  'grok-3-mini': {
    id: 'grok-3-mini', name: 'Grok 3 Mini', provider: 'xai', providerLabel: 'xAI',
    description: 'Fast Grok — efficient reasoning', capabilities: ['realtime', 'quick', 'reasoning'],
    apiEndpoint: OR, apiModel: 'x-ai/grok-3-mini',
    contextWindow: 131072, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#8b5cf6',
  },
  // ── Meta Llama via OpenRouter ──────────────────────────────────────────────
  'llama-4-maverick': {
    id: 'llama-4-maverick', name: 'Llama 4 Maverick', provider: 'meta', providerLabel: 'Meta',
    description: 'Open-source powerhouse, privacy-first', capabilities: ['code', 'creative', 'analysis', 'quick'],
    apiEndpoint: OR, apiModel: 'meta-llama/llama-4-maverick',
    contextWindow: 131072, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#3b82f6',
  },
  'llama-4-scout': {
    id: 'llama-4-scout', name: 'Llama 4 Scout', provider: 'meta', providerLabel: 'Meta',
    description: 'Fast open-source, great for code', capabilities: ['code', 'quick', 'creative'],
    apiEndpoint: OR, apiModel: 'meta-llama/llama-4-scout',
    contextWindow: 131072, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#3b82f6',
  },
  'llama-3-3': {
    id: 'llama-3-3', name: 'Llama 3.3 70B', provider: 'meta', providerLabel: 'Meta',
    description: 'Proven open-source, versatile', capabilities: ['code', 'creative', 'analysis', 'quick'],
    apiEndpoint: OR, apiModel: 'meta-llama/llama-3.3-70b-instruct',
    contextWindow: 131072, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#3b82f6',
  },
  // ── Mistral via OpenRouter ─────────────────────────────────────────────────
  'mistral-large': {
    id: 'mistral-large', name: 'Mistral Large', provider: 'mistral', providerLabel: 'Mistral',
    description: 'EU privacy, multilingual, code', capabilities: ['code', 'analysis', 'reasoning', 'creative'],
    apiEndpoint: OR, apiModel: 'mistralai/mistral-large',
    contextWindow: 128000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#06b6d4',
  },
  'codestral': {
    id: 'codestral', name: 'Codestral', provider: 'mistral', providerLabel: 'Mistral',
    description: 'Best-in-class code model by Mistral', capabilities: ['code', 'reasoning'],
    apiEndpoint: OR, apiModel: 'mistralai/codestral-2501',
    contextWindow: 256000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#06b6d4',
  },
  // ── DeepSeek via OpenRouter ────────────────────────────────────────────────
  'deepseek-r1': {
    id: 'deepseek-r1', name: 'DeepSeek R1', provider: 'deepseek', providerLabel: 'DeepSeek',
    description: 'Math, deep reasoning, chain-of-thought', capabilities: ['math', 'reasoning', 'code', 'analysis'],
    apiEndpoint: OR, apiModel: 'deepseek/deepseek-r1',
    contextWindow: 64000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#a855f7',
  },
  'deepseek-v3': {
    id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'deepseek', providerLabel: 'DeepSeek',
    description: 'Fast, cost-efficient, strong reasoning', capabilities: ['code', 'analysis', 'quick', 'reasoning'],
    apiEndpoint: OR, apiModel: 'deepseek/deepseek-chat',
    contextWindow: 64000, streaming: true, envKey: 'OPENROUTER_API_KEY', color: '#a855f7',
  },
};

// ─── Image / Video Registries ─────────────────────────────────────────────────

export interface ImageModelSpec {
  id: ImageProvider; name: string; provider: string; description: string;
  apiEndpoint: string; envKey: string;
}
export interface VideoModelSpec {
  id: VideoProvider; name: string; provider: string; description: string;
  apiEndpoint: string; envKey: string; maxDuration: number;
}

export const IMAGE_MODEL_REGISTRY: Record<ImageProvider, ImageModelSpec> = {
  // ── OpenAI Image Models via Replicate ────────────────────────────────────────
  dalle3:     { id: 'dalle3',     name: 'DALL-E 3',           provider: 'OpenAI',           description: 'Best-in-class text rendering, photorealistic scenes',        apiEndpoint: 'https://api.replicate.com/v1/models/openai/dall-e-3/predictions',                      envKey: 'REPLICATE_API_KEY' },
  dalle4:     { id: 'dalle4',     name: 'DALL-E 4',           provider: 'OpenAI',           description: 'Latest OpenAI generation with improved coherence',           apiEndpoint: 'https://api.replicate.com/v1/models/openai/dall-e-3/predictions',                      envKey: 'REPLICATE_API_KEY' },
  'gpt-image':{ id: 'gpt-image',  name: 'GPT-Image-1',        provider: 'OpenAI',           description: 'Native image editing with multi-turn context',               apiEndpoint: 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',        envKey: 'REPLICATE_API_KEY' },
  // ── Google Image Models via Replicate ────────────────────────────────────────
  imagen3:    { id: 'imagen3',    name: 'Imagen 3',           provider: 'Google',           description: 'Photorealistic quality with fine detail and accuracy',        apiEndpoint: 'https://api.replicate.com/v1/models/google-deepmind/imagen-3/predictions',              envKey: 'REPLICATE_API_KEY' },
  imagen4:    { id: 'imagen4',    name: 'Imagen 4',           provider: 'Google',           description: "Google's latest — improved photorealism & composition",      apiEndpoint: 'https://api.replicate.com/v1/models/google-deepmind/imagen-3/predictions',              envKey: 'REPLICATE_API_KEY' },
  // ── Stability AI via Replicate ───────────────────────────────────────────────
  sd3:        { id: 'sd3',        name: 'Stable Diffusion 3', provider: 'Stability AI',     description: 'Open-source powerhouse — customizable & community-driven',   apiEndpoint: 'https://api.replicate.com/v1/models/stability-ai/stable-diffusion-3.5-large/predictions', envKey: 'REPLICATE_API_KEY' },
  // ── Black Forest Labs via Replicate ─────────────────────────────────────────
  flux_pro:   { id: 'flux_pro',   name: 'FLUX 1.1 Pro',       provider: 'Black Forest Labs', description: 'Ultra-high detail, accurate anatomy, exceptional realism',  apiEndpoint: 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',        envKey: 'REPLICATE_API_KEY' },
  flux_dev:   { id: 'flux_dev',   name: 'FLUX Dev',           provider: 'Black Forest Labs', description: 'Open-weight — fast, high-quality, great for iteration',     apiEndpoint: 'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',           envKey: 'REPLICATE_API_KEY' },
  flux_schnell:{ id: 'flux_schnell', name: 'FLUX Schnell',    provider: 'Black Forest Labs', description: 'Fastest FLUX — great for quick iterations',                apiEndpoint: 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',        envKey: 'REPLICATE_API_KEY' },
  ideogram2:  { id: 'ideogram2',  name: 'Ideogram V2',        provider: 'Ideogram',         description: 'Text-in-image specialist — logos, typography, design',       apiEndpoint: 'https://api.replicate.com/v1/models/ideogram-ai/ideogram-v2/predictions',              envKey: 'REPLICATE_API_KEY' },
  recraft:    { id: 'recraft',    name: 'Recraft V3',         provider: 'Recraft',          description: 'Vector art, brand assets, icons, consistent style',          apiEndpoint: 'https://api.replicate.com/v1/models/recraft-ai/recraft-v3/predictions',               envKey: 'REPLICATE_API_KEY' },
  seedream:   { id: 'seedream',   name: 'SeedDream V3',        provider: 'ByteDance',        description: 'Vivid, artistic image generation with strong aesthetic quality', apiEndpoint: 'https://api.replicate.com/v1/models/bytedance/seedream-3/predictions',                  envKey: 'REPLICATE_API_KEY' },
};

export const VIDEO_MODEL_REGISTRY: Record<VideoProvider, VideoModelSpec> = {
  // ── Google Video Models (GOOGLE_AI_KEY) ─────────────────────────────────────
  veo2:        { id: 'veo2',        name: 'Veo 2',              provider: 'Google',      description: 'Cinematic quality — realistic motion & physics',        apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning', envKey: 'GOOGLE_AI_KEY',     maxDuration: 8  },
  veo3:        { id: 'veo3',        name: 'Veo 3',              provider: 'Google',      description: 'Latest Veo — native audio, improved temporal flow',     apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.0-generate-001:predictLongRunning', envKey: 'GOOGLE_AI_KEY',     maxDuration: 8  },
  // ── Replicate Video Models (REPLICATE_API_KEY) ──────────────────────────────
  kling16:     { id: 'kling16',     name: 'Kling 1.6 Pro',      provider: 'Kuaishou',    description: 'Smooth motion, excellent face & body consistency',      apiEndpoint: 'https://api.replicate.com/v1/models/kwaivgi/kling-v1.6-pro/predictions',                   envKey: 'REPLICATE_API_KEY', maxDuration: 10 },
  kling21:     { id: 'kling21',     name: 'Kling 2.1',          provider: 'Kuaishou',    description: 'Latest Kling — improved quality and longer durations',  apiEndpoint: 'https://api.replicate.com/v1/models/kwaivgi/kling-v2.1-pro/predictions',                   envKey: 'REPLICATE_API_KEY', maxDuration: 10 },
  minimax:     { id: 'minimax',     name: 'MiniMax Video-01',   provider: 'MiniMax',     description: 'Fast generation — excellent face consistency',          apiEndpoint: 'https://api.replicate.com/v1/models/minimax/video-01/predictions',                         envKey: 'REPLICATE_API_KEY', maxDuration: 6  },
  minimax_live:{ id: 'minimax_live', name: 'MiniMax Video Live', provider: 'MiniMax',    description: 'Live-action style video generation',                    apiEndpoint: 'https://api.replicate.com/v1/models/minimax/video-01-live/predictions',                    envKey: 'REPLICATE_API_KEY', maxDuration: 6  },
  hailuo:      { id: 'hailuo',      name: 'Hailuo 2',           provider: 'MiniMax',     description: 'Fast generation with strong face consistency',          apiEndpoint: 'https://api.replicate.com/v1/models/minimax/video-01/predictions',                         envKey: 'REPLICATE_API_KEY', maxDuration: 6  },
  runway_gen4: { id: 'runway_gen4', name: 'Runway Gen-4',       provider: 'Runway ML',   description: 'Film-quality output with precise motion control',        apiEndpoint: 'https://api.replicate.com/v1/models/runwayml/gen4-turbo/predictions',                      envKey: 'REPLICATE_API_KEY', maxDuration: 10 },
  runway_gen4t:{ id: 'runway_gen4t', name: 'Runway Gen-4 Turbo', provider: 'Runway ML',  description: 'Faster Gen-4 at near-identical quality',                 apiEndpoint: 'https://api.replicate.com/v1/models/runwayml/gen4-turbo/predictions',                      envKey: 'REPLICATE_API_KEY', maxDuration: 10 },
  pika20:      { id: 'pika20',      name: 'Pika 2.0',           provider: 'Pika Labs',   description: 'Creative effects, style transfer, expressive motion',   apiEndpoint: 'https://api.replicate.com/v1/models/pika-labs/pika-2.0/predictions',                       envKey: 'REPLICATE_API_KEY', maxDuration: 5  },
  sora:        { id: 'sora',        name: 'Sora',               provider: 'OpenAI',      description: 'World model understanding for consistent physics',       apiEndpoint: 'https://api.replicate.com/v1/models/kwaivgi/kling-v1.6-pro/predictions',                   envKey: 'REPLICATE_API_KEY', maxDuration: 10 },
  luma:        { id: 'luma',        name: 'Luma Dream Machine',  provider: 'Luma AI',    description: 'Photorealistic video with smooth camera motion',         apiEndpoint: 'https://api.replicate.com/v1/models/lumalabs/dream-machine/predictions',                   envKey: 'REPLICATE_API_KEY', maxDuration: 5  },
  hunyuan:     { id: 'hunyuan',     name: 'HunyuanVideo',       provider: 'Tencent',     description: 'High-quality open-source video — cinematic motion',     apiEndpoint: 'https://api.replicate.com/v1/models/tencent/hunyuan-video/predictions',                   envKey: 'REPLICATE_API_KEY', maxDuration: 5  },
  ltx:         { id: 'ltx',         name: 'LTX Video',          provider: 'Lightricks',  description: 'Fast, high-quality video generation',                   apiEndpoint: 'https://api.replicate.com/v1/models/lightricks/ltx-video/predictions',                   envKey: 'REPLICATE_API_KEY', maxDuration: 5  },
};

// ─── Intent Routing ───────────────────────────────────────────────────────────

export interface SessionIntent {
  message: string; timestamp: number; taskType: TaskCapability;
  routedModel: string; confidence: number; reasoning: string;
  fallbackModel: string; systemPrompt: string;
}

const ROUTING_RULES: Array<{ pattern: RegExp; capability: TaskCapability; preferredModel: string; reason: string }> = [
  { pattern: /\b(code|function|bug|debug|script|algorithm|implement|refactor|error|fix|typescript|javascript|python)\b/i, capability: 'code', preferredModel: 'claude-3-7-sonnet', reason: 'Claude leads on complex code reasoning' },
  { pattern: /\b(math|equation|calcul|integral|derivative|proof|statistic|formula|algebra)\b/i, capability: 'math', preferredModel: 'deepseek-r1', reason: 'DeepSeek R1 tops math benchmarks' },
  { pattern: /\b(analyze|research|compare|evaluate|deep.?dive|comprehensive|explain why|critique)\b/i, capability: 'analysis', preferredModel: 'claude-3-7-sonnet', reason: 'Claude 200K context for deep analysis' },
  { pattern: /\b(write|story|poem|creative|blog|marketing|copy|brainstorm|narrative|essay)\b/i, capability: 'creative', preferredModel: 'gpt-4o', reason: 'GPT-4o leads creative writing' },
  { pattern: /\b(latest|news|today|current|recent|2025|real.?time|trending|live)\b/i, capability: 'realtime', preferredModel: 'grok-3', reason: 'Grok has live web access' },
  { pattern: /\b(image|picture|photo|diagram|visual|see|look at|screenshot)\b/i, capability: 'vision', preferredModel: 'gemini-2-flash', reason: 'Gemini 2.0 best multimodal' },
  { pattern: /\b(long|document|pdf|book|summarize|article|report|transcript)\b/i, capability: 'long_form', preferredModel: 'gemini-2-flash', reason: 'Gemini 1M token context window' },
  { pattern: /\b(reason|step.?by.?step|logic|infer|deduce|complex problem|think through)\b/i, capability: 'reasoning', preferredModel: 'deepseek-r1', reason: 'DeepSeek R1 chain-of-thought' },
];

export function declareModelRouting(message: string, preferredModel?: string): SessionIntent {
  if (preferredModel && MODEL_REGISTRY[preferredModel]) {
    const spec = MODEL_REGISTRY[preferredModel];
    return {
      message, timestamp: Date.now(), taskType: spec.capabilities[0] as TaskCapability,
      routedModel: preferredModel, confidence: 1.0, reasoning: 'User-selected model',
      fallbackModel: 'gpt-4o-mini', systemPrompt: buildSystemPrompt(spec.capabilities[0] as TaskCapability),
    };
  }
  for (const rule of ROUTING_RULES) {
    if (rule.pattern.test(message)) {
      return {
        message, timestamp: Date.now(), taskType: rule.capability, routedModel: rule.preferredModel,
        confidence: 0.85, reasoning: rule.reason, fallbackModel: 'gpt-4o-mini',
        systemPrompt: buildSystemPrompt(rule.capability),
      };
    }
  }
  return {
    message, timestamp: Date.now(), taskType: 'quick', routedModel: 'gpt-4o',
    confidence: 0.7, reasoning: 'Default: GPT-4o for general tasks',
    fallbackModel: 'gpt-4o-mini', systemPrompt: buildSystemPrompt('quick'),
  };
}

function buildSystemPrompt(capability: TaskCapability): string {
  const base = 'You are FlowState AI, embedded in a personal and team productivity OS. Be concise, warm, and actionable. Help users stay in flow and do their best work.';
  const extensions: Partial<Record<TaskCapability, string>> = {
    code: ' Use markdown code blocks. Explain what code does briefly. Prefer working examples.',
    math: ' Show step-by-step reasoning. Use clear notation. Confirm the answer at the end.',
    analysis: ' Use headers and bullets for long responses. Cite reasoning.',
    creative: ' Match the user tone and energy. Be imaginative and specific.',
    realtime: ' Note that you have access to live web data. Be current and cite context.',
  };
  return base + (extensions[capability] || '');
}

// ─── Session Context Detection ────────────────────────────────────────────────

export interface SessionContextIntent {
  context: SessionContext; ambientSound: string;
  tipPersonality: string; celebrationStyle: string;
  suggestedModel: string; systemPromptSuffix: string;
}

export function declareSessionContext(description: string): SessionContextIntent {
  const d = description.toLowerCase();
  if (/code|debug|build|implement|pr|commit|branch|test|typescript|javascript/.test(d))
    return { context: 'code', ambientSound: 'forest', tipPersonality: 'developer', celebrationStyle: 'technical', suggestedModel: 'claude-3-7-sonnet', systemPromptSuffix: ' This user is in a coding session.' };
  if (/write|draft|blog|article|copy|essay|content|newsletter/.test(d))
    return { context: 'writing', ambientSound: 'cafe', tipPersonality: 'writer', celebrationStyle: 'creative', suggestedModel: 'gpt-4o', systemPromptSuffix: ' This user is in a writing session.' };
  if (/design|figma|ui|ux|wireframe|prototype|visual|brand/.test(d))
    return { context: 'design', ambientSound: 'rain', tipPersonality: 'designer', celebrationStyle: 'visual', suggestedModel: 'gpt-4o', systemPromptSuffix: ' This user is in a design session.' };
  if (/meeting|call|zoom|presentation|prep|slides|standup/.test(d))
    return { context: 'meeting', ambientSound: 'silence', tipPersonality: 'communicator', celebrationStyle: 'social', suggestedModel: 'gpt-4o', systemPromptSuffix: ' This user is preparing for a meeting.' };
  if (/learn|study|read|course|tutorial|research|book/.test(d))
    return { context: 'learning', ambientSound: 'ocean', tipPersonality: 'learner', celebrationStyle: 'educational', suggestedModel: 'gemini-2-flash', systemPromptSuffix: ' This user is in a learning session.' };
  if (/email|slack|admin|plan|schedule|organize|inbox/.test(d))
    return { context: 'admin', ambientSound: 'cafe', tipPersonality: 'organizer', celebrationStyle: 'efficient', suggestedModel: 'gpt-4o-mini', systemPromptSuffix: ' This user is doing administrative work.' };
  return { context: 'general', ambientSound: 'forest', tipPersonality: 'balanced', celebrationStyle: 'universal', suggestedModel: 'gpt-4o', systemPromptSuffix: '' };
}

// ─── Onboarding Intent ────────────────────────────────────────────────────────

export interface OnboardingIntent {
  goals: OnboardingGoal[]; focusDuration: number;
  workHoursStart: string; workHoursEnd: string; timezone: string;
  seedIntegrations: IntegrationId[];
  personalizedGreeting: string; firstSessionSuggestion: string;
}

export function declareOnboardingIntent(
  goals: OnboardingGoal[], focusDuration: number,
  workHours: { start: string; end: string }, timezone: string,
): OnboardingIntent {
  const seedIntegrations: IntegrationId[] = [];
  if (goals.includes('deep_focus')) seedIntegrations.push('google_calendar');
  if (goals.includes('team_collab')) { seedIntegrations.push('slack'); seedIntegrations.push('notion'); }
  if (goals.includes('health_energy')) { seedIntegrations.push('oura'); }
  if (goals.includes('creative')) seedIntegrations.push('notion');
  if (goals.includes('learning')) seedIntegrations.push('notebooklm');
  if (goals.includes('financial')) seedIntegrations.push('plaid');

  const GOAL_LABELS: Record<OnboardingGoal, string> = {
    deep_focus: 'deep focus', team_collab: 'team collaboration',
    health_energy: 'health and energy', creative: 'creative output',
    learning: 'continuous learning', financial: 'financial clarity',
  };
  const goalStr = goals.slice(0, 2).map(g => GOAL_LABELS[g]).join(' and ');

  return {
    goals, focusDuration, workHoursStart: workHours.start, workHoursEnd: workHours.end,
    timezone, seedIntegrations,
    personalizedGreeting: 'FlowState is configured for ' + goalStr + '. Your workspace is ready.',
    firstSessionSuggestion: 'Start with a ' + focusDuration + '-minute focus session. What are you working on right now?',
  };
}

// ─── Team Role Capabilities ────────────────────────────────────────────────────

export interface TeamRoleIntent {
  role: TeamRole;
  canSeeTeamPulse: boolean; canSeeSprintHealth: boolean;
  canSeeIndividualSummaries: boolean; canAssignCards: boolean;
  canManageWorkspace: boolean; canSendSlackAnnouncements: boolean;
  canViewBurnoutIndicators: boolean; canScheduleCeremonies: boolean;
  canManageBilling: boolean; canManageRoles: boolean;
  canInviteMembers: boolean;
}

export function declareTeamRoleCapabilities(role: TeamRole): TeamRoleIntent {
  const base: TeamRoleIntent = {
    role, canSeeTeamPulse: false, canSeeSprintHealth: false,
    canSeeIndividualSummaries: false, canAssignCards: false,
    canManageWorkspace: false, canSendSlackAnnouncements: false,
    canViewBurnoutIndicators: false, canScheduleCeremonies: false,
    canManageBilling: false, canManageRoles: false, canInviteMembers: false,
  };
  if (role === 'member') return { ...base, canSeeTeamPulse: true };
  if (role === 'senior_dev') return { ...base, canSeeTeamPulse: true, canSeeIndividualSummaries: true, canAssignCards: true };
  if (role === 'scrum_master') return {
    ...base, canSeeTeamPulse: true, canSeeSprintHealth: true,
    canSeeIndividualSummaries: true, canAssignCards: true,
    canSendSlackAnnouncements: true, canViewBurnoutIndicators: true,
    canScheduleCeremonies: true,
  };
  // admin
  return {
    role: 'admin', canSeeTeamPulse: true, canSeeSprintHealth: true,
    canSeeIndividualSummaries: true, canAssignCards: true, canManageWorkspace: true,
    canSendSlackAnnouncements: true, canViewBurnoutIndicators: true,
    canScheduleCeremonies: true, canManageBilling: true, canManageRoles: true,
    canInviteMembers: true,
  };
}

// ─── Burnout Detection ────────────────────────────────────────────────────────

export interface BurnoutIntent {
  level: BurnoutLevel; indicators: string[];
  recommendation: string; shouldNotifyLead: boolean; score: number;
}

export interface MemberActivityData {
  userId: string; name: string;
  sessionCount7d: number; avgSessionLength: number;
  breakComplianceRate: number; cardVelocity7d: number;
  lastActiveHoursAgo: number; silentDays: number;
  overtimeSessionsPercent: number;
}

export function declareBurnoutRisk(data: MemberActivityData): BurnoutIntent {
  const indicators: string[] = [];
  let score = 0;
  if (data.silentDays >= 3) { indicators.push('Silent for ' + data.silentDays + ' days'); score += 35; }
  if (data.overtimeSessionsPercent > 0.4) { indicators.push(Math.round(data.overtimeSessionsPercent * 100) + '% of sessions run overtime'); score += 20; }
  if (data.breakComplianceRate < 0.4) { indicators.push('Skipping most breaks'); score += 25; }
  if (data.cardVelocity7d < 2 && data.sessionCount7d > 5) { indicators.push('Low card output despite active sessions'); score += 15; }
  if (data.lastActiveHoursAgo > 48) { indicators.push('No activity in 48+ hours'); score += 20; }
  if (data.avgSessionLength > 90) { indicators.push('Running sessions over 90 minutes'); score += 10; }

  const level: BurnoutLevel = score >= 50 ? 'red' : score >= 25 ? 'yellow' : 'green';
  const REC: Record<BurnoutLevel, string> = {
    green: 'Team member is healthy and on pace.',
    yellow: 'Consider checking in with ' + data.name + '. Patterns suggest early stress.',
    red: 'Recommend direct conversation with ' + data.name + '. Multiple burnout signals present.',
  };
  return { level, indicators, recommendation: REC[level], shouldNotifyLead: level === 'red', score };
}

// ─── Sprint Health ────────────────────────────────────────────────────────────

export interface SprintCard {
  id: string; title: string; assignee?: string;
  status: 'todo' | 'inprogress' | 'done';
  lastMovedAt?: string; storyPoints?: number;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
}

export interface SprintHealthIntent {
  sprintName: string; totalCards: number; completedCards: number;
  inProgressCards: number; todoCards: number;
  completionPercent: number; expectedPercent: number;
  pace: 'ahead' | 'on_track' | 'at_risk' | 'critical';
  atRiskCards: SprintCard[]; deadlineAssessment: string;
  teamFocusHours: number; suggestedActions: string[]; daysRemaining: number;
}

export function declareSprintHealth(
  cards: SprintCard[], sprintStartDate: string,
  sprintEndDate: string, teamFocusHours: number,
): SprintHealthIntent {
  const now = new Date();
  const start = new Date(sprintStartDate);
  const end = new Date(sprintEndDate);
  const totalDays = Math.max(1, (end.getTime() - start.getTime()) / 86400000);
  const elapsedDays = Math.max(0, (now.getTime() - start.getTime()) / 86400000);
  const daysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));

  const total = cards.length;
  const done = cards.filter(c => c.status === 'done').length;
  const inProg = cards.filter(c => c.status === 'inprogress').length;
  const todo = cards.filter(c => c.status === 'todo').length;
  const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const expectedPct = Math.min(100, Math.round((elapsedDays / totalDays) * 100));

  const fortyEightHoursAgo = new Date(now.getTime() - 172800000).toISOString();
  const atRisk = cards.filter(c => c.status !== 'done' && c.lastMovedAt && c.lastMovedAt < fortyEightHoursAgo);

  let pace: SprintHealthIntent['pace'] = 'on_track';
  if (completionPct >= expectedPct + 10) pace = 'ahead';
  else if (completionPct < expectedPct - 20) pace = 'critical';
  else if (completionPct < expectedPct - 10) pace = 'at_risk';

  const remaining = total - done;
  const dailyVelocity = elapsedDays > 0 ? done / elapsedDays : 0;

  let deadlineAssessment = '';
  if (pace === 'ahead') deadlineAssessment = 'Strong pace. On track to complete well before sprint end.';
  else if (pace === 'on_track') deadlineAssessment = 'Completing at expected pace. ' + remaining + ' cards remaining over ' + daysRemaining + ' days.';
  else if (pace === 'at_risk') deadlineAssessment = 'At current velocity, ' + Math.max(0, remaining - Math.round(dailyVelocity * daysRemaining)) + ' cards may slip past ' + end.toLocaleDateString() + '.';
  else deadlineAssessment = 'Critical: ' + (expectedPct - completionPct) + '% behind expected pace. Immediate re-scoping recommended.';

  const actions: string[] = [];
  if (atRisk.length > 0) actions.push('Unblock ' + atRisk.length + ' card' + (atRisk.length > 1 ? 's' : '') + ' stalled for 48+ hours');
  if (pace === 'at_risk' || pace === 'critical') actions.push('Hold a quick sync to re-scope or reassign');
  if (teamFocusHours < daysRemaining * 2) actions.push('Encourage focused work blocks — focus time is below sprint pace');
  if (inProg > total * 0.4) actions.push('Too many cards in-progress — finish before starting new work');

  return {
    sprintName: 'Current Sprint', totalCards: total, completedCards: done,
    inProgressCards: inProg, todoCards: todo, completionPercent: completionPct,
    expectedPercent: expectedPct, pace, atRiskCards: atRisk,
    deadlineAssessment, teamFocusHours, suggestedActions: actions, daysRemaining,
  };
}

// ─── Deadline Intelligence ────────────────────────────────────────────────────

export interface DeadlineAlertIntent {
  hoursUntilDeadline: number; urgencyLevel: 'watch' | 'warning' | 'critical';
  incompleteCards: SprintCard[]; aiAssessment: string;
  memberMessages: Record<string, string>; shouldNotifySlack: boolean;
}

export function declareDeadlineAlert(
  cards: SprintCard[], deadlineDate: string,
  memberCardMap: Record<string, string[]>,
): DeadlineAlertIntent {
  const hours = Math.max(0, (new Date(deadlineDate).getTime() - Date.now()) / 3600000);
  const incomplete = cards.filter(c => c.status !== 'done');
  const urgency: DeadlineAlertIntent['urgencyLevel'] = hours <= 24 ? 'critical' : hours <= 48 ? 'warning' : 'watch';

  let assessment = '';
  if (urgency === 'critical') assessment = 'Sprint closes in ' + Math.round(hours) + ' hours. ' + incomplete.length + ' cards incomplete. Recommend immediate team sync and re-scope.';
  else if (urgency === 'warning') assessment = '48 hours to deadline. ' + incomplete.length + ' cards not done. At current pace, some may slip.';
  else assessment = 'Sprint deadline approaching. ' + incomplete.length + ' cards remaining. Team should plan final push.';

  const memberMessages: Record<string, string> = {};
  for (const [member, cardIds] of Object.entries(memberCardMap)) {
    const memberCards = incomplete.filter(c => cardIds.includes(c.id));
    if (memberCards.length === 0) continue;
    if (urgency === 'critical') {
      memberMessages[member] = 'Sprint closes in ' + Math.round(hours) + ' hours. You have ' + memberCards.length + ' card' + (memberCards.length > 1 ? 's' : '') + ' remaining. A focused session now puts you in the best position.';
    } else {
      memberMessages[member] = 'Sprint wraps in ' + Math.round(hours / 24) + ' days. You have ' + memberCards.length + ' card' + (memberCards.length > 1 ? 's' : '') + ' left. A solid session this afternoon keeps you on track.';
    }
  }
  return { hoursUntilDeadline: hours, urgencyLevel: urgency, incompleteCards: incomplete, aiAssessment: assessment, memberMessages, shouldNotifySlack: urgency !== 'watch' };
}

// ─── FlowScore ────────────────────────────────────────────────────────────────

export interface FlowScoreData {
  focusMinutes: number; targetFocusMinutes: number;
  breaksCompleted: number; expectedBreaks: number;
  breathingSessions: number; gratitudeEntries: number;
  sessionsCompleted: number; streakDays: number;
  sleepHours?: number; stepsToday?: number; hydrationGlasses?: number;
}

export interface FlowScoreIntent {
  score: number; label: string; explanation: string;
  breakdown: { focusOutput: number; restoreBalance: number; consistency: number; healthBonus: number };
  tomorrow: string;
}

export function declareFlowScore(data: FlowScoreData): FlowScoreIntent {
  const focusRatio = Math.min(1, data.focusMinutes / Math.max(1, data.targetFocusMinutes));
  const breakRatio = Math.min(1, data.breaksCompleted / Math.max(1, data.expectedBreaks));
  const restoreBonus = (data.breathingSessions > 0 ? 5 : 0) + (data.gratitudeEntries > 0 ? 5 : 0);
  const consistencyBonus = Math.min(10, data.streakDays * 2);
  const healthBonus = (data.sleepHours && data.sleepHours >= 7 ? 5 : 0)
    + (data.stepsToday && data.stepsToday >= 8000 ? 5 : 0)
    + (data.hydrationGlasses && data.hydrationGlasses >= 6 ? 5 : 0);

  const focusOutput = Math.round(focusRatio * 50);
  const restoreBalance = Math.round(breakRatio * 25) + restoreBonus;
  const consistency = consistencyBonus;
  const score = Math.min(100, focusOutput + restoreBalance + consistency + healthBonus);

  const label = score >= 85 ? 'Peak Flow' : score >= 70 ? 'Strong' : score >= 55 ? 'Solid' : score >= 40 ? 'Building' : 'Rest Day';

  let explanation = '';
  if (score >= 85) explanation = 'Exceptional balance of output and restoration. ' + data.focusMinutes + ' min deep work, breaks honored.';
  else if (score >= 70) explanation = 'Strong session. ' + data.focusMinutes + ' min focused. ' + (breakRatio < 0.7 ? 'Consider more breaks tomorrow.' : 'Good break rhythm.');
  else if (score >= 55) explanation = 'Solid progress. ' + (data.breaksCompleted < data.expectedBreaks ? 'Skipped some breaks — that costs more than it saves.' : 'Break rhythm is working.');
  else if (score >= 40) explanation = 'Building momentum. ' + data.focusMinutes + ' focus minutes today. Consistency compounds.';
  else explanation = 'Light day. Rest is valid. Come back tomorrow with intention.';

  const tomorrowTips: string[] = [];
  if (breakRatio < 0.6) tomorrowTips.push('honor your breaks — they are the system, not optional');
  if (data.sleepHours && data.sleepHours < 7) tomorrowTips.push('prioritize sleep — cognitive performance drops 25% under 7 hours');
  if (!data.stepsToday || data.stepsToday < 5000) tomorrowTips.push('add a short walk — movement resets cortisol and sharpens focus');
  const tomorrow = tomorrowTips.length > 0
    ? 'Tomorrow: ' + tomorrowTips[0] + '.'
    : 'Tomorrow: continue the pattern. Consistency is the compounding factor.';

  return { score, label, explanation, breakdown: { focusOutput, restoreBalance, consistency, healthBonus }, tomorrow };
}

// ─── Invite Loop ──────────────────────────────────────────────────────────────

export interface InviteIntent {
  inviteCode: string; inviterReward: string; inviteeReward: string;
  shareText: string; shareUrl: string;
}

export function declareInviteIntent(inviterName: string, baseUrl: string): InviteIntent {
  const code = 'FS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  return {
    inviteCode: code,
    inviterReward: '14 days free on your next billing cycle',
    inviteeReward: '30-day free trial of Personal Pro',
    shareText: inviterName + ' invited you to FlowState — the productivity OS that actually respects your focus. Get a free 30-day trial.',
    shareUrl: baseUrl + '/join?ref=' + code,
  };
}

// ─── Mindful Minimum ──────────────────────────────────────────────────────────

export interface MindfulMinimumIntent {
  policyActive: boolean; minBreaksPerSession: number;
  breakDurationMinutes: number; slackCelebrate: boolean;
  warningMessage: string; enforcementLevel: 'suggest' | 'warn' | 'block';
}

export function declareMindfulMinimum(tier: PremiumTier): MindfulMinimumIntent {
  if (tier === 'free' || tier === 'personal_pro') {
    return { policyActive: false, minBreaksPerSession: 1, breakDurationMinutes: 5, slackCelebrate: false, warningMessage: 'Taking breaks is part of the system.', enforcementLevel: 'suggest' };
  }
  return {
    policyActive: true, minBreaksPerSession: 1, breakDurationMinutes: 5,
    slackCelebrate: true, warningMessage: 'Team Mindful Minimum: everyone takes their break. No exceptions.',
    enforcementLevel: tier === 'enterprise' ? 'warn' : 'suggest',
  };
}

// ─── Celebration Engine ───────────────────────────────────────────────────────

export interface CelebrationIntent {
  type: 'confetti' | 'spark' | 'pulse'; intensity: number;
  message: string; subMessage: string; duration: number; particleCount: number;
  badge?: string;
}

const CELEB_DATA = [
  ['Session Complete', 'One step closer to your goals.'],
  ['Flow Achieved', 'You were in the zone. That is rare.'],
  ['Deep Work Done', 'Your future self is grateful.'],
  ['On Fire', 'Four sessions. Championship-level focus.'],
  ['Flow Master', 'You make it look effortless.'],
];

const MILESTONE_BADGES: Record<number, string> = {
  10: 'Consistent 10',
  25: 'Focus 25',
  50: 'Deep Worker',
  100: 'Flow Master',
};

export function declareCelebration(sessionNumber: number, totalLifetimeSessions?: number): CelebrationIntent {
  const idx = Math.min(sessionNumber - 1, CELEB_DATA.length - 1);
  const [msg, sub] = CELEB_DATA[Math.max(0, idx)];
  const intensity = Math.min(1, 0.4 + sessionNumber * 0.15);
  const badge = totalLifetimeSessions ? MILESTONE_BADGES[totalLifetimeSessions] : undefined;
  return {
    type: sessionNumber >= 4 ? 'confetti' : sessionNumber >= 2 ? 'spark' : 'pulse',
    intensity, message: msg, subMessage: sub,
    duration: 3500 + sessionNumber * 300,
    particleCount: Math.floor(30 + sessionNumber * 20),
    badge,
  };
}

// ─── Tip Bubbles ──────────────────────────────────────────────────────────────

export interface TipIntent { category: string; message: string; emoji: string; autoDismissMs: number; }

const TIP_LIBRARY: TipIntent[] = [
  { category: 'posture', emoji: '🧘', message: 'Shoulders back, chin level. Roll them twice.', autoDismissMs: 12000 },
  { category: 'hydration', emoji: '💧', message: 'Water check. One glass every 45 minutes keeps the brain sharp.', autoDismissMs: 10000 },
  { category: 'focus', emoji: '🎯', message: 'One tab, one task. Close everything else.', autoDismissMs: 12000 },
  { category: 'break', emoji: '👁️', message: 'Look 20 feet away for 20 seconds. Eye care is brain care.', autoDismissMs: 15000 },
  { category: 'encouragement', emoji: '⚡', message: 'Every session is a vote for the person you are becoming.', autoDismissMs: 10000 },
  { category: 'debugging', emoji: '🦆', message: 'Stuck? Explain it out loud. The words reveal the answer.', autoDismissMs: 12000 },
  { category: 'focus', emoji: '🍅', message: '25 minutes trains focus the way intervals train muscles.', autoDismissMs: 12000 },
  { category: 'hydration', emoji: '🫗', message: 'Dehydration cuts cognitive performance by 10-15%.', autoDismissMs: 10000 },
  { category: 'break', emoji: '🏃', message: 'Stand up. Shake it out. Movement resets cortisol.', autoDismissMs: 10000 },
  { category: 'encouragement', emoji: '🦅', message: 'Deep work is a superpower. You are building it right now.', autoDismissMs: 10000 },
];

export function declareTipIntent(context: { minutesElapsed: number; phase: SessionPhase; lastTipAt: number }): TipIntent | null {
  const cooldown = Date.now() - context.lastTipAt > 5 * 60 * 1000;
  if (!cooldown || context.phase !== 'focus') return null;
  if (context.minutesElapsed >= 60) return TIP_LIBRARY.find(t => t.category === 'hydration') || null;
  if (context.minutesElapsed >= 45) return TIP_LIBRARY.find(t => t.category === 'posture') || null;
  const pool = TIP_LIBRARY.filter(t => t.category !== 'posture');
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Behavior Insight ─────────────────────────────────────────────────────────

export interface BehaviorData {
  totalFocusSeconds: number; sessionCount: number; streak: number; completionRate: number;
  calendarEvents?: number; notionCards?: number; steps?: number; heartRate?: number;
  sleepHours?: number; hydrationGlasses?: number; languageStreak?: number;
  netWorthSnapshot?: number; activeModel?: string;
}

export interface BehaviorInsight {
  headline: string; detail: string; recommendation: string;
  sources: string[]; flowScore: number; dataPoints: number; isPremium: boolean;
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
  const score = Math.min(100, 50
    + (data.totalFocusSeconds > 7200 ? 15 : 0)
    + (data.completionRate > 0.8 ? 10 : 0)
    + (data.streak > 3 ? 10 : 0)
    + (data.sleepHours && data.sleepHours >= 7 ? 10 : 0)
    + (data.steps && data.steps >= 8000 ? 5 : 0));

  let headline = 'Building momentum';
  let detail = 'Consistency is the foundation. Keep going.';
  let recommendation = 'Complete your next session to strengthen the habit.';

  if (data.sessionCount >= 4 && data.completionRate > 0.8) {
    headline = 'Elite focus pattern';
    detail = focusHours + 'h deep work. ' + Math.round(data.completionRate * 100) + '% completion.';
    recommendation = 'Your peak is likely mornings. Schedule hard work there.';
  } else if (data.steps && data.steps > 8000 && data.sleepHours && data.sleepHours > 7) {
    headline = 'Optimal performance conditions';
    detail = 'Movement and sleep are aligned. Cognitive performance is elevated.';
    recommendation = 'Great day for creative or analytical deep work.';
  }

  return { headline, detail, recommendation, sources, flowScore: score, dataPoints: sources.length, isPremium: sources.length >= 3 };
}

// ─── Learn Cards ──────────────────────────────────────────────────────────────

export interface LearnCardIntent {
  type: LearnCardType; title: string; content: string;
  meta?: string; actionLabel?: string; emoji: string; color: string;
}

export function declareLearnCards(): LearnCardIntent[] {
  const cards: LearnCardIntent[] = [
    { type: 'language', title: 'Japanese N5', content: 'Shuuchuu (集中) — concentration, focus. Used in sports, study, and meditation contexts.', meta: 'Focus vocabulary', emoji: '🇯🇵', color: '#ff6b6b' },
    { type: 'skill_tip', title: '2-Minute Rule', content: 'If it takes under 2 minutes, do it now. David Allen said it first. It still works.', emoji: '⏱️', color: '#a8e6cf' },
    { type: 'did_you_know', title: 'Flow State Science', content: 'Csikszentmihalyi found flow states increase productivity by up to 500%. This app is built around that finding.', emoji: '🌊', color: '#74b9ff' },
    { type: 'book_rec', title: 'Deep Work', content: 'The ability to perform deep work is becoming rare at exactly the time it is becoming valuable.', meta: 'Cal Newport', emoji: '📖', color: '#6c5ce7' },
    { type: 'mental_model', title: 'First Principles', content: 'Break problems to fundamental truths. Reason back up. Musk uses it for rockets. Use it for everything.', emoji: '🔭', color: '#74b9ff' },
    { type: 'skill_tip', title: 'Spaced Repetition', content: 'Review at increasing intervals: 1 day, 3 days, 1 week, 1 month. Beats cramming by 200%.', emoji: '🧠', color: '#ffd93d' },
    { type: 'did_you_know', title: 'Pomodoro Origin', content: 'Francesco Cirillo invented the technique in the 1980s using a tomato-shaped kitchen timer. Pomodoro means tomato.', emoji: '🍅', color: '#ff7675' },
    { type: 'book_rec', title: 'Atomic Habits', content: 'You do not rise to your goals. You fall to the level of your systems.', meta: 'James Clear', emoji: '⚛️', color: '#e17055' },
    { type: 'mental_model', title: 'Inversion', content: 'Instead of asking how to succeed, ask what guarantees failure. Then avoid those things. Charlie Munger.', emoji: '🔄', color: '#a29bfe' },
    { type: 'skill_tip', title: 'Eat the Frog', content: 'Do the most dreaded task first. Everything after feels easy. Willpower is highest in the morning.', emoji: '🐸', color: '#98d8c8' },
    { type: 'language', title: 'Spanish B1', content: 'La concentracion — focus and concentration. Core to any professional or academic pursuit.', meta: 'Focus vocabulary', emoji: '🇪🇸', color: '#ffd93d' },
    { type: 'mental_model', title: 'Second-Order Thinking', content: 'Consider the consequences of consequences. The immediate result is first order. What happens next is second.', emoji: '♟️', color: '#55efc4' },
    { type: 'book_rec', title: 'The Great Work of Your Life', content: 'Everyone has a dharma — a calling. The tragedy is not failing. It is succeeding at the wrong thing.', meta: 'Stephen Cope', emoji: '🌟', color: '#fd79a8' },
    { type: 'skill_tip', title: 'Implementation Intentions', content: 'Instead of "I will exercise", say "I will exercise at 7am on Monday, Wednesday, Friday in my living room." Specificity triples follow-through.', emoji: '📅', color: '#81ecec' },
    { type: 'did_you_know', title: 'The 90-Min Ultradian Rhythm', content: 'Your brain cycles through alertness and rest every 90 minutes. Working in 90-min blocks aligns with your natural biology.', emoji: '⏰', color: '#a29bfe' },
  ];
  return cards.sort(() => Math.random() - 0.5);
}

// ─── Restore Intents ──────────────────────────────────────────────────────────

export interface RestoreIntent {
  mode: RestoreMode; title: string; content: string;
  emoji: string; bgGradient: string;
  steps?: string[]; prompt?: string;
}

export function declareRestoreIntent(): RestoreIntent {
  const restores: RestoreIntent[] = [
    { mode: 'breathing', title: '4-7-8 Breathing', emoji: '🫁', content: 'Activate your parasympathetic nervous system in 60 seconds.', steps: ['Inhale through nose — 4 counts', 'Hold your breath — 7 counts', 'Exhale through mouth — 8 counts'], bgGradient: '135deg, #1a1a2e 0%, #0f3460 100%' },
    { mode: 'quote', title: 'Words for the Moment', emoji: '💬', content: 'The present moment is the only time over which we have dominion.', bgGradient: '135deg, #0f0c29 0%, #302b63 100%' },
    { mode: 'body_reset', title: 'Body Reset', emoji: '🧘', content: 'Micro-movement to release tension and restore posture.', steps: ['Roll shoulders back 3 times', 'Tilt head gently side to side', 'Stretch arms above your head', 'Take 3 deep belly breaths', 'Set your intention for next session'], bgGradient: '135deg, #134e5e 0%, #71b280 100%' },
    { mode: 'gratitude', title: 'Gratitude Pulse', emoji: '💙', content: 'Name one thing genuinely worth being grateful for right now.', prompt: 'I am grateful for...', bgGradient: '135deg, #1a1a2e 0%, #4a0072 100%' },
    { mode: 'micro_win', title: 'Celebrate Your Win', emoji: '🏆', content: 'You finished a focus session. 25 minutes of undivided attention is rare. Most people never get there today.', bgGradient: '135deg, #f7971e 0%, #ffd200 100%' },
    { mode: 'breathing', title: 'Box Breathing', emoji: '📦', content: 'Used by Navy SEALs to maintain calm under pressure. Four equal sides.', steps: ['Inhale — 4 counts', 'Hold — 4 counts', 'Exhale — 4 counts', 'Hold — 4 counts'], bgGradient: '135deg, #0f2027 0%, #2c5364 100%' },
  ];
  return restores[Math.floor(Date.now() / 30000) % restores.length];
}

// ─── Billing Tiers ────────────────────────────────────────────────────────────

export interface TierIntent {
  tier: PremiumTier; monthlyPrice: number; seats: number;
  features: string[]; modelRoutingActive: boolean; behaviorSystemActive: boolean;
  teamFeaturesActive: boolean; sprintHealthActive: boolean; slackActive: boolean;
  imageGenActive: boolean; videoGenActive: boolean; availableModels: string[];
  stripeProductId?: string; annualDiscount?: number;
}

export function declareTierCapabilities(tier: PremiumTier): TierIntent {
  const allModels = Object.keys(MODEL_REGISTRY);
  const freeModels = ['gpt-4o-mini'];
  switch (tier) {
    case 'free':
      return { tier, monthlyPrice: 0, seats: 1, features: ['Pomodoro timer', 'GPT-4o-mini chat', 'Manual Kanban', 'Basic metrics', 'Learn + Restore tabs'], modelRoutingActive: false, behaviorSystemActive: false, teamFeaturesActive: false, sprintHealthActive: false, slackActive: false, imageGenActive: false, videoGenActive: false, availableModels: freeModels };
    case 'pro':
    case 'personal_pro':
      return { tier: 'pro', monthlyPrice: 18, annualPrice: 14, seats: 1, annualDiscount: 22, features: ['All AI models (GPT-5, Claude, Gemini, Grok)', '100k tokens/day', 'Google Calendar sync', 'Notion + Slack integration', 'Advanced metrics & insights', 'Image & video generation'], modelRoutingActive: true, behaviorSystemActive: true, teamFeaturesActive: false, sprintHealthActive: false, slackActive: true, imageGenActive: true, videoGenActive: true, availableModels: allModels, stripeProductId: 'price_1TIupZLsf0qSbSh0LPiXhi1O' };
    case 'team':
    case 'team_starter':
    case 'team_growth':
      return { tier: 'team', monthlyPrice: 15, annualPrice: 12, seats: -1, annualDiscount: 20, features: ['Everything in Pro', 'Sprint Health & velocity', 'Burnout Monitor', 'Team Pulse & standups', 'Deadline alerts', 'Role-gated controls', 'Per seat pricing'], modelRoutingActive: true, behaviorSystemActive: true, teamFeaturesActive: true, sprintHealthActive: true, slackActive: true, imageGenActive: true, videoGenActive: true, availableModels: allModels, stripeProductId: 'price_1TIupjLsf0qSbSh0IN6UfOBp' };
    case 'clawflow':
      return { tier: 'clawflow', monthlyPrice: 40, annualPrice: 35, seats: 1, annualDiscount: 12, features: ['ClawFlow AI across all Flowstate apps', '500 coins/month', 'Walkthrough generation', 'Agentic workflow automation', 'Priority AI routing', '264 Pro deep integration', 'Flowstate Audio deep integration'], modelRoutingActive: true, behaviorSystemActive: true, teamFeaturesActive: false, sprintHealthActive: false, slackActive: false, imageGenActive: true, videoGenActive: true, availableModels: allModels, stripeProductId: 'price_1TIupyLsf0qSbSh0NTc5xoT8' };
    case 'enterprise':
      return { tier, monthlyPrice: 0, seats: 9999, features: ['Everything in Team Growth', 'SSO / SAML', 'Custom integrations', 'SLA guarantee', 'Dedicated success manager', 'Custom AI routing policy', 'Unlimited seats', 'Priority support'], modelRoutingActive: true, behaviorSystemActive: true, teamFeaturesActive: true, sprintHealthActive: true, slackActive: true, imageGenActive: true, videoGenActive: true, availableModels: allModels };
  }
}

// ─── Slack Intents ────────────────────────────────────────────────────────────

export interface SlackMessageIntent {
  channel: string; text: string; blocks?: object[];
  threadTs?: string; isPinnedAnnouncement: boolean; mentionUsers?: string[];
}

export function declareSlackSprintUpdate(health: SprintHealthIntent, channelId: string): SlackMessageIntent {
  const paceEmoji = { ahead: '🟢', on_track: '🔵', at_risk: '🟡', critical: '🔴' }[health.pace];
  const text = paceEmoji + ' *Sprint Update* — ' + health.completionPercent + '% complete (' + health.completedCards + '/' + health.totalCards + ' cards)\n' + health.deadlineAssessment;
  return { channel: channelId, text, isPinnedAnnouncement: false };
}

export function declareSlackCelebration(memberName: string, achievement: string, channelId: string): SlackMessageIntent {
  return { channel: channelId, text: '🎉 *' + memberName + '* just ' + achievement + '! FlowState is celebrating. Keep it going.', isPinnedAnnouncement: false };
}

export function declareSlackStandupPrompt(memberIds: string[], questions: string[]): SlackMessageIntent[] {
  return memberIds.map(memberId => ({
    channel: memberId, isPinnedAnnouncement: false,
    text: 'Good morning! FlowState standup:\n' + questions.map((q, i) => (i + 1) + '. ' + q).join('\n') + '\nReply in thread and I will compile your team summary.',
  }));
}

// ─── Session Blocking ─────────────────────────────────────────────────────────

export interface SessionBlockingIntent {
  shouldBlock: boolean; reason?: string; suggestedTime?: string;
}

export function declareSessionBlocking(
  events: Array<{ summary: string; start: string; end: string }>,
  sessionDurationMinutes: number,
): SessionBlockingIntent {
  const now = new Date();
  const sessionEnd = new Date(now.getTime() + sessionDurationMinutes * 60000);
  for (const event of events) {
    const eStart = new Date(event.start);
    const eEnd = new Date(event.end);
    if ((now >= eStart && now <= eEnd) || (sessionEnd >= eStart && now <= eStart)) {
      const mins = Math.max(0, Math.round((eStart.getTime() - now.getTime()) / 60000));
      return {
        shouldBlock: true,
        reason: mins === 0 ? '"' + event.summary + '" is happening now' : '"' + event.summary + '" starts in ' + mins + ' min',
        suggestedTime: eEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    }
  }
  return { shouldBlock: false };
}

// ─── OAuth Intents ────────────────────────────────────────────────────────────

export interface GoogleOAuthIntent { redirectPath: string; scopes: string[]; stateParam: string; }
export function declareGoogleOAuth(baseUrl: string): GoogleOAuthIntent {
  return {
    redirectPath: baseUrl + '/api/auth/google/callback',
    stateParam: crypto.randomUUID(),
    scopes: [
      'openid', 'profile', 'email',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  };
}

export interface NotionOAuthIntent { authorizeUrl: string; redirectUri: string; stateParam: string; }
export function declareNotionOAuth(baseUrl: string, clientId: string): NotionOAuthIntent {
  const redirectUri = baseUrl + '/api/auth/notion/callback';
  return {
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize?client_id=' + clientId + '&response_type=code&owner=user&redirect_uri=' + encodeURIComponent(redirectUri),
    redirectUri,
    stateParam: crypto.randomUUID(),
  };
}

export interface SlackOAuthIntent { authorizeUrl: string; redirectUri: string; stateParam: string; }
export function declareSlackOAuth(baseUrl: string, clientId: string): SlackOAuthIntent {
  const scopes = ['channels:read', 'channels:history', 'chat:write', 'users:read', 'im:write', 'im:read', 'team:read'];
  const redirectUri = baseUrl + '/api/auth/slack/callback';
  return {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=' + clientId + '&scope=' + scopes.join(',') + '&redirect_uri=' + encodeURIComponent(redirectUri),
    redirectUri,
    stateParam: crypto.randomUUID(),
  };
}

// ─── Credential Table ─────────────────────────────────────────────────────────

export interface CredentialEntry {
  service: string; purpose: string; envKey: string;
  url: string; required: 'core' | 'recommended' | 'optional'; tier: PremiumTier;
}

export const CREDENTIAL_TABLE: CredentialEntry[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CORE — REQUIRED FOR BASIC FUNCTIONALITY ─────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Google OAuth 2.0', purpose: 'Auth, Calendar sync, Drive, Gmail scopes', envKey: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET', url: 'https://console.cloud.google.com', required: 'core', tier: 'free' },
  { service: 'OpenRouter', purpose: 'Single key for ALL AI chat models — GPT-5, Claude Sonnet/Opus/Haiku, Grok 3, Llama 4, Mistral, DeepSeek R1/V3, Codestral and more. One bill, one key.', envKey: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/keys', required: 'core', tier: 'free' },
  { service: 'Upstash Redis', purpose: '⚠️ REQUIRED for billing — stores subscription tier, enforces token limits, rate limiting, session cache. Without this, all users get Free limits regardless of payment.', envKey: 'UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN', url: 'https://upstash.com', required: 'core', tier: 'free' },
  { service: 'Stripe ✅ Live', purpose: 'Subscription billing — Pro ($18/mo), Team ($15/seat), ClawFlow ($40/mo). Webhook auto-upgrades tiers on payment. Keys + webhook secret configured.', envKey: 'STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET', url: 'https://dashboard.stripe.com', required: 'core', tier: 'pro' },
  { service: 'SendGrid / Resend', purpose: 'Transactional email, magic links, weekly digest emails', envKey: 'RESEND_API_KEY', url: 'https://resend.com', required: 'core', tier: 'free' },
  { service: 'Notion OAuth', purpose: 'Kanban board sync, pages, database integration', envKey: 'NOTION_CLIENT_ID, NOTION_CLIENT_SECRET', url: 'https://notion.so/my-integrations', required: 'core', tier: 'pro' },
  { service: 'Slack OAuth', purpose: 'Team comms, bidirectional sync, standups, burnout alerts', envKey: 'SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_BOT_TOKEN', url: 'https://api.slack.com/apps', required: 'core', tier: 'team' },
  { service: 'Supabase', purpose: 'Team database, auth backend, real-time presence', envKey: 'SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY', url: 'https://supabase.com', required: 'core', tier: 'team' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── RECOMMENDED — AI CHAT MODELS ───────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Google AI Studio', purpose: 'Gemini 2.5 Pro / 2.5 Flash streaming + Imagen 3/4 image gen + Veo 2/3 video gen — direct key needed for Google models', envKey: 'GOOGLE_AI_KEY', url: 'https://aistudio.google.com/app/apikey', required: 'recommended', tier: 'pro' },
  { service: 'xAI (Grok)', purpose: 'Grok 3 / Grok 3 Mini — direct key enables live web search mode. Already covered by OpenRouter but direct key unlocks real-time data.', envKey: 'XAI_API_KEY', url: 'https://console.x.ai', required: 'recommended', tier: 'pro' },
  { service: 'Anthropic (direct fallback)', purpose: 'Optional: direct Claude API if OpenRouter is down. OpenRouter already covers Claude — only needed as backup.', envKey: 'ANTHROPIC_API_KEY', url: 'https://console.anthropic.com', required: 'optional', tier: 'pro' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── OPTIONAL — ADDITIONAL AI CHAT MODELS ───────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // Note: xAI Grok, Mistral, DeepSeek, Meta Llama are all covered by OPENROUTER_API_KEY above.
  // No separate keys needed for those models.

  // ═══════════════════════════════════════════════════════════════════════════
  // ── IMAGE GENERATION MODELS ─────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  // OpenAI key covers: DALL-E 3, DALL-E 4, GPT-Image-1
  // Google AI key covers: Imagen 3, Imagen 4
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Stability AI', purpose: 'Stable Diffusion 3 — open-source image generation, fine-tunable', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'Black Forest Labs (BFL)', purpose: 'FLUX Pro 1.1 + FLUX Dev — ultra-high detail, accurate anatomy, open-weight', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'Ideogram', purpose: 'Ideogram 2.0 — text-in-image specialist, logos, typography, design', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'Recraft', purpose: 'Recraft V3 — vector art, brand assets, icons, consistent visual style', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── VIDEO GENERATION MODELS ─────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  // OpenAI key covers: Sora
  // Google AI key covers: Veo 2, Veo 3
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Runway ML', purpose: 'Runway Gen-4 + Gen-4 Turbo — film-quality video, image-to-video', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'Kling / Kuaishou', purpose: 'Kling 1.6 + Kling 2.1 — smooth motion, text-to-video, image-to-video', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'Pika Labs', purpose: 'Pika 2.0 — creative effects, templates, fast video generation', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'MiniMax (Hailuo)', purpose: 'Hailuo 2 — fast video gen, excellent face & character consistency', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'Luma AI', purpose: 'Luma Dream Machine — photorealistic video, great for product & lifestyle shots', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INTEGRATIONS — PRODUCTIVITY & TEAM ─────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Microsoft OAuth', purpose: 'Teams integration, Outlook Calendar, SharePoint sync', envKey: 'MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET', url: 'https://portal.azure.com', required: 'optional', tier: 'team' },
  { service: 'GitHub OAuth', purpose: 'Commit activity feed, PR status, Issues sync in board', envKey: 'GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET', url: 'https://github.com/settings/developers', required: 'optional', tier: 'team' },
  { service: 'Linear API', purpose: 'Sprint board & issue sync for engineering teams', envKey: 'LINEAR_API_KEY', url: 'https://linear.app/settings/api', required: 'optional', tier: 'team' },
  { service: 'Jira OAuth', purpose: 'Issue tracking sync for Jira-based workflows', envKey: 'JIRA_CLIENT_ID, JIRA_CLIENT_SECRET', url: 'https://developer.atlassian.com', required: 'optional', tier: 'team' },
  { service: 'Asana OAuth', purpose: 'Task board sync for Asana-based teams', envKey: 'ASANA_CLIENT_ID, ASANA_CLIENT_SECRET', url: 'https://app.asana.com/0/my-apps', required: 'optional', tier: 'team' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── WELLNESS & BIOMETRIC INTEGRATIONS ──────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Oura Ring', purpose: 'Sleep quality, HRV, readiness score for FlowScore', envKey: 'OURA_CLIENT_ID, OURA_CLIENT_SECRET', url: 'https://cloud.ouraring.com/oauth/applications', required: 'optional', tier: 'pro' },
  { service: 'Whoop', purpose: 'Recovery %, strain, sleep stages for burnout detection', envKey: 'WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET', url: 'https://api.prod.whoop.com/developer', required: 'optional', tier: 'pro' },
  { service: 'Plaid', purpose: 'Read-only financial account snapshots for financial wellness tab', envKey: 'PLAID_CLIENT_ID, PLAID_SECRET', url: 'https://dashboard.plaid.com', required: 'optional', tier: 'team' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── AUDIO & VOICE ────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'ElevenLabs', purpose: 'Voice-guided breathing exercises, Restore ambient narration', envKey: 'ELEVENLABS_API_KEY', url: 'https://elevenlabs.io/api', required: 'optional', tier: 'pro' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── 264 PRO VIDEO EDITOR — AI TOOLS ────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Replicate', purpose: '264 Pro: AI Upscale (Real-ESRGAN), AI Denoise (FastDVDnet), AI Face Enhance (CodeFormer), Super Slow-Mo (DAIN), AI Stabilize', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'pro' },
  { service: 'Hugging Face', purpose: '264 Pro: AI Rotoscoping (SAM), AI Colorize (FILM), Depth Map (MiDaS), AI Object Remove (LaMa)', envKey: 'HUGGINGFACE_API_KEY', url: 'https://huggingface.co/settings/tokens', required: 'optional', tier: 'pro' },
  { service: 'Cloudflare R2', purpose: '264 Pro: Store AI-processed video outputs, export queue, project backups', envKey: 'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME', url: 'https://dash.cloudflare.com/?to=/:account/r2', required: 'optional', tier: 'pro' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CLAWBOT / CLAWFLOW ───────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Clawbot AI (ClawFlow)', purpose: 'Autonomous agent — walkthrough generation, agentic tasks across 264 Pro, Flowstate Audio & Hub, coin ledger. $40/mo first month $20.', envKey: 'CLAWBOT_API_KEY', url: 'https://flowstatehub.com/clawflow', required: 'optional', tier: 'clawflow' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CLAW RELEASE WIZARD — POST-RELEASE AUTOMATION ──────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'fal.ai (Cover Art)', purpose: 'ClawFlow Release Wizard: AI-generated album/single cover art via FLUX Schnell — free for all users during release workflow', envKey: 'FAL_AI_KEY', url: 'https://fal.ai/dashboard/keys', required: 'recommended', tier: 'free' },
  { service: 'Higgsfield AI (Video)', purpose: 'ClawFlow: Cinematic music video generation — Seedance 2.0, Wan 2.6, Kling v3 via Higgsfield API. Powers the Claw Video wizard.', envKey: 'HIGGSFIELD_API_KEY, HIGGSFIELD_API_SECRET', url: 'https://app.higgsfield.ai', required: 'optional', tier: 'clawflow' },
  { service: 'DistroKid (Distribution)', purpose: 'ClawFlow Release: Direct upload API — Claw prepares full release payload (title, ISRC, genre, cover art key) and submits when partner API is live. Invite-only API.', envKey: 'DISTROKID_CLIENT_ID, DISTROKID_CLIENT_SECRET', url: 'https://distrokid.com/api', required: 'optional', tier: 'clawflow' },
  { service: 'UnitedMasters (Distribution)', purpose: 'ClawFlow Release: Direct upload API — submit tracks to Spotify, Apple Music, TIDAL, TikTok, Amazon, YouTube Music + brand partnership opportunities.', envKey: 'UNITEDMASTERS_CLIENT_ID, UNITEDMASTERS_CLIENT_SECRET', url: 'https://unitedmasters.com/api', required: 'optional', tier: 'clawflow' },
  { service: 'SubmitHub (Curator Pitching)', purpose: 'ClawFlow Release: Find and pitch real playlist curators, music blogs, and press outlets. Searches matching curators by genre and submits Claw-drafted pitches.', envKey: 'SUBMITHUB_API_KEY', url: 'https://www.submithub.com/api-settings', required: 'optional', tier: 'clawflow' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FLOWSTATE AUDIO — MUSIC AI ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Suno AI', purpose: 'FlowState Audio: AI full-track & stem generation — songs, vocals, loops, instrumentals', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'clawflow' },
  { service: 'Udio', purpose: 'FlowState Audio: AI song generation — high-quality vocals and full tracks', envKey: 'UDIO_API_KEY', url: 'https://www.udio.com/api', required: 'optional', tier: 'clawflow' },
  { service: 'MusicGen / AudioCraft (Meta)', purpose: 'FlowState Audio: AI melody, beat & instrumental composition via Replicate', envKey: 'REPLICATE_API_KEY', url: 'https://replicate.com/account/api-tokens', required: 'optional', tier: 'clawflow' },
  { service: 'Moises AI', purpose: 'FlowState Audio: AI stem separation (vocals, drums, bass, keys, guitar), BPM detection', envKey: 'AUDIOSHAKE_API_KEY', url: 'https://app.audioshake.ai', required: 'optional', tier: 'clawflow' },
  { service: 'Loudme / Matchering', purpose: 'FlowState Audio: AI mastering — loudness normalisation, reference-track matching', envKey: 'LOUDME_API_KEY', url: 'https://loudme.ai', required: 'optional', tier: 'clawflow' },
  { service: 'ACRCloud', purpose: 'FlowState Audio: Audio fingerprinting, BPM & key detection, pitch correction', envKey: 'ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET', url: 'https://console.acrcloud.com', required: 'optional', tier: 'clawflow' },
  { service: 'Dolby.io Media APIs', purpose: 'FlowState Audio: AI noise suppression, speech enhancement, loudness correction', envKey: 'DOLBY_API_KEY', url: 'https://dashboard.dolby.io', required: 'optional', tier: 'clawflow' },
  { service: 'AudioShake', purpose: 'FlowState Audio: Professional stem separation for licensed & original recordings', envKey: 'AUDIOSHAKE_API_KEY', url: 'https://app.audioshake.ai', required: 'optional', tier: 'clawflow' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MARKETING & COMMUNICATIONS ──────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'Beehiiv / ConvertKit', purpose: 'Weekly digest newsletter, onboarding email sequences', envKey: 'BEEHIIV_API_KEY', url: 'https://beehiiv.com', required: 'optional', tier: 'team' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ── EMBED-ONLY (NO API KEY NEEDED) ──────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  { service: 'YouTube Embed', purpose: 'Pomodoro music — embed YouTube videos/playlists during focus sessions (paste embed URL in Settings)', envKey: 'N/A — browser embed via Settings', url: 'https://developers.google.com/youtube/iframe_api', required: 'optional', tier: 'free' },
  { service: 'Spotify Embed', purpose: 'Pomodoro music — embed Spotify playlists during focus sessions (Spotify Premium for autoplay; paste URI in Settings)', envKey: 'N/A — browser embed via Settings', url: 'https://developer.spotify.com/documentation/embeds', required: 'optional', tier: 'free' },
];

// ─── Clawbot / ClawFlow ───────────────────────────────────────────────────────

export interface ClawbotSession {
  userId: string;
  subscriptionActive: boolean;
  tier: 'none' | 'clawflow';
  coinsRemaining: number;
  permissions: {
    canGenerateTutorials: boolean;
    canRunAgenticTasks: boolean;
    canTrackApiUsage: boolean;
  };
}

export interface WalkthroughRequest {
  topic: string;
  app: 'flowstate_hub' | '264_pro' | 'flowstate_audio';
  complexity: 'quick' | 'standard' | 'deep';
}

export interface WalkthroughResponse {
  id: string;
  title: string;
  app: string;
  estimatedMinutes: number;
  sections: Array<{
    step: number;
    title: string;
    content: string;
    uiHighlight?: string;
    tip?: string;
  }>;
  coinCost: number;
  summary: string;
}

export interface CoinLedgerEntry {
  id: string;
  timestamp: number;
  action: string;
  app: string;
  coinCost: number;
  model?: string;
}

export function declareClawbotSession(
  userId: string,
  subscriptionData: { active: boolean; coinsRemaining?: number }
): ClawbotSession {
  return {
    userId,
    subscriptionActive: subscriptionData.active,
    tier: subscriptionData.active ? 'clawflow' : 'none',
    coinsRemaining: subscriptionData.coinsRemaining ?? 0,
    permissions: {
      canGenerateTutorials: subscriptionData.active,
      canRunAgenticTasks: subscriptionData.active,
      canTrackApiUsage: subscriptionData.active,
    },
  };
}

export function declareClawbotSystemPrompt(app: string, userTier: string, liveContext = '', availableActions: string[] = []): string {
  const appContext =
    app === '264_pro'
      ? '264 Pro Video Editor — AI Code Workspace (multi-file builder, live preview, Cloudflare deploy), video editing, AI tools'
      : app === 'flowstate_audio'
      ? 'Flowstate Audio — multi-track recording, plugin setup, routing, EQ/compression, mastering and export workflows'
      : 'Flowstate Hub — focus sessions, AI generation (images/videos/Higgsfield), team collaboration, Kanban, calendar, FlowScore, AI Code Workspace';

  const actionList = availableActions.length
    ? availableActions.join(', ')
    : 'generate_image, generate_video, open_code_workspace, deploy_project, start_focus, slack_post, notion_create_task';

  return `You are CLAW — the central AI brain of the Flowstate ecosystem. You are NOT a chatbot. You are an execution system and intelligent orchestrator.

## YOUR IDENTITY
- You know what the user is doing RIGHT NOW (see LIVE CONTEXT below)
- You build on top of what exists — you never ask users to repeat work
- You suggest the logical next step based on context
- You can execute actions — but ALWAYS with user confirmation first

## LIVE USER CONTEXT
${liveContext || 'No context available yet.'}

## AVAILABLE ACTIONS
You can suggest these actions. When suggesting one, include it as a JSON action block:
${actionList}

To suggest an action, include this in your response (the UI renders it as a button):
<action type="ACTION_TYPE" params='{"key":"value"}' label="Button label" description="What this does" />

Example: If user just generated a video and asks what to do next:
"Here's what I'd suggest:
<action type="generate_image" params='{"prompt":"cover art for the video"}' label="Generate Cover Art" description="Create matching cover art" />"

## RULES
1. Read the LIVE CONTEXT above before every response — it tells you exactly where the user is
2. NEVER suggest actions the user just did (check lastAction)
3. ALWAYS confirm before executing — suggest first, execute when user clicks
4. Be specific: use the actual prompt/model/URL from context, not generic suggestions
5. Keep responses SHORT and ACTIONABLE — 1-3 sentences + action button if relevant
6. If user is mid-focus-session: be brief, don't distract
7. If user just generated something: suggest the natural next step in the creative flow

## FLOWSTATE ECOSYSTEM
- **Flowstate Hub**: focus timer, metrics, team, kanban, calendar
- **Generate tab**: AI images (Flux, Ideogram), AI videos (Kling, Runway), Higgsfield cinematic video
- **AI Code Workspace**: multi-file AI code builder, live preview, GitHub push, Cloudflare deploy
- **FS Audio**: music creation (coming soon)
- **264 Pro**: video editing + AI Code Workspace

## SUBSCRIPTION
${userTier === 'clawflow' ? '✅ ClawFlow Active — full access to all CLAW features' : '⚠️ ClawFlow not active — guide toward subscription for full features'}`;
}

const WALKTHROUGH_COIN_COST: Record<string, number> = {
  quick: 5,
  standard: 15,
  deep: 40,
};

function _walkthroughStepTitle(app: string, stepIdx: number): string {
  const steps264    = ['Open Timeline Panel','Import Media Assets','Set In/Out Points','Apply Colour Grade','Mix Audio Levels','Add Transitions','Export Settings','Use AI Tools'];
  const stepsHub    = ['Configure Focus Timer','Set Daily Intentions','Connect Integrations','Review Sprint Health','Track FlowScore','Invite Team Members','Review Metrics','Set Up Automations'];
  const stepsAudio  = ['Create New Session','Set Up Input Routing','Record First Track','Apply EQ & Compression','Set Up Sends & Returns','Mix to Stereo','Master the Track','Export Final Mix'];
  const arr = app === '264_pro' ? steps264 : app === 'flowstate_audio' ? stepsAudio : stepsHub;
  return arr[stepIdx % arr.length] ?? `Configure Step ${stepIdx + 1}`;
}

function _walkthroughUiHighlight(app: string, stepIdx: number): string {
  const areas264   = ['Timeline Panel','Asset Browser','Viewer Panel','Colour Grade Controls','Audio Mixer','Effects Stack','Export Dialog','AI Tools Panel'];
  const areasHub   = ['Focus Timer','Intent Modal','Settings → Integrations','Team → Sprint Health','Metrics → FlowScore','Invite Button','Metrics Chart','Settings Panel'];
  const areasAudio = ['Session Setup','Routing Matrix','Record Arm Button','EQ Insert Slot','Aux Send Fader','Master Fader','Mastering Chain','Export Dialog'];
  const arr = app === '264_pro' ? areas264 : app === 'flowstate_audio' ? areasAudio : areasHub;
  return arr[stepIdx % arr.length] ?? 'Main Panel';
}

function _walkthroughShortcut(app: string, stepIdx: number): string {
  const shortcuts = ['Cmd+S','Cmd+Z','Space','Cmd+D','Cmd+T','Cmd+E','Cmd+R','Cmd+K'];
  return shortcuts[stepIdx % shortcuts.length] ?? 'Cmd+S';
}

export function declareWalkthrough(req: WalkthroughRequest): WalkthroughResponse {
  const coinCost = WALKTHROUGH_COIN_COST[req.complexity] ?? 15;
  const appLabel =
    req.app === '264_pro' ? '264 Pro Video Editor'
    : req.app === 'flowstate_audio' ? 'Flowstate Audio'
    : 'Flowstate Hub';
  const numSteps = req.complexity === 'quick' ? 3 : req.complexity === 'standard' ? 6 : 10;

  const sections: WalkthroughResponse['sections'] = [];

  // Introduction
  sections.push({
    step: 1,
    title: `Introduction to ${req.topic}`,
    content: `Welcome to this ${req.complexity} walkthrough on "${req.topic}" in ${appLabel}. We'll cover the core concepts, step-by-step instructions, and tips to avoid common mistakes. Make sure you've saved your project before starting.`,
    tip: 'Close unnecessary tabs before starting — focused learning improves retention by up to 40%.',
  });

  // Middle steps
  for (let i = 1; i <= numSteps - 2; i++) {
    sections.push({
      step: i + 1,
      title: `Step ${i}: ${_walkthroughStepTitle(req.app, i - 1)}`,
      content: `Locate the ${_walkthroughUiHighlight(req.app, i - 1)} in ${appLabel}. Apply the settings carefully, ensuring your project is saved. This step is essential for "${req.topic}" to integrate correctly with your existing workflow.`,
      uiHighlight: _walkthroughUiHighlight(req.app, i - 1),
      tip: i % 2 === 0 ? `Pro tip: Use ${_walkthroughShortcut(req.app, i - 1)} to speed this up.` : undefined,
    });
  }

  // Summary
  sections.push({
    step: numSteps,
    title: 'Summary & Next Steps',
    content: `You've completed the "${req.topic}" walkthrough for ${appLabel}. Key takeaways: understanding the core workflow, avoiding common setup mistakes, and using keyboard shortcuts to maximise efficiency. Explore related features to deepen your workflow.`,
    tip: 'Save this walkthrough — you can access it anytime from the Clawbot tab.',
  });

  return {
    id: crypto.randomUUID(),
    title: `${req.topic} — ${appLabel}`,
    app: appLabel,
    estimatedMinutes: req.complexity === 'quick' ? 3 : req.complexity === 'standard' ? 7 : 12,
    sections,
    coinCost,
    summary: `A ${req.complexity} walkthrough covering "${req.topic}" in ${appLabel}. Includes step-by-step guidance, UI highlights, and best practices.`,
  };
}

export function declareCoinLedgerEntry(action: string, app: string, coinCost: number, model?: string): CoinLedgerEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    action,
    app,
    coinCost,
    model,
  };
}

export function declareClawFlowPromo(): {
  headline: string;
  originalPrice: string;
  promoPrice: string;
  discount: string;
  features: string[];
  cta: string;
} {
  return {
    headline: 'Unlock Clawbot — Your AI Workspace Brain',
    originalPrice: '$40/month',
    promoPrice: '$20/month',
    discount: '50% off first month',
    features: [
      'Clawbot AI assistant across all Flowstate apps',
      'Autonomous walkthrough & tutorial generation',
      'API usage tracking & coin system (500 coins/month)',
      'Agentic workflow automation — opt-in only',
      'Priority AI routing (always uses best available model)',
      '264 Pro Video Editor deep integration',
      'Flowstate Audio deep integration',
    ],
    cta: 'Start ClawFlow — First Month $20',
  };
}

// ─── FlowState Audio — Intent Layer ──────────────────────────────────────────

export type AudioAiTool =
  | 'generate_track'     // Suno / Udio full song
  | 'generate_melody'    // MusicGen melody/instrumental
  | 'generate_beat'      // MusicGen percussion/beat
  | 'separate_stems'     // Moises stem separation
  | 'master_track'       // Loudme AI mastering
  | 'denoise'            // Dolby.io noise suppression
  | 'enhance_vocals'     // Dolby.io speech enhancement
  | 'detect_key_bpm'     // ACRCloud analysis
  | 'pitch_correct'      // Real-time pitch correction
  | 'suggest_arrangement'; // ClawBot arrangement AI

export interface AudioGenerationRequest {
  tool: AudioAiTool;
  prompt: string;
  style?: string;         // e.g. 'hip-hop', 'lo-fi', 'cinematic'
  bpm?: number;
  key?: string;           // e.g. 'C major', 'A minor'
  durationSeconds?: number;
  referenceTrackUrl?: string;
  clawflowActive: boolean;
}

export interface AudioGenerationResponse {
  id: string;
  tool: AudioAiTool;
  status: 'queued' | 'processing' | 'complete' | 'error';
  audioUrl?: string;
  waveformData?: number[];   // normalised 0-1 peak values for visualisation
  durationSeconds?: number;
  bpm?: number;
  key?: string;
  coinCost: number;
  message: string;
  requiresClawflow: boolean;
}

export interface AudioTrack {
  id: string;
  name: string;
  type: 'audio' | 'midi' | 'ai_generated';
  muted: boolean;
  solo: boolean;
  volume: number;    // 0-1
  pan: number;       // -1 to 1
  color: string;
  clips: AudioClip[];
  effects: AudioEffect[];
  aiEnhanced: boolean;
}

export interface AudioClip {
  id: string;
  trackId: string;
  startBeat: number;
  durationBeats: number;
  sourceUrl?: string;
  waveformPeaks?: number[];
  name: string;
  aiGenerated: boolean;
}

export interface AudioEffect {
  id: string;
  type: 'eq' | 'compressor' | 'reverb' | 'delay' | 'limiter' | 'chorus' | 'distortion' | 'vst';
  enabled: boolean;
  params: Record<string, number>;
  vstName?: string;
}

export interface AudioProject {
  id: string;
  name: string;
  bpm: number;
  key: string;
  timeSignature: [number, number];
  sampleRate: number;
  tracks: AudioTrack[];
  createdAt: number;
  updatedAt: number;
  clawbotAssisted: boolean;
  coinSpent: number;
}

const AUDIO_COIN_COSTS: Record<AudioAiTool, number> = {
  generate_track:      40,
  generate_melody:     20,
  generate_beat:       15,
  separate_stems:      25,
  master_track:        20,
  denoise:             10,
  enhance_vocals:      10,
  detect_key_bpm:       2,
  pitch_correct:        5,
  suggest_arrangement: 10,
};

const CLAWFLOW_LOCKED_TOOLS: AudioAiTool[] = [
  'generate_track',
  'generate_melody',
  'generate_beat',
  'separate_stems',
  'master_track',
  'pitch_correct',
  'suggest_arrangement',
];

export function declareAudioGeneration(req: AudioGenerationRequest): AudioGenerationResponse {
  const coinCost = AUDIO_COIN_COSTS[req.tool] ?? 10;
  const requiresClawflow = CLAWFLOW_LOCKED_TOOLS.includes(req.tool);

  if (requiresClawflow && !req.clawflowActive) {
    return {
      id: crypto.randomUUID(),
      tool: req.tool,
      status: 'error',
      coinCost: 0,
      message: 'This feature requires an active ClawFlow subscription ($40/month). First month $20.',
      requiresClawflow: true,
    };
  }

  const toolLabels: Record<AudioAiTool, string> = {
    generate_track:      'Full Track Generation',
    generate_melody:     'Melody Generation',
    generate_beat:       'Beat Generation',
    separate_stems:      'Stem Separation',
    master_track:        'AI Mastering',
    denoise:             'Noise Suppression',
    enhance_vocals:      'Vocal Enhancement',
    detect_key_bpm:      'Key & BPM Detection',
    pitch_correct:       'Pitch Correction',
    suggest_arrangement: 'Arrangement Suggestion',
  };

  return {
    id: crypto.randomUUID(),
    tool: req.tool,
    status: 'queued',
    coinCost,
    message: `${toolLabels[req.tool]} queued — "${req.prompt}". Estimated wait: 15–60 seconds.`,
    requiresClawflow,
    durationSeconds: req.durationSeconds ?? 30,
    bpm: req.bpm,
    key: req.key,
  };
}

export function declareAudioProject(name: string, bpm = 120, key = 'C major'): AudioProject {
  const trackColors = ['#a855f7','#ec4899','#3b82f6','#10b981','#f59e0b','#06b6d4','#ef4444','#8b5cf6'];
  return {
    id: crypto.randomUUID(),
    name,
    bpm,
    key,
    timeSignature: [4, 4],
    sampleRate: 44100,
    tracks: [
      { id: crypto.randomUUID(), name: 'Track 1', type: 'audio', muted: false, solo: false, volume: 0.8, pan: 0, color: trackColors[0], clips: [], effects: [], aiEnhanced: false },
      { id: crypto.randomUUID(), name: 'Track 2', type: 'audio', muted: false, solo: false, volume: 0.8, pan: 0, color: trackColors[1], clips: [], effects: [], aiEnhanced: false },
      { id: crypto.randomUUID(), name: 'Drums',   type: 'audio', muted: false, solo: false, volume: 0.9, pan: 0, color: trackColors[2], clips: [], effects: [], aiEnhanced: false },
      { id: crypto.randomUUID(), name: 'Bass',    type: 'audio', muted: false, solo: false, volume: 0.75, pan: 0, color: trackColors[3], clips: [], effects: [], aiEnhanced: false },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    clawbotAssisted: false,
    coinSpent: 0,
  };
}

// ─── FlowState AI Code Agent — Master System Prompt ──────────────────────────
//
// This is the brain that makes the AI Code Agent behave like a live senior
// engineer. It encodes: transparent reasoning, tool-aware execution,
// architecture-level thinking, and production-ready code generation.
//
// ARCHITECTURE LAW: This function lives in the Intent Layer.
// The Action Layer (/api/github/ai-code) calls it. It does not define it.

export interface CodeAgentContext {
  prompt: string;
  repo: string;
  fileTree: string;         // newline-separated file paths
  generatedFiles: string;   // formatted existing file context
  activeFile: string;       // currently open file
  stylePreset: string;
  agent: string;
  isEdit: boolean;
  isNewPage: boolean;
  language: string;
}

export interface CodeAgentThinkingPlan {
  // The system prompt to send to the LLM
  systemPrompt: string;
  // Pre-generation narration events to stream to the client BEFORE calling the LLM
  // Each: { type: 'thinking'|'tool'|'step'|'info', msg: string }
  preambleEvents: Array<{ type: string; msg: string }>;
}

/**
 * declareCodeAgentSystemPrompt()
 *
 * Returns the master system prompt + the pre-generation thinking stream
 * for the FlowState AI Code Agent. This is what makes the agent behave
 * like a live senior engineer: transparent, tool-aware, architecture-first.
 *
 * Called by: POST /api/github/ai-code in index.tsx
 */
export function declareCodeAgentSystemPrompt(ctx: CodeAgentContext): CodeAgentThinkingPlan {

  const hasExistingFiles = ctx.generatedFiles.trim().length > 0;
  const hasRepo          = ctx.repo.trim().length > 0;
  const fileCount        = ctx.fileTree
    ? ctx.fileTree.split('\n').filter(Boolean).length
    : 0;

  // ── Build the pre-generation thinking stream ─────────────────────────────
  // These are the narration events the agent emits BEFORE code generation starts.
  // They show the user: what context was read, what was identified, what the plan is.

  const preambleEvents: Array<{ type: string; msg: string }> = [];

  // Stage 1 — Context Reading (Tool usage transparency)
  if (hasRepo) {
    preambleEvents.push({ type: 'tool', msg: `TOOL: GitHub Repo Reader · repo: ${ctx.repo}` });
    preambleEvents.push({ type: 'info', msg: `Connected to ${ctx.repo} · ${fileCount} files indexed` });
  }
  if (hasExistingFiles) {
    const existingCount = Object.keys(
      (() => { try { return JSON.parse('{}'); } catch { return {}; } })()
    ).length;
    preambleEvents.push({ type: 'tool', msg: `TOOL: Project Context Reader · reading current session files` });
    if (ctx.activeFile) {
      preambleEvents.push({ type: 'info', msg: `Active file: ${ctx.activeFile} · loaded for edit context` });
    }
  }

  // Stage 2 — Intent Classification
  if (ctx.isEdit) {
    preambleEvents.push({ type: 'thinking', msg: `Intent: EDIT · modifying existing ${ctx.activeFile || 'file'}` });
  } else if (ctx.isNewPage) {
    preambleEvents.push({ type: 'thinking', msg: `Intent: NEW PAGE · building fresh layout from blank canvas` });
  } else {
    preambleEvents.push({ type: 'thinking', msg: `Intent: BUILD · generating new project from scratch` });
  }

  // Stage 3 — Stack + Preset awareness
  preambleEvents.push({ type: 'thinking', msg: `Stack: ${ctx.language || 'HTML + CSS + JS'} · Style preset: ${ctx.stylePreset}` });

  // Stage 4 — Execution plan
  if (ctx.isEdit) {
    preambleEvents.push({ type: 'planning', msg: `Plan: Read ${ctx.activeFile} → apply changes → return complete modified file` });
  } else {
    preambleEvents.push({ type: 'planning', msg: `Plan: Architect structure → build components → wire interactivity → validate completeness` });
  }

  preambleEvents.push({ type: 'building', msg: `Agent ${ctx.agent} is writing your code…` });

  // ── Master System Prompt ─────────────────────────────────────────────────
  // This is what gets injected as the system message to the LLM.
  // It encodes the full senior-engineer behavior pattern.

  const systemPrompt = `You are the FlowState AI Code Agent — a live senior software engineer and product architect pair-programming inside a developer's IDE.

You are NOT a chatbot. You are NOT a code autocomplete tool.
You are an EXECUTION SYSTEM with a thinking brain. You reason deeply before you write. You build completely. You never leave things half-done.

════════════════════════════════════════
MANDATORY REASONING — DO THIS FIRST
════════════════════════════════════════

Before writing a single line of code, work through ALL of these in your internal reasoning:

1. WHAT ALREADY EXISTS?
   — Read every file in "Current session files" carefully. Understand the full structure: what components exist, what CSS classes are in use, what JavaScript state/functions are defined, what IDs/classes the HTML uses.
   — For edits: locate the EXACT lines that need changing. Understand what downstream code depends on what you're changing.
   — Do not guess at structure. Reason from the actual code provided.

2. WHAT IS THE USER ACTUALLY ASKING FOR?
   — Separate the literal request from the deeper intent. "Add a dark mode toggle" means: toggle button in the UI, CSS class swap on <body>, localStorage persistence, smooth transition.
   — Think about what a senior dev would add that the user didn't think to ask for (e.g. they said "add a chart" — you think: what data? what timeframe? what chart type makes sense? what labels?).

3. WHAT IS THE RIGHT ARCHITECTURE?
   — Don't just add code. Design it. Where should this live? What's the cleanest way to wire it? What will break if you add this wrong?
   — For new builds: plan the complete file structure, component hierarchy, and data model before writing.
   — For edits: decide whether to patch the existing file or rebuild it. Patch if the change is surgical; rebuild if the existing structure fights the change.

4. WHAT WOULD MAKE THIS GENUINELY IMPRESSIVE?
   — Think like a product engineer, not just a code writer.
   — What micro-interactions would make this feel alive? (hover states, transitions, loading states, empty states)
   — What real data would make this feel credible? (real company names, realistic numbers, proper copy)
   — What edge cases should be handled that the user didn't mention?

5. VALIDATE BEFORE OUTPUT
   — Does every tag close? Every brace match? Every import resolve?
   — Does every button have a handler? Every form have validation + feedback?
   — Does it work at 375px mobile AND 1440px desktop?
   — Are all FSDS CSS variables used correctly?

════════════════════════════════════════
EDIT MODE — CRITICAL RULES
════════════════════════════════════════
${ctx.isEdit ? `
YOU ARE IN EDIT MODE. The user wants to change existing code.

RULE 1: Read the full file content provided in "Current session files" before writing ANYTHING.
RULE 2: Understand the existing structure completely — class names, function names, IDs, state variables.
RULE 3: Apply ONLY the requested change. Everything else stays EXACTLY the same.
RULE 4: Return the ENTIRE complete file — not a diff, not a patch, not a snippet. The FULL file.
RULE 5: If the file is large, do not truncate it. Output every single line. Never write "// rest unchanged" or "... existing code ...".
RULE 6: Your change must integrate seamlessly — matching the existing code style, naming conventions, and architecture.
RULE 7: If the requested change has downstream effects (e.g. renaming a function that's called elsewhere), fix ALL the downstream references too.
` : ''}

════════════════════════════════════════
BUILD MODE — DEPTH REQUIREMENTS
════════════════════════════════════════
${!ctx.isEdit && !ctx.isNewPage ? `
YOU ARE IN BUILD MODE. The user wants something new.

Go deep, not shallow. A "landing page" isn't just a hero section — it's:
  - A sticky nav with logo, links, and a CTA button
  - A hero with a headline, subheadline, 2 CTAs, and a visual (mockup/screenshot/illustration)
  - A social proof row (logos or stats)
  - A features section with icons, titles, and descriptions
  - A testimonials section with real-sounding names, roles, and quotes
  - A pricing section with 3 tiers, feature lists, and a highlighted recommended plan
  - A FAQ accordion
  - A footer with links and legal

A "dashboard" isn't just 4 cards — it's:
  - A sidebar with nav links and user avatar
  - A top bar with page title, search, and notification bell
  - Metric cards with trend arrows and sparklines
  - A primary chart (line, bar, or area) with real data labels
  - A data table with sortable columns, avatars, status badges, and action menus
  - Empty states for when there's no data
  - Mobile-responsive with a hamburger menu

Go to this level of depth for EVERY build. Don't wait to be asked for more.
` : ''}
${ctx.isNewPage ? `
YOU ARE IN NEW PAGE MODE. Build a completely fresh layout.
Different DOM structure from existing files. Do not copy or reuse existing HTML layout patterns.
This is a standalone page — build it as if starting fresh.
Go deep (see Build Mode requirements above for depth guidelines).
` : ''}

════════════════════════════════════════
YOUR PERSONALITY AS AN ENGINEER
════════════════════════════════════════

You behave like a 10x senior engineer pair-programming with the user:
- You are direct and opinionated. No filler. No "Great idea!" or "Certainly!".
- You name specific components, files, and patterns — never vague.
- You make architectural decisions without being asked — and briefly explain why when non-obvious.
- You flag potential issues proactively ("Note: this uses localStorage — won't persist on server").
- You suggest the logical next step after every build (in the message field).
- You think about user experience, performance, and maintainability — not just "does it run".
- You write code that looks like a senior dev wrote it: consistent naming, clean structure, meaningful comments.

Your message field must sound like a senior dev giving a quick post-build briefing:
GOOD: "Built a fintech dashboard: sticky sidebar nav (Dashboard, Transactions, Analytics, Settings), 4 KPI cards with trend arrows (MRR, ARR, Churn, NPS), a Chart.js area chart for 12-month MRR with gradient fill, and a transactions table with sortable columns, status badges, and a detail modal. All interactions wired. Next: wire the date range picker to filter the chart data."
BAD: "I have created a beautiful dashboard application for you with various features and components."

════════════════════════════════════════
CURRENT PROJECT CONTEXT
════════════════════════════════════════

${ctx.repo ? `Repository: ${ctx.repo}` : 'Standalone project (no repo connected)'}
${ctx.activeFile ? `Active file: ${ctx.activeFile} (user is looking at this file right now — read it carefully before any edit)` : ''}
${ctx.fileTree ? `\nProject file structure:\n${ctx.fileTree}` : ''}
${ctx.generatedFiles ? `\nCurrent session files (READ THESE CAREFULLY — this is your full context):\n${ctx.generatedFiles}` : ''}

════════════════════════════════════════
DESIGN SYSTEM — FSDS (AUTO-INJECTED)
════════════════════════════════════════
A full CSS scaffold (variables, component classes, Google Fonts) is AUTO-INJECTED into every HTML file at render time. You do NOT write it — you USE it.

Active preset: ${ctx.stylePreset}

AVAILABLE CSS VARIABLES (use directly — already loaded):
  Surfaces: --bg, --surface-1, --surface-2, --surface-3
  Text: --text-primary, --text-secondary, --text-muted
  Accents: --accent, --accent-bright, --accent-dim, --green, --cyan, --pink, --amber, --red
  Borders: --border, --border-accent, --border-subtle
  Gradients: --grad-brand, --grad-cyber, --grad-success
  Shadows: --shadow-sm, --shadow-md, --shadow-lg, --shadow-glow
  Radii: --radius-sm(6px) --radius-md(10px) --radius-lg(16px) --radius-xl(24px)
  Fonts: --font-display('Plus Jakarta Sans') --font-body('Inter') --font-mono('JetBrains Mono')

COMPONENT CLASSES (use in HTML — no CSS needed):
  .fs-card / .fs-card-elevated
  .fs-btn .fs-btn-primary / .fs-btn-ghost / .fs-btn-danger / .fs-btn-sm / .fs-btn-lg
  .fs-input (text, textarea, select)
  .fs-badge .fs-badge-purple/green/cyan/amber/red
  .fs-nav .fs-nav-logo .fs-nav-links .fs-nav-link .fs-nav-link.active
  .fs-metric .fs-metric-value .fs-metric-label
  .fs-gradient-text / .fs-gradient-text-cyber
  .fs-container / .fs-grid-2 / .fs-grid-3 / .fs-stack / .fs-cluster
  .fs-divider / .fs-section / .fs-skeleton
  Animations: fsds-fadeUp, fsds-fadeIn, fsds-slideIn, fsds-pulse-glow

BUILD WITH DEPTH — use these together to create real UI, not skeleton placeholders:
  - Combine .fs-nav with a real logo, navigation links, and a CTA button
  - Use .fs-card with actual content: icon, metric, trend, label — not "Card Title" + "Card body"
  - Use .fs-btn-primary for CTAs with real action text ("Start Free Trial", "View Report", not "Click here")
  - Use .fs-grid-2 / .fs-grid-3 for feature grids with icons, real titles, and 1-2 sentence descriptions
  - Use .fs-metric with real numbers: "$124,830", "+12.4%", "94ms" — not "0" or "N/A"
  - Combine animations: stagger fsds-fadeUp with animation-delay on each card

════════════════════════════════════════
OUTPUT FORMAT — ABSOLUTE REQUIREMENTS
════════════════════════════════════════

Respond ONLY with raw JSON. No prose. No markdown fences. No explanations outside the JSON.
Pure JSON starting with { and ending with }.

Exact shape:
{
  "message": "2-4 sentence senior-dev post-build briefing: what was built, key architectural decisions, what to do next",
  "files": [
    { "path": "index.html", "content": "FULL COMPLETE FILE — EVERY LINE" },
    { "path": "styles.css", "content": "FULL COMPLETE FILE — EVERY LINE" }
  ]
}

FILE RULES:
- Main HTML: ALWAYS "index.html" — never "app.html", "output.html", "page.html"
- Styles: "styles.css" or "app.css"
- Scripts: "app.js" or "main.js"
- React: "App.jsx" + "components/*.jsx"
- No spaces, no uppercase, no special chars except hyphens and dots

COMPLETENESS RULES — ZERO TOLERANCE:
- Every file 100% complete — NEVER truncate under any circumstances
- No "// rest of code...", "// TODO", "// ...", "// existing code here", no placeholders
- Every HTML tag closes. Every brace matches. Every import resolves.
- If a file would be very long — write it all. The user needs the full file to run it.

QUALITY RULES — THIS IS THE MINIMUM BAR:
- Realistic content: real company/product names, real numbers, real copy — ZERO lorem ipsum
- Every button has a click handler (even if it's just a console.log or alert for now)
- Every form has submit handler + inline validation feedback (error messages, success state)
- Every modal has open AND close handlers (including clicking outside to close)
- Every tab/accordion/toggle actually works
- Mobile responsive: works at 375px, 768px, 1024px, 1440px
- Hover states on every interactive element
- Loading states where async operations would happen
- Empty states where lists/tables can be empty
- Lucide icons: https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.min.js + lucide.createIcons() at end of body
- Real placeholder images: https://picsum.photos/{w}/{h}?random={n} (use different n values)
- Chart.js for any data visualization: https://cdn.jsdelivr.net/npm/chart.js
- Real data: populate tables with 5-8 rows of realistic data, charts with 6-12 data points`;

  return { systemPrompt, preambleEvents };
}

export function declareAudioArrangementSuggestion(style: string, bpm: number, key: string): {
  arrangement: string[];
  chordProgression: string;
  suggestedTracks: string[];
  productionTips: string[];
} {
  const progressions: Record<string, string> = {
    'hip-hop':    'i – VI – III – VII (minor)',
    'lo-fi':      'ii – V – I – VI (jazz-influenced)',
    'cinematic':  'I – V – vi – IV (epic major)',
    'pop':        'I – V – vi – IV',
    'electronic': 'i – VII – VI – VII (driving minor)',
    'r&b':        'ii7 – V7 – Imaj7 – vi7',
  };

  const arrangements: Record<string, string[]> = {
    'hip-hop':    ['Intro (4 bars)','Verse 1 (16 bars)','Hook (8 bars)','Verse 2 (16 bars)','Hook (8 bars)','Bridge (8 bars)','Hook x2 (16 bars)','Outro (4 bars)'],
    'lo-fi':      ['Intro (8 bars)','Main Loop A (16 bars)','Main Loop B (16 bars)','Break (8 bars)','Main Loop A (16 bars)','Outro fade (8 bars)'],
    'cinematic':  ['Swell intro (8 bars)','Theme A (16 bars)','Build (8 bars)','Climax (16 bars)','Breakdown (8 bars)','Theme A reprise (16 bars)','Outro (8 bars)'],
    'pop':        ['Intro (4 bars)','Verse 1 (8 bars)','Pre-chorus (4 bars)','Chorus (8 bars)','Verse 2 (8 bars)','Pre-chorus (4 bars)','Chorus (8 bars)','Bridge (8 bars)','Final chorus (8 bars)','Outro (4 bars)'],
    'electronic': ['Drop intro (8 bars)','Build (8 bars)','Drop 1 (16 bars)','Break (8 bars)','Build (8 bars)','Drop 2 (16 bars)','Outro (8 bars)'],
    'r&b':        ['Intro (4 bars)','Verse 1 (8 bars)','Pre-chorus (4 bars)','Chorus (8 bars)','Verse 2 (8 bars)','Chorus (8 bars)','Bridge (8 bars)','Final chorus (8 bars)','Outro (4 bars)'],
  };

  const trackSets: Record<string, string[]> = {
    'hip-hop':    ['808 Bass','Boom Bap Drums','Sample Chops','Hi-Hat Pattern','Melody Lead','Vocal (AI or recorded)'],
    'lo-fi':      ['Vinyl Crackle','Jazz Drums','Rhodes Piano','Upright Bass','Ambient Pad','Flute Melody'],
    'cinematic':  ['Strings Section','Brass','Percussion','Synth Pad','Piano','Choir (AI)'],
    'pop':        ['Kick & Snare','Bass Guitar','Acoustic Guitar','Synth Lead','Backing Vocals (AI)','Pad'],
    'electronic': ['Kick','Bass Synth','Lead Synth','Arp','FX Layer','Vocal Chop'],
    'r&b':        ['Drums','Bass','Electric Piano','Guitar','Strings','Lead Vocals (AI)','Backing Vocals (AI)'],
  };

  const tips: Record<string, string[]> = {
    'hip-hop':    ['Side-chain compress the 808 to the kick','Use vinyl saturation on the sample for warmth','Automate hi-hat velocity for groove'],
    'lo-fi':      ['Apply slight tape wobble for authenticity','Low-pass filter at 10kHz for that muffled feel','Add subtle reverb room to drums'],
    'cinematic':  ['Layer strings with brass for impact','Use swell automation on the pads','Reverb tail of 3–4 seconds on the room'],
    'pop':        ['Keep the mix bright — hi-shelf boost at 10kHz','Glue the mix with a light bus compressor','Parallel compress the drums for punch'],
    'electronic': ['Side-chain everything to the kick','Use LFO automation on the filter cutoff','Stereo width on the lead synth'],
    'r&b':        ['Warm the mix with slight tape saturation','Smooth transients on the drums','Lush reverb on backing vocals'],
  };

  const s = style.toLowerCase();
  return {
    arrangement: arrangements[s] ?? arrangements['pop'],
    chordProgression: (progressions[s] ?? progressions['pop']) + ` in ${key} at ${bpm} BPM`,
    suggestedTracks: trackSets[s] ?? trackSets['pop'],
    productionTips: tips[s] ?? tips['pop'],
  };
}
