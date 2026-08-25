import os
import requests

WORKER_URL = os.environ.get("WORKER_URL", "https://payment-check.mohammadsiam0068.workers.dev")
API_SECRET_KEY = os.environ.get("API_SECRET_KEY", "")


def verify_transaction(trx_id: str):
    url = f"{WORKER_URL}/verify-trx"
    headers = {
        "Authorization": f"Bearer {API_SECRET_KEY}",
        "Content-Type": "application/json",
    }
    payload = {"trx_id": trx_id}

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        data = response.json()

        if response.status_code == 200 and data.get("status") == "success":
            return {"success": True, "amount": data.get("amount")}
        else:
            return {"success": False, "message": data.get("message", "Unknown error")}
    except requests.RequestException as e:
        return {"success": False, "message": str(e)}
