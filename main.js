let ws;

function getWS(){
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return protocol + "://" + location.host;
}

function connect(){
  ws = new WebSocket(getWS());

  ws.onmessage = (e)=>{
    const msg = JSON.parse(e.data);

    if(msg.type==='created'){
      document.getElementById("info").innerText="コード:"+msg.room;
    }

    if(msg.type==='play'){
      document.getElementById("field").innerText="相手がカード出した";
    }
  };
}

function createRoom(){
  connect();
  ws.onopen=()=>{
    ws.send(JSON.stringify({type:'create'}));
  };
}

function joinRoom(){
  connect();
  const room = document.getElementById("roomInput").value;

  ws.onopen=()=>{
    ws.send(JSON.stringify({
      type:'join',
      room: room
    }));
  };
}
