(function (root) {
  const SIDEBAR_COLLAPSE_KEY = "assistant.sidebarCollapsed";

  function createSidebarController(options = {}) {
    const refs = options.refs;
    let isSidebarOpen = false;
    let desktopSidebarCollapsed = false;
    let toolsModal = null;
    let toolsModalClose = null;
    let toolsModalCloseBtn = null;

    function isCompactSidebarMode() {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return false;
      }

      return window.matchMedia("(max-width: 980px)").matches;
    }

    function loadDesktopSidebarPreference() {
      if (typeof localStorage === "undefined") {
        return false;
      }

      try {
        return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "true";
      } catch (_error) {
        return false;
      }
    }

    function saveDesktopSidebarPreference() {
      if (typeof localStorage === "undefined") {
        return;
      }

      try {
        localStorage.setItem(SIDEBAR_COLLAPSE_KEY, desktopSidebarCollapsed ? "true" : "false");
      } catch (_error) {}
    }

    function applyDesktopSidebarState() {
      if (!refs.assistantShell) {
        return;
      }

      const shouldCollapse = !isCompactSidebarMode() && desktopSidebarCollapsed;
      refs.assistantShell.classList.toggle("sidebar-collapsed", shouldCollapse);
    }

    function updateSidebarToggleState() {
      if (!refs.sidebarToggleButton) {
        return;
      }

      if (!isCompactSidebarMode()) {
        refs.sidebarToggleButton.setAttribute("aria-expanded", "false");
        refs.sidebarToggleButton.setAttribute("aria-label", "Open tools menu");
        refs.sidebarToggleButton.setAttribute("title", "Tools");
        return;
      }

      const expanded = isCompactSidebarMode() ? isSidebarOpen : !desktopSidebarCollapsed;
      refs.sidebarToggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
      refs.sidebarToggleButton.setAttribute(
        "aria-label",
        isCompactSidebarMode()
          ? isSidebarOpen
            ? "Close sidebar"
            : "Open sidebar"
          : desktopSidebarCollapsed
            ? "Expand sidebar"
            : "Collapse sidebar"
      );
    }

    function openToolsModal() {
      if (!toolsModal) {
        return;
      }
      toolsModal.classList.remove("hidden");
      toolsModal.setAttribute("aria-hidden", "false");
    }

    function closeToolsModal() {
      if (!toolsModal) {
        return;
      }
      toolsModal.classList.add("hidden");
      toolsModal.setAttribute("aria-hidden", "true");
    }

    function closeAllMenus(exceptMenu = null) {
      document.querySelectorAll(".sidebar-item-menu[open]").forEach((menu) => {
        if (exceptMenu && menu === exceptMenu) {
          return;
        }
        menu.removeAttribute("open");
      });
    }

    function openSidebar() {
      if (!refs.assistantShell || !isCompactSidebarMode()) {
        return;
      }

      refs.assistantShell.classList.add("sidebar-open");
      isSidebarOpen = true;
      updateSidebarToggleState();
    }

    function closeSidebar() {
      if (!refs.assistantShell) {
        return;
      }

      refs.assistantShell.classList.remove("sidebar-open");
      isSidebarOpen = false;
      updateSidebarToggleState();
    }

    function handleSidebarToggle() {
      if (!isCompactSidebarMode()) {
        openToolsModal();
        return;
      }

      if (isSidebarOpen) {
        closeSidebar();
        return;
      }

      openSidebar();
    }

    function syncSidebarForViewport() {
      if (!isCompactSidebarMode()) {
        closeSidebar();
        applyDesktopSidebarState();
      } else if (refs.assistantShell) {
        refs.assistantShell.classList.remove("sidebar-collapsed");
      }

      updateSidebarToggleState();
    }

    function handleSidebarMenuTriggerClick(event) {
      const trigger = event.target.closest(".sidebar-item-menu-trigger");
      if (!trigger) {
        return;
      }

      const menu = trigger.closest(".sidebar-item-menu");
      if (!menu) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const shouldOpen = !menu.hasAttribute("open");
      closeAllMenus(menu);

      if (shouldOpen) {
        menu.setAttribute("open", "");
        return;
      }

      menu.removeAttribute("open");
    }

    function handleDocumentClick(event) {
      if (event.target.closest(".sidebar-item-menu")) {
        return;
      }
      closeAllMenus();
    }

    function handleEscapeKeydown(event) {
      if (event.key === "Escape" && options.isDialogOpen && options.isDialogOpen()) {
        event.preventDefault();
        if (typeof options.closeDialog === "function") {
          options.closeDialog();
        }
        return;
      }

      if (event.key === "Escape" && toolsModal && !toolsModal.classList.contains("hidden")) {
        event.preventDefault();
        closeToolsModal();
        return;
      }

      if (event.key === "Escape" && isSidebarOpen) {
        closeSidebar();
      }
    }

    function init() {
      desktopSidebarCollapsed = loadDesktopSidebarPreference();
      toolsModal = document.getElementById("mobileMenuModal");
      toolsModalClose = document.getElementById("mobileMenuClose");
      toolsModalCloseBtn = document.getElementById("mobileMenuCloseBtn");

      if (refs.sidebarToggleButton) {
        refs.sidebarToggleButton.addEventListener("click", handleSidebarToggle);
      }
      if (refs.sidebarBackdrop) {
        refs.sidebarBackdrop.addEventListener("click", closeSidebar);
      }
      if (toolsModalClose) {
        toolsModalClose.addEventListener("click", closeToolsModal);
      }
      if (toolsModalCloseBtn) {
        toolsModalCloseBtn.addEventListener("click", closeToolsModal);
      }
      if (toolsModal) {
        toolsModal.addEventListener("click", (event) => {
          if (event.target === toolsModal) {
            closeToolsModal();
          }
        });
      }

      document.addEventListener("click", handleSidebarMenuTriggerClick);
      document.addEventListener("click", handleDocumentClick);
      document.addEventListener("keydown", handleEscapeKeydown);
      window.addEventListener("resize", syncSidebarForViewport);
      syncSidebarForViewport();
    }

    return {
      closeAllMenus,
      closeSidebar,
      init,
      isCompactSidebarMode,
      openSidebar,
      syncSidebarForViewport
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.sidebar = {
    createSidebarController
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
