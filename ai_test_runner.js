require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createAiClient } = require("./src/main/aiClient");
const { generateEmbedding } = require("./src/main/rag/embeddingService");
const { ensureAiProviderConfigured } = require("./src/main/config/env");

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArgs(argv) {
  const args = {
    casesPath: path.join(process.cwd(), "ai_test_cases.json"),
    mode: "basic",
    semantic: false,
    threshold: 0.8
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--cases" && argv[i + 1]) {
      args.casesPath = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (current === "--semantic") {
      args.semantic = true;
      continue;
    }
    if (current === "--mode=llm") {
      args.mode = "llm";
      continue;
    }
    if (current === "--mode" && argv[i + 1]) {
      const nextMode = String(argv[i + 1] || "").trim().toLowerCase();
      args.mode = nextMode === "llm" ? "llm" : "basic";
      i += 1;
      continue;
    }
    if (current === "--threshold" && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        args.threshold = parsed;
      }
      i += 1;
    }
  }

  return args;
}

function loadCases(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Test cases file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Test cases must be an array.");
  }

  return parsed.map((item, index) => {
    const input = String(item && item.input ? item.input : "").trim();
    const expected = Array.isArray(item && item.expected)
      ? item.expected.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];

    if (!input) {
      throw new Error(`Case #${index + 1} is missing input.`);
    }
    if (expected.length === 0) {
      throw new Error(`Case #${index + 1} must include at least one expected value.`);
    }

    return {
      input,
      expected
    };
  });
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }

  if (!magA || !magB) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function matchByText(actual, expectedList) {
  const normalizedActual = normalizeText(actual);
  if (!normalizedActual) {
    return {
      passed: false,
      strategy: "none",
      matchedExpected: ""
    };
  }

  for (const expected of expectedList) {
    const normalizedExpected = normalizeText(expected);
    if (!normalizedExpected) {
      continue;
    }

    if (normalizedActual === normalizedExpected) {
      return {
        passed: true,
        strategy: "exact",
        matchedExpected: expected
      };
    }

    if (normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual)) {
      return {
        passed: true,
        strategy: "partial",
        matchedExpected: expected
      };
    }
  }

  return {
    passed: false,
    strategy: "none",
    matchedExpected: ""
  };
}

async function matchBySemantic(actual, expectedList, threshold) {
  const normalizedActual = normalizeText(actual);
  if (!normalizedActual) {
    return {
      passed: false,
      score: 0,
      matchedExpected: ""
    };
  }

  const actualEmbeddingResult = await generateEmbedding(normalizedActual);
  const actualEmbedding = actualEmbeddingResult && actualEmbeddingResult.embedding;
  if (!Array.isArray(actualEmbedding) || actualEmbedding.length === 0) {
    return {
      passed: false,
      score: 0,
      matchedExpected: ""
    };
  }

  let bestScore = 0;
  let bestExpected = "";

  for (const expected of expectedList) {
    const normalizedExpected = normalizeText(expected);
    if (!normalizedExpected) {
      continue;
    }

    const expectedEmbeddingResult = await generateEmbedding(normalizedExpected);
    const expectedEmbedding = expectedEmbeddingResult && expectedEmbeddingResult.embedding;
    const score = cosineSimilarity(actualEmbedding, expectedEmbedding);
    if (score > bestScore) {
      bestScore = score;
      bestExpected = expected;
    }
  }

  return {
    passed: bestScore >= threshold,
    score: bestScore,
    matchedExpected: bestExpected
  };
}

function extractJsonFromText(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const candidates = [raw];

  if (raw.startsWith("```")) {
    const lines = raw.split(/\r?\n/);
    const withoutFence = lines.filter((line) => !line.trim().startsWith("```")).join("\n").trim();
    if (withoutFence) {
      candidates.push(withoutFence);
    }
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {}
  }

  return null;
}

function toSafeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(10, score));
}

function statusFromScore(score) {
  if (score >= 7) {
    return "PASS";
  }
  if (score >= 5) {
    return "WARNING";
  }
  return "FAIL";
}

async function evaluateWithLLM(judgeClient, input, expected, actual) {
  const prompt = [
    "You are an AI evaluator.",
    "",
    `User Question:\n${input}`,
    "",
    `Expected Answer:\n${expected.join(", ")}`,
    "",
    `Actual AI Response:\n${actual}`,
    "",
    "Evaluate based on correctness, relevance, and completeness.",
    "Return only valid JSON with this exact shape:",
    '{"score": number, "verdict": "PASS" | "FAIL", "reason": "short explanation"}'
  ].join("\n");

  const judgeResult = await judgeClient.generate({
    userPrompt: prompt,
    rawPrompt: true
  });

  const judgeText = String(judgeResult && judgeResult.response ? judgeResult.response : "").trim();
  const judgeJson = extractJsonFromText(judgeText);
  if (!judgeJson) {
    throw new Error("Invalid judge response");
  }

  let score = toSafeScore(judgeJson.score);
  const verdict = String(judgeJson.verdict || "").trim().toUpperCase();
  const reason = String(judgeJson.reason || "").trim() || "No reason provided";

  // Keep scoring resilient when the judge returns contradictory score/verdict pairs.
  if (verdict === "PASS" && score < 7) {
    score = 7;
  }
  if (verdict === "FAIL" && score >= 7) {
    score = 4;
  }

  return {
    score,
    verdict: verdict === "PASS" ? "PASS" : "FAIL",
    reason,
    status: statusFromScore(score)
  };
}

async function evaluateBasic(actual, expected, optionsArg = {}) {
  const semantic = Boolean(optionsArg.semantic);
  const threshold = Number(optionsArg.threshold);

  let match = matchByText(actual, expected);
  let semanticDetails = null;

  if (!match.passed && semantic) {
    semanticDetails = await matchBySemantic(actual, expected, threshold);
    if (semanticDetails.passed) {
      match = {
        passed: true,
        strategy: "semantic",
        matchedExpected: semanticDetails.matchedExpected
      };
    }
  }

  return {
    passed: match.passed,
    status: match.passed ? "PASS" : "FAIL",
    score: match.passed ? 10 : 0,
    reason: match.passed
      ? `Matched by ${match.strategy || "basic"}`
      : "Expected keywords did not match",
    strategy: match.strategy || "none",
    semanticDetails
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const testCases = loadCases(args.casesPath);

  ensureAiProviderConfigured();

  const client = createAiClient({
    getCurrentApp: () => "AI Test Runner",
    searchService: { search: async () => ({ summary: "", relatedTopics: [], sources: [] }) }
  });
  const judgeClient = createAiClient({
    getCurrentApp: () => "AI Test Runner Judge",
    searchService: { search: async () => ({ summary: "", relatedTopics: [], sources: [] }) }
  });

  let passed = 0;
  let warnings = 0;
  let failed = 0;
  let totalScore = 0;

  console.log(`Running ${testCases.length} AI test case(s) from ${args.casesPath}`);
  console.log(`Mode: ${args.mode}`);
  console.log(`Semantic matching: ${args.semantic ? `ON (threshold=${args.threshold})` : "OFF"}`);
  console.log("");

  for (let index = 0; index < testCases.length; index += 1) {
    const testCase = testCases[index];
    const result = await client.generate({
      userPrompt: testCase.input,
      rawPrompt: false
    });

    const actual = String(result && result.response ? result.response : "").trim();
    let evaluation = null;
    let usedFallback = false;

    if (args.mode === "llm") {
      try {
        evaluation = await evaluateWithLLM(judgeClient, testCase.input, testCase.expected, actual);
      } catch (_error) {
        usedFallback = true;
        evaluation = await evaluateBasic(actual, testCase.expected, {
          semantic: args.semantic,
          threshold: args.threshold
        });
      }
    } else {
      evaluation = await evaluateBasic(actual, testCase.expected, {
        semantic: args.semantic,
        threshold: args.threshold
      });
    }

    const score = toSafeScore(evaluation && evaluation.score);
    const status = String(evaluation && evaluation.status ? evaluation.status : "FAIL").toUpperCase();
    const reason = String(evaluation && evaluation.reason ? evaluation.reason : "No reason provided").trim();
    totalScore += score;

    if (status === "PASS") {
      passed += 1;
      console.log(`PASS (score: ${score.toFixed(1)}): ${testCase.input}`);
      console.log(`  Reason: ${reason}`);
      if (usedFallback) {
        console.log("  Fallback: basic matching used (judge unavailable)");
      }
      if (evaluation && evaluation.strategy) {
        console.log(`  Match strategy: ${evaluation.strategy}`);
      }
    } else if (status === "WARNING") {
      warnings += 1;
      console.log(`WARNING (score: ${score.toFixed(1)}): ${testCase.input}`);
      console.log(`  Reason: ${reason}`);
      if (usedFallback) {
        console.log("  Fallback: basic matching used (judge unavailable)");
      }
    } else {
      failed += 1;
      console.log(`FAIL (score: ${score.toFixed(1)}): ${testCase.input}`);
      console.log(`  Reason: ${reason}`);
      console.log(`  Expected: ${testCase.expected.join(" | ")}`);
      console.log(`  Actual: ${actual || "(empty)"}`);
      if (usedFallback) {
        console.log("  Fallback: basic matching used (judge unavailable)");
      }
      if (evaluation && evaluation.semanticDetails) {
        console.log(
          `  Best semantic score: ${evaluation.semanticDetails.score.toFixed(3)} (${evaluation.semanticDetails.matchedExpected || "n/a"})`
        );
      }
    }

    console.log("");
  }

  const total = passed + warnings + failed;
  const accuracy = total > 0 ? (passed / total) * 100 : 0;
  const averageScore = total > 0 ? totalScore / total : 0;

  console.log("Summary");
  console.log(`Total: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Warnings: ${warnings}`);
  console.log(`Failed: ${failed}`);
  console.log(`Accuracy: ${accuracy.toFixed(2)}%`);
  console.log(`Average score: ${averageScore.toFixed(2)}/10`);
  console.log(`Pass rate: ${accuracy.toFixed(2)}%`);

  if (failed > 0 || warnings > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error("AI test runner failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
});