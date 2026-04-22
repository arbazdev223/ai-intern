(function (root) {
  const constants = root.SharedModules.constants;

    function createMessageRenderer(options = {}) {
      const refs = options.refs;
      let autoScrollEnabled = true;
      let mermaidInitialized = false;
      let markedOptionsApplied = false;
      let highlightWarned = false;

    function normalizeFilePath(value) {
      return String(value || "").trim();
    }

    function getFileNameFromPath(filePath) {
      const safePath = String(filePath || "").trim();
      if (!safePath) {
        return "";
      }
      const parts = safePath.split(/[/\\\\]/);
      return parts[parts.length - 1] || safePath;
    }

    function normalizeFiles(files) {
      if (!Array.isArray(files)) {
        return [];
      }

      return files
        .map((file) => {
          if (!file || typeof file !== "object") {
            return null;
          }
          const path = normalizeFilePath(file.path || file.filePath || "");
          if (!path) {
            return null;
          }
          const type = String(file.type || file.outputType || "").trim().toLowerCase();
          const name = String(file.fileName || file.name || getFileNameFromPath(path)).trim();
          return { path, type, name };
        })
        .filter(Boolean);
    }

    function getFileBadgeLabel(type) {
      switch (String(type || "").toLowerCase()) {
        case "pdf":
          return "PDF";
        case "excel":
          return "XLSX";
        case "doc":
        case "docx":
          return "DOCX";
        case "html":
          return "HTML";
        case "json":
          return "JSON";
        case "image":
          return "IMG";
        default:
          return "FILE";
      }
    }

    function createFileAttachments(files) {
      const normalized = normalizeFiles(files);
      if (normalized.length === 0) {
        return null;
      }

      const container = document.createElement("div");
      container.className = "message-files";

      normalized.forEach((file) => {
        const row = document.createElement("div");
        row.className = "message-file";

        const meta = document.createElement("div");
        meta.className = "message-file-meta";

        const badge = document.createElement("span");
        badge.className = "message-file-badge";
        badge.textContent = getFileBadgeLabel(file.type);

        const name = document.createElement("span");
        name.className = "message-file-name";
        name.textContent = file.name || file.path;

        meta.appendChild(badge);
        meta.appendChild(name);

        const actions = document.createElement("div");
        actions.className = "message-file-actions";

        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "message-action-btn message-file-open";
        openBtn.textContent = "Open File";

        const folderBtn = document.createElement("button");
        folderBtn.type = "button";
        folderBtn.className = "message-action-btn message-file-folder";
        folderBtn.textContent = "Open Folder";

        const canOpen = options.assistantAPI && typeof options.assistantAPI.openPath === "function";
        const canShow =
          options.assistantAPI && typeof options.assistantAPI.showItemInFolder === "function";

        openBtn.disabled = !canOpen;
        folderBtn.disabled = !canShow;

        openBtn.addEventListener("click", () => {
          if (canOpen) {
            options.assistantAPI.openPath(file.path).catch(() => {});
          }
        });

        folderBtn.addEventListener("click", () => {
          if (canShow) {
            options.assistantAPI.showItemInFolder(file.path);
          }
        });

        actions.appendChild(openBtn);
        actions.appendChild(folderBtn);
        row.appendChild(meta);
        row.appendChild(actions);
        container.appendChild(row);
      });

      return container;
    }

    function appendFileAttachments(target, files) {
      if (!target) {
        return;
      }
      const attachments = createFileAttachments(files);
      if (!attachments) {
        return;
      }
      target.appendChild(attachments);
    }

    function ensureToastContainer() {
      const existing = document.querySelector(".toast-container");
      if (existing) {
        return existing;
      }

      const container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
      return container;
    }

    function showToast(message, detail, variant = "info") {
      const safeMessage = String(message || "").trim();
      if (!safeMessage) {
        return;
      }

      const container = ensureToastContainer();
      const toast = document.createElement("div");
      toast.className = `toast toast--${variant}`;

      const title = document.createElement("div");
      title.className = "toast-title";
      title.textContent = safeMessage;
      toast.appendChild(title);

      const safeDetail = String(detail || "").trim();
      if (safeDetail) {
        const detailNode = document.createElement("div");
        detailNode.className = "toast-detail";
        detailNode.textContent = safeDetail;
        toast.appendChild(detailNode);
      }

      container.appendChild(toast);

      setTimeout(() => {
        toast.classList.add("toast--hide");
        setTimeout(() => {
          if (toast.parentElement) {
            toast.parentElement.removeChild(toast);
          }
        }, 240);
      }, 3200);
    }

    function createImageLoadingElement(labelText) {
      const loading = document.createElement("div");
      loading.className = "image-loading";

      const spinner = document.createElement("span");
      spinner.className = "image-spinner";

      const loadingText = document.createElement("span");
      loadingText.className = "image-loading-text";
      loadingText.textContent = String(labelText || "Generating image...");

      loading.appendChild(spinner);
      loading.appendChild(loadingText);
      return loading;
    }

    function normalizeImagePayload(value) {
      if (!value || typeof value !== "object") {
        return null;
      }

      const urls = [];

      if (Array.isArray(value.images)) {
        value.images.forEach((item) => {
          if (item && typeof item === "object" && item.url) {
            urls.push(String(item.url).trim());
          } else if (typeof item === "string") {
            urls.push(String(item).trim());
          }
        });
      }

      if (Array.isArray(value.imageUrls)) {
        value.imageUrls.forEach((item) => {
          if (item) {
            urls.push(String(item).trim());
          }
        });
      }

      const singleUrl = String(value.imageUrl || value.url || "").trim();
      if (singleUrl) {
        urls.push(singleUrl);
      }

      const filtered = urls
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      const unique = [];
      const seen = new Set();
      filtered.forEach((item) => {
        if (seen.has(item)) {
          return;
        }
        seen.add(item);
        unique.push(item);
      });

      if (unique.length === 0) {
        return null;
      }

      const message = String(value.message || value.caption || "").trim();
      const prompt = String(value.prompt || "").trim();
      return { imageUrls: unique, message, prompt };
    }

    function createImageBlock(imagePayload) {
      const normalized = normalizeImagePayload(imagePayload);
      if (!normalized) {
        return null;
      }

      const block = document.createElement("div");
      block.className = "chat-image-block";

      const loading = createImageLoadingElement("Generating image...");
      const imageUrls = Array.isArray(normalized.imageUrls) ? normalized.imageUrls : [];
      const frame = document.createElement("div");
      frame.className = "image-frame";

      const grid = document.createElement("div");
      grid.className = imageUrls.length > 1 ? "image-grid image-grid--multi" : "image-grid";

      let loadedCount = 0;
      let failedCount = 0;
      const totalCount = Math.max(1, imageUrls.length);

      const updateLoadingState = () => {
        if (loadedCount > 0) {
          block.classList.add("image-ready");
        }
        if (loadedCount + failedCount < totalCount) {
          return;
        }
        if (loadedCount === 0) {
          const textNode = loading.querySelector(".image-loading-text");
          if (textNode) {
            textNode.textContent = "Failed to load image";
          }
        }
      };

      imageUrls.forEach((url) => {
        if (!url) {
          return;
        }
        const img = document.createElement("img");
        img.alt = normalized.prompt || normalized.message || "Generated image";
        img.loading = "lazy";

        img.addEventListener("load", () => {
          loadedCount += 1;
          updateLoadingState();
        });

        img.addEventListener("error", () => {
          failedCount += 1;
          updateLoadingState();
        });

        img.src = url;

        if (img.complete) {
          if (img.naturalWidth > 0) {
            loadedCount += 1;
          } else {
            failedCount += 1;
          }
          updateLoadingState();
        }

        grid.appendChild(img);
      });

      if (loadedCount > 0) {
        block.classList.add("image-ready");
      }

      frame.appendChild(loading);
      frame.appendChild(grid);
      block.appendChild(frame);

      const actions = document.createElement("div");
      actions.className = "image-actions";

      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.className = "image-action-btn image-download-btn";
      downloadBtn.textContent = "Download Image";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "image-action-btn image-open-btn";
      openBtn.textContent = "Open Image";

      const togglePromptBtn = document.createElement("button");
      togglePromptBtn.type = "button";
      togglePromptBtn.className = "image-action-btn image-prompt-toggle-btn";
      togglePromptBtn.textContent = "Show Prompt";

      const editPromptBtn = document.createElement("button");
      editPromptBtn.type = "button";
      editPromptBtn.className = "image-action-btn image-prompt-edit-btn";
      editPromptBtn.textContent = "Edit Prompt";

      const regenerateBtn = document.createElement("button");
      regenerateBtn.type = "button";
      regenerateBtn.className = "image-action-btn image-regenerate-btn";
      regenerateBtn.textContent = "Regenerate";

      const canDownload =
        options.assistantAPI && typeof options.assistantAPI.downloadImage === "function";
      const canOpen =
        options.assistantAPI && typeof options.assistantAPI.openExternal === "function";
      const primaryUrl = imageUrls[0] || "";
      const isHttpUrl = /^https?:\/\//i.test(primaryUrl);
      const canOpenPath =
        options.assistantAPI && typeof options.assistantAPI.openPath === "function";
      const canOpenImage =
        options.assistantAPI && typeof options.assistantAPI.openImage === "function";
      const canOpenViaDownload = Boolean(canDownload && canOpenPath && primaryUrl);
      const canOpenDirect = Boolean(canOpen && isHttpUrl && !canOpenViaDownload);

      downloadBtn.disabled = !canDownload || !primaryUrl;
      openBtn.disabled = !(canOpenImage || canOpenDirect || canOpenViaDownload);

      let savedPath = "";
      const promptAvailable = Boolean(normalized.prompt);
      togglePromptBtn.disabled = !promptAvailable;
      editPromptBtn.disabled = !promptAvailable;
      regenerateBtn.disabled = !promptAvailable;

      downloadBtn.addEventListener("click", async () => {
        if (!canDownload || !primaryUrl) {
          return;
        }
        downloadBtn.disabled = true;
        const original = downloadBtn.textContent;
        downloadBtn.textContent = "Downloading...";
        try {
          const result = await options.assistantAPI.downloadImage({
            url: primaryUrl,
            fileName: normalized.prompt ? normalized.prompt.slice(0, 32) : ""
          });
          if (result && result.filePath) {
            savedPath = result.filePath;
            showToast("Image saved to Downloads", savedPath);
          }
          downloadBtn.textContent = "Downloaded";
          setTimeout(() => {
            downloadBtn.textContent = original;
            downloadBtn.disabled = false;
          }, 1200);
        } catch (_error) {
          downloadBtn.textContent = "Failed";
          showToast("Failed to download image", "", "error");
          setTimeout(() => {
            downloadBtn.textContent = original;
            downloadBtn.disabled = false;
          }, 1200);
        }
      });

      openBtn.addEventListener("click", () => {
        if (!canOpenImage && !canOpenViaDownload && !canOpenDirect) {
          showToast("Cannot open image", "Open option is unavailable.", "error");
          return;
        }
        openBtn.disabled = true;
        const original = openBtn.textContent;
        openBtn.textContent = "Opening...";
        if (canOpenImage) {
          options.assistantAPI
            .openImage({
              url: primaryUrl,
              fileName: normalized.prompt ? normalized.prompt.slice(0, 32) : ""
            })
            .catch((error) => {
              const detail = error && error.message ? error.message : String(error || "");
              showToast("Failed to open image", detail, "error");
            })
            .finally(() => {
              openBtn.textContent = original;
              openBtn.disabled = !(canOpenImage || canOpenDirect || canOpenViaDownload);
            });
          return;
        }

        if (canOpenViaDownload) {
          options.assistantAPI
            .downloadImage({
              url: primaryUrl,
              fileName: normalized.prompt ? normalized.prompt.slice(0, 32) : ""
            })
            .then(async (result) => {
              if (result && result.filePath) {
                savedPath = result.filePath;
                try {
                  const openResult = await options.assistantAPI.openPath(savedPath);
                  if (openResult) {
                    showToast("Failed to open image", openResult, "error");
                  }
                } catch (_error) {
                  showToast("Failed to open image", "", "error");
                }
                return;
              }
              showToast("Failed to open image", "Download returned no file.", "error");
            })
            .catch((error) => {
              const detail = error && error.message ? error.message : String(error || "");
              showToast("Failed to open image", detail, "error");
            })
            .finally(() => {
              openBtn.textContent = original;
              openBtn.disabled = !(canOpenImage || canOpenDirect || canOpenViaDownload);
            });
          return;
        }

        options.assistantAPI
          .openExternal(primaryUrl)
          .catch((error) => {
            const detail = error && error.message ? error.message : String(error || "");
            showToast("Failed to open image", detail, "error");
          })
          .finally(() => {
            openBtn.textContent = original;
            openBtn.disabled = !(canOpenImage || canOpenDirect || canOpenViaDownload);
          });
      });

      actions.appendChild(downloadBtn);
      actions.appendChild(openBtn);
      actions.appendChild(togglePromptBtn);
      actions.appendChild(editPromptBtn);
      actions.appendChild(regenerateBtn);
      block.appendChild(actions);

      let promptPanel = null;
      if (normalized.prompt) {
        promptPanel = document.createElement("div");
        promptPanel.className = "image-prompt";

        const promptText = document.createElement("pre");
        promptText.className = "image-prompt-text";
        promptText.textContent = normalized.prompt;
        promptPanel.appendChild(promptText);

        togglePromptBtn.addEventListener("click", () => {
          const isOpen = promptPanel.classList.toggle("is-open");
          togglePromptBtn.textContent = isOpen ? "Hide Prompt" : "Show Prompt";
        });

        editPromptBtn.addEventListener("click", () => {
          focusPromptInput(normalized.prompt);
        });

        regenerateBtn.addEventListener("click", () => {
          if (!refs.promptInput || refs.promptInput.disabled) {
            return;
          }
          focusPromptInput(normalized.prompt);
          if (refs.chatForm && typeof refs.chatForm.requestSubmit === "function") {
            refs.chatForm.requestSubmit();
          } else if (refs.sendButton && typeof refs.sendButton.click === "function") {
            refs.sendButton.click();
          }
        });

        block.appendChild(promptPanel);
      }

      if (normalized.message) {
        const caption = document.createElement("p");
        caption.className = "caption";
        caption.textContent = normalized.message;
        block.appendChild(caption);
      }

      return block;
    }

    function appendImageBlock(target, imagePayload) {
      if (!target) {
        return;
      }
      const block = createImageBlock(imagePayload);
      if (!block) {
        return;
      }
      target.appendChild(block);
    }

    function renderImagePlaceholder(labelText = "Generating image...") {
      if (!refs.chatMessages) {
        return null;
      }

      const { row, bubble, meta } = createMessageShell("assistant");
      const content = document.createElement("div");
      content.className = "message-text plain-content";
      content.textContent = String(labelText || "Generating image...");

      const placeholder = document.createElement("div");
      placeholder.className = "chat-image-block image-placeholder";
      const frame = document.createElement("div");
      frame.className = "image-frame";
      frame.appendChild(createImageLoadingElement(labelText));
      placeholder.appendChild(frame);

      if (meta) {
        meta.appendChild(createAssistantActions(() => content.textContent, () => bubble.innerHTML, () => []));
      }
      bubble.appendChild(content);
      bubble.appendChild(placeholder);
      appendMessageRow(row);
      scrollChatToBottom();

      return {
        row,
        remove() {
          if (row && row.parentElement) {
            row.parentElement.removeChild(row);
          }
        }
      };
    }

    function applyMarkedOptions() {
      const marked = root.marked;
      if (!marked || markedOptionsApplied || typeof marked.setOptions !== "function") {
        return;
      }

      const renderer = typeof marked.Renderer === "function" ? new marked.Renderer() : {};
      renderer.code = (code, language) => {
        let safeCode = code;
        let resolvedLanguage = language;

        if (safeCode && typeof safeCode === "object") {
          const codeObject = safeCode;
          const candidateText = codeObject.text ?? codeObject.raw;
          if (typeof candidateText === "string") {
            safeCode = candidateText;
          } else if (candidateText != null) {
            safeCode = String(candidateText);
          }

          if (codeObject.lang) {
            resolvedLanguage = codeObject.lang;
          }
        }

        if (typeof safeCode !== "string") {
          try {
            safeCode = JSON.stringify(safeCode, null, 2);
          } catch (_error) {
            safeCode = String(safeCode);
          }
        }

        const rawLang = String(resolvedLanguage || "").trim();
        const safeLang = rawLang.replace(/[^a-z0-9_+-]/gi, "") || "plaintext";
        return `<pre><code class="language-${safeLang}">${escapeHtml(safeCode)}</code></pre>`;
      };

      marked.setOptions({
        gfm: true,
        breaks: true,
        async: false,
        renderer
      });
      markedOptionsApplied = true;
    }

    function ensureMermaidRenderer() {
      if (!root.mermaid) {
        return null;
      }

      if (!mermaidInitialized && typeof root.mermaid.initialize === "function") {
        root.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark"
        });
        mermaidInitialized = true;
      }

      return root.mermaid;
    }

    function isNearChatBottom(threshold = constants.AUTO_SCROLL_THRESHOLD_PX) {
      if (!refs.chatMessages) {
        return true;
      }

      const distance =
        refs.chatMessages.scrollHeight -
        refs.chatMessages.scrollTop -
        refs.chatMessages.clientHeight;
      return distance <= threshold;
    }

    function handleChatScroll() {
      autoScrollEnabled = isNearChatBottom();
    }

    function scrollChatToBottom(force = false) {
      if (!refs.chatMessages) {
        return;
      }

      if (!force && !autoScrollEnabled) {
        return;
      }

      refs.chatMessages.scrollTop = refs.chatMessages.scrollHeight;
    }

    function getTypingIndicator() {
      if (!refs.chatMessages || !refs.typingIndicator) {
        return null;
      }

      if (refs.typingIndicator.parentElement !== refs.chatMessages) {
        return null;
      }

      return refs.typingIndicator;
    }

    function ensureTypingIndicatorAttached() {
      if (!refs.chatMessages || !refs.typingIndicator) {
        return;
      }

      if (refs.typingIndicator.parentElement !== refs.chatMessages) {
        refs.chatMessages.appendChild(refs.typingIndicator);
      }

      ensureTypingIndicatorStructure();
    }

    function ensureTypingIndicatorStructure() {
      if (!refs.typingIndicator) {
        return;
      }
      const indicator = refs.typingIndicator;
      const isHidden = indicator.classList.contains("hidden");
      indicator.className = "typing-message message-row chat-message assistant chat-message--assistant";
      if (isHidden) {
        indicator.classList.add("hidden");
      }

      if (indicator.querySelector(".typing-indicator-shell") && indicator.querySelector(".message-rail")) {
        return;
      }

      indicator.innerHTML = "";

      const rail = document.createElement("div");
      rail.className = "message-rail";

      const avatar = document.createElement("div");
      avatar.className = "message-avatar message-avatar--assistant";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = "AI";

      const body = document.createElement("div");
      body.className = "message-body";

      const bubble = document.createElement("div");
      bubble.className = "bubble chat-bubble";

      const typingBubble = document.createElement("div");
      typingBubble.className = "typing-indicator-shell";

      const dots = document.createElement("div");
      dots.className = "n-typing-dots";
      dots.setAttribute("aria-hidden", "true");

      for (let index = 0; index < 3; index += 1) {
        dots.appendChild(document.createElement("span"));
      }

      const label = document.createElement("span");
      label.className = "typing-label";
      label.textContent = "AI is thinking";
      typingBubble.appendChild(dots);
      typingBubble.appendChild(label);

      bubble.appendChild(typingBubble);
      body.appendChild(bubble);
      rail.appendChild(avatar);
      rail.appendChild(body);
      indicator.appendChild(rail);
    }

    function appendMessageRow(row) {
      if (!refs.chatMessages || !row) {
        return;
      }

      const typingIndicator = getTypingIndicator();
      if (typingIndicator) {
        refs.chatMessages.insertBefore(row, typingIndicator);
        return;
      }

      refs.chatMessages.appendChild(row);
    }

    function createMessageShell(role) {
      const safeRole = role === "user" ? "user" : "assistant";
      const row = document.createElement("article");
      row.className = `message-row chat-message ${safeRole} chat-message--${safeRole}`;
      row.dataset.role = safeRole;

      const rail = document.createElement("div");
      rail.className = "message-rail";

      const avatar = document.createElement("div");
      avatar.className = `message-avatar message-avatar--${safeRole}`;
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = safeRole === "user" ? "YU" : "AI";

      const body = document.createElement("div");
      body.className = "message-body";

      const meta = document.createElement("div");
      meta.className = "message-meta";

      const metaLeft = document.createElement("div");
      metaLeft.className = "message-meta-left";

      const author = document.createElement("span");
      author.className = "message-author";
      author.textContent = safeRole === "user" ? "" : "Assistant";

      const bubble = document.createElement("div");
      bubble.className = "bubble chat-bubble";

      metaLeft.appendChild(author);
      if (safeRole === "assistant") {
        const badge = document.createElement("span");
        badge.className = "message-badge message-badge--ai";
        badge.textContent = "AI";
        metaLeft.appendChild(badge);
      }

      meta.appendChild(metaLeft);
      body.appendChild(meta);
      body.appendChild(bubble);
      rail.appendChild(avatar);
      rail.appendChild(body);
      row.appendChild(rail);
      return { row, bubble, meta };
    }

    function getCopyResetLabel(button) {
      if (!button) {
        return "Copy";
      }

      if (button.classList.contains("message-copy-btn")) {
        return "Copy message";
      }

      return "Copy";
    }

    function setCopyButtonState(button, label, durationMs = 1500, resetLabel) {
      if (!button) {
        return;
      }

      const original = button.dataset.originalLabel || button.textContent;
      button.dataset.originalLabel = original;
      button.textContent = label;
      button.disabled = true;
      button.classList.add("copy-feedback");

      setTimeout(() => {
        button.classList.remove("copy-feedback");
      }, 360);

      setTimeout(() => {
        button.textContent = resetLabel || original;
        button.disabled = false;
      }, durationMs);
    }

    function extractSourcesBlock(text) {
      const source = String(text || "");
      if (!source) {
        return { cleanText: "", sources: [] };
      }

      const lines = source.split(/\r?\n/);
      const startIndex = lines.findIndex((line) => /^\s*Sources\s*:?\s*$/i.test(String(line || "").trim()));
      if (startIndex === -1) {
        return { cleanText: source, sources: [] };
      }

      const sources = [];
      let endIndex = startIndex + 1;

      for (let i = startIndex + 1; i < lines.length; i += 1) {
        const rawLine = String(lines[i] || "");
        const trimmed = rawLine.trim();
        if (!trimmed) {
          endIndex = i + 1;
          continue;
        }

        // Stop on next section heading.
        if (/^#{1,6}\s+\S+/.test(trimmed)) {
          break;
        }

        const mdLink = trimmed.match(/^\s*[-*]\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/);
        if (mdLink) {
          sources.push({ title: mdLink[1].trim(), url: mdLink[2].trim() });
          endIndex = i + 1;
          continue;
        }

        // Allow bare URLs too.
        const bareUrl = trimmed.match(/^\s*[-*]?\s*(https?:\/\/\S+)\s*$/);
        if (bareUrl) {
          sources.push({ title: bareUrl[1].trim(), url: bareUrl[1].trim() });
          endIndex = i + 1;
          continue;
        }

        // If it's not a list item or link, stop parsing to avoid eating the rest of the answer.
        break;
      }

      const cleanLines = [...lines.slice(0, startIndex), ...lines.slice(endIndex)];
      return {
        cleanText: cleanLines.join("\n").trim(),
        sources
      };
    }

    function normalizeHttpUrl(value) {
      const url = String(value || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return "";
      }
      return url;
    }

    function ensureSourcesPanel() {
      const existing = document.getElementById("sourcesPanelBackdrop");
      if (existing) {
        return existing;
      }

      const backdrop = document.createElement("div");
      backdrop.id = "sourcesPanelBackdrop";
      backdrop.className = "sources-panel-backdrop hidden";

      const panel = document.createElement("div");
      panel.className = "sources-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", "Sources");

      const header = document.createElement("div");
      header.className = "sources-panel-header";

      const title = document.createElement("div");
      title.className = "sources-panel-title";
      title.textContent = "Sources";

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "sources-panel-close";
      closeBtn.textContent = "×";
      closeBtn.title = "Close";

      header.appendChild(title);
      header.appendChild(closeBtn);

      const list = document.createElement("div");
      list.className = "sources-panel-list";

      panel.appendChild(header);
      panel.appendChild(list);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);

      const hide = () => {
        backdrop.classList.add("hidden");
        try { backdrop.setAttribute("aria-hidden", "true"); } catch (_e) {}
      };

      closeBtn.addEventListener("click", hide);
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) {
          hide();
        }
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !backdrop.classList.contains("hidden")) {
          hide();
        }
      });

      return backdrop;
    }

    function showSourcesPanel(sources) {
      const normalizedSources = Array.isArray(sources) ? sources : [];
      if (normalizedSources.length === 0) {
        return;
      }

      const backdrop = ensureSourcesPanel();
      const panel = backdrop.querySelector(".sources-panel");
      const list = backdrop.querySelector(".sources-panel-list");
      if (!panel || !list) {
        return;
      }

      list.innerHTML = "";

      normalizedSources.forEach((src) => {
        const title = String(src && src.title ? src.title : "").trim();
        const url = normalizeHttpUrl(src && src.url ? src.url : "");
        if (!url) {
          return;
        }

        const card = document.createElement("button");
        card.type = "button";
        card.className = "sources-panel-item";

        const label = document.createElement("div");
        label.className = "sources-panel-item-title";
        label.textContent = title || url;

        const meta = document.createElement("div");
        meta.className = "sources-panel-item-url";
        meta.textContent = url;

        card.appendChild(label);
        card.appendChild(meta);

        card.addEventListener("click", async () => {
          try {
            const opener = options.assistantAPI?.openExternal || window.assistantAPI?.openExternal;
            if (typeof opener === "function") {
              const result = await opener(url);
              if (result === false) {
                throw new Error("External open rejected");
              }
              showToast("Opened source", url, "success");
              return;
            }
            const win = window.open(url, "_blank", "noopener,noreferrer");
            if (!win) {
              throw new Error("Popup blocked");
            }
            showToast("Opened source", url, "success");
          } catch (error) {
            try {
              const plainCopy =
                (typeof navigator !== "undefined" &&
                  navigator.clipboard &&
                  typeof navigator.clipboard.writeText === "function")
                  ? (text) => navigator.clipboard.writeText(String(text || ""))
                  : null;

              if (plainCopy) {
                await plainCopy(url);
                showToast("Could not open link. URL copied.", url, "warning");
                return;
              }
            } catch (_e) {}

            showToast("Could not open link", String(error && error.message ? error.message : error), "warning");
          }
        });

        list.appendChild(card);
      });

      backdrop.classList.remove("hidden");
      try { backdrop.setAttribute("aria-hidden", "false"); } catch (_e) {}
    }

    async function copyToClipboard(text) {
      const safeText = String(text || "");
      console.log("Copy triggered:", safeText.length);
      console.log("electronAPI available:", window.electronAPI);

      try {
        if (typeof window.electronAPI?.copyText === "function") {
          console.log("Using Electron clipboard");
          const result = window.electronAPI.copyText(safeText);
          if (result && typeof result.then === "function") {
            await result;
          }
          return;
        }

        const assistantCopy =
          options.assistantAPI?.writeClipboardText || window.assistantAPI?.writeClipboardText;
        if (typeof assistantCopy === "function") {
          console.log("Using assistantAPI clipboard");
          const result = assistantCopy(safeText);
          if (result && typeof result.then === "function") {
            await result;
          }
          return;
        }

        throw new Error("No clipboard API available");
      } catch (err) {
        return Promise.reject(err);
      }
    }

    async function copyCodeText(text, button) {
      try {
        await copyToClipboard(text);
        setCopyButtonState(button, "Copied \u2713");
      } catch (error) {
        console.error("Code copy failed:", error);
        setCopyButtonState(button, "Failed", 1500, getCopyResetLabel(button));
      }
    }

    async function copyRichToClipboard(payload) {
      const data = payload && typeof payload === "object" ? payload : {};
      const safeText = String(data.text || "");
      const safeHtml = String(data.html || "");

      try {
        // Prefer browser Clipboard API when available: it matches the same pathway as manual selection copy
        // and is more compatible with destinations like Google Docs.
        if (
          safeHtml &&
          typeof navigator !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.write === "function" &&
          typeof window !== "undefined" &&
          typeof window.ClipboardItem === "function"
        ) {
          const htmlBlob = new Blob([safeHtml], { type: "text/html" });
          const textBlob = new Blob([safeText], { type: "text/plain" });
          await navigator.clipboard.write([
            new window.ClipboardItem({
              "text/html": htmlBlob,
              "text/plain": textBlob
            })
          ]);
          return;
        }

        if (safeHtml && typeof window.electronAPI?.copyRich === "function") {
          const result = window.electronAPI.copyRich({ text: safeText, html: safeHtml });
          if (result && typeof result.then === "function") {
            await result;
          }
          return;
        }

        const assistantCopyRich =
          options.assistantAPI?.writeClipboardRich || window.assistantAPI?.writeClipboardRich;
        if (safeHtml && typeof assistantCopyRich === "function") {
          const result = assistantCopyRich({ text: safeText, html: safeHtml });
          if (result && typeof result.then === "function") {
            await result;
          }
          return;
        }

        // Fallback to plain text copy.
        await copyToClipboard(safeText);
      } catch (err) {
        return Promise.reject(err);
      }
    }

    function createAssistantActions(getRawText, getHtml, getSources) {
      const actions = document.createElement("div");
      actions.className = "message-actions";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "message-copy-btn";
      btn.textContent = "Copy message";
      btn.title = "Copy entire assistant response";

      btn.addEventListener("click", () => {
        const text = String(getRawText ? getRawText() : "");
        const html = typeof getHtml === "function" ? String(getHtml() || "") : "";

        copyRichToClipboard({ text, html })
          .then(() => setCopyButtonState(btn, "Copied \u2713"))
          .catch((error) => {
            console.error("Message copy failed:", error);
            setCopyButtonState(btn, "Failed", 1500, getCopyResetLabel(btn));
          });
      });

      actions.appendChild(btn);

      const sources = typeof getSources === "function" ? getSources() : [];
      if (Array.isArray(sources) && sources.length > 0) {
        const sourcesBtn = document.createElement("button");
        sourcesBtn.type = "button";
        sourcesBtn.className = "message-copy-btn message-sources-btn";
        sourcesBtn.textContent = `Sources (${sources.length})`;
        sourcesBtn.title = "View sources";
        sourcesBtn.addEventListener("click", () => {
          showSourcesPanel(sources);
        });
        actions.appendChild(sourcesBtn);
      }

      return actions;
    }

    function isEditableUserText(text) {
      const normalized = String(text || "").trim();
      if (!normalized) {
        return false;
      }

      return normalized !== "[Screenshot attached]";
    }

    function focusPromptInput(text) {
      if (!refs.promptInput) {
        return;
      }

      refs.promptInput.value = String(text || "");
      refs.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
      refs.promptInput.focus();

      const length = refs.promptInput.value.length;
      if (typeof refs.promptInput.setSelectionRange === "function") {
        refs.promptInput.setSelectionRange(length, length);
      }
    }

    function createUserActions(messageText, handlers = {}) {
      const actions = document.createElement("div");
      actions.className = "message-actions";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "message-action-btn message-copy-btn";
      copyBtn.textContent = "Copy";
      copyBtn.title = "Copy this message";

      copyBtn.addEventListener("click", () => {
        copyCodeText(String(messageText || ""), copyBtn);
      });

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "message-action-btn message-edit-btn";
      editBtn.textContent = "Edit";

      const editable = isEditableUserText(messageText);
      editBtn.disabled = !editable;
      editBtn.title = editable ? "Edit and resend this message" : "No text to edit";

      editBtn.addEventListener("click", () => {
        if (typeof handlers.onEdit === "function") {
          handlers.onEdit();
          return;
        }
        focusPromptInput(messageText);
      });

      actions.appendChild(copyBtn);
      actions.appendChild(editBtn);
      return actions;
    }

    function createInlineEditPanel(messageText) {
      const panel = document.createElement("div");
      panel.className = "message-edit-panel hidden";

      const textarea = document.createElement("textarea");
      textarea.className = "message-edit-textarea";
      textarea.rows = 3;
      textarea.value = String(messageText || "");

      const actions = document.createElement("div");
      actions.className = "message-edit-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "message-action-btn message-edit-cancel";
      cancelBtn.textContent = "Cancel";

      const resendBtn = document.createElement("button");
      resendBtn.type = "button";
      resendBtn.className = "message-action-btn message-edit-send";
      resendBtn.textContent = "Resend";

      actions.appendChild(cancelBtn);
      actions.appendChild(resendBtn);
      panel.appendChild(textarea);
      panel.appendChild(actions);

      return { panel, textarea, cancelBtn, resendBtn };
    }

    function normalizeFenceLines(text) {
      return String(text || "")
        .replace(/(^|\n)```([^\n]*)\\n/g, "$1```$2\n")
        .replace(/\\n```/g, "\n```");
    }

    function normalizeHeadingLines(text) {
      return String(text || "").replace(/(^|\n)\s{0,3}\\?#/g, "$1#");
    }

    function normalizeEscapedMarkdownDecorators(text) {
      return String(text || "")
        .replace(/\\#/g, "#")
        .replace(/\\>/g, ">")
        .replace(/\\-/g, "-");
    }

    function normalizeEscapedListMarkers(text) {
      return String(text || "").replace(/(^|\n)\s*\\?([*-])\s+/g, "$1- ");
    }

    function normalizeInlineCodeEscapes(text) {
      return String(text || "").replace(/\\`/g, "`");
    }

    function hasCodeFenceLikeContent(text) {
      return /```/.test(String(text || ""));
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function renderTextWithCodeFences(text) {
      const source = String(text || "");
      const parts = source.split(/(```[\s\S]*?```)/g);

      return parts
        .map((part) => {
          if (!part.startsWith("```")) {
            return `<p>${escapeHtml(part).replace(/\n/g, "<br />")}</p>`;
          }

          const match = part.match(/^```([^\n]*)\n?([\s\S]*?)```$/);
          const language = match ? String(match[1] || "").trim() : "";
          const code = match ? match[2] : part.replace(/```/g, "");
          const safeLanguage = escapeHtml(language) || "plaintext";
          const className = ` class="language-${safeLanguage}"`;
          return `<pre><code${className}>${escapeHtml(code)}</code></pre>`;
        })
        .join("");
    }

    function normalizeAssistantText(rawText) {
      let normalized = String(rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const escapedNewlines = (normalized.match(/\\n/g) || []).length;
      const realNewlines = (normalized.match(/\n/g) || []).length;

      if (escapedNewlines > 1 && realNewlines <= 1) {
        normalized = normalized
          .replace(/\\r\\n/g, "\n")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t");
      }

      normalized = normalizeEscapedMarkdownDecorators(normalized);
      normalized = normalizeEscapedListMarkers(normalized);
      normalized = normalizeInlineCodeEscapes(normalized);
      normalized = normalized.replace(/\\`\\`\\`/g, "```");
      normalized = normalizeFenceLines(normalized);
      normalized = normalizeHeadingLines(normalized);
      return normalized.trim();
    }

    function normalizeMessageContent(value) {
      if (typeof value === "string") {
        return value;
      }

      if (value == null) {
        return "";
      }

      try {
        return JSON.stringify(value, null, 2);
      } catch (_error) {
        return String(value);
      }
    }

    function renderAssistantPlainText(text) {
      const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      return renderTextWithCodeFences(normalized);
    }

    function parseMarkdownHtml(markdownText) {
      const marked = root.marked;
      applyMarkedOptions();

      if (!marked) {
        return "";
      }

      try {
        if (typeof marked.parse === "function") {
          return marked.parse(String(markdownText || ""), {
            gfm: true,
            breaks: true,
            async: false
          });
        }

        if (typeof marked === "function") {
          return marked(String(markdownText || ""), {
            gfm: true,
            breaks: true,
            async: false
          });
        }
      } catch (_error) {}

      return "";
    }

    function sanitizeRenderedHtml(html) {
      const unsafeHtml = String(html || "");
      const domPurify = root.DOMPurify;

      if (domPurify && typeof domPurify.sanitize === "function") {
        return domPurify.sanitize(unsafeHtml, {
          USE_PROFILES: { html: true },
          ALLOW_DATA_ATTR: false,
          ADD_TAGS: ["h1", "h2", "h3", "h4", "h5", "h6"]
        });
      }

      const template = document.createElement("template");
      template.innerHTML = unsafeHtml;
      template.content
        .querySelectorAll("script, style, iframe, object, embed, link, meta")
        .forEach((node) => node.remove());

      template.content.querySelectorAll("*").forEach((node) => {
        Array.from(node.attributes).forEach((attr) => {
          const name = attr.name.toLowerCase();
          const value = String(attr.value || "");

          if (name.startsWith("on")) {
            node.removeAttribute(attr.name);
            return;
          }

          if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) {
            node.removeAttribute(attr.name);
          }
        });
      });

      return template.innerHTML;
    }

    function renderAssistantMarkdown(text) {
      const normalizedText = normalizeAssistantText(text);
      let rendered = parseMarkdownHtml(normalizedText);

      if (hasCodeFenceLikeContent(normalizedText) && rendered && !rendered.includes("<pre><code")) {
        rendered = parseMarkdownHtml(normalizeFenceLines(normalizedText)) || rendered;
      }

      if (rendered) {
        return sanitizeRenderedHtml(rendered);
      }

      return sanitizeRenderedHtml(renderAssistantPlainText(normalizedText));
    }

    function enhanceMarkdownContent(container) {
      if (!container) {
        return;
      }

      container.querySelectorAll("a[href]").forEach((link) => {
        const href = String(link.getAttribute("href") || "").trim();
        if (!href) {
          return;
        }

        const isExternal = /^(https?:)?\/\//i.test(href) || href.startsWith("mailto:");
        if (isExternal) {
          link.setAttribute("target", "_blank");
          link.setAttribute("rel", "noopener noreferrer");

          link.addEventListener("click", (event) => {
            event.preventDefault();
            options.assistantAPI.openExternal(href).catch(() => {});
          });
        }
      });

      container.querySelectorAll("table").forEach((table) => {
        if (table.parentElement && table.parentElement.classList.contains("markdown-table-wrap")) {
          return;
        }

        const wrapper = document.createElement("div");
        wrapper.className = "markdown-table-wrap";
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      });
    }

    function normalizeCodeLanguage(language) {
      return String(language || "")
        .trim()
        .toLowerCase()
        .replace(/^language-/, "");
    }

    function resolveCodeLanguage(codeBlock) {
      if (!codeBlock) {
        return "";
      }

      const className = String(codeBlock.className || "");
      const classMatch = className.match(/language-([A-Za-z0-9_+-]+)/);
      if (classMatch) {
        return classMatch[1];
      }

      return String(codeBlock.dataset.lang || "").trim();
    }

    function isMermaidCodeBlock(codeBlock) {
      return normalizeCodeLanguage(resolveCodeLanguage(codeBlock)) === "mermaid";
    }

    function setCodeLanguageClass(codeBlock, language) {
      if (!codeBlock) {
        return "";
      }

      const normalized = normalizeCodeLanguage(language);
      if (!normalized) {
        return "";
      }

      Array.from(codeBlock.classList)
        .filter((item) => item.startsWith("language-"))
        .forEach((item) => codeBlock.classList.remove(item));
      codeBlock.classList.add(`language-${normalized}`);
      return normalized;
    }

    function formatCodeLanguageLabel(language) {
      const normalized = normalizeCodeLanguage(language);
      if (!normalized) {
        return "Code";
      }

      const labels = {
        js: "JavaScript",
        ts: "TypeScript",
        py: "Python",
        sh: "Shell",
        md: "Markdown"
      };

      return labels[normalized] || normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    function applyHighlighting(container) {
      if (!container) {
        return false;
      }

      const hljs = root.hljs;
      if (!hljs || typeof hljs.highlightElement !== "function") {
        if (!highlightWarned) {
          console.warn("highlight.js not loaded");
          highlightWarned = true;
        }
        return false;
      }

      const blocks = container.querySelectorAll("pre code");
      blocks.forEach((block) => {
        if (isMermaidCodeBlock(block)) {
          return;
        }

        if (block.classList.contains("hljs")) {
          return;
        }

        try {
          const resolvedLanguage = normalizeCodeLanguage(resolveCodeLanguage(block));

          if (resolvedLanguage) {
            setCodeLanguageClass(block, resolvedLanguage);
            hljs.highlightElement(block);
            block.classList.add("hljs");
            return;
          }

          const auto = hljs.highlightAuto(String(block.textContent || ""));
          if (auto && typeof auto.value === "string") {
            block.innerHTML = auto.value;
          }

          const detected = normalizeCodeLanguage(auto && auto.language);
          setCodeLanguageClass(block, detected || "plaintext");
          block.classList.add("hljs");
        } catch (_error) {}
      });

      return true;
    }

    function highlightCodeBlocks(container) {
      if (applyHighlighting(container)) {
        return;
      }

      const blocks = container.querySelectorAll("pre code");

      blocks.forEach((block) => {
        if (isMermaidCodeBlock(block)) {
          return;
        }

        try {
          const rawCode = String(block.textContent || "");
          const language = normalizeCodeLanguage(resolveCodeLanguage(block));
          const codeSignature = `${language || "auto"}:${rawCode}`;
          if (block.dataset.hljsSignature === codeSignature && block.classList.contains("hljs")) {
            return;
          }

          const result = options.assistantAPI.highlightCode(rawCode, language);
          block.innerHTML = String((result && result.html) || "");
          const detectedLanguage = normalizeCodeLanguage(result && result.language);
          if (detectedLanguage) {
            setCodeLanguageClass(block, detectedLanguage);
            block.dataset.detectedLanguage = detectedLanguage;
          } else if (!language) {
            setCodeLanguageClass(block, "plaintext");
          }

          block.classList.add("hljs");
          block.dataset.hljsSignature = codeSignature;
        } catch (_error) {}
      });
    }

    function attachCodeCopyButtons(container) {
      const preBlocks = container.querySelectorAll("pre");

      preBlocks.forEach((pre) => {
        if (pre.parentElement && pre.parentElement.classList.contains("code-block-container")) {
          return;
        }

        const codeNode = pre.querySelector("code");
        const languageFromClass = codeNode ? resolveCodeLanguage(codeNode) : "";
        const detectedLanguage = codeNode ? String(codeNode.dataset.detectedLanguage || "") : "";
        const languageLabel = formatCodeLanguageLabel(detectedLanguage || languageFromClass);

        const wrapper = document.createElement("div");
        wrapper.className = "code-block-container";
        if (constants.ENABLE_CODE_LINE_NUMBERS) {
          wrapper.classList.add("show-line-numbers");
        }

        const header = document.createElement("div");
        header.className = "code-block-header";

        const languageChip = document.createElement("span");
        languageChip.className = "code-language-label";
        languageChip.textContent = languageLabel;

        const actionWrap = document.createElement("div");
        actionWrap.className = "code-block-actions";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "code-copy-btn";
        btn.textContent = "Copy";
        btn.title = "Copy code";

        btn.addEventListener("click", () => {
          const liveCode = codeNode ? codeNode.innerText : pre.innerText;
          copyCodeText(liveCode, btn);
        });

        actionWrap.appendChild(btn);
        header.appendChild(languageChip);
        header.appendChild(actionWrap);

        if (pre.parentNode) {
          pre.parentNode.insertBefore(wrapper, pre);
          wrapper.appendChild(header);
          wrapper.appendChild(pre);
        }
      });
    }

    async function renderMermaidDiagrams(container) {
      if (!container) {
        return;
      }

      const mermaidBlocks = Array.from(
        container.querySelectorAll("pre code.language-mermaid, pre code[class*='language-mermaid']")
      );

      if (mermaidBlocks.length === 0) {
        return;
      }

      const mermaid = ensureMermaidRenderer();
      if (!mermaid) {
        return;
      }

      for (let index = 0; index < mermaidBlocks.length; index += 1) {
        const block = mermaidBlocks[index];
        const pre = block.closest("pre");
        const source = String(block.textContent || "").trim();
        if (!pre || !source) {
          continue;
        }

        const targetNode =
          pre.parentElement && pre.parentElement.classList.contains("code-block-container")
            ? pre.parentElement
            : pre;

        const diagramHost = document.createElement("div");
        diagramHost.className = "mermaid-diagram";

        try {
          const id = `mermaid-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
          if (typeof mermaid.render === "function") {
            const output = await mermaid.render(id, source);
            const svg = typeof output === "string" ? output : String((output && output.svg) || "");
            diagramHost.innerHTML = svg;
            if (output && typeof output.bindFunctions === "function") {
              output.bindFunctions(diagramHost);
            }
          } else {
            diagramHost.classList.add("mermaid");
            diagramHost.textContent = source;
            if (typeof mermaid.run === "function") {
              await mermaid.run({ nodes: [diagramHost] });
            }
          }

          if (targetNode.parentNode) {
            targetNode.parentNode.replaceChild(diagramHost, targetNode);
          }
        } catch (error) {
          console.error("Mermaid diagram render failed:", error);
        }
      }
    }

    function renderAssistantContent(content, markdownText, state = {}, optionsArg = {}) {
      if (!content) {
        return;
      }

      const renderedHtml = renderAssistantMarkdown(markdownText);
      if (state.lastHtml === renderedHtml) {
        if (optionsArg.enableMermaid && !state.mermaidRendered) {
          state.mermaidRendered = true;
          renderMermaidDiagrams(content).then(
            () => {
              if (state.lastHtml !== renderedHtml) {
                return;
              }
              highlightCodeBlocks(content);
              attachCodeCopyButtons(content);
            },
            () => {
              if (state.lastHtml !== renderedHtml) {
                return;
              }
              highlightCodeBlocks(content);
              attachCodeCopyButtons(content);
            }
          );
        }
        return;
      }

      state.lastHtml = renderedHtml;
      state.mermaidRendered = false;
      content.innerHTML = renderedHtml;

      enhanceMarkdownContent(content);
      const renderSignature = renderedHtml;
      const finalizeCodeRendering = () => {
        if (state.lastHtml !== renderSignature) {
          return;
        }

        highlightCodeBlocks(content);
        attachCodeCopyButtons(content);
      };

      if (optionsArg.enableMermaid) {
        state.mermaidRendered = true;
        renderMermaidDiagrams(content).then(finalizeCodeRendering, finalizeCodeRendering);
        return;
      }

      finalizeCodeRendering();
    }

    function chunkAssistantText(text) {
      const source = String(text || "");
      if (!source) {
        return [];
      }

      return source
        .split(/(\s+)/)
        .filter((token) => token !== "");
    }

    function createStreamingMessageController(optionsArg = {}) {
      if (!refs.chatMessages) {
        return null;
      }

      const { row, bubble, meta } = createMessageShell("assistant");
      let streamText = "";
      let streamSources = [];

      const content = document.createElement("div");
      content.className = "message-text markdown-content markdown-body streaming-cursor";
      content.style.whiteSpace = "pre-wrap";
      const actions = createAssistantActions(() => streamText, () => content.innerHTML, () => streamSources);
      const renderState = { lastHtml: "" };
      let pendingTextPaint = false;
      let debounceHandle = null;

      if (meta) {
        meta.appendChild(actions);
      }
      bubble.appendChild(content);
      appendMessageRow(row);
      scrollChatToBottom();

      const flushPlainText = (force = false) => {
        if (!force && !pendingTextPaint) {
          return;
        }
        pendingTextPaint = false;
        content.textContent = streamText;
        scrollChatToBottom();
      };

      const schedule = () => {
        pendingTextPaint = true;
        if (debounceHandle) {
          return;
        }

        debounceHandle = setTimeout(() => {
          debounceHandle = null;
          flushPlainText(true);
        }, constants.STREAM_RENDER_DEBOUNCE_MS);
      };

      return {
        append(chunk) {
          const safeChunk = String(chunk || "");
          if (!safeChunk) {
            return;
          }
          streamText += safeChunk;
          schedule();
        },
        async finish(optionsArg = {}) {
          const enableMermaid = optionsArg.enableMermaid !== false;
          if (!streamText.trim()) {
            streamText = "No response from the model.";
          }

          const extracted = extractSourcesBlock(streamText);
          streamText = extracted.cleanText;
          streamSources = extracted.sources;

          if (debounceHandle) {
            clearTimeout(debounceHandle);
            debounceHandle = null;
          }

          pendingTextPaint = true;
          flushPlainText(true);
          renderAssistantContent(content, streamText, renderState, { enableMermaid });
          content.classList.remove("streaming-cursor");
          content.style.whiteSpace = "";
          appendFileAttachments(bubble, optionsArg.files || optionsArg.attachments || optionsArg.fileList);
          appendImageBlock(bubble, optionsArg.image || optionsArg.imagePayload);
          scrollChatToBottom();
        }
      };
    }

    async function renderAssistantStream(markdownText, optionsArg = {}) {
      const streamController = createStreamingMessageController(optionsArg);
      if (!streamController) {
        return null;
      }

      const normalizedText = normalizeMessageContent(markdownText);
      const chunks = chunkAssistantText(normalizedText);
      if (chunks.length === 0) {
        streamController.append("No response from the model.");
        await streamController.finish({ enableMermaid: true, files: optionsArg.files });
        return null;
      }

      const wordDelayMs = Math.max(constants.STREAM_CHUNK_DELAY_MS, 28);
      for (const chunk of chunks) {
        streamController.append(chunk);
        if (chunk.trim()) {
          await new Promise((resolve) => setTimeout(resolve, wordDelayMs));
        }
      }

      await streamController.finish({
        enableMermaid: true,
        files: optionsArg.files,
        image: optionsArg.image
      });
      return null;
    }

    function hideEmptyState() {
      try {
        var emptyEl = typeof document !== 'undefined' ? document.getElementById('nEmptyState') : null;
        if (emptyEl) {
          try { emptyEl.style.display = 'none'; emptyEl.setAttribute('aria-hidden', 'true'); } catch (e) {}
        }
      } catch (e) {}
    }

    function renderAssistantMessage(markdownText, optionsArg = {}) {
      if (!refs.chatMessages) {
        return null;
      }

      const { row, bubble, meta } = createMessageShell("assistant");
      const rawText = normalizeMessageContent(markdownText);
      const extracted = extractSourcesBlock(rawText);
      const cleanText = extracted.cleanText;
      const sources = extracted.sources;
      const content = document.createElement("div");
      content.className = "message-text markdown-content markdown-body";
      const actions = createAssistantActions(() => rawText, () => content.innerHTML, () => sources);

      renderAssistantContent(content, cleanText, {}, { enableMermaid: true });
      if (meta) {
        meta.appendChild(actions);
      }
      bubble.appendChild(content);
      // hide the empty hero immediately when an assistant message is rendered
      hideEmptyState();
      appendFileAttachments(bubble, optionsArg.files);
      appendImageBlock(bubble, optionsArg.image || optionsArg.imagePayload);
      appendMessageRow(row);
      scrollChatToBottom();
      return row;
    }

    function renderImagePromptAction(optionsArg = {}) {
      if (!refs.chatMessages) {
        return null;
      }

      const message = String(optionsArg.message || "🎨 Image prompt detected").trim();
      const prompt = String(optionsArg.prompt || "").trim();
      const onGenerate = typeof optionsArg.onGenerate === "function" ? optionsArg.onGenerate : null;

      const { row, bubble, meta } = createMessageShell("assistant");
      const content = document.createElement("div");
      content.className = "message-text plain-content";
      content.textContent = message || "🎨 Image prompt detected";

      const actionsWrap = document.createElement("div");
      actionsWrap.className = "image-actions";

      const generateBtn = document.createElement("button");
      generateBtn.type = "button";
      generateBtn.className = "image-action-btn image-generate-btn";
      generateBtn.textContent = "Generate Image";
      generateBtn.disabled = !prompt;

      generateBtn.addEventListener("click", () => {
        if (!prompt) {
          return;
        }

        if (onGenerate) {
          onGenerate(prompt);
          return;
        }

        if (!refs.promptInput || refs.promptInput.disabled) {
          return;
        }

        focusPromptInput(prompt);
        if (refs.chatForm && typeof refs.chatForm.requestSubmit === "function") {
          refs.chatForm.requestSubmit();
        } else if (refs.sendButton && typeof refs.sendButton.click === "function") {
          refs.sendButton.click();
        }
      });

      actionsWrap.appendChild(generateBtn);
      bubble.appendChild(content);
      bubble.appendChild(actionsWrap);

      if (meta) {
        meta.appendChild(createAssistantActions(() => content.textContent, () => bubble.innerHTML, () => []));
      }

      hideEmptyState();
      appendMessageRow(row);
      scrollChatToBottom();
      return row;
    }

    function renderUserMessage(text, optionsArg = {}) {
      if (!refs.chatMessages) {
        return null;
      }

      const { row, bubble, meta } = createMessageShell("user");
      const safeText = String(text || "").trim();
      const isEditable = isEditableUserText(safeText);

      if (safeText.length > 0) {
        const content = document.createElement("div");
        content.className = "message-text plain-content";
        content.textContent = safeText;
        bubble.appendChild(content);
      }

      // hide the empty hero immediately when a user message is rendered
      hideEmptyState();

      if (optionsArg.imagePath) {
        bubble.classList.add("chat-bubble--with-image");
        const imageWrap = document.createElement("div");
        imageWrap.className = "chat-image-block user-image-block image-ready";

        const frame = document.createElement("div");
        frame.className = "image-frame";

        const img = document.createElement("img");
        img.className = "chat-image message-image";
        img.alt = "Screenshot preview";
        img.src = optionsArg.imagePath;

        frame.appendChild(img);
        imageWrap.appendChild(frame);
        bubble.appendChild(imageWrap);
      }

      if (meta) {
        let editPanelControls = null;

        if (isEditable) {
          editPanelControls = createInlineEditPanel(safeText);
          bubble.appendChild(editPanelControls.panel);

          editPanelControls.cancelBtn.addEventListener("click", () => {
            editPanelControls.panel.classList.add("hidden");
          });

          editPanelControls.resendBtn.addEventListener("click", () => {
            const nextValue = String(editPanelControls.textarea.value || "").trim();
            if (!nextValue) {
              return;
            }

            if (refs.promptInput && refs.promptInput.disabled) {
              return;
            }

            focusPromptInput(nextValue);
            if (refs.chatForm && typeof refs.chatForm.requestSubmit === "function") {
              refs.chatForm.requestSubmit();
            } else if (refs.sendButton && typeof refs.sendButton.click === "function") {
              refs.sendButton.click();
            }
            editPanelControls.panel.classList.add("hidden");
          });
        }

        meta.appendChild(
          createUserActions(safeText, {
            onEdit: () => {
              if (!editPanelControls) {
                focusPromptInput(safeText);
                return;
              }

              const panel = editPanelControls.panel;
              const isHidden = panel.classList.contains("hidden");
              if (isHidden) {
                editPanelControls.textarea.value = safeText;
                panel.classList.remove("hidden");
                editPanelControls.textarea.focus();
                const length = editPanelControls.textarea.value.length;
                editPanelControls.textarea.setSelectionRange(length, length);
              } else {
                panel.classList.add("hidden");
              }
            }
          })
        );
      }

      appendMessageRow(row);
      scrollChatToBottom();
      return row;
    }

    function clearMessages() {
      if (!refs.chatMessages) {
        return;
      }
      const typingIndicator = refs.typingIndicator;
      // Remove all message children except the typing indicator and the empty-state element
      try {
        const keepId = "nEmptyState";
        const children = Array.from(refs.chatMessages.children || []);
        children.forEach(function (ch) {
          if (ch === typingIndicator) return;
          if (ch && ch.id === keepId) return;
          try { ch.remove(); } catch (e) {}
        });
      } catch (e) {
        // fallback: clear everything
        refs.chatMessages.innerHTML = "";
      }
      // ensure typing indicator is attached
      if (typingIndicator && (!typingIndicator.parentElement || typingIndicator.parentElement !== refs.chatMessages)) {
        refs.chatMessages.appendChild(typingIndicator);
      }
    }

    function renderSessionMessages(messages) {
      clearMessages();
      var emptyEl = typeof document !== 'undefined' ? document.getElementById('nEmptyState') : null;
      if (!messages || (Array.isArray(messages) && messages.length === 0)) {
        // show empty hero when there are no messages
        if (emptyEl && refs.chatMessages) {
          refs.chatMessages.appendChild(emptyEl);
          try { emptyEl.style.display = ''; emptyEl.setAttribute('aria-hidden', 'false'); } catch (e) {}
        }
        if (refs.typingIndicator) {
          refs.typingIndicator.classList.add('hidden');
          try { refs.typingIndicator.setAttribute('aria-hidden', 'true'); } catch (e) {}
        }
        autoScrollEnabled = true;
        scrollChatToBottom(true);
        return;
      }

      if (emptyEl) {
        try { emptyEl.style.display = 'none'; emptyEl.setAttribute('aria-hidden', 'true'); } catch (e) {}
      }

      (messages || []).forEach((message) => {
        if (message.role === "assistant") {
          if (message.type === "image_prompt") {
            renderImagePromptAction({
              message: message.imageMessage || message.message || message.content,
              prompt: message.imagePrompt || ""
            });
            return;
          }

          if (message.type === "hybrid") {
            const hybridImagePayload = {
              imageUrl: message.imageUrl,
              imageUrls: Array.isArray(message.imageUrls) ? message.imageUrls : [],
              message: message.imageMessage || message.message || "Explanation + image generated",
              prompt: message.imagePrompt
            };
            renderAssistantMessage(message.explanation || message.content, {
              files: message.files,
              image: hybridImagePayload
            });
            return;
          }

          const imagePayload = message && (message.type === "image" || message.imageUrl)
            ? {
                imageUrl: message.imageUrl,
                imageUrls: Array.isArray(message.imageUrls) ? message.imageUrls : [],
                message: message.imageMessage || message.message || message.content,
                prompt: message.imagePrompt
              }
            : null;
          renderAssistantMessage(message.content, { files: message.files, image: imagePayload });
          return;
        }

        renderUserMessage(message.content, {
          imagePath: String(message.imagePath || "")
        });
      });

      autoScrollEnabled = true;
      scrollChatToBottom(true);
    }

    function init() {
      if (refs.chatMessages) {
        refs.chatMessages.addEventListener("scroll", handleChatScroll, { passive: true });
      }
      ensureTypingIndicatorAttached();
    }

    return {
      clearMessages,
      init,
      renderImagePromptAction,
      renderImagePlaceholder,
      renderAssistantMessage,
      renderAssistantStream,
      renderSessionMessages,
      renderUserMessage
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.messageRenderer = {
    createMessageRenderer
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
