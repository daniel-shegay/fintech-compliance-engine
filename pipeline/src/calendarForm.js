'use strict';

// ----------------------------------------------------------------------------
// Vyplneni formulare "Splátkový kalendář" v admin.php pres Playwright.
//
// Prevzato z el4/electron3/src/calendar.js, upraveno na headless + screenshot
// misto "drz okno otevrene, operator klikne Zapsat rucne v prohlizeci":
//
//   1. fillCalendarForm()   — headless prihlaseni, vyplneni formulare,
//      screenshot vraceny volajicimu (orchestrator ho ulozi a nabidne
//      operatorovi k vizualni kontrole pres GET /calendar-preview.png).
//      Relace (browser+page) zustava otevrena, klic operationId -> session.
//   2. confirmCalendarForm() — operator potvrdil screenshot v UI, tady
//      klikneme Zapsat ve STEJNE jeste otevrene relaci a zavreme prohlizec.
//   3. cancelCalendarForm()  — zavre relaci bez odeslani (napr. pri chybe
//      nebo zruseni operace).
//
// NEOVERENO: selektor tlacitka "Zapsat" (input[type=submit][value*=Zapsat])
// je odhad podle stejneho vzoru jako prihlasovaci tlacitko ("Přihlásit").
// Puvodni el4 kod tento klik nikdy nedelal (cekal na cloveka), takze presny
// selektor je potreba overit prvnim skutecnym prubehem.
// ----------------------------------------------------------------------------

const { config } = require('./config');

const BASE = config.BASE_URL || 'https://api.crm-lending.example';
const LOGIN_URL = `${BASE}/admin.php`;
const CREATE_URL = `${BASE}/admin.php?e=4&edit=665:refund-schedule&act=create`;

function fmtDate(dateStr) { return `${dateStr} 23:59:00`; }

// operationId -> { browser, page }
const sessions = new Map();

// Orez screenshotu na formular jednoho klienta — ne cizi radky pod nim.
//
// 1. pokus: element screenshot primo na zvyraznenem radku/bloku formulare
//    (nejblizsi spolecny ancestor input[name="credit_id"] a
//    input[name="customer_id"] — na strance admin.php je to typicky <tr>
//    nebo <table> obalujici cely formular jednoho zaznamu). Element
//    screenshot se automaticky prizpusobi VYSCE obsahu, takze funguje
//    stejne dobre pro kalendar o 3 i o 30 splatkach — na rozdil od rucne
//    pocitaneho bounding boxu, ktery zna jen konkretni pole, ktera jsme
//    vyplnili, a muze orizeknout tlacitka/pravy sloupec pod/vedle nich.
// 2. fallback: sjednoceni bounding boxu vyplnenych poli (puvodni pristup) —
//    pro pripad, ze spolecny ancestor neexistuje nebo je prilis velky
//    (napr. cela stranka).
// 3. fallback: cela stranka — porad lepsi nez pad chyby bez obrazku.
async function screenshotFormArea(page, lastRowIndex) {
  try {
    const rowShot = await screenshotHighlightedRow(page);
    if (rowShot) return rowShot;
  } catch {
    // pokracujeme na dalsi fallback
  }
  return screenshotFieldBoundingBox(page, lastRowIndex);
}

// Najde nejblizsiho spolecneho predka poli credit_id a customer_id (typicky
// radek/blok formulare zvyrazneny na strance) a vrati jeho element
// screenshot. Vraci null, pokud se nepodari najit rozumny element (napr.
// spolecny predek je cely <body>/<html> — to uz by neorizlo vubec nic).
async function screenshotHighlightedRow(page) {
  const handle = await page.evaluateHandle(() => {
    const a = document.querySelector('input[name="credit_id"]');
    const b = document.querySelector('input[name="customer_id"]');
    if (!a || !b) return null;

    function ancestors(el) {
      const list = [];
      for (let n = el; n; n = n.parentElement) list.push(n);
      return list;
    }
    const aAncestors = ancestors(a);
    const bAncestorSet = new Set(ancestors(b));
    let common = aAncestors.find((n) => bAncestorSet.has(n));
    if (!common) return null;

    // Pokud je spolecny predek TR, radeji zkusime jeho rodicovsky TABLE jen
    // tehdy, kdyz TR samo o sobe nemá smysluplnou vysku (0), jinak zustavame
    // na TR — to je presne ten "jeden radek formulare", co chceme oriznout.
    // Pokud je spolecny predek prilis vysoko ve strome (BODY/HTML/celý
    // hlavni obsah), je to znamení, ze pole nejsou v jednom souvislem bloku
    // — v tom pripade se vzdame a necháme fallback.
    const tag = common.tagName;
    if (tag === 'BODY' || tag === 'HTML') return null;
    const rect = common.getBoundingClientRect();
    if (!rect || rect.width < 10 || rect.height < 10) return null;
    // Sanity: pokud by orez byl skoro cela stranka (>90 % vysky viewportu),
    // spolecny predek je pravdepodobne obal celeho obsahu, ne jen radku
    // formulare — necháme radeji fallback na bounding-box pristup.
    if (rect.height > window.innerHeight * 0.9) return null;
    return common;
  });

  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }
  try {
    return await el.screenshot();
  } finally {
    await handle.dispose();
  }
}

// Puvodni pristup: sjednoceni bounding boxu konkretnich vyplnenych poli
// (credit_id/customer_id, posledni radek rozpisu, poznamka), s malym
// paddingem. Pouziva se jen jako fallback, kdyz element-screenshot vyse
// selze — viz komentar u screenshotFormArea.
async function screenshotFieldBoundingBox(page, lastRowIndex) {
  const selectors = [
    'input[name="credit_id"]',
    'input[name="customer_id"]',
    'input[name="schedule_created"]',
    `input[name="refund_date${lastRowIndex}"]`,
    `input[name="refund_amount${lastRowIndex}"]`,
    'textarea[name="schedule_notes"]',
  ];

  try {
    const boxes = [];
    for (const sel of selectors) {
      const box = await page.locator(sel).boundingBox().catch(() => null);
      if (box) boxes.push(box);
    }
    if (!boxes.length) return page.screenshot();

    const pad = 24;
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
    const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;

    return await page.screenshot({ clip: { x, y, width: right - x, height: bottom - y } });
  } catch {
    return page.screenshot();
  }
}

async function fillCalendarForm(operationId, { customerId, creditId, startDate, schedule, note }) {
  // Lazy require — Playwright/Chromium nemusi byt potreba (a nainstalovany)
  // ve vsech prostredich, kde se pipeline/src pouziva (napr. testy schedule.js).
  const { chromium } = require('playwright');

  if (sessions.has(operationId)) {
    await closeCalendarSession(operationId);
  }

  const browser = await chromium.launch({ headless: true, timeout: config.CALENDAR_TIMEOUT_MS });
  const page = await browser.newPage();
  sessions.set(operationId, { browser, page });

  try {
    if (!config.ADMIN_USER || !config.ADMIN_PASS) {
      throw new Error(
        'CREDITGO_ADMIN_USER nebo CREDITGO_ADMIN_PASS není v .env nastaveno — ' +
        'Playwright se nemá jak přihlásit do admin.php.',
      );
    }

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="name"]', config.ADMIN_USER);
    await page.fill('input[name="passw"]', config.ADMIN_PASS);
    await page.click('input[type="submit"][value*="Přihlásit"]');
    await page.waitForLoadState('networkidle');

    // Kontrola, ze login opravdu probehl — jinak CRM na kazdou chranenou URL
    // (vcetne CREATE_URL) vraci stejnou prihlasovaci stranku, a bez teto
    // kontroly by se to projevilo matoucim timeoutem az na poli credit_id.
    //
    // Kontrolujeme VIDITELNOST pole "passw", ne pouhou pritomnost v DOM —
    // autentizovane stranky CRM maji, zda se, nekde skryte stejne pojmenovane
    // pole (napr. modalni okno zmeny hesla), takze .count() davalo false
    // positive i po uspesnem loginu.
    const stillOnLogin = await page.locator('input[name="passw"]').first()
      .isVisible().catch(() => false);
    if (stillOnLogin) {
      throw new Error(
        'Po pokusu o přihlášení je stále zobrazen přihlašovací formulář — ' +
        'zkontrolujte CREDITGO_ADMIN_USER a CREDITGO_ADMIN_PASS v .env.',
      );
    }

    await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);

    await page.fill('input[name="credit_id"]', String(creditId));
    await page.fill('input[name="customer_id"]', String(customerId));
    await page.fill('input[name="schedule_created"]', fmtDate(startDate));

    await page.fill('input[name="numberMonths"]', String(schedule.months));
    await page.click('input[name="autoFillFields"]');
    await page.waitForTimeout(2000);

    for (const row of schedule.rows) {
      const i = row.n - 1;
      await page.fill(`input[name="refund_date${i}"]`, fmtDate(row.date));
      await page.fill(`input[name="refund_amount${i}"]`, String(row.amount));
    }

    if (note) {
      await page.fill('textarea[name="schedule_notes"]', note);
    }

    // Screenshot orezavame jen na radek/blok s tímto formulářem — cela
    // stranka (fullPage) zobrazuje i uz existujici kalendare ostatnich
    // klientu pod nim, coz operatorovi jen prekazi (a je to zbytecne
    // zobrazovani cizich dat). Bounding box pocitame z prvniho a posledniho
    // vyplneneho pole — funguje bez ohledu na presnou strukturu tabulky.
    const screenshot = await screenshotFormArea(page, schedule.rows.length - 1);
    return { screenshot };
  } catch (err) {
    // Diagnostika: pri chybe ulozime screenshot a aktualni URL, JINAK
    // operator vidi jen "Timeout... waiting for locator(...)" a nevi, na
    // jake strance se Playwright ve skutecnosti ocitl (spatny login,
    // presmerovani, jiny tvar formulare apod).
    try {
      err.debugScreenshot = await page.screenshot({ fullPage: true });
      err.debugUrl = page.url();
      err.message = `${err.message} [aktualni URL: ${err.debugUrl}]`;
    } catch (screenshotErr) {
      // stranka uz nemusi byt pouzitelna (zavreny kontext apod.) — puvodni
      // chybu tim nezastirame, jen nepridame screenshot.
    }
    await closeCalendarSession(operationId);
    throw err;
  }
}

async function confirmCalendarForm(operationId) {
  const session = sessions.get(operationId);
  if (!session) {
    throw new Error(
      'Relace prohlížeče pro tuto operaci už neexistuje (server restartoval nebo relace vypršela) — ' +
      'krok formuláře kalendáře je potřeba spustit znovu.',
    );
  }
  const { page } = session;
  try {
    // NEOVERENO, viz poznamka v hlavicce souboru.
    await page.click('input[type="submit"][value*="Zapsat"]');
    await page.waitForLoadState('networkidle').catch(() => {});
  } finally {
    await closeCalendarSession(operationId);
  }
}

async function cancelCalendarForm(operationId) {
  await closeCalendarSession(operationId);
}

async function closeCalendarSession(operationId) {
  const session = sessions.get(operationId);
  if (!session) return;
  sessions.delete(operationId);
  await session.browser.close().catch(() => {});
}

module.exports = { fillCalendarForm, confirmCalendarForm, cancelCalendarForm, closeCalendarSession };
