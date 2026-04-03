/** @jest-environment jsdom */

require("../src/shared/constants");
require("../src/shared/promptBuilder");
require("../src/renderer/chat/sessionStore");
require("../src/renderer/chat/chatManager");

const createChatManager = global.RendererModules.chatManager.createChatManager;
const createSessionStore = global.RendererModules.sessionStore.createSessionStore;

function setupDom() {
  document.body.innerHTML = `
    <form id="chatForm"></form>
    <textarea id="promptInput"></textarea>
    <button id="sendButton"></button>
    <button id="screenshotButton"></button>
    <div id="chatMessages"></div>
    <div id="statusText"></div>
    <div id="typingIndicator"><span class="typing-label"></span></div>
    <button id="expandButton"></button>
    <button id="newChatButton"></button>
    <ul id="conversationList"></ul>
    <button id="sidebarToggleButton"></button>
    <button id="sidebarBackdrop"></button>
    <button id="clearAttachmentButton"></button>
    <div id="attachmentPreview"></div>
    <img id="attachmentPreviewImage" />
    <div id="screenshotStatus"></div>
    <label><input id="externalScreenToggle" type="checkbox" /></label>
    <span id="externalScreenToggleLabel"></span>
    <div id="modelStatus"></div>
  `;

  return {
    chatForm: document.getElementById("chatForm"),
    promptInput: document.getElementById("promptInput"),
    sendButton: document.getElementById("sendButton"),
    screenshotButton: document.getElementById("screenshotButton"),
    chatMessages: document.getElementById("chatMessages"),
    statusText: document.getElementById("statusText"),
    typingIndicator: document.getElementById("typingIndicator"),
    typingLabel: document.querySelector("#typingIndicator .typing-label"),
    expandButton: document.getElementById("expandButton"),
    newChatButton: document.getElementById("newChatButton"),
    conversationList: document.getElementById("conversationList"),
    sidebarToggleButton: document.getElementById("sidebarToggleButton"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    clearAttachmentButton: document.getElementById("clearAttachmentButton"),
    attachmentPreview: document.getElementById("attachmentPreview"),
    attachmentPreviewImage: document.getElementById("attachmentPreviewImage"),
    screenshotStatus: document.getElementById("screenshotStatus"),
    externalScreenToggle: document.getElementById("externalScreenToggle"),
    externalScreenToggleLabel: document.getElementById("externalScreenToggleLabel"),
    modelStatus: document.getElementById("modelStatus"),
    assistantShell: document.createElement("div")
  };
}

function createMessageRenderer(refs) {
  return {
    init: jest.fn(),
    renderUserMessage: (text, options = {}) => {
      const node = document.createElement("div");
      node.className = "user-message";
      node.textContent = text;
      if (options.imagePath) {
        const img = document.createElement("img");
        img.className = "chat-image";
        img.src = options.imagePath;
        node.appendChild(img);
      }
      refs.chatMessages.appendChild(node);
    },
    renderAssistantMessage: (text) => {
      const node = document.createElement("div");
      node.className = "assistant-message";
      node.textContent = text;
      refs.chatMessages.appendChild(node);
    },
    renderAssistantStream: jest.fn().mockResolvedValue(),
    renderSessionMessages: jest.fn((messages = []) => {
      refs.chatMessages.innerHTML = "";
      messages.forEach((message) => {
        const node = document.createElement("div");
        node.className = message.role === "assistant" ? "assistant-message" : "user-message";
        node.textContent = message.content;
        refs.chatMessages.appendChild(node);
      });
    })
  };
}

describe("chatManager UI responsiveness", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("renders user message immediately after send (async AI delayed)", async () => {
    const refs = setupDom();
    const messageRenderer = createMessageRenderer(refs);
    const sessionStore = createSessionStore();

    const assistantAPI = {
      getCurrentApp: jest.fn().mockResolvedValue("Test App"),
      getExpandState: jest.fn().mockResolvedValue({ expanded: false }),
      toggleExpand: jest.fn(),
      sendPrompt: jest.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ response: "ok", usedModel: "openai:gpt-4o-mini" }), 50)
          )
      ),
      onActiveApp: jest.fn(),
      onOpeningAnalysis: jest.fn()
    };

    const chatManager = createChatManager({
      assistantAPI,
      attachments: {
        init: jest.fn(),
        getPendingScreenshotBase64: jest.fn(() => ""),
        clearPendingAttachment: jest.fn(),
        persistAttachment: jest.fn()
      },
      messageRenderer,
      promptLibrary: { init: jest.fn(), hidePromptBrowser: jest.fn() },
      refs,
      screenshotOCR: {
        extractOcrText: jest.fn(),
        buildPromptWithOcr: jest.fn(),
        hasIssueKeyword: jest.fn(() => false)
      },
      sessionStore,
      sidebar: { closeSidebar: jest.fn(), closeAllMenus: jest.fn(), isCompactSidebarMode: jest.fn(() => false) }
    });

    await chatManager.init();

    refs.promptInput.value = "hello";
    refs.chatForm.dispatchEvent(new Event("submit"));

    // Immediate assertion before async work completes.
    expect(refs.chatMessages.textContent).toContain("hello");

    jest.runAllTimers();
  });

  test("user message renders even when async AI fails", async () => {
    const refs = setupDom();
    const messageRenderer = createMessageRenderer(refs);
    const sessionStore = createSessionStore();

    const assistantAPI = {
      getCurrentApp: jest.fn().mockResolvedValue("Test App"),
      getExpandState: jest.fn().mockResolvedValue({ expanded: false }),
      toggleExpand: jest.fn(),
      sendPrompt: jest.fn(
        () =>
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("fail")), 20))
      ),
      onActiveApp: jest.fn(),
      onOpeningAnalysis: jest.fn()
    };

    const chatManager = createChatManager({
      assistantAPI,
      attachments: {
        init: jest.fn(),
        getPendingScreenshotBase64: jest.fn(() => ""),
        clearPendingAttachment: jest.fn(),
        persistAttachment: jest.fn()
      },
      messageRenderer,
      promptLibrary: { init: jest.fn(), hidePromptBrowser: jest.fn() },
      refs,
      screenshotOCR: {
        extractOcrText: jest.fn(),
        buildPromptWithOcr: jest.fn(),
        hasIssueKeyword: jest.fn(() => false)
      },
      sessionStore,
      sidebar: { closeSidebar: jest.fn(), closeAllMenus: jest.fn(), isCompactSidebarMode: jest.fn(() => false) }
    });

    await chatManager.init();

    refs.promptInput.value = "hello";
    refs.chatForm.dispatchEvent(new Event("submit"));

    expect(refs.chatMessages.textContent).toContain("hello");

    jest.runAllTimers();
  });

  test("user message renders immediately with delayed screenshot persistence", async () => {
    const refs = setupDom();
    const messageRenderer = createMessageRenderer(refs);
    const sessionStore = createSessionStore();

    const assistantAPI = {
      getCurrentApp: jest.fn().mockResolvedValue("Test App"),
      getExpandState: jest.fn().mockResolvedValue({ expanded: false }),
      toggleExpand: jest.fn(),
      sendPrompt: jest.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ response: "ok", usedModel: "openai:gpt-4o-mini" }), 50)
          )
      ),
      onActiveApp: jest.fn(),
      onOpeningAnalysis: jest.fn()
    };

    const attachments = {
      init: jest.fn(),
      getPendingScreenshotBase64: jest.fn(() => "abc123"),
      clearPendingAttachment: jest.fn(),
      persistAttachment: jest.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ imagePath: "file://persisted.png" }), 1500)
          )
      )
    };

    const chatManager = createChatManager({
      assistantAPI,
      attachments,
      messageRenderer,
      promptLibrary: { init: jest.fn(), hidePromptBrowser: jest.fn() },
      refs,
      screenshotOCR: {
        extractOcrText: jest.fn(),
        buildPromptWithOcr: jest.fn(),
        hasIssueKeyword: jest.fn(() => false)
      },
      sessionStore,
      sidebar: { closeSidebar: jest.fn(), closeAllMenus: jest.fn(), isCompactSidebarMode: jest.fn(() => false) }
    });

    await chatManager.init();

    refs.promptInput.value = "hello";
    refs.chatForm.dispatchEvent(new Event("submit"));

    // Immediate assertions before persistence resolves.
    expect(refs.chatMessages.textContent).toContain("hello");
    const img = refs.chatMessages.querySelector("img.chat-image");
    expect(img).not.toBeNull();
    expect(img.src).toContain("data:image/png;base64,abc123");

    jest.runAllTimers();
  });

  test("user message renders even if screenshot persistence fails", async () => {
    const refs = setupDom();
    const messageRenderer = createMessageRenderer(refs);
    const sessionStore = createSessionStore();

    const assistantAPI = {
      getCurrentApp: jest.fn().mockResolvedValue("Test App"),
      getExpandState: jest.fn().mockResolvedValue({ expanded: false }),
      toggleExpand: jest.fn(),
      sendPrompt: jest.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ response: "ok", usedModel: "openai:gpt-4o-mini" }), 50)
          )
      ),
      onActiveApp: jest.fn(),
      onOpeningAnalysis: jest.fn()
    };

    const attachments = {
      init: jest.fn(),
      getPendingScreenshotBase64: jest.fn(() => "abc123"),
      clearPendingAttachment: jest.fn(),
      persistAttachment: jest.fn(
        () =>
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("persist fail")), 1000)
          )
      )
    };

    const chatManager = createChatManager({
      assistantAPI,
      attachments,
      messageRenderer,
      promptLibrary: { init: jest.fn(), hidePromptBrowser: jest.fn() },
      refs,
      screenshotOCR: {
        extractOcrText: jest.fn(),
        buildPromptWithOcr: jest.fn(),
        hasIssueKeyword: jest.fn(() => false)
      },
      sessionStore,
      sidebar: { closeSidebar: jest.fn(), closeAllMenus: jest.fn(), isCompactSidebarMode: jest.fn(() => false) }
    });

    await chatManager.init();

    refs.promptInput.value = "hello";
    refs.chatForm.dispatchEvent(new Event("submit"));

    expect(refs.chatMessages.textContent).toContain("hello");
    const img = refs.chatMessages.querySelector("img.chat-image");
    expect(img).not.toBeNull();
    expect(img.src).toContain("data:image/png;base64,abc123");

    jest.runAllTimers();
  });

  test("prompt input remains focusable after deleting a chat", async () => {
    const refs = setupDom();
    const messageRenderer = createMessageRenderer(refs);
    const sessionStore = createSessionStore();

    const assistantAPI = {
      getCurrentApp: jest.fn().mockResolvedValue("Test App"),
      getExpandState: jest.fn().mockResolvedValue({ expanded: false }),
      toggleExpand: jest.fn(),
      sendPrompt: jest.fn().mockResolvedValue({ response: "ok", usedModel: "openai:gpt-4o-mini" }),
      onActiveApp: jest.fn(),
      onOpeningAnalysis: jest.fn()
    };

    const sidebar = {
      closeSidebar: jest.fn(),
      closeAllMenus: jest.fn(),
      isCompactSidebarMode: jest.fn(() => false)
    };

    const chatManager = createChatManager({
      assistantAPI,
      attachments: {
        init: jest.fn(),
        getPendingScreenshotBase64: jest.fn(() => ""),
        clearPendingAttachment: jest.fn(),
        persistAttachment: jest.fn()
      },
      messageRenderer,
      promptLibrary: { init: jest.fn(), hidePromptBrowser: jest.fn() },
      refs,
      screenshotOCR: {
        extractOcrText: jest.fn(),
        buildPromptWithOcr: jest.fn(),
        hasIssueKeyword: jest.fn(() => false)
      },
      sessionStore,
      sidebar
    });

    await chatManager.init();

    refs.promptInput.value = "first";
    refs.chatForm.dispatchEvent(new Event("submit"));
    await Promise.resolve();

    const deleteBtn = refs.conversationList.querySelector('[data-action="delete"]');
    expect(deleteBtn).not.toBeNull();

    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    jest.runAllTimers();
    await Promise.resolve();

    refs.promptInput.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    refs.promptInput.focus();

    expect(refs.promptInput.disabled).toBe(false);
    expect(document.activeElement).toBe(refs.promptInput);

    confirmSpy.mockRestore();
  });
});
