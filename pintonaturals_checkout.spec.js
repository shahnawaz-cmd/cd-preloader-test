const { test, expect } = require('@playwright/test');

/**
 * Helper class for generating dynamic test data
 */
class DataGenerator {
    static getRandomVIN() {
        // Base VIN provided: 2G37M2P213086
        // Randomizing the 13th character
        const baseVIN = '2G37M2P21308';
        const randomDigit = Math.floor(Math.random() * 10).toString();
        return baseVIN + randomDigit;
    }

    static getUniqueEmail() {
        return `test_${Date.now()}@preloader.com`;
    }
}

/**
 * PreloaderVerification class encapsulates page interactions and locators
 */
class PreloaderVerification {
    constructor(page) {
        this.page = page;
        // Isolated locators using regex for better flexibility
        this.historyButton = page.getByRole('button', { name: /Access Vehicle History/i });
        this.emailInput = page.getByRole('textbox', { name: /Email Address/i });
        this.checkoutButton = page.getByRole('button', { name: /Proceed to Checkout/i });
        
        // Locators for timing tracking
        this.preloader = page.locator('text=Preparing Your Checkout');
        this.checkoutHeader = page.locator('text=Choose payment method');
    }

    async navigateToPreview(vin) {
        const previewUrl = `https://dev.pintonaturals.com/preview?vin=${vin}&locale=en&wpPage=homepage&type=vhr`;
        await this.page.goto(previewUrl);
        // Smart wait: wait for the first interactive element with a generous timeout
        await expect(this.historyButton).toBeVisible({ timeout: 30000 });
    }

    /**
     * Measures the time from preloader appearance to checkout page load
     * Uses smart waits to detect state changes
     */
    async trackPreloaderToCheckoutTime() {
        console.log('⏳ Waiting for preloader to appear...');
        
        // Smart wait: Wait for preloader to become visible
        await expect(this.preloader).toBeVisible({ timeout: 20000 });
        const startTime = Date.now();
        console.log('✅ Preloader visible. Timing started...');

        // Smart wait: Wait for checkout page indicator to become visible
        await expect(this.checkoutHeader).toBeVisible({ timeout: 60000 });
        const endTime = Date.now();
        
        const durationSeconds = ((endTime - startTime) / 1000).toFixed(2);
        console.log(`⏱️ Total Time (Preloader -> Checkout): ${durationSeconds}s`);
        
        return durationSeconds;
    }

    async performPreloaderCheck(email) {
        // Smart wait: ensures element is ready for interaction
        await this.historyButton.click();
        
        await expect(this.emailInput).toBeVisible();
        await this.emailInput.fill(email);
        
        await this.checkoutButton.click();
    }
}

test('Modular Preloader Preview Checkout Verification with Smart Waits', async ({ page }) => {
    // Global timeout for the entire test
    test.setTimeout(90000); 
    
    const preloader = new PreloaderVerification(page);
    const vin = DataGenerator.getRandomVIN();
    const email = DataGenerator.getUniqueEmail();

    console.log(`🚀 Starting Test | VIN: ${vin} | Email: ${email}`);

    // 1. Navigate to Preview
    await preloader.navigateToPreview(vin);
    
    // 2. Interaction
    await preloader.performPreloaderCheck(email);
    
    // 3. Timing Verification
    const elapsed = await preloader.trackPreloaderToCheckoutTime();
    
    // 4. Final Assertions
    expect(parseFloat(elapsed)).toBeLessThan(45);
    // Smart wait for URL transition
    await expect(page).toHaveURL(/.*\/checkout.*/);
    console.log('🎉 Test Completed Successfully');
});
