(function (root) {
  function createLegacyModalController(options = {}) {
    const refs = options.refs || {};
    const constants = root.SharedModules && root.SharedModules.constants;
    const chatStorageKey = constants && constants.CHAT_STORAGE_KEY
      ? String(constants.CHAT_STORAGE_KEY)
      : "ai-intern-chat-sessions-v2";

    function getElement(id) {
      return typeof document !== "undefined" ? document.getElementById(id) : null;
    }

    function openModal(id) {
      const modal = getElement(id);
      if (!modal) {
        return;
      }

      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
    }

    function closeModal(id) {
      const modal = getElement(id);
      if (!modal) {
        return;
      }

      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
    }

    function loadChatSessions() {
      if (typeof localStorage === "undefined") {
        return [];
      }

      try {
        const raw = localStorage.getItem(chatStorageKey) || "";
        if (!raw) {
          return [];
        }

        const parsed = JSON.parse(raw);
        const sessions = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.sessions) ? parsed.sessions : [];
        return Array.isArray(sessions) ? sessions : [];
      } catch (_error) {
        return [];
      }
    }

    function renderAskedQuestions(filterText = "") {
      const list = getElement("aqList");
      if (!list) {
        return;
      }

      const filter = String(filterText || "").trim().toLowerCase();
      const sessions = loadChatSessions();
      list.innerHTML = "";

      if (!sessions.length) {
        list.innerHTML = '<p class="ifda-modal-empty">No past chats found</p>';
        return;
      }

      sessions.forEach((session) => {
        const title = String(session && session.title ? session.title : "").trim() || "Untitled";
        const recentMessages = Array.isArray(session && session.recentMessages) ? session.recentMessages : [];
        const messages = Array.isArray(session && session.messages) ? session.messages : [];
        const preview = recentMessages.length
          ? recentMessages.map((message) => String(message && message.content ? message.content : "")).join(" — ")
          : messages.slice(-3).map((message) => String(message && message.content ? message.content : "")).join(" — ");
        const haystack = `${title} ${preview}`.toLowerCase();

        if (filter && !haystack.includes(filter)) {
          return;
        }

        const item = document.createElement("div");
        item.className = "aq-item";
        item.style.cursor = "pointer";

        const createdAt = Number(session && session.createdAt);
        const createdLabel = Number.isFinite(createdAt) ? new Date(createdAt).toLocaleString() : "";

        item.innerHTML =
          '<div style="flex:1">' +
          `<strong style="display:block">${title.replace(/</g, "&lt;")}</strong>` +
          `<small style="color:var(--muted);">${createdLabel}</small>` +
          `<div style="margin-top:6px;color:var(--muted);font-size:13px;">${(preview || "—").replace(/</g, "&lt;")}</div>` +
          "</div>" +
          '<div style="margin-left:8px;flex-shrink:0"><button class="aq-copy-btn" title="Copy">Copy</button></div>';

        item.addEventListener("click", (event) => {
          if (refs.promptInput) {
            refs.promptInput.value = `${title}\n\n${preview}`.trim();
            refs.promptInput.focus();
          }
          closeModal("askedQuestionsModal");
          event.stopPropagation();
        });

        const copyBtn = item.querySelector(".aq-copy-btn");
        if (copyBtn) {
          copyBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            const text = `${title}\n\n${preview}`.trim();
            try {
              if (root.electronAPI && typeof root.electronAPI.copyText === "function") {
                await root.electronAPI.copyText(text);
              } else if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
              }
              copyBtn.textContent = "✓";
              setTimeout(() => {
                copyBtn.textContent = "Copy";
              }, 1200);
            } catch (_error) {}
          });
        }

        list.appendChild(item);
      });

      if (!list.firstChild) {
        list.innerHTML = '<p class="ifda-modal-empty">No chats match your search</p>';
      }
    }

    function submitCourseHelp() {
      const input = getElement("chInput");
      const value = String((input && input.value) || "").trim();
      if (!value) {
        return;
      }

      if (refs.promptInput) {
        refs.promptInput.value = value;
      }
      if (refs.chatForm && typeof refs.chatForm.requestSubmit === "function") {
        refs.chatForm.requestSubmit();
      }
      closeModal("courseHelpModal");
    }

    function init() {
      document.querySelectorAll(".ifda-modal-backdrop").forEach((backdrop) => {
        backdrop.addEventListener("click", (event) => {
          if (event.target === backdrop) {
            closeModal(backdrop.id);
          }
        });
      });

      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") {
          return;
        }

        document.querySelectorAll(".ifda-modal-backdrop:not(.hidden)").forEach((modal) => {
          closeModal(modal.id);
        });
      });

      const aqModalClose = getElement("aqModalClose");
      const aqSearch = getElement("aqSearch");
      const menuAskedQuestionsBtn = getElement("menuAskedQuestionsBtn");
      if (aqModalClose) {
        aqModalClose.addEventListener("click", () => closeModal("askedQuestionsModal"));
      }
      if (aqSearch) {
        aqSearch.addEventListener("input", () => renderAskedQuestions(aqSearch.value));
      }
      if (menuAskedQuestionsBtn) {
        menuAskedQuestionsBtn.addEventListener("click", () => {
          closeModal("mobileMenuModal");
          openModal("askedQuestionsModal");
          renderAskedQuestions("");
          if (aqSearch) {
            aqSearch.value = "";
            aqSearch.focus();
          }
        });
      }

      const menuPromptLibraryBtn = getElement("menuPromptLibraryBtn");
      if (menuPromptLibraryBtn) {
        menuPromptLibraryBtn.addEventListener("click", () => {
          closeModal("mobileMenuModal");
          document.dispatchEvent(new CustomEvent("ifda:openPromptLibrary"));
        });
      }

      const promptLibraryDesktopBtn = getElement("promptLibraryDesktopBtn");
      if (promptLibraryDesktopBtn) {
        promptLibraryDesktopBtn.addEventListener("click", () => {
          document.dispatchEvent(new CustomEvent("ifda:openPromptLibrary"));
        });
      }

      const chModalClose = getElement("chModalClose");
      const chModalCancel = getElement("chModalCancel");
      const chAskBtn = getElement("chAskBtn");
      const chInput = getElement("chInput");
      if (chModalClose) {
        chModalClose.addEventListener("click", () => closeModal("courseHelpModal"));
      }
      if (chModalCancel) {
        chModalCancel.addEventListener("click", () => closeModal("courseHelpModal"));
      }
      if (chAskBtn) {
        chAskBtn.addEventListener("click", submitCourseHelp);
      }
      if (chInput) {
        chInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitCourseHelp();
          }
        });
      }
    }

    return {
      init
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.legacyModals = {
    createLegacyModalController
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
