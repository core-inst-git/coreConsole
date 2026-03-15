# coreDAQ C++ API

This folder provides an idiomatic C++17 wrapper over the C API.

## Design

- RAII ownership (`coredaq::CoreDAQ`)
- Exception-based errors (`coredaq::CoreDAQError`)
- `std::array` snapshots and `std::vector` frame transfers
- No indefinite waits; all calls are bounded by timeout arguments

## Build

```bash
cmake -S API/cpp_api -B API/cpp_api/build
cmake --build API/cpp_api/build --config Release
```

## Examples

- `examples/example_snapshot_w.cpp`
- `examples/example_transfer_w.cpp`

Run (Windows):

```bash
API\\cpp_api\\build\\Release\\coredaq_cpp_example_snapshot.exe COM5
API\\cpp_api\\build\\Release\\coredaq_cpp_example_transfer.exe COM5 2000
```
