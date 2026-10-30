import { addDays, dayHasOpenSlot, todayKey } from "/shared/dates.js";

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");

const STORE_KEY = "mentorBooking:v1";
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
  hold: null,     // { id, ref, expiresAt, booking, date, time } once a slot is reserved
  slotReq: 0,     // guards against out-of-order availability responses
  timer: null,
};

const form = $("intakeForm");

// ---------- helpers ----------

// Dates are plain strings in the mentor's timezone; format them as UTC so the
// visitor's own timezone can never shift the day.
const dayLabel = (key, opts) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", ...opts });
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
  s.className = "muted-mono";
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
    showRetry($("loadError"), "Couldn't load the booking calendar. Check your connection.", boot);
    return;
  }
  applyConfig();
  initCalendar();
  restore();
}

function applyConfig() {
  $("chipDuration").textContent = cfg.sessionMinutes;
  $("chipPrice").textContent = cfg.amount;
  $("sumTotal").textContent = cfg.amount;
  $("stepAmount").textContent = cfg.amount;
  $("upiIdText").textContent = cfg.upiId;

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
  grid.replaceChildren(note("checking availability..."));

  let slots;
  try {
    const r = await api(`/api/slots?date=${key}`);
    if (!r.ok) throw new Error(`slots ${r.status}`);
    slots = r.data.slots;
  } catch (err) {
    console.error(err);
    if (req !== st.slotReq) return;
    const box = document.createElement("span");
    box.className = "muted-mono";
    showRetry(box, "Couldn't check availability.", loadSlots);
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
  $("slotConfirmText").textContent = `${dayLabel(st.date, SHORT_DAY)}, ${time} IST`;
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
  btn.textContent = "> reserving_slot()...";
  try {
    const r = await api("/api/book", { date: st.date, time: st.time, ...v, website: $("website").value });
    if (r.ok) {
      startPayment(r.data, v);
    } else {
      bookError(r);
    }
  } catch (err) {
    console.error(err);
    showMessage($("formError"), "Couldn't reach the server. Check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "> proceed_to_payment()";
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
  };
  persist();
  renderPayment();
  show("step2");
}

function renderPayment() {
  const h = st.hold;
  $("sumName").textContent = h.booking.name;
  $("sumFocus").textContent = h.booking.focus;
  $("sumSlot").textContent = slotLabel(h.date, h.time).replace(/ IST$/, "");
  $("sumRef").textContent = h.ref;
  $("payError").hidden = true;

  // amount needs 2 decimals; the note carries the reference so payments can be matched to bookings
  const upi = `upi://pay?pa=${encodeURIComponent(cfg.upiId)}&pn=${encodeURIComponent(cfg.payeeName)}`
    + `&am=${Number(cfg.amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Mentor ${h.ref}`)}`;
  $("upiDeepLink").href = upi;

  const qr = $("qrcode");
  qr.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `UPI QR code for ₹${cfg.amount} to ${cfg.upiId}`);
  qr.append(canvas);
  const failed = () => {
    const s = document.createElement("span");
    s.className = "qr-fail";
    s.textContent = "QR failed to generate — use the UPI ID below instead.";
    qr.replaceChildren(s);
  };
  if (window.QRCode) {
    window.QRCode.toCanvas(canvas, upi, {
      width: 200, margin: 2, errorCorrectionLevel: "M", color: { dark: "#33402F", light: "#ffffff" },
    }, (error) => { if (error) { console.error(error); failed(); } });
  } else {
    failed();
  }

  startTimer();
}

function startTimer() {
  clearInterval(st.timer);
  const el = $("holdTimer");
  const tick = () => {
    const left = st.hold.expiresAt - Date.now();
    if (left > 0) {
      el.classList.remove("expired");
      el.textContent = `Slot reserved for you — ${Math.floor(left / 60000)}:${pad(Math.floor(left / 1000) % 60)} left`;
    } else {
      clearInterval(st.timer);
      el.classList.add("expired");
      el.textContent = "Reservation expired. If you've already paid, tap the button below and I'll check. Otherwise go back and pick your slot again.";
    }
  };
  tick();
  st.timer = setInterval(tick, 1000);
}

function waUrl(extra) {
  const h = st.hold;
  const b = h.booking;
  const lines = [
    "New session booking:", "",
    `Ref: ${h.ref}`,
    `Name: ${b.name}`,
    `Email: ${b.email}`,
    `WhatsApp: ${b.whatsapp}`,
    `Focus: ${b.focus}`,
    `Slot: ${slotLabel(h.date, h.time)}`,
    `Context: ${b.context || "-"}`, "",
    `Amount paid: Rs.${cfg.amount} (screenshot attached below)`,
  ];
  if (extra) lines.push("", extra);
  return `https://wa.me/${cfg.whatsappNumber}?text=${encodeURIComponent(lines.join("\n"))}`;
}

$("confirmBtn").addEventListener("click", async () => {
  const h = st.hold;
  if (!h) return;
  const btn = $("confirmBtn");
  const err = $("payError");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "> saving_booking()...";

  // These people have already paid, so every failure points them at WhatsApp.
  const wa = (extra) => ({ href: waUrl(extra), text: "Message me on WhatsApp" });
  try {
    const r = await api("/api/confirm", { id: h.id });
    if (r.ok) return finish();
    if (r.status === 409) {
      showMessage(err, "Your reservation expired and that time was booked by someone else. If you've already paid, message me with your screenshot and we'll sort out a new time or a refund.",
        wa("PROBLEM: my reservation expired and the slot was taken, but I have paid."));
    } else if (r.status === 404 || r.status === 410) {
      showMessage(err, "This booking is no longer active. If you've already paid, message me with your screenshot and we'll sort it out.",
        wa("PROBLEM: my booking was not active, but I have paid."));
    } else {
      throw new Error(`confirm ${r.status}`);
    }
  } catch (e) {
    console.error(e);
    showMessage(err, "Couldn't save your booking right now. Tap the button again to retry, or send your details on WhatsApp so I can note it manually.",
      wa("NOTE: the website could not save this booking, please check it manually."));
  } finally {
    btn.disabled = false;
    btn.textContent = "> i_have_paid()";
  }
});

function finish() {
  const url = waUrl();
  clearInterval(st.timer);
  clearStored();
  $("doneRef").textContent = st.hold.ref;
  $("waLink").href = url;
  window.open(url, "_blank", "noopener"); // may be blocked after an async call; the link on the page always works
  show("step3");
}

$("backBtn").addEventListener("click", () => {
  releaseHold();
  show("step1");
  if (st.date) selectDate(st.date); // refresh availability; they re-pick a time
});

$("copyUpiBtn").addEventListener("click", async () => {
  const btn = $("copyUpiBtn");
  try {
    await navigator.clipboard.writeText(cfg.upiId);
    btn.textContent = "copied!";
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("upiIdText"));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    btn.textContent = "press copy";
  }
  setTimeout(() => { btn.textContent = "copy"; }, 1500);
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
  if (h) {
    fetch("/api/release", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: h.id }), keepalive: true,
    }).catch(() => {});
  }
}

// ---------- survive a reload while the user is in their UPI app ----------

function persist() {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ hold: st.hold, savedAt: Date.now() })); } catch { /* storage unavailable */ }
}
function clearStored() {
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ }
}

function restore() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(STORE_KEY)); } catch { /* none */ }
  const h = saved?.hold;
  if (!h?.id || Date.now() - saved.savedAt > STORE_MAX_AGE_MS) return clearStored();

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
}

boot();
