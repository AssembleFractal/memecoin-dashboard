// Memecoin Dashboard - App Entry
(function () {
    'use strict';

    const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
    const CONFIG_URL = 'config.json';
    const API_URL = 'api.php';
    const UPDATE_INTERVAL = 5000;

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
        
        let twitterUrl = null;
        const socials = base.info?.socials || pair.info?.socials;
        if (Array.isArray(socials)) {
            const twitter = socials.find((s) => s && typeof s === 'object' && s.type === 'twitter' && typeof s.url === 'string');
            if (twitter && twitter.url) twitterUrl = twitter.url.trim();
        }

        const chainId = pair.chainId != null ? String(pair.chainId).toLowerCase() : '';
        const GMGN_CHAIN_MAP = { solana: 'sol', base: 'base', bsc: 'bsc', ethereum: 'eth', arbitrum: 'arb', polygon: 'polygon', avalanche: 'avax' };
        const gmgnChain = GMGN_CHAIN_MAP[chainId] || chainId || 'sol';

        return { name, symbol, imageUrl, priceUsd, marketCap, fdv, volume24h, twitterUrl, chainId, gmgnChain, pair };
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

        if (data?.twitterUrl) {
            const twitterBtn = document.createElement('a');
            twitterBtn.href = data.twitterUrl;
            twitterBtn.target = '_blank';
            twitterBtn.rel = 'noopener noreferrer';
            twitterBtn.className = 'token-twitter-btn';
            twitterBtn.title = 'Open Twitter/X';
            twitterBtn.setAttribute('aria-label', 'Open Twitter/X');
            twitterBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
            twitterBtn.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            tickerRow.appendChild(twitterBtn);
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
        tickerRow.appendChild(gmgnBtn);

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

        info.append(logoRow, tickerRow, priceEl, stats);
        card.append(deleteBtn, info);

        const refs = {
            card, tickerEl, priceEl, fdvVal, mcVal, volVal,
            logoImg, logoFallback,
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
            cardRefs.push({
                address: item.address,
                refs: out.refs,
                lastPrice: item.data?.priceUsd ?? null,
            });
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

    function initSortable(grid) {
        destroySortable();
        const cards = grid.querySelectorAll('.token-card');
        if (!cards.length || typeof Sortable === 'undefined') return;
        sortableInstance = new Sortable(grid, {
            animation: 150,
            filter: '.token-card-delete, .token-copy-btn, .token-twitter-btn, .token-gmgn-btn',
            ghostClass: 'sortable-ghost',
            onStart(evt) {
                evt.item.classList.add('token-card--dragging');
            },
            onEnd(evt) {
                evt.item.classList.remove('token-card--dragging');
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

    function startUpdateTimer() {
        stopUpdateTimer();
        updateTimer = setInterval(async () => {
            try {
                await updateAllTokens();
            } catch (e) {
                console.error('updateAllTokens failed', e);
            }
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
                if (cardRefs[i].address === results[i].address) {
                    updateCardContent(cardRefs[i].refs, results[i], cardRefs[i].lastPrice);
                    cardRefs[i].lastPrice = results[i].data?.priceUsd ?? null;
                }
            }
        } finally {
            grid.classList.remove('token-grid--updating');
            if (indicator) indicator.classList.remove('update-indicator--active');
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
        }
    }

    window.formatDexScreener = formatDexScreener;

    document.addEventListener('DOMContentLoaded', () => init().catch((e) => console.error('init failed', e)));
})();
