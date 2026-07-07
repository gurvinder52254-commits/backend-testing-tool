/**
 * ============================================================
 * microservices/worker/devices.js — Viewport / device profiles
 * ============================================================
 * Desktop = Windows Chrome @ 1920x1080.
 * Mobile  = Playwright's built-in "iPhone 13" emulation (real
 *           mobile viewport + touch + device pixel ratio + UA),
 *           with a safe custom fallback if the named device is
 *           unavailable in the installed Playwright version.
 * ============================================================
 */

const { devices } = require('playwright');

const DESKTOP = {
  name: 'desktop',
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Prefer a real Playwright device descriptor; fall back to a hand-rolled one.
const mobileDevice = devices['iPhone 13'] || devices['iPhone 12'] || devices['Pixel 5'];
const MOBILE = mobileDevice
  ? { name: 'mobile', ...mobileDevice }
  : {
      name: 'mobile',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    };

const PROFILES = { desktop: DESKTOP, mobile: MOBILE };

module.exports = { PROFILES };
