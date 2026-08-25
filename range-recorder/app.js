/* ============================================================
   app.js (range-recorder)
   RHO 音域測定(5tone) 録音・提出ツール
   ------------------------------------------------------------
   ・async/awaitは使わない(iOS Safariのクリックハンドラ内で
     async/awaitが無反応になる不具合があるため、必ず.then()で書く)
   ============================================================ */

(function () {
  "use strict";

  // ==========================================================
  // 0. 送信先の設定
  //    Google Apps Scriptをデプロイしたら、ここにWebアプリのURLを
  //    貼り付けてください。詳しい手順は別途お渡しした設定ガイドを
  //    参照してください。
  // ==========================================================
  var SUBMIT_ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbzoGlK2DZIC4hIW17A3kXho3_3jU2zn55jyKU4ORD1divJ3P4GMaleuWcxsu5TwWL42Ww/exec";

  // ==========================================================
  // 1. 音名・周波数まわりのユーティリティ
  // ==========================================================
  var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function midiToNoteLabel(midi) {
    var rounded = Math.round(midi);
    var noteIndex = ((rounded % 12) + 12) % 12;
    var octave = Math.floor(rounded / 12) - 1;
    return NOTE_NAMES[noteIndex] + octave;
  }

  function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  var GENDER_START_MIDI = { male: 52, female: 57 }; // E3 / A3
  var MAX_MIDI = 96; // C7相当(実質到達しない上限)
  var FIVE_TONE_STEPS = [0, 2, 4, 5, 7, 5, 4, 2, 0]; // ドレミファソファミレド
  var TONE_NOTE_DURATION_SEC = 0.36;
  var TONE_VOLUME = 0.55;

  // ==========================================================
  // 2. DOM参照
  // ==========================================================
  var el = {
    errorMsg: document.getElementById("errorMsg"),

    screenIntro: document.getElementById("screenIntro"),
    screenPractice: document.getElementById("screenPractice"),
    screenDone: document.getElementById("screenDone"),
    screenSubmitting: document.getElementById("screenSubmitting"),
    submittingSub: document.getElementById("submittingSub"),

    genderMaleBtn: document.getElementById("genderMaleBtn"),
    genderFemaleBtn: document.getElementById("genderFemaleBtn"),
    nicknameInput: document.getElementById("nicknameInput"),
    contactInput: document.getElementById("contactInput"),
    startBtn: document.getElementById("startBtn"),

    targetDisplay: document.getElementById("targetDisplay"),
    playToneBtn: document.getElementById("playToneBtn"),
    micToggleBtn: document.getElementById("micToggleBtn"),

    recordBtn: document.getElementById("recordBtn"),
    recordBtnLabel: document.getElementById("recordBtnLabel"),
    recTimer: document.getElementById("recTimer"),
    recTimerValue: document.getElementById("recTimerValue"),

    takePreview: document.getElementById("takePreview"),
    takeAudio: document.getElementById("takeAudio"),
    retakeBtn: document.getElementById("retakeBtn"),
    acceptBtn: document.getElementById("acceptBtn"),

    rangeCapNote: document.getElementById("rangeCapNote"),

    recCount: document.getElementById("recCount"),
    recList: document.getElementById("recList"),

    submitBtn: document.getElementById("submitBtn"),
  };

  // ==========================================================
  // 3. 状態
  // ==========================================================
  var gender = null;
  var currentMidi = null;
  var mediaStream = null;
  var micEnabled = true;
  var mediaRecorder = null;
  var recordedChunks = [];
  var isRecording = false;
  var recTimerIntervalId = null;
  var recTimerStartedAt = null;

  var currentTakeBlob = null;
  var currentTakeMimeType = null;
  var currentTakeUrl = null;

  var recordings = []; // { midi, label, blob, mimeType }

  // ==========================================================
  // 4. エラー表示
  // ==========================================================
  function showError(message) {
    el.errorMsg.textContent = message;
    el.errorMsg.hidden = false;
  }
  function clearError() {
    el.errorMsg.hidden = true;
    el.errorMsg.textContent = "";
  }

  // ==========================================================
  // 5. お手本音(5tone)の再生
  // ==========================================================
  var playbackContext = null;
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

  function playFiveTone(rootFreq) {
    var ctx = ensurePlaybackContext();
    if (!ctx || !rootFreq) return 0;

    var startBase = ctx.currentTime + 0.05;
    var elapsed = 0;

    FIVE_TONE_STEPS.forEach(function (semitoneOffset, idx) {
      var isLastNote = idx === FIVE_TONE_STEPS.length - 1;
      // 最後の音(締めの「ド」)は他の音の2倍の長さで伸ばす
      var dur = isLastNote ? TONE_NOTE_DURATION_SEC * 2 : TONE_NOTE_DURATION_SEC;
      var fade = Math.min(0.03, dur / 4);
      var freq = rootFreq * Math.pow(2, semitoneOffset / 12);
      var startT = startBase + elapsed;

      var osc = ctx.createOscillator();
      var gainNode = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;

      gainNode.gain.setValueAtTime(0.0001, startT);
      gainNode.gain.exponentialRampToValueAtTime(TONE_VOLUME, startT + fade);
      gainNode.gain.setValueAtTime(TONE_VOLUME, startT + dur - fade);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startT + dur);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start(startT);
      osc.stop(startT + dur + 0.05);

      elapsed += dur;
    });

    return (elapsed + 0.15) * 1000; // ms
  }

  el.playToneBtn.addEventListener("click", function () {
    if (currentMidi === null) return;
    var totalMs = playFiveTone(midiToHz(currentMidi));
    el.playToneBtn.disabled = true;
    setTimeout(function () {
      el.playToneBtn.disabled = false;
    }, totalMs);
  });

  // ==========================================================
  // 6. 性別選択・開始
  // ==========================================================
  function selectGender(g) {
    gender = g;
    el.genderMaleBtn.classList.toggle("active", g === "male");
    el.genderFemaleBtn.classList.toggle("active", g === "female");
    el.startBtn.disabled = false;
  }
  el.genderMaleBtn.addEventListener("click", function () {
    selectGender("male");
  });
  el.genderFemaleBtn.addEventListener("click", function () {
    selectGender("female");
  });

  el.startBtn.addEventListener("click", function () {
    if (!gender) return;
    clearError();
    el.startBtn.disabled = true;
    el.startBtn.textContent = "マイクを準備しています…";

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        mediaStream = stream;
        currentMidi = GENDER_START_MIDI[gender];
        el.screenIntro.hidden = true;
        el.screenPractice.hidden = false;
        updateTargetDisplay();
      })
      .catch(function (err) {
        el.startBtn.disabled = false;
        el.startBtn.textContent = "マイクを許可して測定を始める";
        showError(
          "マイクを使用できませんでした。ブラウザの設定でマイクの使用を許可してから、もう一度お試しください。"
        );
      });
  });

  // ==========================================================
  // 7. TARGET表示の更新
  // ==========================================================
  function isRangeCapped() {
    return currentMidi > MAX_MIDI;
  }

  // 録音ボタンの有効/無効を「音域の上限」と「マイクON/OFF」の両方から決める
  function updateRecordAvailability() {
    el.recordBtn.disabled = isRangeCapped() || !micEnabled;
  }

  function updateTargetDisplay() {
    if (isRangeCapped()) {
      el.targetDisplay.textContent = "--";
      el.playToneBtn.disabled = true;
      el.rangeCapNote.hidden = false;
      updateRecordAvailability();
      return;
    }
    el.rangeCapNote.hidden = true;
    el.playToneBtn.disabled = false;
    el.targetDisplay.textContent = midiToNoteLabel(currentMidi);
    updateRecordAvailability();
  }

  // ==========================================================
  // 7b. マイクのON/OFF切り替え
  // ==========================================================
  function setMicEnabled(enabled) {
    micEnabled = enabled;
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) {
        t.enabled = enabled;
      });
    }
    el.micToggleBtn.textContent = enabled ? "🎤 マイクをオフにする" : "🔇 マイクをオンにする";
    updateRecordAvailability();
  }

  el.micToggleBtn.addEventListener("click", function () {
    if (isRecording) return; // 録音中は切り替えさせない
    setMicEnabled(!micEnabled);
  });

  // ==========================================================
  // 8. 録音(MediaRecorder)
  // ==========================================================
  function pickSupportedMimeType() {
    var candidates = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg",
    ];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function extForMimeType(mime) {
    if (!mime) return "audio";
    if (mime.indexOf("mp4") !== -1) return "m4a";
    if (mime.indexOf("webm") !== -1) return "webm";
    if (mime.indexOf("ogg") !== -1) return "ogg";
    return "audio";
  }

  function startRecTimer() {
    recTimerStartedAt = Date.now();
    el.recTimer.hidden = false;
    el.recTimerValue.textContent = "0.0";
    recTimerIntervalId = setInterval(function () {
      var sec = (Date.now() - recTimerStartedAt) / 1000;
      el.recTimerValue.textContent = sec.toFixed(1);
    }, 100);
  }
  function stopRecTimer() {
    if (recTimerIntervalId !== null) {
      clearInterval(recTimerIntervalId);
      recTimerIntervalId = null;
    }
    el.recTimer.hidden = true;
  }

  function startRecording() {
    if (!mediaStream) return;
    if (!micEnabled) {
      showError("マイクがオフになっています。オンにしてから録音してください。");
      return;
    }
    if (!window.MediaRecorder) {
      showError("お使いのブラウザは録音に対応していません。");
      return;
    }
    clearError();

    var mimeType = pickSupportedMimeType();
    var options = mimeType ? { mimeType: mimeType } : undefined;

    try {
      mediaRecorder = options ? new MediaRecorder(mediaStream, options) : new MediaRecorder(mediaStream);
    } catch (e) {
      showError("録音を開始できませんでした: " + e.message);
      return;
    }

    recordedChunks = [];
    currentTakeMimeType = mediaRecorder.mimeType || mimeType || "audio/webm";

    mediaRecorder.ondataavailable = function (evt) {
      if (evt.data && evt.data.size > 0) recordedChunks.push(evt.data);
    };

    mediaRecorder.onstop = function () {
      var blob = new Blob(recordedChunks, { type: currentTakeMimeType });
      currentTakeBlob = blob;
      if (currentTakeUrl) URL.revokeObjectURL(currentTakeUrl);
      currentTakeUrl = URL.createObjectURL(blob);
      el.takeAudio.src = currentTakeUrl;
      el.takePreview.hidden = false;
    };

    mediaRecorder.start();
    isRecording = true;
    el.recordBtn.classList.add("recording");
    el.recordBtnLabel.textContent = "録音を終える";
    el.takePreview.hidden = true;
    el.playToneBtn.disabled = true;
    el.micToggleBtn.disabled = true;
    startRecTimer();
  }

  function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    mediaRecorder.stop();
    isRecording = false;
    el.recordBtn.classList.remove("recording");
    el.recordBtnLabel.textContent = "録音を開始する";
    el.playToneBtn.disabled = false;
    el.micToggleBtn.disabled = false;
    stopRecTimer();
  }

  el.recordBtn.addEventListener("click", function () {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  el.retakeBtn.addEventListener("click", function () {
    currentTakeBlob = null;
    el.takePreview.hidden = true;
    el.takeAudio.removeAttribute("src");
  });

  el.acceptBtn.addEventListener("click", function () {
    if (!currentTakeBlob) return;

    recordings.push({
      midi: currentMidi,
      label: midiToNoteLabel(currentMidi),
      blob: currentTakeBlob,
      mimeType: currentTakeMimeType,
    });

    currentTakeBlob = null;
    el.takePreview.hidden = true;
    el.takeAudio.removeAttribute("src");

    currentMidi += 1;
    updateTargetDisplay();
    renderRecordingsList();
  });

  // ==========================================================
  // 9. 録音済みリストの表示
  // ==========================================================
  function renderRecordingsList() {
    el.recCount.textContent = "これまでの録音: " + recordings.length + "件";
    el.recList.innerHTML = "";

    if (recordings.length === 0) {
      var empty = document.createElement("p");
      empty.className = "rec-empty";
      empty.textContent = "まだ録音はありません";
      el.recList.appendChild(empty);
      el.submitBtn.disabled = true;
      return;
    }

    el.submitBtn.disabled = false;

    recordings.forEach(function (rec, index) {
      var row = document.createElement("div");
      row.className = "rec-item";

      var noteSpan = document.createElement("span");
      noteSpan.className = "rec-item-note";
      noteSpan.textContent = rec.label;

      var audio = document.createElement("audio");
      audio.controls = true;
      audio.src = URL.createObjectURL(rec.blob);

      var delBtn = document.createElement("button");
      delBtn.className = "rec-item-del";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", function () {
        recordings.splice(index, 1);
        renderRecordingsList();
      });

      row.appendChild(noteSpan);
      row.appendChild(audio);
      row.appendChild(delBtn);
      el.recList.appendChild(row);
    });
  }

  // ==========================================================
  // 10. 提出(Google Apps Script経由でDriveへ)
  // ==========================================================
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        resolve(reader.result); // data:...;base64,xxxx
      };
      reader.onerror = function () {
        reject(reader.error);
      };
      reader.readAsDataURL(blob);
    });
  }

  el.submitBtn.addEventListener("click", function () {
    if (recordings.length === 0) return;
    clearError();

    if (!SUBMIT_ENDPOINT_URL || SUBMIT_ENDPOINT_URL.indexOf("PUT_YOUR_") === 0) {
      showError(
        "送信先が未設定です。Google Apps Scriptのデプロイ手順を確認して、app.js内のSUBMIT_ENDPOINT_URLを設定してください。"
      );
      return;
    }

    el.screenPractice.hidden = true;
    el.screenSubmitting.hidden = false;
    el.submittingSub.textContent = "しばらくお待ちください";

    var filePromises = recordings.map(function (rec, idx) {
      return blobToBase64(rec.blob).then(function (base64) {
        return {
          filename:
            gender + "_" + rec.label + "_take" + (idx + 1) + "." + extForMimeType(rec.mimeType),
          mimeType: rec.mimeType,
          base64: base64,
        };
      });
    });

    Promise.all(filePromises)
      .then(function (files) {
        var payload = {
          gender: gender,
          nickname: el.nicknameInput.value || "",
          contact: el.contactInput.value || "",
          submittedAt: new Date().toISOString(),
          notes: recordings.map(function (r) {
            return { midi: r.midi, label: r.label };
          }),
          files: files,
        };

        // Content-Typeを指定しない(=text/plainになる)ことで
        // ブラウザのCORSプリフライトを避け、Apps Script側でシンプルに
        // e.postData.contents として受け取れるようにする
        return fetch(SUBMIT_ENDPOINT_URL, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json && json.result === "success") {
          el.screenSubmitting.hidden = true;
          el.screenDone.hidden = false;
        } else {
          throw new Error((json && json.message) || "送信に失敗しました");
        }
      })
      .catch(function (err) {
        el.screenSubmitting.hidden = true;
        el.screenPractice.hidden = false;
        showError(
          "送信できませんでした。通信状況をご確認のうえ、もう一度「録音完了・提出する」を押してください。(" +
            err.message +
            ")"
        );
      });
  });

  // 初期表示
  renderRecordingsList();
})();
