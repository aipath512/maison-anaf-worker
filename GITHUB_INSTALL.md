# Instalare numai prin GitHub + Cloudflare Dashboard

1. GitHub → New repository → `maison-anaf-worker` (preferabil Private).
2. În repository → Add file → Upload files. Din arhiva ZIP **dezarhivată**, încărcați `src/index.js`, `wrangler.toml`, `package.json`, `.gitignore` și `.github/workflows/deploy.yml`, păstrând căile. Pentru directoare ascunse, GitHub web poate necesita Create new file cu numele `.github/workflows/deploy.yml` și lipirea conținutului.
3. Cloudflare → D1 → `b2b-romania-db` → copiați Database ID. Editați `wrangler.toml` în GitHub și înlocuiți `REPLACE_WITH_REAL_D1_DATABASE_ID`.
4. Cloudflare → My Profile → API Tokens → Create Token: folosiți un token restrâns la contul propriu, cu permisiuni pentru Workers Scripts (Edit), Workers Routes (Edit numai dacă e necesar), D1 (Edit dacă deploy-ul o cere). Nu folosiți Global API Key.
5. Cloudflare → Workers & Pages → Account ID (sau pagina contului). Copiați-l.
6. GitHub → Settings → Secrets and variables → Actions → New repository secret: `CLOUDFLARE_API_TOKEN` și `CLOUDFLARE_ACCOUNT_ID`.
7. În `wrangler.toml` setați `DAILY_LIMIT = "100"` pentru pilot și faceți commit.
8. GitHub → Actions → Deploy MAISON ANAF Worker → Run workflow. Verificați status verde și logul deploy-ului.
9. Cloudflare → Workers & Pages → `maison-anaf-daily` → Settings → Variables and Secrets: adăugați secretele `TELEGRAM_BOT_TOKEN` și `TELEGRAM_CHAT_ID` (secret, nu plain text). Faceți acest pas DUPĂ primul deploy. În caz de redeploy verificați că secretele sunt păstrate.
10. Cloudflare → Workers → Triggers → Scheduled → verificați `0 6 * * *` (06:00 UTC); folosiți trigger de test dacă este disponibil. Pentru test, verificați logurile Worker și în D1 tabelele `maison_anaf_runs`, `maison_anaf_phone`.
11. După succes, editați `DAILY_LIMIT = "1000"` în GitHub și faceți commit; Actions va redeploya.

**Important:** Deployment-ul GitHub Actions este configurat, dar nu a fost executat. Acest Worker nu arhivează JSON brut în R2. Nu trimite telefoane în Telegram. Endpoint-ul `/health` nu execută scanarea. ANAF poate avea limitări de rețea, format și trafic; testați pilotul înainte de 1000/zi. `onrc_firme` trebuie să aibă coloana `CUI`. Interogarea după `CAST(CUI AS INTEGER)` poate fi lentă la volum mare. Nu publicați numere fără verificare și temei legal.
