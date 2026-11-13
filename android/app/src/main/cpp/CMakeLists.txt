cmake_minimum_required(VERSION 3.22.1)
project(noteject_djvu LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
get_filename_component(VENDOR "${CMAKE_CURRENT_LIST_DIR}/../../../../vendor" ABSOLUTE)
set(DJVU "${VENDOR}/djvulibre/djvulibre-3.5.29")
set(JPEG "${VENDOR}/libjpeg-turbo/libjpeg-turbo-3.1.4.1")

include(ExternalProject)
set(JPEG_BUILD "${CMAKE_CURRENT_BINARY_DIR}/jpeg")
ExternalProject_Add(jpeg-build
    SOURCE_DIR "${JPEG}" BINARY_DIR "${JPEG_BUILD}"
    CMAKE_GENERATOR Ninja
    CMAKE_ARGS "-DCMAKE_TOOLCHAIN_FILE=${CMAKE_TOOLCHAIN_FILE}"
        "-DANDROID_ABI=${ANDROID_ABI}" "-DANDROID_PLATFORM=android-26"
        "-DCMAKE_MAKE_PROGRAM=${CMAKE_MAKE_PROGRAM}" "-DCMAKE_BUILD_TYPE=Release"
        "-DCMAKE_POSITION_INDEPENDENT_CODE=ON" "-DCMAKE_C_FLAGS=-fvisibility=hidden"
        -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_TURBOJPEG=OFF
        -DWITH_TOOLS=OFF -DWITH_TESTS=OFF -DWITH_SIMD=OFF
    BUILD_COMMAND "${CMAKE_COMMAND}" --build "${JPEG_BUILD}" --target jpeg-static --parallel 2
    BUILD_BYPRODUCTS "${JPEG_BUILD}/libjpeg.a"
    INSTALL_COMMAND "")
add_library(jpeg-static STATIC IMPORTED)
set_target_properties(jpeg-static PROPERTIES IMPORTED_LOCATION "${JPEG_BUILD}/libjpeg.a")
add_dependencies(jpeg-static jpeg-build)

# Android/Bionic provides these POSIX/C++ facilities on the minimum API 26.
# Derive config.h from the unmodified upstream template so its compatibility
# macros stay in sync with the pinned release.
file(READ "${DJVU}/config/config.h.in" CONFIG_TEXT)
set(FEATURES BOOL DIRENT_H DLFCN_H EXCEPTIONS FSEEKO GCCTLS GETHOSTNAME GETOPT_H
    GETPAGESIZE GETPWUID INTEL_ATOMIC_BUILTINS INTTYPES_H ISWSPACE JPEG LANGINFO_H
    LIBM LONG_LONG_INT MBSTATE_T MEMBER_TEMPLATES MKSTEMP MMAP NAMESPACES NL_LANGINFO
    PTHREAD PUTC_UNLOCKED SCHED_H SCHED_YIELD SETENV SIGACTION SNPRINTF STDINCLUDES
    STDINT_H STDIO_H STDLIB_H STRERROR STRFTIME STRINGS_H STRING_H SYS_MMAN_H
    SYS_PARAM_H SYS_STAT_H SYS_TIME_H SYS_TYPES_H SYS_WAIT_H TYPENAME UNISTD_H
    VSNPRINTF WCHAR_H WCHAR_T WCRTOMB WCTYPE_H)
foreach(FEATURE IN LISTS FEATURES)
    string(REPLACE "#undef HAVE_${FEATURE}\n" "#define HAVE_${FEATURE} 1\n" CONFIG_TEXT "${CONFIG_TEXT}")
endforeach()
string(REPLACE "#undef DJVULIBRE_VERSION" "#define DJVULIBRE_VERSION \"3.5.29\"" CONFIG_TEXT "${CONFIG_TEXT}")
string(REPLACE "#undef _FILE_OFFSET_BITS" "#define _FILE_OFFSET_BITS 64" CONFIG_TEXT "${CONFIG_TEXT}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/config.h" "${CONFIG_TEXT}")

set(DJVU_FILES Arrays BSByteStream BSEncodeByteStream ByteStream DataPool DjVmDir
    DjVmDir0 DjVmDoc DjVmNav DjVuAnno DjVuDocEditor DjVuDocument DjVuDumpHelper
    DjVuErrorList DjVuFile DjVuFileCache DjVuGlobal DjVuGlobalMemory DjVuImage
    DjVuInfo DjVuMessage DjVuMessageLite DjVuNavDir DjVuPalette DjVuPort DjVuText
    DjVuToPS GBitmap GContainer GException GIFFManager GMapAreas GOS GPixmap GRect
    GScaler GSmartPointer GString GThreads GURL GUnicode IFFByteStream IW44EncodeCodec
    IW44Image JB2EncodeCodec JB2Image JPEGDecoder MMRDecoder MMX UnicodeByteStream
    XMLParser XMLTags ZPCodec atomic ddjvuapi debug miniexp)
list(TRANSFORM DJVU_FILES PREPEND "${DJVU}/libdjvu/")
list(TRANSFORM DJVU_FILES APPEND ".cpp")
add_library(noteject_djvu SHARED djvu-reader.cpp ${DJVU_FILES})
target_compile_definitions(noteject_djvu PRIVATE HAVE_CONFIG_H=1 "DIR_DATADIR=\"\"")
target_include_directories(noteject_djvu PRIVATE "${DJVU}/libdjvu" "${CMAKE_CURRENT_BINARY_DIR}"
    "${JPEG}/src" "${CMAKE_CURRENT_BINARY_DIR}/jpeg")
target_compile_options(noteject_djvu PRIVATE -O2 -fexceptions -frtti -fvisibility=hidden)
target_link_libraries(noteject_djvu PRIVATE jpeg-static jnigraphics log)
target_link_options(noteject_djvu PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,--exclude-libs,ALL"
    "-Wl,--version-script=${CMAKE_CURRENT_LIST_DIR}/exports.map")
set_target_properties(noteject_djvu PROPERTIES LINK_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/exports.map")
