/* A bounded, animated wl_shm client for the independent headless smoke test. */
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#ifdef LWFA_COLOR_TEST
#include "color-management-v1-client-protocol.h"
static struct wp_color_manager_v1 *color_manager;
static struct wp_image_description_v1 *color_image;
static struct wp_color_management_surface_v1 *color_surface;
static int color_ready;
static const char *source_space;
static int scrgb_source(void) { return source_space && !strcmp(source_space,"scrgb"); }
static void ignored_uint(void *data, struct wp_color_manager_v1 *manager, uint32_t value) { (void)data; (void)manager; (void)value; }
static void ignored_done(void *data, struct wp_color_manager_v1 *manager) { (void)data; (void)manager; }
static const struct wp_color_manager_v1_listener color_listener = { .supported_intent = ignored_uint, .supported_feature = ignored_uint, .supported_tf_named = ignored_uint, .supported_primaries_named = ignored_uint, .done = ignored_done };
static void image_ready(void *data, struct wp_image_description_v1 *image, uint32_t identity) { (void)data; (void)image; (void)identity; color_ready = 1; }
static void image_failed(void *data, struct wp_image_description_v1 *image, uint32_t cause, const char *message) { (void)data; (void)image; (void)cause; fprintf(stderr, "%s\n", message); exit(8); }
static const struct wp_image_description_v1_listener image_listener = { .ready = image_ready, .failed = image_failed };
#endif

#define WIDTH 320
#define HEIGHT 240

#ifdef LWFA_DMA_TEST
#include "headless-dmabuf.h"
#endif

struct buffer {
    struct wl_buffer *handle;
    uint32_t *pixels;
    int busy;
};

static struct wl_display *client_display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *shell;
static struct wl_surface *surface;
static struct buffer buffers[2];
static int ready, running = 1;
static unsigned frames;

static void draw(void);

static void released(void *data, struct wl_buffer *handle) {
    (void)handle;
    struct buffer *buffer = data;
    buffer->busy = 0;
    if (ready) draw();
}
static const struct wl_buffer_listener buffer_listener = { .release = released };

static void frame_done(void *data, struct wl_callback *callback, uint32_t time) {
    (void)data;
    (void)time;
    wl_callback_destroy(callback);
    ready = 1;
    draw();
}
static const struct wl_callback_listener frame_listener = { .done = frame_done };

static void draw(void) {
    struct buffer *buffer = NULL;
    for (unsigned i = 0; i < 2; ++i) {
        if (!buffers[i].busy) { buffer = &buffers[i]; break; }
    }
    if (!buffer) return;
#ifdef LWFA_EXPLICIT_TEST
    sync_prepare((unsigned)(buffer-buffers));
#elif defined(LWFA_DMA_TEST)
    dma_draw((unsigned)(buffer-buffers));
#else
    for (unsigned y = 0; y < HEIGHT; ++y) {
        for (unsigned x = 0; x < WIDTH; ++x) {
#ifdef LWFA_COLOR_TEST
            if (scrgb_source()) {
                uint16_t *pixel=(uint16_t *)buffer->pixels+(y*WIDTH+x)*4;
                pixel[0]=pixel[1]=pixel[2]=0x3d00; /* half 1.25 = 100 cd/m² */
                pixel[3]=0x3c00;
                continue;
            }
#endif
            buffer->pixels[y * WIDTH + x] =
#ifdef LWFA_COLOR_TEST
                source_space && !strcmp(source_space,"hlg") ? (3u<<30)|(644u<<20)|(644u<<10)|644u :
                (3u << 30) | (520u << 20) | (520u << 10) | 520u; /* PQ approximately 100 cd/m². */
#else
                0xffcc3322;
#endif
        }
    }
    /* Changing content proves frame callbacks keep the application advancing. */
    buffer->pixels[(frames % HEIGHT) * WIDTH] = 0xff22cc33;
    #endif
    buffer->busy = 1;
    ready = 0;
    struct wl_callback *callback = wl_surface_frame(surface);
    wl_callback_add_listener(callback, &frame_listener, NULL);
    wl_surface_attach(surface, buffer->handle, 0, 0);
    wl_surface_damage(surface, 0, 0, WIDTH, HEIGHT);
    wl_surface_commit(surface);
#ifdef LWFA_EXPLICIT_TEST
    wl_display_flush(client_display);
    sync_produce((unsigned)(buffer-buffers));
#endif
    printf("frame %u\n", ++frames);
    fflush(stdout);
}

static void configured(void *data, struct xdg_surface *xdg, uint32_t serial) {
    (void)data;
    xdg_surface_ack_configure(xdg, serial);
    if (!frames) { ready = 1; draw(); }
}
static const struct xdg_surface_listener surface_listener = { .configure = configured };

static void toplevel_configured(void *data, struct xdg_toplevel *toplevel,
                               int32_t width, int32_t height, struct wl_array *states) {
    (void)data; (void)toplevel; (void)width; (void)height; (void)states;
}
static void closed(void *data, struct xdg_toplevel *toplevel) {
    (void)data; (void)toplevel;
    running = 0;
}
static const struct xdg_toplevel_listener toplevel_listener = {
    .configure = toplevel_configured, .close = closed,
};

static void ping(void *data, struct xdg_wm_base *wm, uint32_t serial) {
    (void)data;
    xdg_wm_base_pong(wm, serial);
}
static const struct xdg_wm_base_listener shell_listener = { .ping = ping };

static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
    (void)data; (void)version;
#ifdef LWFA_COLOR_TEST
    if (!strcmp(interface, "wp_color_manager_v1")) {
        color_manager = wl_registry_bind(registry, name, &wp_color_manager_v1_interface, 1);
        wp_color_manager_v1_add_listener(color_manager, &color_listener, NULL);
    } else
#endif
#ifdef LWFA_DMA_TEST
#ifdef LWFA_EXPLICIT_TEST
    if (!strcmp(interface,"wp_linux_drm_syncobj_manager_v1")) {
        sync_manager=wl_registry_bind(registry,name,&wp_linux_drm_syncobj_manager_v1_interface,1);
    } else
#endif
    if (!strcmp(interface,"zwp_linux_dmabuf_v1")) {
        dma_manager=wl_registry_bind(registry,name,&zwp_linux_dmabuf_v1_interface,3);
    } else
#endif
    if (!strcmp(interface, "wl_compositor")) {
        compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 1);
    } else if (!strcmp(interface, "wl_shm")) {
        shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    } else if (!strcmp(interface, "xdg_wm_base")) {
        shell = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(shell, &shell_listener, NULL);
    }
}
static void global_removed(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data; (void)registry; (void)name;
}
static const struct wl_registry_listener registry_listener = {
    .global = global, .global_remove = global_removed,
};

int main(void) {
    struct wl_display *display = wl_display_connect(NULL);
    client_display=display;
#ifdef LWFA_COLOR_TEST
    source_space=getenv("LWFA_TEST_SOURCE_SPACE");
#endif
    if (!display) return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !compositor || !shm || !shell) return 2;
#ifdef LWFA_DMA_TEST
    if (!dma_manager) return 11;
    dma_init();
#endif
    for (unsigned i = 0; i < 2; ++i) {
#ifdef LWFA_DMA_TEST
        buffers[i].handle=dma_buffer(display,i);
        wl_buffer_add_listener(buffers[i].handle,&buffer_listener,&buffers[i]);
#else
        int pixel_size=4;
#ifdef LWFA_COLOR_TEST
        if (scrgb_source()) pixel_size=8;
#endif
        int size = WIDTH * HEIGHT * pixel_size;
        int fd = memfd_create("lwfa-headless-smoke", MFD_CLOEXEC);
        if (fd < 0 || ftruncate(fd, size) < 0) return 3;
        buffers[i].pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (buffers[i].pixels == MAP_FAILED) return 4;
        struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
        buffers[i].handle = wl_shm_pool_create_buffer(pool, 0, WIDTH, HEIGHT, WIDTH * pixel_size,
#ifdef LWFA_COLOR_TEST
            scrgb_source() ? WL_SHM_FORMAT_ABGR16161616F : WL_SHM_FORMAT_XBGR2101010
#else
            WL_SHM_FORMAT_XRGB8888
#endif
        );
        wl_buffer_add_listener(buffers[i].handle, &buffer_listener, &buffers[i]);
        wl_shm_pool_destroy(pool);
        close(fd);
#endif
    }
    surface = wl_compositor_create_surface(compositor);
#ifdef LWFA_EXPLICIT_TEST
    sync_init(surface);
#endif
#ifdef LWFA_COLOR_TEST
    if (!color_manager) return 7;
    const char *invalid = getenv("LWFA_TEST_COLOR_INVALID");
    struct wp_image_description_creator_params_v1 *params = (invalid || !scrgb_source()) ? wp_color_manager_v1_create_parametric_creator(color_manager) : NULL;
    if (invalid) {
        uint32_t expected = 0;
        if (!strcmp(invalid, "unsupported")) {
            wp_image_description_creator_params_v1_set_tf_power(params, 22000);
            expected = WP_IMAGE_DESCRIPTION_CREATOR_PARAMS_V1_ERROR_UNSUPPORTED_FEATURE;
        } else if (!strcmp(invalid, "duplicate")) {
            wp_image_description_creator_params_v1_set_tf_named(params, WP_COLOR_MANAGER_V1_TRANSFER_FUNCTION_ST2084_PQ);
            wp_image_description_creator_params_v1_set_tf_named(params, WP_COLOR_MANAGER_V1_TRANSFER_FUNCTION_ST2084_PQ);
            expected = WP_IMAGE_DESCRIPTION_CREATOR_PARAMS_V1_ERROR_ALREADY_SET;
        } else {
            wp_image_description_creator_params_v1_create(params);
            expected = WP_IMAGE_DESCRIPTION_CREATOR_PARAMS_V1_ERROR_INCOMPLETE_SET;
        }
        int result = wl_display_roundtrip(display);
        const struct wl_interface *interface = NULL;
        uint32_t id = 0;
        uint32_t error = wl_display_get_protocol_error(display, &interface, &id);
        int correct_interface = interface ? !strcmp(interface->name, "wp_image_description_creator_params_v1") : !strcmp(invalid, "incomplete");
        int passed = result < 0 && correct_interface && error == expected;
        wl_display_disconnect(display);
        return passed ? 0 : 10;
    }
    if (scrgb_source()) {
        color_image=wp_color_manager_v1_create_windows_scrgb(color_manager);
    } else {
    wp_image_description_creator_params_v1_set_primaries_named(params, WP_COLOR_MANAGER_V1_PRIMARIES_BT2020);
    wp_image_description_creator_params_v1_set_tf_named(params, source_space && !strcmp(source_space,"hlg") ? WP_COLOR_MANAGER_V1_TRANSFER_FUNCTION_HLG : WP_COLOR_MANAGER_V1_TRANSFER_FUNCTION_ST2084_PQ);
    wp_image_description_creator_params_v1_set_mastering_display_primaries(params, 708000,292000,170000,797000,131000,46000,312700,329000);
    wp_image_description_creator_params_v1_set_mastering_luminance(params, 50, 1000);
    wp_image_description_creator_params_v1_set_luminances(params, 50, source_space && !strcmp(source_space,"hlg") ? 1000 : 10000, 203);
    wp_image_description_creator_params_v1_set_max_cll(params, 1000);
    color_image = wp_image_description_creator_params_v1_create(params);
    }
    wp_image_description_v1_add_listener(color_image, &image_listener, NULL);
    while (!color_ready) if (wl_display_roundtrip(display) < 0) return 9;
    color_surface = wp_color_manager_v1_get_surface(color_manager, surface);
    wp_color_management_surface_v1_set_image_description(color_surface, color_image, WP_COLOR_MANAGER_V1_RENDER_INTENT_PERCEPTUAL);
    wp_image_description_v1_destroy(color_image); /* Copy semantics must preserve the surface state. */
#endif
    struct xdg_surface *xdg = xdg_wm_base_get_xdg_surface(shell, surface);
    xdg_surface_add_listener(xdg, &surface_listener, NULL);
    struct xdg_toplevel *toplevel = xdg_surface_get_toplevel(xdg);
    xdg_toplevel_add_listener(toplevel, &toplevel_listener, NULL);
    xdg_toplevel_set_title(toplevel, "lwfa-headless-smoke");
    xdg_toplevel_set_app_id(toplevel, "lwfa-headless-smoke");
    xdg_toplevel_set_min_size(toplevel, WIDTH, HEIGHT);
    xdg_toplevel_set_max_size(toplevel, WIDTH, HEIGHT);
    xdg_surface_set_window_geometry(xdg, 0, 0, WIDTH, HEIGHT);
    wl_surface_commit(surface);
    while (running && wl_display_dispatch(display) >= 0) {}
    wl_display_disconnect(display);
    return 0;
}
