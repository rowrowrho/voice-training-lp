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
    finalOctaveText: document.getElementById("finalOctaveText"),
    shareBtn: document.getElementById("shareBtn"),
    shareXBtn: document.getElementById("shareXBtn"),
    submitResultBtn: document.getElementById("submitResultBtn"),
    submitResultStatus: document.getElementById("submitResultStatus"),
  };

  var audioContext = null; // マイク入力用
  var analyser = null;
  var mediaStream = null;
  var timeDomainBuffer = null;
  var rafId = null;
  var isRunning = false;

  // お手本再生中のマイク対策を「完全停止→撮り直し」にするか「一時ミュート」にするかの切り替え。
  // もし不具合が起きたら、このtrueをfalseに変えるだけで安全な方式に戻せる。
  var USE_HARD_MIC_STOP = true;

  // マイクのMediaStreamからWeb Audioの接続グラフ(source→analyser)を作る
  function createAudioGraph(stream) {
    mediaStream = stream;
    var source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = CONFIG.FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    timeDomainBuffer = new Float32Array(analyser.fftSize);
  }

  function getMicConstraints() {
    return {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
  }

  // ---- お手本音の再生(マイク入力とは独立したAudioContextを使う) ----
  var playbackContext = null;
  var micMuteTimeoutId = null; // お手本再生中だけマイクをミュートするためのタイマー

  function ensurePlaybackContext() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!playbackContext) {
      playbackContext = new Ctx();
    }
    if (playbackContext.state === "suspended") {
      playbackContext.resume().catch(function () {});
    }
    return playbackContext;
  }

  // お手本再生中はマイクを完全に停止(track.stop())し、OS側の録音セッションごと
  // 解放する。再生が終わったらgetUserMediaを撮り直して再接続する。
  // 万一、再取得が固まってしまった場合に備えて、一定時間で諦めてマイクを
  // 停止状態に戻す保険(タイムアウト)を入れてある。
  function stopMicDuringTone(durationMs) {
    if (micMuteTimeoutId !== null) {
      clearTimeout(micMuteTimeoutId);
      micMuteTimeoutId = null;
    }
    if (!isRunning) return; // マイクがそもそも起動していなければ何もしない

    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) {
        t.stop();
      });
      mediaStream = null;
    }
    analyser = null; // loop()側はanalyserが無い間は検出をスキップする

    micMuteTimeoutId = setTimeout(function () {
      micMuteTimeoutId = null;
      if (!isRunning) return; // 再生中にユーザーがマイクを止めていたら何もしない

      var reacquireTimedOut = false;
      var safetyTimer = setTimeout(function () {
        reacquireTimedOut = true;
        showLog(
          "マイクの再接続に時間がかかっています。お手数ですが、もう一度「マイクを開始」を押してください。",
          true
        );
        stopMic();
      }, 4000); // 4秒以上応答が無ければタイムアウトとして諦める

      navigator.mediaDevices
        .getUserMedia(getMicConstraints())
        .then(function (stream) {
          clearTimeout(safetyTimer);
          if (reacquireTimedOut) {
            // タイムアウト後に遅れて成功した場合は、使わずに閉じる
            stream.getTracks().forEach(function (t) {
              t.stop();
            });
            return;
          }
          createAudioGraph(stream);
        })
        .catch(function (err) {
          clearTimeout(safetyTimer);
          if (reacquireTimedOut) return;
          showLog(
            "マイクの再取得に失敗しました: " + (err && err.message ? err.message : err),
            true
          );
          stopMic();
        });
    }, durationMs);
  }

  // お手本再生中だけマイクの入力を一時的に無効化し、再生終了と同時に戻す
  // (USE_HARD_MIC_STOP=falseのときに使う、より安全な代替方式)
  function muteMicDuringTone(durationMs) {
    if (micMuteTimeoutId !== null) {
      clearTimeout(micMuteTimeoutId);
      micMuteTimeoutId = null;
    }
    if (!mediaStream) return; // マイクが起動していなければ何もしない

    mediaStream.getTracks().forEach(function (t) {
      t.enabled = false;
    });

    micMuteTimeoutId = setTimeout(function () {
      micMuteTimeoutId = null;
      if (mediaStream) {
        mediaStream.getTracks().forEach(function (t) {
          t.enabled = true;
        });
      }
    }, durationMs);
  }

  // 基準音程より低いTARGETほど音量を上げる補正（低音の聞こえにくさ対策）
  function computeBoostedVolume() {
    var refMidi = CONFIG.REFERENCE_TONE_VOLUME_REFERENCE_MIDI;
    var octavesBelow = Math.max(0, (refMidi - tracker.targetMidi) / 12);
    var boostFactor = 1 + octavesBelow * CONFIG.REFERENCE_TONE_LOW_BOOST_PER_OCTAVE;
    return Math.min(1.0, CONFIG.REFERENCE_TONE_VOLUME * boostFactor);
  }

  function playReferenceTone(frequency) {
    var ctx = ensurePlaybackContext();
    if (!ctx || !frequency) return;

    var durationSec = CONFIG.REFERENCE_TONE_DURATION_MS / 1000;
    var peakVolume = computeBoostedVolume();
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

    if (USE_HARD_MIC_STOP) {
      stopMicDuringTone(CONFIG.REFERENCE_TONE_DURATION_MS);
    } else {
      muteMicDuringTone(CONFIG.REFERENCE_TONE_DURATION_MS);
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
  var lastClearedNoteLabel = null; // 今の方向で直前にCLEARできた音の表示名
  var lastClearedNoteMidi = null;

  // 両方向(HIGH/LOW)それぞれの結果を記録
  var directionTested = { HIGH: false, LOW: false };
  var directionResult = { HIGH: null, LOW: null }; // クリアできた最遠の音の表示名 | null(記録なし)
  var directionResultMidi = { HIGH: null, LOW: null }; // クリアできた最遠の音のMIDI番号 | null

  function hideChallengeResult() {
    el.challengeResult.hidden = true;
  }

  function cancelPendingChallengeStart() {
    if (pendingChallengeStartTimeoutId !== null) {
      clearTimeout(pendingChallengeStartTimeoutId);
      pendingChallengeStartTimeoutId = null;
    }
  }

  // お手本音を1秒聞かせてから、制限時間のカウントダウンを開始する
  function startChallengeForCurrentTarget() {
    cancelPendingChallengeStart();
    if (!el.autoAdvanceToggle.checked) {
      challengeActive = false;
      el.challengeTimeValue.textContent = "--";
      el.challengeBarFill.style.width = "0%";
      return;
    }
    challengeActive = false;
    el.challengeTimeValue.textContent = "お手本再生中…";
    el.challengeBarFill.style.width = "100%";

    pendingChallengeStartTimeoutId = setTimeout(function () {
      pendingChallengeStartTimeoutId = null;
      challengeActive = true;
      challengeDeadline = performance.now() + CONFIG.CHALLENGE_DURATION_MS;
    }, CONFIG.REFERENCE_TONE_DURATION_MS);
  }

  function updateChallengeCountdown(nowMs) {
    if (!challengeActive) return;
    var remainingMs = challengeDeadline - nowMs;
    if (remainingMs <= 0) {
      finishChallenge(false);
      return;
    }
    var remainingSec = (remainingMs / 1000).toFixed(1);
    el.challengeTimeValue.textContent = remainingSec + " sec";
    var pct = Math.max(0, Math.min(100, (remainingMs / CONFIG.CHALLENGE_DURATION_MS) * 100));
    el.challengeBarFill.style.width = pct + "%";
  }

  function directionLabel(mode) {
    return mode === "LOW" ? "低音域" : "高音域";
  }

  // reachedListEnd: trueなら「これ以上の音がリストに無い」ことによる終了(=そこまで到達できた成功扱い)
  function finishChallenge(reachedListEnd) {
    challengeActive = false;
    challengeDeadline = null;
    cancelAutoAdvance();
    el.challengeTimeValue.textContent = "--";
    el.challengeBarFill.style.width = "0%";

    var currentMode = tracker.mode;
    directionTested[currentMode] = true;
    directionResult[currentMode] = lastClearedNoteLabel;
    directionResultMidi[currentMode] = lastClearedNoteMidi;

    el.challengeResult.hidden = false;
    el.challengeResultLabel.textContent = directionLabel(currentMode) + "チャレンジ結果";
    el.challengeResultNote.hidden = false;
    el.finalResultBlock.hidden = true;
    el.challengeOtherModeBtn.hidden = true;

    if (lastClearedNoteLabel === null) {
      el.challengeResultNote.textContent = "記録なし";
      el.challengeResultDetail.textContent =
        "10秒以内に1つも音をキープできませんでした。感度調整を見直すか、TARGETを変えてもう一度試してください。";
    } else {
      el.challengeResultNote.textContent = lastClearedNoteLabel;
      el.challengeResultDetail.textContent = reachedListEnd
        ? "測定可能な音域の端まで到達しました。この音が今回測定できた音域の端です。"
        : "この音までは10秒以内にキープできましたが、次の音は時間内にキープできませんでした。この音が今回の音域の端(の目安)です。";
    }

    var otherMode = currentMode === "HIGH" ? "LOW" : "HIGH";
    if (!directionTested[otherMode]) {
      el.challengeOtherModeBtn.hidden = false;
      el.challengeOtherModeBtn.textContent = directionLabel(otherMode) + "もチャレンジする";
    } else {
      showFinalResult();
    }
  }

  function showFinalResult() {
    el.challengeResultLabel.textContent = "音域チャレンジ 最終結果";
    el.challengeResultNote.hidden = true;
    el.challengeResultDetail.textContent = "";
    el.challengeOtherModeBtn.hidden = true;

    var lowLabel = directionResult.LOW || "測定不可";
    var highLabel = directionResult.HIGH || "測定不可";
    el.finalRangeText.textContent = lowLabel + " 〜 " + highLabel;

    var lowMidi = directionResultMidi.LOW;
    var highMidi = directionResultMidi.HIGH;
    if (lowMidi !== null && highMidi !== null && highMidi >= lowMidi) {
      var totalSemitones = highMidi - lowMidi;
      var octaves = Math.floor(totalSemitones / 12);
      var remainderSemitones = totalSemitones % 12;
      var octaveText = octaves + "オクターブ";
      if (remainderSemitones > 0) {
        octaveText += remainderSemitones + "半音";
      }
      el.finalOctaveText.textContent = octaveText;
    } else {
      el.finalOctaveText.textContent = "";
    }

    el.finalResultBlock.hidden = false;
  }

  function goToStartingTarget() {
    el.targetSelect.value = String(STARTING_TARGET_MIDI);
    applyTargetFromSelect();
    tracker.resetHold();
  }

  el.challengeOtherModeBtn.addEventListener("click", function () {
    var otherMode = tracker.mode === "HIGH" ? "LOW" : "HIGH";
    setMode(otherMode);
    goToStartingTarget();
    hideChallengeResult();
    lastClearedNoteLabel = null;
    lastClearedNoteMidi = null;
    startChallengeForCurrentTarget();
  });

  el.challengeResetBtn.addEventListener("click", function () {
    hideChallengeResult();
    directionTested.HIGH = false;
    directionTested.LOW = false;
    directionResult.HIGH = null;
    directionResult.LOW = null;
    directionResultMidi.HIGH = null;
    directionResultMidi.LOW = null;
    lastClearedNoteLabel = null;
    lastClearedNoteMidi = null;
    el.submitResultBtn.disabled = false;
    el.submitResultBtn.textContent = "この結果を送信する";
    el.submitResultStatus.textContent = "";
    setMode("HIGH");
    goToStartingTarget();
    startChallengeForCurrentTarget();
  });

  function buildShareText() {
    var lowLabel = directionResult.LOW || "測定不可";
    var highLabel = directionResult.HIGH || "測定不可";
    return "私の音域は " + lowLabel + " 〜 " + highLabel + " でした！ #RHOボイトレ #音域診断";
  }

  el.shareBtn.addEventListener("click", function () {
    var shareText = buildShareText();
    var shareUrl = location.href;

    if (navigator.share) {
      navigator.share({ text: shareText, url: shareUrl }).catch(function () {});
    } else {
      var intentUrl =
        "https://twitter.com/intent/tweet?text=" +
        encodeURIComponent(shareText) +
        "&url=" +
        encodeURIComponent(shareUrl);
      window.open(intentUrl, "_blank");
    }
  });

  el.shareXBtn.addEventListener("click", function () {
    var shareText = buildShareText();
    var shareUrl = location.href;
    var intentUrl =
      "https://twitter.com/intent/tweet?text=" +
      encodeURIComponent(shareText) +
      "&url=" +
      encodeURIComponent(shareUrl);
    window.open(intentUrl, "_blank");
  });

  // ---- 結果の送信(range-recorderと同じGoogle Apps Scriptエンドポイントへ) ----
  // 音声ファイルは含めず、音域チャレンジの結果(テキストのみ)を送る。
  var SUBMIT_ENDPOINT_URL =
    "https://script.google.com/macros/s/AKfycbzoGlK2DZIC4hIW17A3kXho3_3jU2zn55jyKU4ORD1divJ3P4GMaleuWcxsu5TwWL42Ww/exec";

  el.submitResultBtn.addEventListener("click", function () {
    if (!SUBMIT_ENDPOINT_URL) {
      el.submitResultStatus.textContent = "送信先が設定されていません。";
      return;
    }

    el.submitResultBtn.disabled = true;
    el.submitResultStatus.textContent = "送信中…";

    var payload = {
      source: "pitch-mvp-range-challenge", // range-recorderの録音データと区別するための印
      submittedAt: new Date().toISOString(),
      lowNote: directionResult.LOW || null,
      lowMidi: directionResultMidi.LOW,
      highNote: directionResult.HIGH || null,
      highMidi: directionResultMidi.HIGH,
      octaveSummary: el.finalOctaveText.textContent || null,
    };

    // Content-Typeを指定しない(=text/plainになる)ことでCORSプリフライトを避ける
    // (range-recorder側の送信処理と同じ方式)
    fetch(SUBMIT_ENDPOINT_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json && json.result === "success") {
          el.submitResultStatus.textContent = "送信しました。ありがとうございます！";
          el.submitResultBtn.textContent = "送信済み";
        } else {
          el.submitResultStatus.textContent = "送信に失敗しました。もう一度お試しください。";
          el.submitResultBtn.disabled = false;
        }
      })
      .catch(function () {
        el.submitResultStatus.textContent = "送信に失敗しました。通信環境を確認してください。";
        el.submitResultBtn.disabled = false;
      });
  });

  el.autoAdvanceToggle.addEventListener("change", function () {
    if (!el.autoAdvanceToggle.checked) {
      challengeActive = false;
      el.challengeTimeValue.textContent = "--";
      el.challengeBarFill.style.width = "0%";
      cancelAutoAdvance();
    } else {
      hideChallengeResult();
      lastClearedNoteLabel = null;
      lastClearedNoteMidi = null;
      startChallengeForCurrentTarget();
    }
  });

  function advanceToNextTarget() {
    var currentIndex = el.targetSelect.selectedIndex;
    // LOW MODEのときは音域を下方向(index-1)、それ以外は上方向(index+1)へ進める
    var step = tracker.mode === "LOW" ? -1 : 1;
    var nextIndex = currentIndex + step;
    if (nextIndex < 0 || nextIndex >= el.targetSelect.options.length) {
      // これ以上その方向に音がない（リストの端に到達）ので、到達成功として終了
      finishChallenge(true);
      return;
    }
    el.targetSelect.selectedIndex = nextIndex;
    applyTargetFromSelect();
    tracker.resetHold();
    startChallengeForCurrentTarget();
  }

  function cancelAutoAdvance() {
    if (autoAdvanceTimeoutId !== null) {
      clearTimeout(autoAdvanceTimeoutId);
      autoAdvanceTimeoutId = null;
    }
    cancelPendingChallengeStart();
  }

  // 手動でTARGETを変えた場合は、保留中の自動送り・チャレンジ状態をリセットする
  el.targetSelect.addEventListener("change", function () {
    cancelAutoAdvance();
    hideChallengeResult();
    directionTested.HIGH = false;
    directionTested.LOW = false;
    directionResult.HIGH = null;
    directionResult.LOW = null;
    directionResultMidi.HIGH = null;
    directionResultMidi.LOW = null;
    lastClearedNoteLabel = null;
    lastClearedNoteMidi = null;
    startChallengeForCurrentTarget();
  });

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
      .getUserMedia(getMicConstraints())
      .then(function (stream) {
        createAudioGraph(stream);

        tracker.resetHold();
        hideChallengeResult();
        lastClearedNoteLabel = null;
        lastClearedNoteMidi = null;
        startChallengeForCurrentTarget();

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
    cancelAutoAdvance();
    if (micMuteTimeoutId !== null) {
      clearTimeout(micMuteTimeoutId);
      micMuteTimeoutId = null;
    }
    lastState = null;
    challengeActive = false;
    challengeDeadline = null;
    el.challengeTimeValue.textContent = "--";
    el.challengeBarFill.style.width = "0%";
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

    var rawFrequency = null;
    var confidence = null;
    var rms = 0;

    // お手本再生中(USE_HARD_MIC_STOP=trueの場合)はanalyserが一時的に
    // 存在しない。その間は検出をスキップし、NO_PITCH状態として扱う。
    if (analyser) {
      analyser.getFloatTimeDomainData(timeDomainBuffer);
      rms = PitchLib.computeRMS(timeDomainBuffer);

      if (rms >= CONFIG.INPUT_LEVEL_THRESHOLD) {
        var result = PitchLib.yinDetect(timeDomainBuffer, audioContext.sampleRate, CONFIG);
        if (result) {
          rawFrequency = result.frequency;
          confidence = result.confidence;
        }
      }
    }

    var now = performance.now();
    var info = tracker.update(rawFrequency, rms, now);
    render(info, confidence);
    updateChallengeCountdown(now);

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

    if (el.debugState) {
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

    // --- 自動送り: CLEARに「今まさに切り替わった瞬間」だけ発火させる ---
    if (info.state === "CLEAR" && lastState !== "CLEAR") {
      lastClearedNoteLabel = el.targetDisplay.textContent;
      lastClearedNoteMidi = info.targetMidi;
      if (el.autoAdvanceToggle.checked) {
        challengeActive = false; // 次の音へ進むまでの間はカウントダウンを止めておく
        el.challengeTimeValue.textContent = "CLEAR!";
        cancelAutoAdvance();
        autoAdvanceTimeoutId = setTimeout(function () {
          autoAdvanceTimeoutId = null;
          advanceToNextTarget();
        }, CONFIG.AUTO_ADVANCE_DELAY_MS);
      }
    }
    lastState = info.state;

    if (el.debugState) {
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
  }

  renderIdleState();
})();
