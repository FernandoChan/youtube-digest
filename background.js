/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling DeepSeek to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

function extractUsageStats(rawUsage, model) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const promptTokens = Number(rawUsage.prompt_tokens) || 0;
  const cachedTokens =
    Number(
      rawUsage.prompt_tokens_details?.cached_tokens ??
        rawUsage.prompt_cache_hit_tokens ??
        0,
    ) || 0;
  const completionTokens = Number(rawUsage.completion_tokens) || 0;
  const reasoningTokens =
    Number(rawUsage.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    reasoningTokens,
    model: typeof model === "string" ? model : "",
  };
}

function extractGeminiUsageStats(usageMetadata, model) {
  if (!usageMetadata || typeof usageMetadata !== "object") return null;
  const promptTokens = Number(usageMetadata.promptTokenCount) || 0;
  const cachedTokens = Number(usageMetadata.cachedContentTokenCount) || 0;
  const completionTokens = Number(usageMetadata.candidatesTokenCount) || 0;
  const reasoningTokens = Number(usageMetadata.thoughtsTokenCount) || 0;
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    reasoningTokens,
    model: typeof model === "string" ? model : "",
  };
}

function getProviderDisplayName(provider) {
  if (provider === "google") return "Google Gemini";
  if (provider === "deepseek") return "DeepSeek";
  return "TokenRouter";
}

function buildGeminiRequestBody({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  reasoningEffort,
  model,
  omitThinkingConfig = false,
}) {
  const systemParts = [];
  const contents = [];
  for (const msg of messages || []) {
    const text = typeof msg?.content === "string" ? msg.content : "";
    if (!text) continue;
    if (msg.role === "system") {
      systemParts.push({ text });
    } else {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text }],
      });
    }
  }

  const generationConfig = {};
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    generationConfig.maxOutputTokens = Math.floor(Number(maxTokens));
  }
  if (responseFormat?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }

  const normalizedModel = String(model || "").toLowerCase();
  const isGemini4 = normalizedModel.startsWith("gemini-4");
  const isGemini3OrHigher =
    isGemini4 || normalizedModel.startsWith("gemini-3");

  if (!omitThinkingConfig) {
    if (
      reasoningEffort === "low" ||
      reasoningEffort === "medium" ||
      reasoningEffort === "high"
    ) {
      if (isGemini3OrHigher) {
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingLevel: reasoningEffort.toUpperCase(),
        };
      } else {
        const budgetMap = { low: 1024, medium: 4096, high: 8192 };
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: budgetMap[reasoningEffort],
        };
      }
    } else if (reasoningEffort === "off") {
      if (isGemini4) {
        generationConfig.thinkingConfig = {
          includeThoughts: false,
          thinkingLevel: "LOW",
        };
      } else {
        generationConfig.thinkingConfig = {
          thinkingBudget: 0,
        };
      }
    }
  }

  // Gemini 4 reasoning models prefer default temperature when thinking is active.
  if (
    typeof temperature === "number" &&
    (!isGemini4 || reasoningEffort === "off" || omitThinkingConfig)
  ) {
    generationConfig.temperature = temperature;
  }

  const body = {
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }],
    generationConfig,
  };
  if (systemParts.length) {
    body.systemInstruction = { parts: systemParts };
  }
  return body;
}

function extractGeminiCandidateParts(
  payload,
  { onReasoningChunk, onContentChunk } = {},
) {
  let reasoning = "";
  let content = "";
  const candidates = Array.isArray(payload?.candidates)
    ? payload.candidates
    : [];
  const parts = Array.isArray(candidates[0]?.content?.parts)
    ? candidates[0].content.parts
    : [];
  for (const part of parts) {
    if (typeof part?.text !== "string" || !part.text) continue;
    if (part.thought === true) {
      reasoning += part.text;
      if (typeof onReasoningChunk === "function") {
        onReasoningChunk(part.text);
      }
    } else {
      content += part.text;
      if (typeof onContentChunk === "function") {
        onContentChunk(part.text);
      }
    }
  }
  return {
    reasoning,
    content,
    usageMetadata: payload?.usageMetadata || null,
  };
}

async function readBoundedStreamingGeminiResponse(
  response,
  onActivity,
  { onReasoningChunk, onContentChunk } = {},
) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let responseBytes = 0;
  let detectedMode = "";
  let rawJsonText = "";
  let lineBuffer = "";
  let reasoningText = "";
  let contentText = "";
  let usageMetadata = null;

  const processSseLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") return;

    let parsed;
    try {
      parsed = JSON.parse(payloadText);
    } catch (_error) {
      return;
    }
    const extracted = extractGeminiCandidateParts(parsed, {
      onReasoningChunk,
      onContentChunk,
    });
    reasoningText += extracted.reasoning;
    contentText += extracted.content;
    if (extracted.usageMetadata) {
      usageMetadata = extracted.usageMetadata;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    const byteLength = value?.byteLength ?? 0;
    responseBytes += byteLength;
    if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      await reader.cancel?.().catch(() => {});
      const error = new Error(
        "Google Gemini response exceeded the 2 MiB limit.",
      );
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    const chunkText = decoder.decode(value, { stream: true });
    if (!detectedMode) {
      rawJsonText += chunkText;
      const trimmed = rawJsonText.trimStart();
      if (!trimmed) continue;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        detectedMode = "json";
        continue;
      }
      detectedMode = "sse";
      lineBuffer = rawJsonText;
      rawJsonText = "";
    } else if (detectedMode === "json") {
      rawJsonText += chunkText;
      continue;
    } else {
      lineBuffer += chunkText;
    }

    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      processSseLine(line);
    }
  }

  const finalTail = decoder.decode();
  if (
    !detectedMode &&
    (rawJsonText.trimStart().startsWith("{") ||
      rawJsonText.trimStart().startsWith("["))
  ) {
    detectedMode = "json";
  }

  if (detectedMode === "json") {
    rawJsonText += finalTail;
    const parsed = JSON.parse(rawJsonText.trimStart());
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const extracted = extractGeminiCandidateParts(item, {
        onReasoningChunk,
        onContentChunk,
      });
      reasoningText += extracted.reasoning;
      contentText += extracted.content;
      if (extracted.usageMetadata) {
        usageMetadata = extracted.usageMetadata;
      }
    }
    return { text: contentText, reasoning: reasoningText, usageMetadata };
  }

  lineBuffer += finalTail;
  if (lineBuffer.trim()) {
    processSseLine(lineBuffer);
  }
  return { text: contentText, reasoning: reasoningText, usageMetadata };
}

async function requestGoogleGeminiCompletion({
  settings,
  messages,
  maxTokens,
  temperature,
  responseFormat,
  reasoningEffort,
  stream = false,
  onReasoningChunk,
  onContentChunk,
}) {
  const effectiveEffort =
    reasoningEffort ?? settings.reasoningEffort ?? "low";
  const url = YTD_SETTINGS.geminiGenerateUrl(settings.aiModel, {
    stream,
    baseUrl: settings.aiBaseUrl,
  });

  const executeAttempt = async (omitThinkingConfig) => {
    const body = buildGeminiRequestBody({
      messages,
      maxTokens,
      temperature,
      responseFormat,
      reasoningEffort: effectiveEffort,
      model: settings.aiModel,
      omitThinkingConfig,
    });

    const controller = new AbortController();
    let timeoutKind = "";
    let idleTimeoutId;
    let hardTimeoutId;
    const abortForTimeout = (kind) => {
      if (controller.signal.aborted) return;
      timeoutKind = kind;
      controller.abort();
    };
    const resetIdleTimeout = () => {
      clearTimeout(idleTimeoutId);
      idleTimeoutId = setTimeout(
        () => abortForTimeout("idle"),
        AI_PROVIDER_IDLE_TIMEOUT_MS,
      );
    };

    hardTimeoutId = setTimeout(
      () => abortForTimeout("hard"),
      AI_PROVIDER_HARD_TIMEOUT_MS,
    );
    resetIdleTimeout();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": settings.aiApiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      resetIdleTimeout();

      if (!response.ok) {
        const data = await readBoundedAiResponse(
          response,
          resetIdleTimeout,
        ).catch(() => ({}));
        const errorData = data && typeof data === "object" ? data : {};
        const message =
          errorData.error?.message ||
          errorData.message ||
          `Google Gemini error: ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }

      let text = "";
      let reasoning = "";
      let usageMetadata = null;

      if (stream && response.body?.getReader) {
        const streamed = await readBoundedStreamingGeminiResponse(
          response,
          resetIdleTimeout,
          { onReasoningChunk, onContentChunk },
        );
        text = streamed.text;
        reasoning = streamed.reasoning;
        usageMetadata = streamed.usageMetadata;
      } else {
        const data = await readBoundedAiResponse(response, resetIdleTimeout);
        const extracted = extractGeminiCandidateParts(data, {
          onReasoningChunk,
          onContentChunk,
        });
        text = extracted.content;
        reasoning = extracted.reasoning;
        usageMetadata = extracted.usageMetadata;
      }

      if (typeof text !== "string" || !text.trim()) {
        const error = new Error("Google Gemini returned an empty response.");
        error.code = "EMPTY_AI_RESPONSE";
        throw error;
      }

      const usage = extractGeminiUsageStats(usageMetadata, settings.aiModel);
      return { text, reasoning, usage, settings };
    } catch (error) {
      if (timeoutKind === "idle") {
        const timeoutError = new Error(
          "Google Gemini request was inactive for 50 seconds. Please Retry.",
        );
        timeoutError.code = "AI_IDLE_TIMEOUT";
        throw timeoutError;
      }
      if (timeoutKind === "hard") {
        const timeoutError = new Error(
          "Google Gemini request exceeded the 120-second limit. Please Retry.",
        );
        timeoutError.code = "AI_HARD_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(idleTimeoutId);
      clearTimeout(hardTimeoutId);
    }
  };

  try {
    return await executeAttempt(false);
  } catch (error) {
    if (
      error.status === 400 &&
      /thinking|temperature/i.test(String(error.message || ""))
    ) {
      return await executeAttempt(true);
    }
    throw error;
  }
}

function createThinkTagSplitter(onReasoningChunk, onContentChunk) {
  let inThink = false;
  let pending = "";

  const emitReasoning = (chunk) => {
    if (chunk && typeof onReasoningChunk === "function") {
      onReasoningChunk(chunk);
    }
  };
  const emitContent = (chunk) => {
    if (chunk && typeof onContentChunk === "function") {
      onContentChunk(chunk);
    }
  };

  return {
    push(chunk) {
      if (!chunk) return { reasoning: "", content: "" };
      pending += chunk;
      let reasoning = "";
      let content = "";

      while (pending.length) {
        if (!inThink) {
          const openIdx = pending.indexOf("<think>");
          if (openIdx === -1) {
            const partialStart = pending.lastIndexOf("<");
            if (
              partialStart !== -1 &&
              "<think>".startsWith(pending.slice(partialStart))
            ) {
              const safe = pending.slice(0, partialStart);
              pending = pending.slice(partialStart);
              content += safe;
              emitContent(safe);
              break;
            }
            content += pending;
            emitContent(pending);
            pending = "";
            break;
          }
          const before = pending.slice(0, openIdx);
          if (before) {
            content += before;
            emitContent(before);
          }
          pending = pending.slice(openIdx + 7);
          inThink = true;
        } else {
          const closeIdx = pending.indexOf("</think>");
          if (closeIdx === -1) {
            const partialStart = pending.lastIndexOf("<");
            if (
              partialStart !== -1 &&
              "</think>".startsWith(pending.slice(partialStart))
            ) {
              const safe = pending.slice(0, partialStart);
              pending = pending.slice(partialStart);
              reasoning += safe;
              emitReasoning(safe);
              break;
            }
            reasoning += pending;
            emitReasoning(pending);
            pending = "";
            break;
          }
          const inside = pending.slice(0, closeIdx);
          if (inside) {
            reasoning += inside;
            emitReasoning(inside);
          }
          pending = pending.slice(closeIdx + 8);
          inThink = false;
        }
      }
      return { reasoning, content };
    },
    flush() {
      if (!pending) return { reasoning: "", content: "" };
      const tail = pending;
      pending = "";
      if (inThink) {
        emitReasoning(tail);
        return { reasoning: tail, content: "" };
      }
      emitContent(tail);
      return { reasoning: "", content: tail };
    },
  };
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
  reasoningEffort,
  stream = false,
  onReasoningChunk,
  onContentChunk,
}) {
  const settings = await getSettings();
  const providerName = getProviderDisplayName(settings.provider);
  if (!settings.aiApiKey) {
    const error = new Error(
      `${providerName} API key not configured. Open YouTube Digest Settings.`,
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  if (settings.provider === "google") {
    return requestGoogleGeminiCompletion({
      settings,
      messages,
      maxTokens,
      temperature,
      responseFormat,
      reasoningEffort,
      stream,
      onReasoningChunk,
      onContentChunk,
    });
  }
  const effectiveEffort =
    reasoningEffort ?? settings.reasoningEffort ?? "low";
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // Keep DeepSeek-only request fields isolated from TokenRouter multi-model requests.
  if (settings.provider === "deepseek") {
    body.thinking = { type: "disabled" };
  } else if (settings.provider === "tokenrouter") {
    if (
      effectiveEffort === "low" ||
      effectiveEffort === "medium" ||
      effectiveEffort === "high"
    ) {
      body.reasoning_effort = effectiveEffort;
    } else if (
      effectiveEffort === "off" &&
      String(settings.aiModel || "").startsWith("deepseek")
    ) {
      body.thinking = { type: "disabled" };
    }
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings.aiBaseUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves the AI provider is still making progress.
    resetIdleTimeout();

    if (!response.ok) {
      const data = await readBoundedAiResponse(response, resetIdleTimeout).catch(
        () => ({}),
      );
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `TokenRouter error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    let text = "";
    let reasoning = "";
    let rawUsage = null;

    if (stream && response.body?.getReader) {
      const streamed = await readBoundedStreamingAiResponse(
        response,
        resetIdleTimeout,
        { onReasoningChunk, onContentChunk },
      );
      text = streamed.text;
      reasoning = streamed.reasoning;
      rawUsage = streamed.usage;
    } else {
      const data = await readBoundedAiResponse(response, resetIdleTimeout);
      const message = data.choices?.[0]?.message || {};
      const rawContent =
        typeof message.content === "string" ? message.content : "";
      const explicitReasoning =
        typeof message.reasoning_content === "string"
          ? message.reasoning_content
          : typeof message.reasoning === "string"
            ? message.reasoning
            : "";
      if (explicitReasoning) {
        reasoning = explicitReasoning;
        if (typeof onReasoningChunk === "function") {
          onReasoningChunk(explicitReasoning);
        }
        text = rawContent;
        if (text && typeof onContentChunk === "function") {
          onContentChunk(text);
        }
      } else {
        const splitter = createThinkTagSplitter(
          onReasoningChunk,
          onContentChunk,
        );
        const firstPass = splitter.push(rawContent);
        const tailPass = splitter.flush();
        reasoning = `${firstPass.reasoning}${tailPass.reasoning}`;
        text = `${firstPass.content}${tailPass.content}`;
      }
      rawUsage = data.usage || null;
    }

    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("TokenRouter returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    const usage = extractUsageStats(rawUsage, settings.aiModel);
    return { text, reasoning, usage, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "TokenRouter request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "TokenRouter request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

async function readBoundedStreamingAiResponse(
  response,
  onActivity,
  { onReasoningChunk, onContentChunk } = {},
) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let responseBytes = 0;
  let detectedMode = "";
  let rawJsonText = "";
  let lineBuffer = "";
  let reasoningText = "";
  let contentText = "";
  let rawUsage = null;
  const splitter = createThinkTagSplitter(onReasoningChunk, onContentChunk);

  const processSseLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (_error) {
      return;
    }
    if (parsed.usage) {
      rawUsage = parsed.usage;
    }
    const choice = parsed.choices?.[0];
    const delta = choice?.delta || choice?.message || {};
    const reasoningPart =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (reasoningPart) {
      reasoningText += reasoningPart;
      if (typeof onReasoningChunk === "function") {
        onReasoningChunk(reasoningPart);
      }
    }
    const contentPart = typeof delta.content === "string" ? delta.content : "";
    if (contentPart) {
      const split = splitter.push(contentPart);
      reasoningText += split.reasoning;
      contentText += split.content;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    const byteLength = value?.byteLength ?? 0;
    responseBytes += byteLength;
    if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      await reader.cancel?.().catch(() => {});
      const error = new Error("TokenRouter response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    const chunkText = decoder.decode(value, { stream: true });
    if (!detectedMode) {
      rawJsonText += chunkText;
      const trimmed = rawJsonText.trimStart();
      if (!trimmed) continue;
      if (trimmed.startsWith("{")) {
        detectedMode = "json";
        continue;
      }
      detectedMode = "sse";
      lineBuffer = rawJsonText;
      rawJsonText = "";
    } else if (detectedMode === "json") {
      rawJsonText += chunkText;
      continue;
    } else {
      lineBuffer += chunkText;
    }

    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      processSseLine(line);
    }
  }

  const finalTail = decoder.decode();
  if (!detectedMode && rawJsonText.trimStart().startsWith("{")) {
    detectedMode = "json";
  }

  if (detectedMode === "json") {
    rawJsonText += finalTail;
    const data = JSON.parse(rawJsonText.trimStart());
    const message = data.choices?.[0]?.message || {};
    const rawContent =
      typeof message.content === "string" ? message.content : "";
    const explicitReasoning =
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : typeof message.reasoning === "string"
          ? message.reasoning
          : "";
    if (explicitReasoning) {
      reasoningText = explicitReasoning;
      if (typeof onReasoningChunk === "function") {
        onReasoningChunk(explicitReasoning);
      }
      contentText = rawContent;
      if (contentText && typeof onContentChunk === "function") {
        onContentChunk(contentText);
      }
    } else {
      const firstPass = splitter.push(rawContent);
      const tailPass = splitter.flush();
      reasoningText = `${firstPass.reasoning}${tailPass.reasoning}`;
      contentText = `${firstPass.content}${tailPass.content}`;
    }
    return {
      text: contentText,
      reasoning: reasoningText,
      usage: data.usage || null,
    };
  }

  lineBuffer += finalTail;
  if (lineBuffer.trim()) {
    processSseLine(lineBuffer);
  }
  const tailPass = splitter.flush();
  reasoningText += tailPass.reasoning;
  contentText += tailPass.content;

  return {
    text: contentText,
    reasoning: reasoningText,
    usage: rawUsage,
  };
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including keepalive blank lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("TokenRouter response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("TokenRouter response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  if (!(tab.url || "").startsWith("https://www.youtube.com")) {
    void updatePanelForTab(tab.id, tab.url, tab.windowId);
    return;
  }

  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to YouTube tabs only.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a YouTube-only tool, we
 * enable the panel on YouTube tabs and disable it everywhere else. Disabling
 * on a tab makes Chrome hide/close the panel for that tab, so it never lingers
 * on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-YouTube tab.
 */
async function closePanelForTab(tabId, windowId) {
  // Chrome 141 added an explicit close API. On older supported versions,
  // disabling the tab-specific panel below remains the compatibility path.
  if (typeof chrome.sidePanel.close !== "function") return;

  try {
    // This closes the tab-specific panel used by YouTube Digest.
    await chrome.sidePanel.close({ tabId });
    return;
  } catch (error) {
    // Chrome 145+ rejects tabId when the visible instance is global. Close
    // that instance by window instead.
  }

  if (Number.isInteger(windowId)) {
    await chrome.sidePanel.close({ windowId }).catch(() => {});
  }
}

async function updatePanelForTab(tabId, url, windowId) {
  const isYouTube = (url || "").startsWith("https://www.youtube.com");
  if (!isYouTube) {
    // Close the visible instance first. Then disable this tab so Chrome cannot
    // reopen the global default panel as navigation settles.
    await closePanelForTab(tabId, windowId);
    await chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    return;
  }

  // setOptions can reject if the tab just closed. Ignore that harmlessly.
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch(() => {});
}

/**
 * Gets the best URL from a tab update that can change panel availability.
 * Chrome can apply tab-specific side-panel state before a navigation commits,
 * then reset it during the commit. Handling loading and complete gives the
 * first non-YouTube navigation a reliable second reconciliation.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// A tab started or completed navigation. Reconcile at both stages because
// Chrome can replace per-tab side-panel options while the page commits.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return; // Ignore title and favicon-only updates.
  void updatePanelForTab(tabId, url, tab.windowId);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    void updatePanelForTab(tabId, tab.url || tab.pendingUrl, windowId);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    handleFetchTranscript(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
      { requestId: message.requestId, videoId: message.videoId },
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "analyzeChapters") {
    handleAnalyzeChapters(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
      { requestId: message.requestId, videoId: message.videoId },
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using DeepSeek.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp, or save exact selected transcript
    // text when the side panel supplies it.
    handleSaveNote(
      message.videoId,
      message.timestamp,
      message.videoTitle,
      message.channelName,
      message.selectedText,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to DeepSeek.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) =>
        sendResponse({
          hasSupadataKey: !!settings.supadataApiKey,
          hasAiKey: !!settings.aiApiKey,
          provider: settings.provider,
        }),
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Query specifically for YouTube tabs to avoid side panel context issues
        // Try multiple query strategies to find the right tab
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        // If no YouTube tab found, try broader query
        if (!tabs[0] || !tabs[0].url?.includes("youtube.com")) {
          tabs = await chrome.tabs.query({
            url: "https://www.youtube.com/*",
            active: true,
          });
          debugLog("[YouTube Digest BG] Active YouTube tabs:", tabs.length);
        }

        // Still nothing? Try any YouTube tab
        if (!tabs[0]) {
          tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
          debugLog("[YouTube Digest BG] Any YouTube tabs:", tabs.length);
        }

        if (tabs[0]) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            tabs[0].id,
            "URL:",
            tabs[0].url,
          );
          let response = await chrome.tabs.sendMessage(
            tabs[0].id,
            message.payload,
          );

          // For getVideoInfo, PREFER YouTube's own player data over the
          // DOM scrape. The player's videoDetails is canonical: its `author`
          // is always THIS video's channel and its `shortDescription` is the
          // full text. The DOM scrape is unreliable — e.g. on a playlist page
          // it grabbed the playlist owner's name ("Zara Zhang") instead of the
          // real channel ("Replit and Stripe"), and its description is
          // truncated while the box is collapsed. We fall back to the DOM
          // only for fields the player didn't provide.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(tabs[0].id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
          }

          debugLog("[YouTube Digest BG] Got response from content:", response);
          sendResponse({ success: true, response });
        } else {
          debugLog("[YouTube Digest BG] No YouTube tab found");
          sendResponse({ success: false, error: "No YouTube tab found" });
        }
      } catch (err) {
        console.error("[YouTube Digest BG] Relay error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's full details straight from YouTube's player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where YouTube's player object lives. Its
 * getPlayerResponse() carries videoDetails with the FULL description —
 * unlike the DOM, which truncates it until the user clicks "...more".
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const player = document.getElementById("movie_player");
          const details = player?.getPlayerResponse?.()?.videoDetails;
          if (!details) return null;
          return {
            title: details.title || "",
            channelName: details.author || "",
            description: details.shortDescription || "",
            duration: Number(details.lengthSeconds) || 0,
          };
        } catch (e) {
          return null;
        }
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YouTube Digest BG] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING VIA SUPADATA API
// ============================================================

/**
 * Fetches the transcript for a YouTube video using Supadata API.
 *
 * Supadata is a specialized service that reliably extracts transcripts
 * from YouTube videos. It handles all the complexity of parsing YouTube's
 * internal data structures, dealing with different caption formats, etc.
 *
 * API Docs: https://docs.supadata.ai
 *
 * @param {string} videoId - The YouTube video ID (e.g., "dQw4w9WgXcQ")
 * @returns {Object} - { success, transcript, transcriptText, language } or { success: false, error }
 */
async function handleFetchTranscript(videoId) {
  try {
    const settings = await getSettings();
    if (!settings.supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message: "Supadata API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Share only the canonical watch URL. This strips playlist, referral,
    // timestamp, and other browsing parameters from the active tab URL.
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    // Using the universal transcript endpoint with text=false to get timestamped chunks
    const apiUrl = new URL("https://api.supadata.ai/v1/transcript");
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false"); // Get timestamped chunks, not plain text
    apiUrl.searchParams.set("lang", "en"); // Prefer English
    // Caption-only product scope: never fall back to paid AI transcription.
    apiUrl.searchParams.set("mode", "native");

    // Make the API request
    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: {
        "x-api-key": settings.supadataApiKey,
      },
    });

    // Handle async jobs (for videos > 20 minutes, Supadata returns a job ID)
    if (response.status === 202) {
      const jobData = await response.json();
      // Poll for the result
      return await pollTranscriptJob(jobData.jobId, settings.supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message: "Your Supadata API key is invalid. Open YouTube Digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
        };
      }
      throw new Error(
        errorData.message || `Supadata API error: ${response.status}`,
      );
    }

    const data = await response.json();

    // Parse the response into our internal format
    // Supadata returns: { content: [{ text, offset, duration, lang }], lang, availableLangs }
    const transcript = [];
    let transcriptTextPlain = ""; // Plain text for display/export
    let transcriptTextTimestamped = ""; // Timestamped text for AI analysis

    if (data.content && Array.isArray(data.content)) {
      for (const chunk of data.content) {
        if (chunk.text) {
          // Clean up caption artifacts:
          // ">>" = speaker change marker from YouTube auto-captions
          const cleanText = chunk.text.replace(/>> ?/g, "").trim();
          if (!cleanText) continue; // Skip if nothing left after cleanup

          // offset is in milliseconds, convert to seconds
          const startSeconds = Math.floor((chunk.offset || 0) / 1000);
          const minutes = Math.floor(startSeconds / 60);
          const seconds = startSeconds % 60;
          const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

          transcript.push({
            text: cleanText,
            start: startSeconds,
            duration: Math.floor((chunk.duration || 0) / 1000),
            language: chunk.lang || data.lang || null,
          });

          // Plain text without timestamps (for display/export)
          transcriptTextPlain += cleanText + " ";

          // Timestamped text for DeepSeek (format: [MM:SS] text)
          // This allows the model to reference actual transcript positions.
          transcriptTextTimestamped += `[${timestamp}] ${cleanText}\n`;
        }
      }
    }

    if (transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      };
    }

    return {
      success: true,
      transcript: transcript,
      transcriptText: transcriptTextPlain.trim(), // For display
      transcriptTextTimestamped: transcriptTextTimestamped.trim(), // For AI
      language: typeof data.lang === "string" ? data.lang : null,
    };
  } catch (error) {
    console.error("Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

/**
 * Polls for transcript job completion (for long videos).
 * Supadata processes videos > 20 minutes asynchronously.
 *
 * @param {string} jobId - The job ID returned by the initial request
 * @returns {Object} - Same format as handleFetchTranscript
 */
async function pollTranscriptJob(jobId, supadataApiKey) {
  const maxAttempts = 60; // Max 60 seconds of polling
  const pollInterval = 1000; // Poll every 1 second

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(
      `https://api.supadata.ai/v1/transcript/${encodeURIComponent(jobId)}`,
      {
        headers: { "x-api-key": supadataApiKey },
      },
    );

    if (!response.ok) {
      throw new Error(`Job polling failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "completed") {
      // Parse the completed transcript
      const transcript = [];
      let transcriptTextPlain = "";
      let transcriptTextTimestamped = "";

      if (data.content && Array.isArray(data.content)) {
        for (const chunk of data.content) {
          if (chunk.text) {
            // Clean up caption artifacts (">>" = speaker change marker)
            const cleanText = chunk.text.replace(/>> ?/g, "").trim();
            if (!cleanText) continue;

            const startSeconds = Math.floor((chunk.offset || 0) / 1000);
            const minutes = Math.floor(startSeconds / 60);
            const seconds = startSeconds % 60;
            const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

            transcript.push({
              text: cleanText,
              start: startSeconds,
              duration: Math.floor((chunk.duration || 0) / 1000),
              language: chunk.lang || data.lang || null,
            });
            transcriptTextPlain += cleanText + " ";
            transcriptTextTimestamped += `[${timestamp}] ${chunk.text}\n`;
          }
        }
      }

      return {
        success: true,
        transcript: transcript,
        transcriptText: transcriptTextPlain.trim(),
        transcriptTextTimestamped: transcriptTextTimestamped.trim(),
        language: typeof data.lang === "string" ? data.lang : null,
      };
    }

    if (data.status === "failed") {
      throw new Error("Transcript processing failed");
    }

    // Status is 'queued' or 'active' — keep polling
  }

  throw new Error("Transcript processing timed out");
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function repairUnescapedJsonQuotes(text) {
  // Deterministic repair for an unescaped ASCII double quote inside a JSON
  // string value (e.g., "the "fast" path"). A quote inside a string is treated
  // as a string terminator only when the next non-whitespace character is a
  // valid JSON structural delimiter (:, ,, }, or ]).
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
        continue;
      }
      // Look ahead to the next non-whitespace character
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      const next = text[j] || "";
      if (
        next === ":" ||
        next === "," ||
        next === "}" ||
        next === "]" ||
        next === ""
      ) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (inString && (ch === "\n" || ch === "\r")) {
      out += ch === "\n" ? "\\n" : "";
      continue;
    }
    out += ch;
  }
  return out;
}

function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (_firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    const noTrailing = cleaned.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(noTrailing);
    } catch (_secondError) {
      // Second common LLM slip: unescaped ASCII double quotes or raw newlines
      // inside a string value (common in dense quoted transcripts).
      const repaired = repairUnescapedJsonQuotes(noTrailing);
      return JSON.parse(repaired);
    }
  }
}

// ============================================================
// DEEPSEEK ANALYSIS
// ============================================================

/**
 * Sends the transcript to DeepSeek for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
function computeTranscriptDurationContext(transcriptText, videoDuration) {
  let lastTranscriptSeconds = 0;
  const stampMatches = String(transcriptText || "").match(/\[(\d+):(\d{2})\]/g) || [];
  if (stampMatches.length) {
    const last =
      stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
    lastTranscriptSeconds = parseInt(last[1], 10) * 60 + parseInt(last[2], 10);
  }

  const effectiveSeconds = Math.max(
    Math.floor(videoDuration || 0),
    lastTranscriptSeconds,
  );
  const durationMinutes = Math.floor(effectiveSeconds / 60);
  const durationSeconds = Math.floor(effectiveSeconds % 60);
  const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
  const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.72);
  const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
    lateThresholdSeconds % 60,
  ).padStart(2, "0")}`;

  return {
    durationFormatted,
    maxTimestampSeconds: effectiveSeconds,
    lateThreshold,
  };
}

function mapAiProviderError(error, provider, fallbackMessage) {
  const providerName = getProviderDisplayName(provider);
  if (error.status === 401 || error.status === 403) {
    return {
      success: false,
      error: "INVALID_AI_KEY",
      message:
        provider === "google"
          ? "Google Gemini rejected the API key. Check your key and Google AI Studio billing/Ultra credit status."
          : `${providerName} rejected the API key.`,
    };
  }
  if (error.status === 402) {
    return {
      success: false,
      error: "INSUFFICIENT_BALANCE",
      message: `${providerName} account balance is insufficient (HTTP 402).`,
    };
  }
  if (error.status === 429) {
    return {
      success: false,
      error: "RATE_LIMITED",
      message: `${providerName} rate-limited this request. Try again shortly.`,
    };
  }
  return {
    success: false,
    error: error.message || fallbackMessage,
  };
}

async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
  meta = {},
) {
  let provider = "tokenrouter";
  try {
    const settings = await getSettings();
    provider = settings.provider;
    if (!settings.aiApiKey) {
      const providerName = getProviderDisplayName(provider);
      return {
        success: false,
        error: "NO_AI_KEY",
        message: `${providerName} API key not configured. Open YouTube Digest Settings.`,
      };
    }

    const { durationFormatted, maxTimestampSeconds, lateThreshold } =
      computeTranscriptDurationContext(transcriptText, videoDuration);

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const requestId =
      typeof meta?.requestId === "string" ? meta.requestId : "";
    const videoId = typeof meta?.videoId === "string" ? meta.videoId : "";
    let hasStartedWriting = false;

    const {
      text: responseText,
      reasoning,
      usage,
    } = await requestAiCompletion({
      maxTokens: 16384,
      responseFormat: { type: "json_object" },
      stream: true,
      onReasoningChunk: (chunk) => {
        if (!requestId || !chunk) return;
        chrome.runtime
          .sendMessage({
            action: "analysisProgress",
            requestId,
            videoId,
            target: "overview",
            phase: "thinking",
            reasoningDelta: chunk,
          })
          .catch(() => {});
      },
      onContentChunk: (chunk) => {
        if (!requestId || hasStartedWriting || !chunk || !chunk.trim()) return;
        hasStartedWriting = true;
        chrome.runtime
          .sendMessage({
            action: "analysisProgress",
            requestId,
            videoId,
            target: "overview",
            phase: "writing",
          })
          .catch(() => {});
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let analysis = parseLooseJson(responseText);
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);
    if (typeof reasoning === "string" && reasoning.trim()) {
      analysis.reasoning = reasoning.trim();
    }
    if (usage) {
      analysis.usage = usage;
    }

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    console.error("Analysis error:", error);
    return mapAiProviderError(error, provider, "Failed to analyze transcript");
  }
}

async function handleAnalyzeChapters(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
  meta = {},
) {
  let provider = "tokenrouter";
  try {
    const settings = await getSettings();
    provider = settings.provider;
    if (!settings.aiApiKey) {
      const providerName = getProviderDisplayName(provider);
      return {
        success: false,
        error: "NO_AI_KEY",
        message: `${providerName} API key not configured. Open YouTube Digest Settings.`,
      };
    }

    const { durationFormatted, maxTimestampSeconds, lateThreshold } =
      computeTranscriptDurationContext(transcriptText, videoDuration);

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "chapters.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "chapters.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting timeline chapters", settings.aiModel);
    const requestId =
      typeof meta?.requestId === "string" ? meta.requestId : "";
    const videoId = typeof meta?.videoId === "string" ? meta.videoId : "";
    let hasStartedWriting = false;

    const {
      text: responseText,
      reasoning,
      usage,
    } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      stream: true,
      onReasoningChunk: (chunk) => {
        if (!requestId || !chunk) return;
        chrome.runtime
          .sendMessage({
            action: "analysisProgress",
            requestId,
            videoId,
            target: "chapters",
            phase: "thinking",
            reasoningDelta: chunk,
          })
          .catch(() => {});
      },
      onContentChunk: (chunk) => {
        if (!requestId || hasStartedWriting || !chunk || !chunk.trim()) return;
        hasStartedWriting = true;
        chrome.runtime
          .sendMessage({
            action: "analysisProgress",
            requestId,
            videoId,
            target: "chapters",
            phase: "writing",
          })
          .catch(() => {});
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const parsed = parseLooseJson(responseText);
    const validated = validateAndFixTimestamps(parsed, maxTimestampSeconds);
    return {
      success: true,
      chapters: validated.chapters,
      keyMoments: validated.keyMoments,
      reasoning:
        typeof reasoning === "string" && reasoning.trim()
          ? reasoning.trim()
          : "",
      usage: usage || null,
    };
  } catch (error) {
    console.error("Chapters analysis error:", error);
    return mapAiProviderError(
      error,
      provider,
      "Failed to generate timeline chapters",
    );
  }
}

/**
 * Validates all fields and timestamps in the analysis and fixes any that exceed video duration.
 * Treats every model response as untrusted data and rebuilds the supported schema cleanly.
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";

  const parseTimestampString = (ts) => {
    if (typeof ts !== "string") return null;
    const match = ts.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    if (match[3] !== undefined) {
      return (
        parseInt(match[1], 10) * 3600 +
        parseInt(match[2], 10) * 60 +
        parseInt(match[3], 10)
      );
    }
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  };

  const safeSeconds = (value, fallbackTs) => {
    let seconds = Number(value);
    if (!Number.isFinite(seconds) && fallbackTs) {
      const parsed = parseTimestampString(fallbackTs);
      if (parsed !== null) seconds = parsed;
    }
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const VALID_TONES = new Set(["terracotta", "sage", "sand", "slate"]);
  const safeTone = (tone) => {
    const normalized = safeString(tone, 30).toLowerCase();
    return VALID_TONES.has(normalized) ? normalized : "sand";
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds, chapter?.timestamp);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      const importance =
        safeString(chapter?.importance, 20).toLowerCase() === "supporting"
          ? "supporting"
          : "core";
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        importance,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds, quote?.timestamp);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        speaker: safeString(quote?.speaker, 120),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const headline = safeString(analysis?.headline, 300);
  const oneLineThesis = safeString(analysis?.oneLineThesis, 1200);
  const coreTakeaways = (
    Array.isArray(analysis?.coreTakeaways) ? analysis.coreTakeaways : []
  )
    .slice(0, 8)
    .map((item) => safeString(item, 600))
    .filter(Boolean);

  // Validate adaptive visualBoard blocks
  let visualBoard = null;
  if (analysis?.visualBoard && typeof analysis.visualBoard === "object") {
    const rawBlocks = Array.isArray(analysis.visualBoard.blocks)
      ? analysis.visualBoard.blocks
      : [];
    const blocks = rawBlocks
      .slice(0, 8)
      .map((block) => {
        if (!block || typeof block !== "object") return null;
        const type = safeString(block.type, 40).toLowerCase();
        const title = safeString(block.title, 200);
        if (type === "card_grid") {
          const cards = (Array.isArray(block.cards) ? block.cards : [])
            .slice(0, 6)
            .map((card) => {
              const label = safeString(card?.label, 160);
              const points = (Array.isArray(card?.points) ? card.points : [])
                .slice(0, 8)
                .map((p) => safeString(p, 400))
                .filter(Boolean);
              if (!label || !points.length) return null;
              return { label, tone: safeTone(card?.tone), points };
            })
            .filter(Boolean);
          return cards.length ? { type, title, cards } : null;
        }
        if (type === "comparison_table") {
          const columns = (Array.isArray(block.columns) ? block.columns : [])
            .slice(0, 6)
            .map((c) => safeString(c, 120))
            .filter(Boolean);
          const rows = (Array.isArray(block.rows) ? block.rows : [])
            .slice(0, 12)
            .map((row) =>
              Array.isArray(row)
                ? row.slice(0, columns.length || 6).map((cell) => safeString(cell, 300))
                : null,
            )
            .filter((row) => row && row.some(Boolean));
          return columns.length >= 2 && rows.length
            ? { type, title, columns, rows }
            : null;
        }
        if (type === "process_flow") {
          const steps = (Array.isArray(block.steps) ? block.steps : [])
            .slice(0, 8)
            .map((step, idx) => {
              const stepTitle = safeString(step?.title, 200);
              const detail = safeString(step?.detail, 500);
              if (!stepTitle && !detail) return null;
              const sec = safeSeconds(step?.timestampSeconds, step?.timestamp);
              return {
                step: safeString(step?.step, 16) || String(idx + 1).padStart(2, "0"),
                title: stepTitle,
                detail,
                timestampSeconds: sec,
                timestamp: sec !== null ? formatTimestamp(sec) : "",
              };
            })
            .filter(Boolean);
          return steps.length ? { type, title, steps } : null;
        }
        if (type === "metric_strip") {
          const metrics = (Array.isArray(block.metrics) ? block.metrics : [])
            .slice(0, 6)
            .map((metric) => {
              const value = safeString(metric?.value, 100);
              const label = safeString(metric?.label, 140);
              if (!value || !label) return null;
              return {
                value,
                label,
                context: safeString(metric?.context, 300),
              };
            })
            .filter(Boolean);
          return metrics.length ? { type, title, metrics } : null;
        }
        if (type === "perspective_split") {
          const perspectives = (
            Array.isArray(block.perspectives) ? block.perspectives : []
          )
            .slice(0, 6)
            .map((item) => {
              const speaker = safeString(item?.speaker, 120);
              const stance = safeString(item?.stance, 300);
              const argumentsList = (
                Array.isArray(item?.arguments) ? item.arguments : []
              )
                .slice(0, 6)
                .map((arg) => safeString(arg, 400))
                .filter(Boolean);
              if (!speaker && !stance) return null;
              return { speaker, stance, arguments: argumentsList };
            })
            .filter(Boolean);
          return perspectives.length ? { type, title, perspectives } : null;
        }
        return null;
      })
      .filter(Boolean);

    if (blocks.length) {
      visualBoard = {
        title: safeString(analysis.visualBoard.title, 200) || headline,
        blocks,
      };
    }
  }

  // Validate deep structured brief sections
  const briefSections = (
    Array.isArray(analysis?.briefSections) ? analysis.briefSections : []
  )
    .slice(0, 12)
    .map((section) => {
      const title = safeString(section?.title, 250);
      const lead = safeString(section?.lead, 800);
      const importance =
        safeString(section?.importance, 20).toLowerCase() === "supporting"
          ? "supporting"
          : "core";
      const points = (Array.isArray(section?.points) ? section.points : [])
        .slice(0, 12)
        .map((pt) => {
          const heading = safeString(pt?.heading, 240);
          const detail = safeString(pt?.detail, 1500);
          if (!heading && !detail) return null;
          const sec = safeSeconds(pt?.timestampSeconds, pt?.timestamp);
          return {
            heading,
            detail,
            timestampSeconds: sec,
            timestamp: sec !== null ? formatTimestamp(sec) : "",
          };
        })
        .filter(Boolean);
      if (!title || (!lead && !points.length)) return null;
      return { title, importance, lead, points };
    })
    .filter(Boolean);

  const actionableItems = (
    Array.isArray(analysis?.actionableItems) ? analysis.actionableItems : []
  )
    .slice(0, 10)
    .map((item) => {
      const title = safeString(item?.title, 240);
      const detail = safeString(item?.detail, 800);
      if (!title && !detail) return null;
      return { title, detail };
    })
    .filter(Boolean);

  const mentionedResources = (
    Array.isArray(analysis?.mentionedResources)
      ? analysis.mentionedResources
      : []
  )
    .slice(0, 15)
    .map((item) => {
      const name = safeString(item?.name, 200);
      const note = safeString(item?.note, 500);
      if (!name) return null;
      return { name, note };
    })
    .filter(Boolean);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map((s) => safeSeconds(s))
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return {
    headline,
    oneLineThesis,
    coreTakeaways,
    visualBoard,
    briefSections,
    chapters,
    keyQuotes,
    actionableItems,
    mentionedResources,
    keyMoments,
  };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using DeepSeek.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at a timestamp. Exact selected text is stored directly.
 * Other note requests find the relevant transcript line and clean it up.
 */
async function handleSaveNote(
  videoId,
  timestamp,
  videoTitle,
  channelName,
  selectedText,
) {
  try {
    const canonicalVideoUrl = YTD_SETTINGS.canonicalYouTubeUrl(videoId);
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));
    const exactSelectedText =
      typeof selectedText === "string"
        ? selectedText.replace(/\s+/g, " ").trim().slice(0, 3000)
        : "";

    // A selected transcript note is already the exact text the user wants.
    // Save it directly without a transcript fetch or an AI cleanup request.
    if (exactSelectedText) {
      const minutes = Math.floor(safeTimestamp / 60);
      const seconds = safeTimestamp % 60;
      const note = {
        id: `note_${Date.now()}`,
        videoId,
        videoTitle:
          typeof videoTitle === "string"
            ? videoTitle.slice(0, 500)
            : "Untitled Video",
        channelName:
          typeof channelName === "string" ? channelName.slice(0, 300) : "",
        timestamp: `${minutes}:${String(seconds).padStart(2, "0")}`,
        timestampSeconds: safeTimestamp,
        timestampedUrl: `${canonicalVideoUrl}&t=${safeTimestamp}s`,
        text: exactSelectedText,
        rawText: exactSelectedText,
        createdAt: Date.now(),
      };

      await saveNoteToStorage(note);
      chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});
      return { success: true, note };
    }

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(`digest_${videoId}`);
      if (cached[`digest_${videoId}`]?.transcript) {
        transcript = cached[`digest_${videoId}`].transcript;
        debugLog("[YouTube Digest] Using cached transcript for note");
      }
    } catch (e) {
      debugLog("[YouTube Digest] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript(videoId);
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with DeepSeek.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object
    const note = {
      id: `note_${Date.now()}`,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    console.error("[YouTube Digest] Save note error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using DeepSeek.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 1536,
      reasoningEffort: settings.reasoningEffort === "off" ? "off" : "low",
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    console.error("[YouTube Digest] Cleanup error:", e);
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "TokenRouter API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 2048,
      reasoningEffort: settings.reasoningEffort === "off" ? "off" : "low",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    console.error("Explain selection error:", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using DeepSeek.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - 'transcriptBatch' or 'interfaceBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (!["transcriptBatch", "interfaceBatch"].includes(contentType)) {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "TokenRouter API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const promptSection =
      contentType === "transcriptBatch"
        ? "Transcript batch translation"
        : "Interface content translation";
    const systemPrompt = await loadPromptSection(
      "translation.md",
      promptSection,
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 4096,
      reasoningEffort: settings.reasoningEffort === "off" ? "off" : "low",
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // DeepSeek JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format (DeepSeek only).
    if (
      settings.provider === "deepseek" &&
      !result.success &&
      result.code === "EMPTY_AI_RESPONSE"
    ) {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    console.error("[YouTube Digest] Translation error:", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, reasoningEffort, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      reasoningEffort,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  requestGoogleGeminiCompletion,
  buildGeminiRequestBody,
  extractGeminiUsageStats,
  parseLooseJson,
  validateAndFixTimestamps,
  handleAnalyzeTranscript,
  handleAnalyzeChapters,
  callAiTranslation,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleSaveNote,
  handleTranslateContent,
  closePanelForTab,
  updatePanelForTab,
};
