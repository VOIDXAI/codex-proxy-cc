export const DEFAULT_CONFIG = {
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
  profiles: {
    haiku: {
      model: "gpt-5-mini",
      codexModel: "gpt-5.4-mini",
      effort: "low",
    },
    sonnet: {
      model: "gpt-5.4",
      codexModel: "gpt-5.4",
      effort: "medium",
    },
    opus: {
      model: "gpt-5.4-pro",
      codexModel: "gpt-5.4",
      effort: "xhigh",
    },
  },
  anthropic: {
    defaultProfile: "sonnet",
    modelMap: {
      "claude-haiku-*": "haiku",
      "claude-sonnet-*": "sonnet",
      "claude-opus-*": "opus",
    },
    effortMap: {
      low: "low",
      medium: "medium",
      high: "high",
      max: "xhigh",
    },
  },
  privacy: {
    disableNonEssentialTraffic: false,
    disableTelemetry: false,
    disableErrorReporting: false,
    disableFeedbackCommand: false,
  },
};
