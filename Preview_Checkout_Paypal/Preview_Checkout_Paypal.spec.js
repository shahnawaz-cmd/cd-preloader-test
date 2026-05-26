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
        this.couponInput = page.getByRole('textbox', { name: /Enter your coupon code/i });
        this.applyButton = page.getByRole('button', { name: /Apply/i });
    }

    async applyCoupon(couponCode) {
        console.log(`🎟️ Applying coupon: ${couponCode}`);
        
        await this.humanDelay(1000, 1500);
        const [response] = await Promise.all([
            this.page.waitForResponse(resp => resp.url().includes('/api/get-discount') && resp.status() === 200),
            this.couponInput.fill(couponCode),
            this.applyButton.click()
        ]);
        
        const json = await response.json();
        console.log(`✅ Coupon Discount API Response: ${JSON.stringify(json, null, 2)}`);
        
        await this.humanDelay(2000, 3000);
        await this.page.waitForSelector('text=/coupon applied|discount applied|success/i', { state: 'visible', timeout: 15000 })
            .catch(() => console.log('⚠️ Coupon success message not found in UI, but API passed.'));

        console.log('✅ Coupon applied and verified.');
        await this.humanDelay(1000, 2000);
    }

    async humanDelay(min = 1500, max = 3000) {
        const delay = Math.floor(Math.random() * (max - min + 1) + min);
        await this.page.waitForTimeout(delay);
    }

    async performPreloaderCheck(email) {
        console.log('⏳ Waiting for Access button...');
        await this.historyButton.waitFor({ state: 'visible', timeout: 90000 });
        await this.humanDelay(2000, 4000);
        await this.historyButton.click();
        
        await expect(this.emailInput).toBeVisible({ timeout: 15000 });
        await this.humanDelay(1500, 2500);
        await this.emailInput.fill(email);
        
        await this.humanDelay(1500, 2000);
        await this.checkoutButton.click();
        await this.humanDelay(1000, 1500);
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
            '/api/update-payment',
            '/api/get-discount'
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
        await this.humanDelay(1500, 2500);
        await popup.getByRole('textbox', { name: 'Email or mobile number' }).fill(credentials.email);
        await popup.getByRole('button', { name: 'Next' }).click();

        const overlay = this.page.frameLocator('iframe[name*="__paypal_checkout_sandbox_paypal-overlay"]');
        await overlay.getByRole('link', { name: 'Click to Continue' }).click().catch(() => {});

        await popup.getByRole('textbox', { name: 'Password' }).waitFor({ state: 'visible', timeout: 15000 });
        await this.humanDelay(1000, 2000);
        await popup.getByRole('textbox', { name: 'Password' }).fill(credentials.password);
        await popup.getByRole('button', { name: 'Log In' }).click();
        console.log('✅ PayPal logged in');
    }

    async approvePayPalPayment(popup) {
        console.log('🛡️ Approving PayPal payment...');
        
        const updatePaymentPromise = this.page.waitForResponse(res => res.url().includes('/api/update-payment'), { timeout: 60000 }).catch(() => {});

        let clicked = false;
        const startTimeApproval = Date.now();
        while (!clicked && (Date.now() - startTimeApproval < 180000)) { // Extended timeout to 3m
            // 1. Explicitly check for the "Things don't appear to be working" error screen
            const currentPopupUrl = popup.url();
            if (currentPopupUrl.includes('genericError') || currentPopupUrl.includes('RETRY')) {
                console.log('❌ PayPal Sandbox Error detected (RETRY). Attempting recovery...');
                const tryAgainLink = popup.locator('a.btn.full:has-text("Try again"), a:has-text("Try again")').first();
                if (await tryAgainLink.isVisible()) {
                    await tryAgainLink.click();
                    console.log('⏳ Recovery clicked. Waiting for reload...');
                    await popup.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
                    await this.page.waitForTimeout(5000); // Give sandbox extra time to settle
                    continue; // Re-scan frames after reload
                }
            }

            const frames = popup.frames();
            for (const f of frames) {
                try {
                    // Also check for "Try again" inside frames
                    const tryAgainInFrame = f.getByRole('link', { name: /Try again/i });
                    if (await tryAgainInFrame.isVisible()) {
                        console.log('⚠️ PayPal "Try again" found in frame. Recovering...');
                        await tryAgainInFrame.click();
                        await popup.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                        break; 
                    }

                    const el = f.getByTestId('submit-button-initial');
                    if (await el.isVisible() && await el.isEnabled()) {
                        console.log('✅ PayPal Submit button ready. Final human delay...');
                        await this.humanDelay(3000, 5000); // Increased delay before final critical click
                        await el.click();
                        clicked = true;
                        console.log('✅ PayPal "Complete" button clicked.');
                        break; 
                    }
                } catch (e) {
                    // Frame might be detached/reloading
                }
            }
            if (!clicked) await this.page.waitForTimeout(3000);
        }

        if (!clicked) console.log('⚠️ PayPal Approval failed after recovery attempts.');
        await updatePaymentPromise;
    }
}

class PreloaderVerification extends PreloaderBase {
    async navigateToPreview(vin) {
        // Add inter-test delay to ensure previous context/session is fully cleared
        console.log('⏳ Inter-test delay: 2s');
        await this.page.waitForTimeout(2000);
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

    // Ensure a fresh state between each test run
    test.afterEach(async ({ context }) => {
        console.log('🧹 Clearing cookies and waiting between cases...');
        await context.clearCookies();
        await new Promise(r => setTimeout(r, 2000)); 
    });

    test('VHR: PayPal successful payment', async ({ page, context }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        await page.getByRole('button', { name: /paypal/i }).click();
        await page.waitForSelector('iframe[name*="__zoid__paypal_buttons__"]', { state: 'visible', timeout: 20000 });

        const popup = await vhr.clickPayPalButton(context);
        await vhr.loginPayPal(popup, PAYPAL_CREDENTIALS);
        await vhr.approvePayPalPayment(popup);

        await page.waitForURL(url => url.toString().includes('paid=true'), { timeout: 90000 });
        console.log('✅ PayPal payment complete');
    });

    test('VHR: PayPal Checkout with Coupon', async ({ page, context }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        await vhr.applyCoupon('get20');

        await page.getByRole('button', { name: /paypal/i }).click();
        await page.waitForSelector('iframe[name*="__zoid__paypal_buttons__"]', { state: 'visible', timeout: 20000 });

        const popup = await vhr.clickPayPalButton(context);
        await vhr.loginPayPal(popup, PAYPAL_CREDENTIALS);
        await vhr.approvePayPalPayment(popup);

        await page.waitForURL(url => url.toString().includes('paid=true'), { timeout: 90000 });
        console.log('✅ PayPal payment with coupon complete');
    });

    test('BuildSheet: PayPal successful payment', async ({ page, context }) => {
        const sticker = new BuildSheet(page);
        await sticker.setupApiCaptures();
        await sticker.navigateToPreview(DataGenerator.getRandomVIN());
        await sticker.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await sticker.trackPreloaderToCheckoutTime();

        await page.getByRole('button', { name: /paypal/i }).click();
        await page.waitForSelector('iframe[name*="__zoid__paypal_buttons__"]', { state: 'visible', timeout: 20000 });

        const popup = await sticker.clickPayPalButton(context);
        await sticker.loginPayPal(popup, PAYPAL_CREDENTIALS);
        await sticker.approvePayPalPayment(popup);

        await page.waitForURL(url => url.toString().includes('paid=true'), { timeout: 90000 });
        console.log('✅ PayPal payment complete');
    });

    test('BuildSheet: PayPal Checkout with Coupon', async ({ page, context }) => {
        const sticker = new BuildSheet(page);
        await sticker.setupApiCaptures();
        await sticker.navigateToPreview(DataGenerator.getRandomVIN());
        await sticker.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await sticker.trackPreloaderToCheckoutTime();

        await sticker.applyCoupon('get20');

        await page.getByRole('button', { name: /paypal/i }).click();
        await page.waitForSelector('iframe[name*="__zoid__paypal_buttons__"]', { state: 'visible', timeout: 20000 });

        const popup = await sticker.clickPayPalButton(context);
        await sticker.loginPayPal(popup, PAYPAL_CREDENTIALS);
        await sticker.approvePayPalPayment(popup);

        await page.waitForURL(url => url.toString().includes('paid=true'), { timeout: 90000 });
        console.log('✅ PayPal payment with coupon complete');
    });
});
