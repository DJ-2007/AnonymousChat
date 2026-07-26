// ============================================================
// app.js — AnonymousChat: Omegle-Style 1-on-1 Encrypted Client
// ============================================================
// State machine: idle → searching → paired → idle/searching
// Fresh ECDH key pair per pairing for forward secrecy.
// ============================================================

(function () {
  "use strict";

  // ────────────────────────────────────────────────────────────
  // DOM
  // ────────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);

  const splashScreen      = $("#splash-screen");
  const splashStatus      = $("#splash-status");
  const chatApp           = $("#chat-app");
  const searchingOverlay  = $("#searching-overlay");
  const idleOverlay       = $("#idle-overlay");
  const chatArea          = $("#chat-area");
  const messagesEl        = $("#messages");
  const messagesContainer = $("#messages-container");
  const chatForm          = $("#chat-form");
  const messageInput      = $("#message-input");
  const sendBtn           = $("#send-btn");
  const charCount         = $("#char-count");
  const connectionStatus  = $("#connection-status");
  const onlineCountEl     = $("#online-count");
  const btnSkip           = $("#btn-skip");
  const btnAddFriend      = $("#btn-add-friend");
  const btnEnd            = $("#btn-end");
  const btnNewChat        = $("#btn-new-chat");
  const btnFriendsList    = $("#btn-friends-list");
  const btnFriendsHeader  = $("#btn-friends-list-header");
  const btnCancelSearch   = $("#btn-cancel-search");
  const toastContainer    = $("#toast-container");
  const particlesEl       = $("#particles");

  // Modals
  const friendsModal        = $("#friends-modal");
  const btnCloseFriends     = $("#btn-close-friends");
  const friendsListContainer= $("#friends-list-container");
  const incomingCallModal   = $("#incoming-call-modal");
  const btnRejectCall       = $("#btn-reject-call");
  const btnAcceptCall       = $("#btn-accept-call");
  const nicknameModal       = $("#nickname-modal");
  const nicknameInput       = $("#nickname-input");
  const btnSaveNickname     = $("#btn-save-nickname");
  const btnCancelNickname   = $("#btn-cancel-nickname");

  // Image Attach Elements
  const attachBtn           = $("#attach-btn");
  const attachMenu          = $("#attach-menu");
  const attachGallery       = $("#attach-gallery");
  const attachCamera        = $("#attach-camera");
  const fileGallery         = $("#file-gallery");
  const fileCamera          = $("#file-camera");
  const imagePreviewStrip   = $("#image-preview-strip");
  const imagePreviewImg     = $("#image-preview-img");
  const imagePreviewRemove  = $("#image-preview-remove");
  const typingIndicator     = $("#typing-indicator");

  // ────────────────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────────────────
  let ws             = null;
  let myKeyPair      = null;   // Current ECDH key pair
  let myPublicKeyJwk = null;   // Exported public key (JWK)
  let sharedKey      = null;   // Derived AES-256-GCM key
  let appState       = "idle"; // idle | searching | paired
  let pendingImage   = null;   // base64 data URL of selected image
  let typingTimeout  = null;
  let isTyping       = false;
  let pingInterval   = null;
  let friendsPolling = null;
  let incomingCallCode = null; // Store who is calling
  let currentPartnerCode = null; // Stranger's friend code

  // ── Anonymous Identity ──
  let myFriendCode = null;
  const urlParams = new URLSearchParams(window.location.search);
  const forceCode = urlParams.get('test_user');

  try {
    if (forceCode) {
      myFriendCode = forceCode;
    } else {
      myFriendCode = localStorage.getItem("myFriendCode");
      if (!myFriendCode) {
        myFriendCode = Math.random().toString(36).substring(2, 10).toUpperCase();
        localStorage.setItem("myFriendCode", myFriendCode);
      }
    }
  } catch (e) {
    // Fallback for Incognito mode / Strict Privacy where localStorage throws
    myFriendCode = forceCode || Math.random().toString(36).substring(2, 10).toUpperCase();
  }
  
  function getSavedFriends() {
    try {
      return JSON.parse(localStorage.getItem("savedFriends")) || [];
    } catch { return []; }
  }
  function saveFriend(code, nickname) {
    try {
      const friends = getSavedFriends();
      if (!friends.find(f => f.code === code)) {
        friends.push({ code, nickname: nickname || `Stranger ${code}` });
        localStorage.setItem("savedFriends", JSON.stringify(friends));
      }
    } catch (e) {
      showToast("Could not save friend (Storage disabled)", true);
    }
  }
  function removeFriend(code) {
    try {
      let friends = getSavedFriends();
      friends = friends.filter(f => f.code !== code);
      localStorage.setItem("savedFriends", JSON.stringify(friends));
    } catch (e) {}
  }
  function updateFriendNickname(code, nickname) {
    try {
      const friends = getSavedFriends();
      const f = friends.find(f => f.code === code);
      if (f) {
        f.nickname = nickname;
        localStorage.setItem("savedFriends", JSON.stringify(friends));
      }
    } catch (e) {}
  }

  // ────────────────────────────────────────────────────────────
  // Particles (splash background)
  // ────────────────────────────────────────────────────────────
  function createParticles() {
    for (let i = 0; i < 40; i++) {
      const p = document.createElement("div");
      p.className = "particle";
      p.style.left = Math.random() * 100 + "%";
      p.style.animationDuration = (4 + Math.random() * 8) + "s";
      p.style.animationDelay = Math.random() * 5 + "s";
      p.style.width = p.style.height = (2 + Math.random() * 3) + "px";
      p.style.opacity = 0.1 + Math.random() * 0.3;
      particlesEl.appendChild(p);
    }
  }
  createParticles();

  // ────────────────────────────────────────────────────────────
  // Crypto: ECDH + AES-256-GCM (Web Crypto API)
  // ────────────────────────────────────────────────────────────

  async function generateKeyPair() {
    return await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
  }

  async function exportPublicKey(key) {
    return await crypto.subtle.exportKey("jwk", key);
  }

  async function importPublicKey(jwk) {
    return await crypto.subtle.importKey(
      "jwk", jwk,
      { name: "ECDH", namedCurve: "P-256" },
      true, []
    );
  }

  async function deriveSharedKey(privateKey, publicKey) {
    return await crypto.subtle.deriveKey(
      { name: "ECDH", public: publicKey },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptMessage(plaintext, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    return {
      ciphertext: arrayBufferToBase64(encrypted),
      iv: arrayBufferToBase64(iv),
    };
  }

  async function decryptMessage(ciphertextB64, ivB64, key) {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToArrayBuffer(ivB64) },
      key,
      base64ToArrayBuffer(ciphertextB64)
    );
    return new TextDecoder().decode(decrypted);
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Generate a fresh key pair (called on each new pairing)
  async function refreshKeys() {
    myKeyPair = await generateKeyPair();
    myPublicKeyJwk = await exportPublicKey(myKeyPair.publicKey);
    sharedKey = null;
  }

  // ────────────────────────────────────────────────────────────
  // Init
  // ────────────────────────────────────────────────────────────
  async function init() {
    // Basic browser checks
    if (!window.crypto || !window.crypto.subtle) {
      splashStatus.textContent = "Error: Secure Context Required (HTTPS or Localhost)";
      splashStatus.style.color = "var(--red)";
      alert("Your browser does not support Web Crypto API (requires HTTPS or Localhost). Chat will not work.");
      return;
    }

    try {
      splashStatus.textContent = "Generating encryption keys…";
      await refreshKeys();

      splashStatus.textContent = "Connecting to server…";
      await connectWebSocket();
    } catch (err) {
      splashStatus.textContent = "Error: " + err.message;
      console.error("Init error:", err);
    }
  }

  function connectWebSocket() {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${location.host}`);

      ws.onopen = () => {
        splashStatus.textContent = "Connected!";
        
        // Register our identity
        wsSend({ type: "register_friend_code", code: myFriendCode });

        resolve();
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 30000);
      };

      ws.onclose = () => {
        if (pingInterval) clearInterval(pingInterval);
        showToast("Disconnected. Refresh to reconnect.", true);
        setStatus("Disconnected", "");
        sendBtn.disabled = true;
      };

      ws.onerror = () => reject(new Error("Connection failed"));

      ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
    });
  }

  // ────────────────────────────────────────────────────────────
  // Message Handler
  // ────────────────────────────────────────────────────────────
  async function handleMessage(msg) {
    switch (msg.type) {

      // ── Welcome (initial connection) ────────────────────
      case "welcome":
        splashStatus.textContent = "Looking for a stranger…";
        updateOnlineCount(msg.onlineCount);
        setTimeout(() => {
          splashScreen.classList.add("hidden");
          chatApp.classList.remove("hidden");
        }, 600);
        break;

      // ── Searching for partner ───────────────────────────
      case "searching":
        appState = "searching";
        sharedKey = null;
        showSearching();
        updateOnlineCount(msg.onlineCount);
        break;

      // ── Partner found ───────────────────────────────────
      case "partner_found":
        appState = "paired";
        currentPartnerCode = msg.partnerCode;
        
        // Check if user connected to their own second tab (same browser = same localStorage friendCode)
        if (currentPartnerCode === myFriendCode) {
          btnAddFriend.disabled = true;
          btnAddFriend.textContent = "You (Same Browser)";
          btnAddFriend.style.color = "var(--text-secondary)";
          btnAddFriend.style.background = "transparent";
          btnAddFriend.style.borderColor = "var(--border-light)";
        } else {
          // Reset Add Friend button
          btnAddFriend.disabled = false;
          btnAddFriend.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            Add Friend
          `;
          btnAddFriend.style.color = "";
          btnAddFriend.style.background = "";
          btnAddFriend.style.borderColor = "";
        }

        // Generate fresh keys for this session (forward secrecy)
        await refreshKeys();

        showChatArea();
        clearMessages();
        appendSystem("Messages are end-to-end encrypted. Say hi!");

        // Send our public key to partner
        wsSend({ type: "public_key", publicKey: myPublicKeyJwk });
        break;

      // ── Partner's public key received ───────────────────
      case "public_key":
        try {
          const theirKey = await importPublicKey(msg.publicKey);
          sharedKey = await deriveSharedKey(myKeyPair.privateKey, theirKey);
        } catch (e) {
          console.error("Key exchange failed:", e);
          appendError("Encryption setup failed.");
        }
        break;

      // ── Incoming chat message (from partner) ────────────
      case "chat":
        await renderIncoming(msg);
        break;

      // ── Echo of our own message ─────────────────────────
      case "chat_self":
        await renderSelf(msg);
        break;

      // ── Partner disconnected ────────────────────────────
      case "partner_disconnected":
        appState = "idle";
        sharedKey = null;
        
        // STRICT EPHEMERALITY: Instantly destroy all photos when partner leaves
        document.querySelectorAll('.msg-image').forEach(img => img.remove());
        
        appendSystemRed("Stranger has disconnected. All photos destroyed.");
        disableInput();
        // Show the "New Chat" and "Skip" option after a moment
        setTimeout(() => showPartnerLeftOptions(), 500);
        break;
        
      // ── Anonymous Friends ───────────────────────────────
      case "friends_status":
        renderFriendsList(msg.statuses);
        break;

      case "incoming_call":
        incomingCallCode = msg.callerCode;
        incomingCallModal.classList.remove("hidden");
        break;

      case "call_ringing":
        appState = "searching";
        showSearching();
        break;

      case "call_rejected":
        showToast("Your friend declined the call.", "error");
        wsSend({ type: "find_partner" });
        break;

      // ── Chat ended (by us) ─────────────────────────────
      case "chat_ended":
        appState = "idle";
        sharedKey = null;
        showIdle();
        break;

      // ── Online count update ─────────────────────────────
      case "online_count":
        updateOnlineCount(msg.count);
        break;

      // ── Error ───────────────────────────────────────────
      case "error":
        appendError(msg.message);
        showToast(msg.message, true);
        break;

      case "typing":
        if (typingIndicator) typingIndicator.classList.remove("hidden");
        scrollToBottom();
        break;

      case "stopped_typing":
        if (typingIndicator) typingIndicator.classList.add("hidden");
        break;

      // ── System Broadcast ────────────────────────────────
      case "system_broadcast":
        appendSystemRed(`📢 SYSTEM: ${msg.message}`);
        showToast(msg.message);
        break;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Render messages
  // ────────────────────────────────────────────────────────────
  async function renderIncoming(msg) {
    let text = null;
    let imageUrl = null;
    if (sharedKey && msg.encrypted && msg.iv) {
      try {
        const decryptedStr = await decryptMessage(msg.encrypted, msg.iv, sharedKey);
        const parsed = JSON.parse(decryptedStr);
        text = parsed.text;
        imageUrl = parsed.image;
      } catch (e) {
        console.warn("Decrypt failed:", e.message);
      }
    }
    if (!text && msg.preview) text = msg.preview;
    if (!text && !imageUrl) text = "[Encrypted message — key mismatch]";
    appendBubble(text, imageUrl, msg.timestamp, false);
  }

  async function renderSelf(msg) {
    let text = null;
    let imageUrl = null;
    if (sharedKey && msg.encrypted && msg.iv) {
      try {
        const decryptedStr = await decryptMessage(msg.encrypted, msg.iv, sharedKey);
        const parsed = JSON.parse(decryptedStr);
        text = parsed.text;
        imageUrl = parsed.image;
      } catch (e) {
        console.warn("Decrypt self failed:", e.message);
      }
    }
    if (!text && msg.preview) text = msg.preview;
    if (!text && !imageUrl) text = "[Message sent]";
    appendBubble(text, imageUrl, msg.timestamp, true);
  }

  // ────────────────────────────────────────────────────────────
  // Send message
  // ────────────────────────────────────────────────────────────
  async function sendMessage(text) {
    const trimmed = text.trim();
    if ((!trimmed && !pendingImage) || !ws || ws.readyState !== WebSocket.OPEN) return;

    if (appState !== "paired") {
      appendError("You're not connected to anyone.");
      return;
    }

    if (!sharedKey) {
      appendError("Encryption not ready. Wait a moment…");
      return;
    }

    try {
      // Create a JSON payload with both text and image
      const payloadObj = {
        text: trimmed,
        image: pendingImage
      };
      const payloadStr = JSON.stringify(payloadObj);

      const { ciphertext, iv } = await encryptMessage(payloadStr, sharedKey);
      
      wsSend({
        type: "chat",
        encrypted: ciphertext,
        iv,
        preview: trimmed || "[Image]",
      });

      // Clear image state after sending
      clearPendingImage();
    } catch (err) {
      console.error("Encrypt error:", err);
      appendError("Failed to encrypt message.");
    }
  }

  // ────────────────────────────────────────────────────────────
  // UI State Management
  // ────────────────────────────────────────────────────────────

  function showSearching() {
    searchingOverlay.classList.remove("hidden");
    idleOverlay.classList.add("hidden");
    chatArea.classList.add("hidden");
    if (typingIndicator) typingIndicator.classList.add("hidden");
    setStatus("Searching…", "searching");
    disableInput();
    clearPendingImage();
  }

  function showChatArea() {
    searchingOverlay.classList.add("hidden");
    idleOverlay.classList.add("hidden");
    chatArea.classList.remove("hidden");
    setStatus("Connected to stranger", "paired");
    enableInput();
    messageInput.focus();
  }

  function showIdle() {
    searchingOverlay.classList.add("hidden");
    chatArea.classList.add("hidden");
    idleOverlay.classList.remove("hidden");
    if (typingIndicator) typingIndicator.classList.add("hidden");
    setStatus("Idle", "");
    disableInput();
    clearPendingImage();
  }

  function showPartnerLeftOptions() {
    // Keep the chat visible but show inline buttons
    const div = document.createElement("div");
    div.className = "msg-system";
    div.innerHTML = `
      <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap; padding:8px 0;">
        <button class="btn-new-chat btn-inline-new" id="btn-inline-new">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          New Chat
        </button>
      </div>
    `;
    messagesEl.appendChild(div);
    scrollToBottom();

    // Attach listener
    const btnInline = div.querySelector("#btn-inline-new");
    if (btnInline) {
      btnInline.addEventListener("click", () => {
        wsSend({ type: "find_partner" });
      });
    }
  }

  function setStatus(text, className) {
    connectionStatus.textContent = text;
    connectionStatus.className = "connection-status";
    if (className) connectionStatus.classList.add(className);
  }

  function enableInput() {
    messageInput.disabled = false;
    messageInput.placeholder = "Type a message…";
  }

  function disableInput() {
    messageInput.disabled = true;
    messageInput.placeholder = "Not connected…";
    sendBtn.disabled = true;
  }

  function clearMessages() {
    messagesEl.innerHTML = "";
  }

  function updateOnlineCount(count) {
    onlineCountEl.textContent = count;
  }

  // ────────────────────────────────────────────────────────────
  // DOM Helpers
  // ────────────────────────────────────────────────────────────

  function clearPendingImage() {
    pendingImage = null;
    imagePreviewImg.src = "";
    imagePreviewStrip.classList.add("hidden");
    fileGallery.value = "";
    fileCamera.value = "";
    
    // Disable send button if no text and no image
    if (!messageInput.value.trim()) {
      sendBtn.disabled = true;
    }
  }

  function appendBubble(text, imageUrl, timestamp, isSelf) {
    const wrapper = document.createElement("div");
    wrapper.className = `msg-bubble-wrapper ${isSelf ? "is-self" : "is-other"}`;
    const time = timestamp ? formatTime(timestamp) : "";
    const label = isSelf ? "You" : "Stranger";

    let contentHtml = "";
    if (imageUrl) {
      // Create img tag for base64 image
      contentHtml += `<img src="${imageUrl}" class="msg-image" alt="Shared photo" />`;
    }
    if (text) {
      contentHtml += `<div class="msg-bubble">${escapeHtml(text)}</div>`;
    }

    wrapper.innerHTML = `
      <div class="msg-nick">${label}</div>
      ${contentHtml}
      <div class="msg-time">${time} <span class="msg-encrypted-badge">🔒</span></div>
    `;
    messagesEl.appendChild(wrapper);
    scrollToBottom();
  }

  function appendSystem(text) {
    const div = document.createElement("div");
    div.className = "msg-system";
    div.innerHTML = `<span class="msg-system-text">${text}</span>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendSystemGreen(text) {
    const div = document.createElement("div");
    div.className = "msg-system";
    div.innerHTML = `<span class="msg-system-text system-green">${text}</span>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendSystemRed(text) {
    const div = document.createElement("div");
    div.className = "msg-system";
    div.innerHTML = `<span class="msg-system-text system-red">${text}</span>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function appendError(text) {
    const div = document.createElement("div");
    div.className = "msg-error";
    div.innerHTML = `<span class="msg-error-text">⚠ ${escapeHtml(text)}</span>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast ${isError ? "toast-error" : ""}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ────────────────────────────────────────────────────────────
  // Friends System UI Logic
  // ────────────────────────────────────────────────────────────

  function renderFriendsList(statuses = {}) {
    const friends = getSavedFriends();
    friendsListContainer.innerHTML = "";

    if (friends.length === 0) {
      friendsListContainer.innerHTML = `<p style="text-align:center; color:var(--text-muted); padding:20px;">You haven't saved any friends yet.</p>`;
      return;
    }

    friends.forEach(f => {
      const status = statuses[f.code] || "offline";
      let statusColorClass = "";
      let statusText = "Offline";
      let canCall = false;

      if (status === "idle" || status === "searching") {
        statusColorClass = "online";
        statusText = "Online (Available)";
        canCall = true;
      } else if (status === "paired") {
        statusColorClass = "busy";
        statusText = "Online (In Chat)";
      }

      const item = document.createElement("div");
      item.className = "friend-item";
      item.innerHTML = `
        <div class="friend-info">
          <div class="friend-name">
            <span class="status-dot ${statusColorClass}"></span>
            <input type="text" class="friend-name-input" value="${escapeHtml(f.nickname)}" data-code="${f.code}" maxlength="20" />
          </div>
          <div class="friend-status">${statusText}</div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn-action btn-call" style="${canCall ? 'color:var(--green); border-color:rgba(34,197,94,0.3);' : 'opacity:0.5; pointer-events:none;'}">Call</button>
          <button class="btn-action btn-remove-friend" style="color:var(--red); border-color:rgba(239,68,68,0.3); padding: 4px 8px;" title="Remove Friend">✕</button>
        </div>
      `;

      // Update nickname on blur
      const input = item.querySelector('.friend-name-input');
      input.addEventListener("change", (e) => {
        updateFriendNickname(f.code, e.target.value || `Stranger ${f.code}`);
      });

      // Call button
      const callBtn = item.querySelector('.btn-call');
      callBtn.addEventListener("click", () => {
        wsSend({ type: "direct_call", targetCode: f.code });
        friendsModal.classList.add("hidden");
        showToast("Calling friend...");
      });

      // Remove button
      const removeBtn = item.querySelector('.btn-remove-friend');
      removeBtn.addEventListener("click", () => {
        if (confirm("Are you sure you want to remove this friend?")) {
          removeFriend(f.code);
          renderFriendsList(statuses); // re-render immediately
          showToast("Friend removed.");
          
          // Check if we just removed our CURRENT partner, and re-enable Add Friend
          if (currentPartnerCode === f.code) {
            btnAddFriend.disabled = false;
            btnAddFriend.innerHTML = `
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              Add Friend
            `;
            btnAddFriend.style.color = "";
            btnAddFriend.style.background = "";
            btnAddFriend.style.borderColor = "";
          }
        }
      });

      friendsListContainer.appendChild(item);
    });
  }

  function startPollingFriends() {
    const poll = () => {
      const friends = getSavedFriends().map(f => f.code);
      if (friends.length > 0) wsSend({ type: "check_friends_online", friends });
    };
    poll();
    friendsPolling = setInterval(poll, 3000);
  }
  function stopPollingFriends() {
    if (friendsPolling) clearInterval(friendsPolling);
  }

  btnFriendsList.addEventListener("click", () => {
    friendsModal.classList.remove("hidden");
    startPollingFriends();
  });

  btnFriendsHeader.addEventListener("click", () => {
    friendsModal.classList.remove("hidden");
    startPollingFriends();
  });

  btnCloseFriends.addEventListener("click", () => {
    friendsModal.classList.add("hidden");
    stopPollingFriends();
  });

  btnAddFriend.addEventListener("click", () => {
    if (currentPartnerCode) {
      const defaultName = `Stranger ${currentPartnerCode}`;
      nicknameInput.value = defaultName;
      nicknameModal.classList.remove("hidden");
      nicknameInput.focus();
      nicknameInput.select(); // auto-select the text so they can easily over-write it
    }
  });

  btnCancelNickname.addEventListener("click", () => {
    nicknameModal.classList.add("hidden");
  });

  btnSaveNickname.addEventListener("click", () => {
    if (currentPartnerCode) {
      let nickname = nicknameInput.value.trim();
      if (nickname === "") nickname = `Stranger ${currentPartnerCode}`;

      saveFriend(currentPartnerCode, nickname);
      nicknameModal.classList.add("hidden");
      
      btnAddFriend.disabled = true;
      btnAddFriend.textContent = "Saved!";
      btnAddFriend.style.color = "var(--green)";
      btnAddFriend.style.background = "rgba(34,197,94,0.1)";
      btnAddFriend.style.borderColor = "rgba(34,197,94,0.3)";
      showToast("Saved to friends list!");
    }
  });

  nicknameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      btnSaveNickname.click();
    }
  });

  btnAcceptCall.addEventListener("click", () => {
    if (incomingCallCode) {
      wsSend({ type: "accept_call", callerCode: incomingCallCode });
      incomingCallModal.classList.add("hidden");
      incomingCallCode = null;
    }
  });

  btnRejectCall.addEventListener("click", () => {
    if (incomingCallCode) {
      wsSend({ type: "reject_call", callerCode: incomingCallCode });
      incomingCallModal.classList.add("hidden");
      incomingCallCode = null;
    }
  });

  // ────────────────────────────────────────────────────────────
  // Image Processing
  // ────────────────────────────────────────────────────────────

  function processImageFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      showToast("Please select a valid image file.", true);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Resize image to max 800px width/height to keep payload small
        const MAX_DIM = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_DIM) {
            height *= MAX_DIM / width;
            width = MAX_DIM;
          }
        } else {
          if (height > MAX_DIM) {
            width *= MAX_DIM / height;
            height = MAX_DIM;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        // Compress to JPEG format (0.7 quality)
        const compressedBase64 = canvas.toDataURL("image/jpeg", 0.7);
        
        pendingImage = compressedBase64;
        imagePreviewImg.src = compressedBase64;
        imagePreviewStrip.classList.remove("hidden");
        sendBtn.disabled = false; // enable send button
        attachMenu.classList.add("hidden"); // close menu
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ────────────────────────────────────────────────────────────
  // Event Listeners
  // ────────────────────────────────────────────────────────────

  // ── Privacy Protections ──
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());
  document.addEventListener("copy", (e) => {
    e.preventDefault();
    showToast("Copying is disabled for privacy.", true);
  });
  document.addEventListener("cut", (e) => {
    e.preventDefault();
    showToast("Cutting is disabled for privacy.", true);
  });
  
  function togglePrivacyBlur(shouldBlur) {
    if (shouldBlur && appState === "paired") document.body.classList.add("privacy-blur-active");
    else document.body.classList.remove("privacy-blur-active");
  }
  window.addEventListener("blur", () => togglePrivacyBlur(true));
  window.addEventListener("focus", () => togglePrivacyBlur(false));
  document.addEventListener("visibilitychange", () => togglePrivacyBlur(document.hidden));

  // Try to catch keyboard shortcuts before the OS freezes the screen
  document.addEventListener("keydown", (e) => {
    // Win+Shift+S (Windows) or Cmd+Shift+3/4 (Mac) or PrintScreen
    if (
      (e.metaKey && e.shiftKey) || 
      e.key === 'PrintScreen' || e.code === 'PrintScreen'
    ) {
      togglePrivacyBlur(true);
      try { navigator.clipboard.writeText(''); } catch(err) {}
    }
  });
  
  // Windows sometimes only fires keyup for PrtScr
  document.addEventListener("keyup", (e) => {
    if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
      togglePrivacyBlur(true);
      try { navigator.clipboard.writeText(''); } catch(err) {}
      // Auto-restore after 3 seconds since they don't necessarily leave the window
      setTimeout(() => togglePrivacyBlur(false), 3000);
    }
  });

  // ── Mobile Keyboard Viewport Fix ──
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      document.body.style.height = window.visualViewport.height + "px";
      scrollToBottom();
    });
    document.body.style.height = window.visualViewport.height + "px";
  }


  window.addEventListener("beforeunload", (e) => {
    if (appState === "paired") {
      e.preventDefault();
      e.returnValue = "You are currently connected to a stranger. Are you sure you want to leave?";
      return e.returnValue;
    }
  });

  // Image Attach Menu
  attachBtn.addEventListener("click", () => {
    attachMenu.classList.toggle("hidden");
  });

  // Close attach menu when clicking outside
  document.addEventListener("click", (e) => {
    if (!attachBtn.contains(e.target) && !attachMenu.contains(e.target)) {
      attachMenu.classList.add("hidden");
    }
  });

  attachGallery.addEventListener("click", () => {
    fileGallery.click();
  });

  attachCamera.addEventListener("click", () => {
    fileCamera.click();
  });

  fileGallery.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) {
      processImageFile(e.target.files[0]);
    }
  });

  fileCamera.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) {
      processImageFile(e.target.files[0]);
    }
  });

  imagePreviewRemove.addEventListener("click", () => {
    clearPendingImage();
  });

  // Send message
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = messageInput.value;
    if (text.trim() || pendingImage) {
      sendMessage(text);
      messageInput.value = "";
      sendBtn.disabled = true;
      charCount.textContent = "0 / 2000";
      autoResize();
      stopTyping();
    }
  });

  function startTyping() {
    if (!isTyping && appState === "paired") {
      isTyping = true;
      wsSend({ type: "typing" });
    }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 2000);
  }

  function stopTyping() {
    if (isTyping && appState === "paired") {
      isTyping = false;
      wsSend({ type: "stopped_typing" });
    }
    if (typingTimeout) clearTimeout(typingTimeout);
  }

  // Input
  messageInput.addEventListener("input", () => {
    const len = messageInput.value.length;
    charCount.textContent = `${len} / 2000`;
    sendBtn.disabled = !(messageInput.value.trim() || pendingImage);
    autoResize();
    startTyping();
  });

  // Enter to send
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatForm.dispatchEvent(new Event("submit"));
    }
  });

  function autoResize() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  }

  // Skip button — find new partner
  btnSkip.addEventListener("click", () => {
    wsSend({ type: "skip" });
    clearPendingImage();
    document.querySelectorAll('.msg-image').forEach(img => img.remove());
  });

  // End button — go idle
  btnEnd.addEventListener("click", () => {
    wsSend({ type: "end_chat" });
    appState = "idle";
    showIdle();
  });

  btnCancelSearch.addEventListener("click", () => {
    wsSend({ type: "end_chat" }); // end_chat safely removes from queue and sets state to idle
    appState = "idle";
    showIdle();
  });

  // New Chat button (idle screen)
  btnNewChat.addEventListener("click", () => {
    wsSend({ type: "find_partner" });
    appState = "searching";
    showSearching();
  });
  // ────────────────────────────────────────────────────────────
  // Boot
  // ────────────────────────────────────────────────────────────
  init();

})();
