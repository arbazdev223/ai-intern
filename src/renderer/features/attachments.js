(function (root) {
  const constants = root.SharedModules.constants;

  function createAttachmentsManager(options = {}) {
    const refs = options.refs;
    let pendingScreenshotBase64 = "";
    let lastPasteHandledAt = 0;
    let clipboardReadInProgress = false;

    function wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function updateAttachmentStatus() {
      if (!refs.screenshotStatus) {
        return;
      }

      if (!pendingScreenshotBase64) {
        refs.screenshotStatus.classList.add("hidden");
        refs.screenshotStatus.textContent = "Screenshot attached";
        if (refs.clearAttachmentButton) {
          refs.clearAttachmentButton.classList.add("hidden");
        }
        return;
      }

      refs.screenshotStatus.classList.remove("hidden");
      refs.screenshotStatus.textContent = "Image attached";
      if (refs.clearAttachmentButton) {
        refs.clearAttachmentButton.classList.remove("hidden");
      }
    }

    function updateAttachmentPreview() {
      if (!refs.attachmentPreview || !refs.attachmentPreviewImage) {
        return;
      }

      if (!pendingScreenshotBase64) {
        refs.attachmentPreview.classList.add("hidden");
        refs.attachmentPreviewImage.removeAttribute("src");
        return;
      }

      refs.attachmentPreviewImage.src = `data:image/png;base64,${pendingScreenshotBase64}`;
      refs.attachmentPreview.classList.remove("hidden");
    }

    function clearPendingAttachment(optionsArg = {}) {
      const silent = Boolean(optionsArg.silent);
      pendingScreenshotBase64 = "";
      updateAttachmentStatus();
      updateAttachmentPreview();
      if (!silent) {
        options.setStatus("Attachment removed.");
      }
    }

    function showPendingAttachmentPreview(sourceLabel) {
      if (!pendingScreenshotBase64) {
        return;
      }

      updateAttachmentStatus();
      updateAttachmentPreview();
      options.setStatus(`Screenshot attached (${sourceLabel}).`);
    }

    async function captureScreenshot() {
      let wasHiddenForCapture = false;

      try {
        wasHiddenForCapture = await options.assistantAPI.hideForCapture();
        if (wasHiddenForCapture) {
          await wait(constants.CAPTURE_HIDE_DELAY_MS);
        }

        const imageBase64 = await options.assistantAPI.captureScreenshot();
        if (!imageBase64) {
          throw new Error("Unable to capture screenshot.");
        }

        return imageBase64;
      } finally {
        if (wasHiddenForCapture) {
          try {
            await options.assistantAPI.showAfterCapture();
          } catch (error) {
            console.error("Unable to restore assistant window after capture:", error);
          }
        }
      }
    }

    async function handleManualScreenshotAttach() {
      if (options.getBusy()) {
        return "";
      }

      try {
        options.setStatus("Capturing screenshot...", { busy: true });
        pendingScreenshotBase64 = await captureScreenshot();
        showPendingAttachmentPreview("capture");
        options.setStatus("Screenshot captured and attached.");
        return pendingScreenshotBase64;
      } catch (error) {
        console.error("Manual screenshot failed:", error);
        options.setStatus("Screenshot capture failed.");
        throw error;
      }
    }

    async function attachScreenshotFromClipboard() {
      if (clipboardReadInProgress) {
        return false;
      }

      clipboardReadInProgress = true;

      try {
        const base64 = String(options.assistantAPI.readClipboardImage() || "").trim();
        if (!base64) {
          return false;
        }

        pendingScreenshotBase64 = base64;
        lastPasteHandledAt = Date.now();
        showPendingAttachmentPreview("clipboard");
        options.setStatus("Image pasted from clipboard.");
        return true;
      } finally {
        clipboardReadInProgress = false;
      }
    }

    function handlePromptKeydown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        setTimeout(async () => {
          if (Date.now() - lastPasteHandledAt > 250) {
            await attachScreenshotFromClipboard();
          }
        }, 50);
      }
    }

    function handleGlobalPasteKeydown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        setTimeout(async () => {
          if (Date.now() - lastPasteHandledAt > 250) {
            await attachScreenshotFromClipboard();
          }
        }, 50);
      }
    }

    function handlePasteEvent(event) {
      attachScreenshotFromClipboard()
        .then((handled) => {
          if (handled) {
            event.preventDefault();
          }
        })
        .catch((error) => {
          console.error("Clipboard paste failed:", error);
        });
    }

    function init() {
      if (refs.clearAttachmentButton) {
        refs.clearAttachmentButton.addEventListener("click", () => {
          if (pendingScreenshotBase64) {
            clearPendingAttachment();
          }
        });
      }

      if (refs.promptInput) {
        refs.promptInput.addEventListener("keydown", handlePromptKeydown);
      }

      document.addEventListener("paste", handlePasteEvent);
      document.addEventListener("keydown", handleGlobalPasteKeydown);
      updateAttachmentStatus();
      updateAttachmentPreview();
    }

    return {
      attachScreenshotFromClipboard,
      captureScreenshot,
      clearPendingAttachment,
      getPendingScreenshotBase64: () => pendingScreenshotBase64,
      handleManualScreenshotAttach,
      init,
      persistAttachment: async (prefix = "chat") => {
        if (!pendingScreenshotBase64) {
          return null;
        }

        return options.assistantAPI.storeScreenshot({
          base64Screenshot: pendingScreenshotBase64,
          prefix
        });
      }
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.attachments = {
    createAttachmentsManager
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
