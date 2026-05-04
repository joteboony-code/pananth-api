import os
import requests

LINE_PUSH_API = "https://api.line.me/v2/bot/message/push"
LINE_REPLY_API = "https://api.line.me/v2/bot/message/reply"


def _channel_token() -> str:
    return os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")


def send_push_message(user_id: str, message: str) -> dict:
    """Send a text message to a LINE user via Messaging API Push."""
    token = _channel_token()
    if not token:
        return {"success": False, "error": "LINE_CHANNEL_ACCESS_TOKEN not set"}
    if not user_id:
        return {"success": False, "error": "No LINE User ID provided"}

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "to": user_id,
        "messages": [{"type": "text", "text": message}],
    }
    try:
        resp = requests.post(LINE_PUSH_API, headers=headers, json=payload, timeout=10)
        if resp.status_code == 200:
            return {"success": True}
        return {"success": False, "error": f"HTTP {resp.status_code}: {resp.text}"}
    except requests.RequestException as e:
        return {"success": False, "error": str(e)}


def reply_message(reply_token: str, message: str) -> dict:
    """Reply to a webhook event (follow/message)."""
    token = _channel_token()
    if not token:
        return {"success": False, "error": "LINE_CHANNEL_ACCESS_TOKEN not set"}

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "replyToken": reply_token,
        "messages": [{"type": "text", "text": message}],
    }
    try:
        resp = requests.post(LINE_REPLY_API, headers=headers, json=payload, timeout=10)
        return {"success": resp.status_code == 200}
    except requests.RequestException as e:
        return {"success": False, "error": str(e)}


def build_rent_message(tenant_name: str, room_number: str, year: int, month: int,
                       rent: float, water_cost: float, electric_cost: float,
                       total: float, month_name_th: str) -> str:
    """Build a Thai rent notification message."""
    lines = [
        f"แจ้งค่าเช่าประจำเดือน{month_name_th} {year + 543}",
        f"ห้อง: {room_number}",
        f"ผู้เช่า: {tenant_name}",
        "─────────────────",
        f"ค่าเช่า:       {rent:>10,.2f} บาท",
    ]
    if water_cost > 0:
        lines.append(f"ค่าน้ำ:        {water_cost:>10,.2f} บาท")
    if electric_cost > 0:
        lines.append(f"ค่าไฟ:         {electric_cost:>10,.2f} บาท")
    lines += [
        "─────────────────",
        f"ยอดรวม:        {total:>10,.2f} บาท",
        "",
        "กรุณาชำระภายในวันที่ 5 ของเดือน",
        "ขอบคุณครับ/ค่ะ",
    ]
    return "\n".join(lines)
