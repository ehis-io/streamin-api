const { io } = require("socket.io-client");

const socket = io("http://localhost:4001", {
  transports: ["websocket"],
});

socket.on("connect", () => {
  console.log("Connected to WebSocket");
  // Test movie Deadpool & Wolverine
  socket.emit("find-streams", {
    id: "1241470",
    type: "sub",
    mediaType: "movie",
    requestId: "test"
  });
});

socket.on("stream-resolved", (data) => {
  console.log("Stream Resolved:", data);
  if (data.isM3U8) {
      console.log("SUCCESS! HLS M3U8 found.");
      process.exit(0);
  }
});

socket.on("streams-complete", () => {
  console.log("Stream search completed");
  process.exit(1);
});

socket.on("connect_error", (err) => {
  console.log("Connect Error:", err);
  process.exit(1);
});
