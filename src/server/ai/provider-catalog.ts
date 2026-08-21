export interface ProviderPreset {
  id: string;
  name: string;
  description: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  allowPrivateNetworkDefault: boolean;
  defaultModels: Array<{
    modelId: string;
    displayName: string;
    resourceClass?: "small" | "medium" | "large";
  }>;
  suggestedHeaders?: Record<string, string>;
  documentationUrl?: string;
}

export const AI_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "ollama",
    name: "Ollama (Local / Remote)",
    description:
      "Self-hosted or local Ollama server running open models (Qwen, Llama, Gemma, Mistral).",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    requiresApiKey: false,
    allowPrivateNetworkDefault: true,
    defaultModels: [
      { modelId: "qwen2.5:7b", displayName: "Qwen 2.5 7B", resourceClass: "medium" },
      { modelId: "qwen2.5:3b", displayName: "Qwen 2.5 3B", resourceClass: "small" },
      { modelId: "granite3.3:2b", displayName: "Granite 3.3 2B", resourceClass: "small" },
      { modelId: "llama3.2:3b", displayName: "Llama 3.2 3B", resourceClass: "small" },
      { modelId: "gemma2:9b", displayName: "Gemma 2 9B", resourceClass: "medium" },
    ],
    documentationUrl: "https://ollama.com",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI platform models including GPT-4o, GPT-4o mini, and reasoning models.",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    allowPrivateNetworkDefault: false,
    defaultModels: [
      { modelId: "gpt-4o", displayName: "GPT-4o", resourceClass: "large" },
      { modelId: "gpt-4o-mini", displayName: "GPT-4o mini", resourceClass: "small" },
      { modelId: "o3-mini", displayName: "o3-mini", resourceClass: "medium" },
    ],
    documentationUrl: "https://platform.openai.com",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    description: "Anthropic Claude models via LiteLLM proxy or OpenAI-compatible endpoint.",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    requiresApiKey: true,
    allowPrivateNetworkDefault: false,
    defaultModels: [
      {
        modelId: "claude-3-5-sonnet-latest",
        displayName: "Claude 3.5 Sonnet",
        resourceClass: "large",
      },
      {
        modelId: "claude-3-5-haiku-latest",
        displayName: "Claude 3.5 Haiku",
        resourceClass: "small",
      },
      { modelId: "claude-3-opus-latest", displayName: "Claude 3 Opus", resourceClass: "large" },
    ],
    documentationUrl: "https://docs.anthropic.com",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    description: "Google Gemini models via Gemini OpenAI-compatible endpoint or LiteLLM.",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    requiresApiKey: true,
    allowPrivateNetworkDefault: false,
    defaultModels: [
      { modelId: "gemini-1.5-pro", displayName: "Gemini 1.5 Pro", resourceClass: "large" },
      { modelId: "gemini-1.5-flash", displayName: "Gemini 1.5 Flash", resourceClass: "small" },
      { modelId: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash", resourceClass: "small" },
    ],
    documentationUrl: "https://ai.google.dev",
  },
  {
    id: "litellm",
    name: "LiteLLM Proxy",
    description: "Self-hosted LiteLLM universal proxy gateway (routes to 100+ providers).",
    defaultBaseUrl: "http://127.0.0.1:4000/v1",
    requiresApiKey: false,
    allowPrivateNetworkDefault: true,
    defaultModels: [
      {
        modelId: "ollama/qwen2.5:7b",
        displayName: "Ollama Qwen 2.5 7B (via LiteLLM)",
        resourceClass: "medium",
      },
      {
        modelId: "claude-3-5-sonnet-latest",
        displayName: "Claude 3.5 Sonnet (via LiteLLM)",
        resourceClass: "large",
      },
      {
        modelId: "gemini/gemini-1.5-pro",
        displayName: "Gemini 1.5 Pro (via LiteLLM)",
        resourceClass: "large",
      },
      { modelId: "gpt-4o", displayName: "GPT-4o (via LiteLLM)", resourceClass: "large" },
    ],
    documentationUrl: "https://docs.litellm.ai",
  },
  {
    id: "groq",
    name: "Groq",
    description: "Ultra-fast inference for open models (Llama, Mixtral) running on Groq LPUs.",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    requiresApiKey: true,
    allowPrivateNetworkDefault: false,
    defaultModels: [
      {
        modelId: "llama-3.3-70b-versatile",
        displayName: "Llama 3.3 70B Versatile",
        resourceClass: "large",
      },
      { modelId: "mixtral-8x7b-32768", displayName: "Mixtral 8x7B", resourceClass: "medium" },
    ],
    documentationUrl: "https://groq.com",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek models including DeepSeek-V3 and DeepSeek-R1 reasoning models.",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    requiresApiKey: true,
    allowPrivateNetworkDefault: false,
    defaultModels: [
      { modelId: "deepseek-chat", displayName: "DeepSeek Chat (V3)", resourceClass: "medium" },
      {
        modelId: "deepseek-reasoner",
        displayName: "DeepSeek Reasoner (R1)",
        resourceClass: "large",
      },
    ],
    documentationUrl: "https://deepseek.com",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    description: "Mistral AI platform models (Mistral Large, Codestral, Pixtral).",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    requiresApiKey: true,
    allowPrivateNetworkDefault: false,
    defaultModels: [
      { modelId: "mistral-large-latest", displayName: "Mistral Large", resourceClass: "large" },
      { modelId: "codestral-latest", displayName: "Codestral", resourceClass: "medium" },
    ],
    documentationUrl: "https://mistral.ai",
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    description:
      "Any custom OpenAI-compatible API endpoint, local server (vLLM, LocalAI, LM Studio), or reverse proxy.",
    defaultBaseUrl: "",
    requiresApiKey: false,
    allowPrivateNetworkDefault: false,
    defaultModels: [],
  },
];

export function findProviderPreset(presetId: string): ProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id.toLowerCase() === presetId.toLowerCase());
}
