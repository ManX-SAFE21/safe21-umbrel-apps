(function () {
"use strict";
/* Public page. Every value read from the API is written with textContent (never innerHTML). */
var lang = "it";
try { if (localStorage.getItem("welist-lang") === "en") lang = "en"; } catch (e) { /* storage blocked */ }

var T = {
it: {
 banner: "ANTEPRIMA — pagamenti finti e Will Executor di esempio", title: "Lista Will Executor",
 tab1: "Lista", tab2: "Iscrivi il tuo Will Executor",
 listIntro: "Elenco pubblico dei Will Executor: server che trasmettono alla rete, alla data stabilita, le transazioni di eredità già firmate.",
 signedNote: "L'elenco è firmato: il plugin ne verifica la firma", fp: "Impronta:", dl: "Scarica elenco firmato (JSON)", dlSig: "Firma", dlKey: "Chiave pubblica",
 filter: "Rete", all: "Tutte", count: " Will Executor mostrati", listErr: "Impossibile caricare l'elenco. Riprova tra poco.", empty: "Nessun Will Executor in lista.",
 hAddr: "Indirizzo", hNet: "Rete", hBase: "Tariffa base", hDay: "Tariffa giornaliera", hVer: "Versione", hStat: "Stato", hLast: "Ultimo controllo", hUntil: "In lista fino al",
 online: "online", offline: "offline", daysLeft: "giorni", never: "mai",
 noNeed: "Non serve nessun account, nessuna chiave, nessun record DNS e nessun comando: basta l'indirizzo del tuo server e un pagamento.",
 st1: "1. Indirizzo", st2: "2. Controllo", st3: "3. Pagamento",
 s1t: "Passo 1 — Indirizzo", s1l: "Indirizzo del tuo Will Executor", check: "Controlla", s1h: "Esempio: https://tuo-server.example.net (solo https, senza percorso). Gli indirizzi .onion non sono ancora supportati.",
 s2t: "Passo 2 — Risultato del controllo", s2p: "Questi valori sono letti dal server stesso e non si possono scrivere a mano.",
 kNet: "Rete", kBase: "Tariffa base", kDay: "Tariffa giornaliera", kVer: "Versione", kInfo: "Info", kAddr: "Indirizzo del server",
 proceed: "Continua al pagamento", back: "Cambia indirizzo",
 s3t: "Passo 3 — Pagamento", payAddr: "Indirizzo Bitcoin dedicato a questo Will Executor", copy: "Copia", copied: "Copiato", openWallet: "Apri nel portafoglio",
 amount: "Importo", period: "Periodo", forExec: "Per", credit: "Credito già ricevuto", months: " mesi", free: "gratis",
 waiting: "In attesa del pagamento… ({n} conferme richieste). La pagina si aggiorna da sola.",
 renew: "Per rinnovare paga di nuovo allo stesso indirizzo.", renewFree: "Per rinnovare ripeti l'iscrizione con lo stesso indirizzo.",
 okUntil: "Sei in lista fino al ", suspended: "Iscrizione sospesa dal gestore della lista.",
 offerPaid: "Prezzo: {p} sats per {m} mesi.", offerFree: "Il primo periodo di {m} mesi è gratuito.", offerZero: "L'iscrizione su questa rete è gratuita ({m} mesi).", offerKnown: " Questo Will Executor è già iscritto: vedrai il suo stato.",
 keepLink: "Per tornare a questa pagina:",
 e_bad_url: "Indirizzo non valido: scrivi solo https://nome-del-server (senza percorso e senza / finale).",
 e_https_only: "Serve un indirizzo https://.", e_onion: "I Will Executor .onion non sono ancora supportati.",
 e_bad_host: "Il nome del server non è valido: serve un nome di dominio, non un indirizzo IP.",
 e_local_host: "Nomi locali (localhost, .local, .internal…) non sono ammessi.", e_bad_chain: "Rete non valida.",
 e_dns: "Il nome del server non si trova nel DNS.",
 e_private_address: "Il nome del server porta a un indirizzo privato o riservato, non raggiungibile da internet.",
 e_connect: "Il server non risponde (collegamento rifiutato o interrotto).", e_tls: "Il certificato HTTPS del server non è valido.",
 e_timeout: "Il server non ha risposto entro 10 secondi.", e_redirect: "Il server risponde con un reindirizzamento: usa l'indirizzo finale.",
 e_http_status: "Il server risponde a /{c}/info con l'errore HTTP {s}.", e_too_big: "La risposta del server è troppo grande (massimo 4 KB).",
 e_not_json: "La risposta del server a /{c}/info non è JSON valido.", e_not_object: "La risposta del server a /{c}/info non è JSON valido.",
 e_wrong_chain: "Il server dice di lavorare su un'altra rete ({g}).", e_bad_field: "Il campo «{f}» della risposta del server non è valido.",
 e_rate_limited: "Troppe richieste da questo indirizzo: riprova più tardi.", e_busy: "Il servizio è occupato: riprova tra poco.",
 e_too_many_pending: "Troppe iscrizioni in attesa di pagamento: riprova più tardi.", e_payments_unavailable: "Pagamenti momentaneamente non disponibili: riprova più tardi.",
 e_not_found: "Iscrizione non trovata.", e_other: "Errore imprevisto. Riprova tra poco.",
 errHelp: " Controlla che il server sia acceso, raggiungibile da internet e che l'indirizzo sia corretto, poi riprova."
},
en: {
 banner: "PREVIEW — simulated payments and sample Will Executors", title: "Will Executor List",
 tab1: "List", tab2: "Register your Will Executor",
 listIntro: "Public directory of Will Executors: servers that broadcast pre-signed inheritance transactions to the network on the set date.",
 signedNote: "The list is signed: the plugin verifies its signature", fp: "Fingerprint:", dl: "Download signed list (JSON)", dlSig: "Signature", dlKey: "Public key",
 filter: "Network", all: "All", count: " Will Executors shown", listErr: "Could not load the list. Please try again shortly.", empty: "No Will Executor listed.",
 hAddr: "Address", hNet: "Network", hBase: "Base fee", hDay: "Daily fee", hVer: "Version", hStat: "Status", hLast: "Last check", hUntil: "Listed until",
 online: "online", offline: "offline", daysLeft: "days", never: "never",
 noNeed: "No account, no key, no DNS record and no command is needed: just your server address and a payment.",
 st1: "1. Address", st2: "2. Check", st3: "3. Payment",
 s1t: "Step 1 — Address", s1l: "Address of your Will Executor", check: "Check", s1h: "Example: https://your-server.example.net (https only, no path). .onion addresses are not supported yet.",
 s2t: "Step 2 — Check result", s2p: "These values are read from the server itself and cannot be typed by hand.",
 kNet: "Network", kBase: "Base fee", kDay: "Daily fee", kVer: "Version", kInfo: "Info", kAddr: "Server address",
 proceed: "Continue to payment", back: "Change address",
 s3t: "Step 3 — Payment", payAddr: "Bitcoin address dedicated to this Will Executor", copy: "Copy", copied: "Copied", openWallet: "Open in wallet",
 amount: "Amount", period: "Period", forExec: "For", credit: "Credit already received", months: " months", free: "free",
 waiting: "Waiting for payment… ({n} confirmations required). This page updates by itself.",
 renew: "To renew, pay again to the same address.", renewFree: "To renew, register again with the same address.",
 okUntil: "You are listed until ", suspended: "Registration suspended by the list operator.",
 offerPaid: "Price: {p} sats for {m} months.", offerFree: "The first {m}-month period is free.", offerZero: "Listing on this network is free ({m} months).", offerKnown: " This Will Executor is already registered: you will see its status.",
 keepLink: "To come back to this page:",
 e_bad_url: "Invalid address: write only https://server-name (no path and no trailing /).",
 e_https_only: "An https:// address is required.", e_onion: ".onion Will Executors are not supported yet.",
 e_bad_host: "Invalid server name: a domain name is required, not an IP address.",
 e_local_host: "Local names (localhost, .local, .internal…) are not allowed.", e_bad_chain: "Invalid network.",
 e_dns: "The server name cannot be found in DNS.",
 e_private_address: "The server name points to a private or reserved address, not reachable from the internet.",
 e_connect: "The server does not answer (connection refused or dropped).", e_tls: "The server's HTTPS certificate is not valid.",
 e_timeout: "The server did not answer within 10 seconds.", e_redirect: "The server answers with a redirect: use the final address.",
 e_http_status: "The server answers /{c}/info with HTTP error {s}.", e_too_big: "The server's answer is too large (4 KB max).",
 e_not_json: "The server's answer at /{c}/info is not valid JSON.", e_not_object: "The server's answer at /{c}/info is not valid JSON.",
 e_wrong_chain: "The server says it works on another network ({g}).", e_bad_field: "The field “{f}” of the server's answer is not valid.",
 e_rate_limited: "Too many requests from your address: try again later.", e_busy: "The service is busy: try again shortly.",
 e_too_many_pending: "Too many registrations waiting for payment: try again later.", e_payments_unavailable: "Payments temporarily unavailable: try again later.",
 e_not_found: "Registration not found.", e_other: "Unexpected error. Please try again shortly.",
 errHelp: " Make sure the server is running, reachable from the internet and the address is correct, then try again."
}};
function t(k) { return T[lang][k]; }
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
function num(n) { return (n === null || n === undefined) ? "—" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function sats(n) { return (n === null || n === undefined) ? "—" : num(n) + " sats"; }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString(lang === "it" ? "it-IT" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"; }
function ago(iso) {
  if (!iso) return t("never");
  var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return lang === "it" ? m + " min fa" : m + " min ago";
  var h = Math.round(m / 60);
  if (h < 48) return lang === "it" ? h + " h fa" : h + " h ago";
  var d = Math.round(h / 24); return lang === "it" ? d + " giorni fa" : d + " days ago";
}
function fill(s, o) { return s.replace(/\{(\w)\}/g, function (_, k) { return o[k] === undefined ? "" : String(o[k]); }); }

/* ---------- API ---------- */
function api(method, path, body) {
  var o = { method: method, headers: { "Accept": "application/json" } };
  if (body) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
  return fetch(path, o).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: "other" }; });
  }, function () { return { ok: false, error: "other" }; });
}
function errText(r, chain) {
  var k = "e_" + (r && r.error);
  var s = T[lang][k] ? t(k) : t("e_other");
  s = fill(s, { c: chain || "", s: r && r.status_code, g: r && r.got, f: r && r.field });
  if (/^(dns|connect|timeout|tls|http_status|not_json|not_object|private_address)$/.test(r && r.error)) s += t("errHelp");
  return s;
}

/* ---------- list ---------- */
var LIST = null;
function head(id, keys) {
  var tr = $(id); tr.textContent = "";
  keys.forEach(function (k) { tr.appendChild(el("th", "", t(k))); });
}
function td(label, cls) { var c = el("td", cls); c.setAttribute("data-l", label); return c; }
function renderList() {
  head("h-list", ["hAddr", "hNet", "hBase", "hDay", "hVer", "hStat", "hLast", "hUntil"]);
  var body = $("b-list"); body.textContent = "";
  if (!LIST) { $("count").textContent = ""; return; }
  $("fpr").textContent = LIST.fingerprint.toUpperCase().match(/.{4}/g).join(" ");
  $("banner").classList.toggle("hide", !LIST.preview);
  var f = $("netf").value;
  var rows = LIST.executors.filter(function (r) { return f === "all" || r.chain === f; });
  $("count").textContent = rows.length + t("count");
  if (!rows.length) { var tr0 = el("tr"); var c0 = el("td", "empty", t("empty")); c0.colSpan = 8; tr0.appendChild(c0); body.appendChild(tr0); return; }
  rows.forEach(function (r) {
    var tr = el("tr");
    var a = td(t("hAddr"), "addr"); a.appendChild(el("span", "", r.url)); if (r.info) a.appendChild(el("span", "info", r.info)); tr.appendChild(a);
    var n = td(t("hNet")); n.appendChild(el("span", "net", r.chain)); tr.appendChild(n);
    var b = td(t("hBase")); b.textContent = sats(r.base_fee); tr.appendChild(b);
    var d = td(t("hDay")); d.textContent = sats(r.daily_fee); tr.appendChild(d);
    var v = td(t("hVer")); v.textContent = r.version || "—"; tr.appendChild(v);
    var s = td(t("hStat")); s.appendChild(el("span", "pill " + (r.status === "online" ? "online" : "offline"), t(r.status === "online" ? "online" : "offline"))); tr.appendChild(s);
    var l = td(t("hLast")); l.textContent = ago(r.last_check); tr.appendChild(l);
    var u = td(t("hUntil"));
    var days = Math.round((new Date(r.listed_until).getTime() - Date.now()) / 86400000);
    var txt = fmtDate(r.listed_until) + " (" + days + " " + t("daysLeft") + ")";
    if (days < 15) u.appendChild(el("span", "low", txt)); else u.textContent = txt;
    tr.appendChild(u);
    body.appendChild(tr);
  });
}
function loadList() {
  api("GET", "/api/list").then(function (r) {
    if (!r || !r.executors) { $("listErr").classList.remove("hide"); return; }
    $("listErr").classList.add("hide");
    LIST = r; renderList();
  });
}

/* ---------- registration ---------- */
var step = 1, checked = null, reg = null, pollTimer = null;
function renderSteps() {
  var box = $("steps"); box.textContent = "";
  ["st1", "st2", "st3"].forEach(function (k, i) {
    box.appendChild(el("span", (i + 1 === step) ? "on" : (i + 1 < step ? "done" : ""), t(k)));
  });
  ["s1", "s2", "s3"].forEach(function (id, i) { $(id).classList.toggle("hide", i + 1 !== step); });
}
function go(n) { step = n; renderSteps(); }
function normUrl(s) {
  s = String(s || "").trim();
  if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)\/$/i, "$1");
  return s.toLowerCase();
}
function renderChecks() {
  var ul = $("chk"); ul.textContent = "";
  if (!checked) return;
  var v = checked.values;
  [["kAddr", checked.url], ["kNet", v.chain], ["kBase", sats(v.base_fee)], ["kDay", sats(v.daily_fee)], ["kVer", v.version || "—"], ["kInfo", v.info || "—"]].forEach(function (i) {
    var li = el("li"); li.appendChild(el("span", "tick", "✓")); li.appendChild(el("span", "k", t(i[0]))); li.appendChild(el("strong", "v", i[1])); ul.appendChild(li);
  });
  var o = checked.offer, m = o.period_months, s;
  if (o.price === 0) s = fill(t("offerZero"), { m: m });
  else if (o.free_first) s = fill(t("offerFree"), { m: m }) + " " + fill(t("offerPaid"), { p: num(o.price), m: m });
  else s = fill(t("offerPaid"), { p: num(o.price), m: m });
  if (o.registered) s += t("offerKnown");
  $("offer").textContent = s;
}
function showErr(id, text) { var e = $(id); e.textContent = text || ""; e.classList.toggle("hide", !text); }
function busy(btn, on) { btn.disabled = on; }

function doCheck() {
  var url = normUrl($("url").value), chain = $("chain").value;
  $("url").value = url;
  showErr("s1err", "");
  busy($("check"), true);
  api("POST", "/api/check", { url: url, chain: chain }).then(function (r) {
    busy($("check"), false);
    if (!r.ok) { showErr("s1err", errText(r, chain)); return; }
    checked = r; showErr("s2err", ""); renderChecks(); go(2);
  });
}
function doRegister() {
  if (!checked) return;
  showErr("s2err", "");
  busy($("to3"), true);
  api("POST", "/api/register", { url: checked.url, chain: checked.chain }).then(function (r) {
    busy($("to3"), false);
    if (!r.ok) { showErr("s2err", errText(r, checked.chain)); return; }
    reg = r;
    try { history.replaceState(null, "", "#r=" + r.public_id); } catch (e) { location.hash = "r=" + r.public_id; }
    renderPay(); go(3); startPoll();
  });
}
function renderPay() {
  if (!reg) return;
  var paid = reg.price > 0;
  $("payBlock").classList.toggle("hide", !paid || !reg.pay_address);
  $("payaddr").textContent = reg.pay_address || "";
  if (reg.pay_address) $("walletLink").href = "bitcoin:" + encodeURIComponent(reg.pay_address) + (reg.price > 0 ? "?amount=" + (reg.price / 1e8).toFixed(8).replace(/\.?0+$/, "") : "");
  $("amountv").textContent = paid ? sats(reg.price) : t("free");
  $("periodv").textContent = reg.period_months + t("months");
  $("forv").textContent = reg.url + " (" + reg.chain + ")";
  $("creditRow").classList.toggle("hide", !(reg.credit > 0));
  $("creditv").textContent = sats(reg.credit);
  $("renewNote").textContent = paid ? t("renew") : t("renewFree");
  var st = $("paystat");
  if (reg.suspended) { st.className = "status"; st.textContent = t("suspended"); }
  else if (reg.listed) { st.className = "status ok"; st.textContent = t("okUntil") + fmtDate(reg.listed_until); }
  else { st.className = "status"; st.textContent = fill(t("waiting"), { n: reg.min_conf }); }
  var link = location.origin + "/#r=" + reg.public_id;
  $("selfLink").href = link; $("selfLink").textContent = link;
}
function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(function () {
    if (!reg || step !== 3 || document.hidden) return;
    api("GET", "/api/status/" + encodeURIComponent(reg.public_id)).then(function (r) {
      if (r && r.ok) { var was = reg.listed; reg = r; renderPay(); if (!was && r.listed) loadList(); }
    });
  }, 20000);
}
function resume() {
  var m = /^#r=([A-Za-z0-9_-]{22})$/.exec(location.hash);
  if (!m) return;
  api("GET", "/api/status/" + m[1]).then(function (r) {
    if (!r || !r.ok) return;
    reg = r; showView("reg"); renderPay(); go(3); startPoll();
  });
}

/* ---------- language, tabs ---------- */
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t("title");
  Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (e) { e.textContent = t(e.getAttribute("data-i18n")); });
  $("l-it").classList.toggle("on", lang === "it");
  $("l-en").classList.toggle("on", lang === "en");
  renderList(); renderChecks(); renderSteps(); renderPay();
}
function setLang(l) { lang = l; try { localStorage.setItem("welist-lang", l); } catch (e) { /* ignore */ } applyLang(); }
function showView(name) {
  Array.prototype.forEach.call(document.querySelectorAll("nav.tabs button"), function (x) { x.classList.toggle("on", x.getAttribute("data-view") === name); });
  Array.prototype.forEach.call(document.querySelectorAll(".view"), function (v) { v.classList.remove("on"); });
  $("v-" + name).classList.add("on");
}
Array.prototype.forEach.call(document.querySelectorAll("nav.tabs button"), function (b) {
  b.addEventListener("click", function () { showView(b.getAttribute("data-view")); });
});
$("l-it").addEventListener("click", function () { setLang("it"); });
$("l-en").addEventListener("click", function () { setLang("en"); });
$("netf").addEventListener("change", renderList);
$("check").addEventListener("click", doCheck);
$("url").addEventListener("keydown", function (e) { if (e.key === "Enter") doCheck(); });
$("back1").addEventListener("click", function () { go(1); });
$("to3").addEventListener("click", doRegister);
$("copy").addEventListener("click", function () {
  var b = this, a = $("payaddr").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(a).then(function () { b.textContent = t("copied"); setTimeout(function () { b.textContent = t("copy"); }, 1500); }, function () {});
});
applyLang(); loadList(); resume();
setInterval(function () { if (!document.hidden) loadList(); }, 120000);
})();
