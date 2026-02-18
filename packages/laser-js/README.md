# @coredaq/laser-js

JavaScript Santec laser command library for:

- `TSL550`
- `TSL570`
- `TSL770`

## Usage

Provide a transport with:

- `write(cmd: string): Promise<void>`
- `query(cmd: string): Promise<string>`
- optional `close(): Promise<void>`

```js
const { createLaserFromIdn } = require('@coredaq/laser-js');

const idn = await transport.query('*IDN?');
const { model, laser } = createLaserFromIdn(idn, transport);

await laser.configureForSweep({
  startNm: 1480,
  stopNm: 1620,
  powerMw: 1,
  speedNmS: 50,
});

await laser.startSweep();
// wait for sweep/capture window
await laser.stopSweep();
await laser.close();
```

`TSL770` sweep axis commands are emitted in SI length units (meters, m/s).  
`TSL550/TSL570` use nanometer-based sweep commands.
