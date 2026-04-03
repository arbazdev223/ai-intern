module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["**/__tests__/**/*.test.js"],
  clearMocks: true,
  setupFiles: ["<rootDir>/jest.setup.js"]
};
