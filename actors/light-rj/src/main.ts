
import { Actor } from 'apify';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import fs from 'fs';
import path from 'path';



// Helper logging function
function log(msg: string) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`);
}

chromium.use(stealthPlugin());

await Actor.init();

interface Input {
    username: string;
    password: string;
    antiCaptchaKey?: string;
    captchaService?: 'ANTICAPTCHA';
    installationCode?: string;
    referenceMonth?: string;
}


// --- ANTI-CAPTCHA SOLVER FUNCTION ---
async function solveAntiCaptcha(apiKey: string, siteUrl: string, siteKey: string): Promise<string> {
    log('Requesting Anti-Captcha task...');
    try {
        const createTaskResponse = await axios.post('https://api.anti-captcha.com/createTask', {
            clientKey: apiKey,
            task: {
                type: 'RecaptchaV2TaskProxyless',
                websiteURL: siteUrl,
                websiteKey: siteKey
            }
        });

        if (createTaskResponse.data.errorId !== 0) {
            throw new Error(`Anti-Captcha Error: ${createTaskResponse.data.errorDescription}`);
        }

        const taskId = createTaskResponse.data.taskId;
        log(`Task created with ID: ${taskId}. Waiting for solution...`);

        // Poll for result
        let attempts = 0;
        while (attempts < 200) { // 200 * 3s = 600s (10 mins) timeout
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3s
            attempts++;

            const resultResponse = await axios.post('https://api.anti-captcha.com/getTaskResult', {
                clientKey: apiKey,
                taskId: taskId
            });

            if (resultResponse.data.errorId !== 0) {
                throw new Error(`Anti-Captcha Task Error: ${resultResponse.data.errorDescription}`);
            }

            if (resultResponse.data.status === 'ready') {
                log('✅ Anti-Captcha solved!');
                return resultResponse.data.solution.gRecaptchaResponse;
            }

            if (attempts % 5 === 0) log('Still waiting for captcha solution...');
        }

        throw new Error('Anti-Captcha timeout.');
    } catch (error: any) {
        log(`❌ Anti-Captcha failed: ${error.message}`);
        throw error;
    }
}

// --- MAIN LOGIC ---
try {
    // DEBUG & FALLBACK: Check storage manually if Actor.getInput() fails
    const storageDir = process.env.APIFY_LOCAL_STORAGE_DIR || './storage';

    let input = await Actor.getInput<Input>();

    if (!input && storageDir) {
        log('⚠️ WARNING: Actor.getInput() returned null. Attempting manual read from disk...');
        try {
            const possiblePaths = [
                path.join(storageDir, 'key_value_stores', 'default', 'INPUT.json'),
                path.join('storage', 'key_value_stores', 'default', 'INPUT.json'),
                'INPUT.json'
            ];

            for (const inputPath of possiblePaths) {
                log(`Checking for input at: ${inputPath}`);
                if (fs.existsSync(inputPath)) {
                    const rawContent = fs.readFileSync(inputPath, 'utf-8');
                    input = JSON.parse(rawContent) as Input;
                    log(`✅ SUCCESS: Input read manually from disk at ${inputPath}.`);
                    break;
                }
            }
        } catch (e: any) {
            console.error(`❌ ERROR: Failed manual input read: ${e.message}`);
        }
    }

    log(`Final Input Object Keys: ${input ? Object.keys(input).join(', ') : 'null'}`);

    if (!input) {
        throw new Error('Input is null or missing.');
    }

    if (!input.username || !input.password) {
        await Actor.fail('Username and password are required.');
    }

    const { password } = input!;
    let { username } = input!;

    log(`Starting Light RJ Worker for user: ${username}`);

    const browser = await chromium.launch({
        headless: true, // Always run headless
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled', // Try to hide automation
            '--start-maximized', // Open maximized
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000); // Increased timeout for manual interactions

    // Pipe browser logs to node console
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('✅') || text.includes('❌') || text.includes('⚠️')) {
            log(`[BROWSER] ${text}`);
        }
    });

    // --- LOGIN LOGIC ---
    try {
        log('Navigating to portal...');
        await page.goto('https://agenciavirtual.light.com.br/portal/', { waitUntil: 'domcontentloaded', timeout: 30000 });

        try {
            await page.waitForSelector('body', { timeout: 10000 });
        } catch { }

        const usernameSelector = 'input[id*="wtUserNameInput"]';
        const passwordSelector = 'input[id*="wtPasswordInput"]';

        log('Starting Login Process...');

        if (!username.includes('@')) {
            username = username.replace(/\D/g, '');
            log(`Cleaned Username (digits only): ${username}`);
        }

        log(`Waiting for inputs: ${usernameSelector}`);
        try {
            await page.waitForSelector(usernameSelector, { timeout: 20000 });
        } catch (e) {
            log('Timeout waiting for inputs. Dumping HTML...');
            await Actor.setValue('PAGE_DUMP.html', await page.content(), { contentType: 'text/html' });
            throw new Error('Inputs not found - check PAGE_DUMP.html');
        }

        log(`Final Input - Username: [${username}] | Password: [${password}]`);

        const fillInput = async (selector: string, value: string) => {
            try {
                log(`Focusing input: ${selector}`);
                await page.click(selector);
                await page.focus(selector);

                log(`Typing value into ${selector}...`);
                await page.keyboard.type(value, { delay: 10 });

                await page.keyboard.press('Tab');
                log(`Blurring input...`);

                const finalVal = await page.inputValue(selector);
                if (finalVal !== value) {
                    log(`⚠️ Value mismatch after typing! Expected: ${value}, Got: ${finalVal}. Retrying with JS...`);
                    await page.evaluate(({ sel, val }) => {
                        const el = document.querySelector(sel) as HTMLInputElement;
                        if (el) {
                            el.value = val;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                    }, { sel: selector, val: value });
                }
            } catch (e: any) {
                log(`❌ Error filling ${selector}: ${e.message}`);
            }
        };

        await fillInput(usernameSelector, username);
        await fillInput(passwordSelector, password);

        log('Handling Captcha via ANTICAPTCHA...');

        // Extract siteKey from captcha frame or page
        const captchaFrame = page.frames().find(f => f.url().includes('google.com/recaptcha/api2/anchor'));

        let siteKey = '';
        if (captchaFrame) {
            log('Captcha frame found. Extracting siteKey...');
            const url = captchaFrame.url();
            const urlParams = new URL(url).searchParams;
            siteKey = urlParams.get('k') || '';
        }

        if (!siteKey) {
            siteKey = await page.evaluate(() => {
                const el = document.querySelector('[data-sitekey]');
                return el ? (el.getAttribute('data-sitekey') || '') : '';
            });
        }

        if (!siteKey) throw new Error('Could not find reCAPTCHA sitekey');
        log(`SiteKey: ${siteKey}`);

        const acKey = input.antiCaptchaKey || process.env.ANTI_CAPTCHA_KEY;
        if (!acKey) throw new Error('Anti-Captcha selected but no key provided.');

        const token = await solveAntiCaptcha(acKey, page.url(), siteKey);

        // Inject the solved captcha token into the page
        log('Injecting captcha token into page...');
        await page.evaluate((tkn) => {
            // Set the g-recaptcha-response textarea value (by ID)
            const textarea = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement;
            if (textarea) {
                textarea.style.display = 'block';
                textarea.value = tkn;
            }

            // Also try all textareas with name g-recaptcha-response
            document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach((el) => {
                (el as HTMLTextAreaElement).value = tkn;
            });

            // Also try any textarea inside a .g-recaptcha container
            document.querySelectorAll('.g-recaptcha textarea').forEach((el) => {
                (el as HTMLTextAreaElement).value = tkn;
            });

            // Try data-callback attribute on the recaptcha container
            const container = document.querySelector('[data-sitekey]');
            if (container) {
                const callbackName = container.getAttribute('data-callback');
                if (callbackName && typeof (window as any)[callbackName] === 'function') {
                    (window as any)[callbackName](tkn);
                    return;
                }
            }

            // Try grecaptcha callback through the internal config
            try {
                if (typeof (window as any).___grecaptcha_cfg !== 'undefined') {
                    const clients = (window as any).___grecaptcha_cfg.clients;
                    for (const cKey in clients) {
                        const client = clients[cKey];
                        for (const key in client) {
                            const val = client[key];
                            if (typeof val === 'object' && val !== null) {
                                for (const k2 in val) {
                                    if (typeof val[k2] === 'object' && val[k2] !== null && typeof val[k2].callback === 'function') {
                                        val[k2].callback(tkn);
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) { /* callback not found, that's ok */ }
        }, token);
        log('✅ Captcha token injected.');

        await Actor.setValue('captcha_injected_debug.png', await page.screenshot(), { contentType: 'image/png' });

        const currentPass = await page.inputValue(passwordSelector);
        if (!currentPass) {
            log('⚠️ Password field lost value! Refilling...');
            await fillInput(passwordSelector, password);
        }

        log('Submitting login...');
        const submitBtnSelector = '.btn-entrar';

        try {
            await page.evaluate((selector) => {
                const btn = document.querySelector(selector) as HTMLElement;
                if (btn) btn.click();
            }, submitBtnSelector);
        } catch (e: any) {
            log(`JS click failed: ${e.message}`);
        }

        log('Waiting for navigation/validation...');
        await page.waitForLoadState('load', { timeout: 30000 });
        await page.waitForTimeout(3000); // Allow post-login JS to settle

        try {
            if (await page.locator('.Feedback_Message_Error').isVisible({ timeout: 5000 })) {
                const errorMsg = await page.locator('.Feedback_Message_Error').innerText();
                throw new Error(`Login failed: ${errorMsg}`);
            }
        } catch (e: any) {
            if (e.message.includes('Login failed:')) throw e;
        }

        if (page.url().includes('login') || (await page.locator(usernameSelector).count() > 0)) {
            log('⚠️ Login form still present. Verifying...');
            if (await page.url().toLowerCase().includes('login')) {
                await Actor.setValue('LOGIN_STATE.png', await page.screenshot(), { contentType: 'image/png' });
                throw new Error('Login failed or redirected back to login.');
            }

            if (await page.locator('.Feedback_Message_Error').isVisible()) {
                const finalMsg = await page.locator('.Feedback_Message_Error').innerText();
                throw new Error(`Login failed: ${finalMsg}`);
            }
        }

        // Wait for a clear sign of being logged in (e.g. logout button, dashboard element, or URL change)
        try {
            // The user confirmed that .../portal/Login.aspx IS the logged-in page.
            // The login form is on .../portal/ (default) or similar.

            await page.waitForLoadState('networkidle');

            // Check for explicit failure first
            if (await page.locator('.Feedback_Message_Error').isVisible()) {
                const finalMsg = await page.locator('.Feedback_Message_Error').innerText();
                throw new Error(`Login failed: ${finalMsg}`);
            }

            // Check for success markers
            // 1. URL is Login.aspx (User says this is success)
            // 2. "Bem vindo" text is visible
            // 3. Login inputs are gone

            const isLoginUrl = page.url().toLowerCase().includes('login.aspx');
            const hasWelcome = await page.getByText('Bem vindo', { exact: false }).isVisible();
            const hasLoginInput = await page.locator('input[id*="wtUserNameInput"]').isVisible();

            if (isLoginUrl || hasWelcome || !hasLoginInput) {
                log('✅ Login successful (detected via URL or content).');
            } else {
                await Actor.setValue('LOGIN_FAILURE_STATE.png', await page.screenshot(), { contentType: 'image/png' });
                throw new Error(`Login validation failed. URL: ${page.url()} | Has Welcome: ${hasWelcome} | Has Input: ${hasLoginInput}`);
            }

        } catch (e: any) {
            throw new Error(`Login validation error: ${e.message}`);
        }

        log(`✅ Validated! Redirected to: ${page.url()}`);
        await Actor.pushData({ status: 'success', url: page.url() });

        // --- INVOICE CAPTURE LOGIC ---
        const { installationCode, referenceMonth } = input;

        if (installationCode && referenceMonth) {
            log(`Starting Invoice Capture for Installation: ${installationCode}, Month: ${referenceMonth}`);

            // Explicitly navigate to the "Segunda Via" (Open Bills) page
            const billsUrl = 'https://agenciavirtual.light.com.br/AGV_Segunda_Via_VW/';
            if (!page.url().includes('AGV_Segunda_Via_VW')) {
                log(`Navigating to Bills Page: ${billsUrl}`);
                await page.goto(billsUrl, { waitUntil: 'networkidle', timeout: 60000 });
            } else {
                log('Already on Bills Page.');
            }

            // Check for Open Bills OR "Up to Date" message
            log('Checking for Open Bills or "Up to Date" message...');

            const openBillsSelector = '.accordion-group';
            const upToDateSelector = 'text=Você está em dia';

            let result = '';
            try {
                result = await Promise.race([
                    page.waitForSelector(openBillsSelector, { timeout: 10000 }).then(() => 'BILLS'),
                    page.waitForSelector(upToDateSelector, { timeout: 10000 }).then(() => 'UP_TO_DATE')
                ]);
            } catch (e) {
                log('⚠️ Neither bills list nor "Up to Date" message found immediately. Will try to find installation anyway.');
            }

            if (result === 'UP_TO_DATE') {
                log('ℹ️ Account is up to date (Parabéns! Você está em dia). Switching to Paid Bills...');
                await page.goto('https://agenciavirtual.light.com.br/AGV_Comprovante_Conta_Paga_VW/Comprovante_Conta_Paga.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
            } else {
                log('ℹ️ Open bills found (or fallback). Proceeding with extraction...');
            }

            // --- FIND INSTALLATION IN ACCORDION (Works for both Open and Paid bills pages mostly, signatures similar) ---
            try {
                await page.waitForSelector('.accordion-group', { timeout: 10000 });
            } catch {
                log('⚠️ Accordion group wait timeout (might be on empty paid bills page or error).');
            }

            let installLocator = page.locator('.accordion-item')
                .filter({ has: page.locator(`.verde-span:text-is("${installationCode}")`) })
                .first();

            if (await installLocator.count() === 0) {
                // If we are on Open Bills and didn't find it, maybe we should try Paid Bills if we haven't already?
                if (page.url().includes('AGV_Segunda_Via_VW') && result !== 'UP_TO_DATE') {
                    log('Installation not found on Open Bills. Trying Paid Bills page...');
                    await page.goto('https://agenciavirtual.light.com.br/AGV_Comprovante_Conta_Paga_VW/Comprovante_Conta_Paga.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
                    try { await page.waitForSelector('.accordion-group', { timeout: 10000 }); } catch { }

                    installLocator = page.locator('.accordion-item')
                        .filter({ has: page.locator(`.verde-span:text-is("${installationCode}")`) })
                        .first();
                }
            }

            if (await installLocator.count() === 0) {
                throw new Error(`Installation ${installationCode} not found on any checked page.`);
            }

            // 3. Expand Accordion
            log(`Found installation ${installationCode}. Checking expansion state...`);

            // We use the visibility of the CONTENT as the truth, not the aria attribute
            const contentDiv = installLocator.locator('.accordion-item-content').first();
            const header = installLocator.locator('.accordion-item-header').first();
            const icon = installLocator.locator('.accordion-item-icon').first();

            if (!await contentDiv.isVisible()) {
                log('Accordion content hidden. Clicking header to expand...');
                await header.click();

                try {
                    await contentDiv.waitFor({ state: 'visible', timeout: 5000 });
                } catch {
                    log('⚠️ Header click didn\'t expand content. Trying icon click...');
                    await icon.click();
                    await contentDiv.waitFor({ state: 'visible', timeout: 5000 }).catch(() => log('❌ Failed to expand accordion content!'));
                }
            } else {
                log('Accordion content already visible.');
            }

            // --- WAIT FOR DATA ---
            log('⏳ Waiting for bill list content to load (rows or empty message)...');

            // Wait for loading spinner to disappear if present
            // Wait for loading spinner to disappear if present
            // We use standard waitForSelector which is less strict about multiple matches in older Playwright versions,
            // or better yet, we just wait for network idle as the spinners are usually tied to requests.
            await page.waitForLoadState('networkidle').catch(() => { });

            try {
                // Wait for the specific global ajax wait if it appears
                await page.waitForSelector('.Feedback_AjaxWait', { state: 'attached', timeout: 2000 });
                await page.waitForSelector('.Feedback_AjaxWait', { state: 'detached', timeout: 10000 });
            } catch { }

            try {
                // Wait for rows OR alert
                await Promise.race([
                    contentDiv.locator('tr').first().waitFor({ state: 'visible', timeout: 15000 }),
                    contentDiv.locator('.alert').first().waitFor({ state: 'visible', timeout: 15000 })
                ]).catch(() => log('⚠️ Wait for content race timeout. Continuing to inspection...'));

                const rows = contentDiv.locator('tr');
                const rowCount = await rows.count();

                if (rowCount === 0) {
                    log('⚠️ No rows found. Checking for specific "No bills" alert...');
                    if (await contentDiv.locator('.alert').isVisible()) {
                        const alertText = await contentDiv.locator('.alert').innerText();
                        log(`ℹ️ Alert found: "${alertText}"`);
                        await Actor.setValue('DEBUG_NO_BILLS_ALERT.png', await page.screenshot(), { contentType: 'image/png' });
                    } else {
                        log('⚠️ Content visible but empty? Taking screenshot.');
                        await Actor.setValue('DEBUG_EMPTY_ACCORDION.png', await page.screenshot(), { contentType: 'image/png' });
                    }
                } else {
                    log(`✅ Bill list loaded. Found ${rowCount} rows.`);
                }
            } catch (e) {
                log(`⚠️ Wait for content warning: ${e}`);
            }

            // Find Bill
            log(`Searching for bill: ${referenceMonth}...`);
            let monthMatches = installLocator.locator(`span:text-is("${referenceMonth}")`);
            let count = await monthMatches.count();

            // If month not found on current page, try Paid Bills page
            if (count === 0 && !page.url().includes('Comprovante_Conta_Paga')) {
                log(`⚠️ Bill for ${referenceMonth} not found on Open Bills. Trying Paid Bills page...`);
                await page.goto('https://agenciavirtual.light.com.br/AGV_Comprovante_Conta_Paga_VW/Comprovante_Conta_Paga.aspx', { waitUntil: 'load', timeout: 30000 });
                await new Promise(r => setTimeout(r, 3000)); // settle

                try { await page.waitForSelector('.accordion-group, .accordion-item', { timeout: 10000 }); } catch { }

                // Re-find installation on paid bills page (try both possible class names)
                installLocator = page.locator('.accordion-item, .accordion-group')
                    .filter({ has: page.locator(`text="${installationCode}"`) })
                    .first();

                if (await installLocator.count() > 0) {
                    log(`Found installation ${installationCode} on Paid Bills. Expanding...`);

                    // Try multiple possible content/header selectors
                    const paidContentDiv = installLocator.locator('.accordion-item-content, .accordion-body, .accordion-inner, [id*="content"], [id*="Content"]').first();
                    const paidHeader = installLocator.locator('.accordion-item-header, .accordion-heading, .accordion-toggle, [class*="header"], [class*="Header"]').first();
                    const paidIcon = installLocator.locator('.accordion-item-icon, .accordion-toggle i, i[class*="chevron"], [class*="chevron"], .fa-angle-down, i[class*="angle-down"]').last();

                    if (await paidContentDiv.count() > 0 && (!await paidContentDiv.isVisible() || await paidContentDiv.innerText() === '')) {
                        log('Clicking header to expand...');
                        await paidHeader.click({ force: true }).catch(() => { });
                        try {
                            await paidContentDiv.waitFor({ state: 'visible', timeout: 5000 });
                        } catch {
                            log('⚠️ Header click didn\'t expand. Trying icon click (which might be the orange multiple bills chevron)...');
                            if (await paidIcon.count() > 0) {
                                await paidIcon.click({ force: true }).catch(() => { });
                                await paidContentDiv.waitFor({ state: 'visible', timeout: 5000 }).catch(() => log('❌ Failed to wait for accordion content visibility!'));
                            }
                        }
                    }

                    // Wait for AJAX content to load — use load + settle, not networkidle
                    await page.waitForLoadState('load').catch(() => { });
                    await new Promise(r => setTimeout(r, 5000)); // extra settle for AJAX content

                    try {
                        await page.waitForSelector('.Feedback_AjaxWait', { state: 'attached', timeout: 2000 });
                        await page.waitForSelector('.Feedback_AjaxWait', { state: 'detached', timeout: 15000 });
                    } catch { }

                    // Additional settle after AJAX completes
                    await new Promise(r => setTimeout(r, 4000));

                    // Screenshot for diagnostics
                    await Actor.setValue('DEBUG_PAID_BILLS.png', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });

                    // Count rows in the whole installation block (some pages use table, some use div lists)
                    // Be careful not to match main structural .row elements if they aren't records
                    const paidRows = installLocator.locator('tr, .list-record, .TableVerticalAlign, .row.align-items-center');
                    const paidRowCount = await paidRows.count();
                    log(`Paid Bills: Found ${paidRowCount} record elements in installation block.`);

                    // Search for the month within the entire installation block
                    monthMatches = installLocator.locator(`text="${referenceMonth}"`);
                    count = await monthMatches.count();
                    log(`Paid Bills: Found ${count} month match(es) for ${referenceMonth}`);
                } else {
                    log(`❌ Installation ${installationCode} not found on Paid Bills page either.`);
                    await Actor.setValue('DEBUG_PAID_BILLS_PAGE.png', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
                }
            }

            if (count === 0) {
                log(`❌ Bill for ${referenceMonth} not found on any page.`);
                await Actor.setValue('BILL_NOT_FOUND.png', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
                await Actor.setValue('BILL_NOT_FOUND_DUMP.html', await page.content(), { contentType: 'text/html' });
            } else {
                log(`Found ${count} bill(s) for ${referenceMonth}. Downloading...`);

                for (let i = 0; i < count; i++) {
                    const match = monthMatches.nth(i);

                    // Download button selectors based on recent site updates
                    const btnSelectors = '.fa-download, .fa-file-pdf-o, a[href*="Download" i], [id*="Download" i], [onclick*="download" i], button:has-text("Baixar"), span:has-text("Download"), span:has-text("Baixar"), a:has-text("Baixar"), a:has-text("Download"), .material-symbols-outlined:has-text("download"), [class*="material-symbols"]:has-text("download")';

                    // Strategy 1: Look for download button in ancestor <tr> or .TableVerticalAlign or .row (table/grid layout)
                    let downloadBtn = null;
                    for (const xpath of ['./ancestor::tr', './ancestor::div[contains(@class, "TableVerticalAlign")]', './ancestor::div[contains(@class, "row")]']) {
                        const ancestorRow = match.locator(`xpath=${xpath}`);
                        if (await ancestorRow.count() > 0) {
                            const btnInRow = ancestorRow.locator(btnSelectors).first();
                            if (await btnInRow.count() > 0) {
                                downloadBtn = btnInRow;
                                log(`  📎 Found download button in ancestor grid/row (${xpath})`);
                                break;
                            }
                        }
                    }

                    // Strategy 2: Look in parent containers (div-based layouts)
                    if (!downloadBtn) {
                        for (const xpath of ['./ancestor::div[1]', './ancestor::div[2]', './ancestor::div[3]', './ancestor::li[1]', './ancestor::*[contains(@class,"row")][1]']) {
                            const container = match.locator(`xpath=${xpath}`);
                            if (await container.count() > 0) {
                                const btnInContainer = container.locator(btnSelectors).first();
                                if (await btnInContainer.count() > 0) {
                                    downloadBtn = btnInContainer;
                                    log(`  📎 Found download button via xpath: ${xpath}`);
                                    break;
                                }
                            }
                        }
                    }

                    // Strategy 3: Find ALL download-like buttons in the installation block and use the nth one
                    if (!downloadBtn) {
                        const allButtons = installLocator.locator(btnSelectors);
                        const btnCount = await allButtons.count();
                        log(`  🔍 Fallback: Found ${btnCount} download-like buttons in installation block`);
                        if (btnCount > i) {
                            downloadBtn = allButtons.nth(i);
                            log(`  📎 Using download button at index ${i}`);
                        }
                    }

                    if (downloadBtn && await downloadBtn.count() > 0) {
                        const savePath = path.join(storageDir, `invoice_${installationCode}_${referenceMonth.replace(/\//g, '-')}_${i + 1}.pdf`);

                        // We must click the wrapper <a> if the icon itself is matched but the click needs to be on the link
                        let elementToClick = downloadBtn;
                        const parentA = downloadBtn.locator('xpath=./ancestor::a').first();
                        if (await parentA.count() > 0) {
                            elementToClick = parentA;
                        }

                        const [download] = await Promise.all([
                            page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
                            elementToClick.click({ force: true })
                        ]);

                        if (download) {
                            await download.saveAs(savePath);
                            log(`✅ Downloaded: ${savePath}`);

                            const key = `invoice_${installationCode}_${referenceMonth.replace(/\//g, '-')}_${i + 1}.pdf`;
                            await Actor.setValue(key, fs.readFileSync(savePath), { contentType: 'application/pdf' });

                            await Actor.pushData({
                                status: 'downloaded',
                                file: key,
                                installation: installationCode,
                                month: referenceMonth
                            });
                        } else {
                            log(`⚠️ Download event did not trigger for match ${i + 1}`);
                            throw new Error('Download event timeout');
                        }
                    } else {
                        log(`⚠️ Download button not found for match ${i + 1}. Taking diagnostic screenshot...`);
                        await Actor.setValue(`DEBUG_NO_DL_BTN_${i + 1}.png`, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
                        await Actor.setValue('PAGE_DUMP.html', await page.content(), { contentType: 'text/html' });
                    }
                }
            }
        }
    } catch (e: any) {
        log(`❌ Error: ${e.message}`);
        try {
            await Actor.setValue('ERROR_SCREENSHOT.png', await page.screenshot(), { contentType: 'image/png' });
            await Actor.setValue('PAGE_DUMP.html', await page.content(), { contentType: 'text/html' });
        } catch { }
        await Actor.fail(e.message);
    } finally {
        if (browser) await browser.close();
        await Actor.exit();
    }
} catch (e: any) {
    log(`❌ Fatal Error (Outer): ${e.message}`);
    await Actor.fail(e.message);
}
