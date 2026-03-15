cmake_minimum_required(VERSION 3.16)
project(coredaq_cpp_api C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(coredaq_c_api STATIC
  ../c_api/src/coredaq_c_api.c
)

target_include_directories(coredaq_c_api PUBLIC
  ../c_api/include
)

if(NOT WIN32)
  target_link_libraries(coredaq_c_api PRIVATE m)
endif()

add_library(coredaq_cpp_api STATIC
  src/coredaq_cpp_api.cpp
)

target_include_directories(coredaq_cpp_api PUBLIC
  include
  ../c_api/include
)

target_link_libraries(coredaq_cpp_api PUBLIC coredaq_c_api)

add_executable(coredaq_cpp_example_snapshot examples/example_snapshot_w.cpp)
add_executable(coredaq_cpp_example_transfer examples/example_transfer_w.cpp)

target_link_libraries(coredaq_cpp_example_snapshot PRIVATE coredaq_cpp_api)
target_link_libraries(coredaq_cpp_example_transfer PRIVATE coredaq_cpp_api)
