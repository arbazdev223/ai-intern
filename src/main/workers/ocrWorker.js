const { parentPort, workerData } = require("worker_threads");
const Tesseract = require("tesseract.js");
const constants = require("../../shared/constants");

async function run() {
  const imageBuffer = workerData && workerData.imageBuffer ? workerData.imageBuffer : null;
  if (!imageBuffer) {
    throw new Error("OCR worker received no image data.");
  }

  const result = await Tesseract.recognize(Buffer.from(imageBuffer), "eng");
  const extractedText = String(result && result.data && result.data.text ? result.data.text : "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, constants.OCR_MAX_CHARS);

  parentPort.postMessage({
    ok: true,
    text: extractedText
  });
}

run().catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: error && error.message ? error.message : String(error || "OCR worker failed.")
  });
});
