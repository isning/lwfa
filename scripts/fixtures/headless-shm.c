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

#define WIDTH 320
#define HEIGHT 240

struct buffer {
    struct wl_buffer *handle;
    uint32_t *pixels;
    int busy;
};

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
    for (unsigned y = 0; y < HEIGHT; ++y) {
        for (unsigned x = 0; x < WIDTH; ++x) {
            buffer->pixels[y * WIDTH + x] = 0xffcc3322;
        }
    }
    /* Changing content proves frame callbacks keep the application advancing. */
    buffer->pixels[(frames % HEIGHT) * WIDTH] = 0xff22cc33;
    buffer->busy = 1;
    ready = 0;
    struct wl_callback *callback = wl_surface_frame(surface);
    wl_callback_add_listener(callback, &frame_listener, NULL);
    wl_surface_attach(surface, buffer->handle, 0, 0);
    wl_surface_damage(surface, 0, 0, WIDTH, HEIGHT);
    wl_surface_commit(surface);
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
    if (!display) return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !compositor || !shm || !shell) return 2;
    for (unsigned i = 0; i < 2; ++i) {
        int size = WIDTH * HEIGHT * 4;
        int fd = memfd_create("lwfa-headless-smoke", MFD_CLOEXEC);
        if (fd < 0 || ftruncate(fd, size) < 0) return 3;
        buffers[i].pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (buffers[i].pixels == MAP_FAILED) return 4;
        struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
        buffers[i].handle = wl_shm_pool_create_buffer(pool, 0, WIDTH, HEIGHT, WIDTH * 4, WL_SHM_FORMAT_XRGB8888);
        wl_buffer_add_listener(buffers[i].handle, &buffer_listener, &buffers[i]);
        wl_shm_pool_destroy(pool);
        close(fd);
    }
    surface = wl_compositor_create_surface(compositor);
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
