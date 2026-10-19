// Shared helpers for driving the real app UI in Playwright.

// Decode the QR code inside an element by rasterising its SVG and running the
// vendored jsQR in the page.
export async function readQr(page, selector) {
  await page.waitForSelector(`${selector} svg`, { timeout: 15000 });
  return page.evaluate(async (sel) => {
    if (!window.jsQR) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/jsQR.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.append(s);
      });
    }
    const svg = document.querySelector(`${sel} svg`);
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 400;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 400, 400);
    const code = window.jsQR(g.getImageData(0, 0, 400, 400).data, 400, 400);
    return code?.data ?? null;
  }, selector);
}

// Point the camera page's <video> at a canvas showing the given SVG, so the
// real in-page scanner sees the reply code. Returns once it's swapped in.
export async function showToCamera(page, svgMarkup) {
  await page.evaluate(async (markup) => {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const g = c.getContext('2d');
    const draw = () => {
      g.fillStyle = '#777';
      g.fillRect(0, 0, 1280, 720);
      g.drawImage(img, 400, 120, 480, 480);
    };
    draw();
    window.__qrTimer = setInterval(draw, 50);
    const video = document.getElementById('cam-video');
    window.__realStream = video.srcObject;
    video.srcObject = c.captureStream(20);
    await video.play();
  }, svgMarkup);
}

export async function restoreCamera(page) {
  await page.evaluate(async () => {
    clearInterval(window.__qrTimer);
    const video = document.getElementById('cam-video');
    video.srcObject = window.__realStream;
    await video.play();
  });
}
