/* ============================================================
   app.js (v6 - async/awaitを使わない書き直し版)
   RHO 音域診断 Phase1 - MVP
   ============================================================ */

(function () {
  "use strict";

  var PitchLib = window.PitchLib;
  // CONFIGを直接使わず、テスト用にその場で調整できるコピーを作る
  var CONFIG = Object.assign({}, PitchLib.CONFIG);

  var el = {
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

    yinThresholdSlider: document.getElementById("yinThresholdSlider"),
    yinThresholdValue: document.getElementById("yinThresholdValue"),
    relockSlider: document.getElementById("relockSlider"),
    relockValue: document.getElementById("relockValue"),
    sensitivityResetBtn: document.getElementById("sensitivityResetBtn"),
  };

  var audioContext = null;
  var analyser = null;
  var mediaStream = null;
  var timeDomainBuffer = null;
  var rafId = null;
  var isRunning = false;

  var tracker = new PitchLib.PitchTracker(CONFIG);

  // ---- TARGETセレクトの初期化 ----
  var targetList = PitchLib.generateTargetNoteList();
  var DEFAULT_TARGET_LABEL = "A3";
  targetList.forEach(function (note) {
    var opt = document.createElement("option");
    opt.value = String(note.midi);
    opt.textContent = note.label;
    if (note.label === DEFAULT_TARGET_LABEL) opt.selected = true;
    el.targetSelect.appendChild(opt);
  });

  function applyTargetFromSelect() {
    var midi = parseInt(el.targetSelect.value, 10);
    tracker.setTarget(midi);
    var info = PitchLib.midiToNoteName(midi);
    el.targetDisplay.textContent = info.name + info.octave;
  }
  applyTargetFromSelect();
  el.targetSelect.addEventListener("change", applyTargetFromSelect);

  // ---- HIGH / LOW モード切り替え ----
  function setMode(mode) {
    tracker.setMode(mode);
    el.modeHighBtn.classList.toggle("active", mode === "HIGH");
    el.modeLowBtn.classList.toggle("active", mode === "LOW");
    renderMeterRange();
  }
  el.modeHighBtn.addEventListener("click", function () { setMode("HIGH"); });
  el.modeLowBtn.addEventListener("click", function () { setMode("LOW"); });
  setMode("HIGH");

  var METER_RANGE_CENTS = 220;

  function centsToPercent(cents) {
    var clamped = Math.max(-METER_RANGE_CENTS, Math.min(METER_RANGE_CENTS, cents));
    return ((clamped + METER_RANGE_CENTS) / (METER_RANGE_CENTS * 2)) * 100;
  }

  function renderMeterRange() {
    var mode = tracker.mode;
    var minCents = mode === "HIGH" ? CONFIG.HIGH_MIN_CENTS : CONFIG.LOW_MIN_CENTS;
    var maxCents = mode === "HIGH" ? CONFIG.HIGH_MAX_CENTS : CONFIG.LOW_MAX_CENTS;
    var left = centsToPercent(minCents);
    var right = centsToPercent(maxCents);
    el.meterFill.style.left = left + "%";
    el.meterFill.style.width = (right - left) + "%";
  }
  renderMeterRange();

  // ---- 感度調整スライダー(個人差の吸収用) ----
  function syncSlidersFromConfig() {
    el.yinThresholdSlider.value = CONFIG.YIN_THRESHOLD;
    el.yinThresholdValue.textContent = CONFIG.YIN_THRESHOLD.toFixed(2);
    el.relockSlider.value = CONFIG.OCTAVE_RELOCK_STREAK_FRAMES >= 1000
      ? 100
      : CONFIG.OCTAVE_RELOCK_STREAK_FRAMES;
    el.relockValue.textContent =
      CONFIG.OCTAVE_RELOCK_STREAK_FRAMES >= 1000
        ? "しがみつく(最大)"
        : CONFIG.OCTAVE_RELOCK_STREAK_FRAMES + "フレーム";
  }
  syncSlidersFromConfig();

  el.yinThresholdSlider.addEventListener("input", function () {
    var v = parseFloat(el.yinThresholdSlider.value);
    CONFIG.YIN_THRESHOLD = v;
    el.yinThresholdValue.textContent = v.toFixed(2);
  });

  el.relockSlider.addEventListener("input", function () {
    var v = parseInt(el.relockSlider.value, 10);
    var frames = v >= 100 ? 100000 : v;
    CONFIG.OCTAVE_RELOCK_STREAK_FRAMES = frames;
    el.relockValue.textContent = v >= 100 ? "しがみつく(最大)" : v + "フレーム";
  });

  el.sensitivityResetBtn.addEventListener("click", function () {
    CONFIG.YIN_THRESHOLD = PitchLib.CONFIG.YIN_THRESHOLD;
    CONFIG.OCTAVE_RELOCK_STREAK_FRAMES = PitchLib.CONFIG.OCTAVE_RELOCK_STREAK_FRAMES;
    syncSlidersFromConfig();
  });

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

  // ---- マイク開始（async/awaitを使わず、Promise.then()で統一） ----
  function startMic() {
    clearError();
    el.micButton.disabled = true;

    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      showLog("このブラウザはWeb Audio APIに対応していません。", true);
      el.micButton.disabled = false;
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showLog("このブラウザはマイク入力(getUserMedia)に対応していません。", true);
      el.micButton.disabled = false;
      return;
    }

    try {
      audioContext = new AudioContextClass();
    } catch (e) {
      showLog("AudioContext作成に失敗しました: " + e.message, true);
      el.micButton.disabled = false;
      return;
    }

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      .then(function (stream) {
        mediaStream = stream;

        var source = audioContext.createMediaStreamSource(mediaStream);
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

        loop();
      })
      .catch(function (err) {
        var msg = "マイクを取得できませんでした。";
        if (err && err.name === "NotAllowedError") {
          msg = "マイクの使用が許可されませんでした。ブラウザの設定を確認してください。";
        } else if (err && err.name === "NotFoundError") {
          msg = "マイクが見つかりませんでした。デバイスを確認してください。";
        } else if (err) {
          msg = "エラー: " + err.name + " - " + err.message;
        }
        showLog(msg, true);
        el.micButton.disabled = false;
        if (audioContext) {
          audioContext.close();
          audioContext = null;
        }
      });
  }

  function stopMic() {
    isRunning = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
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

  el.micButton.addEventListener("click", function () {
    if (isRunning) {
      stopMic();
    } else {
      startMic();
    }
  });

  // ---- メインループ ----
  function loop() {
    if (!isRunning) return;

    analyser.getFloatTimeDomainData(timeDomainBuffer);
    var rms = PitchLib.computeRMS(timeDomainBuffer);

    var rawFrequency = null;
    var confidence = null;

    if (rms >= CONFIG.INPUT_LEVEL_THRESHOLD) {
      var result = PitchLib.yinDetect(timeDomainBuffer, audioContext.sampleRate, CONFIG);
      if (result) {
        rawFrequency = result.frequency;
        confidence = result.confidence;
      }
    }

    var info = tracker.update(rawFrequency, rms, performance.now());
    render(info, confidence);

    rafId = requestAnimationFrame(loop);
  }

  var STATE_LABELS = {
    NO_PITCH: "NO PITCH",
    OUT_OF_RANGE: "OUT OF RANGE",
    HOLDING: "HOLDING…",
    CLEAR: "CLEAR!",
  };
  var STATE_CLASSES = {
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
    Object.keys(STATE_CLASSES).forEach(function (key) {
      el.stateLabel.classList.remove(STATE_CLASSES[key]);
    });
    el.stateLabel.classList.add(STATE_CLASSES[state] || "");
  }

  function render(info, confidence) {
    if (info.hasPitch && info.nearestNote) {
      el.noteName.textContent = info.nearestNote.name + info.nearestNote.octave;
      el.hzValue.textContent = info.smoothedFrequency.toFixed(1) + " Hz";
      var nc = info.nearestNote.cents;
      el.nearestCents.textContent = (nc >= 0 ? "+" : "") + nc.toFixed(0) + " cents";
      var tc = info.targetCents;
      el.targetCents.textContent = (tc >= 0 ? "+" : "") + tc.toFixed(0) + " cents";
      el.meterDot.style.left = centsToPercent(tc) + "%";
    } else {
      el.noteName.textContent = "--";
      el.hzValue.textContent = "-- Hz";
      el.nearestCents.textContent = "声を出してください";
      el.targetCents.textContent = "--";
      el.meterDot.style.left = "50%";
    }

    var heldSec = (info.heldMs / 1000).toFixed(1);
    el.holdTimeValue.textContent = heldSec + " sec";
    var holdPct = Math.min(100, (info.heldMs / info.holdDurationMs) * 100);
    el.holdBarFill.style.width = holdPct + "%";

    setStateLabel(info.state);

    el.debugRawF0.textContent = info.rawFrequency ? info.rawFrequency.toFixed(2) + " Hz" : "--";
    el.debugSmoothedF0.textContent = info.smoothedFrequency
      ? info.smoothedFrequency.toFixed(2) + " Hz"
      : "--";
    el.debugRMS.textContent = info.rms.toFixed(5);
    el.debugTargetFreq.textContent = info.targetFrequency.toFixed(2) + " Hz";
    el.debugTargetCents.textContent = info.targetCents !== null ? info.targetCents.toFixed(1) : "--";
    el.debugConfidence.textContent = confidence !== null ? confidence.toFixed(3) : "--";
    el.debugMode.textContent = info.mode;
    el.debugState.textContent = info.state;
    el.debugHeldMs.textContent = Math.round(info.heldMs) + " ms";
    el.debugSampleRate.textContent = audioContext ? audioContext.sampleRate + " Hz" : "--";
  }

  renderIdleState();
})();
