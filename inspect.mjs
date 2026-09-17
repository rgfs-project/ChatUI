import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// Sign in via API first to get a session cookie
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });

// Wait for the form elements
try {
    await page.waitForSelector('.signin', { timeout: 3000 });
} catch {
    console.log('No sign-in form found, app may already be logged in');
}

// Fill inputs via evaluate to bypass any issues
await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    inputs.forEach(input => {
        if (input.type === 'text' || input.getAttribute('name') === 'username') {
            input.value = 'admin';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (input.type === 'password') {
            input.value = 'admin123';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
});

// Force click the submit button
const submitBtn = page.locator('button[type="submit"]');
await submitBtn.evaluate(el => el.click());

// Wait for navigation
try {
    await page.waitForNavigation({ timeout: 3000 }).catch(() => {});
} catch {}
await page.waitForTimeout(2000);

// Take screenshot
await page.screenshot({ path: '/home/user/ChatUI/screenshot-main.png', fullPage: false });
console.log('Screenshot saved');

// Get computed styles for key elements
const styles = await page.evaluate(() => {
    const results = {};
    
    // Check transcript inner padding
    const transcriptInner = document.querySelector('.transcript__inner') || document.querySelector('[class*="transcript"]');
    if (transcriptInner) {
        const style = getComputedStyle(transcriptInner);
        results.transcriptPadding = {
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
        };
    }
    
    // Check composer padding
    const composerEl = document.querySelector('.composer');
    if (composerEl) {
        const style = getComputedStyle(composerEl);
        results.composerPadding = {
            paddingTop: style.paddingTop,
            paddingRight: style.paddingRight,
            paddingBottom: style.paddingBottom,
            paddingLeft: style.paddingLeft,
        };
    }
    
    // Get all CSS custom properties related to spacing
    const rootStyle = getComputedStyle(document.documentElement);
    const spacingProps = ['--column-inset', '--gutter', '--sidebar-width', '--header-height', '--bar-inset', '--control-bleed'];
    results.spacingVars = {};
    for (const prop of spacingProps) {
        results.spacingVars[prop] = rootStyle.getPropertyValue(prop);
    }
    
    return results;
});

console.log('Computed styles:', JSON.stringify(styles, null, 2));

await browser.close();
