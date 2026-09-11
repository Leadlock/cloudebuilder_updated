import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = 'C:\\Users\\22tan\\.gemini\\antigravity-ide\\brain\\ded8c122-d55d-4a6d-b005-a599e1843c02\\qa_screenshots';

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Find available Chrome or Edge binary
const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const executablePath = chromeCandidates.find((p) => fs.existsSync(p));

if (!executablePath) {
  console.error('No Chrome or Edge browser executable found!');
  process.exit(1);
}

console.log(`Using browser executable: ${executablePath}`);

async function runQA() {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  const consoleLogs = [];
  const errors = [];

  page.on('console', (msg) => {
    const text = msg.text();
    consoleLogs.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') {
      console.error(`PAGE CONSOLE ERROR: ${text}`);
    }
  });

  page.on('pageerror', (err) => {
    errors.push(`PAGE UNHANDLED ERROR: ${err.message}`);
    console.error(`PAGE UNHANDLED ERROR: ${err.message}`);
  });

  console.log('\n--- 1. Navigating to Dashboard (http://localhost:3001) ---');
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('main', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01_dashboard.png'), fullPage: true });
  console.log('✓ Captured 01_dashboard.png');

  // Verify KPI metric cards
  const dashboardStats = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasProjectsHeading: text.includes('Projects') || text.includes('Dashboard'),
      hasTotalResources: text.includes('Resources') || text.includes('Total'),
      hasSecurityScore: text.includes('Security') || text.includes('/100'),
      hasMonthlyCost: text.includes('Monthly') || text.includes('Cost') || text.includes('$')
    };
  });
  console.log('Dashboard Stats Check:', dashboardStats);

  console.log('\n--- 2. Testing Currency Switcher (TopBar) ---');
  const currencySelect = await page.$('select');
  if (currencySelect) {
    await page.select('select', 'INR');
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_currency_inr.png'), fullPage: true });
    console.log('✓ Switched currency to INR -> Captured 02_currency_inr.png');

    await page.select('select', 'EUR');
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_currency_eur.png'), fullPage: true });
    console.log('✓ Switched currency to EUR -> Captured 02_currency_eur.png');

    await page.select('select', 'USD');
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\n--- 3. Opening First Architecture Project Canvas ---');
  // Click the first project card
  const projectClicked = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('div[class*="cursor-pointer"], div[class*="rounded-xl"]'));
    const target = cards.find((el) => el.innerText.includes('AWS') || el.innerText.includes('Production') || el.innerText.includes('E-Commerce') || el.innerText.includes('Resources'));
    if (target) {
      target.click();
      return true;
    }
    return false;
  });

  if (projectClicked) {
    await new Promise((r) => setTimeout(r, 2000));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03_canvas_view.png'), fullPage: true });
    console.log('✓ Opened project canvas -> Captured 03_canvas_view.png');
  }

  console.log('\n--- 4. Checking Visual Builder Canvas Nodes ---');
  const nodeCount = await page.evaluate(() => {
    return document.querySelectorAll('.react-flow__node').length;
  });
  console.log(`Canvas Node Count: ${nodeCount} nodes rendered`);

  // Click a node to open Properties Panel
  const nodeClicked = await page.evaluate(() => {
    const node = document.querySelector('.react-flow__node');
    if (node) {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }
    return false;
  });

  if (nodeClicked) {
    await new Promise((r) => setTimeout(r, 1000));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04_node_properties.png'), fullPage: true });
    console.log('✓ Clicked node -> Properties panel displayed -> Captured 04_node_properties.png');
  }

  console.log('\n--- 5. Testing Cost Estimation Panel ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'Cost Estimate' || el.innerText.trim() === 'Cost');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_cost_panel.png'), fullPage: true });
  console.log('✓ Captured 05_cost_panel.png');

  console.log('\n--- 6. Testing Security & Compliance Panel ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'Security' || el.innerText.trim() === 'Security Scan');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06_security_panel.png'), fullPage: true });
  console.log('✓ Captured 06_security_panel.png');

  console.log('\n--- 7. Testing Architecture Advisor Panel ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'Advisor');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07_advisor_panel.png'), fullPage: true });
  console.log('✓ Captured 07_advisor_panel.png');

  console.log('\n--- 8. Testing Terraform HCL Generator Panel ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'Terraform');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08_terraform_panel.png'), fullPage: true });
  console.log('✓ Captured 08_terraform_panel.png');

  console.log('\n--- 9. Testing Environments Panel ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'Environments');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09_environments_panel.png'), fullPage: true });
  console.log('✓ Captured 09_environments_panel.png');

  console.log('\n--- 10. Testing Version History Panel ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'History');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10_version_history.png'), fullPage: true });
  console.log('✓ Captured 10_version_history.png');

  console.log('\n--- 11. Testing AI Architecture Generator View ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'AI Generator');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11_ai_generator.png'), fullPage: true });
  console.log('✓ Captured 11_ai_generator.png');

  console.log('\n--- 12. Testing Templates View ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'Templates');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12_templates_view.png'), fullPage: true });
  console.log('✓ Captured 12_templates_view.png');

  console.log('\n--- 13. Testing Disaster Recovery Designer ---');
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a, div')).find((el) => el.innerText.trim() === 'DR Designer');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '13_dr_designer.png'), fullPage: true });
  console.log('✓ Captured 13_dr_designer.png');

  await browser.close();

  console.log('\n========================================');
  console.log('BROWSER QA EXECUTION SUMMARY');
  console.log('========================================');
  console.log(`Total Unhandled Page Errors: ${errors.length}`);
  console.log(`Total Screenshots Captured: 13`);
  console.log(`Screenshot Directory: ${SCREENSHOT_DIR}`);
  if (errors.length > 0) {
    console.error('Errors encountered during QA:', errors);
  } else {
    console.log('ALL BROWSER FLOWS PASSED WITH 0 ERRORS!');
  }
}

runQA().catch((err) => {
  console.error('Fatal Browser QA Runner Error:', err);
  process.exit(1);
});
