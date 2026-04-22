const mathService = require("../src/main/services/mathService");

describe("mathService cubic area split", () => {
  test("solves the sample problem and returns k approximately -0.223794", () => {
    const prompt = `
Let f(x)=x^3-3x^2+2.
Area bounded by curve, x-axis, and x=0 to x=3.
(a) roots (b) total area (c) find k such that y=k splits region equally.
`;
    expect(mathService.canSolve(prompt)).toBe(true);
    const solved = mathService.solve(prompt);
    expect(solved).toBeTruthy();
    expect(String(solved.response)).toContain("A = 3.75");
    // k approx -0.2237940704
    expect(String(solved.response)).toMatch(/k ≈ -0\.22379/);
  });
});

