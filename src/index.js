/**
 * MAISON / ANAF — daily enrichment, evidence-first.   v2.8 · 2026-10-25
 *
 * v2.8 față de v2.7: SINGURA schimbare = ruta POST /test-telegram (test manual al livrării Telegram),
 * protejată cu secretul TELEGRAM_TEST_KEY (header X-Test-Key). Nu atinge D1, ANAF, cron sau logica de rulare.
 * După testul reușit, ruta se scoate într-o versiune următoare.
 *
 * Schimbări față de v1.0:
 *  1. SQL fără CAST(CUI AS INTEGER): coloana cui e deja INTEGER. Interogarea folosește
 *     indexul ix_onrc_firme_cui (INDEXED BY) => ~5.900 rânduri citite pe rulare (verificat pe baza reală),
 *     în loc de 1.784.283 (scanare completă) în v1.0. Fără INDEXED BY, filtrul top = 1
 *     face planificatorul să aleagă ix_onrc_top_den și să citească ~1,3 milioane de rânduri.
 *  2. La capătul listei NU mai resetează cursorul la 0 (v1.0 reinterogă ANAF pentru toate firmele, la nesfârșit).
 *  3. (înlocuit în v2.0, pct. 19) Filtrul pe top / persoana_fizica depinde de INCLUDE_PFA.
 *  4. MAX_BATCH rămâne 1000: dovedit în producție (v1.0) — 927.010 CUI procesate în loturi de 1.000,
 *     0 fără răspuns (unmatched); singurul eșec din istoric: eroare de rețea 522. Dacă ANAF ar respinge
 *     dimensiunea, cererea eșuează cu 4xx, cursorul nu avansează, eroarea apare în detail.
 *  5. PFA (persoane fizice): INCLUDE_PFA = true, comutator explicit (vezi mai jos).
 *  6. Măsurare: rows_read + rows_written însumate pentru SELECT-uri și scrierile în lot. NU include cererile
 *     mici de lock / cursor / log. Garda de lease (pct. 8) adaugă ~1 rând citit pe instrucțiune.
 *
 * Schimbări în v1.4 (față de v1.3):
 *  7. Verificarea firmelor noi cu CUI sub cursor NU mai depinde de cursor. Când au trecut 7 zile de la ultima
 *     verificare, rulează în aceeași rulare (fără să mute cursorul). (Ordinea fazelor: vezi pct. 32.)
 *     Limită de siguranță: dacă verificarea nu se termină în 3 rulări consecutive, e amânată cu 7 zile și
 *     mesajul avertizează (evită o buclă de scanări de ~1,6 milioane de rânduri).
 *  8. Exclusivitate la SCRIERE, atomică: fiecare instrucțiune de scriere conține în aceeași tranzacție D1
 *     verificarea lease-ului (INSERT ... SELECT ... WHERE EXISTS lease valid, ceasul SQLite).
 *     Dacă lease-ul a expirat, instrucțiunea nu scrie nimic (changes = 0) și rularea se oprește cu eroare.
 *     Cursorul nu poate merge înapoi (UPDATE ... WHERE valoare nouă > valoare veche).
 *     Notă: apelurile ANAF și citirile nu sunt exclusive; scrierile sunt idempotente (upsert).
 *  9. (înlocuit în v2.1, pct. 22) Durata: vezi bugetul de timp din pct. 22.
 *
 * Schimbări în v1.5 (față de v1.4):
 * 10. Lease-ul (achiziție + reînnoire) folosește ceasul SQLite, ca și garda de scriere. v1.4 amesteca
 *     ceasul Worker-ului (Date.now) cu ceasul D1; un decalaj între ele putea face garda să respingă
 *     scrieri valide sau să accepte un lease expirat. Logica rămâne identică, doar sursa timpului.
 *
 * Schimbări în v1.6-v1.8 (față de v1.5), după revizuiri:
 * 11. Validare STRICTĂ a răspunsului ANAF înainte de orice scriere: fiecare CUI cerut trebuie să apară exact o
 *     dată în found SAU în notFound. CUI fără răspuns se recer o singură dată (doar ele). Dacă tot lipsesc, sau
 *     există duplicate / CUI în ambele liste, lotul NU se scrie și cursorul NU avansează (eroare în maison_anaf_runs.detail,
 *     reluat la rularea următoare). Cursorul avansează numai când toate CUI-urile lotului au rezultat explicit.
 *     Consecință asumată: un CUI care ar rămâne permanent fără răspuns ar bloca cursorul și ar apărea în
 *     maison_anaf_runs.detail ("Raspuns ANAF incoerent"); se tratează atunci manual, nu se ignoră în tăcere.
 * 12. Eșecul verificării sub cursor NU oprește faza pe cursor. Faza pe cursor este sărită doar la pierderea
 *     lease-ului sau dacă starea verificării nu s-a putut scrie (garda a refuzat).
 * 13. Verificarea sub cursor are cursor propriu (gap_cui): fiecare rulare continuă de unde a rămas, deci nici
 *     un volum mare de CUI lipsă nu poate lăsa coada neverificată. Cât timp gap_cui > 0, verificarea e scadentă
 *     la fiecare rulare; când ajunge la capăt, gap_cui revine la 0 și următoarea verificare e peste 7 zile.
 *     Eșecuri consecutive (nu progres) : după 3, verificarea se amână 7 zile și mesajul avertizează.
 * 14. Refuzul gărzii este diferențiat: upsert refuzat = lease expirat (rularea se oprește, lotul e numărat eșuat);
 *     cursor refuzat = se citește last_cui: dacă e deja >= ultimul CUI al lotului, cursorul era avansat (benign,
 *     datele sunt scrise); altfel înseamnă lease expirat (eșec).
 * 15. Rezultatul fiecărui setState() este verificat; refuz = lease expirat => rularea se oprește.
 * 16. S.checked numără doar CUI cu rezultat persistat și validat.
 * 17. Frecvența cron-ului NU se schimbă în aceste versiuni. Regula de trecere la cron de 10 minute: vezi pct. 33.
 *
 * Schimbări în v1.9 (față de v1.8):
 * 18. Reinterogarea not_found pentru firme NOI. Un răspuns "not_found" la prima interogare nu mai e definitiv:
 *     CUI-ul intră în maison_anaf_retry și e reinterogat după 1, 3, 7 și 14 zile de la prima vedere.
 *     Găsit => se salvează rezultatul și se scoate din retry; după a 4-a încercare rămâne not_found final.
 *     Se aplică DOAR rândurilor scrise de v1.9 încolo. Rândurile not_found existente (istoric) NU sunt
 *     reinterogate automat: numărul lor nu a fost măsurat, iar reinterogarea lor ar fi o interogare în masă.
 *     Faza retry folosește același lot validat strict și aceeași gardă de lease, în aceeași tranzacție cu scrierea.
 *
 * Corecție în v2.0 (față de v1.9) — PFA:
 * 19. Din v1.1 până la v1.9, filtrul "top = 1" excludea TOATE persoanele fizice: în onrc_firme, cele 473.876 de
 *     rânduri PFA/II/IF au top = 0 (măsurat pe baza reală: top=0 => persoana_fizica=1; top=1 => persoana_fizica=0),
 *     deci INCLUDE_PFA = true nu avea efect. Acum, cu INCLUDE_PFA = true nu se mai filtrează nici top, nici
 *     persoana_fizica; cu false se păstrează doar top = 1 și persoana_fizica = 0.
 *     Verificat pe D1 real: SELECT-ul pe cursor citește 5.001 rânduri pentru 5.000 de CUI; planul de execuție
 *     al verificării sub cursor folosește ix_onrc_firme_cui (SEARCH cui>? AND cui<?).
 *     Consecință: backlogul crește cu CUI-urile PFA de peste cursor (numărul nu a fost măsurat).
 *
 * Schimbări în v2.1 (față de v2.0), după revizuire:
 * 20. Instrucțiunile din faza retry nu mai sunt toate "critice". Upsert-ul în maison_anaf_phone și INSERT-ul
 *     din maison_anaf_retry (ADD) sunt critice: zero modificări => lease expirat => rularea se oprește.
 *     UPDATE (AGAIN) și DELETE (DONE) pe maison_anaf_retry pot avea zero modificări legitim (rând lipsă): se
 *     notează ("fara efect"), nu se atribuie pierderii lease-ului. Datele telefon sunt oricum scrise și protejate.
 * 21. Reîncercările sunt limitate explicit: SQL_RETRY_DUE cere și attempts < 4 (pe lângă next_at <= azi).
 * 22. Mărimea tranzacției D1: instrucțiunile unui lot ANAF se trimit în grupuri de cel mult 1.000 (CHUNK).
 *     Cursorul se adaugă doar la ultimul grup (maximum 1.001, dimensiune dovedită în producție de v1.0).
 *     Un lot ANAF de 1.000 CUI cu retry poate produce până la 2.000 de instrucțiuni; acum se împart în 2 grupuri,
 *     cu cursorul ULTIMUL: dacă un grup eșuează, cursorul nu avansează, iar reluarea e idempotentă (upsert).
 *     MAX_BATCH (ANAF) rămâne 1.000.
 * 23. Buget de timp (wall time): nu se mai începe un lot nou după RUN_BUDGET_MS = 10 min. Cron Triggers au
 *     15 min wall time; rularea se încheie curat, cursorul rămâne neschimbat pentru lotul neînceput.
 *
 * Schimbări în v2.2-v2.3, după revizuire:
 * 24. Date mai noi nu pot fi suprascrise de date mai vechi: upsert-ul în maison_anaf_phone actualizează un rând
 *     existent doar dacă queried_at nou >= queried_at existent. Dacă o scriere critică are zero modificări, se
 *     verifică lease-ul: pierdut => rularea se oprește; încă valid => rezultate mai vechi ignorate (notat).
 * 25. Progresul verificării sub cursor se salvează și când rularea se oprește la buget de timp, la eșec sau la
 *     pană ANAF: gap_cui = ultimul CUI din ultimul lot reușit (cu garda de lease).
 * 27. maison_anaf_retry se sincronizează cu starea PERSISTATĂ din maison_anaf_phone, nu cu răspunsul ANAF din
 *     memorie: ADD și AGAIN se execută doar dacă rândul curent din maison_anaf_phone are status = 'not_found';
 *     DONE doar dacă statusul persistat nu mai este 'not_found'.
 * 28. queried_at ordonează MOMENTELE interogării; nu dovedește prospețimea datelor din sursa ANAF.
 *
 * Schimbări în v2.4-v2.5:
 * 30. Notificarea Telegram din v1.0 a fost ELIMINATĂ în v2.4. (În v2.6 revine DOAR pentru pana ANAF, pct. 34.)
 *     Raportul fiecărei rulări rămâne în maison_anaf_runs (run_at, checked, found, missing, failed, detail).
 * 31. Plafonul GLOBAL este 5.000 CUI pe rulare (cursor + retry + gap la un loc), nu 5.000 pe fază.
 *     RUN_LIMIT (opțional) îl poate doar COBORÎ sub 5.000; nu îl poate crește.
 *
 * Schimbări în v2.6 (față de v2.5), după revizuire:
 * 32. ORDINEA FAZELOR (înlocuită în v2.7, pct. 38: retry rezervat -> cursor -> gap). Backlogul PFA de sub cursor
 *     (până la 473.876 CUI, nemăsurat exact) consuma în v2.5 tot plafonul de 5.000 în fiecare rulare, iar firmele
 *     NOI (peste cursor) și reîncercările ar fi așteptat zile sau luni. Acum firmele noi au prioritate, iar
 *     verificarea sub cursor primește ce rămâne din plafon. Starea gap_cui / last_gap_check funcționează la fel.
 * 33. FILTRU DE INTERVAL pentru CUI în SQL_CURSOR: cui între 1 și 9.999.999.999 (CUI românesc: maximum 10 cifre).
 *     Măsurat pe D1 (25 oct 2026): 1 rând cu CUI de 13 cifre (2760325463043, arată a CNP) și 306 rânduri cu CUI
 *     nul sau <= 0. Fără filtru, valorile uriașe ar ajunge la ANAF la capătul cursorului și un răspuns lipsă ar
 *     bloca cursorul pentru totdeauna (validarea strictă, pct. 11).
 *     LIMITA DE CPU: un Cron Trigger cu interval sub o oră are 30 s de CPU pe invocare (la interval >= 1 oră: 15 min).
 *     Așteptarea după ANAF și D1 NU e CPU; parsarea JSON și construirea instrucțiunilor da. Regulă: se trece la
 *     cron de 10 minute NUMAI după ce prima rulare reală (cron zilnic) arată cpu_time_ms bine sub 30 s
 *     (Cloudflare -> Workers -> maison-anaf-daily -> Observability). Dacă e aproape de 30 s, se coboară plafonul
 *     (RUN_LIMIT=2500 sau 2000). Worker-ul nu își poate măsura singur CPU-ul.
 * 34. ÎNTRERUPĂTOR ANAF (pană/mentenanță, inclusiv weekend și sărbători):
 *     - Pană = ANAF nu răspunde la un lot (timeout, eroare de rețea, 429/5xx, corp non-JSON sau structură
 *       neașteptată) după 3 încercări. Un 4xx (în afară de 429) NU e pană (cerere greșită) și un răspuns
 *       incoerent NU e pană (problemă de date).
 *     - La declarare: se salvează anaf_down_since / anaf_next_try / anaf_down_count în maison_anaf_state, rularea
 *       se oprește, se scrie "ANAF INDISPONIBIL" în maison_anaf_runs și se trimite O notificare Telegram.
 *     - Primul retry după 1 oră. Dacă ANAF tot nu răspunde: verificare O DATĂ PE ZI la 07:00 ora București
 *       (calculată cu fusul Europe/Bucharest, tot anul, inclusiv la schimbarea orei; v2.7, pct. 40), cel puțin
 *       6 ore după încercarea anterioară, până revine.
 *     - Verificarea (probe) trimite UN SINGUR CUI (PROBE_CUI), nu un lot. Până la scadență, rulările de cron
 *       (chiar la 10 minute) se termină imediat: 2-3 citiri mici din maison_anaf_state, fără apel ANAF, fără rând
 *       în maison_anaf_runs.
 *     - La primul răspuns bun: starea de pană se șterge, se scrie "ANAF disponibil din nou", se trimite O
 *       notificare Telegram și procesarea continuă în aceeași rulare.
 *     - Telegram: variabile secrete TELEGRAM_BOT_TOKEN și TELEGRAM_CHAT_ID (Cloudflare Secrets). Lipsesc =>
 *       fără notificare, doar nota din maison_anaf_runs. Mesajele NU conțin CUI-uri sau telefoane, iar
 *       tokenul nu apare niciodată în log sau în detail.
 *
 * Schimbări în v2.7 (față de v2.6), după audit critic:
 * 35. PROBA de revenire validează răspunsul: CUI-ul de test (PROBE_CUI) trebuie să apară EXACT O DATĂ în found SAU
 *     în notFound (aceeași validare ca la loturi). Un răspuns {"found":[],"notFound":[]} NU mai declară revenirea
 *     (în v2.6 o declara, a fost confirmat prin test).
 * 36. Clasificarea erorilor ANAF (fetchAnaf): rețea, HTTP (429/5xx), non-JSON, structură neașteptată — TOATE se
 *     reîncearcă de 3 ori înainte de a declara pana (v2.6 declara pana după prima încercare la structură
 *     neașteptată, contrar antetului). Mesajul spune cauza; pentru structură neașteptată, textul Telegram
 *     spune „format neașteptat (posibilă schimbare de API)”, nu doar „indisponibil”.
 *     HTTP 4xx (în afară de 429) = respingere: oprește restul rulării (nu mai apelează ANAF în fazele următoare).
 *     Răspunsul incoerent (CUI lipsă/duplicat) și erorile D1 NU opresc fazele următoare (problemă de date, nu de server).
 * 37. Raport: nota finală arată selectate / procesate / eșuate / NEPROCESATE. Mesajul pentru scrieri fără efect
 *     (lease valid) spune „rezultat existent mai nou sau retry neaplicabil”, nu doar „rezultate mai vechi”.
 * 38. ORDINEA FAZELOR: retry rezervat -> cursor -> gap. Retry primește cel mult RETRY_RESERVE = 500 CUI pe rulare
 *     (doar cât sunt scadente); cursorul primește restul plafonului de 5.000; gap primește ce rămâne.
 *     Motiv: cu ~857.000 CUI peste cursor, cursorul ar fi consumat tot plafonul ~29 de ore (la cron de 10 minute) și
 *     reîncercările scadente ale firmelor noi ar fi așteptat. Decizia: fondatorul, 25 oct 2026.
 * 39. (rezervat)
 * 40. VERIFICAREA ZILNICĂ la 07:00 ORA BUCUREȘTI, tot anul: ora se calculează cu fusul Europe/Bucharest
 *     (v2.6 folosea 05:00 UTC = 08:00 vara). Dacă Intl nu e disponibil, revine la 05:00 UTC.
 *
 * ATENȚIE: nu ștergeți indexul ix_onrc_firme_cui (interogările îl cer explicit).
 *          Duplicatul ix_onrc_cui_top poate fi șters.
 *
 * Reads CUI from onrc_firme; writes candidate phone numbers to a separate table.
 * Does NOT publish numbers or send them in notifications.
 */
const ANAF_URL = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";
const MAX_BATCH = 1000; // dovedit functional în producție (vezi pct. 4 din antet)
const LEASE_MS = 4 * 60 * 1000; // > cel mai lung apel ANAF posibil (78 s) cu marjă mare
const READ_WARN = 50000; // peste acest număr de rânduri citite de SELECT-ul pe cursor => avertisment
const GAP_DAYS = 7; // la câte zile se caută firme noi cu CUI sub cursor
const GAP_MAX_TRIES = 3; // rulări consecutive permise fără ca verificarea să se termine
const LIMIT = 5000; // plafon GLOBAL de CUI pe rulare (cursor + retry + gap la un loc)
const CHUNK = 1000; // instrucțiuni per db.batch (1.001 cu cursorul = dimensiune dovedită în v1.0)
const RUN_BUDGET_MS = 10 * 60 * 1000; // nu se mai începe un lot nou după 10 min
const MAX_CUI = 9999999999; // CUI românesc: maximum 10 cifre (pct. 33)

// Întrerupător ANAF (pct. 34)
const PROBE_CUI = 51415878; // CUI de test (AiVenture S.R.L.); verificarea trimite doar acesta
const FIRST_RETRY_MS = 60 * 60 * 1000; // prima reîncercare după 1 oră
const PROBE_TZ = "Europe/Bucharest"; // verificarea zilnică la 07:00 ora locală, tot anul (pct. 40)
const PROBE_HOUR_LOCAL = 7;
const PROBE_FALLBACK_HOUR_UTC = 5; // doar dacă Intl nu funcționează
const PROBE_MIN_GAP_MS = 6 * 60 * 60 * 1000; // dar cel puțin 6 ore după încercarea anterioară
const RETRY_RESERVE = 500; // CUI rezervate pe rulare pentru reîncercările scadente (pct. 38)

// Persoane fizice (PFA, II, IF): INCLUSE, la decizia explicită a fondatorului (25 oct 2026).
// Scop: analiză economică INTERNĂ. Tabelul maison_anaf_phone NU trebuie expus public;
// în FirmsFinder, PFA rămân mascate pentru public. Colectarea telefoanelor persoanelor fizice
// necesită un temei documentat (interes legitim) în registrul de prelucrări GDPR.
// Pentru excludere: schimbați în false.
const INCLUDE_PFA = true;

export default {
  async scheduled(event, env, ctx) {
    await run(env, `cron:${event.cron}`);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ok:true, service:"maison-anaf", mode:"scheduled", timestamp:new Date().toISOString()});
    }
    if (url.pathname === "/test-telegram") {
      if (request.method !== "POST") return new Response("Method not allowed", {status:405});
      const expected = env.TELEGRAM_TEST_KEY;
      const supplied = request.headers.get("X-Test-Key");
      if (!expected || !supplied || !safeEqual(supplied, expected)) return new Response("Unauthorized", {status:401});
      const notes = [];
      const T = { note: (m) => notes.push(m) };
      const ok = await notifyTelegram(T, env,
        "TEST MAISON-ANAF v2.8\nCloudflare Worker -> Telegram\n" + new Date().toISOString());
      return Response.json({ok, notes}, {status: ok ? 200 : 502});
    }
    return new Response("Not found", {status:404});
  }
};

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function setup(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS maison_anaf_phone (
      cui INTEGER PRIMARY KEY,
      phone TEXT,
      status TEXT NOT NULL,
      source_url TEXT NOT NULL,
      queried_at TEXT NOT NULL,
      anaf_data_date TEXT NOT NULL,
      error TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS maison_anaf_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS maison_anaf_lock (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS maison_anaf_retry (
      cui INTEGER PRIMARY KEY,
      first_seen TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS ix_maison_anaf_retry_next ON maison_anaf_retry(next_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS maison_anaf_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      checked INTEGER NOT NULL,
      found INTEGER NOT NULL,
      missing INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      detail TEXT
    )`)
  ]);
}


function isoDay() { return new Date().toISOString().slice(0,10); }
function digits(v) { return String(v ?? "").replace(/\D/g,""); }
function validPhone(v) {
  const raw=String(v??"").trim();
  return digits(raw).length>=9 && digits(raw).length<=15 ? raw : null;
}
// Eroarea aruncată după 3 încercări eșuate din motive de disponibilitate poartă anafOutage=true și anafKind:
//   "network" (rețea/timeout), "http" (429/5xx), "nonjson" (corp care nu e JSON), "schema" (JSON fără found/notFound).
// 4xx (în afară de 429) NU e pană: se aruncă imediat, fără anafOutage (respingere a cererii).
async function fetchAnaf(batch, date) {
  let lastError;
  for (let attempt=1; attempt<=3; attempt++) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(), 25000);
    try {
      const res=await fetch(ANAF_URL,{
        method:"POST", headers:{"Content-Type":"application/json","Accept":"application/json"},
        body:JSON.stringify(batch.map(cui=>({cui,data:date}))),
        signal:controller.signal
      });
      if(!res.ok) {
        const message=`ANAF HTTP ${res.status}: ${(await res.text()).slice(0,250)}`;
        throw new Error(message);
      }
      const body=await res.json();
      if(!Array.isArray(body?.found) || !Array.isArray(body?.notFound))
        throw new Error("Unexpected ANAF JSON structure; no data persisted");
      return body;
    } catch(e) {
      const msg=String(e?.message||e);
      if(/^ANAF HTTP 4(?!29)/.test(msg)) throw e; // 4xx în afară de 429: respingere, nu pană
      lastError=e;
      let kind;
      if(msg.startsWith("ANAF HTTP")) kind="http";
      else if(msg.startsWith("Unexpected ANAF")) kind="schema";
      else if(e && e.name==="SyntaxError") kind="nonjson";
      else kind="network";
      try { if(e && typeof e==="object") e.anafKind=kind; } catch(_) {}
    } finally {clearTimeout(timer);}
    if(attempt<3) await new Promise(resolve=>setTimeout(resolve,1000*attempt));
  }
  if(lastError && typeof lastError==="object") { try { lastError.anafOutage=true; } catch(_) {} }
  throw lastError;
}

// v1.5: același ceas (SQLite) la achiziție, reînnoire și gardă => fără decalaj între Worker și D1.
const NOW_MS = `CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`;
async function acquireLease(db, owner) {
  const row=await db.prepare(`
    INSERT INTO maison_anaf_lock(name,owner,expires_at) VALUES('daily',?,${NOW_MS} + ?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
    WHERE maison_anaf_lock.expires_at <= ${NOW_MS}
    RETURNING owner
  `).bind(owner,LEASE_MS).first();
  return row?.owner===owner;
}
async function renewLease(db, owner) {
  const row=await db.prepare(`
    UPDATE maison_anaf_lock SET expires_at=${NOW_MS} + ?
    WHERE name='daily' AND owner=? AND expires_at>${NOW_MS}
    RETURNING owner
  `).bind(LEASE_MS,owner).first();
  if(row?.owner!==owner) throw new Error("Lease lost: refusing stale write");
}
// Lease-ul este încă valid? (citire; nu îl reînnoiește). Folosit ca să deosebim "lease pierdut" de "rezultat mai vechi ignorat".
async function leaseValid(db, owner) {
  const row=await db.prepare(`SELECT owner FROM maison_anaf_lock WHERE name='daily' AND owner=? AND expires_at > ${NOW_MS}`).bind(owner).first();
  return row?.owner===owner;
}
async function releaseLease(db, owner) {
  await db.prepare("DELETE FROM maison_anaf_lock WHERE name='daily' AND owner=?").bind(owner).run();
}

// Garda atomică: se evaluează în aceeași tranzacție cu scrierea, pe ceasul SQLite.
// Ultimul parametru legat în fiecare instrucțiune care o folosește = owner.
const LEASE_OK = `EXISTS (SELECT 1 FROM maison_anaf_lock WHERE name='daily' AND owner=? AND expires_at > CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`;

const SQL_UPSERT = `
  INSERT INTO maison_anaf_phone(cui,phone,status,source_url,queried_at,anaf_data_date,error)
  SELECT ?,?,?,?,?,?,NULL
  WHERE ${LEASE_OK}
  ON CONFLICT(cui) DO UPDATE SET
    phone=excluded.phone,status=excluded.status,source_url=excluded.source_url,
    queried_at=excluded.queried_at,anaf_data_date=excluded.anaf_data_date,error=NULL
  WHERE excluded.queried_at >= maison_anaf_phone.queried_at`;

// Cursorul avansează doar înainte (nu poate fi coborât de o rulare întârziată).
const SQL_CURSOR_SET = `
  INSERT INTO maison_anaf_state(key,value)
  SELECT 'last_cui', ?
  WHERE ${LEASE_OK}
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
  WHERE CAST(excluded.value AS INTEGER) > CAST(maison_anaf_state.value AS INTEGER)`;

const SQL_STATE_SET = `
  INSERT INTO maison_anaf_state(key,value)
  SELECT ?, ?
  WHERE ${LEASE_OK}
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`;

// Retry not_found (v1.9). Programare: reîncercări la 1, 3, 7, 14 zile după first_seen.
// INSERT: no-op la conflict (UPDATE cu aceeași valoare => changes=1, ca să nu fie confundat cu refuz de gardă).
const SQL_RETRY_ADD = `
  INSERT INTO maison_anaf_retry(cui,first_seen,attempts,next_at)
  SELECT ?, ?, 0, date(?, '+1 day')
  WHERE EXISTS (SELECT 1 FROM maison_anaf_phone p WHERE p.cui = ? AND p.status = 'not_found')
    AND ${LEASE_OK}
  ON CONFLICT(cui) DO UPDATE SET first_seen=maison_anaf_retry.first_seen`;
// În UPDATE, "attempts" din CASE este valoarea veche: noua valoare = attempts+1.
const SQL_RETRY_AGAIN = `
  UPDATE maison_anaf_retry SET
    attempts = attempts + 1,
    next_at = CASE attempts + 1
      WHEN 1 THEN date(first_seen,'+3 days')
      WHEN 2 THEN date(first_seen,'+7 days')
      WHEN 3 THEN date(first_seen,'+14 days')
      ELSE '9999-12-31' END
  WHERE cui = ?
    AND EXISTS (SELECT 1 FROM maison_anaf_phone p WHERE p.cui = ? AND p.status = 'not_found')
    AND ${LEASE_OK}`;
// Se șterge doar dacă rezultatul persistat nu mai este not_found.
const SQL_RETRY_DONE = `
  DELETE FROM maison_anaf_retry
  WHERE cui = ?
    AND EXISTS (SELECT 1 FROM maison_anaf_phone p WHERE p.cui = ? AND p.status <> 'not_found')
    AND ${LEASE_OK}`;
const SQL_RETRY_DUE = `
  SELECT cui FROM maison_anaf_retry WHERE next_at <= ? AND attempts < 4 ORDER BY next_at, cui LIMIT ?`;

// Fără CAST; INDEXED BY forțează indexul pe cui (fără el, planificatorul alege ix_onrc_top_den
// și citește ~1,3 milioane de rânduri). v2.6: și limita superioară MAX_CUI (pct. 33).
// Parametri: last_cui, includePfa, limit.
const SQL_CURSOR = `
  SELECT DISTINCT cui
  FROM onrc_firme INDEXED BY ix_onrc_firme_cui
  WHERE cui > ? AND cui <= ${MAX_CUI} AND (? = 1 OR (top = 1 AND (persoana_fizica IS NULL OR persoana_fizica = 0)))
  ORDER BY cui ASC LIMIT ?`;

// Firme noi cu CUI sub cursor (nu au rând în maison_anaf_phone). Rulează doar la GAP_DAYS zile sau cât gap_cui > 0.
const SQL_GAP = `
  SELECT DISTINCT o.cui AS cui
  FROM onrc_firme o INDEXED BY ix_onrc_firme_cui
  WHERE o.cui > ? AND o.cui <= ?
    AND (? = 1 OR (o.top = 1 AND (o.persoana_fizica IS NULL OR o.persoana_fizica = 0)))
    AND NOT EXISTS (SELECT 1 FROM maison_anaf_phone p WHERE p.cui = o.cui)
  ORDER BY o.cui ASC LIMIT ?`;

async function getState(db, key) {
  const r=await db.prepare("SELECT value FROM maison_anaf_state WHERE key=?").bind(key).first();
  return r?.value ?? null;
}
// Scriere de stare protejată de garda de lease. Returnează true dacă s-a scris.
async function setState(S, key, value) {
  const r=await S.db.prepare(SQL_STATE_SET).bind(key,String(value),S.owner).run();
  S.writeTotal+=Number(r.meta?.rows_written ?? 0);
  return Number(r.meta?.changes ?? 0)===1;
}
// Mai multe chei, în ordine; se oprește la primul refuz. Returnează true dacă toate s-au scris.
async function setStates(S, pairs) {
  for(const [k,v] of pairs) if(!(await setState(S,k,v))) return false;
  return true;
}

// ---- Întrerupător ANAF + Telegram (pct. 34) ----
function fmtTs(ms) {
  try {
    return new Date(ms).toLocaleString("ro-RO",{timeZone:"Europe/Bucharest",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  } catch(_) { return new Date(ms).toISOString(); }
}
// Decalajul (ms) al fusului PROBE_TZ față de UTC la momentul dat (include ora de vară).
function tzOffsetMs(utcMs) {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:PROBE_TZ,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).formatToParts(new Date(utcMs));
  const g=(t)=>Number(parts.find(x=>x.type===t).value);
  return Date.UTC(g("year"),g("month")-1,g("day"),g("hour"),g("minute"),g("second")) - Math.floor(utcMs/1000)*1000;
}
// Momentul UTC (ms) în care e ora h:00 locală în ziua (y, m 0-based, d). d poate depăși luna (se normalizează).
function localToUtcMs(y, m, d, h) {
  const guess=Date.UTC(y,m,d,h,0,0);
  let t=guess-tzOffsetMs(guess);
  t=guess-tzOffsetMs(t); // a doua trecere, pentru zilele de schimbare a orei
  return t;
}
// Următoarea verificare zilnică la PROBE_HOUR_LOCAL ora București, cel puțin PROBE_MIN_GAP_MS după momentul dat.
function nextProbeMs(nowMs) {
  try {
    const parts=new Intl.DateTimeFormat("en-US",{timeZone:PROBE_TZ,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(nowMs));
    const g=(t)=>Number(parts.find(x=>x.type===t).value);
    const y=g("year"), m=g("month")-1, d=g("day");
    for(let k=0;k<4;k++) {
      const t=localToUtcMs(y,m,d+k,PROBE_HOUR_LOCAL);
      if(t-nowMs>=PROBE_MIN_GAP_MS) return t;
    }
  } catch(_) { /* Intl indisponibil: cădem pe regula UTC */ }
  const dt=new Date(nowMs);
  let t=Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate(),PROBE_FALLBACK_HOUR_UTC,0,0);
  while(t-nowMs<PROBE_MIN_GAP_MS) t+=86400000;
  return t;
}
// Trimite un mesaj Telegram. Nu pune niciodată tokenul sau textul erorii în note (URL-ul conține tokenul).
async function notifyTelegram(S, env, text) {
  const token=env.TELEGRAM_BOT_TOKEN, chat=env.TELEGRAM_CHAT_ID;
  if(!token || !chat) { S.note("Telegram nesetat (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID): fara notificare"); return false; }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(), 10000);
  try {
    const res=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:chat,text,disable_web_page_preview:true}),
      signal:controller.signal
    });
    if(!res.ok) { S.note(`Telegram: HTTP ${res.status}`); return false; }
    S.note("Telegram: notificare trimisa");
    return true;
  } catch(e) {
    S.note(`Telegram: eroare ${e && e.name ? e.name : "necunoscuta"}`);
    return false;
  } finally { clearTimeout(timer); }
}
// Declară pana (prima dată). Se apelează doar când nu exista deja o pană declarată.
async function declareOutage(S, env, reason, kind) {
  const nowMs=Date.now();
  const next=nowMs+FIRST_RETRY_MS;
  const ok=await setStates(S,[["anaf_down_since",new Date(nowMs).toISOString()],["anaf_down_count","1"],["anaf_next_try",String(next)]]);
  const what = kind==="schema" ? "ANAF A RASPUNS INTR-UN FORMAT NEASTEPTAT (posibila schimbare de API)" : "ANAF INDISPONIBIL";
  S.note(`${what} [${kind||"network"}]: ${reason}; urmatoarea verificare ${fmtTs(next)}` + (ok ? "" : " (starea NU s-a scris: lease expirat)"));
  if(ok) await notifyTelegram(S,env,`⚠️ MAISON–ANAF: ${what} (din ${fmtTs(nowMs)}). Urmatoarea verificare: ${fmtTs(next)}. Procesarea este oprita pana revine.`);
}

// Indexează un răspuns ANAF pentru CUI-urile cerute (set "asked"). Returnează numărul de duplicate.
function indexAnaf(asked, result, foundMap, notFound) {
  let dup=0;
  for(const x of result.found) {
    const c=Number(x?.date_generale?.cui);
    if(!asked.has(c)) continue;
    if(foundMap.has(c)) dup++;
    foundMap.set(c,x);
  }
  for(const x of result.notFound) {
    const c=Number(typeof x==="object" ? (x.cui??x.CUI) : x);
    if(!asked.has(c)) continue;
    if(notFound.has(c)) dup++;
    notFound.add(c);
  }
  return dup;
}
function classifyAnaf(batch, foundMap, notFound) {
  let both=0; const missing=[];
  for(const cui of batch) {
    const f=foundMap.has(cui), n=notFound.has(cui);
    if(f && n) both++; else if(!f && !n) missing.push(cui);
  }
  return {both, missing};
}

// Procesează o listă de CUI în loturi. Returnează:
//   "ok"     = toate loturile au reușit
//   "fail"   = un lot a eșuat (răspuns incoerent / 4xx / eroare D1); nimic scris pentru lot, cursorul neschimbat
//   "stop"   = lease pierdut sau cursor deja avansat; rularea nu mai scrie nimic
//   "budget" = bugetul de timp a fost atins; restul se reia la rularea următoare
//   "outage" = ANAF indisponibil (pct. 34); S.outageReason / S.outageKind au motivul; nimic scris pentru lotul curent
//   "reject" = ANAF a respins cererea cu 4xx (nu 429); nimic scris pentru lot; restul rulării se oprește (pct. 36)
async function processRows(S, rows, mode) {
  for(let i=0;i<rows.length;i+=MAX_BATCH) {
    if(Date.now()-S.t0>RUN_BUDGET_MS) {
      S.budget=true;
      S.note(`Buget de timp ${RUN_BUDGET_MS/60000} min atins (${mode}): restul se reia la rularea urmatoare`);
      return "budget";
    }
    const batch=rows.slice(i,i+MAX_BATCH).map(x=>Number(x.cui));
    try {
      await renewLease(S.db,S.owner);
      const result=await fetchAnaf(batch,S.day);

      // Validare strictă ÎNAINTE de orice scriere: fiecare CUI cerut, exact un rezultat explicit.
      const foundMap=new Map(); const notFound=new Set();
      let dup=indexAnaf(new Set(batch),result,foundMap,notFound);
      let cls=classifyAnaf(batch,foundMap,notFound);
      if(dup===0 && cls.both===0 && cls.missing.length>0) {
        // O singură recerere, doar pentru CUI fără răspuns.
        const again=await fetchAnaf(cls.missing,S.day);
        dup+=indexAnaf(new Set(cls.missing),again,foundMap,notFound);
        cls=classifyAnaf(batch,foundMap,notFound);
      }
      if(dup>0 || cls.both>0 || cls.missing.length>0) {
        throw new Error(`Raspuns ANAF incoerent (duplicate=${dup}, in ambele liste=${cls.both}, fara raspuns=${cls.missing.length}/${batch.length}); nicio scriere, cursorul nu avanseaza`);
      }

      const statements=[]; const kinds=[]; // kinds: "crit" (upsert / retry ADD) sau "soft" (retry AGAIN / DONE)
      let batchFound=0, batchMissing=0;
      for(const cui of batch) {
        const record=foundMap.get(cui);
        const phone=validPhone(record?.date_generale?.telefon);
        const status=record ? (phone?"candidate":"missing_phone") : "not_found";
        if(phone) batchFound++; else batchMissing++;
        statements.push(S.db.prepare(SQL_UPSERT).bind(cui,phone,status,ANAF_URL,S.now,S.day,S.owner)); kinds.push("crit");
        // v1.9: not_found pentru firme noi => retry programat; în faza retry, găsit => scos, tot not_found => următoarea încercare.
        if(status==="not_found") {
          if(mode==="retry") { statements.push(S.db.prepare(SQL_RETRY_AGAIN).bind(cui,cui,S.owner)); kinds.push("soft"); }
          else { statements.push(S.db.prepare(SQL_RETRY_ADD).bind(cui,S.day,S.day,cui,S.owner)); kinds.push("crit"); }
        }
        // În faza retry: dacă rezultatul PERSISTAT nu mai e not_found, reîncercarea se șterge.
        if(mode==="retry") { statements.push(S.db.prepare(SQL_RETRY_DONE).bind(cui,cui,S.owner)); kinds.push("soft"); }
      }
      // Cursorul avansează doar în faza "cursor"; verificarea sub cursor nu îl mută niciodată.
      // Instrucțiunile se trimit în grupuri de cel mult CHUNK; cursorul e ULTIMA instrucțiune, în ultimul grup.
      const cursorStmt = mode==="cursor" ? S.db.prepare(SQL_CURSOR_SET).bind(String(batch[batch.length-1]),S.owner) : null;
      const wr=[];
      for(let k=0;k<statements.length;k+=CHUNK) {
        await renewLease(S.db,S.owner);
        const part=statements.slice(k,k+CHUNK);
        if(cursorStmt && k+CHUNK>=statements.length) part.push(cursorStmt);
        wr.push(...await S.db.batch(part));
      }
      for(const r of wr) {
        S.readTotal+=Number(r.meta?.rows_read ?? 0);
        S.writeTotal+=Number(r.meta?.rows_written ?? 0);
      }
      let refusedCrit=0, softZero=0;
      for(let q=0;q<statements.length;q++) {
        if(Number(wr[q]?.meta?.changes ?? 0)===0) { if(kinds[q]==="crit") refusedCrit++; else softZero++; }
      }
      if(refusedCrit>0) {
        if(!(await leaseValid(S.db,S.owner))) {
          S.failed+=batch.length;
          S.note(`Batch starting CUI ${batch[0]} (${mode}): ${refusedCrit} scrieri refuzate (lease expirat); rularea se opreste`);
          return "stop";
        }
        // Lease valid: zero modificări = rezultat existent mai nou (queried_at) sau retry neaplicabil (statusul persistat nu mai e not_found).
        S.note(`${refusedCrit} scrieri fara efect (rezultat existent mai nou sau retry neaplicabil), ignorate (${mode})`);
      }
      if(softZero>0) S.note(`${softZero} instructiuni retry fara efect (rand lipsa in maison_anaf_retry)`);
      if(mode==="cursor" && Number(wr[wr.length-1]?.meta?.changes ?? 0)===0) {
        // Cursor refuzat: ori era deja avansat (benign), ori lease-ul a expirat între instrucțiuni.
        const lastCui=batch[batch.length-1];
        const cur=Number((await getState(S.db,"last_cui")) || 0);
        if(cur>=lastCui) {
          S.checked+=batch.length; S.found+=batchFound; S.missing+=batchMissing;
          S.note(`Cursorul era deja la CUI ${cur} (>= ${lastCui}); datele lotului s-au scris; rularea se opreste`);
        } else {
          S.failed+=batch.length;
          S.note(`Cursor refuzat dar last_cui=${cur} < ${lastCui}: lease expirat; datele lotului pot fi scrise, cursorul NU a avansat; rularea se opreste`);
        }
        return "stop";
      }
      S.checked+=batch.length;
      S.found+=batchFound;
      S.missing+=batchMissing;
      if(mode==="gap") S.gapLast=batch[batch.length-1];
    } catch(e) {
      S.failed+=batch.length;
      S.note(`Batch starting CUI ${batch[0]} (${mode}) failed: ${String(e.message||e).slice(0,250)}`);
      // Do not advance cursor on failure. Retry next run.
      if(e && e.anafOutage) { S.outageReason=String(e.message||e).slice(0,120); S.outageKind=e.anafKind||"network"; return "outage"; }
      const em=String(e.message||e);
      if(em.startsWith("Lease lost")) return "stop";
      if(em.startsWith("ANAF HTTP 4")) return "reject"; // 4xx (nu 429): cerere respinsă; restul rulării se oprește
      return "fail";
    }
  }
  return "ok";
}

async function run(env, trigger) {
  const db=env.DB;
  const day=isoDay(), now=new Date().toISOString();
  const S={db, day, now, owner:crypto.randomUUID(), checked:0, found:0, missing:0, failed:0, readTotal:0, writeTotal:0, detail:"", t0:Date.now(), budget:false, gapLast:0, selected:0, cap:LIMIT, quiet:false, outageReason:"", outageKind:""};
  { const rl=Math.floor(Number(env.RUN_LIMIT)); if(rl>0) S.cap=Math.min(rl,LIMIT); }
  const phaseLimit=()=>Math.min(LIMIT,S.cap-S.selected); // plafon per fază, limitat de plafonul global
  S.note=(s)=>{ S.detail = S.detail ? S.detail + " | " + s : s; };
  const includePfa = INCLUDE_PFA ? 1 : 0;
  let leaseHeld=false;
  try {
    await setup(db);
    leaseHeld=await acquireLease(db,S.owner);
    if(!leaseHeld) {
      console.log(JSON.stringify({checked:0,found:0,missing:0,failed:0,detail:"Skipped: another run owns the lease"}));
      return;
    }

    // Întrerupător ANAF (pct. 34): pană declarată => pauză până la scadență, apoi un singur CUI de test.
    let proceed=true;
    const downSince=(await getState(db,"anaf_down_since")) || "";
    if(downSince) {
      const nextTry=Number((await getState(db,"anaf_next_try")) || 0);
      if(Date.now()<nextTry) {
        S.quiet=true; proceed=false;
        S.note(`ANAF INDISPONIBIL din ${fmtTs(Date.parse(downSince))}; urmatoarea verificare ${fmtTs(nextTry)}; rularea nu apeleaza ANAF`);
      } else {
        let probeOk=false, leaseLostProbe=false, probeReason="";
        try {
          await renewLease(db,S.owner);
          const pr=await fetchAnaf([PROBE_CUI],day);
          // v2.7: CUI-ul de test trebuie să apară exact o dată în found SAU notFound (altfel nu e revenire).
          const pFound=new Map(), pNot=new Set();
          const pDup=indexAnaf(new Set([PROBE_CUI]),pr,pFound,pNot);
          const pCls=classifyAnaf([PROBE_CUI],pFound,pNot);
          if(pDup>0 || pCls.both>0 || pCls.missing.length>0) throw new Error("raspuns incomplet pentru CUI-ul de test");
          probeOk=true;
        } catch(e) {
          probeReason=String(e.message||e).slice(0,120);
          if(probeReason.startsWith("Lease lost")) leaseLostProbe=true;
        }
        if(probeOk) {
          const hours=((Date.now()-Date.parse(downSince))/3600000).toFixed(1);
          const cleared=await setStates(S,[["anaf_down_since",""],["anaf_next_try","0"],["anaf_down_count","0"]]);
          if(cleared) {
            S.note(`ANAF disponibil din nou (pana a durat ${hours} h); procesarea continua`);
            await notifyTelegram(S,env,`✅ MAISON–ANAF: ANAF disponibil din nou (pana a durat ${hours} h). Procesarea continua.`);
          } else {
            S.note("ANAF raspunde, dar starea de pana NU s-a sters (lease expirat); rularea se opreste");
            proceed=false;
          }
        } else if(leaseLostProbe) {
          S.note(`Verificare ANAF intrerupta: ${probeReason}`);
          proceed=false;
        } else {
          const cnt=Number((await getState(db,"anaf_down_count")) || 1)+1;
          const next=nextProbeMs(Date.now());
          const saved=await setStates(S,[["anaf_down_count",String(cnt)],["anaf_next_try",String(next)]]);
          S.note(`ANAF tot INDISPONIBIL (verificarea #${cnt} a esuat: ${probeReason}); urmatoarea verificare ${fmtTs(next)}` + (saved ? "" : " (starea NU s-a scris)"));
          proceed=false;
        }
      }
    }

    if(proceed) {
      const last=Number((await getState(db,"last_cui")) || 0);
      let ok=true;
      const halts=(st)=> st==="stop" || st==="budget" || st==="outage" || st==="reject";

      // Faza 1: reîncercări not_found scadente (1, 3, 7, 14 zile), cu rezervă de cel mult RETRY_RESERVE CUI (pct. 38).
      const rLim=Math.min(RETRY_RESERVE,phaseLimit());
      if(rLim>0) {
        const rsel=await db.prepare(SQL_RETRY_DUE).bind(day,rLim).all();
        const rRows=rsel.results || [];
        S.selected+=rRows.length;
        S.readTotal+=Number(rsel.meta?.rows_read ?? 0);
        if(rRows.length>0) S.note(`Retry not_found: ${rRows.length} CUI scadente (rezerva ${RETRY_RESERVE})`);
        const rStatus=await processRows(S,rRows,"retry");
        if(halts(rStatus)) ok=false;
        if(rStatus==="outage") await declareOutage(S,env,S.outageReason,S.outageKind);
      }

      // Faza 2: cursorul (CUI mai mari decât ultimul procesat) — firmele NOI, restul plafonului (pct. 32, 38).
      const cLim=phaseLimit();
      if(ok && cLim>0) {
        const sel=await db.prepare(SQL_CURSOR).bind(last,includePfa,cLim).all();
        const rows=sel.results || [];
        S.selected+=rows.length;
        const selRead=Number(sel.meta?.rows_read ?? 0);
        S.readTotal+=selRead;
        S.note(`SELECT cursor a citit ${selRead} randuri`);
        if(selRead>READ_WARN) S.note(`ATENTIE: peste ${READ_WARN} randuri citite, planul de executie s-a stricat; verificati indexul ix_onrc_firme_cui`);
        if(rows.length===0) S.note(`Niciun CUI nou dupa cursor (${last})`); // nu resetăm cursorul la 0
        const cStatus=await processRows(S,rows,"cursor");
        if(halts(cStatus)) ok=false;
        if(cStatus==="outage") await declareOutage(S,env,S.outageReason,S.outageKind);
      }

      // Faza 3: firme noi cu CUI sub cursor (gap), cu cursor propriu (gap_cui); primește ce rămâne din plafon.
      const lastGap=(await getState(db,"last_gap_check")) || "";
      const gapFrom=Number((await getState(db,"gap_cui")) || 0);
      const gapDue=gapFrom>0 || !lastGap || (Date.parse(day)-Date.parse(lastGap)) >= GAP_DAYS*86400000;
      const gLim=phaseLimit();
      if(ok && gapDue && gLim>0) {
        const gsel=await db.prepare(SQL_GAP).bind(gapFrom,last,includePfa,gLim).all();
        const gRows=gsel.results || [];
        S.selected+=gRows.length;
        const gRead=Number(gsel.meta?.rows_read ?? 0);
        S.readTotal+=gRead;
        S.note(`Verificare sub cursor (de la CUI ${gapFrom}): ${gRows.length} CUI nepreluate, ${gRead} randuri citite`);
        const gStatus=await processRows(S,gRows,"gap");
        if(gStatus!=="stop") {
          const progress = S.gapLast>gapFrom ? S.gapLast : 0; // ultimul CUI din ultimul lot reușit
          const complete=[["gap_cui","0"],["last_gap_check",day],["gap_tries","0"]];
          let stateOk;
          if(gStatus==="ok") {
            stateOk = gRows.length<gLim
              ? await setStates(S,complete)                                                  // capăt: verificarea s-a terminat
              : await setStates(S,[["gap_cui",String(gRows[gRows.length-1].cui)],["gap_tries","0"]]); // continuăm de la ultimul procesat
          } else if(gStatus==="budget" || gStatus==="outage") {
            stateOk = progress ? await setStates(S,[["gap_cui",String(progress)]]) : true;
          } else { // "fail" sau "reject"
            const tries=Number((await getState(db,"gap_tries")) || 0);
            if(tries+1>=GAP_MAX_TRIES) {
              stateOk=await setStates(S,complete);
              S.note(`ATENTIE: verificarea sub cursor a esuat ${GAP_MAX_TRIES} rulari consecutive; amanata cu ${GAP_DAYS} zile`);
            } else {
              const pairs=[["gap_tries",String(tries+1)]];
              if(progress) pairs.push(["gap_cui",String(progress)]);
              stateOk=await setStates(S,pairs);
            }
          }
          if(!stateOk) S.note("Starea verificarii sub cursor NU s-a scris (garda a refuzat: lease expirat); rularea se opreste");
        }
        if(gStatus==="outage") await declareOutage(S,env,S.outageReason,S.outageKind);
      }

      { const unproc=Math.max(0,S.selected-S.checked-S.failed);
        S.note(`Plafon pe rulare ${S.cap}: ${S.selected} selectati, ${S.checked} procesati, ${S.failed} esuati, ${unproc} neprocesate (se reiau la rularea urmatoare)`); }
      S.note(`Masurat: ${S.readTotal} randuri citite, ${S.writeTotal} scrise (SELECT + scrieri in lot si stare; fara lock/cursor-read/log)`);
    }
  } catch(e) {
    S.note(`Run failed: ${String(e.message||e).slice(0,300)}`);
  } finally {
    if(leaseHeld) {
      try {await releaseLease(db,S.owner);} catch(e) {
        S.note(`lease release failed: ${String(e.message||e).slice(0,100)}`);
      }
    }
  }
  // Rularea în pauză de pană nu scrie rând în maison_anaf_runs (ar fi 144 de rânduri identice pe zi).
  if(!S.quiet) {
    try {
      await db.prepare("INSERT INTO maison_anaf_runs(run_at,checked,found,missing,failed,detail) VALUES(?,?,?,?,?,?)")
        .bind(now,S.checked,S.found,S.missing,S.failed,S.detail).run();
    } catch(e) {S.note(`run log failed: ${String(e.message||e).slice(0,100)}`);}
  }
  console.log(JSON.stringify({checked:S.checked,found:S.found,missing:S.missing,failed:S.failed,detail:S.detail}));
}
