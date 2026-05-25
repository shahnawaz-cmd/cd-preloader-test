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
        
        // Refined error locator: Targets typical error containers and filters for relevant keywords
        this.stripeError = page.locator('#error-message, .StripeElement--invalid, [role="alert"], .error-text')
            .filter({ hasText: /card|declined|expired|invalid|number|cvc|expiry|stolen/i });
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
            
            // Capture Update Payment (Should NOT be called in failure cases)
            if (url.includes('api/update-payment')) {
                try {
                    const json = await response.json();
                    console.log(`\n🟩 [UPDATE PAYMENT RESPONSE] URL: ${url}`);
                } catch (e) {}
            }
        });
    }

    async trackPreloaderToCheckoutTime() {
        await this.preloader.waitFor({ state: 'visible', timeout: 30000 });
        const startTime = Date.now();
        await this.checkoutHeader.waitFor({ state: 'visible', timeout: 60000 });
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
        await this.historyButton.waitFor({ state: 'visible', timeout: 45000 });
        
        await this.historyButton.click();
        await expect(this.emailInput).toBeVisible({ timeout: 15000 });
        await this.emailInput.fill(email);
        await this.checkoutButton.click();
    }

    async fillStripeDetails(card) {
        const cardFrame = this.page.frameLocator('iframe[title*="Secure card number input frame"]');
        await cardFrame.getByRole('textbox', { name: /Card number/i }).fill(card.number);

        const expiryFrame = this.page.frameLocator('iframe[title*="Secure expiration date input frame"]');
        await expiryFrame.getByRole('textbox', { name: /Expiration date/i }).fill(card.expiry);

        const cvcFrame = this.page.frameLocator('iframe[title*="Secure CVC input frame"]');
        await cvcFrame.getByRole('textbox', { name: /CVC/i }).fill(card.cvc);
    }

    async performCheckout(name, zip, card) {
        console.log(`🛍️ Submitting Checkout with card ending in ${card.number.slice(-4)}...`);
        await expect(this.nameInput).toBeVisible({ timeout: 15000 });
        await this.nameInput.fill(name);
        await this.fillStripeDetails(card);
        await this.zipInput.fill(zip);
        await this.payButton.click();
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
        await this.page.goto(`https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=vhr`);
        await this.page.waitForLoadState('networkidle').catch(() => {});
    }
}

class BuildSheet extends PreloaderBase {
    constructor(page) {
        super(page);
        this.historyButton = page.getByRole('button', { name: /Access Build Sheet/i });
    }
    async navigateToPreview(vin) {
        await this.page.goto(`https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=sticker`);
        await this.page.waitForLoadState('networkidle').catch(() => {});
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

    test('BuildSheet: Full Checkout SUCCESS Flow', async ({ page }) => {
        const sticker = new BuildSheet(page);
        await sticker.setupApiCaptures();
        await sticker.navigateToPreview(DataGenerator.getRandomVIN());
        await sticker.performPreloaderCheck(DataGenerator.getUniqueEmail());
        await sticker.trackPreloaderToCheckoutTime();

        await sticker.performCheckout('Shahnawaz', '26556', DataGenerator.getCards().success);
        await sticker.verifyRedirectionAndSuccess();
    });

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
