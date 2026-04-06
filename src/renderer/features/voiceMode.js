(function (root) {
  function createVoiceModeManager(options = {}) {
    const refs = options.refs || {};
    const assistantAPI = options.assistantAPI;
    const supportsRecorder = Boolean(
      navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof window.MediaRecorder === "function"
    );

    let voiceEnabled = false;
    let recording = false;
    let pausedForSpeak = false;
    let mediaRecorder = null;
    let mediaStream = null;
    let recordedChunks = [];
    let recordStopTimer = null;
    let recorderRestartTimer = null;
    let audioContext = null;
    let analyser = null;
    let analyserData = null;
    let silenceRaf = null;
    let recordStartedAt = 0;
    let lastVoiceAt = 0;
    let hadVoice = false;
    let lastCommittedTranscript = "";
    let lastCommitAt = 0;
    let activeAudio = null;
    let noSpeechAutoOffCount = 0;

    const MAX_RECORD_MS = 14000;
    const RECORD_SILENCE_MS = 3200;
    const MIN_RECORD_MS = 3000;
    const SILENCE_RMS_THRESHOLD = 0.008;
    const NO_SPEECH_MAX_MS = 9000;
    const MIN_AUDIO_BYTES = 5000;
    const VOICE_AUTO_OFF_AFTER_SILENT_TURNS = 1;

    function setStatus(text) {
      if (typeof options.setStatus === "function") {
        options.setStatus(text);
      }
    }

    function saveVoiceModeState() {
      if (typeof localStorage === "undefined") {
        return;
      }
      try {
        localStorage.setItem("assistant.voiceEnabled", voiceEnabled ? "true" : "false");
      } catch (_error) {}
    }

    function loadVoiceModeState() {
      if (typeof localStorage === "undefined") {
        return true;
      }
      try {
        const raw = localStorage.getItem("assistant.voiceEnabled");
        if (raw === null) {
          return true;
        }
        return raw !== "false";
      } catch (_error) {
        return true;
      }
    }

    function updateStatusChip(state, label) {
      if (refs.voiceToggleLabel) {
        refs.voiceToggleLabel.textContent = label.replace(/^Voice:\s*/i, "Voice Mode: ");
      }
      if (refs.voiceStatus) {
        refs.voiceStatus.textContent = label;
        refs.voiceStatus.dataset.state = state;
      }
      if (refs.voiceToggle) {
        refs.voiceToggle.checked = Boolean(voiceEnabled);
      }
    }

    function syncUiState() {
      if (!supportsRecorder) {
        updateStatusChip("unsupported", "Voice: Unavailable");
        return;
      }

      if (!voiceEnabled) {
        updateStatusChip("off", "Voice: Off");
        return;
      }

      if (pausedForSpeak) {
        updateStatusChip("speaking", "Speaking...");
        return;
      }

      if (recording) {
        updateStatusChip("recording", "Listening...");
        return;
      }

      updateStatusChip("on", "Voice: On");
    }

    function updatePromptInput(value) {
      if (!refs.promptInput) {
        return;
      }

      refs.promptInput.value = String(value || "");
      refs.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function updateLiveText(text) {
      if (!refs.voiceLivePreview) {
        return;
      }
      const content = String(text || "").trim();
      if (!content) {
        refs.voiceLivePreview.textContent = "";
        refs.voiceLivePreview.classList.add("hidden");
        return;
      }
      refs.voiceLivePreview.classList.remove("hidden");
      refs.voiceLivePreview.textContent = content;
    }

    function normalizeTranscript(rawText) {
      return String(rawText || "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function isLikelyGarbageTranscript(text) {
      const normalized = normalizeTranscript(text);
      if (!normalized) {
        return true;
      }

      if (/αñ|ΓÇ|Ã|â|█|�|┐|╢|╜|╕|╣|╛|╡/.test(normalized)) {
        return true;
      }

      const words = normalized
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter(Boolean);

      if (!words.length) {
        return true;
      }

      if (words.length >= 5) {
        const unique = new Set(words);
        if (unique.size <= 2) {
          return true;
        }
      }

      return false;
    }

    function getPreferredSttLanguage() {
      try {
        const saved = String(localStorage.getItem("assistant.voiceLanguage") || "").trim().toLowerCase();
        if (saved === "hi" || saved === "en") {
          return saved;
        }
      } catch (_error) {}
      return "";
    }

    function appendTranscriptToInput(text) {
      if (!refs.promptInput) {
        return false;
      }
      const incoming = normalizeTranscript(text);
      if (!incoming || incoming.length < 2) {
        return false;
      }

      const dedupeKey = incoming.toLowerCase();
      const now = Date.now();
      if (dedupeKey === lastCommittedTranscript && now - lastCommitAt < 1200) {
        return false;
      }
      lastCommittedTranscript = dedupeKey;
      lastCommitAt = now;

      const current = String(refs.promptInput.value || "").trim();
      const nextValue = current ? `${current} ${incoming}` : incoming;
      updatePromptInput(nextValue);
      if (refs.promptInput) {
        refs.promptInput.focus();
      }
      return true;
    }

    function clearRecordTimer() {
      if (recordStopTimer) {
        clearTimeout(recordStopTimer);
        recordStopTimer = null;
      }
    }

    function clearRecorderRestartTimer() {
      if (recorderRestartTimer) {
        clearTimeout(recorderRestartTimer);
        recorderRestartTimer = null;
      }
    }

    function stopSilenceDetection() {
      if (silenceRaf) {
        cancelAnimationFrame(silenceRaf);
        silenceRaf = null;
      }
      if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
      }
      analyser = null;
      analyserData = null;
      hadVoice = false;
      recordStartedAt = 0;
      lastVoiceAt = 0;
    }

    async function ensureMediaStream() {
      if (mediaStream) {
        return mediaStream;
      }
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true
        }
      });
      return mediaStream;
    }

    function releaseMediaStream() {
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    }

    function cleanupRecorder() {
      clearRecordTimer();
      stopSilenceDetection();
      recordedChunks = [];
      if (mediaRecorder) {
        mediaRecorder.ondataavailable = null;
        mediaRecorder.onstop = null;
        mediaRecorder.onerror = null;
        mediaRecorder = null;
      }
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = String(reader.result || "");
          const base64 = result.includes(",") ? result.split(",")[1] : result;
          resolve(base64);
        };
        reader.onerror = () => reject(new Error("Failed to read audio blob."));
        reader.readAsDataURL(blob);
      });
    }

    function scheduleRecorderRestart() {
      if (!voiceEnabled || pausedForSpeak || recording) {
        return;
      }
      clearRecorderRestartTimer();
      recorderRestartTimer = setTimeout(() => {
        recorderRestartTimer = null;
        if (voiceEnabled && !pausedForSpeak && !recording) {
          startRecording();
        }
      }, 120);
    }

    function disableVoiceModeWithStatus(message) {
      if (!voiceEnabled) {
        return;
      }
      voiceEnabled = false;
      saveVoiceModeState();
      stopListening();
      stopAudio();
      updateLiveText("");
      syncUiState();
      if (message) {
        setStatus(message);
      }
    }

    async function handleRecordingStop() {
      recording = false;
      syncUiState();
      const recordingMs = Date.now() - Number(recordStartedAt || Date.now());

      if (!recordedChunks.length) {
        cleanupRecorder();
        scheduleRecorderRestart();
        return;
      }

      const blob = new Blob(recordedChunks, {
        type: mediaRecorder && mediaRecorder.mimeType ? mediaRecorder.mimeType : "audio/webm"
      });

      console.log("Audio size:", blob.size);

      if (recordingMs < MIN_RECORD_MS) {
        cleanupRecorder();
        setStatus("Recording too short. Please speak for at least 3 seconds.");
        updateLiveText("");
        noSpeechAutoOffCount += 1;
        if (noSpeechAutoOffCount >= VOICE_AUTO_OFF_AFTER_SILENT_TURNS) {
          disableVoiceModeWithStatus("Voice mode auto-disabled after 5 seconds of silence.");
          return;
        }
        scheduleRecorderRestart();
        return;
      }

      if (blob.size < MIN_AUDIO_BYTES) {
        cleanupRecorder();
        setStatus("Audio too small. Please speak louder or check microphone.");
        updateLiveText("");
        noSpeechAutoOffCount += 1;
        if (noSpeechAutoOffCount >= VOICE_AUTO_OFF_AFTER_SILENT_TURNS) {
          disableVoiceModeWithStatus("Voice mode auto-disabled after 5 seconds of silence.");
          return;
        }
        scheduleRecorderRestart();
        return;
      }

      cleanupRecorder();

      if (!assistantAPI || typeof assistantAPI.transcribeSpeech !== "function") {
        setStatus("Speech-to-text is unavailable.");
        scheduleRecorderRestart();
        return;
      }

      try {
        // Auto-disable voice mode as soon as processing starts.
        disableVoiceModeWithStatus();
        updateLiveText("Processing...");
        setStatus("Processing voice...");

        const audioBase64 = await blobToBase64(blob);
        const result = await assistantAPI.transcribeSpeech({
          audioBase64,
          mimeType: blob.type || "audio/webm",
          filename: "voice.webm",
          languageCode: getPreferredSttLanguage()
        });

        const transcript = normalizeTranscript(result && result.text ? result.text : "");
        console.log("[voice][renderer] transcript:", transcript);
        if (!transcript || transcript.length < 2) {
          setStatus("No speech detected.");
          updateLiveText("");
          noSpeechAutoOffCount += 1;
          if (noSpeechAutoOffCount >= VOICE_AUTO_OFF_AFTER_SILENT_TURNS) {
            disableVoiceModeWithStatus("Voice mode auto-disabled after 5 seconds of silence.");
            return;
          }
          return;
        }

        if (isLikelyGarbageTranscript(transcript)) {
          setStatus("Unclear speech detected. Please repeat clearly.");
          updateLiveText("");
          noSpeechAutoOffCount += 1;
          if (noSpeechAutoOffCount >= VOICE_AUTO_OFF_AFTER_SILENT_TURNS) {
            disableVoiceModeWithStatus("Voice mode auto-disabled after unclear input.");
            return;
          }
          return;
        }

        noSpeechAutoOffCount = 0;
        const appended = appendTranscriptToInput(transcript);
        if (!appended && refs.promptInput && transcript) {
          // Final guard: force populate input when dedupe logic blocks a valid transcript.
          updatePromptInput(transcript);
        }
        setStatus(`Heard: ${transcript.slice(0, 80)}`);
      } catch (error) {
        const message = String(error && error.message ? error.message : "Voice transcription failed.");
        setStatus(message);
      } finally {
        updateLiveText("");
        scheduleRecorderRestart();
      }
    }

    async function startRecording() {
      if (!voiceEnabled || !supportsRecorder || recording || pausedForSpeak) {
        return;
      }

      try {
        await ensureMediaStream();
      } catch (_error) {
        setStatus("Microphone access blocked. Allow mic permission and try again.");
        return;
      }

      recordedChunks = [];
      const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      mediaRecorder = new MediaRecorder(mediaStream, preferredType ? { mimeType: preferredType } : undefined);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        handleRecordingStop();
      };

      mediaRecorder.onerror = () => {
        setStatus("Recording failed.");
        cleanupRecorder();
        recording = false;
        syncUiState();
        scheduleRecorderRestart();
      };

      recording = true;
      syncUiState();
      setStatus("Listening...");
      updateLiveText("Listening...");
      mediaRecorder.start(300);

      clearRecordTimer();
      recordStopTimer = setTimeout(() => {
        stopRecording();
      }, MAX_RECORD_MS);

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          audioContext = new AudioCtx();
          const source = audioContext.createMediaStreamSource(mediaStream);
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 2048;
          analyserData = new Uint8Array(analyser.fftSize);
          source.connect(analyser);
          recordStartedAt = Date.now();
          lastVoiceAt = recordStartedAt;
          hadVoice = false;

          const tick = () => {
            if (!recording || !analyser || !analyserData) {
              return;
            }

            analyser.getByteTimeDomainData(analyserData);
            let sum = 0;
            for (let i = 0; i < analyserData.length; i += 1) {
              const value = (analyserData[i] - 128) / 128;
              sum += value * value;
            }
            const rms = Math.sqrt(sum / analyserData.length);
            const now = Date.now();

            if (rms > SILENCE_RMS_THRESHOLD) {
              hadVoice = true;
              lastVoiceAt = now;
            }

            if (hadVoice && now - lastVoiceAt > RECORD_SILENCE_MS && now - recordStartedAt > MIN_RECORD_MS) {
              stopRecording();
              return;
            }

            if (!hadVoice && now - recordStartedAt > NO_SPEECH_MAX_MS) {
              stopRecording();
              setStatus("No speech detected. Try speaking closer to the mic.");
              return;
            }

            silenceRaf = requestAnimationFrame(tick);
          };

          silenceRaf = requestAnimationFrame(tick);
        }
      } catch (_error) {}
    }

    function stopRecording() {
      if (!mediaRecorder || !recording) {
        return;
      }

      clearRecordTimer();
      try {
        mediaRecorder.stop();
      } catch (_error) {
        cleanupRecorder();
        recording = false;
        syncUiState();
      }
    }

    function stopListening() {
      clearRecorderRestartTimer();
      stopRecording();
      releaseMediaStream();
    }

    function stopAudio() {
      try {
        const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
        if (synth) {
          synth.cancel();
        }
      } catch (_error) {}

      if (activeAudio) {
        activeAudio.pause();
        activeAudio.src = "";
        activeAudio = null;
      }
    }

    async function speak(text) {
      if (!voiceEnabled) {
        return;
      }

      const trimmed = String(text || "").trim();
      if (!trimmed) {
        return;
      }

      pausedForSpeak = true;
      stopListening();
      stopAudio();

      try {
        const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
        const UtteranceCtor = typeof window !== "undefined" ? window.SpeechSynthesisUtterance : null;
        if (!synth || !UtteranceCtor) {
          pausedForSpeak = false;
          scheduleRecorderRestart();
          return;
        }

        const utterance = new UtteranceCtor(trimmed);
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = 1;

        utterance.onend = () => {
          pausedForSpeak = false;
          scheduleRecorderRestart();
        };
        utterance.onerror = () => {
          pausedForSpeak = false;
          scheduleRecorderRestart();
        };

        synth.cancel();
        synth.speak(utterance);
      } catch (_error) {
        pausedForSpeak = false;
        setStatus("Voice playback failed.");
        scheduleRecorderRestart();
      }
    }

    async function requestMicrophoneAccess() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        return false;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        return true;
      } catch (_error) {
        return false;
      }
    }

    function shouldDisableForKey(event) {
      const key = String((event && event.key) || "");
      if (!key) {
        return false;
      }
      if (event && (event.ctrlKey || event.metaKey || event.altKey)) {
        return false;
      }
      if (key.length === 1) {
        return true;
      }
      return key === "Backspace" || key === "Delete" || key === "Enter";
    }

    function handlePromptTyping(event) {
      if (!voiceEnabled) {
        return;
      }
      if (!shouldDisableForKey(event)) {
        return;
      }
      disableVoiceModeWithStatus("Voice mode auto-disabled while typing.");
    }

    async function toggleVoiceMode() {
      voiceEnabled = !voiceEnabled;
      saveVoiceModeState();

      if (voiceEnabled) {
        noSpeechAutoOffCount = 0;
        const micOk = await requestMicrophoneAccess();
        if (!micOk) {
          voiceEnabled = false;
          saveVoiceModeState();
          syncUiState();
          setStatus("Microphone access blocked. Allow mic permission and try again.");
          return;
        }

        setStatus("Voice mode enabled.");
        startRecording();
      } else {
        stopListening();
        stopAudio();
        updateLiveText("");
        setStatus("Voice mode disabled.");
      }

      syncUiState();
    }

    function bindVoiceControls() {
      if (refs.voiceToggle) {
        refs.voiceToggle.addEventListener("change", () => {
          const shouldEnable = Boolean(refs.voiceToggle.checked);
          if (shouldEnable !== voiceEnabled) {
            toggleVoiceMode();
          } else {
            syncUiState();
          }
        });
      }

      if (refs.promptInput) {
        refs.promptInput.addEventListener("keydown", handlePromptTyping, true);
      }
    }

    function init() {
      bindVoiceControls();

      voiceEnabled = Boolean(loadVoiceModeState());
      if (!voiceEnabled) {
        syncUiState();
        return;
      }

      requestMicrophoneAccess().then((micOk) => {
        if (!micOk) {
          voiceEnabled = false;
          saveVoiceModeState();
          syncUiState();
          setStatus("Microphone access blocked. Allow mic permission and restart.");
          return;
        }
        startRecording();
      });

      syncUiState();
    }

    return {
      init,
      speak
    };
  }

  root.RendererModules = root.RendererModules || {};
  root.RendererModules.voiceMode = {
    createVoiceModeManager
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
