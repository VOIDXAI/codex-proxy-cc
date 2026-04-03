export const DEFAULT_CONFIG = {
  backend: {
    type: "auto",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  codex: {
    binary: "codex",
    sandbox: "workspace-write",
  },
  server: {
    bind: "127.0.0.1",
    port: 0,
  },
  claude: {
    binary: "claude",
    effortLevel: "inherit",
  },
  logging: {
    level: "info",
  },
  compatibility: {
    mode: "balanced",
  },
  profiles: {
    fast: {
      model: "gpt-5-mini",
      codexModel: "gpt-5.4-mini",
      effort: "low",
    },
    balanced: {
      model: "gpt-5.4",
      codexModel: "gpt-5.4",
      effort: "medium",
    },
    deep: {
      model: "gpt-5.4-pro",
      codexModel: "gpt-5.4",
      effort: "high",
    },
  },
  anthropic: {
    defaultProfile: "balanced",
    modelMap: {
      "claude-haiku-*": "fast",
      "claude-sonnet-*": "balanced",
      "claude-opus-*": "deep",
    },
    effortMap: {
      low: "low",
      medium: "medium",
      high: "high",
      max: "xhigh",
    },
  },
  privacy: {
    disableNonEssentialTraffic: true,
    disableTelemetry: true,
    disableErrorReporting: true,
    disableFeedbackCommand: true,
  },
};
