(function (root) {
  const constants = root.SharedModules.constants;
  const MEMORY_MAX_MESSAGES = 8;
  const MEMORY_SUMMARY_TRIGGER = 16;
  const MEMORY_SUMMARY_MAX_CHARS = 800;
  const MEMORY_SNIPPET_MAX_CHARS = 120;
  const MAX_PERSISTED_TEXT_CHARS = 12000;
  const MAX_PERSISTED_MESSAGES_PER_SESSION = 120;

  function createSessionStore() {
    function createChatId() {
      return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function normalizeRole(role) {
      return role === "assistant" ? "assistant" : "user";
    }

    function createTitleFromMessage(message) {
      const normalized = String(message || "").replace(/\s+/g, " ").trim();
      if (!normalized) {
        return "New chat";
      }

      return normalized.length > constants.CHAT_TITLE_MAX
        ? `${normalized.slice(0, constants.CHAT_TITLE_MAX - 1)}...`
        : normalized;
    }

    function normalizeStoredMessage(message) {
      if (!message || typeof message !== "object") {
        return null;
      }

      const role = normalizeRole(message.role);
      const content = String(message.content || "").trim();
      const imagePath = role === "user" ? String(message.imagePath || message.imageUrl || "").trim() : "";
      const legacyImageBase64 = role === "user" ? String(message.imageBase64 || "").trim() : "";
      const type = role === "assistant" ? String(message.type || "").trim() : "";
      const imageUrl = role === "assistant" ? String(message.imageUrl || "").trim() : "";
      const imageUrls = role === "assistant" && Array.isArray(message.imageUrls)
        ? message.imageUrls.filter(Boolean)
        : [];
      const imagePrompt =
        role === "assistant" ? String(message.imagePrompt || message.prompt || "").trim() : "";
      const imageMessage =
        role === "assistant" ? String(message.imageMessage || message.message || "").trim() : "";
      const files = Array.isArray(message.files)
        ? message.files
            .map((file) => {
              if (!file || typeof file !== "object") {
                return null;
              }
              const path = String(file.path || file.filePath || "").trim();
              if (!path) {
                return null;
              }
              return {
                path,
                filePath: path,
                fileName: String(file.fileName || file.name || "").trim(),
                outputType: String(file.outputType || file.type || "").trim()
              };
            })
            .filter(Boolean)
        : [];

      if (!content && !imagePath && !legacyImageBase64 && !imageUrl && files.length === 0) {
        return null;
      }

      return {
        role,
        content,
        imagePath,
        legacyImageBase64,
        files,
        type,
        imageUrl,
        imageUrls,
        imagePrompt,
        imageMessage
      };
    }

    function truncatePersistedText(value) {
      const text = String(value || "").trim();
      if (!text) {
        return "";
      }
      return text.length > MAX_PERSISTED_TEXT_CHARS
        ? `${text.slice(0, MAX_PERSISTED_TEXT_CHARS)}...`
        : text;
    }

    function sanitizePersistedImagePath(value) {
      const raw = String(value || "").trim();
      if (!raw) {
        return "";
      }

      // Never persist inline base64 blobs in localStorage.
      if (/^data:image\//i.test(raw)) {
        return "";
      }

      return raw;
    }

    function sanitizePersistedImageUrls(values) {
      if (!Array.isArray(values)) {
        return [];
      }

      return values
        .map((value) => sanitizePersistedImagePath(value))
        .filter(Boolean)
        .slice(0, 8);
    }

    function truncateText(text, maxChars) {
      const trimmed = String(text || "").replace(/\s+/g, " ").trim();
      if (!trimmed) {
        return "";
      }

      return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 3)}...` : trimmed;
    }

    function buildRecentMessagesFromMessages(messages) {
      return (messages || [])
        .map((message) => ({
          role: normalizeRole(message && message.role),
          content: String(message && message.content ? message.content : "").trim()
        }))
        .filter((message) => message.content.length > 0)
        .slice(-MEMORY_MAX_MESSAGES);
    }

    function buildSummaryFromMessages(messages) {
      const items = Array.isArray(messages) ? messages : [];
      if (items.length <= MEMORY_SUMMARY_TRIGGER) {
        return "";
      }

      const olderMessages = items.slice(0, Math.max(0, items.length - MEMORY_MAX_MESSAGES));
      const lines = [];
      let totalChars = 0;

      olderMessages.forEach((message) => {
        const role = normalizeRole(message && message.role);
        const prefix = role === "assistant" ? "Assistant" : "User";
        const snippet = truncateText(message && message.content, MEMORY_SNIPPET_MAX_CHARS);
        if (!snippet) {
          return;
        }

        const line = `- ${prefix}: ${snippet}`;
        totalChars += line.length;
        if (totalChars > MEMORY_SUMMARY_MAX_CHARS) {
          return;
        }
        lines.push(line);
      });

      return lines.length > 0 ? lines.join("\n") : "";
    }

    function buildMemoryFromMessages(messages) {
      const recentMessages = buildRecentMessagesFromMessages(messages);
      const summarizedMemory = buildSummaryFromMessages(messages);

      return {
        recentMessages,
        summarizedMemory
      };
    }

    function buildConversationFromMessages(messages) {
      return messages
        .map((message) => ({
          role: normalizeRole(message.role),
          content: String(message.content || "").trim()
        }))
        .filter((message) => message.content.length > 0)
        .slice(-12);
    }

    function createChatSession(seed = {}) {
      const now = Date.now();
      const baseMessages = Array.isArray(seed.messages)
        ? seed.messages.map(normalizeStoredMessage).filter(Boolean)
        : [];
      const memory = buildMemoryFromMessages(baseMessages);
      const conversationItems = Array.isArray(seed.conversation)
        ? seed.conversation
            .map((item) => ({
              role: normalizeRole(item && item.role),
              content: String(item && item.content ? item.content : "").trim()
            }))
            .filter((item) => item.content.length > 0)
            .slice(-12)
        : buildConversationFromMessages(baseMessages);
      const title =
        String(seed.title || "").trim() ||
        createTitleFromMessage(baseMessages.find((message) => message.role === "user")?.content);

      return {
        id: String(seed.id || createChatId()),
        title,
        messages: baseMessages,
        conversation: conversationItems,
        recentMessages: memory.recentMessages,
        summarizedMemory: memory.summarizedMemory,
        renamed: Boolean(seed.renamed),
        createdAt: Number(seed.createdAt || now),
        updatedAt: Number(seed.updatedAt || now)
      };
    }

    function createDefaultSession() {
      var showWelcome = false;
      try {
        if (typeof localStorage !== "undefined") {
          showWelcome = String(localStorage.getItem("ifda-show-welcome") || "").trim() === "1";
        }
      } catch (e) {
        showWelcome = false;
      }

      return createChatSession({
        title: "New chat",
        messages: showWelcome ? [{ role: "assistant", content: constants.WELCOME_MESSAGE }] : []
      });
    }

    function normalizeStoredSession(session) {
      if (!session || typeof session !== "object") {
        return null;
      }

      const normalized = createChatSession(session);
      return normalized.id ? normalized : null;
    }

    function loadState() {
      if (typeof localStorage === "undefined") {
        return { sessions: [], activeChatId: null };
      }

      const primaryKey = String(constants.CHAT_STORAGE_KEY || "ai-intern-chat-sessions-v2");
      const candidateKeys = [
        primaryKey,
        `${primaryKey}:backup`,
        "ai-intern-chat-sessions-v1",
        "ai-intern-chat-sessions"
      ];

      function parseState(rawValue) {
        const parsed = JSON.parse(rawValue);
        const rawSessions = Array.isArray(parsed) ? parsed : parsed && parsed.sessions;
        const activeId = Array.isArray(parsed) ? null : String((parsed && parsed.activeChatId) || "");
        if (!Array.isArray(rawSessions)) {
          return null;
        }

        return {
          sessions: rawSessions
            .map(normalizeStoredSession)
            .filter(Boolean)
            .slice(0, constants.CHAT_STORAGE_MAX),
          activeChatId: activeId || null
        };
      }

      try {
        for (const key of candidateKeys) {
          const raw = localStorage.getItem(key);
          if (!raw) {
            continue;
          }

          try {
            const nextState = parseState(raw);
            if (nextState) {
              return nextState;
            }
          } catch (_error) {
            // Try next fallback key.
          }
        }

        return { sessions: [], activeChatId: null };
      } catch (error) {
        console.error("Unable to load chat history:", error);
        return { sessions: [], activeChatId: null };
      }
    }

    function saveState(payload = {}) {
      if (typeof localStorage === "undefined") {
        return;
      }

      try {
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        const normalizedSessions = sessions.slice(0, constants.CHAT_STORAGE_MAX).map((session) => ({
          ...session,
          messages: (session.messages || []).slice(-MAX_PERSISTED_MESSAGES_PER_SESSION).map((message) => ({
            role: normalizeRole(message.role),
            content: truncatePersistedText(message.content),
            imagePath: sanitizePersistedImagePath(message.imagePath),
            files: Array.isArray(message.files) ? message.files : [],
            type: String(message.type || "").trim(),
            imageUrl: sanitizePersistedImagePath(message.imageUrl),
            imageUrls: sanitizePersistedImageUrls(message.imageUrls),
            imagePrompt: truncatePersistedText(message.imagePrompt),
            imageMessage: truncatePersistedText(message.imageMessage)
          })),
          conversation: buildConversationFromMessages(session.messages || []),
          recentMessages: buildRecentMessagesFromMessages(session.messages || []),
          summarizedMemory: buildSummaryFromMessages(session.messages || [])
        }));

        const serialized = JSON.stringify({
          activeChatId: String(payload.activeChatId || ""),
          sessions: normalizedSessions
        });

        const primaryKey = String(constants.CHAT_STORAGE_KEY || "ai-intern-chat-sessions-v2");
        localStorage.setItem(primaryKey, serialized);
        localStorage.setItem(`${primaryKey}:backup`, serialized);
      } catch (error) {
        console.error("Unable to save chat history:", error);
      }
    }

    async function migrateLegacyImages(sessions, assistantAPI) {
      if (!assistantAPI || typeof assistantAPI.storeScreenshot !== "function") {
        return false;
      }

      function extractBase64FromDataUrl(value) {
        const raw = String(value || "").trim();
        if (!raw) {
          return "";
        }
        const match = raw.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i);
        return match && match[1] ? match[1] : "";
      }

      async function persistAssistantImage(value) {
        const base64Value = extractBase64FromDataUrl(value);
        if (!base64Value) {
          return String(value || "").trim();
        }

        try {
          const stored = await assistantAPI.storeScreenshot({
            base64Screenshot: base64Value,
            prefix: "generated"
          });
          return String((stored && stored.imagePath) || "").trim();
        } catch (_error) {
          return "";
        }
      }

      let didChange = false;

      for (const session of sessions) {
        for (const message of session.messages || []) {
          if (!message.legacyImageBase64 || message.imagePath) {
            // Continue below to allow assistant image migration even when user legacy image does not apply.
          } else {
            try {
              const stored = await assistantAPI.storeScreenshot({
                base64Screenshot: message.legacyImageBase64,
                prefix: "migrated"
              });
              message.imagePath = String((stored && stored.imagePath) || "").trim();
              message.legacyImageBase64 = "";
              didChange = true;
            } catch (_error) {}
          }

          if (normalizeRole(message.role) !== "assistant") {
            continue;
          }

          const persistedImageUrl = await persistAssistantImage(message.imageUrl);
          if (persistedImageUrl && persistedImageUrl !== String(message.imageUrl || "").trim()) {
            message.imageUrl = persistedImageUrl;
            didChange = true;
          }

          if (Array.isArray(message.imageUrls) && message.imageUrls.length > 0) {
            const nextImageUrls = [];
            for (const item of message.imageUrls) {
              const persisted = await persistAssistantImage(item);
              nextImageUrls.push(persisted || String(item || "").trim());
            }

            const changedUrls =
              nextImageUrls.length !== message.imageUrls.length ||
              nextImageUrls.some((item, index) => item !== String(message.imageUrls[index] || "").trim());
            if (changedUrls) {
              message.imageUrls = nextImageUrls.filter(Boolean);
              if (!String(message.imageUrl || "").trim() && message.imageUrls[0]) {
                message.imageUrl = message.imageUrls[0];
              }
              didChange = true;
            }
          }
        }
      }

      return didChange;
    }

    return {
      buildConversationFromMessages,
      buildMemoryFromMessages,
      createChatSession,
      createDefaultSession,
      createTitleFromMessage,
      loadState,
      migrateLegacyImages,
      normalizeRole,
      normalizeStoredMessage,
      saveState
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.sessionStore = {
    createSessionStore
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
