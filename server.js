require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PAYPAL_BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const PACKS = {
  starter: { amount: "1.00", coins: 1000, label: "Starter Pack" },
  value: { amount: "3.00", coins: 5000, label: "Value Pack" },
  mega: { amount: "5.00", coins: 10000, label: "Mega Pack" }
};

app.use(cors());
app.use("/api/paypal/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.static("public"));

async function paypalAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).access_token;
}

async function getUser(req) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) throw new Error("Missing token");
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new Error("Invalid token");
  return data.user;
}

async function ensureProfile(user) {
  const { data, error } = await supabaseAdmin.from("profiles").upsert({ id: user.id, email: user.email }, { onConflict: "id" }).select().single();
  if (error) throw error;
  return data;
}

app.get("/api/config", (req, res) => res.json({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY, packs: PACKS }));

app.get("/api/me", async (req, res) => {
  try {
    const user = await getUser(req);
    const profile = await ensureProfile(user);
    res.json({ user: { id: user.id, email: user.email }, profile });
  } catch (e) { res.status(401).json({ error: e.message }); }
});

app.post("/api/game/save", async (req, res) => {
  try {
    const user = await getUser(req);
    const { coins, seeds, harvests, plots } = req.body;
    const safePlots = Array.isArray(plots) && plots.length === 9 ? plots : Array(9).fill(0);
    const { data, error } = await supabaseAdmin.from("profiles").update({ coins: Number(coins)||0, seeds: Number(seeds)||0, harvests: Number(harvests)||0, plots: safePlots }).eq("id", user.id).select().single();
    if (error) throw error;
    res.json({ profile: data });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const user = await getUser(req);
    await ensureProfile(user);
    const packId = req.body.packId;
    const pack = PACKS[packId];
    if (!pack) return res.status(400).json({ error: "Invalid pack" });
    const token = await paypalAccessToken();
    const payload = {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: `${user.id}:${packId}`, custom_id: `${user.id}:${packId}`, description: `${pack.label} - ${pack.coins} coins`, amount: { currency_code: "USD", value: pack.amount } }],
      application_context: { brand_name: "Grow a Garden", user_action: "PAY_NOW", return_url: `${process.env.APP_URL}/success.html?pack=${packId}`, cancel_url: `${process.env.APP_URL}/` }
    };
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(payload) });
    const order = await response.json();
    if (!response.ok) return res.status(400).json({ error: "PayPal order failed", details: order });
    await supabaseAdmin.from("payments").insert({ user_id: user.id, paypal_order_id: order.id, amount_usd: Number(pack.amount), coins: pack.coins, status: "created" });
    res.json({ orderId: order.id, approveLink: order.links.find(l => l.rel === "approve")?.href });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function creditPayment(orderId, source) {
  const { data: payment, error: pe } = await supabaseAdmin.from("payments").select("*").eq("paypal_order_id", orderId).single();
  if (pe || !payment) throw new Error("Payment not found");
  if (payment.status === "completed") return { alreadyCredited: true };
  const { data: profile, error: pre } = await supabaseAdmin.from("profiles").select("*").eq("id", payment.user_id).single();
  if (pre || !profile) throw new Error("Profile not found");
  await supabaseAdmin.from("profiles").update({ coins: Number(profile.coins) + Number(payment.coins) }).eq("id", payment.user_id);
  await supabaseAdmin.from("payments").update({ status: "completed" }).eq("paypal_order_id", orderId);
  return { alreadyCredited: false, source, coinsAdded: payment.coins };
}

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const user = await getUser(req);
    const { orderId } = req.body;
    const { data: payment } = await supabaseAdmin.from("payments").select("*").eq("paypal_order_id", orderId).single();
    if (!payment || payment.user_id !== user.id) return res.status(403).json({ error: "Wrong user/order" });
    const token = await paypalAccessToken();
    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" } });
    const capture = await response.json();
    if (!response.ok || capture.status !== "COMPLETED") return res.status(400).json({ error: "Capture failed", details: capture });
    res.json({ ok: true, result: await creditPayment(orderId, "return_capture") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function verifyWebhook(req, rawBody) {
  if (!process.env.PAYPAL_WEBHOOK_ID) return false;
  const token = await paypalAccessToken();
  const payload = { auth_algo: req.headers["paypal-auth-algo"], cert_url: req.headers["paypal-cert-url"], transmission_id: req.headers["paypal-transmission-id"], transmission_sig: req.headers["paypal-transmission-sig"], transmission_time: req.headers["paypal-transmission-time"], webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: JSON.parse(rawBody.toString("utf8")) };
  const response = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json();
  return data.verification_status === "SUCCESS";
}

app.post("/api/paypal/webhook", async (req, res) => {
  try {
    const verified = await verifyWebhook(req, req.body);
    if (!verified) return res.status(400).json({ error: "Webhook verification failed" });
    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const up = (event.resource?.links || []).find(l => l.rel === "up")?.href || "";
      const orderId = up.split("/").pop();
      if (orderId) await creditPayment(orderId, "webhook");
    }
    res.json({ received: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Grow a Garden running on ${PORT}`));
