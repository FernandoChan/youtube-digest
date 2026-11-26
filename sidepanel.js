/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentChapters = null;
let currentChaptersReasoning = "";
let currentChaptersUsage = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTranscriptView = "subtitles"; // "subtitles" | "timeline"
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if overview analysis is in progress
let activeAnalysisRequestId = null;
let isChaptersLoading = false; // Track if timeline chapters analysis is in progress
let activeChaptersRequestId = null;
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;

// --- Translation state ---
// The universal language control supports original content, Chinese, and an
// aligned bilingual view across Transcript, Overview, and Notes.
let currentTranscriptMode = "original";
const DISPLAY_LANGUAGE_MODE_KEY = "ytd_display_language_modes_by_video";
const DISPLAY_LANGUAGE_MODES = new Set(["original", "zh", "bilingual"]);
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let interfaceTranslationCache = new Map();
let interfaceTranslationInFlight = new Set();
let interfaceTranslationFailures = new Set();
let currentNotes = [];
let currentNotesFilterVideoId = null;
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const TRANSLATION_BATCH_SIZE = 3;

// --- Transcript search state ---
// Matches point to visible marks in the active transcript language mode.
// Search navigation only scrolls the panel. It does not seek the video.
let transcriptSearchMatches = [];
let transcriptSearchIndex = -1;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// --- Transcript reading position state ---
// Session storage survives a side panel close but clears when Chrome closes.
const TRANSCRIPT_VIEW_STATE_KEY = "ytd_transcript_view_state";
let pendingTranscriptViewState = null;
let transcriptViewStateSaveTimer = null;
let isRestoringTranscriptView = false;
let selectionActionsController = null;
let lastTranscriptScrollTop = 0;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setTranscriptModeButtons("original");
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "analysisProgress") {
    const isChaptersTarget = message.target === "chapters";
    const expectedRequestId = isChaptersTarget
      ? activeChaptersRequestId
      : activeAnalysisRequestId;
    if (expectedRequestId && message.requestId === expectedRequestId) {
      const thinkingSection = document.getElementById(
        isChaptersTarget ? "chaptersThinkingSection" : "thinkingSection",
      );
      const thinkingStatus = document.getElementById(
        isChaptersTarget ? "chaptersThinkingStatus" : "thinkingStatus",
      );
      const thinkingOutput = document.getElementById(
        isChaptersTarget ? "chaptersThinkingOutput" : "thinkingOutput",
      );
      if (message.phase === "thinking" && message.reasoningDelta) {
        if (thinkingSection) thinkingSection.hidden = false;
        if (thinkingStatus) thinkingStatus.textContent = "Thinking...";
        if (thinkingOutput) {
          const nearBottom =
            thinkingOutput.scrollHeight -
              thinkingOutput.scrollTop -
              thinkingOutput.clientHeight <
            40;
          thinkingOutput.textContent += message.reasoningDelta;
          if (nearBottom) {
            thinkingOutput.scrollTop = thinkingOutput.scrollHeight;
          }
        }
      } else if (message.phase === "writing") {
        if (thinkingStatus) {
          thinkingStatus.textContent = isChaptersTarget
            ? "Generating timeline chapters..."
            : "Building visual board and executive digest...";
        }
      }
    }
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Start the position save, then close in this same event callback. Chrome
    // does not reliably honor window.close() after an asynchronous wait.
    void saveCurrentTranscriptViewState();
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

/**
 * Gets the best URL from a tab update that can change the visible page.
 * The status events repeat the close request after Chrome commits the first
 * non-YouTube navigation, when an early URL event alone can be lost.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// Fires when a tab starts or completes navigation, including YouTube's
// no-reload navigation. The completion event is a deliberate second close
// attempt for the first non-YouTube page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return;
  handleFrontTabUrl(url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions & dual-mode switcher (Subtitles / Timeline)
  document.querySelectorAll(".transcript-view-btn").forEach((button) => {
    button.addEventListener("click", () => {
      switchTranscriptView(button.dataset.transcriptView);
    });
  });
  document
    .getElementById("regenerateChaptersBtn")
    ?.addEventListener("click", () => triggerChaptersAnalysis({ force: true }));
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);

  // Overview actions
  document
    .getElementById("exportOverviewHtmlBtn")
    ?.addEventListener("click", exportOverviewHtml);
  document
    .getElementById("copyOverviewMdBtn")
    ?.addEventListener("click", copyOverviewMarkdown);
  document
    .getElementById("regenerateOverviewBtn")
    ?.addEventListener("click", () => triggerAnalysis({ force: true }));

  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleDisplayLanguageModeChange(button.dataset.transcriptMode);
    });
  });
  setupTranscriptSearch();

  // pagehide also covers closing the side panel without a tab change.
  window.addEventListener("pagehide", () => {
    void saveCurrentTranscriptViewState();
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    // The panel belongs only to the active tab. Looking for another open
    // YouTube tab here can keep an old transcript visible on a non-YouTube
    // page, so never fall back to background tabs.
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const tab = tabs[0] || null;

    debugLog("[YouTube Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    if (!tab.url.startsWith("https://www.youtube.com")) {
      handleFrontTabUrl(tab.url);
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YouTube Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  const videoChanged = videoId !== currentVideoId;

  // Every video change invalidates observer work and in-flight translations.
  if (videoChanged) {
    translationGeneration += 1;
    activeAnalysisRequestId = null;
    activeChaptersRequestId = null;
    isAnalysisLoading = false;
    isChaptersLoading = false;
    currentChapters = null;
    currentChaptersReasoning = "";
    currentChaptersUsage = null;
    applyTranscriptViewUi("subtitles");
    renderThinkingSection({
      visible: false,
      open: false,
      status: "Thinking process",
      meta: "",
      text: "",
    });
    renderChaptersThinkingSection({
      visible: false,
      open: false,
      status: "Thinking process",
      meta: "",
      text: "",
    });
    resetOverviewUi();
    resetChaptersUi();
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
    resetTranscriptSearch();
    lastTranscriptScrollTop = 0;
    pendingTranscriptViewState = await loadTranscriptViewState(videoId);
    // An unseen video always starts in Original, so opening it never spends
    // translation tokens. A saved choice is restored only for this video.
    currentTranscriptMode = await loadDisplayLanguageMode(videoId);
    document
      .getElementById("contentArea")
      ?.classList.toggle(
        "restoring-transcript-view",
        Boolean(pendingTranscriptViewState),
      );
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentChapters =
      Array.isArray(cached.chapters) && cached.chapters.length
        ? cached.chapters
        : Array.isArray(cached.analysis?.chapters) &&
            cached.analysis.chapters.length
          ? cached.analysis.chapters
          : null;
    currentChaptersReasoning = cached.chaptersReasoning || "";
    currentChaptersUsage = cached.chaptersUsage || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    isAnalysisLoading = false;
    isChaptersLoading = false;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }
    if (cached.interfaceCache) {
      for (const [key, value] of Object.entries(cached.interfaceCache)) {
        interfaceTranslationCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    if (currentChapters) {
      renderChaptersList(currentChapters, {
        reasoning: currentChaptersReasoning,
        usage: currentChaptersUsage,
      });
    }

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
    restorePendingTranscriptViewState(videoId);

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentChapters = null;
  currentChaptersReasoning = "";
  currentChaptersUsage = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  isAnalysisLoading = false;
  isChaptersLoading = false;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "API key missing",
        "Add your Supadata API key in YouTube Digest Settings.",
      );
      return;
    }
    showError(
      "No transcript found",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  restorePendingTranscriptViewState(videoId);

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

function interfaceTranslationCacheKey(surface, id, text) {
  return `${currentVideoId || "none"}:zh:${surface}:${id}:${text}`;
}

function getInterfaceTranslation(surface, id, text) {
  return interfaceTranslationCache.get(
    interfaceTranslationCacheKey(surface, id, text),
  );
}

function renderAnchoredCopy(text, surface, id) {
  const formatLeadIn = (str) => {
    const escaped = escapeHtml(str);
    const match = escaped.match(/^([^:：]{2,42})([:：])(\s*[\s\S]+)$/);
    if (match) {
      return `<strong class="takeaway-anchor">${match[1]}${match[2]}</strong>${match[3]}`;
    }
    return escaped;
  };
  const original = String(text || "");
  if (!original) return "";
  if (currentTranscriptMode === "original") return formatLeadIn(original);
  const cacheKey = interfaceTranslationCacheKey(surface, id, original);
  const translated = getInterfaceTranslation(surface, id, original);
  const translation = translated
    ? formatLeadIn(translated)
    : interfaceTranslationFailures.has(cacheKey)
      ? '<span class="translation-error">Translation unavailable.</span>'
      : '<span class="translation-pending">Translating...</span>';
  if (currentTranscriptMode === "bilingual") {
    return `<span class="localized-copy"><span class="localized-original">${formatLeadIn(original)}</span><span class="localized-translation">${translation}</span></span>`;
  }
  return `<span class="localized-copy"><span class="localized-translation">${translation}</span></span>`;
}

function renderLocalizedContent(text, surface, id) {
  const original = String(text || "");
  if (!original) return "";
  const cacheKey = interfaceTranslationCacheKey(surface, id, original);
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "original") return escapeHtml(original);

  const translation = translated
    ? escapeHtml(translated)
    : interfaceTranslationFailures.has(cacheKey)
      ? '<span class="translation-error">Translation unavailable.</span>'
      : '<span class="translation-pending">Translating...</span>';
  if (currentTranscriptMode === "bilingual") {
    return `<span class="localized-copy"><span class="localized-original">${escapeHtml(original)}</span><span class="localized-translation">${translation}</span></span>`;
  }
  return `<span class="localized-copy"><span class="localized-translation">${translation}</span></span>`;
}

function getLocalizedPlainText(text, surface, id) {
  const original = String(text || "");
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "zh") return translated || original;
  if (currentTranscriptMode === "bilingual" && translated) {
    return `${original}\n\n${translated}`;
  }
  return original;
}

async function translateInterfaceSegments(surface, segments, rerender) {
  if (currentTranscriptMode === "original" || !segments.length) return;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const missing = segments
    .filter((segment) => segment.text)
    .map((segment) => ({
      ...segment,
      cacheKey: interfaceTranslationCacheKey(
        surface,
        segment.id,
        segment.text,
      ),
    }))
    .filter(
      (segment) =>
        !interfaceTranslationCache.has(segment.cacheKey) &&
        !interfaceTranslationFailures.has(segment.cacheKey) &&
        !interfaceTranslationInFlight.has(segment.cacheKey),
    );
  if (!missing.length) return;

  missing.forEach((segment) => interfaceTranslationInFlight.add(segment.cacheKey));
  setTranslatingSpinner(true);
  try {
    for (
      let start = 0;
      start < missing.length;
      start += TRANSLATION_BATCH_SIZE
    ) {
      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      let result;
      try {
        result = await sendTranslationMessage({
          action: "translateContent",
          content: {
            segments: batch.map(({ id, text }) => ({ id, text })),
          },
          contentType: "interfaceBatch",
          targetLanguage: "zh",
          videoTitle: currentVideoTitle,
        });
      } catch (error) {
        console.error("[YouTube Digest] Interface batch error:", error);
        result = { success: false, error: error.message };
      }
      if (
        generation !== translationGeneration ||
        videoId !== currentVideoId ||
        currentTranscriptMode === "original"
      ) {
        return;
      }
      const aligned = alignTranslatedSegmentBatch(
        batch,
        result?.success ? result.translatedContent?.segments : [],
      );
      aligned.forEach((item, index) => {
        if (item.text) {
          interfaceTranslationCache.set(batch[index].cacheKey, item.text);
        } else {
          interfaceTranslationFailures.add(batch[index].cacheKey);
        }
      });
      // Match the Transcript UX: reveal and persist every small batch as soon
      // as it returns instead of waiting for the full Overview or Notes list.
      rerender();
      await updateCache();
    }
  } catch (error) {
    console.error("[YouTube Digest] Interface translation error:", error);
    missing.forEach((segment) =>
      interfaceTranslationFailures.add(segment.cacheKey),
    );
  } finally {
    missing.forEach((segment) => interfaceTranslationInFlight.delete(segment.cacheKey));
    setTranslatingSpinner(false);
  }
}

function getChaptersTranslationSegments() {
  if (!Array.isArray(currentChapters) || !currentChapters.length) return [];
  const segments = [];
  currentChapters.forEach((chapter, index) => {
    if (chapter.title) {
      segments.push({ id: `chapter-${index}-title`, text: chapter.title });
    }
    if (chapter.summary) {
      segments.push({ id: `chapter-${index}-summary`, text: chapter.summary });
    }
  });
  return segments;
}

function translateChaptersContent() {
  return translateInterfaceSegments(
    "chapters",
    getChaptersTranslationSegments(),
    () => {
      const contentArea = document.getElementById("contentArea");
      const scrollTop = contentArea?.scrollTop || 0;
      renderChaptersList(currentChapters, {
        reasoning: currentChaptersReasoning,
        usage: currentChaptersUsage,
      });
      if (contentArea) contentArea.scrollTop = scrollTop;
    },
  );
}

function getOverviewTranslationSegments() {
  if (!currentAnalysis) return [];
  const segments = [];
  const pushIf = (id, text) => {
    if (typeof text === "string" && text.trim()) {
      segments.push({ id, text: text.trim() });
    }
  };

  pushIf("headline", currentAnalysis.headline);
  pushIf("thesis", currentAnalysis.oneLineThesis);
  (currentAnalysis.coreTakeaways || []).forEach((item, idx) => {
    pushIf(`takeaway-${idx}`, item);
  });

  if (currentAnalysis.visualBoard) {
    pushIf("board-title", currentAnalysis.visualBoard.title);
    (currentAnalysis.visualBoard.blocks || []).forEach((block, bIdx) => {
      pushIf(`board-${bIdx}-title`, block.title);
      if (block.type === "card_grid") {
        (block.cards || []).forEach((card, cIdx) => {
          pushIf(`board-${bIdx}-card-${cIdx}-label`, card.label);
          (card.points || []).forEach((pt, pIdx) => {
            pushIf(`board-${bIdx}-card-${cIdx}-pt-${pIdx}`, pt);
          });
        });
      } else if (block.type === "comparison_table") {
        (block.columns || []).forEach((col, colIdx) => {
          pushIf(`board-${bIdx}-col-${colIdx}`, col);
        });
        (block.rows || []).forEach((row, rIdx) => {
          (row || []).forEach((cell, cIdx) => {
            pushIf(`board-${bIdx}-row-${rIdx}-cell-${cIdx}`, cell);
          });
        });
      } else if (block.type === "process_flow") {
        (block.steps || []).forEach((step, sIdx) => {
          pushIf(`board-${bIdx}-step-${sIdx}-title`, step.title);
          pushIf(`board-${bIdx}-step-${sIdx}-detail`, step.detail);
        });
      } else if (block.type === "metric_strip") {
        (block.metrics || []).forEach((m, mIdx) => {
          pushIf(`board-${bIdx}-metric-${mIdx}-label`, m.label);
          pushIf(`board-${bIdx}-metric-${mIdx}-ctx`, m.context);
        });
      } else if (block.type === "perspective_split") {
        (block.perspectives || []).forEach((p, pIdx) => {
          pushIf(`board-${bIdx}-persp-${pIdx}-stance`, p.stance);
          (p.arguments || []).forEach((arg, aIdx) => {
            pushIf(`board-${bIdx}-persp-${pIdx}-arg-${aIdx}`, arg);
          });
        });
      }
    });
  }

  (currentAnalysis.briefSections || []).forEach((section, sIdx) => {
    pushIf(`brief-${sIdx}-title`, section.title);
    pushIf(`brief-${sIdx}-lead`, section.lead);
    (section.points || []).forEach((pt, pIdx) => {
      pushIf(`brief-${sIdx}-pt-${pIdx}-head`, pt.heading);
      pushIf(`brief-${sIdx}-pt-${pIdx}-detail`, pt.detail);
    });
  });

  [...(currentAnalysis.keyQuotes || [])]
    .sort((a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0))
    .forEach((quote, index) => {
      pushIf(`quote-${index}`, quote.quote);
    });

  (currentAnalysis.actionableItems || []).forEach((item, idx) => {
    pushIf(`action-${idx}-title`, item.title);
    pushIf(`action-${idx}-detail`, item.detail);
  });

  (currentAnalysis.mentionedResources || []).forEach((item, idx) => {
    pushIf(`res-${idx}-note`, item.note);
  });

  return segments;
}

function translateOverviewContent() {
  return translateInterfaceSegments(
    "overview",
    getOverviewTranslationSegments(),
    () => {
      const contentArea = document.getElementById("contentArea");
      const scrollTop = contentArea?.scrollTop || 0;
      renderAnalysisResults(currentAnalysis);
      if (contentArea) contentArea.scrollTop = scrollTop;
    },
  );
}

function getNoteTranslationId(note, index) {
  const stablePart = String(note.id || note.createdAt || index)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return `note-${stablePart || index}`;
}

function translateNotesContent() {
  const segments = currentNotes.map((note, index) => ({
    id: getNoteTranslationId(note, index),
    text: note.text || "",
  }));
  return translateInterfaceSegments("notes", segments, () => {
    const contentArea = document.getElementById("contentArea");
    const scrollTop = contentArea?.scrollTop || 0;
    renderNotes(currentNotes, currentNotesFilterVideoId);
    if (contentArea) contentArea.scrollTop = scrollTop;
  });
}

function formatAnalysisMeta(usage) {
  if (!usage || typeof usage !== "object") return "";
  const parts = [];
  if (Number(usage.reasoningTokens) > 0) {
    parts.push(`Reasoning ${usage.reasoningTokens} tok`);
  }
  if (Number(usage.cachedTokens) > 0) {
    parts.push(`Cache hit ${usage.cachedTokens} tok`);
  }
  return parts.join(" / ");
}

function renderThinkingSectionFor(
  ids,
  {
    visible = false,
    open = false,
    status = "Thinking process",
    meta = "",
    text = "",
  } = {},
) {
  const section = document.getElementById(ids.section);
  if (!section) return;
  section.hidden = !visible;
  section.open = Boolean(open);
  const statusEl = document.getElementById(ids.status);
  const metaEl = document.getElementById(ids.meta);
  const outputEl = document.getElementById(ids.output);
  if (statusEl) statusEl.textContent = status;
  if (metaEl) metaEl.textContent = meta;
  if (outputEl) outputEl.textContent = text;
}

function renderThinkingSection(options = {}) {
  renderThinkingSectionFor(
    {
      section: "thinkingSection",
      status: "thinkingStatus",
      meta: "thinkingMeta",
      output: "thinkingOutput",
    },
    options,
  );
}

function renderChaptersThinkingSection(options = {}) {
  renderThinkingSectionFor(
    {
      section: "chaptersThinkingSection",
      status: "chaptersThinkingStatus",
      meta: "chaptersThinkingMeta",
      output: "chaptersThinkingOutput",
    },
    options,
  );
}

function resetOverviewUi() {
  const container = document.getElementById("overviewDigestContainer");
  if (container) {
    container.innerHTML =
      '<div class="digest-placeholder">Open Overview to generate a visual synthesis board and deep executive digest...</div>';
  }
  const quotesList = document.getElementById("quotesList");
  if (quotesList) {
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border); cursor: default;"><div class="quote-text" style="font-style: normal">Quotes will be extracted when you view this tab...</div></div>';
  }
  const exportBtn = document.getElementById("exportOverviewHtmlBtn");
  const copyMdBtn = document.getElementById("copyOverviewMdBtn");
  if (exportBtn) exportBtn.disabled = true;
  if (copyMdBtn) copyMdBtn.disabled = true;
}

function resetChaptersUi() {
  const chapterList = document.getElementById("chapterList");
  if (chapterList) {
    chapterList.innerHTML =
      '<li class="chapter-item chapter-placeholder">Switch to Timeline to generate a proportional chapter outline...</li>';
  }
}

/**
 * Renders the Timeline Chapters list inside Transcript -> Timeline mode.
 */
function renderChaptersList(chapters, { reasoning = "", usage = null } = {}) {
  if (reasoning) {
    renderChaptersThinkingSection({
      visible: true,
      open: false,
      status: "Thinking process",
      meta: formatAnalysisMeta(usage),
      text: reasoning,
    });
  } else {
    renderChaptersThinkingSection({ visible: false });
  }

  const chapterList = document.getElementById("chapterList");
  if (!chapterList) return;
  chapterList.innerHTML = "";

  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length) {
    chapterList.innerHTML =
      '<li class="chapter-item chapter-placeholder">No substantive chapters found.</li>';
    return;
  }

  list.forEach((chapter, index) => {
    const li = document.createElement("li");
    const importanceClass =
      chapter.importance === "supporting"
        ? "chapter-supporting"
        : "chapter-core";
    li.className = `chapter-item ${importanceClass}`;
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${renderLocalizedContent(chapter.title, "chapters", `chapter-${index}-title`)}</span>
        <span class="chapter-summary">${renderLocalizedContent(chapter.summary || "", "chapters", `chapter-${index}-summary`)}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  if (
    currentTranscriptMode !== "original" &&
    transcriptTabIsActive() &&
    currentTranscriptView === "timeline"
  ) {
    void translateChaptersContent();
  }
}

/**
 * Pure, XSS-safe renderer for the adaptive Visual Synthesis Board.
 * Converts validated JSON board blocks into warm editorial HTML components.
 */
function renderVisualBoardMarkup(visualBoard, localizeFn = null) {
  if (!visualBoard || !Array.isArray(visualBoard.blocks) || !visualBoard.blocks.length) {
    return "";
  }
  const loc =
    typeof localizeFn === "function"
      ? localizeFn
      : (text) => escapeHtml(text || "");

  const renderBlock = (block, bIdx) => {
    const titleHtml = block.title
      ? `<div class="board-block-title">${loc(block.title, `board-${bIdx}-title`)}</div>`
      : "";

    if (block.type === "card_grid" && Array.isArray(block.cards) && block.cards.length) {
      const cardsHtml = block.cards
        .map((card, cIdx) => {
          const tone = ["terracotta", "sage", "sand", "slate"].includes(card.tone)
            ? card.tone
            : "sand";
          const ptsHtml = (card.points || [])
            .map(
              (pt, pIdx) =>
                `<li>${loc(pt, `board-${bIdx}-card-${cIdx}-pt-${pIdx}`)}</li>`,
            )
            .join("");
          return `
            <div class="board-card tone-${tone}">
              <div class="board-card-head">${loc(card.label, `board-${bIdx}-card-${cIdx}-label`)}</div>
              <ul class="board-card-points">${ptsHtml}</ul>
            </div>
          `;
        })
        .join("");
      return `<div class="board-block">${titleHtml}<div class="board-card-grid">${cardsHtml}</div></div>`;
    }

    if (
      block.type === "comparison_table" &&
      Array.isArray(block.columns) &&
      block.columns.length >= 2 &&
      Array.isArray(block.rows) &&
      block.rows.length
    ) {
      const theadHtml = block.columns
        .map((col, cIdx) => `<th>${loc(col, `board-${bIdx}-col-${cIdx}`)}</th>`)
        .join("");
      const tbodyHtml = block.rows
        .map((row, rIdx) => {
          const cells = block.columns
            .map((_, cIdx) => {
              const val = Array.isArray(row) ? row[cIdx] || "" : "";
              return `<td>${loc(val, `board-${bIdx}-row-${rIdx}-cell-${cIdx}`)}</td>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `
        <div class="board-block">
          ${titleHtml}
          <div class="board-table-wrap">
            <table class="board-table">
              <thead><tr>${theadHtml}</tr></thead>
              <tbody>${tbodyHtml}</tbody>
            </table>
          </div>
        </div>
      `;
    }

    if (block.type === "process_flow" && Array.isArray(block.steps) && block.steps.length) {
      const stepsHtml = block.steps
        .map((step, sIdx) => {
          const tsHtml =
            step.timestamp && Number.isFinite(Number(step.timestampSeconds))
              ? `<button class="inline-ts-btn" type="button" data-seek-seconds="${Number(step.timestampSeconds)}">${escapeHtml(step.timestamp)}</button>`
              : "";
          return `
            <div class="board-flow-step">
              <span class="board-flow-num">${escapeHtml(step.step || String(sIdx + 1).padStart(2, "0"))}</span>
              <div class="board-flow-body">
                <div class="board-flow-head">
                  <span class="board-flow-title">${loc(step.title, `board-${bIdx}-step-${sIdx}-title`)}</span>
                  ${tsHtml}
                </div>
                ${step.detail ? `<div class="board-flow-detail">${loc(step.detail, `board-${bIdx}-step-${sIdx}-detail`)}</div>` : ""}
              </div>
            </div>
          `;
        })
        .join("");
      return `<div class="board-block">${titleHtml}<div class="board-flow">${stepsHtml}</div></div>`;
    }

    if (block.type === "metric_strip" && Array.isArray(block.metrics) && block.metrics.length) {
      const metricsHtml = block.metrics
        .map(
          (m, mIdx) => `
            <div class="board-metric-card">
              <div class="board-metric-value">${escapeHtml(m.value)}</div>
              <div class="board-metric-label">${loc(m.label, `board-${bIdx}-metric-${mIdx}-label`)}</div>
              ${m.context ? `<div class="board-metric-context">${loc(m.context, `board-${bIdx}-metric-${mIdx}-ctx`)}</div>` : ""}
            </div>
          `,
        )
        .join("");
      return `<div class="board-block">${titleHtml}<div class="board-metric-strip">${metricsHtml}</div></div>`;
    }

    if (
      block.type === "perspective_split" &&
      Array.isArray(block.perspectives) &&
      block.perspectives.length
    ) {
      const cardsHtml = block.perspectives
        .map((p, pIdx) => {
          const argsHtml = (p.arguments || [])
            .map(
              (arg, aIdx) =>
                `<li>${loc(arg, `board-${bIdx}-persp-${pIdx}-arg-${aIdx}`)}</li>`,
            )
            .join("");
          return `
            <div class="board-perspective-card">
              ${p.speaker ? `<div class="board-perspective-speaker">${escapeHtml(p.speaker)}</div>` : ""}
              ${p.stance ? `<div class="board-perspective-stance">${loc(p.stance, `board-${bIdx}-persp-${pIdx}-stance`)}</div>` : ""}
              ${argsHtml ? `<ul class="board-perspective-args">${argsHtml}</ul>` : ""}
            </div>
          `;
        })
        .join("");
      return `<div class="board-block">${titleHtml}<div class="board-perspective-grid">${cardsHtml}</div></div>`;
    }

    return "";
  };

  const blocksHtml = visualBoard.blocks.map(renderBlock).filter(Boolean).join("");
  if (!blocksHtml) return "";

  return `
    <section class="visual-board" aria-label="Visual synthesis board">
      <div class="visual-board-header">
        <div class="visual-board-title">${loc(visualBoard.title || "Visual Summary", "board-title")}</div>
        <span class="visual-board-eyebrow">Visual Board</span>
      </div>
      ${blocksHtml}
    </section>
  `;
}

/**
 * Renders the Executive Digest results into the Overview tab:
 * Hero thesis + Core takeaways + Adaptive Visual Synthesis Board +
 * Deep Structured Brief + Actionable items / Resources + Key Quotes.
 */
function renderAnalysisResults(analysis) {
  if (!analysis || typeof analysis !== "object") return;

  if (analysis.reasoning) {
    renderThinkingSection({
      visible: true,
      open: false,
      status: "Thinking process",
      meta: formatAnalysisMeta(analysis.usage),
      text: analysis.reasoning,
    });
  } else {
    renderThinkingSection({
      visible: false,
      open: false,
      status: "Thinking process",
      meta: "",
      text: "",
    });
  }

  const exportBtn = document.getElementById("exportOverviewHtmlBtn");
  const copyMdBtn = document.getElementById("copyOverviewMdBtn");
  if (exportBtn) exportBtn.disabled = false;
  if (copyMdBtn) copyMdBtn.disabled = false;

  const container = document.getElementById("overviewDigestContainer");
  if (container) {
    const loc = (text, id) => renderLocalizedContent(text, "overview", id);
    const parts = [];

    // 1. Hero thesis + Core Takeaways
    const hasHero =
      analysis.headline ||
      analysis.oneLineThesis ||
      (analysis.coreTakeaways && analysis.coreTakeaways.length);
    if (hasHero) {
      const takeawaysHtml =
        analysis.coreTakeaways && analysis.coreTakeaways.length
          ? `
            <div class="takeaways-box">
              <div class="takeaways-label">Core Insights</div>
              <ul class="takeaways-list">
                ${analysis.coreTakeaways
                  .map(
                    (item, idx) =>
                      `<li>${renderAnchoredCopy(item, "overview", `takeaway-${idx}`)}</li>`,
                  )
                  .join("")}
              </ul>
            </div>
          `
          : "";
      parts.push(`
        <section class="digest-hero">
          ${analysis.headline ? `<h2 class="digest-headline">${loc(analysis.headline, "headline")}</h2>` : ""}
          ${analysis.oneLineThesis ? `<p class="digest-thesis">${loc(analysis.oneLineThesis, "thesis")}</p>` : ""}
          ${takeawaysHtml}
        </section>
      `);
    }

    // 2. Adaptive Visual Synthesis Board
    if (analysis.visualBoard) {
      parts.push(renderVisualBoardMarkup(analysis.visualBoard, loc));
    }

    // 3. Deep Structured Brief (thematic, non-chronological)
    if (Array.isArray(analysis.briefSections) && analysis.briefSections.length) {
      const sectionsHtml = analysis.briefSections
        .map((section, sIdx) => {
          const importanceClass =
            section.importance === "supporting"
              ? "importance-supporting"
              : "importance-core";
          const pointsHtml = (section.points || [])
            .map((pt, pIdx) => {
              const tsBtn =
                pt.timestamp && Number.isFinite(Number(pt.timestampSeconds))
                  ? `<button class="inline-ts-btn" type="button" data-seek-seconds="${Number(pt.timestampSeconds)}">${escapeHtml(pt.timestamp)}</button>`
                  : "";
              return `
                <li class="brief-point">
                  <div class="brief-point-head">
                    <span class="brief-point-heading">${loc(pt.heading, `brief-${sIdx}-pt-${pIdx}-head`)}</span>
                    ${tsBtn}
                  </div>
                  ${pt.detail ? `<div class="brief-point-detail">${loc(pt.detail, `brief-${sIdx}-pt-${pIdx}-detail`)}</div>` : ""}
                </li>
              `;
            })
            .join("");
          return `
            <article class="brief-section-card ${importanceClass}">
              <h3 class="brief-section-title">${loc(section.title, `brief-${sIdx}-title`)}</h3>
              ${section.lead ? `<p class="brief-section-lead">${loc(section.lead, `brief-${sIdx}-lead`)}</p>` : ""}
              ${pointsHtml ? `<ul class="brief-points">${pointsHtml}</ul>` : ""}
            </article>
          `;
        })
        .join("");
      parts.push(`
        <div class="section">
          <div class="section-title">Deep Brief</div>
          <div class="brief-sections">${sectionsHtml}</div>
        </div>
      `);
    }

    // 4. Optional Actionable Takeaways
    if (Array.isArray(analysis.actionableItems) && analysis.actionableItems.length) {
      const itemsHtml = analysis.actionableItems
        .map(
          (item, idx) => `
            <li class="digest-extras-item">
              ${item.title ? `<strong>${loc(item.title, `action-${idx}-title`)}</strong>` : ""}
              ${item.title && item.detail ? ": " : ""}
              ${item.detail ? loc(item.detail, `action-${idx}-detail`) : ""}
            </li>
          `,
        )
        .join("");
      parts.push(`
        <div class="section">
          <div class="section-title">Actionable Takeaways</div>
          <div class="digest-extras-card">
            <ul class="digest-extras-list">${itemsHtml}</ul>
          </div>
        </div>
      `);
    }

    // 5. Optional Mentioned Resources
    if (
      Array.isArray(analysis.mentionedResources) &&
      analysis.mentionedResources.length
    ) {
      const resHtml = analysis.mentionedResources
        .map(
          (item, idx) => `
            <div class="resource-item">
              <span class="resource-name">${escapeHtml(item.name)}</span>
              ${item.note ? `<span>${loc(item.note, `res-${idx}-note`)}</span>` : ""}
            </div>
          `,
        )
        .join("");
      parts.push(`
        <div class="section">
          <div class="section-title">Mentioned Resources</div>
          <div class="resource-chips">${resHtml}</div>
        </div>
      `);
    }

    // Legacy fallback if an old cached digest only contained chapters
    if (!parts.length && Array.isArray(analysis.chapters) && analysis.chapters.length) {
      parts.push(
        '<div class="digest-placeholder">This cached summary uses the previous format. Click Regenerate to build the new Visual Board and Executive Digest.</div>',
      );
    }

    container.innerHTML = parts.join("");
    container.querySelectorAll("[data-seek-seconds]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const sec = Number(btn.dataset.seekSeconds);
        if (Number.isFinite(sec)) seekTo(sec);
      });
    });
  }

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  const quotesSection = document.getElementById("quotesSection");
  if (quotesList) {
    quotesList.innerHTML = "";
    const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
      (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
    );
    if (quotesSection) {
      quotesSection.style.display = sortedQuotes.length ? "block" : "none";
    }
    sortedQuotes.forEach((quote, index) => {
      const div = document.createElement("div");
      div.className = "quote-item";
      div.dataset.seconds = quote.timestampSeconds;
      div.innerHTML = `
        <div class="quote-text">${renderLocalizedContent(quote.quote, "overview", `quote-${index}`)}</div>
        ${quote.speaker ? `<div class="quote-speaker">${escapeHtml(quote.speaker)}</div>` : ""}
        <div class="quote-meta">
          <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
          <div class="quote-actions">
            <button class="quote-save-note-btn" title="Save this quote as a note">Note</button>
            <button class="quote-copy-btn" title="Copy this quote">Copy</button>
          </div>
        </div>
      `;
      div.addEventListener("click", () => {
        debugLog(
          "[YouTube Digest Panel] Quote clicked:",
          quote.timestamp,
          quote.timestampSeconds,
        );
        seekTo(quote.timestampSeconds);
      });

      const quoteCopyBtn = div.querySelector(".quote-copy-btn");
      quoteCopyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(
            getLocalizedPlainText(quote.quote, "overview", `quote-${index}`),
          );
          quoteCopyBtn.textContent = "Copied";
          setTimeout(() => {
            quoteCopyBtn.textContent = "Copy";
          }, 1500);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

      const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
      quoteSaveNoteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await saveQuoteAsNote(quote, quoteSaveNoteBtn);
      });

      quotesList.appendChild(div);
    });
  }

  if (
    currentTranscriptMode !== "original" &&
    resultTabIsActive("overview")
  ) {
    void translateOverviewContent();
  }
}

function buildOverviewMarkdown(analysis, meta = {}) {
  if (!analysis || typeof analysis !== "object") return "";
  const title = meta.videoTitle || currentVideoTitle || "YouTube Video";
  const channel = meta.channelName || currentChannelName || "";
  const videoId = meta.videoId || currentVideoId || "";
  const baseUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
  const locText = (text, id) => getLocalizedPlainText(text, "overview", id);
  const lines = [];

  lines.push(`# ${locText(analysis.headline || title, "headline")}`);
  if (channel || baseUrl) {
    lines.push(
      `> ${[channel, baseUrl].filter(Boolean).join(" | ")}`,
    );
  }
  lines.push("");

  if (analysis.oneLineThesis) {
    lines.push(locText(analysis.oneLineThesis, "thesis"));
    lines.push("");
  }

  if (Array.isArray(analysis.coreTakeaways) && analysis.coreTakeaways.length) {
    lines.push("## Core Insights");
    analysis.coreTakeaways.forEach((item, idx) => {
      lines.push(`- ${locText(item, `takeaway-${idx}`)}`);
    });
    lines.push("");
  }

  if (analysis.visualBoard && Array.isArray(analysis.visualBoard.blocks)) {
    lines.push(
      `## ${locText(analysis.visualBoard.title || "Visual Board", "board-title")}`,
    );
    lines.push("");
    analysis.visualBoard.blocks.forEach((block, bIdx) => {
      if (block.title) {
        lines.push(`### ${locText(block.title, `board-${bIdx}-title`)}`);
      }
      if (block.type === "card_grid") {
        (block.cards || []).forEach((card, cIdx) => {
          lines.push(
            `**${locText(card.label, `board-${bIdx}-card-${cIdx}-label`)}**`,
          );
          (card.points || []).forEach((pt, pIdx) => {
            lines.push(`- ${locText(pt, `board-${bIdx}-card-${cIdx}-pt-${pIdx}`)}`);
          });
          lines.push("");
        });
      } else if (block.type === "comparison_table" && block.columns?.length) {
        const cols = block.columns.map((col, cIdx) =>
          locText(col, `board-${bIdx}-col-${cIdx}`),
        );
        lines.push(`| ${cols.join(" | ")} |`);
        lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
        (block.rows || []).forEach((row, rIdx) => {
          const cells = block.columns.map((_, cIdx) =>
            locText(Array.isArray(row) ? row[cIdx] || "" : "", `board-${bIdx}-row-${rIdx}-cell-${cIdx}`)
              .replace(/\|/g, "\\|")
              .replace(/\n/g, " "),
          );
          lines.push(`| ${cells.join(" | ")} |`);
        });
        lines.push("");
      } else if (block.type === "process_flow") {
        (block.steps || []).forEach((step, sIdx) => {
          const num = step.step || String(sIdx + 1).padStart(2, "0");
          const ts = step.timestamp ? ` (${step.timestamp})` : "";
          lines.push(
            `${num}. **${locText(step.title, `board-${bIdx}-step-${sIdx}-title`)}**${ts}: ${locText(step.detail || "", `board-${bIdx}-step-${sIdx}-detail`)}`,
          );
        });
        lines.push("");
      } else if (block.type === "metric_strip") {
        (block.metrics || []).forEach((m, mIdx) => {
          const ctx = m.context
            ? ` (${locText(m.context, `board-${bIdx}-metric-${mIdx}-ctx`)})`
            : "";
          lines.push(
            `- **${m.value}** - ${locText(m.label, `board-${bIdx}-metric-${mIdx}-label`)}${ctx}`,
          );
        });
        lines.push("");
      } else if (block.type === "perspective_split") {
        (block.perspectives || []).forEach((p, pIdx) => {
          lines.push(
            `- **${p.speaker || "Perspective"}**: ${locText(p.stance || "", `board-${bIdx}-persp-${pIdx}-stance`)}`,
          );
          (p.arguments || []).forEach((arg, aIdx) => {
            lines.push(`  - ${locText(arg, `board-${bIdx}-persp-${pIdx}-arg-${aIdx}`)}`);
          });
        });
        lines.push("");
      }
    });
  }

  if (Array.isArray(analysis.briefSections) && analysis.briefSections.length) {
    lines.push("## Deep Brief");
    lines.push("");
    analysis.briefSections.forEach((section, sIdx) => {
      lines.push(`### ${locText(section.title, `brief-${sIdx}-title`)}`);
      if (section.lead) {
        lines.push(locText(section.lead, `brief-${sIdx}-lead`));
      }
      lines.push("");
      (section.points || []).forEach((pt, pIdx) => {
        const tsLink =
          pt.timestamp && baseUrl && Number.isFinite(Number(pt.timestampSeconds))
            ? ` ([${pt.timestamp}](${baseUrl}&t=${Number(pt.timestampSeconds)}s))`
            : pt.timestamp
              ? ` (${pt.timestamp})`
              : "";
        lines.push(
          `- **${locText(pt.heading, `brief-${sIdx}-pt-${pIdx}-head`)}**${tsLink}: ${locText(pt.detail || "", `brief-${sIdx}-pt-${pIdx}-detail`)}`,
        );
      });
      lines.push("");
    });
  }

  if (Array.isArray(analysis.keyQuotes) && analysis.keyQuotes.length) {
    lines.push("## Key Quotes");
    analysis.keyQuotes.forEach((q, idx) => {
      const who = q.speaker ? ` - ${q.speaker}` : "";
      lines.push(
        `> "${locText(q.quote, `quote-${idx}`)}"${who} (${q.timestamp})`,
      );
      lines.push("");
    });
  }

  if (Array.isArray(analysis.actionableItems) && analysis.actionableItems.length) {
    lines.push("## Actionable Takeaways");
    analysis.actionableItems.forEach((item, idx) => {
      lines.push(
        `- **${locText(item.title, `action-${idx}-title`)}**: ${locText(item.detail || "", `action-${idx}-detail`)}`,
      );
    });
    lines.push("");
  }

  if (
    Array.isArray(analysis.mentionedResources) &&
    analysis.mentionedResources.length
  ) {
    lines.push("## Mentioned Resources");
    analysis.mentionedResources.forEach((item, idx) => {
      lines.push(`- **${item.name}**: ${locText(item.note || "", `res-${idx}-note`)}`);
    });
    lines.push("");
  }

  return lines.join("\n").trim();
}

function buildStandaloneOverviewHtml(analysis, meta = {}) {
  const title = meta.videoTitle || currentVideoTitle || "YouTube Digest";
  const channel = meta.channelName || currentChannelName || "";
  const videoId = meta.videoId || currentVideoId || "";
  const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
  const loc = (text, id) =>
    escapeHtml(getLocalizedPlainText(text || "", "overview", id));

  const tsAnchor = (ts, sec) => {
    if (!ts) return "";
    if (watchUrl && Number.isFinite(Number(sec))) {
      return `<a class="ts-link" href="${escapeHtml(`${watchUrl}&t=${Number(sec)}s`)}" target="_blank" rel="noreferrer">${escapeHtml(ts)}</a>`;
    }
    return `<span class="ts-link">${escapeHtml(ts)}</span>`;
  };

  const boardHtml = analysis?.visualBoard
    ? renderVisualBoardMarkup(analysis.visualBoard, loc).replace(
        /<button class="inline-ts-btn" type="button" data-seek-seconds="(\d+)">([^<]+)<\/button>/g,
        (_m, sec, ts) => tsAnchor(ts, Number(sec)),
      )
    : "";

  const takeawaysHtml = (analysis?.coreTakeaways || []).length
    ? `<div class="takeaways"><div class="label">Core Insights</div><ul>${analysis.coreTakeaways
        .map((item, idx) => `<li>${loc(item, `takeaway-${idx}`)}</li>`)
        .join("")}</ul></div>`
    : "";

  const briefHtml = (analysis?.briefSections || [])
    .map(
      (sec, sIdx) => `
      <article class="brief-card">
        <h3>${loc(sec.title, `brief-${sIdx}-title`)}</h3>
        ${sec.lead ? `<p class="lead">${loc(sec.lead, `brief-${sIdx}-lead`)}</p>` : ""}
        <ul>
          ${(sec.points || [])
            .map(
              (pt, pIdx) => `
              <li>
                <div class="pt-head"><strong>${loc(pt.heading, `brief-${sIdx}-pt-${pIdx}-head`)}</strong>${tsAnchor(pt.timestamp, pt.timestampSeconds)}</div>
                ${pt.detail ? `<p>${loc(pt.detail, `brief-${sIdx}-pt-${pIdx}-detail`)}</p>` : ""}
              </li>`,
            )
            .join("")}
        </ul>
      </article>`,
    )
    .join("");

  const quotesHtml = (analysis?.keyQuotes || []).length
    ? `<section class="section"><h2>Key Quotes</h2>${analysis.keyQuotes
        .map(
          (q, idx) => `
          <blockquote class="quote">
            <p>${loc(q.quote, `quote-${idx}`)}</p>
            <footer>${q.speaker ? `<span>${escapeHtml(q.speaker)}</span>` : ""}${tsAnchor(q.timestamp, q.timestampSeconds)}</footer>
          </blockquote>`,
        )
        .join("")}</section>`
    : "";

  const actionsHtml = (analysis?.actionableItems || []).length
    ? `<section class="section"><h2>Actionable Takeaways</h2><ul class="extras">${analysis.actionableItems
        .map(
          (it, idx) =>
            `<li><strong>${loc(it.title, `action-${idx}-title`)}</strong>: ${loc(it.detail, `action-${idx}-detail`)}</li>`,
        )
        .join("")}</ul></section>`
    : "";

  const resourcesHtml = (analysis?.mentionedResources || []).length
    ? `<section class="section"><h2>Mentioned Resources</h2><ul class="extras">${analysis.mentionedResources
        .map(
          (it, idx) =>
            `<li><strong>${escapeHtml(it.name)}</strong>: ${loc(it.note, `res-${idx}-note`)}</li>`,
        )
        .join("")}</ul></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(analysis?.headline || title)} - YouTube Digest</title>
<style>
  :root { --bg:#f7f3ec; --surface:#fff; --raised:#fbf8f2; --border:#e6ded0; --text:#2e2a24; --muted:#6b6258; --accent:#c8674f; --sage:#7c8b6f; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.65 system-ui,-apple-system,sans-serif; padding:36px 20px 64px; }
  .page { max-width:980px; margin:0 auto; }
  header { background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:28px 30px; margin-bottom:22px; }
  .eyebrow { color:var(--accent); font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; margin-bottom:8px; }
  h1 { font-size:26px; line-height:1.25; margin-bottom:10px; }
  .meta { font-size:13px; color:var(--muted); margin-bottom:14px; }
  .meta a { color:var(--accent); text-decoration:none; }
  .thesis { font-size:15px; color:var(--muted); }
  .takeaways { margin-top:18px; padding:16px 18px; border-radius:12px; background:#fbf4ef; border:1px solid #eedad1; }
  .takeaways .label { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--accent); margin-bottom:8px; }
  .takeaways ul { padding-left:18px; }
  .takeaways li { margin:5px 0; }
  .visual-board { background:var(--surface); border:1px solid #ddd4c4; border-radius:18px; padding:24px 26px; margin-bottom:26px; box-shadow:0 8px 28px rgba(60,50,35,.06); }
  .visual-board-header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding-bottom:14px; margin-bottom:18px; border-bottom:1px solid var(--border); }
  .visual-board-title { font-size:18px; font-weight:700; }
  .visual-board-eyebrow { font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); }
  .board-block { margin-bottom:22px; }
  .board-block:last-child { margin-bottom:0; }
  .board-block-title { font-size:14px; font-weight:700; margin-bottom:11px; padding-left:10px; border-left:3px solid var(--accent); }
  .board-card-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; }
  .board-card { border:1px solid var(--border); border-radius:12px; overflow:hidden; background:#fff; }
  .board-card-head { padding:10px 14px; font-weight:700; font-size:13.5px; border-bottom:1px solid var(--border); }
  .tone-terracotta .board-card-head { background:#faece6; color:#8f3f2d; }
  .tone-sage .board-card-head { background:#eef3ea; color:#4b5d3f; }
  .tone-sand .board-card-head { background:#f7f0e2; color:#705832; }
  .tone-slate .board-card-head { background:#edf1f5; color:#3d5166; }
  .board-card-points { list-style:disc; padding:12px 16px 14px 30px; font-size:13.5px; color:var(--muted); }
  .board-card-points li { margin:4px 0; }
  .board-table-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:12px; }
  .board-table { width:100%; border-collapse:collapse; font-size:13.5px; }
  .board-table th { background:var(--raised); text-align:left; padding:10px 14px; border-bottom:1px solid var(--border); }
  .board-table td { padding:10px 14px; border-bottom:1px solid var(--border); color:var(--muted); vertical-align:top; }
  .board-table td:first-child { font-weight:600; color:var(--text); background:#fcfaf6; }
  .board-flow { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
  .board-flow-step { padding:14px; border:1px solid var(--border); border-radius:12px; background:var(--raised); display:flex; gap:10px; }
  .board-flow-num { background:var(--accent); color:#fff; font-family:ui-monospace,monospace; font-size:12px; font-weight:700; padding:2px 8px; border-radius:6px; height:fit-content; }
  .board-flow-title { font-weight:700; font-size:13.5px; }
  .board-flow-detail { font-size:13px; color:var(--muted); margin-top:4px; }
  .board-metric-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .board-metric-card { padding:14px 16px; border:1px solid var(--border); border-radius:12px; background:linear-gradient(180deg,#fff,#fbf7f1); }
  .board-metric-value { font-size:22px; font-weight:700; color:var(--accent); }
  .board-metric-label { font-weight:700; font-size:13px; margin:4px 0; }
  .board-metric-context { font-size:12.5px; color:var(--muted); }
  .board-perspective-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
  .board-perspective-card { padding:14px 16px; border:1px solid var(--border); border-top:3px solid var(--sage); border-radius:12px; background:#fff; }
  .board-perspective-card:first-child { border-top-color:var(--accent); }
  .board-perspective-speaker { font-size:11px; font-weight:700; text-transform:uppercase; color:var(--muted); }
  .board-perspective-stance { font-weight:700; margin:4px 0 8px; }
  .board-perspective-args { padding-left:18px; font-size:13.5px; color:var(--muted); }
  .section { margin-bottom:26px; }
  .section h2 { font-size:20px; margin-bottom:14px; }
  .brief-card { background:var(--surface); border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:14px; padding:20px 22px; margin-bottom:14px; }
  .brief-card h3 { font-size:17px; margin-bottom:6px; }
  .brief-card .lead { color:var(--muted); padding-bottom:10px; margin-bottom:12px; border-bottom:1px solid var(--border); }
  .brief-card ul { list-style:none; display:flex; flex-direction:column; gap:12px; }
  .pt-head { display:flex; justify-content:space-between; align-items:baseline; gap:10px; margin-bottom:3px; }
  .brief-card li p { color:var(--muted); font-size:14px; }
  .ts-link { font-family:ui-monospace,monospace; font-size:11.5px; font-weight:600; color:var(--accent); background:rgba(200,103,79,.1); padding:2px 8px; border-radius:999px; text-decoration:none; white-space:nowrap; }
  .quote { background:var(--surface); border-left:4px solid var(--accent); border-radius:12px; padding:16px 20px; margin-bottom:12px; }
  .quote footer { margin-top:8px; display:flex; justify-content:space-between; font-size:12.5px; color:var(--muted); }
  .extras { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:18px 22px 18px 36px; color:var(--muted); }
  .extras li { margin:6px 0; }
  .extras strong { color:var(--text); }
</style>
</head>
<body>
<main class="page">
  <header>
    <div class="eyebrow">YouTube Digest / Executive Brief</div>
    <h1>${loc(analysis?.headline || title, "headline")}</h1>
    <div class="meta">${escapeHtml(channel)}${watchUrl ? ` · <a href="${escapeHtml(watchUrl)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>` : ""}</div>
    ${analysis?.oneLineThesis ? `<p class="thesis">${loc(analysis.oneLineThesis, "thesis")}</p>` : ""}
    ${takeawaysHtml}
  </header>
  ${boardHtml}
  ${briefHtml ? `<section class="section"><h2>Deep Brief</h2>${briefHtml}</section>` : ""}
  ${quotesHtml}
  ${actionsHtml}
  ${resourcesHtml}
</main>
</body>
</html>`;
}

function copyOverviewMarkdown() {
  if (!currentAnalysis) return;
  const md = buildOverviewMarkdown(currentAnalysis);
  copyToClipboardWithFeedback(md, "copyOverviewMdBtn");
}

function exportOverviewHtml() {
  if (!currentAnalysis) return;
  const htmlDoc = buildStandaloneOverviewHtml(currentAnalysis);
  const blob = new Blob([htmlDoc], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(currentVideoTitle)}-digest.html`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Reapply an active query after a language mode rerenders the transcript.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

// ============================================================
// TRANSCRIPT SEARCH
// ============================================================

/**
 * Finds separate, case-insensitive literal matches. A literal search is
 * important here because punctuation such as "." must be treated as transcript
 * text, not as a regular expression command.
 */
function findLiteralTranscriptMatches(text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) return [];

  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escapedNeedle, "giu");
  const matches = [];
  for (const match of source.matchAll(matcher)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/**
 * Removes old marks before a new search. Restoring plain text first prevents
 * nested marks when the user types one more letter into the search field.
 */
function clearTranscriptSearchHighlights() {
  document
    .querySelectorAll("#transcriptList mark.transcript-search-highlight")
    .forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    });

  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));
}

/**
 * Replaces matching parts of one text node with mark elements. We collect all
 * text nodes before changing the DOM, so each replacement is safe and stable.
 */
function markTranscriptTextNode(textNode, query) {
  const ranges = findLiteralTranscriptMatches(textNode.nodeValue, query);
  if (!ranges.length) return [];

  const fragment = document.createDocumentFragment();
  const marks = [];
  let cursor = 0;

  ranges.forEach(({ start, end }) => {
    if (start > cursor) {
      fragment.appendChild(
        document.createTextNode(textNode.nodeValue.slice(cursor, start)),
      );
    }

    const mark = document.createElement("mark");
    mark.className = "transcript-search-highlight";
    mark.textContent = textNode.nodeValue.slice(start, end);
    fragment.appendChild(mark);
    marks.push(mark);
    cursor = end;
  });

  if (cursor < textNode.nodeValue.length) {
    fragment.appendChild(
      document.createTextNode(textNode.nodeValue.slice(cursor)),
    );
  }

  textNode.parentNode.replaceChild(fragment, textNode);
  return marks;
}

/**
 * Updates the result count and navigation buttons from the current search
 * state. The live output gives the same information to screen reader users.
 */
function updateTranscriptSearchControls(query) {
  const count = document.getElementById("transcriptSearchCount");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  const hasMatches = transcriptSearchMatches.length > 0;

  if (count) {
    count.textContent = !query
      ? ""
      : hasMatches
        ? `${transcriptSearchIndex + 1} of ${transcriptSearchMatches.length}`
        : "No matches";
  }
  if (previous) previous.disabled = !hasMatches;
  if (next) next.disabled = !hasMatches;
}

/**
 * Shows which match is current. Search navigation pauses automatic transcript
 * following, so playback cannot pull the user away from the result they found.
 */
function revealCurrentTranscriptSearchMatch({ scroll = true } = {}) {
  transcriptSearchMatches.forEach((mark) => mark.classList.remove("current"));
  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));

  const mark = transcriptSearchMatches[transcriptSearchIndex];
  if (!mark) return;

  mark.classList.add("current");
  mark.closest(".transcript-entry")?.classList.add("search-current");

  if (!scroll) return;
  if (autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Searches the transcript that is visible now. This means Original searches
 * source subtitles, Chinese searches translated text, and Bilingual searches
 * both columns. Translated rows call this again as their text arrives.
 */
function refreshTranscriptSearch({ preserveIndex = false, scroll = true } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const query = String(input?.value || "").trim();
  const previousIndex = transcriptSearchIndex;

  clearTranscriptSearchHighlights();
  transcriptSearchMatches = [];
  transcriptSearchIndex = -1;
  if (clearButton) clearButton.hidden = !input?.value;

  if (!query) {
    updateTranscriptSearchControls(query);
    return;
  }

  document
    .querySelectorAll("#transcriptList .transcript-entry")
    .forEach((row) => {
      const content = row.querySelector(".transcript-text, .transcript-copy");
      if (!content) return;

      const textNodes = [];
      const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!node.nodeValue || parent?.closest("button")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => {
        transcriptSearchMatches.push(...markTranscriptTextNode(node, query));
      });
    });

  if (transcriptSearchMatches.length) {
    transcriptSearchIndex = preserveIndex
      ? Math.min(Math.max(previousIndex, 0), transcriptSearchMatches.length - 1)
      : 0;
    revealCurrentTranscriptSearchMatch({ scroll });
  }
  updateTranscriptSearchControls(query);
}

/**
 * Moves through results in a loop, like the browser's built-in Find control.
 */
function moveTranscriptSearch(direction) {
  if (!transcriptSearchMatches.length) return;
  transcriptSearchIndex =
    (transcriptSearchIndex + direction + transcriptSearchMatches.length) %
    transcriptSearchMatches.length;
  revealCurrentTranscriptSearchMatch();
  updateTranscriptSearchControls(
    document.getElementById("transcriptSearchInput")?.value.trim(),
  );
}

/**
 * Clears search when the user opens a different video. A query for the old
 * video is unlikely to help and can make the next transcript look empty.
 */
function resetTranscriptSearch({ focus = false } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  refreshTranscriptSearch({ scroll: false });
  if (focus) input?.focus();
}

/**
 * Wires mouse and keyboard controls once when the side panel starts.
 */
function setupTranscriptSearch() {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  if (!input) return;

  input.addEventListener("input", () => refreshTranscriptSearch());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveTranscriptSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      resetTranscriptSearch({ focus: true });
    }
  });

  clearButton?.addEventListener("click", () => {
    resetTranscriptSearch({ focus: true });
  });
  previous?.addEventListener("click", () => moveTranscriptSearch(-1));
  next?.addEventListener("click", () => moveTranscriptSearch(1));
}

function getDisplayedChaptersText() {
  if (!Array.isArray(currentChapters) || !currentChapters.length) return "";
  return currentChapters
    .map((chapter, index) => {
      const title = getLocalizedPlainText(
        chapter.title,
        "chapters",
        `chapter-${index}-title`,
      );
      const summary = getLocalizedPlainText(
        chapter.summary || "",
        "chapters",
        `chapter-${index}-summary`,
      );
      return `[${chapter.timestamp}] ${title}\n${summary}`.trim();
    })
    .join("\n\n");
}

function getDisplayedTranscriptText() {
  if (currentTranscriptView === "timeline") {
    return getDisplayedChaptersText();
  }
  if (currentTranscriptMode === "original") return currentTranscriptText || "";
  return getActiveTranscriptSegments()
    .map((segment) => {
      const translated = transcriptParagraphCache.get(
        transcriptTranslationCacheKey(segment),
      );
      if (currentTranscriptMode === "zh") return translated || segment.text;
      return translated ? `${segment.text}\n${translated}` : segment.text;
    })
    .join("\n\n");
}

function copyTranscript() {
  copyToClipboardWithFeedback(getDisplayedTranscriptText(), "copyTranscriptBtn");
}

function exportTranscript() {
  const isTimeline = currentTranscriptView === "timeline";
  const transcriptContent = getDisplayedTranscriptText();
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `${isTimeline ? "TIMELINE CHAPTERS" : "TRANSCRIPT"}\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `${isTimeline ? "CHAPTERS" : "TRANSCRIPT"}:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YouTube Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-${isTimeline ? "timeline" : "transcript"}.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";
  document.getElementById("transcriptModeControl").style.display =
    state === "results" ? "inline-flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YouTube Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function applyTranscriptViewUi(viewMode) {
  const normalized = viewMode === "timeline" ? "timeline" : "subtitles";
  currentTranscriptView = normalized;

  document.querySelectorAll(".transcript-view-btn").forEach((button) => {
    const active = button.dataset.transcriptView === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const subtitlesView = document.getElementById("transcriptSubtitlesView");
  const timelineView = document.getElementById("transcriptTimelineView");
  const regenChaptersBtn = document.getElementById("regenerateChaptersBtn");
  if (subtitlesView) {
    subtitlesView.hidden = normalized !== "subtitles";
    subtitlesView.classList.toggle("active", normalized === "subtitles");
  }
  if (timelineView) {
    timelineView.hidden = normalized !== "timeline";
    timelineView.classList.toggle("active", normalized === "timeline");
  }
  if (regenChaptersBtn) {
    regenChaptersBtn.hidden = normalized !== "timeline";
  }
}

function switchTranscriptView(viewMode) {
  const normalized = viewMode === "timeline" ? "timeline" : "subtitles";
  if (normalized === currentTranscriptView) return;

  if (currentTranscriptView === "subtitles") {
    captureCurrentTranscriptScrollTop();
    dismissSelectionActions(true);
    stopPlaybackTracking();
  }

  applyTranscriptViewUi(normalized);

  if (normalized === "timeline") {
    if (!currentChapters && !isChaptersLoading) {
      void triggerChaptersAnalysis();
    } else if (currentChapters) {
      renderChaptersList(currentChapters, {
        reasoning: currentChaptersReasoning,
        usage: currentChaptersUsage,
      });
    }
  } else {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      if (!contentArea || !transcriptTabIsActive()) return;
      lastAutoScrollTime = Date.now();
      contentArea.scrollTop = lastTranscriptScrollTop;
    });
    startPlaybackTracking();
    if (currentTranscriptMode !== "original" && !transcriptScrollObserver) {
      void translateTranscript();
    }
  }
}

function switchTab(tabName) {
  // Capture the transcript position before another tab reuses the same scroll
  // area. Scrolling Overview or Notes must not replace this value.
  if (tabName !== "transcript" && transcriptTabIsActive()) {
    captureCurrentTranscriptScrollTop();
    dismissSelectionActions(true);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    if (currentTranscriptView === "subtitles") {
      // Notes always opens at the top, so restore the independent transcript
      // reading position when the user returns here.
      requestAnimationFrame(() => {
        const contentArea = document.getElementById("contentArea");
        if (!contentArea || !transcriptTabIsActive()) return;
        lastAutoScrollTime = Date.now();
        contentArea.scrollTop = lastTranscriptScrollTop;
      });
      startPlaybackTracking();
    } else {
      stopPlaybackTracking();
    }
  } else {
    stopPlaybackTracking();
  }

  // Saved notes are stored newest first. Open Notes at the top so the note the
  // user just created is the first item they see.
  if (tabName === "notes") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      const notesPanelIsActive = document.querySelector(
        '.tab-panel[data-panel="notes"].active',
      );
      if (contentArea && notesPanelIsActive) contentArea.scrollTop = 0;
    });
  }

  // Translate only the visible tab. This prevents hidden surfaces from using
  // tokens or competing with the batch queue the user is waiting for.
  if (tabName === "overview") {
    if (!currentAnalysis && !isAnalysisLoading) {
      triggerAnalysis();
    } else if (currentAnalysis && currentTranscriptMode !== "original") {
      void translateOverviewContent();
    }
  } else if (
    tabName === "notes" &&
    currentTranscriptMode !== "original"
  ) {
    void translateNotesContent();
  } else if (tabName === "transcript") {
    if (currentTranscriptView === "timeline") {
      if (!currentChapters && !isChaptersLoading) {
        void triggerChaptersAnalysis();
      } else if (currentChapters && currentTranscriptMode !== "original") {
        void translateChaptersContent();
      }
    } else if (
      currentTranscriptMode !== "original" &&
      !transcriptScrollObserver
    ) {
      void translateTranscript();
    }
  }
}

/**
 * Triggers Timeline Chapters generation (lazy-loaded when switching Transcript to Timeline).
 */
async function triggerChaptersAnalysis({ force = false } = {}) {
  if (!currentTranscriptTimestamped || isChaptersLoading) return;
  if (currentChapters && !force) return;

  isChaptersLoading = true;
  if (force) {
    currentChapters = null;
    currentChaptersReasoning = "";
    currentChaptersUsage = null;
  }

  const requestId = `chapters_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeChaptersRequestId = requestId;
  renderChaptersThinkingSection({
    visible: true,
    open: true,
    status: "Thinking...",
    meta: "",
    text: "",
  });

  const chapterList = document.getElementById("chapterList");
  if (chapterList) {
    chapterList.innerHTML =
      '<li class="chapter-item chapter-placeholder">Generating proportional timeline chapters...</li>';
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "analyzeChapters",
      requestId,
      videoId: currentVideoId,
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (activeChaptersRequestId === requestId) {
      activeChaptersRequestId = null;
    }

    if (!result?.success) {
      const outputEl = document.getElementById("chaptersThinkingOutput");
      if (outputEl?.textContent) {
        const statusEl = document.getElementById("chaptersThinkingStatus");
        if (statusEl) statusEl.textContent = "Thinking interrupted";
      } else {
        renderChaptersThinkingSection({ visible: false });
      }
      if (chapterList) {
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Timeline failed: ${escapeHtml(result?.message || result?.error || "Unknown error")}</li>`;
      }
      isChaptersLoading = false;
      return;
    }

    currentChapters = result.chapters || [];
    currentChaptersReasoning = result.reasoning || "";
    currentChaptersUsage = result.usage || null;
    renderChaptersList(currentChapters, {
      reasoning: currentChaptersReasoning,
      usage: currentChaptersUsage,
    });
    if (result.keyMoments?.length) {
      highlightMomentsOnPage(result.keyMoments);
    }
    await saveToCache(currentVideoId);
  } catch (error) {
    if (activeChaptersRequestId === requestId) {
      activeChaptersRequestId = null;
    }
    renderChaptersThinkingSection({ visible: false });
    console.error("[YouTube Digest Panel] Chapters error:", error);
    if (chapterList) {
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Error: ${escapeHtml(error.message)}</li>`;
    }
  }

  isChaptersLoading = false;
}

/**
 * Triggers the Executive Digest LLM analysis (lazy-loaded when user clicks Overview tab).
 */
async function triggerAnalysis({ force = false } = {}) {
  if (!currentTranscriptTimestamped || isAnalysisLoading) return;
  if (currentAnalysis && !force) return;

  isAnalysisLoading = true;
  if (force) {
    currentAnalysis = null;
  }

  const requestId = `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeAnalysisRequestId = requestId;
  renderThinkingSection({
    visible: true,
    open: true,
    status: "Thinking...",
    meta: "",
    text: "",
  });

  const digestContainer = document.getElementById("overviewDigestContainer");
  const quotesList = document.getElementById("quotesList");
  const exportBtn = document.getElementById("exportOverviewHtmlBtn");
  const copyMdBtn = document.getElementById("copyOverviewMdBtn");
  if (exportBtn) exportBtn.disabled = true;
  if (copyMdBtn) copyMdBtn.disabled = true;

  if (digestContainer) {
    digestContainer.innerHTML =
      '<div class="digest-placeholder">Synthesizing visual board and deep executive digest...</div>';
  }
  if (quotesList) {
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Extracting key quotes...</div>';
  }

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      requestId,
      videoId: currentVideoId,
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (activeAnalysisRequestId === requestId) {
      activeAnalysisRequestId = null;
    }

    if (!analysisResult.success) {
      const outputEl = document.getElementById("thinkingOutput");
      if (outputEl?.textContent) {
        const statusEl = document.getElementById("thinkingStatus");
        if (statusEl) statusEl.textContent = "Thinking interrupted";
      } else {
        renderThinkingSection({ visible: false });
      }
      if (digestContainer) {
        digestContainer.innerHTML = `<div class="digest-placeholder" style="color: var(--accent);">Analysis failed: ${escapeHtml(analysisResult.message || analysisResult.error || "Unknown error")}</div>`;
      }
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    if (activeAnalysisRequestId === requestId) {
      activeAnalysisRequestId = null;
    }
    const outputEl = document.getElementById("thinkingOutput");
    if (outputEl?.textContent) {
      const statusEl = document.getElementById("thinkingStatus");
      if (statusEl) statusEl.textContent = "Thinking interrupted";
    } else {
      renderThinkingSection({ visible: false });
    }
    console.error("[YouTube Digest Panel] Analysis error:", error);
    if (digestContainer) {
      digestContainer.innerHTML = `<div class="digest-placeholder" style="color: var(--accent);">Error: ${escapeHtml(error.message)}</div>`;
    }
  }

  isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YouTube Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION ACTIONS
// ============================================================

/**
 * Hides actions that belong only to a live transcript selection. Clearing the
 * browser range also prevents the toolbar from returning on another tab.
 */
function dismissSelectionActions(clearSelection = false) {
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip) tooltip.style.display = "none";
  if (clearSelection) window.getSelection()?.removeAllRanges();
}

/**
 * Sets up text selection handling in the transcript.
 * When the user selects text, shows Explain and Note actions.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // This setup can run again after a cached transcript render. Abort old
  // document listeners so one selection creates only one action toolbar.
  selectionActionsController?.abort();
  selectionActionsController = new AbortController();
  const selectionSignal = selectionActionsController.signal;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create one small toolbar for actions on the selected transcript text.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.setAttribute("role", "toolbar");
  tooltip.setAttribute("aria-label", "Selected transcript actions");
  tooltip.innerHTML = `
    <button class="explain-btn" type="button">Explain</button>
    <button class="selection-note-btn" type="button">Note</button>
  `;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";
  let selectedTimestamp = 0;

  // Interacting with either action must preserve the transcript selection and
  // stay isolated from document and row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener(
    "mouseup",
    () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

      // Both ends must be inside the transcript. The first selected row
      // supplies the timestamp when the selection spans more than one row.
      const isInTranscript = Boolean(
        range &&
          transcriptList.contains(range.startContainer) &&
          transcriptList.contains(range.endContainer),
      );

      // Allow any selection length.
      if (text.length > 0 && isInTranscript) {
        selectedText = text;
        const startElement =
          range.startContainer.nodeType === 1
            ? range.startContainer
            : range.startContainer.parentElement;
        const selectedRow = startElement?.closest(".transcript-entry");
        const rowSeconds = Number(selectedRow?.dataset.seconds);
        selectedTimestamp = Number.isFinite(rowSeconds) ? rowSeconds : 0;

        // Set the final coordinates while the toolbar is still hidden. If it
        // becomes visible first, Chrome paints it at its default left edge for
        // one frame before moving it to the selection center.
        const rect = range.getBoundingClientRect();
        tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.display = "flex";
      } else {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Hide tooltip when clicking elsewhere
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!tooltip.contains(event.target)) {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });

  // Save the exact selected words at the first selected transcript row. This
  // action does not move playback and does not ask the AI to rewrite the text.
  tooltip
    .querySelector(".selection-note-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText || !currentVideoId) return;

      const button = event.currentTarget;
      const originalText = button.textContent;
      button.textContent = "Saving...";
      button.disabled = true;

      try {
        const result = await chrome.runtime.sendMessage({
          action: "saveNote",
          videoId: currentVideoId,
          timestamp: selectedTimestamp,
          videoTitle: currentVideoTitle,
          channelName: currentChannelName,
          selectedText,
        });

        if (!result?.success) {
          throw new Error(result?.error || "Could not save note");
        }

        button.textContent = "Saved";
        loadNotes(currentVideoId);
        setTimeout(() => {
          tooltip.style.display = "none";
          button.textContent = originalText;
          button.disabled = false;
        }, 900);
      } catch (error) {
        console.error("[YouTube Digest] Save selected note error:", error);
        button.textContent = "Error";
        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
        }, 1500);
      }
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">Close</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }
    const interfaceCacheForVideo = {};
    for (const [key, value] of interfaceTranslationCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        interfaceCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      chapters: currentChapters,
      chaptersReasoning: currentChaptersReasoning,
      chaptersUsage: currentChaptersUsage,
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      interfaceCache: interfaceCacheForVideo,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      currentNotes = result.notes || [];
      currentNotesFilterVideoId = videoId;
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click Note to save."
      : "No notes saved yet. Hover over a video and click Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note, index) => {
    const translationId = getNoteTranslationId(note, index);
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
      </div>
      <div class="note-text">${renderLocalizedContent(note.text, "notes", translationId)}</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">Play</button>
        <button class="note-delete" data-id="${escapeHtml(note.id)}" type="button" aria-label="Delete note" title="Delete note">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="m19 6-1 14H6L5 6"></path>
            <path d="M10 11v5"></path>
            <path d="M14 11v5"></path>
          </svg>
        </button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(
            getLocalizedPlainText(note.text, "notes", translationId),
          );
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });

  if (currentTranscriptMode !== "original" && resultTabIsActive("notes")) {
    void translateNotesContent();
  }
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  const willRestoreReadingPosition =
    pendingTranscriptViewState?.videoId === currentVideoId;
  autoScrollEnabled = !willRestoreReadingPosition;
  document.getElementById("followPlaybackBtn").style.display =
    willRestoreReadingPosition ? "block" : "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  scheduleTranscriptViewStateSave();

  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

/**
 * Uses session storage when it is available. Local storage is a safe fallback
 * for older test or browser environments that do not expose session storage.
 */
function getTranscriptViewStateStorage() {
  return chrome.storage.session || chrome.storage.local;
}

/**
 * Reads one video's last visible transcript position.
 */
async function loadTranscriptViewState(videoId) {
  if (!videoId) return null;
  try {
    const result = await getTranscriptViewStateStorage().get(
      TRANSCRIPT_VIEW_STATE_KEY,
    );
    const state = result?.[TRANSCRIPT_VIEW_STATE_KEY]?.[videoId];
    const scrollTop = Number(state?.scrollTop);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
    return { videoId, scrollTop };
  } catch (error) {
    console.error("[YouTube Digest] Reading position load error:", error);
    return null;
  }
}

/**
 * Stores positions for a small recent set of videos. This prevents one value
 * from growing without a limit during a long Chrome session.
 */
async function saveTranscriptViewState(videoId, scrollTop) {
  if (!videoId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    const storage = getTranscriptViewStateStorage();
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const states = result?.[TRANSCRIPT_VIEW_STATE_KEY] || {};
    states[videoId] = { scrollTop, updatedAt: Date.now() };

    const recentStates = Object.fromEntries(
      Object.entries(states)
        .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 20),
    );
    await storage.set({ [TRANSCRIPT_VIEW_STATE_KEY]: recentStates });
  } catch (error) {
    console.error("[YouTube Digest] Reading position save error:", error);
  }
}

/**
 * Saves the visible position after scrolling stops. Capturing the video ID and
 * position now prevents a later video change from writing the wrong state.
 */
function scheduleTranscriptViewStateSave() {
  if (
    isRestoringTranscriptView ||
    !currentVideoId ||
    !transcriptTabIsActive()
  ) {
    return;
  }
  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return;

  const videoId = currentVideoId;
  const scrollTop = contentArea.scrollTop;
  lastTranscriptScrollTop = scrollTop;
  clearTimeout(transcriptViewStateSaveTimer);
  transcriptViewStateSaveTimer = setTimeout(() => {
    void saveTranscriptViewState(videoId, scrollTop);
  }, 150);
}

/**
 * Saves immediately before the panel closes.
 */
function saveCurrentTranscriptViewState() {
  clearTimeout(transcriptViewStateSaveTimer);
  const contentArea = document.getElementById("contentArea");
  if (!currentVideoId || !contentArea) return Promise.resolve();
  if (transcriptTabIsActive()) captureCurrentTranscriptScrollTop();
  return saveTranscriptViewState(currentVideoId, lastTranscriptScrollTop);
}

/**
 * Returns true only while the Transcript tab is the visible results panel.
 */
function transcriptTabIsActive() {
  return resultTabIsActive("transcript");
}

function resultTabIsActive(tabName) {
  return Boolean(
    document.querySelector(
      `.tab-panel[data-panel="${CSS.escape(tabName)}"].active`,
    ),
  );
}

/**
 * Copies the shared scroll area's current value into transcript-only state.
 */
function captureCurrentTranscriptScrollTop() {
  if (currentTranscriptView !== "subtitles") return;
  const contentArea = document.getElementById("contentArea");
  if (contentArea) lastTranscriptScrollTop = contentArea.scrollTop;
}

/**
 * Restores the saved position after the transcript becomes visible. Follow
 * Playback stays paused, so the next timer tick cannot move the panel again.
 */
function restorePendingTranscriptViewState(videoId) {
  const state = pendingTranscriptViewState;
  pendingTranscriptViewState = null;
  const contentArea = document.getElementById("contentArea");
  if (!state || state.videoId !== videoId) {
    contentArea?.classList.remove("restoring-transcript-view");
    return;
  }

  requestAnimationFrame(() => {
    if (currentVideoId !== videoId || !contentArea) {
      contentArea?.classList.remove("restoring-transcript-view");
      return;
    }

    isRestoringTranscriptView = true;
    lastAutoScrollTime = Date.now();
    autoScrollEnabled = false;
    contentArea.scrollTop = state.scrollTop;
    lastTranscriptScrollTop = state.scrollTop;
    document.getElementById("followPlaybackBtn").style.display = "block";
    contentArea.classList.remove("restoring-transcript-view");
    requestAnimationFrame(() => {
      isRestoringTranscriptView = false;
    });
  });
}

// ============================================================
// UNIVERSAL DISPLAY LANGUAGE — Original / Chinese / aligned bilingual
// ============================================================

async function loadDisplayLanguageMode(videoId) {
  if (!videoId) {
    setTranscriptModeButtons("original");
    return "original";
  }
  try {
    const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
    const mode = stored?.[DISPLAY_LANGUAGE_MODE_KEY]?.[videoId]?.mode;
    currentTranscriptMode = DISPLAY_LANGUAGE_MODES.has(mode)
      ? mode
      : "original";
  } catch (error) {
    currentTranscriptMode = "original";
  }
  setTranscriptModeButtons(currentTranscriptMode);
  return currentTranscriptMode;
}

async function saveDisplayLanguageMode(videoId, mode) {
  if (!videoId || !DISPLAY_LANGUAGE_MODES.has(mode)) return;
  const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
  const modes = stored?.[DISPLAY_LANGUAGE_MODE_KEY] || {};
  modes[videoId] = { mode, updatedAt: Date.now() };
  const recentModes = Object.fromEntries(
    Object.entries(modes)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50),
  );
  await chrome.storage.local.set({
    [DISPLAY_LANGUAGE_MODE_KEY]: recentModes,
  });
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleDisplayLanguageModeChange(mode) {
  if (!DISPLAY_LANGUAGE_MODES.has(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  await saveDisplayLanguageMode(currentVideoId, mode);
  if (mode !== "original") interfaceTranslationFailures.clear();
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);
  const activeTabName =
    document.querySelector(".tab.active")?.dataset.tab || "transcript";

  if (mode === "original") {
    renderTranscript();
    if (currentChapters) {
      renderChaptersList(currentChapters, {
        reasoning: currentChaptersReasoning,
        usage: currentChaptersUsage,
      });
    }
    if (currentAnalysis) renderAnalysisResults(currentAnalysis);
    if (currentNotes.length) renderNotes(currentNotes, currentNotesFilterVideoId);
    return;
  }

  if (currentChapters) {
    renderChaptersList(currentChapters, {
      reasoning: currentChaptersReasoning,
      usage: currentChaptersUsage,
    });
  }
  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  }
  if (currentNotes.length) {
    renderNotes(currentNotes, currentNotesFilterVideoId);
  }
  if (activeTabName === "overview" && currentAnalysis) {
    await translateOverviewContent();
  } else if (activeTabName === "notes" && currentNotes.length) {
    await translateNotesContent();
  } else if (activeTabName === "transcript") {
    if (currentTranscriptView === "timeline" && currentChapters) {
      await translateChaptersContent();
    } else {
      await translateTranscript();
    }
  }
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  // Bilingual mode can find source text before each translation arrives.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, TRANSLATION_BATCH_SIZE);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < TRANSLATION_BATCH_SIZE) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  findLiteralTranscriptMatches,
  loadTranscriptViewState,
  saveTranscriptViewState,
  loadDisplayLanguageMode,
  saveDisplayLanguageMode,
  getNavigationUrl,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  renderVisualBoardMarkup,
  buildOverviewMarkdown,
  buildStandaloneOverviewHtml,
};
