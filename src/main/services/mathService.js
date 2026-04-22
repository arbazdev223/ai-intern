function normalizeMathText(input) {
  return String(input || "")
    .replace(/\u2212/g, "-") // unicode minus
    .replace(/[–—]/g, "-")
    .replace(/[×]/g, "*")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePolynomialExpr(expr) {
  let out = String(expr || "");
  out = out.replace(/\u2212/g, "-").replace(/[–—]/g, "-");
  // common OCR-ish exponent formatting: "x 3" or "x3"
  out = out.replace(/x\s*([23])\b/gi, "x^$1");
  out = out.replace(/x\^?\s*([23])\b/gi, "x^$1");
  out = out.replace(/\s+/g, "");
  // Ensure unary plus/minus are explicit between terms for easier matching.
  if (out && !/^[+-]/.test(out)) out = `+${out}`;
  return out;
}

function parseCubicFromPrompt(prompt) {
  const text = normalizeMathText(prompt);
  const match = text.match(/f\s*\(\s*x\s*\)\s*=\s*([^,\n\r;]+)/i);
  const rawExpr = match ? match[1] : "";
  const expr = normalizePolynomialExpr(rawExpr);
  if (!expr) return null;

  function readCoeff(termMatch) {
    const raw = String(termMatch || "").trim();
    if (raw === "+" || raw === "") return 1;
    if (raw === "-") return -1;
    const num = Number(raw);
    return Number.isFinite(num) ? num : NaN;
  }

  const aMatch = expr.match(/([+-]\d*\.?\d*)x\^3/i);
  const bMatch = expr.match(/([+-]\d*\.?\d*)x\^2/i);
  const cMatch = expr.match(/([+-]\d*\.?\d*)x(?!\^)/i);

  let a = 0, b = 0, c = 0, d = 0;
  if (aMatch) a = readCoeff(aMatch[1]);
  if (bMatch) b = readCoeff(bMatch[1]);
  if (cMatch) c = readCoeff(cMatch[1]);

  // Constant term: sum of standalone signed numbers not followed by x
  // Example: "+2-5" should become -3
  const constantParts = expr.match(/[+-]\d*\.?\d+(?!x)/gi) || [];
  d = constantParts.reduce((acc, part) => {
    const n = Number(part);
    return Number.isFinite(n) ? acc + n : acc;
  }, 0);

  if (![a, b, c, d].every((v) => Number.isFinite(v))) return null;
  if (a === 0) return null;

  return { a, b, c, d, rawExpr: rawExpr || expr };
}

function parseIntervalFromPrompt(prompt) {
  const text = normalizeMathText(prompt);
  const bracket = text.match(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
  if (bracket) {
    const left = Number(bracket[1]);
    const right = Number(bracket[2]);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
      return { left: Math.min(left, right), right: Math.max(left, right) };
    }
  }

  const verbal = text.match(/x\s*=\s*(-?\d+(?:\.\d+)?)\s*(?:to|and)\s*x\s*=\s*(-?\d+(?:\.\d+)?)/i);
  if (verbal) {
    const left = Number(verbal[1]);
    const right = Number(verbal[2]);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
      return { left: Math.min(left, right), right: Math.max(left, right) };
    }
  }

  return null;
}

function evalCubic(coeffs, x) {
  const { a, b, c, d } = coeffs;
  return ((a * x + b) * x + c) * x + d;
}

function antiDerivativeCubic(coeffs, x) {
  const { a, b, c, d } = coeffs;
  return (a * x ** 4) / 4 + (b * x ** 3) / 3 + (c * x ** 2) / 2 + d * x;
}

function findRootsInInterval(coeffs, left, right, options = {}) {
  const samples = Number.isFinite(Number(options.samples)) ? Number(options.samples) : 2000;
  const eps = Number.isFinite(Number(options.eps)) ? Number(options.eps) : 1e-10;

  const roots = [];
  const step = (right - left) / samples;

  let prevX = left;
  let prevY = evalCubic(coeffs, prevX);

  function pushRoot(x) {
    const safe = Number(x);
    if (!Number.isFinite(safe)) return;
    if (safe < left - 1e-8 || safe > right + 1e-8) return;
    const clamped = Math.max(left, Math.min(right, safe));
    if (roots.some((r) => Math.abs(r - clamped) < 1e-6)) return;
    roots.push(clamped);
  }

  // capture exact zeros at sample points
  if (Math.abs(prevY) < 1e-9) pushRoot(prevX);

  for (let i = 1; i <= samples; i += 1) {
    const x = i === samples ? right : left + step * i;
    const y = evalCubic(coeffs, x);

    if (Math.abs(y) < 1e-9) {
      pushRoot(x);
    }

    if (prevY === 0) {
      prevX = x;
      prevY = y;
      continue;
    }

    if (prevY * y < 0) {
      // bisection bracket [prevX, x]
      let lo = prevX;
      let hi = x;
      let yLo = prevY;
      let yHi = y;

      for (let iter = 0; iter < 120; iter += 1) {
        const mid = (lo + hi) / 2;
        const yMid = evalCubic(coeffs, mid);
        if (Math.abs(yMid) < eps) {
          lo = hi = mid;
          break;
        }
        if (yLo * yMid <= 0) {
          hi = mid;
          yHi = yMid;
        } else {
          lo = mid;
          yLo = yMid;
        }
      }
      pushRoot((lo + hi) / 2);
    }

    prevX = x;
    prevY = y;
  }

  roots.sort((a, b) => a - b);
  return roots;
}

function simpsonIntegrate(fn, left, right, n = 4000) {
  const N = Math.max(200, Math.floor(n / 2) * 2); // even
  const h = (right - left) / N;
  let sum = fn(left) + fn(right);
  for (let i = 1; i < N; i += 1) {
    const x = left + h * i;
    sum += fn(x) * (i % 2 === 0 ? 2 : 4);
  }
  return (h / 3) * sum;
}

function solveAreaSplitByHorizontalLine(coeffs, left, right) {
  const roots = findRootsInInterval(coeffs, left, right, { samples: 4000 });
  const criticalPoints = [left, ...roots.filter((r) => r > left + 1e-9 && r < right - 1e-9), right].sort((a, b) => a - b);

  let totalArea = 0;
  for (let i = 0; i < criticalPoints.length - 1; i += 1) {
    const a = criticalPoints[i];
    const b = criticalPoints[i + 1];
    const signed = antiDerivativeCubic(coeffs, b) - antiDerivativeCubic(coeffs, a);
    totalArea += Math.abs(signed);
  }

  // Area above k within the region between curve and x-axis.
  function areaAboveK(k) {
    const kk = Number(k);
    const sliceLen = (x) => {
      const y = evalCubic(coeffs, x);
      const low = Math.min(0, y);
      const high = Math.max(0, y);
      if (kk >= high) return 0;
      const start = Math.max(kk, low);
      return Math.max(0, high - start);
    };
    return simpsonIntegrate(sliceLen, left, right, 6000);
  }

  // bracket k in [minLow, maxHigh]
  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (let i = 0; i <= 4000; i += 1) {
    const x = left + ((right - left) * i) / 4000;
    const y = evalCubic(coeffs, x);
    minLow = Math.min(minLow, Math.min(0, y));
    maxHigh = Math.max(maxHigh, Math.max(0, y));
  }

  // Bisection for areaAboveK(k) = totalArea/2
  const target = totalArea / 2;
  let lo = minLow;
  let hi = maxHigh;

  // Ensure monotonic direction: areaAboveK(lo) ~= totalArea, areaAboveK(hi) ~= 0
  for (let iter = 0; iter < 70; iter += 1) {
    const mid = (lo + hi) / 2;
    const val = areaAboveK(mid);
    if (val > target) {
      lo = mid; // need reduce area => raise k
    } else {
      hi = mid;
    }
  }

  const k = (lo + hi) / 2;

  return {
    totalArea,
    roots,
    k
  };
}

function canSolve(prompt) {
  const coeffs = parseCubicFromPrompt(prompt);
  const interval = parseIntervalFromPrompt(prompt);
  if (!coeffs || !interval) return false;
  const text = normalizeMathText(prompt).toLowerCase();
  return (
    text.includes("area") &&
    (text.includes("x-axis") || text.includes("x axis")) &&
    (text.includes("k") || text.includes("y=k") || text.includes("y = k"))
  );
}

function solve(prompt) {
  const coeffs = parseCubicFromPrompt(prompt);
  const interval = parseIntervalFromPrompt(prompt);
  if (!coeffs || !interval) {
    return null;
  }

  const { left, right } = interval;
  const roots = findRootsInInterval(coeffs, left, right, { samples: 6000 });
  const result = solveAreaSplitByHorizontalLine(coeffs, left, right);

  const rootsText = roots.length
    ? roots
        .map((r) => {
          const rounded = Math.abs(r) < 1e-9 ? 0 : r;
          return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
        })
        .join(", ")
    : "No roots found in interval.";

  const areaText = Number(result.totalArea).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const kText = Number(result.k).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");

  return {
    response: [
      `Given f(x) = ${coeffs.rawExpr || "cubic"} on [${left}, ${right}].`,
      "",
      "(a) x-axis intersections in the interval:",
      `x = ${rootsText}`,
      "",
      "(b) Total area between the curve and x-axis on the interval:",
      `A = ${areaText}`,
      "",
      "(c) Value of k such that y = k splits the region into two equal areas:",
      `k ≈ ${kText}`
    ].join("\n")
  };
}

module.exports = {
  canSolve,
  solve,
  parseCubicFromPrompt,
  parseIntervalFromPrompt
};

