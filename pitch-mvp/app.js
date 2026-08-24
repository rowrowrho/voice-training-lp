(function () {
  "use strict";

  var micButton = document.getElementById("micButton");

  if (!micButton) {
    alert("エラー: micButtonという要素が見つかりません。index.htmlのbutton idを確認してください。");
    return;
  }

  micButton.addEventListener("click", function () {
    alert("ステップ1: ボタンのクリックイベントは発火しています。");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("ステップ2で失敗: getUserMediaが使えません。");
      return;
    }
    alert("ステップ2: getUserMediaは使えます。マイクをリクエストします。");

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        alert("ステップ3: マイク取得成功！");
        stream.getTracks().forEach(function (t) { t.stop(); });
      })
      .catch(function (err) {
        alert("ステップ3で失敗: " + err.name + " - " + err.message);
      });
  });

  alert("app.js読み込み完了。ボタンにイベントを登録しました。");
})();
