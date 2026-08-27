# 21st  February

Source: https://app.notion.com/p/30b1199ccfe38074a332d45e445745e2



## 🌐 Client–Server Interaction Patterns (Sockets, SSE, Polling, etc.)

When a client (browser/mobile app) needs data from a server, they communicate using different **interaction patterns**.

Each pattern is designed based on **how frequently data changes** and **how real-time the experience needs to be**.

Let’s explore the most common ones with simple examples and **basic Node.js backend code**.

---

### 1️⃣ Request–Response (Traditional HTTP)

#### 📌 How it works

- Client sends a request.

- Server responds once.

- Connection closes.

- Client must request again for updates.

#### 📌 Best for

✔ Static or infrequently changing data

✔ Forms, page loads, CRUD APIs

#### 📌 Flow

```
Client → Request → Server → Response → Done
```

---

#### 🧑‍💻 Backend (Node.js + Express)

```
const express = require("express");
const app = express();

app.get("/time", (req, res) => {
  res.json({ time: new Date().toISOString() });
});

app.listen(3000, () => console.log("Server running on 3000"));
```

---

#### 🧑‍💻 Frontend (Browser)

```
fetch("http://localhost:3000/time")
  .then(res => res.json())
  .then(data => console.log(data));
```

---

### 2️⃣ Polling

#### 📌 How it works

Client repeatedly asks the server for updates at fixed intervals.

```
Client → Request → Server → Response
(wait)
Client → Request → Server → Response
(wait)
```

#### 📌 Best for

✔ Simple real-time updates

✔ When server cannot push data

#### 📌 Downside

❌ Many unnecessary requests

❌ Higher server load

---

#### 🧑‍💻 Backend (Node.js)

Same as request-response — no change needed.

```
app.get("/status", (req, res) => {
  res.json({ status: Math.random() > 0.5 ? "ON" : "OFF" });
});
```

---

#### 🧑‍💻 Frontend (Polling every 3 sec)

```
setInterval(async () => {
  const res = await fetch("/status");
  const data = await res.json();
  console.log("Status:", data.status);
}, 3000);
```

---

### 3️⃣ Long Polling

#### 📌 How it works

Client sends request → server holds it until data changes → responds → client immediately sends new request.

```
Client → Request → (Server waits)
Server → Response when data ready
Client → New request immediately
```

#### 📌 Best for

✔ Near real-time updates

✔ When WebSockets not available

---

#### 🧑‍💻 Backend (Node.js example)

```javascript
let clients = [];

app.get("/long-poll", (req, res) => {
  clients.push(res);
});

setInterval(() => {
  const data = { message: "New update " + Date.now() };
  clients.forEach(res => res.json(data));
  clients = [];
}, 5000);
```

---

#### 🧑‍💻 Frontend

```javascript
async function longPoll() {
  const res = await fetch("/long-poll");
  const data = await res.json();
  console.log(data);
  longPoll(); // request again
}

longPoll();
```

---

### 4️⃣ Server-Sent Events (SSE)

#### 📌 How it works

Server keeps connection open and continuously pushes updates to client.

✔ One-way communication (server → client only)

```
Client connects once
Server keeps sending events
```

#### 📌 Best for

✔ Live feeds

✔ Notifications

✔ Stock prices

---

#### 🧑‍💻 Backend (Node.js SSE)

```javascript
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  setInterval(() => {
    res.write(`data: ${JSON.stringify({ time: Date.now() })}\n\n`);
  }, 2000);
});
```

---

#### 🧑‍💻 Frontend

```javascript
const eventSource = new EventSource("/events");

eventSource.onmessage = (event) => {
  console.log("Server event:", JSON.parse(event.data));
};
```

---

### 5️⃣ WebSockets (Full Duplex)

#### 📌 How it works

Persistent connection where both client and server can send messages anytime.

✔ Two-way real-time communication

```
Client ⇄ Server (always connected)
```

#### 📌 Best for

✔ Chat apps

✔ Multiplayer games

✔ Live collaboration

---

#### 🧑‍💻 Backend (Node.js WebSocket)

Install:

```
npm install ws
```

```javascript
const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", ws => {
  console.log("Client connected");

  ws.on("message", msg => {
    console.log("Received:", msg.toString());
    ws.send("Server received: " + msg);
  });

  setInterval(() => {
    ws.send("Server push " + Date.now());
  }, 3000);
});
```

---

#### 🧑‍💻 Frontend

```
const socket = new WebSocket("ws://localhost:8080");

socket.onmessage = (event) => {
  console.log("Message:", event.data);
};

socket.onopen = () => {
  socket.send("Hello server!");
};
```

---

### 6️⃣ Comparison Summary

| Method | Direction | Real-time | Complexity | Use case |
| --- | --- | --- | --- | --- |
| Request-Response | Client → Server | ✅ | Very Low | APIs |
| Polling | Client → Server | ⚠️ Limited | Low | Simple updates |
| Long Polling | Mostly Server push | ✅ | Medium | Near real-time |
| SSE | Server → Client | ✅ | Low | Notifications |
| WebSockets | Two-way | ✅ Real-time | High | Chat, games |
|  |  |  |  |  |



## 📊 Observability & Monitoring — Frontend System Design

---

### 🎯 Why Observability Matters in Frontend

Frontend runs on **user devices**, not controlled servers.

That means:
