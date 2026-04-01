const { chromium } = require('playwright');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const DEBUG_URL = process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9222';
const PASSWORDS_URL = 'https://passwords.google.com';
const URL_TEXT = /(https?:\/\/)?((\d{1,3}\.){3}\d{1,3}|[\w.-]+\.[a-z]{2,})(:\d+)?(\/\S*)?/i;
const TRANSLATIONS_DIR = path.join(__dirname, 'translations');
const MAC_CHROME_EXAMPLE = '"Google Chrome" --remote-debugging-port=9222 --user-data-dir=./chrome-profile';
const WINDOWS_CHROME_EXAMPLE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=.\\chrome-profile';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAvailableLanguages() {
  return fs
    .readdirSync(TRANSLATIONS_DIR)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => path.basename(fileName, '.json'))
    .sort();
}

function getSelectedLanguages() {
  return getAvailableLanguages();
}

function loadDictionary(langs) {
  const dictionary = {
    delete: [],
    cancel: [],
    back: [],
    username: [],
    password: [],
  };

  for (const lang of langs) {
    const filePath = path.join(TRANSLATIONS_DIR, `${lang}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing translation file for language "${lang}" at ${filePath}.`);
    }

    const contents = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const key of Object.keys(dictionary)) {
      const values = Array.isArray(contents[key]) ? contents[key] : [];
      dictionary[key].push(...values);
    }
  }

  for (const key of Object.keys(dictionary)) {
    dictionary[key] = [...new Set(dictionary[key])];
  }

  return dictionary;
}

function makeRegex(values) {
  const parts = values.map(escapeRegex);
  return new RegExp(`(${parts.join('|')})`, 'i');
}

const AVAILABLE_LANGS = getAvailableLanguages();
const SELECTED_LANGS = getSelectedLanguages();
const dictionary = loadDictionary(SELECTED_LANGS);
const DELETE_TEXT = makeRegex(dictionary.delete);
const CANCEL_TEXT = makeRegex(dictionary.cancel);
const BACK_TEXT = makeRegex(dictionary.back);
const USERNAME_TEXT = makeRegex(dictionary.username);
const PASSWORD_FIELD_TEXT = makeRegex(dictionary.password);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canReachChrome(url) {
  return new Promise((resolve) => {
    const request = http.get(`${url}/json/version`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });

    request.on('error', () => resolve(false));
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForChrome(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canReachChrome(url)) {
      return true;
    }
    await sleep(500);
  }

  return false;
}

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(`${prompt}\n`);
  } finally {
    rl.close();
  }
}

async function getPasswordsPage(context) {
  const existingPage = context.pages().find((page) => page.url().startsWith(PASSWORDS_URL));
  if (existingPage) {
    return existingPage;
  }

  const page = await context.newPage();
  await page.goto(PASSWORDS_URL, { waitUntil: 'domcontentloaded' });
  return page;
}

async function clickFirstEntry(page) {
  const clicked = await page.evaluate((urlSource) => {
    const urlRegex = new RegExp(urlSource, 'i');

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 20 && rect.height > 20;
    }

    function scoreCandidate(element) {
      const rect = element.getBoundingClientRect();
      let score = 0;

      if (element.getAttribute('role') === 'button' || element.getAttribute('role') === 'link') {
        score += 5;
      }
      if (typeof element.onclick === 'function') {
        score += 3;
      }
      if (element.tabIndex >= 0) {
        score += 2;
      }
      if (rect.width > 180) {
        score += 2;
      }
      if (rect.height >= 40 && rect.height <= 120) {
        score += 2;
      }

      return score;
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const candidates = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent || '').trim();
      if (!text || !urlRegex.test(text)) {
        continue;
      }

      let element = node.parentElement;
      while (element) {
        if (isVisible(element)) {
          candidates.push({ element, score: scoreCandidate(element), text });
        }
        element = element.parentElement;
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
      const rect = candidate.element.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) {
        continue;
      }

      candidate.element.click();
      return { text: candidate.text, tag: candidate.element.tagName, score: candidate.score };
    }

    return null;
  }, URL_TEXT.source);

  return clicked;
}

async function waitForEntryDetails(page) {
  const detailSignals = [
    page.getByRole('button', { name: DELETE_TEXT }).first(),
    page.getByRole('button', { name: CANCEL_TEXT }).first(),
    page.getByRole('button', { name: BACK_TEXT }).first(),
    page.getByText(USERNAME_TEXT).first(),
    page.getByText(PASSWORD_FIELD_TEXT).first(),
    page.locator('button').filter({ hasText: DELETE_TEXT }).first(),
  ];

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const locator of detailSignals) {
      if (await locator.count()) {
        return true;
      }
    }
    await page.waitForTimeout(200);
  }

  return false;
}

async function clickDeleteButton(page) {
  const selectors = [
    page.getByRole('button', { name: DELETE_TEXT }).first(),
    page.locator('[role="button"]').filter({ hasText: DELETE_TEXT }).first(),
    page.locator('button').filter({ hasText: DELETE_TEXT }).first(),
  ];

  for (const locator of selectors) {
    if (await locator.count()) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ force: true });
      return;
    }
  }

  const domClicked = await page.evaluate((deleteSource) => {
    const deleteRegex = new RegExp(deleteSource, 'i');

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }

    function clickableAncestor(element) {
      let current = element;
      while (current) {
        if (
          current.tagName === 'BUTTON' ||
          current.getAttribute('role') === 'button' ||
          current.hasAttribute('jsaction') ||
          current.tabIndex >= 0
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }

    const textNodes = Array.from(document.querySelectorAll('span, div'));
    for (const node of textNodes) {
      const text = (node.textContent || '').trim();
      if (!text || !deleteRegex.test(text) || !isVisible(node)) {
        continue;
      }

      const target = clickableAncestor(node);
      if (!target || !isVisible(target)) {
        continue;
      }

      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return {
        text,
        tag: target.tagName,
        role: target.getAttribute('role') || '',
        ariaLabel: target.getAttribute('aria-label') || '',
      };
    }

    return null;
  }, DELETE_TEXT.source);

  if (domClicked) {
    return;
  }

  const buttonDetails = await page.locator('button,[role="button"]').evaluateAll((elements) =>
    elements.slice(0, 20).map((element) => ({
      text: (element.textContent || '').trim(),
      ariaLabel: element.getAttribute('aria-label') || '',
      title: element.getAttribute('title') || '',
    }))
  );

  throw new Error(`Could not find a Delete button on the current page. First buttons seen: ${JSON.stringify(buttonDetails)}`);
}

(async () => {
  console.log(`Connecting to Chrome at ${DEBUG_URL}...`);
  console.log(`Loaded languages: ${SELECTED_LANGS.join(', ')}`);
  console.log(`Available languages: ${AVAILABLE_LANGS.join(', ')}`);
  console.log('Start Chrome yourself with remote debugging enabled, then sign in normally.');
  console.log('macOS example:');
  console.log(MAC_CHROME_EXAMPLE);
  console.log('Windows example (not tested):');
  console.log(WINDOWS_CHROME_EXAMPLE);
  console.log('');

  const chromeReady = await waitForChrome(DEBUG_URL);
  if (!chromeReady) {
    throw new Error(
      `Could not reach Chrome DevTools at ${DEBUG_URL}. Start Chrome first with --remote-debugging-port=9222, or set CHROME_DEBUG_URL if it is exposed on a different host/port.`
    );
  }

  const browser = await chromium.connectOverCDP(DEBUG_URL);
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error('No Chrome context found. Make sure Chrome was started with --remote-debugging-port=9222.');
  }

  const page = await getPasswordsPage(context);
  await page.bringToFront();

  await waitForEnter(
    'Open passwords.google.com in that Chrome window, make sure you are logged in, and press ENTER here when the password list is visible.'
  );

  let deletedCount = 0;

  while (true) {
    const item = await clickFirstEntry(page);

    if (!item) {
      console.log(`No more visible password entries found. Deleted ${deletedCount} item(s).`);
      break;
    }

    console.log(`Opening entry ${deletedCount + 1}: ${item.text}`);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1000);

    const detailViewLoaded = await waitForEntryDetails(page);
    if (!detailViewLoaded) {
      throw new Error(`Clicked "${item.text}" but did not reach the password detail view.`);
    }

    console.log('Deleting...');
    await clickDeleteButton(page);
    await page.waitForTimeout(500);

    console.log('Confirming...');
    await clickDeleteButton(page);
    await page.waitForTimeout(1500);

    deletedCount += 1;
  }

  await browser.close();
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
