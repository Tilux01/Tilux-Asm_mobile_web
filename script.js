/* ==========================================================================
   TILUX MOBILE REMOTE - FULL DESKTOP UI CHAT ENGINE & DRAWER DASHBOARD
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // Global Elements & State
  const pairScreen = document.getElementById('pairScreen');
  const chatScreen = document.getElementById('chatScreen');
  const drawerOverlay = document.getElementById('drawer-overlay');
  
  const badgeText = document.getElementById('badgeText');
  const badgeDot = document.getElementById('badgeDot');
  const badge = document.getElementById('badge');

  const btnScan = document.getElementById('btnScan');
  const serverUrlInput = document.getElementById('serverUrlInput');
  const tokenInput = document.getElementById('tokenInput');
  const btnConnect = document.getElementById('btnConnect');

  const initialView = document.getElementById('initial-view');
  const chatHistory = document.getElementById('chat-history');
  const inputField = document.getElementById('chatInput');
  const btnSend = document.getElementById('btnSend');
  const orbContainer = document.querySelector('.orb-container');

  const scannerModal = document.getElementById('scannerModal');
  const webcamVideo = document.getElementById('webcamVideo');
  const qrCanvas = document.getElementById('qrCanvas');
  const btnCancelScan = document.getElementById('btnCancelScan');

  let socket = null;
  let isPaired = false;
  let pcName = 'Tilux-PC';
  let currentToken = '';
  let videoStream = null;
  let animFrameId = null;
  let activeAiMessage = null;
  let activeRemoteSettings = { tts_enabled: true, tts_voice: 'en-GB-SoniaNeural' };

  let firebaseEventSource = null;
  let lastWakeToken = null;
  let currentEventSourceHostId = null;

  // Restore Saved Credentials & Active Chat State
  let savedUrl = localStorage.getItem('tilux_url');
  let savedToken = localStorage.getItem('tilux_token');
  const savedChatHtml = sessionStorage.getItem('tilux_chat_html');

  // Purge legacy localtunnel URLs from localStorage
  if (savedUrl && savedUrl.includes('loca.lt')) {
    console.warn('[Remote] Purging legacy localtunnel URL from storage:', savedUrl);
    localStorage.removeItem('tilux_url');
    savedUrl = null;
  }

  if (savedUrl) serverUrlInput.value = savedUrl;
  if (savedToken) tokenInput.value = savedToken;

  if (savedChatHtml && savedChatHtml.trim().length > 0) {
    if (chatHistory) chatHistory.innerHTML = savedChatHtml;
    transitionToChat();
  }

  if (savedUrl && savedToken) {
    pairScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    connectSocket(savedUrl, savedToken);
  }

  function saveChatState() {
    if (chatHistory && chatHistory.children.length > 0) {
      sessionStorage.setItem('tilux_chat_html', chatHistory.innerHTML);
    }
  }

  // Toast Helper with Anti-Spam & Deduplication
  function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Filter duplicate toasts
    const existingSpans = container.querySelectorAll('.toast span');
    for (let s of existingSpans) {
      if (s.textContent === msg) return;
    }

    // Cap max visible toasts to prevent screen flooding
    while (container.children.length >= 2) {
      container.removeChild(container.firstChild);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-circle-check' : (type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info');
    toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3500);
  }
  window.showToast = showToast;

  // URL Normalizer
  function normalizeUrl(rawUrl) {
    let clean = (rawUrl || '').trim();
    if (!clean) return '';
    let isHttps = clean.toLowerCase().startsWith('https://') || clean.toLowerCase().startsWith('wss://');
    clean = clean.replace(/^(wss?:\/\/|https?:\/\/)/i, '');
    clean = clean.replace(/\/+$/, '');
    if (!clean.includes(':') && !clean.includes('ngrok') && !clean.includes('cloudflare') && !clean.includes('trycloudflare') && !clean.includes('vercel') && !clean.includes('firebase')) {
      clean = clean + ':8932';
    }
    return (isHttps ? 'https://' : 'http://') + clean;
  }

  // Realtime Firebase RTDB Host Listener via Native EventSource (SSE)

  function subscribeToFirebaseHostEvents(hostId) {
    if (!hostId || typeof EventSource === 'undefined') return;
    const cleanHostId = hostId.trim();
    if (!cleanHostId.startsWith('tilux_host_') && cleanHostId.includes('.')) return;

    if (firebaseEventSource && currentEventSourceHostId === cleanHostId) {
      return; // Already actively subscribed to this host
    }

    if (firebaseEventSource) {
      try { firebaseEventSource.close(); } catch(e) {}
      firebaseEventSource = null;
    }
    
    currentEventSourceHostId = cleanHostId;

    const sseUrl = `https://tiluxasm-default-rtdb.firebaseio.com/hosts/${cleanHostId}.json`;
    console.log('[Realtime Firebase] Subscribing to EventSource stream for Host:', cleanHostId);

    try {
      firebaseEventSource = new EventSource(sseUrl);

      const handleFirebaseData = (rawData) => {
        try {
          const payload = JSON.parse(rawData);
          const data = payload && payload.data ? payload.data : payload;
          if (!data || typeof data !== 'object') return;

          console.log('[Realtime Firebase] Realtime update pushed from host:', payload);

          // Handle targeted patches vs full root snapshots
          if (payload.path === '/settings' || (payload.path && payload.path.startsWith('/settings/'))) {
            if (payload.path === '/settings') {
               activeRemoteSettings = { ...activeRemoteSettings, ...data };
            } else {
               const key = payload.path.replace('/settings/', '');
               activeRemoteSettings[key] = data;
            }
          } else if (data && data.settings && typeof data.settings === 'object') {
            activeRemoteSettings = { ...activeRemoteSettings, ...data.settings };
          }

          const freshWakeToken = data.wake_token ? data.wake_token.trim() : '';
          const freshUrlRaw = data.tunnel_url || data.public_url || data.local_url;

          let isServerWokenUp = false;
          if (freshWakeToken) {
            if (lastWakeToken !== null && freshWakeToken !== lastWakeToken) {
              console.log('[Realtime Firebase] ⚡ Wake token changed (' + lastWakeToken + ' -> ' + freshWakeToken + '). Server has woken up/rebooted!');
              isServerWokenUp = true;
            }
            lastWakeToken = freshWakeToken;
          }

          if (freshUrlRaw) {
            const freshUrl = normalizeUrl(freshUrlRaw);
            let shouldReconnect = false;
            if (isServerWokenUp) {
              shouldReconnect = true;
            } else if (socket && socket.io && freshUrl !== normalizeUrl(socket.io.uri)) {
              shouldReconnect = true;
            }
            if (freshUrl && shouldReconnect) {
              console.log('[Realtime Firebase] Reconnecting socket to woke/live host:', freshUrl);
              connectSocket(cleanHostId, currentToken);
            }
          }
        } catch (err) {
          console.warn('[Realtime Firebase Parse Warning]', err);
        }
      };

      firebaseEventSource.addEventListener('put', (e) => handleFirebaseData(e.data));
      firebaseEventSource.addEventListener('patch', (e) => handleFirebaseData(e.data));

      firebaseEventSource.onerror = () => {
        console.warn('[Realtime Firebase] EventSource reconnecting...');
      };
    } catch(err) {
      console.warn('[Realtime Firebase EventSource Setup Error]', err);
    }
  }

  // Firebase Host Discovery & Connection Resolution
  async function checkFirebaseForUpdatedUrl(hostIdInput = '', tokenInputParam = '', attemptedUrl = '') {
    try {
      let targetHost = (hostIdInput || '').trim();
      
      if (!targetHost || (!targetHost.startsWith('tilux_host_') && targetHost.includes('.'))) {
         console.warn('[Remote] Invalid Host ID provided for Firebase lookup');
         return null;
      }
      
      let fetchUrl = `https://tiluxasm-default-rtdb.firebaseio.com/hosts/${targetHost}.json`;
      subscribeToFirebaseHostEvents(targetHost);

      console.log('[Remote] Looking up Host state from Firebase:', fetchUrl);
      const resp = await fetch(fetchUrl, {
        headers: { 'bypass-tunnel-reminder': 'true' }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (!data) {
          console.warn('[Remote] No Host found for ID:', targetHost);
          return null;
        }

        // Auto-adopt live Pair Token from Firebase RTDB for Host ID lookup
        if (data.pair_token && data.pair_token.trim()) {
          const freshToken = data.pair_token.trim();
          if (freshToken !== currentToken) {
            console.log('[Remote] Auto-adopting updated pair token from Firebase RTDB:', freshToken);
            currentToken = freshToken;
            if (tokenInput) tokenInput.value = freshToken;
            localStorage.setItem('tilux_token', freshToken);
          }
        }

        const freshUrlRaw = data.tunnel_url || data.public_url || data.local_url;
        if (freshUrlRaw) {
          const freshUrl = normalizeUrl(freshUrlRaw);
          const isPageHttps = window.location.protocol === 'https:';
          if (isPageHttps && freshUrl.startsWith('http://')) {
            console.warn('[Remote] Firebase returned HTTP URL on HTTPS page:', freshUrl);
            return null;
          }
          console.log('[Remote] Resolved live PC URL from Firebase:', freshUrl);
          return freshUrl;
        }
      }
    } catch (e) {
      console.warn('[Remote] Firebase URL lookup error:', e);
    }
    return null;
  }

  // Drawer Toggle
  window.toggleDrawer = function() {
    drawerOverlay.classList.toggle('active');
  };

  window.closeDrawerOnOverlay = function(e) {
    if (e.target === drawerOverlay) {
      drawerOverlay.classList.remove('active');
    }
  };



  function resetConnectBtn() {
    const btn = document.getElementById('btnConnect');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>Connect to PC</span> <i class="fa-solid fa-plug"></i>';
    }
  }

  async function connectSocket(hostOrUrl, connToken) {
    const rawInput = (hostOrUrl || '').trim();
    const pairToken = (connToken || '').trim();

    if (!rawInput || !pairToken) {
      showToast('Please enter Host ID and Pair Token', 'error');
      resetConnectBtn();
      return;
    }

    let targetUrl = rawInput;

    // Purge obsolete loca.lt URLs
    if (targetUrl.includes('loca.lt')) {
      console.warn('[Remote] Purging obsolete loca.lt domain:', targetUrl);
      localStorage.removeItem('tilux_url');
      targetUrl = '';
    }

    // Check if input is a Host ID or requires Firebase lookup
    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.includes('trycloudflare') && !targetUrl.includes('ngrok'))) {
      
      // Look up Host ID from Firebase on every connection attempt
      console.log('[Remote] Looking up Host ID from Firebase:', rawInput);
      showToast('Connecting to Host...', 'info');
      
      const resolved = await checkFirebaseForUpdatedUrl(rawInput, pairToken);
      if (resolved && resolved.error) {
        resetConnectBtn();
        return;
      }
      if (resolved && typeof resolved === 'string') {
        targetUrl = resolved;
      } else {
        showToast('Server is offline or not found.', 'error');
        resetConnectBtn();
        return;
      }
      
      // Initialize Firebase EventSource in the background to listen for live tunnel rotations
      if (rawInput.startsWith('tilux_host_')) {
          subscribeToFirebaseHostEvents(rawInput);
      }
    } else {
      targetUrl = normalizeUrl(targetUrl);
    }

    if (socket && socket.connected) {
      if (targetUrl === normalizeUrl(serverUrlInput.value) && pairToken === currentToken) {
        console.log('[Remote] Already connected to this target');
        resetConnectBtn();
        return;
      }
      socket.disconnect();
    }

    serverUrlInput.value = rawInput;
    tokenInput.value = pairToken;
    currentToken = pairToken;

    localStorage.setItem('tilux_url', rawInput);
    localStorage.setItem('tilux_token', pairToken);

    updateBadge('Connecting via Tunnel...', false);

    console.log('[Remote] Initializing Socket.io connection to:', targetUrl);
    socket = io(targetUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      timeout: 10000,
      extraHeaders: {
        'bypass-tunnel-reminder': 'true'
      }
    });

    let connectErrCount = 0;
    
    socket.on('connect', () => {
      connectErrCount = 0;
      updateBadge('Authenticating...', false);
      socket.emit('pair_device', { token: connToken });
    });

    socket.on('connect_error', (err) => {
      console.error('[Remote] Socket Error:', err);
      connectErrCount++;
      updateBadge('Offline (Reconnecting...)', false);
    });

    let hasShownConnectedToast = false;

    socket.on('paired', (data) => {
      resetConnectBtn();
      if (data.status === 'success') {
        isPaired = true;
        pcName = data.pc_name || 'Tilux-PC';
        updateBadge('Connected', true);

        if (document.getElementById('remote-pc-name')) document.getElementById('remote-pc-name').textContent = pcName;
        if (document.getElementById('drawer-pc-name')) document.getElementById('drawer-pc-name').textContent = pcName;

        localStorage.setItem('tilux_url', rawInput);
        localStorage.setItem('tilux_token', connToken);

        pairScreen.classList.add('hidden');
        
        socket.emit('get_history');
        socket.emit('get_billing_status');
        fetchSettingsForMobile(targetUrl);

        if (!hasShownConnectedToast) {
          hasShownConnectedToast = true;
          chatScreen.classList.remove('hidden');
          showToast(`Connected to ${pcName}`, 'success');
        }
      } else {
        console.warn('[Remote] Pair authorization status:', data.status);
        updateBadge('Pairing Failed: Invalid Token', false);
        showToast('Pairing Failed: Invalid Pairing Token. Check token on PC screen.', 'error');
      }
    });

    socket.on('token_usage_update', (data) => {
      handleTokenUsageUpdate(data);
    });

  let selectedTopupAmount = 1;
  let selectedGatewayName = 'paystack';
  let currentBillingData = null;

  function openWalletModal() {
      const modal = document.getElementById('walletModal');
      if (modal) modal.classList.remove('hidden');
      fetchBillingData();
  }

  function closeWalletModal() {
      const modal = document.getElementById('walletModal');
      if (modal) modal.classList.add('hidden');
  }

  function closeWalletModalOnOverlay(e) {
      if (e.target.id === 'walletModal') closeWalletModal();
  }

  function selectTopupAmount(amt, btnEl) {
      selectedTopupAmount = amt;
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      if (btnEl) btnEl.classList.add('active');
      const customInput = document.getElementById('customAmountInput');
      if (customInput) customInput.value = '';
      updatePayButtonText();
  }

  function onCustomAmountInput(inputEl) {
      const val = parseFloat(inputEl.value);
      if (val > 0) {
          selectedTopupAmount = val;
          document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      }
      updatePayButtonText();
  }

  function selectGateway(gw) {
      selectedGatewayName = gw;
      document.querySelectorAll('.gateway-card').forEach(c => c.classList.remove('active'));
      const target = document.getElementById(`gw-${gw}`);
      if (target) target.classList.add('active');
      updatePayButtonText();
  }

  function updatePayButtonText() {
      const btnText = document.getElementById('btnPayText');
      if (btnText) {
          btnText.textContent = `Proceed to Paystack ($${Number(selectedTopupAmount).toFixed(2)} USD)`;
      }
  }

  function updateWalletModalUI(data) {
      if (!data) return;
      currentBillingData = data;

      const billingTrialText = document.getElementById('billingTrialText') || document.getElementById('desktopBillingTrialText');
      const billingTokenText = document.getElementById('billingTokenText') || document.getElementById('desktopBillingTokenText');
      const totalTokens = data.total_tokens || 0;
      const formattedTokens = totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + 'k' : totalTokens;

      if (billingTokenText) billingTokenText.textContent = `${formattedTokens} tok`;
      
      if (data.is_free_trial) {
          const hoursLeft = data.remaining_trial_hours !== undefined ? data.remaining_trial_hours : 24;
          if (billingTrialText) billingTrialText.textContent = `24h Free Trial (${hoursLeft}h)`;
      } else {
          const balance = (data.wallet_balance_usd !== undefined) ? '$' + Number(data.wallet_balance_usd).toFixed(2) : '$0.00';
          if (billingTrialText) billingTrialText.textContent = `Wallet: ${balance}`;
      }

      // Step Pills in Left Banner Card
      const trialPillLabel = document.getElementById('modalTrialPillLabel');
      if (trialPillLabel) {
          if (data.is_free_trial) {
              trialPillLabel.textContent = `24h Free Trial (${data.remaining_trial_hours || 24}h remaining)`;
          } else {
              trialPillLabel.textContent = `Pay-As-You-Go Billing Active`;
          }
      }

      const balancePillLabel = document.getElementById('modalBalancePillLabel');
      if (balancePillLabel) {
          balancePillLabel.textContent = `Balance: $${Number(data.wallet_balance_usd || 0).toFixed(2)} USD`;
      }

      const tokenPillLabel = document.getElementById('modalTokenPillLabel');
      if (tokenPillLabel) {
          tokenPillLabel.textContent = `Tokens: ${formattedTokens} processed`;
      }

      const historyBox = document.getElementById('paymentHistoryList');
      if (historyBox) {
          const history = data.payment_history || [];
          if (history.length === 0) {
              historyBox.innerHTML = '<div class="history-empty">No previous top-up transactions.</div>';
          } else {
              historyBox.innerHTML = history.slice().reverse().map(item => `
                  <div class="history-item-card">
                      <div>
                          <strong style="color: #10b981;">+$${Number(item.amount_usd).toFixed(2)} USD</strong>
                          <span class="history-gateway-badge">${item.gateway}</span>
                      </div>
                      <div style="font-size: 11px; color: #a1a1aa;">
                          ${new Date(item.timestamp * 1000).toLocaleDateString()} ${new Date(item.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                      </div>
                  </div>
              `).join('');
          }
      }
  }

  async function fetchBillingData() {
      try {
          const baseUrl = window.location.origin.includes('8932') ? '' : (window.SERVER_URL || 'http://127.0.0.1:8932');
          const res = await fetch(`${baseUrl}/api/billing_status`);
          const data = await res.json();
          updateWalletModalUI(data);
      } catch (e) {
          console.warn('Failed to fetch billing status', e);
      }
  }

  async function executePayment() {
      const btnPay = document.getElementById('btnPayNow');
      const btnText = document.getElementById('btnPayText');
      const emailInput = document.getElementById('topupEmail');
      const email = (emailInput && emailInput.value.trim()) ? emailInput.value.trim() : '';

      if (!email) {
          if (window.showToast) window.showToast('Please enter a valid receipt email', 'error');
          else alert('Please enter a valid receipt email');
          return;
      }

      if (!selectedTopupAmount || selectedTopupAmount < 1) {
          if (window.showToast) window.showToast('Minimum top-up amount is $1.00 USD', 'error');
          else alert('Minimum top-up amount is $1.00 USD');
          return;
      }

      if (btnPay) btnPay.disabled = true;
      if (btnText) btnText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Initializing ${selectedGatewayName.toUpperCase()}...`;

      try {
          const baseUrl = window.location.origin.includes('8932') ? '' : (window.SERVER_URL || 'http://127.0.0.1:8932');
          const res = await fetch(`${baseUrl}/api/payment/initialize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  gateway: selectedGatewayName,
                  amount_usd: selectedTopupAmount,
                  email: email,
                  currency: 'USD'
              })
          });

          const data = await res.json();
          if (data.status === 'success' && data.checkout_url) {
              if (window.showToast) showToast(`Opening ${selectedGatewayName.toUpperCase()} Secure Checkout...`, 'info');
              const payWindow = window.open(data.checkout_url, '_blank', 'width=600,height=700');

              const verifyRef = data.reference;
              let pollAttempts = 0;
              const pollInterval = setInterval(async () => {
                  pollAttempts++;
                  if (pollAttempts > 30) {
                      clearInterval(pollInterval);
                      if (btnPay) btnPay.disabled = false;
                      updatePayButtonText();
                      return;
                  }
                  try {
                      const vRes = await fetch(`${baseUrl}/api/payment/verify`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              gateway: selectedGatewayName,
                              reference: verifyRef,
                              amount_usd: selectedTopupAmount
                          })
                      });
                      const vData = await vRes.json();
                      if (vData.status === 'success' && vData.billing) {
                          clearInterval(pollInterval);
                          if (payWindow && !payWindow.closed) payWindow.close();
                          updateWalletModalUI(vData.billing);
                          if (window.showToast) showToast(`🎉 Success! $${selectedTopupAmount.toFixed(2)} added to wallet.`, 'success');
                          if (btnPay) btnPay.disabled = false;
                          updatePayButtonText();
                      }
                  } catch (err) {}
              }, 3000);
          } else {
              if (window.showToast) showToast(data.message || 'Payment initialization failed', 'error');
              if (btnPay) btnPay.disabled = false;
              updatePayButtonText();
          }
      } catch (err) {
          if (window.showToast) showToast('Failed to connect to payment server', 'error');
          if (btnPay) btnPay.disabled = false;
          updatePayButtonText();
      }
  }

  function handleTokenUsageUpdate(data) {
    if (!data || typeof data !== 'object') return;
    updateWalletModalUI(data);
  }

    // Real-Time System Stats Sync to Hamburger Drawer
    socket.on('system_stats', (stats) => {
      if (!stats) return;
      if (document.getElementById('cpu-val')) document.getElementById('cpu-val').innerText = (stats.cpu || 0) + '%';
      if (document.getElementById('cpu-fill')) document.getElementById('cpu-fill').style.width = (stats.cpu || 0) + '%';

      if (document.getElementById('ram-val')) document.getElementById('ram-val').innerText = (stats.ram || 0) + '%';
      if (document.getElementById('ram-fill')) document.getElementById('ram-fill').style.width = (stats.ram || 0) + '%';

      if (document.getElementById('swap-val')) document.getElementById('swap-val').innerText = (stats.swap || 0) + '%';
      if (document.getElementById('swap-fill')) document.getElementById('swap-fill').style.width = (stats.swap || 0) + '%; background-color: #f59e0b;';

      if (document.getElementById('net-down')) document.getElementById('net-down').innerText = stats.net_down || '0 B/s';
      if (document.getElementById('net-up')) document.getElementById('net-up').innerText = stats.net_up || '0 B/s';

      if (document.getElementById('process-list') && stats.processes) {
        const procList = document.getElementById('process-list');
        procList.innerHTML = '';
        stats.processes.forEach(p => {
          const li = document.createElement('li');
          li.innerHTML = `<strong>${p.name}</strong> <span style="float:right; color:#00F2FE;">${p.cpu}% CPU | ${p.mem}% RAM</span>`;
          procList.appendChild(li);
        });
      }
    });

    // Section-Based Event Completion Updates (Thinking / Command Step Complete)
    socket.on('agent_events', (data) => {
      if (!data) return;
      if (data.session_id && currentSessionId && data.session_id !== currentSessionId) return;
      
      if (chatHistory && chatHistory.classList.contains('hidden')) {
        transitionToChat();
      }
      if (!activeAiMessage) {
        const loadingId = Date.now();
        activeAiMessage = createAiMessage(loadingId);
      }
      if (data.events) {
        activeAiMessage.updateEvents(data.events);
      }
    });

    // Final AI Output Reply
    socket.on('agent_reply', (data) => {
      if (data) {
        if (data.session_id && currentSessionId && data.session_id !== currentSessionId) return;
        if (data.session_id) {
          currentSessionId = data.session_id;
        }
        if (activeAiMessage) {
          if (data.events) {
            activeAiMessage.updateEvents(data.events);
          }
          if (data.reply) {
            activeAiMessage.setReply(data.reply);
            if (data.requested_by === socket.id) {
              speakOnMobile(data.reply);
            }
          }
          activeAiMessage = null; // Clear reference ONLY after setting reply
        } else if (data.reply) {
          addMessage('AI', formatMarkdownAndProxyImages(data.reply));
          const lastMsg = chatHistory.lastElementChild;
          if (lastMsg) wrapGeneratedImages(lastMsg.querySelector('.msg-content'));
          if (data.requested_by === socket.id) {
            speakOnMobile(data.reply);
          }
        }
      }
      toggleSendIcon(false);
    });




    // Socket History Listeners
    socket.on('history_list', (sessions) => {
      renderMobileHistory(sessions);
    });

    socket.on('session_loaded', (session) => {
      if (!session || !session.messages) return;
      currentSessionId = session.id;
      transitionToChat();
      if (chatHistory) chatHistory.innerHTML = '';
      session.messages.forEach(msg => {
        if (msg.sender === 'User') {
          let finalHtml = msg.text || '';
          let attHtml = null;
          if (msg.attachments && msg.attachments.length > 0) {
            let targetBase = 'http://127.0.0.1:8932';
            if (typeof socket !== 'undefined' && socket && socket.io && socket.io.uri) {
              targetBase = socket.io.uri;
            } else {
              targetBase = (typeof targetUrl !== 'undefined' && targetUrl) ? targetUrl : (localStorage.getItem('tilux_url') || 'http://127.0.0.1:8932');
            }
            const hostPrefix = targetBase.replace(/\/+$/, '');
            let imgHtml = msg.attachments.map(url => `<img src="${hostPrefix}${url}&bypass-tunnel-reminder=true" onclick="openLightbox('${hostPrefix}${url}&bypass-tunnel-reminder=true')" class="chat-attachment-img">`).join('');
            attHtml = `<div class="chat-attachment-container">${imgHtml}</div>`;
          }
          addMessage('User', finalHtml, attHtml);
        } else {
          addMessage('AI', formatMarkdownAndProxyImages(msg.text));
          const lastMsg = chatHistory.lastElementChild;
          if (lastMsg) wrapGeneratedImages(lastMsg.querySelector('.msg-content'));
        }
      });
      if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
    });

    socket.on('new_chat_started', (data) => {
      if (data && data.session_id) {
        currentSessionId = data.session_id;
      }
    });

    socket.on('disconnect', (reason) => {
      isPaired = false;
      updateBadge('Reconnecting...', false);
      console.warn('[Remote] Socket disconnected (reconnection active):', reason);
      // Keep chatScreen visible during transient reconnects
    });
  }

  function updateBadge(text, connected) {
    if (badgeText) badgeText.textContent = text;
    if (badge) {
      if (connected) {
        badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        if (badgeDot) badgeDot.className = 'dot dot-on';
      } else {
        badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        if (badgeDot) badgeDot.className = 'dot dot-off';
      }
    }
  }

  // --- UI TRANSITIONS & MESSAGE RENDERING ---
  function transitionToChat() {
    if (chatHistory) chatHistory.classList.remove('hidden');
    if (orbContainer) orbContainer.classList.add('docked');
    if (initialView) {
      initialView.classList.add('fade-out');
      initialView.classList.add('hidden');
    }
  }

  window.clearChat = function() {
    if (chatHistory) {
      chatHistory.innerHTML = '';
      chatHistory.classList.add('hidden');
    }
    if (initialView) {
      initialView.classList.remove('hidden');
      initialView.classList.remove('fade-out');
    }
    if (orbContainer) orbContainer.classList.remove('docked');
    sessionStorage.removeItem('tilux_chat_html');
    showToast('Chat history cleared', 'info');
  };

  function addMessage(sender, htmlText, attachmentsHtml = null) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender.toLowerCase()}`;

    if (attachmentsHtml) {
      const attContainer = document.createElement('div');
      attContainer.innerHTML = attachmentsHtml;
      // The HTML already contains <div class="chat-attachment-container">...</div>
      msgDiv.appendChild(attContainer.firstChild);
    }

    if (htmlText && htmlText.trim() !== '') {
      const contentDiv = document.createElement('div');
      contentDiv.className = 'msg-content';
      contentDiv.innerHTML = htmlText;
      msgDiv.appendChild(contentDiv);
    }

    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    
    if (typeof loadImagesViaFetch === 'function') {
        loadImagesViaFetch(msgDiv);
    }
    
    saveChatState();
  }

  window.scrollToBottom = function(e) {
    if (e && e.currentTarget) {
      try { e.currentTarget.blur(); } catch(err) {}
    }
    if (document.activeElement) {
      try { document.activeElement.blur(); } catch(err) {}
    }
    if (chatHistory) {
      chatHistory.scrollTo({ top: chatHistory.scrollHeight, behavior: 'smooth' });
    }
  };

  if (chatHistory) {
    chatHistory.addEventListener('scroll', () => {
      const scrollBtn = document.getElementById('scrollToBottomBtn');
      if (!scrollBtn) return;
      const distanceFromBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight;
      if (distanceFromBottom > 100) {
        scrollBtn.classList.remove('hidden');
      } else {
        scrollBtn.classList.add('hidden');
      }
    });
  }

  window.downloadImage = function(url, filename = 'tilux_image.png') {
    showToast('Downloading media file...', 'info');
    fetch(url, {
      headers: { 'bypass-tunnel-reminder': 'true' }
    })
      .then(resp => {
        if (!resp.ok) throw new Error('Fetch failed');
        return resp.blob();
      })
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename || ('tilux_media_' + Date.now() + '.png');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
        showToast('Media downloaded to phone', 'success');
      })
      .catch(err => {
        console.error('Blob download failed:', err);
        showToast('Download failed. Ensure PC server is online.', 'error');
      });
  };

  window.downloadCurrentLightboxImage = function(e) {
    if (e) e.stopPropagation();
    const lightboxImg = document.getElementById('lightboxImg');
    if (lightboxImg && lightboxImg.src) {
      downloadImage(lightboxImg.src, 'tilux_screenshot_' + Date.now() + '.png');
    }
  };

  function formatMarkdownAndProxyImages(text) {
    if (!text) return '';
    let targetBase = 'http://127.0.0.1:8932';
    if (typeof socket !== 'undefined' && socket && socket.io && socket.io.uri) {
      targetBase = socket.io.uri;
    } else {
      targetBase = (typeof targetUrl !== 'undefined' && targetUrl) ? targetUrl : (localStorage.getItem('tilux_url') || 'http://127.0.0.1:8932');
    }
    const hostPrefix = targetBase.replace(/\/+$/, '');

    // Auto-convert any standalone local image file path (even inside backticks or trailing punctuation) into markdown image syntax
    let formattedText = text.replace(/`?(\/(?:tmp|home|var|usr|Users|C:)[^`\s"'<>]+\.(?:png|jpg|jpeg|webp|gif|svg))`?/gi, (match, path) => {
      const cleanPath = path.replace(/[.,;)]+$/, '');
      return `\n![Image Preview](${cleanPath})\n`;
    });

    // Replace local server URLs with the actual tunnel URL so they load on mobile
    formattedText = formattedText.replace(/http:\/\/(127\.0\.0\.1|localhost):8932/g, hostPrefix);

    let parsed = typeof marked !== 'undefined' ? marked.parse(formattedText) : formattedText;

    // 1. Convert <img src="..."> tags to HTTP proxy URLs
    parsed = parsed.replace(/src=["'](file:\/\/[^"']+|\/[^"']+|[A-Za-z]:\\[^"']+|[^\s"']+\.(?:png|jpg|jpeg|webp|gif|svg))["']/gi, (match, p1) => {
      let finalSrc = p1;
      if (!p1.startsWith('http://') && !p1.startsWith('https://') && !p1.startsWith('data:')) {
        const cleanPath = p1.replace(/^file:\/\//, '');
        finalSrc = `${hostPrefix}/api/file?path=${encodeURIComponent(cleanPath)}&bypass-tunnel-reminder=true`;
      }
      return `src="${finalSrc}" onclick="openLightbox('${finalSrc}')" class="ai-generated-img"`;
    });

    // 2. Convert <a href="..."> links to HTTP proxy URLs with download parameter
    parsed = parsed.replace(/href=["'](file:\/\/[^"']+|\/[^"']+|[A-Za-z]:\\[^"']+|[^\s"']+\.(?:png|jpg|jpeg|webp|gif|svg|pdf|txt|json|log))["']/gi, (match, p1) => {
      let finalHref = p1;
      if (!p1.startsWith('http://') && !p1.startsWith('https://') && !p1.startsWith('data:')) {
        const cleanPath = p1.replace(/^file:\/\//, '');
        finalHref = `${hostPrefix}/api/file?path=${encodeURIComponent(cleanPath)}&download=1&bypass-tunnel-reminder=true`;
      }
      return `href="${finalHref}" onclick="event.preventDefault(); downloadImage('${finalHref}')"`;
    });

    // 3. Wrap images in chat-img-wrapper with a Save badge button
    parsed = parsed.replace(/(<img[^>]+class="ai-generated-img"[^>]*>)/gi, (match) => {
      const srcMatch = match.match(/src=["']([^"']+)["']/i);
      const imgSrc = srcMatch ? srcMatch[1] : '';
      return `<div class="chat-img-wrapper">${match}<button class="img-download-badge" onclick="event.stopPropagation(); downloadImage('${imgSrc}')"><i class="fa-solid fa-download"></i> Save</button></div>`;
    });

    return parsed;
  }

  // Wraps consecutive .ai-generated-img elements in a flex container
  function wrapGeneratedImages(parentEl) {
    if (!parentEl) return;
    const imgs = parentEl.querySelectorAll('img.ai-generated-img');
    if (imgs.length === 0) return;

    // Group consecutive images (they may be inside <p> or .chat-img-wrapper tags from markdown)
    const groups = [];
    let currentGroup = [];

    imgs.forEach(img => {
      // Get the top-level wrapper (the .chat-img-wrapper, <p>, or the img itself)
      const wrapper = img.closest('.chat-img-wrapper') || img.closest('p') || img;
      if (currentGroup.length === 0) {
        currentGroup.push({ wrapper, img });
      } else {
        const lastWrapper = currentGroup[currentGroup.length - 1].wrapper;
        let next = lastWrapper.nextSibling;
        while (next && next.nodeType === 3 && next.textContent.trim() === '') {
          next = next.nextSibling;
        }
        if (next === wrapper) {
          currentGroup.push({ wrapper, img });
        } else {
          groups.push([...currentGroup]);
          currentGroup = [{ wrapper, img }];
        }
      }
    });
    if (currentGroup.length > 0) groups.push(currentGroup);

    groups.forEach(group => {
      const container = document.createElement('div');
      container.className = 'ai-generated-container';
      const firstWrapper = group[0].wrapper;
      firstWrapper.parentNode.insertBefore(container, firstWrapper);
      group.forEach(({ wrapper }) => {
        container.appendChild(wrapper);
      });
    });

    loadImagesViaFetch(parentEl);
  }

  function loadImagesViaFetch(parentEl) {
    if (!parentEl) return;
    const imgs = parentEl.querySelectorAll('img.ai-generated-img, img.chat-attachment-img');
    imgs.forEach(img => {
      const src = img.getAttribute('src');
      if (src && src.includes('/api/file?path=') && !src.startsWith('blob:')) {
            img.dataset.originalSrc = src;
            img.style.opacity = '0.5';
            fetch(src, { headers: { 'bypass-tunnel-reminder': 'true', 'ngrok-skip-browser-warning': 'true' } })
            .then(res => {
                if(!res.ok) throw new Error('Network error');
                return res.blob();
            })
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                img.src = blobUrl;
                img.style.opacity = '1';
                img.setAttribute('onclick', `openLightbox('${blobUrl}')`);
            })
            .catch(err => {
                console.error('Failed to load tunnel image via fetch:', err);
                img.style.opacity = '1';
            });
      }
    });
  }

  window.openLightbox = function(src) {
    const lightbox = document.getElementById('imageLightbox');
    const lightboxImg = document.getElementById('lightboxImg');
    if (lightbox && lightboxImg) {
      lightboxImg.src = src;
      lightbox.classList.remove('hidden');
    }
  };

  window.closeLightbox = function(e) {
    if (e) e.stopPropagation();
    const lightbox = document.getElementById('imageLightbox');
    if (lightbox) {
      lightbox.classList.add('hidden');
    }
  };



  function createAiMessage(loadingId) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ai';
    msgDiv.id = `msg-${loadingId}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.innerHTML = `<div id="events-container-${loadingId}" class="events-container"></div><div id="text-response-${loadingId}"></div><div id="ai-loading-${loadingId}" class="ai-loading-indicator"><div class="typing-indicator"><span></span><span></span><span></span></div></div>`;
    
    msgDiv.appendChild(contentDiv);
    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
    
    return {
      updateEvents: function(events) {
        const container = document.getElementById(`events-container-${loadingId}`);

        if (!container || !events || events.length === 0) return;
        
        container.style.display = '';
        let didUpdate = false;

        events.forEach(ev => {
          let el = document.getElementById(`event-${loadingId}-${ev.id}`);
          if (!el) {
            el = document.createElement('div');
            el.id = `event-${loadingId}-${ev.id}`;
            el.className = 'ai-event';
            container.appendChild(el);
            didUpdate = true;
          }
          
          const existingDetails = el.querySelector('details');
          const isOpen = existingDetails ? existingDetails.open : false;

          const isThink = ev.type === "think";
          const eventClass = isThink ? "ai-steps-details thought-event" : "ai-steps-details command-event";

          if (ev.status === "running") {
            const contentStr = String(ev.content || '');
            if (el.dataset.status !== "running" || el.dataset.contentHash !== contentStr) {
              el.dataset.status = "running";
              el.dataset.contentHash = contentStr;
              let label = isThink ? "Thinking & Analyzing..." : "Executing command on PC...";
              if (contentStr) {
                let content = formatMarkdownAndProxyImages(contentStr);
                const shouldOpenRunning = isThink || isOpen;
                el.innerHTML = `<details class="${eventClass}"${shouldOpenRunning ? ' open' : ''}><summary class="ai-steps-summary"><i class="fa-solid fa-circle-notch fa-spin" style="color: #a855f7;"></i> ${label}</summary><div class="ai-step"><i class="fa-solid fa-code-commit" style="margin-top: 4px;"></i> <div class="ai-step-content">${content}</div></div></details>`;
              } else {
                el.innerHTML = `<span class="event-running"><i class="fa-solid fa-circle-notch fa-spin"></i> ${label}</span>`;
              }
              didUpdate = true;
            }
          } else if (ev.status === "completed") {
            const contentStr = String(ev.content || '');
            if (el.dataset.completed !== "true" || el.dataset.contentHash !== contentStr) {
              el.dataset.completed = "true";
              el.dataset.contentHash = contentStr;
              let durStr = ev.duration ? ` for ${ev.duration}` : "";
              let label = isThink ? `Thought${durStr}` : `Ran a command${durStr}`;
              let defaultFallback = isThink ? "Analyzed query and planned execution." : "Command completed successfully.";
              let content = ev.content ? formatMarkdownAndProxyImages(ev.content) : defaultFallback;
              el.innerHTML = `<details class="${eventClass}"${isOpen ? ' open' : ''}><summary class="ai-steps-summary"><i class="fa-solid fa-chevron-right arrow-icon"></i> ${label}</summary><div class="ai-step"><i class="fa-solid fa-code-commit" style="margin-top: 4px;"></i> <div class="ai-step-content">${content}</div></div></details>`;
              didUpdate = true;
            }
          }
        });

        if (didUpdate) {
          chatHistory.scrollTop = chatHistory.scrollHeight;
        }
      },
      setReply: function(text) {
        const container = document.getElementById(`events-container-${loadingId}`);
        if (container) {
          const runningEls = container.querySelectorAll('.event-running');
          runningEls.forEach(el => {
            const parent = el.closest('.ai-event');
            if (parent && parent.dataset.completed !== "true") {
              parent.remove();
            }
          });

          // Auto-hide / collapse all details back on mobile once the final response is given
          const allDetails = container.querySelectorAll('details');
          allDetails.forEach(d => d.removeAttribute('open'));

          if (container.children.length === 0) {
            container.style.display = 'none';
          } else {
            container.style.display = '';
          }
        }

        // Remove loading animation bar once final reply is received
        const loadingIndicator = document.getElementById(`ai-loading-${loadingId}`);
        if (loadingIndicator) {
          loadingIndicator.remove();
        }

        const textResponse = document.getElementById(`text-response-${loadingId}`);
        if (textResponse) {
          textResponse.innerHTML = formatMarkdownAndProxyImages(text);
          wrapGeneratedImages(textResponse);
        }
        chatHistory.scrollTop = chatHistory.scrollHeight;
        saveChatState();
      }
    };
  }

  let isExecutingState = false;

  function toggleSendIcon(isExecuting) {
    isExecutingState = !!isExecuting;
    const sendIcon = document.getElementById('send-icon');
    if (sendIcon) {
      if (isExecuting) {
        sendIcon.className = 'fa-solid fa-stop';
        sendIcon.style.color = '#ef4444';
      } else {
        sendIcon.className = 'fa-solid fa-arrow-up';
        sendIcon.style.color = '';
      }
    }
  }

  function stopTask() {
    if (socket) {
      socket.emit('stop_task');
    }
    if (activeAiMessage) {
      activeAiMessage.setReply("Task stopped by user.");
      activeAiMessage = null;
    }
    toggleSendIcon(false);
    showToast('Stopping task...', 'info');
  }

  let selectedFiles = [];

  window.toggleAttachmentMenu = function() {
    const menu = document.getElementById('attachment-menu');
    if (menu) {
      menu.style.display = (menu.style.display === 'none' || !menu.style.display) ? 'block' : 'none';
    }
  };

  window.triggerUpload = function(acceptType) {
    const fileInput = document.getElementById('chat-attachment-input');
    if (fileInput) {
      fileInput.accept = acceptType || '*/*';
      fileInput.click();
    }
    const menu = document.getElementById('attachment-menu');
    if (menu) menu.style.display = 'none';
  };

  const fileInput = document.getElementById('chat-attachment-input');
  const previewContainer = document.getElementById('attachment-preview-container');

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      for (let i = 0; i < fileInput.files.length; i++) {
        selectedFiles.push(fileInput.files[i]);
      }
      renderPreviews();
      fileInput.value = '';
    });
  }

  // Support pasting images & files directly from clipboard (Ctrl+V / Cmd+V / Paste)
  document.addEventListener('paste', (e) => {
    const clipboardData = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData) || window.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    const files = clipboardData.files;
    let hasPastedFiles = false;

    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            let name = file.name;
            if (!name || name === 'image.png') {
              const ext = file.type.split('/')[1] || 'png';
              name = `pasted_image_${Date.now()}_${i}.${ext}`;
            }
            const renamedFile = new File([file], name, { type: file.type });
            selectedFiles.push(renamedFile);
            hasPastedFiles = true;
          }
        }
      }
    } else if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        selectedFiles.push(files[i]);
        hasPastedFiles = true;
      }
    }

    if (hasPastedFiles) {
      e.preventDefault();
      renderPreviews();
      if (typeof showToast === 'function') {
        showToast('Image pasted into chat!', 'info');
      }
    }
  });

  // Close attachment menu if clicked outside
  document.addEventListener('click', (event) => {
    const menu = document.getElementById('attachment-menu');
    const addBtn = document.querySelector('button[onclick="toggleAttachmentMenu()"]');
    if (menu && addBtn && !menu.contains(event.target) && !addBtn.contains(event.target)) {
      menu.style.display = 'none';
    }
  });

  function renderPreviews() {
    if (!previewContainer) return;
    previewContainer.innerHTML = '';
    selectedFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'attachment-preview-item';
      
      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        item.appendChild(img);
      } else {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-file-lines doc-icon';
        item.appendChild(icon);
      }
      
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-btn';
      removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      removeBtn.onclick = () => {
        selectedFiles.splice(index, 1);
        renderPreviews();
      };
      item.appendChild(removeBtn);
      previewContainer.appendChild(item);
    });
  }

  function unlockIosSpeech() {
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.resume();
        const silentUtterance = new SpeechSynthesisUtterance('');
        silentUtterance.volume = 0;
        window.speechSynthesis.speak(silentUtterance);
      } catch(e) {}
    }
  }

  window.sendQuickAction = function(text) {
    if (inputField) {
      inputField.value = text;
      sendPrompt();
    }
  };

  async function sendPrompt() {
    unlockIosSpeech();
    const text = inputField.value.trim();
    if (!text && selectedFiles.length === 0) return;
    if (!socket) return;

    let attachmentImgs = '';
    const rawAttachments = [];

    for (const file of selectedFiles) {
      if (file.type.startsWith('image/')) {
        const fileUrl = URL.createObjectURL(file);
        attachmentImgs += `<img src="${fileUrl}" onclick="openLightbox('${fileUrl}')" class="chat-attachment-img">`;
      }

      const b64Data = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
      rawAttachments.push({ name: file.name, b64: b64Data });
    }

    const attHtmlFinal = attachmentImgs ? `<div class="chat-attachment-container">${attachmentImgs}</div>` : null;

    transitionToChat();
    addMessage('User', text || '', attHtmlFinal);

    inputField.value = '';
    inputField.style.height = 'auto';
    selectedFiles = [];
    if (previewContainer) previewContainer.innerHTML = '';

    const loadingId = Date.now();
    activeAiMessage = createAiMessage(loadingId);
    toggleSendIcon(true);

    if (!socket || !socket.connected) {
      showToast('Socket disconnected. Reconnecting to tunnel...', 'error');
      toggleSendIcon(false);
      return;
    }

    socket.emit('send_prompt', {
      text: text,
      attachments: rawAttachments,
      token: currentToken,
      loadingId: loadingId,
      session_id: currentSessionId
    });
  }


  if (inputField) {
    inputField.addEventListener('input', () => {
      inputField.style.height = 'auto';
      inputField.style.height = Math.min(inputField.scrollHeight, 120) + 'px';
    });
  }

  async function fetchSettingsForMobile(serverUrl) {
    if (!serverUrl) return;
    try {
      const resp = await fetch(`${serverUrl}/api/settings`, {
        headers: { 'bypass-tunnel-reminder': 'true' }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data) {
          activeRemoteSettings = data;
          if (data.tts_voice) localStorage.setItem('tilux_tts_voice', data.tts_voice);
          if (data.tts_speed) localStorage.setItem('tilux_tts_speed', data.tts_speed);
          if (data.tts_enabled !== undefined) localStorage.setItem('tilux_tts_enabled', data.tts_enabled ? 'true' : 'false');
        }
      }
    } catch(e) {}
  }

  let activeAzureAudio = null;

  async function speakOnMobile(text) {
    if (!text) return;
    const isEnabled = activeRemoteSettings.tts_enabled !== false && localStorage.getItem('tilux_tts_enabled') !== 'false';
    if (!isEnabled) return;

    // Clean markdown, image tags, code blocks, URLs, and file paths
    let cleanText = text
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/https?:\/\/[^\s]+/g, '')
      .replace(/\/[\w.\/-]+/g, '')
      .replace(/[*_~`#>\-]/g, '')
      .trim();

    if (!cleanText) return;
    cleanText = cleanText.slice(0, 350);

    const targetVoiceStr = activeRemoteSettings.tts_voice || localStorage.getItem('tilux_tts_voice') || 'en-GB-SoniaNeural';
    const targetSpeedStr = activeRemoteSettings.tts_speed || localStorage.getItem('tilux_tts_speed') || '+20%';

    try {
      if (activeAzureAudio) {
        activeAzureAudio.pause();
        activeAzureAudio = null;
      }
      
      const backendUrl = normalizeUrl(localStorage.getItem('tilux_url'));
      const res = await fetch(`${backendUrl}/api/tts`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'bypass-tunnel-reminder': 'true'
        },
        body: JSON.stringify({ text: cleanText, voiceName: targetVoiceStr, speed: targetSpeedStr })
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        activeAzureAudio = new Audio(url);
        activeAzureAudio.play();
        return;
      }
    } catch (e) {
      console.warn('[Mobile Speech Azure API fallback]', e);
    }

    // Fallback to Native Speech Synthesis
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();

      const utterance = new SpeechSynthesisUtterance(cleanText);
      let langPrefix = 'en-US';
      const parts = targetVoiceStr.split('-');
      if (parts.length >= 2) {
        langPrefix = `${parts[0]}-${parts[1]}`;
      }

      utterance.lang = langPrefix;
      utterance.rate = 1.2;
      utterance.pitch = 1.0;

      const voices = window.speechSynthesis.getVoices() || [];
      if (voices.length > 0) {
        const targetLangLower = langPrefix.toLowerCase().replace('_', '-');
        const shortLang = targetLangLower.split('-')[0];
        
        const matchedVoice = voices.find(v => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(targetLangLower)) ||
                             voices.find(v => v.lang && v.lang.toLowerCase().startsWith(shortLang)) ||
                             voices.find(v => v.name && v.name.toLowerCase().includes(shortLang));
                             
        if (matchedVoice) {
          utterance.voice = matchedVoice;
          if (matchedVoice.lang) utterance.lang = matchedVoice.lang;
        }
      }

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('[Mobile Speech Error]', e);
    }
  }

  if ('speechSynthesis' in window && window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = () => {
      try { window.speechSynthesis.getVoices(); } catch(e){}
    };
  }

  window.killAudio = function() {
    if (activeAzureAudio) {
      activeAzureAudio.pause();
      activeAzureAudio = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (socket) {
      socket.emit('stop_audio');
    }
    showToast('Audio playback stopped', 'info');
  };

  window.rebootSystem = function() {
    if (socket) {
      socket.emit('reboot_pc');
      showToast('Sent reboot request to PC server', 'info');
      drawerOverlay.classList.remove('active');
    }
  };

  // --- MOBILE CHAT HISTORY MANAGERS ---
  let currentSessionId = null;

  function renderMobileHistory(sessions) {
    const container = document.getElementById('mobile-history-list');
    if (!container) return;
    container.innerHTML = '';
    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div class="history-empty"><i class="fa-solid fa-comments"></i> No past conversations yet</div>';
      return;
    }

    const seen = new Set();
    const uniqueSessions = [];
    sessions.forEach(s => {
      if (s && s.id && !seen.has(s.id)) {
        seen.add(s.id);
        uniqueSessions.push(s);
      }
    });

    uniqueSessions.forEach(s => {
      const item = document.createElement('div');
      item.className = `history-item${s.id === currentSessionId ? ' active' : ''}`;
      item.onclick = () => loadHistorySessionMobile(s.id);
      
      item.innerHTML = `
        <div class="history-info">
          <span class="history-title"><i class="fa-solid fa-message" style="margin-right: 6px; font-size: 11px; color: var(--accent);"></i> ${s.title}</span>
          <span class="history-date">${s.timestamp}</span>
        </div>
        <button type="button" class="history-del-btn" title="Delete conversation" onclick="deleteHistorySessionMobile('${s.id}', event)">
          <i class="fa-solid fa-trash"></i>
        </button>
      `;
      container.appendChild(item);
    });
  }

  window.loadHistorySessionMobile = function(sessionId) {
    currentSessionId = sessionId;
    if (socket) {
      socket.emit('load_session', { id: sessionId });
    }
    if (drawerOverlay) drawerOverlay.classList.remove('active');
  };

  window.startNewChatMobile = function() {
    currentSessionId = null;
    if (socket) {
      socket.emit('new_chat');
    }
    if (chatHistory) {
      chatHistory.innerHTML = '';
      chatHistory.classList.add('hidden');
    }
    if (initialView) {
      initialView.classList.remove('hidden');
      initialView.classList.remove('fade-out');
    }
    if (orbContainer) orbContainer.classList.remove('docked');
    if (drawerOverlay) drawerOverlay.classList.remove('active');
    showToast('New Chat started', 'info');
  };

  window.deleteHistorySessionMobile = function(sessionId, event) {
    if (event) event.stopPropagation();
    if (socket) {
      socket.emit('delete_session', { id: sessionId });
    }
  };

  window.disconnectRemote = function() {
    if (socket) socket.disconnect();
    isPaired = false;
    hasShownConnectedToast = false;
    pairScreen.classList.remove('hidden');
    chatScreen.classList.add('hidden');
    drawerOverlay.classList.remove('active');
    updateBadge('Disconnected', false);
    showToast('Disconnected from PC', 'info');
  };

  // Event Listeners
  btnConnect.addEventListener('click', () => {
    const url = serverUrlInput.value;
    const tok = tokenInput.value;
    if (!url || !tok) {
      showToast('Please enter PC Server URL and Pairing Token', 'error');
      return;
    }
    connectSocket(url, tok);
  });

  btnSend.addEventListener('click', () => {
    if (isExecutingState) {
      stopTask();
    } else {
      sendPrompt();
    }
  });

  // QR Scanner Logic
  const triggerScan = async () => {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      webcamVideo.srcObject = videoStream;
      webcamVideo.play();
      scannerModal.classList.remove('hidden');
      requestAnimationFrame(scanFrame);
    } catch (e) {
      showToast('Browsers require HTTPS for camera scanner. Please enter URL/Token manually.', 'error');
    }
  };

  if (btnScan) btnScan.addEventListener('click', triggerScan);
  const btnScanToken = document.getElementById('btnScanToken');
  if (btnScanToken) btnScanToken.addEventListener('click', triggerScan);
  const btnCircleQR = document.getElementById('btnCircleQR');
  if (btnCircleQR) btnCircleQR.addEventListener('click', triggerScan);

  function closeScanner() {
    if (videoStream) {
      videoStream.getTracks().forEach(t => t.stop());
      videoStream = null;
    }
    if (animFrameId) cancelAnimationFrame(animFrameId);
    scannerModal.classList.add('hidden');
  }

  btnCancelScan.addEventListener('click', closeScanner);

  function scanFrame() {
    if (webcamVideo.readyState === webcamVideo.HAVE_ENOUGH_DATA) {
      const ctx = qrCanvas.getContext('2d');
      qrCanvas.width = webcamVideo.videoWidth;
      qrCanvas.height = webcamVideo.videoHeight;
      ctx.drawImage(webcamVideo, 0, 0, qrCanvas.width, qrCanvas.height);
      const imgData = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height);

      if (code && code.data) {
        closeScanner();
        parseQR(code.data);
        return;
      }
    }
    animFrameId = requestAnimationFrame(scanFrame);
  }

  function parseQR(data) {
    let hostOrUrl = '', tok = '';
    console.log('[Remote QR] Raw Scanned Data:', data);
    try {
      const obj = JSON.parse(data);
      hostOrUrl = obj.host_id || obj.hostId || obj.url || obj.serverUrl || '';
      tok = obj.token || obj.pairing_token || obj.pairToken || '';
    } catch (e) {
      const h = data.match(/(tilux_host_[a-zA-Z0-9_-]+)/i);
      if (h) hostOrUrl = h[1];
      const u = data.match(/(https?:\/\/[^\s]+)/i);
      if (!hostOrUrl && u) hostOrUrl = u[1];
      const t = data.match(/token=([^&\s]+)/i) || data.match(/(tilux_pair_[a-zA-Z0-9_-]+)/i);
      if (t) tok = t[1] || t[0];
    }

    if (!hostOrUrl && serverUrlInput.value) hostOrUrl = serverUrlInput.value;
    if (!tok && tokenInput.value) tok = tokenInput.value;

    if (hostOrUrl || tok) {
      if (hostOrUrl) serverUrlInput.value = hostOrUrl;
      if (tok) tokenInput.value = tok;

      const btn = document.getElementById('btnConnect');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...';
      }

      showToast('QR Code Scanned! Auto-connecting...', 'success');
      connectSocket(hostOrUrl, tok);
    } else {
      showToast('Could not read connection details from QR code.', 'error');
    }
  }

  window.togglePassVisibility = function(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      if (btn) btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
    } else {
      input.type = 'password';
      if (btn) btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
    }
  };

  window.loadMobileSudoPass = async function() {
    if (!currentUrl) return;
    try {
      const res = await fetch(`${currentUrl}/api/settings`, {
        headers: { 'bypass-tunnel-reminder': 'true' }
      });
      const data = await res.json();
      const input = document.getElementById('mobile-sudo-pass-input');
      if (input && data.sudo_password) {
        input.value = data.sudo_password;
      }
    } catch(e) {}
  };

  window.saveMobileSudoPass = async function() {
    if (!currentUrl) return;
    const input = document.getElementById('mobile-sudo-pass-input');
    if (!input) return;
    try {
      const getRes = await fetch(`${currentUrl}/api/settings`, {
        headers: { 'bypass-tunnel-reminder': 'true' }
      });
      const currentSettings = await getRes.json();
      currentSettings.sudo_password = input.value;

      await fetch(`${currentUrl}/api/settings`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'bypass-tunnel-reminder': 'true'
        },
        body: JSON.stringify(currentSettings)
      });
      showToast('Sudo Vault password saved!', 'success');
    } catch(e) {
      showToast('Failed to save Sudo Vault password', 'error');
    }
  };

  // Handle iOS Safari Keyboard & VisualViewport Lock (WhatsApp style)
  const mainContentEl = document.querySelector('.main-content');
  const chatInputEl = document.getElementById('chatInput');

  function lockWindowScroll() {
    if (window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  }

  if (window.visualViewport) {
    const handleViewportResize = () => {
      lockWindowScroll();
      if (mainContentEl) {
        const vh = window.visualViewport.height;
        mainContentEl.style.height = `${vh}px`;
      }
      if (chatHistory) {
        chatHistory.scrollTop = chatHistory.scrollHeight;
      }
    };

    window.visualViewport.addEventListener('resize', handleViewportResize);
    window.visualViewport.addEventListener('scroll', lockWindowScroll);
  }

  if (chatInputEl) {
    chatInputEl.addEventListener('focus', () => {
      setTimeout(() => {
        lockWindowScroll();
        if (window.visualViewport && mainContentEl) {
          mainContentEl.style.height = `${window.visualViewport.height}px`;
        }
        if (chatHistory) {
          chatHistory.scrollTop = chatHistory.scrollHeight;
        }
      }, 100);
    });

    chatInputEl.addEventListener('blur', () => {
      setTimeout(() => {
        lockWindowScroll();
        if (mainContentEl) {
          mainContentEl.style.height = '100%';
        }
      }, 100);
    });
  }

  window.addEventListener('scroll', lockWindowScroll);
});
