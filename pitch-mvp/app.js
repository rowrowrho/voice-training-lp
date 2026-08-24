/* ============================================================
   app.js（診断ログ入り版）
   RHO 音域診断 Phase1 - MVP
   ============================================================ */

(function () {
  "use strict";

  const PitchLib = window.PitchLib;
  const CONFIG = PitchLib.CONFIG;

  const el = {
    micButton: document.getElementById("micButton"),
    errorMsg: document.getElementById("errorMsg"),

    targetSelect: document.getElementById("targetSelect"),
    targetDisplay: document.getElementById("targetDisplay"),
    modeHighBtn: document.getElementById("modeHighBtn"),
    modeLowBtn: document.getElementById("modeLowBtn"),

    noteName: document.getElementById("noteName"),
    hzValue: document.getElementById("hzValue"),
    nearestCents: document.getElementById("nearestCents"),
    targetCents: document.getElementById("targetCents"),

    holdTimeValue: document.getElementById("holdTimeValue"),
    holdBarFill: document.getElementById("holdBarFill"),
    stateLabel: document.getElementById("stateLabel"),

    meterFill: document.getElementById("meterRangeFill"),
    meterDot: document.getElementById("meterDot"),

    debugRawF0: document.getElementById("debugRawF0"),
    debugSmoothedF0: document.getElementById("debugSmoothedF0"),
    debugRMS: document.getElementById("debugRMS"),
    debugTargetFreq: document.getElementById("debugTargetFreq"),
    debugTargetCents: document.getElementById("debugTargetCents"),
    debugConfidence: document.getElementById("debugConfidence"),
    debugMode: document.getElementById("debugMode"),
    debugState: document.getElementById("debugState"),
    debugHeldMs: document.getElementById("debugHeldMs"),
    debugSampleRate: document.getElementById("debugSampleRate"),
  };

  let audioContext = null;
  let analyser = null;
  let mediaStream = null;
  let timeDomainBuffer = null;
  let rafId = null;
  let isRunning = false;

  const tracker = new PitchLib.PitchTracker();

  const targetList = PitchLib.generateTargetNoteList();
  const DEFAULT_TARGET_LABEL = "A3";
  targetList.forEach((note) => {
    const opt = document.createElement("option");
    opt.value = String(note.midi);
    opt.textContent = note.label;
    if (note.label === DEFAULT_TARGET_LABEL) opt.selected = true;
    el.targetSelect.appendChild(opt);
  });

  function applyTargetFromSelect() {
    const midi = parseInt(el.targetSelect.value, 10);
    tracker.setTarget(midi);
    const info = PitchLib.midiToNoteName(midi);
    el.targetDisplay.textContent = `${info.name}${info.octave}`;
  }
  applyTargetFromSelect();
  el.targetSelect.addEventListener("change", applyTargetFromSelect);

  function setMode(mode) {
    tracker.setMode(mode);
    el.modeHighBtn.classList.toggle("active", mode === "HIGH");
    el.modeLowBtn.classList.toggle("active", mode === "LOW");
    renderMeterRange();
  }
  el.modeHighBtn.addEventListener("click", () => setMode("HIGH"));
  el.modeLowBtn.addEventListener("click", () => setMode("LOW"));
  setMode("HIGH");

  const METER_RANGE_CENTS = 220;

  function centsToPercent(cents) {
    const clamped = Math.max(-METER_RANGE_CENTS, Math.min(METER_RANGE_CENTS, cents));
    return ((clamped + METER_RANGE_CENTS) / (METER_RANGE_CENTS * 2)) * 100;
  }

  function renderMeterRange() {
    const mode = tracker.mode;
    const minCents = mode === "HIGH" ? CONFIG.HIGH_MIN_CENTS : CONFIG.LOW_MIN_CENTS;
    const maxCents = mode === "HIGH" ? CONFIG.HIGH_MAX_CENTS : CONFIG.LOW_MAX_CENTS;
    const left = centsToPercent(minCents);
    const right = centsToPercent(maxCents);
    el.meterFill.style.left = `${left}%`;
    el.meterFill.style.width = `${right - left}%`;
  }
  renderMeterRange();

  // ---- ログ表示（診断用） ----
  function showLog(message, isError) {
    el.errorMsg.textContent = message;
    el.errorMsg.hidden = false;
    el.errorMsg.style.color = isError ? "#D9634E" : "#17A98D";
    el.errorMsg.style.background = isError ? "rgba(217,99,78,0.10)" : "rgba(23,169,141,0.10)";
    el.errorMsg.style.borderColor = isError ? "rgba(217,99,78,0.35)" : "rgba(23,169,141,0.35)";
  }
  function clearError() {
    el.errorMsg.hidden = true;
    el.errorMsg.textContent = "";
  }

  // ---- マイク開始/停止（診断ログ付き） ----
  async function startMic() {
    clearError();
    el.micButton.disabled = true;

    try {
      showLog("[1/6] AudioContext作成中…", false);
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      showLog(`[2/6] AudioContext作成OK (state=${audioContext.state})`, false);

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      showLog(`[3/6] resume完了 (state=${audioContext.state})`, false);

      showLog("[4/6] getUserMedia呼び出し中…（許可ダイアログを待っています）", false);
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      showLog("[5/6] マイク取得成功", false);

      const source = audioContext.createMediaStreamSource(mediaStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = CONFIG.FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);

      timeDomainBuffer = new Float32Array(analyser.fftSize);
      tracker.resetHold();

      isRunning = true;
      el.micButton.textContent = "計測を停止";
      el.micButton.disabled = false;
      el.micButton.classList.add("listening");
      showLog("[6/6] 計測開始！", false);

      loop();
    } catch (e) {
      showLog(
        `エラー発生: ${e && e.name ? e.name : "UnknownError"} - ${e && e.message ? e.message : String(e)}`,
        true
      );
      el.micButton.disabled = false;
      console.error(e);
    }
  }

  function stopMic() {
    isRunning = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    analyser = null;
    tracker.resetHold();

    el.micButton.textContent = "マイクを開始";
    el.micButton.classList.remove("listening");
    clearError();
    renderIdleState();
  }

  el.micButton.addEventListener("click", () => {
    if (isRunning) {
      stopMic();
    } else {
      startMic();
    }
  });

  function loop() {
    if (!isRunning) return;

    analyser.getFloatTimeDomainData(timeDomainBuffer);
    const rms = PitchLib.computeRMS(timeDomainBuffer);

    let rawFrequency = null;
    let confidence = null;

    if (rms >= CONFIG.INPUT_LEVEL_THRESHOLD) {
      const result = PitchLib.yinDetect(timeDomainBuffer, audioContext.sampleRate, CONFIG);
      if (result) {
        rawFrequency = result.frequency;
        confidence = result.confidence;
      }
    }

    const info = tracker.update(rawFrequency, rms, performance.now());
    render(info, confidence);

    rafId = requestAnimationFrame(loop);
  }

  const STATE_LABELS = {
    NO_PITCH: "NO PITCH",
    OUT_OF_RANGE: "OUT OF RANGE",
    HOLDING: "HOLDING…",
    CLEAR: "CLEAR!",
  };
  const STATE_CLASSES = {
    NO_PITCH: "state-nopitch",
    OUT_OF_RANGE: "state-outofrange",
    HOLDING: "state-holding",
    CLEAR: "state-clear",
  };

  function renderIdleState() {
    el.noteName.textContent = "--";
    el.hzValue.textContent = "-- Hz";
    el.nearestCents.textContent = "--";
    el.targetCents.textContent = "--";
    el.holdTimeValue.textContent = "0.0 sec";
    el.holdBarFill.style.width = "0%";
    setStateLabel("NO_PITCH");
    el.meterDot.style.left = "50%";

    el.debugRawF0.textContent = "--";
    el.debugSmoothedF0.textContent = "--";
    el.debugRMS.textContent = "--";
    el.debugTargetFreq.textContent = tracker.targetFrequency.toFixed(2) + " Hz";
    el.debugTargetCents.textContent = "--";
    el.debugConfidence.textContent = "--";
    el.debugMode.textContent = tracker.mode;
    el.debugState.textContent = "--";
    el.debugHeldMs.textContent = "0 ms";
    el.debugSampleRate.textContent = "--";
  }

  function setStateLabel(state) {
    el.stateLabel.textContent = STATE_LABELS[state] || state;
    Object.values(STATE_CLASSES).forEach((c) => el.stateLabel.classList.remove(c));
    el.stateLabel.classList.add(STATE_CLASSES[state] || "");
  }

  function render(info, confidence) {
    if (info.hasPitch && info.nearestNote) {
      el.noteName.textContent = `${info.nearestNote.name}${info.nearestNote.octave}`;
      el.hzValue.textContent = `${info.smoothedFrequency.toFixed(1)} Hz`;
      const nc = info.nearestNote.cents;
      el.nearestCents.textContent = `${nc >= 0 ? "+" : ""}${nc.toFixed(0)} cents`;
      const tc = info.targetCents;
      el.targetCents.textContent = `${tc >= 0 ? "+" : ""}${tc.toFixed(0)} cents`;
      el.meterDot.style.left = `${centsToPercent(tc)}%`;
    } else {
      el.noteName.textContent = "--";
      el.hzValue.textContent = "-- Hz";
      el.nearestCents.textContent = "声を出してください";
      el.targetCents.textContent = "--";
      el.meterDot.style.left = "50%";
    }

    const heldSec = (info.heldMs / 1000).toFixed(1);
    el.holdTimeValue.textContent = `${heldSec} sec`;
    const holdPct = Math.min(100, (info.heldMs / info.holdDurationMs) * 100);
    el.holdBarFill.style.width = `${holdPct}%`;

    setStateLabel(info.state);

    el.debugRawF0.textContent = info.rawFrequency ? `${info.rawFrequency.toFixed(2)} Hz` : "--";
    el.debugSmoothedF0.textContent = info.smoothedFrequency
      ? `${info.smoothedFrequency.toFixed(2)} Hz`
      : "--";
    el.debugRMS.textContent = info.rms.toFixed(5);
    el.debugTargetFreq.textContent = `${info.targetFrequency.toFixed(2)} Hz`;
    el.debugTargetCents.textContent = info.targetCents !== null ? info.targetCents.toFixed(1) : "--";
    el.debugConfidence.textContent = confidence !== null ? confidence.toFixed(3) : "--";
    el.debugMode.textContent = info.mode;
    el.debugState.textContent = info.state;
    el.debugHeldMs.textContent = `${Math.round(info.heldMs)} ms`;
    el.debugSampleRate.textContent = audioContext ? `${audioContext.sampleRate} Hz` : "--";
  }

  renderIdleState();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showLog("このブラウザはマイク入力(getUserMedia)に対応していません。", true);
    el.micButton.disabled = true;
  }
  if (!(window.AudioContext || window.webkitAudioContext)) {
    showLog("このブラウザはWeb Audio APIに対応していません。", true);
    el.micButton.disabled = true;
  }
})();
