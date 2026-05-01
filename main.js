const ws = new WebSocket("wss://4peace-server-vw1ezw.fly.dev");

let room = null;

// 接続成功
ws.onopen = () => {
  console.log("connected to server");
};

// メッセージ受信
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "created") {
    room = msg.room;
    alert("部屋作成: " + room);
  }

  if (msg.type === "joined") {
    alert("参加成功！");
  }

  if (msg.type === "play") {
    alert("相手が押した！");
  }
};

// 部屋作成
function createRoom() {
  ws.send(JSON.stringify({ type: "create" }));
}

// 部屋参加
function joinRoom() {
  const input = document.getElementById("roomInput");
  ws.send(JSON.stringify({
    type: "join",
    room: input.value
  }));
}

// ボタン押す
function play() {
  ws.send(JSON.stringify({ type: "play" }));
}
