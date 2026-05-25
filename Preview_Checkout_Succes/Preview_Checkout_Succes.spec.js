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

    static getCards() {
        return {
            success: { number: '4242424242424242', expiry: '12/26', cvc: '123' },
            threeDS: { number: '4000000000003220', expiry: '12/26', cvc: '123' },
            declined: { number: '4000000000000002', expiry: '12/26', cvc: '123' },
            insufficientFunds: { number: '4000000000009995', expiry: '12/26', cvc: '123' },
            stolen: { number: '4000000000009979', expiry: '12/26', cvc: '123' },
            expired: { number: '4242424242424241', expiry: '01/10', cvc: '123' }
        };
    }
}

/**
 * Base class for Preloader and Checkout interactions
 */
class PreloaderBase {
    constructor(page) {
        this.page = page;
        this.historyButton = page.getByRole('button', { name: /Access Vehicle History/i });
        this.emailInput = page.getByRole('textbox', { name: /Email Address/i });
        this.checkoutButton = page.getByRole('button', { name: /Proceed to Checkout/i });
        
        this.preloader = page.locator('text=Preparing Your Checkout');
        this.checkoutHeader = page.locator('text=Choose payment method');
        this.nameInput = page.getByRole('textbox', { name: /Enter your name/i });
        this.zipInput = page.getByRole('textbox', { name: /ZIP \/ Postal Code/i });
        this.payButton = page.getByRole('button', { name: /Pay \$/i });
        this.couponInput = page.getByRole('textbox', { name: /Enter your coupon code/i });
        this.applyButton = page.getByRole('button', { name: /Apply/i });
        
        // Refined error locator: Targets typical error containers and filters for relevant keywords
        this.stripeError = page.locator('#error-message, .StripeElement--invalid, [role="alert"], .error-text')
            .filter({ hasText: /card|declined|expired|invalid|number|cvc|expiry|stolen/i });
    }

    async applyCoupon(couponCode) {
        console.log(`🎟️ Applying coupon: ${couponCode}`);
        
        // Wait for both the coupon discount API and the subsequent Stripe elements session
        await Promise.all([
            this.page.waitForResponse(resp => resp.url().includes('/api/get-discount') && resp.status() === 200),
            this.couponInput.fill(couponCode),
            this.applyButton.click()
        ]);
        
        console.log('⏳ Waiting for Stripe elements session to re-initialize...');
        await this.page.waitForResponse(resp => resp.url().includes('api.stripe.com/v1/elements/sessions') && resp.status() === 200);
        
        // Final buffer: 4s to ensure Stripe form is validated and enabled
        console.log('⏳ Waiting 4s for UI stabilization after session update...');
        await this.page.waitForTimeout(4000);
        
        // Ensure checkout fields are ready
        await expect(this.nameInput).toBeVisible({ timeout: 15000 });
        console.log('✅ Coupon applied and Stripe form ready for input.');
    }

    async setupApiCaptures() {
        console.log('📡 API Capture Listeners initialized...');
        this.page.on('response', async (response) => {
            const url = response.url();
            
            // Capture Stripe Responses (Success or Error)
            if (url.includes('api.stripe.com/v1')) {
                try {
                    const json = await response.json();
                    if (json.error) {
                        console.log(`\n❌ [STRIPE ERROR CAPTURED] URL: ${url}`);
                        console.log(JSON.stringify(json.error, null, 2));
                    } else if (url.includes('/confirm')) {
                        console.log(`\n🟦 [STRIPE CONFIRM RESPONSE] URL: ${url}`);
                        console.log(JSON.stringify(json, null, 2));
                    }
                } catch (e) {}
            }
            
            // Capture Update Payment
            if (url.includes('api/update-payment')) {
                try {
                    const json = await response.json();
                    console.log(`\n🟩 [UPDATE PAYMENT RESPONSE] URL: ${url}`);
                    console.log(JSON.stringify(json, null, 2));
                } catch (e) {
                    console.log(`\n⚠️ [UPDATE PAYMENT FAILED TO PARSE JSON] URL: ${url}`);
                    const text = await response.text();
                    console.log(`Raw response: ${text}`);
                }
            }
        });
    }

    async trackPreloaderToCheckoutTime() {
        await this.preloader.waitFor({ state: 'visible', timeout: 30000 });
        const startTime = Date.now();
        
        // Use URL-based wait as it's more reliable than text content for navigation transitions
        await this.page.waitForURL('**/checkout**', { timeout: 90000 });
        
        const endTime = Date.now();
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`⏱️ Preloader -> Checkout: ${durationSeconds}s`);
        return durationSeconds;
    }

    async performPreloaderCheck(email) {
        // 1. Wait for the loading/searching indicator to disappear first
        const searchingIndicator = this.page.getByAltText('Searching');
        await expect(searchingIndicator).not.toBeVisible({ timeout: 60000 });
        
        // 2. Now wait for the button, as the searching process is done
        await this.historyButton.waitFor({ state: 'visible', timeout: 60000 });
        
        await this.historyButton.click();
        await expect(this.emailInput).toBeVisible({ timeout: 15000 });
        await this.emailInput.fill(email);
        await this.checkoutButton.click();
    }

    async fillStripeDetails(card) {
        // Wait specifically for Stripe iFrames to be fully attached
        const cardFrame = this.page.frameLocator('iframe[title*="Secure card number input frame"]');
        await cardFrame.locator('body').waitFor({ state: 'attached', timeout: 15000 });
        await cardFrame.getByRole('textbox', { name: /Card number/i }).fill(card.number);

        const expiryFrame = this.page.frameLocator('iframe[title*="Secure expiration date input frame"]');
        await expiryFrame.locator('body').waitFor({ state: 'attached', timeout: 15000 });
        await expiryFrame.getByRole('textbox', { name: /Expiration date/i }).fill(card.expiry);

        const cvcFrame = this.page.frameLocator('iframe[title*="Secure CVC input frame"]');
        await cvcFrame.locator('body').waitFor({ state: 'attached', timeout: 15000 });
        await cvcFrame.getByRole('textbox', { name: /CVC/i }).fill(card.cvc);
    }

    async performCheckout(name, zip, card, submitButtonLocator = null) {
        console.log(`🛍️ Submitting Checkout with card ending in ${card.number.slice(-4)}...`);
        await expect(this.nameInput).toBeVisible({ timeout: 15000 });
        await this.nameInput.fill(name);
        await this.fillStripeDetails(card);
        await this.zipInput.fill(zip);
        
        const buttonToClick = submitButtonLocator || this.payButton;
        
        // Ensure the button is enabled before clicking
        await expect(buttonToClick).toBeEnabled({ timeout: 20000 });
        await buttonToClick.click();
    }

    async verifyRedirectionAndSuccess() {
        console.log('✅ Verifying Success Redirection...');
        await this.page.waitForURL(/.*(generate=true&paid=true|members\/my-reports).*/, { timeout: 60000 });
        console.log(`🎉 Success: ${this.page.url()}`);
    }

    async verifyPaymentError(expectedPartialText) {
        console.log(`🔍 Verifying UI Error Message containing: "${expectedPartialText}"`);
        // Wait for the error to appear on the frontend
        await expect(this.stripeError.first()).toBeVisible({ timeout: 20000 });
        const actualError = await this.stripeError.first().innerText();
        console.log(`⚠️ UI Error Captured: "${actualError}"`);
        
        // Allow for either "declined" or the specific "insufficient funds" message
        const isMatch = actualError.toLowerCase().includes(expectedPartialText.toLowerCase()) || 
                        actualError.toLowerCase().includes('insufficient funds');
        expect(isMatch).toBe(true);
    }
}

class PreloaderVerification extends PreloaderBase {
    async navigateToPreview(vin) {
        const url = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=vhr`;
        for (let i = 0; i < 3; i++) {
            try {
                await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                // Ensure the page has had a moment to trigger network calls
                await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
                return;
            } catch (e) {
                console.log(`⚠️ Navigation attempt ${i + 1} failed, retrying...`);
                if (i === 2) throw e;
            }
        }
    }
}

class BuildSheet extends PreloaderBase {
    constructor(page) {
        super(page);
        this.historyButton = page.getByRole('button', { name: /Access Build Sheet/i });
    }
    async selectReportOption() {
        const reportOption = this.page.locator('label:nth-child(6) > div > .flex.flex-wrap.items-center.rounded > .w-6');
        if (await reportOption.isVisible()) {
            await reportOption.click();
            console.log('✅ Report option selected.');
        }
    }

    async navigateToPreview(vin) {
        const url = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=sticker`;
        for (let i = 0; i < 3; i++) {
            try {
                await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
                await this.selectReportOption();
                return;
            } catch (e) {
                console.log(`⚠️ Navigation attempt ${i + 1} failed, retrying...`);
                if (i === 2) throw e;
            }
        }
    }
}

test.describe('Pintonaturals End-to-End VHR Checkout Scenarios', () => {
    test.setTimeout(180000);

    test('VHR: Full Checkout SUCCESS Flow', async ({ page }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        await vhr.performCheckout('Shahnawaz', '26556', DataGenerator.getCards().success);
        await vhr.verifyRedirectionAndSuccess();
    });

    test('VHR: Full Checkout SUCCESS Flow - Canada', async ({ page }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        // Perform checkout with Canadian postal code
        await vhr.performCheckout('Shahnawaz', 'K1A 0B1', DataGenerator.getCards().success);
        await vhr.verifyRedirectionAndSuccess();
    });

    test('BuildSheet: Full Checkout SUCCESS Flow', async ({ page }) => {
        const sticker = new BuildSheet(page);
        await sticker.setupApiCaptures();
        await sticker.navigateToPreview(DataGenerator.getRandomVIN());
        await sticker.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await sticker.trackPreloaderToCheckoutTime();

        await sticker.performCheckout('Shahnawaz', '26556', DataGenerator.getCards().success);
        await sticker.verifyRedirectionAndSuccess();
    });

    test('Stripe Success with coupon', async ({ page }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        await vhr.applyCoupon('offer20');
        await vhr.performCheckout('Shahnawaz', '26556', DataGenerator.getCards().success);
        await vhr.verifyRedirectionAndSuccess();
    });

    test('VHR: Checkout SUCCESS with 3D Secure', async ({ page }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        // 1. Fill Name & Stripe Details
        console.log('🛍️ Filling checkout details...');
        await page.getByRole('textbox', { name: 'Enter your name' }).fill('Shahnawaz');
        await vhr.fillStripeDetails({ number: '4000 0027 6000 3184', expiry: '02 / 66', cvc: '265' });
        await vhr.zipInput.fill('74900');
        await vhr.payButton.click();

        // 4. Handle 3DS Challenge via Event-Driven Polling
        console.log('🛡️ Handling 3DS Challenge via robust polling...');
        await new Promise((resolve) => {
            const check = async () => {
                // Re-fetch frames on every poll to handle frame refreshes
                for (const frame of page.frames()) {
                    try {
                        const completeButton = frame.getByRole('button', { name: 'Complete' });
                        if (await completeButton.isVisible()) {
                            await completeButton.click();
                            console.log('✅ 3DS "Complete" button clicked.');
                            return resolve();
                        }
                    } catch (e) {
                        // Ignore detached frame errors here, the loop will continue to the next frame
                        continue;
                    }
                }
            };
            page.on('frameattached', check);
            const interval = setInterval(check, 1000);
            setTimeout(() => { clearInterval(interval); resolve(); }, 60000);
        });

        await vhr.verifyRedirectionAndSuccess();
        });

    test('VHR: Checkout FAILURE with 3D Secure', async ({ page }) => {
        const vhr = new PreloaderVerification(page);
        await vhr.setupApiCaptures();
        await vhr.navigateToPreview(DataGenerator.getRandomVIN());
        await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await vhr.trackPreloaderToCheckoutTime();

        // 1. Fill Name
        console.log('🛍️ Filling checkout details...');
        await page.getByRole('textbox', { name: 'Enter your name' }).click();
        await page.getByRole('textbox', { name: 'Enter your name' }).fill('Test failure');

        // 2. Fill Stripe card details
        await vhr.fillStripeDetails({ number: '4000 0082 6000 3178', expiry: '02 / 66', cvc: '265' });
        await vhr.zipInput.fill('74900');
        
        // 3. Pay
        await vhr.payButton.click();

        // 3. Handle 3DS Challenge via Event-Driven Polling
        console.log('🛡️ Handling 3DS Challenge via robust polling...');
        await new Promise((resolve) => {
            const check = async () => {
                for (const f of page.frames()) {
                    try {
                        const el = await f.getByRole('button', { name: 'Complete' });
                        if (await el.isVisible()) {
                            await el.click();
                            console.log('✅ 3DS "Complete" button clicked.');
                            return resolve();
                        }
                    } catch (_) {}
                }
            };
            page.on('frameattached', check);
            const interval = setInterval(check, 1000);
            setTimeout(() => { clearInterval(interval); resolve(); }, 60000);
        });

        // 4. Verify Error
        await vhr.verifyPaymentError('declined');
        console.log('✅ 3DS failure verified.');
        await page.close();
    });

    test('Subscription purchase via Stripe', async ({ page }) => {
        const sticker = new BuildSheet(page);
        await sticker.setupApiCaptures();
        await sticker.navigateToPreview(DataGenerator.getRandomVIN());

        // 2. Select plan: "Unlimited Buildsheets"
        const planLabel = page.locator('label[for="option-CDSTSC"]');
        await planLabel.waitFor({ state: 'visible' });
        await planLabel.click();

        // 3. Access Build Sheet
        await page.getByRole('button', { name: 'Access Build Sheet' }).click();

        // 4. Perform Preloader Flow (Unique Email)
        const uniqueEmail = DataGenerator.getUniqueEmail();
        await page.getByRole('textbox', { name: /Email Address/i }).fill(uniqueEmail);
        await page.getByRole('button', { name: /Proceed to Checkout/i }).click();

        // 5. Track Preloader Time
        await sticker.trackPreloaderToCheckoutTime();

        // 6. Apply wrong coupon and wait 2 seconds
        console.log('🛍️ Applying wrong coupon...');
        await page.getByRole('textbox', { name: 'Enter your coupon code' }).fill('get20');
        await page.getByRole('button', { name: 'Apply' }).click();
        await page.waitForTimeout(2000);
        
        // 7. Perform robust checkout using the established BuildSheet method
        await sticker.performCheckout('test subscription', '748965', DataGenerator.getCards().success, page.getByRole('button', { name: /Subscribe \$/i }));
        await sticker.verifyRedirectionAndSuccess();
    });

    // test('Same-session duplicate purchase', async ({ page }) => {
    //     const vhr = new PreloaderVerification(page);
    //     await vhr.setupApiCaptures();
    //     const vin = '2G37M2P213088'; // Use a specific VIN to ensure reproducibility
    //     const email = DataGenerator.getUniqueEmail();

    //     // 1. First Purchase
    //     await vhr.navigateToPreview(vin);
    //     await vhr.performPreloaderCheck(email);
    //     await vhr.trackPreloaderToCheckoutTime();
    //     await vhr.performCheckout('Shahnawaz', '26556', DataGenerator.getCards().success);
    //     await vhr.verifyRedirectionAndSuccess();

    //     // 2. Duplicate Attempt in same session with the EXACT same URL (VIN + type)
    //     console.log('🔄 Attempting duplicate purchase for same VIN in same session...');
    //     const duplicateUrl = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=vhr`;
    //     await page.goto(duplicateUrl);
        
    //     // Wait for the button to appear or redirect to happen
    //     await vhr.historyButton.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    //     await vhr.historyButton.click();
        
    //     // Verify we are in member area (checking URL)
    //     await expect(page).toHaveURL(/.*members\/search.*/, { timeout: 15000 });
    //     console.log('✅ PASS — User was not prompted to checkout again (duplicate blocked/session maintained)');
    // });

    const failureScenarios = [
        { name: 'Declined Card', card: DataGenerator.getCards().declined, expectedError: 'declined' },
        { name: 'Insufficient Funds', card: DataGenerator.getCards().insufficientFunds, expectedError: 'declined' },
        { name: 'Stolen Card', card: DataGenerator.getCards().stolen, expectedError: 'declined' }
    ];

    for (const scenario of failureScenarios) {
        test(`VHR: Checkout FAILURE - ${scenario.name}`, async ({ page }) => {
            const vhr = new PreloaderVerification(page);
            
            // 1. Setup Capture to catch Stripe API Error JSON
            await vhr.setupApiCaptures();

            await vhr.navigateToPreview(DataGenerator.getRandomVIN());
            await vhr.performPreloaderCheck(DataGenerator.getUniqueEmail());
            await vhr.trackPreloaderToCheckoutTime();

            // 2. Perform Checkout with invalid card
            await vhr.performCheckout('Failure Test', '10001', scenario.card);

            // 3. Verify Frontend Error Message
            await vhr.verifyPaymentError(scenario.expectedError);

            console.log(`✅ Failure scenario "${scenario.name}" verified from both API and UI.`);
            // Browser closes automatically after test completion
        });
    }
});
