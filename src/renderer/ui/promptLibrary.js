(function (root) {
  const constants = root.SharedModules.constants;
  const PROMPT_LIBRARY_API_BASE = "https://ims.ifda.in/api/prompt-library";
  const PROMPT_LIBRARY_TOKEN_KEY = "assistant.promptLibraryBearerToken";
  const PROMPT_LIBRARY_MASTER_SECRET_KEY = "assistant.promptLibraryMasterSecret";
  const PROMPT_LIBRARY_USER_ID_KEY = "assistant.promptLibraryUserId";
  const PROMPT_LIBRARY_API_TIMEOUT_MS = 15000;

  function createPromptLibraryController(options = {}) {
    const refs = options.refs;
    let savedPrompts = [];
    let activePromptTemplateId = "";
    let activeSavedPromptId = "";
    let activePromptCategoryId = "";
    let promptSearchQuery = "";
    let lastPromptCatalog = [];
    let savedPromptDialogState = null;
    let promptCategories = [];

    function createSavedPromptId() {
      return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function normalizeSavedPromptItem(item) {
      if (!item || typeof item !== "object") {
        return null;
      }

      const id = String(item.id || createSavedPromptId()).trim();
      const rawTitle = String(item.title || "").replace(/\s+/g, " ").trim();
      const title =
        rawTitle.length > constants.CHAT_TITLE_MAX
          ? `${rawTitle.slice(0, constants.CHAT_TITLE_MAX - 1)}...`
          : rawTitle;
      const prompt = String(item.prompt || "").trim();

      if (!id || !title || !prompt) {
        return null;
      }

      return { id, title, prompt };
    }

    function normalizePromptTemplateItem(item) {
      if (!item || typeof item !== "object") {
        return null;
      }

      const id = String(item.id || "").trim();
      const title = String(item.title || "").trim();
      const prompt = String(item.prompt || "").trim();
      const categoryId = String(item.categoryId || "").trim();

      if (!id || !title || !prompt || !categoryId) {
        return null;
      }

      return {
        id,
        title,
        prompt,
        categoryId
      };
    }

    function readSetting(key) {
      if (typeof localStorage === "undefined") {
        return "";
      }

      try {
        return String(localStorage.getItem(key) || "").trim();
      } catch (_error) {
        return "";
      }
    }

    function getAuthContext() {
      const token = readSetting(PROMPT_LIBRARY_TOKEN_KEY);
      const masterSecret = readSetting(PROMPT_LIBRARY_MASTER_SECRET_KEY);
      const userId = readSetting(PROMPT_LIBRARY_USER_ID_KEY);

      if (token) {
        return { mode: "bearer", token, masterSecret: "", userId: "" };
      }

      if (masterSecret) {
        return { mode: "master", token: "", masterSecret, userId };
      }

      return { mode: "none", token: "", masterSecret: "", userId: "" };
    }

    function buildAuthHeaders(authContext) {
      const headers = {
        "Content-Type": "application/json"
      };

      if (!authContext || authContext.mode === "none") {
        return headers;
      }

      if (authContext.mode === "bearer") {
        headers.Authorization = `Bearer ${authContext.token}`;
      } else if (authContext.mode === "master") {
        headers["x-master-secret"] = authContext.masterSecret;
      }

      return headers;
    }

    async function apiRequest(path, requestOptions = {}) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => {
            controller.abort();
          }, PROMPT_LIBRARY_API_TIMEOUT_MS)
        : null;

      try {
        const response = await fetch(`${PROMPT_LIBRARY_API_BASE}${path}`, {
          method: requestOptions.method || "GET",
          headers: requestOptions.headers || {},
          body: requestOptions.body,
          signal: controller ? controller.signal : undefined
        });

        const text = await response.text();
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (_error) {
          payload = {};
        }

        if (!response.ok) {
          const message =
            (payload && payload.message && String(payload.message)) ||
            `Prompt library API request failed (${response.status}).`;
          throw new Error(message);
        }

        return payload;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    function parseArrayPayload(payload) {
      if (Array.isArray(payload)) {
        return payload;
      }

      if (payload && Array.isArray(payload.data)) {
        return payload.data;
      }

      return [];
    }

    function setPromptCategories(nextCategories) {
      if (!Array.isArray(nextCategories) || nextCategories.length === 0) {
        return;
      }

      promptCategories = nextCategories;
    }

    async function fetchCategoriesFromApi() {
      const payload = await apiRequest("/categories");
      const rows = parseArrayPayload(payload);

      return rows
        .map((item) => {
          const id = String(item && item.id ? item.id : "").trim();
          const title = String(item && item.title ? item.title : "").trim();
          const description = String(item && item.description ? item.description : "").trim();
          const sortOrder = Number(item && item.sortOrder);

          if (!id || !title) {
            return null;
          }

          return {
            id,
            title,
            description,
            sortOrder: Number.isFinite(sortOrder) ? sortOrder : 100,
            prompts: []
          };
        })
        .filter(Boolean)
        .sort((left, right) => left.sortOrder - right.sortOrder);
    }

    async function fetchTemplatesFromApi() {
      const payload = await apiRequest("/templates?page=1&limit=500");
      const rows = parseArrayPayload(payload);
      return rows.map(normalizePromptTemplateItem).filter(Boolean);
    }

    async function hydratePromptCatalogFromApi() {
      try {
        const [categories, templates] = await Promise.all([
          fetchCategoriesFromApi(),
          fetchTemplatesFromApi()
        ]);

        if (!categories.length) {
          return;
        }

        const byId = new Map();
        categories.forEach((category) => {
          byId.set(category.id, {
            id: category.id,
            title: category.title,
            description: category.description,
            sortOrder: category.sortOrder,
            prompts: []
          });
        });

        templates.forEach((template) => {
          const bucket = byId.get(template.categoryId);
          if (!bucket) {
            return;
          }

          bucket.prompts.push({
            id: template.id,
            title: template.title,
            prompt: template.prompt
          });
        });

        const normalized = Array.from(byId.values()).filter((item) => item.prompts.length > 0);
        if (!normalized.length) {
          return;
        }

        setPromptCategories(normalized);
        renderPromptLibrary();
        refreshPromptBrowserIfOpen();
      } catch (_error) {
        // Fallback stays on local constants when API is unavailable.
      }
    }

    async function fetchSavedPromptsFromApi() {
      const authContext = getAuthContext();
      if (authContext.mode === "none") {
        return null;
      }

      let query = "";
      if (authContext.mode === "master" && authContext.userId) {
        query = `?userId=${encodeURIComponent(authContext.userId)}`;
      }

      const payload = await apiRequest(`/saved${query}`, {
        method: "GET",
        headers: buildAuthHeaders(authContext)
      });

      return parseArrayPayload(payload).map(normalizeSavedPromptItem).filter(Boolean);
    }

    async function createSavedPromptOnApi(payload) {
      const authContext = getAuthContext();
      if (authContext.mode === "none") {
        return null;
      }

      const body = {
        title: payload.title,
        prompt: payload.prompt,
        sourceTemplateId: payload.sourceTemplateId || undefined,
        isFavorite: Boolean(payload.isFavorite)
      };

      if (authContext.mode === "master" && authContext.userId) {
        body.userId = authContext.userId;
      }

      const response = await apiRequest("/saved", {
        method: "POST",
        headers: buildAuthHeaders(authContext),
        body: JSON.stringify(body)
      });

      const created = response && response.data ? response.data : response;
      return normalizeSavedPromptItem(created);
    }

    async function updateSavedPromptOnApi(promptId, payload) {
      const authContext = getAuthContext();
      if (authContext.mode === "none") {
        return false;
      }

      const body = {
        title: payload.title,
        prompt: payload.prompt,
        isFavorite: payload.isFavorite
      };

      if (authContext.mode === "master" && authContext.userId) {
        body.userId = authContext.userId;
      }

      await apiRequest(`/saved/${encodeURIComponent(promptId)}`, {
        method: "PATCH",
        headers: buildAuthHeaders(authContext),
        body: JSON.stringify(body)
      });

      return true;
    }

    async function deleteSavedPromptOnApi(promptId) {
      const authContext = getAuthContext();
      if (authContext.mode === "none") {
        return false;
      }

      await apiRequest(`/saved/${encodeURIComponent(promptId)}`, {
        method: "DELETE",
        headers: buildAuthHeaders(authContext)
      });

      return true;
    }

    function loadSavedPrompts() {
      if (typeof localStorage === "undefined") {
        return [];
      }

      try {
        const raw = localStorage.getItem(constants.SAVED_PROMPTS_KEY);
        if (!raw) {
          return [];
        }

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return [];
        }

        return parsed.map(normalizeSavedPromptItem).filter(Boolean).slice(0, constants.SAVED_PROMPTS_MAX);
      } catch (error) {
        console.error("Unable to load saved prompts:", error);
        return [];
      }
    }

    function saveSavedPrompts() {
      if (typeof localStorage === "undefined") {
        return;
      }

      try {
        localStorage.setItem(
          constants.SAVED_PROMPTS_KEY,
          JSON.stringify(savedPrompts.slice(0, constants.SAVED_PROMPTS_MAX))
        );
      } catch (error) {
        console.error("Unable to save prompts:", error);
      }
    }

    function fillPromptInput(promptText) {
      if (!refs.promptInput) {
        return;
      }

      const text = String(promptText || "").trim();
      if (!text) {
        return;
      }

      refs.promptInput.value = text;
      if (typeof options.autoResizeInput === "function") {
        options.autoResizeInput();
      }
      refs.promptInput.focus();

      const length = refs.promptInput.value.length;
      if (typeof refs.promptInput.setSelectionRange === "function") {
        refs.promptInput.setSelectionRange(length, length);
      }

      options.setStatus("Prompt inserted into input.");
    }

    async function copyPromptText(text) {
      const safeText = String(text || "").trim();
      if (!safeText) {
        return;
      }

      try {
        if (typeof root.electronAPI?.copyText === "function") {
          const result = root.electronAPI.copyText(safeText);
          if (result && typeof result.then === "function") {
            await result;
          }
          options.setStatus("Prompt copied.");
          return;
        }

        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(safeText);
          options.setStatus("Prompt copied.");
          return;
        }

        options.setStatus("Copy is unavailable in this environment.");
      } catch (_error) {
        options.setStatus("Could not copy prompt.");
      }
    }

    function getPromptCategoryFilters() {
      const base = promptCategories.map((category) => ({
        id: category.id,
        title: category.title
      }));

      return [
        { id: "all", title: "All" },
        ...base,
        { id: "my-prompts", title: "My Prompts" }
      ];
    }

    function buildPromptCatalog() {
      const libraryEntries = promptCategories.flatMap((category) =>
        category.prompts.map((item) => ({
          key: `library:${item.id}`,
          source: "library",
          templateId: item.id,
          savedId: "",
          categoryId: category.id,
          categoryTitle: category.title,
          title: String(item.title || "").trim(),
          prompt: String(item.prompt || "").trim()
        }))
      );

      const savedEntries = savedPrompts.map((item) => ({
        key: `saved:${item.id}`,
        source: "saved",
        templateId: "",
        savedId: item.id,
        categoryId: "my-prompts",
        categoryTitle: "My Prompts",
        title: String(item.title || "").trim(),
        prompt: String(item.prompt || "").trim()
      }));

      return [...savedEntries, ...libraryEntries];
    }

    function getPromptCatalogItemByKey(itemKey) {
      const key = String(itemKey || "");
      return lastPromptCatalog.find((item) => item.key === key) || null;
    }

    function renderPromptBrowserCategoryChips() {
      if (!refs.promptBrowserCategoryChips) {
        return;
      }

      const selectedId = activePromptCategoryId || "all";
      refs.promptBrowserCategoryChips.innerHTML = "";

      getPromptCategoryFilters().forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "prompt-browser-category-chip";
        if (item.id === selectedId) {
          button.classList.add("active");
        }
        button.dataset.categoryId = item.id;
        button.textContent = item.title;
        refs.promptBrowserCategoryChips.appendChild(button);
      });
    }

    function getPromptLibraryCategory(categoryId) {
      const id = String(categoryId || "");
      return promptCategories.find((category) => category.id === id) || null;
    }

    function findPromptTemplateById(templateId) {
      const id = String(templateId || "");
      for (const category of promptCategories) {
        const item = category.prompts.find((prompt) => prompt.id === id);
        if (item) {
          return { category, item };
        }
      }
      return null;
    }

    function renderPromptLibrary() {
      if (!refs.promptLibraryList) {
        return;
      }

      refs.promptLibraryList.innerHTML = "";

      promptCategories.forEach((category) => {
        const li = document.createElement("li");
        li.className = "prompt-library-item";
        li.dataset.promptCategoryId = category.id;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "prompt-library-btn";
        if (category.id === activePromptCategoryId) {
          button.classList.add("active");
        }
        button.dataset.promptCategoryId = category.id;
        button.textContent = category.title;
        button.title = category.description;

        const description = document.createElement("p");
        description.className = "prompt-library-description";
        description.textContent = category.description;

        li.appendChild(button);
        li.appendChild(description);
        refs.promptLibraryList.appendChild(li);
      });
    }

    function renderPromptBrowser() {
      if (!refs.promptBrowserCards || !refs.promptBrowserPanel) {
        return;
      }

      const activeCategory = activePromptCategoryId || "all";
      const search = String(promptSearchQuery || "").trim().toLowerCase();
      const catalog = buildPromptCatalog();

      lastPromptCatalog = catalog.filter((item) => {
        const categoryMatch = activeCategory === "all" ? true : item.categoryId === activeCategory;
        if (!categoryMatch) {
          return false;
        }

        if (!search) {
          return true;
        }

        const haystack = `${item.title} ${item.prompt} ${item.categoryTitle}`.toLowerCase();
        return haystack.includes(search);
      });

      renderPromptBrowserCategoryChips();

      if (refs.promptBrowserEyebrow) {
        refs.promptBrowserEyebrow.textContent = "Prompt Library";
      }
      if (refs.promptBrowserTitle) {
        refs.promptBrowserTitle.textContent = "Prompt Library";
      }
      if (refs.promptBrowserSubtitle) {
        refs.promptBrowserSubtitle.textContent =
          lastPromptCatalog.length > 0
            ? `${lastPromptCatalog.length} prompt${lastPromptCatalog.length > 1 ? "s" : ""} available for quick use.`
            : "No prompts found. Try another search or create your own prompt.";
      }

      refs.promptBrowserCards.innerHTML = "";

      if (lastPromptCatalog.length === 0) {
        const empty = document.createElement("div");
        empty.className = "prompt-browser-empty";
        empty.innerHTML =
          '<p class="prompt-browser-empty-title">No prompts found</p><p class="prompt-browser-empty-sub">Try a different keyword or click Create Prompt to add your own.</p>';
        refs.promptBrowserCards.appendChild(empty);
      }

      lastPromptCatalog.forEach((item) => {
        const card = document.createElement("article");
        card.className = "prompt-browser-card";
        card.dataset.promptKey = item.key;

        const top = document.createElement("div");
        top.className = "prompt-browser-card-top";

        const title = document.createElement("h3");
        title.className = "prompt-browser-card-title";
        title.textContent = item.title || "Untitled prompt";

        const badge = document.createElement("span");
        badge.className = "prompt-browser-card-badge";
        badge.textContent = item.categoryTitle;

        const text = document.createElement("p");
        text.className = "prompt-browser-card-text";
        text.textContent = item.prompt;

        const actions = document.createElement("div");
        actions.className = "prompt-browser-card-actions";

        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "prompt-browser-card-btn primary";
        useBtn.dataset.browserAction = "use";
        useBtn.dataset.promptKey = item.key;
        useBtn.textContent = "Use";

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "prompt-browser-card-btn";
        copyBtn.dataset.browserAction = "copy";
        copyBtn.dataset.promptKey = item.key;
        copyBtn.textContent = "Copy";

        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "prompt-browser-card-btn";
        saveBtn.dataset.browserAction = "save";
        saveBtn.dataset.promptKey = item.key;
        saveBtn.textContent = item.source === "saved" ? "Saved" : "Save";
        saveBtn.disabled = item.source === "saved";

        top.appendChild(title);
        top.appendChild(badge);
        actions.appendChild(useBtn);
        actions.appendChild(copyBtn);
        actions.appendChild(saveBtn);
        card.appendChild(top);
        card.appendChild(text);
        card.appendChild(actions);
        refs.promptBrowserCards.appendChild(card);
      });

      // hide hero when rendering list
      if (refs.promptBrowserHero) {
        refs.promptBrowserHero.classList.add("hidden");
        try { refs.promptBrowserHero.setAttribute('aria-hidden', 'true'); } catch (e) {}
      }
    }

    function showPromptDetails(templateId) {
      const resolved = findPromptTemplateById(templateId);
      if (!resolved || !refs.promptBrowserHero) return;

      const item = resolved.item;
      activePromptTemplateId = item.id;
      // set hero title
      if (refs.promptBrowserHeroTitle) {
        refs.promptBrowserHeroTitle.textContent = item.title || "";
      }
      // set full prompt
      if (refs.promptBrowserFullPrompt) {
        refs.promptBrowserFullPrompt.textContent = item.prompt || "";
      }
      // set image if provided (supports item.image)
      if (refs.promptBrowserHeroImage) {
        if (item.image) {
          refs.promptBrowserHeroImage.src = item.image;
          refs.promptBrowserHeroImage.style.display = "block";
        } else {
          refs.promptBrowserHeroImage.src = "";
          refs.promptBrowserHeroImage.style.display = "none";
        }
      }

      // show hero
      refs.promptBrowserHero.classList.remove("hidden");
      try { refs.promptBrowserHero.setAttribute('aria-hidden', 'false'); } catch (e) {}

      renderPromptBrowser();
    }

    function renderSavedPromptList() {
      if (!refs.savedPromptList) {
        return;
      }

      refs.savedPromptList.innerHTML = "";

      if (savedPrompts.length === 0) {
        const empty = document.createElement("li");
        empty.className = "saved-prompt-empty";
        empty.textContent = "No saved prompts yet.";
        refs.savedPromptList.appendChild(empty);
        return;
      }

      savedPrompts.forEach((item) => {
        const li = document.createElement("li");
        li.className = "saved-prompt-item";
        li.dataset.promptId = item.id;

        const topRow = document.createElement("div");
        topRow.className = "sidebar-item-row";

        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "saved-prompt-select";
        if (item.id === activeSavedPromptId) {
          useBtn.classList.add("active");
        }
        useBtn.dataset.action = "use";
        useBtn.dataset.promptId = item.id;
        useBtn.textContent = item.title;
        useBtn.title = item.prompt;

        const preview = document.createElement("p");
        preview.className = "saved-prompt-preview";
        preview.textContent = item.prompt;

        const menu = document.createElement("details");
        menu.className = "sidebar-item-menu saved-prompt-actions";

        const menuTrigger = document.createElement("summary");
        menuTrigger.className = "sidebar-item-menu-trigger";
        menuTrigger.setAttribute("aria-label", `More actions for ${item.title}`);
        menuTrigger.textContent = "...";

        const actions = document.createElement("div");
        actions.className = "sidebar-item-menu-popover";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "sidebar-item-menu-action saved-prompt-action";
        editBtn.dataset.action = "edit";
        editBtn.dataset.promptId = item.id;
        editBtn.textContent = "Edit";

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "sidebar-item-menu-action saved-prompt-action danger";
        deleteBtn.dataset.action = "delete";
        deleteBtn.dataset.promptId = item.id;
        deleteBtn.textContent = "Delete";

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        menu.appendChild(menuTrigger);
        menu.appendChild(actions);

        topRow.appendChild(useBtn);
        topRow.appendChild(menu);
        li.appendChild(topRow);
        li.appendChild(preview);
        refs.savedPromptList.appendChild(li);
      });
    }

    function showPromptBrowser(categoryId) {
      if (!refs.promptBrowserPanel) {
        return;
      }

      const requested = String(categoryId || "").trim();
      const validCategory = getPromptCategoryFilters().some((item) => item.id === requested);
      activePromptCategoryId = validCategory ? requested : "all";
      refs.promptBrowserPanel.classList.remove("hidden");
      if (refs.assistantShell) {
        refs.assistantShell.classList.add("prompt-library-open");
      }
      if (refs.promptBrowserSearchInput) {
        refs.promptBrowserSearchInput.value = promptSearchQuery;
      }
      renderPromptLibrary();
      renderPromptBrowser();
    }

    function hidePromptBrowser() {
      activePromptCategoryId = "";
      if (refs.promptBrowserPanel) {
        refs.promptBrowserPanel.classList.add("hidden");
      }
      if (refs.assistantShell) {
        refs.assistantShell.classList.remove("prompt-library-open");
      }
      renderPromptLibrary();
    }

    function refreshPromptBrowserIfOpen() {
      if (!refs.promptBrowserPanel || refs.promptBrowserPanel.classList.contains("hidden")) {
        return;
      }
      renderPromptBrowser();
    }

    function usePromptTemplate(templateId) {
      const resolved = findPromptTemplateById(templateId);
      if (!resolved) {
        return;
      }

      activePromptTemplateId = resolved.item.id;
      activePromptCategoryId = resolved.category.id;
      activeSavedPromptId = "";
      renderPromptLibrary();
      renderPromptBrowser();
      renderSavedPromptList();
      fillPromptInput(resolved.item.prompt);
      hidePromptBrowser();
      if (refs.promptBrowserHero) {
        refs.promptBrowserHero.classList.add("hidden");
        try { refs.promptBrowserHero.setAttribute('aria-hidden', 'true'); } catch (e) {}
      }
    }

    function useSavedPrompt(promptId) {
      const item = savedPrompts.find((prompt) => prompt.id === promptId);
      if (!item) {
        return;
      }

      activeSavedPromptId = item.id;
      activePromptTemplateId = "";
      renderSavedPromptList();
      renderPromptLibrary();
      fillPromptInput(item.prompt);
      hidePromptBrowser();
    }

    async function savePromptToLibrary(title, promptText, saveOptions = {}) {
      const normalized = normalizeSavedPromptDraft(title, promptText);
      if (!normalized.title || !normalized.prompt) {
        return null;
      }

      const existing = savedPrompts.find(
        (item) => String(item.prompt || "").trim().toLowerCase() === normalized.prompt.toLowerCase()
      );
      if (existing) {
        activeSavedPromptId = existing.id;
        renderSavedPromptList();
        return existing;
      }

      let created = {
        id: createSavedPromptId(),
        title: normalized.title,
        prompt: normalized.prompt
      };

      try {
        const remoteCreated = await createSavedPromptOnApi({
          title: normalized.title,
          prompt: normalized.prompt,
          sourceTemplateId: saveOptions.sourceTemplateId || "",
          isFavorite: false
        });
        if (remoteCreated) {
          created = remoteCreated;
        }
      } catch (_error) {
        // Keep local save behavior when API call fails.
      }

      savedPrompts = [created, ...savedPrompts].slice(0, constants.SAVED_PROMPTS_MAX);
      activeSavedPromptId = created.id;
      saveSavedPrompts();
      renderSavedPromptList();
      return created;
    }

    function openSavedPromptDialog(optionsArg = {}) {
      if (
        !refs.savedPromptDialogBackdrop ||
        !refs.savedPromptDialogHeading ||
        !refs.savedPromptDialogSubmitButton ||
        !refs.savedPromptTitleInput ||
        !refs.savedPromptTextInput
      ) {
        options.setStatus("Saved prompt dialog is unavailable.");
        return;
      }

      const mode = optionsArg.mode === "edit" ? "edit" : "add";
      savedPromptDialogState = {
        mode,
        promptId: String(optionsArg.promptId || "")
      };

      refs.savedPromptDialogHeading.textContent =
        mode === "edit" ? "Edit Saved Prompt" : "Add Saved Prompt";
      refs.savedPromptDialogSubmitButton.textContent =
        mode === "edit" ? "Update Prompt" : "Save Prompt";

      refs.savedPromptTitleInput.value = String(optionsArg.title || "");
      refs.savedPromptTextInput.value = String(optionsArg.prompt || "");
      refs.savedPromptDialogBackdrop.classList.remove("hidden");
      refs.savedPromptDialogBackdrop.setAttribute("aria-hidden", "false");
      options.sidebar.closeAllMenus();

      if (options.sidebar.isCompactSidebarMode()) {
        options.sidebar.closeSidebar();
      }

      window.setTimeout(() => {
        refs.savedPromptTitleInput.focus();
        refs.savedPromptTitleInput.select();
      }, 0);
    }

    function closeSavedPromptDialog(optionsArg = {}) {
      if (!refs.savedPromptDialogBackdrop) {
        return;
      }

      const shouldRestoreFocus = optionsArg.restoreFocus !== false;
      refs.savedPromptDialogBackdrop.classList.add("hidden");
      refs.savedPromptDialogBackdrop.setAttribute("aria-hidden", "true");
      savedPromptDialogState = null;

      if (refs.savedPromptDialogForm) {
        refs.savedPromptDialogForm.reset();
      }

      if (shouldRestoreFocus && refs.addSavedPromptButton) {
        refs.addSavedPromptButton.focus();
      }
    }

    function normalizeSavedPromptDraft(rawTitle, rawPrompt) {
      const normalizedTitle = String(rawTitle || "").replace(/\s+/g, " ").trim();
      const title =
        normalizedTitle.length > constants.CHAT_TITLE_MAX
          ? `${normalizedTitle.slice(0, constants.CHAT_TITLE_MAX - 1)}...`
          : normalizedTitle;
      const prompt = String(rawPrompt || "").trim();
      return { title, prompt };
    }

    function handlePromptLibraryClick(event) {
      if (options.getBusy()) {
        return;
      }

      const card = event.target.closest(".prompt-library-item[data-prompt-category-id]");
      if (!card || !refs.promptLibraryList || !refs.promptLibraryList.contains(card)) {
        return;
      }

      const categoryId = String(card.dataset.promptCategoryId || "");
      const isAlreadyOpen =
        categoryId &&
        categoryId === activePromptCategoryId &&
        refs.promptBrowserPanel &&
        !refs.promptBrowserPanel.classList.contains("hidden");

      if (isAlreadyOpen) {
        hidePromptBrowser();
      } else {
        showPromptBrowser(categoryId);
      }

      if (options.sidebar.isCompactSidebarMode()) {
        options.sidebar.closeSidebar();
      }
    }

    async function handlePromptBrowserClick(event) {
      if (options.getBusy()) {
        return;
      }

      const categoryChip = event.target.closest(".prompt-browser-category-chip[data-category-id]");
      if (categoryChip && refs.promptBrowserCategoryChips && refs.promptBrowserCategoryChips.contains(categoryChip)) {
        activePromptCategoryId = String(categoryChip.dataset.categoryId || "all") || "all";
        renderPromptBrowser();
        return;
      }

      const actionButton = event.target.closest("[data-browser-action][data-prompt-key]");
      let action = "";
      let promptKey = "";

      if (actionButton && refs.promptBrowserCards && refs.promptBrowserCards.contains(actionButton)) {
        action = String(actionButton.dataset.browserAction || "");
        promptKey = String(actionButton.dataset.promptKey || "");
      } else {
        const card = event.target.closest(".prompt-browser-card[data-prompt-key]");
        if (!card || !refs.promptBrowserCards || !refs.promptBrowserCards.contains(card)) {
          return;
        }
        action = "use";
        promptKey = String(card.dataset.promptKey || "");
      }

      const entry = getPromptCatalogItemByKey(promptKey);
      if (!entry) {
        return;
      }

      if (action === "use") {
        if (entry.source === "saved") {
          useSavedPrompt(entry.savedId);
        } else {
          usePromptTemplate(entry.templateId);
        }
        options.sidebar.closeSidebar();
        return;
      }

      if (action === "copy") {
        copyPromptText(entry.prompt);
        return;
      }

      if (action === "save" && entry.source === "library") {
        const created = await savePromptToLibrary(entry.title, entry.prompt, {
          sourceTemplateId: entry.templateId
        });
        if (created) {
          options.setStatus("Prompt saved.");
          renderPromptBrowser();
        }
      }
    }

    async function handleSavedPromptListClick(event) {
      if (options.getBusy()) {
        return;
      }

      const actionTarget = event.target.closest("[data-action]");
      if (actionTarget && refs.savedPromptList && refs.savedPromptList.contains(actionTarget)) {
        const action = String(actionTarget.dataset.action || "");
        const promptId = String(actionTarget.dataset.promptId || "");
        if (!promptId) {
          return;
        }

        if (action === "use") {
          useSavedPrompt(promptId);
          options.sidebar.closeSidebar();
          return;
        }

        if (action === "edit") {
          event.stopPropagation();
          const existing = savedPrompts.find((item) => item.id === promptId);
          if (existing) {
            openSavedPromptDialog({
              mode: "edit",
              promptId: existing.id,
              title: existing.title,
              prompt: existing.prompt
            });
          }
          options.sidebar.closeSidebar();
          return;
        }

        if (action === "delete") {
          event.stopPropagation();
          const existing = savedPrompts.find((item) => item.id === promptId);
          if (existing && window.confirm(`Delete saved prompt "${existing.title}"?`)) {
            try {
              await deleteSavedPromptOnApi(promptId);
            } catch (_error) {
              options.setStatus("Could not delete prompt from server. Deleted locally.");
            }

            savedPrompts = savedPrompts.filter((item) => item.id !== promptId);
            if (activeSavedPromptId === promptId) {
              activeSavedPromptId = "";
            }
            saveSavedPrompts();
            renderSavedPromptList();
            refreshPromptBrowserIfOpen();
            options.setStatus("Saved prompt deleted.");
          }
          options.sidebar.closeSidebar();
        }
        return;
      }

      if (event.target.closest(".sidebar-item-menu")) {
        return;
      }

      const card = event.target.closest(".saved-prompt-item[data-prompt-id]");
      if (!card || !refs.savedPromptList || !refs.savedPromptList.contains(card)) {
        return;
      }

      const promptId = String(card.dataset.promptId || "");
      if (!promptId) {
        return;
      }

      useSavedPrompt(promptId);
      options.sidebar.closeSidebar();
    }

    async function handleSavedPromptDialogSubmit(event) {
      event.preventDefault();

      if (!savedPromptDialogState) {
        closeSavedPromptDialog();
        return;
      }

      const { title, prompt } = normalizeSavedPromptDraft(
        refs.savedPromptTitleInput && refs.savedPromptTitleInput.value,
        refs.savedPromptTextInput && refs.savedPromptTextInput.value
      );

      if (!title) {
        options.setStatus("Prompt title is required.");
        refs.savedPromptTitleInput && refs.savedPromptTitleInput.focus();
        return;
      }

      if (!prompt) {
        options.setStatus("Prompt text is required.");
        refs.savedPromptTextInput && refs.savedPromptTextInput.focus();
        return;
      }

      if (savedPromptDialogState.mode === "edit") {
        const existing = savedPrompts.find((item) => item.id === savedPromptDialogState.promptId);
        if (!existing) {
          closeSavedPromptDialog();
          options.setStatus("Saved prompt no longer exists.");
          return;
        }

        try {
          await updateSavedPromptOnApi(existing.id, {
            title,
            prompt,
            isFavorite: false
          });
        } catch (_error) {
          options.setStatus("Could not update prompt on server. Updated locally.");
        }

        existing.title = title;
        existing.prompt = prompt;
        activeSavedPromptId = existing.id;
        activePromptTemplateId = "";
        saveSavedPrompts();
        renderSavedPromptList();
        renderPromptLibrary();
        refreshPromptBrowserIfOpen();
        fillPromptInput(existing.prompt);
        options.setStatus("Saved prompt updated.");
        closeSavedPromptDialog();
        return;
      }

      const created = await savePromptToLibrary(title, prompt);
      if (!created) {
        options.setStatus("Could not save prompt.");
        return;
      }

      activeSavedPromptId = created.id;
      activePromptTemplateId = "";
      renderSavedPromptList();
      renderPromptLibrary();
      refreshPromptBrowserIfOpen();
      fillPromptInput(created.prompt);
      options.setStatus("Saved prompt added.");
      closeSavedPromptDialog();
    }

    function init() {
      savedPrompts = loadSavedPrompts();
      activePromptCategoryId = "all";
      renderPromptLibrary();
      renderSavedPromptList();
      renderPromptBrowserCategoryChips();

      void (async () => {
        try {
          await hydratePromptCatalogFromApi();
          const remoteSaved = await fetchSavedPromptsFromApi();
          if (Array.isArray(remoteSaved)) {
            savedPrompts = remoteSaved.slice(0, constants.SAVED_PROMPTS_MAX);
            saveSavedPrompts();
            renderSavedPromptList();
            refreshPromptBrowserIfOpen();
          }
        } catch (_error) {
          // Keep local fallback behavior.
        }
      })();

      function openLibraryFromButton() {
        if (options.getBusy()) {
          return;
        }
        showPromptBrowser("all");
      }

      if (refs.promptLibraryList) {
        refs.promptLibraryList.addEventListener("click", handlePromptLibraryClick);
      }
      if (refs.savedPromptList) {
        refs.savedPromptList.addEventListener("click", handleSavedPromptListClick);
      }
      if (refs.promptBrowserCards) {
        refs.promptBrowserCards.addEventListener("click", handlePromptBrowserClick);
      }
      if (refs.promptBrowserCategoryChips) {
        refs.promptBrowserCategoryChips.addEventListener("click", handlePromptBrowserClick);
      }
      if (refs.promptBrowserSearchInput) {
        refs.promptBrowserSearchInput.addEventListener("input", (event) => {
          promptSearchQuery = String((event.target && event.target.value) || "");
          renderPromptBrowser();
        });
      }
      if (refs.promptBrowserCreateButton) {
        refs.promptBrowserCreateButton.addEventListener("click", () => {
          if (!options.getBusy()) {
            openSavedPromptDialog({ mode: "add", title: "", prompt: "" });
          }
        });
      }
      if (refs.promptBrowserUseButton) {
        refs.promptBrowserUseButton.addEventListener("click", function () {
          if (!activePromptTemplateId) return;
          usePromptTemplate(activePromptTemplateId);
        });
      }
      if (refs.promptLibraryDesktopBtn) {
        refs.promptLibraryDesktopBtn.addEventListener("click", openLibraryFromButton);
      }
      if (refs.menuPromptLibraryBtn) {
        refs.menuPromptLibraryBtn.addEventListener("click", openLibraryFromButton);
      }
      if (refs.addSavedPromptButton) {
        refs.addSavedPromptButton.addEventListener("click", () => {
          if (!options.getBusy()) {
            openSavedPromptDialog({ mode: "add", title: "", prompt: "" });
          }
        });
      }
      if (refs.savedPromptDialogForm) {
        refs.savedPromptDialogForm.addEventListener("submit", handleSavedPromptDialogSubmit);
      }
      if (refs.savedPromptDialogBackdrop) {
        refs.savedPromptDialogBackdrop.addEventListener("click", (event) => {
          if (event.target === refs.savedPromptDialogBackdrop) {
            closeSavedPromptDialog();
          }
        });
      }
      if (refs.savedPromptDialogCloseButton) {
        refs.savedPromptDialogCloseButton.addEventListener("click", () => closeSavedPromptDialog());
      }
      if (refs.savedPromptDialogCancelButton) {
        refs.savedPromptDialogCancelButton.addEventListener("click", () => closeSavedPromptDialog());
      }
      if (refs.closePromptBrowserButton) {
        refs.closePromptBrowserButton.addEventListener("click", hidePromptBrowser);
      }

      // Listen for external request to open the prompt browser (useful when UI triggers before init)
      try {
        document.addEventListener('ifda:openPromptLibrary', function () {
          try {
            showPromptBrowser("all");
          } catch (e) {}
        });
      } catch (e) {}
    }

    return {
      closeDialog: closeSavedPromptDialog,
      hidePromptBrowser,
      init,
      isDialogOpen: () =>
        Boolean(refs.savedPromptDialogBackdrop && !refs.savedPromptDialogBackdrop.classList.contains("hidden"))
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.promptLibrary = {
    createPromptLibraryController
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
