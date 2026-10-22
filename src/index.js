/**
 * MAISON / ANAF — daily enrichment, evidence-first.
 * Reads CUI from onrc_firme; writes candidate phone numbers to a separate table.
 * Does NOT publish numbers or send them in notifications.
 */
const ANAF_URL = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";
const MAX_BATCH = 1000; // EXPERIMENT: ANAF acceptance of 1000-item requests is unverified.
const LEASE_MS = 90 * 1000; // Recovered automatically after interrupted invocations.

export default {
  async scheduled(event, env, ctx) {
    await run(env, `cron:${event.cron}`);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/health") return new Response("Not found", {status:404});
    return Response.json({ok:true, service:"maison-anaf", mode:"scheduled", timestamp:new Date().toISOString()});
  }
};

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

async function notify(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return "not_configured";
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID, text:message, disable_web_page_preview:true})
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0,180)}`);
  return "sent";
}

function isoDay() { return new Date().toISOString().slice(0,10); }
function digits(v) { return String(v ?? "").replace(/\D/g,""); }
function validPhone(v) {
  const raw=String(v??"").trim();
  return digits(raw).length>=9 && digits(raw).length<=15 ? raw : null;
}
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
        if(![429,500,502,503,504,520,521,522,523,524].includes(res.status)) throw new Error(message);
        lastError=new Error(message);
      } else {
        const body=await res.json();
        if(!Array.isArray(body.found) || !Array.isArray(body.notFound))
          throw new Error("Unexpected ANAF JSON structure; no data persisted");
        return body;
      }
    } catch(e) {
      lastError=e;
      if(String(e.message||e).startsWith("Unexpected ANAF") || /ANAF HTTP 4(?!29)/.test(String(e.message||e))) throw e;
    } finally {clearTimeout(timer);}
    if(attempt<3) await new Promise(resolve=>setTimeout(resolve,1000*attempt));
  }
  throw lastError;
}

async function acquireLease(db, owner) {
  const now=Date.now();
  const row=await db.prepare(`
    INSERT INTO maison_anaf_lock(name,owner,expires_at) VALUES('daily',?,?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
    WHERE maison_anaf_lock.expires_at <= ?
    RETURNING owner
  `).bind(owner,now+LEASE_MS,now).first();
  return row?.owner===owner;
}
async function renewLease(db, owner) {
  const now=Date.now();
  const row=await db.prepare(`
    UPDATE maison_anaf_lock SET expires_at=?
    WHERE name='daily' AND owner=? AND expires_at>?
    RETURNING owner
  `).bind(now+LEASE_MS,owner,now).first();
  if(row?.owner!==owner) throw new Error("Lease lost: refusing stale write");
}
async function releaseLease(db, owner) {
  await db.prepare("DELETE FROM maison_anaf_lock WHERE name='daily' AND owner=?").bind(owner).run();
}

async function run(env, trigger) {
  const db=env.DB;
  const day=isoDay(), now=new Date().toISOString();
  let checked=0,found=0,missing=0,failed=0;
  let detail="", notice="not_sent";
  const owner=crypto.randomUUID();
  let leaseHeld=false;
  try {
    await setup(db);
    leaseHeld=await acquireLease(db,owner);
    if(!leaseHeld) {
      console.log(JSON.stringify({checked:0,found:0,missing:0,failed:0,detail:"Skipped: another run owns the lease",notice:"not_sent"}));
      return;
    }
    const state=await db.prepare("SELECT value FROM maison_anaf_state WHERE key='last_cui'").first();
    const last=Number(state?.value || 0);
    const target = 5000;
    const progressRow = await db.prepare("SELECT value FROM maison_anaf_state WHERE key='test_5000_progress'").first();
    const progress = Math.max(0, Number(progressRow?.value || 0));
    const limit = Math.min(5000, Math.max(0, target-progress));
    if(limit===0) detail="5000-CUI test complete; no additional work";
    // onrc_firme.CUI exists in the known schema; cast to integer for stable cursor.
    const rows=limit>0 ? (await db.prepare(`
      SELECT DISTINCT CAST(CUI AS INTEGER) AS cui
      FROM onrc_firme
      WHERE CAST(CUI AS INTEGER) > ? AND CAST(CUI AS INTEGER) > 0
      ORDER BY CAST(CUI AS INTEGER) ASC LIMIT ?
    `).bind(last,limit).all()).results || [] : [];
    if(rows.length===0 && limit>0) {
      detail="Reached end of CUI list; cursor reset to 0 for next run";
      await db.prepare("INSERT INTO maison_anaf_state(key,value) VALUES('last_cui','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
    }
    for(let i=0;i<rows.length;i+=MAX_BATCH) {
      const batch=rows.slice(i,i+MAX_BATCH).map(x=>Number(x.cui));
      try {
        await renewLease(db,owner);
        const result=await fetchAnaf(batch,day);
        const byCui=new Map(result.found.map(x=>[Number(x?.date_generale?.cui),x]));
        const notFound=new Set(result.notFound.map(x=>Number(typeof x==="object" ? (x.cui??x.CUI) : x)));
        const statements=[];
        let batchFound=0, batchMissing=0;
        for(const cui of batch) {
          const record=byCui.get(cui);
          const phone=validPhone(record?.date_generale?.telefon);
          const status=record ? (phone?"candidate":"missing_phone") : (notFound.has(cui)?"not_found":"unmatched");
          if(phone) batchFound++; else batchMissing++;
          statements.push(db.prepare(`
            INSERT INTO maison_anaf_phone(cui,phone,status,source_url,queried_at,anaf_data_date,error)
            VALUES(?,?,?,?,?,?,NULL)
            ON CONFLICT(cui) DO UPDATE SET
              phone=excluded.phone,status=excluded.status,source_url=excluded.source_url,
              queried_at=excluded.queried_at,anaf_data_date=excluded.anaf_data_date,error=NULL
          `).bind(cui,phone,status,ANAF_URL,now,day));
        }
        statements.push(db.prepare(`
          INSERT INTO maison_anaf_state(key,value) VALUES('last_cui',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).bind(String(batch[batch.length-1])));
        statements.push(db.prepare("INSERT INTO maison_anaf_state(key,value) VALUES('test_5000_progress',?) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+?").bind(String(batch.length),batch.length));
        await renewLease(db,owner);
        await db.batch(statements);
        checked+=batch.length;
        found+=batchFound;
        missing+=batchMissing;
      } catch(e) {
        failed+=batch.length;
        detail=`Batch starting CUI ${batch[0]} failed: ${String(e.message||e).slice(0,250)}`;
        // Do not advance cursor on failure. Retry this batch next day.
        break;
      }
    }
  } catch(e) {
    detail=`Run failed: ${String(e.message||e).slice(0,300)}`;
  } finally {
    if(leaseHeld) {
      try {await releaseLease(db,owner);} catch(e) {
        detail+=` | lease release failed: ${String(e.message||e).slice(0,100)}`;
      }
    }
  }
  try {
    await db.prepare("INSERT INTO maison_anaf_runs(run_at,checked,found,missing,failed,detail) VALUES(?,?,?,?,?,?)")
      .bind(now,checked,found,missing,failed,detail).run();
  } catch(e) {detail+=` | run log failed: ${String(e.message||e).slice(0,100)}`;}
  const message=`MAISON / ANAF — ${day}\nTrigger: ${trigger}\nCUI verificate: ${checked}\nTelefon candidat: ${found}\nFara telefon / fara potrivire: ${missing}\nInterogari esuate: ${failed}\n${detail ? "Observatii: "+detail : "Executie finalizata."}\nAtentie: numerele sunt candidate, nu validate independent.`;
  try {notice=await notify(env,message);} catch(e) {notice=`notification_failed: ${String(e.message||e).slice(0,120)}`;}
  console.log(JSON.stringify({checked,found,missing,failed,detail,notice}));
}
