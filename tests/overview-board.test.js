const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settingsModule = require("../settings.js");

function loadSidepanelHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: settingsModule,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers({ settings, fetchImpl }) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: () => 0,
    clearTimeout() {},
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => ({ [key]: localStorage[key] }),
          set: async (values) => Object.assign(localStorage, values),
          remove: async () => {},
        },
      },
      action: { onClicked: listeners },
      sidePanel: { setPanelBehavior() {}, setOptions: () => Promise.resolve() },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: settingsModule,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

function sseResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  const enc = new TextEncoder();
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: enc.encode(chunks[index++]) };
          },
          async cancel() {},
        };
      },
    },
  };
}

test("Google Gemini provider sends x-goog-api-key header, streams thoughts, and parses usageMetadata", async () => {
  const calls = [];
  const reasoningChunks = [];
  const contentChunks = [];
  const bg = loadBackgroundHelpers({
    settings: settingsModule.normalize({
      provider: "google",
      aiApiKey: "example-gemini-key",
      aiModel: "gemini-4-neon",
      reasoningEffort: "medium",
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Step 1 reasoning","thought":true}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"{\\"ok\\":true}"}]}}],"usageMetadata":{"promptTokenCount":500,"cachedContentTokenCount":300,"candidatesTokenCount":40,"thoughtsTokenCount":120}}\n\n',
      ]);
    },
  });

  const res = await bg.requestAiCompletion({
    maxTokens: 2048,
    responseFormat: { type: "json_object" },
    stream: true,
    onReasoningChunk: (chunk) => reasoningChunks.push(chunk),
    onContentChunk: (chunk) => contentChunks.push(chunk),
    messages: [
      { role: "system", content: "Static system prompt." },
      { role: "user", content: "User transcript." },
    ],
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
  );
  assert.equal(calls[0].headers["x-goog-api-key"], "example-gemini-key");
  assert.doesNotMatch(calls[0].url, /key=/);
  assert.equal(calls[0].body.systemInstruction.parts[0].text, "Static system prompt.");
  assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "MEDIUM",
  });
  assert.equal(res.text, '{"ok":true}');
  assert.equal(res.reasoning, "Step 1 reasoning");
  assert.deepEqual(reasoningChunks, ["Step 1 reasoning"]);
  assert.deepEqual(contentChunks, ['{"ok":true}']);
  assert.equal(res.usage.cachedTokens, 300);
  assert.equal(res.usage.reasoningTokens, 120);
});

test("Google Gemini retries once without thinkingConfig if HTTP 400 rejects thinking parameter", async () => {
  const bodies = [];
  const bg = loadBackgroundHelpers({
    settings: settingsModule.normalize({
      provider: "google",
      aiApiKey: "example-gemini-key",
      aiModel: "gemini-3.5-flash",
      reasoningEffort: "low",
    }),
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              error: { message: "Unsupported thinkingConfig for this model" },
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "fallback ok" }] } }],
          }),
      };
    },
  });

  const res = await bg.requestAiCompletion({
    maxTokens: 256,
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(res.text, "fallback ok");
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].generationConfig.thinkingConfig);
  assert.equal(Object.hasOwn(bodies[1].generationConfig, "thinkingConfig"), false);
});

test("validateAndFixTimestamps validates all visual board blocks and drops out-of-range timestamps", () => {
  const bg = loadBackgroundHelpers({
    settings: settingsModule.DEFAULTS,
    fetchImpl: async () => ({ ok: true }),
  });

  const validated = bg.validateAndFixTimestamps(
    {
      headline: "Core Thesis",
      oneLineThesis: "Dense summary.",
      coreTakeaways: ["Point A", "Point B"],
      visualBoard: {
        title: "Board",
        blocks: [
          {
            type: "card_grid",
            title: "Themes",
            cards: [{ label: "Card 1", tone: "terracotta", points: ["Fact 1"] }],
          },
          {
            type: "comparison_table",
            title: "US vs China",
            columns: ["Dim", "US", "China"],
            rows: [["SaaS", "$190B", "$16B"]],
          },
          {
            type: "process_flow",
            title: "Steps",
            steps: [
              { step: "01", title: "Step One", detail: "Do X", timestampSeconds: 120 },
              { step: "02", title: "Out of bounds", detail: "Do Y", timestampSeconds: 9999 },
            ],
          },
          {
            type: "metric_strip",
            title: "Metrics",
            metrics: [{ value: "10x", label: "Leverage", context: "Observed" }],
          },
          {
            type: "perspective_split",
            title: "Debate",
            perspectives: [{ speaker: "Alice", stance: "Pro", arguments: ["Arg 1"] }],
          },
        ],
      },
      briefSections: [
        {
          title: "Section 1",
          importance: "core",
          lead: "Lead",
          points: [
            { heading: "Sub", detail: "Detail", timestampSeconds: 90 },
            { heading: "Too late", detail: "Detail 2", timestampSeconds: 5000 },
          ],
        },
      ],
      chapters: [
        { title: "Valid", timestampSeconds: 60, importance: "core", summary: "Good" },
        { title: "Invalid", timestampSeconds: 9999, summary: "Drop" },
      ],
      keyQuotes: [{ quote: "Great line.", speaker: "Bob", timestampSeconds: 150 }],
      actionableItems: [{ title: "Try it", detail: "Start small" }],
      mentionedResources: [{ name: "Orca", note: "Agentic IDE" }],
    },
    600,
  );

  assert.equal(validated.visualBoard.blocks.length, 5);
  assert.equal(validated.visualBoard.blocks[2].steps[0].timestamp, "2:00");
  assert.equal(validated.visualBoard.blocks[2].steps[1].timestampSeconds, null);
  assert.equal(validated.briefSections[0].points[0].timestamp, "1:30");
  assert.equal(validated.briefSections[0].points[1].timestampSeconds, null);
  assert.equal(validated.chapters.length, 1);
  assert.equal(validated.chapters[0].importance, "core");
  assert.equal(validated.keyQuotes[0].speaker, "Bob");
});

test("Visual board renderer and HTML/Markdown exporters escape untrusted HTML safely", () => {
  const sp = loadSidepanelHelpers();
  const sampleAnalysis = {
    headline: 'Thesis <script>alert(1)</script>',
    oneLineThesis: "Safe framing.",
    coreTakeaways: ["Takeaway <img src=x onerror=alert(2)>"],
    visualBoard: {
      title: "Board <svg onload=alert(3)>",
      blocks: [
        {
          type: "card_grid",
          title: "Cards",
          cards: [{ label: "<b>Label</b>", tone: "sage", points: ["Bullet 1"] }],
        },
        {
          type: "comparison_table",
          title: "Compare",
          columns: ["Dim", "A", "B"],
          rows: [["Speed", "Fast", "Slow"]],
        },
      ],
    },
    briefSections: [
      {
        title: "Deep Section",
        lead: "Lead",
        points: [{ heading: "Point", detail: "Evidence", timestamp: "1:00", timestampSeconds: 60 }],
      },
    ],
    keyQuotes: [{ quote: "Quoted line.", speaker: "Guest", timestamp: "2:00", timestampSeconds: 120 }],
    actionableItems: [{ title: "Do X", detail: "Because Y" }],
    mentionedResources: [{ name: "ToolZ", note: "Useful" }],
  };

  const boardHtml = sp.renderVisualBoardMarkup(sampleAnalysis.visualBoard);
  assert.match(boardHtml, /board-card-grid/);
  assert.match(boardHtml, /board-table/);
  assert.doesNotMatch(boardHtml, /<svg onload|<b\b/);
  assert.match(boardHtml, /&lt;b&gt;Label&lt;\/b&gt;/);

  const standalone = sp.buildStandaloneOverviewHtml(sampleAnalysis, {
    videoId: "abc12345678",
    videoTitle: "Demo Video",
    channelName: "Demo Channel",
  });
  assert.match(standalone, /<!doctype html>/i);
  assert.match(standalone, /https:\/\/www\.youtube\.com\/watch\?v=abc12345678&amp;t=60s/);
  assert.doesNotMatch(standalone, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(standalone, /<img src=x onerror=/);

  const md = sp.buildOverviewMarkdown(sampleAnalysis, {
    videoId: "abc12345678",
    videoTitle: "Demo Video",
    channelName: "Demo Channel",
  });
  assert.match(md, /## Core Insights/);
  assert.match(md, /\| Dim \| A \| B \|/);
  assert.match(md, /## Deep Brief/);
  assert.match(md, /## Actionable Takeaways/);
  assert.match(md, /## Mentioned Resources/);
});

test("parseLooseJson repairs unescaped inner ASCII double quotes and trailing commas", () => {
  const bg = loadBackgroundHelpers({
    settings: settingsModule.DEFAULTS,
    fetchImpl: async () => ({ ok: true }),
  });

  const raw = '{"headline":"The "march of nines" problem","items":["a","b",]}';
  const parsed = bg.parseLooseJson(raw);
  assert.equal(parsed.headline, 'The "march of nines" problem');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.items)), ["a", "b"]);
});

test("Transcript tab hosts both Subtitles and Timeline modes while Overview hosts Executive Digest", () => {
  const html = read("sidepanel.html");
  assert.match(html, /data-panel="transcript"[\s\S]*id="transcriptViewSubtitlesBtn"/);
  assert.match(html, /data-panel="transcript"[\s\S]*id="transcriptViewTimelineBtn"/);
  assert.match(html, /data-panel="transcript"[\s\S]*id="transcriptTimelineView"[\s\S]*id="chapterList"/);
  assert.match(html, /data-panel="overview"[\s\S]*id="overviewDigestContainer"/);
  assert.match(html, /data-panel="overview"[\s\S]*id="exportOverviewHtmlBtn"/);
  assert.match(html, /data-panel="overview"[\s\S]*id="copyOverviewMdBtn"/);
});
