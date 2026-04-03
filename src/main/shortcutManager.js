const { globalShortcut } = require("electron");
const constants = require("../shared/constants");

function createShortcutManager(options = {}) {
  function register() {
    globalShortcut.register(constants.TOGGLE_SHORTCUT, async () => {
      await options.onToggleShortcut();
    });
  }

  function unregisterAll() {
    globalShortcut.unregisterAll();
  }

  return {
    register,
    unregisterAll
  };
}

module.exports = {
  createShortcutManager
};
