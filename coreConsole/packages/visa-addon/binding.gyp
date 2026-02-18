{
  "targets": [
    {
      "target_name": "visa_addon",
      "sources": ["src/visa_addon.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        ["OS==\"win\"", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/utf-8"]
            }
          }
        }]
      ]
    }
  ]
}
