// Example: transfer frames in W and measure time
// Requirements: npm install serialport

const PORT = 'COM5'; // change to your COM port
const FRAMES = 10000; // adjust

const { CoreDAQ } = require('../coredaq_js_api');

(async () => {
  const dev = await CoreDAQ.open(PORT);
  try {
    console.log('Arming acquisition...');
    await dev.set_freq(100000);
    await dev.arm_acquisition(FRAMES, false);
    await dev.start_acquisition();

    // Wait for acquisition to complete
    await new Promise((r) => setTimeout(r, Math.ceil((FRAMES / 100000) * 1000) + 50));

    const t0 = Date.now();
    const watts = await dev.transfer_frames_W(FRAMES);
    const t1 = Date.now();

    console.log(`transfer_frames_W took ${(t1 - t0) / 1000}s`);
    console.log('CH1 first 10 samples (W):', watts[0].slice(0, 10));
  } finally {
    await dev.close();
  }
})();