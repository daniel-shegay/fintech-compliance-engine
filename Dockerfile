# node:20-bookworm-slim misto puvodniho node:20-alpine: Playwright (krok 7-8
# Splátkového kalendáře, headless Chromium) oficialne nepodporuje Alpine/musl
# — potrebuje glibc a apt pro `playwright install --with-deps`. Alpine bylo
# v poradku, dokud modul jen cetl API; s Playwrightem uz ne.
FROM node:20-bookworm-slim

WORKDIR /app

# Sprva jen manifesty — tak npm ci pre-bezi jen kdyz se realne zmeni zavislosti,
# ne pri kazde uprave kodu.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Chromium + systemove zavislosti pro Playwright. Verze prohlizece musi
# presne odpovidat verzi npm balicku playwright (viz package.json) — proto
# instalujeme az PO npm ci, pres uz nainstalovany playwright-core CLI, ne
# pres samostatny pevne pripnuty base image.
RUN npx playwright install --with-deps chromium

# Kod a staticke soubory. .env a users.json se NEKOPIRUJI — prichazeji
# zvenci (viz .dockerignore) pres env_file a volume v docker-compose.yml.
COPY server.js access.js writeoff-bridge.js ./
COPY public ./public
COPY scripts ./scripts

# Modul odpisu. Testy a tools jsou v obraze zamerne: bez site a bez
# zavislosti, takze `docker compose exec compliance node --test
# "writeoff/test/*.test.js"` overuje presne ten kod, ktery bezi.
COPY writeoff ./writeoff

# Pipeline modul "Splátkový kalendář" (krok 1-10).
COPY pipeline ./pipeline

# Audit-log odpisu. Adresar vytvarime predem, aby prava byla spravna, data
# prichazeji volume (viz docker-compose.yml) — bez neho zmizi idempotence
# a zaznamy o neuzavrenych proveedeni pri prvnim pre-buildu.
RUN mkdir -p /app/audit
VOLUME ["/app/audit"]

EXPOSE 3000

CMD ["node", "server.js"]
