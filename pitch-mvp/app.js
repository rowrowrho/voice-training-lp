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
    replayToneBtn: document.getElementById("replayToneBtn"),
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

    autoAdvanceToggle: document.getElementById("autoAdvanceToggle"),

    challengeTimeValue: document.getElementById("challengeTimeValue"),
    challengeBarFill: document.getElementById("challengeBarFill"),
    challengeResult: document.getElementById("challengeResult"),
    challengeResultLabel: document.getElementById("challengeResultLabel"),
    challengeResultNote: document.getElementById("challengeResultNote"),
    challengeResultDetail: document.getElementById("challengeResultDetail"),
    challengeResetBtn: document.getElementById("challengeResetBtn"),
    challengeOtherModeBtn: document.getElementById("challengeOtherModeBtn"),
    finalResultBlock: document.getElementById("finalResultBlock"),
    finalRangeText: document.getElementById("finalRangeText"),
    shareBtn: document.getElementById("shareBtn"),
  };

  var audioContext = null; // マイク入力用
  var analyser = null;
  var mediaStream = null;
  var timeDomainBuffer = null;
  var rafId = null;
  var isRunning = false;

  // ---- お手本音の再生(マイク入力とは独立したAudioContextを使う) ----
  var playbackContext = null;

  function ensurePlaybackContext() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!playbackContext) {
      playbackContext = new Ctx();
    }
    if (playbackContext.state === "suspended") {
      playbackContext
        .resume()
        .then(function () {
          alert("診断: resume成功、新しいstate = " + playbackContext.state);
        })
        .catch(function (e) {
          alert("診断: resume失敗 - " + e.name + ": " + e.message);
        });
    }
    return playbackContext;
  }

  function playReferenceTone(frequency) {
    try {
      var ctx = ensurePlaybackContext();
      if (!ctx) {
        alert("診断: AudioContextを作成できませんでした(Web Audio API非対応)");
        return;
      }
      if (!frequency) {
        alert("診断: frequencyが不正です: " + frequency);
        return;
      }

      alert("診断: ctx.state = " + ctx.state + " / frequency = " + frequency.toFixed(1) + "Hz");

      var durationSec = CONFIG.REFERENCE_TONE_DURATION_MS / 1000;
      var peakVolume = CONFIG.REFERENCE_TONE_VOLUME;
      var fade = Math.min(0.03, durationSec / 4);

      var osc = ctx.createOscillator();
      var gainNode = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;

      var now = ctx.currentTime;
      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(peakVolume, now + fade);
      gainNode.gain.setValueAtTime(peakVolume, now + durationSec - fade);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationSec + 0.05);
    } catch (e) {
      alert("診断: エラー発生 - " + e.name + ": " + e.message);
    }
  }

  el.replayToneBtn.addEventListener("click", function () {
    playReferenceTone(tracker.targetFrequency);
    // チャレンジ中の場合は、聞き直した分だけタイマーも仕切り直す
    startChallengeForCurrentTarget();
  });

  var tracker = new PitchLib.PitchTracker(CONFIG);

  // ---- TARGETセレクトの初期化 ----
  var targetList = PitchLib.generateTargetNoteList();
  var DEFAULT_TARGET_LABEL = "A3";
  var STARTING_TARGET_MIDI = null; // A3のMIDI番号(下で確定させる)
  targetList.forEach(function (note) {
    var opt = document.createElement("option");
    opt.value = String(note.midi);
    opt.textContent = note.label;
    if (note.label === DEFAULT_TARGET_LABEL) {
      opt.selected = true;
      STARTING_TARGET_MIDI = note.midi;
    }
    el.targetSelect.appendChild(opt);
  });

  function applyTargetFromSelect() {
    var midi = parseInt(el.targetSelect.value, 10);
    tracker.setTarget(midi);
    var info = PitchLib.midiToNoteName(midi);
    el.targetDisplay.textContent = info.name + info.octave;
    playReferenceTone(tracker.targetFrequency);
  }
  applyTargetFromSelect();
  el.targetSelect.addEventListener("change", applyTargetFromSelect);

  // ---- 自動送り(CLEARしたら半音上の次の音へ) ----
  var autoAdvanceTimeoutId = null;
  var lastState = null; // CLEARへの「切り替わった瞬間」だけを検知するため

  // ---- 音域チャレンジモード ----
  var challengeActive = false;
  var challengeDeadline = null; // performance.now()基準の締切時刻
  var pendingChallengeStartTimeoutId = null; // お手本再生後にカウントダウンを始めるまでの待機
  var lastClearedNoteLabel = null; // 今の
