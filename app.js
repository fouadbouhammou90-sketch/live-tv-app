import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, onValue, push, set, update, remove, serverTimestamp, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { firebaseConfig, FUNCTIONS_REGION, WORKER_URL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
const sendNotificationFn = httpsCallable(getFunctions(app, FUNCTIONS_REGION || "us-central1"), "sendNotification");
const $ = id => document.getElementById(id);

let currentTab = "home";
let categories = {};
let channels = {};
let matches = {};
let privateStreams = {};
let dataUnsubscribers = [];
let uploadCounter = 0;
let channelSearch = "";
let channelCategoryFilter = "all";
let privateStreamSearch = "";

const tabTitles = {
  home: "الرئيسية",
  categories: "إدارة الأقسام",
  channels: "إدارة القنوات",
  matches: "إدارة المباريات",
  privateStreams: "إدارة ومقارنة روابط البث المحمية",
  notifications: "إدارة وشحن الإشعارات الجماعية (FCM)",
  import: "الاستيراد بالجملة"
};

const icon = name => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ============ الدخول والخروج ============ */
onAuthStateChanged(auth, user => {
  $("loginScreen").hidden = !!user;
  $("dashboardScreen").hidden = !user;
  if (user) {
    startDataListeners();
    const nm = document.querySelector(".user-name"), av = document.querySelector(".user-avatar");
    if (nm) nm.textContent = user.email || "مدير النظام";
    if (av) av.textContent = (user.email || "A")[0].toUpperCase();
  }
  else stopDataListeners();
});

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("loginBtn");
  button.disabled = true;
  button.textContent = "جارٍ تسجيل الدخول...";
  $("loginMsg").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (error) {
    $("loginMsg").textContent = friendlyFirebaseError(error);
  } finally {
    button.disabled = false;
    button.textContent = "تسجيل الدخول";
  }
});

$("logoutBtn").addEventListener("click", () => signOut(auth));
$("logoutBtnMobile").addEventListener("click", () => signOut(auth));

/* ============ التنقل ============ */
function goTab(tab) {
  currentTab = tab;
  document.querySelectorAll("[data-tab]").forEach(item => item.classList.toggle("active", item.dataset.tab === tab));
  renderTab();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => goTab(button.dataset.tab)));

/* ============ البيانات ============ */
function startDataListeners() {
  stopDataListeners();
  dataUnsubscribers = [
    onValue(ref(db, "categories"), snapshot => { categories = snapshot.val() || {}; renderTab(); }, handleDatabaseError),
    onValue(ref(db, "channels"), snapshot => { channels = snapshot.val() || {}; renderTab(); }, handleDatabaseError),
    onValue(ref(db, "matches"), snapshot => { matches = snapshot.val() || {}; renderTab(); }, handleDatabaseError),
    onValue(ref(db, "privateStreams"), snapshot => { privateStreams = snapshot.val() || {}; renderTab(); }, handleDatabaseError),
    onValue(query(ref(db, "notifications_history"), limitToLast(30)), snapshot => { notifHistory = snapshot.val() || {}; renderNotifHistory(); }, () => {})
  ];
}
function stopDataListeners() {
  dataUnsubscribers.forEach(unsubscribe => { try { unsubscribe(); } catch (_) {} });
  dataUnsubscribers = [];
}
function handleDatabaseError(error) {
  console.error("Firebase Database:", error);
  toast(`تعذر تحميل البيانات: ${friendlyFirebaseError(error)}`, "error");
}

const sortCategoryEntries = entries => entries.sort((a, b) => Number(a[1]?.sort || 0) - Number(b[1]?.sort || 0) || String(a[1]?.name || "").localeCompare(String(b[1]?.name || ""), "ar"));
const sortedCategories = () => sortCategoryEntries(Object.entries(categories));
const childCategories = parentId => sortCategoryEntries(Object.entries(categories).filter(([, item]) => (item.parentId || "") === (parentId || "")));
const categoryLabel = id => {
  const item = categories[id]; if (!item) return "بدون قسم";
  const parent = item.parentId && categories[item.parentId];
  return parent ? `${parent.name || "قسم رئيسي"} / ${item.name || "قسم فرعي"}` : (item.name || "بدون اسم");
};
const categoryTreeEntries = () => {
  const result = [];
  const walk = (parentId, depth, ancestors = new Set()) => {
    childCategories(parentId).forEach(([id, item]) => {
      if (ancestors.has(id)) return;
      result.push([id, item, depth]);
      const next = new Set(ancestors); next.add(id); walk(id, depth + 1, next);
    });
  };
  walk("", 0); 
  Object.entries(categories).forEach(([id, item]) => { if (!result.some(row => row[0] === id)) result.push([id, item, 0]); });
  return result;
};
const channelsIn = categoryId => Object.values(channels).filter(channel => channel.categoryId === categoryId);
const normUrl = value => String(value || "").trim().toLowerCase();

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============ حماية الروابط عبر Cloudflare Worker ============ */
// الرابط الأصلي لا يُحفظ في Firebase إطلاقاً: يُرسل للـ Worker فيُشفَّره (AES-256-GCM) ويحفظه في KV.
// في Firebase نحفظ فقط علامة hasLink=true. التطبيق يطلب الرابط لحظة التشغيل من الـ Worker.
function workerErrorText(status, code) {
  const map = {
    login_required: "سجّل الدخول من جديد.", bad_token: "انتهت الجلسة. سجّل الخروج ثم الدخول.",
    not_admin: "بريدك ليس ضمن ADMIN_EMAILS في إعدادات الـ Worker.", batch_size: "عدد الروابط في الدفعة غير مسموح.",
    bad_item: "رابط غير صالح (يجب أن يبدأ بـ http أو https).", no_link: "لا يوجد رابط محفوظ لهذا العنصر.",
    AES_KEY_invalid: "AES_KEY غير مضبوط في الـ Worker (64 حرف hex).", server_error: "خطأ في خادم الحماية."
  };
  return map[code] || `خطأ من خادم الحماية (${status}${code ? ": " + code : ""}).`;
}
async function workerCall(path, body) {
  if (!WORKER_URL || /YOUR-|PASTE/i.test(WORKER_URL)) {
    console.error("[WORKER_URL Missing/Invalid]:", WORKER_URL);
    throw new Error("اضبط WORKER_URL في firebase-config.js أولاً.");
  }
  const user = auth.currentUser;
  if (!user) throw new Error("سجّل الدخول أولاً.");
  const token = await user.getIdToken();
  let res;
  const targetEndpoint = `${WORKER_URL.replace(/\/$/, "")}${path}`;
  console.log(`[Worker Call Initiated]: ${targetEndpoint}`);
  try {
    res = await fetch(targetEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error(`[Worker Call Network/CORS Error] Target: ${targetEndpoint}`, err);
    throw new Error(`تعذر الاتصال بخادم الحماية (${WORKER_URL}). تحقق من تفعيل CORS وسماح ALLOWED_ORIGINS في Cloudflare Worker.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[Worker Call HTTP Error] Status: ${res.status}`, data);
    throw new Error(workerErrorText(res.status, data.error));
  }
  console.log(`[Worker Call Success] Status: ${res.status}`);
  return data;
}
async function saveLinks(items, onProgress) {
  for (let i = 0; i < items.length; i += 40) {
    await workerCall("/api/admin/links", { items: items.slice(i, i + 40) });
    if (onProgress) onProgress(Math.min(i + 40, items.length), items.length);
  }
}
const saveSecureLink = (type, id, url) => saveLinks([{ type, id, url }]);
async function deleteSecureLinks(type, ids) {
  for (let i = 0; i < ids.length; i += 40) await workerCall("/api/admin/delete", { type, ids: ids.slice(i, i + 40) });
}

// تأمين الروابط القديمة: ينسخها للـ Worker ويضع hasLink (لا يحذف النص حتى تحدّث التطبيق)
async function migrateAllLinks(button) {
  const jobs = [];
  Object.keys(channels).forEach(id => { const u = privateStreams?.channels?.[id]?.streamUrl || channels[id].url; if (!channels[id].hasLink && u) jobs.push({ type: "channels", id, url: u }); });
  Object.keys(matches).forEach(id => { const u = privateStreams?.matches?.[id]?.streamUrl || matches[id].channelUrl; if (!matches[id].hasLink && u) jobs.push({ type: "matches", id, url: u }); });
  if (!jobs.length) { toast("لا توجد روابط قديمة تحتاج تأميناً.", "success"); return; }
  if (!(await confirmDialog("تأمين الروابط الحالية", `سيتم تشفير ${jobs.length} رابط ونقلها إلى خادم الحماية. النصوص القديمة تبقى في Firebase حتى تضغط «حذف النسخ النصية». (حد الكتابة المجاني في KV هو 1000 يومياً)`))) return;
  button.disabled = true;
  try {
    await saveLinks(jobs, (done, total) => { button.textContent = `جارٍ التأمين ${done}/${total}`; });
    const updates = {};
    jobs.forEach(j => { updates[`${j.type}/${j.id}/hasLink`] = true; });
    await update(ref(db), updates);
    toast(`تم تأمين ${jobs.length} رابط ✓`, "success");
  } catch (error) { toast(error.message || friendlyFirebaseError(error), "error"); }
  button.disabled = false; button.textContent = "🔒 تأمين الروابط الحالية";
}

// حذف النصوص نهائياً من Firebase (للعناصر المؤمَّنة فقط)
async function purgePlainLinks(button) {
  const updates = {};
  let count = 0;
  Object.keys(channels).forEach(id => { if (channels[id].hasLink) {
    if (channels[id].url) { updates[`channels/${id}/url`] = null; count++; }
    if (privateStreams?.channels?.[id]?.streamUrl) { updates[`privateStreams/channels/${id}/streamUrl`] = null; count++; }
  } });
  Object.keys(matches).forEach(id => { if (matches[id].hasLink) {
    if (matches[id].channelUrl) { updates[`matches/${id}/channelUrl`] = null; count++; }
    if (privateStreams?.matches?.[id]?.streamUrl) { updates[`privateStreams/matches/${id}/streamUrl`] = null; count++; }
  } });
  if (!count) { toast("لا توجد نسخ نصية للحذف.", "success"); return; }
  if (!(await confirmDialog("حذف الروابط النصية", `سيتم حذف ${count} نسخة نصية من Firebase. التطبيق القديم الذي يقرأ الروابط من Firebase سيتوقف عن تشغيل هذه القنوات. تأكد أن التطبيق الجديد (خادم الحماية) منشور. متابعة؟`))) return;
  button.disabled = true;
  try { await update(ref(db), updates); toast("تم حذف النصوص. الروابط الآن في خادم الحماية فقط ✓", "success"); }
  catch (error) { toast(error.message || friendlyFirebaseError(error), "error"); }
  button.disabled = false;
}

/* ============ العرض ============ */
function renderTab() {
  if (!$("tabContent")) return;
  $("pageTitle").textContent = tabTitles[currentTab] || "لوحة التحكم";
  if (currentTab === "home") renderHome();
  if (currentTab === "categories") renderCategories();
  if (currentTab === "channels") renderChannels();
  if (currentTab === "matches") renderMatches();
  if (currentTab === "privateStreams") renderPrivateStreams();
  if (currentTab === "notifications") renderNotifications();
  if (currentTab === "import") renderImport();
}

function renderHome() {
  const categoryCount = Object.keys(categories).length;
  const channelCount = Object.keys(channels).length;
  const matchCount = Object.keys(matches).length;
  const liveCount = Object.values(matches).filter(match => /مباشر|live/i.test(match.status || "")).length;
  const maxInCat = Math.max(1, ...Object.keys(categories).map(id => channelsIn(id).length));

  const bars = sortedCategories().map(([id, category]) => {
    const count = channelsIn(id).length;
    return `<div class="cat-bar">${logoCell(category.logo, category.name)}<b>${esc(category.name || "بدون اسم")}</b><em>${count} قناة</em><div class="bar-track"><span style="width:${Math.round(count / maxInCat * 100)}%"></span></div></div>`;
  }).join("");

  const recent = Object.entries(channels).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6).map(([, channel]) => `
    <div class="recent-item">${logoCell(channel.logo, channel.name)}<div class="grow"><b>${esc(channel.name || "بدون اسم")}</b><small>${esc(categoryLabel(channel.categoryId))}</small></div><span class="status-pill ${channel.status === "disabled" ? "off" : "on"}">${channel.status === "disabled" ? "معطلة" : "مفعلة"}</span></div>`).join("");

  $("tabContent").innerHTML = `
    <section class="welcome-panel">
      <div><span class="eyebrow light">مرحباً بك مجدداً</span><h2>إدارة RAYA TV PRO بسهولة</h2><p>أضف القناة مرة واحدة واخترها في عدة أقسام بضغطة زر واحدة، وارفع الشعارات مباشرة من جهازك، مع نظام المقارنة والحماية الفورية.</p></div>
      <button class="welcome-cta" id="homeAddChannel">${icon("plus")} إضافة قناة جديدة</button>
    </section>
    <div class="stats-grid">
      ${statCard("folder", categoryCount, "إجمالي الأقسام", "blue")}
      ${statCard("tv", channelCount, "إجمالي القنوات", "gold")}
      ${statCard("ball", matchCount, "إجمالي المباريات", "purple")}
      ${statCard("live", liveCount, "المباريات المباشرة", "red")}
    </div>
    <div class="home-grid">
      <section class="panel-card"><div class="section-heading"><span class="eyebrow">نظرة عامة</span><h2>القنوات في كل قسم</h2></div><div class="cat-bars">${bars || `<p class="multi-empty">لا توجد أقسام بعد.</p>`}</div></section>
      <section class="panel-card"><div class="section-heading"><span class="eyebrow">آخر الإضافات</span><h2>أحدث القنوات</h2></div><div class="recent-list">${recent || `<p class="multi-empty">لا توجد قنوات بعد.</p>`}</div></section>
    </div>`;
  $("homeAddChannel").onclick = () => openChannelModal();
  bindLogoFallback();
}
function statCard(iconName, value, label, color) {
  return `<article class="stat-card"><div class="stat-icon ${color}">${icon(iconName)}</div><div><strong>${value}</strong><span>${label}</span></div></article>`;
}

function renderCategories() {
  const tree = categoryTreeEntries();
  const rows = tree.map(([key, category, depth]) => {
    const count = channelsIn(key).length;
    const parent = category.parentId && categories[category.parentId];
    return `<tr>
      <td class="cell-main">${logoCell(category.logo, category.name)}<div><b>${depth ? "↳ " : ""}${esc(category.name || "بدون اسم")}</b><small class="cell-sub">${parent ? `داخل ${esc(parent.name || "")}` : "قسم رئيسي"}</small></div></td>
      <td data-label="الترتيب">${Number(category.sort || 0)}</td>
      <td data-label="القنوات"><span class="count-pill">${count} قناة</span></td>
      <td class="cell-actions">${actionButtons("cat", key)}</td>
    </tr>`;
  }).join("");
  $("tabContent").innerHTML = `<section class="panel-card"><div class="panel-header"><div><span class="eyebrow">تنظيم المحتوى</span><h2>الأقسام والتصنيفات <span class="title-count">${Object.keys(categories).length}</span></h2><p class="panel-subtitle">أنشئ قسماً رئيسياً ثم أضف تحته أقساماً فرعية، وضع القنوات داخل القسم المناسب.</p></div><button class="btn-primary" id="addCatBtn">${icon("plus")} إضافة قسم</button></div><div class="category-tree-note">${icon("layers")} يمكنك بناء هيكل مثل: الرياضة ← beIN SPORTS، والأفلام ← أفلام عربية.</div><div class="table-responsive"><table class="data-table"><thead><tr><th>القسم / التصنيف</th><th>الترتيب</th><th>القنوات</th><th>الإجراءات</th></tr></thead><tbody>${rows || emptyRow(4, "لا توجد أقسام بعد. أضف أول قسم للبدء.")}</tbody></table></div></section>`;
  $("addCatBtn").onclick = () => openCategoryModal();
  bindLogoFallback();
  document.querySelectorAll("[data-del-cat]").forEach(button => button.onclick = async () => {
    const id = button.dataset.delCat;
    const children = childCategories(id);
    if (children.length) { toast("لا يمكن حذف هذا القسم قبل نقل أو حذف الأقسام الفرعية التابعة له.", "error"); return; }
    if (!(await confirmDialog("حذف القسم", "هل أنت متأكد من حذف هذا القسم؟"))) return;
    try { await remove(ref(db, `categories/${id}`)); toast("تم حذف القسم.", "success"); }
    catch (error) { toast(`تعذر الحذف: ${friendlyFirebaseError(error)}`, "error"); }
  });
  document.querySelectorAll("[data-edit-cat]").forEach(button => button.onclick = () => openCategoryModal(button.dataset.editCat, categories[button.dataset.editCat]));
}

function renderChannels() {
  if (channelCategoryFilter !== "all" && channelCategoryFilter !== "none" && !categories[channelCategoryFilter]) channelCategoryFilter = "all";
  const search = channelSearch.trim().toLowerCase();
  const noCategoryCount = Object.values(channels).filter(channel => !categories[channel.categoryId]).length;

  const entries = Object.entries(channels)
    .filter(([, channel]) => {
      if (channelCategoryFilter === "none") { if (categories[channel.categoryId]) return false; }
      else if (channelCategoryFilter !== "all" && channel.categoryId !== channelCategoryFilter) return false;
      const categoryName = categories[channel.categoryId]?.name || "";
      const countryName = channel.country || "";
      return `${channel.name || ""} ${categoryName} ${countryName}`.toLowerCase().includes(search);
    })
    .sort((a, b) => String(a[1].name || "").localeCompare(String(b[1].name || ""), "ar"));

  const rows = entries.map(([key, channel]) => {
    const categoryName = categoryLabel(channel.categoryId);
    const countryName = String(channel.country || "").trim();
    const disabled = channel.status === "disabled";
    const isLocked = !!channel.hasLink;
    const hasSecureUrl = isLocked || !!(privateStreams?.channels?.[key]?.streamUrl || channel.url);
    return `<tr>
      <td class="cell-main">${logoCell(channel.logo, channel.name)}<div><b>${esc(channel.name || "بدون اسم")}</b><small class="cell-sub">${esc(channel.quality || "")}</small></div></td>
      <td data-label="القسم"><span class="category-pill">${esc(categoryName)}${countryName ? ` / ${esc(countryName)}` : ""}</span></td>
      <td data-label="رابط البث"><span class="url-state ${isLocked ? "locked" : hasSecureUrl ? "warn" : "none"}">${isLocked ? "🔒 محمي ومشفّر" : hasSecureUrl ? "⚠ غير مشفّر" : "لا يوجد رابط"}</span></td>
      <td data-label="الحالة"><span class="status-pill ${disabled ? "off" : "on"}">${disabled ? "معطلة" : "مفعلة"}</span></td>
      <td class="cell-actions"><div class="action-btns"><button class="btn-sm btn-edit" data-edit-chan="${esc(key)}">${icon("edit")} تعديل</button><button class="btn-sm btn-edit" data-copy-chan="${esc(key)}">${icon("copy")} أقسام</button><button class="btn-sm btn-del" data-del-chan="${esc(key)}">${icon("trash")} حذف</button></div></td>
    </tr>`;
  }).join("");

  const chip = (value, label, count) => `<button class="chip ${channelCategoryFilter === value ? "active" : ""}" data-filter="${esc(value)}">${esc(label)} <small>${count}</small></button>`;
  const chips = chip("all", "الكل", Object.keys(channels).length)
    + sortedCategories().map(([id, category]) => chip(id, category.name || "بدون اسم", channelsIn(id).length)).join("")
    + (noCategoryCount ? chip("none", "بدون قسم", noCategoryCount) : "");

  $("tabContent").innerHTML = `<section class="panel-card">
    <div class="panel-header"><div><span class="eyebrow">مكتبة البث</span><h2>القنوات <span class="title-count">${Object.keys(channels).length}</span></h2><p class="panel-subtitle">استعرض القنوات وعدلها، أو استخدم تبويب «إدارة ومقارنة روابط البث المحمية» للتحقق من الروابط.</p></div>
      <div class="header-tools"><div class="search-wrap">${icon("search")}<input id="channelSearch" class="search-box" type="search" placeholder="ابحث عن قناة أو قسم..." value="${esc(channelSearch)}"></div><button class="btn-primary" id="addChanBtn">${icon("plus")} إضافة قناة</button></div></div>
    <div class="chip-row" id="chipRow">${chips}</div>
    <div class="table-responsive"><table class="data-table"><thead><tr><th>القناة</th><th>القسم</th><th>رابط البث</th><th>الحالة</th><th>الإجراءات</th></tr></thead><tbody>${rows || emptyRow(5, "لا توجد قنوات مطابقة.")}</tbody></table></div></section>`;

  $("channelSearch").addEventListener("input", event => {
    channelSearch = event.target.value;
    const pos = event.target.selectionStart;
    renderChannels();
    const input = $("channelSearch"); input.focus(); input.setSelectionRange(pos, pos);
  });
  document.querySelectorAll("[data-filter]").forEach(button => button.onclick = () => { channelCategoryFilter = button.dataset.filter; renderChannels(); });
  $("addChanBtn").onclick = () => openChannelModal();
  bindLogoFallback();
  bindDelete("chan", "channels", "القناة");
  document.querySelectorAll("[data-edit-chan]").forEach(button => button.onclick = () => openChannelModal(button.dataset.editChan, channels[button.dataset.editChan]));
  document.querySelectorAll("[data-copy-chan]").forEach(button => button.onclick = () => openCopyModal(button.dataset.copyChan));
}

/* ============ المباريات: بطاقات + تحكم كامل ============ */
let matchSearch = "";
let matchFilter = "all";
const normStatus = value => {
  const s = String(value || "").trim().toLowerCase();
  if (/مباشر|live|inplay|playing/.test(s)) return "مباشرة";
  if (/انته|finish|ended|\bft\b|full/.test(s)) return "انتهت";
  return "قادمة";
};
const matchStatusClass = st => st === "مباشرة" ? "live" : st === "انتهت" ? "off" : "upcoming";
const sortedMatches = () => Object.entries(matches).sort((a, b) =>
  (Number(a[1]?.sort ?? 1e9) - Number(b[1]?.sort ?? 1e9)) || String(a[1]?.time || "").localeCompare(String(b[1]?.time || "")));
const scoreVal = id => { const v = ($(id)?.value || "").trim(); return v === "" || isNaN(Number(v)) ? null : Number(v); };
const nextMatchSort = () => Math.max(0, ...Object.values(matches).map(x => Number(x?.sort) || 0)) + 1;

function renderMatches() {
  const q = matchSearch.trim().toLowerCase();
  const all = sortedMatches();
  const count = st => all.filter(([, m]) => normStatus(m.status) === st).length;
  const list = all.filter(([, m]) =>
    (matchFilter === "all" || normStatus(m.status) === matchFilter) &&
    `${m.home || ""} ${m.away || ""} ${m.league || ""} ${m.channelName || ""} ${m.commentator || ""}`.toLowerCase().includes(q));

  const cards = list.map(([key, m]) => {
    const st = normStatus(m.status), cls = matchStatusClass(st);
    const hasScore = m.homeScore !== undefined && m.homeScore !== null && m.homeScore !== "";
    const center = hasScore && st !== "قادمة"
      ? `<div class="score"><span>${esc(m.homeScore)}</span><i>:</i><span>${esc(m.awayScore ?? 0)}</span></div>`
      : `<div class="vs">VS</div>`;
    const position = all.findIndex(([k]) => k === key) + 1;
    return `<article class="item-card match-card st-${cls}">
      <div class="match-top">
        <div class="order-ctl" title="ترتيب المباراة">
          <button type="button" class="ord-btn" data-move="${esc(key)}|-1" aria-label="للأعلى">${icon("up")}</button>
          <input class="order-input" type="number" min="1" max="${all.length}" value="${position}" data-pos="${esc(key)}" aria-label="رقم الترتيب">
          <button type="button" class="ord-btn" data-move="${esc(key)}|1" aria-label="للأسفل">${icon("down")}</button>
        </div>
        <div class="match-meta"><b>${esc(m.league || "بطولة غير محددة")}</b><small>${esc([m.date, m.channelName].filter(Boolean).join(" • ") || "بدون قناة")}</small></div>
        <span class="status-pill ${cls}">${esc(st)}</span>
      </div>
      <div class="scoreline">
        <div class="team">${logoCell(m.homeLogo, m.home)}<b>${esc(m.home || "الفريق الأول")}</b></div>
        <div class="center">${center}<span class="match-time">${esc(m.time || "—")}</span></div>
        <div class="team">${logoCell(m.awayLogo, m.away)}<b>${esc(m.away || "الفريق الثاني")}</b></div>
      </div>
      ${m.commentator ? `<div class="commentator">${icon("mic")}<span>${esc(m.commentator)}</span></div>` : ""}
      <div class="match-foot">
        <div class="seg" role="group" aria-label="حالة المباراة">${["قادمة", "مباشرة", "انتهت"].map(s => `<button type="button" class="${st === s ? "on " + matchStatusClass(s) : ""}" data-set-status="${esc(key)}|${s}">${s}</button>`).join("")}</div>
        <div class="action-btns">
          <button type="button" class="btn-sm btn-edit" data-edit-match="${esc(key)}">${icon("edit")} تعديل</button>
          <button type="button" class="btn-sm btn-edit" data-dup-match="${esc(key)}">${icon("copy")} نسخ</button>
          <button type="button" class="btn-sm btn-del" data-del-match="${esc(key)}">${icon("trash")} حذف</button>
        </div>
      </div>
    </article>`;
  }).join("");

  const chip = (value, label, n) => `<button type="button" class="${matchFilter === value ? "on" : ""}" data-match-filter="${value}">${label} <em>${n}</em></button>`;
  $("tabContent").innerHTML = `<section class="panel-card">
    <div class="panel-header">
      <div><span class="eyebrow">جدول البث الرياضي</span><h2>المباريات <span class="title-count">${all.length}</span></h2>
      <p class="panel-subtitle">رتّب المباريات بالأسهم أو برقم، غيّر الحالة بضغطة، وأدخل النتيجة من نافذة التعديل. لإضافة عدد كبير استعمل تبويب «استيراد JSON».</p></div>
      <div class="header-tools">
        <div class="search-wrap">${icon("search")}<input id="matchSearchBox" class="search-box" type="search" placeholder="ابحث عن فريق أو بطولة..." value="${esc(matchSearch)}"></div>
        <button type="button" class="btn-secondary danger-outline" id="purgeFinishedBtn">${icon("trash")} حذف المنتهية</button>
        <button type="button" class="btn-primary" id="addMatchBtn">${icon("plus")} إضافة مباراة</button>
      </div>
    </div>
    <div class="seg filter-seg" role="group" aria-label="تصفية">${chip("all", "الكل", all.length)}${chip("مباشرة", "مباشرة", count("مباشرة"))}${chip("قادمة", "قادمة", count("قادمة"))}${chip("انتهت", "انتهت", count("انتهت"))}</div>
    <div class="item-grid match-grid">${cards || `<div class="empty-state big">${icon("ball")}<b>لا توجد مباريات مطابقة</b><small>أضف مباراة أو استورد جدولاً كاملاً بصيغة JSON.</small></div>`}</div>
  </section>`;

  $("addMatchBtn").onclick = () => openMatchModal();
  $("purgeFinishedBtn").onclick = purgeFinishedMatches;
  $("matchSearchBox").addEventListener("input", e => {
    matchSearch = e.target.value;
    const pos = e.target.selectionStart;
    renderMatches();
    const input = $("matchSearchBox"); input.focus(); input.setSelectionRange(pos, pos);
  });
  document.querySelectorAll("[data-match-filter]").forEach(b => b.onclick = () => { matchFilter = b.dataset.matchFilter; renderMatches(); });
  document.querySelectorAll("[data-set-status]").forEach(b => b.onclick = async () => {
    const [key, status] = [b.dataset.setStatus.slice(0, b.dataset.setStatus.lastIndexOf("|")), b.dataset.setStatus.split("|").pop()];
    try { await update(ref(db, `matches/${key}`), { status }); } catch (e) { toast(friendlyFirebaseError(e), "error"); }
  });
  document.querySelectorAll("[data-move]").forEach(b => b.onclick = () => {
    const i = b.dataset.move.lastIndexOf("|");
    const key = b.dataset.move.slice(0, i), step = Number(b.dataset.move.slice(i + 1));
    placeMatch(key, sortedMatches().findIndex(([k]) => k === key) + step);
  });
  document.querySelectorAll("[data-pos]").forEach(inp => inp.onchange = () => placeMatch(inp.dataset.pos, (Number(inp.value) || 1) - 1));
  document.querySelectorAll("[data-dup-match]").forEach(b => b.onclick = () => duplicateMatch(b.dataset.dupMatch));
  bindLogoFallback();
  bindDelete("match", "matches", "المباراة");
  document.querySelectorAll("[data-edit-match]").forEach(button => button.onclick = () => openMatchModal(button.dataset.editMatch, matches[button.dataset.editMatch]));
}

async function placeMatch(key, targetIndex) {
  const keys = sortedMatches().map(([k]) => k);
  const from = keys.indexOf(key);
  if (from < 0) return;
  const to = Math.max(0, Math.min(keys.length - 1, targetIndex));
  if (from === to) { renderMatches(); return; }
  keys.splice(to, 0, keys.splice(from, 1)[0]);
  const updates = {};
  keys.forEach((k, i) => { if (Number(matches[k]?.sort) !== i + 1) updates[`matches/${k}/sort`] = i + 1; });
  try { await update(ref(db), updates); } catch (e) { toast(friendlyFirebaseError(e), "error"); }
}

async function duplicateMatch(key) {
  const m = matches[key];
  if (!m) return;
  const { homeScore, awayScore, ...rest } = m;
  const newKey = push(ref(db, "matches")).key;
  const updates = { [`matches/${newKey}`]: { ...rest, status: "قادمة", sort: nextMatchSort() } };
  const link = privateStreams?.matches?.[key]?.streamUrl;
  if (link) updates[`privateStreams/matches/${newKey}`] = { streamUrl: link, status: "active", updatedAt: Date.now() };
  try { if (m.hasLink) await workerCall("/api/admin/copy", { type: "matches", from: key, to: [newKey] }); await update(ref(db), updates); toast("تم نسخ المباراة (بحالة قادمة).", "success"); }
  catch (e) { toast(friendlyFirebaseError(e), "error"); }
}

async function purgeFinishedMatches() {
  const done = Object.keys(matches).filter(k => normStatus(matches[k].status) === "انتهت");
  if (!done.length) { toast("لا توجد مباريات منتهية.", "info"); return; }
  if (!(await confirmDialog("حذف المباريات المنتهية", `سيتم حذف ${done.length} مباراة منتهية نهائياً. متابعة؟`))) return;
  const updates = {};
  done.forEach(k => { updates[`matches/${k}`] = null; updates[`privateStreams/matches/${k}`] = null; });
  try { await update(ref(db), updates); const linked = done.filter(k => matches[k]?.hasLink); if (linked.length) { try { await deleteSecureLinks("matches", linked); } catch (_) {} } toast(`تم حذف ${done.length} مباراة منتهية.`, "success"); }
  catch (e) { toast(friendlyFirebaseError(e), "error"); }
}

/* ============ إدارة ومقارنة روابط البث المحمية (Private Streams & Comparison) ============ */
function renderPrivateStreams() {
  const search = privateStreamSearch.trim().toLowerCase();

  const channelEntries = Object.entries(channels)
    .filter(([, ch]) => `${ch.name || ""} ${categories[ch.categoryId]?.name || ""}`.toLowerCase().includes(search))
    .map(([id, ch]) => ({
      id,
      type: "channel",
      name: ch.name || "قناة بدون اسم",
      logo: ch.logo || "",
      category: categoryLabel(ch.categoryId),
      streamUrl: privateStreams?.channels?.[id]?.streamUrl || ch.url || "",
      isProtected: !!ch.hasLink,
      status: privateStreams?.channels?.[id]?.status || ((ch.url || ch.hasLink) ? "active" : "missing"),
      lastTestResult: privateStreams?.channels?.[id]?.lastTestResult || "لم يتم الاختبار بعد"
    }));

  const matchEntries = Object.entries(matches)
    .filter(([, m]) => `${m.home || ""} vs ${m.away || ""} ${m.league || ""}`.toLowerCase().includes(search))
    .map(([id, m]) => ({
      id,
      type: "match",
      name: `${m.home || "الفريق الأول"} vs ${m.away || "الفريق الثاني"}`,
      logo: m.homeLogo || "",
      category: m.league || "مباراة",
      streamUrl: privateStreams?.matches?.[id]?.streamUrl || m.channelUrl || "",
      isProtected: !!m.hasLink,
      status: privateStreams?.matches?.[id]?.status || ((m.channelUrl || m.hasLink) ? "active" : "missing"),
      lastTestResult: privateStreams?.matches?.[id]?.lastTestResult || "لم يتم الاختبار بعد"
    }));

  const allItems = [...channelEntries, ...matchEntries];

  const rows = allItems.map(item => {
    const hasStream = !!item.streamUrl || item.isProtected;
    const isPaused = item.status === "paused";
    const statusText = !hasStream ? "مفقود" : isPaused ? "متوقف مؤقتاً" : item.isProtected ? (item.streamUrl ? "🔒 مشفّر (+ نسخة نصية قديمة)" : "🔒 محمي ومشفّر") : "⚠ غير مشفّر";
    const statusClass = !hasStream ? "none" : isPaused ? "off" : item.isProtected && !item.streamUrl ? "locked" : "warn";
    const testResultColor = item.lastTestResult.includes("يعمل") ? "var(--ok)" : item.lastTestResult.includes("لا") ? "var(--danger)" : "var(--muted)";

    return `<tr>
      <td class="cell-main">${logoCell(item.logo, item.name)}<div><b>${esc(item.name)}</b><small class="cell-sub">${item.type === "channel" ? "قناة بث مباشر" : "مباراة رياضية"}</small></div></td>
      <td data-label="التصنيف">${esc(item.category)}</td>
      <td data-label="حالة الحماية"><span class="url-state ${statusClass}">${esc(statusText)}</span></td>
      <td data-label="نتيجة الفحص"><span style="color:${testResultColor}; font-weight:700; font-size:12px;">${esc(item.lastTestResult)}</span></td>
      <td class="cell-actions"><div class="action-btns"><button class="btn-sm btn-edit" data-edit-stream="${esc(item.type)}_${esc(item.id)}">${icon("edit")} مقارنة وإدارة</button></div></td>
    </tr>`;
  }).join("");

  $("tabContent").innerHTML = `
    <section class="panel-card">
      <div class="panel-header">
        <div>
          <span class="eyebrow">الحماية عبر Cloudflare</span>
          <h2>إدارة ومقارنة روابط البث المحمية <span class="title-count">${allItems.length}</span></h2>
          <p class="panel-subtitle">الروابط تُشفَّر بـ AES-256-GCM وتُحفظ في خادم الحماية (Cloudflare) وليس في Firebase. يطلبها التطبيق لحظة التشغيل فقط. اضغط «تأمين الروابط الحالية» ثم، بعد تحديث التطبيق، «حذف النسخ النصية».</p>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><span class="url-state locked">🔒 مؤمَّنة: ${allItems.filter(i => i.isProtected).length}</span><span class="url-state warn">⚠ نصوص قديمة: ${allItems.filter(i => i.streamUrl).length}</span></div>
        </div>
        <div class="header-tools">
          <button type="button" class="btn-secondary" id="migrateBtn">🔒 تأمين الروابط الحالية</button>
          <button type="button" class="btn-secondary danger-outline" id="purgeBtn">🧹 حذف النسخ النصية</button>
          <div class="search-wrap">${icon("search")}<input id="streamSearch" class="search-box" type="search" placeholder="ابحث عن قناة أو مباراة..." value="${esc(privateStreamSearch)}"></div>
        </div>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr><th>العنصر</th><th>التصنيف</th><th>حالة الحماية</th><th>آخر اختبار</th><th>الإجراءات</th></tr></thead>
          <tbody>${rows || emptyRow(5, "لا توجد عناصر مطابقة.")}</tbody>
        </table>
      </div>
    </section>
  `;

  $("migrateBtn").onclick = () => migrateAllLinks($("migrateBtn"));
  $("purgeBtn").onclick = () => purgePlainLinks($("purgeBtn"));
  $("streamSearch").addEventListener("input", e => {
    privateStreamSearch = e.target.value;
    const pos = e.target.selectionStart;
    renderPrivateStreams();
    const input = $("streamSearch"); input.focus(); input.setSelectionRange(pos, pos);
  });

  document.querySelectorAll("[data-edit-stream]").forEach(btn => {
    btn.onclick = () => {
      const v = btn.dataset.editStream, cut = v.indexOf("_"), type = v.slice(0, cut), id = v.slice(cut + 1);
      openStreamModal(type, id);
    };
  });
}

async function openStreamModal(type, id) {
  const isMatch = type === "match";
  const item = isMatch ? matches[id] : channels[id];
  if (!item) return;

  const currentStream = (isMatch ? privateStreams?.matches?.[id] : privateStreams?.channels?.[id]) || {};
  const currentUrl = currentStream.streamUrl || (isMatch ? (item.channelUrl || "") : (item.url || ""));
  const currentStatus = currentStream.status || "active";
  const updatedAt = currentStream.updatedAt ? new Date(currentStream.updatedAt).toLocaleString("ar") : "غير متوفر";
  const lastTestDate = currentStream.lastTestDate ? new Date(currentStream.lastTestDate).toLocaleString("ar") : "لم يتم الاختبار بعد";
  const lastTestResult = currentStream.lastTestResult || "غير معروف";
  const oldHash = currentStream.lastHash || "";
  const currentHash = currentUrl ? await sha256(currentUrl) : "";
  const linkChanged = oldHash && oldHash !== currentHash ? "تم تغيير الرابط" : "الرابط لم يتغير";
  const linkChangedColor = oldHash && oldHash !== currentHash ? "var(--danger)" : "var(--ok)";

  const itemName = isMatch ? `${item.home || ""} vs ${item.away || ""}` : (item.name || "");

  openModal(`مقارنة وإدارة الرابط المحمي: ${itemName}`, `<form id="streamForm"><div class="form-grid">
    <div class="form-group full">
      <label for="streamUrlInput">رابط البث الأصلي (🔒 يُشفَّر عند الحفظ)${item.hasLink ? " — محمي حالياً، اتركه فارغاً للإبقاء عليه" : " *"}</label>
      <input id="streamUrlInput" class="form-control" type="url" value="${esc(currentUrl)}" placeholder="${item.hasLink ? "الرابط الحالي مشفّر ومخفي. الصق رابطاً جديداً لاستبداله" : "https://..."}" ${item.hasLink ? "" : "required"} dir="ltr">
      <small class="field-hint">يُرسل إلى خادم الحماية ويُحفظ مشفّراً، ثم يُحذف أي نص قديم من Firebase.</small>
    </div>

    <div class="form-group full" style="padding:16px; background:#050b18; border-radius:14px; border:1px solid var(--line); font-size:13px; color:var(--muted); display:grid; gap:8px;">
      <div><b>📅 تاريخ آخر تعديل:</b> <span style="color:#fff;">${esc(updatedAt)}</span></div>
      <div><b>🔄 حالة الرابط:</b> <span style="color:${linkChangedColor}; font-weight:800;">${esc(linkChanged)}</span></div>
      <div><b>🔐 بصمة الهاش (SHA-256 Hash):</b> <code style="color:#93c5fd; font-family:monospace; background:rgba(255,255,255,.06); padding:2px 6px; border-radius:4px;">${esc(currentHash || "فارغ")}</code></div>
      <div><b>⏱️ تاريخ آخر اختبار:</b> <span style="color:#fff;">${esc(lastTestDate)}</span></div>
      <div><b>🔍 نتيجة الفحص السابق:</b> <span style="color:${lastTestResult.includes("يعمل") ? "var(--ok)" : "var(--danger)"}; font-weight:800;">${esc(lastTestResult)}</span></div>
    </div>

    <div class="form-group full">
      <label for="streamStatusSelect">حالة البث</label>
      <select id="streamStatusSelect" class="form-control">
        <option value="active" ${currentStatus !== "paused" ? "selected" : ""}>مفعل وآمن</option>
        <option value="paused" ${currentStatus === "paused" ? "selected" : ""}>إيقاف مؤقت للبث</option>
      </select>
    </div>
  </div>
  <div style="display:flex; gap:12px; margin-top:12px;">
    <button type="button" class="btn-secondary" id="testLinkBtn">اختبار استجابة الرابط الآن</button>
  </div>
  <div class="modal-footer"><button type="button" class="btn-secondary" id="cancelModal">إلغاء</button><button type="submit" class="btn-primary" id="saveStream">${icon("check")} حفظ وتحديث الرابط</button></div></form>`);

  $("cancelModal").onclick = closeModal;

  $("testLinkBtn").onclick = async () => {
    const testUrl = $("streamUrlInput").value.trim();
    if (!testUrl) { toast("أدخل الرابط أولاً لاختباره.", "error"); return; }
    toast("جارٍ فحص استجابة الرابط...", "info");
    let testResult = "الرابط لا يستجيب";
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(testUrl, { method: "HEAD", signal: controller.signal, mode: "no-cors" });
      clearTimeout(timeoutId);
      testResult = "الرابط يعمل ✓";
      toast("الرابط يعمل بنجاح ✓", "success");
    } catch (e) {
      testResult = "الرابط لا يستجيب ✗";
      toast("فشل الاتصال بالرابط", "error");
    }

    const newHash = await sha256(testUrl);
    await update(ref(db, `privateStreams/${type}s/${id}`), {
      lastTestDate: Date.now(),
      lastTestResult: testResult,
      lastHash: newHash
    });
    toast("تم تحديث نتيجة الاختبار وسجل البصمة.", "success");
    closeModal();
  };

  $("streamForm").onsubmit = async e => {
    e.preventDefault();
    const btn = $("saveStream");
    btn.disabled = true;
    try {
      const streamUrl = $("streamUrlInput").value.trim();
      const status = $("streamStatusSelect").value;
      if (!streamUrl && !item.hasLink) throw new Error("يرجى إدخال رابط البث.");
      const collection = `${type}s`;
      if (streamUrl) await saveSecureLink(collection, id, streamUrl);   // أولاً: إن فشل لا يتغير شيء
      const updates = {};
      if (streamUrl) {
        updates[`${collection}/${id}/hasLink`] = true;
        updates[`${collection}/${id}/${isMatch ? "channelUrl" : "url"}`] = null;
        updates[`privateStreams/${collection}/${id}/streamUrl`] = null;
      }
      updates[`privateStreams/${collection}/${id}/status`] = status;
      updates[`privateStreams/${collection}/${id}/updatedAt`] = Date.now();
      await update(ref(db), updates);
      if (item.hasLink || streamUrl) await workerCall("/api/admin/pause", { type: collection, id, paused: status === "paused" });

      toast("تم تشفير الرابط وحفظه في خادم الحماية ✓", "success");
      closeModal();
    } catch (error) {
      toast(error.message || friendlyFirebaseError(error), "error");
      btn.disabled = false;
    }
  };
}

/* ============ استيراد القنوات بالجملة (Bulk JSON Import) ============ */
/* ============ الاستيراد بالجملة: قنوات + مباريات ============ */
let importKind = "channels";

const MATCH_SAMPLE = [
  { home: "الرجاء", away: "الوداد", time: "21:00", date: "2026-11-14", league: "البطولة الاحترافية", status: "قادمة", channelName: "beIN SPORTS 1", commentator: "اسم المعلق", homeLogo: "https://example.com/home.png", awayLogo: "https://example.com/away.png", url: "https://example.com/match.m3u8" },
  { home: "ريال مدريد", away: "برشلونة", time: "22:00", league: "الليغا", status: "live", homeScore: 1, awayScore: 0, channelName: "beIN SPORTS 2" }
];
const CHANNEL_SAMPLE = [
  { name: "Bein Sports 1 HD", url: "https://example.com/live.m3u8", logo: "https://example.com/logo.png", quality: "HD", country: "MAROC" }
];

function renderImport() {
  const isMatches = importKind === "matches";
  const categoryOptions = categoryTreeEntries().map(([id, item, depth]) => {
    const parent = item.parentId && categories[item.parentId];
    const label = parent ? `${parent.name || "قسم"} / ${item.name || ""}` : (item.name || "قسم رئيسي");
    return `<option value="${esc(id)}">${"— ".repeat(Math.min(depth, 3))}${esc(label)}</option>`;
  }).join("");
  const sample = JSON.stringify(isMatches ? MATCH_SAMPLE : CHANNEL_SAMPLE, null, 2);

  $("tabContent").innerHTML = `
    <section class="panel-card">
      <div class="panel-header">
        <div>
          <span class="eyebrow">أدوات متقدمة</span>
          <h2>${isMatches ? "استيراد المباريات بالجملة" : "استيراد القنوات بالجملة"} (JSON)</h2>
          <p class="panel-subtitle">${isMatches ? "الصق جدول المباريات أو حمّل ملفاً. إن طابق channelName اسم قناة موجودة تُربط بها تلقائياً." : "الصق كود JSON أو حمّل ملفاً لإضافة مئات القنوات دفعة واحدة داخل القسم المختار."}</p>
        </div>
      </div>

      <div class="seg import-seg" role="tablist">
        <button type="button" data-kind="channels" class="${!isMatches ? "on upcoming" : ""}">${icon("tv")} استيراد القنوات</button>
        <button type="button" data-kind="matches" class="${isMatches ? "on upcoming" : ""}">${icon("ball")} استيراد المباريات</button>
      </div>

      <div class="form-grid" style="grid-template-columns: 1fr;">
        ${isMatches ? "" : `<div class="form-group">
          <label for="importCategory">القسم المستهدف *</label>
          <select id="importCategory" class="form-control"><option value="">اختر القسم أو التصنيف الفرعي</option>${categoryOptions}</select>
          <small class="field-hint">سيتم ربط جميع القنوات المستوردة بهذا القسم.</small>
        </div>`}
        <div class="form-group">
          <label for="jsonFileSelect">رفع ملف JSON من الجهاز</label>
          <input type="file" id="jsonFileSelect" class="form-control" accept=".json,application/json">
        </div>
        <div class="form-group">
          <label for="jsonInput">محتوى JSON (أو الصق الكود هنا)</label>
          <textarea id="jsonInput" class="form-control" rows="10" dir="ltr" placeholder="${esc(sample)}"></textarea>
          ${isMatches ? `<small class="field-hint">الضروري فقط: home و away. الحالة تقبل: قادمة / مباشرة / انتهت أو upcoming / live / finished. الحقول الاختيارية: time, date, league, channelName, channelId, commentator, homeLogo, awayLogo, homeScore, awayScore, url.</small>` : ""}
        </div>
        <label class="check-row"><input type="checkbox" id="skipDuplicates" checked><span>${isMatches ? "منع تكرار المباريات (نفس الفريقين والتوقيت والبطولة)" : "منع إضافة القنوات المكررة (نفس رابط البث)"}</span></label>
        ${isMatches ? `<label class="check-row danger"><input type="checkbox" id="replaceAll"><span>استبدال الجدول كاملاً (يحذف كل المباريات الحالية أولاً بعد التأكيد)</span></label>` : ""}
      </div>

      <div class="import-actions">
        <button type="button" class="btn-secondary" id="previewBtn">${isMatches ? "معاينة المباريات" : "معاينة القنوات"}</button>
        <button type="button" class="btn-primary" id="startImportBtn">${icon("upload")} بدء الاستيراد</button>
        <button type="button" class="btn-secondary" id="sampleBtn">تحميل نموذج JSON</button>
      </div>
      <div id="importResultArea" style="margin-top:24px;"></div>
    </section>`;

  document.querySelectorAll("[data-kind]").forEach(b => b.onclick = () => { importKind = b.dataset.kind; renderImport(); });
  $("jsonFileSelect").onchange = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = event => { $("jsonInput").value = event.target.result; toast("تم تحميل ملف JSON بنجاح.", "success"); };
    reader.onerror = () => toast("تعذرت قراءة الملف.", "error");
    reader.readAsText(file);
  };
  $("previewBtn").onclick = () => (isMatches ? previewMatchesData() : previewJsonData());
  $("startImportBtn").onclick = () => (isMatches ? executeMatchesImport() : executeBulkImport());
  $("sampleBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(isMatches ? MATCH_SAMPLE : CHANNEL_SAMPLE, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = isMatches ? "matches-sample.json" : "channels-sample.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

/* ---- منطق استيراد المباريات ---- */
const pick = (item, keys) => {
  for (const k of keys) {
    const v = item?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
};
const numOrNull = v => (v === "" || v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));
const matchDupKey = m => [m.home, m.away, m.time, m.league, m.date].map(x => String(x || "").trim().toLowerCase()).join("|");

function normalizeMatch(item) {
  return {
    home: pick(item, ["home", "homeTeam", "team1"]),
    away: pick(item, ["away", "awayTeam", "team2"]),
    time: pick(item, ["time", "kickoff"]),
    date: pick(item, ["date", "day"]),
    league: pick(item, ["league", "competition", "tournament"]),
    commentator: pick(item, ["commentator", "commentary"]),
    homeLogo: pick(item, ["homeLogo", "logo1"]),
    awayLogo: pick(item, ["awayLogo", "logo2"]),
    status: normStatus(pick(item, ["status", "state"])),
    channelName: pick(item, ["channelName", "channel"]),
    channelId: pick(item, ["channelId"]),
    url: pick(item, ["url", "stream", "streamUrl", "channelUrl"]),
    homeScore: numOrNull(pick(item, ["homeScore", "score1"])),
    awayScore: numOrNull(pick(item, ["awayScore", "score2"]))
  };
}
function findChannelFor(m) {
  if (m.channelId && channels[m.channelId]) return [m.channelId, channels[m.channelId]];
  const n = m.channelName.trim().toLowerCase();
  return n ? Object.entries(channels).find(([, c]) => String(c.name || "").trim().toLowerCase() === n) || null : null;
}

function previewMatchesData() {
  try {
    const items = parseJsonInput().map(normalizeMatch);
    let valid = 0, invalid = 0, linked = 0;
    const rows = items.map((m, idx) => {
      const ok = m.home && m.away;
      ok ? valid++ : invalid++;
      const ch = findChannelFor(m);
      if (ch) linked++;
      return `<tr>
        <td>${idx + 1}</td>
        <td class="cell-main"><b>${esc(m.home || "؟")}</b> <span style="color:var(--gold)">×</span> <b>${esc(m.away || "؟")}</b><small class="cell-sub">${esc([m.league, m.date, m.time].filter(Boolean).join(" • "))}</small></td>
        <td><span class="status-pill ${matchStatusClass(m.status)}">${esc(m.status)}</span></td>
        <td>${ch ? `<span class="url-state locked">${esc(ch[1].name)}</span>` : m.channelName ? `<span class="url-state warn">غير موجودة: ${esc(m.channelName)}</span>` : `<span class="url-state none">بدون قناة</span>`}</td>
        <td><span class="status-pill ${ok ? "on" : "off"}">${ok ? "جاهزة" : "بيانات ناقصة"}</span></td>
      </tr>`;
    }).join("");
    $("importResultArea").innerHTML = `
      <div class="import-stats"><span class="count-pill">الإجمالي: <b>${items.length}</b></span><span class="status-pill on">جاهزة: <b>${valid}</b></span><span class="url-state locked">مربوطة بقناة: <b>${linked}</b></span>${invalid ? `<span class="status-pill off">ناقصة (home و away): <b>${invalid}</b></span>` : ""}</div>
      <div class="table-responsive"><table class="data-table"><thead><tr><th>#</th><th>المباراة</th><th>الحالة</th><th>القناة</th><th>التحقق</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (error) {
    $("importResultArea").innerHTML = `<div class="import-error">${esc(error.message)}</div>`;
  }
}

async function executeMatchesImport() {
  const button = $("startImportBtn");
  try {
    const items = parseJsonInput().map(normalizeMatch);
    const skipDuplicates = $("skipDuplicates").checked;
    const replaceAll = $("replaceAll")?.checked;
    const updates = {};
    const pendingLinks = [];
    let replacedIds = [];
    let sort = 0, success = 0, duplicates = 0, failed = 0, linked = 0;

    if (replaceAll) {
      if (!(await confirmDialog("استبدال الجدول كاملاً", `سيتم حذف ${Object.keys(matches).length} مباراة حالية نهائياً ثم استيراد الجدول الجديد. متابعة؟`))) return;
      replacedIds = Object.keys(matches).filter(k => matches[k].hasLink);
      Object.keys(matches).forEach(k => { updates[`matches/${k}`] = null; updates[`privateStreams/matches/${k}`] = null; });
    } else {
      sort = Math.max(0, ...Object.values(matches).map(x => Number(x?.sort) || 0));
    }
    const seen = new Set(replaceAll ? [] : Object.values(matches).map(matchDupKey));

    items.forEach(m => {
      if (!m.home || !m.away) { failed++; return; }
      const dk = matchDupKey(m);
      if (skipDuplicates && seen.has(dk)) { duplicates++; return; }
      seen.add(dk);
      const key = push(ref(db, "matches")).key;
      const ch = findChannelFor(m);
      if (ch) linked++;
      const payload = {
        home: m.home, away: m.away, homeLogo: m.homeLogo, awayLogo: m.awayLogo,
        time: m.time, date: m.date, league: m.league,
        channelId: ch ? ch[0] : "", channelName: ch ? (ch[1].name || m.channelName) : m.channelName,
        channelUrl: "", commentator: m.commentator, status: m.status, sort: ++sort
      };
      if (m.homeScore !== null) payload.homeScore = m.homeScore;
      if (m.awayScore !== null) payload.awayScore = m.awayScore;
      updates[`matches/${key}`] = payload;
      if (m.url) { payload.hasLink = true; pendingLinks.push({ type: "matches", id: key, url: m.url }); }
      success++;
    });

    if (!success) { toast(`لم تُستورد أي مباراة. مكررة: ${duplicates}، ناقصة: ${failed}`, "error"); return; }
    button.disabled = true;
    if (pendingLinks.length) await saveLinks(pendingLinks, (d, t) => { button.textContent = `جارٍ تأمين الروابط ${d}/${t}`; });
    button.textContent = "جارٍ الحفظ في Firebase...";
    await update(ref(db), updates);
    if (replacedIds.length) { try { await deleteSecureLinks("matches", replacedIds); } catch (_) {} }
    toast(`تم استيراد ${success} مباراة بنجاح ✓`, "success");
    $("importResultArea").innerHTML = `<div class="import-ok">✅ تم استيراد المباريات بنجاح<br><small>أُضيفت ${success} مباراة • مربوطة بقناة: ${linked}${duplicates ? ` • تخطي ${duplicates} مكررة` : ""}${failed ? ` • ناقصة ${failed}` : ""}</small></div>`;
  } catch (error) {
    console.error("Matches import failed:", error);
    toast(error.message || friendlyFirebaseError(error), "error");
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("upload")} بدء الاستيراد`;
  }
}

function parseJsonInput() {
  const raw = $("jsonInput").value.trim();
  if (!raw) throw new Error("يرجى إدخال محتوى JSON أو تحميل ملف.");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`خطأ في صياغة JSON (JSON Syntax Error): ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    if (typeof parsed === "object" && parsed !== null) {
      const values = Object.values(parsed);
      if (values.length && values.every(v => typeof v === "object" && v !== null)) {
        parsed = values;
      } else {
        throw new Error("يجب أن يكون ملف JSON مصفوفة (Array) من كائنات القنوات [...]");
      }
    } else {
      throw new Error("تنسيق JSON غير صالح.");
    }
  }
  return parsed;
}

function previewJsonData() {
  try {
    const items = parseJsonInput();
    const categoryId = $("importCategory").value;
    const catName = categoryLabel(categoryId) || "لم يتم تحديد قسم";

    let validCount = 0;
    let invalidCount = 0;

    const rows = items.map((item, idx) => {
      const name = String(item.name || item.title || "").trim();
      const url = String(item.url || item.stream || "").trim();
      const logo = String(item.logo || item.image || "").trim();
      const quality = String(item.quality || "HD").trim();
      const country = String(item.country || "").trim();
      const isValid = name && url;
      if (isValid) validCount++; else invalidCount++;

      return `<tr>
        <td>${idx + 1}</td>
        <td class="cell-main">${logoCell(logo, name)}<b>${esc(name || "بدون اسم")}</b></td>
        <td><span class="url-state ${url ? "" : "none"}">${url ? "رابط صالح" : "رابط مفقود"}</span></td>
        <td><span class="category-pill">${esc(catName)}${country ? ` / ${esc(country)}` : ""}</span></td>
        <td><span class="status-pill ${isValid ? "on" : "off"}">${isValid ? "جاهز للاستيراد" : "بيانات ناقصة"}</span></td>
      </tr>`;
    }).join("");

    $("importResultArea").innerHTML = `
      <div style="margin-bottom:14px; display:flex; gap:12px; flex-wrap:wrap;">
        <span class="count-pill">إجمالي العناصر: <b>${items.length}</b></span>
        <span class="status-pill on">صالحة: <b>${validCount}</b></span>
        ${invalidCount ? `<span class="status-pill off">غير صالحة (تتطلب اسم ورابط): <b>${invalidCount}</b></span>` : ""}
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr><th>#</th><th>القناة</th><th>الحالة</th><th>القسم المستهدف</th><th>التحقق</th></tr></thead>
          <tbody>${rows || emptyRow(5, "لا توجد بيانات للمعاينة.")}</tbody>
        </table>
      </div>
    `;
    toast(`تم التحقق: ${validCount} قناة جاهزة للاستيراد.`, "success");
  } catch (error) {
    $("importResultArea").innerHTML = `<div style="padding:16px; background:var(--danger-soft); color:var(--danger); border-radius:12px; font-weight:700;">${esc(error.message)}</div>`;
    toast(error.message, "error");
  }
}

async function executeBulkImport() {
  const categoryId = $("importCategory").value;
  if (!categoryId) {
    toast("يرجى اختيار القسم المستهدف أولاً.", "error");
    $("importCategory").focus();
    return;
  }
  if (!categories[categoryId]) {
    toast("القسم المستهدف غير موجود.", "error");
    return;
  }

  try {
    const items = parseJsonInput();
    const skipDuplicates = $("skipDuplicates").checked;
    const existingUrls = new Set([...Object.values(channels).map(c => normUrl(c.url)), ...Object.values(privateStreams?.channels || {}).map(c => normUrl(c.streamUrl))]);

    let successCount = 0;
    let duplicateCount = 0;
    let failCount = 0;

    const updates = {};
    const pendingLinks = [];
    const channelsRef = ref(db, "channels");

    items.forEach(item => {
      const name = String(item.name || item.title || "").trim();
      const url = String(item.url || item.stream || "").trim();
      if (!name || !url) {
        failCount++;
        return;
      }
      const normalizedUrl = normUrl(url);
      if (skipDuplicates && existingUrls.has(normalizedUrl)) {
        duplicateCount++;
        return;
      }

      const newKey = push(channelsRef).key;
      const country = String(item.country || "").trim().toUpperCase();
      updates[`channels/${newKey}`] = {
        name,
        logo: String(item.logo || item.image || "").trim(),
        quality: String(item.quality || "HD").trim(),
        description: String(item.description || item.desc || "").trim(),
        status: String(item.status || "active").trim(),
        categoryId,
        country,
        hasLink: true
      };
      pendingLinks.push({ type: "channels", id: newKey, url });
      existingUrls.add(normalizedUrl);
      successCount++;
    });

    if (successCount === 0) {
      toast(`لم يتم استيراد أي قناة. مكررة: ${duplicateCount}، فاشلة: ${failCount}`, "error");
      return;
    }

    const button = $("startImportBtn");
    button.disabled = true;
    if (pendingLinks.length) await saveLinks(pendingLinks, (d, t) => { button.textContent = `جارٍ تأمين الروابط ${d}/${t}`; });
    button.textContent = "جارٍ الحفظ في Firebase...";

    await update(ref(db), updates);

    toast(`تم استيراد ${successCount} قناة بنجاح! ${duplicateCount ? `(تم تخطي ${duplicateCount} مكررة)` : ""}`, "success");
    $("importResultArea").innerHTML = `
      <div style="padding:22px; background:var(--ok-soft); color:var(--ok); border-radius:16px; text-align:center; font-weight:800; font-size:16px;">
        ✅ تمت عملية الاستيراد بنجاح في Firebase!<br>
        <span style="font-size:13.5px; font-weight:600; color:var(--ink);">تمت إضافة ${successCount} قناة${duplicateCount ? ` • تم تخطي ${duplicateCount} مكررة` : ""}${failCount ? ` • فشلت ${failCount}` : ""}</span>
      </div>
    `;
    button.disabled = false;
    button.textContent = `${icon("upload")} بدء الاستيراد لـ Firebase`;
  } catch (error) {
    console.error("Bulk import failed:", error);
    toast(error.message || friendlyFirebaseError(error), "error");
    $("startImportBtn").disabled = false;
    $("startImportBtn").textContent = "بدء الاستيراد لـ Firebase";
  }
}

function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="empty-state">${icon("layers")}${esc(message)}</td></tr>`; }
function actionButtons(type, key) { return `<div class="action-btns"><button class="btn-sm btn-edit" data-edit-${type}="${esc(key)}">${icon("edit")} تعديل</button><button class="btn-sm btn-del" data-del-${type}="${esc(key)}">${icon("trash")} حذف</button></div>`; }

function bindDelete(type, path, label) {
  document.querySelectorAll(`[data-del-${type}]`).forEach(button => button.onclick = async () => {
    const id = button.dataset[`del${type[0].toUpperCase()}${type.slice(1)}`];
    if (!(await confirmDialog(`حذف ${label}`, `هل أنت متأكد من حذف ${label}؟ لا يمكن التراجع عن هذا الإجراء.`))) return;
    button.disabled = true;
    try {
      const hadLink = (path === "channels" || path === "matches") && !!(path === "channels" ? channels : matches)[id]?.hasLink;
      await remove(ref(db, `${path}/${id}`));
      if (path === "channels" || path === "matches") { try { await remove(ref(db, `privateStreams/${path}/${id}`)); } catch (_) {} }
      if (hadLink) { try { await deleteSecureLinks(path, [id]); } catch (_) {} }
      toast(`تم حذف ${label} بنجاح.`, "success");
    }
    catch (error) { toast(`تعذر الحذف: ${friendlyFirebaseError(error)}`, "error"); button.disabled = false; }
  });
}

function logoCell(url, name) {
  const initials = esc(getInitials(name));
  return `<div class="table-logo">${url ? `<img src="${esc(url)}" alt="${esc(name || "الشعار")}" loading="lazy">` : ""}<span class="logo-fallback" ${url ? "hidden" : ""}>${initials}</span></div>`;
}
function bindLogoFallback() {
  document.querySelectorAll(".table-logo img").forEach(image => {
    const showFallback = () => {
      image.hidden = true;
      const fallback = image.parentElement.querySelector(".logo-fallback");
      if (fallback) fallback.hidden = false;
    };
    if (image.complete && image.naturalWidth === 0) showFallback();
    else image.addEventListener("error", showFallback, { once: true });
  });
}
function getInitials(value) {
  const words = String(value || "TV").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "TV";
  return words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...words[0]].slice(0, 2).join("");
}

/* ============ النوافذ ============ */
function openModal(title, content, { small = false } = {}) {
  $("modalOverlay").hidden = false;
  $("modalContainer").className = `modal-card${small ? " small" : ""}`;
  $("modalContainer").innerHTML = `<div class="modal-header"><div><span class="eyebrow">RAYA TV PRO</span><h3 id="modalTitle">${title}</h3></div><button type="button" class="close-btn" id="closeModal" aria-label="إغلاق">${icon("close")}</button></div>${content}`;
  $("closeModal").onclick = closeModal;
  $("modalOverlay").onclick = event => { if (event.target === $("modalOverlay")) closeModal(); };
  document.body.style.overflow = "hidden";
}
document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("modalOverlay").hidden) closeModal(); });
function closeModal() {
  $("modalOverlay").hidden = true;
  $("modalContainer").innerHTML = "";
  document.body.style.overflow = "";
}

function confirmDialog(title, message) {
  return new Promise(resolve => {
    $("modalOverlay").hidden = false;
    $("modalContainer").className = "modal-card small confirm-card";
    $("modalContainer").innerHTML = `<div class="confirm-icon">${icon("trash")}</div><h3 id="modalTitle">${esc(title)}</h3><p class="confirm-body">${esc(message)}</p><div class="modal-footer"><button type="button" class="btn-secondary" id="confirmNo">إلغاء</button><button type="button" class="btn-danger" id="confirmYes">نعم، احذف</button></div>`;
    document.body.style.overflow = "hidden";
    const done = value => { closeModal(); resolve(value); };
    $("confirmNo").onclick = () => done(false);
    $("confirmYes").onclick = () => done(true);
    $("modalOverlay").onclick = event => { if (event.target === $("modalOverlay")) done(false); };
    $("confirmNo").focus();
  });
}

/* ---- اختيار عدة أقسام ---- */
function categoryChips({ checked = new Set(), locked = new Set(), exclude = null } = {}) {
  const list = categoryTreeEntries();
  if (!list.length) return `<p class="multi-empty">لا توجد أقسام. أضف قسماً أولاً من صفحة «الأقسام».</p>`;
  return `<div class="cat-chips">${list.map(([id, category, depth]) => {
    const isLocked = locked.has(id);
    const isChecked = isLocked || checked.has(id);
    const parent = category.parentId && categories[category.parentId];
    const label = parent ? `${parent.name || "قسم"} / ${category.name || "قسم فرعي"}` : (category.name || "قسم بدون اسم");
    return `<label class="cat-opt ${isLocked ? "locked" : ""} ${depth ? "nested-cat-opt" : ""}" data-cat="${esc(id)}" ${exclude === id ? "hidden" : ""} style="--cat-depth:${Math.min(depth,3)}"><input type="checkbox" value="${esc(id)}" ${isChecked ? "checked" : ""} ${isLocked ? "disabled" : ""}><span class="tick">${icon("check")}</span><span>${esc(label)}</span>${isLocked ? "<em>موجودة</em>" : ""}</label>`;
  }).join("")}</div>`;
}
function selectedCategoryIds(root) {
  return [...root.querySelectorAll(".cat-opt:not([hidden]) input:checked:not(:disabled)")].map(input => input.value);
}
function bindChipControls(root, onChange = () => {}) {
  root.addEventListener("change", onChange);
  const all = root.querySelector("[data-select-all]");
  if (all) all.onclick = () => {
    const boxes = [...root.querySelectorAll(".cat-opt:not([hidden]) input:not(:disabled)")];
    const everyChecked = boxes.every(box => box.checked);
    boxes.forEach(box => { box.checked = !everyChecked; });
    all.textContent = everyChecked ? "تحديد الكل" : "إلغاء التحديد";
    onChange();
  };
}

/* ---- الأقسام ---- */
function openCategoryModal(key = null, data = {}) {
  const parentOptions = categoryTreeEntries()
    .filter(([id]) => id !== key && !isDescendantCategory(id, key))
    .map(([id, item, depth]) => `<option value="${esc(id)}" ${data.parentId === id ? "selected" : ""}>${"— ".repeat(Math.min(depth,3))}${esc(item.name || "قسم بدون اسم")}</option>`).join("");
  openModal(key ? "تعديل القسم" : "إضافة قسم جديد", `<form id="catForm"><div class="form-grid">
    <div class="form-group full"><label for="catName">اسم القسم أو التصنيف *</label><input id="catName" class="form-control" value="${esc(data.name || "")}" required placeholder="مثال: beIN SPORTS HD"></div>
    <div class="form-group full"><label for="catParent">القسم الرئيسي (اختياري)</label><select id="catParent" class="form-control"><option value="">بدون قسم رئيسي — إنشاء قسم رئيسي</option>${parentOptions}</select><small class="field-hint">اختر «الرياضة» مثلاً ليصبح هذا القسم تصنيفاً فرعياً بداخلها.</small></div>
    <div class="form-group"><label for="catSort">ترتيب الظهور</label><input id="catSort" type="number" class="form-control" value="${Number(data.sort || 0)}"></div>
    <div class="form-group full"><label>شعار القسم</label><div id="uploadContainerCat"></div></div>
    </div><div class="modal-footer"><button type="button" class="btn-secondary" id="cancelModal">إلغاء</button><button type="submit" class="btn-primary" id="saveCat">حفظ القسم</button></div></form>`);
  const upload = createUploadWidget("catLogo", data.logo || ""); $("uploadContainerCat").append(upload);
  $("cancelModal").onclick = closeModal;
  $("catForm").onsubmit = async event => {
    event.preventDefault(); const button = $("saveCat"); button.disabled = true;
    try {
      const parentId = $("catParent").value || "";
      if (key && parentId === key) throw new Error("لا يمكن جعل القسم تابعاً لنفسه.");
      const payload = { name: $("catName").value.trim(), sort: Number($("catSort").value) || 0, logo: upload.getValue(), parentId };
      if (!payload.name) throw new Error("يرجى إدخال اسم القسم.");
      if (upload.isUploading()) throw new Error("انتظر حتى تنتهي معالجة الشعار.");
      if (key) await update(ref(db, `categories/${key}`), payload); else await push(ref(db, "categories"), payload);
      toast("تم حفظ القسم بنجاح.", "success"); closeModal();
    } catch (error) { toast(error.message || friendlyFirebaseError(error), "error"); button.disabled = false; }
  };
}
function isDescendantCategory(candidateId, ancestorId) {
  if (!ancestorId) return false;
  let current = categories[candidateId], seen = new Set();
  while (current?.parentId && !seen.has(current.parentId)) {
    if (current.parentId === ancestorId) return true;
    seen.add(current.parentId); current = categories[current.parentId];
  }
  return false;
}

/* ---- القنوات (مع الإضافة لعدة أقسام) ---- */
function openChannelModal(key = null, data = {}) {
  const editing = !!key;
  const currentStreamUrl = privateStreams?.channels?.[key]?.streamUrl || data.url || "";
  const storedCategory = categories[data.categoryId];
  const legacyChild = storedCategory?.parentId ? storedCategory : null;
  const initialParentId = legacyChild ? storedCategory.parentId : (data.categoryId || "");
  const initialCountry = String(data.country || (legacyChild ? storedCategory.name : ""));
  const rootCategories = sortedCategories().filter(([, category]) => !category.parentId);
  const categoryOptions = rootCategories.map(([id, category]) =>
    `<option value="${esc(id)}" ${initialParentId === id ? "selected" : ""}>${esc(category.name || "قسم بدون اسم")}</option>`
  ).join("");

  openModal(editing ? "تعديل القناة" : "إضافة قناة جديدة", `<form id="chanForm"><div class="form-grid">
    <div class="form-group full"><label for="chanName">اسم القناة *</label><input id="chanName" class="form-control" value="${esc(data.name || "")}" required placeholder="مثال: Arryadia"></div>
    <div class="form-group full"><label for="chanCategory">القسم الرئيسي *</label><select id="chanCategory" class="form-control" required><option value="">اختر القسم الرئيسي</option>${categoryOptions}</select></div>
    <div class="form-group full"><label for="chanCountry">الدولة أو القسم الفرعي داخل التطبيق</label><input id="chanCountry" class="form-control" value="${esc(initialCountry)}" placeholder="MAROC أو ALGERIA أو EGYPTE"><small class="field-hint">اكتب MAROC مثلاً لتظهر بطاقة المغرب داخل ARABIC CHANNELS.</small></div>
    <div class="form-group full"><label for="chanUrl">رابط البث الأصلي المحمي (خاص للمشرف 🔒)</label><input id="chanUrl" class="form-control" type="url" value="${esc(currentStreamUrl)}" placeholder="${data.hasLink ? "🔒 محمي ومشفّر — اتركه فارغاً للإبقاء عليه أو الصق رابطاً جديداً" : "https://example.com/live.m3u8"}" dir="ltr"><small class="field-hint">يُشفَّر ويُحفظ في خادم الحماية (Cloudflare) ولا يظهر في Firebase.</small></div>
    <div class="form-group"><label for="chanStatus">حالة القناة</label><select id="chanStatus" class="form-control"><option value="active" ${data.status !== "disabled" ? "selected" : ""}>مفعلة</option><option value="disabled" ${data.status === "disabled" ? "selected" : ""}>معطلة</option></select></div>
    <div class="form-group"><label for="chanQuality">الجودة</label><input id="chanQuality" class="form-control" value="${esc(data.quality || "HD")}" placeholder="HD / 4K / SD"></div>
    <div class="form-group full"><label for="chanDesc">وصف القناة</label><textarea id="chanDesc" class="form-control" rows="3">${esc(data.description || "")}</textarea></div>
    <div class="form-group full"><label>شعار القناة</label><div id="uploadContainerChan"></div></div>
    </div><div class="modal-footer"><button type="button" class="btn-secondary" id="cancelModal">إلغاء</button><button type="submit" class="btn-primary" id="saveChan">${editing ? "حفظ التعديلات" : "حفظ القناة"}</button></div></form>`);

  const upload = createUploadWidget("chanLogo", data.logo || "");
  $("uploadContainerChan").append(upload);
  $("cancelModal").onclick = closeModal;

  $("chanForm").onsubmit = async event => {
    event.preventDefault();
    const button = $("saveChan");
    button.disabled = true;
    button.textContent = "جارٍ الحفظ...";
    try {
      const name = $("chanName").value.trim();
      const categoryId = $("chanCategory").value;
      const country = $("chanCountry").value.trim().replace(/\s+/g, " ").toUpperCase();
      const url = $("chanUrl").value.trim();
      if (!name || !categoryId) throw new Error("يرجى إدخال اسم القناة واختيار القسم الرئيسي.");
      if (!categories[categoryId]) throw new Error("القسم الرئيسي غير موجود. حدّث الصفحة ثم حاول مجدداً.");
      if (categories[categoryId].parentId) throw new Error("اختر قسماً رئيسياً، وليس تصنيفاً فرعياً.");
      if (upload.isUploading()) throw new Error("انتظر حتى تنتهي معالجة الشعار.");

      const payload = {
        name,
        url,
        status: $("chanStatus").value,
        quality: $("chanQuality").value.trim() || "HD",
        description: $("chanDesc").value.trim(),
        logo: upload.getValue(),
        categoryId,
        country
      };

      const channelKey = key || push(ref(db, "channels")).key;
      const publicPayload = {
        name,
        status: $("chanStatus").value,
        quality: $("chanQuality").value.trim() || "HD",
        description: $("chanDesc").value.trim(),
        logo: upload.getValue(),
        categoryId,
        country,
        updatedAt: Date.now()
      };

      if (url) await saveSecureLink("channels", channelKey, url);   // أولاً: إن فشل لا يُحفظ شيء
      await update(ref(db, `channels/${channelKey}`), { ...publicPayload, ...(url ? { hasLink: true } : {}) });

      if (url) {
        await update(ref(db, `privateStreams/channels/${channelKey}`), { streamUrl: null, status: "active", updatedAt: Date.now() });
        // مسح أي رابط قديم مكشوف في المجموعة العامة لضمان السرية
        await update(ref(db, `channels/${channelKey}`), { url: null, channelUrl: null });
      }

      toast(editing ? "تم حفظ تعديلات القناة بنجاح." : `تمت إضافة القناة بنجاح${country ? ` داخل ${country}` : ""}.`, "success");
      closeModal();
    } catch (error) {
      console.error("Save channel failed:", error);
      toast(error.message || friendlyFirebaseError(error), "error");
      button.disabled = false;
      button.textContent = editing ? "حفظ التعديلات" : "حفظ القناة";
    }
  };
}

function openCopyModal(key) {
  const channel = channels[key];
  if (!channel) return;
  const url = normUrl(channel.url);
  const locked = new Set([channel.categoryId]);
  Object.entries(channels).forEach(([otherKey, other]) => { if (otherKey !== key && url && normUrl(other.url) === url) locked.add(other.categoryId); });

  openModal("إضافة القناة إلى أقسام أخرى", `<form id="copyForm">
    <div class="team-cell" style="margin-bottom:16px">${logoCell(channel.logo, channel.name)}<div><b>${esc(channel.name || "")}</b><small class="cell-sub">موجودة حالياً في: ${esc(categoryLabel(channel.categoryId))}</small></div></div>
    <div class="multi-box" id="multiBox"><div class="multi-top"><b>اختر الأقسام <span class="selected-count" id="selCount">0</span></b><button type="button" class="link-btn" data-select-all>تحديد الكل</button></div>
    ${categoryChips({ locked })}<p class="multi-hint">ستُنشأ نسخة من القناة (بنفس الرابط والشعار) في كل قسم تحدده.</p></div>
    <div class="modal-footer"><button type="button" class="btn-secondary" id="cancelModal">إلغاء</button><button type="submit" class="btn-primary" id="saveCopy">إضافة للأقسام المحددة</button></div></form>`);
  bindLogoFallback();
  const multiBox = $("multiBox");
  const refreshCount = () => { $("selCount").textContent = selectedCategoryIds(multiBox).length; };
  bindChipControls(multiBox, refreshCount);
  $("cancelModal").onclick = closeModal;
  $("copyForm").onsubmit = async event => {
    event.preventDefault(); const button = $("saveCopy"); button.disabled = true;
    try {
      const picked = selectedCategoryIds(multiBox);
      if (!picked.length) throw new Error("اختر قسماً واحداً على الأقل.");
      const { ...copyBase } = channel;
      const updates = {};
      const newIds = picked.map(categoryId => { const nk = push(ref(db, "channels")).key; updates[`channels/${nk}`] = { ...copyBase, categoryId }; return nk; });
      if (channel.hasLink) await workerCall("/api/admin/copy", { type: "channels", from: key, to: newIds });
      await update(ref(db), updates);
      toast(`تمت إضافة القناة إلى ${picked.length} ${picked.length === 1 ? "قسم" : "أقسام"}.`, "success"); closeModal();
    } catch (error) { toast(error.message || friendlyFirebaseError(error), "error"); button.disabled = false; }
  };
}

/* ---- المباريات ---- */
function openMatchModal(key = null, data = {}) {
  const currentMatchUrl = (key && privateStreams?.matches?.[key]?.streamUrl) || data.channelUrl || "";
  const channelOptions = Object.entries(channels).map(([id, channel]) => `<option value="${esc(id)}" ${data.channelId === id || (!data.channelId && data.channelName === channel.name) ? "selected" : ""}>${esc(channel.name || "قناة")}${channel.categoryId && categories[channel.categoryId] ? " — " + esc(categoryLabel(channel.categoryId)) : ""}</option>`).join("");
  openModal(key ? "تعديل المباراة" : "إضافة مباراة جديدة", `<form id="matchForm"><div class="form-grid">
    <div class="form-group"><label for="matchHome">الفريق الأول *</label><input id="matchHome" class="form-control" value="${esc(data.home || "")}" required></div>
    <div class="form-group"><label for="matchAway">الفريق الثاني *</label><input id="matchAway" class="form-control" value="${esc(data.away || "")}" required></div>
    <div class="form-group"><label>شعار الفريق الأول</label><div id="uploadContainerHome"></div></div>
    <div class="form-group"><label>شعار الفريق الثاني</label><div id="uploadContainerAway"></div></div>
    <div class="form-group"><label for="matchTime">توقيت المباراة *</label><input id="matchTime" class="form-control" value="${esc(data.time || "")}" placeholder="21:00" required></div>
    <div class="form-group"><label for="matchLeague">البطولة *</label><input id="matchLeague" class="form-control" value="${esc(data.league || "")}" placeholder="اسم البطولة" required></div>
    <div class="form-group"><label for="matchChannelSelect">القناة الناقلة</label><select id="matchChannelSelect" class="form-control"><option value="">اختر القناة</option>${channelOptions}</select></div>
    <div class="form-group"><label for="matchChannelUrl">رابط بث المباراة الأصلي (🔒 يُشفَّر عند الحفظ${data.hasLink ? " — محمي حالياً، اتركه فارغاً للإبقاء عليه" : ""})</label><input id="matchChannelUrl" class="form-control" value="${esc(currentMatchUrl)}" dir="ltr" placeholder="https://..."></div>
    <div class="form-group"><label for="matchCommentator">اسم المعلق</label><input id="matchCommentator" class="form-control" value="${esc(data.commentator || "")}"></div>
    <div class="form-group"><label for="matchStatus">حالة المباراة</label><select id="matchStatus" class="form-control"><option value="قادمة" ${data.status === "قادمة" || !data.status ? "selected" : ""}>قادمة</option><option value="مباشرة" ${data.status === "مباشرة" ? "selected" : ""}>مباشرة</option><option value="انتهت" ${data.status === "انتهت" ? "selected" : ""}>انتهت</option></select></div>
    <div class="form-group"><label for="matchDate">التاريخ (اختياري)</label><input id="matchDate" class="form-control" value="${esc(data.date || "")}" placeholder="2026-11-14" dir="ltr"></div>
    <div class="form-group"><label for="matchHomeScore">نتيجة الفريق الأول</label><input id="matchHomeScore" class="form-control" type="number" min="0" value="${esc(data.homeScore ?? "")}" placeholder="—"></div>
    <div class="form-group"><label for="matchAwayScore">نتيجة الفريق الثاني</label><input id="matchAwayScore" class="form-control" type="number" min="0" value="${esc(data.awayScore ?? "")}" placeholder="—"></div>
    </div><div class="modal-footer"><button type="button" class="btn-secondary" id="cancelModal">إلغاء</button><button type="submit" class="btn-primary" id="saveMatch">حفظ المباراة</button></div></form>`);
  const homeUpload = createUploadWidget("homeLogo", data.homeLogo || ""); $("uploadContainerHome").append(homeUpload);
  const awayUpload = createUploadWidget("awayLogo", data.awayLogo || ""); $("uploadContainerAway").append(awayUpload);
  $("matchChannelSelect").addEventListener("change", event => {
    const selected = channels[event.target.value];
    if (selected) { const su = privateStreams?.channels?.[event.target.value]?.streamUrl || selected.url || ""; if (su) $("matchChannelUrl").value = su; }
  });
  $("cancelModal").onclick = closeModal;
  $("matchForm").onsubmit = async event => {
    event.preventDefault(); const button = $("saveMatch"); button.disabled = true;
    try {
      const channelId = $("matchChannelSelect").value;
      const selectedChannel = channels[channelId];
      const payload = {
        home: $("matchHome").value.trim(), away: $("matchAway").value.trim(),
        homeLogo: homeUpload.getValue(), awayLogo: awayUpload.getValue(),
        time: $("matchTime").value.trim(), league: $("matchLeague").value.trim(),
        channelId: channelId || "", channelName: selectedChannel?.name || data.channelName || "",
        channelUrl: $("matchChannelUrl").value.trim(), commentator: $("matchCommentator").value.trim(), status: $("matchStatus").value,
        date: $("matchDate").value.trim(), homeScore: scoreVal("matchHomeScore"), awayScore: scoreVal("matchAwayScore")
      };
      if (!payload.home || !payload.away || !payload.time || !payload.league) throw new Error("يرجى إدخال الفريقين والتوقيت والبطولة.");
      if (homeUpload.isUploading() || awayUpload.isUploading()) throw new Error("انتظر حتى تنتهي معالجة شعاري الفريقين.");

      const matchKey = key || push(ref(db, "matches")).key;
      if (!key) payload.sort = nextMatchSort();
      const rawUrl = payload.channelUrl;
      payload.channelUrl = null;
      if (rawUrl) { await saveSecureLink("matches", matchKey, rawUrl); payload.hasLink = true; }
      await update(ref(db, `matches/${matchKey}`), payload);
      if (rawUrl) await update(ref(db, `privateStreams/matches/${matchKey}`), { streamUrl: null, status: "active", updatedAt: Date.now() });

      toast("تم حفظ المباراة بنجاح.", "success"); closeModal();
    } catch (error) { toast(error.message || friendlyFirebaseError(error), "error"); button.disabled = false; }
  };
}

/* ============ رفع الشعارات (Base64) ============ */
function createUploadWidget(fieldName, initialUrl = "") {
  const id = `${fieldName}_${++uploadCounter}`;
  const placeholder = `<div class="upload-placeholder">${icon("image")}<small>معاينة الشعار</small></div>`;
  const wrapper = document.createElement("div");
  wrapper.className = "upload-widget-container";
  wrapper.innerHTML = `<input class="file-input" id="file_${id}" type="file" accept="image/*" hidden>
    <input id="value_${id}" type="hidden" value="${esc(initialUrl)}">
    <div class="upload-card"><div class="upload-preview-wrapper" id="preview_${id}">${initialUrl ? `<img class="upload-img-preview" src="${esc(initialUrl)}" alt="معاينة الشعار">` : placeholder}</div>
    <div class="upload-details"><strong>شعار الصورة</strong><small>PNG أو JPG أو WEBP · حتى 5MB</small><div class="upload-actions"><button type="button" class="btn-primary" id="choose_${id}">${icon("image")} اختيار صورة</button><button type="button" class="btn-sm btn-del" id="remove_${id}" ${initialUrl ? "" : "hidden"}>${icon("trash")} إزالة</button></div></div></div>
    <div class="upload-progress" id="progressWrap_${id}" hidden><div class="progress-meta"><span id="status_${id}">جاهز</span><b id="percent_${id}">0%</b></div><div class="progress-track"><span id="bar_${id}"></span></div></div>`;
  const fileInput = wrapper.querySelector(`#file_${id}`);
  const valueInput = wrapper.querySelector(`#value_${id}`);
  const preview = wrapper.querySelector(`#preview_${id}`);
  const choose = wrapper.querySelector(`#choose_${id}`);
  const removeBtn = wrapper.querySelector(`#remove_${id}`);
  const progressWrap = wrapper.querySelector(`#progressWrap_${id}`);
  const status = wrapper.querySelector(`#status_${id}`);
  const percent = wrapper.querySelector(`#percent_${id}`);
  const bar = wrapper.querySelector(`#bar_${id}`);
  let processing = false;
  let generation = 0;

  const setProgress = (value, message) => {
    const safe = Math.max(0, Math.min(100, Math.round(value)));
    percent.textContent = `${safe}%`;
    bar.style.width = `${safe}%`;
    status.textContent = message;
  };

  choose.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("الملف المختار ليس صورة.", "error"); fileInput.value = ""; return; }
    if (file.size > 5 * 1024 * 1024) { toast("حجم الصورة أكبر من 5 ميجابايت. اختر صورة أصغر.", "error"); fileInput.value = ""; return; }

    const thisGeneration = ++generation;
    processing = true;
    choose.disabled = true;
    progressWrap.hidden = false;
    setProgress(5, "جارٍ قراءة الصورة...");
    try {
      const dataUrl = await imageToCompactBase64(file, (progress, message) => setProgress(progress, message));
      if (thisGeneration !== generation) return;
      valueInput.value = dataUrl;
      preview.innerHTML = `<img class="upload-img-preview" src="${dataUrl}" alt="معاينة الشعار">`;
      removeBtn.hidden = false;
      setProgress(100, "الشعار جاهز — اضغط حفظ لإتمام العملية.");
    } catch (error) {
      console.error("Image conversion failed:", error);
      setProgress(0, error.message || "تعذر تحويل الصورة.");
      toast(error.message || "تعذر تحويل الصورة. جرّب صورة أخرى.", "error");
    } finally {
      if (thisGeneration === generation) {
        processing = false;
        choose.disabled = false;
      }
      fileInput.value = "";
    }
  });

  removeBtn.addEventListener("click", () => {
    generation++;
    valueInput.value = "";
    fileInput.value = "";
    preview.innerHTML = placeholder;
    removeBtn.hidden = true;
    progressWrap.hidden = true;
    processing = false;
    choose.disabled = false;
  });
  wrapper.getValue = () => valueInput.value.trim();
  wrapper.isUploading = () => processing;
  return wrapper;
}

// يحوّل الصورة محلياً إلى WebP/Base64 مضغوط قبل الحفظ في Realtime Database.
async function imageToCompactBase64(file, onProgress = () => {}) {
  onProgress(15, "جارٍ تجهيز الصورة وضغطها...");
  let bitmap;
  try {
    if ("createImageBitmap" in window) bitmap = await createImageBitmap(file);
  } catch (_) { bitmap = null; }

  let source = bitmap;
  if (!source) {
    source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("تعذرت قراءة الصورة من الجهاز."));
      reader.onload = () => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("صيغة الصورة غير مدعومة أو الملف تالف."));
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  try {
    const originalWidth = source.width || source.naturalWidth;
    const originalHeight = source.height || source.naturalHeight;
    if (!originalWidth || !originalHeight) throw new Error("أبعاد الصورة غير صالحة.");

    const maxEncodedBytes = 280 * 1024;
    const attempts = [
      { max: 512, quality: 0.78 },
      { max: 448, quality: 0.72 },
      { max: 384, quality: 0.68 },
      { max: 320, quality: 0.64 },
      { max: 256, quality: 0.60 }
    ];

    for (let i = 0; i < attempts.length; i++) {
      const { max, quality } = attempts[i];
      const scale = Math.min(1, max / Math.max(originalWidth, originalHeight));
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("المتصفح لا يدعم معالجة الصور.");
      context.clearRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);

      let dataUrl = canvas.toDataURL("image/webp", quality);
      if (!dataUrl.startsWith("data:image/webp")) {
        const jpegCanvas = document.createElement("canvas");
        jpegCanvas.width = width;
        jpegCanvas.height = height;
        const jpegContext = jpegCanvas.getContext("2d");
        jpegContext.fillStyle = "#ffffff";
        jpegContext.fillRect(0, 0, width, height);
        jpegContext.drawImage(source, 0, 0, width, height);
        dataUrl = jpegCanvas.toDataURL("image/jpeg", quality);
      }
      const approximateBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      onProgress(25 + Math.round((i / attempts.length) * 65), `ضغط الصورة (${width}×${height})...`);
      if (approximateBytes <= maxEncodedBytes) return dataUrl;
    }
    throw new Error("الصورة ما زالت كبيرة بعد الضغط. اختر شعاراً أبسط أو صورة أصغر.");
  } finally {
    if (bitmap) bitmap.close?.();
  }
}

/* ============ أدوات مساعدة ============ */
/* ============ الإشعارات (FCM عبر Cloud Function) ============ */
let notifHistory = {};
const NOTIF_TOPICS = { all_users: "جميع المستخدمين", match_updates: "مستجدو المباريات", channel_updates: "تحديثات القنوات", test_devices: "أجهزة الاختبار فقط" };
const NOTIF_TYPES = { general: "عام", channel: "قناة", match: "مباراة" };

function notifTargetOptions(type) {
  if (type === "channel") {
    return Object.entries(channels).sort((a, b) => String(a[1].name || "").localeCompare(String(b[1].name || ""), "ar"))
      .map(([id, c]) => `<option value="${esc(id)}">${esc(c.name || id)} — ${esc(categoryLabel(c.categoryId))}</option>`).join("");
  }
  if (type === "match") {
    return sortedMatches().map(([id, m]) => `<option value="${esc(id)}">${esc(m.home || "")} × ${esc(m.away || "")} — ${esc(m.time || "")}</option>`).join("");
  }
  return "";
}
function refreshNotifTargets() {
  const typeEl = $("notifType"), wrap = $("notifTargetWrap"), sel = $("notifTargetId");
  if (!typeEl || !wrap || !sel) return;
  wrap.hidden = typeEl.value === "general";
  const keep = sel.value;
  sel.innerHTML = `<option value="">— اختر —</option>${notifTargetOptions(typeEl.value)}`;
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}
function notifErrorText(error) {
  const code = String(error?.code || "");
  if (code.includes("permission-denied")) return "حسابك ليس مشرفاً. أضف بريدك في ADMIN_EMAILS داخل functions/.env أو نفّذ scripts/set-admin.js ثم أعد النشر.";
  if (code.includes("not-found")) return "الدالة sendNotification غير منشورة بعد. نفّذ: firebase deploy --only functions";
  if (code.includes("unauthenticated")) return "انتهت الجلسة. سجّل الدخول من جديد.";
  if (code.includes("invalid-argument")) return error.message || "بيانات الإشعار غير صالحة.";
  return error?.message || "تعذر إرسال الإشعار.";
}

function renderNotifications() {
  if ($("notifTitle")) { refreshNotifTargets(); renderNotifHistory(); return; }   // لا نمسح ما يكتبه المشرف
  $("tabContent").innerHTML = `
    <section class="panel-card">
      <div class="panel-header"><div>
        <span class="eyebrow">التواصل الفوري</span>
        <h2>الإشعارات الجماعية (FCM)</h2>
        <p class="panel-subtitle">أرسل إشعاراً لكل مشتركي موضوع معين، واختر قناة أو مباراة ليفتحها التطبيق عند الضغط على الإشعار.</p>
      </div></div>

      <div class="notif-layout">
        <div class="notif-form">
          <h3>${icon("bell")} إشعار جديد</h3>
          <div class="notif-chips">
            <button type="button" class="chip-btn" data-tpl="live">⚽ مباراة تبدأ الآن</button>
            <button type="button" class="chip-btn" data-tpl="channel">📺 قناة جديدة</button>
            <button type="button" class="chip-btn" data-tpl="update">🔔 تحديث التطبيق</button>
          </div>
          <div class="form-group"><label for="notifTitle">عنوان الإشعار *</label><input id="notifTitle" class="form-control" maxlength="100" placeholder="مثال: مباراة حاسمة الليلة!"></div>
          <div class="form-group"><label for="notifBody">نص الإشعار *</label><textarea id="notifBody" class="form-control" rows="3" maxlength="300" placeholder="اكتب نص الرسالة هنا..."></textarea></div>
          <div class="form-grid">
            <div class="form-group"><label for="notifTopic">الجمهور المستهدف</label><select id="notifTopic" class="form-control">${Object.entries(NOTIF_TOPICS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
            <div class="form-group"><label for="notifType">عند الضغط يفتح</label><select id="notifType" class="form-control">${Object.entries(NOTIF_TYPES).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
          </div>
          <div class="form-group" id="notifTargetWrap" hidden><label for="notifTargetId">العنصر المستهدف</label><select id="notifTargetId" class="form-control"></select></div>
          <div class="form-group"><label for="notifImage">رابط صورة الإشعار (اختياري)</label><input id="notifImage" class="form-control" type="url" dir="ltr" placeholder="https://example.com/banner.jpg"></div>
          <button type="button" class="btn-primary notif-send" id="sendNotifBtn">${icon("send")} إرسال الإشعار</button>
        </div>

        <div class="notif-side">
          <h3>معاينة على الهاتف</h3>
          <div class="notif-phone">
            <div class="notif-phone-bar"><span>9:41</span><span>●●●</span></div>
            <div class="notif-card">
              <div class="notif-app"><span class="brand-mark small">R</span><span>RAYA TV PRO • الآن</span></div>
              <b id="previewTitle">عنوان الإشعار</b>
              <p id="previewBody">نص الإشعار...</p>
              <img id="previewImage" alt="" hidden>
            </div>
          </div>
          <h3 style="margin-top:22px">آخر الإشعارات المرسلة</h3>
          <div id="notifHistory" class="notif-history"></div>
        </div>
      </div>
    </section>`;

  const preview = () => {
    $("previewTitle").textContent = $("notifTitle").value || "عنوان الإشعار";
    $("previewBody").textContent = $("notifBody").value || "نص الإشعار...";
    const img = $("notifImage").value.trim(), el = $("previewImage");
    if (/^https?:\/\/.+/i.test(img)) { el.src = img; el.hidden = false; } else { el.hidden = true; el.removeAttribute("src"); }
  };
  ["notifTitle", "notifBody", "notifImage"].forEach(id => $(id).addEventListener("input", preview));
  $("notifType").addEventListener("change", refreshNotifTargets);
  $("notifTargetId").addEventListener("change", () => {
    const id = $("notifTargetId").value, type = $("notifType").value;
    if (type === "match" && matches[id]) {
      const m = matches[id];
      $("notifTitle").value = `⚽ ${m.home || ""} × ${m.away || ""}`;
      $("notifBody").value = `تبدأ ${m.time || "قريباً"}${m.channelName ? ` على ${m.channelName}` : ""} — شاهد الآن على RAYA TV PRO`;
      if (m.homeLogo && /^https?:/i.test(m.homeLogo)) $("notifImage").value = m.homeLogo;
    }
    if (type === "channel" && channels[id]) {
      $("notifTitle").value = `📺 ${channels[id].name || ""}`;
      $("notifBody").value = "البث المباشر متاح الآن بجودة عالية على RAYA TV PRO.";
    }
    preview();
  });
  document.querySelectorAll("[data-tpl]").forEach(b => b.onclick = () => {
    const t = {
      live: ["⚽ مباراة هامة بدأت الآن", "شاهد البث المباشر الآن بجودة عالية على RAYA TV PRO.", "match_updates", "general"],
      channel: ["📺 قناة جديدة وصلت", "أضفنا قناة جديدة، افتح التطبيق لمشاهدتها.", "channel_updates", "general"],
      update: ["🔔 تحديث جديد للتطبيق", "حدّث التطبيق للحصول على أحدث المزايا وأفضل أداء.", "all_users", "general"]
    }[b.dataset.tpl];
    $("notifTitle").value = t[0]; $("notifBody").value = t[1]; $("notifTopic").value = t[2]; $("notifType").value = t[3];
    refreshNotifTargets(); preview();
  });

  $("sendNotifBtn").onclick = async () => {
    const button = $("sendNotifBtn");
    const data = {
      title: $("notifTitle").value.trim(), body: $("notifBody").value.trim(),
      topic: $("notifTopic").value, type: $("notifType").value,
      targetId: $("notifType").value === "general" ? "" : $("notifTargetId").value,
      image: $("notifImage").value.trim()
    };
    if (!data.title || !data.body) { toast("اكتب عنوان ونص الإشعار.", "error"); return; }
    if (data.type !== "general" && !data.targetId) { toast("اختر القناة أو المباراة المستهدفة.", "error"); return; }
    if (data.image && !/^https?:\/\/.+/i.test(data.image)) { toast("رابط الصورة غير صالح.", "error"); return; }
    if (!(await confirmDialog("إرسال الإشعار", `سيصل الإشعار إلى «${NOTIF_TOPICS[data.topic]}». متابعة؟`))) return;

    button.disabled = true;
    button.textContent = "جارٍ الإرسال...";
    try {
      await sendNotificationFn(data);
      toast("تم إرسال الإشعار بنجاح ✓", "success");
      $("notifTitle").value = ""; $("notifBody").value = ""; $("notifImage").value = "";
      preview();
    } catch (error) {
      console.error("Notification error:", error);
      toast(notifErrorText(error), "error");
    } finally {
      button.disabled = false;
      button.innerHTML = `${icon("send")} إرسال الإشعار`;
    }
  };
  refreshNotifTargets();
  renderNotifHistory();
}

function renderNotifHistory() {
  const box = $("notifHistory");
  if (!box) return;
  const rows = Object.entries(notifHistory).sort((a, b) => Number(b[1].timestamp || 0) - Number(a[1].timestamp || 0)).slice(0, 20);
  box.innerHTML = rows.length ? rows.map(([id, n]) => `
    <div class="notif-item ${n.status === "failed" ? "failed" : ""}">
      <div class="notif-item-body">
        <b>${esc(n.title || "")}</b><p>${esc(n.body || "")}</p>
        <small>${esc(NOTIF_TOPICS[n.topic] || n.topic || "")} • ${esc(NOTIF_TYPES[n.type] || "عام")} • ${n.timestamp ? esc(new Date(n.timestamp).toLocaleString("ar")) : ""}</small>
        ${n.status === "failed" && n.error ? `<small class="err">${esc(n.error)}</small>` : ""}
      </div>
      <div class="notif-item-side"><span class="status-pill ${n.status === "failed" ? "off" : "on"}">${n.status === "failed" ? "فشل" : "أُرسل"}</span>
      <button type="button" class="btn-sm btn-edit" data-reuse-notif="${esc(id)}">${icon("refresh")} إعادة</button></div>
    </div>`).join("") : `<div class="empty-state">لا توجد إشعارات مرسلة بعد.</div>`;
  box.querySelectorAll("[data-reuse-notif]").forEach(b => b.onclick = () => {
    const n = notifHistory[b.dataset.reuseNotif];
    if (!n) return;
    $("notifTitle").value = n.title || ""; $("notifBody").value = n.body || ""; $("notifTopic").value = n.topic || "all_users";
    $("notifType").value = n.type || "general"; refreshNotifTargets(); if (n.targetId) $("notifTargetId").value = n.targetId;
    $("notifImage").value = n.image || "";
    $("notifTitle").dispatchEvent(new Event("input"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function toast(message, type = "info") {
  const region = $("toastRegion");
  const item = document.createElement("div"); item.className = `toast ${type}`; item.textContent = message;
  region.append(item); setTimeout(() => item.remove(), 4800);
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}
function friendlyFirebaseError(error) {
  const code = error?.code || "";
  const messages = {
    "auth/invalid-credential": "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
    "auth/user-not-found": "الحساب غير موجود.",
    "auth/wrong-password": "كلمة المرور غير صحيحة.",
    "auth/too-many-requests": "محاولات كثيرة. حاول لاحقاً.",
    "PERMISSION_DENIED": "ليست لديك صلاحية للوصول إلى قاعدة البيانات.",
    "database/permission-denied": "ليست لديك صلاحية للوصول إلى قاعدة البيانات."
  };
  return messages[code] || error?.message || String(error || "") || "حدث خطأ غير متوقع.";
}
