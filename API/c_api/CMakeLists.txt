cmake_minimum_required(VERSION 3.16)
project(coredaq_c_api C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_library(coredaq_c_api STATIC
  src/coredaq_c_api.c
)

target_include_directories(coredaq_c_api PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(NOT WIN32)
  target_link_libraries(coredaq_c_api PRIVATE m)
endif()

add_executable(coredaq_c_example_snapshot examples/example_snapshot_w.c)
add_executable(coredaq_c_example_triggered examples/example_triggered_capture.c)

target_link_libraries(coredaq_c_example_snapshot PRIVATE coredaq_c_api)
target_link_libraries(coredaq_c_example_triggered PRIVATE coredaq_c_api)
