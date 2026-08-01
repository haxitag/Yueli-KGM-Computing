{
  "targets": [
    {
      "target_name": "kgm_native_core",
      "sources": [
        "src/addon.cc"
      ],
      "defines": [
        "NAPI_VERSION=8"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-O3"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "GCC_OPTIMIZATION_LEVEL": "3"
      },
      "conditions": [
        ["KGM_ENABLE_CUDA==\"1\"", {
          "defines": ["KGM_ENABLE_CUDA"],
          "include_dirs": [
            "<(CUDA_HOME)/include"
          ],
          "libraries": [
            "-L<(CUDA_HOME)/lib64",
            "-lcudart"
          ]
        }]
      ]
    }
  ]
}
