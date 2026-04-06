(function (root) {
  function getRefs() {
    return {
      addSavedPromptButton: document.getElementById("addSavedPromptButton"),
      assistantShell: document.querySelector(".assistant-shell"),
      attachmentPreview: document.getElementById("attachmentPreview"),
      attachmentPreviewImage: document.getElementById("attachmentPreviewImage"),
      chatForm: document.getElementById("chatForm"),
      chatMessages: document.getElementById("chatMessages"),
      chatSearchInput: document.getElementById("chat-search"),
      clearAttachmentButton: document.getElementById("clearAttachmentButton"),
      closePromptBrowserButton: document.getElementById("closePromptBrowserButton"),
      conversationList: document.getElementById("conversationList"),
      detectedAppLabel: document.getElementById("detectedAppLabel"),
      expandButton: document.getElementById("expandButton"),
      externalScreenToggle: document.getElementById("externalScreenToggle"),
      externalScreenToggleLabel: document.getElementById("externalScreenToggleLabel"),
      modelStatus: document.getElementById("modelStatus"),
      newChatButton: document.getElementById("newChatButton"),
      promptBrowserCards: document.getElementById("promptBrowserCards"),
      promptBrowserCategoryChips: document.getElementById("promptBrowserCategoryChips"),
      promptBrowserCreateButton: document.getElementById("promptBrowserCreateButton"),
      promptBrowserEyebrow: document.getElementById("promptBrowserEyebrow"),
      promptBrowserPanel: document.getElementById("promptBrowserPanel"),
      promptBrowserSearchInput: document.getElementById("promptBrowserSearchInput"),
      promptBrowserHero: document.getElementById("promptBrowserHero"),
      promptBrowserHeroImage: document.getElementById("promptBrowserHeroImage"),
      promptBrowserHeroTitle: document.getElementById("promptBrowserHeroTitle"),
      promptBrowserFullPrompt: document.getElementById("promptBrowserFullPrompt"),
      promptBrowserUseButton: document.getElementById("promptBrowserUseButton"),
      promptBrowserSubtitle: document.getElementById("promptBrowserSubtitle"),
      promptBrowserTitle: document.getElementById("promptBrowserTitle"),
      promptInput: document.getElementById("promptInput"),
      promptLibraryDesktopBtn: document.getElementById("promptLibraryDesktopBtn"),
      promptLibraryList: document.getElementById("promptLibraryList"),
      menuPromptLibraryBtn: document.getElementById("menuPromptLibraryBtn"),
      savedPromptDialogBackdrop: document.getElementById("savedPromptDialogBackdrop"),
      savedPromptDialogCancelButton: document.getElementById("savedPromptDialogCancelButton"),
      savedPromptDialogCloseButton: document.getElementById("savedPromptDialogCloseButton"),
      savedPromptDialogForm: document.getElementById("savedPromptDialogForm"),
      savedPromptDialogHeading: document.getElementById("savedPromptDialogHeading"),
      savedPromptDialogSubmitButton: document.getElementById("savedPromptDialogSubmitButton"),
      savedPromptList: document.getElementById("savedPromptList"),
      savedPromptTextInput: document.getElementById("savedPromptTextInput"),
      savedPromptTitleInput: document.getElementById("savedPromptTitleInput"),
      screenshotButton: document.getElementById("screenshotButton"),
      screenshotStatus: document.getElementById("screenshotStatus"),
      sendButton: document.getElementById("sendButton"),
      sidebarBackdrop: document.getElementById("sidebarBackdrop"),
      sidebarToggleButton: document.getElementById("sidebarToggleButton"),
      statusText: document.getElementById("statusText"),
      typingIndicator: document.getElementById("typingIndicator"),
      typingLabel: document.querySelector("#typingIndicator .typing-label"),
      voiceLivePreview: document.getElementById("voiceLivePreview"),
      voiceToggle: document.getElementById("voiceToggle"),
      voiceToggleLabel: document.getElementById("voiceToggleLabel"),
      voiceStatus: document.getElementById("voiceStatus")
    };
  }

  function init() {
    console.log("electronAPI:", root.electronAPI);
    if (!root.assistantAPI) {
      console.error("assistantAPI bridge is unavailable.");
      return;
    }

    const refs = getRefs();
    if (!refs.chatMessages || !refs.chatForm || !refs.promptInput || !refs.sendButton || !refs.screenshotButton) {
      console.error("Required chat UI elements are missing.");
      return;
    }

    let chatManager = null;
    let promptLibrary = null;

    const sidebar = root.RendererModules.sidebar.createSidebarController({
      closeDialog: () => {
        if (promptLibrary) {
          promptLibrary.closeDialog();
        }
      },
      isDialogOpen: () => Boolean(promptLibrary && promptLibrary.isDialogOpen()),
      refs
    });

    promptLibrary = root.RendererModules.promptLibrary.createPromptLibraryController({
      autoResizeInput: () => {
        if (chatManager) {
          chatManager.autoResizeInput();
        }
      },
      getBusy: () => Boolean(chatManager && chatManager.getBusy()),
      refs,
      setStatus: (...args) => {
        if (chatManager) {
          chatManager.setStatus(...args);
        }
      },
      sidebar
    });

    // initialize prompt library so it wires its DOM event handlers
    try {
      if (promptLibrary && typeof promptLibrary.init === "function") {
        promptLibrary.init();
      }
    } catch (e) {
      console.error("Prompt library init failed:", e);
    }

    const messageRenderer = root.RendererModules.messageRenderer.createMessageRenderer({
      assistantAPI: root.assistantAPI,
      refs
    });

    const voiceManager = root.RendererModules.voiceMode.createVoiceModeManager({
      assistantAPI: root.assistantAPI,
      getBusy: () => Boolean(chatManager && chatManager.getBusy()),
      refs,
      setStatus: (...args) => {
        if (chatManager) {
          chatManager.setStatus(...args);
        }
      }
    });

    const attachments = root.RendererModules.attachments.createAttachmentsManager({
      assistantAPI: root.assistantAPI,
      getBusy: () => Boolean(chatManager && chatManager.getBusy()),
      refs,
      setStatus: (...args) => {
        if (chatManager) {
          chatManager.setStatus(...args);
        }
      }
    });

    const screenshotOCR = root.RendererModules.screenshotOCR.createScreenshotOCR({
      assistantAPI: root.assistantAPI,
      setStatus: (...args) => {
        if (chatManager) {
          chatManager.setStatus(...args);
        }
      }
    });

    const sessionStore = root.RendererModules.sessionStore.createSessionStore();

    chatManager = root.RendererModules.chatManager.createChatManager({
      assistantAPI: root.assistantAPI,
      attachments,
      messageRenderer,
      promptLibrary,
      refs,
      screenshotOCR,
      sessionStore,
      sidebar,
      voiceManager
    });

    sidebar.init();
    chatManager.init().catch((error) => {
      console.error("Renderer bootstrap failed:", error);
    });
    voiceManager.init();
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.renderer = {
    init
  };

  function bootRenderer() {
    console.log("Renderer boot starting...");

    try {
      if (
        root.RendererModules &&
        root.RendererModules.renderer &&
        typeof root.RendererModules.renderer.init === "function"
      ) {
        console.log("Calling renderer.init()");
        root.RendererModules.renderer.init();
        console.log("Renderer initialized successfully");
      } else {
        console.error("RendererModules.renderer.init NOT found");
        console.log("RendererModules:", root.RendererModules);
      }
    } catch (err) {
      console.error("Renderer init crashed:", err);
    }
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootRenderer);
    } else {
      bootRenderer();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
