"""
Volume monitor: reads config.json tokens, checks DexScreener 5m volume every 5 min.
When 5m Vol >= ALERT_VOLUME_THRESHOLD: sends Telegram alert and POSTs to dashboard addHistory.
"""
import json
import os
import re
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# .env 탐색: 프로젝트 루트 우선, 없으면 volume-monitor 폴더
_BASE_DIR = Path(__file__).resolve().parent.parent  # memecoin-dashboard/
_ENV_CANDIDATES = [
    _BASE_DIR / ".env",
    Path(__file__).resolve().parent / ".env",  # volume-monitor/.env
]
for _env_path in _ENV_CANDIDATES:
    if _env_path.exists():
        load_dotenv(dotenv_path=_env_path, override=False)
        print(f"[env] Loaded: {_env_path}")
        break
else:
    print("[env] WARNING: No .env file found. Env vars must be set externally.")

CONFIG_PATH = _BASE_DIR / "config.json"
DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens"
INTERVAL_SEC = 300  # 5 min
ALERT_VOLUME_THRESHOLD = 50_000
PREV_VOL_5M: dict[str, float] = {}

# MarkdownV2 예약문자: \ _ * [ ] ( ) ~ ` > # + - = | { } . !
_MD2_ESCAPE_RE = re.compile(r"([_*\[\]()~`>#+=|{}.!\-\\])")


def _escape_md2(s: str) -> str:
    return _MD2_ESCAPE_RE.sub(r"\\\1", s)


def load_tokens() -> list[str]:
    if not CONFIG_PATH.exists():
        return []
    raw = CONFIG_PATH.read_text(encoding="utf-8")
    data = json.loads(raw)
    tokens = data.get("tokens") or []
    return [t.get("address") if isinstance(t, dict) else t for t in tokens if (t.get("address") if isinstance(t, dict) else t)]


def format_vol(value: float) -> str:
    """k/m/b 소수점 한 자리. 1000 미만은 그대로."""
    if value is None or value != value:  # NaN
        return "0"
    if value < 0:
        value = 0
    if value >= 1e9:
        return f"{(value / 1e9):.1f}b"
    if value >= 1e6:
        return f"{(value / 1e6):.1f}m"
    if value >= 1e3:
        return f"{(value / 1e3):.1f}k"
    return str(int(round(value)))


def fetch_pair(address: str) -> dict | None:
    url = f"{DEXSCREENER_API}/{address}"
    try:
        r = httpx.get(url, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        pairs = data.get("pairs")
        if not pairs:
            return None
        sorted_pairs = sorted(pairs, key=lambda p: p.get("liquidity", {}).get("usd") or 0, reverse=True)
        return sorted_pairs[0] if sorted_pairs else None
    except Exception:
        return None


def get_volume5m_and_symbol(pair: dict) -> tuple[float | None, str, float | None]:
    vol = pair.get("volume") or {}
    m5 = vol.get("m5")
    if m5 is not None:
        try:
            v5 = float(m5)
        except (TypeError, ValueError):
            v5 = None
    else:
        v5 = None
    base = pair.get("baseToken") or {}
    symbol = (base.get("symbol") or "—").strip().upper() or "—"
    mcap = pair.get("marketCap")
    if mcap is not None:
        try:
            mcap_f = float(mcap)
        except (TypeError, ValueError):
            mcap_f = None
    else:
        mcap_f = None
    return v5, symbol, mcap_f


def send_telegram(message: str, parse_mode: str | None = None) -> bool:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": message, "disable_web_page_preview": True}
    if parse_mode:
        payload["parse_mode"] = parse_mode
    try:
        r = httpx.post(url, json=payload, timeout=10)
        return r.status_code == 200
    except Exception:
        return False


def add_history(address: str, symbol: str, actual_price: float, note: str, market_cap: float | None = None) -> bool:
    base_url = (os.getenv("DASHBOARD_URL") or "").rstrip("/")
    if not base_url:
        return False
    url = f"{base_url}/api.php"
    payload = {
        "tokenAddress": address,
        "tokenSymbol": symbol,
        "targetPrice": 0,
        "actualPrice": actual_price,
        "type": "volume_spike",
        "note": note,
    }
    if market_cap is not None:
        payload["marketCap"] = market_cap
    try:
        r = httpx.post(f"{url}?action=addHistory", json=payload, timeout=10)
        return r.status_code == 200 and (r.json() or {}).get("ok") is True
    except Exception:
        return False


def warm_up() -> None:
    """시작 시 이전 볼륨을 미리 채워서 첫 알림에도 % 표시 가능하게 함."""
    print("Warm-up: fetching initial volumes...")
    addresses = [a for a in load_tokens() if a and len(a) >= 20]
    for address in addresses:
        pair = fetch_pair(address)
        if not pair:
            continue
        vol5m, symbol, _ = get_volume5m_and_symbol(pair)
        if vol5m is not None:
            PREV_VOL_5M[address] = vol5m
            print(f"  {symbol}: prev_vol set to {vol5m}")
    print("Warm-up done. Sleeping before first check...")
    time.sleep(INTERVAL_SEC)


def main():
    print("Monitor started")
    # 환경변수 로딩 상태 확인
    _bot = os.getenv("TELEGRAM_BOT_TOKEN")
    _chat = os.getenv("TELEGRAM_CHAT_ID")
    _url  = os.getenv("DASHBOARD_URL")
    print(f"[env] TELEGRAM_BOT_TOKEN: {'SET' if _bot else 'MISSING'}")
    print(f"[env] TELEGRAM_CHAT_ID:   {'SET' if _chat else 'MISSING'}")
    print(f"[env] DASHBOARD_URL:      {_url or 'MISSING'}")
    if not _bot or not _chat:
        print("[env] WARNING: Telegram not configured. Alerts will be skipped.")
    if not _url:
        print("[env] WARNING: DASHBOARD_URL not set. History will not be saved.")
    warm_up()
    while True:
        addresses = [a for a in load_tokens() if a and len(a) >= 20]
        for address in addresses:
            pair = fetch_pair(address)
            if not pair:
                continue
            vol5m, symbol, mcap = get_volume5m_and_symbol(pair)
            prev_vol = PREV_VOL_5M.get(address)
            if vol5m is not None:
                PREV_VOL_5M[address] = vol5m
            if vol5m is None or vol5m < ALERT_VOLUME_THRESHOLD:
                continue
            print(f"SPIKE detected: {symbol} | 5m vol: {vol5m}")
            mcap_str = format_vol(mcap) if mcap is not None else "—"
            vol_str = format_vol(vol5m)
            if prev_vol and prev_vol > 0:
                increase_pct = round(((vol5m / prev_vol) - 1) * 100)
                sign = "+" if increase_pct >= 0 else ""
                pct_str = f" ({sign}{increase_pct}%)"
            else:
                pct_str = ""
            msg = (
                "*" + _escape_md2(f"${symbol} 5m Volume Spike") + "*"
                + "\n\n"
                + _escape_md2(f"MC: ${mcap_str}") + "\n"
                + _escape_md2(f"5m Vol: ${vol_str}{pct_str}")
            )
            result = send_telegram(msg, parse_mode="MarkdownV2")
            print(f"Telegram sent: {result}")
            price = 0.0
            try:
                price = float(pair.get("priceUsd") or 0)
            except (TypeError, ValueError):
                pass
            note = f"5m Vol Spike ${vol_str}{pct_str}"
            add_history(address, symbol, price, note, market_cap=mcap)
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    main()
