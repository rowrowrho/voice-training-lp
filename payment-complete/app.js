/* ============================================================
   payment-complete.js
   Stripeの支払いリンクから戻ってきた後、Apps Script経由で
   本当に支払いが完了しているかをサーバー側で確認し、
   結果をlocalStorageに書き込んで元のタブに知らせる。
   ------------------------------------------------------------
   ・async/awaitは使わず.then()で書く(iOS Safari対策)
   ============================================================ */

(function () {
  "use strict";

  // range-recorder/app.js の SUBMIT_ENDPOINT_URL と同じURLを指定してください
  var VERIFY_ENDPOINT_URL = "PUT_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";

  // app.js側と共通のlocalStorageキー
  var PAYMENT_STORAGE_KEY = "rho_range_recorder_payment";

  var spinner = document.getElementById("spinner");
  var titleEl = document.getElementById("statusTitle");
  var subEl = document.getElementById("statusSub");

  function setDone(title, sub) {
    if (spinner) spinner.style.display = "none";
    titleEl.textContent = title;
    subEl.textContent = sub;
  }

  function getQueryParam(name) {
    var params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  var sessionId = getQueryParam("session_id");

  if (!sessionId) {
    setDone(
      "決済情報が見つかりません",
      "決済リンクから正しく戻ってきているかご確認ください。"
    );
  } else if (!VERIFY_ENDPOINT_URL || VERIFY_ENDPOINT_URL.indexOf("PUT_YOUR_") === 0) {
    setDone("設定エラー", "確認先のURLが未設定です。payment-complete.js内のVERIFY_ENDPOINT_URLを設定してください。");
  } else {
    fetch(VERIFY_ENDPOINT_URL + "?action=verify_payment&session_id=" + encodeURIComponent(sessionId))
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json && json.paid) {
          try {
            window.localStorage.setItem(
              PAYMENT_STORAGE_KEY,
              JSON.stringify({ sessionId: sessionId, confirmedAt: Date.now() })
            );
          } catch (e) {}
          setDone(
            "お支払いを確認しました ✅",
            "このタブは閉じて大丈夫です。録音していたタブに戻って「提出する」を押してください。"
          );
        } else {
          setDone(
            "お支払いを確認できませんでした",
            (json && json.message) || "少し時間をおいてから、このページを再読み込みしてみてください。"
          );
        }
      })
      .catch(function () {
        setDone(
          "通信エラーが発生しました",
          "通信状況をご確認のうえ、このページを再読み込みしてください。"
        );
      });
  }
})();
