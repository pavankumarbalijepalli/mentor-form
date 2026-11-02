import { addDays, dayHasOpenSlot, todayKey } from "/js/dates.js";

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");

const STORE_KEY = "mentorBooking:v2";
const STORE_MAX_AGE_MS = 24 * 3600 * 1000;
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_DAY = { weekday: "short", day: "numeric", month: "short" };
const LONG_DAY = { weekday: "long", day: "numeric", month: "long" };

let cfg = null; // public schedule + payment settings from /api/config

const st = {
  view: null,     // { y, m } month shown in the calendar (m is 0-based)
  date: null,     // "YYYY-MM-DD" in the mentor's timezone
  time: null,     // "8:00 AM"
  hold: null,     // { id, ref, expiresAt, booking, date, time, keyId, order, paid? } once a slot is reserved
  slotReq: 0,     // guards against out-of-order availability responses
  timer: null,
  checkout: null, // promise for the Razorpay script
};

const form = $("intakeForm");

// ---------- helpers ----------

// Dates are plain strings in the mentor's timezone; format them as UTC so the
// visitor's own timezone can never shift the day.
const dayLabel = (key, opts) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", ...opts });
const nb = (time) => time.replace(" ", "\u00a0"); // keep "8:00 AM" on one line
const slotLabel = (date, time) => `${dayLabel(date, LONG_DAY)}, ${time} IST`;

async function api(path, body) {
  const init = { signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    Object.assign(init, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function show(step) {
  for (const id of ["step1", "step2", "step3"]) $(id).hidden = id !== step;
  window.scrollTo(0, 0);
  $(step).querySelector("h1").focus({ preventScroll: true });
}

function showMessage(el, text, link) {
  el.replaceChildren(document.createTextNode(text));
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = link.text;
    el.append(" ", a);
  }
  el.hidden = false;
}

function showRetry(el, text, onRetry) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "retry-link";
  b.textContent = "Retry";
  b.addEventListener("click", onRetry);
  el.replaceChildren(document.createTextNode(`${text} `), b);
  el.hidden = false;
}

const note = (text) => {
  const s = document.createElement("span");
  s.className = "note";
  s.textContent = text;
  return s;
};

function setInvalid(name, bad) {
  const field = form.querySelector(`[data-field=${name}]`);
  if (!field) return;
  field.classList.toggle("invalid", bad);
  const input = field.querySelector("input:not([type=radio]), textarea");
  if (input) input.setAttribute("aria-invalid", String(bad));
}

// ---------- boot ----------

async function boot() {
  $("loadError").hidden = true;
  try {
    const r = await api("/api/config");
    if (!r.ok) throw new Error(`config ${r.status}`);
    cfg = r.data;
  } catch (err) {
    console.error(err);
    showRetry($("loadError"), "I couldn't load the calendar. Check your connection.", boot);
    return;
  }
  applyConfig();
  initCalendar();
  await restore();
}

function applyConfig() {
  $("chipDuration").textContent = cfg.sessionMinutes;
  $("chipPrice").textContent = cfg.amount;
  $("sumTotal").textContent = cfg.amount;
  $("payBtn").textContent = `Pay ₹${cfg.amount}`;

  const grid = $("focusOptions");
  grid.replaceChildren();
  for (const opt of cfg.focusOptions) {
    const label = document.createElement("label");
    label.className = "radio-card";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "focus";
    input.value = opt;
    label.append(input, document.createTextNode(opt));
    grid.append(label);
  }
}

// ---------- calendar ----------

const monthIndex = (key) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
const todayIST = () => todayKey(Date.now(), cfg.utcOffsetMinutes);

function initCalendar() {
  const today = todayIST();
  st.view = { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 };
  renderCalendar();
}

function renderCalendar() {
  const grid = $("calGrid");
  grid.replaceChildren();
  for (const d of DOW) {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.setAttribute("aria-hidden", "true");
    el.textContent = d;
    grid.append(el);
  }

  const { y, m } = st.view;
  $("calMonthLabel").textContent = `${MONTHS[m]} ${y}`;

  const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  for (let i = 0; i < lead; i++) {
    const el = document.createElement("div");
    el.className = "cal-empty";
    el.setAttribute("aria-hidden", "true");
    grid.append(el);
  }

  const now = Date.now();
  for (let d = 1; d <= days; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-day" + (key === st.date ? " selected" : "");
    btn.textContent = d;
    btn.disabled = !dayHasOpenSlot(key, now, cfg);
    btn.setAttribute("aria-label", dayLabel(key, { ...LONG_DAY, year: "numeric" }));
    btn.setAttribute("aria-pressed", String(key === st.date));
    btn.addEventListener("click", () => selectDate(key));
    grid.append(btn);
  }

  const here = st.view.y * 12 + st.view.m;
  const today = todayIST();
  $("calPrev").disabled = here <= monthIndex(today);
  $("calNext").disabled = here >= monthIndex(addDays(today, cfg.bookingWindowDays));
}

$("calPrev").addEventListener("click", () => shiftMonth(-1));
$("calNext").addEventListener("click", () => shiftMonth(1));
function shiftMonth(delta) {
  const d = new Date(Date.UTC(st.view.y, st.view.m + delta, 1));
  st.view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  renderCalendar();
}

async function selectDate(key) {
  st.date = key;
  st.time = null;
  $("slotConfirm").hidden = true;
  renderCalendar();
  $("slotsWrap").hidden = false;
  $("slotsDayLabel").textContent = dayLabel(key, SHORT_DAY);
  await loadSlots();
}

async function loadSlots() {
  const key = st.date;
  const req = ++st.slotReq;
  const grid = $("slotGrid");
  grid.replaceChildren(note("Checking availability…"));

  let slots;
  try {
    const r = await api(`/api/slots?date=${key}`);
    if (!r.ok) throw new Error(`slots ${r.status}`);
    slots = r.data.slots;
  } catch (err) {
    console.error(err);
    if (req !== st.slotReq) return;
    const box = document.createElement("span");
    box.className = "note";
    showRetry(box, "I couldn't check availability.", loadSlots);
    grid.replaceChildren(box);
    return;
  }
  if (req !== st.slotReq) return; // user already clicked another day

  if (!slots.length) {
    grid.replaceChildren(note("No times available on this day."));
    return;
  }
  const suffix = { booked: " (booked)", held: " (on hold)" };
  grid.replaceChildren(...slots.map(({ time, status }) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "slot-pill";
    pill.textContent = time + (suffix[status] || "");
    pill.dataset.time = time;
    pill.setAttribute("aria-pressed", "false");
    if (status === "open") {
      pill.addEventListener("click", () => selectTime(time));
    } else {
      pill.disabled = true;
      pill.title = status === "closed" ? "Too soon to book this time" : "Not available — pick another time";
    }
    return pill;
  }));
}

function selectTime(time) {
  st.time = time;
  for (const p of document.querySelectorAll(".slot-pill")) {
    const on = p.dataset.time === time;
    p.classList.toggle("selected", on);
    p.setAttribute("aria-pressed", String(on));
  }
  $("slotConfirmText").textContent = `${dayLabel(st.date, SHORT_DAY)}, ${nb(time)} IST`;
  $("slotConfirm").hidden = false;
  setInvalid("slot", false);
}

// ---------- intake form ----------

form.addEventListener("input", (e) => {
  const field = e.target.closest?.(".field");
  if (field?.dataset.field) setInvalid(field.dataset.field, false);
});

function validate() {
  const v = {
    name: $("name").value.trim(),
    email: $("email").value.trim(),
    whatsapp: $("whatsapp").value.trim(),
    focus: form.querySelector("input[name=focus]:checked")?.value || "",
    context: $("context").value.trim(),
  };
  const digits = v.whatsapp.replace(/\D/g, "");
  const bad = {
    name: v.name.length < 2,
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email),
    whatsapp: !/^\+?[0-9][0-9 ()-]*$/.test(v.whatsapp) || digits.length < 10 || digits.length > 15,
    focus: !v.focus,
    slot: !(st.date && st.time),
    promo: false,
  };
  for (const [name, isBad] of Object.entries(bad)) setInvalid(name, isBad);

  const first = Object.keys(bad).find((k) => bad[k]);
  if (first) {
    const target = {
      name: $("name"), email: $("email"), whatsapp: $("whatsapp"),
      focus: form.querySelector("input[name=focus]"),
      slot: document.querySelector(".cal-day:not(:disabled)"),
    }[first];
    target?.focus();
  }
  return first ? null : v;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!cfg) return;
  $("formError").hidden = true;

  const v = validate();
  if (!v) return;

  const btn = $("submitBtn");
  btn.disabled = true;
  btn.textContent = "Reserving your slot…";
  try {
    const r = await api("/api/book", { date: st.date, time: st.time, ...v, promoCode: $("promo").value.trim(), website: $("website").value });
    if (r.ok && r.data.free) {
      st.hold = { id: r.data.id, ref: r.data.ref, booking: v, date: r.data.date, time: r.data.time, free: true };
      finishBooked(r.data);
    } else if (r.ok) {
      startPayment(r.data, v);
    } else {
      bookError(r);
    }
  } catch (err) {
    console.error(err);
    showMessage($("formError"), "I couldn't reach the server. Check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Continue to payment";
  }
});

function bookError({ status, data }) {
  const err = $("formError");
  if (status === 409 || data.error === "invalid_slot") {
    showMessage(err, status === 409
      ? "Someone just reserved that time. Please pick another."
      : "That time is no longer available. Please pick another.");
    st.time = null;
    $("slotConfirm").hidden = true;
    loadSlots();
  } else if (data.error === "invalid_field") {
    setInvalid(data.field, true);
    showMessage(err, "Please check the highlighted field.");
  } else if (data.error === "invalid_promo") {
    setInvalid("promo", true);
    $("promo").focus();
    showMessage(err, "Please check your promo code, or clear it to pay in full.");
  } else if (data.error === "payment_unavailable") {
    showMessage(err, "Online payment isn't available right now. Please try again in a bit, or", { href: `https://wa.me/${cfg.whatsappNumber}`, text: "message me on WhatsApp." });
  } else if (status === 429) {
    showMessage(err, "Too many attempts. Please wait a few minutes and try again.");
  } else {
    showMessage(err, "Something went wrong on our side. Please try again in a moment.");
  }
}

// ---------- payment ----------

function startPayment(data, booking) {
  st.hold = {
    id: data.id,
    ref: data.ref,
    expiresAt: Date.now() + cfg.holdMinutes * 60000,
    booking,
    date: st.date,
    time: st.time,
    keyId: data.keyId,
    order: data.order,
  };
  persist();
  renderPayment();
  show("step2");
}

function renderPayment() {
  const h = st.hold;
  $("sumName").textContent = h.booking.name;
  $("sumFocus").textContent = h.booking.focus;
  $("sumSlot").textContent = `${dayLabel(h.date, SHORT_DAY)}, ${nb(h.time)}`;
  $("sumRef").textContent = h.ref;
  hidePayError();
  setPayButton();
  startTimer();
  preloadCheckout();
}

// Once a payment has been made the button only retries confirming it, so nobody pays twice.
function setPayButton(busyText) {
  const btn = $("payBtn");
  const expired = st.hold.expiresAt <= Date.now() && !st.hold.paid;
  btn.disabled = Boolean(busyText) || expired;
  btn.textContent = busyText || (st.hold.paid ? "Confirm my payment" : `Pay ₹${cfg.amount}`);
}

const hidePayError = () => { $("payError").hidden = true; };

function startTimer() {
  clearInterval(st.timer);
  const el = $("holdTimer");
  const tick = () => {
    if (st.hold.paid) {
      clearInterval(st.timer);
      el.classList.remove("expired");
      el.textContent = "Payment received. Confirming your booking…";
      return;
    }
    const left = st.hold.expiresAt - Date.now();
    if (left > 0) {
      el.classList.remove("expired");
      el.textContent = `Slot reserved for you — ${Math.floor(left / 60000)}:${pad(Math.floor(left / 1000) % 60)} left`;
    } else {
      clearInterval(st.timer);
      el.classList.add("expired");
      el.textContent = "Your reservation expired. Go back and pick your slot again.";
      if ($("payBtn").textContent.startsWith("Pay")) setPayButton();
    }
  };
  tick();
  st.timer = setInterval(tick, 1000);
}

// ---- Razorpay Checkout ----

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  st.checkout ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolve;
    script.onerror = () => { st.checkout = null; script.remove(); reject(new Error("checkout.js failed to load")); };
    document.head.append(script);
  });
  return st.checkout;
}
const preloadCheckout = () => { loadCheckout().catch(() => {}); };

$("payBtn").addEventListener("click", async () => {
  const h = st.hold;
  if (!h) return;
  hidePayError();
  if (h.paid) return confirmPayment(); // already paid: just retry the confirmation

  setPayButton("Opening secure checkout…");
  try {
    await loadCheckout();
  } catch (err) {
    console.error(err);
    showMessage($("payError"), "I couldn't load the payment window. Check your connection and try again.");
    setPayButton();
    return;
  }

  const rzp = new window.Razorpay({
    key: h.keyId,
    order_id: h.order.id,
    amount: h.order.amount,
    currency: h.order.currency,
    name: cfg.businessName,
    description: `1:1 session · ${dayLabel(h.date, SHORT_DAY)}, ${h.time} IST`,
    prefill: { name: h.booking.name, email: h.booking.email, contact: h.booking.whatsapp },
    notes: { ref: h.ref },
    theme: { color: "#1F4E8C" },
    modal: { ondismiss: () => setPayButton() },
    handler: (response) => {
      h.paid = { paymentId: response.razorpay_payment_id, signature: response.razorpay_signature };
      persist();
      confirmPayment();
    },
  });
  rzp.on("payment.failed", (response) => {
    showMessage($("payError"), `${response.error?.description || "The payment didn't go through."} You can try again.`);
    setPayButton();
  });
  rzp.open();
});

// Tell our server the payment happened; it verifies the signature and asks Razorpay itself.
async function confirmPayment() {
  const h = st.hold;
  hidePayError();
  setPayButton("Confirming your payment…");
  startTimer();
  const help = (extra) => ({ href: waUrl(`PROBLEM: ${extra} Payment id: ${h.paid.paymentId}`), text: "Message me on WhatsApp." });
  try {
    const r = await api("/api/verify", { id: h.id, razorpay_payment_id: h.paid.paymentId, razorpay_signature: h.paid.signature });
    if (r.ok) return finishBooked({ ...r.data, ref: h.ref });

    if (r.status === 409 && r.data.error === "slot_taken") {
      clearStored();
      showMessage($("payError"), r.data.status === "refunded"
        ? "Your payment arrived after your reservation expired, and someone else booked that time. I've refunded you in full (it takes 5 to 7 working days to show up). Please go back and pick another time."
        : "Your payment arrived after your reservation expired, and someone else booked that time. You'll be refunded in full. If you don't see it in a few days,",
        r.data.status === "refunded" ? null : help("My payment arrived after my slot expired and I need the refund."));
      st.hold.paid = null;
      setPayButton("Slot unavailable");
      return;
    }
    if (r.status === 402) {
      showMessage($("payError"), "Razorpay hasn't confirmed this payment yet. Wait a moment and tap the button again. Please don't pay twice.");
    } else if (r.status === 409 || r.status === 404 || r.status === 400) {
      showMessage($("payError"), "I couldn't match your payment to this booking. Please don't pay again;", help("My payment could not be matched to my booking."));
    } else {
      throw new Error(`verify ${r.status}`);
    }
  } catch (err) {
    console.error(err);
    showMessage($("payError"), "Your payment went through, but I couldn't confirm the booking just now. Please don't pay again. Tap the button to retry, or",
      help("I paid but the website could not confirm my booking."));
  }
  setPayButton();
}

function waUrl(extra) {
  const h = st.hold;
  const lines = [
    "Hi! About my 1:1 session booking:", "",
    `Ref: ${h.ref}`,
    `Name: ${h.booking.name}`,
    `Slot: ${slotLabel(h.date, h.time)}`,
  ];
  if (extra) lines.push("", extra);
  return `https://wa.me/${cfg.whatsappNumber}?text=${encodeURIComponent(lines.join("\n"))}`;
}

function finishBooked({ ref, date, time }) {
  const h = st.hold;
  clearInterval(st.timer);
  clearStored();
  $("doneLead").textContent = h.free
    ? "Your session is booked, no payment needed. I'll message you on WhatsApp before we meet."
    : "Payment received and your session is booked. I'll message you on WhatsApp before we meet.";
  $("doneSlot").textContent = `${dayLabel(date || h.date, LONG_DAY)}, ${nb(time || h.time)} IST`;
  $("doneRef").textContent = ref || h.ref;
  $("waLink").href = waUrl();
  show("step3");
}

$("backBtn").addEventListener("click", () => {
  releaseHold();
  show("step1");
  if (st.date) selectDate(st.date); // refresh availability; they re-pick a time
});

$("restartBtn").addEventListener("click", () => {
  form.reset();
  for (const f of form.querySelectorAll(".field")) setInvalid(f.dataset.field, false);
  $("formError").hidden = true;
  $("slotsWrap").hidden = true;
  $("slotConfirm").hidden = true;
  st.date = st.time = st.hold = null;
  initCalendar();
  show("step1");
});

// Free the slot right away instead of making others wait out the hold.
function releaseHold() {
  const h = st.hold;
  st.hold = null;
  clearInterval(st.timer);
  clearStored();
  if (h && !h.paid && !h.free) {
    fetch("/api/release", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: h.id }), keepalive: true,
    }).catch(() => {});
  }
}

// ---------- survive a reload while the customer is in their UPI/bank app ----------

function persist() {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ hold: st.hold, savedAt: Date.now() })); } catch { /* storage unavailable */ }
}
function clearStored() {
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ }
}

async function restore() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY)); } catch { /* none */ }
  const h = saved?.hold;
  if (!h?.id || !h.order || Date.now() - saved.savedAt > STORE_MAX_AGE_MS) return clearStored();

  // Ask the server what became of it (it also notices a payment we never heard about).
  let current = null;
  try {
    const r = await api(`/api/status?id=${encodeURIComponent(h.id)}`);
    if (r.ok) current = r.data.status;
    else if (r.status === 404) current = "gone";
  } catch { /* offline: fall back to what we remember */ }

  st.hold = h;
  if (current === "confirmed") return finishBooked({ ref: h.ref, date: h.date, time: h.time });
  if (current && current !== "held") {
    st.hold = null;
    clearStored();
    showMessage($("formError"), current === "refunded" || current === "refund_due"
      ? "Your earlier payment couldn't be used because that time was taken. It's being refunded. Please pick another time."
      : "Your earlier reservation is no longer active. Please pick a time again.");
    return;
  }

  st.date = h.date;
  st.time = h.time;
  st.view = { y: Number(h.date.slice(0, 4)), m: Number(h.date.slice(5, 7)) - 1 };
  $("name").value = h.booking.name;
  $("email").value = h.booking.email;
  $("whatsapp").value = h.booking.whatsapp;
  $("context").value = h.booking.context;
  for (const r of form.querySelectorAll("input[name=focus]")) r.checked = r.value === h.booking.focus;
  renderCalendar();
  renderPayment();
  show("step2");
  if (h.paid) confirmPayment(); // they paid but we never got the confirmation through: retry it
}

boot();
