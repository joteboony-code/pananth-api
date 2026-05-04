import requests


LINE_NOTIFY_API = "https://notify-api.line.me/api/notify"


def send_line_notify(token: str, message: str) -> dict:
    """Send a message via LINE Notify to a specific token."""
    if not token:
        return {"success": False, "error": "No LINE token provided"}

    headers = {"Authorization": f"Bearer {token}"}
    payload = {"message": message}

    try:
        response = requests.post(LINE_NOTIFY_API, headers=headers, data=payload, timeout=10)
        if response.status_code == 200:
            return {"success": True}
        else:
            return {"success": False, "error": f"HTTP {response.status_code}: {response.text}"}
    except requests.RequestException as e:
        return {"success": False, "error": str(e)}


def build_rent_message(tenant_name: str, room_number: str, year: int, month: int,
                       rent: float, water_cost: float, electric_cost: float,
                       total: float, month_name_th: str) -> str:
    """Build a Thai rent notification message."""
    lines = [
        f"\n แจ้งค่าเช่าประจำเดือน {month_name_th} {year + 543}",
        f"ห้อง: {room_number}",
        f"ผู้เช่า: {tenant_name}",
        "─────────────────",
        f"ค่าเช่า:          {rent:,.2f} บาท",
    ]
    if water_cost > 0:
        lines.append(f"ค่าน้ำ:           {water_cost:,.2f} บาท")
    if electric_cost > 0:
        lines.append(f"ค่าไฟ:            {electric_cost:,.2f} บาท")
    lines += [
        "─────────────────",
        f"ยอดรวม:          {total:,.2f} บาท",
        "กรุณาชำระภายในวันที่ 5 ของเดือน",
        "ขอบคุณครับ/ค่ะ",
    ]
    return "\n".join(lines)
