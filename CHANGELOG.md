# Changelog

## v1.0.5

- Fixed Capture tab numeric inputs so values can be freely edited again instead of getting stuck after the first change.
- Changed Capture tab field handling to use draft text state while typing and only commit validated numeric values on blur or Enter.
- Preserved Capture tab physical/virtual channel visibility and arrangement across tab switches for the active device instead of resetting to all four channels.

## v1.0.4

- Bundled a private Python + `h5py` HDF5 runtime into the Windows app so `Save H5` no longer depends on a system Python install.
- Updated the backend to prefer the bundled HDF5 runtime and show user-facing reinstall guidance instead of raw Python-path errors.
- Hardened `sweep_h5_writer.py` to accept UTF-8 BOM input payloads.
- Updated Windows build packaging so portable and zip releases automatically include the HDF5 export runtime.

## v1.0.3

- Removed LOG deadband handling from the JS, Python, C, and C++ APIs.
- Changed InGaAs LOG conversion to extrapolate beyond LUT endpoints using the fitted end-segment slope.
- Added InGaAs LOG output bounds of `1 nW` to `3 mW`.
- Updated C/C++ examples and API docs to match the new LOG conversion behavior.
- Refreshed standalone `coreDAQ_API` mirror content to stay in sync with `coreConsole/API`.
