(() => {
  const localScriptSrc = "./public/highlight.min.js";
  const localStyleHref = "./public/highlight.css";

  const ensureLocalStyle = () => {
    if (document.querySelector("link[data-hljs-local]")) {
      return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = localStyleHref;
    link.dataset.hljsLocal = "true";
    document.head.appendChild(link);
  };

  const applyHighlighting = () => {
    if (!window.hljs || typeof window.hljs.highlightElement !== "function") {
      return;
    }

    document.querySelectorAll("pre code").forEach((block) => {
      if (!block.classList.contains("hljs")) {
        try {
          window.hljs.highlightElement(block);
        } catch (_error) {}
      }
    });
  };

  const ensureLocalScript = () => {
    if (window.hljs || document.querySelector("script[data-hljs-local]")) {
      return;
    }

    const script = document.createElement("script");
    script.src = localScriptSrc;
    script.dataset.hljsLocal = "true";
    script.addEventListener("load", () => {
      applyHighlighting();
    });
    document.body.appendChild(script);
  };

  const handleResourceError = (event) => {
    const target = event.target;
    if (!target) {
      return;
    }

    const tagName = String(target.tagName || "").toLowerCase();
    if (tagName === "script") {
      const src = String(target.src || "");
      if (src.includes("highlight")) {
        console.warn("Highlight.js CDN failed, loading local fallback.");
        ensureLocalStyle();
        ensureLocalScript();
      }
    }

    if (tagName === "link") {
      const href = String(target.href || "");
      if (href.includes("highlight")) {
        console.warn("Highlight.js CDN CSS failed, loading local fallback.");
        ensureLocalStyle();
      }
    }
  };

  window.addEventListener("error", handleResourceError, true);

  window.addEventListener("load", () => {
    if (!window.hljs) {
      console.warn("Highlight.js not available after load, using local fallback.");
      ensureLocalStyle();
      ensureLocalScript();
      return;
    }

    applyHighlighting();
  });
})();
