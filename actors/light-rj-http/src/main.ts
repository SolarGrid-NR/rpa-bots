import { Actor } from 'apify';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

// --- Logging ---
function log(msg: string) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`);
}

// --- Anti-Captcha Solver ---
async function solveAntiCaptcha(apiKey: string, siteUrl: string, siteKey: string): Promise<string> {
    log('Requesting Anti-Captcha task...');
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
    log(`Task created: ${taskId}. Polling...`);

    let attempts = 0;
    while (attempts < 200) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        attempts++;

        const result = await axios.post('https://api.anti-captcha.com/getTaskResult', {
            clientKey: apiKey,
            taskId: taskId
        });

        if (result.data.errorId !== 0) {
            throw new Error(`Anti-Captcha Task Error: ${result.data.errorDescription}`);
        }

        if (result.data.status === 'ready') {
            log('✅ Anti-Captcha solved!');
            return result.data.solution.gRecaptchaResponse;
        }

        if (attempts % 5 === 0) log('Still waiting for captcha solution...');
    }

    throw new Error('Anti-Captcha timeout.');
}

// --- Input Interface ---
interface Input {
    username: string;
    password: string;
    antiCaptchaKey?: string;
    captchaService?: 'ANTICAPTCHA';
    installationCode?: string;
    referenceMonth?: string;
}

// --- MAIN ---
await Actor.init();

try {
    const storageDir = process.env.APIFY_LOCAL_STORAGE_DIR || './storage';
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

    const input = await Actor.getInput<Input>();
    if (!input || !input.username || !input.password) {
        throw new Error('Missing required input: username, password');
    }

    const { installationCode, referenceMonth } = input;
    // Only strip non-digits if input looks like a CPF/CNPJ (mostly digits)
    // If it contains @ or is mostly non-numeric, use as-is (email)
    const rawUsername = input.username.trim();
    const digitsOnly = rawUsername.replace(/\D/g, '');
    const username = rawUsername.includes('@') || digitsOnly.length < rawUsername.length / 2
        ? rawUsername
        : digitsOnly;

    log(`Starting Light RJ HTTP Worker for user: ${username}`);
    log(`Installation: ${installationCode}, Month: ${referenceMonth}`);

    // --- Configure HTTP Client with Proxy ---
    log('Configuring Apify residential proxy...');
    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'BR',
    });
    const proxyUrl = await proxyConfiguration?.newUrl();

    const clientConfig: any = {
        timeout: 30000,
        maxRedirects: 5,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'sec-ch-ua': '"" Not A;Brand";v="99", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        },
    };

    if (proxyUrl) {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        clientConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
        clientConfig.httpAgent = new HttpsProxyAgent(proxyUrl);
        log(`✅ Proxy configured: ${proxyUrl.replace(/:[^:]+@/, ':***@')}`);
    }

    const client = axios.create(clientConfig);

    // Cookie jar (manual — simpler than tough-cookie for this use case)
    let cookies: Record<string, string> = {};

    function parseCookies(setCookieHeaders: string[] | undefined) {
        if (!setCookieHeaders) return;
        for (const header of setCookieHeaders) {
            const [pair] = header.split(';');
            const [name, value] = pair.split('=');
            if (name && value !== undefined) {
                cookies[name.trim()] = value.trim();
            }
        }
    }

    function cookieString(): string {
        return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    // ====================================================================
    // STEP 1: GET Login Page — extract __OSVSTATE and siteKey
    // ====================================================================
    log('--- STEP 1: GET Login Page ---');
    const loginPageUrl = 'https://agenciavirtual.light.com.br/portal/';

    const step1 = await client.get(loginPageUrl, {
        headers: { 'Upgrade-Insecure-Requests': '1' },
        maxRedirects: 10,
    });

    parseCookies(step1.headers['set-cookie']);
    // Also add device cookies that the browser would set via JS
    cookies['DEVICE_OS'] = 'windows';
    cookies['DEVICES_TYPE'] = 'desktop';
    cookies['DEVICE_BROWSER'] = 'chrome';
    cookies['DEVICE_ORIENTATION'] = 'undefined';
    cookies['pageLoadedFromBrowserCache'] = 'false';

    log(`Cookies after GET: ${Object.keys(cookies).join(', ')}`);

    const $ = cheerio.load(step1.data);

    // Extract __OSVSTATE (OutSystems' ViewState)
    const osvState = $('input[name="__OSVSTATE"]').val() as string || '';
    const viewStateGen = $('input[name="__VIEWSTATEGENERATOR"]').val() as string || '';
    log(`__OSVSTATE length: ${osvState.length} chars`);
    log(`__VIEWSTATEGENERATOR: ${viewStateGen}`);

    if (!osvState) {
        await Actor.setValue('DEBUG_LOGIN_PAGE.html', step1.data, { contentType: 'text/html' });
        throw new Error('Could not extract __OSVSTATE from login page');
    }

    // Extract reCAPTCHA siteKey
    const siteKey = $('[data-sitekey]').attr('data-sitekey') || '6LcLDd8UAAAAAKr1i2M1bsq6c9dg6vAGAmJGAROF';
    log(`SiteKey: ${siteKey}`);

    // Extract form field name prefixes (they may vary between deployments)
    // Look for the username input to get the full field name
    const usernameInput = $('input[id*="wtUserNameInput"]');
    const passwordInput = $('input[id*="wtPasswordInput"]');
    const usernameFieldName = usernameInput.attr('name') || '';
    const passwordFieldName = passwordInput.attr('name') || '';
    log(`Username field: ${usernameFieldName}`);
    log(`Password field: ${passwordFieldName}`);

    if (!usernameFieldName || !passwordFieldName) {
        await Actor.setValue('DEBUG_LOGIN_PAGE.html', step1.data, { contentType: 'text/html' });
        throw new Error('Could not find username/password field names in login page HTML');
    }

    // Find the "Lembra conta" checkbox and ENTRAR button field names
    const lembraContaInput = $('input[id*="wtLembraConta"]');
    const entrarButton = $('input[id*="wtEntrar"][value="ENTRAR"]');
    const lembraContaFieldName = lembraContaInput.attr('name') || '';
    const entrarFieldName = entrarButton.attr('name') || '';

    // Find search bar fields (there are some in the header)
    // These appear as empty fields in the POST body
    const searchFields: Record<string, string> = {};
    $('input[id*="wt3"][type="text"]').each((_, el) => {
        const name = $(el).attr('name');
        if (name) searchFields[name] = '';
    });

    // ====================================================================
    // STEP 2: Solve Captcha + POST Login
    // ====================================================================
    log('--- STEP 2: Solve Captcha + POST Login ---');

    const acKey = input.antiCaptchaKey || process.env.ANTI_CAPTCHA_KEY;
    if (!acKey) throw new Error('Anti-Captcha key not provided.');

    const captchaToken = await solveAntiCaptcha(acKey, loginPageUrl, siteKey);
    log(`Captcha token length: ${captchaToken.length}`);

    // Build login POST body — MUST include ALL form fields (ASP.NET WebForms requirement)
    // Collect every input/select/textarea from the login page form
    const loginBody: Record<string, string> = {};

    // Get all hidden inputs
    $('input[type="hidden"]').each((_, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value') || '';
        if (name) loginBody[name] = value;
    });

    // Get all text/search/password inputs
    $('input[type="text"], input[type="search"], input[type="password"], input[type="email"]').each((_, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value') || '';
        if (name) loginBody[name] = value;
    });

    // Get all checkboxes that are checked
    $('input[type="checkbox"]:checked').each((_, el) => {
        const name = $(el).attr('name');
        if (name) loginBody[name] = 'on';
    });

    // Now override with our specific values
    loginBody['__OSVSTATE'] = osvState;
    loginBody['__EVENTTARGET'] = '';
    loginBody['__EVENTARGUMENT'] = '';
    loginBody[usernameFieldName] = username;
    loginBody[passwordFieldName] = input.password;
    loginBody['g-recaptcha-response'] = captchaToken;

    // Add the ENTRAR button (simulates clicking it)
    if (entrarFieldName) loginBody[entrarFieldName] = 'ENTRAR';

    // Add the "Lembra conta" checkbox
    if (lembraContaFieldName) loginBody[lembraContaFieldName] = 'on';

    log(`POST body field count: ${Object.keys(loginBody).length}`);
    log(`POST fields: ${Object.keys(loginBody).join(', ')}`);

    const loginUrl = 'https://agenciavirtual.light.com.br/portal/Login.aspx';
    const step2 = await client.post(loginUrl, new URLSearchParams(loginBody).toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://agenciavirtual.light.com.br',
            'Referer': loginPageUrl,
            'Upgrade-Insecure-Requests': '1',
            'Cookie': cookieString(),
        },
        maxRedirects: 10,
        validateStatus: (s) => s < 400, // Accept 2xx and 3xx
    });

    // Log raw response headers for debugging
    log(`Login response status: ${step2.status}`);
    log(`Login response headers: ${JSON.stringify(Object.keys(step2.headers))}`);
    const rawSetCookie = step2.headers['set-cookie'];
    if (rawSetCookie) {
        log(`Set-Cookie headers found: ${rawSetCookie.length} entries`);
        for (const c of rawSetCookie) {
            log(`  Set-Cookie: ${c.substring(0, 80)}...`);
        }
    } else {
        log('⚠️ No Set-Cookie headers in login response');
    }

    parseCookies(step2.headers['set-cookie']);

    // OutSystems sets session cookies via JavaScript in the HTML response
    // Look for patterns like: document.cookie = 'AGV_UserProvider.sid=...'
    // or OsCookies.setCookie('agv-username', '...')
    const responseHtml = step2.data as string;
    const jsCookiePatterns = [
        /document\.cookie\s*=\s*['"]([^'"]+)['"]/g,
        /setCookie\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
        /AGV_UserProvider\.sid[=:]\s*['"]?([^'";,\s]+)/g,
        /agv-username[=:]\s*['"]?([^'";,\s]+)/g,
    ];

    for (const pattern of jsCookiePatterns) {
        const matches = [...responseHtml.matchAll(pattern)];
        for (const match of matches) {
            log(`Found JS cookie pattern: ${match[0].substring(0, 100)}`);
            if (match[0].includes('document.cookie')) {
                // Parse "name=value; path=/" format
                const cookieStr = match[1];
                const [pair] = cookieStr.split(';');
                const eqIdx = pair.indexOf('=');
                if (eqIdx > 0) {
                    const name = pair.substring(0, eqIdx).trim();
                    const value = pair.substring(eqIdx + 1).trim();
                    cookies[name] = value;
                    log(`  → Extracted JS cookie: ${name}=${value.substring(0, 30)}...`);
                }
            } else if (match[0].includes('setCookie')) {
                cookies[match[1]] = match[2];
                log(`  → Extracted setCookie: ${match[1]}=${match[2].substring(0, 30)}...`);
            }
        }
    }

    log(`Cookies after login (with JS extraction): ${Object.keys(cookies).join(', ')}`);

    // Check if the response page title indicates success
    const $loginResp = cheerio.load(responseHtml);
    const pageTitle = $loginResp('title').text().trim();
    log(`Login response page title: "${pageTitle}"`);

    // Validate login success
    const hasSessionCookie = 'AGV_UserProvider.sid' in cookies;
    const hasUsernameCookie = 'agv-username' in cookies;

    if (!hasSessionCookie || !hasUsernameCookie) {
        // If the page title is "Início", login succeeded but cookies were set differently
        if (pageTitle.includes('Início') || pageTitle.includes('Inicio')) {
            log('⚠️ Page title indicates login success but cookies not found. Saving full response for analysis.');
        }

        // Check for error messages in the response
        const errorText = $loginResp('.Feedback_Message_Error').text().trim();
        if (errorText) {
            throw new Error(`Login failed: ${errorText}`);
        }
        await Actor.setValue('DEBUG_LOGIN_RESPONSE.html', step2.data, { contentType: 'text/html' });
        throw new Error('Login failed: session cookies not set. Check DEBUG_LOGIN_RESPONSE.html');
    }

    log(`✅ Login successful! Session: ${cookies['AGV_UserProvider.sid'].substring(0, 20)}...`);

    if (!installationCode || !referenceMonth) {
        log('No installationCode/referenceMonth provided. Login-only test complete.');
        await Actor.pushData({ status: 'login_success', cookies: Object.keys(cookies) });
        await Actor.exit();
    }

    // ====================================================================
    // STEP 3: GET Paid Bills Page — parse accordion, find bill
    // ====================================================================
    log('--- STEP 3: GET Paid Bills Page ---');

    const billsUrl = 'https://agenciavirtual.light.com.br/AGV_Comprovante_Conta_Paga_VW/Comprovante_Conta_Paga.aspx';
    const step3 = await client.get(billsUrl, {
        headers: {
            'Cookie': cookieString(),
            'Referer': loginUrl,
            'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 10,
    });

    parseCookies(step3.headers['set-cookie']);
    const $bills = cheerio.load(step3.data);

    log(`Bills page HTML length: ${step3.data.length} chars`);

    // Find the installation in the accordion
    // The accordion uses .card-instalacao with .verde-span containing installation code
    const pageText = step3.data as string;
    const hasInstallation = pageText.includes(installationCode);
    log(`Installation ${installationCode} found on page: ${hasInstallation}`);

    if (!hasInstallation) {
        await Actor.setValue('DEBUG_BILLS_PAGE.html', step3.data, { contentType: 'text/html' });
        throw new Error(`Installation ${installationCode} not found on Paid Bills page.`);
    }

    // Find the month in the page text
    const hasMonth = pageText.includes(referenceMonth);
    log(`Month ${referenceMonth} found on page: ${hasMonth}`);

    if (!hasMonth) {
        // The bills might be loaded via AJAX after accordion expansion
        // We need to find the accordion expand AJAX call
        log('⚠️ Month not found in initial page load. Trying AJAX accordion expansion...');

        // Extract __OSVSTATE from the bills page for the AJAX call
        const billsOsvState = $bills('input[name="__OSVSTATE"]').val() as string || '';
        const billsViewStateGen = $bills('input[name="__VIEWSTATEGENERATOR"]').val() as string || '';

        // Find the accordion toggle button/event target for this installation
        // Looking for the CustomAccordionItem click handler
        const accordionClickTarget = findAccordionClickTarget($bills, installationCode);

        if (accordionClickTarget && billsOsvState) {
            log(`Found accordion click target: ${accordionClickTarget}`);

            // Build AJAX POST to expand accordion
            const ajaxBody: Record<string, string> = {
                '__EVENTTARGET': accordionClickTarget,
                '__EVENTARGUMENT': '',
                '__OSVSTATE': billsOsvState,
                '__VIEWSTATE': '',
                '__VIEWSTATEGENERATOR': billsViewStateGen,
            };

            // Get all form fields from the bills page
            $bills('input[type="hidden"], input[type="text"], select').each((_, el) => {
                const name = $bills(el).attr('name');
                const value = $bills(el).attr('value') || $bills(el).val() as string || '';
                if (name && !ajaxBody[name]) {
                    ajaxBody[name] = value;
                }
            });

            const ts = Date.now();
            const ajaxUrl = `${billsUrl}?_ts=${ts}`;

            const ajaxResponse = await client.post(ajaxUrl, new URLSearchParams(ajaxBody).toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cookie': cookieString(),
                    'Origin': 'https://agenciavirtual.light.com.br',
                    'Referer': billsUrl,
                },
            });

            parseCookies(ajaxResponse.headers['set-cookie']);
            const ajaxData = ajaxResponse.data as string;
            log(`AJAX response length: ${ajaxData.length} chars`);

            const ajaxHasMonth = ajaxData.includes(referenceMonth);
            log(`Month ${referenceMonth} found in AJAX response: ${ajaxHasMonth}`);

            if (!ajaxHasMonth) {
                await Actor.setValue('DEBUG_AJAX_RESPONSE.html', ajaxData, { contentType: 'text/html' });
                throw new Error(`Month ${referenceMonth} not found after AJAX expansion.`);
            }

            // Parse the AJAX response to find download link
            const downloadUrl = extractDownloadUrl(ajaxData, referenceMonth, installationCode);
            if (downloadUrl) {
                await downloadPdf(client, downloadUrl, installationCode, referenceMonth, storageDir, cookies);
            } else {
                await Actor.setValue('DEBUG_AJAX_RESPONSE.html', ajaxData, { contentType: 'text/html' });
                throw new Error('Could not find download link in AJAX response.');
            }
        } else {
            await Actor.setValue('DEBUG_BILLS_PAGE.html', step3.data, { contentType: 'text/html' });
            throw new Error('Could not find accordion click target for AJAX expansion.');
        }
    } else {
        // Month found in initial page — extract download link directly
        const downloadUrl = extractDownloadUrl(pageText, referenceMonth, installationCode);
        if (downloadUrl) {
            await downloadPdf(client, downloadUrl, installationCode, referenceMonth, storageDir, cookies);
        } else {
            // Try the AJAX approach as fallback
            await Actor.setValue('DEBUG_BILLS_PAGE.html', step3.data, { contentType: 'text/html' });
            throw new Error('Month found but could not extract download link.');
        }
    }

} catch (e: any) {
    log(`❌ Error: ${e.message}`);
    await Actor.fail(e.message);
} finally {
    await Actor.exit();
}

// ====================================================================
// HELPER FUNCTIONS
// ====================================================================

function findAccordionClickTarget($: cheerio.CheerioAPI, installationCode: string): string | null {
    // Look for onclick handlers near the installation code
    // OutSystems pattern: OsAjax(arguments[0], 'EVENTTARGET', ...)
    const html = $.html();

    // Find the accordion item containing the installation code
    // Pattern: onclick="OsAjax(arguments[0] || window.event,'AGV_UI_th_..._block_wt5',..."
    const regex = /onclick="[^"]*OsAjax\([^,]*,\s*'([^']+_block_wt5)'/g;
    const matches = [...html.matchAll(regex)];

    if (matches.length > 0) {
        // Return the first match — if there are multiple installations,
        // we might need to find the right one
        return matches[0][1].replace(/_/g, '$').replace(/\$/g, '$');
    }

    // Fallback: look for the accordion-item-header click event
    const regex2 = /onclick="[^"]*OsAjax\([^,]*,\s*'([^']+CustomAccordionItem[^']+)'/g;
    const matches2 = [...html.matchAll(regex2)];
    if (matches2.length > 0) {
        return matches2[0][1];
    }

    return null;
}

function extractDownloadUrl(html: string, referenceMonth: string, installationCode: string): string | null {
    // Strategy 1: Look for direct download link near the reference month
    // Pattern in HAR: href="ModalDownload_ComprovanteConta.aspx?CodigoInstalacao=XXX&..."
    const modalLinkRegex = /href="(ModalDownload_ComprovanteConta\.aspx\?[^"]+)"/g;
    const modalMatches = [...html.matchAll(modalLinkRegex)];

    for (const match of modalMatches) {
        const url = match[1];
        if (url.includes(installationCode)) {
            return `https://agenciavirtual.light.com.br/AGV_Comprovante_Conta_Paga_VW/${url.replace(/&amp;/g, '&')}`;
        }
    }

    // Strategy 2: Look for download icon/button links
    // Pattern: <a href="..." class="...download..."
    const $ = cheerio.load(html);

    // Find all card-accordion blocks
    const cards = $('[class*="card-accordion"]');
    let downloadLink: string | null = null;

    cards.each((_, card) => {
        const cardHtml = $(card).html() || '';
        if (cardHtml.includes(referenceMonth)) {
            // Found the card with our month — look for download link/button
            const links = $(card).find('a[href*="Download"], a[href*="download"], a[onclick*="download" i]');
            if (links.length > 0) {
                const href = links.first().attr('href');
                if (href && !href.startsWith('javascript:')) {
                    downloadLink = href.startsWith('http') ? href : `https://agenciavirtual.light.com.br${href}`;
                }
            }

            // Also check for onclick with OsAjax download trigger
            const downloadBtns = $(card).find('[onclick*="Download"], [onclick*="download"]');
            if (downloadBtns.length > 0) {
                const onclick = downloadBtns.first().attr('onclick') || '';
                const eventTargetMatch = onclick.match(/OsAjax\([^,]*,\s*'([^']+)'/);
                if (eventTargetMatch) {
                    // This is an AJAX download — we'll need to trigger it via POST
                    log(`Found AJAX download event target: ${eventTargetMatch[1]}`);
                    downloadLink = `AJAX:${eventTargetMatch[1]}`;
                }
            }
        }
    });

    return downloadLink;
}

async function downloadPdf(
    client: AxiosInstance,
    downloadUrl: string,
    installationCode: string,
    referenceMonth: string,
    storageDir: string,
    cookies: Record<string, string>
) {
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const savePath = path.join(storageDir, `invoice_${installationCode}_${referenceMonth.replace(/\//g, '-')}_1.pdf`);

    if (downloadUrl.startsWith('AJAX:')) {
        // AJAX-triggered download — need to POST to the bills page with the event target
        log('Download requires AJAX trigger — this flow is not yet implemented.');
        throw new Error('AJAX download not implemented yet. Need to capture the exact POST flow.');
    }

    log(`Downloading PDF from: ${downloadUrl}`);

    const response = await client.get(downloadUrl, {
        headers: {
            'Cookie': cookieStr,
            'Referer': 'https://agenciavirtual.light.com.br/AGV_Comprovante_Conta_Paga_VW/Comprovante_Conta_Paga.aspx',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || '';
    log(`Response: ${response.status}, Content-Type: ${contentType}, Size: ${buffer.length} bytes`);

    // Validate it's a PDF
    const header = buffer.toString('utf-8', 0, 5);
    if (header !== '%PDF-') {
        // Might be an HTML page (e.g., modal page that generates the PDF)
        log(`⚠️ Response is not a direct PDF (header: "${header}"). Might be an intermediate page.`);

        // Save for debugging
        await Actor.setValue('DEBUG_DOWNLOAD_RESPONSE.html', buffer.toString('utf-8'), { contentType: 'text/html' });

        // Try to parse as HTML and look for the actual PDF link
        const $dl = cheerio.load(buffer.toString('utf-8'));
        const pdfLink = $dl('a[href*=".pdf"], a[href*="Download"], iframe[src*=".pdf"]');
        if (pdfLink.length > 0) {
            const pdfUrl = pdfLink.first().attr('href') || pdfLink.first().attr('src') || '';
            if (pdfUrl) {
                const fullPdfUrl = pdfUrl.startsWith('http') ? pdfUrl : `https://agenciavirtual.light.com.br${pdfUrl}`;
                log(`Found PDF link in intermediate page: ${fullPdfUrl}`);
                return downloadPdf(client, fullPdfUrl, installationCode, referenceMonth, storageDir, cookies);
            }
        }

        throw new Error('Downloaded content is not a PDF. Check DEBUG_DOWNLOAD_RESPONSE.html');
    }

    // Save PDF
    fs.writeFileSync(savePath, buffer);
    log(`✅ PDF saved: ${savePath} (${buffer.length} bytes)`);

    const key = `invoice_${installationCode}_${referenceMonth.replace(/\//g, '-')}_1.pdf`;
    await Actor.setValue(key, buffer, { contentType: 'application/pdf' });

    await Actor.pushData({
        status: 'downloaded',
        file: key,
        installation: installationCode,
        month: referenceMonth,
        sizeBytes: buffer.length,
    });

    log('✅ Invoice capture complete!');
}
