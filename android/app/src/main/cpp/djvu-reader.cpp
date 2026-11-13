#include <jni.h>
#include <android/bitmap.h>
#include <ddjvuapi.h>
#include <miniexp.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <list>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {
struct Cancelled : std::runtime_error { Cancelled() : std::runtime_error("Page rendering was cancelled.") {} };
struct PageDeleter { void operator()(ddjvu_page_t* p) const { if (p) ddjvu_page_release(p); } };
using Page = std::unique_ptr<ddjvu_page_t, PageDeleter>;
struct Session {
    ddjvu_context_t* context = nullptr;
    ddjvu_document_t* document = nullptr;
    ddjvu_format_t* format = nullptr;
    std::mutex operations;
    std::atomic<uint64_t> generation{0};
    std::list<std::pair<int, Page>> pages;
    int count = 0;
    ~Session() {
        pages.clear();
        if (format) ddjvu_format_release(format);
        if (document) ddjvu_document_release(document);
        if (context) { ddjvu_cache_clear(context); ddjvu_context_release(context); }
    }
    void check(uint64_t expected) const { if (generation.load() != expected) throw Cancelled(); }
    void messages() {
        std::string error;
        while (const auto* message = ddjvu_message_peek(context)) {
            if (message->m_any.tag == DDJVU_ERROR && error.empty()) error = message->m_error.message ? message->m_error.message : "Invalid DjVu data.";
            // Complete bundled files require no external resource requests.
            if (message->m_any.tag == DDJVU_NEWSTREAM) {
                ddjvu_stream_close(document, message->m_newstream.streamid, 1);
                error = "This DjVu needs companion files. Import a bundled .djvu document.";
            }
            ddjvu_message_pop(context);
        }
        if (!error.empty()) throw std::runtime_error(error);
    }
    template<class Ready> void wait(Ready ready, uint64_t expected, int seconds = 120) {
        const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
        while (!ready()) {
            check(expected); messages();
            if (std::chrono::steady_clock::now() > until) throw std::runtime_error("DjVu decoding timed out. Try this page again.");
            std::this_thread::sleep_for(std::chrono::milliseconds(8));
        }
        check(expected); messages();
    }
    ddjvu_page_t* page(int index, uint64_t expected) {
        if (index < 0 || index >= count) throw std::runtime_error("Page is outside this document.");
        for (auto it = pages.begin(); it != pages.end(); ++it) {
            if (it->first == index) {
                pages.splice(pages.begin(), pages, it);
                return decoded(pages.front().second.get(), expected);
            }
        }
        Page created(ddjvu_page_create_by_pageno(document, index));
        if (!created) throw std::runtime_error("This DjVu page could not be opened.");
        pages.emplace_front(index, std::move(created));
        if (pages.size() > 3) pages.pop_back();
        return decoded(pages.front().second.get(), expected);
    }
    ddjvu_page_t* decoded(ddjvu_page_t* page, uint64_t expected) {
        wait([&] { return ddjvu_page_decoding_done(page); }, expected);
        if (ddjvu_page_decoding_error(page)) throw std::runtime_error("This DjVu page could not be decoded.");
        return page;
    }
};

std::mutex registryLock;
std::unordered_map<jlong, std::shared_ptr<Session>> sessions;
std::atomic<jlong> nextId{1};
std::shared_ptr<Session> lookup(jlong handle, bool required = true) {
    std::lock_guard<std::mutex> guard(registryLock);
    const auto found = sessions.find(handle);
    if (found != sessions.end()) return found->second;
    if (required) throw std::runtime_error("The DjVu document is closed.");
    return nullptr;
}
void exception(JNIEnv* env) {
    try { throw; }
    catch (const Cancelled& error) { env->ThrowNew(env->FindClass("java/util/concurrent/CancellationException"), error.what()); }
    catch (const std::exception& error) { env->ThrowNew(env->FindClass("java/io/IOException"), error.what()); }
    catch (...) { env->ThrowNew(env->FindClass("java/io/IOException"), "The native DjVu decoder failed."); }
}
jbyteArray bytes(JNIEnv* env, const std::string& value) {
    const auto result = env->NewByteArray(static_cast<jsize>(value.size()));
    if (result && !value.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(value.size()), reinterpret_cast<const jbyte*>(value.data()));
    return result;
}
std::string quote(const char* value) {
    std::string result = "\"";
    for (const unsigned char ch : std::string(value ? value : "")) {
        if (ch == '"' || ch == '\\') { result += '\\'; result += ch; }
        else if (ch < 32) {
            constexpr char hex[] = "0123456789abcdef";
            result += "\\u00"; result += hex[ch >> 4]; result += hex[ch & 15];
        } else result += ch;
    }
    return result + '"';
}
// A caller-owned Android bitmap is locked only for the actual region render.
struct Pixels {
    JNIEnv* env; jobject bitmap; void* data = nullptr;
    Pixels(JNIEnv* env, jobject bitmap) : env(env), bitmap(bitmap) {
        if (AndroidBitmap_lockPixels(env, bitmap, &data) != ANDROID_BITMAP_RESULT_SUCCESS) throw std::runtime_error("Could not access page pixels.");
    }
    ~Pixels() { AndroidBitmap_unlockPixels(env, bitmap); }
};
struct Expression {
    ddjvu_document_t* doc; miniexp_t value;
    ~Expression() { if (value != miniexp_dummy) ddjvu_miniexp_release(doc, value); }
};
} // namespace

extern "C" JNIEXPORT jlong JNICALL Java_com_noteject_app_DjVuNative_open(JNIEnv* env, jobject, jstring filename) {
    try {
        auto session = std::make_shared<Session>();
        session->context = ddjvu_context_create("noteject");
        if (!session->context) throw std::runtime_error("Could not start DjVuLibre.");
        ddjvu_cache_set_size(session->context, 16 * 1024 * 1024);
        const char* path = env->GetStringUTFChars(filename, nullptr);
        if (!path) return 0;
        session->document = ddjvu_document_create_by_filename_utf8(session->context, path, 1);
        env->ReleaseStringUTFChars(filename, path);
        if (!session->document) throw std::runtime_error("This DjVu file could not be opened.");
        session->wait([&] { return ddjvu_document_decoding_done(session->document); }, 0, 30);
        if (ddjvu_document_decoding_error(session->document)) throw std::runtime_error("Invalid or incomplete DjVu document.");
        const auto type = ddjvu_document_get_type(session->document);
        if (type == DDJVU_DOCTYPE_INDIRECT || type == DDJVU_DOCTYPE_OLD_INDEXED) throw std::runtime_error("This DjVu needs companion files. Import a bundled .djvu document.");
        session->count = ddjvu_document_get_pagenum(session->document);
        if (session->count <= 0 || session->count > 1'000'000) throw std::runtime_error("Invalid DjVu page count.");
        unsigned int masks[] = { 0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000 };
        session->format = ddjvu_format_create(DDJVU_FORMAT_RGBMASK32, 4, masks);
        if (!session->format) throw std::runtime_error("Could not initialize DjVu page colors.");
        ddjvu_format_set_row_order(session->format, 1);
        ddjvu_format_set_y_direction(session->format, 1);
        const auto id = nextId.fetch_add(1);
        { std::lock_guard<std::mutex> guard(registryLock); sessions.emplace(id, session); }
        return id;
    } catch (...) { exception(env); return 0; }
}
extern "C" JNIEXPORT jint JNICALL Java_com_noteject_app_DjVuNative_pageCount(JNIEnv* env, jobject, jlong handle) {
    try { return lookup(handle)->count; } catch (...) { exception(env); return 0; }
}
extern "C" JNIEXPORT jintArray JNICALL Java_com_noteject_app_DjVuNative_size(JNIEnv* env, jobject, jlong handle, jint index) {
    try {
        auto session = lookup(handle); std::lock_guard<std::mutex> guard(session->operations);
        const auto generation = session->generation.load();
        if (index < 0 || index >= session->count) throw std::runtime_error("Invalid page number.");
        ddjvu_pageinfo_t info{}; ddjvu_status_t status;
        session->wait([&] { status = ddjvu_document_get_pageinfo(session->document, index, &info); return status >= DDJVU_JOB_OK; }, generation);
        if (status != DDJVU_JOB_OK || info.width <= 0 || info.height <= 0) throw std::runtime_error("Invalid DjVu page dimensions.");
        jint values[] = { info.width, info.height };
        const auto result = env->NewIntArray(2);
        if (result) env->SetIntArrayRegion(result, 0, 2, values);
        return result;
    } catch (...) { exception(env); return nullptr; }
}
extern "C" JNIEXPORT void JNICALL Java_com_noteject_app_DjVuNative_render(JNIEnv* env, jobject, jlong handle, jint index, jint width, jint height, jint left, jint top, jobject bitmap) {
    try {
        auto session = lookup(handle); std::lock_guard<std::mutex> guard(session->operations);
        const auto generation = session->generation.load();
        AndroidBitmapInfo info{};
        if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS || info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
            width < 1 || height < 1 || width > 131072 || height > 131072 || left < 0 || top < 0 ||
            info.width > 8192 || info.height > 8192 || uint64_t(info.width) * info.height > 6'000'000 ||
            int64_t(left) + info.width > width || int64_t(top) + info.height > height) throw std::runtime_error("Invalid DjVu render region.");
        const auto page = session->page(index, generation);
        session->check(generation);
        const ddjvu_rect_t entire{0, 0, static_cast<unsigned>(width), static_cast<unsigned>(height)};
        const ddjvu_rect_t region{left, top, info.width, info.height};
        {
            Pixels pixels(env, bitmap);
            if (!ddjvu_page_render(page, DDJVU_RENDER_COLOR, &entire, &region, session->format, info.stride, static_cast<char*>(pixels.data)))
                throw std::runtime_error("This DjVu page could not be rendered.");
        }
        session->check(generation); session->messages();
    } catch (...) { exception(env); }
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_com_noteject_app_DjVuNative_text(JNIEnv* env, jobject, jlong handle, jint index) {
    try {
        auto session = lookup(handle); std::lock_guard<std::mutex> guard(session->operations);
        if (index < 0 || index >= session->count) throw std::runtime_error("Invalid page number.");
        const auto generation = session->generation.load();
        Expression expression{session->document, miniexp_dummy};
        session->wait([&] { expression.value = ddjvu_document_get_pagetext(session->document, index, "line"); return expression.value != miniexp_dummy; }, generation);
        if (miniexp_symbolp(expression.value)) throw std::runtime_error("This DjVu page text could not be read.");
        std::string text;
        std::vector<miniexp_t> stack{expression.value};
        size_t visited = 0;
        while (!stack.empty() && visited++ < 1'000'000 && text.size() < 8'000'000) {
            session->check(generation);
            const auto value = stack.back(); stack.pop_back();
            if (miniexp_stringp(value)) { text += miniexp_to_str(value); text += '\n'; }
            else if (miniexp_consp(value)) { stack.push_back(miniexp_cdr(value)); stack.push_back(miniexp_car(value)); }
        }
        return bytes(env, text);
    } catch (...) { exception(env); return nullptr; }
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_com_noteject_app_DjVuNative_textLayout(JNIEnv* env, jobject, jlong handle, jint index) {
    try {
        auto session = lookup(handle); std::lock_guard<std::mutex> guard(session->operations);
        if (index < 0 || index >= session->count) throw std::runtime_error("Invalid page number.");
        const auto generation = session->generation.load();
        ddjvu_pageinfo_t info{}; ddjvu_status_t status;
        session->wait([&] { status = ddjvu_document_get_pageinfo(session->document, index, &info); return status >= DDJVU_JOB_OK; }, generation);
        if (status != DDJVU_JOB_OK || info.width <= 0 || info.height <= 0) throw std::runtime_error("Invalid DjVu page dimensions.");
        Expression expression{session->document, miniexp_dummy};
        session->wait([&] { expression.value = ddjvu_document_get_pagetext(session->document, index, "word"); return expression.value != miniexp_dummy; }, generation);
        if (miniexp_symbolp(expression.value)) throw std::runtime_error("This DjVu page text could not be read.");
        struct Zone { miniexp_t value; int line; int depth; };
        std::vector<Zone> pending{{expression.value, -1, 0}};
        std::string result = "["; bool first = true; int nextLine = 0; size_t visited = 0;
        const int rotation = info.rotation & 3;
        const double originalWidth = (rotation & 1) ? info.height : info.width;
        const double originalHeight = (rotation & 1) ? info.width : info.height;
        while (!pending.empty() && visited++ < 200000 && result.size() < 8'000'000) {
            session->check(generation);
            const auto zone = pending.back(); pending.pop_back();
            if (!miniexp_consp(zone.value) || zone.depth > 64) continue;
            const auto tag = miniexp_car(zone.value);
            if (!miniexp_symbolp(tag)) continue;
            const std::string kind = miniexp_to_name(tag);
            const int line = kind == "line" || zone.line < 0 ? ++nextLine : zone.line;
            auto children = miniexp_cdr(zone.value);
            int coordinates[4]; bool valid = true;
            for (int i = 0; i < 4; ++i) {
                if (!miniexp_consp(children) || !miniexp_numberp(miniexp_car(children))) { valid = false; break; }
                coordinates[i] = miniexp_to_int(miniexp_car(children)); children = miniexp_cdr(children);
            }
            if (!valid) continue;
            if (miniexp_consp(children) && miniexp_stringp(miniexp_car(children))) {
                double left = 1, top = 1, right = 0, bottom = 0;
                // OCR uses unrotated bottom-left coordinates. The native page
                // image includes the document's counter-clockwise rotation.
                for (int corner = 0; corner < 4; ++corner) {
                    const double x = coordinates[(corner & 1) ? 2 : 0];
                    const double y = coordinates[(corner & 2) ? 3 : 1];
                    double rx = x, ry = y;
                    if (rotation == 1) { rx = originalHeight - y; ry = x; }
                    else if (rotation == 2) { rx = originalWidth - x; ry = originalHeight - y; }
                    else if (rotation == 3) { rx = y; ry = originalWidth - x; }
                    rx /= info.width; ry = 1.0 - ry / info.height;
                    left = std::min(left, rx); right = std::max(right, rx);
                    top = std::min(top, ry); bottom = std::max(bottom, ry);
                }
                if (!first) result += ','; first = false;
                result += "{\"text\":" + quote(miniexp_to_str(miniexp_car(children))) + ",\"line\":" + std::to_string(line) +
                    ",\"left\":" + std::to_string(left) + ",\"top\":" + std::to_string(top) +
                    ",\"right\":" + std::to_string(right) + ",\"bottom\":" + std::to_string(bottom) + '}';
            } else {
                std::vector<miniexp_t> ordered;
                while (miniexp_consp(children) && ordered.size() < 200000) { ordered.push_back(miniexp_car(children)); children = miniexp_cdr(children); }
                for (auto it = ordered.rbegin(); it != ordered.rend(); ++it) pending.push_back({*it, line, zone.depth + 1});
            }
        }
        return bytes(env, result + ']');
    } catch (...) { exception(env); return nullptr; }
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_com_noteject_app_DjVuNative_outline(JNIEnv* env, jobject, jlong handle) {
    try {
        auto session = lookup(handle); std::lock_guard<std::mutex> guard(session->operations);
        const auto generation = session->generation.load();
        Expression expression{session->document, miniexp_dummy};
        session->wait([&] { expression.value = ddjvu_document_get_outline(session->document); return expression.value != miniexp_dummy; }, generation);
        if (miniexp_symbolp(expression.value)) throw std::runtime_error("This DjVu outline could not be read.");
        std::string result = "[";
        std::vector<std::pair<miniexp_t, int>> stack;
        if (miniexp_consp(expression.value)) stack.emplace_back(miniexp_cdr(expression.value), 0);
        size_t visited = 0; bool first = true;
        while (!stack.empty() && visited++ < 20000) {
            session->check(generation);
            const auto pending = stack.back(); stack.pop_back();
            const auto list = pending.first;
            if (!miniexp_consp(list) || pending.second > 64) continue;
            stack.emplace_back(miniexp_cdr(list), pending.second);
            const auto entry = miniexp_car(list);
            if (!miniexp_consp(entry)) continue;
            const auto title = miniexp_car(entry);
            const auto rest = miniexp_cdr(entry);
            const auto url = miniexp_consp(rest) ? miniexp_car(rest) : miniexp_nil;
            int page = -1;
            if (miniexp_stringp(url)) {
                std::string destination = miniexp_to_str(url);
                // Only document-internal destinations become navigation actions.
                if (!destination.empty() && destination[0] == '#') {
                    destination.erase(0, 1);
                    char* end = nullptr; const long numeric = std::strtol(destination.c_str(), &end, 10);
                    if (!destination.empty() && end && *end == '\0') page = numeric > 0 && numeric <= session->count ? int(numeric - 1) : -1;
                    else page = ddjvu_document_search_pageno(session->document, destination.c_str());
                }
            }
            if (page >= 0 && page < session->count && miniexp_stringp(title)) {
                if (!first) result += ','; first = false;
                result += "{\"title\":" + quote(miniexp_to_str(title)) + ",\"page\":" + std::to_string(page) + ",\"depth\":" + std::to_string(pending.second) + '}';
            }
            if (miniexp_consp(rest)) stack.emplace_back(miniexp_cdr(rest), pending.second + 1);
        }
        return bytes(env, result + ']');
    } catch (...) { exception(env); return nullptr; }
}
extern "C" JNIEXPORT void JNICALL Java_com_noteject_app_DjVuNative_cancel(JNIEnv* env, jobject, jlong handle) {
    try { if (auto session = lookup(handle, false)) session->generation.fetch_add(1); } catch (...) { exception(env); }
}
extern "C" JNIEXPORT void JNICALL Java_com_noteject_app_DjVuNative_trim(JNIEnv* env, jobject, jlong handle) {
    try {
        auto session = lookup(handle); std::lock_guard<std::mutex> guard(session->operations);
        session->pages.clear(); ddjvu_cache_clear(session->context); session->messages();
    } catch (...) { exception(env); }
}
extern "C" JNIEXPORT void JNICALL Java_com_noteject_app_DjVuNative_close(JNIEnv* env, jobject, jlong handle) {
    try {
        std::shared_ptr<Session> session;
        { std::lock_guard<std::mutex> guard(registryLock);
            const auto found = sessions.find(handle); if (found == sessions.end()) return;
            session = found->second; sessions.erase(found);
        }
        session->generation.fetch_add(1);
    } catch (...) { exception(env); }
}
