(function (root) {
  function createVoiceModeManager(options = {}) {
    const refs = options.refs || {};
    const assistantAPI = options.assistantAPI;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecorder = Boolean(
      navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof window.MediaRecorder === "function"
    );

    let recognition = null;
    let voiceEnabled = false;
    let listening = false;
    let lastTranscript = "";
    let restartTimer = null;
    let sendTimer = null;
    let silenceTimer = null;
    let activeAudio = null;
    let pausedForSpeak = false;
    let recorderMode = false;
    let recording = false;
    let voiceBusy = false;
    let voiceHistory = [];
    let mediaRecorder = null;
    let mediaStream = null;
    let recordedChunks = [];
    let recordStopTimer = null;
    let audioContext = null;
    let analyser = null;
    let analyserData = null;
    let silenceRaf = null;
    let recordStartedAt = 0;
    let lastVoiceAt = 0;
    let hadVoice = false;
    const SEND_AFTER_MS = 900;
    const SILENCE_TIMEOUT_MS = 6000;
    const MAX_RECORD_MS = 12000;
    const VOICE_CONTEXT_MAX = 8;
    const SHOW_TRANSCRIPT_IN_INPUT = false;
    const RECORD_SILENCE_MS = 900;
    const MIN_RECORD_MS = 700;
    const SILENCE_RMS_THRESHOLD = 0.015;
    const NO_SPEECH_MAX_MS = 6000;

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
        return false;
      }

      try {
        return localStorage.getItem("assistant.voiceEnabled") === "true";
      } catch (_error) {
        return false;
      }
    }

    function updateStatusChip(state, label) {
      if (!refs.voiceStatus) {
        return;
      }

      refs.voiceStatus.textContent = label;
      refs.voiceStatus.dataset.state = state;
    }

    function updateButtonState() {}

    function syncUiState() {
      if (!SpeechRecognition && !supportsRecorder) {
        updateStatusChip("unsupported", "Voice: Unavailable");
        updateButtonState();
        return;
      }

      if (!voiceEnabled) {
        updateStatusChip("off", "Voice: Off");
        updateButtonState();
        return;
      }

      if (pausedForSpeak) {
        updateStatusChip("speaking", "Speaking...");
      } else if (recording) {
        updateStatusChip("recording", "Recording...");
      } else if (listening) {
        updateStatusChip("listening", "Listening...");
      } else {
        updateStatusChip("on", "Voice: On");
      }

      updateButtonState();
    }

    function updatePromptInput(value) {
      if (!refs.promptInput) {
        return;
      }

      if (!SHOW_TRANSCRIPT_IN_INPUT) {
        return;
      }

      refs.promptInput.value = String(value || "");
      refs.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function addVoiceMessage(role, content) {
      const safeRole = role === "assistant" ? "assistant" : "user";
      const safeContent = String(content || "").trim();
      if (!safeContent) {
        return;
      }
      voiceHistory.push({ role: safeRole, content: safeContent });
      if (voiceHistory.length > VOICE_CONTEXT_MAX) {
        voiceHistory = voiceHistory.slice(-VOICE_CONTEXT_MAX);
      }
    }

    function getVoiceContext() {
      return voiceHistory.slice(-VOICE_CONTEXT_MAX);
    }

    async function sendVoicePrompt(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed) {
        return;
      }

      if (voiceBusy) {
        return;
      }

      if (!assistantAPI || typeof assistantAPI.sendPrompt !== "function") {
        setStatus("Voice service unavailable.");
        return;
      }

      voiceBusy = true;
      stopListening();
      stopRecording();
      setStatus("Sending voice message...");

      try {
        const response = await assistantAPI.sendPrompt({
          userPrompt: trimmed,
          contextMessages: getVoiceContext(),
          memorySummary: "",
          rawPrompt: false
        });

        const assistantText =
          String((response && response.response) || "").trim() || "No response from the model.";
        addVoiceMessage("user", trimmed);
        addVoiceMessage("assistant", assistantText);
        setStatus("Voice reply ready.");
        await speak(assistantText);
      } catch (error) {
        const message = String(error && error.message ? error.message : "Voice request failed.");
        setStatus(message);
      } finally {
        voiceBusy = false;
        if (voiceEnabled && !pausedForSpeak) {
          if (recorderMode) {
            startRecording();
          } else {
            scheduleRestart();
          }
        }
      }
    }

    function sendTranscript(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed) {
        return;
      }

      if (typeof options.getBusy === "function" && options.getBusy()) {
        return;
      }

      if (refs.promptInput && refs.promptInput.disabled) {
        return;
      }

      sendVoicePrompt(trimmed);
    }

    function scheduleRestart() {
      if (!voiceEnabled || pausedForSpeak || recorderMode || voiceBusy) {
        return;
      }

      if (restartTimer) {
        clearTimeout(restartTimer);
      }

      restartTimer = setTimeout(() => {
        restartTimer = null;
        startListening();
      }, 450);
    }

    function clearTimers() {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = null;
      }
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    }

    function scheduleSend() {
      if (!voiceEnabled || pausedForSpeak) {
        return;
      }

      if (sendTimer) {
        clearTimeout(sendTimer);
      }

      sendTimer = setTimeout(() => {
        sendTimer = null;
        const toSend = String(lastTranscript || "").trim();
        if (!toSend) {
          return;
        }
        lastTranscript = "";
        stopListening();
        setStatus("Sending voice message...");
        sendTranscript(toSend);
      }, SEND_AFTER_MS);
    }

    function startSilenceTimer() {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
      }

      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (!listening || pausedForSpeak) {
          return;
        }
        if (!String(lastTranscript || "").trim()) {
          stopListening();
          setStatus("No voice detected. Try speaking closer to the mic.");
          scheduleRestart();
        }
      }, SILENCE_TIMEOUT_MS);
    }

    function ensureRecognition() {
      if (!SpeechRecognition || recognition) {
        return;
      }

      recognition = new SpeechRecognition();
      recognition.lang = navigator.language || "en-US";
      recognition.interimResults = true;
      recognition.continuous = false;

      recognition.onstart = () => {
        listening = true;
        syncUiState();
        startSilenceTimer();
      };

      recognition.onresult = (event) => {
        let interim = "";
        let finalText = "";

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result && result[0] ? String(result[0].transcript || "") : "";
          if (result && result.isFinal) {
            finalText += transcript;
          } else {
            interim += transcript;
          }
        }

        const combined = String(finalText || interim || "").trim();
        if (combined) {
          lastTranscript = combined;
          updatePromptInput(combined);
          scheduleSend();
          setStatus(`Heard: ${combined.slice(0, 80)}`);
        }
        startSilenceTimer();
      };

      recognition.onend = () => {
        listening = false;
        syncUiState();

        if (!voiceEnabled || pausedForSpeak) {
          return;
        }

        scheduleRestart();
      };

      recognition.onerror = (event) => {
        listening = false;
        syncUiState();
        const errorCode = event && event.error ? String(event.error) : "unknown";
        if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
          setStatus("Microphone access denied.");
          voiceEnabled = false;
          saveVoiceModeState();
          syncUiState();
          return;
        }

        if (errorCode === "network" && supportsRecorder) {
          recorderMode = true;
          setStatus("Speech service blocked. Switching to recorder mode.");
          stopListening();
          if (voiceEnabled) {
            startRecording();
          }
          return;
        }

        setStatus(`Voice error: ${errorCode}`);
        scheduleRestart();
      };

      recognition.onspeechend = () => {
        startSilenceTimer();
      };
    }

    function startListening() {
      if (recorderMode) {
        return;
      }

      if (!SpeechRecognition) {
        setStatus("Voice input is not supported in this app.");
        voiceEnabled = false;
        saveVoiceModeState();
        syncUiState();
        return;
      }

      if (listening || pausedForSpeak) {
        return;
      }

      ensureRecognition();
      if (!recognition) {
        return;
      }

      try {
        lastTranscript = "";
        clearTimers();
        recognition.start();
        startSilenceTimer();
      } catch (_error) {
        scheduleRestart();
      }
    }

    function stopListening({ disable = false } = {}) {
      if (disable) {
        voiceEnabled = false;
        saveVoiceModeState();
      }

      clearTimers();

      if (recognition && listening) {
        try {
          recognition.stop();
        } catch (_error) {}
      }

      listening = false;
      syncUiState();
    }

    function stopAudio() {
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.src = "";
        activeAudio = null;
      }
    }

    function clearRecordTimer() {
      if (recordStopTimer) {
        clearTimeout(recordStopTimer);
        recordStopTimer = null;
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
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
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

    async function handleRecordingStop() {
      recording = false;
      syncUiState();

      if (!recordedChunks.length) {
        cleanupRecorder();
        return;
      }

      const blob = new Blob(recordedChunks, {
        type: mediaRecorder && mediaRecorder.mimeType ? mediaRecorder.mimeType : "audio/webm"
      });
      cleanupRecorder();

      if (!assistantAPI || typeof assistantAPI.transcribeSpeech !== "function") {
        setStatus("Speech-to-text is unavailable.");
        return;
      }

      try {
        setStatus("Transcribing voice...");
        const audioBase64 = await blobToBase64(blob);
        const result = await assistantAPI.transcribeSpeech({
          audioBase64,
          mimeType: blob.type || "audio/webm"
        });

        const text =
          String(result && result.text ? result.text : "").trim() ||
          (Array.isArray(result && result.transcripts)
            ? result.transcripts.map((item) => String(item.text || "").trim()).join(" ").trim()
            : "");

        if (!text) {
          setStatus("No speech detected in the recording.");
          return;
        }

        setStatus(`Heard: ${text.slice(0, 80)}`);
        sendTranscript(text);
      } catch (_error) {
        setStatus("Voice transcription failed.");
      }
    }

    async function startRecording() {
      if (!supportsRecorder || recording || pausedForSpeak) {
        return;
      }

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (_error) {
        setStatus("Microphone access blocked. Allow mic permission and try again.");
        return;
      }

      recordedChunks = [];
      const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
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
      };

      recording = true;
      syncUiState();
      setStatus("Recording...");
      mediaRecorder.start();
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

    async function speak(text) {
      if (!voiceEnabled || !assistantAPI || typeof assistantAPI.synthesizeSpeech !== "function") {
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
        const result = await assistantAPI.synthesizeSpeech({ text: trimmed });
        if (!result || !result.audioBase64) {
          pausedForSpeak = false;
          scheduleRestart();
          return;
        }

        const mime = String(result.contentType || "audio/mpeg");
        activeAudio = new Audio(`data:${mime};base64,${result.audioBase64}`);
        activeAudio.volume = 1;
        activeAudio.play().catch(() => {});
        activeAudio.onended = () => {
          pausedForSpeak = false;
          if (voiceEnabled) {
            if (recorderMode) {
              startRecording();
            } else {
              scheduleRestart();
            }
          }
        };
        activeAudio.onerror = () => {
          pausedForSpeak = false;
          if (voiceEnabled) {
            if (recorderMode) {
              startRecording();
            } else {
              scheduleRestart();
            }
          }
        };
      } catch (_error) {
        pausedForSpeak = false;
        setStatus("Voice playback failed.");
        if (voiceEnabled) {
          if (recorderMode) {
            startRecording();
          } else {
            scheduleRestart();
          }
        }
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

    async function toggleVoiceMode() {
      voiceEnabled = !voiceEnabled;
      saveVoiceModeState();
      if (voiceEnabled) {
        const micOk = await requestMicrophoneAccess();
        if (!micOk) {
          voiceEnabled = false;
          saveVoiceModeState();
          syncUiState();
          setStatus("Microphone access blocked. Allow mic permission and try again.");
          return;
        }
        if (!SpeechRecognition || recorderMode) {
          recorderMode = true;
          setStatus("Recorder mode enabled. Click Voice to stop.");
          startRecording();
        } else {
          startListening();
          setStatus("Voice mode enabled.");
        }
      } else {
        stopListening({ disable: true });
        stopRecording();
        stopAudio();
        setStatus("Voice mode disabled.");
      }
      syncUiState();
    }

    function init() {
      if (!SpeechRecognition && supportsRecorder) {
        recorderMode = true;
      }

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

        if (recorderMode) {
          startRecording();
        } else {
          startListening();
        }
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
