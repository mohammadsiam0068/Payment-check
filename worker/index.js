export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ status: "error", message: "Method not allowed" }), { status: 405 });
    }

    const url = new URL(request.url);
    const authHeader = request.headers.get("Authorization") || "";
    const providedKey = authHeader.replace("Bearer ", "").trim();

    if (providedKey !== env.API_SECRET_KEY) {
      return new Response(JSON.stringify({ status: "error", message: "Unauthorized" }), { status: 401 });
    }

    if (url.pathname === "/add-sms") {
      const smsText = await request.text();
      return handleAddSms(smsText, env);
    } else if (url.pathname === "/verify-trx") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ status: "error", message: "Invalid JSON" }), { status: 400 });
      }
      return handleVerifyTrx(body, env);
    }

    return new Response(JSON.stringify({ status: "error", message: "Not found" }), { status: 404 });
  },
};

function parseSms(text) {
  let trxMatch = text.match(/TrxID\s+([A-Za-z0-9]+)\s+at/i);
  if (trxMatch) {
    const amountMatch = text.match(/Tk\s?([\d,]+\.?\d*)\s*from/i);
    const senderMatch = text.match(/from\s+(01\d{9})/i);
    if (amountMatch && senderMatch) {
      return {
        trxId: trxMatch[1],
        amount: parseFloat(amountMatch[1].replace(/,/g, "")),
        senderNumber: senderMatch[1],
      };
    }
  }

  trxMatch = text.match(/TxnID:\s*([A-Za-z0-9]+)/i);
  if (trxMatch) {
    const amountMatch = text.match(/Amount:\s*Tk\s?([\d,]+\.?\d*)/i);
    const senderMatch = text.match(/Sender:\s*(01\d{9})/i);
    if (amountMatch && senderMatch) {
      return {
        trxId: trxMatch[1],
        amount: parseFloat(amountMatch[1].replace(/,/g, "")),
        senderNumber: senderMatch[1],
      };
    }
  }

  trxMatch = text.match(/Txn ID:\s*([A-Za-z0-9]+)/i);
  if (trxMatch) {
    const amountMatch = text.match(/Tk\s?([\d,]+\.?\d*)\s*received/i);
    const senderMatch = text.match(/from\s+(01\d\*{3}\d{4})/i);
    if (amountMatch && senderMatch) {
      return {
        trxId: trxMatch[1],
        amount: parseFloat(amountMatch[1].replace(/,/g, "")),
        senderNumber: senderMatch[1],
      };
    }
  }

  return null;
}

async function handleAddSms(smsText, env) {
  if (!smsText || typeof smsText !== "string" || smsText.trim() === "") {
    return new Response(JSON.stringify({ status: "error", message: "sms_text required" }), { status: 400 });
  }

  const parsed = parseSms(smsText);

  if (!parsed) {
    return new Response(
      JSON.stringify({ status: "error", message: "Could not parse SMS", received: smsText }),
      { status: 422 }
    );
  }

  const { trxId, amount, senderNumber } = parsed;

  try {
    await env.DB.prepare(
      "INSERT INTO transactions (trx_id, sender_number, amount, status, created_at) VALUES (?, ?, ?, 'unused', ?)"
    )
      .bind(trxId, senderNumber, amount, new Date().toISOString())
      .run();

    return new Response(JSON.stringify({ status: "success", trx_id: trxId, amount, sender_number: senderNumber }), {
      status: 200,
    });
  } catch (e) {
    return new Response(JSON.stringify({ status: "error", message: "DB insert failed", detail: e.message }), {
      status: 500,
    });
  }
}

async function handleVerifyTrx(body, env) {
  const trxId = body.trx_id;
  if (!trxId || typeof trxId !== "string") {
    return new Response(JSON.stringify({ status: "error", message: "trx_id required" }), { status: 400 });
  }

  try {
    const row = await env.DB.prepare("SELECT * FROM transactions WHERE trx_id = ?").bind(trxId).first();

    if (!row) {
      return new Response(JSON.stringify({ status: "error", message: "Transaction not found" }), { status: 404 });
    }

    if (row.status === "used") {
      return new Response(JSON.stringify({ status: "error", message: "Transaction already used" }), { status: 409 });
    }

    await env.DB.prepare("UPDATE transactions SET status = 'used' WHERE trx_id = ?").bind(trxId).run();

    return new Response(JSON.stringify({ status: "success", amount: row.amount }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ status: "error", message: "DB query failed", detail: e.message }), {
      status: 500,
    });
  }
}
