import { Actor } from 'apify';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Helper logging function
function log(msg: string) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`);
}

chromium.use(stealthPlugin());

await Actor.init();

interface Input {
    uc: string;
    cpf: string;
    targetDate?: string;
}

// DEBUG & FALLBACK: Check storage manually if Actor.getInput() fails
const storageDir = process.env.APIFY_LOCAL_STORAGE_DIR;

let input = await Actor.getInput<Input>();

if (!input && storageDir) {
    log('⚠️ WARNING: Actor.getInput() returned null. Attempting manual read from disk...');
    try {
        const inputPath = path.join(storageDir, 'key_value_stores', 'default', 'INPUT.json');
        if (fs.existsSync(inputPath)) {
            const rawContent = fs.readFileSync(inputPath, 'utf-8');
            input = JSON.parse(rawContent) as Input;
            log('✅ SUCCESS: Input read manually from disk.');
        } else {
            log('❌ ERROR: INPUT.json not found during manual fallback.');
        }
    } catch (e: any) {
        console.error(`❌ ERROR: Failed manual input read: ${e.message}`);
    }
}

log(`Final Input Object: ${JSON.stringify(input, null, 2)}`);
log(`Environment APIFY_LOCAL_STORAGE_DIR: ${process.env.APIFY_LOCAL_STORAGE_DIR}`);

const uc = input?.uc;
const cpf = input?.cpf;
const targetDate = input?.targetDate || '12/2025';

if (!uc || !cpf) throw new Error('UC e CPF são obrigatórios!');

// --- ESTA MENSAGEM TEM QUE APARECER NO LOG ---
log(`🚀 INICIANDO MODO LOCAL (SEM PROXY)`);
log(`🎯 Alvo: Equatorial | UC: ${uc}`);

// ==================================================================
// CONFIGURAÇÃO DO BROWSER
// ==================================================================
let launchOptions: any = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--ignore-certificate-errors',
        '--disable-popup-blocking'
    ]
};

// ==================================================================
// NAVEGADOR
// ==================================================================
log('Lançando navegador...');
const browser = await chromium.launch(launchOptions);

const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    ignoreHTTPSErrors: true
});

const page = await context.newPage();
// Timeout mais curto conforme pedido (10s)
page.setDefaultTimeout(10000);

try {
    log('Acessando Login...');

    const response = await page.goto('https://goias.equatorialenergia.com.br/LoginGO.aspx?envia-dados=Entrar', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    if (response) {
        log(`Status HTTP: ${response.status()}`);
    }

    log('Esperando formulário...');
    await page.waitForSelector('#WEBDOOR_headercorporativogo_txtUC', { timeout: 40000 });

    log('✅ Conectado! Preenchendo...');
    await page.locator('#WEBDOOR_headercorporativogo_txtUC').pressSequentially(uc, { delay: 100 });
    await page.waitForTimeout(200);
    await page.locator('#WEBDOOR_headercorporativogo_txtDocumento').pressSequentially(cpf, { delay: 100 });

    log('Entrando...');
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Entrar' }).click();
    await nav;

    if (page.url().includes('LoginGO.aspx')) throw new Error('Login falhou (não redirecionou).');
    log('Login OK!');

    // Fecha Banner
    try {
        log('Checking for promo banner...');
        const btnPromo = page.locator('#popup_promocao .ModalButton', { hasText: 'OK' });
        if (await btnPromo.isVisible({ timeout: 5000 })) {
            await btnPromo.click();
            log('Promo banner dismissed.');
        }
    } catch (e) { }

    // Histórico
    log('Indo para Faturas...');
    await page.goto('https://goias.equatorialenergia.com.br/AgenciaGO/Servi%C3%A7os/comum/HistoricoFaturas.aspx', { waitUntil: 'domcontentloaded' });

    // Seleção UC/Ano
    await page.waitForSelector('#CONTENT_comboBoxUC');

    if ((await page.inputValue('#CONTENT_comboBoxUC')) !== uc) {
        log(`Selecting UC: ${uc}`);
        await page.selectOption('#CONTENT_comboBoxUC', uc);
        await page.waitForLoadState('domcontentloaded');
    }

    const [mes, ano] = targetDate.split('/');
    if ((await page.inputValue('#CONTENT_ddReferencia')) !== ano) {
        log(`Selecting Year: ${ano}`);
        await page.selectOption('#CONTENT_ddReferencia', ano);
        await page.waitForLoadState('domcontentloaded');
    }

    log('Clicking "Consultar"...');
    await page.locator('#CONTENT_btEnviar').click();

    // ==================================================================
    // TRATAMENTO DO MODAL DE PROTOCOLO
    // ==================================================================
    log('Verificando se há modal de protocolo...');
    try {
        // O modal pode demorar um pouco ou ser rápido. Vamos esperar por ele.
        // Se ele não aparecer em 5s, assumimos que não bloqueou ou não existe.
        const modalSelector = '#CONTENT_upModal .ModalButton'; // Botão OK do modal ESPECÍFICO de protocolo
        const modal = page.locator(modalSelector, { hasText: 'OK' });

        if (await modal.isVisible({ timeout: 5000 })) {
            log('ℹ️ Modal de protocolo detectado! Confirmando...');
            await modal.click();
            // Espera o modal sumir
            await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => { });
            log('✅ Modal confirmado e fechado.');
        } else {
            log('ℹ️ Nenhum modal bloqueante detectado (timeout). Seguindo...');
        }
    } catch (e: any) {
        log(`ℹ️ Erro/Timeout na verificação do modal (não impactante): ${e.message}`);
    }

    // Wait for the grid to update/load
    log('Waiting for results grid...');
    await page.waitForSelector('tr.GridRow', { timeout: 10000 }).catch(() => log('Grid row not immediately found, checking if empty...'));

    // ==================================================================
    // TRATAMENTO DO MODAL DE HISTÓRICO (BLOQUEANTE)
    // ==================================================================
    log('Verificando se há modal de histórico bloqueando...');
    try {
        const histModal = page.locator('#historicoFaturaModal');
        if (await histModal.isVisible({ timeout: 5000 })) {
            log('ℹ️ Modal "historicoFaturaModal" detectado! Tentando fechar...');

            // Tenta encontrar botão de fechar genérico
            const closeBtn = histModal.locator('.btn-primary, .close, button.close, .ModalButton');
            if (await closeBtn.count() > 0) {
                await closeBtn.first().click();
                await histModal.waitFor({ state: 'hidden', timeout: 5000 });
                log('✅ Modal de histórico fechado via botão.');
            } else {
                log('⚠️ Botão de fechar não encontrado. Tentando ocultar via JS...');
                await page.evaluate(() => {
                    const m = document.querySelector('#historicoFaturaModal');
                    if (m) {
                        // @ts-ignore
                        if (typeof $ !== 'undefined') $(m).modal('hide');
                        else m.remove();
                    }
                });
            }
        }
    } catch (e: any) {
        log(`ℹ️ Erro na verificação do modal histórico: ${e.message}`);
    }

    // Download
    log(`Baixando ${targetDate}...`);
    const row = page.locator('tr.GridRow').filter({ hasText: targetDate });
    // Verify count
    const count = await row.count();
    if (count === 0) throw new Error(`Fatura ${targetDate} não encontrada no grid.`);
    log(`Found ${count} invoice(s) for date ${targetDate}.`);


    // Use Promise.all to prevent unhandled rejection if popup waits times out while click is processing
    log('Initiating download...');
    const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 30000 }),
        row.getByText('Download').first().click()
    ]);
    log('Popup opened.');

    await popup.waitForLoadState('domcontentloaded');

    const btnFinal = popup.locator('#CONTENT_btnModal');
    await btnFinal.waitFor({ timeout: 30000 });

    const downloadPromise = popup.waitForEvent('download');
    await btnFinal.click();
    const download = await downloadPromise;

    // Use os helper to get temp dir that works on Windows and Linux
    // Note: In local execution, os.tmpdir might be different from where actor runs if containerized, 
    // but here we know it runs on host.
    const downloadPath = path.join(os.tmpdir(), download.suggestedFilename());
    await download.saveAs(downloadPath);
    const buffer = fs.readFileSync(downloadPath);
    const key = `FATURA_${uc}_${targetDate.replace('/', '-')}`;

    await Actor.setValue(key, buffer, { contentType: 'application/pdf' });
    log(`🎉 SUCESSO! PDF salvo: ${key}`);

    await Actor.pushData({ status: 'success', key });

} catch (error: any) {
    console.error('❌ ERRO:', error.message);
    try {
        // Save screenshot with extension for easier handling
        await Actor.setValue('ERROR_SCREENSHOT.png', await page.screenshot(), { contentType: 'image/png' });
        log('📸 Screenshot de erro salvo: ERROR_SCREENSHOT.png');
    } catch (e) { }
    await Actor.fail(error.message);
} finally {
    if (typeof browser !== 'undefined') {
        await browser.close();
    }
    await Actor.exit();
}
