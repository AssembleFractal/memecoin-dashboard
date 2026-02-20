"""
Volume monitor: reads config.json tokens, checks DexScreener 5m volume every 5 min.
On 2x+ spike: sends Telegram alert and POSTs to dashboard addHistory.
"""
import json
import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"
DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens"
INTERVAL_SEC = 300  # 5 min
PREV_VOLUME: dict[str, float] = {}


def load_tokens() -> list[str]:
    if not CONFIG_PATH.exists():
        return []
    raw = CONFIG_PATH.read_text(encoding="utf-8")
    data = json.loads(raw)
    tokens = data.get("tokens") or []
    return [t.get("address") if isinstance(t, dict) else t for t in tokens if (t.get("address") if isinstance(t, dict) else t)]


def format_vol(value: float) -> str:
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
    return f"{value:.1f}"


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


def send_telegram(message: str) -> bool:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        r = httpx.post(url, json={"chat_id": chat_id, "text": message, "disable_web_page_preview": True}, timeout=10)
        return r.status_code == 200
    except Exception:
        return False


def add_history(address: str, symbol: str, actual_price: float, note: str) -> bool:
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
    try:
        r = httpx.post(f"{url}?action=addHistory", json=payload, timeout=10)
        return r.status_code == 200 and (r.json() or {}).get("ok") is True
    except Exception:
        return False


def main():
    print("Monitor started")
    while True:
        addresses = [a for a in load_tokens() if a and len(a) >= 20]
        for address in addresses:
            pair = fetch_pair(address)
            if not pair:
                continue
            vol5m, symbol, mcap = get_volume5m_and_symbol(pair)
            if vol5m is None or vol5m <= 0:
                continue
            prev = PREV_VOLUME.get(address)
            print(f"Checking {symbol} | 5m vol: {vol5m} | prev: {prev}")
            PREV_VOLUME[address] = vol5m
            if prev is None or prev <= 0:
                continue
            if vol5m < 2 * prev:
                continue
            print(f"SPIKE detected: {symbol}")
            pct = ((vol5m / prev) - 1) * 100 if prev else 0
            mcap_str = format_vol(mcap) if mcap is not None else "—"
            vol_str = format_vol(vol5m)
            msg = (
                f"⚡${symbol} 5m Volume Spike\n"
                f"Mcap: ${mcap_str}\n"
                f"5m Vol: ${vol_str} (+{pct:.0f}%)"
            )
            result = send_telegram(msg)
            print(f"Telegram sent: {result}")
            price = 0.0
            try:
                price = float(pair.get("priceUsd") or 0)
            except (TypeError, ValueError):
                pass
            add_history(address, symbol, price, f"5m Vol Spike +{pct:.0f}%")
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    main()
