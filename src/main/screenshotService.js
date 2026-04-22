const fs = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");
const { Worker } = require("worker_threads");
const { app, desktopCapturer, nativeImage } = require("electron");
const constants = require("../shared/constants");

function createScreenshotService() {
  let screenshotDirectoryPromise = null;

  async function ensureScreenshotDirectory() {
    if (!screenshotDirectoryPromise) {
      screenshotDirectoryPromise = fs
        .mkdir(path.join(app.getPath("userData"), constants.SCREENSHOT_DIR_NAME), { recursive: true })
        .then(() => path.join(app.getPath("userData"), constants.SCREENSHOT_DIR_NAME));
    }

    return screenshotDirectoryPromise;
  }

  async function captureScreen() {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 }
    });

    if (!sources || sources.length === 0) {
      throw new Error("No screen source found.");
    }

    const source = sources[0];
    const imageBase64 = source.thumbnail.toPNG().toString("base64");

    if (!imageBase64) {
      throw new Error("Unable to capture screenshot.");
    }

    return imageBase64;
  }

  function createFileName(prefix = "screenshot") {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now()}-${random}.png`;
  }

  async function saveScreenshot(base64Image, options = {}) {
    const safeBase64 = String(base64Image || "").trim();
    if (!safeBase64) {
      throw new Error("Screenshot data is empty.");
    }

    const directory = await ensureScreenshotDirectory();
    const fileName = createFileName(options.prefix || "screenshot");
    const filePath = path.join(directory, fileName);
    const buffer = Buffer.from(safeBase64, "base64");

    await fs.writeFile(filePath, buffer);

    return {
      imagePath: pathToFileURL(filePath).href
    };
  }

  async function extractOcrText(base64Screenshot) {
    const safeBase64 = String(base64Screenshot || "").trim();
    if (!safeBase64) {
      return "";
    }

    try {
      const startedAt = Date.now();
      console.info("[ocr] start", { imageBytes: Buffer.byteLength(safeBase64, "utf8") });
      const buffer = Buffer.from(safeBase64, "base64");
      const image = nativeImage.createFromBuffer(buffer);
      const size = image.getSize();
      let ocrBuffer = buffer;

      if (size && size.width && size.width > 1280) {
        const resized = image.resize({ width: 1280, quality: "good" });
        if (!resized.isEmpty()) {
          ocrBuffer = resized.toPNG();
        }
      }
      const finalText = await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, "workers", "ocrWorker.js"), {
          workerData: {
            imageBuffer: ocrBuffer
          }
        });
        let settled = false;

        worker.once("message", (message) => {
          settled = true;
          if (message && message.ok) {
            resolve(String(message.text || ""));
            return;
          }

          reject(new Error(message && message.error ? String(message.error) : "OCR worker failed."));
        });

        worker.once("error", (error) => {
          settled = true;
          reject(error);
        });

        worker.once("exit", (code) => {
          if (settled || code === 0) {
            return;
          }
          reject(new Error(`OCR worker exited with code ${code}.`));
        });
      });

      console.info("[ocr] end", { durationMs: Date.now() - startedAt, textLength: finalText.length });
      return finalText;
    } catch (_error) {
      return "";
    }
  }

  return {
    captureScreen,
    ensureScreenshotDirectory,
    extractOcrText,
    saveScreenshot
  };
}

module.exports = {
  createScreenshotService
};
