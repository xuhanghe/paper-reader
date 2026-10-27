// Starting points for the custom endpoint dialog: where a well-known service
// answers, and which wire format it speaks. They only fill the form — the
// URL stays editable, and "Load models" asks the service itself what it has.
//
// Client-safe.

export type EndpointPreset = {
  id: string;
  name: string;
  format: "openai" | "anthropic";
  baseUrl: string;
  // Runs on this computer, usually without a key
  local?: boolean;
  // Where to make a key, shown beside the field
  keyUrl?: string;
};

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  { id: "openai", name: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openrouter", name: "OpenRouter", format: "openai", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys" },
  { id: "gemini", name: "Google Gemini", format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "deepseek", name: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "groq", name: "Groq", format: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", name: "Mistral", format: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "xai", name: "xAI", format: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "ollama", name: "Ollama", format: "openai", baseUrl: "http://localhost:11434/v1", local: true },
  { id: "lmstudio", name: "LM Studio", format: "openai", baseUrl: "http://localhost:1234/v1", local: true },
  { id: "other", name: "Other", format: "openai", baseUrl: "" },
];

export const presetById = (id: string | undefined) => ENDPOINT_PRESETS.find((p) => p.id === id);
