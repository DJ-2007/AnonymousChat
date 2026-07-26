(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  // DOM Elements
  const loginOverlay = $("#login-overlay");
  const dashboard = $("#dashboard");
  const loginForm = $("#login-form");
  const passwordInput = $("#password");
  const loginError = $("#login-error");

  const statTotal = $("#stat-total");
  const statOnline = $("#stat-online");
  const statChats = $("#stat-chats");
  const statSearching = $("#stat-searching");
  const statIdle = $("#stat-idle");

  const broadcastForm = $("#broadcast-form");
  const broadcastMsgInput = $("#broadcast-msg");
  const btnDisconnectAll = $("#btn-disconnect-all");

  let ws = null;
  let pingInterval = null;

  // Handle Login Form Submit
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pwd = passwordInput.value;
    if (!pwd) return;

    loginError.classList.add("hidden");
    connectWebSocket(pwd);
  });

  function connectWebSocket(password) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      // Attempt login
      ws.send(JSON.stringify({ type: "admin_login", password }));

      // Keep connection alive
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    ws.onclose = () => {
      if (pingInterval) clearInterval(pingInterval);
      if (!dashboard.classList.contains("hidden")) {
        alert("Disconnected from server. Please refresh to reconnect.");
      }
    };

    ws.onerror = () => {
      showError("Connection failed. Is the server running?");
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "admin_login_success":
        showDashboard();
        break;
      
      case "admin_login_fail":
        showError(msg.message || "Invalid password");
        if (ws) ws.close();
        break;

      case "admin_stats":
        updateStats(msg);
        break;
    }
  }

  function showDashboard() {
    loginOverlay.classList.add("hidden");
    dashboard.classList.remove("hidden");
  }

  function showError(text) {
    loginError.textContent = text;
    loginError.classList.remove("hidden");
  }

  function updateStats(stats) {
    if (statTotal) statTotal.textContent = stats.totalAllTime || 0;
    statOnline.textContent = stats.online;
    statChats.textContent = stats.activeChats;
    statSearching.textContent = stats.searching;
    statIdle.textContent = stats.idle;
  }

  // Handle Broadcast
  broadcastForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = broadcastMsgInput.value.trim();
    if (!message || !ws) return;

    ws.send(JSON.stringify({ type: "admin_broadcast", message }));
    broadcastMsgInput.value = "";
    
    // Quick confirmation
    const btn = broadcastForm.querySelector("button");
    const originalText = btn.textContent;
    btn.textContent = "Sent!";
    setTimeout(() => { btn.textContent = originalText; }, 2000);
  });

  // Handle Disconnect All
  btnDisconnectAll.addEventListener("click", () => {
    const confirm = window.confirm("Are you SURE you want to disconnect ALL users? This action cannot be undone.");
    if (confirm && ws) {
      ws.send(JSON.stringify({ type: "admin_disconnect_all" }));
    }
  });

})();
