#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

using ViStatus = int32_t;
using ViUInt32 = uint32_t;
using ViUInt16 = uint16_t;
using ViUInt8 = uint8_t;
using ViAttr = uint32_t;
using ViAttrState = uintptr_t;
using ViObject = uint32_t;
using ViSession = uint32_t;
using ViFindList = uint32_t;
using ViAccessMode = uint32_t;
using ViBuf = ViUInt8*;
using ViRsrc = const char*;
using ViString = const char*;

constexpr ViStatus VI_SUCCESS = 0;
constexpr ViStatus VI_SUCCESS_MAX_CNT = static_cast<ViStatus>(0x3FFF0006);
constexpr ViStatus VI_ERROR_INV_OBJECT = static_cast<ViStatus>(0xBFFF000E);
constexpr ViStatus VI_ERROR_RSRC_NFOUND = static_cast<ViStatus>(0xBFFF0011);
constexpr ViStatus VI_ERROR_TMO = static_cast<ViStatus>(0xBFFF0015);
constexpr ViStatus VI_ERROR_NSUP_ATTR = static_cast<ViStatus>(0xBFFF001D);

constexpr ViUInt32 VI_NULL = 0;
constexpr ViAttr VI_ATTR_TMO_VALUE = 0x3FFF001AU;
constexpr ViAttr VI_ATTR_TERMCHAR = 0x3FFF0018U;
constexpr ViAttr VI_ATTR_TERMCHAR_EN = 0x3FFF0038U;

constexpr size_t VISA_DESC_BUF_LEN = 1024;
constexpr ViUInt32 READ_MAX_BYTES_LIMIT = 1024U * 1024U;

#ifdef _WIN32
#define VISA_CALL __stdcall
using VisaLibHandle = HMODULE;
#else
#define VISA_CALL
using VisaLibHandle = void*;
#endif

using viOpenDefaultRM_t = ViStatus(VISA_CALL*)(ViSession*);
using viFindRsrc_t = ViStatus(VISA_CALL*)(ViSession, ViString, ViFindList*, ViUInt32*, char[]);
using viFindNext_t = ViStatus(VISA_CALL*)(ViFindList, char[]);
using viOpen_t = ViStatus(VISA_CALL*)(ViSession, ViRsrc, ViAccessMode, ViUInt32, ViSession*);
using viSetAttribute_t = ViStatus(VISA_CALL*)(ViObject, ViAttr, ViAttrState);
using viWrite_t = ViStatus(VISA_CALL*)(ViSession, ViBuf, ViUInt32, ViUInt32*);
using viRead_t = ViStatus(VISA_CALL*)(ViSession, ViBuf, ViUInt32, ViUInt32*);
using viClose_t = ViStatus(VISA_CALL*)(ViObject);
using viStatusDesc_t = ViStatus(VISA_CALL*)(ViObject, ViStatus, char[]);

VisaLibHandle g_visa = nullptr;
std::string g_loaded_path;
std::vector<std::string> g_checked_paths;

viOpenDefaultRM_t p_viOpenDefaultRM = nullptr;
viFindRsrc_t p_viFindRsrc = nullptr;
viFindNext_t p_viFindNext = nullptr;
viOpen_t p_viOpen = nullptr;
viSetAttribute_t p_viSetAttribute = nullptr;
viWrite_t p_viWrite = nullptr;
viRead_t p_viRead = nullptr;
viClose_t p_viClose = nullptr;
viStatusDesc_t p_viStatusDesc = nullptr;

bool IsVisaSuccess(ViStatus st) {
  return st >= 0;
}

const char* PlatformName() {
#ifdef _WIN32
  return "win32";
#elif __APPLE__
  return "darwin";
#elif __linux__
  return "linux";
#else
  return "unknown";
#endif
}

std::string HexStatus(ViStatus st) {
  std::ostringstream oss;
  oss << "0x" << std::uppercase << std::hex << static_cast<uint32_t>(st);
  return oss.str();
}

std::string VisaStatusName(ViStatus st) {
  switch (st) {
    case VI_SUCCESS:
      return "VI_SUCCESS";
    case VI_SUCCESS_MAX_CNT:
      return "VI_SUCCESS_MAX_CNT";
    case VI_ERROR_TMO:
      return "VI_ERROR_TMO";
    case VI_ERROR_RSRC_NFOUND:
      return "VI_ERROR_RSRC_NFOUND";
    case VI_ERROR_INV_OBJECT:
      return "VI_ERROR_INV_OBJECT";
    case VI_ERROR_NSUP_ATTR:
      return "VI_ERROR_NSUP_ATTR";
    default:
      return "VISA_STATUS";
  }
}

#ifdef _WIN32
std::string WideToUtf8(const std::wstring& ws) {
  if (ws.empty()) return std::string();
  int sz = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (sz <= 0) return std::string();
  std::string out(static_cast<size_t>(sz - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, out.data(), sz, nullptr, nullptr);
  return out;
}

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int wlen = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (wlen <= 1) return std::wstring();
  std::wstring ws(static_cast<size_t>(wlen - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, ws.data(), wlen);
  return ws;
}
#endif

void ResetVisaPointers() {
  p_viOpenDefaultRM = nullptr;
  p_viFindRsrc = nullptr;
  p_viFindNext = nullptr;
  p_viOpen = nullptr;
  p_viSetAttribute = nullptr;
  p_viWrite = nullptr;
  p_viRead = nullptr;
  p_viClose = nullptr;
  p_viStatusDesc = nullptr;
}

void CloseVisaLibrary() {
  if (!g_visa) return;
#ifdef _WIN32
  FreeLibrary(g_visa);
#else
  dlclose(g_visa);
#endif
  g_visa = nullptr;
  g_loaded_path.clear();
  ResetVisaPointers();
}

void* ResolveSymbol(const char* name) {
#ifdef _WIN32
  return reinterpret_cast<void*>(GetProcAddress(g_visa, name));
#else
  return dlsym(g_visa, name);
#endif
}

bool ResolveVisaSymbols(std::string* reason) {
  p_viOpenDefaultRM = reinterpret_cast<viOpenDefaultRM_t>(ResolveSymbol("viOpenDefaultRM"));
  p_viFindRsrc = reinterpret_cast<viFindRsrc_t>(ResolveSymbol("viFindRsrc"));
  p_viFindNext = reinterpret_cast<viFindNext_t>(ResolveSymbol("viFindNext"));
  p_viOpen = reinterpret_cast<viOpen_t>(ResolveSymbol("viOpen"));
  p_viSetAttribute = reinterpret_cast<viSetAttribute_t>(ResolveSymbol("viSetAttribute"));
  p_viWrite = reinterpret_cast<viWrite_t>(ResolveSymbol("viWrite"));
  p_viRead = reinterpret_cast<viRead_t>(ResolveSymbol("viRead"));
  p_viClose = reinterpret_cast<viClose_t>(ResolveSymbol("viClose"));
  p_viStatusDesc = reinterpret_cast<viStatusDesc_t>(ResolveSymbol("viStatusDesc"));

  if (!p_viOpenDefaultRM || !p_viFindRsrc || !p_viFindNext || !p_viOpen ||
      !p_viSetAttribute || !p_viWrite || !p_viRead || !p_viClose || !p_viStatusDesc) {
    if (reason) {
      *reason = "Required VISA symbols were not found in loaded library";
    }
    ResetVisaPointers();
    return false;
  }
  return true;
}

std::vector<std::string> BuildVisaCandidates() {
  std::vector<std::string> c;
#ifdef _WIN32
  c = {
      "visa64.dll",
      "C:\\Windows\\System32\\visa64.dll",
      "C:\\Program Files\\IVI Foundation\\VISA\\Win64\\Bin\\visa64.dll",
      "C:\\Program Files\\National Instruments\\Shared\\VISA\\Bin\\visa64.dll",
  };
#elif __APPLE__
  c = {
      "libvisa.dylib",
      "/Library/Frameworks/VISA.framework/VISA",
      "/usr/local/vxipnp/mac/lib/libvisa.dylib",
      "/usr/local/lib/libvisa.dylib",
      "/opt/homebrew/lib/libvisa.dylib",
  };
#else
  c = {
      "libvisa.so",
      "/usr/lib/libvisa.so",
      "/usr/local/lib/libvisa.so",
  };
#endif

  const char* env_path = std::getenv("VISA_DLL_PATH");
  if (env_path != nullptr && env_path[0] != '\0') {
    c.insert(c.begin(), std::string(env_path));
  }
  return c;
}

bool TryLoadLibrary(const std::string& p, VisaLibHandle* out) {
#ifdef _WIN32
  const std::wstring wp = Utf8ToWide(p);
  if (wp.empty()) return false;
  HMODULE lib = LoadLibraryW(wp.c_str());
  if (!lib) return false;
  *out = lib;
  return true;
#else
  void* lib = dlopen(p.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (!lib) return false;
  *out = lib;
  return true;
#endif
}

bool LoadVisaLibrary(std::string* reason) {
  if (g_visa != nullptr) {
    return true;
  }

  g_checked_paths.clear();
  const auto candidates = BuildVisaCandidates();

  for (const auto& c : candidates) {
    g_checked_paths.push_back(c);
    VisaLibHandle lib = nullptr;
    if (!TryLoadLibrary(c, &lib)) {
      continue;
    }

    g_visa = lib;
    g_loaded_path = c;

    if (ResolveVisaSymbols(reason)) {
      return true;
    }

    CloseVisaLibrary();
  }

  if (reason) {
#ifdef _WIN32
    *reason = "Could not load NI-VISA library (visa64.dll)";
#else
    *reason = "Could not load VISA library (libvisa)";
#endif
  }
  return false;
}

bool EnsureVisaLoaded(Napi::Env env) {
  std::string reason;
  if (LoadVisaLibrary(&reason)) return true;

  Napi::Error err = Napi::Error::New(env, reason);
  Napi::Object obj = err.Value();
  obj.Set("code", Napi::String::New(env, "NI_VISA_NOT_FOUND"));
  Napi::Array arr = Napi::Array::New(env, g_checked_paths.size());
  for (size_t i = 0; i < g_checked_paths.size(); ++i) {
    arr.Set(i, Napi::String::New(env, g_checked_paths[i]));
  }
  obj.Set("checkedPaths", arr);
  err.ThrowAsJavaScriptException();
  return false;
}

std::string StatusDescription(ViObject handle, ViStatus st) {
  if (p_viStatusDesc != nullptr && g_visa != nullptr) {
    char desc[512] = {0};
    ViStatus rc = p_viStatusDesc(handle, st, desc);
    if (IsVisaSuccess(rc) && desc[0] != '\0') {
      return std::string(desc);
    }
  }

  std::ostringstream oss;
  oss << VisaStatusName(st) << " (" << HexStatus(st) << ")";
  return oss.str();
}

void ThrowVisaJsError(Napi::Env env,
                      const std::string& code,
                      const std::string& message,
                      ViStatus st,
                      bool include_paths = false) {
  Napi::Error err = Napi::Error::New(env, message);
  Napi::Object o = err.Value();
  o.Set("code", Napi::String::New(env, code));
  o.Set("status", Napi::Number::New(env, static_cast<double>(st)));
  if (include_paths) {
    Napi::Array arr = Napi::Array::New(env, g_checked_paths.size());
    for (size_t i = 0; i < g_checked_paths.size(); ++i) {
      arr.Set(i, Napi::String::New(env, g_checked_paths[i]));
    }
    o.Set("checkedPaths", arr);
  }
  err.ThrowAsJavaScriptException();
}

Napi::Value Health(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  std::string reason;
  const bool loaded = LoadVisaLibrary(&reason);

  out.Set("visaLoaded", Napi::Boolean::New(env, loaded));
  out.Set("platform", Napi::String::New(env, PlatformName()));
  out.Set("reason", Napi::String::New(env, reason));
  out.Set("loadedPath", Napi::String::New(env, g_loaded_path));

  Napi::Array checked = Napi::Array::New(env, g_checked_paths.size());
  for (size_t i = 0; i < g_checked_paths.size(); ++i) {
    checked.Set(i, Napi::String::New(env, g_checked_paths[i]));
  }
  out.Set("checkedPaths", checked);

  if (!loaded) {
    out.Set("resourceManager", Napi::Boolean::New(env, false));
    return out;
  }

  ViSession rm = VI_NULL;
  ViStatus st = p_viOpenDefaultRM(&rm);
  if (!IsVisaSuccess(st)) {
    out.Set("resourceManager", Napi::Boolean::New(env, false));
    out.Set("status", Napi::Number::New(env, static_cast<double>(st)));
    out.Set("statusText", Napi::String::New(env, StatusDescription(rm, st)));
    return out;
  }

  out.Set("resourceManager", Napi::Boolean::New(env, true));
  if (p_viClose != nullptr) {
    (void)p_viClose(rm);
  }
  return out;
}

Napi::Value InitVisa(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  ViSession rm = VI_NULL;
  ViStatus st = p_viOpenDefaultRM(&rm);
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_INIT_FAILED", StatusDescription(rm, st), st);
    return env.Null();
  }

  return Napi::Number::New(env, static_cast<double>(rm));
}

Napi::Value ListResources(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 1 || !info[0].IsNumber()) {
    ThrowVisaJsError(env, "INVALID_ARGUMENT", "listResources(rmHandle) requires rmHandle number", 0);
    return env.Null();
  }

  ViSession rm = static_cast<ViSession>(info[0].As<Napi::Number>().Uint32Value());
  ViFindList find_list = VI_NULL;
  ViUInt32 count = 0;
  char desc[VISA_DESC_BUF_LEN] = {0};

  ViStatus st = p_viFindRsrc(rm, "?*INSTR", &find_list, &count, desc);
  if (st == VI_ERROR_RSRC_NFOUND) {
    return Napi::Array::New(env, 0);
  }
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(rm, st), st);
    return env.Null();
  }

  Napi::Array out = Napi::Array::New(env);
  uint32_t idx = 0;
  out.Set(idx++, Napi::String::New(env, std::string(desc)));

  for (ViUInt32 i = 1; i < count; ++i) {
    char next_desc[VISA_DESC_BUF_LEN] = {0};
    ViStatus st_next = p_viFindNext(find_list, next_desc);
    if (!IsVisaSuccess(st_next)) {
      if (p_viClose != nullptr) {
        (void)p_viClose(find_list);
      }
      ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(find_list, st_next), st_next);
      return env.Null();
    }
    out.Set(idx++, Napi::String::New(env, std::string(next_desc)));
  }

  if (p_viClose != nullptr) {
    (void)p_viClose(find_list);
  }

  return out;
}

Napi::Value OpenSession(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    ThrowVisaJsError(env,
                     "INVALID_ARGUMENT",
                     "open(rmHandle, resourceString) requires (number, string)",
                     0);
    return env.Null();
  }

  ViSession rm = static_cast<ViSession>(info[0].As<Napi::Number>().Uint32Value());
  std::string resource = info[1].As<Napi::String>().Utf8Value();

  ViSession session = VI_NULL;
  ViStatus st = p_viOpen(rm, resource.c_str(), 0, 0, &session);
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(rm, st), st);
    return env.Null();
  }

  return Napi::Number::New(env, static_cast<double>(session));
}

Napi::Value SetTimeout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    ThrowVisaJsError(env,
                     "INVALID_ARGUMENT",
                     "setTimeout(sessionHandle, ms) requires (number, number)",
                     0);
    return env.Null();
  }

  ViSession session = static_cast<ViSession>(info[0].As<Napi::Number>().Uint32Value());
  ViAttrState timeout_ms = static_cast<ViAttrState>(info[1].As<Napi::Number>().Uint32Value());
  ViStatus st = p_viSetAttribute(session, VI_ATTR_TMO_VALUE, timeout_ms);
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(session, st), st);
    return env.Null();
  }
  return env.Undefined();
}

Napi::Value SetTermChar(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsBoolean()) {
    ThrowVisaJsError(env,
                     "INVALID_ARGUMENT",
                     "setTermChar(sessionHandle, charCode, enable) requires (number, number, boolean)",
                     0);
    return env.Null();
  }

  ViSession session = static_cast<ViSession>(info[0].As<Napi::Number>().Uint32Value());
  ViAttrState char_code = static_cast<ViAttrState>(info[1].As<Napi::Number>().Uint32Value() & 0xFFU);
  ViAttrState enabled = info[2].As<Napi::Boolean>().Value() ? 1U : 0U;

  ViStatus st = p_viSetAttribute(session, VI_ATTR_TERMCHAR, char_code);
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(session, st), st);
    return env.Null();
  }

  st = p_viSetAttribute(session, VI_ATTR_TERMCHAR_EN, enabled);
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(session, st), st);
    return env.Null();
  }

  return env.Undefined();
}

Napi::Value Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 2 || !info[0].IsNumber() || !(info[1].IsBuffer() || info[1].IsString())) {
    ThrowVisaJsError(env,
                     "INVALID_ARGUMENT",
                     "write(sessionHandle, bufferOrString) requires (number, buffer|string)",
                     0);
    return env.Null();
  }

  ViSession session = static_cast<ViSession>(info[0].As<Napi::Number>().Uint32Value());

  std::vector<uint8_t> owned;
  const uint8_t* data_ptr = nullptr;
  size_t data_len = 0;

  if (info[1].IsBuffer()) {
    Napi::Buffer<uint8_t> buf = info[1].As<Napi::Buffer<uint8_t>>();
    data_ptr = buf.Data();
    data_len = buf.Length();
  } else {
    std::string s = info[1].As<Napi::String>().Utf8Value();
    owned.assign(s.begin(), s.end());
    data_ptr = owned.data();
    data_len = owned.size();
  }

  ViUInt32 written = 0;
  ViStatus st = p_viWrite(session,
                          const_cast<ViBuf>(reinterpret_cast<const ViUInt8*>(data_ptr)),
                          static_cast<ViUInt32>(data_len),
                          &written);
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(session, st), st);
    return env.Null();
  }

  return Napi::Number::New(env, static_cast<double>(written));
}

Napi::Value Read(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    ThrowVisaJsError(env, "INVALID_ARGUMENT", "read(sessionHandle, maxBytes) requires (number, number)", 0);
    return env.Null();
  }

  ViSession session = static_cast<ViSession>(info[0].As<Napi::Number>().Uint32Value());
  ViUInt32 max_bytes = info[1].As<Napi::Number>().Uint32Value();
  max_bytes = std::max<ViUInt32>(1, std::min<ViUInt32>(max_bytes, READ_MAX_BYTES_LIMIT));

  std::vector<uint8_t> buf(max_bytes);
  ViUInt32 read_count = 0;
  ViStatus st = p_viRead(session,
                         reinterpret_cast<ViBuf>(buf.data()),
                         max_bytes,
                         &read_count);
  if (!IsVisaSuccess(st)) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(session, st), st);
    return env.Null();
  }

  return Napi::Buffer<uint8_t>::Copy(env, buf.data(), static_cast<size_t>(read_count));
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 1 || !info[0].IsNumber()) {
    ThrowVisaJsError(env, "INVALID_ARGUMENT", "close(handle) requires number", 0);
    return env.Null();
  }

  ViObject handle = static_cast<ViObject>(info[0].As<Napi::Number>().Uint32Value());
  ViStatus st = p_viClose(handle);
  if (!IsVisaSuccess(st) && st != VI_ERROR_INV_OBJECT) {
    ThrowVisaJsError(env, "VISA_ERROR", StatusDescription(handle, st), st);
    return env.Null();
  }

  return env.Undefined();
}

Napi::Value StatusDesc(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureVisaLoaded(env)) {
    return env.Null();
  }

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    ThrowVisaJsError(env, "INVALID_ARGUMENT", "statusDesc(handle, status) requires (number, number)", 0);
    return env.Null();
  }
  ViObject handle = static_cast<ViObject>(info[0].As<Napi::Number>().Uint32Value());
  ViStatus st = static_cast<ViStatus>(info[1].As<Napi::Number>().Int64Value());
  return Napi::String::New(env, StatusDescription(handle, st));
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("health", Napi::Function::New(env, Health));
  exports.Set("init", Napi::Function::New(env, InitVisa));
  exports.Set("listResources", Napi::Function::New(env, ListResources));
  exports.Set("open", Napi::Function::New(env, OpenSession));
  exports.Set("setTimeout", Napi::Function::New(env, SetTimeout));
  exports.Set("setTermChar", Napi::Function::New(env, SetTermChar));
  exports.Set("write", Napi::Function::New(env, Write));
  exports.Set("read", Napi::Function::New(env, Read));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("statusDesc", Napi::Function::New(env, StatusDesc));
  return exports;
}

}  // namespace

NODE_API_MODULE(visa_addon, InitModule)
