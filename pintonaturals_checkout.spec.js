const { test, expect } = require('@playwright/test');

/**
 * Helper class for generating dynamic test data
 */
class DataGenerator {
    static getRandomVIN() {
        // Base VIN provided: 2G37M2P213086
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
        // Default locator for VHR
        this.historyButton = page.getByRole('button', { name: /Access Vehicle History/i });
        this.emailInput = page.getByRole('textbox', { name: /Email Address/i });
        this.checkoutButton = page.getByRole('button', { name: /Proceed to Checkout/i });
        
        // Locators for timing tracking
        this.preloader = page.locator('text=Preparing Your Checkout');
        this.checkoutHeader = page.locator('text=Choose payment method');
    }

    async trackPreloaderToCheckoutTime() {
        console.log('⏳ Waiting for preloader to appear...');
        await expect(this.preloader).toBeVisible({ timeout: 25000 });
        const startTime = Date.now();
        console.log('✅ Preloader visible. Timing started...');

        await expect(this.checkoutHeader).toBeVisible({ timeout: 60000 });
        const endTime = Date.now();
        
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`⏱️ Total Time (Preloader -> Checkout): ${durationSeconds}s`);
        
        return durationSeconds;
    }

    async performPreloaderCheck(email) {
        // Wait for the specific button to be interactive
        await this.historyButton.waitFor({ state: 'visible', timeout: 30000 });
        await this.historyButton.click();
        
        // Wait for email popup
        await expect(this.emailInput).toBeVisible({ timeout: 15000 });
        await this.emailInput.fill(email);
        
        await this.checkoutButton.click();
    }
}

/**
 * PreloaderVerification class for Vehicle History Reports (VHR)
 */
class PreloaderVerification extends PreloaderBase {
    async navigateToPreview(vin) {
        const previewUrl = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=vhr`;
        console.log(`🔗 Navigating to VHR Preview: ${previewUrl}`);
        await this.page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
        await this.page.waitForLoadState('networkidle').catch(() => {}); 
    }
}

/**
 * BuildSheet class for Window Stickers
 */
class BuildSheet extends PreloaderBase {
    constructor(page) {
        super(page);
        // Override the button locator for the Build Sheet flow
        this.historyButton = page.getByRole('button', { name: /Access Build Sheet/i });
    }

    async navigateToPreview(vin) {
        const previewUrl = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=sticker`;
        console.log(`🔗 Navigating to BuildSheet Preview: ${previewUrl}`);
        await this.page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
        await this.page.waitForLoadState('networkidle').catch(() => {});
    }
}

test.describe('Pintonaturals Preloader Tests', () => {
    test.setTimeout(120000);

    test('VHR Preloader Verification', async ({ page }) => {
        const preloader = new PreloaderVerification(page);
        const vin = DataGenerator.getRandomVIN();
        const email = DataGenerator.getUniqueEmail();

        await preloader.navigateToPreview(vin);
        await preloader.performPreloaderCheck(email);
        const elapsed = await preloader.trackPreloaderToCheckoutTime();
        
        expect(parseFloat(elapsed)).toBeLessThan(50);
        await expect(page).toHaveURL(/.*\/checkout.*/);
    });

    test('BuildSheet Preloader Verification', async ({ page }) => {
        const buildSheet = new BuildSheet(page);
        const vin = DataGenerator.getRandomVIN();
        const email = DataGenerator.getUniqueEmail();

        await buildSheet.navigateToPreview(vin);
        await buildSheet.performPreloaderCheck(email);
        const elapsed = await buildSheet.trackPreloaderToCheckoutTime();
        
        expect(parseFloat(elapsed)).toBeLessThan(50);
        await expect(page).toHaveURL(/.*\/checkout.*/);
    });
});
