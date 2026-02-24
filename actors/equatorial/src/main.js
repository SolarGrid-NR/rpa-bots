
import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

await Actor.init();

const input = await Actor.getInput() || {};
const { uc, cpf } = input;

console.log(`Processing with UC: ${uc} and CPF: ${cpf}`);

const crawler = new PlaywrightCrawler({
    launchContext: {
        launcher: chromium,
        launchOptions: {
            headless: true, // Set to false to see the browser
        }
    },
    requestHandler: async ({ page }) => {
        console.log('Navigating to Google...');
        await page.goto('https://www.google.com');
        
        // Just a test action
        if (uc) {
            await page.fill('textarea[name="q"]', `Equatorial UC ${uc}`);
        }
        
        const screenshot = await page.screenshot();
        await Actor.setValue('RESULT_SCREENSHOT', screenshot, { contentType: 'image/png' });
        await Actor.pushData({
            status: 'Success',
            uc,
            cpf,
            message: 'Screenshot saved to Key-Value Store'
        });
        console.log('Screenshot saved.');
    },
});

await crawler.run(['https://www.google.com']);

await Actor.exit();
