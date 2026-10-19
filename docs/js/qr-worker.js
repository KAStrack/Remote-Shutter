// Runs jsQR off the main thread so the camera preview stays smooth.
importScripts('../vendor/jsQR.min.js');

let frame = 0;

self.onmessage = (e) => {
  const { width, height, buffer } = e.data;
  // Phone screens show dark-on-light codes; check inverted frames only now and
  // then (dark-mode screenshots, odd exposure) because it doubles the cost.
  const inversionAttempts = frame++ % 4 === 3 ? 'onlyInvert' : 'dontInvert';
  const code = self.jsQR(new Uint8ClampedArray(buffer), width, height, { inversionAttempts });
  self.postMessage(code ? code.data : null);
};
