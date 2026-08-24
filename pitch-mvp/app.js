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
    if (!A
