const promptBuilder = require("../src/shared/promptBuilder");

describe("promptBuilder", () => {
  test("buildFinalPrompt includes system instructions and question", () => {
    const prompt = promptBuilder.buildFinalPrompt({
      userPrompt: "What is AI?",
      contextMessages: []
    });

    expect(prompt).toContain("[SYSTEM INSTRUCTIONS]");
    expect(prompt).toContain("[FACT ACCURACY MODE]");
    expect(prompt).toContain("[STUDENT QUESTION]");
    expect(prompt).toContain("What is AI?");
  });

  test("buildPromptWithOcr embeds OCR text", () => {
    const prompt = promptBuilder.buildPromptWithOcr("Help me", "OCR TEXT");
    expect(prompt).toContain("OCR TEXT");
    expect(prompt).toContain("Student question");
  });
});
