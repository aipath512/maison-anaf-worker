# MAISON — ANAF Daily Worker

## Ce face
La 06:00 UTC zilnic citește până la `DAILY_LIMIT` CUI-uri (implicit 1.000/zi) din tabela `onrc_firme` a bazei D1, în loturi de max. 100 (10 cereri pentru 1.000 CUI-uri). Interoghează ANAF v9, stochează telefoanele ca **date candidate** în `maison_anaf_phone`, cu proveniență, și trimite sumar prin Telegram. Nu publică datele și nu contactează firmele.

## Instalare
1. În Cloudflare Dashboard → D1 → `b2b-romania-db`, copiați **Database ID** în `wrangler.toml`.
2. Verificați în D1 că tabela `onrc_firme` are coloana `CUI` și că Workers poate accesa baza.
3. În directorul proiectului rulați `npm install` și `npx wrangler login`.
4. Pentru notificări, creați un bot prin `@BotFather` în Telegram; obțineți `chat_id` din conversația cu botul. Configurați secretele:
   - `npx wrangler secret put TELEGRAM_BOT_TOKEN`
   - `npx wrangler secret put TELEGRAM_CHAT_ID`
5. Rulați `npm run deploy`. Cron rulează zilnic la 06:00 UTC.
6. În Cloudflare Dashboard → Workers → `maison-anaf-daily` → Logs verificați execuția. Se poate testa din dashboard cu **Trigger scheduled event**.

## SQL verificare
```sql
SELECT * FROM maison_anaf_runs ORDER BY id DESC LIMIT 5;
SELECT cui, phone, status, source_url, queried_at FROM maison_anaf_phone ORDER BY queried_at DESC LIMIT 20;
SELECT COUNT(*) AS candidates FROM maison_anaf_phone WHERE status='candidate';
```

## Limite importante
- **Nu a fost deployat și nu a fost testat live**. Structura reală a D1 și răspunsurile ANAF trebuie validate în pilot.
- Acesta este un scan secvențial după CUI; **nu este încă selecția 200 firme noi + 200 vechi**.
- La eșec de rețea/ANAF, cursorul nu avansează pentru lotul nereușit.
- Datele ANAF pot fi incomplete sau vechi; telefonul nu este verificat prin apel.
- D1 `onrc_firme` poate fi foarte mare: indexarea pe `CAST(CUI AS INTEGER)` ar putea fi lentă. Pentru producție, creați o coadă indexată de CUI-uri, mai ales dacă interogarea depășește limitele D1.
- Limitele de cereri ANAF și termenii de reutilizare trebuie reverificați înainte de creșterea volumului.
- Nu trimiteți chei sau numere în Telegram; notificarea conține doar statistici.
- Ora UTC rămâne fixă și se deplasează cu schimbarea orei de vară în România.
