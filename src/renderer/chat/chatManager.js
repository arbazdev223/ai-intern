(function (root) {
  const constants = root.SharedModules.constants;
  const EXTERNAL_SCREEN_TOGGLE_KEY = "assistant.allowExternalScreenData";

  function createChatManager(options = {}) {
    const refs = options.refs;
    let chatSessions = [];
    let activeChatId = null;
    let conversation = [];
    let isBusy = false;
    let openingAnalysisRunning = false;
    let longRequestTimer = null;
    let chatSearchQuery = "";
    let chatSearchDebounceTimer = null;

    function loadExternalScreenConsent() {
      if (typeof localStorage === "undefined") {
        return false;
      }

      try {
        return localStorage.getItem(EXTERNAL_SCREEN_TOGGLE_KEY) === "true";
      } catch (_error) {
        return false;
      }
    }

    function saveExternalScreenConsent(allowed) {
      if (typeof localStorage === "undefined") {
        return;
      }

      try {
        localStorage.setItem(EXTERNAL_SCREEN_TOGGLE_KEY, allowed ? "true" : "false");
      } catch (_error) {}
    }

    function applyExternalScreenConsent(allowed) {
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.checked = allowed;
      }
      if (refs.externalScreenToggleLabel) {
        refs.externalScreenToggleLabel.textContent = allowed ? "External AI: ON" : "External AI: OFF";
      }
    }

    function isExternalScreenAllowed() {
      return Boolean(refs.externalScreenToggle && refs.externalScreenToggle.checked);
    }

    function setModelStatus(mode, detail) {
      if (!refs.modelStatus) {
        return;
      }

      const safeMode = String(mode || "Offline").trim() || "Offline";
      const safeDetail = String(detail || "").trim();
      refs.modelStatus.textContent = safeDetail ? `Mode: ${safeMode} (${safeDetail})` : `Mode: ${safeMode}`;
      refs.modelStatus.dataset.mode = safeMode.toLowerCase();
    }

    function resolveModeFromModel(usedModel) {
      const safeModel = String(usedModel || "").trim();
      if (!safeModel) {
        return { mode: "Offline", detail: "" };
      }
      if (safeModel.toLowerCase().startsWith("openai:")) {
        return { mode: "OpenAI", detail: safeModel.replace(/^openai:/i, "") };
      }
      if (safeModel.toLowerCase().startsWith("gemini:")) {
        return { mode: "Gemini", detail: safeModel.replace(/^gemini:/i, "") };
      }
      return { mode: "AI", detail: safeModel };
    }

    function setStatus(text, statusOptions = {}) {
      const busy = Boolean(statusOptions.busy);
      if (refs.statusText) {
        refs.statusText.textContent = String(text || "");
        refs.statusText.classList.toggle("busy", busy);
      }
    }

    function setTypingIndicator(show) {
      if (refs.typingIndicator) {
        refs.typingIndicator.classList.toggle("hidden", !show);
      }
      if (refs.typingLabel) {
        refs.typingLabel.textContent = "AI is thinking";
      }
      if (!show && longRequestTimer) {
        clearTimeout(longRequestTimer);
        longRequestTimer = null;
      }
      if (show && !longRequestTimer && refs.typingLabel) {
        longRequestTimer = setTimeout(() => {
          if (refs.typingLabel) {
            refs.typingLabel.textContent = "Still working...";
          }
        }, 7000);
      }
    }

    function setBusyState(nextBusy) {
      isBusy = nextBusy;
      if (refs.sendButton) {
        refs.sendButton.disabled = nextBusy;
      }
      if (refs.screenshotButton) {
        refs.screenshotButton.disabled = nextBusy;
      }
      if (refs.promptInput) {
        refs.promptInput.disabled = nextBusy;
      }
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.disabled = nextBusy;
      }
    }

    function autoResizeInput() {
      if (!refs.promptInput) {
        return;
      }

      refs.promptInput.style.height = "auto";
      refs.promptInput.style.height = `${Math.min(refs.promptInput.scrollHeight, 160)}px`;
    }

    function setDetectedApp(appName) {
      const safeName = String(appName || "Unknown application").trim() || "Unknown application";
      if (refs.detectedAppLabel) {
        refs.detectedAppLabel.textContent = `Detected App: ${safeName}`;
      }
    }

    function getSessionById(sessionId) {
      const id = String(sessionId || "");
      return chatSessions.find((session) => session.id === id) || null;
    }

    function getActiveSession() {
      return getSessionById(activeChatId);
    }

    function updateConversationFromActiveSession() {
      const session = getActiveSession();
      if (!session) {
        conversation = [];
        return;
      }

      session.conversation = options.sessionStore.buildConversationFromMessages(session.messages);
      const memory = options.sessionStore.buildMemoryFromMessages(session.messages);
      session.recentMessages = memory.recentMessages;
      session.summarizedMemory = memory.summarizedMemory;
      conversation = session.conversation.slice(-12);
    }

    function saveSessions() {
      options.sessionStore.saveState({
        activeChatId,
        sessions: chatSessions
      });
    }

    function renderConversationList() {
      if (!refs.conversationList) {
        return;
      }

      refs.conversationList.innerHTML = "";

      const allChats = [...chatSessions].sort((left, right) => right.updatedAt - left.updatedAt);
      const query = String(chatSearchQuery || "").trim().toLowerCase();
      const filteredChats = query
        ? allChats.filter((session) => sessionMatchesQuery(session, query))
        : allChats;

      if (filteredChats.length === 0) {
        const emptyItem = document.createElement("li");
        emptyItem.className = "conversation-empty-state";
        emptyItem.textContent = "No chats found";
        refs.conversationList.appendChild(emptyItem);
        return;
      }

      filteredChats.forEach((session) => {
          const item = document.createElement("li");
          item.className = "conversation-item";
          item.dataset.chatId = session.id;
          if (session.id === activeChatId) {
            item.classList.add("active");
          }

          const topRow = document.createElement("div");
          topRow.className = "sidebar-item-row";

          const selectBtn = document.createElement("button");
          selectBtn.type = "button";
          selectBtn.className = "conversation-select";
          selectBtn.dataset.action = "select";
          selectBtn.dataset.chatId = session.id;
          const titleText = options.sessionStore.createTitleFromMessage(session.title || "New chat");
          selectBtn.title = titleText;
          if (query) {
            selectBtn.innerHTML = highlightMatch(titleText, query);
          } else {
            selectBtn.textContent = titleText;
          }

          const menu = document.createElement("details");
          menu.className = "sidebar-item-menu conversation-actions";

          const menuTrigger = document.createElement("summary");
          menuTrigger.className = "sidebar-item-menu-trigger";
          menuTrigger.setAttribute("aria-label", `More actions for ${selectBtn.textContent}`);
          menuTrigger.textContent = "\u22EE";

          const actions = document.createElement("div");
          actions.className = "sidebar-item-menu-popover";

          const renameBtn = document.createElement("button");
          renameBtn.type = "button";
          renameBtn.className = "sidebar-item-menu-action conversation-action";
          renameBtn.dataset.action = "rename";
          renameBtn.dataset.chatId = session.id;
          renameBtn.textContent = "Rename";

          const deleteBtn = document.createElement("button");
          deleteBtn.type = "button";
          deleteBtn.className = "sidebar-item-menu-action conversation-action danger";
          deleteBtn.dataset.action = "delete";
          deleteBtn.dataset.chatId = session.id;
          deleteBtn.textContent = "Delete";

          actions.appendChild(renameBtn);
          actions.appendChild(deleteBtn);
          menu.appendChild(menuTrigger);
          menu.appendChild(actions);
          topRow.appendChild(selectBtn);
          topRow.appendChild(menu);
          item.appendChild(topRow);
          refs.conversationList.appendChild(item);
        });
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function escapeRegExp(value) {
      return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function highlightMatch(text, query) {
      const safeText = String(text || "");
      const trimmedQuery = String(query || "").trim();
      if (!trimmedQuery) {
        return escapeHtml(safeText);
      }

      const escapedQuery = escapeRegExp(trimmedQuery);
      const regex = new RegExp(`(${escapedQuery})`, "ig");
      return escapeHtml(safeText).replace(regex, "<mark>$1</mark>");
    }

    function sessionMatchesQuery(session, query) {
      const safeQuery = String(query || "").trim().toLowerCase();
      if (!safeQuery) {
        return true;
      }

      const title = options.sessionStore
        .createTitleFromMessage(session && session.title ? session.title : "New chat")
        .toLowerCase();
      if (title.includes(safeQuery)) {
        return true;
      }

      const messages = Array.isArray(session && session.messages) ? session.messages : [];
      return messages.some((msg) => {
        const content = String(msg && msg.content ? msg.content : "").toLowerCase();
        return content.includes(safeQuery);
      });
    }

    function applyChatSearch(nextValue) {
      chatSearchQuery = String(nextValue || "");
      renderConversationList();
    }

    function handleChatSearchInput(event) {
      const value = String(event && event.target ? event.target.value : "");
      const shouldDebounce = chatSessions.length > 100;
      if (!shouldDebounce) {
        applyChatSearch(value);
        return;
      }

      if (chatSearchDebounceTimer) {
        clearTimeout(chatSearchDebounceTimer);
      }

      chatSearchDebounceTimer = setTimeout(() => {
        applyChatSearch(value);
      }, 200);
    }

    function switchChat(sessionId, switchOptions = {}) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      activeChatId = session.id;
      options.promptLibrary.hidePromptBrowser();
      options.attachments.clearPendingAttachment({ silent: true });
      updateConversationFromActiveSession();
      renderConversationList();
      options.messageRenderer.renderSessionMessages(session.messages);
      saveSessions();

      if (switchOptions.focusInput && refs.promptInput) {
        refs.promptInput.focus();
      }
    }

    function appendMessageToActiveSession(role, text, messageOptions = {}) {
      const session = getActiveSession();
      if (!session) {
        return;
      }

      const safeRole = options.sessionStore.normalizeRole(role);
      const safeContent = String(text || "").trim();
      const imagePath = safeRole === "user" ? String(messageOptions.imagePath || "").trim() : "";
      const files = safeRole === "assistant" && Array.isArray(messageOptions.files)
        ? messageOptions.files
        : undefined;
      const imageUrl =
        safeRole === "assistant" ? String(messageOptions.imageUrl || "").trim() : "";
      const imageUrls =
        safeRole === "assistant" && Array.isArray(messageOptions.imageUrls)
          ? messageOptions.imageUrls.filter(Boolean)
          : [];
      const imagePrompt =
        safeRole === "assistant"
          ? String(messageOptions.imagePrompt || messageOptions.prompt || "").trim()
          : "";
      const imageMessage =
        safeRole === "assistant"
          ? String(messageOptions.imageMessage || messageOptions.message || "").trim()
          : "";
      const messageType =
        safeRole === "assistant"
          ? String(messageOptions.type || messageOptions.messageType || "").trim()
          : "";

      if (!safeContent && !imagePath && !imageUrl) {
        return;
      }

      session.messages.push({
        role: safeRole,
        content: safeContent,
        imagePath,
        files,
        type: messageType,
        imageUrl,
        imageUrls,
        imagePrompt,
        imageMessage
      });

      if (safeRole === "user" && !session.renamed && (!session.title || session.title === "New chat")) {
        session.title = options.sessionStore.createTitleFromMessage(safeContent || "New chat");
      }

      session.updatedAt = Date.now();
      updateConversationFromActiveSession();
      renderConversationList();
      saveSessions();
    }

    function addMessageAndPersist(role, text, messageOptions = {}) {
      if (role === "assistant") {
        options.messageRenderer.renderAssistantMessage(text, {
          files: messageOptions.files,
          image: messageOptions.image
        });
      } else {
        options.messageRenderer.renderUserMessage(text, messageOptions);
      }

      appendMessageToActiveSession(role, text, messageOptions);
    }

    function hydrateChatSessions() {
      const stored = options.sessionStore.loadState();
      chatSessions = stored.sessions;

      if (chatSessions.length === 0) {
        const fresh = options.sessionStore.createDefaultSession();
        chatSessions = [fresh];
        activeChatId = fresh.id;
        saveSessions();
      } else {
        const requestedActive = stored.activeChatId;
        activeChatId =
          (requestedActive && getSessionById(requestedActive)?.id) ||
          [...chatSessions].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ||
          chatSessions[0].id;
      }

      switchChat(activeChatId);
    }

    async function migrateLegacySessions() {
      const didChange = await options.sessionStore.migrateLegacyImages(chatSessions, options.assistantAPI);
      if (didChange) {
        saveSessions();
        const activeSession = getActiveSession();
        if (activeSession) {
          options.messageRenderer.renderSessionMessages(activeSession.messages);
        }
      }
    }

    async function hydrateCurrentApp() {
      try {
        const appName = await options.assistantAPI.getCurrentApp();
        setDetectedApp(appName);
      } catch (_error) {
        setDetectedApp("Unknown application");
      }
    }

    function applyExpandButtonState(expanded) {
      if (!refs.expandButton) {
        return;
      }

      refs.expandButton.textContent = expanded ? "Collapse" : "Expand";
      refs.expandButton.dataset.expanded = expanded ? "true" : "false";
    }

    async function hydrateExpandState() {
      if (!refs.expandButton) {
        return;
      }

      try {
        const state = await options.assistantAPI.getExpandState();
        applyExpandButtonState(Boolean(state && state.expanded));
      } catch (_error) {
        applyExpandButtonState(false);
      }
    }

    async function handleExpandToggle() {
      if (!refs.expandButton) {
        return;
      }

      try {
        const state = await options.assistantAPI.toggleExpand();
        const expanded = Boolean(state && state.expanded);
        applyExpandButtonState(expanded);
        setStatus(expanded ? "Expanded layout enabled." : "Compact layout enabled.");
      } catch (error) {
        console.error("Expand toggle failed:", error);
        setStatus("Unable to resize window.");
      }
    }

    function buildUserContextContent(userPrompt, hasImage) {
      const text = String(userPrompt || "").trim();
      if (text) {
        return text;
      }

      return hasImage ? "[Screenshot attached]" : "";
    }

    function updateLastUserMessageImagePath(nextPath) {
      const session = getActiveSession();
      if (!session || !nextPath) {
        return;
      }

      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        const message = session.messages[index];
        if (message && message.role === "user" && message.imagePath) {
          message.imagePath = nextPath;
          break;
        }
      }

      saveSessions();
    }

    function getMemoryContext() {
      const session = getActiveSession();
      if (session && Array.isArray(session.recentMessages)) {
        return session.recentMessages.slice(-8);
      }
      return conversation.slice(-5);
    }

    function getMemorySummary() {
      const session = getActiveSession();
      return session && typeof session.summarizedMemory === "string"
        ? session.summarizedMemory
        : "";
    }

    function handleNewChat() {
      if (isBusy) {
        return;
      }

      const newSession = options.sessionStore.createDefaultSession();
      chatSessions.push(newSession);
      if (chatSessions.length > constants.CHAT_STORAGE_MAX) {
        chatSessions = [...chatSessions]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, constants.CHAT_STORAGE_MAX);
      }

      switchChat(newSession.id, { focusInput: true });
      options.sidebar.closeSidebar();
    }

    function restoreInputInteraction() {
      if (!refs.promptInput) {
        return;
      }

      refs.promptInput.disabled = false;
      if (refs.sendButton) {
        refs.sendButton.disabled = false;
      }
      if (refs.screenshotButton) {
        refs.screenshotButton.disabled = false;
      }
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.disabled = false;
      }

      try {
        if (typeof window !== "undefined" && typeof window.focus === "function") {
          window.focus();
        }
      } catch (_error) {}

      window.setTimeout(() => {
        if (refs.promptInput) {
          refs.promptInput.focus();
        }
      }, 0);
    }

    function finalizeSidebarChatAction() {
      // Defensive reset in case a transient overlay or stale busy state blocks the composer.
      isBusy = false;
      setBusyState(false);
      setTypingIndicator(false);

      if (options.sidebar && typeof options.sidebar.closeAllMenus === "function") {
        options.sidebar.closeAllMenus();
      }
      options.sidebar.closeSidebar();
      if (refs.assistantShell) {
        refs.assistantShell.classList.remove("sidebar-open");
      }
      restoreInputInteraction();
    }

    function renameChatSession(sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      const nextTitle = window.prompt("Rename chat", session.title || "New chat");
      if (nextTitle === null) {
        return;
      }

      const cleaned = options.sessionStore.createTitleFromMessage(nextTitle);
      session.title = cleaned || "New chat";
      session.renamed = true;
      session.updatedAt = Date.now();
      renderConversationList();
      saveSessions();
    }

    function deleteChatSession(sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      const shouldDelete = window.confirm(`Delete "${session.title || "New chat"}"?`);
      if (!shouldDelete) {
        return;
      }

      chatSessions = chatSessions.filter((item) => item.id !== session.id);

      if (chatSessions.length === 0) {
        const fresh = options.sessionStore.createDefaultSession();
        chatSessions = [fresh];
        switchChat(fresh.id, { focusInput: true });
        return;
      }

      const nextActive = [...chatSessions].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      switchChat(nextActive.id, { focusInput: true });
    }

    function handleConversationListClick(event) {
      if (isBusy || !refs.conversationList) {
        return;
      }

      const actionTarget = event.target.closest("[data-action]");
      if (actionTarget && refs.conversationList.contains(actionTarget)) {
        const action = String(actionTarget.dataset.action || "");
        const chatId = String(actionTarget.dataset.chatId || "");
        if (!chatId) {
          return;
        }

        if (action === "select") {
          switchChat(chatId, { focusInput: true });
          finalizeSidebarChatAction();
          return;
        }

        if (action === "rename") {
          event.stopPropagation();
          renameChatSession(chatId);
          finalizeSidebarChatAction();
          return;
        }

        if (action === "delete") {
          event.stopPropagation();
          deleteChatSession(chatId);
          finalizeSidebarChatAction();
        }
      }
    }

    async function handleChatSubmit(event) {
      event.preventDefault();

      if (isBusy) {
        return;
      }

      options.sidebar.closeSidebar();

      const userPrompt = String((refs.promptInput && refs.promptInput.value) || "").trim();
      let screenshotBase64 = options.attachments.getPendingScreenshotBase64();

      if (!userPrompt && !screenshotBase64) {
        return;
      }

      setBusyState(true);
      let imagePlaceholder = null;
      let responseReceived = false;
      let placeholderInserted = false;

      try {
        const userContentForContext = buildUserContextContent(userPrompt, Boolean(screenshotBase64));
        const previewImagePath = screenshotBase64 ? `data:image/png;base64,${screenshotBase64}` : "";

        addMessageAndPersist("user", userContentForContext, {
          imagePath: previewImagePath
        });

        if (screenshotBase64) {
          options.attachments
            .persistAttachment("chat")
            .then((storedAttachment) => {
              const persistedImagePath = String(
                (storedAttachment && storedAttachment.imagePath) || ""
              ).trim();
              if (persistedImagePath) {
                updateLastUserMessageImagePath(persistedImagePath);
              }
            })
            .catch((error) => {
              console.warn("Screenshot persistence failed, using base64 preview.", error);
            });
        }

        options.attachments.clearPendingAttachment({ silent: true });

        if (refs.promptInput) {
          refs.promptInput.value = "";
        }
        autoResizeInput();

        let promptForRequest = userPrompt;
        if (screenshotBase64) {
          const extractedText = await options.screenshotOCR.extractOcrText(screenshotBase64);
          promptForRequest = options.screenshotOCR.buildPromptWithOcr(userPrompt, extractedText);
        }

        let shouldShowTypingIndicator = true;

        function isLikelyImageGenerationRequest(promptText) {
          const text = String(promptText || "").toLowerCase();
          if (!text) {
            return false;
          }

          const patterns = [
            /\bimage\b/,
            /\bimages\b/,
            /\bphoto\b/,
            /\bpicture\b/,
            /\bpic\b/,
            /\billustration\b/,
            /\bwallpaper\b/,
            /\bposter\b/,
            /\blogo\b/,
            /\bsketch\b/,
            /\bdraw\b/,
            /\brender\b/,
            /\bgenerate\s+(an\s+)?image\b/,
            /\bcreate\s+(an\s+)?image\b/,
            /\bmake\s+(an\s+)?image\b/,
            /\bimage\s+bana(o|do|na)\b/,
            /\bphoto\s+bana(o|do|na)\b/
          ];

          return patterns.some((pattern) => pattern.test(text));
        }

        if (options.assistantAPI && typeof options.assistantAPI.classifyInputType === "function") {
          try {
            const result = await options.assistantAPI.classifyInputType({ userPrompt });
            const type = String((result && result.type) || "").trim().toLowerCase();
            const confidence = Number(result && result.confidence);
            if (
              type === "creative_prompt" &&
              Number.isFinite(confidence) &&
              confidence >= 0.6 &&
              isLikelyImageGenerationRequest(userPrompt)
            ) {
              imagePlaceholder = options.messageRenderer.renderImagePlaceholder("Generating image...");
              placeholderInserted = true;
              shouldShowTypingIndicator = false;
              setStatus("Generating image...", { busy: true });
            }
          } catch (_error) {}
        }

        if (shouldShowTypingIndicator) {
          setTypingIndicator(true);
          setStatus(
            screenshotBase64 ? "AI is analyzing your screen..." : "AI is thinking...",
            { busy: true }
          );
        } else {
          setTypingIndicator(false);
        }

        const response = await options.assistantAPI.sendPrompt({
          userPrompt: promptForRequest,
          screenshotBase64,
          contextMessages: getMemoryContext(),
          memorySummary: getMemorySummary(),
          rawPrompt: Boolean(screenshotBase64),
          allowExternalScreenshot: isExternalScreenAllowed()
        });
        responseReceived = true;
        if (imagePlaceholder) {
          imagePlaceholder.remove();
        }

        if (response && response.type === "image_prompt") {
          const promptText = String((response && response.prompt) || userPrompt || "").trim();
          const infoMessage = String((response && response.message) || "🎨 Image prompt detected").trim();

          options.messageRenderer.renderImagePromptAction({
            message: infoMessage,
            prompt: promptText,
            onGenerate: async (selectedPrompt) => {
              const nextPrompt = String(selectedPrompt || "").trim();
              if (!nextPrompt || isBusy) {
                return;
              }

              setBusyState(true);
              setTypingIndicator(true);
              setStatus("Generating image...", { busy: true });

              try {
                const generated = await options.assistantAPI.sendPrompt({
                  userPrompt: nextPrompt,
                  forceImageGeneration: true,
                  contextMessages: getMemoryContext(),
                  memorySummary: getMemorySummary(),
                  rawPrompt: false
                });

                const generatedText =
                  String((generated && generated.response) || (generated && generated.message) || "").trim() ||
                  "Here is your generated image";
                const files = Array.isArray(generated && generated.files) ? generated.files : [];
                const generatedImagePayload = generated && generated.type === "image"
                  ? {
                      imageUrl: String(generated.imageUrl || "").trim(),
                      imageUrls: Array.isArray(generated.imageUrls) ? generated.imageUrls : [],
                      images: Array.isArray(generated.images) ? generated.images : [],
                      prompt: String(generated.prompt || nextPrompt || "").trim(),
                      message: String(generated.message || generatedText).trim()
                    }
                  : null;

                await options.messageRenderer.renderAssistantStream(generatedText, {
                  files,
                  image: generatedImagePayload
                });
                appendMessageToActiveSession("assistant", generatedText, {
                  files,
                  type: generated && generated.type ? String(generated.type) : "",
                  imageUrl: generatedImagePayload && generatedImagePayload.imageUrl,
                  imageUrls:
                    generatedImagePayload && Array.isArray(generatedImagePayload.imageUrls)
                      ? generatedImagePayload.imageUrls
                      : [],
                  imagePrompt: generatedImagePayload && generatedImagePayload.prompt,
                  imageMessage: generatedImagePayload && generatedImagePayload.message
                });
                setStatus("Ready");
              } catch (generateError) {
                const errMessage = String(
                  generateError && generateError.message ? generateError.message : "Image generation failed."
                );
                addMessageAndPersist("assistant", `Error: ${errMessage}`);
                setStatus("Image generation failed.");
              } finally {
                setTypingIndicator(false);
                setBusyState(false);
              }
            }
          });

          appendMessageToActiveSession("assistant", infoMessage, {
            type: "image_prompt",
            imagePrompt: promptText,
            imageMessage: infoMessage
          });

          setStatus("🎨 Image prompt detected. Click Generate Image.");
          return;
        }

        if (response && response.type === "hybrid") {
          const explanationText =
            String((response && response.explanation) || (response && response.response) || "").trim() ||
            "I generated an explanation and image for your request.";
          const hybridImagePayload = {
            imageUrl: String((response && response.imageUrl) || "").trim(),
            imageUrls: Array.isArray(response && response.imageUrls) ? response.imageUrls : [],
            images: Array.isArray(response && response.images) ? response.images : [],
            prompt: String((response && response.prompt) || userPrompt || "").trim(),
            message: String((response && response.message) || "Explanation + image generated").trim()
          };

          await options.messageRenderer.renderAssistantStream(explanationText, {
            image: hybridImagePayload
          });

          appendMessageToActiveSession("assistant", explanationText, {
            type: "hybrid",
            explanation: explanationText,
            imageUrl: hybridImagePayload.imageUrl,
            imageUrls: hybridImagePayload.imageUrls,
            imagePrompt: hybridImagePayload.prompt,
            imageMessage: hybridImagePayload.message
          });

          if (options.voiceManager && typeof options.voiceManager.speak === "function") {
            options.voiceManager.speak(explanationText);
          }

          const usedModel = response && response.usedModel ? String(response.usedModel) : "";
          const resolved = resolveModeFromModel(usedModel);
          setModelStatus(resolved.mode, resolved.detail);
          const modelUsed = usedModel ? ` (${usedModel})` : "";
          setStatus(`Ready${modelUsed}`);
          return;
        }

        const assistantText = String((response && response.response) || "").trim() || "No response from the model.";
        const files = Array.isArray(response && response.files) ? response.files : [];
        const imagePayload = response && response.type === "image"
          ? {
              imageUrl: String(response.imageUrl || "").trim(),
              imageUrls: Array.isArray(response.imageUrls) ? response.imageUrls : [],
              images: Array.isArray(response.images) ? response.images : [],
              prompt: String(response.prompt || "").trim(),
              message: String(response.message || "").trim()
            }
          : null;
        await options.messageRenderer.renderAssistantStream(assistantText, {
          files,
          image: imagePayload
        });
        appendMessageToActiveSession("assistant", assistantText, {
          files,
          type: response && response.type ? String(response.type) : "",
          imageUrl: imagePayload && imagePayload.imageUrl,
          imageUrls: imagePayload && Array.isArray(imagePayload.imageUrls) ? imagePayload.imageUrls : [],
          imagePrompt: imagePayload && imagePayload.prompt,
          imageMessage: imagePayload && imagePayload.message
        });
        if (options.voiceManager && typeof options.voiceManager.speak === "function") {
          options.voiceManager.speak(assistantText);
        }

        const usedModel = response && response.usedModel ? String(response.usedModel) : "";
        const provider = response && response.provider ? String(response.provider) : "";
        const openAIEnabled = Boolean(response && response.openAIEnabled);
        const resolved = resolveModeFromModel(usedModel);
        setModelStatus(resolved.mode, resolved.detail);
        const modelUsed = usedModel ? ` (${usedModel})` : "";
        setStatus(`Ready${modelUsed}`);
      } catch (error) {
        console.error("Send failed:", error);
        if (imagePlaceholder) {
          imagePlaceholder.remove();
        }
        const message = String(error && error.message ? error.message : "Request failed.");
        addMessageAndPersist("assistant", `Error: ${message}`);
        setModelStatus("Offline", "");

        if (message.includes("No AI API configured")) {
          setStatus("AI API missing. Add OPENAI_API_KEY or GEMINI_API_KEY.");
        } else if (message.includes("External AI off")) {
          setStatus("External AI is off. Enable External AI to use screenshots.");
        } else {
          setStatus("Request failed.");
        }
      } finally {
        setTypingIndicator(false);
        setBusyState(false);
      }
    }

    async function runOpeningAnalysis() {
      if (openingAnalysisRunning || isBusy) {
        return;
      }

      openingAnalysisRunning = true;
      setBusyState(true);

      try {
        setStatus("Capturing current screen...", { busy: true });

        const screenshotBase64 = await options.attachments.captureScreenshot();
        const extractedText = await options.screenshotOCR.extractOcrText(screenshotBase64);
        const openingPrompt = options.screenshotOCR.buildPromptWithOcr("", extractedText, {
          openingAnalysis: true
        });

        setTypingIndicator(true);
        setStatus("Analyzing active app context...", { busy: true });

        const response = await options.assistantAPI.sendPrompt({
          userPrompt: openingPrompt,
          screenshotBase64,
          contextMessages: getMemoryContext(),
          memorySummary: getMemorySummary(),
          rawPrompt: true
        });

        const assistantText =
          String((response && response.response) || "").trim() || "I could not analyze the current screen.";
        const files = Array.isArray(response && response.files) ? response.files : [];
        await options.messageRenderer.renderAssistantStream(assistantText, { files });
        appendMessageToActiveSession("assistant", assistantText, { files });
        if (options.voiceManager && typeof options.voiceManager.speak === "function") {
          options.voiceManager.speak(assistantText);
        }

        const usedModel = response && response.usedModel ? String(response.usedModel) : "";
        const provider = response && response.provider ? String(response.provider) : "";
        const openAIEnabled = Boolean(response && response.openAIEnabled);
        const resolved = resolveModeFromModel(usedModel);
        setModelStatus(resolved.mode, resolved.detail);
        const modelUsed = usedModel ? ` (${usedModel})` : "";
        setStatus(`Ready${modelUsed}`);
      } catch (error) {
        console.error("Opening analysis failed:", error);
        addMessageAndPersist("assistant", `Screen analysis failed: ${error.message}`);
        setModelStatus("Offline", "");
        setStatus("Screen analysis failed.");
      } finally {
        setTypingIndicator(false);
        setBusyState(false);
        openingAnalysisRunning = false;
      }
    }

    function handlePromptKeydown(event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        refs.chatForm.requestSubmit();
      }
    }

    async function init() {
      options.messageRenderer.init();
      options.attachments.init();
      options.promptLibrary.init();
      setTypingIndicator(false);
      setStatus("Ready");
      setModelStatus("Offline", "");
      hydrateChatSessions();

      const storedConsent = loadExternalScreenConsent();
      applyExternalScreenConsent(storedConsent);
      await migrateLegacySessions();
      await hydrateCurrentApp();
      await hydrateExpandState();

      if (refs.chatForm) {
        refs.chatForm.addEventListener("submit", handleChatSubmit);
      }
      if (refs.promptInput) {
        refs.promptInput.addEventListener("input", autoResizeInput);
        refs.promptInput.addEventListener("keydown", handlePromptKeydown);
      }
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.addEventListener("change", () => {
          const allowed = isExternalScreenAllowed();
          saveExternalScreenConsent(allowed);
          applyExternalScreenConsent(allowed);
          setStatus(allowed ? "External screen sharing enabled." : "External screen sharing disabled.");
        });
      }
      if (refs.screenshotButton) {
        refs.screenshotButton.addEventListener("click", async () => {
          try {
            await options.attachments.handleManualScreenshotAttach();
          } catch (error) {
            addMessageAndPersist("assistant", `Screenshot capture failed: ${error.message}`);
          }
        });
      }
      if (refs.expandButton) {
        refs.expandButton.addEventListener("click", handleExpandToggle);
      }
      if (refs.newChatButton) {
        refs.newChatButton.addEventListener("click", handleNewChat);
      }
      if (refs.conversationList) {
        refs.conversationList.addEventListener("click", handleConversationListClick);
      }
      if (refs.chatSearchInput) {
        refs.chatSearchInput.addEventListener("input", handleChatSearchInput);
      }

      options.assistantAPI.onActiveApp((appName) => {
        setDetectedApp(appName);
      });
      options.assistantAPI.onOpeningAnalysis(() => {
        runOpeningAnalysis().catch((error) => {
          addMessageAndPersist("assistant", `Screen analysis failed: ${error.message}`);
          setStatus("Screen analysis failed.");
        });
      });
    }

    return {
      autoResizeInput,
      getBusy: () => isBusy,
      init,
      setStatus
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.chatManager = {
    createChatManager
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
