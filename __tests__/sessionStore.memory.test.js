const constants = require("../src/shared/constants");
require("../src/renderer/chat/sessionStore");

const createSessionStore = global.RendererModules.sessionStore.createSessionStore;

describe("sessionStore memory system", () => {
  const store = createSessionStore();

  function buildMessages(count, options = {}) {
    const role = options.role || "user";
    return Array.from({ length: count }).map((_item, index) => ({
      role: index % 2 === 0 ? role : "assistant",
      content: `${options.prefix || "msg"} ${index + 1}`
    }));
  }

  test("LIMIT TEST: only last 8 messages in recentMessages", () => {
    const messages = buildMessages(20);
    const memory = store.buildMemoryFromMessages(messages);

    expect(memory.recentMessages).toHaveLength(8);
    expect(memory.recentMessages[0].content).toBe("msg 13");
    expect(memory.recentMessages[7].content).toBe("msg 20");
  });

  test("SUMMARY TEST: summarizedMemory generated for long conversations", () => {
    const messages = buildMessages(20);
    const memory = store.buildMemoryFromMessages(messages);

    expect(memory.summarizedMemory).toBeTruthy();
    expect(memory.summarizedMemory).toContain("User:");
    expect(memory.summarizedMemory).toContain("msg 1");
    expect(memory.summarizedMemory).not.toContain("msg 20");
  });

  test("EMPTY INPUT: returns empty recentMessages and summary", () => {
    const memory = store.buildMemoryFromMessages([]);

    expect(memory.recentMessages).toEqual([]);
    expect(memory.summarizedMemory).toBe("");
  });

  test("SUMMARY THRESHOLD: no summary for short conversations", () => {
    const messages = buildMessages(12);
    const memory = store.buildMemoryFromMessages(messages);

    expect(memory.summarizedMemory).toBe("");
    expect(memory.recentMessages).toHaveLength(8);
    expect(memory.recentMessages[0].content).toBe("msg 5");
    expect(memory.recentMessages[7].content).toBe("msg 12");
  });

  test("SUMMARY THRESHOLD: no summary at 16-message boundary", () => {
    const messages = buildMessages(16);
    const memory = store.buildMemoryFromMessages(messages);

    expect(memory.summarizedMemory).toBe("");
    expect(memory.recentMessages).toHaveLength(8);
    expect(memory.recentMessages[0].content).toBe("msg 9");
    expect(memory.recentMessages[7].content).toBe("msg 16");
  });

  test("SUMMARY GENERATION ABOVE THRESHOLD: summary generated at 17 messages", () => {
    const messages = buildMessages(17);
    const memory = store.buildMemoryFromMessages(messages);

    expect(memory.summarizedMemory).not.toBe("");
    expect(memory.summarizedMemory).toContain("msg 1");
    expect(memory.summarizedMemory).not.toContain("msg 17");
    expect(memory.recentMessages).toHaveLength(8);
    expect(memory.recentMessages[0].content).toBe("msg 10");
    expect(memory.recentMessages[7].content).toBe("msg 17");
  });

  test("MESSAGE TRIMMING: summary truncates long messages", () => {
    const longText = "x".repeat(300);
    const messages = [
      ...buildMessages(10),
      { role: "user", content: longText },
      ...buildMessages(10, { prefix: "tail" })
    ];

    const memory = store.buildMemoryFromMessages(messages);
    expect(memory.summarizedMemory).toBeTruthy();
    expect(memory.summarizedMemory).toContain("...");
    expect(memory.summarizedMemory).not.toContain(longText);
  });

  test("PERSISTENCE: strips inline data URLs before localStorage save", () => {
    const payload = {
      activeChatId: "chat-1",
      sessions: [
        {
          id: "chat-1",
          title: "Chat 1",
          messages: [
            {
              role: "user",
              content: "with image",
              imagePath: "data:image/png;base64,i-am-large"
            },
            {
              role: "assistant",
              content: "generated",
              imageUrl: "data:image/jpeg;base64,also-large",
              imageUrls: [
                "https://example.com/image.png",
                "data:image/webp;base64,too-large"
              ]
            }
          ]
        }
      ]
    };

    store.saveState(payload);

    const saved = JSON.parse(localStorage.getItem(constants.CHAT_STORAGE_KEY));
    const messages = saved.sessions[0].messages;

    expect(messages[0].imagePath).toBe("");
    expect(messages[1].imageUrl).toBe("");
    expect(messages[1].imageUrls).toEqual(["https://example.com/image.png"]);
  });

  test("PERSISTENCE: truncates oversized message text", () => {
    const veryLong = "x".repeat(13000);
    const payload = {
      activeChatId: "chat-2",
      sessions: [
        {
          id: "chat-2",
          title: "Chat 2",
          messages: [{ role: "user", content: veryLong }]
        }
      ]
    };

    store.saveState(payload);

    const saved = JSON.parse(localStorage.getItem(constants.CHAT_STORAGE_KEY));
    const content = saved.sessions[0].messages[0].content;

    expect(content.length).toBeLessThanOrEqual(12003);
    expect(content.endsWith("...")).toBe(true);
  });

  test("MIGRATION: converts assistant data URL images to persisted paths", async () => {
    const sessions = [
      {
        id: "chat-3",
        messages: [
          {
            role: "assistant",
            content: "Here is your generated image",
            imageUrl: "data:image/png;base64,abc123",
            imageUrls: ["data:image/png;base64,abc123"]
          }
        ]
      }
    ];

    const assistantAPI = {
      storeScreenshot: jest.fn(async () => ({ imagePath: "file:///tmp/generated-1.png" }))
    };

    const didChange = await store.migrateLegacyImages(sessions, assistantAPI);

    expect(didChange).toBe(true);
    expect(assistantAPI.storeScreenshot).toHaveBeenCalled();
    expect(sessions[0].messages[0].imageUrl).toBe("file:///tmp/generated-1.png");
    expect(sessions[0].messages[0].imageUrls).toEqual(["file:///tmp/generated-1.png"]);
  });
});
