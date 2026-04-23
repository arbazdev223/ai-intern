(function (root) {
  const constants = root.SharedModules.constants;
  const EXTERNAL_SCREEN_TOGGLE_KEY = "assistant.allowExternalScreenData";

  function createChatManager(options = {}) {
    const refs = options.refs;
    let chatSessions = [];
    let activeChatId = null;
    let conversation = [];
    let isBusy = false;
    let openingAnalysisRunning = false;
    let longRequestTimer = null;
    let chatSearchQuery = "";
    let chatSearchDebounceTimer = null;
    let mediaRecorder = null;
    let mediaStream = null;
    let isVoiceRecording = false;
    let voiceTranscriptText = "";
    let voiceInputPrefix = "";
    let voiceChunks = [];
    let voiceMimeType = "audio/webm";
    let voiceAudioContext = null;
    let voiceAnalyser = null;
    let voiceAnalyserData = null;
    let voiceWaveAnimationHandle = null;
    let voiceWaveLevels = null;
    let voiceWaveCssWidth = 0;
    let voiceWaveCssHeight = 0;
    let voiceWaveDpr = 1;
    let shouldTranscribeVoice = true;

    function resolveVoiceLanguage() {
      const inputText = String((refs.promptInput && refs.promptInput.value) || "").trim();
      if (/[\u0900-\u097F]/.test(inputText)) {
        return "hi-IN";
      }

      const browserLang = String((navigator && navigator.language) || "").toLowerCase();
      if (browserLang.startsWith("hi")) {
        return "hi-IN";
      }

      return "en-US";
    }

    function getVoiceOutputMode() {
      const raw = String((refs.voiceOutputMode && refs.voiceOutputMode.value) || "auto").trim().toLowerCase();
      if (raw === "hinglish" || raw === "english") {
        return raw;
      }
      return "auto";
    }

    function updateVoiceButtonUi() {
      if (!refs.voiceButton) {
        return;
      }

      refs.voiceButton.classList.toggle("is-recording", isVoiceRecording);
      if (refs.voiceWaveWrap) {
        refs.voiceWaveWrap.classList.toggle("hidden", !isVoiceRecording);
        refs.voiceWaveWrap.setAttribute("aria-hidden", isVoiceRecording ? "false" : "true");
      }
      refs.voiceButton.classList.toggle("hidden", isVoiceRecording);
      if (refs.chatForm) {
        refs.chatForm.classList.toggle("is-voice-recording", isVoiceRecording);
      }
      refs.voiceButton.setAttribute("aria-pressed", isVoiceRecording ? "true" : "false");
      refs.voiceButton.setAttribute(
        "aria-label",
        isVoiceRecording ? "Stop voice input" : "Start voice input"
      );
      refs.voiceButton.title = isVoiceRecording ? "Stop voice input" : "Voice input";
    }

    function stopVoiceWave() {
      if (voiceWaveAnimationHandle) {
        try {
          cancelAnimationFrame(voiceWaveAnimationHandle);
        } catch (_error) {}
      }

      voiceWaveAnimationHandle = null;
      voiceAnalyser = null;
      voiceAnalyserData = null;
      voiceWaveLevels = null;

      if (voiceAudioContext) {
        try {
          voiceAudioContext.close();
        } catch (_error) {}
      }
      voiceAudioContext = null;

      if (refs.voiceWaveCanvas) {
        const ctx = refs.voiceWaveCanvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, refs.voiceWaveCanvas.width, refs.voiceWaveCanvas.height);
        }
      }
    }

    function startVoiceWave(stream) {
      stopVoiceWave();
      if (!refs.voiceWaveCanvas || !stream) {
        return;
      }

      const CanvasCtx = refs.voiceWaveCanvas.getContext("2d");
      if (!CanvasCtx) {
        return;
      }

      const syncCanvasResolution = () => {
        const canvas = refs.voiceWaveCanvas;
        if (!canvas) {
          return;
        }

        const rect = canvas.getBoundingClientRect();
        const cssWidth = Math.max(1, Math.floor(rect.width));
        const cssHeight = Math.max(1, Math.floor(rect.height));
        const dpr = Math.max(1, Math.floor((window && window.devicePixelRatio) || 1));

        // Resize backing store only when needed (prevents blur + weird spacing on scaled canvas).
        if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
          canvas.width = cssWidth * dpr;
          canvas.height = cssHeight * dpr;
        }

        voiceWaveCssWidth = cssWidth;
        voiceWaveCssHeight = cssHeight;
        voiceWaveDpr = dpr;

        CanvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };

      syncCanvasResolution();

      const AudioCtx =
        (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext)) || null;
      if (!AudioCtx) {
        return;
      }

      try {
        voiceAudioContext = new AudioCtx();
        const source = voiceAudioContext.createMediaStreamSource(stream);
        voiceAnalyser = voiceAudioContext.createAnalyser();
        voiceAnalyser.fftSize = 2048;
        voiceAnalyser.smoothingTimeConstant = 0.86;
        source.connect(voiceAnalyser);
        voiceAnalyserData = new Uint8Array(voiceAnalyser.fftSize);
      } catch (_error) {
        stopVoiceWave();
        return;
      }

      const computeBarCount = () => {
        const gap = 1;
        const minBarWidth = 2;
        return Math.max(40, Math.min(450, Math.floor((voiceWaveCssWidth + gap) / (minBarWidth + gap))));
      };

      let barCount = computeBarCount();
      voiceWaveLevels = new Array(barCount).fill(0.08);
      let lastLevel = 0.08;

      const draw = () => {
        if (!isVoiceRecording || !voiceAnalyser || !voiceAnalyserData) {
          stopVoiceWave();
          return;
        }

        syncCanvasResolution();
        const width = voiceWaveCssWidth;
        const height = voiceWaveCssHeight;

        const nextBarCount = computeBarCount();
        if (nextBarCount !== barCount) {
          barCount = nextBarCount;
          voiceWaveLevels = new Array(barCount).fill(lastLevel);
        }

        voiceAnalyser.getByteTimeDomainData(voiceAnalyserData);

        let sum = 0;
        for (let i = 0; i < voiceAnalyserData.length; i++) {
          const centered = (voiceAnalyserData[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / voiceAnalyserData.length); // 0..~1

        // Smooth + keep a tiny idle pulse so the UI doesn't look frozen.
        const target = Math.min(1, rms * 2.4);
        const idle = 0.06 + Math.abs(Math.sin(Date.now() / 180)) * 0.02;
        const nextLevel = Math.max(idle, target);
        lastLevel = lastLevel * 0.78 + nextLevel * 0.22;

        if (voiceWaveLevels) {
          voiceWaveLevels.shift();
          voiceWaveLevels.push(lastLevel);
        }

        CanvasCtx.clearRect(0, 0, width, height);

        const gap = 1;
        const barWidth = Math.max(2, Math.floor((width - gap * (barCount - 1)) / barCount));
        const centerY = height / 2;
        let x = 0;

        const fill = CanvasCtx.createLinearGradient(0, 0, width, 0);
        fill.addColorStop(0, "rgba(15, 23, 42, 0.92)");
        fill.addColorStop(1, "rgba(2, 6, 23, 0.92)");
        CanvasCtx.fillStyle = fill;

        const hasRoundRect = typeof CanvasCtx.roundRect === "function";
        for (let i = 0; i < barCount; i++) {
          const level = voiceWaveLevels ? voiceWaveLevels[i] : 0.08;
          const eased = Math.min(1, Math.pow(level, 0.7));
          const h = Math.max(3, eased * height);
          const y = centerY - h / 2;
          const r = Math.min(5, barWidth / 2);

          CanvasCtx.beginPath();
          if (hasRoundRect) {
            CanvasCtx.roundRect(x, y, barWidth, h, r);
          } else {
            const rx = r;
            const ry = r;
            CanvasCtx.moveTo(x + rx, y);
            CanvasCtx.lineTo(x + barWidth - rx, y);
            CanvasCtx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + ry);
            CanvasCtx.lineTo(x + barWidth, y + h - ry);
            CanvasCtx.quadraticCurveTo(x + barWidth, y + h, x + barWidth - rx, y + h);
            CanvasCtx.lineTo(x + rx, y + h);
            CanvasCtx.quadraticCurveTo(x, y + h, x, y + h - ry);
            CanvasCtx.lineTo(x, y + ry);
            CanvasCtx.quadraticCurveTo(x, y, x + rx, y);
          }
          CanvasCtx.fill();

          x += barWidth + gap;
        }

        voiceWaveAnimationHandle = requestAnimationFrame(draw);
      };

      voiceWaveAnimationHandle = requestAnimationFrame(draw);
    }

    function setVoiceRecordingState(nextState) {
      isVoiceRecording = Boolean(nextState);
      updateVoiceButtonUi();
      if (!isVoiceRecording && refs.voiceLivePreview) {
        refs.voiceLivePreview.classList.add("hidden");
        refs.voiceLivePreview.textContent = "";
      }
      if (!isVoiceRecording) {
        stopVoiceWave();
      }
    }

    function releaseVoiceResources() {
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (_error) {}
        });
      }

      mediaStream = null;
      mediaRecorder = null;
    }

    function resolveRecorderMimeType() {
      if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
        return "audio/webm";
      }

      if (MediaRecorder.isTypeSupported("audio/webm")) {
        return "audio/webm";
      }

      return "";
    }

    function applyVoiceTranscript(nextTranscript) {
      if (!refs.promptInput) {
        return;
      }

      voiceTranscriptText = String(nextTranscript || "").trim();
      const composed = `${voiceInputPrefix} ${voiceTranscriptText}`.trim();
      refs.promptInput.value = composed;
      autoResizeInput();

      if (refs.voiceLivePreview) {
        if (voiceTranscriptText) {
          refs.voiceLivePreview.textContent = `Listening: ${voiceTranscriptText}`;
          refs.voiceLivePreview.classList.remove("hidden");
        } else {
          refs.voiceLivePreview.textContent = "";
          refs.voiceLivePreview.classList.add("hidden");
        }
      }
    }

    function stopVoiceInput() {
      if (!mediaRecorder || !isVoiceRecording) {
        return;
      }

      try {
        mediaRecorder.stop();
      } catch (_error) {}
      stopVoiceWave();
      setVoiceRecordingState(false);
      setStatus("Transcribing audio...", { busy: true });
    }

    function cancelVoiceInput() {
      if (!mediaRecorder || !isVoiceRecording) {
        return;
      }
      shouldTranscribeVoice = false;
      try {
        mediaRecorder.stop();
      } catch (_error) {}
      stopVoiceWave();
      setVoiceRecordingState(false);
      setStatus("Voice input cancelled.");
    }

    async function startVoiceInput() {
      if (isBusy || !refs.promptInput || refs.promptInput.disabled) {
        return;
      }

      if (mediaRecorder) {
        setStatus("Finishing previous recording...");
        return;
      }

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        setStatus("Voice input is not supported in this environment.");
        return;
      }

      const outputMode = getVoiceOutputMode();
      const preferredMimeType = resolveRecorderMimeType();

      voiceInputPrefix = String(refs.promptInput.value || "").trim();
      voiceChunks = [];
      applyVoiceTranscript("");
      shouldTranscribeVoice = true;

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = preferredMimeType
          ? new MediaRecorder(mediaStream, { mimeType: preferredMimeType })
          : new MediaRecorder(mediaStream);
        voiceMimeType = String(mediaRecorder.mimeType || preferredMimeType || "audio/webm")
          .split(";")[0]
          .trim() || "audio/webm";

        mediaRecorder.ondataavailable = (event) => {
          if (!event.data || event.data.size === 0) {
            return;
          }
          voiceChunks.push(event.data);
        };

        mediaRecorder.onerror = (event) => {
          console.error("Voice recorder error:", event);
          setStatus("Voice input error.");
          setVoiceRecordingState(false);
          releaseVoiceResources();
        };

        mediaRecorder.onstop = async () => {
          try {
            if (!shouldTranscribeVoice) {
              return;
            }
            const audioBlob = new Blob(voiceChunks, { type: voiceMimeType || "audio/webm" });
            console.log("Blob type:", audioBlob.type, "size:", audioBlob.size);

            const audioFile = typeof File !== "undefined"
              ? new File([audioBlob], "speech.webm", { type: "audio/webm" })
              : audioBlob;
            console.log("File:", audioFile);

            if (!audioFile || audioBlob.size === 0) {
              console.error("Empty audio file");
              setStatus("No audio captured. Please try again.");
              return;
            }

            const response = await options.assistantAPI.transcribeSpeech({
              file: audioFile,
              languageCode:
                outputMode === "hinglish"
                  ? "hi"
                  : outputMode === "english"
                    ? "en"
                    : "",
              outputMode
            });
            const transcript = String((response && response.text) || "").trim();
            applyVoiceTranscript(transcript);
            setStatus(transcript ? "Voice input ready." : "No speech detected.");
          } catch (error) {
            console.error("Voice transcription failed:", error);
            setStatus("Voice transcription failed.");
          } finally {
            voiceChunks = [];
            releaseVoiceResources();
            setVoiceRecordingState(false);
            if (refs.promptInput) {
              refs.promptInput.focus();
            }
          }
        };

        mediaRecorder.start();
        setVoiceRecordingState(true);
        startVoiceWave(mediaStream);
        setStatus("Listening...", { busy: true });
      } catch (error) {
        console.error("Voice start error:", error);
        setVoiceRecordingState(false);
        releaseVoiceResources();
        const message = String(error && error.name ? error.name : "").toLowerCase().includes("notallowed")
          ? "Microphone permission denied."
          : "Unable to start voice input.";
        setStatus(message);
      }
    }

    function handleVoiceButtonClick() {
      if (isVoiceRecording) {
        stopVoiceInput();
        return;
      }

      startVoiceInput().catch((error) => {
        console.error("Voice input start failed:", error);
        setStatus("Unable to start voice input.");
      });
    }

    function initVoiceInput() {
      if (!refs.voiceButton || !refs.promptInput) {
        return;
      }

      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function" ||
        typeof MediaRecorder === "undefined" ||
        !options.assistantAPI ||
        typeof options.assistantAPI.transcribeSpeech !== "function"
      ) {
        refs.voiceButton.classList.add("hidden");
        return;
      }

      updateVoiceButtonUi();

      refs.voiceButton.addEventListener("click", handleVoiceButtonClick);
      if (refs.voiceStopButton) {
        refs.voiceStopButton.addEventListener("click", () => {
          stopVoiceInput();
        });
      }
      if (refs.voiceCancelButton) {
        refs.voiceCancelButton.addEventListener("click", () => {
          cancelVoiceInput();
        });
      }
    }

    function loadExternalScreenConsent() {
      if (typeof localStorage === "undefined") {
        return false;
      }

      try {
        return localStorage.getItem(EXTERNAL_SCREEN_TOGGLE_KEY) === "true";
      } catch (_error) {
        return false;
      }
    }

    function saveExternalScreenConsent(allowed) {
      if (typeof localStorage === "undefined") {
        return;
      }

      try {
        localStorage.setItem(EXTERNAL_SCREEN_TOGGLE_KEY, allowed ? "true" : "false");
      } catch (_error) {}
    }

    function applyExternalScreenConsent(allowed) {
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.checked = allowed;
      }
      if (refs.externalScreenToggleLabel) {
        refs.externalScreenToggleLabel.textContent = allowed ? "External AI: ON" : "External AI: OFF";
      }
    }

    function isExternalScreenAllowed() {
      return Boolean(refs.externalScreenToggle && refs.externalScreenToggle.checked);
    }

    function setModelStatus(mode, detail) {
      if (!refs.modelStatus) {
        return;
      }

      const safeMode = String(mode || "Offline").trim() || "Offline";
      const safeDetail = String(detail || "").trim();
      refs.modelStatus.textContent = safeDetail ? `Mode: ${safeMode} (${safeDetail})` : `Mode: ${safeMode}`;
      refs.modelStatus.dataset.mode = safeMode.toLowerCase();
    }

    function resolveModeFromModel(usedModel) {
      const safeModel = String(usedModel || "").trim();
      if (!safeModel) {
        return { mode: "Offline", detail: "" };
      }
      if (safeModel.toLowerCase().startsWith("openai:")) {
        return { mode: "OpenAI", detail: safeModel.replace(/^openai:/i, "") };
      }
      if (safeModel.toLowerCase().startsWith("gemini:")) {
        return { mode: "Gemini", detail: safeModel.replace(/^gemini:/i, "") };
      }
      return { mode: "AI", detail: safeModel };
    }

    function setStatus(text, statusOptions = {}) {
      const busy = Boolean(statusOptions.busy);
      if (refs.statusText) {
        refs.statusText.textContent = String(text || "");
        refs.statusText.classList.toggle("busy", busy);
      }
    }

    function setTypingIndicator(show, labelText = "AI is thinking") {
      const safeLabel = String(labelText || "AI is thinking").trim() || "AI is thinking";
      if (refs.typingIndicator) {
        refs.typingIndicator.classList.toggle("hidden", !show);
      }
      const activeTypingLabel =
        (refs.typingIndicator && refs.typingIndicator.querySelector(".typing-label")) ||
        refs.typingLabel ||
        null;
      if (activeTypingLabel) {
        activeTypingLabel.textContent = show ? safeLabel : "AI is thinking";
        refs.typingLabel = activeTypingLabel;
      }
      if (!show && longRequestTimer) {
        clearTimeout(longRequestTimer);
        longRequestTimer = null;
      }
      if (show && !longRequestTimer && activeTypingLabel) {
        const followUpLabel = /\bimage\b/i.test(safeLabel)
          ? "Still generating image..."
          : "Still working...";
        longRequestTimer = setTimeout(() => {
          const liveLabel =
            (refs.typingIndicator && refs.typingIndicator.querySelector(".typing-label")) ||
            refs.typingLabel ||
            null;
          if (liveLabel) {
            liveLabel.textContent = followUpLabel;
          }
        }, 7000);
      }
    }

    function setBusyState(nextBusy) {
      isBusy = nextBusy;
      if (refs.sendButton) {
        refs.sendButton.disabled = nextBusy;
      }
      if (refs.screenshotButton) {
        refs.screenshotButton.disabled = nextBusy;
      }
      if (refs.promptInput) {
        refs.promptInput.disabled = nextBusy;
      }
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.disabled = nextBusy;
      }
      if (refs.voiceButton) {
        refs.voiceButton.disabled = nextBusy;
      }
      if (nextBusy && isVoiceRecording) {
        stopVoiceInput();
      }
    }

    function autoResizeInput() {
      if (!refs.promptInput) {
        return;
      }

      refs.promptInput.style.height = "auto";
      refs.promptInput.style.height = `${Math.min(refs.promptInput.scrollHeight, 160)}px`;
    }

    function setDetectedApp(appName) {
      const safeName = String(appName || "Unknown application").trim() || "Unknown application";
      if (refs.detectedAppLabel) {
        refs.detectedAppLabel.textContent = `Detected App: ${safeName}`;
      }
    }

    function getSessionById(sessionId) {
      const id = String(sessionId || "");
      return chatSessions.find((session) => session.id === id) || null;
    }

    function getActiveSession() {
      return getSessionById(activeChatId);
    }

    function extractFirstUrlFromText(text) {
      const source = String(text || "");
      const match = source.match(/https?:\/\/[^\s)\]}>"']+/i);
      return match ? String(match[0]).trim() : "";
    }

    function shouldAttachLastUrlContext(promptText, session) {
      const prompt = String(promptText || "").trim().toLowerCase();
      if (!prompt) {
        return false;
      }

      const hasPinnedUrl = Boolean(session && session.lastUrl && Number(session.lastUrlTurnsRemaining) > 0);

      // If user recently shared a URL in this chat, treat follow-ups as referring to that page by default.
      // This is what users expect: they shouldn't need to paste the URL repeatedly.
      if (hasPinnedUrl) {
        // Avoid attaching URL context to explicit "new topic" prompts.
        if (/\b(new\s+topic|forget\s+link|clear\s+link|reset)\b/i.test(prompt)) {
          return false;
        }
        return true;
      }

      // Otherwise: only attach when prompt looks like a follow-up reference.
      return /\b(link|url|page|website|site|this|that|it)\b/i.test(prompt);
    }

    function updateConversationFromActiveSession() {
      const session = getActiveSession();
      if (!session) {
        conversation = [];
        return;
      }

      session.conversation = options.sessionStore.buildConversationFromMessages(session.messages);
      const memory = options.sessionStore.buildMemoryFromMessages(session.messages);
      session.recentMessages = memory.recentMessages;
      session.summarizedMemory = memory.summarizedMemory;
      conversation = session.conversation.slice(-12);
    }

    function saveSessions() {
      options.sessionStore.saveState({
        activeChatId,
        sessions: chatSessions
      });
    }

    function renderConversationList() {
      if (!refs.conversationList) {
        return;
      }

      refs.conversationList.innerHTML = "";

      const allChats = [...chatSessions].sort((left, right) => right.updatedAt - left.updatedAt);
      const query = String(chatSearchQuery || "").trim().toLowerCase();
      const filteredChats = query
        ? allChats.filter((session) => sessionMatchesQuery(session, query))
        : allChats;

      if (filteredChats.length === 0) {
        const emptyItem = document.createElement("li");
        emptyItem.className = "conversation-empty-state";
        emptyItem.textContent = "No chats found";
        refs.conversationList.appendChild(emptyItem);
        return;
      }

      filteredChats.forEach((session) => {
          const item = document.createElement("li");
          item.className = "conversation-item";
          item.dataset.chatId = session.id;
          if (session.id === activeChatId) {
            item.classList.add("active");
          }

          const topRow = document.createElement("div");
          topRow.className = "sidebar-item-row";

          const selectBtn = document.createElement("button");
          selectBtn.type = "button";
          selectBtn.className = "conversation-select";
          selectBtn.dataset.action = "select";
          selectBtn.dataset.chatId = session.id;
          const titleText = options.sessionStore.createTitleFromMessage(session.title || "New chat");
          selectBtn.title = titleText;
          if (query) {
            selectBtn.innerHTML = highlightMatch(titleText, query);
          } else {
            selectBtn.textContent = titleText;
          }

          const menu = document.createElement("details");
          menu.className = "sidebar-item-menu conversation-actions";

          const menuTrigger = document.createElement("summary");
          menuTrigger.className = "sidebar-item-menu-trigger";
          menuTrigger.setAttribute("aria-label", `More actions for ${selectBtn.textContent}`);
          menuTrigger.textContent = "\u22EE";

          const actions = document.createElement("div");
          actions.className = "sidebar-item-menu-popover";

          const renameBtn = document.createElement("button");
          renameBtn.type = "button";
          renameBtn.className = "sidebar-item-menu-action conversation-action";
          renameBtn.dataset.action = "rename";
          renameBtn.dataset.chatId = session.id;
          renameBtn.textContent = "Rename";

          const deleteBtn = document.createElement("button");
          deleteBtn.type = "button";
          deleteBtn.className = "sidebar-item-menu-action conversation-action danger";
          deleteBtn.dataset.action = "delete";
          deleteBtn.dataset.chatId = session.id;
          deleteBtn.textContent = "Delete";

          actions.appendChild(renameBtn);
          actions.appendChild(deleteBtn);
          menu.appendChild(menuTrigger);
          menu.appendChild(actions);
          topRow.appendChild(selectBtn);
          topRow.appendChild(menu);
          item.appendChild(topRow);
          refs.conversationList.appendChild(item);
        });
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function escapeRegExp(value) {
      return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function highlightMatch(text, query) {
      const safeText = String(text || "");
      const trimmedQuery = String(query || "").trim();
      if (!trimmedQuery) {
        return escapeHtml(safeText);
      }

      const escapedQuery = escapeRegExp(trimmedQuery);
      const regex = new RegExp(`(${escapedQuery})`, "ig");
      return escapeHtml(safeText).replace(regex, "<mark>$1</mark>");
    }

    function sessionMatchesQuery(session, query) {
      const safeQuery = String(query || "").trim().toLowerCase();
      if (!safeQuery) {
        return true;
      }

      const title = options.sessionStore
        .createTitleFromMessage(session && session.title ? session.title : "New chat")
        .toLowerCase();
      if (title.includes(safeQuery)) {
        return true;
      }

      const messages = Array.isArray(session && session.messages) ? session.messages : [];
      return messages.some((msg) => {
        const content = String(msg && msg.content ? msg.content : "").toLowerCase();
        return content.includes(safeQuery);
      });
    }

    function applyChatSearch(nextValue) {
      chatSearchQuery = String(nextValue || "");
      renderConversationList();
    }

    function handleChatSearchInput(event) {
      const value = String(event && event.target ? event.target.value : "");
      const shouldDebounce = chatSessions.length > 100;
      if (!shouldDebounce) {
        applyChatSearch(value);
        return;
      }

      if (chatSearchDebounceTimer) {
        clearTimeout(chatSearchDebounceTimer);
      }

      chatSearchDebounceTimer = setTimeout(() => {
        applyChatSearch(value);
      }, 200);
    }

    function switchChat(sessionId, switchOptions = {}) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      activeChatId = session.id;
      options.promptLibrary.hidePromptBrowser();
      options.attachments.clearPendingAttachment({ silent: true });
      updateConversationFromActiveSession();
      renderConversationList();
      options.messageRenderer.renderSessionMessages(session.messages);
      saveSessions();

      if (switchOptions.focusInput && refs.promptInput) {
        refs.promptInput.focus();
      }
    }

    function appendMessageToActiveSession(role, text, messageOptions = {}) {
      const session = getActiveSession();
      if (!session) {
        return;
      }

      const safeRole = options.sessionStore.normalizeRole(role);
      const safeContent = String(text || "").trim();
      const imagePath = safeRole === "user" ? String(messageOptions.imagePath || "").trim() : "";
      const files = safeRole === "assistant" && Array.isArray(messageOptions.files)
        ? messageOptions.files
        : undefined;
      const imageUrl =
        safeRole === "assistant" ? String(messageOptions.imageUrl || "").trim() : "";
      const imageUrls =
        safeRole === "assistant" && Array.isArray(messageOptions.imageUrls)
          ? messageOptions.imageUrls.filter(Boolean)
          : [];
      const imagePrompt =
        safeRole === "assistant"
          ? String(messageOptions.imagePrompt || messageOptions.prompt || "").trim()
          : "";
      const imageMessage =
        safeRole === "assistant"
          ? String(messageOptions.imageMessage || messageOptions.message || "").trim()
          : "";
      const messageType =
        safeRole === "assistant"
          ? String(messageOptions.type || messageOptions.messageType || "").trim()
          : "";

      if (!safeContent && !imagePath && !imageUrl) {
        return;
      }

      session.messages.push({
        role: safeRole,
        content: safeContent,
        imagePath,
        files,
        type: messageType,
        imageUrl,
        imageUrls,
        imagePrompt,
        imageMessage
      });

      if (safeRole === "user" && !session.renamed && (!session.title || session.title === "New chat")) {
        session.title = options.sessionStore.createTitleFromMessage(safeContent || "New chat");
      }

      session.updatedAt = Date.now();
      updateConversationFromActiveSession();
      renderConversationList();
      saveSessions();
    }

    function addMessageAndPersist(role, text, messageOptions = {}) {
      if (role === "assistant") {
        options.messageRenderer.renderAssistantMessage(text, {
          files: messageOptions.files,
          image: messageOptions.image
        });
      } else {
        options.messageRenderer.renderUserMessage(text, messageOptions);
      }

      appendMessageToActiveSession(role, text, messageOptions);
    }

    function hydrateChatSessions() {
      const stored = options.sessionStore.loadState();
      chatSessions = stored.sessions;

      if (chatSessions.length === 0) {
        const fresh = options.sessionStore.createDefaultSession();
        chatSessions = [fresh];
        activeChatId = fresh.id;
        saveSessions();
      } else {
        const requestedActive = stored.activeChatId;
        activeChatId =
          (requestedActive && getSessionById(requestedActive)?.id) ||
          [...chatSessions].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ||
          chatSessions[0].id;
      }

      switchChat(activeChatId);
    }

    async function migrateLegacySessions() {
      const didChange = await options.sessionStore.migrateLegacyImages(chatSessions, options.assistantAPI);
      if (didChange) {
        saveSessions();
        const activeSession = getActiveSession();
        if (activeSession) {
          options.messageRenderer.renderSessionMessages(activeSession.messages);
        }
      }
    }

    async function hydrateCurrentApp() {
      try {
        const appName = await options.assistantAPI.getCurrentApp();
        setDetectedApp(appName);
      } catch (_error) {
        setDetectedApp("Unknown application");
      }
    }

    function applyExpandButtonState(expanded) {
      if (!refs.expandButton) {
        return;
      }

      refs.expandButton.textContent = expanded ? "Collapse" : "Expand";
      refs.expandButton.dataset.expanded = expanded ? "true" : "false";
    }

    async function hydrateExpandState() {
      if (!refs.expandButton) {
        return;
      }

      try {
        const state = await options.assistantAPI.getExpandState();
        applyExpandButtonState(Boolean(state && state.expanded));
      } catch (_error) {
        applyExpandButtonState(false);
      }
    }

    async function handleExpandToggle() {
      if (!refs.expandButton) {
        return;
      }

      try {
        const state = await options.assistantAPI.toggleExpand();
        const expanded = Boolean(state && state.expanded);
        applyExpandButtonState(expanded);
        setStatus(expanded ? "Expanded layout enabled." : "Compact layout enabled.");
      } catch (error) {
        console.error("Expand toggle failed:", error);
        setStatus("Unable to resize window.");
      }
    }

    function buildUserContextContent(userPrompt, hasImage) {
      const text = String(userPrompt || "").trim();
      if (text) {
        return text;
      }

      return hasImage ? "[Screenshot attached]" : "";
    }

    function updateLastUserMessageImagePath(nextPath) {
      const session = getActiveSession();
      if (!session || !nextPath) {
        return;
      }

      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        const message = session.messages[index];
        if (message && message.role === "user" && message.imagePath) {
          message.imagePath = nextPath;
          break;
        }
      }

      saveSessions();
    }

    function getMemoryContext() {
      const session = getActiveSession();
      if (session && Array.isArray(session.recentMessages)) {
        return session.recentMessages.slice(-8);
      }
      return conversation.slice(-5);
    }

    function getMemorySummary() {
      const session = getActiveSession();
      return session && typeof session.summarizedMemory === "string"
        ? session.summarizedMemory
        : "";
    }

    function handleNewChat() {
      if (isBusy) {
        return;
      }

      const newSession = options.sessionStore.createDefaultSession();
      chatSessions.push(newSession);
      if (chatSessions.length > constants.CHAT_STORAGE_MAX) {
        chatSessions = [...chatSessions]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, constants.CHAT_STORAGE_MAX);
      }

      switchChat(newSession.id, { focusInput: true });
      options.sidebar.closeSidebar();
    }

    function restoreInputInteraction() {
      if (!refs.promptInput) {
        return;
      }

      refs.promptInput.disabled = false;
      if (refs.sendButton) {
        refs.sendButton.disabled = false;
      }
      if (refs.screenshotButton) {
        refs.screenshotButton.disabled = false;
      }
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.disabled = false;
      }

      try {
        if (typeof window !== "undefined" && typeof window.focus === "function") {
          window.focus();
        }
      } catch (_error) {}

      window.setTimeout(() => {
        if (refs.promptInput) {
          refs.promptInput.focus();
        }
      }, 0);
    }

    function finalizeSidebarChatAction() {
      // Defensive reset in case a transient overlay or stale busy state blocks the composer.
      isBusy = false;
      setBusyState(false);
      setTypingIndicator(false);

      if (options.sidebar && typeof options.sidebar.closeAllMenus === "function") {
        options.sidebar.closeAllMenus();
      }
      options.sidebar.closeSidebar();
      if (refs.assistantShell) {
        refs.assistantShell.classList.remove("sidebar-open");
      }
      restoreInputInteraction();
    }

    function renameChatSession(sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      const nextTitle = window.prompt("Rename chat", session.title || "New chat");
      if (nextTitle === null) {
        return;
      }

      const cleaned = options.sessionStore.createTitleFromMessage(nextTitle);
      session.title = cleaned || "New chat";
      session.renamed = true;
      session.updatedAt = Date.now();
      renderConversationList();
      saveSessions();
    }

    function deleteChatSession(sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      const shouldDelete = window.confirm(`Delete "${session.title || "New chat"}"?`);
      if (!shouldDelete) {
        return;
      }

      chatSessions = chatSessions.filter((item) => item.id !== session.id);

      if (chatSessions.length === 0) {
        const fresh = options.sessionStore.createDefaultSession();
        chatSessions = [fresh];
        switchChat(fresh.id, { focusInput: true });
        return;
      }

      const nextActive = [...chatSessions].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      switchChat(nextActive.id, { focusInput: true });
    }

    function handleConversationListClick(event) {
      if (isBusy || !refs.conversationList) {
        return;
      }

      const actionTarget = event.target.closest("[data-action]");
      if (actionTarget && refs.conversationList.contains(actionTarget)) {
        const action = String(actionTarget.dataset.action || "");
        const chatId = String(actionTarget.dataset.chatId || "");
        if (!chatId) {
          return;
        }

        if (action === "select") {
          switchChat(chatId, { focusInput: true });
          finalizeSidebarChatAction();
          return;
        }

        if (action === "rename") {
          event.stopPropagation();
          renameChatSession(chatId);
          finalizeSidebarChatAction();
          return;
        }

        if (action === "delete") {
          event.stopPropagation();
          deleteChatSession(chatId);
          finalizeSidebarChatAction();
        }
      }
    }

    async function handleChatSubmit(event) {
      event.preventDefault();

      if (isBusy) {
        return;
      }

      options.sidebar.closeSidebar();

      const userPrompt = String((refs.promptInput && refs.promptInput.value) || "").trim();
      let screenshotBase64 = options.attachments.getPendingScreenshotBase64();
      const attachmentSource =
        (options.attachments && typeof options.attachments.getPendingAttachmentSource === "function"
          ? String(options.attachments.getPendingAttachmentSource() || "").trim().toLowerCase()
          : "") || "";
      const isFileAttachment = attachmentSource === "file";

      if (!userPrompt && !screenshotBase64) {
        return;
      }

      setBusyState(true);
      let imagePlaceholder = null;
      let responseReceived = false;
      let placeholderInserted = false;

      try {
        const userContentForContext = buildUserContextContent(userPrompt, Boolean(screenshotBase64));
        const previewImagePath = screenshotBase64 ? `data:image/png;base64,${screenshotBase64}` : "";

        addMessageAndPersist("user", userContentForContext, {
          imagePath: previewImagePath
        });

        if (screenshotBase64) {
          options.attachments
            .persistAttachment("chat")
            .then((storedAttachment) => {
              const persistedImagePath = String(
                (storedAttachment && storedAttachment.imagePath) || ""
              ).trim();
              if (persistedImagePath) {
                updateLastUserMessageImagePath(persistedImagePath);
              }
            })
            .catch((error) => {
              console.warn("Screenshot persistence failed, using base64 preview.", error);
            });
        }

        options.attachments.clearPendingAttachment({ silent: true });

        if (refs.promptInput) {
          refs.promptInput.value = "";
        }
        autoResizeInput();

        let promptForRequest = userPrompt;
        if (screenshotBase64) {
          if (isFileAttachment) {
            promptForRequest = userPrompt;
          } else {
            const extractedText = await options.screenshotOCR.extractOcrText(screenshotBase64);
            promptForRequest = options.screenshotOCR.buildPromptWithOcr(userPrompt, extractedText);
          }
        }

        let shouldShowTypingIndicator = true;

        function isLikelyImageGenerationRequest(promptText) {
          const text = String(promptText || "").toLowerCase();
          if (!text) {
            return false;
          }

          const patterns = [
            /\bimage\b/,
            /\bimages\b/,
            /\bphoto\b/,
            /\bpicture\b/,
            /\bpic\b/,
            /\billustration\b/,
            /\bwallpaper\b/,
            /\bposter\b/,
            /\blogo\b/,
            /\bsketch\b/,
            /\bdraw\b/,
            /\brender\b/,
            /\bgenerate\s+(an\s+)?image\b/,
            /\bcreate\s+(an\s+)?image\b/,
            /\bmake\s+(an\s+)?image\b/,
            /\bimage\s+bana(o|do|na)\b/,
            /\bphoto\s+bana(o|do|na)\b/
          ];

          return patterns.some((pattern) => pattern.test(text));
        }

        function isLikelyImageEditRequest(promptText) {
          const text = String(promptText || "").toLowerCase();
          if (!text) {
            return false;
          }

          const editVerbPatterns = [
            /\badd\b/,
            /\bremove\b/,
            /\breplace\b/,
            /\bedit\b/,
            /\benhance\b/,
            /\bupscale\b/,
            /\bretouch\b/,
            /\bmerge\b/,
            /\bcombine\b/,
            /\bmake\s+it\b/,
            /\badd\s+kar\b/,
            /\bkar\s+do\b/,
            /\bhata\s+do\b/,
            /\b4k\b/,
            /\bhd\b/
          ];

          const analysisPatterns = [
            /\bwhat\b/,
            /\bwhy\b/,
            /\bexplain\b/,
            /\banalyze\b/,
            /\banalysis\b/,
            /\bkya\b/,
            /\bkaise\b/
          ];

          const hasEditSignal = editVerbPatterns.some((pattern) => pattern.test(text));
          const hasAnalysisSignal = analysisPatterns.some((pattern) => pattern.test(text));
          return hasEditSignal && !hasAnalysisSignal;
        }

        const shouldForceImageGeneration =
          Boolean(screenshotBase64) &&
          isFileAttachment &&
          isLikelyImageEditRequest(userPrompt);

        if (shouldForceImageGeneration) {
          imagePlaceholder = options.messageRenderer.renderImagePlaceholder("Generating image...");
          placeholderInserted = true;
          shouldShowTypingIndicator = false;
          setStatus("Generating image...", { busy: true });
        } else if (options.assistantAPI && typeof options.assistantAPI.classifyInputType === "function") {
          try {
            const result = await options.assistantAPI.classifyInputType({ userPrompt });
            const type = String((result && result.type) || "").trim().toLowerCase();
            const confidence = Number(result && result.confidence);
            if (
              type === "creative_prompt" &&
              Number.isFinite(confidence) &&
              confidence >= 0.6 &&
              isLikelyImageGenerationRequest(userPrompt)
            ) {
              imagePlaceholder = options.messageRenderer.renderImagePlaceholder("Generating image...");
              placeholderInserted = true;
              shouldShowTypingIndicator = false;
              setStatus("Generating image...", { busy: true });
            }
          } catch (_error) {}
        }

        if (shouldShowTypingIndicator) {
          setTypingIndicator(true);
          setStatus(
            screenshotBase64
              ? isFileAttachment
                ? "AI is analyzing your image..."
                : "AI is analyzing your screen..."
              : "AI is thinking...",
            { busy: true }
          );
        } else {
          setTypingIndicator(false);
        }

        const allowExternalForRequest = isFileAttachment ? true : isExternalScreenAllowed();

        // Persist last URL per chat so follow-up questions can reuse it.
        try {
          const session = getActiveSession();
          if (session) {
            const pastedUrl = extractFirstUrlFromText(promptForRequest);
            if (pastedUrl) {
              session.lastUrl = pastedUrl;
              // Pin the URL as context for the next few user messages.
              // This prevents the bot from "forgetting" the page between follow-ups.
              const wantsDeepUrlWork = /\b(explor(?:e)?|analy[sz]e|summari[sz]e|read|review|explain|modules?|syllabus|curriculum)\b/i.test(
                String(promptForRequest || "")
              );
              session.lastUrlTurnsRemaining = wantsDeepUrlWork ? 10 : 6;
            }
          }
        } catch (_error) {}

        const activeSession = getActiveSession();
        const lastUrlContext =
          activeSession &&
          activeSession.lastUrl &&
          !extractFirstUrlFromText(promptForRequest) &&
          shouldAttachLastUrlContext(promptForRequest, activeSession)
            ? String(activeSession.lastUrl)
            : "";

        if (lastUrlContext && activeSession && Number(activeSession.lastUrlTurnsRemaining) > 0) {
          activeSession.lastUrlTurnsRemaining = Number(activeSession.lastUrlTurnsRemaining) - 1;
        }

        const response = await options.assistantAPI.sendPrompt({
          userPrompt: promptForRequest,
          screenshotBase64,
          contextMessages: getMemoryContext(),
          memorySummary: getMemorySummary(),
          urlContext: lastUrlContext,
          rawPrompt: Boolean(screenshotBase64 && !isFileAttachment),
          allowExternalScreenshot: allowExternalForRequest,
          forceImageGeneration: shouldForceImageGeneration,
          attachmentSource
        });
        responseReceived = true;
        if (imagePlaceholder) {
          imagePlaceholder.remove();
        }

        if (response && response.type === "image_prompt") {
          const promptText = String((response && response.prompt) || userPrompt || "").trim();
          const infoMessage = String((response && response.message) || "🎨 Image prompt detected").trim();

          options.messageRenderer.renderImagePromptAction({
            message: infoMessage,
            prompt: promptText,
            onGenerate: async (selectedPrompt) => {
              const nextPrompt = String(selectedPrompt || "").trim();
              if (!nextPrompt || isBusy) {
                return;
              }

              setBusyState(true);
              setTypingIndicator(true, "Generating image...");
              setStatus("Generating image...", { busy: true });

              try {
                const generated = await options.assistantAPI.sendPrompt({
                  userPrompt: nextPrompt,
                  forceImageGeneration: true,
                  contextMessages: getMemoryContext(),
                  memorySummary: getMemorySummary(),
                  rawPrompt: false
                });

                const generatedText =
                  String((generated && generated.response) || (generated && generated.message) || "").trim() ||
                  "Here is your generated image";
                const files = Array.isArray(generated && generated.files) ? generated.files : [];
                const generatedImagePayload = generated && generated.type === "image"
                  ? {
                      imageUrl: String(generated.imageUrl || "").trim(),
                      imageUrls: Array.isArray(generated.imageUrls) ? generated.imageUrls : [],
                      images: Array.isArray(generated.images) ? generated.images : [],
                      prompt: String(generated.prompt || nextPrompt || "").trim(),
                      message: String(generated.message || generatedText).trim()
                    }
                  : null;

                await options.messageRenderer.renderAssistantStream(generatedText, {
                  files,
                  image: generatedImagePayload
                });
                appendMessageToActiveSession("assistant", generatedText, {
                  files,
                  type: generated && generated.type ? String(generated.type) : "",
                  imageUrl: generatedImagePayload && generatedImagePayload.imageUrl,
                  imageUrls:
                    generatedImagePayload && Array.isArray(generatedImagePayload.imageUrls)
                      ? generatedImagePayload.imageUrls
                      : [],
                  imagePrompt: generatedImagePayload && generatedImagePayload.prompt,
                  imageMessage: generatedImagePayload && generatedImagePayload.message
                });
                setStatus("Ready");
              } catch (generateError) {
                const errMessage = String(
                  generateError && generateError.message ? generateError.message : "Image generation failed."
                );
                addMessageAndPersist("assistant", `Error: ${errMessage}`);
                setStatus("Image generation failed.");
              } finally {
                setTypingIndicator(false);
                setBusyState(false);
              }
            }
          });

          appendMessageToActiveSession("assistant", infoMessage, {
            type: "image_prompt",
            imagePrompt: promptText,
            imageMessage: infoMessage
          });

          setStatus("🎨 Image prompt detected. Click Generate Image.");
          return;
        }

        if (response && response.type === "hybrid") {
          const explanationText =
            String((response && response.explanation) || (response && response.response) || "").trim() ||
            "I generated an explanation and image for your request.";
          const hybridImagePayload = {
            imageUrl: String((response && response.imageUrl) || "").trim(),
            imageUrls: Array.isArray(response && response.imageUrls) ? response.imageUrls : [],
            images: Array.isArray(response && response.images) ? response.images : [],
            prompt: String((response && response.prompt) || userPrompt || "").trim(),
            message: String((response && response.message) || "Explanation + image generated").trim()
          };

          await options.messageRenderer.renderAssistantStream(explanationText, {
            image: hybridImagePayload
          });

          appendMessageToActiveSession("assistant", explanationText, {
            type: "hybrid",
            explanation: explanationText,
            imageUrl: hybridImagePayload.imageUrl,
            imageUrls: hybridImagePayload.imageUrls,
            imagePrompt: hybridImagePayload.prompt,
            imageMessage: hybridImagePayload.message
          });

          if (options.voiceManager && typeof options.voiceManager.speak === "function") {
            options.voiceManager.speak(explanationText);
          }

          const usedModel = response && response.usedModel ? String(response.usedModel) : "";
          const resolved = resolveModeFromModel(usedModel);
          setModelStatus(resolved.mode, resolved.detail);
          const modelUsed = usedModel ? ` (${usedModel})` : "";
          setStatus(`Ready${modelUsed}`);
          return;
        }

        const assistantText = String((response && response.response) || "").trim() || "No response from the model.";
        const files = Array.isArray(response && response.files) ? response.files : [];
        const imagePayload = response && response.type === "image"
          ? {
              imageUrl: String(response.imageUrl || "").trim(),
              imageUrls: Array.isArray(response.imageUrls) ? response.imageUrls : [],
              images: Array.isArray(response.images) ? response.images : [],
              prompt: String(response.prompt || "").trim(),
              message: String(response.message || "").trim()
            }
          : null;
        await options.messageRenderer.renderAssistantStream(assistantText, {
          files,
          image: imagePayload
        });
        appendMessageToActiveSession("assistant", assistantText, {
          files,
          type: response && response.type ? String(response.type) : "",
          imageUrl: imagePayload && imagePayload.imageUrl,
          imageUrls: imagePayload && Array.isArray(imagePayload.imageUrls) ? imagePayload.imageUrls : [],
          imagePrompt: imagePayload && imagePayload.prompt,
          imageMessage: imagePayload && imagePayload.message
        });
        if (options.voiceManager && typeof options.voiceManager.speak === "function") {
          options.voiceManager.speak(assistantText);
        }

        const usedModel = response && response.usedModel ? String(response.usedModel) : "";
        const provider = response && response.provider ? String(response.provider) : "";
        const openAIEnabled = Boolean(response && response.openAIEnabled);
        if (provider === "unconfigured") {
          setModelStatus("Offline", "");
          setStatus("AI unavailable. Please contact support.");
          return;
        }
        const resolved = resolveModeFromModel(usedModel);
        setModelStatus(resolved.mode, resolved.detail);
        const modelUsed = usedModel ? ` (${usedModel})` : "";
        setStatus(`Ready${modelUsed}`);
      } catch (error) {
        console.error("Send failed:", error);
        if (imagePlaceholder) {
          imagePlaceholder.remove();
        }
        const message = String(error && error.message ? error.message : "Request failed.");
        addMessageAndPersist("assistant", `Error: ${message}`);
        setModelStatus("Offline", "");

        if (message.includes("No AI API configured") || message.includes("Missing OPENAI_API_KEY")) {
          setStatus("AI unavailable. Please contact support.");
        } else if (message.includes("External AI off")) {
          setStatus("External AI is off. Enable External AI to use screenshots.");
        } else {
          setStatus("Request failed.");
        }
      } finally {
        setTypingIndicator(false);
        setBusyState(false);
      }
    }

    async function runOpeningAnalysis() {
      if (openingAnalysisRunning || isBusy) {
        return;
      }

      openingAnalysisRunning = true;
      setBusyState(true);

      try {
        setStatus("Capturing current screen...", { busy: true });

        const screenshotBase64 = await options.attachments.captureScreenshot();
        const extractedText = await options.screenshotOCR.extractOcrText(screenshotBase64);
        const openingPrompt = options.screenshotOCR.buildPromptWithOcr("", extractedText, {
          openingAnalysis: true
        });

        setTypingIndicator(true);
        setStatus("Analyzing active app context...", { busy: true });

        const response = await options.assistantAPI.sendPrompt({
          userPrompt: openingPrompt,
          screenshotBase64,
          contextMessages: getMemoryContext(),
          memorySummary: getMemorySummary(),
          rawPrompt: true
        });

        const assistantText =
          String((response && response.response) || "").trim() || "I could not analyze the current screen.";
        const files = Array.isArray(response && response.files) ? response.files : [];
        await options.messageRenderer.renderAssistantStream(assistantText, { files });
        appendMessageToActiveSession("assistant", assistantText, { files });
        if (options.voiceManager && typeof options.voiceManager.speak === "function") {
          options.voiceManager.speak(assistantText);
        }

        const usedModel = response && response.usedModel ? String(response.usedModel) : "";
        const provider = response && response.provider ? String(response.provider) : "";
        const openAIEnabled = Boolean(response && response.openAIEnabled);
        if (provider === "unconfigured") {
          setModelStatus("Offline", "");
          setStatus("AI unavailable. Please contact support.");
          return;
        }
        const resolved = resolveModeFromModel(usedModel);
        setModelStatus(resolved.mode, resolved.detail);
        const modelUsed = usedModel ? ` (${usedModel})` : "";
        setStatus(`Ready${modelUsed}`);
      } catch (error) {
        console.error("Opening analysis failed:", error);
        addMessageAndPersist("assistant", `Screen analysis failed: ${error.message}`);
        setModelStatus("Offline", "");
        setStatus("Screen analysis failed.");
      } finally {
        setTypingIndicator(false);
        setBusyState(false);
        openingAnalysisRunning = false;
      }
    }

    function handlePromptKeydown(event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        refs.chatForm.requestSubmit();
      }
    }

    async function init() {
      options.messageRenderer.init();
      options.attachments.init();
      setTypingIndicator(false);
      setStatus("Ready");
      setModelStatus("Offline", "");
      hydrateChatSessions();

      const storedConsent = loadExternalScreenConsent();
      applyExternalScreenConsent(storedConsent);
      await migrateLegacySessions();
      await hydrateCurrentApp();
      await hydrateExpandState();

      if (refs.chatForm) {
        refs.chatForm.addEventListener("submit", handleChatSubmit);
      }
      if (refs.promptInput) {
        refs.promptInput.addEventListener("input", autoResizeInput);
        refs.promptInput.addEventListener("keydown", handlePromptKeydown);
      }
      if (refs.externalScreenToggle) {
        refs.externalScreenToggle.addEventListener("change", () => {
          const allowed = isExternalScreenAllowed();
          saveExternalScreenConsent(allowed);
          applyExternalScreenConsent(allowed);
          setStatus(allowed ? "External screen sharing enabled." : "External screen sharing disabled.");
        });
      }
      if (refs.screenshotButton) {
        refs.screenshotButton.addEventListener("click", async () => {
          try {
            await options.attachments.handleManualScreenshotAttach();
          } catch (error) {
            addMessageAndPersist("assistant", `Screenshot capture failed: ${error.message}`);
          }
        });
      }
      if (refs.expandButton) {
        refs.expandButton.addEventListener("click", handleExpandToggle);
      }
      if (refs.newChatButton) {
        refs.newChatButton.addEventListener("click", handleNewChat);
      }
      if (refs.conversationList) {
        refs.conversationList.addEventListener("click", handleConversationListClick);
      }
      if (refs.chatSearchInput) {
        refs.chatSearchInput.addEventListener("input", handleChatSearchInput);
      }

      initVoiceInput();

      options.assistantAPI.onActiveApp((appName) => {
        setDetectedApp(appName);
      });
      options.assistantAPI.onOpeningAnalysis(() => {
        runOpeningAnalysis().catch((error) => {
          addMessageAndPersist("assistant", `Screen analysis failed: ${error.message}`);
          setStatus("Screen analysis failed.");
        });
      });
    }

    return {
      autoResizeInput,
      getBusy: () => isBusy,
      init,
      setStatus
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.chatManager = {
    createChatManager
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
