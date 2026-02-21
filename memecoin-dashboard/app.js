// Memecoin Dashboard - App Entry
(function () {
    'use strict';

    const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
    const CONFIG_URL = 'config.json';
    const API_URL = 'api.php';
    const UPDATE_INTERVAL = 60000;

    /** @type {Array<{ address: string, refs: object, lastPrice: string | null }>} */
    let cardRefs = [];

    let updateTimer = null;
    /** @type {Array<{address: string, order: number}>} */
    let tokenList = [];
    /** @type {Sortable | null} */
    let sortableInstance = null;

    /**
     * DexScreener 스타일 k, M, B 단위 포맷 (1.5M, 2.3B)
     * @param {number} n
     * @returns {string} e.g. "1.23k", "4.56M", "7.89B"
     */
    function formatDexScreener(n) {
        if (n == null || Number.isNaN(n) || n < 0) return '—';
        if (n >= 1e9) return trimTrailingZeros((n / 1e9).toFixed(2)) + 'B';
        if (n >= 1e6) return trimTrailingZeros((n / 1e6).toFixed(2)) + 'M';
        if (n >= 1e3) return trimTrailingZeros((n / 1e3).toFixed(2)) + 'k';
        return String(n);
    }

    function trimTrailingZeros(s) {
        return s.replace(/\.?0+$/, '');
    }

    function getTokens() {
        return tokenList.map((t) => t.address);
    }

    function normalizedTokenList(arr) {
        if (!Array.isArray(arr)) return [];
        return arr
            .map((t, i) => {
                const addr = typeof t === 'string' ? String(t).trim() : (t?.address && String(t.address).trim());
                if (!addr) return null;
                const order = typeof t === 'object' && typeof t.order === 'number' ? t.order : i;
                return { address: addr, order };
            })
            .filter(Boolean)
            .sort((a, b) => a.order - b.order)
            .map((t, i) => ({ address: t.address, order: i }));
    }

    async function fetchTokensFromServer() {
        try {
            const res = await fetch(CONFIG_URL + '?t=' + Date.now());
            if (!res.ok) return [];
            const data = await res.json();
            const arr = Array.isArray(data?.tokens) ? data.tokens : [];
            tokenList = normalizedTokenList(arr);
            return tokenList;
        } catch (e) {
            console.warn('fetchTokensFromServer failed', e);
            return [];
        }
    }

    async function apiAddToken(token) {
        const res = await fetch(API_URL + '?action=add&token=' + encodeURIComponent(token), { method: 'POST' });
        const data = await res.json();
        if (data && data.ok && Array.isArray(data.tokens)) {
            tokenList = normalizedTokenList(data.tokens);
            return { ok: true, tokens: data.tokens };
        }
        return { ok: false, error: (data && data.error) || 'Add failed' };
    }

    async function apiRemoveToken(token) {
        const res = await fetch(API_URL + '?action=remove&token=' + encodeURIComponent(token), { method: 'POST' });
        const data = await res.json();
        if (data && data.ok && Array.isArray(data.tokens)) {
            tokenList = normalizedTokenList(data.tokens);
            return { ok: true, tokens: data.tokens };
        }
        return { ok: false, error: (data && data.error) || 'Remove failed' };
    }

    async function apiReorderTokens(orderedAddresses) {
        if (!orderedAddresses.length) return { ok: false, error: 'Empty order' };
        const order = orderedAddresses.map((a) => encodeURIComponent(a)).join(',');
        const res = await fetch(API_URL + '?action=reorder&order=' + order, { method: 'POST' });
        const data = await res.json();
        if (data && data.ok && Array.isArray(data.tokens)) {
            tokenList = normalizedTokenList(data.tokens);
            return { ok: true, tokens: data.tokens };
        }
        return { ok: false, error: (data && data.error) || 'Reorder failed' };
    }

    async function apiGetAlerts() {
        try {
            const res = await fetch(API_URL + '?action=getAlerts');
            const data = await res.json();
            return data && data.ok && Array.isArray(data.alerts) ? { ok: true, alerts: data.alerts } : { ok: false, alerts: [] };
        } catch (e) {
            return { ok: false, alerts: [] };
        }
    }

    async function apiGetHistory() {
        try {
            const res = await fetch(API_URL + '?action=getHistory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await res.json();
            if (data && data.ok) {
                return { ok: true, items: Array.isArray(data.items) ? data.items : [], unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0 };
            }
            return { ok: false, items: [], unreadCount: 0 };
        } catch (e) {
            return { ok: false, items: [], unreadCount: 0 };
        }
    }

    async function apiSaveAlert(payload) {
        const res = await fetch(API_URL + '?action=saveAlert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data || !data.ok) {
            console.error('apiSaveAlert error:', data);
            return { ok: false, error: (data && data.error) || 'Save failed' };
        }
        return { ok: true, alerts: data.alerts || [] };
    }

    async function apiDeleteAlert(alertId) {
        const res = await fetch(API_URL + '?action=deleteAlert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alertId }),
        });
        const data = await res.json();
        return data && data.ok ? { ok: true, alerts: data.alerts || [] } : { ok: false, error: (data && data.error) || 'Delete failed' };
    }

    async function apiAddHistory(payload) {
        const res = await fetch(API_URL + '?action=addHistory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data && data.ok) {
            return { ok: true, unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0 };
        }
        return { ok: false };
    }

    async function apiMarkHistoryRead(id) {
        const res = await fetch(API_URL + '?action=markHistoryRead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(id != null ? { id } : {}),
        });
        const data = await res.json();
        if (data && data.ok) {
            return { ok: true, items: data.items || [], unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0 };
        }
        return { ok: false };
    }

    async function apiUpdateAlertLastPrice(alertId, lastPrice) {
        const res = await fetch(API_URL + '?action=updateAlertLastPrice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alertId, lastPrice }),
        });
        const data = await res.json();
        return data && data.ok ? { ok: true, alerts: data.alerts || [] } : { ok: false };
    }

    async function apiDeleteHistoryItem(itemId) {
        const res = await fetch(API_URL + '?action=deleteHistoryItem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: itemId }),
        });
        const data = await res.json();
        if (data && data.ok) {
            return { ok: true, items: data.items || [], unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0 };
        }
        return { ok: false, error: (data && data.error) || 'Delete failed' };
    }

    async function apiClearAllHistory() {
        const res = await fetch(API_URL + '?action=clearAllHistory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const data = await res.json();
        if (data && data.ok) {
            return { ok: true, items: [], unreadCount: 0 };
        }
        return { ok: false, error: (data && data.error) || 'Clear failed' };
    }

    let alertsCache = [];
    let historyUnreadCount = 0;

    const VOL5M_SPIKE_THRESHOLD = 50_000;

    function updateSpikeIndicator(el, history) {
        if (!el) return;
        const count = Array.isArray(history)
            ? history.filter(e => {
                const n = Number(e.v);
                return Number.isFinite(n) && n >= VOL5M_SPIKE_THRESHOLD;
              }).length
            : 0;
        if (count === 0) {
            el.textContent = '';
            el.style.display = 'none';
            return;
        }
        el.textContent = count >= 6 ? `⚡ x${count}` : '⚡'.repeat(count);
        el.style.display = 'block';
    }

    function updateFireIndicator(fireIndicator, volume1h) {
        if (!fireIndicator) return;
        const vol = volume1h != null && !Number.isNaN(Number(volume1h)) ? Number(volume1h) : 0;
        let text = '';
        if      (vol >= 4_000_000) text = '🔥🔥🔥+';
        else if (vol >= 3_000_000) text = '🔥🔥🔥';
        else if (vol >= 2_000_000) text = '🔥🔥';
        else if (vol >= 1_000_000) text = '🔥';
        else if (vol >=   500_000) text = '💧';
        fireIndicator.textContent = text;
        fireIndicator.style.display = text ? 'block' : 'none';
    }

    function updateHistoryBadge(count) {
        historyUnreadCount = count;
        const wrap = document.getElementById('header-history-wrap');
        if (!wrap) return;
        const badge = wrap.querySelector('.history-badge');
        if (badge) {
            if (count <= 0) {
                badge.classList.add('history-badge--hidden');
                badge.textContent = '0';
            } else {
                badge.classList.remove('history-badge--hidden');
                badge.textContent = count > 99 ? '99+' : String(count);
            }
        }
    }

    let alertModalEl = null;
    let historyPanelEl = null;
    let historyPollInProgress = false;

    function getOrCreateAlertModal() {
        if (alertModalEl) return alertModalEl;
        const overlay = document.createElement('div');
        overlay.className = 'alert-modal-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        const box = document.createElement('div');
        box.className = 'alert-modal-box';
        box.innerHTML = '<h3 class="alert-modal-title">Price alerts</h3><p class="alert-modal-token"></p><div class="alert-modal-list"></div><div class="alert-modal-form"><label>Target price <input type="number" step="any" min="0" class="alert-modal-price" placeholder="0.00"></label><button type="button" class="alert-modal-save control-btn"><span class="control-btn-icon">+</span>Add alert</button></div><button type="button" class="alert-modal-close" aria-label="Close">&times;</button>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAlertsModal(); });
        box.querySelector('.alert-modal-close').addEventListener('click', () => closeAlertsModal());
        alertModalEl = { overlay, box, tokenLabel: box.querySelector('.alert-modal-token'), list: box.querySelector('.alert-modal-list'), priceInput: box.querySelector('.alert-modal-price'), saveBtn: box.querySelector('.alert-modal-save') };
        return alertModalEl;
    }

    function openAlertsModal(tokenAddress, tokenSymbol, currentPrice) {
        const modal = getOrCreateAlertModal();
        modal.box.dataset.tokenAddress = tokenAddress;
        modal.box.dataset.tokenSymbol = tokenSymbol;
        modal.tokenLabel.textContent = tokenSymbol + (currentPrice != null ? ' · $' + formatPrice(String(currentPrice)) : '');
        modal.priceInput.placeholder = '0.00';
        modal.priceInput.value = currentPrice != null ? formatPrice(String(currentPrice)) : '';
        renderModalAlertsList(tokenAddress);
        modal.saveBtn.onclick = () => {
            const targetPrice = parseFloat(modal.priceInput.value);
            if (Number.isNaN(targetPrice) || targetPrice <= 0) {
                showToast('Enter a valid target price');
                return;
            }
            apiSaveAlert({
                tokenAddress,
                tokenSymbol,
                targetPrice,
            }).then((r) => {
                if (r.ok) {
                    alertsCache = r.alerts;
                    renderModalAlertsList(tokenAddress);
                    modal.priceInput.value = '';
                    showToast('Alert added');
                } else {
                    console.error('Failed to save alert:', r.error);
                    showToast(r.error || 'Failed to save');
                }
            });
        };
        modal.overlay.classList.add('alert-modal-overlay--open');
        modal.overlay.setAttribute('aria-hidden', 'false');
        modal.priceInput.focus();
        modal.priceInput.select();
    }

    function closeAlertsModal() {
        if (!alertModalEl) return;
        alertModalEl.overlay.classList.remove('alert-modal-overlay--open');
        alertModalEl.overlay.setAttribute('aria-hidden', 'true');
    }

    function renderModalAlertsList(tokenAddress) {
        const modal = getOrCreateAlertModal();
        const list = modal.list;
        list.innerHTML = '';
        const forToken = (alertsCache || []).filter((a) => a.tokenAddress === tokenAddress);
        if (forToken.length === 0) {
            list.innerHTML = '<p class="alert-modal-empty">No alerts for this token.</p>';
            return;
        }
        for (const a of forToken) {
            const row = document.createElement('div');
            row.className = 'alert-modal-row';
            const desc = document.createElement('span');
            desc.textContent = '$' + formatPrice(String(a.targetPrice));
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'alert-modal-delete';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => {
                const addr = alertModalEl && alertModalEl.box.dataset.tokenAddress;
                apiDeleteAlert(a.id).then((r) => {
                    if (r.ok) {
                        alertsCache = r.alerts;
                        if (addr) renderModalAlertsList(addr);
                        showToast('Alert removed');
                    }
                });
            });
            row.append(desc, delBtn);
            list.appendChild(row);
        }
    }

    function getOrCreateHistoryPanel() {
        if (historyPanelEl) return historyPanelEl;
        const wrap = document.getElementById('header-history-wrap');
        if (!wrap) return null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history-trigger';
        btn.title = 'Alert history';
        btn.setAttribute('aria-label', 'Alert history');
        btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3"></path><circle cx="12" cy="12" r="10"></circle></svg><span class="history-badge history-badge--hidden">0</span>';
        const panel = document.createElement('div');
        panel.className = 'history-panel';
        panel.innerHTML = '<div class="history-panel-header"><span>Alert history</span><div class="history-panel-header-actions"><button type="button" class="history-clear-all">Clear all history</button><button type="button" class="history-mark-read">Mark all read</button></div></div><div class="history-panel-list"></div><p class="history-panel-empty">No alerts triggered yet.</p>';
        wrap.appendChild(btn);
        wrap.appendChild(panel);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleHistoryPanel();
        });
        panel.querySelector('.history-mark-read').addEventListener('click', () => {
            apiMarkHistoryRead(null).then((r) => {
                if (r.ok) {
                    updateHistoryBadge(r.unreadCount);
                    renderHistoryPanelList(r.items);
                }
            });
        });
        panel.querySelector('.history-clear-all').addEventListener('click', () => {
            if (confirm('Clear all alert history?')) {
                apiClearAllHistory().then((r) => {
                    if (r.ok) {
                        updateHistoryBadge(r.unreadCount);
                        renderHistoryPanelList(r.items);
                    } else {
                        showToast(r.error || 'Failed to clear history');
                    }
                });
            }
        });
        document.addEventListener('click', (e) => {
            if (historyPanelEl && panel.classList.contains('history-panel--open') && !panel.contains(e.target) && !btn.contains(e.target)) {
                panel.classList.remove('history-panel--open');
            }
        });
        historyPanelEl = { wrap, btn, panel, list: panel.querySelector('.history-panel-list'), empty: panel.querySelector('.history-panel-empty') };
        return historyPanelEl;
    }

    function toggleHistoryPanel() {
        const h = getOrCreateHistoryPanel();
        if (!h) return;
        h.panel.classList.toggle('history-panel--open');
        if (h.panel.classList.contains('history-panel--open')) {
            apiGetHistory().then((r) => {
                if (r.ok) {
                    updateHistoryBadge(r.unreadCount);
                    renderHistoryPanelList(r.items);
                }
            });
        }
    }

    function applySpikeHighlightsFromHistory(items) {
        if (!Array.isArray(items) || !cardRefs.length) return;
        const nowMs = Date.now();
        const addressSet = new Set();
        const symbolToAddress = new Map();
        for (const ref of cardRefs) {
            const s = ref.refs?.tickerEl?.textContent?.trim().toUpperCase();
            if (s) symbolToAddress.set(s, ref.address);
        }
        for (const it of items) {
            const isSpike = (it.type || '') === 'volume_spike' || (typeof (it.note || '') === 'string' && it.note.includes('5m Vol Spike'));
            if (!isSpike) continue;
            const eventTsMs = (it.triggeredAt != null ? Number(it.triggeredAt) : 0) * 1000;
            if (nowMs - eventTsMs > SPIKE_HIGHLIGHT_WINDOW_MS) continue;
            const addr = it.tokenAddress || it.address;
            if (addr) {
                addressSet.add(addr);
            } else if (it.tokenSymbol) {
                const a = symbolToAddress.get(String(it.tokenSymbol).trim().toUpperCase());
                if (a) addressSet.add(a);
            }
        }
        for (const ref of cardRefs) {
            const card = ref.refs?.card;
            if (card) card.classList.toggle('token-card--spike', addressSet.has(ref.address));
        }
    }

    function pollHistoryUnread() {
        if (historyPollInProgress) return;
        historyPollInProgress = true;
        apiGetHistory()
            .then((r) => {
                if (r && typeof r.unreadCount === 'number') updateHistoryBadge(r.unreadCount);
                if (r && r.ok && Array.isArray(r.items)) applySpikeHighlightsFromHistory(r.items);
                if (historyPanelEl && historyPanelEl.panel.classList.contains('history-panel--open') && r && r.ok) {
                    renderHistoryPanelList(r.items);
                }
            })
            .catch((e) => {
                console.warn('pollHistoryUnread failed', e);
            })
            .finally(() => {
                historyPollInProgress = false;
            });
    }

    function formatKST(timestamp) {
        const date = new Date(timestamp * 1000);
        const kstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
        const year = kstDate.getUTCFullYear();
        const month = String(kstDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(kstDate.getUTCDate()).padStart(2, '0');
        const hours = String(kstDate.getUTCHours()).padStart(2, '0');
        const minutes = String(kstDate.getUTCMinutes()).padStart(2, '0');
        const seconds = String(kstDate.getUTCSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} KST`;
    }

    function renderHistoryPanelList(items) {
        const h = historyPanelEl;
        if (!h) return;
        h.list.innerHTML = '';
        const list = Array.isArray(items) ? items : [];
        h.empty.classList.toggle('history-panel-empty--hidden', list.length > 0);
        for (const it of list) {
            const isVolumeSpike = (it.type || '') === 'volume_spike';
            const row = document.createElement('div');
            row.className = 'history-panel-row' + (it.read ? ' history-panel-row--read' : '');
            row.dataset.type = isVolumeSpike ? 'volume_spike' : 'price_alert';
            const timeStr = formatKST(it.triggeredAt);
            let contentHtml;
            if (isVolumeSpike) {
                const symbol = (it.tokenSymbol || '—').toString().toUpperCase();
                const rawNote = (it.note || '').toString();
                // 구버전 note에 남아있는 " MC" 접미사 제거
                const spikeLine = rawNote.replace(/\s+MC\s*$/, '').trim();
                let mcLine = '';
                if (it.marketCap != null && Number.isFinite(Number(it.marketCap))) {
                    mcLine = 'MC: $' + formatDexScreener(Number(it.marketCap));
                }
                contentHtml = '<span class="history-panel-symbol">' + escapeHtml(symbol) + '</span>'
                    + '<span class="history-panel-detail">' + escapeHtml(spikeLine) + '</span>'
                    + (mcLine ? '<span class="history-panel-detail">' + escapeHtml(mcLine) + '</span>' : '')
                    + '<time class="history-panel-time">' + escapeHtml(timeStr) + '</time>'
                    + '<button type="button" class="history-item-delete" aria-label="Delete">×</button>';
            } else {
                contentHtml = '<span class="history-panel-symbol">' + escapeHtml(it.tokenSymbol) + '</span> <span class="history-panel-detail">crossed $' + formatPrice(String(it.targetPrice)) + ' → $' + formatPrice(String(it.actualPrice)) + '</span> <time class="history-panel-time">' + escapeHtml(timeStr) + '</time><button type="button" class="history-item-delete" aria-label="Delete">×</button>';
            }
            row.innerHTML = contentHtml;
            // 개별 카드 클릭 → read 처리
            row.addEventListener('click', () => {
                if (row.classList.contains('history-panel-row--read')) return;
                apiMarkHistoryRead(it.id).then((r) => {
                    if (r.ok) {
                        row.classList.add('history-panel-row--read');
                        updateHistoryBadge(r.unreadCount);
                    }
                });
            });
            const deleteBtn = row.querySelector('.history-item-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                apiDeleteHistoryItem(it.id).then((r) => {
                    if (r.ok) {
                        updateHistoryBadge(r.unreadCount);
                        renderHistoryPanelList(r.items);
                    } else {
                        showToast(r.error || 'Failed to delete');
                    }
                });
            });
            h.list.appendChild(row);
        }
    }

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    async function copyAddressToClipboard(address) {
        const ca = typeof address === 'string' ? address.trim() : '';
        if (!ca) {
            console.warn('copyAddressToClipboard: no address');
            showToast('Copy failed!');
            return;
        }
        console.log('Copying CA:', ca);
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(ca);
                showToast('CA copied!');
                return;
            }
            const textArea = document.createElement('textarea');
            textArea.value = ca;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '0';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (ok) {
                showToast('CA copied!');
            } else {
                console.error('Copy failed: execCommand returned false');
                showToast('Copy failed!');
            }
        } catch (err) {
            console.error('Copy failed:', err);
            showToast('Copy failed!');
        }
    }

    function showToast(message) {
        let t = document.getElementById('toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'toast';
            t.className = 'toast';
            document.body.appendChild(t);
        }
        t.textContent = message;
        t.classList.remove('toast--out');
        t.offsetHeight;
        t.classList.add('toast--visible');
        if (t._hide) clearTimeout(t._hide);
        t._hide = setTimeout(() => {
            t.classList.add('toast--out');
            t._hide = setTimeout(() => {
                t.classList.remove('toast--visible', 'toast--out');
                t._hide = null;
            }, 300);
        }, 2000);
    }

    function validateContractAddress(addr) {
        const s = typeof addr === 'string' ? addr.trim() : '';
        if (!s) return { ok: false, msg: 'Address is required.' };
        if (s.length < 20 || s.length > 66) return { ok: false, msg: 'Invalid address length.' };
        return { ok: true };
    }

    /**
     * DexScreener API 응답 파싱: name, symbol, priceUsd, fdv, marketCap, volume (h24) 추출.
     */
    function parseDexScreenerResponse(apiResponse) {
        const pairs = apiResponse?.pairs;
        if (!Array.isArray(pairs) || pairs.length === 0) return null;

        const sorted = [...pairs].sort((a, b) => {
            const liqA = a.liquidity?.usd ?? 0;
            const liqB = b.liquidity?.usd ?? 0;
            return liqB - liqA;
        });
        const pair = sorted[0];
        const base = pair.baseToken || {};
        const name = typeof base.name === 'string' ? base.name.trim() || '—' : '—';
        const symbol = typeof base.symbol === 'string' ? base.symbol.trim() || '—' : '—';
        const imageUrl = base.info?.imageUrl || base.imageUrl || pair.info?.imageUrl || null;
        const priceUsd = pair.priceUsd != null && pair.priceUsd !== '' ? String(pair.priceUsd) : null;
        const marketCap = pair.marketCap != null && !Number.isNaN(Number(pair.marketCap)) ? Number(pair.marketCap) : null;
        const fdv = pair.fdv != null && !Number.isNaN(Number(pair.fdv)) ? Number(pair.fdv) : null;
        const volume24h = pair.volume?.h24 != null && !Number.isNaN(Number(pair.volume.h24)) ? Number(pair.volume.h24) : null;
        const volume1h  = pair.volume?.h1  != null && !Number.isNaN(Number(pair.volume.h1))  ? Number(pair.volume.h1)  : null;
        const volume5m  = pair.volume?.m5  != null && !Number.isNaN(Number(pair.volume.m5))  ? Number(pair.volume.m5)  : null;

        let twitterUrl = null;
        const socials = base.info?.socials || pair.info?.socials;
        if (Array.isArray(socials)) {
            const twitter = socials.find((s) => s && typeof s === 'object' && s.type === 'twitter' && typeof s.url === 'string');
            if (twitter && twitter.url) twitterUrl = twitter.url.trim();
        }

        const chainId = pair.chainId != null ? String(pair.chainId).toLowerCase() : '';
        const GMGN_CHAIN_MAP = { solana: 'sol', base: 'base', bsc: 'bsc', ethereum: 'eth', arbitrum: 'arb', polygon: 'polygon', avalanche: 'avax' };
        const gmgnChain = GMGN_CHAIN_MAP[chainId] || chainId || 'sol';

        return { name, symbol, imageUrl, priceUsd, marketCap, fdv, volume24h, volume1h, volume5m, twitterUrl, chainId, gmgnChain, pair };
    }

    async function fetchTokenData(address) {
        const url = `${DEXSCREENER_API}/${encodeURIComponent(address)}`;
        try {
            const res = await fetch(url);
            if (!res.ok) return { data: null, error: `HTTP ${res.status}` };
            const json = await res.json();
            const data = parseDexScreenerResponse(json);
            if (!data) return { data: null, error: 'No pairs' };
            return { data, error: null };
        } catch (e) {
            return { data: null, error: e?.message || 'Request failed' };
        }
    }

    function formatPrice(s) {
        const n = parseFloat(s);
        if (Number.isNaN(n)) return '—';
        if (n >= 1e6) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
        if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
        if (n >= 1e-6) return n.toFixed(6);
        return n.toFixed(6);
    }

    function createTokenCard(item) {
        const { address, data, error } = item;
        const card = document.createElement('article');
        card.className = 'token-card';
        card.dataset.address = address;
        if (error) card.classList.add('token-card--error');

        const fireIndicator = document.createElement('div');
        fireIndicator.className = 'token-fire-indicator';
        card.appendChild(fireIndicator);

        const spikeIndicator = document.createElement('div');
        spikeIndicator.className = 'token-spike-indicator';
        spikeIndicator.style.display = 'none';
        card.appendChild(spikeIndicator);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'token-card-delete';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.title = 'Remove token';
        deleteBtn.addEventListener('click', () => removeToken(address));

        const info = document.createElement('div');
        info.className = 'card-info';

        const logoRow = document.createElement('div');
        logoRow.className = 'card-info-logo-row';
        const logoWrap = document.createElement('div');
        logoWrap.className = 'token-logo';
        const logoImg = document.createElement('img');
        logoImg.className = 'token-logo-img';
        logoImg.alt = '';
        logoImg.width = 32;
        logoImg.height = 32;
        const logoFallback = document.createElement('span');
        logoFallback.className = 'token-logo-fallback';
        const fallbackLetter = (data?.symbol || '?')[0].toUpperCase();
        logoFallback.textContent = error ? '?' : fallbackLetter;
        if (data?.imageUrl && typeof data.imageUrl === 'string') {
            logoImg.src = data.imageUrl;
            logoImg.classList.add('token-logo-img--visible');
            logoImg.addEventListener('error', () => {
                logoImg.classList.remove('token-logo-img--visible');
                logoFallback.textContent = (data?.symbol || '?')[0].toUpperCase();
            });
        }
        logoWrap.appendChild(logoImg);
        logoWrap.appendChild(logoFallback);
        logoRow.appendChild(logoWrap);

        const tickerEl = document.createElement('div');
        tickerEl.className = 'token-ticker';
        if (error) {
            tickerEl.textContent = 'Error loading';
        } else {
            tickerEl.textContent = data?.symbol ? String(data.symbol).toUpperCase() : '—';
        }

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'token-copy-btn';
        copyBtn.title = 'Copy contract address';
        copyBtn.setAttribute('aria-label', 'Copy contract address');
        copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = e.currentTarget.closest('.token-card');
            const addr = address || (card && card.dataset.address);
            copyAddressToClipboard(addr);
        });

        const tickerRow = document.createElement('div');
        tickerRow.className = 'ticker-row';
        tickerRow.append(tickerEl, copyBtn);

        const socialLinksRow = document.createElement('div');
        socialLinksRow.className = 'social-links-row';

        if (data?.twitterUrl) {
            const twitterBtn = document.createElement('a');
            twitterBtn.href = data.twitterUrl;
            twitterBtn.target = '_blank';
            twitterBtn.rel = 'noopener noreferrer';
            twitterBtn.className = 'token-twitter-btn';
            twitterBtn.title = 'Open Twitter/X';
            twitterBtn.setAttribute('aria-label', 'Open Twitter/X');
            twitterBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
            twitterBtn.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            socialLinksRow.appendChild(twitterBtn);
        }

        const gmgnChain = data?.gmgnChain || 'sol';
        const gmgnUrl = `https://gmgn.ai/${gmgnChain}/token/${encodeURIComponent(address)}`;
        const gmgnBtn = document.createElement('a');
        gmgnBtn.href = gmgnUrl;
        gmgnBtn.target = '_blank';
        gmgnBtn.rel = 'noopener noreferrer';
        gmgnBtn.className = 'token-gmgn-btn';
        gmgnBtn.title = 'Open on GMGN';
        gmgnBtn.setAttribute('aria-label', 'Open on GMGN');
        gmgnBtn.textContent = 'G';
        gmgnBtn.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        socialLinksRow.appendChild(gmgnBtn);

        const alertBtn = document.createElement('button');
        alertBtn.type = 'button';
        alertBtn.className = 'token-alert-btn';
        alertBtn.title = 'Price alerts';
        alertBtn.setAttribute('aria-label', 'Price alerts');
        alertBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>';
        alertBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const price = data?.priceUsd != null ? parseFloat(data.priceUsd) : null;
            openAlertsModal(address, (data?.symbol || '—').toString(), price);
        });
        socialLinksRow.appendChild(alertBtn);

        const priceEl = document.createElement('div');
        priceEl.className = 'token-price';
        priceEl.textContent = data?.priceUsd != null ? `$${formatPrice(data.priceUsd)}` : '—';

        const stats = document.createElement('div');
        stats.className = 'token-stats';
        const fdvLbl = document.createElement('span');
        fdvLbl.className = 'token-stat-label';
        fdvLbl.textContent = 'FDV ';
        const fdvVal = document.createElement('span');
        fdvVal.className = 'token-stat-value';
        fdvVal.textContent = formatDexScreener(data?.fdv);
        const fdvEl = document.createElement('div');
        fdvEl.className = 'token-stat';
        fdvEl.append(fdvLbl, fdvVal);
        const mcLbl = document.createElement('span');
        mcLbl.className = 'token-stat-label';
        mcLbl.textContent = 'MC ';
        const mcVal = document.createElement('span');
        mcVal.className = 'token-stat-value';
        mcVal.textContent = formatDexScreener(data?.marketCap);
        const mcEl = document.createElement('div');
        mcEl.className = 'token-stat';
        mcEl.append(mcLbl, mcVal);
        const volLbl = document.createElement('span');
        volLbl.className = 'token-stat-label';
        volLbl.textContent = '24h V ';
        const volVal = document.createElement('span');
        volVal.className = 'token-stat-value';
        volVal.textContent = formatDexScreener(data?.volume24h);
        const volEl = document.createElement('div');
        volEl.className = 'token-stat';
        volEl.append(volLbl, volVal);
        stats.append(fdvEl, mcEl, volEl);

        info.append(logoRow, tickerRow, priceEl, socialLinksRow, stats);
        card.append(deleteBtn, info);

        updateFireIndicator(fireIndicator, data?.volume1h);

        const refs = {
            card, tickerEl, priceEl, fdvVal, mcVal, volVal,
            logoImg, logoFallback,
            fireIndicator, spikeIndicator,
        };
        return { card, refs };
    }

    function updateCardContent(refs, item, prevPrice) {
        const { address, data, error } = item;
        refs.card.classList.toggle('token-card--error', !!error);
        if (error) {
            refs.tickerEl.textContent = 'Error loading';
        } else {
            refs.tickerEl.textContent = data?.symbol ? String(data.symbol).toUpperCase() : '—';
        }
        const newPrice = data?.priceUsd ?? null;
        const prev = prevPrice != null && !Number.isNaN(Number(prevPrice)) ? Number(prevPrice) : null;
        const curr = newPrice != null && !Number.isNaN(Number(newPrice)) ? Number(newPrice) : null;
        const priceChanged = prev != null && curr != null && prev !== curr;
        refs.priceEl.textContent = newPrice != null ? `$${formatPrice(newPrice)}` : '—';
        if (priceChanged) {
            refs.priceEl.classList.remove('price-pulse');
            refs.priceEl.offsetHeight;
            refs.priceEl.classList.add('price-pulse');
            setTimeout(() => refs.priceEl.classList.remove('price-pulse'), 500);
        }
        refs.fdvVal.textContent = formatDexScreener(data?.fdv);
        refs.mcVal.textContent = formatDexScreener(data?.marketCap);
        refs.volVal.textContent = formatDexScreener(data?.volume24h);

        updateFireIndicator(refs.fireIndicator, data?.volume1h);

        const fallbackLetter = (data?.symbol || '?')[0].toUpperCase();
        if (refs.logoFallback) refs.logoFallback.textContent = error ? '?' : fallbackLetter;
        if (refs.logoImg) {
            if (error) {
                refs.logoImg.classList.remove('token-logo-img--visible');
            } else if (data?.imageUrl) {
                refs.logoImg.src = data.imageUrl;
                refs.logoImg.classList.add('token-logo-img--visible');
            } else {
                refs.logoImg.classList.remove('token-logo-img--visible');
            }
        }
    }

    function renderTokenCards(grid, list, opts) {
        const addedAddress = opts && opts.addedAddress;
        destroySortable();
        cardRefs = [];
        grid.innerHTML = '';

        const fragment = document.createDocumentFragment();
        for (const item of list) {
            const out = createTokenCard(item);
            if (addedAddress && item.address === addedAddress) out.card.classList.add('token-card--enter');
            const newRef = {
                address: item.address,
                refs: out.refs,
                lastPrice: item.data?.priceUsd ?? null,
                vol5mHistory: [],
                lastGoodData: item.data ?? null,
                lastSnapshotBucketKey: null,
                lastPriceAlertTs: null,
            };
            if (newRef.lastGoodData) prefillVol5mHistory(newRef);
            cardRefs.push(newRef);
            fragment.appendChild(out.card);
        }
        grid.appendChild(fragment);
        initSortable(grid);
    }

    function destroySortable() {
        if (sortableInstance) {
            sortableInstance.destroy();
            sortableInstance = null;
        }
    }

    const DRAG_SCROLL_EDGE = 100;
    const DRAG_SCROLL_SPEED = 12;

    function initSortable(grid) {
        destroySortable();
        const cards = grid.querySelectorAll('.token-card');
        if (!cards.length || typeof Sortable === 'undefined') return;

        let scrollVelocity = 0;
        let scrollRafId = null;
        let dragMoveBound = null;
        let dragScrollActive = false;

        function applyScroll() {
            if (!dragScrollActive) return;
            if (scrollVelocity !== 0) {
                window.scrollBy(0, scrollVelocity);
            }
            scrollRafId = requestAnimationFrame(applyScroll);
        }

        sortableInstance = new Sortable(grid, {
            animation: 150,
            filter: '.token-card-delete, .token-copy-btn, .token-twitter-btn, .token-gmgn-btn, .token-alert-btn',
            ghostClass: 'sortable-ghost',
            onStart(evt) {
                evt.item.classList.add('token-card--dragging');
                scrollVelocity = 0;
                dragScrollActive = true;
                scrollRafId = requestAnimationFrame(applyScroll);
                dragMoveBound = (e) => {
                    const y = e.clientY;
                    const top = DRAG_SCROLL_EDGE;
                    const bottom = window.innerHeight - DRAG_SCROLL_EDGE;
                    if (y < top) {
                        scrollVelocity = -DRAG_SCROLL_SPEED * (top - y) / top;
                    } else if (y > bottom) {
                        scrollVelocity = DRAG_SCROLL_SPEED * (y - bottom) / DRAG_SCROLL_EDGE;
                    } else {
                        scrollVelocity = 0;
                    }
                };
                document.addEventListener('mousemove', dragMoveBound);
            },
            onEnd(evt) {
                evt.item.classList.remove('token-card--dragging');
                dragScrollActive = false;
                document.removeEventListener('mousemove', dragMoveBound);
                scrollVelocity = 0;
                if (scrollRafId != null) {
                    cancelAnimationFrame(scrollRafId);
                    scrollRafId = null;
                }
                const ordered = Array.from(grid.querySelectorAll('.token-card')).map((el) => el.dataset.address).filter(Boolean);
                if (ordered.length === 0) return;
                apiReorderTokens(ordered).then((res) => {
                    if (!res.ok) return;
                    const byAddr = new Map(cardRefs.map((e) => [e.address, e]));
                    const newRefs = [];
                    for (const a of ordered) {
                        const x = byAddr.get(a);
                        if (x) newRefs.push(x);
                    }
                    cardRefs.length = 0;
                    cardRefs.push(...newRefs);
                });
            },
        });
    }

    function showEmptyState(grid) {
        destroySortable();
        grid.innerHTML = '<p class="empty-state">No tokens added. Add a contract address above.</p>';
        cardRefs = [];
    }

    const SPIKE_HIGHLIGHT_WINDOW_MS = 10 * 60 * 1000; // 10분 (서버 히스토리 기준 테두리 유지)

    function getBucketKey(now) {
        const year        = now.getUTCFullYear();
        const month       = now.getUTCMonth() + 1; // 1-based
        const date        = now.getUTCDate();
        const hour        = now.getUTCHours();
        const bucketIndex = Math.floor(now.getUTCMinutes() / 5); // 0–11
        return `${year}-${month}-${date}-${hour}-${bucketIndex}`;
    }

    function prefillVol5mHistory(ref) {
        if (!ref.lastGoodData) return;
        const raw = ref.lastGoodData.volume5m;
        const v = Number(raw);
        if (!Number.isFinite(v)) return;
        const now = new Date();
        ref.vol5mHistory = [{ t: now.toISOString(), v }];
        ref.lastSnapshotBucketKey = getBucketKey(now);
        updateSpikeIndicator(ref.refs.spikeIndicator, ref.vol5mHistory);
        console.debug('[vol5m prefill]', ref.address, 'volume5m =', v, 'history =', ref.vol5mHistory);
    }

    function trySnapshotVol5m() {
        const now = new Date();
        const bucketKey = getBucketKey(now);
        for (const ref of cardRefs) {
            if (ref.lastSnapshotBucketKey === bucketKey) continue;
            if (!ref.lastGoodData) continue;
            const v = Number(ref.lastGoodData.volume5m);
            if (!Number.isFinite(v)) continue;
            ref.lastSnapshotBucketKey = bucketKey;
            ref.vol5mHistory.push({ t: now.toISOString(), v });
            if (ref.vol5mHistory.length > 12) ref.vol5mHistory.shift();
            updateSpikeIndicator(ref.refs.spikeIndicator, ref.vol5mHistory);
            console.debug('[vol5m snapshot]', ref.address, 'bucket =', bucketKey, 'v =', v, 'history =', ref.vol5mHistory.map(e => e.v));
        }
    }

    function startUpdateTimer() {
        stopUpdateTimer();
        updateTimer = setInterval(async () => {
            try {
                await updateAllTokens();
            } catch (e) {
                console.error('updateAllTokens failed', e);
            }
            trySnapshotVol5m();
            pollHistoryUnread();
        }, UPDATE_INTERVAL);
    }

    function stopUpdateTimer() {
        if (updateTimer) {
            clearInterval(updateTimer);
            updateTimer = null;
        }
    }

    async function updateAllTokens() {
        const grid = document.querySelector('.token-grid');
        const indicator = document.querySelector('.update-indicator');
        const addresses = getTokens();
        if (!grid || !addresses.length || !cardRefs.length) return;

        if (indicator) indicator.classList.add('update-indicator--active');
        grid.classList.add('token-grid--updating');
        try {
            const results = await Promise.all(
                addresses.map(async (address) => {
                    const { data, error } = await fetchTokenData(address);
                    return { address, data, error };
                })
            );
            for (let i = 0; i < results.length && i < cardRefs.length; i++) {
                if (cardRefs[i].address !== results[i].address) continue;
                const ref = cardRefs[i];
                updateCardContent(ref.refs, results[i], ref.lastPrice);
                ref.lastPrice = results[i].data?.priceUsd ?? null;
                if (results[i].data != null) {
                    const isFirstData = ref.lastGoodData == null;
                    ref.lastGoodData = results[i].data;
                    if (isFirstData) prefillVol5mHistory(ref);
                }
            }
            await checkAlerts(results);
        } finally {
            grid.classList.remove('token-grid--updating');
            if (indicator) indicator.classList.remove('update-indicator--active');
        }
    }

    const PRICE_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

    async function checkAlerts(results) {
        const alerts = alertsCache.length ? alertsCache : (await apiGetAlerts()).alerts;
        if (alerts.length === 0) return;
        alertsCache = alerts;
        const activeAlerts = alerts.filter((a) => !a.triggeredAt);
        if (activeAlerts.length === 0) return;
        const now = Date.now();
        for (const r of results) {
            const price = r.data?.priceUsd != null ? parseFloat(r.data.priceUsd) : null;
            if (price == null || Number.isNaN(price)) continue;
            const symbol = (r.data?.symbol || '—').toString();
            const cardRef = cardRefs.find((c) => c.address === r.address);
            for (const a of activeAlerts) {
                if (a.tokenAddress !== r.address) continue;
                const target = Number(a.targetPrice);
                if (Number.isNaN(target)) continue;
                const lastPrice = a.lastPrice != null ? Number(a.lastPrice) : null;
                let crossed = false;
                if (lastPrice == null || Number.isNaN(lastPrice)) {
                    await apiUpdateAlertLastPrice(a.id, price);
                    alertsCache = (await apiGetAlerts()).alerts;
                    continue;
                } else {
                    const wasBelow = lastPrice < target;
                    const isAbove = price >= target;
                    const wasAbove = lastPrice > target;
                    const isBelow = price <= target;
                    crossed = (wasBelow && isAbove) || (wasAbove && isBelow);
                }
                if (!crossed) {
                    await apiUpdateAlertLastPrice(a.id, price);
                    alertsCache = (await apiGetAlerts()).alerts;
                    continue;
                }
                // 5분 쿨다운 — 동일 토큰에 대해 채널 구분 없이 적용
                if (cardRef && cardRef.lastPriceAlertTs != null &&
                    now - cardRef.lastPriceAlertTs < PRICE_ALERT_COOLDOWN_MS) {
                    await apiUpdateAlertLastPrice(a.id, price);
                    alertsCache = (await apiGetAlerts()).alerts;
                    continue;
                }
                const addRes = await apiAddHistory({
                    tokenAddress: a.tokenAddress,
                    tokenSymbol: a.tokenSymbol || symbol,
                    targetPrice: target,
                    actualPrice: price,
                    type: 'price_alert',
                    marketCap: r.data?.marketCap ?? null,
                    volume1h: r.data?.volume1h ?? null,
                    volume24h: r.data?.volume24h ?? null,
                });
                if (addRes.ok && addRes.unreadCount != null) updateHistoryBadge(addRes.unreadCount);
                if (cardRef) cardRef.lastPriceAlertTs = now;
                await apiUpdateAlertLastPrice(a.id, price);
                alertsCache = (await apiGetAlerts()).alerts;
            }
        }
    }

    async function addToken(address) {
        const addr = typeof address === 'string' ? address.trim() : '';
        const valid = validateContractAddress(addr);
        if (!valid.ok) {
            alert(valid.msg);
            return;
        }

        const tokens = getTokens();
        if (tokens.includes(addr)) {
            alert('Token already added.');
            return;
        }

        const btn = document.getElementById('add-token-btn');
        const input = document.getElementById('token-address-input');
        if (btn) btn.disabled = true;

        const { data, error } = await fetchTokenData(addr);
        if (error) {
            alert('Invalid or not found. Check the contract address.');
            if (btn) btn.disabled = false;
            return;
        }

        const api = await apiAddToken(addr);
        if (!api.ok) {
            alert(api.error || 'Failed to add token.');
            if (btn) btn.disabled = false;
            return;
        }

        const grid = document.querySelector('.token-grid');
        if (!grid) {
            if (btn) btn.disabled = false;
            return;
        }

        const next = getTokens();
        const results = await Promise.all(
            next.map(async (a) => {
                const r = a === addr ? { address: a, data, error: null } : await fetchTokenData(a).then((x) => ({ address: a, ...x }));
                return r;
            })
        );
        renderTokenCards(grid, results, { addedAddress: addr });

        if (input) input.value = '';
        if (btn) btn.disabled = false;

        if (next.length === 1) startUpdateTimer();
    }

    async function removeToken(address) {
        const grid = document.querySelector('.token-grid');
        if (!grid) return;

        const api = await apiRemoveToken(address);
        if (!api.ok) {
            alert(api.error || 'Failed to remove token.');
            return;
        }

        const tokens = getTokens();

        if (tokens.length === 0) {
            showEmptyState(grid);
            stopUpdateTimer();
            return;
        }

        const idx = cardRefs.findIndex((c) => c.address === address);
        if (idx < 0) return;

        const { refs } = cardRefs[idx];
        refs.card.classList.add('token-card--exit');
        let done = false;
        const onDone = () => {
            if (done) return;
            done = true;
            refs.card.remove();
            cardRefs.splice(idx, 1);
        };
        refs.card.addEventListener('animationend', onDone, { once: true });
        setTimeout(onDone, 400);
    }

    async function initialRender(addresses) {
        const grid = document.querySelector('.token-grid');
        if (!grid) return;

        const list = Array.isArray(addresses) && addresses.length ? addresses : getTokens();
        if (!list.length) {
            showEmptyState(grid);
            return;
        }

        const results = await Promise.all(
            list.map(async (address) => {
                const { data, error } = await fetchTokenData(address);
                return { address, data, error };
            })
        );
        renderTokenCards(grid, results);
        startUpdateTimer();
    }

    async function init() {
        const grid = document.querySelector('.token-grid');
        const input = document.getElementById('token-address-input');
        const btn = document.getElementById('add-token-btn');

        if (!grid) return;

        grid.innerHTML = '<p class="loading">Loading…</p>';
        await fetchTokensFromServer();
        const addresses = getTokens();

        if (!addresses.length) {
            showEmptyState(grid);
        } else {
            try {
                await initialRender(addresses);
            } catch (e) {
                console.error('initialRender failed', e);
                grid.innerHTML = '<p class="loading error">Failed to load token data.</p>';
            }
        }

        if (btn && input) {
            btn.addEventListener('click', () => addToken(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') addToken(input.value);
            });
            (function setupClipboardPasteOnFocus() {
                let pasteInProgress = false;
                function tryPasteFromClipboard() {
                    if (pasteInProgress) return;
                    pasteInProgress = true;
                    navigator.clipboard.readText().then((raw) => {
                        const text = typeof raw === 'string' ? raw.trim() : '';
                        if (!text) {
                            pasteInProgress = false;
                            return;
                        }
                        const len = text.length;
                        if (len < 20 || len > 66) {
                            pasteInProgress = false;
                            return;
                        }
                        const val = input.value || '';
                        const start = input.selectionStart ?? 0;
                        const end = input.selectionEnd ?? 0;
                        const fullSelection = val.length > 0 && start === 0 && end === val.length;
                        if (val.length > 0 && !fullSelection) {
                            pasteInProgress = false;
                            return;
                        }
                        input.value = text;
                        input.setSelectionRange(text.length, text.length);
                        pasteInProgress = false;
                    }).catch(() => {
                        showToast('Click then press Ctrl+V (clipboard permission blocked)');
                        pasteInProgress = false;
                    });
                }
                input.addEventListener('click', tryPasteFromClipboard);
                input.addEventListener('focus', tryPasteFromClipboard);
            })();
        }

        const alertsRes = await apiGetAlerts();
        if (alertsRes.ok) alertsCache = alertsRes.alerts;
        const historyRes = await apiGetHistory();
        if (historyRes.ok) {
            historyUnreadCount = historyRes.unreadCount;
            getOrCreateHistoryPanel();
            updateHistoryBadge(historyRes.unreadCount);
            if (Array.isArray(historyRes.items)) applySpikeHighlightsFromHistory(historyRes.items);
        }
    }

    window.formatDexScreener = formatDexScreener;

    document.addEventListener('DOMContentLoaded', () => init().catch((e) => console.error('init failed', e)));
})();
