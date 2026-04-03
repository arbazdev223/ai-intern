const { Menu, Tray } = require("electron");

function createTrayManager(options = {}) {
  let tray = null;

  function create() {
    tray = new Tray(options.createIcon(16));
    tray.setToolTip("AI Assistant");

    tray.on("click", () => {
      options.onToggle();
    });

    const menu = Menu.buildFromTemplate([
      {
        label: "Open Assistant",
        click: () => options.onOpen()
      },
      {
        label: "Hide Assistant",
        click: () => options.onHide()
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => options.onQuit()
      }
    ]);

    tray.setContextMenu(menu);
    return tray;
  }

  function destroy() {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  }

  return {
    create,
    destroy
  };
}

module.exports = {
  createTrayManager
};
