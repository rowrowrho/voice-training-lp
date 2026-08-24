/* ============================================================
   pitch-detector.js
   RHO 音域診断 Phase1 - MVP
   ------------------------------------------------------------
   このファイルは「音程検出ロジック」だけを扱う。
   DOM操作・UI描画は一切行わない（app.js側の責務）。

   含まれるもの:
     - CONFIG（調整可能な定数を一箇所に集約）
     - Hz → MIDI → 音名 変換
     - cents計算（最も近い音 / TARGETとの差）
     - YINアルゴリズムによる基本周波数(F0)推定
     - PitchTracker クラス
         - 生F0の受け取り
         - スムージング（メディアン→EMA）
         - TARGET判定（HIGH/LOW modeのcents範囲）
         - 1秒維持判定（実時間ベース）
   ============================================================ */

(function (global) {
  "use strict";

  // ------------------------------------------------------------
  // 1. 調整可能な定数（プロンプト仕様20番に対応）
  //    ここだけを触れば全体の挙動を調整できるようにする。
  // ------------------------------------------------------------
  const CONFIG = {
    A4_REFERENCE: 440,        // 基準周波数(Hz)

    HIGH_MIN_CENTS: -60,      // HIGH MODE有効範囲の下限（TARGETからの差）
    HIGH_MAX_CENTS: 150,      // HIGH MODE有効範囲の上限
    LOW_MIN_CENTS: -150,      // LOW MODE有効範囲の下限
    LOW_MAX_CENTS: 60,        // LOW MODE有効範囲の上限

    HOLD_DURATION_MS: 1000,   // 連続維持でCLEARとなるまでの時間(ms)

    MIN_MIDI: 36,              // C2 = MIDI 36 （検出対象の下限）
    MAX_MIDI: 96,              // C7 = MIDI 96 （検出対象の上限）

    // 入力レベル（RMS, -1〜1のfloatサンプルに対する値）
    // この値未満は「無音」として扱う。実機で調整すること。
    INPUT_LEVEL_THRESHOLD: 0.015,

    // YINアルゴリズムの絶対しきい値。小さいほど厳密（誤検出は減るが感度も下がる）
    YIN_THRESHOLD: 0.15,

    // YINの積分ウィンドウ長（サンプル数）。大きいほど低音の検出精度は上がるが
    // 処理負荷とレイテンシが増える。
    YIN_WINDOW_SIZE: 2048,

    // AnalyserNodeから読み出すバッファ長（= fftSize）。
    // YIN_WINDOW_SIZE + 最大ラグ(=sampleRate/最低周波数) を余裕を持って収める必要がある。
    FFT_SIZE: 4096,

    // スムージング関連
    MEDIAN_WINDOW_SIZE: 8,     // 中央値フィルタのウィンドウ（オクターブ誤検出の単発ノイズを除去）
    SMOOTHING_PARAMETER: 0.15, // EMA(指数移動平均)の係数。大きいほど追従が速い（0〜1）

    // 直前の音から整数オクターブ(±この許容量, 単位:オクターブ)に近い値が
    // 来た場合、直前と同じオクターブに引き戻す（倍音による誤検出の対策）
    // 値を大きくするほど「緩く」補正がかかりやすくなる
    OCTAVE_CORRECTION_TOLERANCE: 0.35,
  };

  const NOTE_NAMES = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
  ];

  // ------------------------------------------------------------
  // 2. Hz ⇔ MIDI ⇔ 音名 変換 / cents計算
  // ------------------------------------------------------------

  // Hz -> MIDIノート番号（小数を含む。A4=69, 440Hz基準）
  function hzToMidi(hz) {
    return 69 + 12 * Math.log2(hz / CONFIG.A4_REFERENCE);
  }

  // MIDIノート番号(整数) -> Hz
  function midiToHz(midi) {
    return CONFIG.A4_REFERENCE * Math.pow(2, (midi - 69) / 12);
  }

  // MIDIノート番号(整数) -> {name, octave}
  // 表記はC3=真ん中のドに近いミュージックソフトウェア慣習（C4=261.6Hz）に合わせる
  function midiToNoteName(midi) {
    const rounded = Math.round(midi);
    const noteIndex = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    return { name: NOTE_NAMES[noteIndex], octave, midi: rounded };
  }

  // 周波数 -> 最も近い12平均律音との差(cents) と、その音の情報
  function nearestNoteInfo(hz) {
    const midiFloat = hzToMidi(hz);
    const nearestMidi = Math.round(midiFloat);
    const cents = (midiFloat - nearestMidi) * 100;
    const noteInfo = midiToNoteName(nearestMidi);
    return {
      name: noteInfo.name,
      octave: noteInfo.octave,
      midi: nearestMidi,
      cents: cents,
    };
  }

  // 2つの周波数間のcents差（f1がf2に対して何cents高いか）
  function centsBetween(f1, f2) {
    return 1200 * Math.log2(f1 / f2);
  }

  // "C4"のような表記 -> MIDIノート番号
  function noteStringToMidi(noteString) {
    const match = /^([A-G]#?)(-?\d+)$/.exec(noteString);
    if (!match) return null;
    const [, name, octaveStr] = match;
    const noteIndex = NOTE_NAMES.indexOf(name);
    if (noteIndex === -1) return null;
    const octave = parseInt(octaveStr, 10);
    return (octave + 1) * 12 + noteIndex;
  }

  // C2〜C7の範囲で選択可能な半音リストを生成（UIのTARGETセレクト用）
  function generateTargetNoteList() {
    const list = [];
    for (let midi = CONFIG.MIN_MIDI; midi <= CONFIG.MAX_MIDI; midi++) {
      const info = midiToNoteName(midi);
      list.push({
        midi,
        label: `${info.name}${info.octave}`,
        frequency: midiToHz(midi),
      });
    }
    return list;
  }

  // ------------------------------------------------------------
  // 3. RMS（入力レベル）計算
  // ------------------------------------------------------------
  function computeRMS(buffer) {
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      sumSquares += buffer[i] * buffer[i];
    }
    return Math.sqrt(sumSquares / buffer.length);
  }

  // ------------------------------------------------------------
  // 4. YINアルゴリズムによるF0推定
  //    参考: de Cheveigné & Kawahara (2002), "YIN, a fundamental
  //    frequency estimator for speech and music"
  //
  //    単純なFFTピーク検出は倍音を基音と誤認しやすい（オクターブエラー）。
  //    YINは自己相関ベースの手法に正規化・絶対しきい値・放物線補間を
  //    組み合わせることでオクターブエラーを抑えつつ精度を確保する。
  //
  //    探索するラグ(tau)の範囲は MIN_MIDI/MAX_MIDI から算出される
  //    周波数レンジに限定し、計算量を抑える。
  // ------------------------------------------------------------
  function yinDetect(buffer, sampleRate, config) {
    config = config || CONFIG;
    const W = config.YIN_WINDOW_SIZE;

    const minFrequency = midiToHz(config.MIN_MIDI);
    const maxFrequency = midiToHz(config.MAX_MIDI);

    const maxTau = Math.min(
      Math.floor(sampleRate / minFrequency),
      buffer.length - W - 1
    );
    const minTau = Math.max(1, Math.floor(sampleRate / maxFrequency));

    if (maxTau <= minTau || buffer.length < W + maxTau) {
      return null; // バッファ不足（設定不整合）
    }

    // --- Step 1+2: 差分関数 d(tau) と 累積平均正規化差分関数 d'(tau) ---
    const d = new Float32Array(maxTau + 1);
    d[0] = 1;

    let runningSum = 0;

    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const diff = buffer[j] - buffer[j + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
      runningSum += sum;
      d[tau] = runningSum === 0 ? 1 : (sum * tau) / runningSum;
    }

    // --- Step 3: 絶対しきい値を満たす最初のlocal minimumを探す ---
    let tauEstimate = -1;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (d[tau] < config.YIN_THRESHOLD) {
        // このtau以降でさらに下がる（より良い）局所最小があれば採用
        while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate === -1) {
      // しきい値を満たすtauが無い = 明確なピッチが見つからない
      return null;
    }

    // --- Step 4: 放物線補間でtauをサブサンプル精度に補正 ---
    let betterTau = tauEstimate;
    const x0 = tauEstimate < 1 ? tauEstimate : tauEstimate - 1;
    const x2 = tauEstimate + 1 <= maxTau ? tauEstimate + 1 : tauEstimate;
    if (x0 !== tauEstimate && x2 !== tauEstimate) {
      const s0 = d[x0];
      const s1 = d[tauEstimate];
      const s2 = d[x2];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) {
        betterTau = tauEstimate + (s2 - s0) / denom;
      }
    }

    if (betterTau <= 0) return null;

    const frequency = sampleRate / betterTau;
    const confidence = 1 - d[tauEstimate]; // 0〜1、高いほど信頼できる

    if (frequency < minFrequency * 0.9 || frequency > maxFrequency * 1.1) {
      return null; // 検出対象レンジから明らかに外れている
    }

    return { frequency, confidence };
  }

  // ------------------------------------------------------------
  // 5. PitchTracker
  //    フレーム単位で呼び出し、スムージング・TARGET判定・
  //    保持時間判定までをまとめて面倒みる状態オブジェクト。
  // ------------------------------------------------------------
  class PitchTracker {
    constructor(config) {
      this.config = config || CONFIG;
      this.mode = "HIGH"; // "HIGH" | "LOW"
      this.targetMidi = 57; // デフォルト A3
      this.targetFrequency = midiToHz(this.targetMidi);

      this._medianBuffer = []; // log2(Hz)のバッファ（中央値フィルタ用）
      this._smoothedLogFreq = null; // EMA後のlog2(Hz)

      this._holdStartTime = null; // performance.now()、有効範囲に入った時刻
      this._heldMs = 0;
      this._cleared = false;
    }

    setTarget(midi) {
      this.targetMidi = midi;
      this.targetFrequency = midiToHz(midi);
      this.resetHold();
    }

    setMode(mode) {
      this.mode = mode === "LOW" ? "LOW" : "HIGH";
      this.resetHold();
    }

    resetHold() {
      this._holdStartTime = null;
      this._heldMs = 0;
      this._cleared = false;
    }

    _pushMedianBuffer(logFreq) {
      this._medianBuffer.push(logFreq);
      if (this._medianBuffer.length > this.config.MEDIAN_WINDOW_SIZE) {
        this._medianBuffer.shift();
      }
    }

    _medianOfBuffer() {
      const sorted = [...this._medianBuffer].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
      }
      return sorted[mid];
    }

    /**
     * 1フレーム分の生データを処理する。
     * @param {number|null} rawFrequency  YIN等で検出された生F0（無音/未検出ならnull）
     * @param {number} rms 入力レベル
     * @param {number} nowMs performance.now() 相当の現在時刻(ms)
     * @returns {object} UI表示に必要な情報一式
     */
    update(rawFrequency, rms, nowMs) {
      const cfg = this.config;
      const isSilent = rms < cfg.INPUT_LEVEL_THRESHOLD;
      const hasPitch = !isSilent && rawFrequency !== null && !isNaN(rawFrequency);

      let smoothedFrequency = null;
      let nearest = null;
      let targetCents = null;
      let inRange = false;

      if (hasPitch) {
        let logFreq = Math.log2(rawFrequency);

        // --- オクターブ補正 ---
        // 直前のスムージング値から見て「整数オクターブ分」ズレている場合、
        // 倍音による誤検出とみなして直前と同じオクターブに引き戻す。
        // (1オクターブだけでなく2オクターブのズレにも対応)
        if (this._smoothedLogFreq !== null) {
          const diff = logFreq - this._smoothedLogFreq;
          const nearestOctaveStep = Math.round(diff);
          if (
            nearestOctaveStep !== 0 &&
            Math.abs(diff - nearestOctaveStep) < cfg.OCTAVE_CORRECTION_TOLERANCE
          ) {
            logFreq -= nearestOctaveStep;
          }
        }

        this._pushMedianBuffer(logFreq);
        const medianLogFreq = this._medianOfBuffer();

        if (this._smoothedLogFreq === null) {
          this._smoothedLogFreq = medianLogFreq;
        } else {
          const alpha = cfg.SMOOTHING_PARAMETER;
          this._smoothedLogFreq =
            this._smoothedLogFreq * (1 - alpha) + medianLogFreq * alpha;
        }

        smoothedFrequency = Math.pow(2, this._smoothedLogFreq);
        nearest = nearestNoteInfo(smoothedFrequency);
        targetCents = centsBetween(smoothedFrequency, this.targetFrequency);

        const minCents =
          this.mode === "HIGH" ? cfg.HIGH_MIN_CENTS : cfg.LOW_MIN_CENTS;
        const maxCents =
          this.mode === "HIGH" ? cfg.HIGH_MAX_CENTS : cfg.LOW_MAX_CENTS;
        inRange = targetCents >= minCents && targetCents <= maxCents;
      } else {
        // 無音/未検出フレームでは中央値バッファをクリアして
        // 直前の値を引きずらないようにする（次の発声で素早く追従するため）
        this._medianBuffer = [];
        this._smoothedLogFreq = null;
      }

      // --- 保持時間（実時間ベース） ---
      let state = "NO_PITCH";
      if (hasPitch) {
        if (inRange) {
          if (this._holdStartTime === null) {
            this._holdStartTime = nowMs;
          }
          this._heldMs = nowMs - this._holdStartTime;
          if (this._heldMs >= cfg.HOLD_DURATION_MS) {
            this._cleared = true;
            state = "CLEAR";
          } else {
            state = "HOLDING";
          }
        } else {
          this._holdStartTime = null;
          this._heldMs = 0;
          this._cleared = false;
          state = "OUT_OF_RANGE";
        }
      } else {
        this._holdStartTime = null;
        this._heldMs = 0;
        this._cleared = false;
        state = "NO_PITCH";
      }

      return {
        hasPitch,
        rawFrequency,
        smoothedFrequency,
        nearestNote: nearest, // {name, octave, midi, cents} | null
        targetMidi: this.targetMidi,
        targetFrequency: this.targetFrequency,
        targetCents, // TARGETとの差(cents) | null
        mode: this.mode,
        heldMs: this._heldMs,
        holdDurationMs: cfg.HOLD_DURATION_MS,
        cleared: this._cleared,
        state, // "NO_PITCH" | "OUT_OF_RANGE" | "HOLDING" | "CLEAR"
        rms,
      };
    }
  }

  // ------------------------------------------------------------
  // 6. 公開API
  // ------------------------------------------------------------
  global.PitchLib = {
    CONFIG,
    NOTE_NAMES,
    hzToMidi,
    midiToHz,
    midiToNoteName,
    nearestNoteInfo,
    centsBetween,
    noteStringToMidi,
    generateTargetNoteList,
    computeRMS,
    yinDetect,
    PitchTracker,
  };
})(typeof window !== "undefined" ? window : globalThis);
