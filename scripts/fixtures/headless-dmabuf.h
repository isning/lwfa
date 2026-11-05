/* EGL producer for the native smoke client. Keeps exported textures alive and
 * uses the compositor's advertised fourcc/modifier pairs, never assumes linear. */
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include "linux-dmabuf-v1-client-protocol.h"
static struct zwp_linux_dmabuf_v1 *dma_manager;
static EGLDisplay producer;
static GLuint textures[2];
static void dma_created(void *data, struct zwp_linux_buffer_params_v1 *params, struct wl_buffer *buffer) {
    *(struct wl_buffer **)data=buffer; zwp_linux_buffer_params_v1_destroy(params);
}
static void dma_failed(void *data, struct zwp_linux_buffer_params_v1 *params) {
    (void)data; (void)params; fprintf(stderr,"DMA-BUF import failed\n"); exit(12);
}
static const struct zwp_linux_buffer_params_v1_listener dma_params_listener={.created=dma_created,.failed=dma_failed};
static void dma_init(void) {
    PFNEGLQUERYDEVICESEXTPROC query=(void *)eglGetProcAddress("eglQueryDevicesEXT");
    PFNEGLGETPLATFORMDISPLAYEXTPROC get_display=(void *)eglGetProcAddress("eglGetPlatformDisplayEXT");
    if (!query || !get_display) exit(13);
    EGLDeviceEXT devices[16]; EGLint count=0;
    if (!query(16,devices,&count) || count<1) exit(14);
    for (int i=0;i<count;i++) {
        producer=get_display(EGL_PLATFORM_DEVICE_EXT,devices[i],NULL);
        if (eglInitialize(producer,NULL,NULL)) break;
    }
    if (!eglBindAPI(EGL_OPENGL_ES_API)) exit(15);
    EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};
    EGLContext context=eglCreateContext(producer,EGL_NO_CONFIG_KHR,EGL_NO_CONTEXT,attrs);
    if (context==EGL_NO_CONTEXT || !eglMakeCurrent(producer,EGL_NO_SURFACE,EGL_NO_SURFACE,context)) exit(16);
    glGenTextures(2,textures);
}
static struct wl_buffer *dma_buffer(struct wl_display *display, unsigned index) {
    glBindTexture(GL_TEXTURE_2D,textures[index]);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGB10_A2,WIDTH,HEIGHT,0,GL_RGBA,GL_UNSIGNED_INT_2_10_10_10_REV,NULL);
    EGLint attrs[]={EGL_GL_TEXTURE_LEVEL_KHR,0,EGL_NONE};
    PFNEGLCREATEIMAGEKHRPROC image_create=(void *)eglGetProcAddress("eglCreateImageKHR");
    PFNEGLEXPORTDMABUFIMAGEQUERYMESAPROC query=(void *)eglGetProcAddress("eglExportDMABUFImageQueryMESA");
    PFNEGLEXPORTDMABUFIMAGEMESAPROC export_image=(void *)eglGetProcAddress("eglExportDMABUFImageMESA");
    PFNEGLDESTROYIMAGEKHRPROC destroy=(void *)eglGetProcAddress("eglDestroyImageKHR");
    if (!image_create || !query || !export_image || !destroy) exit(17);
    EGLImageKHR image=image_create(producer,eglGetCurrentContext(),EGL_GL_TEXTURE_2D_KHR,(EGLClientBuffer)(uintptr_t)textures[index],attrs);
    int format=0,planes=0; EGLuint64KHR modifier=0;
    if (image==EGL_NO_IMAGE_KHR || !query(producer,image,&format,&planes,&modifier) || planes!=1) exit(18);
    int fd=-1,stride=0,offset=0;
    if (!export_image(producer,image,&fd,&stride,&offset)) exit(19);
    struct zwp_linux_buffer_params_v1 *params=zwp_linux_dmabuf_v1_create_params(dma_manager);
    struct wl_buffer *buffer=NULL;
    zwp_linux_buffer_params_v1_add_listener(params,&dma_params_listener,&buffer);
    zwp_linux_buffer_params_v1_add(params,fd,0,offset,stride,(uint32_t)(modifier>>32),(uint32_t)modifier);
    close(fd); destroy(producer,image);
    zwp_linux_buffer_params_v1_create(params,WIDTH,HEIGHT,format,0);
    while (!buffer) if (wl_display_roundtrip(display)<0) exit(20);
    fprintf(stderr,"DMA-BUF imported format=%x modifier=%llx\n",format,(unsigned long long)modifier);
    return buffer;
}
static void dma_draw(unsigned index) {
    GLuint framebuffer;
    glGenFramebuffers(1,&framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,textures[index],0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) exit(21);
    float gray=520.0f/1023.0f;
    float color[]={gray,gray,gray,1.0f};
    glClearBufferfv(GL_COLOR,0,color);
    glFinish();
    glDeleteFramebuffers(1,&framebuffer);
}

#ifdef LWFA_EXPLICIT_TEST
#include <fcntl.h>
#include <xf86drm.h>
#include "linux-drm-syncobj-v1-client-protocol.h"
static struct wp_linux_drm_syncobj_manager_v1 *sync_manager;
static struct wp_linux_drm_syncobj_surface_v1 *sync_surface;
static struct wp_linux_drm_syncobj_timeline_v1 *acquire_timelines[2],*release_timelines[2];
static uint32_t acquire_handles[2],release_handles[2];
static uint64_t points[2];
static int sync_fd;
static void sync_init(struct wl_surface *surface) {
    if (!sync_manager) exit(22);
    PFNEGLQUERYDISPLAYATTRIBEXTPROC query_display=(void *)eglGetProcAddress("eglQueryDisplayAttribEXT");
    PFNEGLQUERYDEVICESTRINGEXTPROC query_device=(void *)eglGetProcAddress("eglQueryDeviceStringEXT");
    EGLAttrib device;
    if (!query_display || !query_device || !query_display(producer,EGL_DEVICE_EXT,&device)) exit(23);
    const char *path=query_device((EGLDeviceEXT)device,EGL_DRM_RENDER_NODE_FILE_EXT);
    if (!path || (sync_fd=open(path,O_RDWR|O_CLOEXEC))<0) exit(24);
    sync_surface=wp_linux_drm_syncobj_manager_v1_get_surface(sync_manager,surface);
    for (int i=0;i<2;i++) {
        int acquire_fd,release_fd;
        if (drmSyncobjCreate(sync_fd,0,&acquire_handles[i]) || drmSyncobjCreate(sync_fd,0,&release_handles[i]) ||
            drmSyncobjHandleToFD(sync_fd,acquire_handles[i],&acquire_fd) || drmSyncobjHandleToFD(sync_fd,release_handles[i],&release_fd)) exit(25);
        acquire_timelines[i]=wp_linux_drm_syncobj_manager_v1_import_timeline(sync_manager,acquire_fd);
        release_timelines[i]=wp_linux_drm_syncobj_manager_v1_import_timeline(sync_manager,release_fd);
        close(acquire_fd);close(release_fd);
    }
}
static void sync_prepare(unsigned index) {
    if (points[index] && drmSyncobjTimelineWait(sync_fd,&release_handles[index],&points[index],1,0,DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL,NULL)) {
        fprintf(stderr,"buffer released before explicit timeline\n"); exit(26);
    }
    uint64_t point=++points[index];
    wp_linux_drm_syncobj_surface_v1_set_acquire_point(sync_surface,acquire_timelines[index],point>>32,(uint32_t)point);
    wp_linux_drm_syncobj_surface_v1_set_release_point(sync_surface,release_timelines[index],point>>32,(uint32_t)point);
}
static void sync_produce(unsigned index) {
    /* Commit before writing pixels: the acquire point must block rendering. */
    usleep(30000);
    dma_draw(index);
    if (drmSyncobjTimelineSignal(sync_fd,&acquire_handles[index],&points[index],1)) exit(27);
}
#endif
