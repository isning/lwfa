#version 100
//_DEFINES_
#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif
precision highp float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif
uniform float alpha;
uniform vec2 source_size;
uniform vec2 packed_size;
varying vec2 v_coords;
#if defined(DEBUG_FLAGS)
uniform float tint;
#endif
vec3 pq_at(vec2 pixel) {
    vec2 uv = (clamp(pixel, vec2(0.0), source_size-1.0)+0.5)/source_size;
    // Input is premultiplied linear sRGB in nits with an 80-nit working white.
    // Flatten transparency over black in linear light, before PQ encoding.
    vec3 rgb = texture2D(tex, uv).rgb * (203.0/80.0);
    rgb = mat3(0.627404,0.069097,0.016391, 0.329283,0.919540,0.088013, 0.043313,0.011362,0.895595) * rgb;
    vec3 p = pow(clamp(rgb/10000.0,0.0,1.0),vec3(0.1593017578125));
    return pow((0.8359375+18.8515625*p)/(1.0+18.6875*p),vec3(78.84375));
}
vec3 yuv(vec3 rgb) {
    float y = dot(rgb, vec3(0.2627,0.6780,0.0593));
    return vec3(y,(rgb.b-y)/1.8814,(rgb.r-y)/1.4746);
}
float word(float column, float row) {
    float code;
    if (row < source_size.y) {
        code = clamp(floor(64.0+876.0*yuv(pq_at(vec2(column,row))).x+0.5),64.0,940.0);
    } else {
        vec2 pixel = vec2(floor(column/2.0)*2.0,(row-source_size.y)*2.0);
        vec3 average = (yuv(pq_at(pixel)) + yuv(pq_at(pixel+vec2(1.0,0.0)))
          + yuv(pq_at(pixel+vec2(0.0,1.0))) + yuv(pq_at(pixel+1.0))) * 0.25;
        float component = mod(column,2.0) < 0.5 ? average.y : average.z;
        code = clamp(floor(512.0+896.0*component+0.5),64.0,960.0);
    }
    return (code*64.0)/65535.0;
}
void main() {
    vec2 pixel = floor(v_coords*packed_size);
    float column = pixel.x*4.0;
    gl_FragColor = vec4(word(column,pixel.y),word(column+1.0,pixel.y),
        word(column+2.0,pixel.y),word(column+3.0,pixel.y)) * alpha;
}
