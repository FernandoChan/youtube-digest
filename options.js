const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "youtubeDigestPreview:";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const COPY = {
    en: {
      pageTitle: "YouTube Digest Settings",
      languageGroupLabel: "Interface language",
      heading: "Bring your own API keys",
      lede:
        "Keys stay in this Chrome profile and are sent only to Supadata and your chosen AI provider (Google Gemini or TokenRouter). This open-source extension has no developer server or analytics.",
      transcriptProvider: "Transcript provider",
      supadataApiKeyLabel: "Supadata API key",
      supadataHelp: "Used to fetch timestamped YouTube subtitles. ",
      supadataLink: "Create a Supadata account and key",
      supadataHelpSuffix:
        ". Supadata generates the key during onboarding.",
      aiProvider: "AI provider",
      aiProviderSelectLabel: "Provider",
      providerSummaryLabel: "Active AI provider",
      providerBadge: "Supported in this version",
      googleProviderBadge: "Google AI Studio / Ultra credits",
      aiModelLabel: "Model",
      aiModelHelp:
        "Default is DeepSeek V4.1 Flash (fast and low cost). You can switch models at any time.",
      googleModelHelp:
        "Default is Gemini 4 Neon (fast frontier quality for visual executive digests). Supports Google AI Ultra monthly API credits claimed in Google AI Studio.",
      reasoningEffortLabel: "Thinking mode",
      reasoningEffortHelp:
        "Controls reasoning depth for thinking models such as Gemini 4 and DeepSeek V4.1 Flash. Overview streams the thinking process live, and prompt prefix caching is automatic.",
      deepseekApiKeyLabel: "TokenRouter API key",
      deepseekKeyPlaceholder: "Paste your TokenRouter key",
      deepseekHelp:
        "YouTube Digest uses TokenRouter for overviews, explanations, translation, and note polishing. ",
      deepseekLink: "Open TokenRouter dashboard",
      deepseekHelpSuffix: ".",
      privacyNote:
        "When you use AI features, TokenRouter receives the video transcript and relevant video context. Review TokenRouter's terms and pricing before saving.",
      googleApiKeyLabel: "Google Gemini API key",
      googleKeyPlaceholder: "Paste your Google AI Studio key (AIza...)",
      googleHelp:
        "Claim your Google AI Ultra monthly credits in Google AI Studio, link billing, and paste your Gemini API key here. ",
      googleLink: "Open Google AI Studio API keys",
      googleHelpSuffix: ".",
      googlePrivacyNote:
        "When you use AI features, Google's Gemini API (generativelanguage.googleapis.com) receives the video transcript and relevant video context directly via the x-goog-api-key header. Review Google's Gemini API terms before saving.",
      saveSettings: "Save settings",
      localRemix: "Local remix",
      customizationTitle: "Want to use another AI model?",
      customizationPurpose: "Edit and copy a safe prompt for your coding agent",
      agentBadge: "Coding agent ready",
      customizationIntro:
        "You can edit the prompt directly. Complete these three steps before copying:",
      customizationStepFolder:
        "Open the extracted YouTube Digest project folder in your coding agent.",
      customizationStepReplace:
        "Replace [PROVIDER] and [MODEL] with the service and model you want to use.",
      customizationStepKeys:
        "Never include API keys in the prompt or chat. Enter them yourself after the code is ready.",
      customizationPromptLabel: "Editable customization prompt",
      customizationReminderLabel: "Prompt reminder",
      customizationReminder:
        "Before copying, replace [PROVIDER] and [MODEL] with the provider and model you want to use.",
      customizationPrompt:
        "Customize this local YouTube Digest workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is YouTube Digest. If verification fails, stop and ask me to open the extracted YouTube Digest project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real YouTube video.",
      copyCustomizationPrompt: "Copy edited prompt",
      localData: "Local data",
      localDataHelp:
        "Digests, translations, and notes are stored only in this Chrome profile. You can remove them at any time.",
      clearCache: "Clear cached digests",
      deleteNotes: "Delete all notes",
      resetData: "Reset extension data",
      footer:
        'Read <a href="PRIVACY.md" target="_blank">PRIVACY.md</a> in the repository for the complete data-flow description.',
      migrationWarning:
        "Previous provider settings were reset safely. Your Supadata key was kept, but the AI key was cleared. Enter a TokenRouter or Google Gemini API key to continue.",
      saving: "Saving…",
      addSupadataKey: "Add a Supadata API key.",
      addDeepseekKey: "Add a TokenRouter API key.",
      addGoogleKey: "Add a Google Gemini API key.",
      saved: "Saved. Reopen YouTube Digest to use these settings.",
      saveFailed: "Could not save settings. Please try again.",
      copying: "Copying…",
      promptCopied: "Edited prompt copied.",
      copyFailed:
        "Could not copy the prompt. Select the prompt text and copy it manually.",
      clearedDigests: ({ count }) =>
        `Cleared ${count} cached digest${count === 1 ? "" : "s"}.`,
      notesDeleted: "Deleted all saved notes.",
      resetConfirm:
        "Delete API keys, cached digests, translations, and saved notes from this Chrome profile?",
      allDataDeleted: "All YouTube Digest data was deleted.",
      settingsLoadFailed:
        "Could not load saved settings. You can still preview this page.",
    },
    "zh-CN": {
      pageTitle: "YouTube Digest 设置",
      languageGroupLabel: "界面语言",
      heading: "使用你自己的 API 密钥",
      lede:
        "密钥仅保存在当前 Chrome 个人资料中，只会发送给 Supadata 和你选择的 AI 服务（Google Gemini 或 TokenRouter）。本开源扩展没有开发者服务器，也不使用分析服务。",
      transcriptProvider: "字幕服务",
      supadataApiKeyLabel: "Supadata API 密钥",
      supadataHelp: "用于获取带时间戳的 YouTube 字幕。",
      supadataLink: "创建 Supadata 账号并获取密钥",
      supadataHelpSuffix: "。Supadata 会在引导流程中生成密钥。",
      aiProvider: "AI 服务",
      aiProviderSelectLabel: "服务商",
      providerSummaryLabel: "当前 AI 服务",
      providerBadge: "当前版本支持",
      googleProviderBadge: "支持 Google AI Ultra 订阅赠送额度",
      aiModelLabel: "模型",
      aiModelHelp: "默认使用 DeepSeek V4.1 Flash（速度快、成本低），可随时切换。",
      googleModelHelp:
        "默认使用 Gemini 4 Neon（适合生成深度视觉纪要画板，速度与质量兼顾）。支持在 Google AI Studio 领取的 Google AI Ultra 每月赠送额度。",
      reasoningEffortLabel: "思考模式",
      reasoningEffortHelp:
        "控制 Gemini 4、DeepSeek V4.1 Flash 等推理模型的思考强度。总结页会实时显示思考过程，服务端前缀缓存与浏览器本地缓存均默认开启。",
      deepseekApiKeyLabel: "TokenRouter API 密钥",
      deepseekKeyPlaceholder: "粘贴你的 TokenRouter 密钥",
      deepseekHelp:
        "YouTube Digest 使用 TokenRouter 生成深度纪要、时间线章节、内容讲解、翻译字幕和润色笔记。",
      deepseekLink: "打开 TokenRouter 控制台",
      deepseekHelpSuffix: "。",
      privacyNote:
        "使用 AI 功能时，TokenRouter 会收到视频字幕及相关视频上下文。保存前请查看 TokenRouter 的服务条款和价格。",
      googleApiKeyLabel: "Google Gemini API 密钥",
      googleKeyPlaceholder: "粘贴你的 Google AI Studio 密钥 (AIza...)",
      googleHelp:
        "在 Google AI Studio 领取 Google AI Ultra 订阅赠送的每月 API 额度后，创建 Gemini API Key 并粘贴到这里。",
      googleLink: "打开 Google AI Studio API Keys",
      googleHelpSuffix: "。",
      googlePrivacyNote:
        "使用 AI 功能时，扩展会通过 x-goog-api-key 请求头直连 Google Gemini API (generativelanguage.googleapis.com) 并发送视频字幕及相关上下文。保存前请查看 Google Gemini API 服务条款。",
      saveSettings: "保存设置",
      localRemix: "本地改造",
      customizationTitle: "想使用其他 AI 模型？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。",
      customizationStepReplace:
        "把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder:
        "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationPrompt:
        "请把当前本地 YouTube Digest 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 YouTube Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，并在真实 YouTube 视频上测试。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      localData: "本地数据",
      localDataHelp:
        "摘要、翻译和笔记仅保存在当前 Chrome 个人资料中。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      footer:
        '完整数据流说明请参阅仓库中的 <a href="PRIVACY.md" target="_blank">PRIVACY.md</a>。',
      migrationWarning:
        "已安全重置旧的服务设置。Supadata 密钥已保留，AI 密钥已清除。请输入 TokenRouter 或 Google Gemini API 密钥以继续使用。",
      saving: "正在保存…",
      addSupadataKey: "请添加 Supadata API 密钥。",
      addDeepseekKey: "请添加 TokenRouter API 密钥。",
      addGoogleKey: "请添加 Google Gemini API 密钥。",
      saved: "已保存。请重新打开 YouTube Digest 以使用这些设置。",
      saveFailed: "无法保存设置，请重试。",
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      clearedDigests: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeleted: "已删除全部已保存的笔记。",
      resetConfirm:
        "要从当前 Chrome 个人资料中删除 API 密钥、缓存摘要、翻译和已保存的笔记吗？",
      allDataDeleted: "已删除全部 YouTube Digest 数据。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",
    },
  };

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "en";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? COPY.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      en: translate("en", "customizationPrompt"),
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const aiProviderSelect = doc.getElementById("aiProviderSelect");
    const aiModelSelect = doc.getElementById("aiModel");
    const reasoningEffortSelect = doc.getElementById("reasoningEffort");
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    const supadataApiKeyInput = doc.getElementById("supadataApiKey");
    const providerSummaryName = doc.getElementById("providerSummaryName");
    const providerSummaryBadge = doc.getElementById("providerSummaryBadge");
    const aiModelHelp = doc.getElementById("aiModelHelp");
    const aiApiKeyLabel = doc.getElementById("aiApiKeyLabel");
    const aiKeyHelpPrefix = doc.getElementById("aiKeyHelpPrefix");
    const aiKeyHelpLink = doc.getElementById("aiKeyHelpLink");
    const aiKeyHelpSuffix = doc.getElementById("aiKeyHelpSuffix");
    const aiPrivacyNote = doc.getElementById("aiPrivacyNote");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = "en";
    let currentProvider = settingsApi.DEFAULTS.provider;
    const providerKeys = {
      tokenrouter: "",
      google: "",
    };
    const providerModels = {
      tokenrouter: settingsApi.PROVIDERS.tokenrouter.defaultModel,
      google: settingsApi.PROVIDERS.google.defaultModel,
    };

    function renderStatus(element) {
      const state = statusStates.get(element);
      element.textContent = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
    }

    function setStatus(element, key, params = {}) {
      statusStates.set(element, { key, params });
      renderStatus(element);
    }

    function populateModelOptions(provider, selectedModel) {
      if (!aiModelSelect) return;
      const models = settingsApi.getModelsForProvider(provider);
      const defaultModel = settingsApi.getProviderConfig(provider).defaultModel;
      aiModelSelect.innerHTML = "";
      for (const item of models) {
        const opt = doc.createElement("option");
        opt.value = item.id;
        opt.textContent = `${item.label} (${item.id})`;
        aiModelSelect.appendChild(opt);
      }
      const hasSelected = models.some((item) => item.id === selectedModel);
      aiModelSelect.value = hasSelected ? selectedModel : defaultModel;
    }

    function renderProviderCopy() {
      const isGoogle = currentProvider === "google";
      const providerConfig = settingsApi.getProviderConfig(currentProvider);
      if (providerSummaryName) {
        providerSummaryName.textContent = providerConfig.label;
      }
      if (providerSummaryBadge) {
        providerSummaryBadge.textContent = translate(
          currentLanguage,
          isGoogle ? "googleProviderBadge" : "providerBadge",
        );
      }
      if (aiModelHelp) {
        aiModelHelp.textContent = translate(
          currentLanguage,
          isGoogle ? "googleModelHelp" : "aiModelHelp",
        );
      }
      if (aiApiKeyLabel) {
        aiApiKeyLabel.textContent = translate(
          currentLanguage,
          isGoogle ? "googleApiKeyLabel" : "deepseekApiKeyLabel",
        );
      }
      if (aiApiKeyInput) {
        aiApiKeyInput.placeholder = translate(
          currentLanguage,
          isGoogle ? "googleKeyPlaceholder" : "deepseekKeyPlaceholder",
        );
      }
      if (aiKeyHelpPrefix) {
        aiKeyHelpPrefix.textContent = translate(
          currentLanguage,
          isGoogle ? "googleHelp" : "deepseekHelp",
        );
      }
      if (aiKeyHelpLink) {
        aiKeyHelpLink.href = isGoogle
          ? "https://aistudio.google.com/apikey"
          : "https://tokenrouter.cheap/dashboard";
        aiKeyHelpLink.textContent = translate(
          currentLanguage,
          isGoogle ? "googleLink" : "deepseekLink",
        );
      }
      if (aiKeyHelpSuffix) {
        aiKeyHelpSuffix.textContent = translate(
          currentLanguage,
          isGoogle ? "googleHelpSuffix" : "deepseekHelpSuffix",
        );
      }
      if (aiPrivacyNote) {
        aiPrivacyNote.textContent = translate(
          currentLanguage,
          isGoogle ? "googlePrivacyNote" : "privacyNote",
        );
      }
    }

    function switchProvider(nextProvider, { preserveCurrentInputs = true } = {}) {
      if (preserveCurrentInputs) {
        providerKeys[currentProvider] = aiApiKeyInput?.value || "";
        if (aiModelSelect?.value) {
          providerModels[currentProvider] = aiModelSelect.value;
        }
      }
      currentProvider = settingsApi.normalizeProvider(nextProvider);
      if (aiProviderSelect) aiProviderSelect.value = currentProvider;
      populateModelOptions(currentProvider, providerModels[currentProvider]);
      if (aiApiKeyInput) {
        aiApiKeyInput.value = providerKeys[currentProvider] || "";
      }
      renderProviderCopy();
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }

      renderProviderCopy();
      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;

        providerKeys.tokenrouter = settings.tokenrouterApiKey || "";
        providerKeys.google = settings.googleApiKey || "";
        providerModels[settings.provider] = settings.aiModel;
        supadataApiKeyInput.value = settings.supadataApiKey;

        switchProvider(settings.provider, { preserveCurrentInputs: false });

        if (reasoningEffortSelect) {
          const hasEffortOption = [...reasoningEffortSelect.options].some(
            (opt) => opt.value === settings.reasoningEffort,
          );
          reasoningEffortSelect.value = hasEffortOption
            ? settings.reasoningEffort
            : settingsApi.DEFAULTS.reasoningEffort;
        }
        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (_error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage("en");
      }
      await loadSettings();
    }

    async function saveSettings(event) {
      event.preventDefault();
      setStatus(saveStatus, "saving");

      const activeProvider = settingsApi.normalizeProvider(
        aiProviderSelect?.value || currentProvider,
      );
      providerKeys[activeProvider] = aiApiKeyInput.value;

      const settings = settingsApi.normalize({
        provider: activeProvider,
        aiModel: aiModelSelect?.value,
        reasoningEffort: reasoningEffortSelect?.value,
        aiApiKey: aiApiKeyInput.value,
        tokenrouterApiKey: providerKeys.tokenrouter,
        googleApiKey: providerKeys.google,
        supadataApiKey: supadataApiKeyInput.value,
      });

      if (!settings.supadataApiKey) {
        setStatus(saveStatus, "addSupadataKey");
        return;
      }
      if (!settings.aiApiKey) {
        setStatus(
          saveStatus,
          activeProvider === "google" ? "addGoogleKey" : "addDeepseekKey",
        );
        return;
      }

      try {
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
        setStatus(saveStatus, "saved");
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    async function clearCachedDigests() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
      if (keys.length) await storage.remove(keys);
      setStatus(dataStatus, "clearedDigests", { count: keys.length });
    }

    async function clearNotes() {
      await storage.remove("ytd_notes");
      setStatus(dataStatus, "notesDeleted");
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      await storage.clear();
      await persistPreferredLanguage(storage, currentLanguage);
      await loadSettings();
      setStatus(dataStatus, "allDataDeleted");
    }

    aiProviderSelect?.addEventListener("change", () => {
      switchProvider(aiProviderSelect.value, { preserveCurrentInputs: true });
    });
    form.addEventListener("submit", saveSettings);
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedDigests);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);
    for (const button of languageButtons) {
      button.addEventListener("click", async () => {
        const language = button.dataset.language;
        applyLanguage(language);
        await persistPreferredLanguage(storage, language);
      });
    }

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }
  }

  return {
    COPY,
    LANGUAGE_STORAGE_KEY,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    normalizeLanguage,
    persistPreferredLanguage,
    readPreferredLanguage,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}
