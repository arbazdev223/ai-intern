const { registerIpcHandlers } = require("../src/main/ipcHandlers");

describe("ipcHandlers", () => {
  test("rejects invalid generate payloads", async () => {
    const handlers = {};
    const ipcMain = {
      handle: (channel, fn) => {
        handlers[channel] = fn;
      },
      on: jest.fn()
    };

    const aiClient = { generate: jest.fn().mockResolvedValue({ response: "ok" }) };
    const screenshotService = {
      captureScreen: jest.fn().mockResolvedValue("img"),
      extractOcrText: jest.fn().mockResolvedValue("text"),
      saveScreenshot: jest.fn().mockResolvedValue({ imagePath: "file://img.png" })
    };
    const windowManager = {
      showChatWindow: jest.fn(),
      hideChatWindowForCapture: jest.fn(),
      showChatWindowAfterCapture: jest.fn(),
      getExpandState: jest.fn(),
      toggleExpandState: jest.fn(),
      getCurrentApp: jest.fn()
    };

    registerIpcHandlers({ ipcMain, aiClient, screenshotService, windowManager });

    await expect(handlers["ai:generate"](null, {})).rejects.toThrow("userPrompt is required");
    await expect(
      handlers["ai:generate"](null, { userPrompt: "a".repeat(60 * 1024) })
    ).rejects.toThrow("exceeds size limit");
  });

  test("accepts valid generate payloads", async () => {
    const handlers = {};
    const ipcMain = {
      handle: (channel, fn) => {
        handlers[channel] = fn;
      },
      on: jest.fn()
    };

    const aiClient = { generate: jest.fn().mockResolvedValue({ response: "ok" }) };
    const screenshotService = {
      captureScreen: jest.fn().mockResolvedValue("img"),
      extractOcrText: jest.fn().mockResolvedValue("text"),
      saveScreenshot: jest.fn().mockResolvedValue({ imagePath: "file://img.png" })
    };
    const windowManager = {
      showChatWindow: jest.fn(),
      hideChatWindowForCapture: jest.fn(),
      showChatWindowAfterCapture: jest.fn(),
      getExpandState: jest.fn(),
      toggleExpandState: jest.fn(),
      getCurrentApp: jest.fn()
    };

    registerIpcHandlers({ ipcMain, aiClient, screenshotService, windowManager });

    const result = await handlers["ai:generate"](null, { userPrompt: "Hello" });
    expect(result).toEqual({ response: "ok" });
  });

  test("rejects malformed OCR payloads", async () => {
    const handlers = {};
    const ipcMain = {
      handle: (channel, fn) => {
        handlers[channel] = fn;
      },
      on: jest.fn()
    };

    const aiClient = { generate: jest.fn() };
    const screenshotService = {
      captureScreen: jest.fn(),
      extractOcrText: jest.fn(),
      saveScreenshot: jest.fn()
    };
    const windowManager = {
      showChatWindow: jest.fn(),
      hideChatWindowForCapture: jest.fn(),
      showChatWindowAfterCapture: jest.fn(),
      getExpandState: jest.fn(),
      toggleExpandState: jest.fn(),
      getCurrentApp: jest.fn()
    };

    registerIpcHandlers({ ipcMain, aiClient, screenshotService, windowManager });

    await expect(handlers["assistant:extract-ocr"](null, {})).rejects.toThrow(
      "base64Screenshot is required"
    );
  });
});
