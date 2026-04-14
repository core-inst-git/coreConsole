# Changelog

## v1.0.3

- Removed LOG deadband handling from the JS, Python, C, and C++ APIs.
- Changed InGaAs LOG conversion to extrapolate beyond LUT endpoints using the fitted end-segment slope.
- Added InGaAs LOG output bounds of `1 nW` to `3 mW`.
- Updated C/C++ examples and API docs to match the new LOG conversion behavior.
- Refreshed standalone `coreDAQ_API` mirror content to stay in sync with `coreConsole/API`.
