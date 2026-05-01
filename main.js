import { WebSocketServer } from "ws";
import http from "http";

const server = http.createServer();

const wss = new WebSocketServer({ server });

let rooms = {};

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const msg = JSON.parse(data);

    // 部屋作成
    if (msg.type === "create") {
      const room = Math.random().toString(36).substring(2, 6);
      rooms[room] = [ws];
      ws.room = room;

      ws.send(JSON.stringify({
        type: "created",
        room: room
      }));
    }

    // 参加
    if (msg.type === "join") {
      if (rooms[msg.room]) {
        rooms[msg.room].push(ws);
        ws.room = msg.room;

        ws.send(JSON.stringify({ type: "joined" }));
      }
    }

    // メッセージ中継
    if (msg.type === "play") {
      const room = ws.room;
      if (!room) return;

      rooms[room].forEach(client => {
        if (client !== ws) {
          client.send(JSON.stringify({
            type: "play"
          }));
        }
      });
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(c => c !== ws);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("server started");
});
