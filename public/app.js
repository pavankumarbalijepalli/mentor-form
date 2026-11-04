import { addDays, dayHasOpenSlot, todayKey } from "/js/dates.js";

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");

const STORE_KEY = "mentorBooking:v3";
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
  hold: null,     // { id, ref, expiresAt, booking, date, time, payUrl, leftAt? } once a slot is reserved
  slotReq: 0,     // guards against out-of-order availability responses
  timer: null,
  checking: false, // true while we wait for PhonePe to say whether a payment went through
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

  // PhonePe sends customers back to /?booking=<id> after they pay (or give up).
  const returned = new URLSearchParams(location.search).get("booking");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(returned || "")) {
    history.replaceState(null, "", location.pathname);
    return resumeAfterPayment(returned);
  }
  await restore();
}

function applyConfig() {
  $("chipDuration").textContent = cfg.sessionMinutes;
  $("leadMinutes").textContent = cfg.sessionMinutes;
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

// ---------- payment (on PhonePe's page) ----------

const POLL_MS = 3000;
const POLL_TRIES = 20; // about a minute of waiting for PhonePe to finish
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WA_HELP = (text) => ({ href: waUrl(`PROBLEM: ${text}`), text: "Message me on WhatsApp." });

function startPayment(data, booking) {
  st.hold = {
    id: data.id,
    ref: data.ref,
    expiresAt: Date.now() + cfg.holdMinutes * 60000,
    booking,
    date: st.date,
    time: st.time,
    payUrl: data.payUrl,
  };
  persist();
  renderPayment();
  show("step2");
}

function renderPayment() {
  const h = st.hold;
  $("sumName").textContent = h.booking?.name || "—";
  $("sumFocus").textContent = h.booking?.focus || "—";
  $("sumSlot").textContent = `${dayLabel(h.date, SHORT_DAY)}, ${nb(h.time)}`;
  $("sumRef").textContent = h.ref;
  $("payError").hidden = true;
  $("backBtn").hidden = false;
  $("checkBtn").hidden = !h.leftAt; // only offered once they've been to PhonePe
  setPayButton();
  startTimer();
}

function setPayButton(busyText) {
  const btn = $("payBtn");
  const expired = st.hold.expiresAt <= Date.now();
  btn.disabled = Boolean(busyText) || st.checking || expired || !st.hold.payUrl;
  btn.textContent = busyText || (st.checking ? "Checking your payment…" : `Pay ₹${cfg.amount}`);
}

function startTimer() {
  clearInterval(st.timer);
  const el = $("holdTimer");
  const tick = () => {
    if (!st.hold) return clearInterval(st.timer); // the booking went away (e.g. unknown id): nothing to count down
    if (st.checking) {
      el.classList.remove("expired");
      el.textContent = "Checking your payment with PhonePe…";
      return;
    }
    const left = st.hold.expiresAt - Date.now();
    if (left > 0) {
      el.classList.remove("expired");
      el.textContent = `Slot reserved for you — ${Math.floor(left / 60000)}:${pad(Math.floor(left / 1000) % 60)} left`;
    } else {
      clearInterval(st.timer);
      el.classList.add("expired");
      el.textContent = "Your reservation expired. If you've already paid, tap “check my payment”. Otherwise go back and pick your slot again.";
      setPayButton();
    }
  };
  tick();
  st.timer = setInterval(tick, 1000);
}

// Off to PhonePe's hosted page; they bring the customer back to /?booking=<id>.
$("payBtn").addEventListener("click", () => {
  const h = st.hold;
  if (!h?.payUrl) return;
  $("payError").hidden = true;
  h.leftAt = Date.now();
  persist();
  setPayButton("Taking you to PhonePe…");
  window.location.assign(h.payUrl);
});

$("checkBtn").addEventListener("click", () => resumeAfterPayment(st.hold.id));

// Coming back from PhonePe (or tapping "check my payment"): the server asks PhonePe
// what happened. UPI payments can take a few seconds to settle, so wait a little.
async function resumeAfterPayment(id) {
  st.checking = true;
  if (st.hold?.id !== id) {
    const stored = readStored();
    st.hold = stored?.id === id ? stored : null;
  }
  const outcome = await pollStatus(id);
  st.checking = false;

  if (outcome.kind === "unknown") {
    clearInterval(st.timer);
    clearStored();
    st.hold = null;
    show("step1");
    showMessage($("formError"), "I couldn't find that booking. Please pick a time again.");
    return;
  }
  ensureHold(id, outcome.data);
  if (outcome.kind === "confirmed") return finishBooked(outcome.data);
  if (outcome.kind === "failed" && outcome.data.status === "held") {
    st.hold.expiresAt = outcome.data.holdExpiresAt || st.hold.expiresAt;
    renderPayment();
    show("step2");
    return showMessage($("payError"), "PhonePe says the payment didn't go through, so nothing was charged. You can try again.");
  }

  // anything else needs a human-readable explanation on the payment screen
  renderPayment();
  show("step2");
  $("backBtn").hidden = outcome.kind === "pending"; // never offer "back" while a payment may be in flight
  setPayButton();
  const err = $("payError");
  if (outcome.kind === "pending") {
    showRetry(err, "PhonePe is still processing your payment. Please don't pay again: it can take a few minutes. If money left your account and you see no confirmation within an hour, message me with your reference.", () => resumeAfterPayment(id));
    $("checkBtn").hidden = true;
  } else if (outcome.kind === "refunded") {
    showMessage(err, "Your payment arrived after your reservation expired, and someone else booked that time. I've refunded you in full (it takes 5 to 7 working days to show up). Please go back and pick another time.");
  } else if (outcome.kind === "refund_due") {
    showMessage(err, "Your payment arrived after your reservation expired, and someone else booked that time. You'll be refunded in full. If you don't see it in a few days,", WA_HELP("my payment arrived after my slot expired and I need the refund."));
  } else {
    showMessage(err, "I couldn't match your payment to an active booking. Please don't pay again;", WA_HELP("my payment could not be matched to my booking."));
  }
  $("payBtn").disabled = true;
  $("payBtn").textContent = outcome.kind === "pending" ? "Still processing…" : "Slot unavailable";
}

// Waits (up to about a minute) for a verdict. kind: confirmed | failed | pending | refunded | refund_due | closed | unknown
async function pollStatus(id) {
  renderChecking(id);
  let last = null;
  for (let i = 0; i < POLL_TRIES; i++) {
    try {
      const r = await api(`/api/status?id=${encodeURIComponent(id)}`);
      if (r.status === 404) return { kind: "unknown" };
      if (r.ok) {
        const d = (last = r.data);
        if (d.status === "confirmed") return { kind: "confirmed", data: d };
        if (d.status === "refunded" || d.status === "refund_due") return { kind: d.status, data: d };
        if (d.status === "released" || d.status === "cancelled") return { kind: "closed", data: d };
        if (d.payment === "failed" || d.payment === "mismatch") return { kind: d.payment === "failed" ? "failed" : "closed", data: d };
      }
    } catch { /* offline for a moment: keep trying */ }
    await sleep(POLL_MS);
  }
  return { kind: "pending", data: last || { status: "held" } };
}

function renderChecking(id) {
  if (st.hold?.id === id) {
    renderPayment();
  } else {
    st.hold = { id, ref: id.slice(0, 8).toUpperCase(), date: st.date || "1970-01-01", time: "", booking: {}, expiresAt: Date.now() };
    $("sumName").textContent = $("sumFocus").textContent = $("sumSlot").textContent = "—";
    $("sumRef").textContent = st.hold.ref;
    $("payError").hidden = true;
    $("checkBtn").hidden = true;
    startTimer();
  }
  $("backBtn").hidden = true;
  setPayButton();
  show("step2");
}

// After a return with no saved state (e.g. a different browser), rebuild what we need from the server's answer.
function ensureHold(id, d) {
  if (st.hold?.id === id && st.hold.booking?.name !== undefined && st.hold.time) return;
  st.hold = { ...(st.hold || {}), id, ref: d.ref, date: d.date, time: d.time, booking: st.hold?.booking || {}, payUrl: d.payUrl, expiresAt: d.holdExpiresAt || 0 };
}

function waUrl(extra) {
  const h = st.hold || {};
  const lines = [
    "Hi! About my 1:1 session booking:", "",
    `Ref: ${h.ref}`,
    ...(h.booking?.name ? [`Name: ${h.booking.name}`] : []),
    `Slot: ${slotLabel(h.date, h.time)}`,
  ];
  if (extra) lines.push("", extra);
  return `https://wa.me/${cfg.whatsappNumber}?text=${encodeURIComponent(lines.join("\n"))}`;
}

function finishBooked({ ref, date, time }) {
  clearInterval(st.timer);
  clearStored();
  st.checking = false;
  st.hold = { ...(st.hold || {}), ref: ref || st.hold?.ref, date: date || st.hold?.date, time: time || st.hold?.time };
  const h = st.hold;
  $("doneLead").textContent = h.free
    ? "Your session is booked, no payment needed. I'll message you on WhatsApp before we meet."
    : "Payment received and your session is booked. I'll message you on WhatsApp before we meet.";
  $("doneSlot").textContent = `${dayLabel(h.date, LONG_DAY)}, ${nb(h.time)} IST`;
  $("doneRef").textContent = h.ref;
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
  clearInterval(st.timer);
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
  if (h && !h.free) {
    fetch("/api/release", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: h.id }), keepalive: true,
    }).catch(() => {});
  }
}

// Coming back with the browser's Back button can show the page frozen as we left it.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted || !st.hold || $("step2").hidden || st.checking) return;
  setPayButton();
  if (st.hold.leftAt) {
    $("checkBtn").hidden = false;
    showMessage($("payError"), "If you've just paid, tap “check my payment” before paying again.");
  }
});

// ---------- survive a reload ----------

function persist() {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ hold: st.hold, savedAt: Date.now() })); } catch { /* storage unavailable */ }
}
function clearStored() {
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ }
}
function readStored() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY));
    if (saved?.hold?.id && Date.now() - saved.savedAt <= STORE_MAX_AGE_MS) return saved.hold;
  } catch { /* none */ }
  return null;
}

async function restore() {
  const h = readStored();
  if (!h?.payUrl) return clearStored();

  // Ask the server what became of it (it also notices a payment we never heard about).
  let current = null;
  try {
    const r = await api(`/api/status?id=${encodeURIComponent(h.id)}`);
    if (r.ok) current = r.data;
    else if (r.status === 404) current = { status: "gone" };
  } catch { /* offline: fall back to what we remember */ }

  if (current?.status === "confirmed") { st.hold = h; return finishBooked(current); }
  if (current && current.status !== "held") {
    clearStored();
    showMessage($("formError"), current.status === "refunded" || current.status === "refund_due"
      ? "Your earlier payment couldn't be used because that time was taken. It's being refunded. Please pick another time."
      : "Your earlier reservation is no longer active. Please pick a time again.");
    return;
  }

  st.hold = h;
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
  if (h.leftAt) {
    // They've been to PhonePe. Don't invite a second payment before they've checked the first.
    showMessage($("payError"), current?.payment === "failed"
      ? "PhonePe says your last payment didn't go through, so nothing was charged. You can try again."
      : "If you've just paid, tap “check my payment” before paying again.");
  }
}

boot();
