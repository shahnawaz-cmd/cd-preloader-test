const { test, expect } = require('@playwright/test');

/**
 * Helper class for generating dynamic test data
 */
class DataGenerator {
    static getRandomVIN() {
        const baseVIN = '2G37M2P21308';
        const randomDigit = Math.floor(Math.random() * 10).toString();
        return baseVIN + randomDigit;
    }

    static getUniqueEmail() {
        return `test_${Date.now()}@preloader.com`;
    }
}

/**
 * Base class for Preloader interactions to share common logic
 */
class PreloaderBase {
    constructor(page) {
        this.page = page;
        this.historyButton = page.getByRole('button', { name: /Access Vehicle History/i });
        this.emailInput = page.getByRole('textbox', { name: /Email Address/i });
        this.checkoutButton = page.getByRole('button', { name: /Proceed to Checkout/i });
        
        this.preloader = page.locator('text=Preparing Your Checkout');
        this.checkoutHeader = page.locator('text=Choose payment method');
    }

    async performPreloaderCheck(email) {
        console.log('⏳ Waiting for Access button...');
        await this.historyButton.waitFor({ state: 'visible', timeout: 90000 });
        await this.historyButton.click();
        
        await expect(this.emailInput).toBeVisible({ timeout: 15000 });
        await this.emailInput.fill(email);
        await this.checkoutButton.click();
    }

    async trackPreloaderToCheckoutTime() {
        await this.preloader.waitFor({ state: 'visible', timeout: 30000 });
        const startTime = Date.now();
        await this.page.waitForURL('**/checkout**', { timeout: 90000 });
        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`⏱️ Preloader -> Checkout: ${durationSeconds}s`);
        return durationSeconds;
    }

    async setupApiCaptures() {
        console.log('📡 API Capture Listeners initialized...');
        
        const relevantEndpoints = [
            '/api/paypal/create-order',
            'sandbox.paypal.com/v2/checkout/orders',
            '/api/update-payment'
        ];

        this.page.on('request', request => {
            const url = request.url();
            if (relevantEndpoints.some(endpoint => url.includes(endpoint))) {
                const postData = request.postData();
                if (postData) {
                    console.log(`\n📤 [API REQUEST PAYLOAD] URL: ${url}`);
                    try {
                        console.log(JSON.stringify(JSON.parse(postData), null, 2));
                    } catch (e) {
                        console.log(postData);
                    }
                }
            }
        });

        this.page.on('response', async (response) => {
            const url = response.url();
            if (relevantEndpoints.some(endpoint => url.includes(endpoint))) {
                try {
                    const json = await response.json();
                    console.log(`\n📥 [API RESPONSE DATA] URL: ${url}`);
                    console.log(JSON.stringify(json, null, 2));
                } catch (e) {
                    const text = await response.text().catch(() => 'No response body');
                    console.log(`\n⚠️ [API RESPONSE - NON-JSON] URL: ${url}\n${text}`);
                }
            }
        });
    }

    async clickPayPalButton(context) {
        const paypalIframe = this.page.frameLocator('iframe[name*="__zoid__paypal_buttons__"]').first();
        const [popup] = await Promise.all([
            context.waitForEvent('page'),
            paypalIframe.getByRole('link', { name: 'Pay with PayPal' }).click()
        ]);
        console.log('✅ PayPal popup opened');
        return popup;
    }

    async loginPayPal(popup, credentials) {
        await popup.waitForLoadState('domcontentloaded');
        await popup.getByRole('textbox', { name: 'Email or mobile number' }).fill(credentials.email);
        await popup.getByRole('button', { name: 'Next' }).click();

        // Handle "Click to Continue" overlay if present
        const overlay = this.page.frameLocator('iframe[name*="__paypal_checkout_sandbox_paypal-overlay"]');
        await overlay.getByRole('link', { name: 'Click to Continue' }).click().catch(() => {});

        await popup.getByRole('textbox', { name: 'Password' }).waitFor({ state: 'visible', timeout: 15000 });
        await popup.getByRole('textbox', { name: 'Password' }).fill(credentials.password);
        await popup.getByRole('button', { name: 'Log In' }).click();
        console.log('✅ PayPal logged in');
    }
}

class PreloaderVerification extends PreloaderBase {
    async navigateToPreview(vin) {
        const previewUrl = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=vhr`;
        await this.page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
    }
}

class BuildSheet extends PreloaderBase {
    constructor(page) {
        super(page);
        this.historyButton = page.getByRole('button', { name: /Access Build Sheet/i });
    }
    async navigateToPreview(vin) {
        const previewUrl = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=sticker`;
        await this.page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
    }
}

test.describe('PayPal Checkout Scenarios', () => {
    test.setTimeout(300000);

    const PAYPAL_CREDENTIALS = {
        email: 'sb-rtbp126775467@personal.example.com',
        password: 'Ogznv/4c'
    };

    test('VHR: PayPal successful payment', async ({ page, context }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        // Switch to PayPal tab
        await page.getByRole('button', { name: /paypal/i }).click();
        await page.waitForSelector('iframe[name*="__zoid__paypal_buttons__"]', { state: 'visible', timeout: 20000 });

        const popup = await vhr.clickPayPalButton(context);
        await vhr.loginPayPal(popup, PAYPAL_CREDENTIALS);

        // Approve payment using robust polling pattern
        console.log('🛡️ Approving PayPal payment...');
        await new Promise((resolve) => {
            const check = async () => {
                for (const f of popup.frames()) {
                    try {
                        const el = await f.getByTestId('submit-button-initial');
                        if (await el.isVisible()) {
                            await el.click();
                            console.log('✅ PayPal "Complete" button clicked.');
                            return resolve();
                        }
                    } catch (e) {}
                }
            };
            const interval = setInterval(check, 1000);
            setTimeout(() => { clearInterval(interval); resolve(); }, 60000);
        });

        await page.waitForURL(url => url.toString().includes('paid=true'), { timeout: 60000 });
        console.log('✅ PayPal payment complete');
    });

    test('BuildSheet: PayPal successful payment', async ({ page, context }) => {
        const sticker = new BuildSheet(page);
        await sticker.setupApiCaptures();
        await sticker.navigateToPreview(DataGenerator.getRandomVIN());
        await sticker.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await sticker.trackPreloaderToCheckoutTime();

        // Switch to PayPal tab
        await page.getByRole('button', { name: /paypal/i }).click();
        await page.waitForSelector('iframe[name*="__zoid__paypal_buttons__"]', { state: 'visible', timeout: 20000 });

        const popup = await sticker.clickPayPalButton(context);
        await sticker.loginPayPal(popup, PAYPAL_CREDENTIALS);

        // Approve payment using robust polling pattern
        console.log('🛡️ Approving PayPal payment...');
        await new Promise((resolve) => {
            const check = async () => {
                for (const f of popup.frames()) {
                    try {
                        const el = await f.getByTestId('submit-button-initial');
                        if (await el.isVisible()) {
                            await el.click();
                            console.log('✅ PayPal "Complete" button clicked.');
                            return resolve();
                        }
                    } catch (e) {}
                }
            };
            const interval = setInterval(check, 1000);
            setTimeout(() => { clearInterval(interval); resolve(); }, 60000);
        });

        await page.waitForURL(url => url.toString().includes('paid=true'), { timeout: 60000 });
        console.log('✅ PayPal payment complete');
    });
});
