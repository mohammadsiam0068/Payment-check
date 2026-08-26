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
    } else if (url.pathname === "/verify-crypto-trx") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ status: "error", message: "Invalid JSON" }), { status: 400 });
      }
      return handleVerifyCryptoTrx(body, env);
    }

    return new Response(JSON.stringify({ status: "error", message: "Not found" }), { status: 404 });
  },
};

async function hmacSha256Hex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function binanceRequest(env, path, params) {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp: timestamp.toString(), recvWindow: "10000" });
  const signature = await hmacSha256Hex(env.BINANCE_API_SECRET, query.toString());
  query.append("signature", signature);

  const response = await fetch(`https://api.binance.com${path}?${query.toString()}`, {
    method: "GET",
    headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Binance API error ${response.status}: ${errText}`);
  }

  return response.json();
}

async function handleVerifyCryptoTrx(body, env) {
  const txId = body.tx_id;
  if (!txId || typeof txId !== "string") {
    return new Response(JSON.stringify({ status: "error", message: "tx_id required" }), { status: 400 });
  }

  try {
    const existing = await env.DB.prepare("SELECT * FROM crypto_transactions WHERE tx_id = ?").bind(txId).first();
    if (existing) {
      return new Response(JSON.stringify({ status: "error", message: "Transaction already used" }), { status: 409 });
    }

    const deposits = await binanceRequest(env, "/sapi/v1/capital/deposit/hisrec", { status: "1", limit: "100" });

    const match = Array.isArray(deposits) ? deposits.find((d) => d.txId === txId) : null;

    if (!match) {
      return new Response(JSON.stringify({ status: "error", message: "Transaction not found or not confirmed" }), {
        status: 404,
      });
    }

    try {
      await env.DB.prepare(
        "INSERT INTO crypto_transactions (tx_id, coin, network, amount, status, created_at) VALUES (?, ?, ?, ?, 'used', ?)"
      )
        .bind(txId, match.coin, match.network, parseFloat(match.amount), new Date().toISOString())
        .run();
    } catch (insertErr) {
      return new Response(JSON.stringify({ status: "error", message: "Transaction already used" }), { status: 409 });
    }

    return new Response(
      JSON.stringify({ status: "success", amount: parseFloat(match.amount), coin: match.coin, network: match.network }),
      { status: 200 }
    );
  } catch (e) {
    return new Response(JSON.stringify({ status: "error", message: "Verification failed", detail: e.message }), {
      status: 500,
    });
  }
}

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
    return new Response(JSON.stringify({ status: "error", message: "Could not parse SMS" }), { status: 422 });
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

    const updateResult = await env.DB.prepare(
      "UPDATE transactions SET status = 'used' WHERE trx_id = ? AND status = 'unused'"
    )
      .bind(trxId)
      .run();

    if (!updateResult.meta || updateResult.meta.changes === 0) {
      return new Response(JSON.stringify({ status: "error", message: "Transaction already used" }), { status: 409 });
    }

    return new Response(JSON.stringify({ status: "success", amount: row.amount }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ status: "error", message: "DB query failed", detail: e.message }), {
      status: 500,
    });
  }
}
