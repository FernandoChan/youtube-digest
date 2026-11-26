/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";

  const TOKENROUTER_MODELS = Object.freeze([
    Object.freeze({ id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" }),
    Object.freeze({ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }),
    Object.freeze({ id: "gpt-5.5", label: "GPT-5.5" }),
    Object.freeze({ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }),
    Object.freeze({ id: "gemini-4-argon", label: "Gemini 4 Argon" }),
  ]);

  const GOOGLE_MODELS = Object.freeze([
    Object.freeze({ id: "gemini-4-neon", label: "Gemini 4 Neon" }),
    Object.freeze({ id: "gemini-4-carbon", label: "Gemini 4 Carbon" }),
    Object.freeze({ id: "gemini-4-argon", label: "Gemini 4 Argon" }),
    Object.freeze({ id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" }),
    Object.freeze({ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }),
    Object.freeze({ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }),
  ]);

  const PROVIDERS = Object.freeze({
    tokenrouter: Object.freeze({
      id: "tokenrouter",
      label: "TokenRouter",
      baseUrl: "https://tokenrouter.cheap/v1",
      defaultModel: "deepseek-v4.1-flash",
      models: TOKENROUTER_MODELS,
    }),
    google: Object.freeze({
      id: "google",
      label: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-4-neon",
      models: GOOGLE_MODELS,
    }),
  });

  const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));
  const SUPPORTED_MODELS = TOKENROUTER_MODELS;
  const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "off"]);

  const DEFAULTS = Object.freeze({
    provider: "tokenrouter",
    aiApiKey: "",
    tokenrouterApiKey: "",
    googleApiKey: "",
    aiBaseUrl: PROVIDERS.tokenrouter.baseUrl,
    aiModel: PROVIDERS.tokenrouter.defaultModel,
    reasoningEffort: "low",
    supadataApiKey: "",
  });

  function isLegacyCustom(input) {
    return (
      !!input &&
      (input.provider === "custom" || input.provider === "deepseek")
    );
  }

  function normalizeProvider(provider) {
    if (typeof provider === "string") {
      const normalized = provider.trim().toLowerCase();
      if (SUPPORTED_PROVIDERS.includes(normalized)) {
        return normalized;
      }
    }
    return DEFAULTS.provider;
  }

  function getProviderConfig(provider) {
    return PROVIDERS[normalizeProvider(provider)];
  }

  function getModelsForProvider(provider) {
    return getProviderConfig(provider).models;
  }

  function normalizeModel(
    model,
    isMigratingLegacy = false,
    provider = DEFAULTS.provider,
  ) {
    const providerConfig = getProviderConfig(provider);
    if (isMigratingLegacy || typeof model !== "string") {
      return providerConfig.defaultModel;
    }
    const trimmed = model.trim();
    const retiredModel = ["deepseek", "chat"].join("-");
    if (
      !trimmed ||
      trimmed === "deepseek-v4-flash" ||
      trimmed === retiredModel ||
      !/^[A-Za-z0-9._:/-]{2,100}$/.test(trimmed)
    ) {
      return providerConfig.defaultModel;
    }
    if (
      providerConfig.id === "google" &&
      !trimmed.toLowerCase().startsWith("gemini-")
    ) {
      return providerConfig.defaultModel;
    }
    return trimmed;
  }

  function normalizeReasoningEffort(effort) {
    if (typeof effort === "string") {
      const normalized = effort.trim().toLowerCase();
      if (REASONING_EFFORTS.includes(normalized)) {
        return normalized;
      }
    }
    return DEFAULTS.reasoningEffort;
  }

  function normalize(input = {}) {
    const legacy = isLegacyCustom(input);
    const provider = legacy ? DEFAULTS.provider : normalizeProvider(input.provider);
    const providerConfig = getProviderConfig(provider);

    const rawAiKey =
      !legacy && typeof input.aiApiKey === "string" ? input.aiApiKey.trim() : "";
    const rawTokenRouterKey =
      !legacy && typeof input.tokenrouterApiKey === "string"
        ? input.tokenrouterApiKey.trim()
        : "";
    const rawGoogleKey =
      !legacy && typeof input.googleApiKey === "string"
        ? input.googleApiKey.trim()
        : "";

    let tokenrouterApiKey = rawTokenRouterKey;
    let googleApiKey = rawGoogleKey;

    if (provider === "google") {
      if (!googleApiKey && rawAiKey) googleApiKey = rawAiKey;
    } else {
      if (!tokenrouterApiKey && rawAiKey) tokenrouterApiKey = rawAiKey;
    }

    const activeApiKey =
      provider === "google" ? googleApiKey : tokenrouterApiKey;

    return {
      provider,
      aiApiKey: activeApiKey,
      tokenrouterApiKey,
      googleApiKey,
      aiBaseUrl: providerConfig.baseUrl,
      aiModel: normalizeModel(input.aiModel, legacy, provider),
      reasoningEffort: normalizeReasoningEffort(input.reasoningEffort),
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl(baseUrl = DEFAULTS.aiBaseUrl) {
    const normalized = String(baseUrl || DEFAULTS.aiBaseUrl).replace(
      /\/+$/,
      "",
    );
    return `${normalized}/chat/completions`;
  }

  function geminiGenerateUrl(
    model = PROVIDERS.google.defaultModel,
    { stream = false, baseUrl = PROVIDERS.google.baseUrl } = {},
  ) {
    const normalizedBase = String(baseUrl || PROVIDERS.google.baseUrl).replace(
      /\/+$/,
      "",
    );
    const safeModel = encodeURIComponent(
      String(model || PROVIDERS.google.defaultModel).trim(),
    );
    return stream
      ? `${normalizedBase}/models/${safeModel}:streamGenerateContent?alt=sse`
      : `${normalizedBase}/models/${safeModel}:generateContent`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  return {
    STORAGE_KEY,
    PROVIDERS,
    SUPPORTED_PROVIDERS,
    SUPPORTED_MODELS,
    TOKENROUTER_MODELS,
    GOOGLE_MODELS,
    REASONING_EFFORTS,
    DEFAULTS,
    isLegacyCustom,
    normalizeProvider,
    getProviderConfig,
    getModelsForProvider,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    geminiGenerateUrl,
    canonicalYouTubeUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
