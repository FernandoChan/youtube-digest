const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("TokenRouter defaults use deepseek-v4.1-flash and allow supported models", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "  example-key  ",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "gemini-3.5-flash",
    supadataApiKey: "  example-supadata  ",
  });

  assert.equal(normalized.provider, "tokenrouter");
  assert.equal(normalized.aiBaseUrl, "https://tokenrouter.cheap/v1");
  assert.equal(normalized.aiModel, "gemini-3.5-flash");
  assert.equal(normalized.reasoningEffort, "low");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
  assert.equal(
    settings.chatCompletionsUrl(normalized.aiBaseUrl),
    "https://tokenrouter.cheap/v1/chat/completions",
  );

  for (const effort of ["low", "medium", "high", "off"]) {
    assert.equal(
      settings.normalize({ reasoningEffort: effort }).reasoningEffort,
      effort,
    );
  }
  assert.equal(
    settings.normalize({ reasoningEffort: "invalid" }).reasoningEffort,
    "low",
  );

  const fallbackModel = settings.normalize({
    aiModel: "deepseek-v4-flash",
  });
  assert.equal(fallbackModel.aiModel, "deepseek-v4.1-flash");
});

test("legacy custom and deepseek migration clears only the AI key and is idempotent", () => {
  for (const legacyProvider of ["custom", "deepseek"]) {
    const legacy = {
      provider: legacyProvider,
      aiApiKey: "legacy-secret",
      aiBaseUrl: "https://api.example.com/v1",
      aiModel: "deepseek-v4-flash",
      supadataApiKey: " supadata-secret ",
    };
    const first = settings.migrateLegacyCustom(legacy);

    assert.equal(first.migrated, true);
    assert.equal(first.settings.provider, "tokenrouter");
    assert.equal(first.settings.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
    assert.equal(first.settings.aiModel, settings.DEFAULTS.aiModel);
    assert.equal(first.settings.aiApiKey, "");
    assert.equal(first.settings.supadataApiKey, "supadata-secret");

    const second = settings.migrateLegacyCustom(first.settings);
    assert.equal(second.migrated, false);
    assert.deepEqual(second.settings, first.settings);
  }

  const configuredTokenRouter = settings.normalize({
    aiModel: "gpt-5.5",
    aiApiKey: "new-tokenrouter-key",
  });
  assert.equal(configuredTokenRouter.aiApiKey, "new-tokenrouter-key");
  assert.equal(configuredTokenRouter.aiModel, "gpt-5.5");
});

test("Google Gemini provider normalizes models, URLs, and preserves per-provider keys", () => {
  const google = settings.normalize({
    provider: "google",
    aiApiKey: "  example-google-key  ",
    tokenrouterApiKey: "  example-tr-key  ",
    aiModel: "gemini-4-carbon",
    reasoningEffort: "high",
    supadataApiKey: "example-supadata",
  });

  assert.equal(google.provider, "google");
  assert.equal(
    google.aiBaseUrl,
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assert.equal(google.aiModel, "gemini-4-carbon");
  assert.equal(google.aiApiKey, "example-google-key");
  assert.equal(google.googleApiKey, "example-google-key");
  assert.equal(google.tokenrouterApiKey, "example-tr-key");
  assert.equal(
    settings.geminiGenerateUrl("gemini-4-neon"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent",
  );
  assert.equal(
    settings.geminiGenerateUrl("gemini-4-neon", { stream: true }),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
  );

  // Non-Gemini model falls back to Google default model
  const fallback = settings.normalize({
    provider: "google",
    aiModel: "deepseek-v4.1-flash",
  });
  assert.equal(fallback.aiModel, "gemini-4-neon");
});

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
});
