const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { app } = require("electron");
const { pathToFileURL } = require("url");

const DOWNLOAD_DIR_NAME = "downloads";
const DEFAULT_PREFIX = "ai-output";
const DEFAULT_MAX_CHARS = 40000;
const IMAGE_MAX_CHARS = 2000;

function safeRequire(moduleName) {
  try {
    return require(moduleName);
  } catch (error) {
    return null;
  }
}

function createFileService(options = {}) {
  let downloadDirPromise = null;

  function getBaseDir() {
    if (app && typeof app.getPath === "function") {
      return app.getPath("userData");
    }
    return process.cwd();
  }

  async function ensureDownloadDirectory() {
    if (!downloadDirPromise) {
      const dir = path.join(getBaseDir(), DOWNLOAD_DIR_NAME);
      downloadDirPromise = fsPromises.mkdir(dir, { recursive: true }).then(() => dir);
    }
    return downloadDirPromise;
  }

  function createFileName(prefix, extension) {
    const safePrefix = String(prefix || DEFAULT_PREFIX)
      .replace(/[\\/:*?"<>|]+/g, "-")
      .trim() || DEFAULT_PREFIX;
    const safeExt = String(extension || "").replace(/^\./, "").trim();
    const random = Math.random().toString(36).slice(2, 8);
    return `${safePrefix}-${Date.now()}-${random}.${safeExt || "txt"}`;
  }

  function resolveFileName(optionsArg, defaultExtension) {
    const requested = String(optionsArg && optionsArg.fileName ? optionsArg.fileName : "").trim();
    if (requested) {
      const sanitized = requested.replace(/[\\/:*?"<>|]+/g, "-").trim();
      const ext = path.extname(sanitized);
      if (!ext) {
        return `${sanitized}.${defaultExtension}`;
      }
      return sanitized;
    }

    return createFileName(optionsArg.prefix || DEFAULT_PREFIX, defaultExtension);
  }

  function normalizeText(value, maxChars = DEFAULT_MAX_CHARS) {
    const safe = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!safe) {
      return "";
    }
    if (safe.length <= maxChars) {
      return safe;
    }
    return `${safe.slice(0, maxChars - 3)}...`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeXml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  async function buildFileInfo(filePath, outputType, contentType) {
    let sizeBytes = 0;
    try {
      const stats = await fsPromises.stat(filePath);
      sizeBytes = Number(stats.size) || 0;
    } catch (_error) {}

    return {
      outputType,
      type: outputType,
      fileName: path.basename(filePath),
      filePath,
      path: filePath,
      fileUrl: pathToFileURL(filePath).href,
      contentType,
      sizeBytes
    };
  }

  function parseCsvLike(text) {
    const lines = String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return [];
    }

    const hasTabs = lines.some((line) => line.includes("\t"));
    const hasCommas = lines.some((line) => line.includes(","));
    let delimiter = "";

    if (hasTabs) {
      delimiter = "\t";
    } else if (hasCommas) {
      delimiter = ",";
    }

    return lines.map((line) => {
      if (!delimiter) {
        return [line];
      }
      return line.split(delimiter).map((cell) => cell.trim());
    });
  }

  function normalizeExcelInput(data) {
    if (Array.isArray(data)) {
      if (data.length === 0) {
        return { rows: [] };
      }

      if (data.every((row) => Array.isArray(row))) {
        return { rows: data };
      }

      if (data.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
        return { rows: data, columns: Object.keys(data[0] || {}) };
      }
    }

    if (data && typeof data === "object") {
      const rows = Array.isArray(data.rows) ? data.rows : Array.isArray(data.data) ? data.data : null;
      if (rows) {
        return { rows, columns: Array.isArray(data.columns) ? data.columns : undefined };
      }

      return { rows: [data], columns: Object.keys(data) };
    }

    const asString = normalizeText(data, DEFAULT_MAX_CHARS);
    if (!asString) {
      return { rows: [] };
    }

    try {
      const parsed = JSON.parse(asString);
      return normalizeExcelInput(parsed);
    } catch (_error) {
      return { rows: parseCsvLike(asString) };
    }
  }

  function ensureExcelRows(rows) {
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.slice(0, 500);
  }

  function normalizeDocSections(optionsArg, fallbackText) {
    const structured = optionsArg && typeof optionsArg.structured === "object" ? optionsArg.structured : null;
    if (structured && !Array.isArray(structured)) {
      const title = String(structured.title || optionsArg.title || "AI Output").trim() || "AI Output";
      const rawSections = Array.isArray(structured.sections) ? structured.sections : [];
      const sections = rawSections
        .map((section) => {
          if (!section || typeof section !== "object") {
            return null;
          }
          const heading = String(section.heading || "").trim();
          const rawParagraphs = Array.isArray(section.paragraphs)
            ? section.paragraphs
            : typeof section.paragraphs === "string"
              ? [section.paragraphs]
              : [];
          const paragraphs = rawParagraphs
            .map((paragraph) => String(paragraph || "").replace(/\s+/g, " ").trim())
            .filter(Boolean);
          if (!heading && paragraphs.length === 0) {
            return null;
          }
          return { heading, paragraphs: paragraphs.length > 0 ? paragraphs : [" "] };
        })
        .filter(Boolean);

      if (sections.length > 0) {
        return { title, sections };
      }
    }

    const safe = String(fallbackText || "").trim();
    const rawParagraphs = safe ? safe.split(/\n{2,}/) : [];
    const paragraphs = rawParagraphs
      .map((chunk) => chunk.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    return {
      title: "AI Output",
      sections: [
        {
          heading: "",
          paragraphs: paragraphs.length > 0 ? paragraphs : ["(No content)"]
        }
      ]
    };
  }

  function styleExcelHeaderRow(worksheet, rowIndex = 1) {
    if (!worksheet) {
      return;
    }
    const row = worksheet.getRow(rowIndex);
    row.font = { bold: true };
    row.alignment = { vertical: "middle" };
  }

  async function generatePDF(text, optionsArg = {}) {
    const PDFDocument = safeRequire("pdfkit");
    if (!PDFDocument) {
      throw new Error("pdfkit is not installed.");
    }

    const directory = await ensureDownloadDirectory();
    const fileName = resolveFileName(optionsArg, "pdf");
    const filePath = path.join(directory, fileName);
    const safeText = normalizeText(text, DEFAULT_MAX_CHARS) || " ";
    const structured = normalizeDocSections(optionsArg, safeText);

    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    const title = String(structured.title || "AI Output").trim();
    if (title) {
      doc.fontSize(20).text(title, { align: "left" });
      doc.moveDown(0.6);
    }

    structured.sections.forEach((section) => {
      if (section.heading) {
        doc.fontSize(14).text(section.heading, { align: "left" });
        doc.moveDown(0.3);
      }

      const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs : [];
      paragraphs.forEach((paragraph) => {
        const safeParagraph = String(paragraph || "").trim();
        if (!safeParagraph) {
          return;
        }
        doc.fontSize(12);
        doc.text(safeParagraph, {
          lineGap: 4,
          width: 500,
          align: "left"
        });
        doc.moveDown(0.4);
      });
    });

    doc.end();

    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    return buildFileInfo(filePath, "pdf", "application/pdf");
  }

  async function generateExcel(data, optionsArg = {}) {
    const ExcelJS = safeRequire("exceljs");
    if (!ExcelJS) {
      throw new Error("exceljs is not installed.");
    }

    const directory = await ensureDownloadDirectory();
    const fileName = resolveFileName(optionsArg, "xlsx");
    const filePath = path.join(directory, fileName);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sheet1");

    const normalized = normalizeExcelInput(data);
    const rows = ensureExcelRows(normalized.rows);

    if (rows.length === 0) {
      worksheet.addRow(["No data"]);
    } else if (rows.every((row) => Array.isArray(row))) {
      worksheet.addRows(rows);
      const firstRow = rows[0] || [];
      const headerCandidate =
        firstRow.length > 0 &&
        firstRow.every((cell) => typeof cell === "string" && String(cell || "").trim());
      if (headerCandidate) {
        styleExcelHeaderRow(worksheet, 1);
      }
    } else if (rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      const columns =
        Array.isArray(normalized.columns) && normalized.columns.length > 0
          ? normalized.columns
          : Object.keys(rows[0] || {});
      worksheet.columns = columns.map((key) => ({
        header: key,
        key,
        width: Math.max(12, String(key).length + 2)
      }));
      rows.forEach((row) => worksheet.addRow(row));
      styleExcelHeaderRow(worksheet, 1);
    } else {
      worksheet.addRows(rows);
    }

    await workbook.xlsx.writeFile(filePath);
    return buildFileInfo(
      filePath,
      "excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  }

  function looksLikeHtml(text) {
    const source = String(text || "");
    return /<!doctype/i.test(source) || /<html/i.test(source);
  }

  function containsHtmlTags(text) {
    return /<\/?[a-z][\s\S]*>/i.test(String(text || ""));
  }

  function buildHtmlDocument(text) {
    const safe = String(text || "");
    if (looksLikeHtml(safe)) {
      return safe;
    }

    if (containsHtmlTags(safe)) {
      return [
        "<!doctype html>",
        "<html>",
        "<head>",
        "  <meta charset=\"utf-8\" />",
        "  <title>AI Output</title>",
        "</head>",
        "<body>",
        safe,
        "</body>",
        "</html>"
      ].join("\n");
    }

    const escaped = escapeHtml(safe);
    return [
      "<!doctype html>",
      "<html>",
      "<head>",
      "  <meta charset=\"utf-8\" />",
      "  <title>AI Output</title>",
      "  <style>body{font-family:Arial, sans-serif; padding:24px;} pre{white-space:pre-wrap;}</style>",
      "</head>",
      "<body>",
      `<pre>${escaped}</pre>`,
      "</body>",
      "</html>"
    ].join("\n");
  }

  async function generateHTML(text, optionsArg = {}) {
    const directory = await ensureDownloadDirectory();
    const fileName = resolveFileName(optionsArg, "html");
    const filePath = path.join(directory, fileName);
    const safeText = normalizeText(text, DEFAULT_MAX_CHARS);
    const html = buildHtmlDocument(safeText || "");

    await fsPromises.writeFile(filePath, html, "utf8");
    return buildFileInfo(filePath, "html", "text/html");
  }

  async function generateDoc(text, optionsArg = {}) {
    const docx = safeRequire("docx");
    if (!docx) {
      throw new Error("docx is not installed.");
    }

    const { Document, Packer, Paragraph, TextRun } = docx;
    const directory = await ensureDownloadDirectory();
    const fileName = resolveFileName(optionsArg, "docx");
    const filePath = path.join(directory, fileName);
    const safeText = normalizeText(text, DEFAULT_MAX_CHARS);
    const structured = normalizeDocSections(optionsArg, safeText);
    const children = [];
    const title = String(structured.title || "AI Output").trim();
    if (title) {
      children.push(new Paragraph({ text: title, heading: "Heading1" }));
    }

    structured.sections.forEach((section) => {
      if (section.heading) {
        children.push(new Paragraph({ text: section.heading, heading: "Heading2" }));
      }
      const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs : [];
      paragraphs.forEach((paragraph) => {
        const safeParagraph = String(paragraph || "").trim();
        if (!safeParagraph) {
          return;
        }
        children.push(new Paragraph({ children: [new TextRun(safeParagraph)] }));
      });
    });

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: children.length > 0 ? children : [new Paragraph(" ")]
        }
      ]
    });

    const buffer = await Packer.toBuffer(doc);
    await fsPromises.writeFile(filePath, buffer);
    return buildFileInfo(
      filePath,
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  }

  function wrapTextLines(text, maxLineLength = 60, maxLines = 28) {
    const words = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);

    if (words.length === 0) {
      return ["(empty)"];
    }

    const lines = [];
    let current = "";
    for (const word of words) {
      if ((current + " " + word).trim().length > maxLineLength) {
        if (current) {
          lines.push(current);
        }
        current = word;
      } else {
        current = (current + " " + word).trim();
      }
      if (lines.length >= maxLines) {
        break;
      }
    }
    if (current && lines.length < maxLines) {
      lines.push(current);
    }
    return lines;
  }

  async function generateImage(text, optionsArg = {}) {
    const directory = await ensureDownloadDirectory();
    const fileName = resolveFileName(optionsArg, "svg");
    const filePath = path.join(directory, fileName);
    const safeText = normalizeText(text, IMAGE_MAX_CHARS);
    const lines = wrapTextLines(safeText || "Generated by IFDA AI");
    const padding = 40;
    const lineHeight = 26;
    const width = 960;
    const height = Math.max(200, padding * 2 + lineHeight * lines.length);

    const textNodes = lines
      .map((line, index) => {
        const y = padding + lineHeight * (index + 1);
        return `<text x="${padding}" y="${y}" font-size="18" font-family="Arial, sans-serif" fill="#1f2937">${escapeXml(
          line
        )}</text>`;
      })
      .join("\n");

    const svg = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="100%" height="100%" fill="#f8fafc"/>`,
      `<rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="18" fill="#ffffff" stroke="#e2e8f0" />`,
      textNodes,
      `</svg>`
    ].join("\n");

    await fsPromises.writeFile(filePath, svg, "utf8");
    return buildFileInfo(filePath, "image", "image/svg+xml");
  }

  function normalizeJsonPayload(data, fallbackText) {
    if (data == null) {
      return { content: String(fallbackText || "").trim() };
    }

    if (typeof data === "string") {
      const trimmed = data.trim();
      if (!trimmed) {
        return { content: "" };
      }
      try {
        return JSON.parse(trimmed);
      } catch (_error) {
        return { content: trimmed };
      }
    }

    if (typeof data === "object") {
      return data;
    }

    return { content: String(data) };
  }

  async function generateJson(data, optionsArg = {}) {
    const directory = await ensureDownloadDirectory();
    const fileName = resolveFileName(optionsArg, "json");
    const filePath = path.join(directory, fileName);
    const payload = normalizeJsonPayload(data, optionsArg.text);
    const json = JSON.stringify(payload, null, 2);
    await fsPromises.writeFile(filePath, json, "utf8");
    return buildFileInfo(filePath, "json", "application/json");
  }

  async function generateFile(outputType, payload = {}) {
    const type = String(outputType || "").trim().toLowerCase();
    if (type === "pdf") {
      return generatePDF(payload.text, payload);
    }
    if (type === "excel") {
      return generateExcel(payload.data ?? payload.text, payload);
    }
    if (type === "html") {
      return generateHTML(payload.text, payload);
    }
    if (type === "doc" || type === "docx") {
      return generateDoc(payload.text, payload);
    }
    if (type === "image") {
      return generateImage(payload.text, payload);
    }
    if (type === "json") {
      return generateJson(payload.data ?? payload.text, payload);
    }
    throw new Error(`Unsupported outputType: ${outputType}`);
  }

  return {
    ensureDownloadDirectory,
    generateDoc,
    generateExcel,
    generateFile,
    generateHTML,
    generateImage,
    generateJson,
    generatePDF
  };
}

module.exports = {
  createFileService
};
