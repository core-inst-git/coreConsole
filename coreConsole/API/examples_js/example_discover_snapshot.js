'use strict';

const path = require('path');
const { CoreDAQ } = require(path.join(__dirname, '..', 'coredaq_js_api'));

async function main() {
  const ports = await CoreDAQ.find();
  if (!ports.length) {
    console.log('No coreDAQ devices found.');
    return 1;
  }

  const port = ports[0];
  console.log(`Using port: ${port}`);

  const dev = await CoreDAQ.open(port, 0.2);
  try {
    console.log(`IDN: ${await dev.idn()}`);
    console.log(`Frontend: ${dev.frontend_type()}`);
    console.log(`Detector: ${dev.detector_type()}`);

    const [mv, gains] = await dev.snapshot_mV(8);
    console.log('Snapshot mV:', mv);
    console.log('Gains:', gains);

    const pW = await dev.snapshot_W(8);
    console.log('Snapshot power W:', pW);
  } finally {
    await dev.close();
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
