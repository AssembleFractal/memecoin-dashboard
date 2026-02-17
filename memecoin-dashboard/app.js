// Memecoin Dashboard - App Entry
(function () {
    'use strict';

    const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
    const DEXSCREENER_PAIRS_API = 'https://api.dexscreener.com/latest/dex/pairs';
    const CHART_COLOR = '#00ff88';
    const CONFIG_URL = 'config.json';
    const API_URL = 'api.php';
    const UPDATE_INTERVAL = 5000;
    const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
    const DEFAULT_TIMEFRAME = '1h';
    /** Points per TF at 5s interval: 5m=60, 15m=180, 1h=720, 4h=2880, 1d=17280 */
    const TF_POINTS = { '5m': 60, '15m': 180, '1h': 720, '4h': 2880, '1d': 17280 };
    const MAX_HISTORY_POINTS = 34560; // ~2 days
    const BUILDING_THRESHOLD = 12;    // 1 min at 5s

    /** @type {Chart[]} */
    let chartInstances = [];

    /** @type {Array<{ address: string, refs: object, chart: Chart }>} */
    let cardRefs = [];

    let updateTimer = null;
    /** @type {Array<{address: string, order: number}>} */
    let tokenList = [];
    /** @type {{ [address: string]: Array<{t: number, p: number}> }} */
    let priceHistoryStore = {};
    /** @type {{ [address: string]: string }} */
    let timeframeByAddress = {};
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

    function getTimeframeForToken(address) {
        const v = timeframeByAddress[address];
        return TIMEFRAMES.includes(v) ? v : DEFAULT_TIMEFRAME;
    }

    function setTimeframeForToken(address, tf) {
        timeframeByAddress[address] = tf;
    }

    function getPriceHistory(address) {
        const arr = priceHistoryStore[address];
        if (!Array.isArray(arr)) return [];
        return arr.filter((x) => x != null && typeof x.t === 'number' && typeof x.p === 'number');
    }

    function appendPricePoint(address, price) {
        const n = parseFloat(price);
        if (Number.isNaN(n) || n <= 0) return;
        const points = getPriceHistory(address);
        points.push({ t: Date.now(), p: n });
        const keep = points.slice(-MAX_HISTORY_POINTS);
        priceHistoryStore[address] = keep;
    }

    function clearPriceHistory(address) {
        delete priceHistoryStore[address];
    }

    function getPointsForTimeframe(address, tf) {
        const points = getPriceHistory(address);
        const n = TF_POINTS[tf] ?? 720;
        const slice = points.slice(-n);
        const data = slice.map((x) => x.p);
        const timestamps = slice.map((x) => x.t);
        const labels = slice.map((_, i) =>
            (i === 0 || i === slice.length - 1 || (slice.length > 5 && i === Math.floor(slice.length / 2)))
                ? formatKSTShort(timestamps[i], tf)
                : ''
        );
        return { labels, data, timestamps };
    }

    function formatKST(ms) {
        const d = new Date(ms + 9 * 60 * 60 * 1000);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        const h = String(d.getUTCHours()).padStart(2, '0');
        const min = String(d.getUTCMinutes()).padStart(2, '0');
        const s = String(d.getUTCSeconds()).padStart(2, '0');
        return `${y}-${m}-${day} ${h}:${min}:${s} KST`;
    }

    function formatKSTShort(ms, tf) {
        const d = new Date(ms + 9 * 60 * 60 * 1000);
        const h = String(d.getUTCHours()).padStart(2, '0');
        const min = String(d.getUTCMinutes()).padStart(2, '0');
        const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        if (tf === '1d' || tf === '4h') return `${mo}-${day} ${h}:${min}`;
        return `${h}:${min}`;
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

        return { name, symbol, imageUrl, priceUsd, marketCap, fdv, volume24h, pair };
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

    const crosshairPlugin = {
        id: 'chartCrosshair',
        afterDraw(chart) {
            const ctx = chart && chart.ctx;
            const tp = chart && chart.tooltip;
            const yScale = chart && chart.scales && chart.scales.y;
            if (!ctx || !tp || !tp.dataPoints || tp.dataPoints.length === 0 || !yScale) return;
            const pt = tp.dataPoints[0];
            const el = pt && pt.element;
            const x = el && typeof el.x === 'number' && Number.isFinite(el.x) ? el.x : null;
            const top = typeof yScale.top === 'number' && Number.isFinite(yScale.top) ? yScale.top : 0;
            const bottom = typeof yScale.bottom === 'number' && Number.isFinite(yScale.bottom) ? yScale.bottom : 0;
            if (x == null || !Number.isFinite(top) || !Number.isFinite(bottom)) return;
            ctx.save();
            ctx.strokeStyle = 'rgba(139, 152, 165, 0.35)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
            ctx.stroke();
            ctx.restore();
        },
    };
    if (typeof Chart !== 'undefined') Chart.register(crosshairPlugin);

    function createPriceChart(canvas, address, timeframe) {
        const tf = TIMEFRAMES.includes(timeframe) ? timeframe : DEFAULT_TIMEFRAME;
        const { labels, data, timestamps } = getPointsForTimeframe(address, tf);

        const ch = new Chart(canvas, {
            type: 'line',
            data: {
                labels: labels.slice(),
                datasets: [{
                    label: 'Price',
                    data: data.slice(),
                    borderColor: CHART_COLOR,
                    backgroundColor: 'transparent',
                    fill: false,
                    tension: 0.35,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                aspectRatio: 2.1,
                interaction: { mode: 'index', intersect: false },
                layout: { padding: { top: 8, right: 8, bottom: 6, left: 8 } },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: true,
                        mode: 'index',
                        intersect: false,
                        backgroundColor: 'rgba(26, 31, 46, 0.95)',
                        titleColor: '#e7e9ea',
                        bodyColor: '#e7e9ea',
                        borderColor: 'rgba(120, 86, 255, 0.2)',
                        borderWidth: 1,
                        callbacks: {
                            title() {
                                return 'Price';
                            },
                            label(ctx) {
                                const chart = ctx.chart;
                                const ts = chart._timestamps;
                                const idx = ctx.dataIndex;
                                const price = ctx.parsed.y;
                                const t = Array.isArray(ts) && ts[idx] != null ? formatKST(ts[idx]) : '';
                                return t ? [`$${formatPrice(String(price))}`, t] : `$${formatPrice(String(price))}`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        display: true,
                        grid: { display: true, color: 'rgba(139, 152, 165, 0.08)' },
                        ticks: { maxTicksLimit: 5, color: 'rgba(139, 152, 165, 0.7)', font: { size: 10 } },
                    },
                    y: {
                        display: true,
                        grid: { display: true, color: 'rgba(139, 152, 165, 0.08)' },
                        ticks: { maxTicksLimit: 4, color: 'rgba(139, 152, 165, 0.7)', font: { size: 10 } },
                    },
                },
            },
        });
        ch._timestamps = timestamps.slice();
        return ch;
    }

    function updateChartFromHistory(entry) {
        const { address, chart, refs } = entry;
        const tf = getTimeframeForToken(address);
        const { labels, data, timestamps } = getPointsForTimeframe(address, tf);

        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.data.labels = labels.slice();
        chart.data.datasets[0].data = data.slice();
        chart._timestamps = timestamps.slice();
        chart.update('none');

        const buildingEl = refs.buildingEl;
        const history = getPriceHistory(address);
        if (buildingEl) {
            buildingEl.classList.toggle('chart-building--visible', history.length < BUILDING_THRESHOLD);
        }
    }

    function updateChartForTimeframe(entry) {
        updateChartFromHistory(entry);
    }

    function formatPrice(s) {
        const n = parseFloat(s);
        if (Number.isNaN(n)) return '—';
        if (n >= 1e6) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
        if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
        if (n >= 1e-6) return n.toFixed(6);
        return n.toFixed(6);
    }

    /**
     * 단일 토큰 카드 DOM 생성. 상단 우측 삭제 "X", 차트 하단 타임프레임 버튼.
     */
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

        const chartWrap = document.createElement('div');
        chartWrap.className = 'card-chart';
        chartWrap.setAttribute('aria-hidden', 'true');
        const chartInner = document.createElement('div');
        chartInner.className = 'card-chart-inner';
        const innerInner = document.createElement('div');
        innerInner.className = 'card-chart-inner-inner';
        const canvas = document.createElement('canvas');
        innerInner.appendChild(canvas);
        const buildingEl = document.createElement('div');
        buildingEl.className = 'chart-building';
        buildingEl.textContent = 'Building chart...';
        buildingEl.setAttribute('aria-hidden', 'true');
        buildingEl.classList.toggle('chart-building--visible', getPriceHistory(address).length < BUILDING_THRESHOLD);
        chartInner.appendChild(innerInner);
        chartInner.appendChild(buildingEl);

        const toolbar = document.createElement('div');
        toolbar.className = 'chart-toolbar';
        const tf = getTimeframeForToken(address);
        TIMEFRAMES.forEach((t) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chart-tf-btn' + (t === tf ? ' active' : '');
            btn.textContent = t;
            btn.dataset.tf = t;
            toolbar.appendChild(btn);
        });
        chartWrap.appendChild(chartInner);
        chartWrap.appendChild(toolbar);

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
        card.append(deleteBtn, chartWrap, info);

        const pair = data?.pair;
        const pairAddress = pair?.pairAddress || null;
        const chainId = pair?.chainId || null;
        const refs = {
            card, tickerEl, priceEl, fdvVal, mcVal, volVal,
            logoImg, logoFallback,
            toolbarEl: toolbar, chartWrapEl: chartWrap, buildingEl,
        };
        return { card, priceForChart: data?.priceUsd ?? null, refs, pairAddress, chainId };
    }

    function syncToolbarState(toolbar, activeTf) {
        toolbar.querySelectorAll('.chart-tf-btn').forEach((b) => {
            const isActive = b.dataset.tf === activeTf;
            b.classList.toggle('active', isActive);
            b.disabled = isActive;
        });
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
        for (const c of chartInstances) c.destroy();
        chartInstances = [];
        cardRefs = [];
        grid.innerHTML = '';

        const fragment = document.createDocumentFragment();
        const meta = [];
        for (const item of list) {
            const out = createTokenCard(item);
            if (addedAddress && item.address === addedAddress) out.card.classList.add('token-card--enter');
            meta.push({
                refs: out.refs,
                pairAddress: out.pairAddress,
                chainId: out.chainId,
            });
            fragment.appendChild(out.card);
        }
        grid.appendChild(fragment);

        const canvases = grid.querySelectorAll('.card-chart-inner-inner canvas');
        canvases.forEach((canvas, i) => {
            const item = list[i];
            const m = meta[i];
            const tf = getTimeframeForToken(item.address);
            const ch = createPriceChart(canvas, item.address, tf);
            chartInstances.push(ch);
            const entry = {
                address: item.address,
                refs: m.refs,
                chart: ch,
                pairAddress: m.pairAddress,
                chainId: m.chainId,
                lastPrice: item.data?.priceUsd ?? null,
                tfLoading: false,
            };
            cardRefs.push(entry);
            updateChartFromHistory(entry);
            attachTimeframeHandlers(entry);
        });
        initSortable(grid);
    }

    function attachTimeframeHandlers(entry) {
        const toolbar = entry.refs.toolbarEl;
        if (!toolbar) return;

        syncToolbarState(toolbar, getTimeframeForToken(entry.address));

        toolbar.querySelectorAll('.chart-tf-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tf = btn.dataset.tf;
                if (!TIMEFRAMES.includes(tf)) return;
                if (entry.tfLoading) return;

                const currentTf = getTimeframeForToken(entry.address);
                if (tf === currentTf) return;

                entry.tfLoading = true;
                setTimeframeForToken(entry.address, tf);
                syncToolbarState(toolbar, tf);
                updateChartForTimeframe(entry);
                entry.tfLoading = false;
            });
        });
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
            filter: '.token-card-delete, .chart-tf-btn, .token-copy-btn',
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
                    const byAddr = new Map(cardRefs.map((e, i) => [e.address, { entry: e, chart: chartInstances[i] }]));
                    const newRefs = [];
                    const newCharts = [];
                    for (const a of ordered) {
                        const x = byAddr.get(a);
                        if (x) {
                            newRefs.push(x.entry);
                            newCharts.push(x.chart);
                        }
                    }
                    cardRefs.length = 0;
                    cardRefs.push(...newRefs);
                    chartInstances.length = 0;
                    chartInstances.push(...newCharts);
                });
            },
        });
    }

    function showEmptyState(grid) {
        destroySortable();
        grid.innerHTML = '<p class="empty-state">No tokens added. Add a contract address above.</p>';
        chartInstances = [];
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
                    const price = results[i].data?.priceUsd ?? null;
                    cardRefs[i].lastPrice = price;
                    if (price != null) appendPricePoint(results[i].address, price);
                }
            }
            for (const e of cardRefs) updateChartFromHistory(e);
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

        if (data?.priceUsd != null) appendPricePoint(addr, data.priceUsd);

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

        clearPriceHistory(address);
        const tokens = getTokens();

        if (tokens.length === 0) {
            showEmptyState(grid);
            stopUpdateTimer();
            return;
        }

        const idx = cardRefs.findIndex((c) => c.address === address);
        if (idx < 0) return;

        const { refs, chart } = cardRefs[idx];
        refs.card.classList.add('token-card--exit');
        let done = false;
        const onDone = () => {
            if (done) return;
            done = true;
            chart.destroy();
            refs.card.remove();
            chartInstances.splice(idx, 1);
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
        for (const r of results) {
            if (r.data?.priceUsd != null) appendPricePoint(r.address, r.data.priceUsd);
        }
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
